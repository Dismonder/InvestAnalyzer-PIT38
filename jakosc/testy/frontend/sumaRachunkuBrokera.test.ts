import test from 'node:test';
import assert from 'node:assert/strict';

import { sumaRachunkuBrokera } from '../../../aplikacje/web/src/portfel/services/sumaRachunkuBrokera.ts';

test('suma rachunku: gotówka i pozycje przeliczone kursem NBP, PLN po 1', () => {
  const suma = sumaRachunkuBrokera(
    [{ waluta: 'USD', kwota: 1000 }, { waluta: 'usd', kwota: 500 }, { waluta: 'PLN', kwota: 100 }, { waluta: 'EUR', kwota: 0 }],
    { USD: 4, EUR: null },
  );
  assert.equal(suma.sumaPLN, 6100);
  assert.equal(suma.sumaUSD, 1525);
  assert.deepEqual(suma.bezKursu, []);
});

test('waluta bez kursu nie jest liczona 1:1 - jest nazwana jako nieujęta', () => {
  const suma = sumaRachunkuBrokera([{ waluta: 'EUR', kwota: 200 }, { waluta: 'PLN', kwota: 50 }, { waluta: 'USD', kwota: null }], {});
  assert.equal(suma.sumaPLN, 50);
  assert.equal(suma.sumaUSD, null);
  assert.deepEqual(suma.bezKursu, ['EUR']);
  assert.equal(suma.bezKwoty, 1);
});
