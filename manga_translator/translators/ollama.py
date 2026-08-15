"""Native Ollama chat translator with persistent, single-flight HTTP transport."""

from __future__ import annotations

import asyncio
import math
from typing import Any, Protocol

import httpx

from ..benchmark_replay import JsonReplayStore, replay_mode, replay_path
from .common import CommonTranslator
from .config_gpt import ConfigGPT
from .custom_openai import CustomOpenAiTranslator
from .keys import (
    CUSTOM_OPENAI_MODEL_CONF,
    OLLAMA_API_BASE,
    OLLAMA_CONTEXT_LENGTH,
    OLLAMA_DISABLE_REASONING,
    OLLAMA_KEEP_ALIVE,
    OLLAMA_MODEL,
)


class OllamaChatTransport(Protocol):
    """Minimal injectable transport used by production and memory tests."""

    async def chat(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Submit one non-streaming Ollama chat payload."""


class HttpxOllamaChatTransport:
    """Persistent HTTP/1.1 transport limited to one active Ollama request."""

    def __init__(
        self,
        api_base: str = OLLAMA_API_BASE,
        http_transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        """Create a persistent client, optionally with an in-memory test adapter."""
        timeout = httpx.Timeout(connect=10.0, read=600.0, write=60.0, pool=10.0)
        limits = httpx.Limits(max_connections=1, max_keepalive_connections=1)
        self._client = httpx.AsyncClient(
            base_url=api_base.rstrip('/'),
            timeout=timeout,
            limits=limits,
            transport=http_transport,
        )

    async def chat(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Post a chat request, retrying only a pre-submission connect failure."""
        for attempt in range(2):
            try:
                response = await self._client.post('/api/chat', json=payload)
                response.raise_for_status()
                return response.json()
            except httpx.ConnectError:
                if attempt:
                    raise
                await asyncio.sleep(0.25)
        raise RuntimeError('Ollama connection retry loop terminated unexpectedly.')

    async def close(self) -> None:
        """Close the underlying connection pool."""
        await self._client.aclose()


class OllamaTranslator(CustomOpenAiTranslator):
    """Translate manga regions through Ollama's native ``/api/chat`` API."""

    _MAX_REQUESTS_PER_MINUTE = -1
    _RETRY_FAILED_QUERIES_ONLY = True

    def __init__(
        self,
        model: str | None = None,
        api_base: str | None = None,
        transport: OllamaChatTransport | None = None,
    ) -> None:
        """Initialize prompt configuration and a single-flight native client."""
        config_key = 'ollama'
        if CUSTOM_OPENAI_MODEL_CONF:
            config_key += f'.{CUSTOM_OPENAI_MODEL_CONF}'
        ConfigGPT.__init__(self, config_key=config_key)
        CommonTranslator.__init__(self)
        self.model = model or OLLAMA_MODEL
        self.transport = transport or HttpxOllamaChatTransport(api_base or OLLAMA_API_BASE)
        self._disable_reasoning = OLLAMA_DISABLE_REASONING
        self._request_lock = asyncio.Semaphore(1)
        self.token_count = 0
        self.token_count_last = 0
        self.last_metrics: dict[str, float | int] = {}

    async def translate(
        self,
        from_lang: str,
        to_lang: str,
        queries: list[str],
        use_mtpe: bool = False,
    ) -> list[str]:
        """Translate one logical page and reset page-scoped timing counters."""
        self.token_count_last = 0
        self.last_metrics = {
            'requests': 0,
            'load_ms': 0.0,
            'prompt_eval_ms': 0.0,
            'eval_ms': 0.0,
            'prompt_tokens': 0,
            'output_tokens': 0,
        }
        return await super().translate(from_lang, to_lang, queries, use_mtpe)

    @staticmethod
    def _estimate_prompt_tokens(text: str) -> int:
        """Conservatively estimate mixed ASCII/CJK tokens without model assets."""
        ascii_count = sum(1 for character in text if ord(character) < 128)
        non_ascii_bytes = sum(
            len(character.encode('utf-8'))
            for character in text
            if ord(character) >= 128
        )
        return math.ceil(ascii_count / 4 + non_ascii_bytes / 2)

    def _prompt_token_budget(self, to_lang: str | None = None) -> int:
        """Reserve output, system-prompt, and example tokens in Ollama context."""
        target_language = to_lang or 'English'
        system_overhead = self._estimate_prompt_tokens(
            self.chat_system_template.format(to_lang=target_language)
        )
        sample = self.get_chat_sample(target_language)
        sample_overhead = (
            sum(self._estimate_prompt_tokens(part) for part in sample)
            if sample else 0
        )
        output_token_reserve = self._MAX_TOKENS // 2
        return max(
            256,
            OLLAMA_CONTEXT_LENGTH
            - output_token_reserve
            - system_overhead
            - sample_overhead,
        )

    def _assemble_prompts(
        self,
        from_lang: str,
        to_lang: str,
        queries: list[str],
    ):
        """Linearly group complete text regions within the Ollama context budget."""
        del from_lang  # The inherited prompt format does not encode source language.
        prefix = (
            self.prompt_template.format(to_lang=to_lang)
            if self._INCLUDE_TEMPLATE
            else ''
        )
        if self._RETURN_PROMPT:
            prefix += '\nOriginal:'
        budget = self._prompt_token_budget(to_lang)
        prompt_parts = [prefix]
        prompt_tokens = self._estimate_prompt_tokens(prefix)
        query_count = 0

        for query in queries:
            numbered_query = f'\n<|{query_count + 1}|>{query}'
            numbered_tokens = self._estimate_prompt_tokens(numbered_query)
            if query_count and prompt_tokens + numbered_tokens > budget:
                prompt = ''.join(prompt_parts)
                if self._RETURN_PROMPT:
                    prompt += '\n<|1|>'
                yield prompt.lstrip(), query_count
                prompt_parts = [prefix]
                prompt_tokens = self._estimate_prompt_tokens(prefix)
                query_count = 0
                numbered_query = f'\n<|1|>{query}'
                numbered_tokens = self._estimate_prompt_tokens(numbered_query)
            prompt_parts.append(numbered_query)
            prompt_tokens += numbered_tokens
            query_count += 1

        if query_count:
            prompt = ''.join(prompt_parts)
            if self._RETURN_PROMPT:
                prompt += '\n<|1|>'
            yield prompt.lstrip(), query_count

    def _translation_replay_key(
        self,
        from_lang: str,
        to_lang: str,
        queries: list[str],
    ) -> str:
        """Key deterministic translations independently of internal batching."""
        return JsonReplayStore.canonical_key({
            'model': self.model,
            'from_lang': from_lang,
            'to_lang': to_lang,
            'queries': queries,
            'system_prompt': self.chat_system_template.format(to_lang=to_lang),
            'sample': self.get_chat_sample(to_lang),
            'temperature': self.temperature,
            'top_p': self.top_p,
            'num_ctx': OLLAMA_CONTEXT_LENGTH,
            'num_predict': self._MAX_TOKENS // 2,
            'disable_reasoning': self._disable_reasoning,
        })

    async def _translate(
        self,
        from_lang: str,
        to_lang: str,
        queries: list[str],
    ) -> list[str]:
        """Run, record, or deterministically substitute one logical query set."""
        mode = replay_mode('ollama')
        replay_store = None
        replay_key = None
        if mode != 'off':
            replay_store = JsonReplayStore(replay_path(), 'ollama')
            replay_key = self._translation_replay_key(from_lang, to_lang, queries)
        if mode == 'replay':
            assert replay_store is not None and replay_key is not None
            recorded = replay_store.require(replay_key)
            if not isinstance(recorded, list) or len(recorded) != len(queries):
                raise ValueError('Ollama replay output count does not match input regions.')
            return [str(value) for value in recorded]

        live_translations = await super()._translate(from_lang, to_lang, queries)
        if mode == 'record':
            assert replay_store is not None and replay_key is not None
            replay_store.put(replay_key, live_translations)
            return live_translations
        if mode == 'verify':
            assert replay_store is not None and replay_key is not None
            recorded = replay_store.require(replay_key)
            if not isinstance(recorded, list) or len(recorded) != len(queries):
                raise ValueError('Ollama replay output count does not match input regions.')
            # Live generation above supplies real load/prompt/eval/token metrics;
            # recorded text below removes sampling variance from image output.
            return [str(value) for value in recorded]
        return live_translations

    async def _request_translation_with_retries(self, to_lang: str, prompt: str) -> str:
        """Submit exactly one generation; transport only retries connect failures."""
        return await self._request_translation(to_lang, prompt)

    async def _request_translation(self, to_lang: str, prompt: str) -> str:
        """Build and submit one native Ollama chat request."""
        if not self.model:
            raise ValueError('OLLAMA_MODEL (or CUSTOM_OPENAI_MODEL) must be configured.')

        messages = [
            {'role': 'system', 'content': self.chat_system_template.format(to_lang=to_lang)}
        ]
        lang_chat_samples = self.get_chat_sample(to_lang)
        if lang_chat_samples:
            messages.extend((
                {'role': 'user', 'content': lang_chat_samples[0]},
                {'role': 'assistant', 'content': lang_chat_samples[1]},
            ))
        messages.append({'role': 'user', 'content': prompt})

        payload: dict[str, Any] = {
            'model': self.model,
            'messages': messages,
            'stream': False,
            'keep_alive': OLLAMA_KEEP_ALIVE,
            'options': {
                'num_predict': self._MAX_TOKENS // 2,
                'temperature': self.temperature,
                'top_p': self.top_p,
                'num_ctx': OLLAMA_CONTEXT_LENGTH,
            },
        }
        if self._disable_reasoning:
            payload['think'] = False

        async with self._request_lock:
            response = await self.transport.chat(payload)

        message = response.get('message', {})
        response_text = self._extract_response_text(message)
        request_metrics: dict[str, float | int] = {
            'load_ms': float(response.get('load_duration', 0) or 0) / 1_000_000,
            'prompt_eval_ms': float(response.get('prompt_eval_duration', 0) or 0) / 1_000_000,
            'eval_ms': float(response.get('eval_duration', 0) or 0) / 1_000_000,
            'prompt_tokens': int(response.get('prompt_eval_count', 0) or 0),
            'output_tokens': int(response.get('eval_count', 0) or 0),
        }
        if 'requests' not in self.last_metrics:
            self.last_metrics = {
                'requests': 0,
                'load_ms': 0.0,
                'prompt_eval_ms': 0.0,
                'eval_ms': 0.0,
                'prompt_tokens': 0,
                'output_tokens': 0,
            }
        self.last_metrics['requests'] = int(self.last_metrics['requests']) + 1
        for metric_name, metric_value in request_metrics.items():
            self.last_metrics[metric_name] = self.last_metrics[metric_name] + metric_value
        request_tokens = int(request_metrics['prompt_tokens']) + int(
            request_metrics['output_tokens']
        )
        self.token_count_last += request_tokens
        self.token_count += request_tokens
        self.logger.info(
            'Ollama timing: load=%.1fms prompt=%.1fms generation=%.1fms tokens=%s/%s',
            request_metrics['load_ms'],
            request_metrics['prompt_eval_ms'],
            request_metrics['eval_ms'],
            request_metrics['prompt_tokens'],
            request_metrics['output_tokens'],
        )
        return response_text

    async def warmup(self) -> dict[str, Any]:
        """Load the configured model into Ollama without generating output."""
        if not self.model:
            return {'status': 'unconfigured'}
        async with self._request_lock:
            await self.transport.chat({
                'model': self.model,
                'stream': False,
                'keep_alive': OLLAMA_KEEP_ALIVE,
            })
        return {'status': 'ready', 'model': self.model}
