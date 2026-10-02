import test from 'node:test';
import assert from 'node:assert/strict';
import { KOMUNIKAT_NIEDOSTEPNE_W_HOSTINGU, czyOdmowaHostingu } from '../../../aplikacje/web/src/shared/kodyHostingu.ts';

test('odmowa hostingu jest rozpoznawana po tresci, ktora engineBridge opakowuje w swoj komunikat', () => {
  assert.equal(czyOdmowaHostingu(`Silnik zwrócił błąd: ${KOMUNIKAT_NIEDOSTEPNE_W_HOSTINGU}`), true);
  assert.equal(czyOdmowaHostingu('NIEDOSTEPNE_W_HOSTINGU'), true);
});

test('zwykla awaria silnika albo sieci nie jest odmowa hostingu', () => {
  assert.equal(czyOdmowaHostingu('Failed to fetch'), false);
  assert.equal(czyOdmowaHostingu('Silnik zwrócił błąd: brak pliku'), false);
  assert.equal(czyOdmowaHostingu(null), false);
  assert.equal(czyOdmowaHostingu(undefined), false);
});
