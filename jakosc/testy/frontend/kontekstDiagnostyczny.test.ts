/**
 * "Skopiuj kontekst diagnostyczny" trafia do schowka i zwykle do zewnetrznego AI,
 * wiec nie moze niesc nazw wyciagow (zdradzaja brokera, konto, okres) ani tresci logow.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { zbudujKontekstDiagnostyczny } from '../../../aplikacje/web/src/invest_analyzer/services/kontekstDiagnostyczny.ts';

const pliki = [
  { name: 'Wyciag_IBKR_U1234567_2025.xlsx', recordCount: 120, isEnabled: true },
  { name: 'C:\\Users\\TestUser\\Downloads\\freedom24 raport.PDF', recordCount: 0, isEnabled: false },
  { name: 'bez-rozszerzenia', recordCount: 3 },
];
const logi = [
  { displayLevel: 'error' as const, stage: 'AUTO_IMPORT', userFacingKind: 'blocking_error', displayMessage: 'Błąd importu pliku Wyciag_IBKR_U1234567_2025.xlsx: amount=1234,56' },
  { displayLevel: 'warn' as const, stage: 'NBP', userFacingKind: 'action_required', displayMessage: 'Brak kursu USD 2025-03-01 dla C:\\Users\\TestUser\\x.csv' },
];
const etykieta = (stage: string) => `Etap ${stage}`;

test('domyślnie nazwy plików to identyfikatory z rozszerzeniem, a logi tylko poziomy i etapy', () => {
  const tekst = zbudujKontekstDiagnostyczny({ taxPlan: 'defensible', files: pliki, logs: logi, formatStage: etykieta });
  for (const wyciek of ['IBKR', 'U1234567', 'freedom24', 'TestUser', '1234,56', 'Brak kursu', 'Wyciag']) {
    assert.ok(!tekst.includes(wyciek), `kontekst zawiera: ${wyciek}\n${tekst}`);
  }
  assert.match(tekst, /plik-1\.xlsx \(120 rekordów, aktywny\)/);
  assert.match(tekst, /plik-2\.pdf \(0 rekordów, wyłączony\)/);
  assert.match(tekst, /plik-3 \(3 rekordy, aktywny\)/);
  assert.match(tekst, /\[error\] Etap AUTO_IMPORT \(blocking_error\)/);
  assert.match(tekst, /\[warn\] Etap NBP \(action_required\)/);
  assert.match(tekst, /Plan podatkowy: defensible/);
});

test('jawne nazwy plików tylko na wyraźne żądanie, logi nadal bez treści', () => {
  const tekst = zbudujKontekstDiagnostyczny({ taxPlan: 'x', files: pliki, logs: logi, formatStage: etykieta, jawneNazwyPlikow: true });
  assert.ok(tekst.includes('Wyciag_IBKR_U1234567_2025.xlsx'));
  assert.ok(!tekst.includes('1234,56'));
});

test('brak plików i logów daje "brak"', () => {
  const tekst = zbudujKontekstDiagnostyczny({ taxPlan: 'x', files: [], logs: [], formatStage: etykieta });
  assert.match(tekst, /Pliki bazowe: brak/);
  assert.match(tekst, /Ostatnie logi: brak/);
});
