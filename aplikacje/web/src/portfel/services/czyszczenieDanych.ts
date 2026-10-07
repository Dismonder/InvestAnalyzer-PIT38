/**
 * Pelne czyszczenie danych aplikacji w przegladarce („Wyczysc wszystko" w rachunkach
 * i Ustawienia → Dane). Przycisk obiecuje stan czysty, wiec usuwa wszystko, co
 * aplikacja zapisala w tym profilu przegladarki:
 *  - localStorage: rachunki (z kluczami API i sesjami brokera), transakcje, alerty,
 *    zlecenia, dane podatnika (PESEL, urzad), ustawienia rozliczenia i silnika,
 *    decyzje przegladu, nadpisania, kopie uszkodzonych wpisow - wszystkie klucze
 *    poza preferencjami wygladu;
 *  - sessionStorage: znacznik trybu hostingu i flagi przeladowania;
 *  - IndexedDB (localforage: nadpisania transakcji, rejestr rozpoznanych plikow).
 *
 * Wczesniej przycisk kasowal tylko cztery klucze portfela, a rachunki z kluczami API,
 * dane podatnika i decyzje rozliczenia zostawaly w przegladarce - na cudzym
 * komputerze to byl falszywy komunikat „zresetowano do stanu czystego".
 *
 * Zostaja tylko preferencje wygladu (motyw, jezyk): nie sa danymi osobowymi, a ich
 * utrata przy czyszczeniu zaskakiwala. Pamiec service workera (pliki aplikacji)
 * nie zawiera danych uzytkownika i zostaje.
 */

/** Klucze localStorage, ktore przezywaja czyszczenie (sam wyglad, zadne dane). */
export const ZACHOWANE_KLUCZE: ReadonlySet<string> = new Set(['pit38_theme', 'pit38_lang', 'theme', 'uiLanguage:v1']);

/** Minimalny ksztalt magazynu Web Storage potrzebny do czyszczenia (testy podstawiaja atrapy). */
export interface MagazynKluczy {
  readonly length: number;
  key(indeks: number): string | null;
  removeItem(klucz: string): void;
}

export interface WynikCzyszczenia {
  usunieteKlucze: string[];
  usunieteKluczeSesji: string[];
  /** `pominieto` = brak magazynu w tym srodowisku; `blad` = czyszczenie rzucilo wyjatek. */
  indexedDb: 'wyczyszczono' | 'pominieto' | 'blad';
}

export interface ZaleznosciCzyszczenia {
  localStorage?: MagazynKluczy;
  sessionStorage?: MagazynKluczy;
  /** Czyszczenie IndexedDB; domyslnie `localforage.clear()` na magazynie aplikacji. */
  indexedDb?: () => Promise<void>;
  zachowane?: ReadonlySet<string>;
}

/** Usuwa z magazynu wszystkie klucze poza zachowanymi; zwraca usuniete (posortowane). */
export function usunKluczePozaZachowanymi(magazyn: MagazynKluczy | undefined, zachowane: ReadonlySet<string> = ZACHOWANE_KLUCZE): string[] {
  if (!magazyn) return [];
  const klucze: string[] = [];
  try {
    for (let i = 0; i < magazyn.length; i++) {
      const klucz = magazyn.key(i);
      if (klucz !== null && !zachowane.has(klucz)) klucze.push(klucz);
    }
    // Najpierw lista, potem usuwanie: usuwanie w trakcie iteracji przesuwa indeksy i gubi co drugi klucz.
    for (const klucz of klucze) magazyn.removeItem(klucz);
  } catch {
    // Zablokowany magazyn (tryb prywatny, polityka): nie ma czego czyscic.
  }
  return klucze.sort();
}

function magazynPrzegladarki(nazwa: 'localStorage' | 'sessionStorage'): MagazynKluczy | undefined {
  try {
    const magazyn = (globalThis as unknown as Record<string, MagazynKluczy | undefined>)[nazwa];
    return magazyn && typeof magazyn.key === 'function' ? magazyn : undefined;
  } catch {
    return undefined;
  }
}

async function wyczyscIndexedDbAplikacji(): Promise<void> {
  if (typeof indexedDB === 'undefined') throw new Error('brak IndexedDB');
  const { default: localforage } = await import('localforage');
  await localforage.clear();
}

/** Czysci wszystkie dane aplikacji w przegladarce. Nigdy nie rzuca - wynik mowi, co sie udalo. */
export async function wyczyscDaneAplikacji(zal: ZaleznosciCzyszczenia = {}): Promise<WynikCzyszczenia> {
  const zachowane = zal.zachowane ?? ZACHOWANE_KLUCZE;
  const usunieteKlucze = usunKluczePozaZachowanymi(zal.localStorage ?? magazynPrzegladarki('localStorage'), zachowane);
  const usunieteKluczeSesji = usunKluczePozaZachowanymi(zal.sessionStorage ?? magazynPrzegladarki('sessionStorage'), new Set());
  let indexedDb: WynikCzyszczenia['indexedDb'] = 'pominieto';
  const czyszczenie = zal.indexedDb ?? (typeof indexedDB !== 'undefined' ? wyczyscIndexedDbAplikacji : undefined);
  if (czyszczenie) {
    try {
      await czyszczenie();
      indexedDb = 'wyczyszczono';
    } catch {
      indexedDb = 'blad';
    }
  }
  return { usunieteKlucze, usunieteKluczeSesji, indexedDb };
}
