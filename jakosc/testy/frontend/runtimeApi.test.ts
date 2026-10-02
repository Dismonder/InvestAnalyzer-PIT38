import test from "node:test";
import assert from "node:assert/strict";

import { detectRuntime } from "../../../aplikacje/web/src/invest_analyzer/services/runtimeApi.ts";
import { webRuntimeApi } from "../../../aplikacje/web/src/invest_analyzer/services/runtimeApi.web.ts";

test('anulowanie zadania web przerywa jego fetch', async () => {
  const originalFetch = globalThis.fetch;
  let signal: AbortSignal | undefined;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    signal = init?.signal || undefined;
    return await new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });
  }) as typeof fetch;
  try {
    const { jobId } = await webRuntimeApi.startTaxEngineJob({ year: 2025 } as Parameters<typeof webRuntimeApi.startTaxEngineJob>[0]);
    assert.equal(signal?.aborted, false);
    await webRuntimeApi.cancelTaxEngineJob(jobId);
    assert.equal(signal?.aborted, true);
  } finally { globalThis.fetch = originalFetch; }
});

test("detectRuntime defaults to web outside Tauri", () => {
  const originalWindow = globalThis.window;
  try {
    Object.defineProperty(globalThis, "window", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    assert.equal(detectRuntime(), "web");
  } finally {
    Object.defineProperty(globalThis, "window", {
      value: originalWindow,
      configurable: true,
      writable: true,
    });
  }
});

test("web RuntimeApi maps storage list and tax engine run to existing Express endpoints", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    if (url === "/api/storage/files") {
      return new Response(JSON.stringify({ success: true, files: ["Dane/broker.json"] }), { status: 200 });
    }
    if (url === "/api/tax-engine/run") {
      return new Response(JSON.stringify({ success: true, annual_summary: { tax_year: "2026" } }), { status: 200 });
    }
    if (url === "/api/ollama/status") {
      return new Response(JSON.stringify({
        available: false,
        serverRunning: false,
        baseUrl: "http://127.0.0.1:11434",
        model: "qwen2.5:7b-instruct",
        modelAvailable: false,
        models: [],
        exePath: null,
        exeExists: false,
        canAutoStart: false,
        error: "fetch failed",
      }), { status: 200 });
    }
    if (url === "/api/ollama/models") {
      return new Response(JSON.stringify([{ name: "qwen2.5:7b-instruct" }]), { status: 200 });
    }
    if (url === "/api/ollama/config") {
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    if (url === "/api/ollama/ensure") {
      return new Response(JSON.stringify({
        started: false,
        alreadyRunning: false,
        status: {
          available: false,
          serverRunning: false,
          baseUrl: "http://127.0.0.1:11434",
          model: "qwen2.5:7b-instruct",
          modelAvailable: false,
          models: [],
          exePath: null,
          exeExists: false,
          canAutoStart: false,
          error: "desktop only",
        },
        message: "desktop only",
      }), { status: 200 });
    }
    if (url === "/api/runtime/clear-app-data") {
      return new Response(JSON.stringify({
        success: true,
        removedFiles: 2,
        removedDirs: 1,
        clearedRoots: ["dane/pliki", "dane/out"],
        warnings: [],
      }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const files = await webRuntimeApi.listStorageFiles();
    const ollama = await webRuntimeApi.getOllamaStatus();
    const models = await webRuntimeApi.listOllamaModels();
    await webRuntimeApi.setOllamaConfig({ model: "qwen2.5:7b-instruct" });
    const ensure = await webRuntimeApi.ensureOllamaRunning();
    const clear = await webRuntimeApi.clearAppData();
    const result = await webRuntimeApi.runTaxEngine({
      year: 2026,
      runMode: "SAFE",
      taxPlan: "aggressive_user",
      includeFxConversionCosts: true,
      includeBankFundingFees: true,
      includeInterestCosts: true,
      includeAccountFees: true,
    });

    assert.equal(files[0].relativePath, "Dane/broker.json");
    assert.equal(ollama.available, false);
    assert.equal(ollama.baseUrl, "http://127.0.0.1:11434");
    assert.equal(models[0].name, "qwen2.5:7b-instruct");
    assert.equal(ensure.started, false);
    assert.equal(clear.removedFiles, 2);
    const clearCall = calls.find((call) => call.url === "/api/runtime/clear-app-data");
    assert.equal(clearCall?.init?.method, "POST");
    assert.deepEqual(clearCall?.init?.headers, { "Content-Type": "application/json" });
    assert.deepEqual(JSON.parse(String(clearCall?.init?.body)), { confirm: "WYCZYSC_DANE_APLIKACJI" });
    assert.equal(result.success, true);
    assert.deepEqual(
      calls.map((call) => call.url),
      ["/api/storage/files", "/api/ollama/status", "/api/ollama/models", "/api/ollama/config", "/api/ollama/ensure", "/api/runtime/clear-app-data", "/api/tax-engine/run"],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

