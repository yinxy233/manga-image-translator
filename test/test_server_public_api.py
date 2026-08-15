from __future__ import annotations

import asyncio
import base64
import sys
import unittest
from io import BytesIO
from types import ModuleType, SimpleNamespace

try:
    from fastapi import HTTPException
    from fastapi.responses import StreamingResponse
    from fastapi.testclient import TestClient
    from PIL import Image
    from pydantic import BaseModel, ConfigDict, PrivateAttr
    import pytest
except ModuleNotFoundError as error:  # pragma: no cover - minimal development env
    raise unittest.SkipTest(
        f"Full public API test dependencies are unavailable: {error.name}"
    ) from error


def install_test_stubs() -> None:
    """Install lightweight module stubs before importing ``server.main``."""
    manga_translator_stub = ModuleType("manga_translator")

    class Config(BaseModel):
        """Minimal config model for API authentication tests."""

        model_config = ConfigDict(extra="allow")
        _web_frontend_optimized: bool = PrivateAttr(default=False)
        _image_result_only: bool = PrivateAttr(default=False)

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
        nonce: str | None = None
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

    ollama_runtime_stub = ModuleType("server.ollama_runtime")

    class DummyOllamaRuntime:
        """In-memory warmup state that never opens a test network connection."""

        def schedule_warmup(self) -> None:
            """Leave the deterministic test runtime unconfigured."""

        async def ensure_probed(self) -> bool:
            """Report that no native local model was configured for API tests."""
            return False

        def snapshot(self) -> dict[str, object]:
            """Return the health fields expected by the public endpoint."""
            return {
                "status": "unconfigured",
                "service_started_at_unix": 0.0,
                "observed_at_unix": 0.0,
            }

    ollama_runtime_stub.ollama_runtime = DummyOllamaRuntime()
    sys.modules["server.ollama_runtime"] = ollama_runtime_stub


_ISOLATED_MODULE_NAMES = (
    "manga_translator",
    "server.instance",
    "server.main",
    "server.myqueue",
    "server.ollama_runtime",
    "server.request_extraction",
    "server.sent_data_internal",
    "server.to_json",
)
_ORIGINAL_MODULES = {
    module_name: sys.modules.get(module_name)
    for module_name in _ISOLATED_MODULE_NAMES
}
try:
    install_test_stubs()
    import server.main as server_main
    import server.myqueue as server_queue
    import server.request_extraction as request_extraction
    from server.sent_data_internal import FrameDecoder, process_stream
    from server.settings import ServerSettings
finally:
    # Keep this module's direct references while preventing lightweight stubs
    # from leaking into later full-suite test collection.
    for module_name, original_module in _ORIGINAL_MODULES.items():
        if original_module is None:
            sys.modules.pop(module_name, None)
        else:
            sys.modules[module_name] = original_module


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
        "ollama_native": True,
        "performance_diagnostics": True,
    }
    assert health_response.json()["recommended_client_concurrency"] == 1
    assert queue_response.status_code == 200
    assert translate_response.status_code == 200
    assert translate_response.headers["content-type"] == "image/png"


def test_health_only_advertises_benchmark_approved_available_workers(monkeypatch) -> None:
    """Health concurrency is both opt-in and capped by launched workers."""
    monkeypatch.setattr(
        server_main,
        "server_settings",
        ServerSettings(
            public_api_key=None,
            version=server_main.server_settings.version,
            recommended_client_concurrency=3,
        ),
    )
    monkeypatch.setattr(
        server_main.executor_instances,
        "list",
        [object(), object()],
    )

    payload = server_main.build_health_payload()

    assert payload["recommended_client_concurrency"] == 2


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


def test_encoded_image_path_does_not_fully_decode_in_public_process(monkeypatch) -> None:
    """Validated compressed bytes should remain intact until the worker process."""
    payload = create_test_png_bytes()
    monkeypatch.setattr(
        request_extraction,
        "_open_image_from_bytes",
        lambda _payload: (_ for _ in ()).throw(AssertionError("unexpected full decode")),
    )

    result = asyncio.run(request_extraction.to_image_bytes(payload))

    assert result is payload


def test_legacy_local_openai_switches_only_after_ollama_probe(monkeypatch) -> None:
    """A successful native probe upgrades legacy local Ollama configuration."""
    async def ready() -> bool:
        """Return a deterministic successful probe result."""
        return True

    translator = SimpleNamespace(translator="custom_openai", _translator_gen=object())
    config = SimpleNamespace(translator=translator)
    monkeypatch.setattr(request_extraction.ollama_runtime, "ensure_probed", ready)

    asyncio.run(request_extraction._prefer_native_local_ollama(config))

    assert translator.translator == "ollama"
    assert translator._translator_gen is None


def test_native_ollama_waits_for_startup_warmup(monkeypatch) -> None:
    """The first native generation should not race the model preload request."""
    probes = 0

    async def ready() -> bool:
        """Record the synchronization probe used by the native request."""
        nonlocal probes
        probes += 1
        return True

    translator = SimpleNamespace(translator="ollama", _translator_gen=None)
    config = SimpleNamespace(translator=translator)
    monkeypatch.setattr(request_extraction.ollama_runtime, "ensure_probed", ready)

    asyncio.run(request_extraction._prefer_native_local_ollama(config))

    assert probes == 1
    assert translator.translator == "ollama"


def test_legacy_openai_is_preserved_when_native_probe_fails(monkeypatch) -> None:
    """A non-Ollama-compatible server remains on the OpenAI-compatible path."""
    async def unavailable() -> bool:
        """Return a deterministic failed probe result."""
        return False

    translator = SimpleNamespace(translator="custom_openai", _translator_gen=None)
    config = SimpleNamespace(translator=translator)
    monkeypatch.setattr(request_extraction.ollama_runtime, "ensure_probed", unavailable)

    asyncio.run(request_extraction._prefer_native_local_ollama(config))

    assert translator.translator == "custom_openai"


def test_internal_frame_decoder_handles_one_byte_fragments() -> None:
    """The bytearray decoder should preserve order across arbitrary fragmentation."""
    first = bytes([1]) + (3).to_bytes(4, "big") + b"ocr"
    second = bytes([0]) + (4).to_bytes(4, "big") + b"png!"
    decoder = FrameDecoder()
    frames: list[tuple[int, bytes]] = []

    for value in first + second:
        frames.extend(decoder.feed(bytes([value])))

    assert frames == [(1, b"ocr"), (0, b"png!")]
    assert decoder.remainder() == b""


def test_internal_stream_rejects_a_truncated_terminal_frame() -> None:
    """A broken worker connection must become an error instead of a hung client."""
    class FakeContent:
        """Yield one incomplete result frame."""

        async def iter_any(self):
            yield b"\x00\x00\x00\x00\x04pn"

    response = SimpleNamespace(content=FakeContent())

    with pytest.raises(RuntimeError, match="truncated frame"):
        asyncio.run(process_stream(response, lambda _code, _data: None))


def test_disconnected_queued_task_is_removed_before_worker_submission(monkeypatch) -> None:
    """A client that leaves the queue must never reserve or call a model worker."""
    class DisconnectedTask:
        """Minimal queue task whose originating request is already gone."""

        async def is_client_disconnected(self) -> bool:
            """Report a closed connection on every queue poll."""
            return True

    class RejectingExecutors:
        """Fail if disconnect cleanup reaches worker capacity checks."""

        def free_executors(self) -> int:
            """Worker admission must not be queried for a disconnected task."""
            raise AssertionError("disconnected task reached worker admission")

    task = DisconnectedTask()
    monkeypatch.setattr(server_queue.task_queue, "queue", [task])
    monkeypatch.setattr(server_queue, "executor_instances", RejectingExecutors())

    asyncio.run(server_queue.wait_in_queue(task, lambda _code, _data: None))

    assert server_queue.task_queue.queue == []


def test_internal_nonce_route_is_not_blocked_by_public_api_key(monkeypatch) -> None:
    """Internal nonce-protected routes should not require the public API key."""
    registered: list[object] = []
    monkeypatch.setattr(
        server_main,
        "server_settings",
        ServerSettings(public_api_key="public-secret", version=server_main.server_settings.version),
    )
    monkeypatch.setattr(server_main, "nonce", "internal-secret")
    monkeypatch.setattr(server_main.executor_instances, "register", registered.append)

    with TestClient(server_main.app) as client:
        response = client.post(
            "/register",
            json={"ip": "127.0.0.1", "port": 5004, "busy": False},
            headers={"X-Nonce": "internal-secret"},
        )

    assert response.status_code == 200
    assert registered[0].nonce == "internal-secret"


def test_build_internal_instance_ports_returns_incremental_ports() -> None:
    """Internal translator worker ports should increment from the web port."""
    assert server_main.build_internal_instance_ports(8000, 3) == [8001, 8002, 8003]


def test_result_folder_path_rejects_parent_traversal() -> None:
    """Fast-path result downloads must stay inside the result directory."""
    with pytest.raises(HTTPException) as exc_info:
        server_main._result_folder_path("..")

    assert exc_info.value.status_code == 404


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
