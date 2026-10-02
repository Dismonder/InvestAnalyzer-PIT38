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
  const runtimeRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'invest-storage-runtime-'));
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

test("storage API lists and serves nested broker files from isolated workspace", async () => {
  const workspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "invest-storage-api-"));
  await fs.promises.mkdir(path.join(workspaceRoot, "dane", "pliki", "Dane"), { recursive: true });
  await fs.promises.writeFile(
    path.join(workspaceRoot, "dane", "pliki", "Dane", "broker.json"),
    JSON.stringify({ source: "nested" }),
  );

  try {
    await withServer(workspaceRoot, async (baseUrl) => {
      const listResponse = await fetch(`${baseUrl}/api/storage/files`);
      const listPayload = await listResponse.json() as { files: string[] };
      assert.deepEqual(listPayload.files, ["Dane/broker.json"]);

      const encodedResponse = await fetch(`${baseUrl}/api/storage/files/${encodeURIComponent("Dane/broker.json")}`);
      assert.equal(encodedResponse.status, 200);
      assert.deepEqual(await encodedResponse.json(), { source: "nested" });

      const plainNestedResponse = await fetch(`${baseUrl}/api/storage/files/Dane/broker.json`);
      assert.equal(plainNestedResponse.status, 200);
      assert.deepEqual(await plainNestedResponse.json(), { source: "nested" });
    });
  } finally {
    await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("storage API returns controlled error for invalid broker JSON", async () => {
  const workspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "invest-storage-api-invalid-json-"));
  await fs.promises.mkdir(path.join(workspaceRoot, "dane", "pliki", "Dane"), { recursive: true });
  await fs.promises.writeFile(
    path.join(workspaceRoot, "dane", "pliki", "Dane", "broken.json"),
    "{ invalid json",
  );

  try {
    await withServer(workspaceRoot, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/storage/files/${encodeURIComponent("Dane/broken.json")}`);
      assert.equal(response.status, 400);
      const payload = await response.json() as { error?: string };
      assert.match(payload.error || "", /Nieprawidłowy JSON w pliku storage: Dane\/broken\.json/);
    });
  } finally {
    await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("storage API wymusza pobranie aktywnego HTML i izoluje odpowiedź", async () => {
  const workspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "invest-storage-api-html-"));
  const storageRoot = path.join(workspaceRoot, "dane", "pliki");
  await fs.promises.mkdir(storageRoot, { recursive: true });
  await fs.promises.writeFile(path.join(storageRoot, "unsafe.html"), "<script>alert(1)</script>");
  try {
    await withServer(workspaceRoot, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/storage/files/unsafe.html`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-disposition") || "", /^attachment;/);
      assert.equal(response.headers.get("content-security-policy"), "sandbox; default-src 'none'");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");

      for (const nazwa of ["unsafe.svg", "unsafe.xml"]) {
        await fs.promises.writeFile(path.join(storageRoot, nazwa), "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>");
        const aktywny = await fetch(`${baseUrl}/api/storage/files/${nazwa}`);
        // SVG nie jest dopuszczonym typem magazynu - wtedy wystarczy, ze tresc nie wraca.
        if (aktywny.status === 200) {
          assert.match(aktywny.headers.get("content-disposition") || "", /^attachment;/, nazwa);
          assert.equal(aktywny.headers.get("content-security-policy"), "sandbox; default-src 'none'", nazwa);
        }
      }

      // Dane czytane przez aplikacje zostaja w tresci odpowiedzi, a JSON z BOM (Notatnik) jest czytelny.
      await fs.promises.writeFile(path.join(storageRoot, "bom.json"), "﻿{\"a\":1}");
      const json = await fetch(`${baseUrl}/api/storage/files/bom.json`);
      assert.equal(json.status, 200);
      assert.equal(json.headers.get("content-disposition"), null);
      assert.deepEqual(await json.json(), { a: 1 });

      await fs.promises.writeFile(path.join(storageRoot, "raport.pdf"), "%PDF-1.4");
      const pdf = await fetch(`${baseUrl}/api/storage/files/raport.pdf`);
      assert.equal(pdf.headers.get("content-disposition"), null);
      assert.equal(pdf.headers.get("content-security-policy"), null, "piaskownica wylacza podglad PDF");
    });
  } finally {
    await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("storage API zachowuje dokładną dużą liczbę w JSON", async () => {
  const workspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "invest-storage-api-number-"));
  const storageRoot = path.join(workspaceRoot, "dane", "pliki");
  await fs.promises.mkdir(storageRoot, { recursive: true });
  const content = '{"id":9007199254740993}';
  await fs.promises.writeFile(path.join(storageRoot, "large.json"), content);
  try {
    await withServer(workspaceRoot, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/storage/files/large.json`);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), content);
    });
  } finally {
    await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("API kopii nie ujawnia ścieżki katalogu roboczego", async () => {
  const workspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "invest-backups-api-"));
  try {
    await withServer(workspaceRoot, async (baseUrl) => {
      const saved = await fetch(`${baseUrl}/api/backups`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ snapshot: { createdAt: "2026-09-29T00:00:00.000Z" } }),
      });
      const savedBody = await saved.json() as { backup: Record<string, unknown> };
      assert.equal(saved.status, 200);
      assert.equal("path" in savedBody.backup, false);
      assert.equal(JSON.stringify(savedBody).includes(workspaceRoot), false);

      const listed = await fetch(`${baseUrl}/api/backups`);
      const listedBody = await listed.json() as { backups: Array<Record<string, unknown>> };
      assert.equal(listed.status, 200);
      assert.equal(listedBody.backups.length, 1);
      assert.equal("path" in listedBody.backups[0], false);
      assert.equal(JSON.stringify(listedBody).includes(workspaceRoot), false);
    });
  } finally {
    await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("storage API returns Polish controlled error when requested storage path is a directory", async () => {
  const workspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "invest-storage-api-directory-"));
  await fs.promises.mkdir(path.join(workspaceRoot, "dane", "pliki", "Dane", "folder.json"), { recursive: true });

  try {
    await withServer(workspaceRoot, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/storage/files/${encodeURIComponent("Dane/folder.json")}`);
      assert.equal(response.status, 404);
      const payload = await response.json() as { error?: string };
      assert.match(payload.error || "", /Plik storage nie istnieje albo nie jest zwykłym plikiem: Dane\/folder\.json/);
    });
  } finally {
    await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("runtime clear app data removes repo storage and generated outputs but preserves gitkeep", async () => {
  const workspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "invest-clear-data-"));
  const dirs = [
    path.join(workspaceRoot, "dane", "pliki"),
    path.join(workspaceRoot, "dane", "out"),
    path.join(workspaceRoot, "dane", "tymczasowe"),
    path.join(workspaceRoot, "dane", "logi"),
  ];
  for (const dir of dirs) {
    await fs.promises.mkdir(path.join(dir, "nested"), { recursive: true });
    await fs.promises.writeFile(path.join(dir, ".gitkeep"), "");
    await fs.promises.writeFile(path.join(dir, "private.json"), "{}");
    await fs.promises.writeFile(path.join(dir, "nested", "artifact.txt"), "x");
  }

  try {
    await withServer(workspaceRoot, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/runtime/clear-app-data`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "WYCZYSC_DANE_APLIKACJI" }),
      });
      assert.equal(response.status, 200);
      const payload = await response.json() as {
        success: boolean;
        removedFiles: number;
        removedDirs: number;
        clearedRoots: string[];
      };
      assert.equal(payload.success, true);
      assert.equal(payload.removedFiles, 4);
      assert.equal(payload.removedDirs, 4);
      assert.equal(payload.clearedRoots.length, 4);
      for (const dir of dirs) {
        assert.equal(fs.existsSync(path.join(dir, ".gitkeep")), true);
        assert.equal(fs.existsSync(path.join(dir, "private.json")), false);
        assert.equal(fs.existsSync(path.join(dir, "nested")), false);
      }
    });
  } finally {
    await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("API rejects foreign Host and Origin, and clear requires JSON confirmation", async () => {
  const workspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "invest-clear-guard-"));
  const privateFile = path.join(workspaceRoot, "dane", "pliki", "private.json");
  await fs.promises.mkdir(path.dirname(privateFile), { recursive: true });
  await fs.promises.writeFile(privateFile, "{}");
  try {
    await withServer(workspaceRoot, async (baseUrl) => {
      const clear = (headers: Record<string, string>, body = JSON.stringify({ confirm: "WYCZYSC_DANE_APLIKACJI" })) =>
        fetch(`${baseUrl}/api/runtime/clear-app-data`, { method: "POST", headers, body });
      const foreignOrigin = await clear({ "content-type": "application/json", origin: "http://evil.example" });
      assert.equal(foreignOrigin.status, 403);
      assert.equal((await foreignOrigin.json() as { success: boolean }).success, false);
      assert.equal(fs.existsSync(privateFile), true);

      const foreignHost = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const request = http.get(`${baseUrl}/api/storage/files`, { headers: { Host: "evil.example" } }, (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => resolve({ status: response.statusCode || 0, body: Buffer.concat(chunks).toString() }));
        });
        request.on("error", reject);
      });
      assert.equal(foreignHost.status, 403);
      assert.equal((JSON.parse(foreignHost.body) as { success: boolean }).success, false);

      const foreignSite = await clear({ "content-type": "application/json", "sec-fetch-site": "cross-site" });
      assert.equal(foreignSite.status, 403);
      assert.equal(fs.existsSync(privateFile), true);

      const missingConfirm = await clear({ "content-type": "application/json" }, "{}");
      assert.equal(missingConfirm.status, 400);
      assert.equal(fs.existsSync(privateFile), true);

      const form = await fetch(`${baseUrl}/api/runtime/clear-app-data`, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "confirm=WYCZYSC_DANE_APLIKACJI",
      });
      assert.equal(form.status, 400);
      assert.equal(fs.existsSync(privateFile), true);

      const sameOrigin = await clear({ "content-type": "application/json", origin: baseUrl });
      assert.equal(sameOrigin.status, 200);
      assert.equal(fs.existsSync(privateFile), false);
    });
  } finally {
    await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
  }
});


