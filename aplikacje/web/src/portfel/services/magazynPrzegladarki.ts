/**
 * Bezpieczny odczyt stanu z magazynu przegladarki.
 *
 * Stan aplikacji wraca po starcie z localStorage. Dotad czesc odczytow szla
 * przez goly JSON.parse: wystarczyl jeden uszkodzony wpis - przerwany zapis,
 * reczna edycja w narzedziach przegladarki, zmiana formatu miedzy wersjami -
 * i aplikacja wywracala sie przy pierwszym renderze. Uzytkownik widzial bialy
 * ekran i nie mial jak z niego wyjsc bez czyszczenia magazynu recznie.
 *
 * Tutaj kazdy odczyt konczy sie wartoscia uzyteczna: albo zapisanym stanem,
 * albo wartoscia domyslna. Uszkodzony wpis jest odkladany na bok pod nazwa
 * z sufiksem, zeby dalo sie go obejrzec, zamiast kasowac bez sladu.
 */

import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';

export const SUFIKS_USZKODZONEGO = ':uszkodzony';

/**
 * Klucze, ktorych nie udalo sie odczytac w tej sesji.
 *
 * Bez tego cala lista transakcji uszkodzona w magazynie przegladarki znikala
 * po cichu: aplikacja startowala z pusta lista, rozliczenie pokazywalo 0,00 zl,
 * a jedyny slad zostawal w konsoli. Tresc jest odkladana pod klucz z sufiksem,
 * wiec da sie ja odzyskac - uzytkownik musi sie tylko o tym dowiedziec.
 */
export const uszkodzoneWpisyMagazynu: Array<{ klucz: string; powod: string }> = [];

function zapamietajUszkodzony(klucz: string, powod: string): void {
  if (!uszkodzoneWpisyMagazynu.some((wpis) => wpis.klucz === klucz)) {
    uszkodzoneWpisyMagazynu.push({ klucz, powod });
  }
}

function odloz(klucz: string, tresc: string): void {
  try {
    localStorage.setItem(`${klucz}${SUFIKS_USZKODZONEGO}`, tresc.slice(0, 100_000));
  } catch {
    // Brak miejsca w magazynie nie moze blokowac startu aplikacji.
  }
}

/**
 * Odczytuje wartosc z magazynu i sprawdza jej ksztalt.
 *
 * @param walidator Zwraca true, gdy odczyt nadaje sie do uzycia. Sam parser
 *   JSON tu nie wystarcza: zapis moze byc poprawnym JSON-em i jednoczescie
 *   miec zly ksztalt (obiekt tam, gdzie kod oczekuje tablicy), a wtedy
 *   aplikacja wywraca sie dopiero przy pierwszym .filter albo .map.
 */
export function odczytajZMagazynu<T>(
  klucz: string,
  domyslna: T,
  walidator: (wartosc: unknown) => wartosc is T
): T {
  let surowa: string | null = null;
  try {
    surowa = localStorage.getItem(klucz);
  } catch {
    return domyslna;
  }
  if (surowa === null) {
    return domyslna;
  }

  let odczyt: unknown;
  try {
    odczyt = JSON.parse(surowa);
  } catch {
    odloz(klucz, surowa);
    zapamietajUszkodzony(klucz, 'zapis nie jest poprawnym JSON-em');
    console.warn(`Wpis ${klucz} w magazynie przeglądarki jest uszkodzony i został pominięty.`);
    return domyslna;
  }

  if (!walidator(odczyt)) {
    odloz(klucz, surowa);
    zapamietajUszkodzony(klucz, 'zapis ma nieoczekiwany kształt');
    console.warn(`Wpis ${klucz} ma nieoczekiwany kształt i został pominięty.`);
    return domyslna;
  }
  return odczyt;
}

/** Tablica obiektow z polem id - wspolny ksztalt list w tej aplikacji. */
export function jestTablicaWpisow(wartosc: unknown): wartosc is Array<{ id: string }> {
  return (
    Array.isArray(wartosc) &&
    wartosc.every(
      (element) =>
        element !== null &&
        typeof element === 'object' &&
        typeof (element as { id?: unknown }).id === 'string'
    )
  );
}

/** Zwykly obiekt, ktory nie jest tablica ani wartoscia pusta. */
export function jestObiektem(wartosc: unknown): wartosc is Record<string, unknown> {
  return typeof wartosc === 'object' && wartosc !== null && !Array.isArray(wartosc);
}

/**
 * Zapisuje wartosc do magazynu, nie wywracajac aplikacji.
 *
 * `localStorage.setItem` rzuca, gdy magazyn odmawia zapisu: pelen limit
 * (rejestr transakcji i wynik silnika potrafia go wypelnic), tryb prywatny,
 * zablokowane dane witryny. Wyjatek rzucony w efekcie Reacta idzie do granicy
 * bledu i gasi caly ekran - utrata biezacego widoku za nieudany zapis to zla
 * zamiana.
 */
const sluchaczeBledu = new Set<(klucz: string) => void>();
const niezapisaneKlucze = new Set<string>();

export function obserwujBledyZapisu(sluchacz: (klucz: string) => void): () => void {
  sluchaczeBledu.add(sluchacz);
  return () => { sluchaczeBledu.delete(sluchacz); };
}

export function zapiszWMagazynie(klucz: string, wartosc: unknown): boolean {
  try {
    localStorage.setItem(klucz, typeof wartosc === 'string' ? wartosc : JSON.stringify(wartosc));
    niezapisaneKlucze.delete(klucz);
    return true;
  } catch {
    console.warn(`Nie udało się zapisać wpisu ${klucz} w magazynie przeglądarki.`);
    if (niezapisaneKlucze.size === 0) sluchaczeBledu.forEach((sluchacz) => sluchacz(klucz));
    niezapisaneKlucze.add(klucz);
    return false;
  }
}

type Wpis = { id: string };

/** Nakłada tylko lokalne zmiany od ostatniego odczytu na świeży stan magazynu. */
export function scalZmianyListy<T extends Wpis>(baza: T[], lokalne: T[], aktualne: T[]): T[] {
  const przed = new Map(baza.map((wpis) => [wpis.id, wpis]));
  const po = new Map(lokalne.map((wpis) => [wpis.id, wpis]));
  const wynik = new Map(aktualne.map((wpis) => [wpis.id, wpis]));
  for (const id of przed.keys()) if (!po.has(id)) wynik.delete(id);
  for (const [id, wpis] of po) {
    if (!przed.has(id) || JSON.stringify(przed.get(id)) !== JSON.stringify(wpis)) wynik.set(id, wpis);
  }
  return [...wynik.values()];
}

export function stworzSynchronizatorListy<T extends Wpis>(
  klucz: string, poczatkowa: T[], aktualizuj: (lista: T[]) => void,
  oczysc: (lista: T[]) => T[] = (lista) => lista,
) {
  let baza = poczatkowa;
  let biezaca = poczatkowa;
  const odczytaj = (): T[] | null => {
    try {
      const surowa = localStorage.getItem(klucz);
      if (surowa === null) return [];
      const wartosc: unknown = JSON.parse(surowa);
      return jestTablicaWpisow(wartosc) ? wartosc as T[] : null;
    } catch { return null; }
  };
  const zapisz = (lista: T[], nowaBaza: T[]) => {
    const wynik = scalZmianyListy(baza, lista, nowaBaza);
    if (zapiszWMagazynie(klucz, wynik)) {
      baza = wynik;
      biezaca = wynik;
      if (JSON.stringify(wynik) !== JSON.stringify(lista)) aktualizuj(wynik);
    }
  };
  return {
    /**
     * Stan poczatkowy bywa oczyszczony przy odczycie (bez wpisow demonstracyjnych
     * starszych wersji). Magazyn musi to oczyszczenie dostac od razu - inaczej
     * scalanie ze "swiezym" magazynem przywracaloby odfiltrowane wpisy jak dodane
     * w innej karcie, a z nimi fikcyjne transakcje trafialyby do rozliczenia.
     * Czyscimy SWIEZY odczyt tym samym filtrem, a nie zapisujemy listy z chwili
     * montowania - wpis dodany w innej karcie w miedzyczasie musi przetrwac.
     */
    wyrownaj() {
      const swieza = odczytaj();
      if (swieza === null) return;
      let oczyszczona: T[];
      try {
        oczyszczona = oczysc(swieza);
      } catch {
        return; // uszkodzony wpis - zostawiamy magazyn bez zmian
      }
      if (JSON.stringify(oczyszczona) !== JSON.stringify(swieza) && !zapiszWMagazynie(klucz, oczyszczona)) return;
      baza = oczyszczona;
      biezaca = oczyszczona;
      if (JSON.stringify(oczyszczona) !== JSON.stringify(poczatkowa)) aktualizuj(oczyszczona);
    },
    zmiana(lista: T[]) {
      biezaca = lista;
      const swieza = odczytaj();
      if (swieza === null) {
        // Nie nadpisuj nieczytelnego wpisu ani stanu, którego nie da się odczytać.
        if (niezapisaneKlucze.size === 0) sluchaczeBledu.forEach((sluchacz) => sluchacz(klucz));
        niezapisaneKlucze.add(klucz);
        return;
      }
      zapisz(lista, swieza);
    },
    zdarzenie(nowaWartosc: string | null, lokalna: T[] = biezaca) {
      let zdalna: T[];
      try {
        // Zdarzenie może być opóźnione względem kolejnego zapisu tej karty.
        const swieza = odczytaj();
        const parsed: unknown = swieza ?? (nowaWartosc === null ? [] : JSON.parse(nowaWartosc));
        if (!jestTablicaWpisow(parsed)) return;
        zdalna = parsed as T[];
      } catch { return; }
      biezaca = lokalna;
      if (JSON.stringify(biezaca) !== JSON.stringify(baza)) {
        zapisz(biezaca, zdalna);
      } else {
        baza = zdalna;
        biezaca = zdalna;
        aktualizuj(zdalna);
      }
    },
  };
}

export function useSynchronizowanaLista<T extends Wpis>(
  klucz: string, wartosc: T[], ustaw: Dispatch<SetStateAction<T[]>>,
  oczysc?: (lista: T[]) => T[],
): void {
  const poczatkowa = useRef(wartosc);
  const aktualna = useRef(wartosc);
  aktualna.current = wartosc;
  const pomin = useRef<T[] | null>(null);
  const synchronizator = useRef<ReturnType<typeof stworzSynchronizatorListy<T>> | null>(null);
  if (!synchronizator.current) {
    synchronizator.current = stworzSynchronizatorListy(klucz, wartosc, (lista) => {
      aktualna.current = lista;
      pomin.current = lista;
      ustaw(lista);
    }, oczysc);
  }
  useEffect(() => {
    synchronizator.current?.wyrownaj();
  }, [klucz]);
  useEffect(() => {
    if (wartosc === poczatkowa.current || wartosc === pomin.current) return;
    synchronizator.current?.zmiana(wartosc);
  }, [wartosc, klucz]);
  useEffect(() => {
    const odbierz = (event: StorageEvent) => {
      if (event.key === klucz) synchronizator.current?.zdarzenie(event.newValue, aktualna.current);
    };
    window.addEventListener('storage', odbierz);
    return () => window.removeEventListener('storage', odbierz);
  }, [klucz]);
}

/**
 * Utrwala stan listy w magazynie, pomijajac pierwszy render.
 *
 * Stan poczatkowy powstaje z odczytu magazynu, ktory po drodze odsiewa wpisy
 * (dane pokazowe ze starszych wersji, rekordy o zlym ksztalcie). Zapis w tym
 * samym obiegu utrwalal wynik odsiewu: jedno bledne dopasowanie filtra i dane
 * uzytkownika znikaly z magazynu na stale, bez zadnej jego decyzji. Pominiecie
 * pierwszego zapisu sprawia, ze magazyn zmienia sie dopiero wskutek realnej
 * zmiany - dodania, edycji, usuniecia albo importu.
 */
export function useZapisWMagazynie(klucz: string, wartosc: unknown): void {
  const wartoscPoczatkowa = useRef(wartosc);
  useEffect(() => {
    // Dopoki stan jest dokladnie tym, co wczytano z magazynu, nie ma czego
    // zapisywac. Porownanie referencji, a nie licznik renderow: React w trybie
    // scislym uruchamia efekt przy montowaniu dwa razy, wiec licznik zdazyl sie
    // wyzerowac juz przy pierwszym przebiegu i drugi utrwalal wynik odsiewu -
    // dokladnie to, przed czym ten strażnik mial chronic.
    if (wartosc === wartoscPoczatkowa.current) {
      return;
    }
    zapiszWMagazynie(klucz, wartosc);
  }, [klucz, wartosc]);
}
