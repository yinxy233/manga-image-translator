"""Worker-side tests for compressed-image and legacy PIL payload compatibility."""

from __future__ import annotations

import base64
import hashlib
from pathlib import Path
import pickle
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+g5XsAAAAASUVORK5CYII="
)

try:
    from PIL import Image
    from manga_translator import Context
    from manga_translator.config import Config
    from manga_translator.mode.share import MangaShare
    import manga_translator.manga_translator as translator_module
except ImportError:
    Image = None
    Config = None
    translator_module = None


@unittest.skipUnless(translator_module is not None, "worker dependencies are unavailable")
class WorkerCompressedDecodeTests(unittest.IsolatedAsyncioTestCase):
    """Verify the worker owns the only full pixel decode in the service path."""

    async def test_compressed_payload_is_opened_once_in_worker(self) -> None:
        """Encoded bytes are hashed directly and fully decoded exactly once."""
        translator = translator_module.MangaTranslator({"kernel_size": 3})
        real_open = translator_module.Image.open
        open_calls = 0

        def counting_open(*args, **kwargs):
            """Count worker decodes while delegating to Pillow."""
            nonlocal open_calls
            open_calls += 1
            return real_open(*args, **kwargs)

        async def identity_translate(_config, ctx):
            """Skip model execution after payload preparation."""
            ctx.text_regions = []
            return ctx

        translator._translate = identity_translate
        with patch.object(translator_module.Image, "open", counting_open):
            ctx = await translator.translate(PNG_BYTES, Config(), skip_context_save=True)

        self.assertEqual(open_calls, 1)
        self.assertEqual(ctx.source_digest, hashlib.sha256(PNG_BYTES).hexdigest())

    async def test_legacy_pil_payload_remains_supported(self) -> None:
        """Internal callers that already send PIL images avoid a second decode."""
        translator = translator_module.MangaTranslator({"kernel_size": 3})
        image = Image.new("RGB", (2, 2), color="white")

        async def identity_translate(_config, ctx):
            """Skip model execution after legacy payload preparation."""
            ctx.text_regions = []
            return ctx

        translator._translate = identity_translate
        with patch.object(
            translator_module.Image,
            "open",
            side_effect=AssertionError("legacy PIL payload was decoded again"),
        ):
            ctx = await translator.translate(image, Config(), skip_context_save=True)

        self.assertIs(ctx.input, image)
        self.assertIsNone(ctx.source_digest)

    async def test_final_png_is_atomically_published_without_temp_files(self) -> None:
        """Atomic PNG publication leaves one complete final file behind."""
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "final.png"
            translator_module._atomic_save_png(
                Image.new("RGB", (3, 2), color="white"),
                str(destination),
            )
            with Image.open(destination) as restored:
                restored.load()
                dimensions = restored.size
            remaining_files = [path.name for path in Path(directory).iterdir()]

        self.assertEqual(dimensions, (3, 2))
        self.assertEqual(remaining_files, ["final.png"])

    def test_image_only_batch_serializes_no_intermediate_context_arrays(self) -> None:
        """Public batch image results retain PNG bytes but drop model intermediates."""
        config = Config()
        config._image_result_only = True
        attributes = {
            "images_with_configs": [(PNG_BYTES, config)],
            "batch_size": 2,
        }
        contexts = []
        for _index in range(2):
            context = Context()
            context.result = None
            context.result_png = PNG_BYTES
            context.img_rgb = bytearray(1024)
            context.mask = bytearray(1024)
            contexts.append(context)

        resolved_config = MangaShare._result_config(attributes)
        restored = pickle.loads(
            MangaShare._serialize_result(contexts, resolved_config)
        )

        self.assertIs(resolved_config, config)
        self.assertEqual(len(restored), 2)
        self.assertTrue(all(context.result_png == PNG_BYTES for context in restored))
        self.assertTrue(all("img_rgb" not in context for context in restored))
        self.assertTrue(all("mask" not in context for context in restored))


@unittest.skipUnless(translator_module is not None, "worker dependencies are unavailable")
class TargetLanguageRetryTests(unittest.IsolatedAsyncioTestCase):
    """Ensure native Ollama validation never regenerates valid bubbles."""

    async def test_retry_strategy_is_local_to_native_ollama(self) -> None:
        """Remote-compatible backends retain the historical full-region path."""
        translator = translator_module.MangaTranslator.__new__(
            translator_module.MangaTranslator
        )
        calls: list[str] = []

        async def partial(*_args, **_kwargs) -> bool:
            """Record the native failed-region retry branch."""
            calls.append("partial")
            return True

        async def full(*_args, **_kwargs) -> bool:
            """Record the legacy full-region retry branch."""
            calls.append("full")
            return True

        translator._retry_target_language_mismatches = partial
        translator._retry_all_target_language_regions = full
        context = SimpleNamespace(text_regions=[])
        config = SimpleNamespace(
            translator=SimpleNamespace(translator="ollama")
        )

        self.assertTrue(
            await translator._retry_target_language_failures(context, config)
        )
        config.translator.translator = "custom_openai"
        self.assertTrue(
            await translator._retry_target_language_failures(context, config)
        )

        self.assertEqual(calls, ["partial", "full"])

    async def test_retry_submits_only_mismatched_regions_and_keeps_threshold(self) -> None:
        """Local retry updates failed regions and preserves the caller's ratio gate."""
        valid = SimpleNamespace(text="valid-source", translation="正常")
        failed = SimpleNamespace(text="failed-source", translation="wrong")
        context = SimpleNamespace(text_regions=[valid, failed])
        config = SimpleNamespace(translator=SimpleNamespace(
            post_check_max_retry_attempts=1,
            target_lang="CHS",
        ), render=SimpleNamespace(uppercase=False, lowercase=False))
        translator = translator_module.MangaTranslator.__new__(
            translator_module.MangaTranslator
        )
        submitted: list[list[str]] = []
        thresholds: list[float] = []

        translator._find_target_language_mismatches = (
            lambda regions, _target: [failed] if failed.translation == "wrong" else []
        )

        async def translate_failed(texts, _config, _context):
            """Capture the retry request and return one corrected translation."""
            submitted.append(list(texts))
            return ["修复"]

        async def check_ratio(_regions, _target, min_ratio):
            """Record the threshold and pass after the failed region is updated."""
            thresholds.append(min_ratio)
            return failed.translation == "修复"

        translator._batch_translate_texts = translate_failed
        translator._check_target_language_ratio = check_ratio

        passed = await translator._retry_target_language_mismatches(
            context,
            config,
            min_ratio=0.3,
        )

        self.assertTrue(passed)
        self.assertEqual(submitted, [["failed-source"]])
        self.assertEqual(valid.translation, "正常")
        self.assertEqual(failed.translation, "修复")
        self.assertEqual(thresholds, [0.3])

    def test_retried_region_reuses_source_aware_punctuation_rules(self) -> None:
        """Local retries receive the same quotation correction as first output."""
        region = SimpleNamespace(text="「原文」", translation='"译文"')
        config = SimpleNamespace(render=SimpleNamespace(
            uppercase=False,
            lowercase=False,
        ))
        translator = translator_module.MangaTranslator.__new__(
            translator_module.MangaTranslator
        )

        translator._postprocess_retried_translation(region, config, [])

        self.assertEqual(region.translation, "「译文」")


if __name__ == "__main__":
    unittest.main()
