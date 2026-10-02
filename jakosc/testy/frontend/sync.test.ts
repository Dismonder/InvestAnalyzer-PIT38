import test from "node:test";
import assert from "node:assert/strict";

import { SyncService } from "../../../aplikacje/web/src/invest_analyzer/services/sync.ts";
import { StorageService } from "../../../aplikacje/web/src/invest_analyzer/services/storage.ts";

type LoggedEntry = { level: string; message: string; details?: unknown };

async function runWithStorageFiles(
  files: string[],
  alreadyProcessed: string[] = [],
): Promise<{ processed: string[]; saved: string[][]; logs: LoggedEntry[]; fetchCalls: string[] }> {
  const originalFetch = globalThis.fetch;
  const originalGetProcessedStorageFiles = StorageService.getProcessedStorageFiles;
  const originalSaveProcessedStorageFiles = StorageService.saveProcessedStorageFiles;

  const fetchCalls: string[] = [];
  const saved: string[][] = [];
  const logs: LoggedEntry[] = [];

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    fetchCalls.push(url);
    if (url === "/api/storage/files") {
      return new Response(JSON.stringify({ success: true, files }), { status: 200 });
    }
    return new Response("not found", { status: 404, statusText: "Not Found" });
  }) as typeof fetch;

  StorageService.getProcessedStorageFiles = async () => [...alreadyProcessed];
  StorageService.saveProcessedStorageFiles = async (entries: string[]) => {
    saved.push([...entries]);
  };

  try {
    const processed = await SyncService.markStorageFilesProcessed((level, _stage, message, details) => {
      logs.push({ level, message, details });
    });
    return { processed, saved, logs, fetchCalls };
  } finally {
    globalThis.fetch = originalFetch;
    StorageService.getProcessedStorageFiles = originalGetProcessedStorageFiles;
    StorageService.saveProcessedStorageFiles = originalSaveProcessedStorageFiles;
  }
}

test("markStorageFilesProcessed pobiera listę plików z magazynu", async () => {
  const { processed, saved, logs, fetchCalls } = await runWithStorageFiles(["Dane/raport ąć.json"]);

  assert.deepEqual(fetchCalls, ["/api/storage/files"]);
  assert.deepEqual(processed, ["Dane/raport ąć.json"]);
  assert.deepEqual(saved, [["Dane/raport ąć.json"]]);
  assert.equal(logs.some((entry) => /canonical_tax_input\.json/i.test(entry.message)), true);
  assert.equal(logs.some((entry) => entry.level === "error"), false);
});

test("markStorageFilesProcessed nie oznacza po raz drugi pliku już obsłużonego", async () => {
  const { processed, saved, logs } = await runWithStorageFiles(["broker_raport.json"], ["broker_raport.json"]);

  assert.deepEqual(processed, []);
  assert.deepEqual(saved, [], "bez nowych plików nie ma po co zapisywać listy");
  assert.deepEqual(logs, []);
});

test("markStorageFilesProcessed pomija wpisy techniczne magazynu", async () => {
  const { processed } = await runWithStorageFiles([".keep", ".gitignore", "Transakcje.xlsx"]);

  assert.deepEqual(processed, ["Transakcje.xlsx"]);
});

test("markStorageFilesProcessed opisuje rolę pliku dowodowego zamiast go importować", async () => {
  const { processed, logs } = await runWithStorageFiles(["Stawki.pdf"]);

  assert.deepEqual(processed, ["Stawki.pdf"]);
  assert.equal(logs.some((entry) => entry.level === "error"), false);
  assert.equal(logs.length, 1);
});

test("markStorageFilesProcessed przyjmuje raport brokera bez czerwonego błędu", async () => {
  const { processed, logs } = await runWithStorageFiles(["broker_raport_zbliansem.json"]);

  assert.deepEqual(processed, ["broker_raport_zbliansem.json"]);
  assert.equal(logs.some((entry) => entry.level === "error"), false);
  assert.equal(logs.some((entry) => /źródło danych/i.test(entry.message)), true);
});

test("markStorageFilesProcessed zgłasza ostrzeżenie, gdy magazyn nie odpowiada", async () => {
  const originalFetch = globalThis.fetch;
  const logs: LoggedEntry[] = [];
  globalThis.fetch = (async () => {
    throw new Error("magazyn niedostępny");
  }) as typeof fetch;

  try {
    const processed = await SyncService.markStorageFilesProcessed((level, _stage, message, details) => {
      logs.push({ level, message, details });
    });

    assert.deepEqual(processed, []);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].level, "warn");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
