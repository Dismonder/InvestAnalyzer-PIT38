import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkOllamaStatus, isAllowedLocalRequestHost, resolveServerHost } from "../../../aplikacje/web/src/server/createInvestAnalyzerServer.ts";

test("production server entrypoint does not import Vite middleware", () => {
  const source = readFileSync(new URL("../../../aplikacje/web/server.ts", import.meta.url), "utf8");

  assert.equal(source.includes("from \"vite\""), false);
  assert.equal(source.includes("await import(\"vite\")"), false);
  assert.equal(source.includes("createViteServer"), false);
});

test("development server entrypoint owns Vite middleware", () => {
  const source = readFileSync(new URL("../../../aplikacje/web/server-dev.ts", import.meta.url), "utf8");

  assert.match(source, /from "vite"/);
  assert.match(source, /middlewareMode:\s*true/);
});

test("server entrypoints do not bind every network interface by default", () => {
  const productionSource = readFileSync(new URL("../../../aplikacje/web/server.ts", import.meta.url), "utf8");
  const developmentSource = readFileSync(new URL("../../../aplikacje/web/server-dev.ts", import.meta.url), "utf8");

  assert.equal(productionSource.includes("\"0.0.0.0\""), false);
  assert.equal(developmentSource.includes("\"0.0.0.0\""), false);
  assert.match(productionSource, /resolveServerHost/);
  assert.match(developmentSource, /resolveServerHost/);
});

test("resolveServerHost uses loopback by default and rejects public bindings", () => {
  const originalHost = process.env.HOST;

  try {
    delete process.env.HOST;
    assert.equal(resolveServerHost(), "127.0.0.1");

    process.env.HOST = "localhost";
    assert.equal(resolveServerHost(), "localhost");

    process.env.HOST = "0.0.0.0";
    assert.equal(resolveServerHost(), "127.0.0.1");
  } finally {
    if (originalHost === undefined) {
      delete process.env.HOST;
    } else {
      process.env.HOST = originalHost;
    }
  }
});

test("lokalny host localhost z końcową kropką zachowuje walidację portu", () => {
  assert.equal(isAllowedLocalRequestHost("localhost.:3000"), true);
  assert.equal(isAllowedLocalRequestHost("localhost."), true);
  assert.equal(isAllowedLocalRequestHost("localhost.:0"), false);
  assert.equal(isAllowedLocalRequestHost("localhost.:65536"), false);
  assert.equal(isAllowedLocalRequestHost("localhost.:3000.example"), false);
});

test("checkOllamaStatus reports unavailable Ollama as controlled status", async () => {
  const status = await checkOllamaStatus(async () => {
    throw new Error("connection refused");
  });

  assert.equal(status.available, false);
  assert.equal(status.serverRunning, false);
  assert.equal(status.baseUrl, "http://127.0.0.1:11434");
  assert.equal(status.model, "qwen3:14b");
  assert.match(status.error || "", /connection refused/);
});

test("checkOllamaStatus parses tags and selected model availability", async () => {
  const status = await checkOllamaStatus(async () => new Response(JSON.stringify({
    models: [
      { name: "qwen3:8b", size: 100 },
      { name: "qwen2.5:7b-instruct", size: 123 },
      { name: "llama3.1:8b-instruct", size: 456 },
    ],
  }), { status: 200 }));

  assert.equal(status.available, true);
  assert.equal(status.serverRunning, true);
  assert.equal(status.modelAvailable, true);
  assert.equal(status.model, "qwen3:8b");
  assert.equal(status.models.length, 3);
  assert.equal(status.models[0].name, "qwen3:8b");
});

