/**
 * Kontrola danych przed wyslaniem do silnika.
 *
 * JSON.stringify zamienia NaN i Infinity na null, a silnik pomija pole null
 * bez slowa. Jedna zepsuta liczba z importu CSV potrafila wiec cicho wyzerowac
 * kwote transakcji i przeklamac podatek. Te testy pilnuja, zeby przeliczenie
 * zatrzymalo sie z czytelnym komunikatem zamiast policzyc bzdure.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sprawdzTransakcje,
  opiszProblemy,
} from '../../../aplikacje/web/src/portfel/services/engineBridge.ts';
import type { Transaction } from '../../../aplikacje/web/src/portfel/types.ts';

function kupno(zmiany: Partial<Transaction> = {}): Transaction {
  return {
    id: 'tx-1',
    accountId: 'acc-1',
    ticker: 'AAPL.US',
    name: 'Apple',
    category: 'STOCK_FOREIGN',
    type: 'BUY',
    date: '2024-03-15T10:00:00',
    quantity: 10,
    pricePerUnit: 150,
    currency: 'USD',
    commission: 1,
    commissionCurrency: 'USD',
    ...zmiany,
  } as Transaction;
}

test('poprawna transakcja nie zglasza problemow', () => {
  assert.deepEqual(sprawdzTransakcje([kupno()]), []);
});

test('NaN w ilosci jest zatrzymywany', () => {
  const problemy = sprawdzTransakcje([kupno({ quantity: Number.NaN })]);
  assert.equal(problemy.length, 1);
  assert.equal(problemy[0].pole, 'ilość');
});

test('nieskonczonosc w cenie jest zatrzymywana', () => {
  const problemy = sprawdzTransakcje([kupno({ pricePerUnit: Number.POSITIVE_INFINITY })]);
  assert.equal(problemy[0].pole, 'cena');
});

test('kwota poza zakresem dokladnosci liczb jest zatrzymywana', () => {
  const problemy = sprawdzTransakcje([kupno({ pricePerUnit: 1e16 })]);
  assert.equal(problemy[0].pole, 'cena', 'powyzej 1e15 liczba gubi grosze');
});

test('ilosc zero i ujemna sa zatrzymywane', () => {
  assert.equal(sprawdzTransakcje([kupno({ quantity: 0 })]).length, 1);
  assert.equal(sprawdzTransakcje([kupno({ quantity: -5 })]).length, 1);
});

test('ujemna prowizja jest zatrzymywana', () => {
  assert.equal(sprawdzTransakcje([kupno({ commission: -1 })])[0].pole, 'prowizja');
});

test('brak tickera przy kupnie jest zatrzymywany', () => {
  assert.equal(sprawdzTransakcje([kupno({ ticker: '' })])[0].pole, 'ticker');
});

test('zle daty sa zatrzymywane', () => {
  assert.equal(sprawdzTransakcje([kupno({ date: '' })])[0].pole, 'data');
  assert.equal(sprawdzTransakcje([kupno({ date: 'wczoraj' })])[0].pole, 'data');
  assert.equal(sprawdzTransakcje([kupno({ date: '1899-01-01' })])[0].pole, 'data');
  assert.equal(sprawdzTransakcje([kupno({ date: '2099-01-01' })])[0].pole, 'data');
});

test('zla waluta jest zatrzymywana', () => {
  assert.equal(sprawdzTransakcje([kupno({ currency: '' as never })])[0].pole, 'waluta');
  assert.equal(sprawdzTransakcje([kupno({ currency: 'DOLAR' as never })])[0].pole, 'waluta');
});

test('dywidenda bez tickera jest zatrzymywana', () => {
  // Bez symbolu silnik nie ustali kraju, wiec dywidenda nie trafi do PIT/ZG,
  // a bramka pokrycia kategorii zablokuje cale rozliczenie.
  const problemy = sprawdzTransakcje([
    kupno({ type: 'DIVIDEND', ticker: '', quantity: 1, pricePerUnit: 25 }),
  ]);
  assert.ok(problemy.some((p) => p.pole === 'ticker'));
});

test('podatek u zrodla wiekszy od dywidendy jest zatrzymywany', () => {
  const problemy = sprawdzTransakcje([
    kupno({ type: 'DIVIDEND', quantity: 1, pricePerUnit: 25, foreignTaxAmount: 30 }),
  ]);
  assert.equal(problemy[0].pole, 'podatek u źródła');
});

test('stawka podatku poza zakresem jest zatrzymywana', () => {
  const problemy = sprawdzTransakcje([
    kupno({ type: 'DIVIDEND', quantity: 1, pricePerUnit: 25, foreignTaxRate: 150 }),
  ]);
  assert.equal(problemy[0].pole, 'stawka podatku');
});

test('komunikat wymienia wpisy i nie zasypuje uzytkownika', () => {
  const wiele = Array.from({ length: 9 }, (_, i) => kupno({ id: `tx-${i}`, quantity: Number.NaN }));
  const opis = opiszProblemy(sprawdzTransakcje(wiele));
  assert.ok(opis.includes('9 wpisów'));
  assert.ok(opis.includes('oraz 4 kolejnych'), 'pokazujemy piec i podsumowanie reszty');
});
