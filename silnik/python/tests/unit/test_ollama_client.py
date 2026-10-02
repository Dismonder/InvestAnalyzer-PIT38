import http.server
import json
import threading

import pytest

from investment_tax_engine.ai.ollama_client import OllamaClient, OllamaClientError


class _FakeResponse:
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps({"response": json.dumps({"ok": True})}).encode("utf-8")


def test_ollama_client_defaults_to_gpu_all_layers(monkeypatch):
    monkeypatch.delenv("INVEST_OLLAMA_GPU_MODE", raising=False)
    monkeypatch.delenv("INVEST_OLLAMA_NUM_GPU", raising=False)
    monkeypatch.delenv("INVEST_OLLAMA_GPU_BACKEND", raising=False)
    monkeypatch.delenv("INVEST_OLLAMA_GPU_LOAD_LIMIT_PERCENT", raising=False)
    monkeypatch.delenv("INVEST_OLLAMA_NUM_BATCH", raising=False)
    monkeypatch.delenv("OLLAMA_NUM_PARALLEL", raising=False)
    monkeypatch.delenv("INVEST_OLLAMA_GPU_REQUIRED", raising=False)
    monkeypatch.delenv("INVEST_OLLAMA_GPU_CONFIRMED", raising=False)
    monkeypatch.delenv("INVEST_OLLAMA_ALLOW_CPU_AI", raising=False)
    monkeypatch.delenv("INVEST_OLLAMA_COMPUTE_BACKEND", raising=False)
    monkeypatch.delenv("INVEST_OLLAMA_REQUEST_COOLDOWN_MS", raising=False)

    client = OllamaClient.from_environment()

    assert client.model == "qwen3:14b"
    assert client.gpu_mode == "gpu"
    assert client.num_gpu == -1
    assert client.gpu_backend == "vulkan"
    assert client.gpu_load_limit_percent == 85
    assert client.num_batch == 128
    assert client.max_parallel == 1
    assert client.request_cooldown_ms == 250
    assert client.gpu_required is False
    assert client.allow_cpu_ai is False


def test_ollama_client_ignores_cpu_env_and_allow_cpu_flag(monkeypatch):
    monkeypatch.setenv("INVEST_OLLAMA_GPU_MODE", "cpu")
    monkeypatch.setenv("INVEST_OLLAMA_NUM_GPU", "0")
    monkeypatch.setenv("INVEST_OLLAMA_ALLOW_CPU_AI", "true")
    monkeypatch.setenv("INVEST_OLLAMA_COMPUTE_BACKEND", "cpu")

    client = OllamaClient.from_environment()

    assert client.gpu_mode == "gpu"
    assert client.num_gpu == -1
    assert client.allow_cpu_ai is False
    assert client.compute_backend == "cpu"


def test_ollama_client_sends_num_gpu_to_generate(monkeypatch):
    captured = {}

    def fake_urlopen(request, timeout):
        captured["timeout"] = timeout
        captured["payload"] = json.loads(request.data.decode("utf-8"))
        return _FakeResponse()

    monkeypatch.setattr("investment_tax_engine.ai.ollama_client._otworz_bez_proxy", fake_urlopen)

    result = OllamaClient(gpu_mode="gpu", num_gpu=-1).generate_structured(
        prompt="Return JSON.",
        schema={"type": "object"},
        task_name="gpu-test",
    )

    assert result == {"ok": True}
    assert captured["payload"]["options"]["temperature"] == 0
    assert captured["payload"]["options"]["num_gpu"] == -1
    assert captured["payload"]["options"]["num_batch"] == 128
    assert captured["payload"]["keep_alive"] == "30s"


def test_ollama_client_rejects_unconfirmed_gpu_before_request(monkeypatch):
    captured = {}

    def fake_urlopen(request, timeout):
        captured["payload"] = json.loads(request.data.decode("utf-8"))
        return _FakeResponse()

    monkeypatch.setattr("investment_tax_engine.ai.ollama_client._otworz_bez_proxy", fake_urlopen)

    with pytest.raises(OllamaClientError, match="GPU was not confirmed"):
        OllamaClient(gpu_mode="gpu", num_gpu=-1, gpu_required=True, gpu_confirmed=False).generate_structured(
            prompt="Return JSON.",
            schema={"type": "object"},
            task_name="gpu-required-test",
        )

    assert captured == {}


def test_ollama_client_rejects_cpu_backend_before_request(monkeypatch):
    captured = {}

    def fake_urlopen(request, timeout):
        captured["payload"] = json.loads(request.data.decode("utf-8"))
        return _FakeResponse()

    monkeypatch.setattr("investment_tax_engine.ai.ollama_client._otworz_bez_proxy", fake_urlopen)

    with pytest.raises(OllamaClientError, match="CPU backend"):
        OllamaClient(
            gpu_mode="gpu",
            num_gpu=-1,
            gpu_required=True,
            gpu_confirmed=True,
            compute_backend="cpu",
        ).generate_structured(
            prompt="Return JSON.",
            schema={"type": "object"},
            task_name="cpu-backend-test",
        )

    assert captured == {}


def test_ollama_client_rejects_cpu_backend_even_when_constructor_allows_cpu(monkeypatch):
    captured = {}

    def fake_urlopen(request, timeout):
        captured["payload"] = json.loads(request.data.decode("utf-8"))
        return _FakeResponse()

    monkeypatch.setattr("investment_tax_engine.ai.ollama_client._otworz_bez_proxy", fake_urlopen)

    with pytest.raises(OllamaClientError, match="CPU backend"):
        OllamaClient(
            gpu_mode="gpu",
            num_gpu=-1,
            gpu_required=True,
            gpu_confirmed=True,
            allow_cpu_ai=True,
            compute_backend="cpu",
        ).generate_structured(
            prompt="Return JSON.",
            schema={"type": "object"},
            task_name="cpu-backend-test",
        )

    assert captured == {}


@pytest.mark.parametrize(
    "adres",
    [
        "https://evil.example.com",
        "http://evil.example.com:11434",
        "https://127.0.0.1:11434",
        "http://localhost@example.com",
        "http://127.0.0.1@example.com:11434",
        "http://127.0.0.1.evil.example.com:11434",
        "http://localhost.evil.example.com",
        "http://user:haslo@127.0.0.1:11434",
        "http://0.0.0.0:11434",
        "http://192.168.1.10:11434",
        "ftp://localhost:11434",
        "http://127.0.0.1:abc",
        "127.0.0.1:11434",
    ],
)
def test_ollama_nie_wysyla_wyciagow_pod_adres_spoza_petli_zwrotnej(monkeypatch, adres):
    """INVEST_OLLAMA_BASE_URL nie moze skierowac tresci wyciagow poza ten komputer."""
    wyslano = []
    monkeypatch.setattr("investment_tax_engine.ai.ollama_client._otworz_bez_proxy", lambda request, timeout: wyslano.append(request.full_url))
    monkeypatch.setenv("INVEST_OLLAMA_BASE_URL", adres)

    client = OllamaClient.from_environment()  # nie wywraca przebiegu

    with pytest.raises(OllamaClientError, match="127.0.0.1|localhost"):
        client.generate_structured(prompt="Wyciag brokera", schema={"type": "object"}, task_name="adres")
    assert wyslano == []


def test_ollama_pusty_adres_w_srodowisku_to_adres_domyslny(monkeypatch):
    monkeypatch.setenv("INVEST_OLLAMA_BASE_URL", "  ")
    assert OllamaClient.from_environment().base_url == "http://127.0.0.1:11434"


@pytest.mark.parametrize(
    "adres",
    ["http://127.0.0.1:11434", "http://localhost:11434/", "http://[::1]:11434", "http://LOCALHOST", "http://127.0.0.1"],
)
def test_ollama_petla_zwrotna_http_jest_dozwolona(monkeypatch, adres):
    wyslano = []

    def fake_urlopen(request, timeout):
        wyslano.append(request.full_url)
        return _FakeResponse()

    monkeypatch.setattr("investment_tax_engine.ai.ollama_client._otworz_bez_proxy", fake_urlopen)
    monkeypatch.setenv("INVEST_OLLAMA_BASE_URL", adres)
    # Inne testy potrafia zostawic w srodowisku wymog GPU albo backend CPU.
    monkeypatch.delenv("INVEST_OLLAMA_GPU_REQUIRED", raising=False)
    monkeypatch.delenv("INVEST_OLLAMA_COMPUTE_BACKEND", raising=False)

    result = OllamaClient.from_environment().generate_structured(
        prompt="x", schema={"type": "object"}, task_name="adres"
    )

    assert result == {"ok": True}
    assert wyslano and wyslano[0].endswith("/api/generate")


class _Serwer:
    """Atrapa serwera HTTP na petli zwrotnej (bez sieci zewnetrznej)."""

    def __init__(self, odpowiedz):
        self.odebrane = []
        odebrane = self.odebrane

        class Uchwyt(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                dlugosc = int(self.headers.get("Content-Length") or 0)
                odebrane.append((self.path, self.rfile.read(dlugosc)))
                status, naglowki, cialo = odpowiedz()
                self.send_response(status)
                for nazwa, wartosc in naglowki.items():
                    self.send_header(nazwa, wartosc)
                self.send_header("Content-Length", str(len(cialo)))
                self.end_headers()
                self.wfile.write(cialo)

            do_GET = do_POST

            def log_message(self, *_args):
                pass

        self.serwer = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Uchwyt)
        self.port = self.serwer.server_address[1]
        threading.Thread(target=self.serwer.serve_forever, daemon=True).start()

    def zamknij(self):
        self.serwer.shutdown()
        self.serwer.server_close()


def _odpowiedz_ollamy():
    return 200, {}, json.dumps({"response": json.dumps({"ok": True})}).encode("utf-8")


def _czyste_srodowisko(monkeypatch):
    for nazwa in ("INVEST_OLLAMA_GPU_REQUIRED", "INVEST_OLLAMA_COMPUTE_BACKEND"):
        monkeypatch.delenv(nazwa, raising=False)


def test_ollama_omija_proxy_z_zmiennych_srodowiskowych(monkeypatch):
    """HTTP_PROXY nie moze przechwycic tresci wyciagow wysylanych do lokalnej Ollamy."""
    _czyste_srodowisko(monkeypatch)
    ollama = _Serwer(_odpowiedz_ollamy)
    proxy = _Serwer(_odpowiedz_ollamy)
    try:
        for nazwa in ("HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"):
            monkeypatch.setenv(nazwa, f"http://127.0.0.1:{proxy.port}")
        for nazwa in ("NO_PROXY", "no_proxy"):
            monkeypatch.delenv(nazwa, raising=False)
        monkeypatch.setenv("INVEST_OLLAMA_BASE_URL", f"http://127.0.0.1:{ollama.port}")

        result = OllamaClient.from_environment().generate_structured(
            prompt="Wyciag brokera", schema={"type": "object"}, task_name="proxy"
        )
    finally:
        ollama.zamknij()
        proxy.zamknij()

    assert result == {"ok": True}
    assert len(ollama.odebrane) == 1
    assert proxy.odebrane == [], "zapytanie nie moze isc przez proxy"


def test_ollama_nie_podaza_za_przekierowaniem(monkeypatch):
    _czyste_srodowisko(monkeypatch)
    cel = _Serwer(_odpowiedz_ollamy)
    ollama = _Serwer(lambda: (302, {"Location": f"http://127.0.0.1:{cel.port}/api/generate"}, b""))
    try:
        monkeypatch.setenv("INVEST_OLLAMA_BASE_URL", f"http://127.0.0.1:{ollama.port}")
        with pytest.raises(OllamaClientError):
            OllamaClient.from_environment().generate_structured(
                prompt="Wyciag brokera", schema={"type": "object"}, task_name="redirect"
            )
    finally:
        ollama.zamknij()
        cel.zamknij()

    assert len(ollama.odebrane) == 1
    assert cel.odebrane == [], "przekierowanie nie moze zmienic adresu odbiorcy"
