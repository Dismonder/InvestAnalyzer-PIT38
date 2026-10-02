from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit


class OllamaClientError(RuntimeError):
    pass


class _BezPrzekierowan(urllib.request.HTTPRedirectHandler):
    """Odpowiedz z przekierowaniem konczy sie bledem zamiast zmieniac adres odbiorcy."""

    def redirect_request(self, *_args, **_kwargs):
        return None


def _otworz_bez_proxy(request: urllib.request.Request, timeout: float):
    """Zapytanie do lokalnej Ollamy bez proxy z HTTP_PROXY/rejestru i bez przekierowan.

    Domyslny opener urllib wysylalby tresc wyciagow do proxy z ustawien systemu,
    mimo ze adres Ollamy jest sprawdzony jako petla zwrotna.
    """
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _BezPrzekierowan())
    return opener.open(request, timeout=timeout)


_HOSTY_PETLI_ZWROTNEJ = frozenset({"127.0.0.1", "localhost", "::1"})


def sprawdz_adres_ollamy(base_url: str) -> str:
    """Adres Ollamy tylko przez http na petli zwrotnej (127.0.0.1, localhost, ::1).

    Do modelu idzie tresc wyciagow brokera, wiec adres z zewnatrz (zmienna
    srodowiskowa) nie moze jej wyslac poza ten komputer. Serwer Node i aplikacja
    desktopowa stosuja te sama regule. Blad zglasza sie przy zapytaniu, a nie przy
    tworzeniu klienta: warstwa AI przechwytuje OllamaClientError i przebieg
    podatkowy idzie dalej bez kontekstu AI.
    """
    tekst = str(base_url or "").strip()
    try:
        czesci = urlsplit(tekst)
        host = (czesci.hostname or "").lower()
        czesci.port  # niepoprawny port zglasza ValueError
    except ValueError as exc:
        raise OllamaClientError(
            f"Adres Ollamy '{tekst}' jest niepoprawny; dozwolony jest tylko http://127.0.0.1, http://localhost lub http://[::1]."
        ) from exc
    if (
        czesci.scheme.lower() != "http"
        or host not in _HOSTY_PETLI_ZWROTNEJ
        or czesci.username is not None
        or czesci.password is not None
        or czesci.query
        or czesci.fragment
    ):
        raise OllamaClientError(
            f"Adres Ollamy '{tekst}' jest niedozwolony: treść wyciągów może trafić tylko na ten komputer "
            "(http://127.0.0.1, http://localhost lub http://[::1])."
        )
    return tekst.rstrip("/")


@dataclass
class OllamaClient:
    base_url: str = "http://127.0.0.1:11434"
    model: str = "qwen3:14b"
    timeout_seconds: int = 120
    gpu_mode: str = "gpu"
    num_gpu: int | None = -1
    gpu_backend: str = "vulkan"
    gpu_load_limit_percent: int = 85
    num_batch: int = 128
    max_parallel: int = 1
    gpu_required: bool = False
    gpu_confirmed: bool = False
    allow_cpu_ai: bool = False
    compute_backend: str = "unknown"
    request_cooldown_ms: int = 250

    _request_lock = threading.Lock()
    _last_request_at = 0.0

    @classmethod
    def from_environment(cls) -> "OllamaClient":
        gpu_mode = os.environ.get("INVEST_OLLAMA_GPU_MODE", "gpu").strip().lower()
        if gpu_mode not in {"gpu", "auto"}:
            gpu_mode = "gpu"
        gpu_backend = os.environ.get("INVEST_OLLAMA_GPU_BACKEND", "vulkan").strip().lower()
        if gpu_backend not in {"vulkan", "rocm", "cuda", "auto"}:
            gpu_backend = "vulkan"
        raw_num_gpu = os.environ.get("INVEST_OLLAMA_NUM_GPU")
        if raw_num_gpu is None:
            num_gpu = -1 if gpu_mode == "gpu" else None
        else:
            try:
                num_gpu = int(raw_num_gpu)
            except ValueError:
                num_gpu = -1 if gpu_mode == "gpu" else None
        if num_gpu == 0:
            num_gpu = -1
        try:
            gpu_load_limit_percent = int(os.environ.get("INVEST_OLLAMA_GPU_LOAD_LIMIT_PERCENT", "85"))
        except ValueError:
            gpu_load_limit_percent = 85
        gpu_load_limit_percent = max(50, min(95, gpu_load_limit_percent))
        try:
            num_batch = int(os.environ.get("INVEST_OLLAMA_NUM_BATCH", "128" if gpu_load_limit_percent <= 85 else "256"))
        except ValueError:
            num_batch = 128
        try:
            max_parallel = int(os.environ.get("OLLAMA_NUM_PARALLEL", "1"))
        except ValueError:
            max_parallel = 1
        try:
            request_cooldown_ms = int(os.environ.get("INVEST_OLLAMA_REQUEST_COOLDOWN_MS", "250"))
        except ValueError:
            request_cooldown_ms = 250
        return cls(
            base_url=(os.environ.get("INVEST_OLLAMA_BASE_URL") or "").strip().rstrip("/") or "http://127.0.0.1:11434",
            model=os.environ.get("INVEST_OLLAMA_MODEL", "qwen3:14b"),
            timeout_seconds=int(os.environ.get("INVEST_OLLAMA_TIMEOUT_SECONDS", "120")),
            gpu_mode=gpu_mode,
            num_gpu=num_gpu,
            gpu_backend=gpu_backend,
            gpu_load_limit_percent=gpu_load_limit_percent,
            num_batch=max(1, num_batch),
            max_parallel=max(1, min(2, max_parallel)),
            gpu_required=os.environ.get("INVEST_OLLAMA_GPU_REQUIRED", "false").strip().lower() == "true",
            gpu_confirmed=os.environ.get("INVEST_OLLAMA_GPU_CONFIRMED", "false").strip().lower() == "true",
            allow_cpu_ai=False,
            compute_backend=os.environ.get("INVEST_OLLAMA_COMPUTE_BACKEND", "unknown").strip().lower() or "unknown",
            request_cooldown_ms=max(0, min(5000, request_cooldown_ms)),
        )

    def _wait_for_ai_slot(self) -> None:
        # Ollama has process-level limits, but this keeps our normalizer from
        # submitting bursts of local GPU work in one Python engine process.
        with self._request_lock:
            cooldown_seconds = max(0, self.request_cooldown_ms) / 1000
            elapsed = time.monotonic() - self.__class__._last_request_at
            if elapsed < cooldown_seconds:
                time.sleep(cooldown_seconds - elapsed)
            self.__class__._last_request_at = time.monotonic()

    def generate_structured(self, *, prompt: str, schema: dict[str, Any], task_name: str) -> dict[str, Any]:
        base_url = sprawdz_adres_ollamy(self.base_url)
        if self.gpu_required and not self.gpu_confirmed:
            raise OllamaClientError(
                f"Ollama GPU was not confirmed for {task_name}; CPU fallback is disabled."
            )
        if self.compute_backend == "cpu":
            raise OllamaClientError(
                f"Ollama reported CPU backend for {task_name}; CPU fallback is disabled."
            )
        options: dict[str, Any] = {"temperature": 0}
        if self.gpu_mode == "gpu":
            options["num_gpu"] = -1 if self.num_gpu is None else self.num_gpu
        elif self.num_gpu is not None:
            options["num_gpu"] = self.num_gpu
        options["num_batch"] = max(1, int(self.num_batch))
        payload = {
            "model": self.model,
            "prompt": prompt,
            "format": schema,
            "stream": False,
            "keep_alive": "30s",
            "options": options,
        }
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            f"{base_url}/api/generate",
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            self._wait_for_ai_slot()
            with _otworz_bez_proxy(request, timeout=self.timeout_seconds) as response:
                response_payload = json.loads(response.read().decode("utf-8"))
        except (TimeoutError, urllib.error.URLError, OSError, json.JSONDecodeError) as exc:
            raise OllamaClientError(f"Ollama request failed for {task_name}: {exc}") from exc

        raw_response = response_payload.get("response")
        if not isinstance(raw_response, str):
            raise OllamaClientError(f"Ollama response for {task_name} does not contain JSON text.")
        try:
            parsed = json.loads(raw_response)
        except json.JSONDecodeError as exc:
            raise OllamaClientError(f"Ollama response for {task_name} is not valid JSON.") from exc
        if not isinstance(parsed, dict):
            raise OllamaClientError(f"Ollama response for {task_name} must be a JSON object.")
        return parsed


__all__ = ["OllamaClient", "OllamaClientError"]
