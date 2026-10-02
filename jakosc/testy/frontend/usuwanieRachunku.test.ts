import test from 'node:test';
import assert from 'node:assert/strict';

import { trescPotwierdzeniaUsunieciaRachunku } from '../../../aplikacje/web/src/portfel/services/usuwanieRachunku.ts';

test('potwierdzenie usuniecia rachunku podaje liczbe transakcji i skutek dla PIT-8C', () => {
  const tresc = trescPotwierdzeniaUsunieciaRachunku('Dom; makler', 12);
  assert.ok(tresc.includes('Dom; makler'));
  assert.ok(tresc.includes('12'));
  assert.ok(tresc.includes('pozostaną w historii bez rachunku'));
  assert.ok(tresc.includes('PIT-8C'));
});

test('rachunek bez transakcji dostaje krotkie potwierdzenie', () => {
  const tresc = trescPotwierdzeniaUsunieciaRachunku('Pusty', 0);
  assert.ok(tresc.includes('nie ma powiązanych transakcji'));
  assert.ok(!tresc.includes('PIT-8C'));
});
