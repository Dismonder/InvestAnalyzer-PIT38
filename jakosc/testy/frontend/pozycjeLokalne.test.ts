/**
 * Wersja hostowana (telefon) nie ma silnika: pozycje portfela licza sie w
 * przegladarce (FIFO per ticker+rachunek, koszt PLN po kursie NBP T-1).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { policzPozycjeLokalnie } from '../../../aplikacje/web/src/portfel/services/pozycjeLokalne.ts';
import type { Transaction } from '../../../aplikacje/web/src/portfel/types.ts';

const tx = (czesc: Partial<Transaction> & Pick<Transaction, 'id' | 'type' | 'date' | 'quantity' | 'pricePerUnit'>): Transaction => ({
  accountId: 'acc1', ticker: 'NBIS.US', name: 'Nebius', category: 'STOCK_FOREIGN', currency: 'USD',
  commission: 0, commissionCurrency: 'USD', ...czesc,
} as Transaction);

const kursy = async (currency: string, date: string) => {
  if (currency === 'PLN') return { mid: 1, effectiveDate: date, table: 'A' };
  if (currency === 'USD') return { mid: 4, effectiveDate: '2026-01-14', table: 'A' };
  return null;
};

test('FIFO: sprzedaz zdejmuje najstarsza partie, zostaje reszta z kosztem po kursie NBP i prowizja proporcjonalna', async () => {
  const wynik = await policzPozycjeLokalnie([
    tx({ id: 'b1', type: 'BUY', date: '2026-01-15', quantity: 10, pricePerUnit: 100, commission: 2 }),
    tx({ id: 'b2', type: 'BUY', date: '2026-02-01', quantity: 5, pricePerUnit: 120 }),
    tx({ id: 's1', type: 'SELL', date: '2026-03-10', quantity: 12, pricePerUnit: 150 }),
  ], kursy);
  assert.equal(wynik.openPositions.length, 1);
  const p = wynik.openPositions[0];
  assert.equal(p.totalQuantity, 3);
  assert.equal(p.openLotsCount, 1);
  assert.equal(p.lots[0].buyTransactionId, 'b2');
  assert.equal(p.avgBuyPrice, 120);
  assert.equal(p.totalCostPLN, 3 * 120 * 4);
  assert.equal(p.avgBuyPricePLN, 480);
  assert.deepEqual(p.accountIds, ['acc1']);
  assert.deepEqual(wynik.unmatchedSalesWarnings, []);
  assert.equal(wynik.pominieteBezDanych, 0);
});

test('prowizja zakupu wchodzi do kosztu proporcjonalnie do pozostalej czesci partii', async () => {
  const wynik = await policzPozycjeLokalnie([
    tx({ id: 'b1', type: 'BUY', date: '2026-01-15', quantity: 10, pricePerUnit: 100, commission: 2 }),
    tx({ id: 's1', type: 'SELL', date: '2026-03-10', quantity: 5, pricePerUnit: 150 }),
  ], kursy);
  const p = wynik.openPositions[0];
  assert.equal(p.lots[0].commissionPLN, 4, 'polowa z 2 USD po kursie 4');
  assert.equal(p.lots[0].commissionOrig, 1);
  assert.equal(p.totalCostPLN, 5 * 100 * 4 + 4);
});

test('ten sam ticker na dwoch rachunkach to dwie pozycje; sprzedaz bez pokrycia jest zgloszona', async () => {
  const wynik = await policzPozycjeLokalnie([
    tx({ id: 'b1', type: 'BUY', date: '2026-01-15', quantity: 10, pricePerUnit: 100 }),
    tx({ id: 'b2', type: 'BUY', date: '2026-01-16', quantity: 4, pricePerUnit: 100, accountId: 'acc2' }),
    tx({ id: 's1', type: 'SELL', date: '2026-02-01', quantity: 6, pricePerUnit: 100, accountId: 'acc2' }),
  ], kursy);
  assert.equal(wynik.openPositions.length, 1, 'acc2 wyzerowane, acc1 zostaje');
  assert.equal(wynik.openPositions[0].accountIds[0], 'acc1');
  assert.equal(wynik.unmatchedSalesWarnings.length, 1);
  assert.equal(wynik.unmatchedSalesWarnings[0].missingQuantity, 2);
});

test('brak kursu NBP: partia wchodzi z kosztem 0 i jest policzona jako pominieta, kurs wlasny z transakcji ma pierwszenstwo', async () => {
  const wynik = await policzPozycjeLokalnie([
    tx({ id: 'b1', type: 'BUY', date: '2026-01-15', quantity: 1, pricePerUnit: 50, currency: 'CHF', commissionCurrency: 'CHF' }),
    tx({ id: 'b2', type: 'BUY', date: '2026-01-15', quantity: 1, pricePerUnit: 50, currency: 'CHF', commissionCurrency: 'CHF', ticker: 'X', customExchangeRate: 4.5, customExchangeRateDate: '2026-01-14' }),
  ], kursy);
  assert.equal(wynik.pominieteBezDanych, 1);
  const bez = wynik.openPositions.find((p) => p.ticker === 'NBIS.US')!;
  assert.equal(bez.totalCostPLN, 0);
  assert.equal(bez.lots[0].exchangeTable, 'BRAK');
  const wlasny = wynik.openPositions.find((p) => p.ticker === 'X')!;
  assert.equal(wlasny.totalCostPLN, 225);
});

test('dywidendy i oplaty nie tworza pozycji', async () => {
  const wynik = await policzPozycjeLokalnie([
    tx({ id: 'd1', type: 'DIVIDEND', date: '2026-01-15', quantity: 0, pricePerUnit: 12 }),
    tx({ id: 'f1', type: 'FEE', date: '2026-01-15', quantity: 0, pricePerUnit: 1 }),
  ], kursy);
  assert.deepEqual(wynik.openPositions, []);
});
