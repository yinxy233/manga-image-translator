"""Tests for nonce propagation between the public service and model workers."""

from __future__ import annotations

import asyncio
import unittest
from unittest.mock import patch


try:
    import server.instance as instance_module
except ModuleNotFoundError:
    instance_module = None


@unittest.skipUnless(instance_module is not None, "server dependencies are unavailable")
class InternalWorkerAuthTests(unittest.TestCase):
    """Ensure every private worker transport uses the configured nonce."""

    def test_non_streaming_request_includes_nonce_header(self) -> None:
        """A regular worker call authenticates with the startup nonce."""
        captured: dict[str, object] = {}

        async def fake_fetch_data(*_args, **kwargs):
            """Capture transport keyword arguments without opening a socket."""
            captured.update(kwargs)
            return object()

        executor = instance_module.ExecutorInstance(
            ip="127.0.0.1",
            port=8002,
            nonce="internal-secret",
        )
        with patch.object(instance_module, "fetch_data", fake_fetch_data):
            asyncio.run(executor.sent(b"image", object()))

        self.assertEqual(captured["headers"], {"X-Nonce": "internal-secret"})

    def test_disabled_nonce_sends_no_authentication_header(self) -> None:
        """The legacy explicit ``None`` mode does not send a bogus nonce."""
        executor = instance_module.ExecutorInstance(
            ip="127.0.0.1",
            port=8002,
            nonce="None",
        )

        self.assertEqual(executor._headers(), {})

    def test_streaming_request_includes_nonce_header(self) -> None:
        """A streaming worker call authenticates through the same private channel."""
        captured: dict[str, object] = {}

        async def fake_fetch_data_stream(*_args, **kwargs):
            """Capture transport keyword arguments without opening a socket."""
            captured.update(kwargs)

        executor = instance_module.ExecutorInstance(
            ip="127.0.0.1",
            port=8002,
            nonce="internal-secret",
        )
        with patch.object(
            instance_module,
            "fetch_data_stream",
            fake_fetch_data_stream,
        ):
            asyncio.run(executor.sent_stream(b"image", object(), lambda *_args: None))

        self.assertEqual(captured["headers"], {"X-Nonce": "internal-secret"})


if __name__ == "__main__":
    unittest.main()
