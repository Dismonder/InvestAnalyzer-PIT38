/**
 * IBKR Flex: wiersz "Withholding Tax" (opis "... CASH DIVIDEND ... - US TAX", kwota
 * ujemna) byl lapany warunkiem description.includes('dividend') jako osobna
 * dywidenda z Math.abs - przychod rosl o podatek, a podatek u zrodla wynosil 0.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { syncIBKRTrades } from '../../../aplikacje/web/src/server/routes/brokers.ts';

async function sync(wiersze: string[]): Promise<any> {
  const oryginalny = globalThis.fetch;
  globalThis.fetch = (async (wejscie: any) => {
    const adres = String(wejscie);
    if (adres.includes('SendRequest')) {
      return new Response('<FlexStatementResponse><Status>Success</Status><ReferenceCode>777</ReferenceCode></FlexStatementResponse>');
    }
    if (adres.includes('GetStatement')) {
      return new Response(`<FlexQueryResponse><CashTransactions>${wiersze.join('\n')}</CashTransactions></FlexQueryResponse>`);
    }
    throw new Error(`nieoczekiwane zapytanie: ${adres.slice(0, 60)}`);
  }) as typeof fetch;
  try {
    return await syncIBKRTrades({ accountId: 'a9', apiKey: 't', queryId: 'q' } as any, async () => {});
  } finally {
    globalThis.fetch = oryginalny;
  }
}

const dywidenda = (symbol: string, kwota: string, data = '20240520', waluta = 'USD', typ = 'Dividends') =>
  `<CashTransaction type="${typ}" description="${symbol}(US0378331005) CASH DIVIDEND USD 0.24 PER SHARE (Ordinary Dividend)" symbol="${symbol}" amount="${kwota}" currency="${waluta}" dateTime="${data}" settleDate="${data}" />`;
const podatek = (symbol: string, kwota: string, data = '20240520', waluta = 'USD') =>
  `<CashTransaction type="Withholding Tax" description="${symbol}(US0378331005) CASH DIVIDEND USD 0.24 PER SHARE - US TAX" symbol="${symbol}" amount="${kwota}" currency="${waluta}" dateTime="${data}" settleDate="${data}" />`;

test('podatek u zrodla jest przypisany do dywidendy, a nie osobna dywidenda', async () => {
  const wynik = await sync([dywidenda('AAPL', '24'), podatek('AAPL', '-3.6')]);
  assert.equal(wynik.success, true);
  assert.equal(wynik.syncedTransactions.length, 1, JSON.stringify(wynik.syncedTransactions));
  const [dyw] = wynik.syncedTransactions;
  assert.equal(dyw.type, 'DIVIDEND');
  assert.equal(dyw.pricePerUnit, 24, 'przychod brutto bez doliczonego podatku');
  assert.equal(dyw.foreignTaxAmount, 3.6);
  assert.equal(dyw.foreignTaxRate, 15);
});

test('Payment In Lieu Of Dividends jest dywidenda, a podatek dopasowany po symbolu, dacie i walucie', async () => {
  const wynik = await sync([
    dywidenda('MSFT', '10', '20240521', 'USD', 'Payment In Lieu Of Dividends'),
    podatek('MSFT', '-1.5', '20240521'),
    dywidenda('KO', '20', '20240521'),
    podatek('KO', '-3', '20240521', 'EUR'), // inna waluta: nie pasuje do KO w USD
    podatek('KO', '-2', '20240522'), // inna data: nie pasuje
  ]);
  const msft = wynik.syncedTransactions.find((t: any) => t.ticker === 'MSFT');
  const ko = wynik.syncedTransactions.find((t: any) => t.ticker === 'KO');
  assert.equal(wynik.syncedTransactions.length, 2);
  assert.equal(msft.foreignTaxAmount, 1.5);
  assert.equal(ko.foreignTaxAmount, 0);
  assert.match(wynik.ostrzezenia.join(' '), /KO/, 'podatek bez pasujacej dywidendy trafia do ostrzezen');
});

test('samotny podatek u zrodla nie tworzy transakcji, a ujemna dywidenda jest pomijana z ostrzezeniem', async () => {
  const wynik = await sync([podatek('IBM', '-4'), dywidenda('T', '-8')]);
  assert.equal(wynik.syncedTransactions.length, 0);
  assert.match(wynik.ostrzezenia.join(' '), /IBM/);
  assert.match(wynik.ostrzezenia.join(' '), /T/);
});

test('zwrot podatku (kwota dodatnia) pomniejsza podatek u zrodla dywidendy', async () => {
  const wynik = await sync([dywidenda('PEP', '100'), podatek('PEP', '-15'), podatek('PEP', '5')]);
  assert.equal(wynik.syncedTransactions.length, 1);
  assert.equal(wynik.syncedTransactions[0].foreignTaxAmount, 10);
});

test('wyplata / storno / ponowna wyplata to jedna dywidenda, nie dwie (storno kasuje pare)', async () => {
  const wynik = await sync([
    dywidenda('KO', '24', '20240520'),
    podatek('KO', '-3.6', '20240520'),
    dywidenda('KO', '-24', '20240522'),
    podatek('KO', '3.6', '20240522'),
    dywidenda('KO', '24', '20240523'),
    podatek('KO', '-3.6', '20240523'),
  ]);
  const dywidendy = wynik.syncedTransactions.filter((t: any) => t.type === 'DIVIDEND');
  assert.equal(dywidendy.length, 1, JSON.stringify(dywidendy));
  assert.equal(dywidendy[0].pricePerUnit, 24, 'przychod liczony raz');
  assert.doesNotMatch(wynik.ostrzezenia.join(' '), /Korekty dywidend/, 'sparowane storno nie jest ostrzezeniem');
});

test('storno paruje sie tylko z wyplata o tym samym symbolu, walucie i kwocie', async () => {
  const wynik = await sync([
    dywidenda('KO', '24', '20240520'),
    dywidenda('PEP', '24', '20240520'),
    dywidenda('KO', '-24', '20240522', 'EUR'), // inna waluta
    dywidenda('PEP', '-20', '20240522'), // inna kwota
  ]);
  assert.equal(wynik.syncedTransactions.length, 2, 'zadna wyplata nie zostaje skasowana');
  const ostrzezenia = wynik.ostrzezenia.join(' ');
  assert.match(ostrzezenia, /Korekty dywidend/);
  assert.match(ostrzezenia, /KO/);
  assert.match(ostrzezenia, /PEP/);
});

test('jedno storno kasuje tylko jedna wyplate o tej kwocie', async () => {
  const wynik = await sync([
    dywidenda('KO', '24', '20240520'),
    dywidenda('KO', '24', '20240521'),
    dywidenda('KO', '-24', '20240522'),
  ]);
  assert.equal(wynik.syncedTransactions.length, 1);
});