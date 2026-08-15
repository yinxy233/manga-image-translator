#!/usr/bin/env python3
"""Benchmark the browser-facing local translation path and write JSON evidence."""

from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import math
import os
import statistics
import subprocess
import threading
import time
import uuid
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import quote, urlparse


SCENARIO_DEFAULTS = {
    "ordinary": (1, 10),
    "dense": (1, 10),
    "long": (1, 3),
    "queue10": (10, 3),
    "stress30": (30, 1),
}
BENCHMARK_STATES = ("cold", "warm", "cache")


class FrameDecoder:
    """Decode the public five-byte-header stream using a bytearray cursor."""

    def __init__(self) -> None:
        """Initialize an empty protocol buffer."""
        self.buffer = bytearray()
        self.cursor = 0

    def feed(self, chunk: bytes) -> list[tuple[int, bytes]]:
        """Append a network chunk and return all complete frames."""
        self.buffer.extend(chunk)
        frames: list[tuple[int, bytes]] = []
        while len(self.buffer) - self.cursor >= 5:
            start = self.cursor
            size = int.from_bytes(self.buffer[start + 1:start + 5], "big")
            end = start + 5 + size
            if end > len(self.buffer):
                break
            frames.append((self.buffer[start], bytes(self.buffer[start + 5:end])))
            self.cursor = end
        if self.cursor and (self.cursor == len(self.buffer) or self.cursor >= 1024 * 1024):
            del self.buffer[:self.cursor]
            self.cursor = 0
        return frames


class ResourceSampler:
    """Sample server/worker RSS and NVIDIA compute memory when available."""

    def __init__(self, interval_seconds: float = 0.25) -> None:
        """Configure a low-frequency sampler that stays outside timed requests."""
        self.interval_seconds = interval_seconds
        self.peak_rss_bytes = 0
        self.peak_vram_mib = 0
        self.rss_samples: list[int] = []
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        """Start sampling on a daemon thread."""
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self) -> dict[str, Any]:
        """Stop sampling and return peaks plus a noise-resistant steady trend."""
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)
        sample_window = max(1, len(self.rss_samples) // 4)
        rss_start = (
            int(statistics.median(self.rss_samples[:sample_window]))
            if self.rss_samples else None
        )
        rss_end = (
            int(statistics.median(self.rss_samples[-sample_window:]))
            if self.rss_samples else None
        )
        quartile_medians = [
            int(statistics.median(
                self.rss_samples[
                    quartile * len(self.rss_samples) // 4:
                    (quartile + 1) * len(self.rss_samples) // 4
                ]
            ))
            for quartile in range(4)
            if (quartile + 1) * len(self.rss_samples) // 4
            > quartile * len(self.rss_samples) // 4
        ] if len(self.rss_samples) >= 8 else []
        growth_tolerance = 2 * 1024 * 1024
        continuously_growing = bool(
            len(quartile_medians) == 4
            and all(
                right - left > growth_tolerance
                for left, right in zip(quartile_medians, quartile_medians[1:])
            )
        )
        return {
            "peak_process_rss_bytes": self.peak_rss_bytes or None,
            "peak_vram_mib": self.peak_vram_mib or None,
            "rss_start_bytes": rss_start,
            "rss_end_bytes": rss_end,
            "rss_sample_count": len(self.rss_samples),
            "rss_quartile_medians": quartile_medians,
            "steady_rss_continuously_growing": continuously_growing,
            "steady_rss_growth_bytes": (
                rss_end - rss_start
                if rss_start is not None and rss_end is not None else None
            ),
        }

    def _run(self) -> None:
        """Collect optional metrics until the owning benchmark run completes."""
        try:
            import psutil  # type: ignore
        except ImportError:
            psutil = None
        sample_index = 0
        while not self._stop.is_set():
            target_process_ids: set[int] = set()
            if psutil is not None:
                rss = 0
                for process in psutil.process_iter(("pid", "cmdline", "memory_info")):
                    try:
                        command = " ".join(process.info.get("cmdline") or [])
                        if any(marker in command for marker in (
                            "server/main.py",
                            "-m server.main",
                            "-m manga_translator shared",
                            "ollama",
                        )):
                            rss += int(process.info["memory_info"].rss)
                            target_process_ids.add(int(process.info["pid"]))
                    except (psutil.AccessDenied, psutil.NoSuchProcess):
                        continue
                self.peak_rss_bytes = max(self.peak_rss_bytes, rss)
                if rss:
                    self.rss_samples.append(rss)
            if sample_index % 2 == 0:
                self.peak_vram_mib = max(
                    self.peak_vram_mib,
                    _read_nvidia_vram_mib(target_process_ids),
                )
            sample_index += 1
            self._stop.wait(self.interval_seconds)


def _read_nvidia_vram_mib(target_process_ids: set[int] | None = None) -> int:
    """Return pipeline VRAM, falling back to total GPU use on WDDM hosts."""
    try:
        completed = subprocess.run(
            [
                "nvidia-smi",
                "--query-compute-apps=pid,used_memory",
                "--format=csv,noheader,nounits",
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=2,
        )
    except (FileNotFoundError, subprocess.SubprocessError):
        return 0
    total = 0
    if completed.returncode == 0:
        for line in completed.stdout.splitlines():
            values = [value.strip() for value in line.split(",", 1)]
            if len(values) != 2 or not all(value.isdigit() for value in values):
                continue
            process_id, used_memory = (int(value) for value in values)
            if target_process_ids is None or process_id in target_process_ids:
                total += used_memory
    if total:
        return total

    # Windows WDDM commonly exposes per-GPU memory but reports process memory
    # as N/A. Total use is noisier, yet it is still valid fail-closed evidence
    # for the requirement that candidate peak system VRAM must not increase.
    try:
        fallback = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=memory.used",
                "--format=csv,noheader,nounits",
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=2,
        )
    except (FileNotFoundError, subprocess.SubprocessError):
        return 0
    if fallback.returncode:
        return 0
    return sum(
        int(value.strip())
        for value in fallback.stdout.splitlines()
        if value.strip().isdigit()
    )


def _connection(server_url: str) -> tuple[http.client.HTTPConnection, str]:
    """Create an HTTP(S) connection and return its normalized URL prefix."""
    parsed = urlparse(server_url)
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    connection_type = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
    connection = connection_type(host, port, timeout=900)
    return connection, parsed.path.rstrip("/")


def _health(server_url: str, api_key: str) -> dict[str, Any]:
    """Fetch server capabilities before timed runs."""
    connection, prefix = _connection(server_url)
    headers = {"X-API-Key": api_key} if api_key else {}
    try:
        connection.request("GET", f"{prefix}/health", headers=headers)
        response = connection.getresponse()
        payload = response.read()
        if response.status != 200:
            raise RuntimeError(f"Health request failed with HTTP {response.status}: {payload[:200]!r}")
        return json.loads(payload)
    finally:
        connection.close()


def _multipart_parts(
    image_bytes: bytes,
    filename: str,
    config: dict[str, Any],
) -> tuple[str, bytes, bytes]:
    """Build multipart boundaries around the original compressed byte payload."""
    boundary = f"----mit-benchmark-{uuid.uuid4().hex}"
    prefix = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="image"; filename="{filename}"\r\n'
        "Content-Type: application/octet-stream\r\n\r\n"
    ).encode()
    suffix = (
        f"\r\n--{boundary}\r\n"
        'Content-Disposition: form-data; name="config"\r\n'
        "Content-Type: application/json; charset=utf-8\r\n\r\n"
        f"{json.dumps(config, ensure_ascii=False, separators=(',', ':'))}"
        f"\r\n--{boundary}--\r\n"
    ).encode()
    return boundary, prefix, suffix


def _download_final(server_url: str, api_key: str, folder_name: str) -> tuple[bytes, float]:
    """Download an atomically published fast-path result."""
    started = time.perf_counter()
    connection, prefix = _connection(server_url)
    headers = {"X-API-Key": api_key} if api_key else {}
    try:
        path = f"{prefix}/result/{quote(folder_name, safe='')}/final.png"
        connection.request("GET", path, headers=headers)
        response = connection.getresponse()
        payload = response.read()
        if response.status != 200:
            raise RuntimeError(f"Result download failed with HTTP {response.status}")
        return payload, (time.perf_counter() - started) * 1000
    finally:
        connection.close()


def _png_dimensions(payload: bytes) -> tuple[int, int] | None:
    """Read PNG IHDR dimensions without adding an image-library dependency."""
    if len(payload) < 24 or payload[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    return int.from_bytes(payload[16:20], "big"), int.from_bytes(payload[20:24], "big")


def load_browser_diagnostics(path: Path | None) -> list[dict[str, Any]]:
    """Load userscript ``[mit-performance]`` records from JSON or console text."""
    if path is None:
        return []
    text = path.read_text(encoding="utf-8")
    try:
        decoded = json.loads(text)
    except json.JSONDecodeError:
        decoded = None
    if isinstance(decoded, list):
        return [record for record in decoded if isinstance(record, dict)]
    if isinstance(decoded, dict):
        records = decoded.get("records")
        if isinstance(records, list):
            return [record for record in records if isinstance(record, dict)]
        return [decoded]

    records: list[dict[str, Any]] = []
    marker = "[mit-performance]"
    for line in text.splitlines():
        marker_index = line.find(marker)
        if marker_index < 0:
            continue
        payload = line[marker_index + len(marker):].strip()
        try:
            record = json.loads(payload)
        except json.JSONDecodeError:
            continue
        if isinstance(record, dict):
            records.append(record)
    return records


def run_request(
    server_url: str,
    api_key: str,
    image_path: Path,
    config: dict[str, Any],
    web_fast_path: bool,
) -> dict[str, Any]:
    """Run one end-to-end browser-facing image translation request."""
    overall_started = time.perf_counter()
    read_started = time.perf_counter()
    image_bytes = image_path.read_bytes()
    read_ms = (time.perf_counter() - read_started) * 1000
    hash_started = time.perf_counter()
    source_sha256 = hashlib.sha256(image_bytes).hexdigest()
    hash_ms = (time.perf_counter() - hash_started) * 1000
    boundary, prefix_bytes, suffix_bytes = _multipart_parts(image_bytes, image_path.name, config)
    connection, url_prefix = _connection(server_url)
    endpoint = "/translate/with-form/image/stream/web" if web_fast_path else "/translate/with-form/image/stream"
    headers = {
        "Content-Type": f"multipart/form-data; boundary={boundary}",
        "Content-Length": str(len(prefix_bytes) + len(image_bytes) + len(suffix_bytes)),
    }
    if api_key:
        headers["X-API-Key"] = api_key

    events: list[dict[str, Any]] = []
    diagnostics: dict[str, Any] = {}
    result_bytes = b""
    download_ms = 0.0
    final_future: Future[tuple[bytes, float]] | None = None
    executor = ThreadPoolExecutor(max_workers=1)
    decoder = FrameDecoder()
    upload_started = time.perf_counter()
    try:
        connection.putrequest("POST", f"{url_prefix}{endpoint}")
        for name, value in headers.items():
            connection.putheader(name, value)
        connection.endheaders()
        connection.send(prefix_bytes)
        connection.send(image_bytes)
        connection.send(suffix_bytes)
        upload_ms = (time.perf_counter() - upload_started) * 1000
        response = connection.getresponse()
        first_byte_ms = (time.perf_counter() - upload_started) * 1000
        if response.status != 200:
            raise RuntimeError(
                f"Translation failed with HTTP {response.status}: {response.read()[:500]!r}"
            )

        while True:
            chunk = response.read1(64 * 1024)
            if not chunk:
                break
            for code, payload in decoder.feed(chunk):
                elapsed_ms = (time.perf_counter() - overall_started) * 1000
                if code == 0:
                    result_bytes = payload
                    continue
                text = payload.decode("utf-8", errors="replace")
                events.append({"code": code, "state": text, "elapsed_ms": elapsed_ms})
                if code == 2:
                    raise RuntimeError(text or "Translation worker returned an error")
                if text.startswith("diagnostics:"):
                    diagnostics = json.loads(text.removeprefix("diagnostics:"))
                if text.startswith("final_ready:") and final_future is None:
                    folder_name = text.removeprefix("final_ready:").strip()
                    final_future = executor.submit(_download_final, server_url, api_key, folder_name)
            if final_future:
                result_bytes, download_ms = final_future.result(timeout=900)
                break

        if final_future:
            result_bytes, download_ms = final_future.result(timeout=900)
    finally:
        connection.close()
        executor.shutdown(wait=True, cancel_futures=True)

    if _png_dimensions(result_bytes) is None:
        raise RuntimeError("Translation result is not a valid PNG")
    total_ms = (time.perf_counter() - overall_started) * 1000
    return {
        "image": str(image_path),
        "source_bytes": len(image_bytes),
        "source_sha256": source_sha256,
        "result_bytes": len(result_bytes),
        "result_sha256": hashlib.sha256(result_bytes).hexdigest(),
        "result_dimensions": _png_dimensions(result_bytes),
        "read_ms": read_ms,
        "hash_ms": hash_ms,
        "upload_ms": upload_ms,
        "first_byte_ms": first_byte_ms,
        "download_ms": download_ms,
        "total_ms": total_ms,
        "events": events,
        "diagnostics": diagnostics,
        # The caller persists this outside the timed/resource-sampled section,
        # then removes it before serializing the JSON report. Keeping the final
        # PNG lets the comparator measure decoded-pixel equivalence even when
        # baseline and candidate use different lossless PNG encoders.
        "_result_payload": result_bytes,
    }


def _percentile(values: list[float], percentile: float) -> float | None:
    """Return a linearly interpolated percentile for a non-empty sample."""
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * percentile
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def _browser_run_totals(browser_records: list[dict[str, Any]]) -> list[float]:
    """Derive page-session wall times without double-counting overlapped tasks."""
    grouped: dict[str, list[dict[str, Any]]] = {}
    for record in browser_records:
        session_id = str(record.get("sessionId") or "legacy")
        grouped.setdefault(session_id, []).append(record)

    totals: list[float] = []
    for records in grouped.values():
        starts = [
            float(record["startedAt"])
            for record in records
            if isinstance(record.get("startedAt"), (int, float))
        ]
        finishes = [
            float(record["finishedAt"])
            for record in records
            if isinstance(record.get("finishedAt"), (int, float))
        ]
        if starts and finishes:
            totals.append(max(finishes) - min(starts))
            continue
        legacy_total = sum(
            float(record.get("totalMs", 0) or 0) for record in records
        )
        if legacy_total:
            totals.append(legacy_total)
    return totals


def summarize(
    run_records: list[dict[str, Any]],
    browser_records: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Aggregate service and optional userscript latency/resource evidence."""
    browser_records = browser_records or []
    successful_browser_records = [
        record for record in browser_records
        if record.get("outcome") in (None, "complete", "cache")
    ]
    requests = [request for run in run_records for request in run["requests"]]
    service_latencies = [float(request["total_ms"]) for request in requests]
    browser_latencies = [
        float(record["totalMs"])
        for record in successful_browser_records
        if isinstance(record.get("totalMs"), (int, float))
    ]
    # Browser records include acquisition, hashing, cache lookup, download, and
    # DOM replacement, so they are authoritative whenever supplied.
    latencies = browser_latencies or service_latencies
    service_run_totals = [float(run["total_ms"]) for run in run_records]
    browser_run_totals = _browser_run_totals(successful_browser_records)
    run_totals = browser_run_totals or service_run_totals
    browser_long_tasks = [
        float(record.get("mainThreadLongTaskMs", 0) or 0)
        for record in successful_browser_records
    ]
    diagnostics = [
        request.get("diagnostics", {})
        for request in requests
        if isinstance(request.get("diagnostics"), dict)
    ]
    ollama_metrics = [
        diagnostic.get("ollama", {})
        for diagnostic in diagnostics
        if isinstance(diagnostic.get("ollama"), dict)
    ]
    evidence_count = (
        len(successful_browser_records) if browser_records else len(requests)
    )
    return {
        "request_count": evidence_count,
        "run_count": len(browser_run_totals) or len(run_records),
        "request_median_ms": statistics.median(latencies) if latencies else None,
        "request_p95_ms": _percentile(latencies, 0.95),
        "run_median_ms": statistics.median(run_totals) if run_totals else None,
        "throughput_pages_per_minute": (
            (len(browser_latencies) if browser_latencies else len(requests))
            / (sum(run_totals) / 60_000)
            if sum(run_totals) else None
        ),
        "uploaded_bytes": (
            sum(int(request["source_bytes"]) for request in requests)
            if requests else sum(
                int(record.get("uploadBytes", 0) or 0) for record in browser_records
            )
        ),
        "downloaded_bytes": (
            sum(int(request["result_bytes"]) for request in requests)
            if requests else sum(
                int(record.get("downloadBytes", 0) or 0) for record in browser_records
            )
        ),
        "peak_process_rss_bytes": max(
            (int(run["resources"].get("peak_process_rss_bytes") or 0) for run in run_records),
            default=0,
        ) or None,
        "peak_vram_mib": max(
            (int(run["resources"].get("peak_vram_mib") or 0) for run in run_records),
            default=0,
        ) or None,
        "browser_record_count": len(browser_records),
        "browser_failed_tasks": len(browser_records) - len(successful_browser_records),
        "browser_cache_hits": sum(
            1 for record in browser_records if record.get("outcome") == "cache"
        ),
        "browser_long_task_median_ms": (
            statistics.median(browser_long_tasks) if browser_long_tasks else None
        ),
        "browser_long_task_total_ms": sum(browser_long_tasks),
        "browser_uploaded_bytes": sum(
            int(record.get("uploadBytes", 0) or 0) for record in browser_records
        ),
        "browser_downloaded_bytes": sum(
            int(record.get("downloadBytes", 0) or 0) for record in browser_records
        ),
        "ollama_request_count": sum(
            int(metric.get("requests", 0) or 0) for metric in ollama_metrics
        ),
        "ollama_prompt_tokens": sum(
            int(metric.get("prompt_tokens", 0) or 0) for metric in ollama_metrics
        ),
        "ollama_output_tokens": sum(
            int(metric.get("output_tokens", 0) or 0) for metric in ollama_metrics
        ),
        "ollama_load_ms": sum(
            float(metric.get("load_ms", 0) or 0) for metric in ollama_metrics
        ),
        "ollama_prompt_eval_ms": sum(
            float(metric.get("prompt_eval_ms", 0) or 0) for metric in ollama_metrics
        ),
        "ollama_eval_ms": sum(
            float(metric.get("eval_ms", 0) or 0) for metric in ollama_metrics
        ),
    }


def build_parser() -> argparse.ArgumentParser:
    """Build the benchmark command-line interface."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("images", nargs="*", type=Path)
    parser.add_argument("--server", default="http://127.0.0.1:8001")
    parser.add_argument("--api-key", default=os.getenv("MT_WEB_API_KEY", ""))
    parser.add_argument("--scenario", choices=SCENARIO_DEFAULTS, default="ordinary")
    parser.add_argument("--pages-per-run", type=int, default=0)
    parser.add_argument("--runs", type=int, default=0)
    parser.add_argument(
        "--request-concurrency",
        type=int,
        default=1,
        help="Concurrent browser-facing requests (default: 1).",
    )
    parser.add_argument("--state", choices=BENCHMARK_STATES, default="warm")
    parser.add_argument("--warmups", type=int)
    parser.add_argument("--config", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--artifact-dir",
        type=Path,
        help=(
            "Directory for deduplicated final PNGs used by pixel-equivalence "
            "checks (default: <output-stem>-artifacts)."
        ),
    )
    parser.add_argument("--standard-stream", action="store_true")
    parser.add_argument(
        "--browser-long-task-ms",
        type=float,
        help="Optional total from the userscript [mit-performance] record.",
    )
    parser.add_argument(
        "--browser-diagnostics",
        type=Path,
        help="JSON/console export containing userscript [mit-performance] records.",
    )
    return parser


def _cycle_images(images: list[Path], count: int) -> Iterable[Path]:
    """Yield exactly ``count`` paths by cycling the provided fixture list."""
    for index in range(count):
        yield images[index % len(images)]


def _run_request_batch(
    server_url: str,
    api_key: str,
    image_paths: list[Path],
    config: dict[str, Any],
    web_fast_path: bool,
    request_concurrency: int,
) -> list[dict[str, Any]]:
    """Submit one scenario run with a bounded, order-preserving client load."""
    if request_concurrency <= 1:
        return [
            run_request(server_url, api_key, image_path, config, web_fast_path)
            for image_path in image_paths
        ]

    with ThreadPoolExecutor(
        max_workers=min(request_concurrency, len(image_paths))
    ) as executor:
        futures = [
            executor.submit(
                run_request,
                server_url,
                api_key,
                image_path,
                config,
                web_fast_path,
            )
            for image_path in image_paths
        ]
        # Preserve fixture order so deterministic baseline/candidate output
        # hashes remain directly comparable even when completion order differs.
        return [future.result() for future in futures]


def _persist_result_artifacts(
    requests: list[dict[str, Any]],
    artifact_directory: Path,
    report_directory: Path,
) -> None:
    """Persist deduplicated final PNGs and strip private payloads from records.

    Args:
        requests: Completed timed request records containing private payloads.
        artifact_directory: Directory that owns final-output evidence.
        report_directory: Parent directory used to make portable references.
    """
    artifact_directory.mkdir(parents=True, exist_ok=True)
    for request in requests:
        payload = request.pop("_result_payload", None)
        if not isinstance(payload, bytes):
            continue
        artifact_path = artifact_directory / f'{request["result_sha256"]}.png'
        if not artifact_path.exists():
            temporary_path = artifact_path.with_suffix(".png.tmp")
            temporary_path.write_bytes(payload)
            os.replace(temporary_path, artifact_path)
        request["result_artifact"] = os.path.relpath(
            artifact_path.resolve(),
            start=report_directory.resolve(),
        )


def main() -> int:
    """Run warmups and measured scenarios, then atomically save a JSON report."""
    args = build_parser().parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    if args.request_concurrency < 1:
        raise SystemExit("--request-concurrency must be at least 1.")
    pages_default, runs_default = SCENARIO_DEFAULTS[args.scenario]
    pages_per_run = args.pages_per_run or pages_default
    runs = args.runs or (1 if args.state == "cold" else runs_default)
    warmups = args.warmups if args.warmups is not None else (1 if args.state == "warm" else 0)
    browser_records = load_browser_diagnostics(args.browser_diagnostics)

    if args.state == "cache" and not browser_records:
        raise SystemExit("--state cache requires --browser-diagnostics from a cache-hit run.")
    expected_records = pages_per_run * runs
    if browser_records and len(browser_records) != expected_records:
        raise SystemExit(
            f"Browser diagnostics need exactly {expected_records} records for this matrix; "
            f"got {len(browser_records)}."
        )
    if args.state == "cache":
        if any(record.get("outcome") != "cache" for record in browser_records):
            raise SystemExit("Cache report contains a non-cache userscript outcome.")
    if args.state != "cache" and not args.images:
        raise SystemExit("At least one image is required for cold or warm service runs.")
    for image_path in args.images:
        if not image_path.is_file():
            raise SystemExit(f"Image does not exist: {image_path}")
    config = {
        "performance_diagnostics": True,
        "translator": {"translator": "ollama", "target_lang": "CHS"},
    }
    if args.config:
        config = json.loads(args.config.read_text(encoding="utf-8"))
        config["performance_diagnostics"] = True

    health: dict[str, Any] = {}
    web_fast_path: bool | None = None
    if args.state != "cache":
        health = _health(args.server, args.api_key)
        web_fast_path = not args.standard_stream and bool(
            health.get("capabilities", {}).get("web_result_fastpath")
        )
        for image_path in _cycle_images(args.images, warmups):
            run_request(args.server, args.api_key, image_path, config, web_fast_path)

    measured_runs: list[dict[str, Any]] = []
    artifact_directory = args.artifact_dir or args.output.parent / (
        f"{args.output.stem}-artifacts"
    )
    if args.state != "cache":
        for run_index in range(runs):
            sampler = ResourceSampler()
            sampler.start()
            run_started = time.perf_counter()
            requests: list[dict[str, Any]] = []
            try:
                requests = _run_request_batch(
                    args.server,
                    args.api_key,
                    list(_cycle_images(args.images, pages_per_run)),
                    config,
                    bool(web_fast_path),
                    args.request_concurrency,
                )
            finally:
                resources = sampler.stop()
            run_total_ms = (time.perf_counter() - run_started) * 1000
            _persist_result_artifacts(
                requests,
                artifact_directory,
                args.output.parent,
            )
            measured_runs.append({
                "index": run_index,
                "total_ms": run_total_ms,
                "requests": requests,
                "resources": resources,
            })

    report = {
        "schema_version": 1,
        "created_at_unix": time.time(),
        "scenario": args.scenario,
        "state": args.state,
        "server": args.server,
        "health": health,
        "web_fast_path": web_fast_path,
        "pages_per_run": pages_per_run,
        "request_concurrency": args.request_concurrency,
        "warmups": warmups,
        "config": config,
        "runs": measured_runs,
        "browser_records": browser_records,
        "replay": {
            "ocr_mode": os.getenv(
                "MANGA_OCR_REPLAY_MODE",
                os.getenv("MANGA_REPLAY_MODE", "off"),
            ).strip().lower(),
            "ollama_mode": os.getenv(
                "MANGA_OLLAMA_REPLAY_MODE",
                os.getenv("MANGA_REPLAY_MODE", "off"),
            ).strip().lower(),
            "path": os.getenv("MANGA_REPLAY_PATH", "benchmark-results/replay.json"),
        },
        "cold_start_requires_fresh_services": args.state == "cold",
    }
    report["summary"] = summarize(measured_runs, browser_records)
    report["summary"]["browser_long_task_ms"] = (
        args.browser_long_task_ms
        if args.browser_long_task_ms is not None
        else report["summary"]["browser_long_task_median_ms"]
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix(args.output.suffix + ".tmp")
    temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, args.output)
    print(json.dumps(report["summary"], ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
