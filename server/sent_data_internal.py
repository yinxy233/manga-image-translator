import pickle
from typing import Any, Mapping, Optional, Callable

import aiohttp
from PIL.Image import Image
from fastapi import HTTPException

from manga_translator import Config

NotifyType = Optional[Callable[[int, Optional[bytes]], None]]


def _method_attributes(
    image_or_attributes: Image | bytes | dict[str, Any],
    config: Config,
) -> dict[str, Any]:
    """Preserve legacy image calls while allowing explicit batch arguments."""
    if isinstance(image_or_attributes, dict):
        return image_or_attributes
    return {"image": image_or_attributes, "config": config}

class FrameDecoder:
    """Incrementally decode internal status frames without quadratic copies."""

    _HEADER_SIZE = 5

    def __init__(self) -> None:
        """Create an empty decoder buffer."""
        self._buffer = bytearray()
        self._cursor = 0

    def feed(self, chunk: bytes) -> list[tuple[int, bytes]]:
        """Append one transport chunk and return all complete frames.

        Args:
            chunk: Newly received response bytes.

        Returns:
            A list of ``(status, payload)`` frames in wire order.
        """
        if chunk:
            self._buffer.extend(chunk)

        frames: list[tuple[int, bytes]] = []
        while len(self._buffer) - self._cursor >= self._HEADER_SIZE:
            start = self._cursor
            status = self._buffer[start]
            expected_size = int.from_bytes(self._buffer[start + 1:start + 5], "big")
            frame_end = start + self._HEADER_SIZE + expected_size
            if frame_end > len(self._buffer):
                break
            frames.append((status, bytes(self._buffer[start + 5:frame_end])))
            self._cursor = frame_end

        if self._cursor and (
            self._cursor == len(self._buffer) or self._cursor >= 1024 * 1024
        ):
            del self._buffer[:self._cursor]
            self._cursor = 0
        return frames

    def remainder(self) -> bytes:
        """Return the unconsumed partial frame for compatibility helpers."""
        return bytes(self._buffer[self._cursor:])


async def fetch_data_stream(
    url: str,
    image: Image | bytes | dict[str, Any],
    config: Config,
    sender: NotifyType,
    headers: Optional[Mapping[str, str]] = None,
):
    """Send an internal translation request and incrementally relay frames."""
    attributes = _method_attributes(image, config)
    data = pickle.dumps(attributes)

    async with aiohttp.ClientSession() as session:
        async with session.post(url, data=data, headers=headers or {}) as response:
            if response.status == 200:
                await process_stream(response, sender)
            else:
                raise HTTPException(response.status, detail=await response.text())

async def fetch_data(
    url: str,
    image: Image | bytes | dict[str, Any],
    config: Config,
    headers: Optional[Mapping[str, str]] = None,
):
    """Send an internal non-streaming translation request."""
    attributes = _method_attributes(image, config)
    data = pickle.dumps(attributes)

    async with aiohttp.ClientSession() as session:
        async with session.post(url, data=data, headers=headers or {}) as response:
            if response.status == 200:
                return pickle.loads(await response.read())
            else:
                raise HTTPException(response.status, detail=await response.text())

async def process_stream(response, sender: NotifyType):
    """Relay a fragmented worker response to a public-server callback."""
    decoder = FrameDecoder()
    terminal_seen = False

    async for chunk in response.content.iter_any():
        for status, data in decoder.feed(chunk):
            terminal_seen = terminal_seen or status in (0, 2)
            if sender:
                sender(status, data)
    if decoder.remainder():
        raise RuntimeError("Internal worker stream ended with a truncated frame.")
    if not terminal_seen:
        raise RuntimeError("Internal worker stream ended without a result or error frame.")



def handle_buffer(buffer, sender: NotifyType):
    """Decode complete frames from one buffer; retained for API compatibility."""
    decoder = FrameDecoder()
    for status, data in decoder.feed(buffer):
        if sender:
            sender(status, data)
    return decoder.remainder()


def extract_header(buffer):
    """Extract the status and expected size from a five-byte frame header."""
    status = int.from_bytes(buffer[0:1], byteorder='big')
    expected_size = int.from_bytes(buffer[1:5], byteorder='big')
    return status, expected_size
