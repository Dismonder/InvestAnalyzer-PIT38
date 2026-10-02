/**
 * Brakujacy plik z /assets to 404, a nie index.html z kodem 200. Po wydaniu
 * nowej wersji otwarta karta prosi o stary fragment kodu (inny hash w nazwie);
 * HTML w miejscu skryptu dawal mylacy blad typu MIME zamiast braku pliku.
 * Trasy aplikacji (np. /portfel) nadal dostaja index.html.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';

import { createInvestAnalyzerServer } from '../../../aplikacje/web/src/server/createInvestAnalyzerServer.ts';

test('brakujacy plik /assets daje 404, trasy SPA - index.html', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-statyczne-'));
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-statyczne-runtime-'));
  const wydanie = path.join(root, 'wydanie');
  fs.mkdirSync(path.join(wydanie, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(wydanie, 'index.html'), '<!doctype html><div id="root"></div>');
  fs.writeFileSync(path.join(wydanie, 'assets', 'index-abc.js'), 'export {};');
  const serwer = http.createServer(createInvestAnalyzerServer({ workspaceRoot: root, runtimeRoot, serveStatic: true, staticDir: wydanie }));
  await new Promise<void>((resolve) => serwer.listen(0, '127.0.0.1', resolve));
  try {
    const baza = `http://127.0.0.1:${(serwer.address() as AddressInfo).port}`;
    const istniejacy = await fetch(`${baza}/assets/index-abc.js`);
    assert.equal(istniejacy.status, 200);
    assert.match(istniejacy.headers.get('content-type') || '', /javascript/);

    const brakujacy = await fetch(`${baza}/assets/Dashboard-staryHash.js`);
    assert.equal(brakujacy.status, 404);
    assert.doesNotMatch(await brakujacy.text(), /<div id="root">/);

    const trasa = await fetch(`${baza}/portfel`);
    assert.equal(trasa.status, 200);
    assert.match(await trasa.text(), /<div id="root">/);
  } finally {
    await new Promise<void>((resolve) => serwer.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
