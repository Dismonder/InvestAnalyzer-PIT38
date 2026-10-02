import test from 'node:test';
import assert from 'node:assert/strict';
import {
  odczytajZakladke, odczytajRok, odczytajTickerWykresu,
} from '../../../aplikacje/web/src/portfel/services/preferencesBridge.ts';

const magazyn = (dane: Record<string, string> = {}) => ({
  getItem: (klucz: string) => dane[klucz] ?? null,
});

test('przywraca kazda obslugiwana zakladke, a stara lub uszkodzona wraca do portfela', () => {
  for (const zakladka of ['portfolio', 'tax', 'transactions', 'brokers', 'charts', 'alerts', 'engine', 'security']) {
    assert.equal(odczytajZakladke(magazyn({ pit38_active_tab: zakladka })), zakladka);
  }
  for (const zapis of ['', 'dashboard', 'undefined', 'null', '"portfolio"']) {
    assert.equal(odczytajZakladke(magazyn({ pit38_active_tab: zapis })), 'portfolio');
  }
});

test('nie przekazuje NaN, zera ani niepelnego roku do przeliczenia podatku', () => {
  assert.equal(odczytajRok(magazyn({ pit38_selected_year: '2025' }), 2026), 2025);
  for (const zapis of ['', 'NaN', 'null', '0', '0000', '-2025', '2025.5', '25', '2025abc', 'Infinity']) {
    assert.equal(odczytajRok(magazyn({ pit38_selected_year: zapis }), 2026), 2026);
  }
});

test('niedostepny magazyn ustawien nie przerywa startu aplikacji', () => {
  const niedostepny = { getItem: () => { throw new Error('SecurityError'); } };
  assert.equal(odczytajZakladke(niedostepny), 'portfolio');
  assert.equal(odczytajRok(niedostepny, 2026), 2026);
  assert.equal(odczytajTickerWykresu(niedostepny), '');
  assert.equal(odczytajTickerWykresu(magazyn({ pit38_selected_chart_ticker: 'BRK-B' })), 'BRK-B');
});
