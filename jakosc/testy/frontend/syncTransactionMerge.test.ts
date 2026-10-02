import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeSyncedTransactions } from '../../../aplikacje/web/src/portfel/services/syncTransactionMerge.ts';
import type { Transaction } from '../../../aplikacje/web/src/portfel/types.ts';

function transaction(id: string, quantity: number): Transaction {
  return {
    id, accountId: 'ibkr', ticker: 'ABC', name: 'Example', category: 'STOCK_FOREIGN', type: 'BUY',
    date: '2026-01-01', quantity, pricePerUnit: 10, currency: 'USD', commission: 0,
    commissionCurrency: 'USD',
  };
}

test('synchronizacja zachowuje historię i aktualizuje istniejącą transakcję po ID', () => {
  const history = [transaction('old-1', 1), transaction('old-2', 2), transaction('old-3', 3)];
  const updated = transaction('old-2', 20);
  const merged = mergeSyncedTransactions(history, 'ibkr', [updated, transaction('new', 4)]);

  assert.equal(merged.length, 4);
  assert.deepEqual(merged.find(({ id }) => id === 'old-1'), history[0]);
  assert.deepEqual(merged.find(({ id }) => id === 'old-3'), history[2]);
  assert.deepEqual(merged.find(({ id }) => id === 'old-2'), updated);
  assert.ok(merged.some(({ id }) => id === 'new'));
});

test('ta sama operacja z pliku CSV i z API brokera nie wchodzi dwa razy', () => {
  const zPliku = { ...transaction('csv-1', 5), date: '2026-01-01T00:00:00' };
  const zApi = { ...transaction('ibkr-777', 5), date: '2026-01-01T15:30:00' };
  const merged = mergeSyncedTransactions([zPliku, transaction('old-2', 2)], 'ibkr', [zApi]);

  assert.equal(merged.length, 2);
  assert.ok(merged.some(({ id }) => id === 'ibkr-777'));
  assert.ok(!merged.some(({ id }) => id === 'csv-1'));
});

test('dwie identyczne operacje z jednego dnia paruja sie jedna do jednej', () => {
  const merged = mergeSyncedTransactions(
    [transaction('csv-a', 5), transaction('csv-b', 5)],
    'ibkr',
    [transaction('api-a', 5), transaction('api-b', 5), transaction('api-c', 5)],
  );

  assert.deepEqual(merged.map(({ id }) => id).sort(), ['api-a', 'api-b', 'api-c']);
});

test('wpis innego rachunku z wyniku synchronizacji nie trafia do historii', () => {
  const obcy = { ...transaction('obcy', 1), accountId: 'inny' };
  const merged = mergeSyncedTransactions([transaction('old-1', 1)], 'ibkr', [obcy]);
  assert.deepEqual(merged.map(({ id }) => id), ['old-1']);
});

test('wpisy bez ilosci albo ceny nie scalaja sie po tresci', () => {
  const bezIlosci = { ...transaction('csv-x', 1), quantity: Number.NaN };
  const zApiBezIlosci = { ...transaction('api-x', 1), quantity: Number.NaN };
  const merged = mergeSyncedTransactions([bezIlosci], 'ibkr', [zApiBezIlosci]);
  assert.deepEqual(merged.map(({ id }) => id).sort(), ['api-x', 'csv-x']);
});

test('wpis bez znanego ID nie zabiera miejsca wpisowi, ktory pasuje po ID (kolejnosc bez znaczenia)', () => {
  const zSynchronizacji = transaction('a', 5);
  const zPliku = transaction('csv', 5);
  const nowyBezId = transaction('n', 5);
  const znanyPoId = { ...transaction('a', 6) };
  for (const kolejnosc of [[nowyBezId, znanyPoId], [znanyPoId, nowyBezId]]) {
    const merged = mergeSyncedTransactions([zSynchronizacji, zPliku], 'ibkr', kolejnosc);
    // 'a' aktualizuje swoj wpis, 'n' paruje sie z wpisem z pliku o tej samej tresci.
    assert.deepEqual(merged.map(({ id }) => id).sort(), ['a', 'n']);
    assert.equal(merged.find(({ id }) => id === 'a')?.quantity, 6);
  }
});

test('ta sama tresc w innej walucie to inna operacja', () => {
  const zPliku = { ...transaction('csv-1', 5), currency: 'USD' as const };
  const zApiEur = { ...transaction('api-1', 5), currency: 'EUR' as const };
  const merged = mergeSyncedTransactions([zPliku], 'ibkr', [zApiEur]);
  assert.deepEqual(merged.map(({ id }) => id).sort(), ['api-1', 'csv-1']);
});
