from __future__ import annotations

import asyncio
import builtins
import io
import logging
import re
from base64 import b64decode
from collections.abc import Callable
from typing import Any, NoReturn

import aiohttp
from PIL import Image, UnidentifiedImageError
from fastapi import HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from manga_translator import Config
from server.myqueue import BatchQueueElement, QueueElement, task_queue, wait_in_queue
from server.streaming import notify, stream


logger = logging.getLogger(__name__)
DATA_URL_PATTERN = re.compile(r"^data:image/.+;base64,", re.IGNORECASE)
REMOTE_IMAGE_TIMEOUT = aiohttp.ClientTimeout(total=20)


class TranslateRequest(BaseModel):
    """Translation request payload for JSON endpoints."""

    image: bytes | str
    """Source image bytes, data URL, or remote HTTP(S) image URL."""

    config: Config = Config()
    """Translation configuration payload."""


class BatchTranslateRequest(BaseModel):
    """Batch translation request payload."""

    images: list[bytes | str]
    """Source image list containing bytes, data URLs, or remote HTTP(S) URLs."""

    config: Config = Config()
    """Translation configuration payload."""

    batch_size: int = 4
    """Batch size processed by the downstream worker."""


def _raise_invalid_image(detail: str, error: Exception | None = None) -> NoReturn:
    """Raise a stable 422 error for invalid public image inputs.

    Args:
        detail: User-facing error message.
        error: Optional underlying exception used for structured logging.

    Raises:
        HTTPException: Always raised with status code 422.
    """
    if error is None:
        logger.warning("Invalid image input: %s", detail)
    else:
        logger.warning("Invalid image input: %s", detail, exc_info=error)
    raise HTTPException(status_code=422, detail=detail)


def _open_image_from_bytes(image_bytes: bytes) -> Image.Image:
    """Create a fully loaded PIL image from raw bytes.

    Args:
        image_bytes: Raw image payload.

    Returns:
        A fully loaded PIL image instance.

    Raises:
        HTTPException: Raised when the bytes cannot be decoded as an image.
    """
    try:
        image = Image.open(io.BytesIO(image_bytes))
        image.load()
        return image
    except UnidentifiedImageError as error:
        _raise_invalid_image("Image payload could not be decoded.", error)
    except OSError as error:
        _raise_invalid_image("Image payload could not be decoded.", error)


async def _fetch_remote_image_bytes(image_url: str) -> bytes:
    """Fetch an image from a public remote URL.

    Args:
        image_url: Public HTTP(S) image URL.

    Returns:
        The downloaded raw image bytes.

    Raises:
        HTTPException: Raised when the remote image cannot be fetched or validated.
    """
    # 这里明确只支持服务端直接抓取公开图片，避免引入浏览器 Cookie 透传带来的安全边界扩大。
    if not image_url.lower().startswith(("http://", "https://")):
        _raise_invalid_image("Only HTTP(S) image URLs are supported.")

    try:
        async with aiohttp.ClientSession(timeout=REMOTE_IMAGE_TIMEOUT) as session:
            async with session.get(image_url) as response:
                if response.status != 200:
                    _raise_invalid_image(f"Remote image request failed with status {response.status}.")

                content_type = response.headers.get("Content-Type", "").lower()
                if content_type and not content_type.startswith("image/"):
                    _raise_invalid_image("Remote URL did not return an image response.")

                return await response.read()
    except asyncio.TimeoutError as error:
        logger.warning("Timed out while fetching remote image: %s", image_url, exc_info=error)
        raise HTTPException(status_code=422, detail="Remote image request timed out.") from error
    except aiohttp.ClientError as error:
        logger.warning("Failed to fetch remote image: %s", image_url, exc_info=error)
        raise HTTPException(status_code=422, detail="Failed to fetch remote image.") from error


async def to_pil_image(image: str | bytes) -> Image.Image:
    """Convert a public request image payload into a PIL image.

    Args:
        image: Raw bytes, data URL, or remote HTTP(S) URL.

    Returns:
        A loaded PIL image instance.

    Raises:
        HTTPException: Raised when the payload is invalid or cannot be fetched.
    """
    if isinstance(image, builtins.bytes):
        return _open_image_from_bytes(image)

    if DATA_URL_PATTERN.match(image):
        encoded_value = image.split(",", 1)[1]
        try:
            image_data = b64decode(encoded_value)
        except ValueError as error:
            _raise_invalid_image("Image data URL is not valid base64.", error)
        return _open_image_from_bytes(image_data)

    remote_image_bytes = await _fetch_remote_image_bytes(image)
    return _open_image_from_bytes(remote_image_bytes)


async def get_ctx(req: Request, config: Config, image: str | bytes) -> Any:
    """Resolve a single translation context through the shared queue.

    Args:
        req: Incoming FastAPI request.
        config: Parsed translation configuration.
        image: Raw bytes, data URL, or remote URL.

    Returns:
        The translated execution context returned by the worker queue.
    """
    pil_image = await to_pil_image(image)

    task = QueueElement(req, pil_image, config, 0)
    task_queue.add_task(task)

    return await wait_in_queue(task, None)


async def while_streaming(
    req: Request,
    transform: Callable[[Any], bytes],
    config: Config,
    image: bytes | str,
) -> StreamingResponse:
    """Create a streaming translation response for a single image request.

    Args:
        req: Incoming FastAPI request.
        transform: Result transformer used when the worker emits the final frame.
        config: Parsed translation configuration.
        image: Raw bytes, data URL, or remote URL.

    Returns:
        A streaming response over the shared queue protocol.
    """
    pil_image = await to_pil_image(image)

    task = QueueElement(req, pil_image, config, 0)
    task_queue.add_task(task)

    messages: asyncio.Queue[bytes] = asyncio.Queue()

    def notify_internal(code: int, data: bytes) -> None:
        """Forward queue notifications into the streaming response buffer.

        Args:
            code: Queue protocol status code.
            data: Queue protocol payload.
        """
        notify(code, data, transform, messages)

    streaming_response = StreamingResponse(stream(messages), media_type="application/octet-stream")
    asyncio.create_task(wait_in_queue(task, notify_internal))
    return streaming_response


async def get_batch_ctx(
    req: Request,
    config: Config,
    images: list[str | bytes],
    batch_size: int = 4,
) -> Any:
    """Resolve a batch translation request through the shared queue.

    Args:
        req: Incoming FastAPI request.
        config: Parsed translation configuration.
        images: Source images to convert before queueing.
        batch_size: Downstream batch size for worker execution.

    Returns:
        The translated batch result from the worker queue.
    """
    pil_images = [await to_pil_image(image) for image in images]

    batch_task = BatchQueueElement(req, pil_images, config, batch_size)
    task_queue.add_task(batch_task)

    return await wait_in_queue(batch_task, None)
