import test from 'node:test';
import assert from 'node:assert/strict';

import { obliczObrotRoku } from '../../../aplikacje/web/src/portfel/services/obrotRoczny.ts';
import type { Transaction } from '../../../aplikacje/web/src/portfel/types.ts';

function tx(zmiany: Partial<Transaction>): Transaction {
  return {
    id: 't', accountId: 'a', ticker: 'NBIS.US', name: 'NBIS', category: 'STOCK_FOREIGN', type: 'BUY',
    date: '2026-02-01', quantity: 10, pricePerUnit: 100, currency: 'USD', commission: 1, commissionCurrency: 'USD',
    ...zmiany,
  } as Transaction;
}

test('obrót roku to kupno + sprzedaż, osobno dla każdej waluty', () => {
  const wynik = obliczObrotRoku(
    [
      tx({}),
      tx({ type: 'SELL', quantity: 10, pricePerUnit: 120 }),
      tx({ currency: 'PLN', quantity: 5, pricePerUnit: 200 }),
      tx({ date: '2025-12-31' }),
      tx({ type: 'DIVIDEND' as Transaction['type'] }),
    ],
    2026,
  );
  assert.deepEqual(wynik.waluty.map((w) => [w.waluta, w.kupno, w.sprzedaz, w.razem, w.liczbaKupna, w.liczbaSprzedazy]), [
    ['USD', 1000, 1200, 2200, 1, 1],
    ['PLN', 1000, 0, 1000, 1, 0],
  ]);
  assert.equal(wynik.pominiete, 0);
});

test('transakcja bez ceny albo waluty nie jest zgadywana - jest policzona jako pominięta', () => {
  const wynik = obliczObrotRoku([tx({ pricePerUnit: 0 }), tx({ currency: '' as Transaction['currency'] }), tx({})], 2026);
  assert.equal(wynik.pominiete, 2);
  assert.equal(wynik.waluty[0].razem, 1000);
});
