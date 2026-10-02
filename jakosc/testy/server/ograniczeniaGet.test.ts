/**
 * GET /api/* nie mial kontroli Origin, wiec obca strona mogla (no-cors) wywolywac
 * /api/quotes i /api/history z dowolna liczba tickerow: nieograniczona lista
 * obserwowanych przez rejestrator nocny, setki rownoleglych zapytan do dostawcy.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import express from 'express';

import { createInvestAnalyzerServer } from '../../../aplikacje/web/src/server/createInvestAnalyzerServer.ts';
import quotesRouter, { MAX_TICKEROW_NA_ZADANIE, MAX_ROWNOLEGLYCH_POBRAN } from '../../../aplikacje/web/src/server/routes/quotes.ts';
import { RejestratorNocny } from '../../../aplikacje/web/src/server/overnightRecorder.ts';

async function zSerwerem(app: express.Express | http.RequestListener, uzyj: (adres: string) => Promise<void>) {
  const serwer = http.createServer(app);
  await new Promise<void>((gotowe) => serwer.listen(0, '127.0.0.1', gotowe));
  try {
    await uzyj(`http://127.0.0.1:${(serwer.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((gotowe) => serwer.close(() => gotowe()));
  }
}

test('GET /api/quotes odrzuca za dluga liste tickerow kodem 400 bez pytania dostawcy', async () => {
  const oryginalny = globalThis.fetch;
  let zapytaniaDoDostawcy = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('127.0.0.1')) return oryginalny(input, init);
    zapytaniaDoDostawcy += 1;
    throw new Error('dostawca niedostepny');
  }) as typeof fetch;
  const app = express();
  app.use('/api', quotesRouter);
  try {
    await zSerwerem(app, async (adres) => {
      const zaDuzo = Array.from({ length: MAX_TICKEROW_NA_ZADANIE + 1 }, (_, i) => `LIM${i}`).join(',');
      const odpowiedz = await fetch(`${adres}/api/quotes?tickers=${zaDuzo}`);
      assert.equal(odpowiedz.status, 400);
      const tresc = (await odpowiedz.json()) as { success: boolean; error: string };
      assert.equal(tresc.success, false);
      assert.match(tresc.error, new RegExp(String(MAX_TICKEROW_NA_ZADANIE)));
      assert.equal(zapytaniaDoDostawcy, 0);
    });
  } finally { globalThis.fetch = oryginalny; }
});

test('pobieranie notowan akcji ma ograniczona rownoleglosc', async () => {
  const oryginalny = globalThis.fetch;
  const oryginalnyLog = console.error;
  console.error = () => undefined;
  let wLocie = 0;
  let maksimum = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('127.0.0.1')) return oryginalny(input, init);
    wLocie += 1;
    maksimum = Math.max(maksimum, wLocie);
    await new Promise((resolve) => setTimeout(resolve, 15));
    wLocie -= 1;
    return new Response('{}', { status: 500 });
  }) as typeof fetch;
  const app = express();
  app.use('/api', quotesRouter);
  try {
    await zSerwerem(app, async (adres) => {
      const tickery = Array.from({ length: 40 }, (_, i) => `ROWN${i}`).join(',');
      const odpowiedz = await fetch(`${adres}/api/quotes?tickers=${tickery}&force=true`);
      assert.equal(odpowiedz.status, 200);
      assert.ok(maksimum > 0, 'atrapa dostawcy musi zostac wywolana');
      assert.ok(maksimum <= MAX_ROWNOLEGLYCH_POBRAN, `rownolegle pobrania: ${maksimum}`);
    });
  } finally { globalThis.fetch = oryginalny; console.error = oryginalnyLog; }
});

test('rejestrator nocny odmawia obserwowania ponad limit, ale odswieza juz obserwowane', async () => {
  const katalog = fs.mkdtempSync(path.join(os.tmpdir(), 'nocny-limit-'));
  // Poniedzialek 02:00 w Nowym Jorku - sesja nocna.
  const teraz = Date.parse('2026-01-05T07:00:00Z');
  const pytane: string[] = [];
  const rejestrator = new RejestratorNocny(katalog, async (ticker) => { pytane.push(ticker); return 10; }, () => teraz, 3);
  try {
    for (const ticker of ['AAA', 'BBB', 'CCC', 'DDD', 'EEE']) rejestrator.obserwuj(ticker);
    rejestrator.obserwuj('AAA');
    await rejestrator.probkuj();
    assert.deepEqual(pytane.sort(), ['AAA', 'BBB', 'CCC']);
  } finally { fs.rmSync(katalog, { recursive: true, force: true }); }
});

test('rejestrator nocny zwalnia miejsce po wygasnieciu obserwacji (7 dni)', async () => {
  const katalog = fs.mkdtempSync(path.join(os.tmpdir(), 'nocny-wygasanie-'));
  let teraz = Date.parse('2026-01-05T07:00:00Z');
  const pytane: string[] = [];
  const rejestrator = new RejestratorNocny(katalog, async (ticker) => { pytane.push(ticker); return 10; }, () => teraz, 1);
  try {
    rejestrator.obserwuj('AAA');
    teraz += 8 * 86_400_000;
    rejestrator.obserwuj('BBB');
    await rejestrator.probkuj();
    assert.deepEqual(pytane, ['BBB']);
  } finally { fs.rmSync(katalog, { recursive: true, force: true }); }
});

test('GET /api z Sec-Fetch-Site: cross-site jest odrzucany, wlasny front przechodzi', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-get-'));
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-get-runtime-'));
  fs.mkdirSync(path.join(root, 'dane', 'pliki'), { recursive: true });
  try {
    await zSerwerem(createInvestAnalyzerServer({ workspaceRoot: root, runtimeRoot }), async (adres) => {
      const pobierz = (naglowki: Record<string, string>) =>
        new Promise<number>((resolve, reject) => {
          http.get(`${adres}/api/quotes?tickers=`, { headers: naglowki }, (odpowiedz) => {
            odpowiedz.resume();
            resolve(odpowiedz.statusCode ?? 0);
          }).on('error', reject);
        });
      assert.equal(await pobierz({ 'Sec-Fetch-Site': 'cross-site' }), 403);
      for (const zrodlo of ['same-origin', 'same-site', 'none']) {
        assert.equal(await pobierz({ 'Sec-Fetch-Site': zrodlo }), 200, zrodlo);
      }
      assert.equal(await pobierz({}), 200, 'klient bez naglowka (skrypty, testy)');
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
