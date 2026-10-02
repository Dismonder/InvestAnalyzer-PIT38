import test from 'node:test';
import assert from 'node:assert/strict';

import { przygotujDaneWykresu, sekundyZakresu } from '../../../aplikacje/web/src/portfel/services/daneWykresuGieldowego.ts';
import { najdluzszyZakres } from '../../../aplikacje/web/src/server/routes/quotes.ts';
import { wiarygodnaDataDebiutu } from '../../../aplikacje/web/src/server/routes/brokers.ts';

const t0 = Date.UTC(2026, 8, 18, 14, 0);
const swieca = (minuty: number, zmiany: object = {}) => ({ timestamp: t0 + minuty * 60_000, open: 10, high: 12, low: 9, close: 11, volume: 100, ...zmiany });

test('dane dla wykresu: rosnąco, bez powtórzonych znaczników i bez świec z niepełną ceną', () => {
  const dane = przygotujDaneWykresu([
    swieca(15), swieca(0), swieca(15, { close: 11.5 }),
    swieca(30, { close: Number.NaN }), swieca(45, { open: undefined as unknown as number }), swieca(60, { close: 0 }),
  ]);
  assert.equal(dane.swiece.length, 2);
  assert.ok(dane.swiece[0].time < dane.swiece[1].time);
  assert.equal(dane.swiece[1].close, 11.5, 'powtórzony znacznik: wygrywa ostatni odczyt');
  assert.equal(dane.linia.length, 2);
  assert.equal(dane.swiece[0].time, t0 / 1000);
});

test('powtórzona godzina lokalna po zmianie czasu zachowuje obie świece', () => {
  const pierwsza = Date.UTC(2026, 9, 25, 0, 30);
  const druga = Date.UTC(2026, 9, 25, 1, 30);
  const dane = przygotujDaneWykresu([
    { ...swieca(0), timestamp: pierwsza },
    { ...swieca(0), timestamp: druga, close: 12 },
  ]);
  assert.deepEqual(dane.swiece.map((s) => s.time), [pierwsza / 1000, druga / 1000]);
  assert.equal(dane.szczegoly.size, 2);
});

test('świece spoza sesji regularnej mają własny kolor, regularne - domyślny', () => {
  const dane = przygotujDaneWykresu([swieca(0, { session: 'REGULAR' }), swieca(15, { session: 'PRE' }), swieca(30, { session: 'OVERNIGHT', close: 9.5 })]);
  assert.equal(dane.swiece[0].color, undefined);
  assert.equal(dane.swiece[1].color, '#FBBF24');
  assert.equal(dane.swiece[2].color, '#0369A1');
});

test('brak wolumenu to 0 na histogramie, nie brak świecy', () => {
  const dane = przygotujDaneWykresu([swieca(0, { volume: undefined })]);
  assert.equal(dane.wolumen[0].value, 0);
  assert.equal(dane.swiece.length, 1);
});

test('wykres pobiera najdłuższą historię, jaką dostawca daje dla interwału', () => {
  assert.equal(najdluzszyZakres('1m'), '7d');
  assert.equal(najdluzszyZakres('15m'), '60d');
  assert.equal(najdluzszyZakres('1h'), '730d');
  assert.equal(najdluzszyZakres('1d'), '10y');
  assert.equal(sekundyZakresu('5d'), 7 * 86_400);
});

test('data-zaślepka z 1970 r. nie jest pokazywana jako debiut', () => {
  assert.equal(wiarygodnaDataDebiutu('01.05.1970'), undefined);
  assert.equal(wiarygodnaDataDebiutu('24.05.2011'), '24.05.2011');
  assert.equal(wiarygodnaDataDebiutu(undefined), undefined);
});
