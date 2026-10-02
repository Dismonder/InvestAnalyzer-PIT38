import test from 'node:test';
import assert from 'node:assert/strict';

import { pozycjaTickeraDoInformacji, wybierzPozycjeRachunku } from '../../../aplikacje/web/src/portfel/services/pozycjaRachunku.ts';
import type { OpenPosition } from '../../../aplikacje/web/src/portfel/types.ts';

function pozycja(ticker: string, konto: string, ilosc: number): OpenPosition {
  return {
    ticker, name: ticker, category: 'STOCK_FOREIGN', currency: 'USD', totalQuantity: ilosc, avgBuyPrice: 1,
    avgBuyPricePLN: 4, totalCostPLN: 4 * ilosc, openLotsCount: 1, lots: [{ accountId: konto } as OpenPosition['lots'][number]],
    accountIds: [konto],
  };
}

const pozycje = [pozycja('ABC', 'k1', 10), pozycja('ABC', 'k2', 3), pozycja('XYZ', 'k1', 7)];

test('pozycja jest wybierana po tickerze i rachunku', () => {
  assert.equal(wybierzPozycjeRachunku(pozycje, 'ABC', 'k2')?.totalQuantity, 3);
  assert.equal(wybierzPozycjeRachunku(pozycje, 'abc', 'k1')?.totalQuantity, 10);
});

test('brak pozycji na wybranym rachunku to brak pozycji, a nie pozycja innego rachunku', () => {
  assert.equal(wybierzPozycjeRachunku(pozycje, 'ABC', 'k9'), undefined);
  assert.equal(wybierzPozycjeRachunku(pozycje, 'XYZ', 'k2'), undefined);
});

test('bez wybranego rachunku ograniczenia nie ma - pierwsza pozycja tickera', () => {
  assert.equal(wybierzPozycjeRachunku(pozycje, 'ABC', '')?.totalQuantity, 10);
});

test('do samej informacji o walorze zostaje pierwsza pozycja tickera', () => {
  assert.equal(pozycjaTickeraDoInformacji(pozycje, 'XYZ', 'k2')?.currency, 'USD');
  assert.equal(pozycjaTickeraDoInformacji(pozycje, 'ABC', 'k2')?.totalQuantity, 3);
  assert.equal(pozycjaTickeraDoInformacji(pozycje, 'QQQ', 'k1'), undefined);
});

test('brak pozycji o tickerze daje undefined; rachunek rozpoznawany tez po accountIds bez partii', () => {
  assert.equal(wybierzPozycjeRachunku(pozycje, 'QQQ', 'k1'), undefined);
  const bezPartii = { ...pozycja('ABC', 'k5', 2), lots: [] };
  assert.equal(wybierzPozycjeRachunku([pozycja('ABC', 'k1', 10), bezPartii], 'ABC', 'k5')?.totalQuantity, 2);
});
