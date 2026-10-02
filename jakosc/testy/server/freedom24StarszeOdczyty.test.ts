import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import router from '../../../aplikacje/web/src/server/routes/brokers.ts';

test('starsze trasy odczytu używają wyłącznie serwerowych kluczy i dokumentowanych poleceń', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom24-mock-'));
  fs.writeFileSync(path.join(folder, 'public'), 'test-public');
  fs.writeFileSync(path.join(folder, 'private'), 'test-private');
  const previous = {
    dir: process.env.FREEDOM24_CREDENTIALS_DIR,
    integration: process.env.FREEDOM24_INTEGRATION,
    disable: process.env.FREEDOM24_DISABLE_LIVE,
    fetch: globalThis.fetch,
  };
  process.env.FREEDOM24_CREDENTIALS_DIR = folder;
  process.env.FREEDOM24_INTEGRATION = '1';
  delete process.env.FREEDOM24_DISABLE_LIVE;

  const calls: string[] = [];
  const requests: Array<{ command: string; params: any }> = [];
  const answers: Record<string, unknown> = {
    getOrdersHistory: { orders: { order: [{ id: 4, instr_nm: 'NBIS.US', q: 1, p: 10 }] } },
    getUserCashFlows: { cashflow: [{ id: 5 }] },
    getClientCpsHistory: { cps: [{ id: 6, status_c: 1 }] },
    getCpsFiles: { files: [{ file_name: 'test.pdf' }] },
    getUserStockLists: { userStockLists: [{ id: 7, name: 'Test', tickers: [] }] },
    getOptionsByMktNameAndBaseAsset: [
      { ticker: '+NBIS^C20.US', base_contract_code: 'NBIS.US', expire_date: '2026-10-16', strike_price: '20', option_type: 'CALL' },
      { ticker: '+NBIS^P20.US', base_contract_code: 'NBIS.US', expire_date: '2026-10-16', strike_price: '20', option_type: 'PUT' },
      { ticker: '+NBIS^C25.US', base_contract_code: 'NBIS.US', expire_date: '2026-11-20', strike_price: '25', option_type: 'CALL' },
    ],
    getHloc: { hloc: [{ date: '2026-09-01', o: 20, h: 22, l: 19, c: 21, v: 10 }] },
  };
  globalThis.fetch = (async (input, init) => {
    const command = String(input).split('/').at(-1) || '';
    assert.equal((init?.headers as Record<string, string>)['X-NtApi-PublicKey'], 'test-public');
    calls.push(command);
    const params = JSON.parse(String(init?.body || '{}'));
    requests.push({ command, params });
    const answer = answers[command];
    return new Response(JSON.stringify(typeof answer === 'function' ? (answer as (params: any) => unknown)(params) : answer), { status: 200 });
  }) as typeof fetch;

  const app = express();
  app.use(express.json());
  app.use(router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  const post = (route: string, body: object = {}) => new Promise<{ status: number; data: any }>((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: route, method: 'POST',
      headers: { 'Content-Type': 'application/json' } }, (response) => {
      let content = '';
      response.on('data', (chunk) => { content += chunk; });
      response.on('end', () => resolve({ status: response.statusCode || 0, data: JSON.parse(content) }));
    });
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });

  try {
    const routes: Array<[string, object, string]> = [
      ['/freedom24/orders-history', {}, 'getOrdersHistory'],
      ['/freedom24/cashflows', {}, 'getUserCashFlows'],
      ['/freedom24/cps/history', {}, 'getClientCpsHistory'],
      ['/freedom24/cps/files', { id: 6 }, 'getCpsFiles'],
      ['/freedom24/stock-lists', {}, 'getUserStockLists'],
      ['/freedom24/options', { ticker: 'NBIS', underlyingPrice: 21 }, 'getOptionsByMktNameAndBaseAsset'],
      ['/freedom24/hloc', { ticker: 'NBIS' }, 'getHloc'],
    ];
    for (const [route, body, command] of routes) {
      const response = await post(route, body);
      assert.equal(response.status, 200, route);
      assert.equal(response.data.success, true, route);
      assert.equal(calls.at(-1), command, route);
    }
    const options = await post('/freedom24/options', { ticker: 'NBIS', underlyingPrice: 21 });
    assert.equal(options.data.underlyingPrice, 21);
    assert.deepEqual(requests.filter((entry) => entry.command === 'getOptionsByMktNameAndBaseAsset').at(-1)?.params,
      { ltr: 'FIX', base_contract_code: 'NBIS.US' });
    assert.deepEqual(options.data.expirationDates, ['2026-10-16', '2026-11-20']);
    assert.equal(options.data.selectedExpiration, '2026-10-16');
    assert.equal(options.data.contracts.length, 1);
    assert.equal(options.data.contracts[0].callTicker, '+NBIS^C20.US');
    assert.equal(options.data.contracts[0].putTicker, '+NBIS^P20.US');
    assert.equal(options.data.contracts[0].callBid, null);
    assert.equal(options.data.contracts[0].putAsk, null);
    const nextExpiry = await post('/freedom24/options', { ticker: 'NBIS.US', expiration: '2026-11-20' });
    assert.equal(nextExpiry.data.contracts.length, 1);
    assert.equal(nextExpiry.data.contracts[0].strike, 25);
    assert.equal(nextExpiry.data.contracts[0].putTicker, null);
    const beforeUnsupported = calls.length;
    assert.equal((await post('/freedom24/options', { ticker: 'CDR.PL' })).status, 400);
    assert.equal(calls.length, beforeUnsupported);

    answers.getUserCashFlows = (params: any) => params.skip === 0
      ? { total: 101, cashflow: Array.from({ length: 100 }, (_, index) => ({ id: index })) }
      : { total: 101, cashflow: [{ id: 100 }] };
    const cashflows = await post('/freedom24/cashflows', { dateFrom: '2026-01-01', dateTo: '2026-12-31' });
    assert.equal(cashflows.status, 200);
    assert.equal(cashflows.data.cashflows.length, 101);
    assert.deepEqual(requests.filter((entry) => entry.command === 'getUserCashFlows').slice(-2).map((entry) => entry.params), [
      { take: 100, skip: 0, filters: [{ field: 'date', operator: 'eqormore', value: '2026-01-01' }, { field: 'date', operator: 'eqorless', value: '2026-12-31' }] },
      { take: 100, skip: 100, filters: [{ field: 'date', operator: 'eqormore', value: '2026-01-01' }, { field: 'date', operator: 'eqorless', value: '2026-12-31' }] },
    ]);
    answers.getUserCashFlows = (params: any) => params.skip === 0
      ? { total: 101, cashflow: Array.from({ length: 100 }, (_, index) => ({ id: index })) }
      : { total: 101, cashflow: [] };
    const incomplete = await post('/freedom24/cashflows');
    assert.equal(incomplete.status, 502);
    assert.deepEqual(incomplete.data.cashflows, []);
    assert.equal((await post('/freedom24/hloc', { ticker: 'NBIS' })).data.demoData, undefined);

    for (const [route, body, command] of routes) {
      answers[command] = { errMsg: 'token=abc12345678901234567890123456789' };
      const denied = await post(route, body);
      assert.equal(denied.status, 502, route);
      assert.equal(denied.data.success, false, route);
      assert.doesNotMatch(denied.data.message, /abc123/, route);
    }

    process.env.FREEDOM24_CREDENTIALS_DIR = path.join(folder, 'missing');
    for (const [route, body] of routes.filter(([route]) => route !== '/freedom24/hloc')) {
      assert.equal((await post(route, body)).status, 400, route);
    }
    const demo = await post('/freedom24/hloc', { ticker: 'NBIS', count: 1 });
    assert.equal(demo.status, 200);
    assert.equal(demo.data.demoData, true);
    assert.match(demo.data.demoReason, /Brak poświadczeń/);
    assert.equal((await post('/freedom24/options', { ticker: 'NBIS' })).status, 400);

    for (const route of ['/freedom24/portfolio', '/freedom24/full-export']) {
      assert.equal(router.stack.filter((layer: any) => layer.route?.path === route).length, 1, route);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    globalThis.fetch = previous.fetch;
    if (previous.dir === undefined) delete process.env.FREEDOM24_CREDENTIALS_DIR;
    else process.env.FREEDOM24_CREDENTIALS_DIR = previous.dir;
    if (previous.integration === undefined) delete process.env.FREEDOM24_INTEGRATION;
    else process.env.FREEDOM24_INTEGRATION = previous.integration;
    if (previous.disable === undefined) delete process.env.FREEDOM24_DISABLE_LIVE;
    else process.env.FREEDOM24_DISABLE_LIVE = previous.disable;
    const resolved = path.resolve(folder);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
