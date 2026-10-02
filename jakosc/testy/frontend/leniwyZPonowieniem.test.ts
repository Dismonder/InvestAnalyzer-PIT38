import test from 'node:test';
import assert from 'node:assert/strict';
import React, { Suspense, lazy, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { leniwyZPonowieniem, zwolnijOdrzuconeLeniwe } from '../../../aplikacje/web/src/shared/leniwyZPonowieniem.tsx';

const Okno: ComponentType<{ tytul: string }> = ({ tytul }) => React.createElement('p', null, `okno: ${tytul}`);

/** Import, ktory zawodzi zadana liczbe razy (serwer w trakcie restartu), a potem dziala. */
function importerZAwariami(awarie: number) {
  const stan = { wywolania: 0, obietnice: [] as Promise<unknown>[] };
  const importer = () => {
    stan.wywolania += 1;
    const obietnica = stan.wywolania <= awarie
      ? Promise.reject(new TypeError('Failed to fetch dynamically imported module'))
      : Promise.resolve({ default: Okno });
    stan.obietnice.push(obietnica.catch(() => undefined));
    return obietnica;
  };
  return { stan, importer };
}

/** Czeka, az obietnice importu i lancuch lazy (then/catch - jedna kolejka pozniej) sie ustala. */
async function ustal(obietnice: Promise<unknown>[]): Promise<void> {
  await Promise.all(obietnice);
  await new Promise((r) => setTimeout(r, 0));
}

/** Renderuje pod Suspense; blad w poddrzewie Suspense serwer oddaje po cichu jako fallback. */
function wyrenderuj(Komponent: ComponentType<{ tytul: string }>): { html: string } {
  return {
    html: renderToStaticMarkup(
      React.createElement(Suspense, { fallback: 'ładowanie' }, React.createElement(Komponent, { tytul: 'ulubione' })),
    ),
  };
}

test('odrzucenie zostaje do zwolnienia przez granicę, potem paczka jest pobierana od nowa, a udane pobranie zapamiętane', async () => {
  const { stan, importer } = importerZAwariami(1);
  const Ponawialne = leniwyZPonowieniem(importer);

  assert.equal(wyrenderuj(Ponawialne).html, 'ładowanie');
  await ustal(stan.obietnice);
  assert.equal(stan.wywolania, 1);

  // React renderuje zawieszone poddrzewo ponownie zaraz po odrzuceniu: ma dostac
  // blad (dla granicy), a nie nowe pobranie - inaczej okno "wczytuje sie" bez konca.
  // Bez Suspense render serwerowy rzuca blad odrzuconego komponentu wprost.
  assert.throws(
    () => renderToStaticMarkup(React.createElement(Ponawialne, { tytul: 'ulubione' })),
    /Failed to fetch dynamically imported module/,
  );
  assert.equal(wyrenderuj(Ponawialne).html, 'ładowanie', 'pod Suspense serwer oddaje fallback zamiast bledu');
  assert.equal(stan.wywolania, 1, 'bez zwolnienia nie ma nowej proby pobrania');

  // Granica przyjela blad; nastepne otwarcie pobiera paczke od nowa.
  zwolnijOdrzuconeLeniwe();
  assert.equal(wyrenderuj(Ponawialne).html, 'ładowanie');
  await ustal(stan.obietnice);
  assert.equal(stan.wywolania, 2);

  assert.equal(wyrenderuj(Ponawialne).html, '<p>okno: ulubione</p>');
  zwolnijOdrzuconeLeniwe();
  assert.equal(wyrenderuj(Ponawialne).html, '<p>okno: ulubione</p>');
  assert.equal(stan.wywolania, 2, 'udany import nie jest powtarzany, takze po zwolnieniu odrzucen');
});

test('kontrast: zwykłe React.lazy po jednej awarii nie próbuje już pobrać paczki', async () => {
  const { stan, importer } = importerZAwariami(1);
  const Zwykle = lazy(importer);

  wyrenderuj(Zwykle);
  await ustal(stan.obietnice);
  wyrenderuj(Zwykle);
  await ustal(stan.obietnice);
  assert.equal(stan.wywolania, 1);
});

test('ponowienie idzie pod adres z dopiskiem, bo przeglądarka pamięta nieudane pobranie tego samego adresu', async () => {
  const { adresPaczkiZBledu, adresPonowienia, ustawImportZAdresuDoTestow } = await import('../../../aplikacje/web/src/shared/leniwyZPonowieniem.tsx');
  assert.equal(
    adresPaczkiZBledu(new TypeError('Failed to fetch dynamically imported module: http://localhost:4173/assets/Okno-Ab12.js')),
    'http://localhost:4173/assets/Okno-Ab12.js',
  );
  assert.equal(adresPaczkiZBledu(new TypeError('Importing a module script failed.')), null, 'Safari nie podaje adresu');
  assert.match(adresPonowienia('http://x/assets/Okno-Ab12.js', 7), /^http:\/\/x\/assets\/Okno-Ab12\.js\?ponow=7$/);
  assert.match(adresPonowienia('http://x/assets/Okno-Ab12.js?ponow=7', 9), /^http:\/\/x\/assets\/Okno-Ab12\.js\?ponow=9$/, 'bez piętrzenia dopisków');

  const adresy: string[] = [];
  ustawImportZAdresuDoTestow(async (adres) => { adresy.push(adres); return { Okno }; });
  try {
    const stan = { wywolania: 0 };
    const importer = () => {
      stan.wywolania += 1;
      return Promise.reject(new TypeError('Failed to fetch dynamically imported module: http://x/assets/Okno-Ab12.js'));
    };
    const Ponawialne = leniwyZPonowieniem(importer, (modul: { Okno: typeof Okno }) => modul.Okno);
    assert.equal(wyrenderuj(Ponawialne).html, 'ładowanie');
    await new Promise((r) => setTimeout(r, 0));
    zwolnijOdrzuconeLeniwe();
    assert.equal(wyrenderuj(Ponawialne).html, 'ładowanie');
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(wyrenderuj(Ponawialne).html, '<p>okno: ulubione</p>', 'wybor eksportu dziala takze przy ponowieniu');
    assert.equal(stan.wywolania, 1, 'pierwotny importer nie jest powtarzany - adres jest juz zapamietany jako nieudany');
    assert.equal(adresy.length, 1);
    assert.match(adresy[0], /^http:\/\/x\/assets\/Okno-Ab12\.js\?ponow=\d+$/);
  } finally {
    ustawImportZAdresuDoTestow(null);
  }
});
