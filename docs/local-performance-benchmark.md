# Local full-pipeline performance benchmark

This benchmark covers the browser-facing HTTP path, queue, one model worker,
native Ollama translation, image processing, final PNG publication, and result
download. It intentionally does not lower model resolutions or thresholds.

## Recommended local configuration

- Run one model worker per GPU. `run_server.bat` now defaults to `--instances 1`
  and does not enable `--verbose`.
- Set `OLLAMA_MODEL` to the existing local model and use translator `ollama`.
- Set `OLLAMA_NUM_PARALLEL=1` in the Ollama service environment and leave
  `OLLAMA_KEEP_ALIVE=5m` unless a different residency policy is required.
- The userscript defaults to `http://127.0.0.1:8001`, native Ollama, multipart,
  automatic Web fast-path negotiation, one GPU task, and one prepared page ahead.
  Existing stored settings are preserved.

## Deterministic fixture recording

Record OCR and native Ollama responses once, outside measured runs:

```powershell
$env:MANGA_REPLAY_MODE = "record"
$env:MANGA_REPLAY_PATH = "benchmark-results/replay.json"
uv run python server/main.py --host 127.0.0.1 --port 8001 --use-gpu --instances 1
```

Submit every fixture once, then restart both baseline and candidate builds with:

```powershell
$env:MANGA_REPLAY_MODE = "verify"
$env:MANGA_REPLAY_PATH = "benchmark-results/replay.json"
```

Replay keys include compressed-image identity plus detected OCR geometry and the
logical region query set. A missing or geometrically incompatible fixture fails
fast. In `verify` mode the real OCR and Ollama calls still execute, so measured
latency, model loading, token counts, and generation timings remain full-chain;
only their mutable text/color outputs are replaced with recorded values before
post-processing and rendering. This makes OCR text, region mapping, translation
output, and final pixels comparable without deleting model work from the timing.
The release comparator rejects `--deterministic` evidence unless both stages
were configured as `verify`. Plain `replay` remains available for fast functional
checks, but is not valid release-performance evidence.

## Matrix

Use a real ordinary page, a high-density page, and the original 704×26000
reproduction image for final GPU acceptance. CI may substitute a synthetic long
PNG, but it is not evidence for the release latency thresholds.

```powershell
uv run python devscripts/generate_synthetic_long_png.py benchmark-results/synthetic-704x26000.png
```

```powershell
uv run python devscripts/benchmark_local_pipeline.py ordinary.png --scenario ordinary --output benchmark-results/candidate-ordinary.json
uv run python devscripts/benchmark_local_pipeline.py dense.png --scenario dense --output benchmark-results/candidate-dense.json
uv run python devscripts/benchmark_local_pipeline.py original-704x26000.png --scenario long --output benchmark-results/candidate-long.json
uv run python devscripts/benchmark_local_pipeline.py page1.png page2.png --scenario queue10 --output benchmark-results/candidate-queue10.json
uv run python devscripts/benchmark_local_pipeline.py page1.png page2.png --scenario stress30 --output benchmark-results/candidate-stress30.json
```

Also capture the required state-specific ordinary-page reports. Start the cold
command within five minutes of restarting both services. The health snapshot
records service start/observation timestamps and may report Ollama as `cold`,
`warming`, or already `ready` when startup preloading finishes quickly:

```powershell
uv run python devscripts/benchmark_local_pipeline.py ordinary.png --scenario ordinary --state cold --output benchmark-results/candidate-ordinary-cold.json
uv run python devscripts/benchmark_local_pipeline.py --scenario ordinary --state cache --browser-diagnostics benchmark-results/cache-console.log --output benchmark-results/candidate-ordinary-cache.json
```

Defaults implement the required sample counts: ordinary/dense 10 runs, long 3,
10-page queue 3, and 30-page stress 1. One warmup request precedes measurement.
Reports include file read/hash, upload, first byte, worker progress timestamps,
native Ollama token/timing data, final download, bytes, output hash/dimensions,
process RSS (including quartile trend detection), and NVIDIA VRAM when the host
exposes those counters. The sampler prefers project-process VRAM and falls back
to total GPU usage when Windows WDDM reports per-process memory as `N/A`. Each
report also owns a deduplicated
`<output-stem>-artifacts` directory containing final PNGs. These are final
results, not verbose intermediate images, and let the comparator evaluate
decoded pixels when baseline and candidate use different lossless encoders.
Opt-in diagnostics additionally carry only counts and SHA-256 fingerprints for
detection geometry, OCR text, merged regions, and postprocessed translations;
the comparator requires those fingerprints to match and never stores the text
itself in the report.

Enable “性能诊断” in the userscript to emit one `[mit-performance]` JSON line per
image. It includes main-thread Long Task time, upload/download bytes, cache state,
and page replacement timing. Pass its long-task total to the service report with
`--browser-long-task-ms`, or export the console lines and pass the file through
`--browser-diagnostics`.

Use `--state warm` (the default) for release gates. For a cold-start sample,
restart both the manga service and Ollama, then run one request with `--state
cold`; this implicitly disables warmups. Cache measurements must come from the
real userscript because the service client cannot emulate IndexedDB:

```powershell
uv run python devscripts/benchmark_local_pipeline.py `
  --state cache --scenario ordinary `
  --browser-diagnostics benchmark-results/cache-console.log `
  --output benchmark-results/candidate-ordinary-cache.json
```

Browser diagnostics must contain exactly the matrix's expected sample count.
Cache mode rejects reports containing non-cache outcomes, and
records network upload bytes as zero while retaining source-read/hash timings.

Compare before/after reports and enforce the release gates:

```powershell
uv run python devscripts/compare_benchmark_reports.py `
  --baseline benchmark-results/baseline-ordinary-cold.json benchmark-results/baseline-ordinary.json benchmark-results/baseline-ordinary-cache.json benchmark-results/baseline-dense.json benchmark-results/baseline-long.json benchmark-results/baseline-queue10.json benchmark-results/baseline-stress30.json `
  --candidate benchmark-results/candidate-ordinary-cold.json benchmark-results/candidate-ordinary.json benchmark-results/candidate-ordinary-cache.json benchmark-results/candidate-dense.json benchmark-results/candidate-long.json benchmark-results/candidate-queue10.json benchmark-results/candidate-stress30.json `
  --deterministic
```

With deterministic replay, byte-identical final PNGs pass immediately. If PNG
compression bytes differ, the comparator loads the referenced final artifacts
and enforces the rendering quality gate directly: maximum channel difference 2
and PSNR at least 60 dB. It separately requires stage quality fingerprints to
match, so visually hidden OCR or translation drift also fails. Do not delete the
artifact directories until the comparison has completed.

To decide whether a machine may use two full workers, repeat the ordinary and
queue10 runs with `--instances 1` and `--instances 2`, then add
`--single-worker <one-worker reports>` and `--double-worker <two-worker reports>`
to the comparison command. The output recommends two only when queue throughput
improves by more than 10%, ordinary p95 does not regress, and sampled VRAM does
not increase; otherwise it keeps one.

Both one-worker and two-worker comparison runs must use
`--request-concurrency 2`; the comparator rejects a recommendation based on
serial client traffic. This flag is only a benchmark load generator. It does not
change the userscript's default concurrency or bypass the service health cap.

When—and only when—the verdict reports `recommended_instances: 2`, restart the
service with both `--instances 2` and `--recommended-client-concurrency 2` (or
set `MT_RECOMMENDED_CLIENT_CONCURRENCY=2`). The health response caps this value
to the number of launched workers, and the userscript still caps it to the
user's `maxConcurrency`. Without this explicit benchmark approval the service
continues to advertise one.

## AOT regression on Windows/NVIDIA

Run all Python tests through the project environment:

```powershell
uv run python -m unittest test.test_inpainting_geometry test.test_inpainting_aot
```

The integration matrix covers the original 56×2048 failure, short edges 64,
65, 71, and 72 in both orientations, plus empty, edge, and full-width masks. It
uses a geometry guard in regular CI. To run the same matrix through the actual
checkpoint on the original Windows/NVIDIA environment, explicitly enable the
GPU integration before invoking the tests:

```powershell
$env:MANGA_RUN_AOT_MODEL_INTEGRATION = "1"
uv run python -m unittest test.test_inpainting_aot
```

Minimal environments report model integration as skipped. Acceptance requires
the original output size and exact preservation of every unmasked pixel.

The ROI rendering differential tests cover rotation, vertical layout, and
out-of-bounds regions. They enforce a maximum per-channel difference of 2 and
PSNR of at least 60 dB against the previous full-canvas warp.

## Required checks

```powershell
uv run python -m compileall -q manga_translator server test devscripts
uv run python devscripts/check_documentation_coverage.py
uv run python -m unittest test.test_benchmark_replay test.test_config_transport_flags test.test_documentation_coverage test.test_internal_worker_auth test.test_performance_benchmark_tools test.test_server_settings test.test_synthetic_long_fixture test.test_streaming_disconnect test.test_worker_compressed_decode test.test_inpainting_geometry test.test_inpainting_aot test.test_rendering_roi test.test_ollama_translator
cd userscript
pnpm check
```

Do not publish based on a single improved metric. Keep the JSON reports and
verify ordinary median, long-image median, 10-page throughput, every scenario's
p95, browser Long Tasks, peak RAM/VRAM, 30-page memory growth, and deterministic
output equivalence together.
