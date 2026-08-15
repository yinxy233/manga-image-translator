#!/usr/bin/env python3
"""Compare before/after benchmark JSON against the full-chain release gates."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any


REQUIRED_REPORT_COUNTS = {
    "ordinary:cold": 1,
    "ordinary:warm": 10,
    "ordinary:cache": 10,
    "dense:warm": 10,
    "long:warm": 3,
    "queue10:warm": 30,
    "stress30:warm": 30,
}


def _load_reports(paths: list[Path]) -> dict[str, dict[str, Any]]:
    """Load reports keyed by ``scenario:state`` (legacy reports are warm)."""
    reports = {}
    for path in paths:
        report = json.loads(path.read_text(encoding="utf-8"))
        report["_report_path"] = str(path.resolve())
        key = f'{report["scenario"]}:{report.get("state", "warm")}'
        reports[key] = report
    return reports


def _artifact_path(report: dict[str, Any], request: dict[str, Any]) -> Path | None:
    """Resolve one report-relative final PNG artifact when present."""
    artifact = request.get("result_artifact")
    report_path = report.get("_report_path")
    if not artifact or not report_path:
        return None
    path = Path(str(artifact))
    if path.is_absolute():
        return path
    return Path(str(report_path)).parent / path


def _compare_png_pixels(left_path: Path, right_path: Path) -> dict[str, Any]:
    """Measure maximum channel delta and PSNR between two decoded PNGs."""
    try:
        from PIL import Image, ImageChops
    except ImportError as error:
        return {"passed": False, "error": f"Pillow unavailable: {error}"}

    try:
        with Image.open(left_path) as left_image, Image.open(right_path) as right_image:
            left_rgba = left_image.convert("RGBA")
            right_rgba = right_image.convert("RGBA")
            if left_rgba.size != right_rgba.size:
                return {
                    "passed": False,
                    "error": "dimension mismatch",
                    "left_size": left_rgba.size,
                    "right_size": right_rgba.size,
                }
            difference = ImageChops.difference(left_rgba, right_rgba)
            extrema = difference.getextrema()
            max_channel_difference = max(high for _low, high in extrema)
            histogram = difference.histogram()
            squared_error = sum(
                count * ((index % 256) ** 2)
                for index, count in enumerate(histogram)
            )
            sample_count = left_rgba.width * left_rgba.height * 4
            mse = squared_error / sample_count if sample_count else 0.0
            psnr = None if mse == 0 else 20 * math.log10(255 / math.sqrt(mse))
    except (OSError, ValueError) as error:
        return {"passed": False, "error": str(error)}
    return {
        "passed": (
            max_channel_difference <= 2
            and (psnr is None or psnr >= 60.0)
        ),
        "max_channel_difference": max_channel_difference,
        "psnr_db": psnr,
    }


def _output_equivalence(
    baseline_report: dict[str, Any],
    candidate_report: dict[str, Any],
) -> tuple[bool, Any]:
    """Compare ordered outputs by bytes or decoded-pixel quality thresholds."""
    baseline_requests = [
        request
        for run in baseline_report.get("runs", [])
        for request in run.get("requests", [])
    ]
    candidate_requests = [
        request
        for run in candidate_report.get("runs", [])
        for request in run.get("requests", [])
    ]
    if not baseline_requests or len(baseline_requests) != len(candidate_requests):
        return False, "missing or differently sized output sets"

    comparisons: list[dict[str, Any]] = []
    cached_pixel_comparisons: dict[tuple[Path, Path], dict[str, Any]] = {}
    for index, (before, after) in enumerate(zip(baseline_requests, candidate_requests)):
        if before.get("result_sha256") == after.get("result_sha256"):
            comparisons.append({"index": index, "mode": "byte-identical", "passed": True})
            continue
        before_path = _artifact_path(baseline_report, before)
        after_path = _artifact_path(candidate_report, after)
        if not before_path or not after_path or not before_path.is_file() or not after_path.is_file():
            comparisons.append({
                "index": index,
                "mode": "pixel",
                "passed": False,
                "error": "result artifacts are required when PNG byte hashes differ",
            })
            continue
        artifact_pair = (before_path.resolve(), after_path.resolve())
        comparison = cached_pixel_comparisons.get(artifact_pair)
        if comparison is None:
            comparison = _compare_png_pixels(*artifact_pair)
            cached_pixel_comparisons[artifact_pair] = comparison
        comparisons.append({"index": index, "mode": "pixel", **comparison})
    return all(comparison["passed"] for comparison in comparisons), comparisons


def _quality_fingerprint_equivalence(
    baseline_report: dict[str, Any],
    candidate_report: dict[str, Any],
) -> tuple[bool, Any]:
    """Compare opt-in detection/OCR/translation fingerprints in request order."""
    baseline_requests = [
        request
        for run in baseline_report.get("runs", [])
        for request in run.get("requests", [])
    ]
    candidate_requests = [
        request
        for run in candidate_report.get("runs", [])
        for request in run.get("requests", [])
    ]
    if not baseline_requests or len(baseline_requests) != len(candidate_requests):
        return False, "missing or differently sized quality evidence sets"

    comparisons = []
    for index, (before, after) in enumerate(zip(baseline_requests, candidate_requests)):
        before_quality = before.get("diagnostics", {}).get("quality")
        after_quality = after.get("diagnostics", {}).get("quality")
        passed = (
            isinstance(before_quality, dict)
            and bool(before_quality)
            and before_quality == after_quality
        )
        comparisons.append({
            "index": index,
            "passed": passed,
            "baseline": before_quality,
            "candidate": after_quality,
        })
    return all(comparison["passed"] for comparison in comparisons), comparisons


def _improvement(before: float, after: float) -> float:
    """Return the percentage reduction from a latency baseline."""
    return (before - after) / before * 100 if before else 0.0


def _throughput_improvement(before: float, after: float) -> float:
    """Return the percentage increase from a throughput baseline."""
    return (after - before) / before * 100 if before else 0.0


def evaluate_worker_counts(
    single_paths: list[Path],
    double_paths: list[Path],
) -> dict[str, Any]:
    """Recommend two workers only when throughput, p95, and VRAM all qualify."""
    single = _load_reports(single_paths)
    double = _load_reports(double_paths)
    checks: list[dict[str, Any]] = []

    def record(name: str, passed: bool, value: Any, requirement: str) -> None:
        checks.append({
            "name": name,
            "passed": passed,
            "value": value,
            "requirement": requirement,
        })

    ordinary_key = "ordinary:warm"
    queue_key = "queue10:warm"
    load_reports = [
        reports.get(key)
        for reports in (single, double)
        for key in (ordinary_key, queue_key)
    ]
    reported_concurrency = [
        int(report.get("request_concurrency", 0) or 0)
        for report in load_reports
        if report is not None
    ]
    record(
        "two-workers:client-load",
        len(reported_concurrency) == 4
        and all(concurrency >= 2 for concurrency in reported_concurrency),
        reported_concurrency,
        "ordinary and queue10 reports use request_concurrency >= 2",
    )
    if queue_key in single and queue_key in double:
        throughput_gain = _throughput_improvement(
            float(single[queue_key]["summary"]["throughput_pages_per_minute"]),
            float(double[queue_key]["summary"]["throughput_pages_per_minute"]),
        )
        record("two-workers:throughput", throughput_gain > 10.0, throughput_gain, "> 10%")
    else:
        record("two-workers:throughput", False, "missing queue10:warm", "> 10%")

    if ordinary_key in single and ordinary_key in double:
        single_p95 = float(single[ordinary_key]["summary"]["request_p95_ms"])
        double_p95 = float(double[ordinary_key]["summary"]["request_p95_ms"])
        p95_change = (double_p95 - single_p95) / single_p95 * 100 if single_p95 else 0.0
        record("two-workers:p95", p95_change <= 0.0, p95_change, "no degradation")
    else:
        record("two-workers:p95", False, "missing ordinary:warm", "no degradation")

    common = set(single) & set(double)
    vram_pairs = [
        (
            single[key]["summary"].get("peak_vram_mib"),
            double[key]["summary"].get("peak_vram_mib"),
        )
        for key in common
    ]
    vram_pairs = [(left, right) for left, right in vram_pairs if left and right]
    if vram_pairs:
        vram_delta = max(int(right) - int(left) for left, right in vram_pairs)
        record("two-workers:vram", vram_delta <= 0, vram_delta, "no increase")
    else:
        record("two-workers:vram", False, "missing VRAM samples", "no increase")

    recommend_two = all(check["passed"] for check in checks)
    return {
        "recommended_instances": 2 if recommend_two else 1,
        "checks": checks,
    }


def build_parser() -> argparse.ArgumentParser:
    """Build the comparison CLI."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", nargs="+", type=Path, required=True)
    parser.add_argument("--candidate", nargs="+", type=Path, required=True)
    parser.add_argument(
        "--deterministic",
        action="store_true",
        help=(
            "Require live verify mode plus byte/pixel-equivalent outputs from "
            "recorded OCR and Ollama fixtures."
        ),
    )
    parser.add_argument(
        "--single-worker",
        nargs="+",
        type=Path,
        help="Optional one-worker ordinary/queue reports for worker recommendation.",
    )
    parser.add_argument(
        "--double-worker",
        nargs="+",
        type=Path,
        help="Optional two-worker ordinary/queue reports for worker recommendation.",
    )
    return parser


def main() -> int:
    """Evaluate every available scenario and print a machine-readable verdict."""
    args = build_parser().parse_args()
    if bool(args.single_worker) != bool(args.double_worker):
        raise SystemExit("--single-worker and --double-worker must be provided together.")
    baseline = _load_reports(args.baseline)
    candidate = _load_reports(args.candidate)
    common = sorted(set(baseline) & set(candidate))
    if not common:
        raise SystemExit("No matching scenarios were found.")

    checks: list[dict[str, Any]] = []

    def add(name: str, passed: bool, value: Any, requirement: str) -> None:
        checks.append({
            "name": name,
            "passed": passed,
            "value": value,
            "requirement": requirement,
        })

    for report_key, expected_count in REQUIRED_REPORT_COUNTS.items():
        for label, reports in (("baseline", baseline), ("candidate", candidate)):
            add(
                f"matrix:{report_key}:{label}",
                report_key in reports,
                "present" if report_key in reports else "missing",
                "required release-matrix report",
            )
            if report_key in reports:
                request_count = int(
                    reports[report_key]["summary"].get("request_count", 0) or 0
                )
                add(
                    f"matrix:{report_key}:{label}-samples",
                    request_count >= expected_count,
                    request_count,
                    f">= {expected_count} successful requests",
                )

    add(
        "matrix:deterministic-replay",
        bool(args.deterministic),
        "enabled" if args.deterministic else "disabled",
        "--deterministic is required for release comparison",
    )

    for report_key in common:
        before = baseline[report_key]["summary"]
        after = candidate[report_key]["summary"]
        browser_failures = int(after.get("browser_failed_tasks", 0) or 0)
        if after.get("browser_record_count", 0):
            add(
                f"{report_key}:browser-completion",
                browser_failures == 0,
                browser_failures,
                "no failed or canceled browser tasks",
            )
        before_p95 = before.get("request_p95_ms")
        after_p95 = after.get("request_p95_ms")
        if before_p95 is not None and after_p95 is not None:
            p95_change = (float(after_p95) - float(before_p95)) / float(before_p95) * 100
            add(
                f"{report_key}:p95",
                p95_change <= 5.0,
                p95_change,
                "<= 5% regression",
            )
        elif report_key in REQUIRED_REPORT_COUNTS:
            add(
                f"{report_key}:p95",
                False,
                "missing latency samples",
                "<= 5% regression",
            )

        before_vram = before.get("peak_vram_mib")
        after_vram = after.get("peak_vram_mib")
        if before_vram is not None and after_vram is not None:
            add(
                f"{report_key}:vram",
                int(after_vram) <= int(before_vram),
                int(after_vram) - int(before_vram),
                "no peak VRAM increase",
            )
        elif report_key in REQUIRED_REPORT_COUNTS and not report_key.endswith(":cache"):
            add(
                f"{report_key}:vram",
                False,
                "missing VRAM samples",
                "no peak VRAM increase",
            )

        if args.deterministic:
            if report_key != "ordinary:cache":
                for label, report in (
                    ("baseline", baseline[report_key]),
                    ("candidate", candidate[report_key]),
                ):
                    replay = report.get("replay", {})
                    replay_modes = (
                        replay.get("ocr_mode"),
                        replay.get("ollama_mode"),
                    )
                    add(
                        f"{report_key}:{label}-replay-mode",
                        replay_modes == ("verify", "verify"),
                        "/".join(str(mode or "missing") for mode in replay_modes),
                        "OCR and Ollama modes are both verify (live timing + deterministic output)",
                    )
            if report_key != "ordinary:cache":
                equivalent, equivalence_details = _output_equivalence(
                    baseline[report_key],
                    candidate[report_key],
                )
                add(
                    f"{report_key}:output-equivalence",
                    equivalent,
                    equivalence_details,
                    "byte-identical or max channel diff <= 2 and PSNR >= 60 dB",
                )
                quality_equivalent, quality_details = _quality_fingerprint_equivalence(
                    baseline[report_key],
                    candidate[report_key],
                )
                add(
                    f"{report_key}:quality-fingerprints",
                    quality_equivalent,
                    quality_details,
                    "detection, OCR, merged-region, and postprocessed text fingerprints match",
                )

    if "ordinary:warm" in common:
        gain = _improvement(
            float(baseline["ordinary:warm"]["summary"]["request_median_ms"]),
            float(candidate["ordinary:warm"]["summary"]["request_median_ms"]),
        )
        add("ordinary:median", gain >= 15.0, gain, ">= 15% latency reduction")

    if "long:warm" in common:
        gain = _improvement(
            float(baseline["long:warm"]["summary"]["request_median_ms"]),
            float(candidate["long:warm"]["summary"]["request_median_ms"]),
        )
        add("long:median", gain >= 20.0, gain, ">= 20% latency reduction")
        before_ram = baseline["long:warm"]["summary"].get("peak_process_rss_bytes")
        after_ram = candidate["long:warm"]["summary"].get("peak_process_rss_bytes")
        if before_ram and after_ram:
            ram_gain = _improvement(float(before_ram), float(after_ram))
            add(
                "long:ram",
                ram_gain >= 10.0,
                ram_gain,
                ">= 10% peak process RAM reduction",
            )
        else:
            add(
                "long:ram",
                False,
                "missing RAM samples",
                ">= 10% peak process RAM reduction",
            )
        before_long_task = baseline["long:warm"]["summary"].get("browser_long_task_ms")
        after_long_task = candidate["long:warm"]["summary"].get("browser_long_task_ms")
        if before_long_task is not None and after_long_task is not None:
            long_task_gain = _improvement(float(before_long_task), float(after_long_task))
            add(
                "long:browser-main-thread",
                long_task_gain >= 30.0,
                long_task_gain,
                ">= 30% Long Task reduction",
            )
        else:
            add(
                "long:browser-main-thread",
                False,
                "missing browser diagnostics",
                ">= 30% Long Task reduction",
            )

    if "queue10:warm" in common:
        gain = _throughput_improvement(
            float(baseline["queue10:warm"]["summary"]["throughput_pages_per_minute"]),
            float(candidate["queue10:warm"]["summary"]["throughput_pages_per_minute"]),
        )
        add("queue10:throughput", gain >= 20.0, gain, ">= 20% throughput increase")

    if "stress30:warm" in common:
        continuous_growth_samples = [
            run["resources"].get("steady_rss_continuously_growing")
            for run in candidate["stress30:warm"]["runs"]
            if run["resources"].get("steady_rss_continuously_growing") is not None
        ]
        if continuous_growth_samples:
            add(
                "stress30:no-continuous-memory-growth",
                not any(bool(sample) for sample in continuous_growth_samples),
                any(bool(sample) for sample in continuous_growth_samples),
                "RSS quartile medians do not continuously rise",
            )
        else:
            add(
                "stress30:no-continuous-memory-growth",
                False,
                "missing RSS trend samples",
                "RSS quartile medians do not continuously rise",
            )
        growth_samples = [
            run["resources"].get("steady_rss_growth_bytes")
            for run in candidate["stress30:warm"]["runs"]
            if run["resources"].get("steady_rss_growth_bytes") is not None
        ]
        if growth_samples:
            growth = max(int(sample) for sample in growth_samples)
            add(
                "stress30:steady-memory",
                growth <= 64 * 1024 * 1024,
                growth,
                "<= 64 MiB post-warmup RSS growth",
            )
        else:
            add(
                "stress30:steady-memory",
                False,
                "missing RSS samples",
                "<= 64 MiB post-warmup RSS growth",
            )
        request_count = sum(
            len(run["requests"]) for run in candidate["stress30:warm"]["runs"]
        )
        add("stress30:completed", request_count >= 30, request_count, ">= 30 completed pages")

    if "ordinary:cache" in candidate:
        cache_summary = candidate["ordinary:cache"]["summary"]
        cache_requests = int(cache_summary.get("request_count", 0) or 0)
        cache_hits = int(cache_summary.get("browser_cache_hits", 0) or 0)
        add(
            "cache:all-hits",
            cache_requests >= 10 and cache_hits == cache_requests,
            f"{cache_hits}/{cache_requests}",
            "all cache samples hit IndexedDB",
        )
        uploaded_bytes = int(cache_summary.get("uploaded_bytes", 0) or 0)
        add("cache:no-upload", uploaded_bytes == 0, uploaded_bytes, "0 uploaded bytes")

    if "ordinary:cold" in candidate:
        cold_report = candidate["ordinary:cold"]
        ollama_health = cold_report.get("health", {}).get("ollama", {})
        ollama_status = ollama_health.get("status")
        add(
            "cold:ollama-state",
            ollama_status in {"cold", "warming", "ready"},
            str(ollama_status or "missing"),
            "Ollama is configured and in its startup warmup lifecycle",
        )
        service_started_at = ollama_health.get("service_started_at_unix")
        observed_at = ollama_health.get("observed_at_unix")
        if service_started_at is not None and observed_at is not None:
            service_age_seconds = float(observed_at) - float(service_started_at)
            add(
                "cold:fresh-service",
                0 <= service_age_seconds <= 300,
                service_age_seconds,
                "health sampled within 300 seconds of service startup",
            )
        else:
            add(
                "cold:fresh-service",
                False,
                "missing service timestamps",
                "health sampled within 300 seconds of service startup",
            )
        add(
            "cold:no-warmup-request",
            int(cold_report.get("warmups", -1)) == 0,
            str(cold_report.get("warmups", "missing")),
            "0 benchmark warmups",
        )

    verdict = {"passed": all(check["passed"] for check in checks), "checks": checks}
    if args.single_worker and args.double_worker:
        verdict["worker_recommendation"] = evaluate_worker_counts(
            args.single_worker,
            args.double_worker,
        )
    print(json.dumps(verdict, ensure_ascii=False, indent=2))
    return 0 if verdict["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
