"""Integration-level regression coverage for narrow AOT inputs."""

import asyncio
import logging
import os
import unittest


try:
    import numpy as np
    import torch

    from manga_translator.config import InpainterConfig
    from manga_translator.inpainting.inpainting_aot import AotInpainter
except ModuleNotFoundError as import_error:
    ML_RUNTIME_AVAILABLE = False
    ML_RUNTIME_IMPORT_ERROR = str(import_error)
    torch = None
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

    def test_boundary_dimensions_and_orientations_are_safe(self):
        """Short edges 64, 65, 71, and 72 work in both orientations."""
        for short_edge in (64, 65, 71, 72):
            for shape in ((short_edge, 2048), (2048, short_edge)):
                with self.subTest(shape=shape):
                    inpainter = object.__new__(AotInpainter)
                    inpainter.device = "cpu"
                    inpainter.logger = logging.getLogger("test-aot-boundaries")
                    inpainter.model = _AotGeometryGuard()
                    image = np.full((*shape, 3), 83, dtype=np.uint8)
                    mask = np.zeros(shape, dtype=np.uint8)

                    result = asyncio.run(inpainter._infer(
                        image, mask, InpainterConfig(), inpainting_size=2048
                    ))

                    self.assertEqual(result.shape, image.shape)
                    self.assertGreater(min(inpainter.model.input_shape) // 4, 16)
                    np.testing.assert_array_equal(result, image)

    def test_mask_variants_preserve_every_unmasked_pixel(self):
        """Empty, edge, and full-width masks keep all outside pixels exact."""
        image = np.arange(80 * 256 * 3, dtype=np.uint8).reshape(80, 256, 3)
        masks = []
        masks.append(np.zeros((80, 256), dtype=np.uint8))
        edge_mask = np.zeros((80, 256), dtype=np.uint8)
        edge_mask[:, :7] = 255
        masks.append(edge_mask)
        full_width_mask = np.zeros((80, 256), dtype=np.uint8)
        full_width_mask[35:45, :] = 255
        masks.append(full_width_mask)

        for mask in masks:
            with self.subTest(mask_pixels=int(np.count_nonzero(mask))):
                inpainter = object.__new__(AotInpainter)
                inpainter.device = "cpu"
                inpainter.logger = logging.getLogger("test-aot-masks")
                inpainter.model = _AotGeometryGuard()
                result = asyncio.run(inpainter._infer(
                    image, mask, InpainterConfig(), inpainting_size=2048
                ))

                self.assertEqual(result.shape, image.shape)
                outside = mask < 127
                np.testing.assert_array_equal(result[outside], image[outside])


@unittest.skipUnless(
    ML_RUNTIME_AVAILABLE
    and os.getenv("MANGA_RUN_AOT_MODEL_INTEGRATION", "").lower()
    in {"1", "true", "yes", "on"}
    and torch is not None
    and torch.cuda.is_available(),
    "set MANGA_RUN_AOT_MODEL_INTEGRATION=1 on an NVIDIA host",
)
class AotRealModelIntegrationTest(unittest.IsolatedAsyncioTestCase):
    """Run the complete narrow-input matrix through the downloaded AOT model."""

    async def asyncSetUp(self) -> None:
        """Load the real AOT checkpoint on CUDA once for each integration test."""
        self.inpainter = AotInpainter()
        await self.inpainter.load("cuda")

    async def asyncTearDown(self) -> None:
        """Release the model after the opt-in matrix finishes."""
        await self.inpainter.unload()

    async def test_real_model_narrow_shapes_and_masks(self) -> None:
        """Verify all requested dimensions, orientations, and mask variants."""
        shapes = [
            (2048, 56), (56, 2048),
            (2048, 64), (64, 2048),
            (2048, 65), (65, 2048),
            (2048, 71), (71, 2048),
            (2048, 72), (72, 2048),
        ]
        for height, width in shapes:
            with self.subTest(shape=(height, width)):
                image = np.full((height, width, 3), 127, dtype=np.uint8)
                mask = np.zeros((height, width), dtype=np.uint8)
                mask[max(0, height // 2 - 2):height // 2 + 2, :] = 255
                result = await self.inpainter._infer(
                    image, mask, InpainterConfig(), inpainting_size=2048
                )
                self.assertEqual(result.shape, image.shape)
                np.testing.assert_array_equal(result[mask < 127], image[mask < 127])

        image = np.full((2048, 56, 3), 91, dtype=np.uint8)
        masks = [np.zeros((2048, 56), dtype=np.uint8)]
        edge_mask = np.zeros((2048, 56), dtype=np.uint8)
        edge_mask[:, :6] = 255
        masks.append(edge_mask)
        full_width_mask = np.zeros((2048, 56), dtype=np.uint8)
        full_width_mask[1000:1010, :] = 255
        masks.append(full_width_mask)
        for mask in masks:
            with self.subTest(mask_pixels=int(np.count_nonzero(mask))):
                result = await self.inpainter._infer(
                    image, mask, InpainterConfig(), inpainting_size=2048
                )
                self.assertEqual(result.shape, image.shape)
                np.testing.assert_array_equal(result[mask < 127], image[mask < 127])


if __name__ == "__main__":
    unittest.main()
