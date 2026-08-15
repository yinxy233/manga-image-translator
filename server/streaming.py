import asyncio
import pickle
from collections.abc import AsyncIterator, Callable
from typing import Any


async def stream(
    messages: asyncio.Queue[bytes],
    response_closed: asyncio.Event | None = None,
) -> AsyncIterator[bytes]:
    """Yield public protocol frames and signal when the HTTP consumer closes."""
    try:
        while True:
            message = await messages.get()
            yield message
            if message[0] == 0 or message[0] == 2:
                break
    finally:
        response_closed and response_closed.set()


def notify(
    code: int,
    data: bytes,
    transform_to_bytes: Callable[[Any], bytes],
    messages: asyncio.Queue[bytes],
    response_closed: asyncio.Event | None = None,
) -> None:
    """Encode one worker frame unless its public HTTP consumer disconnected."""
    if response_closed and response_closed.is_set():
        return
    if code == 0:
        result_bytes = transform_to_bytes(pickle.loads(data))
        encoded_result = b'\x00' + len(result_bytes).to_bytes(4, 'big') + result_bytes
        messages.put_nowait(encoded_result)
    else:
        encoded_result =code.to_bytes(1, 'big') + len(data).to_bytes(4, 'big') + data
        messages.put_nowait(encoded_result)
