"""Dependency-free tests for public stream disconnect cleanup."""

from __future__ import annotations

import asyncio
import pickle
import unittest

from server.streaming import notify, stream


class StreamingDisconnectTests(unittest.IsolatedAsyncioTestCase):
    """Ensure completed worker results are discarded after HTTP disconnect."""

    async def test_stream_sets_closed_event_when_consumer_stops(self) -> None:
        """Closing the response generator publishes the disconnect signal."""
        messages: asyncio.Queue[bytes] = asyncio.Queue()
        await messages.put(b"\x01\x00\x00\x00\x00")
        response_closed = asyncio.Event()
        generator = stream(messages, response_closed)

        await generator.__anext__()
        await generator.aclose()

        self.assertTrue(response_closed.is_set())

    async def test_terminal_frame_is_not_materialized_after_disconnect(self) -> None:
        """An unused full result never invokes the potentially large transform."""
        messages: asyncio.Queue[bytes] = asyncio.Queue()
        response_closed = asyncio.Event()
        response_closed.set()

        def fail_transform(_result: object) -> bytes:
            """Fail if disconnect cleanup accidentally transforms the result."""
            raise AssertionError("disconnected result was materialized")

        notify(0, pickle.dumps({"result": "unused"}), fail_transform, messages, response_closed)

        self.assertTrue(messages.empty())


if __name__ == "__main__":
    unittest.main()
