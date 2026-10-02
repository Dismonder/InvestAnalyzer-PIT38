/**
 * Jedno źródło prawdy: zakładki Portfel / PIT-38 / Transakcje z przebiegu silnika.
 *
 * Błąd, który ten plik trzyma: warsztat silnika liczył 441 transakcji i podatek
 * 17 376,32 zł z magazynu dokumentów, a portfel obok - przy świeżym profilu
 * przeglądarki - pokazywał „0 transakcji” i „Należny podatek: —”, bo czytał
 * wyłącznie własny stan lokalny i przy pustej liście w ogóle nie pytał silnika.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  KONTO_MAGAZYNU_SILNIKA,
  mapDividends,
  mapOpenPositions,
  pustePodsumowanieRoku,
  transakcjeZWynikuSilnika,
  zbudujWynikPortfelaZSilnika,
} from '../../../aplikacje/web/src/portfel/services/engineBridge.ts';
import { zestawPozycjeZBrokerem } from '../../../aplikacje/web/src/portfel/services/pozycjeBrokera.ts';
import {
  podzielTransakcjeLokalne,
  transakcjeJakoNadpisania,
} from '../../../aplikacje/web/src/portfel/services/reczneTransakcje.ts';
import { polaczNadpisania } from '../../../aplikacje/web/src/invest_analyzer/services/taxEngineRequestFactory.ts';
import {
  odczytajWynikSilnika,
  opublikujWynikSilnika,
  subskrybujWynikSilnika,
  uniewaznijWynikiSilnika,
} from '../../../aplikacje/web/src/invest_analyzer/services/ostatniWynikSilnika.ts';
import { opisTrwajacegoPrzebiegu } from '../../../aplikacje/web/src/invest_analyzer/services/runtimeApi.web.ts';
import type { Transaction } from '../../../aplikacje/web/src/portfel/types.ts';

function wiersz(zmiany: Record<string, unknown>): Record<string, unknown> {
  return {
    row_id: 'TRADE-1',
    parent_row_id: null,
    row_kind: 'TRADE',
    display_date: '2026-01-21 07:39:21',
    transaction_id: '1',
    manual_record_id: '1',
    ticker: 'NBIS.US',
    side: 'BUY',
    quantity: '20.00000000',
    amount: '1980.00000000',
    currency: 'USD',
    amount_pln: '7147.34',
    logical_world: 'equity_tax',
    details: {},
    ...zmiany,
  };
}

/** Wynik w kształcie zwracanym przez silnik (kwoty jak w przebiegu za 2026 r.). */
function odpowiedzSilnika(): any {
  return {
    success: true,
    status: 'SUCCESS_WITH_WARNINGS',
    filing_ready: false,
    tax_years_detected: [2025, 2026],
    annual_summary: { tax_year: '2026', tax_19_pln: '17376.32' },
    art30b: {
      tax_year: '2026',
      pit38_rounded_revenue_pln: '11165390',
      pit38_rounded_cost_pln: '11073935',
      pit38_form_revenue_pln: '11165389.72',
      pit38_form_cost_pln: '11073935.41',
      pit38_form_income_pln: '91454.31',
      pit38_form_loss_pln: '0.00',
      pit38_form_base_pln: '91454',
      pit38_form_tax_pln: '17376.26',
      pit38_form_tax_due_pln: '17376',
      pit38_income: '91454',
      pit38_loss: '0',
      tax_19_pln: '17376.32',
      prior_year_loss_used_pln: '0.00',
    },
    art30a: {},
    transaction_history_rows: [
      wiersz({}),
      wiersz({ row_id: 'EVENT-9', parent_row_id: 'TRADE-1', row_kind: 'TRADE_FEE', side: null, quantity: null, amount: '-2.4', transaction_id: '9', manual_record_id: '9' }),
      wiersz({ row_id: 'TRADE-2', transaction_id: '2', manual_record_id: '2', side: 'SELL', quantity: '5', amount: '600', display_date: '2026-02-03 10:00:00' }),
      wiersz({ row_id: 'TRADE-FX', transaction_id: '3', manual_record_id: '3', ticker: 'PLN/USD', logical_world: 'private_cash_fx', quantity: '48460', amount: '13000' }),
      wiersz({ row_id: 'EVENT-D', row_kind: 'DIVIDEND', side: null, quantity: null, amount: '0.2', ticker: 'NVDA.US', display_date: '2026-04-03 12:14:19', transaction_id: 'd', manual_record_id: 'd' }),
      wiersz({ row_id: 'EVENT-T', row_kind: 'TAX', side: null, quantity: null, amount: '-0.03', ticker: 'NVDA.US', display_date: '2026-04-03 12:14:19', transaction_id: 't', manual_record_id: 't' }),
      // Wiersz bez waluty: nie wolno mu dopisać "USD" ani zera.
      wiersz({ row_id: 'TRADE-X', transaction_id: 'x', manual_record_id: 'x', currency: null }),
      // Ręczny wpis portfela wraca z silnika pod swoim identyfikatorem.
      wiersz({ row_id: 'TRADE-M', transaction_id: 'portfel-tx_1', manual_record_id: 'portfel-tx_1', ticker: 'CDR.PL', quantity: '10', amount: '2500', currency: 'PLN', amount_pln: '2500.00' }),
    ],
    fifo_rows: [
      {
        row_id: 'F1', symbol: 'NBIS.US', sell_trade_id: '2', buy_trade_id: '1', quantity: '5',
        sell_tax_date: '2026-02-03', buy_tax_date: '2026-01-21', sell_fx_date: '2026-02-02', buy_fx_date: '2026-01-20',
        gross_revenue_pln: '2166.00', sell_commission_alloc_pln: '0', net_revenue_pln: '2166.00', cost_pln: '1786.84', pnl_pln: '379.16',
        sell_price: '120', sell_currency: 'USD', sell_fx_rate: '3.61',
      },
    ],
    open_lots: [
      { lot_id: 'LOT-1', symbol: 'NBIS.US', origin_trade_id: '1', open_date: '2026-01-21T07:39:21', logical_world: 'equity_tax', quantity_open: '20', quantity_remaining: '15', unit_cost_pln: '357.367', cost_remaining_pln: '5360.51', price: '99', currency: 'USD' },
      // Zakup z roku wcześniejszego, nadal trzymany - nie ma go w wierszach historii roku 2026.
      { lot_id: 'LOT-0', symbol: 'AAPL.US', origin_trade_id: '0', open_date: '2025-05-05T10:00:00', logical_world: 'equity_tax', quantity_open: '3', quantity_remaining: '3', unit_cost_pln: '800', cost_remaining_pln: '2400.00', price: '200', currency: 'USD' },
      // Akcje przyznane: brak transakcji nabycia, więc brak waluty.
      { lot_id: 'GRANT-1', symbol: 'PTON.US', origin_trade_id: 'g', open_date: '2025-02-01T00:00:00', logical_world: 'equity_tax', quantity_open: '1', quantity_remaining: '1', unit_cost_pln: '0', cost_remaining_pln: '0.00', price: null, currency: null },
    ],
    dividends_view: [],
  };
}

test('wiersz dywidendy pokazuje wyłącznie dopłatę per wiersz z silnika', () => {
  const [dywidenda] = mapDividends({ dividends_view: [{
    event_id: 'DIV-1', date: '2025-06-01', symbol: 'XYZ.US',
    gross_dividend_pln: '100.00', gross_dividend_foreign: '100.00', currency: 'USD',
    withholding_tax_pln: '30.00', withholding_tax_foreign: '30.00',
    polish_tax_due_pln: '19.00', creditable_tax_pln: '15.00', tax_to_pay_pln: '4.00',
  }] }, []);
  assert.equal(dywidenda.taxToPayInPolandPLN, 4);
});

function reczna(zmiany: Partial<Transaction>): Transaction {
  return {
    id: 'tx_1', accountId: 'acc', ticker: 'CDR.PL', name: 'CD Projekt', category: 'STOCK_PL', type: 'BUY',
    date: '2026-03-01', quantity: 10, pricePerUnit: 250, currency: 'PLN', commission: 5, commissionCurrency: 'PLN',
    ...zmiany,
  };
}

test('pusty stan przeglądarki nie znaczy „0 transakcji”: lista powstaje z przebiegu silnika', () => {
  const { transakcje, pominieteBezDanych } = transakcjeZWynikuSilnika(odpowiedzSilnika(), []);
  const kupna = transakcje.filter((tx) => tx.type === 'BUY');
  const sprzedaze = transakcje.filter((tx) => tx.type === 'SELL');
  const dywidendy = transakcje.filter((tx) => tx.type === 'DIVIDEND');
  assert.equal(kupna.length, 2);
  assert.equal(sprzedaze.length, 1);
  assert.equal(dywidendy.length, 1);
  // Przewalutowanie PLN/USD nie jest transakcją portfela.
  assert.equal(transakcje.some((tx) => tx.ticker === 'PLN/USD'), false);
  // Wiersz bez waluty jest policzony jako pominięty, nie dostaje "USD".
  assert.equal(pominieteBezDanych, 1);

  const kupno = kupna.find((tx) => tx.ticker === 'NBIS.US');
  assert.ok(kupno);
  assert.equal(kupno.quantity, 20);
  assert.equal(kupno.pricePerUnit, 99);
  assert.equal(kupno.currency, 'USD');
  assert.equal(kupno.commission, 2.4);
  assert.equal(kupno.commissionCurrency, 'USD');
  assert.equal(kupno.kwotaPLN, 7147.34);
  assert.equal(kupno.tylkoOdczyt, true);
  assert.equal(kupno.accountId, KONTO_MAGAZYNU_SILNIKA);
  assert.equal(dywidendy[0].foreignTaxAmount, 0.03);
});

test('kwoty PIT-38 w zakładce są przepisane z silnika, nie liczone drugi raz', () => {
  const wynik = zbudujWynikPortfelaZSilnika(odpowiedzSilnika(), 2026, [], []);
  const rok = wynik.yearSummaries.get(2026);
  assert.ok(rok);
  assert.equal(rok.nieobliczony, undefined);
  assert.equal(rok.revenuePLN, 11165389.72);
  assert.equal(rok.costsPLN, 11073935.41);
  assert.equal(rok.incomePLN, 91454.31);
  assert.equal(rok.lossPLN, 0);
  assert.equal(rok.taxBasePLN, 91454);
  assert.equal(rok.taxBeforeCreditPLN, 17376.26);
  assert.equal(rok.taxDuePLN, 17376);
  // Suma z jednego wiersza FIFO dałaby 379,16 zł dochodu - gdyby zakładka liczyła
  // sama, podatek wyszedłby 72 zł zamiast 17 376,32 zł.
  assert.notEqual(rok.taxDuePLN, Math.round(379.16 * 0.19));
  assert.equal(wynik.gotoweDoZlozenia, false);
  assert.equal(wynik.rokSilnika, 2026);
});

test('kwota do zapłaty portfela pochodzi z poz. 51 projekcji pakietu', () => {
  const odpowiedz = odpowiedzSilnika();
  odpowiedz.tax_filing_package = { draft: { form_fields: [
    { section: 'D', position: '31', value: '91454' },
    { section: 'D', position: '33', value: '17376.26' },
    { section: 'D', position: '35', value: '17376' },
    { section: 'G', position: '48', value: '10.32' },
    { section: 'G', position: '49', value: '1' },
    { section: 'G', position: '51', value: '17377' },
  ] } };
  odpowiedz.art30a = { gross_dividends_pln: '60.00', polish_tax_19_pln: '11.40', tax_to_pay_pln: '1.08' };
  const rok = zbudujWynikPortfelaZSilnika(odpowiedz, 2026, [], []).yearSummaries.get(2026);
  assert.ok(rok);
  assert.equal(rok.dividendTaxToPayPLN, 1);
  assert.equal(rok.dividendCreditUsedPLN, 10.32);
  assert.equal(rok.totalTaxToPayPLN, 17377);
});

test('bez pakietu pozycje 31 i 51 pochodzą z tej samej projekcji silnika', () => {
  const odpowiedz = odpowiedzSilnika();
  odpowiedz.annual_summary.pit38_form_base_pln = '91454';
  odpowiedz.annual_summary.pit38_form_total_tax_to_pay_pln = '17376.19';
  odpowiedz.annual_summary.pit38_form_fields = {
    '31': '91454', '45': '0', '46': '0', '47': '0.19',
    '48': '0', '49': '0.19', '50': '0', '51': '17376.19',
  };
  odpowiedz.art30a = {
    gross_dividends_pln: '0', gross_credit_interest_pln: '1.00',
    polish_tax_19_pln: '0', tax_to_pay_pln: '0',
  };
  const bezPakietu = zbudujWynikPortfelaZSilnika(odpowiedz, 2026, [], []).yearSummaries.get(2026);
  odpowiedz.tax_filing_package = { draft: { form_fields: [
    { section: 'D', position: '31', value: '91454' },
    { section: 'G', position: '51', value: '17376.19' },
  ] } };
  const zPakietem = zbudujWynikPortfelaZSilnika(odpowiedz, 2026, [], []).yearSummaries.get(2026);
  assert.ok(bezPakietu && zPakietem);
  assert.equal(bezPakietu.taxBasePLN, zPakietem.taxBasePLN);
  assert.equal(bezPakietu.formTaxToPayPLN, zPakietem.formTaxToPayPLN);
  assert.equal(bezPakietu.totalTaxToPayPLN, 17376.19);
  assert.equal((bezPakietu as typeof bezPakietu & { engineFormFields: Record<string, number> }).engineFormFields['47'], 0.19);
});

test('brak wyniku silnika dla roku daje „—”, nie zero', () => {
  const wynik = zbudujWynikPortfelaZSilnika(odpowiedzSilnika(), 2026, [], []);
  // Rok 2025 silnik wykrył w danych, ale go nie liczył.
  assert.equal(wynik.yearSummaries.get(2025)?.nieobliczony, true);
  const puste = pustePodsumowanieRoku(2024);
  assert.equal(puste.nieobliczony, true);
  // Odpowiedź bez rozliczenia nie trafia do wspólnego magazynu wyniku.
  uniewaznijWynikiSilnika();
  opublikujWynikSilnika(2026, 'k', { success: false, error: 'awaria' } as any);
  assert.equal(odczytajWynikSilnika(2026), null);
});

test('otwarte pozycje pochodzą z otwartych partii FIFO całego horyzontu', () => {
  const wynik = zbudujWynikPortfelaZSilnika(odpowiedzSilnika(), 2026, [], []);
  const tickery = wynik.openPositions.map((p) => p.ticker).sort();
  // AAPL kupione w 2025 r. nie ma w wierszach historii roku 2026, a jest w portfelu.
  assert.deepEqual(tickery, ['AAPL.US', 'NBIS.US']);
  const nbis = wynik.openPositions.find((p) => p.ticker === 'NBIS.US');
  assert.ok(nbis);
  assert.equal(nbis.totalQuantity, 15);
  assert.equal(nbis.totalCostPLN, 5360.51);
  assert.equal(nbis.currency, 'USD');
  // Partia bez waluty (akcje przyznane) nie dostaje zgadywanej waluty ani kosztu 0 w tabeli.
  assert.equal(wynik.openPositions.some((p) => p.ticker === 'PTON.US'), false);
});

test('starszy silnik bez open_lots: pozycje nadal wynikają z FIFO wierszy historii', () => {
  const odpowiedz = odpowiedzSilnika();
  delete odpowiedz.open_lots;
  const pozycje = mapOpenPositions(odpowiedz, []);
  const nbis = pozycje.find((p) => p.ticker === 'NBIS.US');
  assert.ok(nbis);
  assert.equal(nbis.totalQuantity, 15);
  assert.equal(pozycje.some((p) => p.ticker === 'PLN/USD'), false);
});

test('pozycja z Freedom24 nie dubluje pozycji z transakcji; różnice są nazwane', () => {
  const wynik = zbudujWynikPortfelaZSilnika(odpowiedzSilnika(), 2026, [], []);
  const zgodne = zestawPozycjeZBrokerem(wynik.openPositions, [
    { ticker: 'NBIS', market: 'US', quantity: 15, currency: 'USD' },
    { ticker: 'AAPL', market: 'US', quantity: 3, currency: 'USD' },
  ]);
  assert.deepEqual(zgodne, []);

  const rozbieznosci = zestawPozycjeZBrokerem(wynik.openPositions, [
    { ticker: 'NBIS', market: 'US', quantity: 16, currency: 'USD' },
    { ticker: 'PTON', market: 'US', quantity: 1, currency: 'USD' },
    { ticker: 'MOMO', market: 'US', quantity: null, currency: 'USD' },
  ]);
  const wgTickera = new Map(rozbieznosci.map((r) => [r.ticker, r]));
  assert.equal(wgTickera.get('NBIS')?.rodzaj, 'INNA_ILOSC');
  assert.equal(wgTickera.get('PTON')?.rodzaj, 'BRAK_W_TRANSAKCJACH');
  assert.equal(wgTickera.get('PTON')?.iloscZTransakcji, null);
  assert.equal(wgTickera.get('MOMO')?.rodzaj, 'ILOSC_NIEZNANA');
  assert.equal(wgTickera.get('AAPL')?.rodzaj, 'BRAK_U_BROKERA');
  // Brak odpowiedzi brokera (pusta lista) nie oznacza, że pozycji nie ma.
  assert.deepEqual(zestawPozycjeZBrokerem(wynik.openPositions, []), []);
});

test('ręczne wpisy jadą w żądaniu jako rekordy ręczne, a kopie z API brokera nie', () => {
  const lokalne: Transaction[] = [
    reczna({}),
    reczna({ id: 'fr24_acc_trade_611553452_NBIS.US', ticker: 'NBIS.US', currency: 'USD' }),
    reczna({ id: 'tx_2', type: 'DIVIDEND' }),
    reczna({ id: 'tx_3', category: 'CRYPTO', ticker: 'BTC' }),
    reczna({ id: 'tx_4', quantity: Number.NaN }),
  ];
  const podzial = podzielTransakcjeLokalne(lokalne);
  assert.deepEqual(podzial.doSilnika.map((tx) => tx.id), ['tx_1']);
  assert.deepEqual(
    podzial.pominiete.map((p) => p.powod).sort(),
    ['KOPIA_Z_API_BROKERA', 'KRYPTOWALUTA', 'NIEPELNE_DANE', 'RODZAJ_NIEOBSLUGIWANY'],
  );

  const nadpisania = transakcjeJakoNadpisania(lokalne);
  assert.equal(nadpisania.length, 1);
  assert.equal(nadpisania[0].mode, 'new');
  assert.equal(nadpisania[0].recordType, 'TRADE');
  assert.equal(nadpisania[0].manualRecordId, 'portfel-tx_1');
  assert.equal(nadpisania[0].values.trade_currency, 'PLN');
  assert.equal(nadpisania[0].values.gross_amount, '2500');
  // To samo wejście daje to samo żądanie - inaczej nie da się rozpoznać przebiegu w locie.
  assert.deepEqual(transakcjeJakoNadpisania(lokalne), nadpisania);
  // Rekord już obecny w edytorze historii nie jest dokładany drugi raz.
  assert.equal(polaczNadpisania(nadpisania, nadpisania).length, 1);

  // Wiersz silnika dla ręcznego wpisu wraca pod lokalnym identyfikatorem i jest edytowalny.
  const { transakcje } = transakcjeZWynikuSilnika(odpowiedzSilnika(), lokalne);
  const zwrocona = transakcje.find((tx) => tx.id === 'tx_1');
  assert.ok(zwrocona);
  assert.equal(zwrocona.tylkoOdczyt, false);
  assert.equal(zwrocona.zrodlo, 'RECZNA');
  assert.equal(transakcje.filter((tx) => tx.ticker === 'CDR.PL').length, 1);
});

test('wynik policzony w warsztacie trafia do portfela przez wspólny magazyn wyniku', () => {
  uniewaznijWynikiSilnika();
  const odebrane: number[] = [];
  const odsubskrybuj = subskrybujWynikSilnika((wynik) => odebrane.push(wynik.rok));
  opublikujWynikSilnika(2026, 'klucz-a', odpowiedzSilnika());
  odsubskrybuj();
  opublikujWynikSilnika(2025, 'klucz-b', odpowiedzSilnika());
  assert.deepEqual(odebrane, [2026]);
  assert.equal(odczytajWynikSilnika(2026)?.kluczZadania, 'klucz-a');
  uniewaznijWynikiSilnika();
  assert.equal(odczytajWynikSilnika(2026), null);
});

test('trwający przebieg mówi, ile trwa, zamiast stać na 50%', () => {
  const poczatek = opisTrwajacegoPrzebiegu(5_000, 60_000);
  const pozniej = opisTrwajacegoPrzebiegu(45_000, 60_000);
  const dlugo = opisTrwajacegoPrzebiegu(200_000, 60_000);
  assert.ok(poczatek.progress < pozniej.progress);
  assert.equal(dlugo.progress, 95);
  assert.match(pozniej.message, /Trwa 45 s/);
  assert.match(pozniej.message, /poprzedni przebieg trwał ok\. 60 s/);
  assert.match(dlugo.message, /dłużej niż zwykle/);
  assert.match(opisTrwajacegoPrzebiegu(1_000, null).message, /około minuty/);
});

test('pozycja kupiona przed rokiem rozliczenia należy do tego samego rachunku co reszta', () => {
  const wynik = zbudujWynikPortfelaZSilnika(odpowiedzSilnika(), 2026, [], []);
  // AAPL nie ma wiersza historii w 2026 r. Pusty rachunek zamieniał się w „acc_default”
  // i jeden rachunek brokera był pokazywany jako dwa. Partie z wyciągów w magazynie
  // należą do dokumentów silnika - „rachunek nieustalony” wyłączał je ze zleceń.
  const rachunki = new Set(wynik.openPositions.flatMap((p) => p.lots.map((lot) => lot.accountId)));
  assert.deepEqual([...rachunki], [KONTO_MAGAZYNU_SILNIKA]);
  for (const pozycja of wynik.openPositions) {
    assert.deepEqual(pozycja.accountIds, [KONTO_MAGAZYNU_SILNIKA], pozycja.ticker);
  }
});

test('pamięć wyników trzyma tylko trzy ostatnio policzone lata', () => {
  uniewaznijWynikiSilnika();
  const wynik = { success: true, annual_summary: { tax_year: '2020' } } as never;
  for (const rok of [2020, 2021, 2022, 2023]) opublikujWynikSilnika(rok, `k${rok}`, wynik);
  assert.equal(odczytajWynikSilnika(2020), null, 'najstarszy rok zwolniony');
  for (const rok of [2021, 2022, 2023]) assert.ok(odczytajWynikSilnika(rok));
  // Ponowne policzenie roku odświeża jego miejsce w pamięci.
  opublikujWynikSilnika(2021, 'k2021b', wynik);
  opublikujWynikSilnika(2024, 'k2024', wynik);
  assert.equal(odczytajWynikSilnika(2022), null);
  assert.equal(odczytajWynikSilnika(2021)?.kluczZadania, 'k2021b');
  uniewaznijWynikiSilnika();
});
