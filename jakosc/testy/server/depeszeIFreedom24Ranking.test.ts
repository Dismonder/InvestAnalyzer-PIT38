import test from 'node:test';
import assert from 'node:assert/strict';

import { depeszeZOdpowiedzi, rankingZCenami, tickeryDoDepesz } from '../../../aplikacje/web/src/server/routes/brokers.ts';
import { FREEDOM24_READ_ONLY_COMMANDS } from '../../../aplikacje/web/src/server/freedom24/freedom24Api.ts';

test('depesze i ranking to polecenia tylko do odczytu; polecenia zleceń nadal nie są dozwolone', () => {
  assert.equal(FREEDOM24_READ_ONLY_COMMANDS.has('getNewsList'), true);
  assert.equal(FREEDOM24_READ_ONLY_COMMANDS.has('getTopSecurities'), true);
  for (const zapis of ['putTradeOrder', 'putStopLoss', 'delTradeOrder']) assert.equal(FREEDOM24_READ_ONLY_COMMANDS.has(zapis), false);
});

test('o depesze pytamy tylko o poprawne tickery z portfela, bez powtórzeń i najwyżej o 8', () => {
  assert.deepEqual(tickeryDoDepesz(['nbis.us', 'NBIS.US', 'DGT4016.JUN26', '../etc', 42, '']), ['NBIS.US', 'DGT4016.JUN26']);
  assert.equal(tickeryDoDepesz(Array.from({ length: 20 }, (_, i) => `T${i}.US`)).length, 8);
  assert.deepEqual(tickeryDoDepesz('NBIS.US'), []);
});

test('depesza bez tytułu odpada, a brakujących pól nie dopisujemy', () => {
  const depesze = depeszeZOdpowiedzi({
    list: [
      { id: 1, title: ' Nebius raises guidance ', provider: 'Oninvest', date: '2026-09-19 02:35:30', tickers: ['NBIS.US'], url: 'https://example.com/a', sentiment: 'positive' },
      { id: 2, title: '', provider: 'X' },
      { id: 3, title: 'Bez linku', url: 'javascript:alert(1)' },
    ],
  });
  assert.equal(depesze.length, 2);
  assert.deepEqual(depesze[0], { id: 1, title: 'Nebius raises guidance', source: 'Oninvest', date: '2026-09-19 02:35:30', tickers: ['NBIS.US'], summary: '', url: 'https://example.com/a', sentiment: 'positive' });
  assert.equal(depesze[1].url, undefined);
  assert.deepEqual(depeszeZOdpowiedzi({ nic: true }), []);
});

test('spółka z rankingu bez notowania nie dostaje ceny 0 - odpada', async () => {
  const ranking = await rankingZCenami(
    { tickers: ['AAA.US', 'BBB.US'], details: { 'AAA.US': { name: 'Alfa' } } },
    true,
    async (ticker) => (ticker === 'AAA.US' ? { price: 10.5, changePercent24h: 3.2, currency: 'USD', volume24h: 100 } : null),
  );
  assert.deepEqual(ranking, [{ ticker: 'AAA.US', name: 'Alfa', price: 10.5, changePercent: 3.2, volume: 100, currency: 'USD', type: 'GAINER' }]);
});
