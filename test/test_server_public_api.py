from __future__ import annotations

import asyncio
import base64
import sys
from io import BytesIO
from types import ModuleType, SimpleNamespace

from fastapi import HTTPException
from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient
from PIL import Image
from pydantic import BaseModel, ConfigDict
import pytest


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
import server.request_extraction as request_extraction
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
    assert health_response.json()["capabilities"] == {
        "web_result_fastpath": True,
        "source_url_translation": True,
    }
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
    assert health_response.json()["total_instances"] == 0
    assert translate_response.status_code == 200


def test_json_web_stream_endpoint_enables_fast_path(monkeypatch) -> None:
    """The JSON web streaming endpoint should enable placeholder optimization."""
    captured: dict[str, object] = {}

    async def fake_while_streaming(
        _req: object,
        _transform: object,
        config: BaseModel,
        image: str | bytes,
    ) -> StreamingResponse:
        captured["image"] = image
        captured["web_fast_path"] = getattr(config, "_web_frontend_optimized", False)
        return StreamingResponse(iter([b"ok"]), media_type="application/octet-stream")

    png_data_url = "data:image/png;base64," + base64.b64encode(create_test_png_bytes()).decode("ascii")
    monkeypatch.setattr(server_main, "while_streaming", fake_while_streaming)

    with TestClient(server_main.app) as client:
        response = client.post(
            "/translate/image/stream/web",
            json={"image": png_data_url, "config": {}},
        )

    assert response.status_code == 200
    assert captured["image"] == png_data_url
    assert captured["web_fast_path"] is True


class FakeAioHttpResponse:
    """Minimal async response context manager for remote image tests."""

    def __init__(self, status: int, payload: bytes, content_type: str = "image/png") -> None:
        self.status = status
        self._payload = payload
        self.headers = {"Content-Type": content_type}

    async def __aenter__(self) -> "FakeAioHttpResponse":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        return None

    async def read(self) -> bytes:
        return self._payload


class FakeAioHttpSession:
    """Minimal async session context manager for remote image tests."""

    def __init__(self, response: FakeAioHttpResponse | None = None, error: Exception | None = None) -> None:
        self._response = response
        self._error = error

    async def __aenter__(self) -> "FakeAioHttpSession":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        return None

    def get(self, _url: str) -> FakeAioHttpResponse:
        if self._error is not None:
            raise self._error
        if self._response is None:
            raise RuntimeError("Response was not configured for FakeAioHttpSession.")
        return self._response


def test_remote_image_fetch_rejects_non_image_content(monkeypatch) -> None:
    """Remote URL fetch should reject non-image content types."""
    monkeypatch.setattr(
        request_extraction.aiohttp,
        "ClientSession",
        lambda timeout=None: FakeAioHttpSession(
            response=FakeAioHttpResponse(200, b"<html>not image</html>", content_type="text/html")
        ),
    )

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(request_extraction.to_pil_image("https://example.com/page"))

    assert exc_info.value.status_code == 422
    assert exc_info.value.detail == "Remote URL did not return an image response."


def test_remote_image_fetch_rejects_invalid_image_payload(monkeypatch) -> None:
    """Remote URL fetch should reject undecodable image bytes."""
    monkeypatch.setattr(
        request_extraction.aiohttp,
        "ClientSession",
        lambda timeout=None: FakeAioHttpSession(
            response=FakeAioHttpResponse(200, b"not-a-real-png", content_type="image/png")
        ),
    )

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(request_extraction.to_pil_image("https://example.com/broken.png"))

    assert exc_info.value.status_code == 422
    assert exc_info.value.detail == "Image payload could not be decoded."


def test_remote_image_fetch_rejects_timeout(monkeypatch) -> None:
    """Remote URL fetch should surface timeouts as stable 422 errors."""
    monkeypatch.setattr(
        request_extraction.aiohttp,
        "ClientSession",
        lambda timeout=None: FakeAioHttpSession(error=asyncio.TimeoutError()),
    )

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(request_extraction.to_pil_image("https://example.com/slow.png"))

    assert exc_info.value.status_code == 422
    assert exc_info.value.detail == "Remote image request timed out."


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


def test_build_internal_instance_ports_returns_incremental_ports() -> None:
    """Internal translator worker ports should increment from the web port."""
    assert server_main.build_internal_instance_ports(8000, 3) == [8001, 8002, 8003]


def test_prepare_starts_multiple_instances(monkeypatch) -> None:
    """Prepare should launch the configured number of internal translator workers."""
    started_ports: list[int] = []

    def fake_start_proc(host: str, port: int, nonce: str | None, _params: object) -> str:
        started_ports.append(port)
        return f"{host}:{port}:{nonce}"

    monkeypatch.setattr(server_main, "start_translator_client_proc", fake_start_proc)

    args = SimpleNamespace(
        nonce="nonce-value",
        start_instance=True,
        host="0.0.0.0",
        port=8000,
        instances=3,
    )

    processes = server_main.prepare(args)

    assert started_ports == [8001, 8002, 8003]
    assert processes == [
        "0.0.0.0:8001:nonce-value",
        "0.0.0.0:8002:nonce-value",
        "0.0.0.0:8003:nonce-value",
    ]
