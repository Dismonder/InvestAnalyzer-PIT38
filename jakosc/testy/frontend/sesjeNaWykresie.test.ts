import test from 'node:test';
import assert from 'node:assert/strict';

import { graniceSesjiRegularnej, sesjaSwiecy, czyInterwalSrodsesyjny } from '../../../aplikacje/web/src/server/routes/quotes.ts';
import { wyznaczStrefySesji } from '../../../aplikacje/web/src/portfel/services/strefySesji.ts';

// 2026-09-21, Nowy Jork (UTC-4): sesja regularna 09:30-16:00.
const PRZESUNIECIE = -4 * 3600;
const polnocUtc = Date.UTC(2026, 8, 21) / 1000;
const czasNY = (godzina: number, minuta = 0) => polnocUtc + godzina * 3600 + minuta * 60 - PRZESUNIECIE;
const meta = { gmtoffset: PRZESUNIECIE, currentTradingPeriod: { regular: { start: czasNY(9, 30), end: czasNY(16), gmtoffset: PRZESUNIECIE } } };

test('świeca dostaje sesję z pory dnia giełdy, także w inne dni zakresu', () => {
  const granice = graniceSesjiRegularnej(meta);
  assert.ok(granice);
  assert.equal(sesjaSwiecy(czasNY(4), granice), 'PRE');
  assert.equal(sesjaSwiecy(czasNY(9, 30), granice), 'REGULAR');
  assert.equal(sesjaSwiecy(czasNY(15, 59), granice), 'REGULAR');
  assert.equal(sesjaSwiecy(czasNY(16), granice), 'POST');
  assert.equal(sesjaSwiecy(czasNY(8) - 3 * 86_400, granice), 'PRE');
});

test('bez granic od dostawcy sesja nie jest zgadywana', () => {
  assert.equal(graniceSesjiRegularnej({}), null);
  assert.equal(sesjaSwiecy(czasNY(4), null), null);
});

test('handel poza sesją jest pobierany tylko dla interwałów śródsesyjnych', () => {
  assert.equal(czyInterwalSrodsesyjny('5m'), true);
  assert.equal(czyInterwalSrodsesyjny('1d'), false);
});

test('strefy do cieniowania to ciągłe odcinki pre-market i after-hours', () => {
  const strefy = wyznaczStrefySesji([
    { date: '10:00', session: 'PRE' }, { date: '10:05', session: 'PRE' },
    { date: '15:30', session: 'REGULAR' }, { date: '21:55', session: 'REGULAR' },
    { date: '22:00', session: 'POST' }, { date: '22:05', session: 'POST' },
    { date: '2.10 10:00', session: 'PRE' },
  ]);
  assert.deepEqual(strefy, [
    { sesja: 'PRE', od: '10:00', do: '10:05' },
    { sesja: 'POST', od: '22:00', do: '22:05' },
    { sesja: 'PRE', od: '2.10 10:00', do: '2.10 10:00' },
  ]);
});
