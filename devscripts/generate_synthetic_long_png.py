#!/usr/bin/env python3
"""Generate a deterministic long-page PNG fixture using only the standard library."""

from __future__ import annotations

import argparse
import binascii
import os
from pathlib import Path
import struct
import time
import zlib


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def _chunk(chunk_type: bytes, payload: bytes) -> bytes:
    """Encode one PNG chunk with its length and CRC."""
    checksum = binascii.crc32(chunk_type)
    checksum = binascii.crc32(payload, checksum) & 0xFFFFFFFF
    return (
        struct.pack(">I", len(payload))
        + chunk_type
        + payload
        + struct.pack(">I", checksum)
    )


def _fixture_row(width: int, row_index: int) -> bytes:
    """Build one scanline containing panel borders and text-like dark strokes."""
    row = bytearray([0])
    panel_position = row_index % 1300
    for x in range(width):
        border = x in (8, width - 9) or panel_position in (8, 9, 1290, 1291)
        bubble_band = 90 <= panel_position < 390 and width // 5 <= x < width * 4 // 5
        text_stroke = bubble_band and (panel_position % 31 < 4) and (x % 47 < 31)
        value = 24 if border or text_stroke else 246
        row.extend((value, value, value))
    return bytes(row)


def write_synthetic_long_png(path: Path, width: int = 704, height: int = 26_000) -> None:
    """Atomically write a deterministic RGB long-page benchmark fixture."""
    if width < 16 or height < 16:
        raise ValueError("Synthetic fixture dimensions must both be at least 16 pixels.")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_suffix(
        path.suffix + f".{os.getpid()}.{time.time_ns()}.tmp"
    )
    compressor = zlib.compressobj(level=6)
    compressed_parts: list[bytes] = []
    for row_index in range(height):
        compressed = compressor.compress(_fixture_row(width, row_index))
        if compressed:
            compressed_parts.append(compressed)
    compressed_parts.append(compressor.flush())
    image_data = b"".join(compressed_parts)
    try:
        with temporary_path.open("wb") as output:
            output.write(PNG_SIGNATURE)
            output.write(_chunk(
                b"IHDR",
                struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0),
            ))
            output.write(_chunk(b"IDAT", image_data))
            output.write(_chunk(b"IEND", b""))
        os.replace(temporary_path, path)
    finally:
        if temporary_path.exists():
            temporary_path.unlink()


def build_parser() -> argparse.ArgumentParser:
    """Build the fixture-generator command-line interface."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--width", type=int, default=704)
    parser.add_argument("--height", type=int, default=26_000)
    return parser


def main() -> int:
    """Generate the requested fixture and print its path."""
    args = build_parser().parse_args()
    write_synthetic_long_png(args.output, args.width, args.height)
    print(args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
