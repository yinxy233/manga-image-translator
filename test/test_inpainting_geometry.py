"""Regression tests for model input geometry constraints."""

import importlib.util
from pathlib import Path
import unittest


# Load the dependency-free geometry module directly so this focused test does
# not require the optional ML runtime imported by the application package.
MODULE_PATH = Path(__file__).parents[1] / "manga_translator" / "inpainting_geometry.py"
MODULE_SPEC = importlib.util.spec_from_file_location("inpainting_geometry", MODULE_PATH)
assert MODULE_SPEC is not None and MODULE_SPEC.loader is not None
INPAINTING_GEOMETRY = importlib.util.module_from_spec(MODULE_SPEC)
MODULE_SPEC.loader.exec_module(INPAINTING_GEOMETRY)
calculate_minimum_padding = INPAINTING_GEOMETRY.calculate_minimum_padding


class CalculateMinimumPaddingTest(unittest.TestCase):
    """Verify that narrow model inputs are padded without changing valid inputs."""

    def test_pads_reported_aot_failure_width_to_safe_dimension(self):
        """The reported 2048x56 input must become 2048x72 for AOT."""
        padding = calculate_minimum_padding(height=2048, width=56, minimum_dimension=72)

        self.assertEqual((padding.top, padding.bottom), (0, 0))
        self.assertEqual((padding.left, padding.right), (8, 8))
        self.assertEqual(padding.padded_shape(2048, 56), (2048, 72))
        self.assertGreater(min(padding.padded_shape(2048, 56)) // 4, 16)

    def test_splits_odd_padding_without_losing_a_pixel(self):
        """Asymmetric one-pixel remainders must preserve the requested size."""
        padding = calculate_minimum_padding(height=65, width=100, minimum_dimension=72)

        self.assertEqual((padding.top, padding.bottom), (3, 4))
        self.assertEqual(padding.padded_shape(65, 100), (72, 100))

    def test_leaves_safe_dimensions_unchanged(self):
        """Models without a minimum or already-safe inputs must not be padded."""
        no_minimum = calculate_minimum_padding(height=56, width=2048, minimum_dimension=0)
        already_safe = calculate_minimum_padding(height=72, width=2048, minimum_dimension=72)

        self.assertTrue(no_minimum.is_empty)
        self.assertTrue(already_safe.is_empty)


if __name__ == "__main__":
    unittest.main()
