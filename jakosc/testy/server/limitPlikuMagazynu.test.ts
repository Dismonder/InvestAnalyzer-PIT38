/**
 * Limity wgrywania plikow do magazynu (POST /api/storage/files) maja byc takie
 * same jak w desktopie: 32 MiB danych na plik (44 739 240 znakow base64),
 * sprawdzane przed dekodowaniem; limit zadania pozwala na kilka duzych plikow.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';

import { createInvestAnalyzerServer } from '../../../aplikacje/web/src/server/createInvestAnalyzerServer.ts';

const MAX_BASE64 = 44_739_240;

async function wyslij(pliki: Array<{ fileName: string; base64: string }>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-limit-pliku-'));
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-limit-pliku-rt-'));
  fs.mkdirSync(path.join(root, 'dane', 'pliki'), { recursive: true });
  const serwer = http.createServer(createInvestAnalyzerServer({ workspaceRoot: root, runtimeRoot }));
  await new Promise<void>((resolve) => serwer.listen(0, '127.0.0.1', resolve));
  try {
    const odpowiedz = await fetch(`http://127.0.0.1:${(serwer.address() as AddressInfo).port}/api/storage/files`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: pliki.map((plik) => ({ ...plik, relativePath: plik.fileName })) }),
    });
    return { status: odpowiedz.status, tresc: (await odpowiedz.json()) as any };
  } finally {
    await new Promise<void>((resolve) => serwer.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
}

test('plik kilku MiB (wieloletni wyciag) jest przyjmowany, a ponad 32 MiB odrzucany przed dekodowaniem', async () => {
  const wynik = await wyslij([
    { fileName: 'wieloletni.json', base64: Buffer.alloc(5 * 1024 * 1024, 0x20).toString('base64') },
    { fileName: 'za-duzy.json', base64: 'A'.repeat(MAX_BASE64 + 4) },
  ]);
  assert.equal(wynik.status, 200);
  assert.equal(wynik.tresc.imported.length, 1, JSON.stringify(wynik.tresc.failed));
  assert.equal(wynik.tresc.imported[0].relativePath, 'wieloletni.json');
  assert.equal(wynik.tresc.failed.length, 1);
  assert.equal(wynik.tresc.failed[0].errorCode, 'FILE_TOO_LARGE');
  assert.match(wynik.tresc.failed[0].message, /32 MiB/);
});

test('partia kilku duzych plikow miesci sie w limicie zadania', async () => {
  const plik = (nazwa: string) => ({ fileName: nazwa, base64: Buffer.alloc(20 * 1024 * 1024, 0x20).toString('base64') });
  const wynik = await wyslij([plik('a.json'), plik('b.json'), plik('c.json')]);
  assert.equal(wynik.status, 200);
  assert.equal(wynik.tresc.imported.length, 3, JSON.stringify(wynik.tresc));
});
