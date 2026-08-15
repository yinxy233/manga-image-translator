"""Dependency-light regression coverage for the rendering point-shape contract."""

import ast
from pathlib import Path
import unittest

try:
    import numpy as np
except ImportError as error:  # pragma: no cover - exercised in minimal environments
    np = None
    _IMPORT_ERROR = error


def _load_render_function():
    """Load the production ``render`` function with lightweight test doubles."""
    source_path = (
        Path(__file__).resolve().parents[1]
        / "manga_translator"
        / "rendering"
        / "__init__.py"
    )
    syntax_tree = ast.parse(source_path.read_text(encoding="utf-8"))
    render_node = next(
        node
        for node in syntax_tree.body
        if isinstance(node, ast.FunctionDef) and node.name == "render"
    )
    isolated_module = ast.Module(body=[render_node], type_ignores=[])
    ast.fix_missing_locations(isolated_module)

    class TextRenderDouble:
        """Return a deterministic opaque horizontal text image."""

        @staticmethod
        def put_text_horizontal(*_args, **_kwargs):
            """Return an RGBA box without requiring font dependencies."""
            rgba = np.zeros((40, 80, 4), dtype=np.uint8)
            rgba[:, :, :3] = 255
            rgba[:, :, 3] = 255
            return rgba

    class Cv2Double:
        """Provide the homography API reached after edge measurement."""

        RANSAC = 0

        @staticmethod
        def findHomography(_source, _destination, _method, _threshold):
            """Return a valid transform so the renderer can complete."""
            return np.eye(3, dtype=np.float64), None

    def warp_double(rgba, _matrix, _points, _shape):
        """Return the rendered pixels and matching local bounds."""
        height, width = rgba.shape[:2]
        return rgba, (0, 0, width, height)

    namespace = {
        "TextBlock": object,
        "_warp_rgba_to_local_roi": warp_double,
        "cv2": Cv2Double,
        "fg_bg_compare": lambda foreground, background: (foreground, background),
        "np": np,
        "text_render": TextRenderDouble,
    }
    exec(compile(isolated_module, str(source_path), "exec"), namespace)
    return namespace["render"]


@unittest.skipIf(np is None, "numpy is unavailable")
class RenderingShapeRegressionTests(unittest.TestCase):
    """Exercise the normal batched quadrilateral passed by ``TextBlock``."""

    def test_render_preserves_batched_quadrilateral_for_edge_measurement(self):
        """A ``(1, 4, 2)`` text rectangle must render without axis errors."""

        class Region:
            """Provide the attributes consumed by one horizontal render."""

            font_size = 20
            alignment = "center"
            direction = "h"
            horizontal = True
            target_lang = "CHS"

            @staticmethod
            def get_font_colors():
                """Return contrasting foreground and background colors."""
                return (255, 255, 255), (0, 0, 0)

            @staticmethod
            def get_translation_for_rendering():
                """Return deterministic text for the renderer double."""
                return "test"

        render = _load_render_function()
        image = np.zeros((180, 220, 3), dtype=np.uint8)
        points = np.array(
            [[[30, 40], [170, 40], [170, 120], [30, 120]]],
            dtype=np.float32,
        )

        output = render(image, Region(), points, True, None, False)

        self.assertEqual(output.shape, image.shape)
        self.assertGreater(int(output.sum()), 0)


if __name__ == "__main__":
    unittest.main()
