import asyncio
import pickle
import io
import secrets
from threading import Lock

import uvicorn
from fastapi import FastAPI, HTTPException, Path, Request, Response
from pydantic import BaseModel

from starlette.responses import StreamingResponse

from manga_translator import MangaTranslator

SAFE_PICKLE_MODULES = frozenset({
    'builtins',
    'collections',
    'numpy',
    'numpy.core.multiarray',
    'numpy.dtype',
    'manga_translator',
    'manga_translator.utils',
    'manga_translator.utils.generic',
    'manga_translator.config'
})

class RestrictedUnpickler(pickle.Unpickler):
    """Unpickle internal requests using a narrow module allowlist."""

    def find_class(self, module: str, name: str):
        """Resolve only classes required by the private worker protocol."""
        if module in SAFE_PICKLE_MODULES or module.startswith('PIL.'):
            return super().find_class(module, name)
        raise pickle.UnpicklingError(
            f"Deserialization of {module}.{name} is not allowed"
        )


def restricted_loads(data: bytes):
    """Deserialize one nonce-protected internal request payload."""
    return RestrictedUnpickler(io.BytesIO(data)).load()

class MethodCall(BaseModel):
    """Legacy internal method-call envelope."""
    method_name: str
    attributes: bytes





class MangaShare:
    """Expose one in-process translator through the private worker API."""

    def __init__(self, params: dict = None):
        params = params or {}
        self.manga = MangaTranslator(params)
        self.host = params.get('host', '127.0.0.1')
        self.port = int(params.get('port', '5003'))
        nonce = params.get('nonce', None)
        if not nonce:
            nonce = secrets.token_hex(16)
        if nonce == "None":
            nonce = None
        self.nonce = nonce

        # each chunk has a structure like this status_code(int/1byte),len(int/4bytes),bytechunk
        # status codes are 0 for result, 1 for progress report, 2 for error
        self.progress_queue = asyncio.Queue()
        self.lock = Lock()

        async def hook(state: str, finished: bool):
            state_data = state.encode("utf-8")
            progress_data = b'\x01' + len(state_data).to_bytes(4, 'big') + state_data
            await self.progress_queue.put(progress_data)
            await asyncio.sleep(0)

        self.manga.add_progress_hook(hook)

    async def progress_stream(self):
        """Yield progress frames until a result or error frame terminates work."""
        while True:
            progress = await self.progress_queue.get()
            yield progress
            if progress[0] != 1:
                break

    async def run_method(self, method, **attributes):
        """Execute one reserved streaming method and publish its terminal frame."""
        try:
            if asyncio.iscoroutinefunction(method):
                result = await method(**attributes)
            else:
                result = method(**attributes)

            result_bytes = self._serialize_result(
                result,
                self._result_config(attributes),
            )

            encoded_result = b'\x00' + len(result_bytes).to_bytes(4, 'big') + result_bytes
            await self.progress_queue.put(encoded_result)
        except Exception as e:
            err_bytes = str(e).encode("utf-8")
            encoded_result = b'\x02' + len(err_bytes).to_bytes(4, 'big') + err_bytes
            await self.progress_queue.put(encoded_result)
        finally:
            self.lock.release()

    @staticmethod
    def _serialize_result(result, config=None) -> bytes:
        """Serialize only fields required by image-only public endpoints."""
        image_only = getattr(config, '_image_result_only', False) if config else False
        is_batch = isinstance(result, list)
        placeholder = bool(getattr(result, 'use_placeholder', False)) if not is_batch else False
        if not image_only and not placeholder:
            return pickle.dumps(result)

        if is_batch:
            return pickle.dumps([
                MangaShare._minimal_image_context(item)
                for item in result
            ])
        return pickle.dumps(MangaShare._minimal_image_context(result))

    @staticmethod
    def _result_config(attributes):
        """Resolve the output config from single-page or batch call arguments."""
        if not isinstance(attributes, dict):
            return None
        config = attributes.get('config')
        if config is not None:
            return config
        images_with_configs = attributes.get('images_with_configs')
        if not images_with_configs:
            return None
        first_item = images_with_configs[0]
        if isinstance(first_item, (tuple, list)) and len(first_item) >= 2:
            return first_item[1]
        return None

    @staticmethod
    def _minimal_image_context(result):
        """Build one small image response while preserving Web placeholders."""
        placeholder = bool(getattr(result, 'use_placeholder', False))

        from manga_translator import Context
        from PIL import Image

        minimal_result = Context()
        if placeholder:
            minimal_result.result = Image.new('RGB', (1, 1), color='white')
        else:
            encoded_png = getattr(result, 'result_png', None)
            if encoded_png is None:
                if result.result is None:
                    raise ValueError('Image-only translation did not produce PNG bytes.')
                image_buffer = io.BytesIO()
                result.result.save(image_buffer, format='PNG')
                encoded_png = image_buffer.getvalue()
            minimal_result.result = None
            minimal_result.result_png = encoded_png
        minimal_result.use_placeholder = placeholder
        minimal_result.debug_folder = getattr(result, 'debug_folder', None)
        minimal_result.performance_diagnostics = getattr(
            result, 'performance_diagnostics', None
        )
        return minimal_result


    def check_nonce(self, request: Request):
        """Reject internal callers that do not present the configured nonce."""
        if self.nonce:
            nonce = request.headers.get('X-Nonce')
            if nonce != self.nonce:
                raise HTTPException(401, detail="Nonce does not match")

    def check_lock(self):
        """Reserve the sole model execution slot or return HTTP 429."""
        if not self.lock.acquire(blocking=False):
            raise HTTPException(status_code=429, detail="some Method is already being executed.")

    def get_fn(self, method_name: str):
        """Resolve a permitted translator method by public name."""
        if method_name.startswith("__"):
            raise HTTPException(status_code=403, detail="These functions are not allowed to be executed remotely")
        method = getattr(self.manga, method_name, None)
        if not method:
            raise HTTPException(status_code=404, detail="Method not found")
        return method

    async def listen(self, translation_params: dict = None):
        """Run the private FastAPI worker server until shutdown."""
        app = FastAPI()

        @app.get("/is_locked")
        async def is_locked():
            if self.lock.locked():
                return {"locked": True}
            return {"locked": False}

        @app.post("/simple_execute/{method_name}")
        async def execute_method(request: Request, method_name: str = Path(...)):
            self.check_nonce(request)
            self.check_lock()
            try:
                method = self.get_fn(method_name)
                if self.nonce is None:
                    attr = pickle.loads(await request.body())
                else:
                    attr = restricted_loads(await request.body())
                self.manga._is_streaming_mode = False
                if asyncio.iscoroutinefunction(method):
                    result = await method(**attr)
                else:
                    result = method(**attr)
                config = self._result_config(attr)
                result_bytes = self._serialize_result(result, config)
                return Response(content=result_bytes, media_type="application/octet-stream")
            except HTTPException:
                raise
            except Exception as e:
                raise HTTPException(status_code=500, detail=str(e))
            finally:
                if self.lock.locked():
                    self.lock.release()

        @app.post("/execute/{method_name}")
        async def execute_method(request: Request, method_name: str = Path(...)):
            self.check_nonce(request)
            self.check_lock()
            try:
                method = self.get_fn(method_name)
                request_body = await request.body()
                if self.nonce is None:
                    attr = pickle.loads(request_body)
                else:
                    attr = restricted_loads(request_body)

                # 根据端点类型决定是否使用占位符优化
                config = attr.get('config')
                self.manga._is_streaming_mode = getattr(
                    config, '_web_frontend_optimized', False
                ) if config else False
            except Exception:
                if self.lock.locked():
                    self.lock.release()
                raise

            # streaming response
            streaming_response = StreamingResponse(self.progress_stream(), media_type="application/octet-stream")
            asyncio.create_task(self.run_method(method, **attr))
            return streaming_response

        config = uvicorn.Config(app, host=self.host, port=self.port)
        server = uvicorn.Server(config)
        await server.serve()
