"""Integration-level regression coverage for narrow AOT inputs."""

import asyncio
import logging
import unittest


try:
    import numpy as np

    from manga_translator.config import InpainterConfig
    from manga_translator.inpainting.inpainting_aot import AotInpainter
except ModuleNotFoundError as import_error:
    ML_RUNTIME_AVAILABLE = False
    ML_RUNTIME_IMPORT_ERROR = str(import_error)
else:
    ML_RUNTIME_AVAILABLE = True
    ML_RUNTIME_IMPORT_ERROR = ""


class _AotGeometryGuard:
    """Cheap model double that enforces AOT's real reflection-pad constraint."""

    def __init__(self):
        self.input_shape = None

    def __call__(self, image, mask):
        """Reject inputs that would fail inside AOTBlock's rate-16 branch."""
        self.input_shape = tuple(image.shape[-2:])
        if min(self.input_shape) // 4 <= 16:
            raise RuntimeError(
                "Padding size should be less than the corresponding input dimension"
            )
        return image


@unittest.skipUnless(
    ML_RUNTIME_AVAILABLE,
    f"ML runtime is not installed: {ML_RUNTIME_IMPORT_ERROR}",
)
class AotNarrowInputTest(unittest.TestCase):
    """Exercise the shared preprocessing and postprocessing used by AOT."""

    def test_narrow_webtoon_input_is_padded_for_model_and_cropped_afterward(self):
        """A 2048x56 input must reach AOT as 2048x72 and return as 2048x56."""
        inpainter = object.__new__(AotInpainter)
        inpainter.device = "cpu"
        inpainter.logger = logging.getLogger("test-aot-inpainter")
        inpainter.model = _AotGeometryGuard()
        image = np.zeros((2048, 56, 3), dtype=np.uint8)
        mask = np.zeros((2048, 56), dtype=np.uint8)

        result = asyncio.run(
            inpainter._infer(
                image,
                mask,
                InpainterConfig(),
                inpainting_size=2048,
            )
        )

        self.assertEqual(inpainter.model.input_shape, (2048, 72))
        self.assertEqual(result.shape, image.shape)


if __name__ == "__main__":
    unittest.main()
