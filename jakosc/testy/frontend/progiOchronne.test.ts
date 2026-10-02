import test from 'node:test';
import assert from 'node:assert/strict';

import { ocenProgi, progOdKursu } from '../../../aplikacje/web/src/portfel/services/progiOchronne.ts';

test('progi liczą się od aktualnego kursu, nie od ceny zakupu', () => {
  // Pozycja kupiona po 266,73 przy kursie 223,54: SL -5% to 212,36, nie 253,40 (powyżej rynku).
  assert.equal(progOdKursu(223.54, 5, 'SL')?.toFixed(2), '212.36');
  assert.equal(progOdKursu(223.54, 15, 'TP')?.toFixed(2), '257.07');
  assert.equal(progOdKursu(null, 5, 'SL'), null);
});

test('wskaźnik zysk/ryzyko tylko dla układu SL < kurs < TP', () => {
  assert.equal(ocenProgi(223.54, 212.363, 257.071).rrr?.toFixed(2), '3.00');
  const slPowyzej = ocenProgi(223.54, 253.4, 306.74);
  assert.equal(slPowyzej.rrr, null, 'wcześniej wychodziło 1 : 83203');
  assert.match(slPowyzej.blad ?? '', /Stop-Loss/);
  assert.match(ocenProgi(223.54, 200, 220).blad ?? '', /Take-Profit/);
  assert.deepEqual(ocenProgi(null, 200, 250), { rrr: null, blad: null });
});
