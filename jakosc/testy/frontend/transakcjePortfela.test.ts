import test from 'node:test';
import assert from 'node:assert/strict';

import { oczyscTransakcje } from '../../../aplikacje/web/src/portfel/services/transakcjePortfela.ts';
import type { Transaction } from '../../../aplikacje/web/src/portfel/types.ts';
import { DEMO_TRANSACTION_IDS } from '../../../aplikacje/web/src/portfel/services/sampleData.ts';

const poprawna: Transaction = {
  id: 'tx-real-1', accountId: 'acc-real', ticker: 'CDR', name: 'CD Projekt',
  category: 'STOCK_PL', type: 'BUY', date: '2026-10-01', quantity: 2,
  pricePerUnit: 100, currency: 'PLN', commission: 0, commissionCurrency: 'PLN',
};

test('transakcje bez pol potrzebnych powloce odpadaja', () => {
  const brakujace = [
    { id: 'x' },
    ...(['id', 'accountId', 'ticker', 'type', 'date', 'quantity', 'pricePerUnit', 'currency'] as const)
      .map((pole) => ({ ...poprawna, [pole]: undefined })),
    { ...poprawna, id: '   ' },
    { ...poprawna, ticker: '   ' },
    { ...poprawna, date: '2026-10' },
    { ...poprawna, quantity: Infinity },
    { ...poprawna, pricePerUnit: NaN },
    null,
    'tekst',
  ] as unknown as Transaction[];
  assert.deepEqual(oczyscTransakcje([poprawna, ...brakujace]), [poprawna]);
});

test('poprawne transakcje zachowuja kolejnosc i pola opcjonalne', () => {
  const druga = { ...poprawna, id: 'tx-real-2', notes: 'test' };
  // Oplata z importu CSV nie ma symbolu waloru - to prawidlowy wpis.
  const oplata: Transaction = { ...poprawna, id: 'tx-fee', type: 'FEE', ticker: '', quantity: 1, pricePerUnit: 9.9 };
  assert.deepEqual(oczyscTransakcje([druga, poprawna, oplata]), [druga, poprawna, oplata]);
});

test('stare transakcje demo nadal odpadaja', () => {
  const demoIds = [...DEMO_TRANSACTION_IDS].map((id) => ({ ...poprawna, id }));
  const demoPrefix = ['tx_demo', 'tx_demo_inna', 'tx_demoUser'].map((id) => ({ ...poprawna, id }));
  assert.deepEqual(oczyscTransakcje([...demoIds, poprawna, ...demoPrefix]), [poprawna]);
});

test('transakcja uzytkownika na rachunku o demo-id zostaje', () => {
  const transakcja = { ...poprawna, accountId: 'acc_xtb_pln' };
  assert.deepEqual(oczyscTransakcje([transakcja]), [transakcja]);
});
