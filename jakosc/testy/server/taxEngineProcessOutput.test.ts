import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";

import { createInvestAnalyzerServer } from "../../../aplikacje/web/src/server/createInvestAnalyzerServer.ts";

async function withServer(workspaceRoot: string, run: (baseUrl: string, runtimeRoot: string) => Promise<void>): Promise<void> {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-process-runtime-'));
  const app = createInvestAnalyzerServer({ workspaceRoot, runtimeRoot });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`, runtimeRoot);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
}

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-output-"));
  fs.mkdirSync(path.join(root, "dane", "pliki"), { recursive: true });
  return root;
}

/**
 * Strumienie procesu potomnego emituja zdarzenie "data". Literal "dane" -
 * pozostalosc po masowej zamianie nazw - nigdy sie nie wyzwalal, wiec serwer
 * nie odbieral ani wyniku silnika, ani jego bledu.
 *
 * Test uruchamia endpoint w pustym katalogu roboczym, gdzie silnika nie ma.
 * Python konczy sie bledem i wypisuje slad na stderr. Jesli przechwytywanie
 * dziala, uzytkownik dostaje ten slad; jesli nie - dostaje komunikat ogolny.
 */
test("blad silnika trafia do odpowiedzi, a nie ginie w nieodczytanym strumieniu", async () => {
  const workspaceRoot = makeWorkspace();
  try {
    await withServer(workspaceRoot, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/tax-engine/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ year: 2025, runMode: "SAFE" }),
      });
      const payload = (await response.json()) as { success: boolean; error?: string };

      assert.equal(payload.success, false, "uruchomienie bez silnika nie moze byc raportowane jako sukces");
      assert.ok(typeof payload.error === "string" && payload.error.length > 0);
      assert.notEqual(
        payload.error,
        "Tax engine failed to run.",
        "komunikat ogolny oznacza, ze stderr Pythona nie zostal przechwycony",
      );
    });
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('trzeci równoległy przebieg dostaje 429, a anulowanie zwalnia miejsce', async () => {
  const workspaceRoot = makeWorkspace();
  const cliPath = path.join(workspaceRoot, 'silnik', 'python', 'src', 'investment_tax_engine', 'app', 'cli.py');
  fs.mkdirSync(path.dirname(cliPath), { recursive: true });
  fs.writeFileSync(cliPath, 'setTimeout(() => process.stdout.write(JSON.stringify({ exported_files: [] })), 10000);');
  const previousPython = process.env.INVEST_PYTHON;
  process.env.INVEST_PYTHON = process.execPath;
  try {
    await withServer(workspaceRoot, async (baseUrl) => {
      const controller1 = new AbortController();
      const controller2 = new AbortController();
      const send = (signal?: AbortSignal) => fetch(`${baseUrl}/api/tax-engine/run`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ year: 2025, runMode: 'SAFE', forceRecalculate: true }), signal,
      });
      const first = send(controller1.signal).catch(() => undefined);
      const second = send(controller2.signal).catch(() => undefined);
      try {
        await new Promise((resolve) => setTimeout(resolve, 300));
        const blocked = await send();
        assert.equal(blocked.status, 429);
        assert.match(String((await blocked.json()).error), /Dwa przebiegi/);
      } finally {
        controller1.abort();
        controller2.abort();
        await Promise.all([first, second]);
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      const controller3 = new AbortController();
      const available = send(controller3.signal).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 300));
      controller3.abort();
      const response = await available;
      assert.equal(response, undefined, 'nowy przebieg powinien zostać uruchomiony i anulowany');
    });
  } finally {
    if (previousPython === undefined) delete process.env.INVEST_PYTHON;
    else process.env.INVEST_PYTHON = previousPython;
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('artefakt udanego przebiegu da się pobrać, choć pamięć podręczna go nie zna', async () => {
  const workspaceRoot = makeWorkspace();
  const cliPath = path.join(workspaceRoot, 'silnik', 'python', 'src', 'investment_tax_engine', 'app', 'cli.py');
  fs.mkdirSync(path.dirname(cliPath), { recursive: true });
  // Atrapa silnika (uruchamiana przez node): zapisuje artefakt w katalogu przebiegu.
  fs.writeFileSync(cliPath, [
    "const fs = require('fs'); const path = require('path');",
    "const outDir = process.argv[process.argv.indexOf('--out-dir') + 1];",
    "fs.mkdirSync(outDir, { recursive: true });",
    "const artefakt = path.join(outDir, 'pakiet.json');",
    "fs.writeFileSync(artefakt, '{}');",
    "process.stdout.write(JSON.stringify({ exported_files: [artefakt] }));",
  ].join(String.fromCharCode(10)));
  const previousPython = process.env.INVEST_PYTHON;
  process.env.INVEST_PYTHON = process.execPath;
  try {
    await withServer(workspaceRoot, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/tax-engine/run`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ year: 2025, runMode: 'SAFE', forceRecalculate: true }),
      });
      const wynik = await response.json() as { exported_files?: string[] };
      const artefakt = wynik.exported_files?.[0];
      assert.ok(artefakt, 'atrapa musi zwrócić ścieżkę artefaktu');
      // Symulacja nieudanego zapisu pamięci podręcznej: bez metadanych katalog
      // przebiegu nie jest już znany z pamięci.
      await new Promise((resolve) => setTimeout(resolve, 100));
      // <runtime>/investment-tax-engine-dev-runtime/<ns>/engine-output/<przebieg>/pakiet.json,
      // a pamięć podręczna leży w <runtime>/<ns>/engine-cache.
      let runtimeRoot = artefakt;
      for (let poziom = 0; poziom < 5; poziom += 1) runtimeRoot = path.dirname(runtimeRoot);
      let usuniete = 0;
      for (const plik of fs.readdirSync(runtimeRoot, { recursive: true }) as string[]) {
        if (String(plik).endsWith('.meta.json')) { fs.rmSync(path.join(runtimeRoot, String(plik)), { force: true }); usuniete += 1; }
      }
      assert.ok(usuniete > 0, 'test musi usunąć metadane pamięci podręcznej przebiegu');
      const pobranie = await fetch(`${baseUrl}/api/tax-engine/download?path=${encodeURIComponent(artefakt)}`);
      assert.equal(pobranie.status, 200);
      await pobranie.body?.cancel();
    });
  } finally {
    if (previousPython === undefined) delete process.env.INVEST_PYTHON;
    else process.env.INVEST_PYTHON = previousPython;
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('serie nieudanych przebiegów nie rozrasta katalogów przebiegów ponad limit retencji', async () => {
  const workspaceRoot = makeWorkspace();
  const cliPath = path.join(workspaceRoot, 'silnik', 'python', 'src', 'investment_tax_engine', 'app', 'cli.py');
  fs.mkdirSync(path.dirname(cliPath), { recursive: true });
  // Atrapa silnika (uruchamiana przez node): pada z tracebackiem na stderr.
  fs.writeFileSync(cliPath, "process.stderr.write('Traceback (atrapa)'); process.exit(1);");
  const previousPython = process.env.INVEST_PYTHON;
  process.env.INVEST_PYTHON = process.execPath;
  try {
    await withServer(workspaceRoot, async (baseUrl, runtimeRoot) => {
      const przebiegi = 24;
      for (let i = 0; i < przebiegi; i += 1) {
        const response = await fetch(`${baseUrl}/api/tax-engine/run`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ year: 2025, runMode: 'SAFE', forceRecalculate: true }),
        });
        assert.equal(response.status, 500);
        await response.json();
      }
      // Sprzątanie po odpowiedzi działa w setImmediate.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const katalogiWyjsciowe = (fs.readdirSync(runtimeRoot, { recursive: true }) as string[])
        .map(String).filter((wpis) => path.basename(wpis) === 'engine-output');
      assert.equal(katalogiWyjsciowe.length, 1, 'jeden katalog engine-output');
      const przebiegiNaDysku = fs.readdirSync(path.join(runtimeRoot, katalogiWyjsciowe[0]));
      assert.ok(przebiegiNaDysku.length > 0, 'najnowsze przebiegi z logiem stderr zostają');
      assert.ok(przebiegiNaDysku.length <= 20, `zostało ${przebiegiNaDysku.length} katalogów przebiegów, limit 20`);
    });
  } finally {
    if (previousPython === undefined) delete process.env.INVEST_PYTHON;
    else process.env.INVEST_PYTHON = previousPython;
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});