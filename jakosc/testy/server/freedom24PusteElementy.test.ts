/**
 * Pusty albo uszkodzony element tablicy w odpowiedzi Freedom24 (null, liczba)
 * wywracal adapter TypeError-em i cala trasa konczyla sie bledem 500.
 * Elementy bez danych sa pomijane, reszta odpowiedzi zostaje odczytana.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { adaptPortfolio } from '../../../aplikacje/web/src/server/freedom24/freedom24Api.ts';

test('adaptPortfolio pomija elementy null zamiast rzucac TypeError', () => {
  const portfel = adaptPortfolio({ result: { ps: { acc: [null, { curr: 'usd', s: 5 }], pos: [null, 7, { i: 'AAPL.US', q: 2, curr: 'USD' }] } } });
  assert.equal(portfel.balances.length, 1);
  assert.equal(portfel.balances[0].currency, 'USD');
  assert.equal(portfel.positions.length, 1);
  assert.equal(portfel.positions[0].ticker, 'AAPL');
  assert.equal(portfel.positions[0].quantity, 2);
});
