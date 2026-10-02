import test from 'node:test';
import assert from 'node:assert/strict';

import { przygotujKopiePrzedCzyszczeniem } from '../../../aplikacje/web/src/invest_analyzer/services/kopiaPrzedCzyszczeniem.ts';

test('zapisana kopia pozwala czyscic bez pytania', async () => {
  let pytania = 0;
  const wynik = await przygotujKopiePrzedCzyszczeniem({
    collect: async () => 'stan',
    write: async () => ({ id: 'kopia-1' }),
    potwierdzBezKopii: () => { pytania += 1; return true; },
  });
  assert.deepEqual({ kontynuuj: wynik.kontynuuj, idKopii: wynik.idKopii }, { kontynuuj: true, idKopii: 'kopia-1' });
  assert.equal(pytania, 0);
});

test('blad zapisu kopii bez zgody uzytkownika przerywa czyszczenie', async () => {
  const tresci: string[] = [];
  const wynik = await przygotujKopiePrzedCzyszczeniem({
    collect: async () => 'stan',
    write: async () => { throw new Error('brak miejsca'); },
    potwierdzBezKopii: (tresc) => { tresci.push(tresc); return false; },
  });
  assert.equal(wynik.kontynuuj, false);
  assert.equal(wynik.idKopii, null);
  assert.equal(tresci.length, 1);
  assert.match(tresci[0], /brak miejsca/);
  assert.match(tresci[0], /BEZ kopii/);
});

test('blad zbierania stanu tez wymaga jawnej zgody; zgoda pozwala czyscic bez kopii', async () => {
  const wynik = await przygotujKopiePrzedCzyszczeniem({
    collect: async () => { throw new Error('nie da sie odczytac'); },
    write: async () => ({ id: 'x' }),
    potwierdzBezKopii: () => true,
  });
  assert.equal(wynik.kontynuuj, true);
  assert.equal(wynik.idKopii, null);
  assert.ok(wynik.blad instanceof Error);
});

test('kopia z pominietymi kluczami jest niepelna: czyszczenie wymaga osobnej zgody z lista kluczy', async () => {
  const tresci: string[] = [];
  const zapisane: unknown[] = [];
  const dane = { skippedKeys: ['klucz-a', 'klucz-b'] };
  const odmowa = await przygotujKopiePrzedCzyszczeniem({
    collect: async () => dane,
    write: async (kopia) => { zapisane.push(kopia); return { id: 'niepelna-1' }; },
    potwierdzBezKopii: (tresc) => { tresci.push(tresc); return false; },
  });
  assert.equal(odmowa.kontynuuj, false);
  assert.equal(tresci.length, 1);
  assert.match(tresci[0], /klucz-a, klucz-b/);
  assert.match(tresci[0], /niepełna/);
  assert.equal(zapisane.length, 1);

  const zgoda = await przygotujKopiePrzedCzyszczeniem({
    collect: async () => dane,
    write: async () => ({ id: 'niepelna-2' }),
    potwierdzBezKopii: () => true,
  });
  assert.equal(zgoda.kontynuuj, true);
  assert.deepEqual(zgoda.pominieteKlucze, ['klucz-a', 'klucz-b']);

  const pusta = await przygotujKopiePrzedCzyszczeniem({
    collect: async () => ({ skippedKeys: [] }),
    write: async () => ({ id: 'ok' }),
    potwierdzBezKopii: () => { throw new Error('nie powinno pytac'); },
  });
  assert.equal(pusta.kontynuuj, true);
});
