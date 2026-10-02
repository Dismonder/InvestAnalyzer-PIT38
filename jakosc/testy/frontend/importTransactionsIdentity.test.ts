import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildImportTransactionIdentity,
  kolumnyInstrumentuCsv,
  createImportTransactionId,
  resolveCsvAccountId,
} from '../../../aplikacje/web/src/portfel/components/ImportTransactionsModal.tsx';
import { zapiszZmianeUstawien, odczytajUstawienia, USTAWIENIA_DOMYSLNE } from '../../../aplikacje/web/src/portfel/services/optymalizacjaPodatkowa.ts';

test('zmiany ustawień z dwóch kart scalają różne pola na świeżym magazynie', () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } });
  zapiszZmianeUstawien({ ...USTAWIENIA_DOMYSLNE });
  // Karta A wybiera plan; karta B nadal ma stary render i zmienia tylko odsetki.
  zapiszZmianeUstawien({ plan: 'conservative_user' });
  zapiszZmianeUstawien({ odsetki: false });
  const final = odczytajUstawienia();
  assert.equal(final.plan, 'conservative_user');
  assert.equal(final.odsetki, false);
});

test('import CSV wiąże rachunek po ID, potem po jednoznacznej nazwie i wykrywa nieznany', () => {
  const accounts = [{ id: 'a1', name: 'Rachunek A' }, { id: 'b2', name: 'Rachunek B' }] as any;
  assert.equal(resolveCsvAccountId(accounts, 'b2', 'Rachunek A'), 'b2');
  assert.equal(resolveCsvAccountId(accounts, 'stare-id', 'Rachunek A'), 'a1');
  assert.equal(resolveCsvAccountId(accounts, 'stare-id', 'Nieznany'), null);
});

test('tożsamość importowanej transakcji uwzględnia pełny czas i prowizję', () => {
  const base = buildImportTransactionIdentity('account', '', '2026-01-02 10:15:00', 'ABC', 'BUY', 2, 10, 'USD', 1);
  const differentTime = buildImportTransactionIdentity('account', '', '2026-01-02 10:15:01', 'ABC', 'BUY', 2, 10, 'USD', 1);
  const differentCommission = buildImportTransactionIdentity('account', '', '2026-01-02 10:15:00', 'ABC', 'BUY', 2, 10, 'USD', 2);

  assert.notEqual(differentTime, base);
  assert.notEqual(differentCommission, base);
  assert.notEqual(createImportTransactionId(base, new Map()), createImportTransactionId(differentTime, new Map()));
});

test('tożsamość importowanej transakcji używa identyfikatora brokera', () => {
  const withBrokerId = buildImportTransactionIdentity('account', 'order-123', '2026-01-02 10:15:00', 'ABC', 'BUY', 2, 10, 'USD', 1);
  assert.equal(
    withBrokerId,
    buildImportTransactionIdentity('account', 'order-123', '2026-01-03 11:00:00', 'XYZ', 'SELL', 4, 20, 'EUR', 2),
  );
});

test('polska kolumna "Typ instrumentu" nie staje sie tickerem ani rodzajem operacji', () => {
  const naglowek = ['typ instrumentu', 'symbol', 'data', 'typ', 'ilość', 'cena', 'waluta'];
  assert.deepEqual(kolumnyInstrumentuCsv(naglowek), { instrumentClassCol: 0, tickerCol: 1, typeCol: 3 });
  const angielski = ['asset class', 'instrument', 'date', 'side', 'qty', 'price', 'currency'];
  assert.deepEqual(kolumnyInstrumentuCsv(angielski), { instrumentClassCol: 0, tickerCol: 1, typeCol: 3 });
  const bezKlasy = ['symbol', 'date', 'type', 'qty'];
  assert.deepEqual(kolumnyInstrumentuCsv(bezKlasy), { instrumentClassCol: -1, tickerCol: 0, typeCol: 2 });
});

test('druga kolumna klasy instrumentu tez nie zostaje tickerem', () => {
  const naglowek = ['asset class', 'instrument type', 'symbol', 'side'];
  assert.deepEqual(kolumnyInstrumentuCsv(naglowek), { instrumentClassCol: 0, tickerCol: 2, typeCol: 3 });
});
