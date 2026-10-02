import test from 'node:test';
import assert from 'node:assert/strict';
import { iloscZlecenia } from '../../../aplikacje/web/src/portfel/services/iloscZlecenia.ts';

test('ilosc zlecenia musi byc dodatnia i skonczona', () => {
  for (const wartosc of ['', ' ', 'abc', '2abc', '0', '-1', 'Infinity', 'NaN']) {
    assert.equal(iloscZlecenia(wartosc), null, wartosc);
  }
  assert.equal(iloscZlecenia('2.5'), 2.5);
});
