"""Regression tests for local-ROI text perspective rendering."""

import unittest

try:
    import cv2
    import numpy as np

    from manga_translator.rendering import _warp_rgba_to_local_roi
except ImportError as error:  # pragma: no cover - exercised in minimal environments
    cv2 = None
    np = None
    _IMPORT_ERROR = error


@unittest.skipIf(cv2 is None, "rendering dependencies are unavailable")
class RenderingRoiTests(unittest.TestCase):
    """Compare the bounded allocation against the previous full-canvas warp."""

    def _assert_matches_legacy(self, points):
        canvas_shape = (2600, 704, 3)
        source = np.zeros((90, 180, 4), dtype=np.uint8)
        source[8:-8, 12:-12, :3] = (40, 170, 250)
        source[8:-8, 12:-12, 3] = 213
        source_points = np.array(
            [[0, 0], [source.shape[1], 0], [source.shape[1], source.shape[0]], [0, source.shape[0]]],
            dtype=np.float32,
        )
        homography, _ = cv2.findHomography(source_points, points, cv2.RANSAC, 5.0)

        full_warp = cv2.warpPerspective(source, homography, (canvas_shape[1], canvas_shape[0]))
        legacy = np.zeros_like(full_warp)
        x, y, width, height = cv2.boundingRect(points.astype(np.int32))
        x0 = max(0, x)
        y0 = max(0, y)
        x1 = min(canvas_shape[1], x + width)
        y1 = min(canvas_shape[0], y + height)
        legacy[y0:y1, x0:x1] = full_warp[y0:y1, x0:x1]
        local, (x0, y0, x1, y1) = _warp_rgba_to_local_roi(
            source, homography, points, canvas_shape
        )
        rebuilt = np.zeros_like(legacy)
        rebuilt[y0:y1, x0:x1] = local

        difference = np.abs(legacy.astype(np.int16) - rebuilt.astype(np.int16))
        self.assertLessEqual(int(difference.max()), 2)
        mse = float(np.mean(difference.astype(np.float64) ** 2))
        psnr = float("inf") if mse == 0 else 20 * np.log10(255.0 / np.sqrt(mse))
        self.assertGreaterEqual(psnr, 60.0)
        self.assertLess(local.shape[0] * local.shape[1], canvas_shape[0] * canvas_shape[1] // 10)

    def test_rotated_region_matches_full_canvas_warp(self):
        """A rotated in-bounds region remains visually equivalent."""
        self._assert_matches_legacy(
            np.array([[240, 900], [440, 850], [470, 970], [270, 1020]], dtype=np.float32)
        )

    def test_out_of_bounds_region_is_clipped(self):
        """A boundary-crossing region does not create invalid negative slices."""
        self._assert_matches_legacy(
            np.array([[-25, 40], [170, 10], [190, 130], [-10, 155]], dtype=np.float32)
        )

    def test_vertical_region_matches_full_canvas_warp(self):
        """A tall vertical text region preserves legacy interpolation output."""
        self._assert_matches_legacy(
            np.array([[510, 420], [590, 430], [565, 810], [485, 795]], dtype=np.float32)
        )


if __name__ == "__main__":
    unittest.main()
