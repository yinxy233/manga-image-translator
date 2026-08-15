"""Dependency-free tests for full-chain benchmark report utilities."""

from __future__ import annotations

import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

try:
    from PIL import Image
except ImportError:  # pragma: no cover - optional in minimal utility CI
    Image = None


ROOT = Path(__file__).parents[1]


def load_module(name: str, path: Path):
    """Load one repository script without importing optional ML dependencies."""
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


BENCHMARK = load_module(
    "benchmark_local_pipeline",
    ROOT / "devscripts" / "benchmark_local_pipeline.py",
)
COMPARE = load_module(
    "compare_benchmark_reports",
    ROOT / "devscripts" / "compare_benchmark_reports.py",
)


class BenchmarkToolTests(unittest.TestCase):
    """Validate browser ingestion, cache summaries, and worker recommendations."""

    def test_console_diagnostics_are_ingested(self) -> None:
        """DevTools-prefixed performance lines remain machine readable."""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "console.log"
            path.write_text(
                'console [mit-performance] {"outcome":"cache","totalMs":12.5}\n',
                encoding="utf-8",
            )

            records = BENCHMARK.load_browser_diagnostics(path)

        self.assertEqual(records, [{"outcome": "cache", "totalMs": 12.5}])

    def test_cache_summary_uses_browser_latency_and_zero_upload(self) -> None:
        """Cache-only reports do not pretend that an HTTP upload occurred."""
        summary = BENCHMARK.summarize([], [{
            "outcome": "cache",
            "totalMs": 10.0,
            "mainThreadLongTaskMs": 2.0,
            "uploadBytes": 0,
            "downloadBytes": 20,
        }])

        self.assertEqual(summary["request_count"], 1)
        self.assertEqual(summary["request_median_ms"], 10.0)
        self.assertEqual(summary["uploaded_bytes"], 0)
        self.assertEqual(summary["browser_cache_hits"], 1)

    def test_browser_records_are_authoritative_for_end_to_end_latency(self) -> None:
        """Service timings cannot hide browser acquisition or replacement cost."""
        service_runs = [{
            "total_ms": 100.0,
            "requests": [{"total_ms": 100.0, "source_bytes": 1, "result_bytes": 1}],
            "resources": {},
        }]
        browser_records = [
            {
                "sessionId": "page",
                "startedAt": 10.0,
                "finishedAt": 40.0,
                "totalMs": 30.0,
            },
            {
                "sessionId": "page",
                "startedAt": 20.0,
                "finishedAt": 60.0,
                "totalMs": 40.0,
            },
        ]

        summary = BENCHMARK.summarize(service_runs, browser_records)

        self.assertEqual(summary["request_median_ms"], 35.0)
        self.assertEqual(summary["run_median_ms"], 50.0)
        self.assertEqual(summary["throughput_pages_per_minute"], 2400.0)

    def test_resource_sampler_detects_continuous_quartile_growth(self) -> None:
        """A steadily leaking 30-page run is distinguishable from peak RSS."""
        sampler = BENCHMARK.ResourceSampler()
        sampler.rss_samples = [
            100 * 1024 * 1024 + index * 3 * 1024 * 1024
            for index in range(16)
        ]
        sampler.peak_rss_bytes = max(sampler.rss_samples)

        resources = sampler.stop()

        self.assertTrue(resources["steady_rss_continuously_growing"])
        self.assertEqual(len(resources["rss_quartile_medians"]), 4)

    def test_vram_sampler_falls_back_when_wddm_hides_process_memory(self) -> None:
        """Windows N/A process rows use total GPU memory instead of no sample."""
        responses = [
            SimpleNamespace(returncode=0, stdout="1234, N/A\n"),
            SimpleNamespace(returncode=0, stdout="4096\n"),
        ]
        with patch.object(BENCHMARK.subprocess, "run", side_effect=responses):
            sampled = BENCHMARK._read_nvidia_vram_mib({1234})

        self.assertEqual(sampled, 4096)

    def test_request_batch_exercises_bounded_concurrent_load(self) -> None:
        """Dual-worker evidence must actually overlap browser-facing requests."""
        active = 0
        maximum_active = 0
        lock = threading.Lock()

        def fake_run_request(
            _server: str,
            _api_key: str,
            image_path: Path,
            _config: dict,
            _web_fast_path: bool,
        ) -> dict:
            """Track overlap while returning each fixture identity."""
            nonlocal active, maximum_active
            with lock:
                active += 1
                maximum_active = max(maximum_active, active)
            time.sleep(0.02)
            with lock:
                active -= 1
            return {"image": str(image_path)}

        paths = [Path(f"page-{index}.png") for index in range(4)]
        with patch.object(BENCHMARK, "run_request", fake_run_request):
            results = BENCHMARK._run_request_batch(
                "http://127.0.0.1:8001", "", paths, {}, True, 2
            )

        self.assertEqual(maximum_active, 2)
        self.assertEqual(
            [result["image"] for result in results],
            [str(path) for path in paths],
        )

    def test_two_workers_require_all_three_safety_conditions(self) -> None:
        """Throughput alone cannot cause a two-worker recommendation."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            single_paths = self._write_worker_reports(root, "single", 10.0, 100.0, 4000)
            double_paths = self._write_worker_reports(root, "double", 12.0, 101.0, 4500)

            recommendation = COMPARE.evaluate_worker_counts(single_paths, double_paths)

        self.assertEqual(recommendation["recommended_instances"], 1)

    def test_release_comparison_fails_closed_on_incomplete_matrix(self) -> None:
        """A fast ordinary-page result cannot replace the full release matrix."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            baseline = root / "baseline.json"
            candidate = root / "candidate.json"
            self._write_ordinary_report(baseline, median_ms=100.0)
            self._write_ordinary_report(candidate, median_ms=80.0)
            output = io.StringIO()
            argv = [
                "compare_benchmark_reports.py",
                "--baseline",
                str(baseline),
                "--candidate",
                str(candidate),
            ]

            with patch.object(sys, "argv", argv), redirect_stdout(output):
                exit_code = COMPARE.main()

        verdict = json.loads(output.getvalue())
        self.assertEqual(exit_code, 1)
        self.assertFalse(verdict["passed"])
        self.assertIn(
            "matrix:long:warm:candidate",
            {check["name"] for check in verdict["checks"] if not check["passed"]},
        )

    def test_complete_release_matrix_can_pass_every_gate(self) -> None:
        """The fail-closed comparator also accepts a fully evidenced improvement."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            baseline_paths = self._write_release_matrix(root, "baseline", candidate=False)
            candidate_paths = self._write_release_matrix(root, "candidate", candidate=True)
            output = io.StringIO()
            argv = [
                "compare_benchmark_reports.py",
                "--baseline",
                *(str(path) for path in baseline_paths),
                "--candidate",
                *(str(path) for path in candidate_paths),
                "--deterministic",
            ]

            with patch.object(sys, "argv", argv), redirect_stdout(output):
                exit_code = COMPARE.main()

        verdict = json.loads(output.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertTrue(verdict["passed"])

    @unittest.skipIf(Image is None, "Pillow is unavailable")
    def test_output_equivalence_uses_pixel_thresholds_for_different_encoders(self) -> None:
        """PNG byte differences pass only when decoded image quality is equivalent."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            baseline_png = root / "baseline.png"
            candidate_png = root / "candidate.png"
            baseline_image = Image.new("RGB", (64, 64), color=(100, 100, 100))
            candidate_image = baseline_image.copy()
            candidate_image.putpixel((0, 0), (102, 100, 100))
            baseline_image.save(baseline_png, compress_level=0)
            candidate_image.save(candidate_png, compress_level=9)
            baseline_report = self._artifact_report(root / "baseline.json", baseline_png, "a")
            candidate_report = self._artifact_report(root / "candidate.json", candidate_png, "b")

            passed, details = COMPARE._output_equivalence(
                baseline_report,
                candidate_report,
            )

        self.assertTrue(passed)
        self.assertEqual(details[0]["max_channel_difference"], 2)
        self.assertGreaterEqual(details[0]["psnr_db"], 60.0)

    def test_quality_fingerprints_detect_non_visual_pipeline_drift(self) -> None:
        """OCR or postprocessing changes fail even before final pixel comparison."""
        baseline = {
            "runs": [{"requests": [{"diagnostics": {"quality": {
                "ocr_text": {"count": 2, "sha256": "before"},
            }}}]}],
        }
        candidate = {
            "runs": [{"requests": [{"diagnostics": {"quality": {
                "ocr_text": {"count": 2, "sha256": "after"},
            }}}]}],
        }

        passed, details = COMPARE._quality_fingerprint_equivalence(
            baseline,
            candidate,
        )

        self.assertFalse(passed)
        self.assertFalse(details[0]["passed"])

    @staticmethod
    def _artifact_report(
        report_path: Path,
        artifact_path: Path,
        result_hash: str,
    ) -> dict:
        """Build one comparator report referencing a final PNG artifact."""
        return {
            "_report_path": str(report_path),
            "runs": [{"requests": [{
                "result_sha256": result_hash,
                "result_artifact": artifact_path.name,
            }]}],
        }

    @staticmethod
    def _write_release_matrix(
        root: Path,
        prefix: str,
        candidate: bool,
    ) -> list[Path]:
        """Write compact reports satisfying every full-chain release condition."""
        paths: list[Path] = []
        for report_key, request_count in COMPARE.REQUIRED_REPORT_COUNTS.items():
            scenario, state = report_key.split(":", 1)
            requests = [{
                "result_sha256": "stable-output",
                "diagnostics": {"quality": {
                    "detection_geometry": {"count": 1, "sha256": "same"},
                    "ocr_text": {"count": 1, "sha256": "same"},
                    "merged_region_text": {"count": 1, "sha256": "same"},
                    "postprocessed_translation": {"count": 1, "sha256": "same"},
                }},
            } for _ in range(request_count)]
            resources = {
                "steady_rss_growth_bytes": 0,
                "steady_rss_continuously_growing": False,
            }
            request_median = 100.0
            if candidate and scenario == "ordinary" and state == "warm":
                request_median = 80.0
            if candidate and scenario == "long":
                request_median = 70.0
            summary = {
                "request_count": request_count,
                "request_median_ms": request_median,
                "request_p95_ms": 100.0,
                "peak_vram_mib": 4000,
                "peak_process_rss_bytes": (
                    800 * 1024 * 1024 if candidate else 1000 * 1024 * 1024
                ),
                "throughput_pages_per_minute": 13.0 if candidate else 10.0,
                "browser_long_task_ms": 50.0 if candidate else 100.0,
                "browser_cache_hits": request_count if state == "cache" else 0,
                "uploaded_bytes": 0 if state == "cache" else request_count,
            }
            report = {
                "scenario": scenario,
                "state": state,
                "summary": summary,
                "runs": [] if state == "cache" else [{
                    "requests": requests,
                    "resources": resources,
                }],
                "replay": {"ocr_mode": "verify", "ollama_mode": "verify"},
                "health": {"ollama": {
                    "status": "cold",
                    "service_started_at_unix": 100.0,
                    "observed_at_unix": 101.0,
                }},
                "warmups": 0 if state == "cold" else 1,
            }
            path = root / f"{prefix}-{scenario}-{state}.json"
            path.write_text(json.dumps(report), encoding="utf-8")
            paths.append(path)
        return paths

    @staticmethod
    def _write_ordinary_report(path: Path, median_ms: float) -> None:
        """Write one valid ordinary warm report for fail-closed matrix tests."""
        path.write_text(json.dumps({
            "scenario": "ordinary",
            "state": "warm",
            "summary": {
                "request_count": 10,
                "request_median_ms": median_ms,
                "request_p95_ms": median_ms,
                "peak_vram_mib": 1000,
            },
            "runs": [],
        }), encoding="utf-8")

    @staticmethod
    def _write_worker_reports(
        root: Path,
        prefix: str,
        throughput: float,
        p95: float,
        vram: int,
    ) -> list[Path]:
        """Write minimal ordinary and queue reports for recommendation tests."""
        paths = []
        for scenario in ("ordinary", "queue10"):
            path = root / f"{prefix}-{scenario}.json"
            path.write_text(json.dumps({
                "scenario": scenario,
                "state": "warm",
                "request_concurrency": 2,
                "summary": {
                    "throughput_pages_per_minute": throughput,
                    "request_p95_ms": p95,
                    "peak_vram_mib": vram,
                },
            }), encoding="utf-8")
            paths.append(path)
        return paths


if __name__ == "__main__":
    unittest.main()
