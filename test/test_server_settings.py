"""Dependency-free tests for benchmark-gated public service settings."""

from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from server.settings import load_server_settings


class ServerSettingsTests(unittest.TestCase):
    """Keep browser concurrency opt-in, bounded, and CLI-overridable."""

    def test_environment_concurrency_is_capped_at_two(self) -> None:
        """The supported single-versus-double gate cannot advertise more than two."""
        with patch.dict(os.environ, {"MT_RECOMMENDED_CLIENT_CONCURRENCY": "9"}):
            settings = load_server_settings()

        self.assertEqual(settings.recommended_client_concurrency, 2)

    def test_cli_concurrency_overrides_environment(self) -> None:
        """An explicit benchmark-approved CLI value wins over stale environment state."""
        with patch.dict(os.environ, {"MT_RECOMMENDED_CLIENT_CONCURRENCY": "2"}):
            settings = load_server_settings(
                cli_recommended_client_concurrency=1,
            )

        self.assertEqual(settings.recommended_client_concurrency, 1)

    def test_invalid_environment_concurrency_falls_back_to_one(self) -> None:
        """Malformed environment input must retain the safe single-worker default."""
        with patch.dict(os.environ, {"MT_RECOMMENDED_CLIENT_CONCURRENCY": "invalid"}):
            settings = load_server_settings()

        self.assertEqual(settings.recommended_client_concurrency, 1)


if __name__ == "__main__":
    unittest.main()
