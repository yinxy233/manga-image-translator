from __future__ import annotations

import re

from ..config import TranslatorConfig
from .config_gpt import ConfigGPT  # Import the `gpt_config` parsing parent class

try:
    import openai
except ImportError:
    openai = None
import asyncio
import time
from typing import Any, List
from .common import CommonTranslator, VALID_LANGUAGES
from .keys import (
    CUSTOM_OPENAI_API_BASE,
    CUSTOM_OPENAI_API_KEY,
    CUSTOM_OPENAI_DISABLE_REASONING,
    CUSTOM_OPENAI_MODEL,
    CUSTOM_OPENAI_MODEL_CONF,
)


class CustomOpenAiTranslator(ConfigGPT, CommonTranslator):
    _INVALID_REPEAT_COUNT = 2  # 如果检测到"无效"翻译，最多重复 2 次
    _MAX_REQUESTS_PER_MINUTE = 40  # 每分钟最大请求次数
    _TIMEOUT = 40  # 在重试之前等待服务器响应的时间（秒）
    _RETRY_ATTEMPTS = 3  # 在放弃之前重试错误请求的次数
    _TIMEOUT_RETRY_ATTEMPTS = 3  # 在放弃之前重试超时请求的次数
    _RATELIMIT_RETRY_ATTEMPTS = 3  # 在放弃之前重试速率限制请求的次数

    # 最大令牌数量，用于控制处理的文本长度
    _MAX_TOKENS = 4096

    # 是否返回原始提示，用于控制输出内容
    _RETURN_PROMPT = False

    # 是否包含模板，用于决定是否使用预设的提示模板
    _INCLUDE_TEMPLATE = False

    def __init__(self, model=None, api_base=None, api_key=None, check_openai_key=False):
        # If the user has specified a nested key to use for the model, append the key
        #   Otherwise: Use the `ollama` defaults.
        _CONFIG_KEY='ollama'
        if CUSTOM_OPENAI_MODEL_CONF:
            _CONFIG_KEY+=f".{CUSTOM_OPENAI_MODEL_CONF}"

        ConfigGPT.__init__(self, config_key=_CONFIG_KEY)
        self.model = model
        CommonTranslator.__init__(self)
        resolved_api_key = api_key or CUSTOM_OPENAI_API_KEY or "ollama"
        resolved_api_base = api_base or CUSTOM_OPENAI_API_BASE

        self.client = openai.AsyncOpenAI(api_key=resolved_api_key) # required, but unused for ollama
        self.client.base_url = resolved_api_base
        self.token_count = 0
        self.token_count_last = 0
        self._disable_reasoning = CUSTOM_OPENAI_DISABLE_REASONING

    def parse_args(self, args: TranslatorConfig):
        self.config = args.chatgpt_config


    def extract_capture_groups(self, text: str, regex: str = r"(.*)") -> str:
        """
        Extracts all capture groups from matches and concatenates them into a single string.

        Args:
            text: The multi-line text to search.
            regex: The regex pattern with capture groups.

        Returns:
            A concatenated string of all matched groups.
        """
        pattern = re.compile(regex, re.DOTALL)  # DOTALL to match across multiple lines
        matches = pattern.findall(text)  # Find all matches
        
        # Ensure matches are concatonated (handles multiple groups per match)
        extracted_text = "\n".join(
            "\n".join(m) if isinstance(m, tuple) else m for m in matches
        )

        return extracted_text.strip() if extracted_text else ""

    def _normalize_message_text(self, value: Any) -> str:
        """Normalizes response payload fragments into plain text.

        Args:
            value: Raw message field value returned by the OpenAI-compatible API.

        Returns:
            A best-effort plain text string.
        """
        if value is None:
            return ""
        if isinstance(value, str):
            return value
        if isinstance(value, list):
            parts = [self._normalize_message_text(item) for item in value]
            return "".join(part for part in parts if part)
        if isinstance(value, dict):
            for key in ("text", "content", "reasoning", "reasoning_content", "thinking"):
                nested_value = value.get(key)
                if nested_value is not None:
                    return self._normalize_message_text(nested_value)
            return ""

        text_value = getattr(value, "text", None)
        if text_value is not None:
            return self._normalize_message_text(text_value)

        content_value = getattr(value, "content", None)
        if content_value is not None and content_value is not value:
            return self._normalize_message_text(content_value)

        return ""

    def _get_message_field(self, message: Any, field_name: str) -> str:
        """Returns a normalized text value from a response message field.

        Args:
            message: Message object returned by the OpenAI-compatible API.
            field_name: Field name to inspect.

        Returns:
            A normalized string. Empty string means the field is missing or empty.
        """
        if isinstance(message, dict):
            return self._normalize_message_text(message.get(field_name))
        return self._normalize_message_text(getattr(message, field_name, None))

    def _safe_dump(self, value: Any) -> Any:
        """Builds a debug-friendly dump for unexpected response payloads.

        Args:
            value: Response object or nested message payload.

        Returns:
            A serializable representation when available.
        """
        model_dump = getattr(value, "model_dump", None)
        if callable(model_dump):
            try:
                return model_dump()
            except Exception:
                return str(value)
        return value

    def _extract_response_text(self, message: Any) -> str:
        """Extracts the usable text body from a model response.

        Args:
            message: Response message returned by the OpenAI-compatible API.

        Returns:
            The text that should be parsed as translation output.

        Raises:
            ValueError: If the response does not contain any usable text field.
        """
        for field_name in ("content", "reasoning_content", "reasoning", "thinking"):
            text = self._get_message_field(message, field_name).strip()
            if text:
                if field_name != "content":
                    self.logger.warning(
                        "Response content is empty, fallback to message.%s for parsing.",
                        field_name,
                    )
                return text

        raise ValueError(
            "OpenAI-compatible response does not contain usable text. "
            f"message={self._safe_dump(message)}"
        )

    def _build_request_kwargs(self, messages: list[dict[str, str]]) -> dict[str, Any]:
        """Builds request arguments for the OpenAI-compatible chat API.

        Args:
            messages: Chat messages to send to the model.

        Returns:
            Request keyword arguments for `chat.completions.create`.
        """
        request_kwargs: dict[str, Any] = {
            "model": self.model or CUSTOM_OPENAI_MODEL,
            "messages": messages,
            "max_tokens": self._MAX_TOKENS // 2,
            "temperature": self.temperature,
            "top_p": self.top_p,
        }

        # 业务意图：对部分 Ollama thinking 模型提供显式开关，避免只返回 reasoning 字段导致翻译流程拿不到正文。
        if self._disable_reasoning:
            request_kwargs["extra_body"] = {"reasoning_effort": "none"}

        return request_kwargs

    def _assemble_prompts(self, from_lang: str, to_lang: str, queries: List[str]):
        prompt = ''

        if self._INCLUDE_TEMPLATE:
            prompt += self.prompt_template.format(to_lang=to_lang)

        if self._RETURN_PROMPT:
            prompt += '\nOriginal:'

        i_offset = 0
        for i, query in enumerate(queries):
            prompt += f'\n<|{i + 1 - i_offset}|>{query}'

            # If prompt is growing too large and there's still a lot of text left
            # split off the rest of the queries into new prompts.
            # 1 token = ~4 characters according to https://platform.openai.com/tokenizer
            # TODO: potentially add summarizations from special requests as context information
            if self._MAX_TOKENS * 2 and len(''.join(queries[i + 1:])) > self._MAX_TOKENS:
                if self._RETURN_PROMPT:
                    prompt += '\n<|1|>'
                yield prompt.lstrip(), i + 1 - i_offset
                prompt = self.prompt_template.format(to_lang=to_lang)
                # Restart counting at 1
                i_offset = i + 1

        if self._RETURN_PROMPT:
            prompt += '\n<|1|>'

        yield prompt.lstrip(), len(queries) - i_offset

    def _format_prompt_log(self, to_lang: str, prompt: str) -> str:
        if to_lang in self.chat_sample:
            return '\n'.join([
                'System:',
                self.chat_system_template.format(to_lang=to_lang),
                'User:',
                self.chat_sample[to_lang][0],
                'Assistant:',
                self.chat_sample[to_lang][1],
                'User:',
                prompt,
            ])
        else:
            return '\n'.join([
                'System:',
                self.chat_system_template.format(to_lang=to_lang),
                'User:',
                prompt,
            ])

    async def _translate(self, from_lang: str, to_lang: str, queries: List[str]) -> List[str]:
        translations = []
        self.logger.debug(f'Temperature: {self.temperature}, TopP: {self.top_p}')

        for prompt, query_size in self._assemble_prompts(from_lang, to_lang, queries):
            self.logger.debug('-- GPT Prompt --\n' + self._format_prompt_log(to_lang, prompt))

            ratelimit_attempt = 0
            server_error_attempt = 0
            timeout_attempt = 0
            while True:
                request_task = asyncio.create_task(self._request_translation(to_lang, prompt))
                started = time.time()
                while not request_task.done():
                    await asyncio.sleep(0.1)
                    if time.time() - started > self._TIMEOUT + (timeout_attempt * self._TIMEOUT / 2):
                        # Server takes too long to respond
                        if timeout_attempt >= self._TIMEOUT_RETRY_ATTEMPTS:
                            raise Exception('ollama servers did not respond quickly enough.')
                        timeout_attempt += 1
                        self.logger.warning(f'Restarting request due to timeout. Attempt: {timeout_attempt}')
                        request_task.cancel()
                        request_task = asyncio.create_task(self._request_translation(to_lang, prompt))
                        started = time.time()
                try:
                    response = await request_task
                    break
                except openai.RateLimitError:  # Server returned ratelimit response
                    ratelimit_attempt += 1
                    if ratelimit_attempt >= self._RATELIMIT_RETRY_ATTEMPTS:
                        raise
                    self.logger.warning(
                        f'Restarting request due to ratelimiting by Ollama servers. Attempt: {ratelimit_attempt}')
                    await asyncio.sleep(2)
                except openai.APIError:  # Server returned 500 error (probably server load)
                    server_error_attempt += 1
                    if server_error_attempt >= self._RETRY_ATTEMPTS:
                        self.logger.error(
                            'Ollama encountered a server error, possibly due to high server load. Use a different translator or try again later.')
                        raise
                    self.logger.warning(f'Restarting request due to a server error. Attempt: {server_error_attempt}')
                    await asyncio.sleep(1)

            # self.logger.debug('-- GPT Response --\n' + response)
            

            # Use regex to extract response 
            response=self.extract_capture_groups(response, rf"{self.rgx_capture}")

            if not response:
                raise ValueError(
                    "OpenAI-compatible API returned an empty text response after capture extraction. "
                    "If you are using an Ollama thinking model, enable CUSTOM_OPENAI_DISABLE_REASONING=1 "
                    "or switch to a non-thinking model."
                )


            # Sometimes it will return line like "<|9>demo", and we need to fix it.
            def add_pipe(match):
                number = match.group(1)
                return f"<|{number}|>"
            response = re.sub(r"<\|?(\d+)\|?>", add_pipe, response)
            

            # self.logger.debug('-- GPT Response (filtered) --\n' + response)

            # @NOTE: This should *should* be superflous now, due to `extract_capture_groups`:
            # 
            # Remove any text preceeding the first translation.
            new_translations = re.split(r'<\|\d+\|>', 'pre_1\n' + response)[1:]
            # new_translations = re.split(r'<\|\d+\|>', response)

            # When there is only one query LLMs likes to exclude the <|1|>
            if not new_translations:
                new_translations = [response]

            # Immediately clean leading and trailing whitespace from each translation text
            new_translations = [t.strip() for t in new_translations]

            # When there is only one query LLMs likes to exclude the <|1|> # Maybe it can be removed, but it causes no errors
            if not new_translations[0].strip():
                new_translations = new_translations[1:]

            if len(new_translations) <= 1 and query_size > 1:
                # Try splitting by newlines instead
                new_translations = re.split(r'\n', response)

            if len(new_translations) > query_size:
                new_translations = new_translations[: query_size]
            elif len(new_translations) < query_size:
                new_translations = new_translations + [''] * (query_size - len(new_translations))

            translations.extend([t.strip() for t in new_translations])

        for t in translations:
            if "I'm sorry, but I can't assist with that request" in t:
                raise Exception('translations contain error text')
        self.logger.debug(translations)
        if self.token_count_last:
            self.logger.info(f'Used {self.token_count_last} tokens (Total: {self.token_count})')

        return translations

    async def _request_translation(self, to_lang: str, prompt: str) -> str:
        messages = [{'role': 'system', 'content': self.chat_system_template.format(to_lang=to_lang)}]

        # Add chat samples if available
        lang_chat_samples = self.get_chat_sample(to_lang)
        if lang_chat_samples:
            messages.append({'role': 'user', 'content': lang_chat_samples[0]})
            messages.append({'role': 'assistant', 'content': lang_chat_samples[1]})

        messages.append({'role': 'user', 'content': prompt})

        response = await self.client.chat.completions.create(**self._build_request_kwargs(messages))
        message = response.choices[0].message
        response_text = self._extract_response_text(message)

        self.logger.debug('\n-- GPT Response (raw) --')
        self.logger.debug(response_text)
        self.logger.debug('------------------------\n')


        total_tokens = getattr(getattr(response, "usage", None), "total_tokens", 0) or 0
        self.token_count += total_tokens
        self.token_count_last = total_tokens

        return response_text
