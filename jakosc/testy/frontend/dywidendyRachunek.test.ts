import test from 'node:test';
import assert from 'node:assert/strict';

import { etykietaRachunkuDywidendy, mapDividends, RACHUNEK_NIEUSTALONY } from '../../../aplikacje/web/src/portfel/services/engineBridge.ts';
import type { Transaction } from '../../../aplikacje/web/src/portfel/types.ts';

function tx(zmiany: Partial<Transaction>): Transaction {
  return {
    id: 't1', accountId: 'a', ticker: 'XYZ.US', name: 'XYZ', category: 'STOCK_FOREIGN', type: 'BUY',
    date: '2026-01-01', quantity: 1, pricePerUnit: 10, currency: 'USD', commission: 0, commissionCurrency: 'USD',
    ...zmiany,
  };
}

function odpowiedz(wiersz: Record<string, unknown>) {
  return { dividends_view: [{
    event_id: 'DIV-1', date: '2026-06-01', symbol: 'XYZ.US', gross_dividend_pln: '100', gross_dividend_foreign: '25',
    currency: 'USD', withholding_tax_pln: '15', withholding_tax_foreign: '4', ...wiersz,
  }] } as Parameters<typeof mapDividends>[0];
}

test('dywidenda bierze rachunek z wiersza silnika, gdy go ma', () => {
  const [d] = mapDividends(odpowiedz({ account_id: 'b' }), [tx({}), tx({ id: 't2', accountId: 'b' })]);
  assert.equal(d.accountId, 'b');
});

test('dywidenda bierze rachunek transakcji o tym samym ID zdarzenia', () => {
  const [d] = mapDividends(odpowiedz({}), [tx({}), tx({ id: 'DIV-1', accountId: 'b', type: 'DIVIDEND' })]);
  assert.equal(d.accountId, 'b');
});

test('ticker na jednym rachunku daje ten rachunek', () => {
  const [d] = mapDividends(odpowiedz({}), [tx({ accountId: 'a' }), tx({ id: 't2', accountId: 'a' })]);
  assert.equal(d.accountId, 'a');
});

test('ticker na wielu rachunkach bez rachunku w wierszu daje rachunek nieustalony, nie pierwszy', () => {
  const [d] = mapDividends(odpowiedz({}), [tx({ accountId: 'a' }), tx({ id: 't2', accountId: 'b' })]);
  assert.equal(d.accountId, RACHUNEK_NIEUSTALONY);
});

test('etykieta rachunku dywidendy: nazwa, nieustalony albo Główne', () => {
  const konta = [{ id: 'a', name: 'Dom' }] as never;
  assert.equal(etykietaRachunkuDywidendy('a', konta), 'Dom');
  assert.equal(etykietaRachunkuDywidendy(RACHUNEK_NIEUSTALONY, konta), 'Rachunek nieustalony');
  assert.equal(etykietaRachunkuDywidendy('', konta), 'Główne');
});
