/**
 * Skan tekstu pod katem poswiadczen wpisanych w kod (klucze API, tokeny, hasla,
 * klucze prywatne). Wspolne zrodlo dla bramki assert-no-private-data.mjs i testu.
 *
 * Wynik nigdy nie zawiera samej wartosci: tylko numer linii, nazwe klucza i
 * zamaskowany poczatek, zeby raport bramki nie stal sie kolejnym wyciekiem.
 */

/** Nazwy kluczy, ktorych wartosc przypisana w kodzie jest podejrzana. */
const NAZWA_KLUCZA =
  '(?:[A-Za-z0-9_]*(?:api[_-]?key|api[_-]?secret|secret|token|password|passwd|query[_-]?id|private[_-]?key|(?:security|access|auth)[_-]?key)[A-Za-z0-9_]*|sid)';

/** Przypisanie `klucz: 'wartosc'` / `klucz = "wartosc"` z wartoscia >= 24 znakow base64/hex/url-safe. */
const PRZYPISANIE = new RegExp(
  String.raw`(?<![A-Za-z0-9_])(${NAZWA_KLUCZA})["']?\s*[:=]\s*["']([A-Za-z0-9+/=_-]{24,})["']`,
  'gi',
);

/** Naglowek klucza API Binance z literalem zamiast zmiennej. */
const NAGLOWEK_BINANCE = /X-MBX-APIKEY["']?\s*[:=,]\s*["']([A-Za-z0-9]{20,})["']/gi;

/**
 * Zapis bez cudzyslowu (.env): KLUCZ=wartosc na poczatku linii, bez spacji wokol =, z wartoscia zawierajaca cyfre
 * (identyfikator zmiennej albo \ nie jest poswiadczeniem).
 */
const PRZYPISANIE_ENV = new RegExp(
  String.raw`^\s*(?:export\s+)?(${NAZWA_KLUCZA})=(?=[^\s#]*\d)([A-Za-z0-9+/=_-]{24,})\s*(?:#.*)?$`,
  'gi',
);

/** Poswiadczenie w adresie: ?token=..., &api_key=..., ?t=... (wartosc >= 24 znaki z cyfra). */
const PARAMETR_URL = new RegExp(
  String.raw`(?<=[?&])(${NAZWA_KLUCZA}|t)=(?=[A-Za-z0-9+/_-]*\d)([A-Za-z0-9+/_-]{24,})`,
  'gi',
);

const KLUCZ_PEM = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/;

/**
 * Wartosci, ktore sa oczywistymi atrapami (jawna lista wyjatkow): zawieraja slowo
 * z listy albo sa powtorzeniem kilku znakow. Prawdziwy klucz ma wiele roznych znakow.
 */
const ZNACZNIKI_ATRAP = ['test', 'dummy', 'example', 'xxx', 'fake', 'sample', 'placeholder', 'changeme', 'sekret', 'twoj'];
const MIN_ROZNYCH_ZNAKOW = 8;

function jestAtrapa(wartosc) {
  const male = wartosc.toLowerCase();
  if (ZNACZNIKI_ATRAP.some((znacznik) => male.includes(znacznik))) return true;
  return new Set(wartosc).size < MIN_ROZNYCH_ZNAKOW;
}

const maska = (wartosc) => `${wartosc.slice(0, 3)}***(${wartosc.length} zn.)`;

const DLUGOSC_OKNA = 2000;
const NAKLADKA_OKIEN = 400;

/** Opis pierwszego znaleziska w jednym fragmencie tekstu (linia albo okno linii) albo null. */
function opisZnaleziska(fragment) {
  if (KLUCZ_PEM.test(fragment)) return 'klucz prywatny PEM';
  const znajdzNieAtrape = (wzorzec, grupaWartosci = 2) => {
    wzorzec.lastIndex = 0;
    let dopasowanie;
    while ((dopasowanie = wzorzec.exec(fragment)) !== null) {
      if (!jestAtrapa(dopasowanie[grupaWartosci])) return dopasowanie;
    }
    return null;
  };
  const przypisanie = znajdzNieAtrape(PRZYPISANIE);
  if (przypisanie) return `przypisanie do "${przypisanie[1]}": ${maska(przypisanie[2])}`;
  const naglowek = znajdzNieAtrape(NAGLOWEK_BINANCE, 1);
  if (naglowek) return `naglowek X-MBX-APIKEY z literalem: ${maska(naglowek[1])}`;
  const env = znajdzNieAtrape(PRZYPISANIE_ENV);
  if (env) return `zapis bez cudzyslowu "${env[1]}": ${maska(env[2])}`;
  const url = znajdzNieAtrape(PARAMETR_URL);
  if (url) return `parametr "${url[1]}" w adresie: ${maska(url[2])}`;
  return null;
}

/**
 * Zwraca liste znalezisk: { linia, opis } - bez samej wartosci poswiadczenia.
 * Dluga linia (zminifikowany plik) jest skanowana oknami z nakladka, a nie pomijana;
 * wartosc przypisana w nastepnej linii (`klucz =` i wartosc nizej) jest laczona z linia klucza.
 */
export function znajdzPoswiadczeniaWTekscie(tekst) {
  const znaleziska = [];
  const linie = tekst.split(/\r?\n/);
  for (let indeks = 0; indeks < linie.length; indeks += 1) {
    const linia = linie[indeks];
    let opis = null;
    if (linia.length > DLUGOSC_OKNA) {
      for (let start = 0; start < linia.length && !opis; start += DLUGOSC_OKNA - NAKLADKA_OKIEN) {
        opis = opisZnaleziska(linia.slice(start, start + DLUGOSC_OKNA));
      }
    } else {
      opis = opisZnaleziska(linia);
      if (!opis && /[:=]\s*$/.test(linia) && indeks + 1 < linie.length && linie[indeks + 1].length <= DLUGOSC_OKNA) {
        opis = opisZnaleziska(`${linia} ${linie[indeks + 1].trim()}`);
      }
    }
    if (opis) znaleziska.push({ linia: indeks + 1, opis });
  }
  return znaleziska;
}
