import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import express from 'express';

import brokersRouter, { polskiDzienKalendarzowy } from '../../../aplikacje/web/src/server/routes/brokers.ts';

async function withMockExport(total: number, emptySecondPage: boolean, run: (baseUrl: string, reportDates: string[]) => Promise<void>) {
  const credentialsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom24-export-test-'));
  fs.writeFileSync(path.join(credentialsDir, 'public'), 'test-public');
  fs.writeFileSync(path.join(credentialsDir, 'private'), 'test-private');
  const originalFetch = globalThis.fetch;
  const oldCredentials = process.env.FREEDOM24_CREDENTIALS_DIR;
  const oldIntegration = process.env.FREEDOM24_INTEGRATION;
  const oldDisabled = process.env.FREEDOM24_DISABLE_LIVE;
  process.env.FREEDOM24_CREDENTIALS_DIR = credentialsDir;
  process.env.FREEDOM24_INTEGRATION = '1';
  delete process.env.FREEDOM24_DISABLE_LIVE;
  const reportDates: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith('https://freedom24.com/api/')) return originalFetch(input, init);
    const command = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    const params = JSON.parse(String(init?.body || '{}')) as { skip?: number; type?: string; date_end?: string };
    if (command === 'getTradesHistory') return new Response(JSON.stringify({ trades: { trade: [{ date: '2025-01-01' }] } }));
    if (command === 'getUserCashFlows') {
      const skip = params.skip || 0;
      const count = emptySecondPage && skip > 0 ? 0 : Math.min(100, total - skip);
      return new Response(JSON.stringify({ total, cashflow: Array.from({ length: count }, (_, index) => ({ id: skip + index })) }));
    }
    if (command === 'getPositionJson') return new Response(JSON.stringify({ result: { ps: { acc: [], pos: [] } } }));
    if (command === 'getBrokerReport') {
      reportDates.push(String(params.date_end));
      if (params.type === 'commissions') return new Response(JSON.stringify({ error: 'Sekcja niedostępna' }), { status: 400 });
      return new Response(JSON.stringify({ report: [] }));
    }
    if (command === 'getDepositaryReport') return new Response(JSON.stringify({ report: {} }));
    throw new Error(`Nieoczekiwane polecenie: ${command}`);
  }) as typeof fetch;
  const app = express();
  app.use(express.json());
  app.use('/api/brokers', brokersRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, reportDates);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    globalThis.fetch = originalFetch;
    if (oldCredentials === undefined) delete process.env.FREEDOM24_CREDENTIALS_DIR;
    else process.env.FREEDOM24_CREDENTIALS_DIR = oldCredentials;
    if (oldIntegration === undefined) delete process.env.FREEDOM24_INTEGRATION;
    else process.env.FREEDOM24_INTEGRATION = oldIntegration;
    if (oldDisabled === undefined) delete process.env.FREEDOM24_DISABLE_LIVE;
    else process.env.FREEDOM24_DISABLE_LIVE = oldDisabled;
    fs.rmSync(credentialsDir, { recursive: true, force: true });
  }
}

test('eksport Freedom24 przekracza 2000 przepływów i wskazuje brakującą sekcję podatkową', async () => {
  await withMockExport(2101, false, async (baseUrl, reportDates) => {
    const response = await fetch(`${baseUrl}/api/brokers/freedom24/full-export`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    const result = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(result.success, true);
    assert.equal(result.report.cash_flows.length, 2101);
    assert.equal(result.complete, false);
    assert.deepEqual(result.missingSections, ['commissions']);
    assert.ok(reportDates.every((date) => date === polskiDzienKalendarzowy()));
  });
});

test('brak dalszej strony przepływów jest jawnym błędem z liczbą brakujących rekordów', async () => {
  await withMockExport(250, true, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/brokers/freedom24/full-export`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    const result = await response.json() as any;
    assert.equal(response.status, 502);
    assert.equal(result.errorCode, 'FREEDOM24_EXPORT_INCOMPLETE');
    assert.equal(result.missingRecords, 150);
  });
});

test('domyślny dzień raportu uwzględnia północ w Polsce', () => {
  assert.equal(polskiDzienKalendarzowy(new Date('2026-01-01T23:30:00Z')), '2026-01-02');
  assert.equal(polskiDzienKalendarzowy(new Date('2026-07-01T22:30:00Z')), '2026-07-02');
});
