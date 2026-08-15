"""Deterministic tests for native Ollama request semantics."""

from __future__ import annotations

import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

try:
    import httpx
    from manga_translator.translators.common import CommonTranslator
    from manga_translator.translators.ollama import (
        HttpxOllamaChatTransport,
        OllamaTranslator,
    )
    from manga_translator.benchmark_replay import JsonReplayStore
except ImportError as error:  # pragma: no cover - minimal CI environments
    CommonTranslator = object
    HttpxOllamaChatTransport = None
    OllamaTranslator = None
    _IMPORT_ERROR = error


class MemoryOllamaTransport:
    """In-memory adapter that records payloads and serves queued responses."""

    def __init__(self, responses: list[dict]) -> None:
        """Store deterministic responses in request order."""
        self.responses = list(responses)
        self.payloads: list[dict] = []

    async def chat(self, payload: dict) -> dict:
        """Record one request and return its deterministic response."""
        self.payloads.append(payload)
        if not self.responses:
            raise AssertionError("Ollama request was submitted more than once.")
        return self.responses.pop(0)


class SelectiveRetryTranslator(CommonTranslator):
    """Translator double that fails only one region on its first attempt."""

    _LANGUAGE_CODE_MAP = {"CHS": "CHS"}
    _INVALID_REPEAT_COUNT = 1
    _RETRY_FAILED_QUERIES_ONLY = True

    def __init__(self) -> None:
        """Initialize request capture state."""
        super().__init__()
        self.requests: list[list[str]] = []

    async def _translate(self, _from_lang: str, _to_lang: str, queries: list[str]) -> list[str]:
        """Return one empty translation on the initial request."""
        self.requests.append(list(queries))
        if len(self.requests) == 1:
            return ["甲", "", "丙"]
        return ["乙"]


@unittest.skipIf(OllamaTranslator is None, "translator dependencies are unavailable")
class OllamaTranslatorTests(unittest.IsolatedAsyncioTestCase):
    """Validate native payloads, response fields, batching, and timing data."""

    async def test_one_submitted_request_is_not_replayed(self):
        """A successful generation must correspond to exactly one API call."""
        transport = MemoryOllamaTransport([{
            "message": {"content": "<|1|>你好"},
            "load_duration": 2_000_000,
            "prompt_eval_duration": 3_000_000,
            "eval_duration": 4_000_000,
            "prompt_eval_count": 10,
            "eval_count": 2,
        }])
        translator = OllamaTranslator(model="unit-model", transport=transport)

        result = await translator._translate("auto", "Chinese (Simplified)", ["こんにちは"])

        self.assertEqual(result, ["你好"])
        self.assertEqual(len(transport.payloads), 1)
        self.assertIn("keep_alive", transport.payloads[0])
        self.assertEqual(translator.last_metrics["load_ms"], 2.0)
        self.assertEqual(translator.token_count_last, 12)

    async def test_thinking_field_is_accepted_when_content_is_empty(self):
        """Thinking-capable local models may place usable output outside content."""
        transport = MemoryOllamaTransport([
            {"message": {"content": "", "thinking": "<|1|>译文"}}
        ])
        translator = OllamaTranslator(model="unit-model", transport=transport)

        result = await translator._translate("auto", "Chinese (Simplified)", ["原文"])

        self.assertEqual(result, ["译文"])

    async def test_warmup_uses_an_empty_non_generating_chat_request(self):
        """Preloading keeps the model resident without adding prompt content."""
        transport = MemoryOllamaTransport([{}])
        translator = OllamaTranslator(model="unit-model", transport=transport)

        result = await translator.warmup()

        self.assertEqual(result, {"status": "ready", "model": "unit-model"})
        self.assertEqual(len(transport.payloads), 1)
        self.assertNotIn("messages", transport.payloads[0])
        self.assertFalse(transport.payloads[0]["stream"])
        self.assertIn("keep_alive", transport.payloads[0])

    def test_prompt_batches_never_split_a_region(self):
        """Oversized pages are split only between complete bubble strings."""
        translator = OllamaTranslator(
            model="unit-model", transport=MemoryOllamaTransport([])
        )
        translator._prompt_token_budget = lambda _to_lang: 8

        groups = list(translator._assemble_prompts("auto", "Chinese (Simplified)", [
            "first bubble", "second bubble", "third bubble"
        ]))

        self.assertEqual(sum(size for _, size in groups), 3)
        self.assertGreaterEqual(len(groups), 2)
        self.assertTrue(all(size >= 1 for _, size in groups))
        self.assertTrue(all("bubble" in prompt for prompt, _ in groups))

    async def test_validation_retries_only_failed_regions(self):
        """A failed bubble must not cause already valid page text to regenerate."""
        translator = SelectiveRetryTranslator()

        result = await translator.translate("auto", "CHS", ["one", "two", "three"])

        self.assertEqual(result, ["甲", "乙", "丙"])
        self.assertEqual(translator.requests, [["one", "two", "three"], ["two"]])

    async def test_verify_mode_runs_live_generation_but_returns_recorded_text(self):
        """Performance verification retains live metrics and deterministic output."""
        transport = MemoryOllamaTransport([{
            "message": {"content": "<|1|>live-output"},
            "eval_duration": 7_000_000,
            "eval_count": 3,
        }])
        translator = OllamaTranslator(model="unit-model", transport=transport)
        queries = ["source"]
        replay_key = translator._translation_replay_key(
            "auto",
            "Chinese (Simplified)",
            queries,
        )
        with tempfile.TemporaryDirectory() as directory:
            replay_file = Path(directory) / "replay.json"
            JsonReplayStore(replay_file, "ollama").put(replay_key, ["recorded-output"])
            with patch.dict(os.environ, {
                "MANGA_OLLAMA_REPLAY_MODE": "verify",
                "MANGA_REPLAY_PATH": str(replay_file),
            }):
                result = await translator._translate(
                    "auto",
                    "Chinese (Simplified)",
                    queries,
                )

        self.assertEqual(result, ["recorded-output"])
        self.assertEqual(len(transport.payloads), 1)
        self.assertEqual(translator.last_metrics["eval_ms"], 7.0)
        self.assertEqual(translator.token_count_last, 3)


@unittest.skipIf(
    HttpxOllamaChatTransport is None,
    "Ollama HTTP dependencies are unavailable",
)
class OllamaHttpTransportTests(unittest.IsolatedAsyncioTestCase):
    """Verify retry boundaries of the persistent native HTTP adapter."""

    async def test_connect_failure_retries_once_before_submission(self) -> None:
        """One initial connect error may retry without an unbounded loop."""
        attempts = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise httpx.ConnectError("not connected", request=request)
            return httpx.Response(200, json={"message": {"content": "ok"}})

        transport = HttpxOllamaChatTransport(
            http_transport=httpx.MockTransport(handler)
        )
        try:
            response = await transport.chat({"model": "unit-model"})
        finally:
            await transport.close()

        self.assertEqual(response["message"]["content"], "ok")
        self.assertEqual(attempts, 2)

    async def test_read_timeout_is_not_resubmitted(self) -> None:
        """A timeout after request submission surfaces after exactly one call."""
        attempts = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal attempts
            attempts += 1
            raise httpx.ReadTimeout("generation timed out", request=request)

        transport = HttpxOllamaChatTransport(
            http_transport=httpx.MockTransport(handler)
        )
        try:
            with self.assertRaises(httpx.ReadTimeout):
                await transport.chat({"model": "unit-model"})
        finally:
            await transport.close()

        self.assertEqual(attempts, 1)

    async def test_disconnect_after_submission_is_not_resubmitted(self) -> None:
        """A read-side disconnect must not create a second generation."""
        attempts = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal attempts
            attempts += 1
            raise httpx.ReadError("connection closed", request=request)

        transport = HttpxOllamaChatTransport(
            http_transport=httpx.MockTransport(handler)
        )
        try:
            with self.assertRaises(httpx.ReadError):
                await transport.chat({"model": "unit-model"})
        finally:
            await transport.close()

        self.assertEqual(attempts, 1)


if __name__ == "__main__":
    unittest.main()
