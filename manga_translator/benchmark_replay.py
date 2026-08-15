"""Small JSON replay store for deterministic OCR and Ollama performance runs."""

from __future__ import annotations

import copy
import hashlib
import json
import os
import threading
import time
from pathlib import Path
from typing import Any


class JsonReplayStore:
    """Persist compact stage responses under canonical input hashes."""

    def __init__(self, path: str | Path, namespace: str) -> None:
        """Open a namespace within one shared replay JSON file."""
        self.path = Path(path)
        self.namespace = namespace
        self._lock = threading.RLock()

    @staticmethod
    def canonical_key(payload: Any) -> str:
        """Hash a JSON-serializable request into a stable replay key."""
        encoded = json.dumps(
            payload, ensure_ascii=False, sort_keys=True, separators=(',', ':')
        ).encode('utf-8')
        return hashlib.sha256(encoded).hexdigest()

    def get(self, key: str) -> Any | None:
        """Return a defensive copy of one recorded value when present."""
        with self._lock:
            data = self._read()
            value = data.get('entries', {}).get(self.namespace, {}).get(key)
            return copy.deepcopy(value)

    def require(self, key: str) -> Any:
        """Return a recorded value or fail fast on an incomplete fixture."""
        value = self.get(key)
        if value is None:
            raise KeyError(f'Missing {self.namespace} replay entry: {key}')
        return value

    def put(self, key: str, value: Any) -> None:
        """Atomically write one JSON-safe response into the namespace."""
        with self._lock:
            data = self._read()
            data.setdefault('schema_version', 1)
            data.setdefault('created_at_unix', time.time())
            entries = data.setdefault('entries', {})
            entries.setdefault(self.namespace, {})[key] = value
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary_path = self.path.with_suffix(
                self.path.suffix + f'.{os.getpid()}.{time.time_ns()}.tmp'
            )
            try:
                temporary_path.write_text(
                    json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8'
                )
                os.replace(temporary_path, self.path)
            finally:
                if temporary_path.exists():
                    temporary_path.unlink()

    def _read(self) -> dict[str, Any]:
        """Read the current document or create a new schema root."""
        if not self.path.exists():
            return {'schema_version': 1, 'entries': {}}
        return json.loads(self.path.read_text(encoding='utf-8'))


def replay_mode(stage: str) -> str:
    """Resolve the deterministic fixture mode for one pipeline stage.

    ``verify`` runs the real model for timing, then substitutes the recorded
    deterministic output. ``replay`` skips model execution and is intended only
    for fast functional checks, not full-chain performance evidence.
    """
    value = os.getenv(
        f'MANGA_{stage.upper()}_REPLAY_MODE',
        os.getenv('MANGA_REPLAY_MODE', 'off'),
    ).strip().lower()
    if value not in {'off', 'record', 'replay', 'verify'}:
        raise ValueError(f'Unsupported replay mode for {stage}: {value}')
    return value


def replay_path() -> str:
    """Return the shared replay file path configured for benchmark runs."""
    return os.getenv('MANGA_REPLAY_PATH', 'benchmark-results/replay.json')


def serialize_ocr_lines(textlines: list[Any]) -> list[dict[str, Any]]:
    """Serialize only mutable OCR output fields, excluding image arrays."""
    fields = ('text', 'prob', 'fg_r', 'fg_g', 'fg_b', 'bg_r', 'bg_g', 'bg_b')
    return [
        {
            field: (
                getattr(textline, field).item()
                if hasattr(getattr(textline, field), 'item')
                else getattr(textline, field)
            )
            for field in fields
        }
        for textline in textlines
    ]


def apply_ocr_lines(textlines: list[Any], recorded: list[dict[str, Any]]) -> list[Any]:
    """Apply recorded OCR values to freshly detected geometry in place."""
    if len(textlines) != len(recorded):
        raise ValueError(
            f'OCR replay region count changed: detected={len(textlines)} recorded={len(recorded)}'
        )
    for textline, values in zip(textlines, recorded):
        for field, value in values.items():
            setattr(textline, field, value)
    return textlines
