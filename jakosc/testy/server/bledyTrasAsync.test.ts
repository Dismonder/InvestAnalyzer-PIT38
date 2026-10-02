/**
 * Express 4 nie przechwytuje odrzucen z async handlerow. Wyjatek po `await`
 * (np. nieoczekiwany ksztalt odpowiedzi brokera) zostawial zadanie bez
 * odpowiedzi, a nieobsluzone odrzucenie od Node 15 konczy caly proces
 * serwera. Trasa ma odpowiedziec 500 z JSON-em bez szczegolow bledu.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';

import { createInvestAnalyzerServer } from '../../../aplikacje/web/src/server/createInvestAnalyzerServer.ts';
import { koncowaObslugaBledu, zabezpieczTrasyAsync } from '../../../aplikacje/web/src/server/trasyAsync.ts';

test('wyjatek po await w trasie (takze w routerze) daje 500 JSON zamiast zawieszenia', async () => {
  const app = express();
  const router = express.Router();
  router.post('/zepsuta', async () => {
    await Promise.resolve();
    throw new TypeError("Cannot read properties of null (reading 'i')");
  });
  app.use('/api', router);
  app.get('/ok', async (_req, res) => { await Promise.resolve(); res.json({ ok: true }); });
  zabezpieczTrasyAsync(app);
  zabezpieczTrasyAsync(app); // drugie wywolanie nie owija ponownie
  app.use(koncowaObslugaBledu);

  const odrzucenia: unknown[] = [];
  const naOdrzucenie = (powod: unknown) => { odrzucenia.push(powod); };
  process.on('unhandledRejection', naOdrzucenie);
  const bledyKonsoli = console.error;
  console.error = () => {};
  const serwer = http.createServer(app);
  await new Promise<void>((resolve) => serwer.listen(0, '127.0.0.1', resolve));
  try {
    const baza = `http://127.0.0.1:${(serwer.address() as AddressInfo).port}`;
    const zepsuta = await zapytanie(`${baza}/api/zepsuta`, 'POST');
    assert.equal(zepsuta.status, 500);
    const tresc = JSON.parse(zepsuta.tresc) as { success: boolean; error: string };
    assert.equal(tresc.success, false);
    assert.doesNotMatch(tresc.error, /Cannot read|TypeError/);
    const ok = await zapytanie(`${baza}/ok`, 'GET');
    assert.equal(ok.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(odrzucenia.length, 0, 'odrzucenie nie moze zostac nieobsluzone');
  } finally {
    console.error = bledyKonsoli;
    process.off('unhandledRejection', naOdrzucenie);
    await new Promise<void>((resolve) => serwer.close(() => resolve()));
  }
});

test('serwer aplikacji konczy stos koncowa obsluga bledu', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-async-'));
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-async-runtime-'));
  try {
    const app = createInvestAnalyzerServer({ workspaceRoot: root, runtimeRoot });
    const stos = (app as unknown as { _router: { stack: Array<{ handle: unknown }> } })._router.stack;
    assert.equal(stos.at(-1)?.handle, koncowaObslugaBledu);
  } finally {
    for (const katalog of [root, runtimeRoot]) fs.rmSync(katalog, { recursive: true, force: true });
  }
});

function zapytanie(adres: string, metoda: string): Promise<{ status: number; tresc: string }> {
  return new Promise((resolve, reject) => {
    const zadanie = http.request(adres, { method: metoda, headers: { 'Content-Type': 'application/json' } }, (odp) => {
      let tresc = '';
      odp.on('data', (kawalek) => { tresc += kawalek; });
      odp.on('end', () => resolve({ status: odp.statusCode || 0, tresc }));
    });
    zadanie.setTimeout(3000, () => { zadanie.destroy(new Error('Trasa nie odpowiedziala w 3 s (zawieszone zadanie).')); });
    zadanie.on('error', reject);
    zadanie.end(metoda === 'POST' ? '{}' : undefined);
  });
}
