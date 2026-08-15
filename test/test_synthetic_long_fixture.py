"""Tests for the dependency-free synthetic long-page PNG generator."""

from __future__ import annotations

import importlib.util
from pathlib import Path
import tempfile
import unittest


MODULE_PATH = Path(__file__).parents[1] / "devscripts" / "generate_synthetic_long_png.py"
MODULE_SPEC = importlib.util.spec_from_file_location("generate_synthetic_long_png", MODULE_PATH)
assert MODULE_SPEC is not None and MODULE_SPEC.loader is not None
GENERATOR = importlib.util.module_from_spec(MODULE_SPEC)
MODULE_SPEC.loader.exec_module(GENERATOR)


class SyntheticLongFixtureTests(unittest.TestCase):
    """Validate deterministic PNG structure without Pillow or NumPy."""

    def test_generated_png_has_requested_dimensions(self) -> None:
        """IHDR width and height match the requested fixture geometry."""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fixture.png"
            GENERATOR.write_synthetic_long_png(path, width=64, height=96)
            payload = path.read_bytes()

        self.assertEqual(payload[:8], GENERATOR.PNG_SIGNATURE)
        self.assertEqual(int.from_bytes(payload[16:20], "big"), 64)
        self.assertEqual(int.from_bytes(payload[20:24], "big"), 96)


if __name__ == "__main__":
    unittest.main()
