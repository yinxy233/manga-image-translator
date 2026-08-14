"""Dependency-free geometry helpers for inpainting model inputs."""

from typing import NamedTuple


class ImagePadding(NamedTuple):
    """Padding widths in the order expected by OpenCV border operations."""

    top: int
    bottom: int
    left: int
    right: int

    @property
    def is_empty(self) -> bool:
        """Return whether applying this padding would leave an image unchanged."""
        return not any(self)

    def padded_shape(self, height: int, width: int) -> tuple[int, int]:
        """Return the image shape after this padding is applied."""
        return (
            height + self.top + self.bottom,
            width + self.left + self.right,
        )

    def crop_slices(self, height: int, width: int) -> tuple[slice, slice]:
        """Return slices that remove this padding from an image."""
        return (
            slice(self.top, self.top + height),
            slice(self.left, self.left + width),
        )


def calculate_minimum_padding(
    height: int,
    width: int,
    minimum_dimension: int,
) -> ImagePadding:
    """Calculate symmetric padding that raises both dimensions to a minimum.

    Odd padding amounts place the extra pixel on the bottom or right. A minimum
    of zero disables padding, which lets model subclasses opt in without
    changing the behavior of other inpainters.
    """
    if height <= 0 or width <= 0:
        raise ValueError("Image dimensions must be positive.")
    if minimum_dimension < 0:
        raise ValueError("Minimum image dimension cannot be negative.")

    missing_height = max(minimum_dimension - height, 0)
    missing_width = max(minimum_dimension - width, 0)
    top = missing_height // 2
    left = missing_width // 2
    return ImagePadding(
        top=top,
        bottom=missing_height - top,
        left=left,
        right=missing_width - left,
    )
