"""Process-local Ollama warmup state exposed through the health endpoint."""

from __future__ import annotations

import asyncio
import os
import time
from typing import Any
from urllib.parse import urlparse

import httpx
from dotenv import load_dotenv


load_dotenv()


class OllamaRuntime:
    """Warm an optional Ollama model and retain compact readiness metadata."""

    def __init__(self) -> None:
        """Read backwards-compatible Ollama configuration from the environment."""
        explicit_ollama_base = os.getenv('OLLAMA_API_BASE')
        configured_base = explicit_ollama_base or os.getenv(
            'CUSTOM_OPENAI_API_BASE', 'http://127.0.0.1:11434'
        )
        self.api_base = configured_base.rstrip('/')
        if self.api_base.endswith('/v1'):
            self.api_base = self.api_base[:-3]
        self.model = os.getenv('OLLAMA_MODEL') or os.getenv('CUSTOM_OPENAI_MODEL', '')
        self.keep_alive = os.getenv('OLLAMA_KEEP_ALIVE', '5m')
        self.service_started_at_unix = time.time()
        hostname = (urlparse(self.api_base).hostname or '').lower()
        self.auto_probe_enabled = bool(
            explicit_ollama_base
            or hostname in {'localhost', '127.0.0.1', '::1'}
        )
        if not self.model:
            self.status = 'unconfigured'
        elif self.auto_probe_enabled:
            self.status = 'cold'
        else:
            self.status = 'external'
        self.error = ''
        self.warmup_ms = 0.0
        self._task: asyncio.Task[None] | None = None

    def schedule_warmup(self) -> None:
        """Start one non-blocking model warmup task when a model is configured."""
        # Do not turn every legacy request into another multi-minute connection
        # attempt after a failed startup probe. Restarting the local service is
        # the explicit retry boundary after Ollama configuration is corrected.
        if not self.model or not self.auto_probe_enabled or self.status != 'cold':
            return
        self.status = 'warming'
        self._task = asyncio.create_task(self._warmup())

    async def ensure_probed(self) -> bool:
        """Wait for one warmup/probe and report whether native Ollama is ready."""
        self.schedule_warmup()
        if self._task:
            await self._task
        return self.status == 'ready'

    async def _warmup(self) -> None:
        """Ask Ollama to load the model without generating any tokens."""
        started = time.perf_counter()
        try:
            timeout = httpx.Timeout(connect=5.0, read=300.0, write=30.0, pool=5.0)
            async with httpx.AsyncClient(base_url=self.api_base, timeout=timeout) as client:
                response = await client.post('/api/chat', json={
                    'model': self.model,
                    'stream': False,
                    'keep_alive': self.keep_alive,
                })
                response.raise_for_status()
            self.status = 'ready'
            self.error = ''
        except Exception as error:  # Health reports failure without taking down image APIs.
            self.status = 'error'
            self.error = str(error)
        finally:
            self.warmup_ms = (time.perf_counter() - started) * 1000

    def snapshot(self) -> dict[str, Any]:
        """Return JSON-safe health metadata without exposing prompts or responses."""
        payload: dict[str, Any] = {
            'status': self.status,
            'model': self.model,
            'warmup_ms': round(self.warmup_ms, 3),
            'keep_alive': self.keep_alive,
            'auto_probe_enabled': self.auto_probe_enabled,
            'service_started_at_unix': self.service_started_at_unix,
            'observed_at_unix': time.time(),
        }
        if self.error:
            payload['error'] = self.error
        return payload


ollama_runtime = OllamaRuntime()
