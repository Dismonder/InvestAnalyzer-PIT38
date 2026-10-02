import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";

import { createInvestAnalyzerServer } from "../../../aplikacje/web/src/server/createInvestAnalyzerServer.ts";

async function withServer(
  workspaceRoot: string,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const runtimeRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'invest-upload-runtime-'));
  const app = createInvestAnalyzerServer({ workspaceRoot, runtimeRoot });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await fs.promises.rm(runtimeRoot, { recursive: true, force: true });
  }
}

test("API /storage/files (POST)", async (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "invest-analyzer-upload-test-"));
  const storageRoot = path.join(workspaceRoot, "dane", "pliki");
  fs.mkdirSync(storageRoot, { recursive: true });

  await t.test("zapis poprawnego pliku", async () => {
    await withServer(workspaceRoot, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/storage/files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: [{
            fileName: "test.json",
            relativePath: "test.json",
            base64: Buffer.from("{}").toString("base64")
          }]
        })
      });
      const data = await response.json();
      assert.equal(response.status, 200, JSON.stringify(data));
      assert.equal(data.success, true);
      assert.equal(data.imported.length, 1);
      assert.equal(data.imported[0].fileName, "test.json");
      assert.equal(data.failed.length, 0);

      const content = fs.readFileSync(path.join(storageRoot, "test.json"), "utf8");
      assert.equal(content, "{}");
    });
  });

  await t.test("odrzucenie zlego rozszerzenia", async () => {
    await withServer(workspaceRoot, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/storage/files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: [{
            fileName: "script.exe",
            relativePath: "script.exe",
            base64: Buffer.from("bad").toString("base64")
          }]
        })
      });
      const data = await response.json();
      assert.equal(response.status, 200);
      assert.equal(data.success, true);
      assert.equal(data.imported.length, 0);
      assert.equal(data.failed.length, 1);
      assert.equal(data.failed[0].fileName, "script.exe");
      assert.equal(data.failed[0].errorCode, "UNSUPPORTED_FILE_TYPE");
    });
  });

  await t.test("odrzucenie proby wyjscia z katalogu", async () => {
    await withServer(workspaceRoot, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/storage/files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: [{
            fileName: "secret.json",
            relativePath: "../secret.json",
            base64: Buffer.from("{}").toString("base64")
          }]
        })
      });
      const data = await response.json();
      // Should not allow traversal, should sanitize to safeFileName which is "secret.json"
      assert.equal(response.status, 200);
      assert.equal(data.success, true);
      assert.equal(data.imported.length, 1);
      assert.equal(data.imported[0].fileName, "secret.json");
      assert.equal(data.imported[0].relativePath, "secret.json");
      assert.ok(fs.existsSync(path.join(storageRoot, "secret.json")));
    });
  });

  await t.test("kolizja nazw (inne tresci)", async () => {
    fs.writeFileSync(path.join(storageRoot, "conflict.json"), "{}");

    await withServer(workspaceRoot, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/storage/files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: [{
            fileName: "conflict.json",
            relativePath: "conflict.json",
            base64: Buffer.from('{"new":true}').toString("base64")
          }]
        })
      });
      const data = await response.json();
      assert.equal(response.status, 200);
      assert.equal(data.success, true);
      assert.equal(data.imported.length, 1);
      assert.ok(data.imported[0].fileName.startsWith("conflict-"));
      assert.ok(data.imported[0].fileName.endsWith(".json"));
      assert.ok(data.imported[0].fileName !== "conflict.json");
      assert.equal(data.failed.length, 0);

      const content = fs.readFileSync(path.join(storageRoot, data.imported[0].relativePath), "utf8");
      assert.equal(content, '{"new":true}');
    });
  });
  
  await t.test("kolizja nazw (te same tresci)", async () => {
    fs.writeFileSync(path.join(storageRoot, "duplicate.json"), "{}");

    await withServer(workspaceRoot, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/storage/files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: [{
            fileName: "duplicate.json",
            relativePath: "duplicate.json",
            base64: Buffer.from('{}').toString("base64")
          }]
        })
      });
      const data = await response.json();
      assert.equal(response.status, 200);
      assert.equal(data.success, true);
      assert.equal(data.imported.length, 0);
      assert.equal(data.skipped.length, 1);
      assert.equal(data.skipped[0].fileName, "duplicate.json");
    });
  });

  // Cleanup
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

test("plik oznaczony do nadpisania zastepuje poprzedni zamiast tworzyc kopie", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "storage-nadpis-"));
  try {
    await withServer(workspaceRoot, async (baseUrl) => {
      async function wyslij(tresc: string, overwrite: boolean) {
        const odpowiedz = await fetch(`${baseUrl}/api/storage/files`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            files: [
              {
                relativePath: "portfel_reczne_transakcje.json",
                fileName: "portfel_reczne_transakcje.json",
                base64: Buffer.from(tresc, "utf-8").toString("base64"),
                overwrite,
              },
            ],
          }),
        });
        return odpowiedz.json() as Promise<{ imported: unknown[]; warnings: string[] }>;
      }

      await wyslij('{"trades":[1]}', true);
      await wyslij('{"trades":[1,2]}', true);

      const katalog = path.join(workspaceRoot, "dane", "pliki");
      const pliki = fs.readdirSync(katalog).filter((nazwa) => nazwa.endsWith(".json"));
      assert.deepEqual(pliki, ["portfel_reczne_transakcje.json"], "nadpisanie nie moze mnozyc plikow");
      assert.equal(
        fs.readFileSync(path.join(katalog, pliki[0]), "utf-8"),
        '{"trades":[1,2]}',
        "w magazynie ma zostac nowa tresc",
      );
    });
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("równoległe nadpisania eksportu zachowują pierwszą wersję w kopii", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "storage-rownolegle-"));
  const fileName = "freedom24_komplet.json";
  const versions = ['{"wersja":1}', '{"wersja":2}'];
  try {
    await withServer(workspaceRoot, async (baseUrl) => {
      const results = await Promise.all(versions.map(async (contents) => {
        const response = await fetch(`${baseUrl}/api/storage/files`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ files: [{
            fileName, relativePath: fileName, overwrite: true,
            base64: Buffer.from(contents).toString("base64"),
          }] }),
        });
        assert.equal(response.status, 200);
        return response.json() as Promise<{ imported: unknown[]; failed: unknown[]; warnings: string[] }>;
      }));
      assert.ok(results.every((result) => result.imported.length === 1 && result.failed.length === 0));
      assert.equal(results.filter((result) => result.warnings.some((warning) => warning.includes("backupy"))).length, 1);

      const saved = fs.readFileSync(path.join(workspaceRoot, "dane", "pliki", fileName), "utf8");
      const backupRoot = path.join(workspaceRoot, "dane", "backupy");
      const backupFiles = fs.readdirSync(backupRoot).filter((name) => name.startsWith("freedom24_komplet-") && name.endsWith(".bak.json"));
      assert.equal(backupFiles.length, 1);
      const backup = fs.readFileSync(path.join(backupRoot, backupFiles[0]), "utf8");
      assert.deepEqual(new Set([saved, backup]), new Set(versions));
    });
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("bez flagi nadpisania plik uzytkownika dostaje kopie ze znacznikiem czasu", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "storage-kopia-"));
  try {
    await withServer(workspaceRoot, async (baseUrl) => {
      async function wyslij(tresc: string) {
        const odpowiedz = await fetch(`${baseUrl}/api/storage/files`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            files: [
              {
                relativePath: "wyciag.json",
                fileName: "wyciag.json",
                base64: Buffer.from(tresc, "utf-8").toString("base64"),
              },
            ],
          }),
        });
        return odpowiedz.json();
      }

      await wyslij('{"a":1}');
      await wyslij('{"a":2}');

      const katalog = path.join(workspaceRoot, "dane", "pliki");
      const pliki = fs.readdirSync(katalog).filter((nazwa) => nazwa.endsWith(".json"));
      assert.equal(pliki.length, 2, "dane uzytkownika nie moga znikac po cichu");
    });
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("flaga nadpisania nie podmienia wyciagu uzytkownika - tylko pliki tworzone przez aplikacje", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "storage-flaga-"));
  try {
    await withServer(workspaceRoot, async (baseUrl) => {
      async function wyslij(relativePath: string, tresc: string) {
        const odpowiedz = await fetch(`${baseUrl}/api/storage/files`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            files: [{ relativePath, fileName: path.basename(relativePath), base64: Buffer.from(tresc, "utf-8").toString("base64"), overwrite: true }],
          }),
        });
        return odpowiedz.json();
      }

      // Wyciag wgrany przez uzytkownika jest jedyna kopia - flaga od klienta go nie zastapi.
      await wyslij("wyciag_2025.json", '{"a":1}');
      await wyslij("wyciag_2025.json", '{"a":2}');
      // Nazwa pliku zarzadzanego w podkatalogu to nadal plik uzytkownika.
      await wyslij("stare/freedom24_komplet.json", '{"b":1}');
      await wyslij("stare/freedom24_komplet.json", '{"b":2}');

      const katalog = path.join(workspaceRoot, "dane", "pliki");
      assert.equal(fs.readFileSync(path.join(katalog, "wyciag_2025.json"), "utf-8"), '{"a":1}');
      assert.equal(fs.readdirSync(katalog).filter((nazwa) => nazwa.startsWith("wyciag_2025")).length, 2);
      assert.equal(fs.readFileSync(path.join(katalog, "stare", "freedom24_komplet.json"), "utf-8"), '{"b":1}');
      assert.equal(fs.readdirSync(path.join(katalog, "stare")).length, 2);
    });
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("wrogie dane w tablicy files sa odrzucane pojedynczo, bez wywracania zadania", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "storage-wrogie-"));
  try {
    await withServer(workspaceRoot, async (baseUrl) => {
      const nazwaZBajtemZerowym = "zla" + String.fromCharCode(0) + "nazwa.json";
      const odpowiedz = await fetch(`${baseUrl}/api/storage/files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: [
            "nie-obiekt",
            { fileName: "", base64: "" },
            { fileName: "a".repeat(300) + ".json", base64: "e30=" },
            { fileName: nazwaZBajtemZerowym, base64: "e30=" },
            { fileName: "sciezka.json", relativePath: 42, base64: "e30=" },
            { fileName: "dobry.json", base64: Buffer.from('{"trades":[]}', "utf-8").toString("base64") },
          ],
        }),
      });

      assert.equal(odpowiedz.status, 200, "jeden zly wpis nie moze wywrocic calego zadania");
      const wynik = (await odpowiedz.json()) as {
        imported: Array<{ fileName: string }>;
        failed: Array<{ errorCode: string }>;
      };

      assert.equal(wynik.imported.length, 1, "przechodzi wylacznie poprawny plik");
      assert.equal(wynik.imported[0].fileName, "dobry.json");
      assert.equal(wynik.failed.length, 5, "kazdy zly wpis ma wlasny powod odrzucenia");

      const pliki = fs.readdirSync(path.join(workspaceRoot, "dane", "pliki"));
      assert.deepEqual(pliki, ["dobry.json"], "na dysk trafia tylko poprawny plik");
    });
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("zbyt wiele plikow w jednym zadaniu jest odrzucane", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "storage-duzo-"));
  try {
    await withServer(workspaceRoot, async (baseUrl) => {
      const odpowiedz = await fetch(`${baseUrl}/api/storage/files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: Array.from({ length: 60 }, (_, i) => ({
            fileName: `plik-${i}.json`,
            base64: "e30=",
          })),
        }),
      });

      assert.equal(odpowiedz.status, 400);
      const wynik = (await odpowiedz.json()) as { error: string };
      assert.match(wynik.error, /plik/i);
    });
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("niepoprawny JSON w zadaniu daje czytelny komunikat", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "storage-json-"));
  try {
    await withServer(workspaceRoot, async (baseUrl) => {
      const odpowiedz = await fetch(`${baseUrl}/api/storage/files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{to nie jest json",
      });

      assert.equal(odpowiedz.status, 400);
      const wynik = (await odpowiedz.json()) as { error: string };
      assert.match(wynik.error, /JSON/i, "uzytkownik ma wiedziec, co jest nie tak");
    });
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("odswiezenie eksportu Freedom24 zachowuje poprzednia wersje w backupach", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "invest-analyzer-f24-backup-"));
  const storageRoot = path.join(workspaceRoot, "dane", "pliki");
  fs.mkdirSync(storageRoot, { recursive: true });
  const stara = JSON.stringify({ wersja: "stara" });
  fs.writeFileSync(path.join(storageRoot, "freedom24_komplet.json"), stara);

  try {
    await withServer(workspaceRoot, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/storage/files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: [{
            fileName: "freedom24_komplet.json",
            relativePath: "freedom24_komplet.json",
            overwrite: true,
            base64: Buffer.from(JSON.stringify({ wersja: "nowa" })).toString("base64"),
          }],
        }),
      });
      const data = await response.json();
      assert.equal(response.status, 200, JSON.stringify(data));

      const wMagazynie = fs.readdirSync(storageRoot).filter((nazwa) => nazwa.includes("freedom24"));
      assert.deepEqual(wMagazynie, ["freedom24_komplet.json"], "kopia nie moze lezec w magazynie czytanym przez silnik");
      assert.match(fs.readFileSync(path.join(storageRoot, "freedom24_komplet.json"), "utf8"), /nowa/);

      const backupy = path.join(workspaceRoot, "dane", "backupy");
      const kopie = fs.readdirSync(backupy).filter((nazwa) => nazwa.startsWith("freedom24_komplet-"));
      assert.equal(kopie.length, 1);
      assert.equal(fs.readFileSync(path.join(backupy, kopie[0]), "utf8"), stara);
    });
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
