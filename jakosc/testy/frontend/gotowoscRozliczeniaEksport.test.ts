import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ADNOTACJA_NIEGOTOWEGO_ROZLICZENIA,
  adnotacjaNiegotowego,
  dodajAdnotacjeDoPdf,
  powodBlokadyXml,
  rozliczenieGotowe,
} from '../../../aplikacje/web/src/portfel/services/gotowoscRozliczenia.ts';
import { zbudujCsvZyskow } from '../../../aplikacje/web/src/portfel/services/csvExporter.ts';
import type { TaxYearSummary } from '../../../aplikacje/web/src/portfel/types.ts';

test('tylko true z silnika znaczy gotowe; false, null i undefined blokuja XML', () => {
  assert.equal(rozliczenieGotowe(true), true);
  for (const wartosc of [false, null, undefined]) {
    assert.equal(rozliczenieGotowe(wartosc), false);
    assert.ok(powodBlokadyXml(false, wartosc, undefined));
    assert.equal(adnotacjaNiegotowego(wartosc), ADNOTACJA_NIEGOTOWEGO_ROZLICZENIA);
  }
  assert.equal(powodBlokadyXml(false, true, undefined), undefined);
  assert.equal(adnotacjaNiegotowego(true), undefined);
  assert.equal(powodBlokadyXml(true, true, 'Wynik NIEAKTUALNY'), 'Wynik NIEAKTUALNY');
  assert.match(powodBlokadyXml(false, false, undefined) ?? '', /blokady/);
});

test('CSV niegotowego rozliczenia ma adnotacje na poczatku, gotowego nie ma', () => {
  const podsumowanie = { year: 2026, revenuePLN: 0, costsPLN: 0, incomePLN: 0, lossPLN: 0, taxDuePLN: 0 } as TaxYearSummary;
  const niegotowe = zbudujCsvZyskow([], podsumowanie, [], { adnotacja: ADNOTACJA_NIEGOTOWEGO_ROZLICZENIA });
  assert.ok(niegotowe.replace(/^\uFEFF/, '').startsWith(ADNOTACJA_NIEGOTOWEGO_ROZLICZENIA));
  assert.ok(!zbudujCsvZyskow([], podsumowanie, []).includes('NIEGOTOWE'));
});

test('PDF: adnotacja rysowana tylko gdy jest', () => {
  const wywolania: string[] = [];
  const doc = {
    setTextColor: () => undefined, setFont: () => undefined, setFontSize: () => undefined,
    text: (tresc: string) => { wywolania.push(tresc); },
  };
  dodajAdnotacjeDoPdf(doc, undefined);
  assert.deepEqual(wywolania, []);
  dodajAdnotacjeDoPdf(doc, ADNOTACJA_NIEGOTOWEGO_ROZLICZENIA);
  assert.deepEqual(wywolania, [ADNOTACJA_NIEGOTOWEGO_ROZLICZENIA]);
});
