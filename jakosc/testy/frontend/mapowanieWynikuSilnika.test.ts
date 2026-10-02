/**
 * Mapowanie wyniku silnika na ekrany PIT-38 i portfela.
 *
 * Wynik w pliku obok pochodzi z prawdziwego przebiegu silnika: trzy zakupy
 * AAPL (30 @ 140, 40 @ 150, 50 @ 160), sprzedaz 90 sztuk po 200 USD i jeden
 * zakup MSFT bez sprzedazy. Dzieki temu test pilnuje calego mapowania bez
 * uruchamiania Pythona.
 *
 * Najwazniejsze pulapki, ktore ten test trzyma:
 * - sprzedaz pokryta kilkoma zakupami ma byc JEDNYM wierszem z lista partii,
 *   a nie trzema osobnymi sprzedazami,
 * - przy partii zuzytej czesciowo (20 z 50 sztuk) prowizja wchodzi w takiej
 *   samej proporcji,
 * - kursy sa odtwarzane z kwot silnika, bo sam ich nie zwraca,
 * - pozycje otwarte licza sie z tego, czego FIFO silnika NIE zamknelo.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  mapRealizedGains,
  mapOpenPositions,
  mapYearSummaries,
} from '../../../aplikacje/web/src/portfel/services/engineBridge.ts';
import type { Transaction } from '../../../aplikacje/web/src/portfel/types.ts';

const wynikSilnika = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, '..', 'dane', 'wynikSilnika-wielePartii.json'), 'utf-8'),
);

function transakcja(zmiany: Partial<Transaction>): Transaction {
  return {
    id: 'x',
    accountId: 'a',
    ticker: 'AAPL.US',
    name: 'Apple',
    category: 'STOCK_FOREIGN',
    type: 'BUY',
    date: '2024-01-10T15:30:00',
    quantity: 30,
    pricePerUnit: 140,
    currency: 'USD',
    commission: 3,
    ...zmiany,
  } as Transaction;
}

const TRANSAKCJE: Transaction[] = [
  transakcja({ id: 'b1' }),
  transakcja({ id: 'b2', date: '2024-02-05T15:30:00', quantity: 40, pricePerUnit: 150, commission: 4 }),
  transakcja({ id: 'b3', date: '2024-03-12T15:30:00', quantity: 50, pricePerUnit: 160, commission: 5 }),
  transakcja({ id: 's1', type: 'SELL', date: '2024-09-10T15:30:00', quantity: 90, pricePerUnit: 200, commission: 9 }),
  transakcja({
    id: 'b4',
    ticker: 'MSFT.US',
    name: 'Microsoft',
    date: '2024-04-02T15:30:00',
    quantity: 20,
    pricePerUnit: 300,
    commission: 6,
  }),
];

test('sprzedaz pokryta trzema zakupami to jeden wiersz z trzema partiami', () => {
  const zyski = mapRealizedGains(wynikSilnika, TRANSAKCJE);

  assert.equal(zyski.length, 1, 'jedna sprzedaz, nie trzy');
  assert.equal(zyski[0].sellQuantity, 90);
  assert.equal(zyski[0].matchedBuyLots.length, 3);
  assert.deepEqual(
    zyski[0].matchedBuyLots.map((partia) => partia.buyQuantity),
    [30, 40, 20],
    'ostatnia partia zuzyta czesciowo',
  );
});

test('cena sprzedazy jest w walucie, a nie w zlotowkach', () => {
  // Wczesniej pole dostawalo przychod w PLN podzielony przez ilosc i bylo
  // podpisane waluta transakcji - na ekranie wychodzilo "774,77 USD".
  const [zysk] = mapRealizedGains(wynikSilnika, TRANSAKCJE);
  assert.equal(zysk.sellPricePerUnit, 200);
  assert.equal(zysk.sellCurrency, 'USD');
});

test('kursy odtworzone z kwot silnika zgadzaja sie z tabela NBP', () => {
  const [zysk] = mapRealizedGains(wynikSilnika, TRANSAKCJE);

  assert.ok(Math.abs(zysk.sellExchangeRate - 3.8758) < 0.0005, `kurs sprzedazy: ${zysk.sellExchangeRate}`);
  const kursyZakupu = zysk.matchedBuyLots.map((partia) => Number(partia.buyExchangeRate.toFixed(4)));
  assert.deepEqual(kursyZakupu, [3.9612, 3.9641, 3.9262]);
});

test('prowizja partii zuzytej czesciowo wchodzi w tej samej proporcji', () => {
  const [zysk] = mapRealizedGains(wynikSilnika, TRANSAKCJE);
  const ostatnia = zysk.matchedBuyLots[2];

  // 20 z 50 sztuk, wiec 40% prowizji 5 USD.
  assert.ok(Math.abs(ostatnia.buyCommissionShare - 2) < 0.001, `udzial prowizji: ${ostatnia.buyCommissionShare}`);
  assert.ok(Math.abs(ostatnia.totalCostPLN - 12571.69) < 0.01);
});

test('suma partii i prowizji sprzedazy zgadza sie z kosztem PIT', () => {
  const [zysk] = mapRealizedGains(wynikSilnika, TRANSAKCJE);
  const sumaPartii = zysk.matchedBuyLots.reduce((suma, partia) => suma + partia.totalCostPLN, 0);
  assert.ok(Math.abs(sumaPartii + zysk.sellCommissionPLN - zysk.costPLN) < 0.01);
});

test('pozycje otwarte to reszta, ktorej FIFO nie zamknelo', () => {
  const pozycje = mapOpenPositions(wynikSilnika, TRANSAKCJE);
  const poTickerze = new Map(pozycje.map((pozycja) => [pozycja.ticker, pozycja]));

  assert.equal(poTickerze.get('AAPL.US')?.totalQuantity, 30, 'z partii 50 zostalo 30');
  assert.equal(poTickerze.get('MSFT.US')?.totalQuantity, 20, 'MSFT nie byl sprzedawany');
  assert.equal(poTickerze.get('AAPL.US')?.currency, 'USD');
});

test('koszt pozycji otwartej jest proporcjonalny do reszty partii', () => {
  const pozycje = mapOpenPositions(wynikSilnika, TRANSAKCJE);
  const aapl = pozycje.find((pozycja) => pozycja.ticker === 'AAPL.US');

  // Partia 50 sztuk kosztowala 31 429,23 zl; zostalo 30 sztuk.
  assert.ok(Math.abs((aapl?.totalCostPLN ?? 0) - 18857.54) < 0.01, `koszt: ${aapl?.totalCostPLN}`);
  assert.ok(Math.abs((aapl?.avgBuyPrice ?? 0) - 160) < 0.01);
});

test('sprzedany walor nie zostaje w pozycjach otwartych dwa razy', () => {
  const pozycje = mapOpenPositions(wynikSilnika, TRANSAKCJE);
  const tickery = pozycje.map((pozycja) => pozycja.ticker);
  assert.equal(new Set(tickery).size, tickery.length, 'kazdy walor raz');
});

// ---------------------------------------------------------------------------
// Wiele lat podatkowych
// ---------------------------------------------------------------------------

const wynikWieleLat = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, '..', 'dane', 'wynikSilnika-wieleLat.json'), 'utf-8'),
);

test('przelacznik roku dostaje wszystkie lata wykryte przez silnik', () => {
  // Silnik liczy jeden rok na przebieg. Lista lat brala sie wczesniej z samych
  // policzonych podsumowan, wiec pokazywala tylko rok wlasnie policzony
  // i nie dalo sie przejsc do rozliczenia za rok wczesniejszy.
  const zyski = mapRealizedGains(wynikWieleLat, []);
  const podsumowania = mapYearSummaries(wynikWieleLat, 2024, zyski, [], []);

  const lata = [...podsumowania.keys()].sort();
  assert.deepEqual(lata, [2022, 2023, 2024], `dostepne lata: ${lata.join(', ')}`);
});

test('podsumowanie roku rozliczanego bierze kwoty z pol deklaracji', () => {
  const zyski = mapRealizedGains(wynikWieleLat, []);
  const podsumowania = mapYearSummaries(wynikWieleLat, 2024, zyski, [], []);
  const rok2024 = podsumowania.get(2024);

  assert.ok(rok2024, 'brak podsumowania roku rozliczanego');
  assert.equal(rok2024?.revenuePLN, Number(wynikWieleLat.art30b.total_revenue_pln));
  assert.equal(rok2024?.costsPLN, Number(wynikWieleLat.art30b.total_cost_pln));
});

test('podatek od dywidend bierze się z silnika, z limitem stawki umownej', () => {
  // Silnik stosuje art. 30a ust. 9: odliczyć można najwyżej tyle, ile wynika
  // ze stawki umownej. Interfejs odejmował wcześniej CAŁY podatek pobrany za
  // granicą, więc przy 30% potrąconych w USA (brak formularza W-8BEN) pokazywał
  // kwotę niższą od należnej.
  const wynik = {
    art30b: { pit38_rounded_revenue_pln: '0', pit38_rounded_cost_pln: '0', tax_19_pln: '0' },
    art30a: {
      tax_year: '2026',
      gross_dividends_pln: '10000.00',
      foreign_withholding_tax_pln: '3000.00',
      foreign_withholding_creditable_pln: '1500.00',
      foreign_tax_not_creditable_pln: '1500.00',
      polish_tax_19_pln: '1900.00',
      credit_used_pln: '1500.00',
      tax_to_pay_pln: '400.00',
    },
    tax_year: '2026',
  } as unknown as Parameters<typeof mapYearSummaries>[0];

  const podsumowania = mapYearSummaries(wynik, 2026, [], [], []);
  const rok = podsumowania.get(2026);

  assert.equal(rok?.dividendGrossPLN, 10000);
  assert.equal(rok?.dividendForeignTaxPLN, 3000);
  assert.equal(rok?.dividendPolishTaxDuePLN, 1900);
  // Kluczowe: 400 zł do dopłaty (1900 − 1500 odliczalne), a nie 0 zł, które
  // wyszłoby po odjęciu pełnych 3000 zł potrąconych za granicą.
  assert.equal(rok?.dividendTaxToPayPLN, 400);
  assert.notEqual(rok?.dividendTaxToPayPLN, 0);
});

test('most przepisuje podział PIT-8C zwrócony przez silnik', () => {
  const wynik = {
    art30b: {
      pit38_rounded_revenue_pln: '100000',
      pit38_rounded_cost_pln: '60000',
      tax_19_pln: '7600',
      prior_year_loss_used_pln: '5000.00',
      pit8c_revenue_pln: '30000.00',
      pit8c_cost_pln: '20000.00',
      pit8c_calculated_revenue_pln: '30000.00',
      pit8c_calculated_cost_pln: '20000.00',
      pit8c_source: 'transakcje',
    },
    tax_filing_package: { draft: { form_fields: [
      { position: '20', value: '30000.00' }, { position: '21', value: '20000.00' },
      { position: '22', value: '70000.00' }, { position: '23', value: '40000.00' },
      { position: '26', value: '100000.00' }, { position: '27', value: '60000.00' },
      { position: '30', value: '5000.00' },
    ] } },
    tax_year: '2026',
  } as unknown as Parameters<typeof mapYearSummaries>[0];

  const zyski = [
    { taxYear: 2026, accountId: 'xtb', ticker: 'CDR.PL', revenuePLN: 30000, costPLN: 20000 },
    { taxYear: 2026, accountId: 'ibkr', ticker: 'AAPL.US', revenuePLN: 70000, costPLN: 40000 },
  ] as unknown as Parameters<typeof mapYearSummaries>[2];

  const konta = [
    { id: 'xtb', name: 'XTB', brokerType: 'XTB' },
    { id: 'ibkr', name: 'IBKR', brokerType: 'IBKR' },
  ] as unknown as Parameters<typeof mapYearSummaries>[4];

  const rok = mapYearSummaries(wynik, 2026, zyski, [], konta).get(2026);

  assert.equal(rok?.pit8cRevenuePLN, 30000);
  assert.equal(rok?.pit8cCostsPLN, 20000);
  assert.equal(rok?.foreignRevenuePLN, 70000);
  assert.equal(rok?.foreignCostsPLN, 40000);
  // Suma czesci musi sie zgadzac z kwota z silnika, inaczej deklaracja
  // zglosi wyzszy przychod niz policzony.
  assert.equal((rok?.pit8cRevenuePLN ?? 0) + (rok?.foreignRevenuePLN ?? 0), rok?.revenuePLN);
  assert.equal(rok?.priorYearLossUsedPLN, 5000);
});

test('bez rachunków polskich cała kwota idzie do pozycji 22 i 23', () => {
  const wynik = {
    art30b: { pit38_rounded_revenue_pln: '100000', pit38_rounded_cost_pln: '60000', tax_19_pln: '7600' },
    tax_year: '2026',
  } as unknown as Parameters<typeof mapYearSummaries>[0];

  const konta = [{ id: 'ibkr', name: 'IBKR', brokerType: 'IBKR' }] as unknown as Parameters<
    typeof mapYearSummaries
  >[4];

  const rok = mapYearSummaries(wynik, 2026, [], [], konta).get(2026);

  assert.equal(rok?.pit8cRevenuePLN, 0);
  assert.equal(rok?.foreignRevenuePLN, 100000);
});

test('bez pól silnika most nie zgaduje podziału po tickerze', () => {
  const wynik = {
    art30b: { pit38_rounded_revenue_pln: '100000', pit38_rounded_cost_pln: '60000', tax_19_pln: '7600' },
    tax_year: '2026',
  } as unknown as Parameters<typeof mapYearSummaries>[0];

  const zyski = [
    { taxYear: 2026, accountId: 'xtb', ticker: 'AAPL.US', revenuePLN: 100000, costPLN: 60000 },
  ] as unknown as Parameters<typeof mapYearSummaries>[2];

  const konta = [
    { id: 'xtb', name: 'XTB', brokerType: 'XTB' },
    { id: 'ibkr', name: 'IBKR', brokerType: 'IBKR' },
  ] as unknown as Parameters<typeof mapYearSummaries>[4];

  const rok = mapYearSummaries(wynik, 2026, zyski, [], konta, {
    tickeryNiejednoznaczne: new Set(['AAPL.US']),
  }).get(2026);

  assert.equal(rok?.pit8cRevenuePLN, undefined);
  assert.equal(rok?.foreignRevenuePLN, undefined);
});

test('wpisana informacja PIT-8C zastępuje kwoty policzone z transakcji', () => {
  const wynik = {
    art30b: {
      pit38_rounded_revenue_pln: '100010', pit38_rounded_cost_pln: '59990', tax_19_pln: '7603.80',
      pit8c_revenue_pln: '30000.00', pit8c_cost_pln: '20000.00',
      pit8c_calculated_revenue_pln: '29990.00', pit8c_calculated_cost_pln: '20010.00',
      pit8c_revenue_difference_pln: '10.00', pit8c_cost_difference_pln: '-10.00',
      pit8c_source: 'informacja',
    },
    tax_filing_package: { draft: { form_fields: [
      { position: '20', value: '30000.00' }, { position: '21', value: '20000.00' },
      { position: '22', value: '70010.00' }, { position: '23', value: '39990.00' },
      { position: '26', value: '100010.00' }, { position: '27', value: '59990.00' },
      { position: '28', value: '40020.00' }, { position: '29', value: '0' },
      { position: '30', value: '0' }, { position: '31', value: '40020' },
      { position: '33', value: '7603.80' }, { position: '34', value: '0' },
      { position: '35', value: '7604' }, { position: '51', value: '7604' },
    ] } },
    tax_year: '2026',
  } as unknown as Parameters<typeof mapYearSummaries>[0];

  const zyski = [
    { taxYear: 2026, accountId: 'xtb', ticker: 'CDR.PL', revenuePLN: 29990, costPLN: 20010 },
    { taxYear: 2026, accountId: 'ibkr', ticker: 'AAPL.US', revenuePLN: 70010, costPLN: 39990 },
  ] as unknown as Parameters<typeof mapYearSummaries>[2];

  const konta = [
    { id: 'xtb', name: 'XTB', brokerType: 'XTB' },
    { id: 'ibkr', name: 'IBKR', brokerType: 'IBKR' },
  ] as unknown as Parameters<typeof mapYearSummaries>[4];

  const rok = mapYearSummaries(wynik, 2026, zyski, [], konta).get(2026);

  assert.equal(rok?.pit8cRevenuePLN, 30000);
  assert.equal(rok?.pit8cCostsPLN, 20000);
  assert.equal(rok?.pit8cZrodlo, 'informacja');
  // Wlasny rachunek zostaje do porownania - roznica ma byc widoczna, a nie ukryta.
  assert.equal(rok?.pit8cWyliczonyPrzychodPLN, 29990);
  assert.equal(rok?.pit8cWyliczoneKosztyPLN, 20010);
  // Wiersz 2 nadal pokazuje to, co policzone poza rachunkami z PIT-8C.
  assert.equal(rok?.foreignRevenuePLN, 70010);
  assert.equal(rok?.revenuePLN, 100010);
  assert.equal(rok?.costsPLN, 59990);
  assert.equal(rok?.incomePLN, 40020);
  assert.equal(rok?.taxBasePLN, 40020);
  assert.equal(rok?.taxBeforeCreditPLN, 7603.8);
  assert.equal(rok?.taxDuePLN, 7604);
  assert.equal(rok?.totalTaxToPayPLN, 7604);
});

test('bez wpisanej informacji kafelki są oznaczone jako policzone z transakcji', () => {
  const wynik = {
    art30b: {
      pit38_rounded_revenue_pln: '100000', pit38_rounded_cost_pln: '60000', tax_19_pln: '7600',
      pit8c_revenue_pln: '100000.00', pit8c_cost_pln: '60000.00',
      pit8c_calculated_revenue_pln: '100000.00', pit8c_calculated_cost_pln: '60000.00',
      pit8c_source: 'transakcje',
    },
    tax_year: '2026',
  } as unknown as Parameters<typeof mapYearSummaries>[0];

  const konta = [{ id: 'xtb', name: 'XTB', brokerType: 'XTB' }] as unknown as Parameters<
    typeof mapYearSummaries
  >[4];

  const rok = mapYearSummaries(wynik, 2026, [], [], konta).get(2026);

  assert.equal(rok?.pit8cZrodlo, 'transakcje');
  assert.equal(rok?.revenuePLN, 100000);
  assert.equal(rok?.costsPLN, 60000);
  assert.equal(rok?.taxDuePLN, 7600);
});
