from __future__ import annotations

import secrets
from typing import Final

from fastapi import HTTPException, Request

from server.settings import ServerSettings


AUTH_HEADER_NAME: Final[str] = "X-API-Key"
PROTECTED_PUBLIC_PREFIXES: Final[tuple[str, ...]] = (
    "/translate",
    "/queue-size",
    "/result/",
    "/results",
)


def is_protected_public_path(path: str) -> bool:
    """Check whether a request path requires the public API key.

    Args:
        path: Request path from FastAPI.

    Returns:
        ``True`` when the request targets a protected public endpoint.
    """
    if path.startswith("/translate"):
        return True
    if path == "/queue-size":
        return True
    if path.startswith("/result/"):
        return True
    if path.startswith("/results"):
        return True
    return False


def validate_public_api_key(request: Request, settings: ServerSettings) -> None:
    """Validate the public API key for a protected request.

    Args:
        request: Incoming FastAPI request.
        settings: Shared server settings.

    Raises:
        HTTPException: Raised when a protected endpoint is accessed without a valid key.
    """
    if not settings.public_api_key or request.method == "OPTIONS":
        return

    header_value = request.headers.get(AUTH_HEADER_NAME)
    if not header_value or not secrets.compare_digest(header_value, settings.public_api_key):
        raise HTTPException(status_code=401, detail="Invalid API key")
