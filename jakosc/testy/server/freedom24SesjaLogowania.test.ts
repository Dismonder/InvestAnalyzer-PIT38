import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  freedom24Session,
  otworzSesjeZOdpowiedzi,
  parametryLogowaniaHaslem,
} from '../../../aplikacje/web/src/server/freedom24/freedom24Api.ts';
import brokersRouter from '../../../aplikacje/web/src/server/routes/brokers.ts';

test('logowanie hasłem zawsze prosi o tryb tylko do podglądu i nie zapamiętuje sesji na 2 tygodnie', () => {
  const params = parametryLogowaniaHaslem('ktos@example.com', 'fikcyjne-haslo');
  assert.equal(params.viewOnlyMode, true);
  assert.equal(params.rememberMe, 0);
  assert.equal(params.getAccounts, false);
});

test('sesja żyje w pamięci serwera, jej opis nie zawiera SID, a po 12 godzinach wygasa', () => {
  freedom24Session.close();
  assert.deepEqual(otworzSesjeZOdpowiedzi({ success: true, logged: true, SID: 'fikcyjny-sid-0001' }, 'LOGIN'), { ok: true });
  const opis = freedom24Session.describe();
  assert.equal(opis.active, true);
  assert.equal(opis.method, 'LOGIN');
  assert.equal(JSON.stringify(opis).includes('fikcyjny-sid-0001'), false);
  assert.equal(freedom24Session.current(Date.now() + 13 * 3600_000), null);
  assert.equal(freedom24Session.describe().active, false);
});

test('odpowiedź brokera bez SID albo z logged=false nie otwiera sesji', () => {
  freedom24Session.close();
  assert.equal(otworzSesjeZOdpowiedzi({ success: true }, 'SMS').ok, false);
  assert.equal(otworzSesjeZOdpowiedzi({ SID: 'fikcyjny-sid-0002', logged: false }, 'SMS').ok, false);
  assert.equal(freedom24Session.describe().active, false);
});

test('trasy logowania: puste dane to 400 bez zapytania do brokera, a status i wylogowanie nie ujawniają SID', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/brokers', brokersRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baza = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/brokers/freedom24`;
  try {
    const pusty = await fetch(`${baza}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(pusty.status, 400);

    freedom24Session.open('fikcyjny-sid-0003', 'SMS');
    const status = await (await fetch(`${baza}/status`)).text();
    assert.equal(status.includes('fikcyjny-sid-0003'), false);
    assert.equal(JSON.parse(status).session.active, true);

    const wylogowanie = await (await fetch(`${baza}/auth/logout`, { method: 'POST' })).json();
    assert.equal(wylogowanie.session.active, false);
    assert.equal(freedom24Session.current(), null);
  } finally {
    freedom24Session.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
