import test from 'node:test';
import assert from 'node:assert/strict';

import { zbudujCsvTransakcji, zbudujCsvZyskow } from '../../../aplikacje/web/src/portfel/services/csvExporter.ts';
import { podzielNaRekordy, podzielWiersz } from '../../../aplikacje/web/src/portfel/services/odczytCsv.ts';
import type { BrokerAccount, TaxRealizedGain, TaxYearSummary, Transaction } from '../../../aplikacje/web/src/portfel/types.ts';

const rachunek = { id: 'k1', name: 'Dom; makler', brokerType: 'CUSTOM', currency: 'PLN', color: '#000' } as BrokerAccount;

function transakcja(zmiany: Partial<Transaction>): Transaction {
  return {
    id: 't1', accountId: 'k1', ticker: 'ABC', name: 'Spółka', category: 'STOCK_FOREIGN', type: 'BUY',
    date: '2026-01-02', quantity: 1.5, pricePerUnit: 10.25, currency: 'USD', commission: 0.5,
    commissionCurrency: 'USD', ...zmiany,
  };
}

test('eksport transakcji: nazwa rachunku z sredniknikiem jest cytowana, a wiersz ma tyle samo pol co naglowek', () => {
  const csv = zbudujCsvTransakcji([transakcja({})], [rachunek]);
  const [naglowek, wiersz] = podzielNaRekordy(csv.replace(/^\uFEFF/, ''));
  assert.equal(podzielWiersz(wiersz, ';').length, podzielWiersz(naglowek, ';').length);
  assert.equal(podzielWiersz(wiersz, ';')[1], 'Dom; makler');
});

test('eksport transakcji: pola tekstowe od uzytkownika nie wykonuja formul, liczby zostaja liczbami', () => {
  const csv = zbudujCsvTransakcji(
    [transakcja({ id: '=1+1', ticker: '@X', name: '-cmd', notes: '+notatka\nz nowa linia', pricePerUnit: 10.5, foreignTaxRate: 15 })],
    [{ ...rachunek, name: '=HYPERLINK("http://x")' }],
  );
  const [, wiersz] = podzielNaRekordy(csv.replace(/^\uFEFF/, ''));
  const pola = podzielWiersz(wiersz, ';');
  assert.equal(pola[0], "'=1+1");
  assert.equal(pola[1], `'=HYPERLINK("http://x")`);
  assert.equal(pola[3], "'@X");
  assert.equal(pola[4], "'-cmd");
  assert.equal(pola[15], "'+notatka\nz nowa linia");
  assert.equal(pola[8], '1,5');
  assert.equal(pola[9], '10,5');
  assert.equal(pola[13], '15', 'stawka podatku u źródła w osobnej kolumnie');
  assert.equal(pola[14], '', 'brak kwoty podatku u źródła to puste pole');
  // Ujemna liczba nie dostaje apostrofu.
  const ujemna = zbudujCsvTransakcji([transakcja({ commission: -2.5 })], [rachunek]);
  assert.ok(ujemna.includes(';-2,5;'));
});

test('eksport zyskow: nazwa i konto sa cytowane i neutralizowane, kwoty ujemne bez apostrofu', () => {
  const zysk = {
    ticker: 'ABC', name: '=cmd; "x"', category: 'STOCK_FOREIGN', accountId: 'k1', sellDate: '2026-02-01',
    sellQuantity: 1, sellPricePerUnit: 5, sellCurrency: 'USD', sellExchangeRate: 4, sellExchangeTable: '001/A/NBP/2026',
    sellCommissionPLN: 0, revenuePLN: 20, costPLN: 30, profitPLN: -10, taxYear: 2026,
  } as unknown as TaxRealizedGain;
  const podsumowanie = { year: 2026, revenuePLN: 20, costsPLN: 30, incomePLN: 0, lossPLN: 10, taxDuePLN: 0 } as TaxYearSummary;
  const csv = zbudujCsvZyskow([zysk], podsumowanie, [rachunek]);
  const wiersze = podzielNaRekordy(csv.replace(/^\uFEFF/, ''));
  const wiersz = wiersze[wiersze.length - 1];
  const pola = podzielWiersz(wiersz, ';');
  assert.equal(pola.length, 16);
  assert.equal(pola[2], `'=cmd; "x"`);
  assert.equal(pola[4], 'Dom; makler');
  assert.equal(pola[14], '-10,00');
});
