#!/usr/bin/env python3
"""Check docstrings/JSDoc for public symbols changed by the local pipeline work."""

from __future__ import annotations

import ast
import json
import re
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).parents[1]
MINIMUM_COVERAGE = 90.0

PYTHON_MODULES = (
    "manga_translator/benchmark_replay.py",
    "manga_translator/translators/ollama.py",
    "server/ollama_runtime.py",
    "devscripts/benchmark_local_pipeline.py",
    "devscripts/compare_benchmark_reports.py",
    "devscripts/generate_synthetic_long_png.py",
)

PYTHON_SYMBOLS = {
    "manga_translator/detection/default.py": ("det_batch_forward_default",),
    "manga_translator/manga_translator.py": ("MangaTranslator.translate",),
    "manga_translator/mode/share.py": (
        "restricted_loads",
        "MethodCall",
        "MangaShare",
        "MangaShare.progress_stream",
        "MangaShare.run_method",
        "MangaShare.check_nonce",
        "MangaShare.check_lock",
        "MangaShare.get_fn",
        "MangaShare.listen",
    ),
    "manga_translator/rendering/__init__.py": ("render",),
    "manga_translator/rendering/gimp_render.py": ("gimp_render",),
    "manga_translator/translators/__init__.py": ("get_translator",),
    "manga_translator/translators/common.py": ("CommonTranslator.translate",),
    "server/instance.py": (
        "ExecutorInstance",
        "ExecutorInstance.sent",
        "ExecutorInstance.sent_stream",
        "ExecutorInstance.sent_batch",
        "ExecutorInstance.sent_batch_stream",
        "Executors",
        "Executors.register",
        "Executors.free_executors",
        "Executors.find_executor",
        "Executors.free_executor",
    ),
    "server/main.py": (
        "warm_local_ollama",
        "build_health_payload",
        "register_instance",
        "health",
        "transform_to_image",
        "image",
        "stream_image",
        "stream_image_web",
        "image_form",
        "stream_image_form",
        "stream_image_form_web",
        "get_result_by_folder",
        "batch_images",
    ),
    "server/myqueue.py": (
        "QueueElement",
        "QueueElement.get_image",
        "QueueElement.is_client_disconnected",
        "BatchQueueElement",
        "BatchQueueElement.is_client_disconnected",
        "TaskQueue",
        "TaskQueue.add_task",
        "TaskQueue.get_pos",
        "TaskQueue.update_event",
        "TaskQueue.remove",
        "TaskQueue.wait_for_event",
        "wait_in_queue",
    ),
    "server/request_extraction.py": (
        "TranslateRequest",
        "BatchTranslateRequest",
        "to_pil_image",
        "to_image_bytes",
        "get_ctx",
        "while_streaming",
        "get_batch_ctx",
    ),
    "server/settings.py": ("ServerSettings", "load_server_settings"),
    "server/sent_data_internal.py": (
        "FrameDecoder",
        "FrameDecoder.feed",
        "FrameDecoder.remainder",
        "fetch_data_stream",
        "fetch_data",
        "process_stream",
        "handle_buffer",
        "extract_header",
    ),
    "server/streaming.py": ("stream", "notify"),
}

TYPESCRIPT_SYMBOLS = {
    "front/app/types.ts": ("TranslatorKey", "validTranslators"),
    "userscript/src/cache.ts": (
        "TranslationCacheRecord",
        "TranslationCacheStore",
        "TranslationResultCache",
        "TranslationResultCache.buildKey",
        "TranslationResultCache.buildKeyFromHash",
        "TranslationResultCache.get",
        "TranslationResultCache.clear",
        "TranslationResultCache.set",
    ),
    "userscript/src/config.ts": (
        "DEFAULT_SETTINGS",
        "TRANSLATOR_OPTIONS",
        "STREAM_ENDPOINT_OPTIONS",
        "INITIAL_AUTO_TRANSLATE_SCAN_DELAY_MS",
        "PROGRESS_TEXT_MAP",
    ),
    "userscript/src/core/controller.ts": ("TranslatorController",),
    "userscript/src/core/overlayManager.ts": (
        "OverlayManagerCallbacks",
        "OverlayManager",
    ),
    "userscript/src/core/taskQueue.ts": (
        "CancelReason",
        "QueueTask",
        "TaskQueue",
        "TaskQueue.enqueue",
        "TaskQueue.pause",
        "TaskQueue.resume",
        "TaskQueue.clear",
        "TaskQueue.reset",
        "TaskQueue.cancel",
        "TaskQueue.setMaxConcurrency",
        "TaskQueue.getStats",
    ),
    "userscript/src/storage.ts": ("sanitizeSettings", "loadSettings", "saveSettings"),
    "userscript/src/types.ts": (
        "TranslatorKey",
        "StreamEndpoint",
        "UserscriptSettings",
        "HealthPayload",
        "StreamFrame",
    ),
    "userscript/src/utils/performance.ts": (
        "BrowserPerformanceDiagnostics",
        "BrowserPerformanceDiagnostics.setEnabled",
        "BrowserPerformanceDiagnostics.reset",
        "BrowserPerformanceDiagnostics.begin",
        "BrowserPerformanceDiagnostics.mark",
        "BrowserPerformanceDiagnostics.setSourceBytes",
        "BrowserPerformanceDiagnostics.setUploadBytes",
        "BrowserPerformanceDiagnostics.setServerDiagnostics",
        "BrowserPerformanceDiagnostics.finish",
    ),
    "userscript/src/utils/stream.ts": (
        "StreamFrameParser",
        "StreamFrameParser.push",
        "decodeFrameText",
        "readReadableStream",
    ),
    "userscript/src/utils/transport.ts": (
        "HttpStatusError",
        "TransportClient",
        "TransportClient.checkHealth",
        "TransportClient.fetchImageBlob",
        "TransportClient.translateImage",
    ),
}


def _public_python_nodes(tree: ast.Module) -> Iterable[tuple[str, ast.AST]]:
    """Yield public module/class definitions from one syntax tree."""
    for node in tree.body:
        if not isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if node.name.startswith("_"):
            continue
        yield node.name, node
        if isinstance(node, ast.ClassDef):
            for member in node.body:
                if isinstance(member, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    if not member.name.startswith("_"):
                        yield f"{node.name}.{member.name}", member


def _python_results() -> list[tuple[str, bool]]:
    """Collect documentation results for new modules and selected changed APIs."""
    results: list[tuple[str, bool]] = []
    selected = dict(PYTHON_SYMBOLS)
    for relative_path in PYTHON_MODULES:
        path = ROOT / relative_path
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        selected[relative_path] = tuple(name for name, _ in _public_python_nodes(tree))

    for relative_path, symbols in selected.items():
        path = ROOT / relative_path
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        nodes = dict(_public_python_nodes(tree))
        for symbol in symbols:
            node = nodes.get(symbol)
            documented = node is not None and bool(ast.get_docstring(node))
            results.append((f"{relative_path}:{symbol}", documented))
    return results


def _has_jsdoc(lines: list[str], declaration_index: int) -> bool:
    """Return whether the nearest preceding source block is a JSDoc comment."""
    index = declaration_index - 1
    while index >= 0 and not lines[index].strip():
        index -= 1
    if index < 0 or not lines[index].strip().endswith("*/"):
        return False
    while index >= 0:
        stripped = lines[index].strip()
        if stripped.startswith("/**"):
            return True
        if stripped.startswith("/*") and not stripped.startswith("/**"):
            return False
        index -= 1
    return False


def _typescript_symbol_line(lines: list[str], symbol: str) -> int | None:
    """Locate one exported declaration or named class method."""
    if "." in symbol:
        _, method = symbol.split(".", 1)
        pattern = re.compile(rf"^\s+(?:async\s+)?{re.escape(method)}\s*\(")
    else:
        pattern = re.compile(
            rf"^export\s+(?:(?:declare|async)\s+)?"
            rf"(?:class|function|interface|type|const|enum)\s+{re.escape(symbol)}\b"
        )
    return next((index for index, line in enumerate(lines) if pattern.search(line)), None)


def _typescript_results() -> list[tuple[str, bool]]:
    """Collect JSDoc results for the changed TypeScript public surface."""
    results: list[tuple[str, bool]] = []
    for relative_path, symbols in TYPESCRIPT_SYMBOLS.items():
        lines = (ROOT / relative_path).read_text(encoding="utf-8").splitlines()
        for symbol in symbols:
            line_index = _typescript_symbol_line(lines, symbol)
            results.append((
                f"{relative_path}:{symbol}",
                line_index is not None and _has_jsdoc(lines, line_index),
            ))
    return results


def documentation_report() -> dict[str, object]:
    """Return a machine-readable documentation coverage report."""
    results = _python_results() + _typescript_results()
    missing = [name for name, documented in results if not documented]
    documented = len(results) - len(missing)
    coverage = documented / len(results) * 100 if results else 100.0
    return {
        "documented": documented,
        "total": len(results),
        "coverage_percent": round(coverage, 2),
        "minimum_percent": MINIMUM_COVERAGE,
        "missing": missing,
        "passed": coverage >= MINIMUM_COVERAGE,
    }


def main() -> int:
    """Print the coverage report and fail when it drops below the release gate."""
    report = documentation_report()
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
