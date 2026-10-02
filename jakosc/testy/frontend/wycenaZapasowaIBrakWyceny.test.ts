/**
 * Wycena pozycji z rachunku: symbol brokera u dostawcy notowań, cena zapasowa
 * z Freedom24 i „nie wiem” zamiast zera, gdy wyceny nie ma.
 *
 * Tło: NBIS.US miało „brak notowania”, więc „Wartość Całkowita Portfela” była
 * „—”, pod nią „≈ $0 USD • ≈ €0 EUR”, a przy pozycjach „0% portfela”.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  opiszBrakiWyceny,
  podsumujWycene,
  sumaWWalucie,
  udzialWPortfelu,
  wycenPozycje,
} from '../../../aplikacje/web/src/portfel/services/wycenaPozycji.ts';
import { kandydaciSymboluDostawcy } from '../../../aplikacje/web/src/server/routes/quotes.ts';
import type { LiveMarketQuote, OpenPosition } from '../../../aplikacje/web/src/portfel/types.ts';

function pozycja(zmiany: Partial<OpenPosition>): OpenPosition {
  return {
    ticker: 'NBIS.US', name: 'NBIS.US', category: 'STOCK_FOREIGN', currency: 'USD',
    totalQuantity: 10, avgBuyPrice: 100, avgBuyPricePLN: 400, totalCostPLN: 4000,
    openLotsCount: 1, lots: [], accountIds: [], ...zmiany,
  } as OpenPosition;
}
const nota = pozycja({ ticker: 'DGT4016.JUN26', totalQuantity: 1, totalCostPLN: 3600 });

test('sufiks rynku brokera trafia do dostawcy notowań jako właściwy symbol', () => {
  assert.deepEqual(kandydaciSymboluDostawcy('NBIS.US'), ['NBIS']);
  assert.deepEqual(kandydaciSymboluDostawcy('nvda.us'), ['NVDA']);
  // Ten sam walor na dwóch rynkach to dwa różne notowania.
  assert.deepEqual(kandydaciSymboluDostawcy('VOD.US'), ['VOD']);
  assert.deepEqual(kandydaciSymboluDostawcy('VOD.L'), ['VOD.L']);
  assert.deepEqual(kandydaciSymboluDostawcy('VOD.UK'), ['VOD.L']);
  // GPW: znany ticker przez słownik, zapis brokera przez sufiks.
  assert.deepEqual(kandydaciSymboluDostawcy('CDR'), ['CDR.WA']);
  assert.deepEqual(kandydaciSymboluDostawcy('CDR.PL'), ['CDR.WA']);
  assert.deepEqual(kandydaciSymboluDostawcy('XYZ.WA'), ['XYZ.WA']);
  // Nieznany sufiks (nota strukturyzowana): bez zgadywania innych giełd.
  assert.deepEqual(kandydaciSymboluDostawcy('DGT4016.JUN26'), ['DGT4016.JUN26']);
  // Ticker bez rynku zachowuje dotychczasowe próby.
  assert.deepEqual(kandydaciSymboluDostawcy('ABC'), ['ABC', 'ABC.WA', 'ABC.DE', 'ABC.L']);
  assert.deepEqual(kandydaciSymboluDostawcy('  '), []);
});

test('cena z rachunku Freedom24 jest źródłem zapasowym, oznaczonym i z walutą', () => {
  const ceny = [{ ticker: 'NBIS', price: 222, currency: 'usd' }];
  const [zBrokera] = wycenPozycje([pozycja({})], {}, { USD: 4 }, ceny);
  assert.equal(zBrokera.zrodloCeny, 'BROKER');
  assert.equal(zBrokera.walutaCeny, 'USD');
  assert.equal(zBrokera.maWycene, true);
  assert.equal(zBrokera.currentValuePLN, 8880);
  // Broker nie podaje zmiany dziennej - nie powstaje z niej zysk dnia.
  assert.equal(zBrokera.dailyPnLPLN, null);

  // Notowanie dostawcy ma pierwszeństwo przed ceną brokera.
  const notowanie = { ticker: 'NBIS.US', price: 220, currency: 'USD', changePercent24h: 1 } as unknown as LiveMarketQuote;
  const [zDostawcy] = wycenPozycje([pozycja({})], { 'NBIS.US': notowanie }, { USD: 4 }, ceny);
  assert.equal(zDostawcy.zrodloCeny, 'NOTOWANIE');
  assert.equal(zDostawcy.currentValuePLN, 8800);

  // Cena bez waluty, zerowa albo pusta nie jest ceną.
  for (const zla of [{ ticker: 'NBIS', price: 222, currency: '' }, { ticker: 'NBIS', price: 0, currency: 'USD' }, { ticker: 'NBIS', price: null, currency: 'USD' }]) {
    const [bez] = wycenPozycje([pozycja({})], {}, { USD: 4 }, [zla]);
    assert.equal(bez.zrodloCeny, null);
    assert.equal(bez.walutaCeny, null);
    assert.equal(bez.maWycene, false);
  }
});

test('suma portfela pokazuje wycenioną część i mówi, ilu pozycji nie obejmuje', () => {
  const wycena = wycenPozycje([pozycja({}), nota], {}, { USD: 4 }, [{ ticker: 'NBIS', price: 222, currency: 'USD' }]);
  const suma = podsumujWycene(wycena);
  assert.equal(suma.wartoscPLN, 8880);
  assert.equal(suma.liczbaBezWyceny, 1);
  assert.match(opiszBrakiWyceny(suma) || '', /Kwota obejmuje 1 z 2 pozycji\. Nie wyceniono 1 pozycji/);
  // Nota bez żadnego źródła ceny zostaje uczciwie bez wyceny.
  assert.equal(wycena[1].maWycene, false);
});

test('brak wyceny to „—”, nie „$0”, „€0” ani „0% portfela”', () => {
  assert.equal(sumaWWalucie(null, 3.8), null);
  assert.equal(sumaWWalucie(undefined, 3.8), null);
  assert.equal(sumaWWalucie(8880, null), null);
  assert.equal(sumaWWalucie(8880, 4), 2220);

  assert.equal(udzialWPortfelu(false, 0, 8880), null);
  assert.equal(udzialWPortfelu(true, 8880, null), null);
  assert.equal(udzialWPortfelu(true, 8880, 0), null);
  assert.equal(udzialWPortfelu(true, 4440, 8880), '50,0');

  // Żadna pozycja nie ma ceny: suma jest nieznana, a nie zerowa.
  const suma = podsumujWycene(wycenPozycje([nota], {}, { USD: 4 }));
  assert.equal(suma.wartoscPLN, null);
  assert.equal(sumaWWalucie(suma.wartoscPLN, 4), null);
});

test('cena brokera jednego rynku nie wycenia drugiego: najpierw pelny ticker, baza tylko gdy jednoznaczna', () => {
  const ceny = [
    { ticker: 'VOD.L', price: 70, currency: 'GBP' },
    { ticker: 'VOD.US', price: 9, currency: 'USD' },
  ];
  const wyceny = wycenPozycje(
    [pozycja({ ticker: 'VOD.US', currency: 'USD' }), pozycja({ ticker: 'vod.l', currency: 'GBP' }), pozycja({ ticker: 'VOD', currency: 'USD' })],
    {}, { USD: 4, GBP: 5 }, ceny,
  );
  assert.equal(wyceny[0].currentPriceOrig, 9);
  assert.equal(wyceny[0].walutaCeny, 'USD');
  assert.equal(wyceny[1].currentPriceOrig, 70);
  assert.equal(wyceny[1].walutaCeny, 'GBP');
  // Baza "VOD" pasuje do dwoch wpisow brokera - nie wiadomo, ktory rynek, wiec brak ceny.
  assert.equal(wyceny[2].zrodloCeny, null);
  assert.equal(wyceny[2].maWycene, false);

  // Jednoznaczna baza nadal dziala.
  const [jedyna] = wycenPozycje([pozycja({ ticker: 'NBIS.US' })], {}, { USD: 4 }, [{ ticker: 'NBIS', price: 222, currency: 'USD' }]);
  assert.equal(jedyna.currentPriceOrig, 222);
});

test('baza tickera laczy ceny brokera tylko gdy jedna ze stron nie ma sufiksu rynku', () => {
  const [inny] = wycenPozycje([pozycja({ ticker: 'VOD.L', currency: 'GBP' })], {}, { USD: 4, GBP: 5 }, [{ ticker: 'VOD.US', price: 9, currency: 'USD' }]);
  assert.equal(inny.zrodloCeny, null);
  const [bezSufiksu] = wycenPozycje([pozycja({ ticker: 'VOD', currency: 'USD' })], {}, { USD: 4 }, [{ ticker: 'VOD.US', price: 9, currency: 'USD' }]);
  assert.equal(bezSufiksu.currentPriceOrig, 9);
  const [zSufiksem] = wycenPozycje([pozycja({ ticker: 'VOD.US', currency: 'USD' })], {}, { USD: 4 }, [{ ticker: 'VOD', price: 9, currency: 'USD' }]);
  assert.equal(zSufiksem.currentPriceOrig, 9);
});
