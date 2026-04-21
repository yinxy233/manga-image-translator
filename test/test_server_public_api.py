from __future__ import annotations

import sys
from io import BytesIO
from types import ModuleType, SimpleNamespace

from fastapi.testclient import TestClient
from PIL import Image
from pydantic import BaseModel, ConfigDict


def install_test_stubs() -> None:
    """Install lightweight module stubs before importing ``server.main``."""
    manga_translator_stub = ModuleType("manga_translator")

    class Config(BaseModel):
        """Minimal config model for API authentication tests."""

        model_config = ConfigDict(extra="allow")

    manga_translator_stub.Config = Config
    sys.modules["manga_translator"] = manga_translator_stub

    to_json_stub = ModuleType("server.to_json")

    class TranslationResponse(BaseModel):
        """Minimal response model stub for API tests."""

        translations: list[dict] = []
        debug_folder: str | None = None

        def to_bytes(self) -> bytes:
            """Return an empty byte payload for stubbed endpoints."""
            return b""

    def to_translation(_ctx: object) -> TranslationResponse:
        """Return a lightweight stub response."""
        return TranslationResponse()

    to_json_stub.TranslationResponse = TranslationResponse
    to_json_stub.to_translation = to_translation
    sys.modules["server.to_json"] = to_json_stub

    instance_stub = ModuleType("server.instance")

    class ExecutorInstance(BaseModel):
        """Minimal executor model for register endpoint tests."""

        ip: str
        port: int
        busy: bool = False

    class DummyExecutors:
        """Minimal executor registry for queue-related imports."""

        def __init__(self) -> None:
            self.list: list[ExecutorInstance] = []

        def register(self, instance: ExecutorInstance) -> None:
            self.list.append(instance)

        def free_executors(self) -> int:
            return 1

        async def find_executor(self) -> ExecutorInstance:
            return ExecutorInstance(ip="127.0.0.1", port=5003)

        async def free_executor(self, _instance: ExecutorInstance) -> None:
            return None

    instance_stub.ExecutorInstance = ExecutorInstance
    instance_stub.executor_instances = DummyExecutors()
    sys.modules["server.instance"] = instance_stub


install_test_stubs()

import server.main as server_main
from server.settings import ServerSettings


def create_test_png_bytes() -> bytes:
    """Create a tiny in-memory PNG for API tests.

    Returns:
        PNG bytes for multipart upload tests.
    """
    image = Image.new("RGB", (2, 2), color="white")
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


async def fake_get_ctx(*_args, **_kwargs) -> SimpleNamespace:
    """Return a lightweight translation context for endpoint tests.

    Returns:
        A namespace with a rendered image result.
    """
    return SimpleNamespace(result=Image.new("RGB", (2, 2), color="white"))


def test_public_routes_remain_accessible_without_api_key(monkeypatch) -> None:
    """Public routes should keep working when API key protection is disabled."""
    monkeypatch.setattr(
        server_main,
        "server_settings",
        ServerSettings(public_api_key=None, version=server_main.server_settings.version),
    )
    monkeypatch.setattr(server_main, "get_ctx", fake_get_ctx)

    with TestClient(server_main.app) as client:
        health_response = client.get("/health")
        queue_response = client.post("/queue-size")
        translate_response = client.post(
            "/translate/with-form/image",
            files={"image": ("sample.png", create_test_png_bytes(), "image/png")},
            data={"config": "{}"},
        )

    assert health_response.status_code == 200
    assert queue_response.status_code == 200
    assert translate_response.status_code == 200
    assert translate_response.headers["content-type"] == "image/png"


def test_public_routes_require_valid_api_key_when_configured(monkeypatch) -> None:
    """Protected public routes should reject missing or invalid API keys."""
    monkeypatch.setattr(
        server_main,
        "server_settings",
        ServerSettings(public_api_key="public-secret", version=server_main.server_settings.version),
    )

    with TestClient(server_main.app) as client:
        missing_key_response = client.post("/queue-size")
        invalid_key_response = client.post(
            "/translate/with-form/image",
            files={"image": ("sample.png", create_test_png_bytes(), "image/png")},
            data={"config": "{}"},
            headers={"X-API-Key": "wrong-secret"},
        )

    assert missing_key_response.status_code == 401
    assert invalid_key_response.status_code == 401


def test_public_routes_accept_correct_api_key(monkeypatch) -> None:
    """Protected public routes should accept the configured API key."""
    monkeypatch.setattr(
        server_main,
        "server_settings",
        ServerSettings(public_api_key="public-secret", version=server_main.server_settings.version),
    )
    monkeypatch.setattr(server_main, "get_ctx", fake_get_ctx)

    with TestClient(server_main.app) as client:
        health_response = client.get("/health", headers={"X-API-Key": "public-secret"})
        translate_response = client.post(
            "/translate/with-form/image",
            files={"image": ("sample.png", create_test_png_bytes(), "image/png")},
            data={"config": "{}"},
            headers={"X-API-Key": "public-secret"},
        )

    assert health_response.status_code == 200
    assert health_response.json()["status"] == "ok"
    assert translate_response.status_code == 200


def test_internal_nonce_route_is_not_blocked_by_public_api_key(monkeypatch) -> None:
    """Internal nonce-protected routes should not require the public API key."""
    monkeypatch.setattr(
        server_main,
        "server_settings",
        ServerSettings(public_api_key="public-secret", version=server_main.server_settings.version),
    )
    monkeypatch.setattr(server_main, "nonce", "internal-secret")
    monkeypatch.setattr(server_main.executor_instances, "register", lambda _instance: None)

    with TestClient(server_main.app) as client:
        response = client.post(
            "/register",
            json={"ip": "127.0.0.1", "port": 5004, "busy": False},
            headers={"X-Nonce": "internal-secret"},
        )

    assert response.status_code == 200
