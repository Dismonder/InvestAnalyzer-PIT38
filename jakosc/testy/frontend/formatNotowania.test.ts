import test from 'node:test';
import assert from 'node:assert/strict';

import { formatujProcentZmiany, zmianaLubNull } from '../../../aplikacje/web/src/portfel/services/formatNotowania.ts';

test('brak zmiany dziennej to kreska, a nie wyjatek ani 0.00%', () => {
  for (const brak of [null, undefined, Number.NaN, '1.2', {}]) {
    assert.equal(formatujProcentZmiany(brak), '—');
    assert.equal(zmianaLubNull(brak), null);
  }
});

test('zmiana dzienna jest formatowana ze znakiem, takze zero', () => {
  assert.equal(formatujProcentZmiany(1.234), '+1,23%');
  assert.equal(formatujProcentZmiany(-0.4), '-0,40%');
  assert.equal(formatujProcentZmiany(0), '+0,00%');
});