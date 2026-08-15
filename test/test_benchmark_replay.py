"""Dependency-free tests for deterministic benchmark replay storage."""

import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


MODULE_PATH = Path(__file__).parents[1] / "manga_translator" / "benchmark_replay.py"
MODULE_SPEC = importlib.util.spec_from_file_location("benchmark_replay", MODULE_PATH)
assert MODULE_SPEC is not None and MODULE_SPEC.loader is not None
REPLAY = importlib.util.module_from_spec(MODULE_SPEC)
MODULE_SPEC.loader.exec_module(REPLAY)


class JsonReplayStoreTests(unittest.TestCase):
    """Validate stable keys, namespace isolation, and atomic persistence."""

    def test_canonical_key_ignores_mapping_order(self):
        """Semantically identical request mappings share a replay key."""
        left = REPLAY.JsonReplayStore.canonical_key({"model": "qwen", "messages": [1, 2]})
        right = REPLAY.JsonReplayStore.canonical_key({"messages": [1, 2], "model": "qwen"})
        self.assertEqual(left, right)

    def test_namespaces_share_one_file_without_overwriting(self):
        """OCR and Ollama fixtures coexist in the same compact JSON document."""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "replay.json"
            ocr = REPLAY.JsonReplayStore(path, "ocr")
            ollama = REPLAY.JsonReplayStore(path, "ollama")
            ocr.put("page", [{"text": "原文"}])
            ollama.put("prompt", {"message": {"content": "译文"}})

            self.assertEqual(ocr.require("page"), [{"text": "原文"}])
            self.assertEqual(
                ollama.require("prompt"), {"message": {"content": "译文"}}
            )
            self.assertEqual(list(path.parent.glob("replay.json.*.tmp")), [])

    def test_verify_mode_is_distinct_from_model_skipping_replay(self):
        """Release benchmarks can request live timing with deterministic output."""
        with patch.dict(os.environ, {"MANGA_OCR_REPLAY_MODE": "verify"}):
            self.assertEqual(REPLAY.replay_mode("ocr"), "verify")


if __name__ == "__main__":
    unittest.main()
