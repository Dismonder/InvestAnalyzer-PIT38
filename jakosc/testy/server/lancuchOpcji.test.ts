import test from 'node:test';
import assert from 'node:assert/strict';

import { getFreedom24Options } from '../../../aplikacje/web/src/server/routes/brokers.ts';

test('bez poświadczeń i ceny nie powstaje wymyślony łańcuch opcji', async () => {
  const wynik = await getFreedom24Options('NVDA', undefined, undefined, undefined, null);
  assert.equal(wynik.success, false);
  assert.equal(wynik.underlyingPrice, null);
  assert.deepEqual(wynik.contracts, []);
});

test('znana cena instrumentu bazowego nie tworzy premii ani terminów ze wzoru', async () => {
  const wynik = await getFreedom24Options('NVDA', undefined, undefined, undefined, 218.29);
  assert.equal(wynik.success, false);
  assert.equal(wynik.underlyingPrice, 218.29);
  assert.deepEqual(wynik.expirationDates, []);
  assert.deepEqual(wynik.contracts, []);
});

test('rynek bez potwierdzonego kodu opcji jest odrzucany', async () => {
  const wynik = await getFreedom24Options('CDR.PL');
  assert.equal(wynik.success, false);
  assert.deepEqual(wynik.contracts, []);
  assert.match(String(wynik.message), /tylko rynek USA/);
});
