import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { Freedom24ApiClient, FREEDOM24_PROTECTIVE_COMMANDS, FREEDOM24_READ_ONLY_COMMANDS } from '../../../aplikacje/web/src/server/freedom24/freedom24Api.ts';
import brokersRouter, { bladProsbyOchrony, zleceniaZOdpowiedzi } from '../../../aplikacje/web/src/server/routes/brokers.ts';

test('zlecenia z rachunku: typ 6 to take-profit, status 10 to aktywne', () => {
  const zlecenia = zleceniaZOdpowiedzi({
    orders: { order: [
      { id: 111, instr: 'NBIS.US', oper: 3, type: 6, stat: 10, q: 30, leaves_qty: 30, p: 275.88, stop: 281, cur: 'USD', exp: 3, date: '2026-09-18 15:00:00' },
      { id: 112, instr: 'NBIS.US', oper: 3, type: 5, stat: 31, q: 30, p: 0, stop: 200, cur: 'USD', exp: 1 },
      { instr: 'BEZ.ID' },
    ] },
  });
  assert.equal(zlecenia.length, 2);
  assert.deepEqual(
    { ...zlecenia[0] },
    { orderId: 111, ticker: 'NBIS.US', rodzaj: 'TAKE_PROFIT', strona: 'SPRZEDAZ', ilosc: 30, pozostalo: 30, cenaProgu: 281, cenaZlecenia: 275.88, waluta: 'USD', status: 10, aktywne: true, waznosc: 'DO_ANULOWANIA', data: '2026-09-18 15:00:00' },
  );
  assert.equal(zlecenia[1].rodzaj, 'STOP_LOSS');
  assert.equal(zlecenia[1].aktywne, false, 'anulowane (31) nie jest aktywne');
  assert.equal(zlecenia[1].cenaZlecenia, null, 'cena 0 to brak ceny, nie zero');
  assert.deepEqual(zleceniaZOdpowiedzi({ orders: [] }), []);
});

test('SL/TP tylko na posiadanej pozycji i tylko po właściwej stronie kursu z rachunku', () => {
  const pozycja = { quantity: 30, marketPrice: 223.54 };
  assert.equal(bladProsbyOchrony({ ticker: 'NBIS.US', stopLoss: 212.36, takeProfit: 257.07 }, pozycja), null);
  assert.match(bladProsbyOchrony({ ticker: 'NBIS.US', stopLoss: 253.4, takeProfit: null }, pozycja) ?? '', /Stop-Loss/);
  assert.match(bladProsbyOchrony({ ticker: 'NBIS.US', stopLoss: null, takeProfit: 200 }, pozycja) ?? '', /Take-Profit/);
  assert.match(bladProsbyOchrony({ ticker: 'NBIS.US', stopLoss: null, takeProfit: null }, pozycja) ?? '', /Podaj cenę/);
  assert.match(bladProsbyOchrony({ ticker: 'AAPL.US', stopLoss: 100, takeProfit: null }, null) ?? '', /nie ma otwartej pozycji/);
  assert.match(bladProsbyOchrony({ ticker: 'NBIS.US', stopLoss: 100, takeProfit: null }, { quantity: 30, marketPrice: null }) ?? '', /nie podał bieżącego kursu/);
  assert.match(bladProsbyOchrony({ ticker: '../x', stopLoss: 1, takeProfit: null }, pozycja) ?? '', /ticker/);
});

test('klient wysyła wyłącznie SL/TP i anulowanie - kupno i sprzedaż nie przechodzą żadną drogą', async () => {
  const wyslane: string[] = [];
  const falszywyHttp = { post: async (command: string) => { wyslane.push(command); return { ok: true, data: {}, status: 200 }; } };
  const api = new Freedom24ApiClient(falszywyHttp as never);
  assert.deepEqual([...FREEDOM24_PROTECTIVE_COMMANDS].sort(), ['delTradeOrder', 'putStopLoss']);
  for (const zakazane of ['putTradeOrder', 'putOrder', 'getPositionJson']) {
    assert.equal((await api.protect(zakazane, {})).ok, false);
  }
  for (const zapis of ['putStopLoss', 'delTradeOrder', 'putTradeOrder']) {
    assert.equal(FREEDOM24_READ_ONLY_COMMANDS.has(zapis), false);
    assert.equal((await api.read(zapis, {})).ok, false);
  }
  assert.deepEqual(wyslane, [], 'żadne z odrzuconych poleceń nie trafiło do sieci');
  assert.equal((await api.protect('putStopLoss', { instr_name: 'NBIS.US', stop_loss: 212.36 })).ok, true);
  assert.deepEqual(wyslane, ['putStopLoss']);
});

test('trasy zleceń odmawiają bez jawnego potwierdzenia, zanim cokolwiek pójdzie do brokera', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/brokers', brokersRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baza = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/brokers/freedom24/orders`;
  const post = (sciezka: string, tresc: object) => fetch(`${baza}/${sciezka}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tresc) });
  try {
    assert.equal((await post('protect', { ticker: 'NBIS.US', stopLoss: 212 })).status, 400);
    assert.equal((await post('cancel', { orderId: 111 })).status, 400);
    assert.equal((await post('cancel', { orderId: 'abc', confirm: true })).status, 400);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
