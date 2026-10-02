/**
 * Bezpieczny odczyt stanu z magazynu przegladarki.
 *
 * Jeden uszkodzony wpis - przerwany zapis, reczna edycja w narzedziach
 * przegladarki, zmiana formatu miedzy wersjami - wywracal aplikacje przy
 * pierwszym renderze. Uzytkownik widzial bialy ekran bez wyjscia.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  odczytajZMagazynu,
  jestTablicaWpisow,
  jestObiektem,
  obserwujBledyZapisu,
  zapiszWMagazynie,
  stworzSynchronizatorListy,
} from '../../../aplikacje/web/src/portfel/services/magazynPrzegladarki.ts';

function podstawMagazyn(): Map<string, string> {
  const dane = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (klucz: string) => dane.get(klucz) ?? null,
    setItem: (klucz: string, wartosc: string) => {
      dane.set(klucz, String(wartosc));
    },
    removeItem: (klucz: string) => {
      dane.delete(klucz);
    },
    clear: () => dane.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
  return dane;
}

test('brak wpisu daje wartosc domyslna', () => {
  podstawMagazyn();
  assert.deepEqual(odczytajZMagazynu('nie-ma', [1], (w): w is number[] => Array.isArray(w)), [1]);
});

test('poprawny wpis jest zwracany', () => {
  const dane = podstawMagazyn();
  dane.set('lista', JSON.stringify([{ id: 'a' }]));
  assert.deepEqual(odczytajZMagazynu('lista', [], jestTablicaWpisow), [{ id: 'a' }]);
});

test('uszkodzony JSON nie wywraca odczytu', () => {
  const dane = podstawMagazyn();
  dane.set('lista', '{to nie jest json');
  assert.deepEqual(odczytajZMagazynu('lista', [], jestTablicaWpisow), []);
});

test('uszkodzony wpis jest odkladany na bok, a nie kasowany', () => {
  const dane = podstawMagazyn();
  dane.set('lista', '{uszkodzone');
  odczytajZMagazynu('lista', [], jestTablicaWpisow);
  assert.equal(dane.get('lista:uszkodzony'), '{uszkodzone', 'ma sie dac obejrzec, co bylo zapisane');
});

test('poprawny JSON o zlym ksztalcie tez jest odrzucany', () => {
  // Obiekt tam, gdzie kod oczekuje tablicy, wywracal aplikacje dopiero przy
  // pierwszym .filter - czyli w losowym miejscu, daleko od przyczyny.
  const dane = podstawMagazyn();
  dane.set('lista', JSON.stringify({ nie: 'tablica' }));
  assert.deepEqual(odczytajZMagazynu('lista', [], jestTablicaWpisow), []);
});

test('tablica bez identyfikatorow jest odrzucana', () => {
  const dane = podstawMagazyn();
  dane.set('lista', JSON.stringify([{ brak: 'id' }]));
  assert.deepEqual(odczytajZMagazynu('lista', [], jestTablicaWpisow), []);
});

test('rozpoznawanie ksztaltow', () => {
  assert.equal(jestTablicaWpisow([{ id: 'x' }]), true);
  assert.equal(jestTablicaWpisow([{ id: 5 }]), false);
  assert.equal(jestTablicaWpisow(null), false);
  assert.equal(jestObiektem({ a: 1 }), true);
  assert.equal(jestObiektem([]), false);
  assert.equal(jestObiektem(null), false);
});

test('brak magazynu w srodowisku nie wywraca odczytu', () => {
  delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
  assert.deepEqual(odczytajZMagazynu('cokolwiek', ['domyslna'], (w): w is string[] => Array.isArray(w)), [
    'domyslna',
  ]);
});

test('QuotaExceededError zgłasza jedną serię błędów i pozwala ponowić zapis', () => {
  const dane = podstawMagazyn();
  let pelny = true;
  const magazyn = globalThis.localStorage;
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    ...magazyn,
    setItem: (klucz: string, wartosc: string) => {
      if (pelny) throw new DOMException('Pełny magazyn', 'QuotaExceededError');
      dane.set(klucz, wartosc);
    },
  } as Storage;
  let ostrzezenia = 0;
  const stop = obserwujBledyZapisu(() => { ostrzezenia += 1; });
  try {
    assert.equal(zapiszWMagazynie('pit38_transactions', [{ id: 'a' }]), false);
    assert.equal(zapiszWMagazynie('pit38_accounts', [{ id: 'b' }]), false);
    assert.equal(ostrzezenia, 1);
    pelny = false;
    assert.equal(zapiszWMagazynie('pit38_transactions', [{ id: 'a' }]), true);
    assert.equal(zapiszWMagazynie('pit38_accounts', [{ id: 'b' }]), true);
    pelny = true;
    assert.equal(zapiszWMagazynie('pit38_alerts', [{ id: 'c' }]), false);
    assert.equal(ostrzezenia, 2);
    pelny = false;
    assert.equal(zapiszWMagazynie('pit38_alerts', [{ id: 'c' }]), true);
  } finally { stop(); }
});

test('dwie karty scalają wpisy po id i zdarzenie storage nie powoduje kolejnego zapisu', () => {
  const dane = podstawMagazyn();
  let zapisy = 0;
  const magazyn = globalThis.localStorage;
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    ...magazyn,
    setItem: (klucz: string, wartosc: string) => {
      zapisy += 1;
      dane.set(klucz, wartosc);
    },
  } as Storage;
  const a: Array<{ id: string }> = [];
  const b: Array<{ id: string }> = [];
  const kartaA = stworzSynchronizatorListy('pit38_transactions', a, (lista) => { a.splice(0, a.length, ...lista); });
  const kartaB = stworzSynchronizatorListy('pit38_transactions', b, (lista) => { b.splice(0, b.length, ...lista); });
  kartaA.zmiana([{ id: 'a' }]);
  kartaB.zmiana([{ id: 'b' }]);
  assert.equal(zapisy, 2);
  assert.deepEqual(JSON.parse(dane.get('pit38_transactions')!), [{ id: 'a' }, { id: 'b' }]);
  kartaA.zdarzenie(dane.get('pit38_transactions')!);
  assert.deepEqual(a, [{ id: 'a' }, { id: 'b' }]);
  assert.deepEqual(JSON.parse(dane.get('pit38_transactions')!), [{ id: 'a' }, { id: 'b' }]);
  kartaB.zdarzenie(dane.get('pit38_transactions')!);
  assert.deepEqual(b, [{ id: 'a' }, { id: 'b' }]);
  assert.equal(zapisy, 2, 'odbiór storage nie zapisuje ponownie do magazynu');
});

test('odfiltrowany przy odczycie wpis demonstracyjny nie wraca przy pierwszej zmianie', () => {
  const dane = podstawMagazyn();
  // Starsza wersja zostawila w magazynie transakcje demonstracyjna; aplikacja
  // odfiltrowuje ja przy odczycie i pracuje na liscie bez niej.
  dane.set('pit38_transactions', JSON.stringify([{ id: 'tx_demo_1' }, { id: 'prawdziwa' }]));
  const lista: Array<{ id: string }> = [{ id: 'prawdziwa' }];
  const bezDemo = (wpisy: Array<{ id: string }>) => wpisy.filter((wpis) => !wpis.id.startsWith('tx_demo'));
  const karta = stworzSynchronizatorListy('pit38_transactions', lista, (nowa) => { lista.splice(0, lista.length, ...nowa); }, bezDemo);
  karta.wyrownaj();
  assert.deepEqual(JSON.parse(dane.get('pit38_transactions') ?? '[]'), [{ id: 'prawdziwa' }]);

  karta.zmiana([{ id: 'prawdziwa' }, { id: 'nowa' }]);
  const zapisane = JSON.parse(dane.get('pit38_transactions') ?? '[]') as Array<{ id: string }>;
  assert.deepEqual(zapisane.map((wpis) => wpis.id).sort(), ['nowa', 'prawdziwa'], 'demo nie może wrócić do rozliczenia');
});

test('wyrównanie przy montowaniu nie kasuje wpisu dodanego w innej karcie w międzyczasie', () => {
  const dane = podstawMagazyn();
  // Karta odczytała [a] przy renderowaniu; zanim ruszył efekt, druga karta dopisała b.
  dane.set('pit38_transactions', JSON.stringify([{ id: 'a' }, { id: 'b' }]));
  const lista: Array<{ id: string }> = [{ id: 'a' }];
  const bezDemo = (wpisy: Array<{ id: string }>) => wpisy.filter((wpis) => !wpis.id.startsWith('tx_demo'));
  const karta = stworzSynchronizatorListy('pit38_transactions', lista, (nowa) => { lista.splice(0, lista.length, ...nowa); }, bezDemo);
  karta.wyrownaj();
  assert.deepEqual(JSON.parse(dane.get('pit38_transactions') ?? '[]'), [{ id: 'a' }, { id: 'b' }]);
  assert.deepEqual(lista, [{ id: 'a' }, { id: 'b' }], 'karta widzi wpis z drugiej karty');
});
