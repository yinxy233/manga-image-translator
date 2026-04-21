from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Final

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover
    import tomli as tomllib


logger = logging.getLogger(__name__)
PROJECT_ROOT: Final[Path] = Path(__file__).resolve().parent.parent
DEFAULT_APP_VERSION: Final[str] = "0.1.0"


def _normalize_secret(value: str | None) -> str | None:
    """Normalize optional secret values.

    Args:
        value: Secret value from CLI or environment.

    Returns:
        The normalized secret. Empty strings and ``"None"`` are treated as disabled.
    """
    if value is None:
        return None

    normalized = value.strip()
    if not normalized or normalized.lower() == "none":
        return None
    return normalized


def resolve_app_version() -> str:
    """Resolve the application version from ``pyproject.toml``.

    Returns:
        The project version string. Falls back to ``DEFAULT_APP_VERSION`` when the
        file is unavailable or malformed.
    """
    pyproject_path = PROJECT_ROOT / "pyproject.toml"
    try:
        with pyproject_path.open("rb") as file:
            data = tomllib.load(file)
        return str(data["project"]["version"])
    except (FileNotFoundError, KeyError, TypeError, tomllib.TOMLDecodeError):
        logger.warning("Failed to resolve application version from pyproject.toml.", exc_info=True)
        return DEFAULT_APP_VERSION


@dataclass(slots=True)
class ServerSettings:
    """Runtime settings shared by the public API server.

    Attributes:
        public_api_key: Optional API key required by public endpoints.
        version: Human-readable application version.
    """

    public_api_key: str | None
    version: str


def load_server_settings(cli_api_key: str | None = None) -> ServerSettings:
    """Load server settings from CLI arguments and environment variables.

    Args:
        cli_api_key: Optional API key passed from ``server/args.py``.

    Returns:
        The runtime server settings.
    """
    public_api_key = _normalize_secret(cli_api_key) or _normalize_secret(
        os.getenv("MT_PUBLIC_API_KEY")
    )
    return ServerSettings(public_api_key=public_api_key, version=resolve_app_version())
