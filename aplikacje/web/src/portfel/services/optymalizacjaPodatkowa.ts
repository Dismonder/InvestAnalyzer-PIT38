/**
 * Ustawienia optymalizacji podatkowej.
 *
 * Silnik potrafi ujac w kosztach uzyskania przychodu duzo wiecej niz sama cene
 * zakupu, ale kazda z tych pozycji ma wlasny przelacznik. Most do silnika
 * wysylal je dotad na sztywno - i to z wylaczonymi odsetkami oraz kosztem
 * finansowania, czyli akurat tym, co w rachunku maklerskim z kredytem wazy
 * najwiecej. Tutaj sa zebrane w jednym miejscu, z podstawa prawna kazdej.
 *
 * Domyslnie wlaczone jest wszystko (plan agresywny). To swiadomy wybor: kazda
 * pozycja ma uzasadnienie w ustawie, a silnik zapisuje dla niej slad dowodowy,
 * wiec w razie pytania urzedu da sie ja obronic.
 */

import type { FundingFeeEntry, PriorYearLossEntry } from '../../invest_analyzer/services/taxEngineConfig';

export type PlanPodatkowy = 'aggressive_user' | 'balanced_user' | 'conservative_user';

/**
 * Kwoty przepisane z otrzymanej informacji PIT-8C.
 *
 * Do poz. 20 i 21 zeznania wpisuje sie kwoty z poz. 35 i 36 tej informacji, a
 * nie wynik wlasnego rachunku. Aplikacja potrafi policzyc te czesc z transakcji
 * na rachunkach polskich, ale jesli jej liczba rozni sie od tego, co broker
 * zglosil urzedowi, zeznanie i informacja PIT-8C nie beda sie zgadzac.
 */
export interface WpisPit8c {
  id: string;
  taxYear: number;
  /** Poz. 35 informacji PIT-8C - przychod. */
  revenuePln: string;
  /** Poz. 36 informacji PIT-8C - koszty uzyskania przychodow. */
  costsPln: string;
  /** Kto wystawil informacje - do rozroznienia kilku PIT-8C w jednym roku. */
  issuer?: string;
}

export interface UstawieniaOptymalizacji {
  /** Plan kosztowy silnika. Agresywny wlacza najszerszy katalog kosztow. */
  plan: PlanPodatkowy;
  /** Koszty przewalutowania ponoszone przy zakupie i sprzedazy w obcej walucie. */
  kosztyPrzewalutowania: boolean;
  /** Koszt pozyskania srodkow na zakup akcji - odsetki i prowizje od kredytu. */
  kosztyFinansowania: boolean;
  /** Odsetki dzienne, w tym od ujemnego salda na rachunku maklerskim. */
  odsetki: boolean;
  /** Oplaty za prowadzenie rachunku i pozostale oplaty maklerskie. */
  oplatyRachunku: boolean;
  /** Czy podatnik zlozyl formularz W-8BEN (stawka 15% zamiast 30% w USA). */
  maW8BEN: boolean;
  /** Recznie wpisane koszty finansowania zakupu (np. rata kredytu pod depozyt). */
  oplatyFinansowania: FundingFeeEntry[];
  /** Straty z lat ubieglych do odliczenia. */
  stratyZLatUbieglych: PriorYearLossEntry[];
  /**
   * Koszty nabycia walut wirtualnych nieodliczone w poprzednich latach.
   *
   * Czesc E rzadzi sie inna regula niz czesc C: nadwyzka kosztow nad przychodem
   * nie jest strata, tylko przechodzi na rok nastepny (art. 22 ust. 16 ustawy
   * o PIT). Silnik nie zna rozliczen sprzed okresu objetego danymi, wiec te
   * kwote wpisuje uzytkownik.
   */
  kosztyKryptoZLatUbieglych: string;
  /**
   * Informacje PIT-8C otrzymane od polskich platnikow, po jednej na wystawce.
   * Puste znaczy "nie mam PIT-8C" - wtedy poz. 20 i 21 licza sie z transakcji.
   */
  informacjePit8c: WpisPit8c[];
}

/** Opis pozycji kosztowej pokazywany uzytkownikowi razem z podstawa prawna. */
export interface OpisPozycji {
  klucz: keyof Pick<
    UstawieniaOptymalizacji,
    'kosztyPrzewalutowania' | 'kosztyFinansowania' | 'odsetki' | 'oplatyRachunku'
  >;
  nazwa: string;
  opis: string;
  podstawa: string;
  ryzyko: 'niskie' | 'srednie' | 'wyzsze';
}

export const POZYCJE_KOSZTOWE: OpisPozycji[] = [
  {
    klucz: 'kosztyFinansowania',
    nazwa: 'Koszt finansowania zakupu (kredyt, depozyt)',
    opis:
      'Odsetki i prowizje od środków pożyczonych na zakup papierów. Silnik przypisuje je do konkretnych zakupów sfinansowanych tymi środkami, więc da się wskazać związek z przychodem.',
    podstawa: 'Art. 22 ust. 1 ustawy o PIT - koszt poniesiony w celu osiągnięcia przychodu.',
    ryzyko: 'wyzsze',
  },
  {
    klucz: 'odsetki',
    nazwa: 'Odsetki dzienne i od ujemnego salda',
    opis:
      'Naliczenia dzienne na rachunku maklerskim, w tym odsetki od debetu wykorzystanego do utrzymania pozycji.',
    podstawa: 'Art. 22 ust. 1 ustawy o PIT; koszt bezpośrednio związany z utrzymaniem inwestycji.',
    ryzyko: 'srednie',
  },
  {
    klucz: 'kosztyPrzewalutowania',
    nazwa: 'Koszty przewalutowania',
    opis:
      'Spread i prowizje przy zamianie waluty na potrzeby zakupu oraz przy powrocie do złotego po sprzedaży.',
    podstawa: 'Art. 22 ust. 1 ustawy o PIT w związku z art. 11a ust. 2 (przeliczanie kosztów).',
    ryzyko: 'srednie',
  },
  {
    klucz: 'oplatyRachunku',
    nazwa: 'Opłaty za prowadzenie rachunku',
    opis: 'Opłaty okresowe, za wyciągi, przelewy i inne opłaty maklerskie.',
    podstawa: 'Art. 22 ust. 1 ustawy o PIT.',
    ryzyko: 'niskie',
  },
];

const KLUCZ_MAGAZYNU = 'pit38_optymalizacja';

/** Maksymalna optymalizacja: wszystko, co silnik potrafi udokumentowac. */
export const USTAWIENIA_DOMYSLNE: UstawieniaOptymalizacji = {
  plan: 'aggressive_user',
  kosztyPrzewalutowania: true,
  kosztyFinansowania: true,
  odsetki: true,
  oplatyRachunku: true,
  maW8BEN: true,
  oplatyFinansowania: [],
  stratyZLatUbieglych: [],
  kosztyKryptoZLatUbieglych: '',
  informacjePit8c: [],
};

/** Przywraca tylko wybory obliczeniowe, nie usuwa wpisanych danych podatnika. */
export function przywrocMaksymalnaOptymalizacje(u: UstawieniaOptymalizacji): UstawieniaOptymalizacji {
  return {
    ...u,
    plan: USTAWIENIA_DOMYSLNE.plan,
    kosztyPrzewalutowania: USTAWIENIA_DOMYSLNE.kosztyPrzewalutowania,
    kosztyFinansowania: USTAWIENIA_DOMYSLNE.kosztyFinansowania,
    odsetki: USTAWIENIA_DOMYSLNE.odsetki,
    oplatyRachunku: USTAWIENIA_DOMYSLNE.oplatyRachunku,
  };
}

export function odczytajUstawienia(): UstawieniaOptymalizacji {
  try {
    const zapisane = localStorage.getItem(KLUCZ_MAGAZYNU);
    if (!zapisane) {
      // Pierwsze otwarcie panelu przy istniejacym warsztacie: przejmujemy to,
      // co uzytkownik juz tam wpisal, zamiast nadpisywac pustymi wartosciami
      // domyslnymi. Wczesniej samo wejscie na zakladke kasowalo oplaty
      // finansowania i straty z lat ubieglych wprowadzone w warsztacie.
      return { ...USTAWIENIA_DOMYSLNE, ...odczytajZWarsztatu() };
    }
    const odczyt = JSON.parse(zapisane) as Partial<UstawieniaOptymalizacji>;
    // Plan, przelaczniki, oplaty i straty silnik bierze z kluczy warsztatu, wiec
    // to one sa prawda. Kopia panelu sprzed zmiany w warsztacie wracala tam przy
    // najblizszym zapisie panelu (np. dopisaniu PIT-8C) i po cichu cofala zmiane
    // planu albo przywracala usuniete oplaty finansowania.
    const {
      informacjePit8c: _lustroPit8c,
      kosztyKryptoZLatUbieglych: _dawnyKosztKrypto,
      ...zWarsztatu
    } = odczytajZWarsztatu();
    return {
      ...USTAWIENIA_DOMYSLNE,
      ...odczyt,
      oplatyFinansowania: Array.isArray(odczyt.oplatyFinansowania) ? odczyt.oplatyFinansowania : [],
      stratyZLatUbieglych: Array.isArray(odczyt.stratyZLatUbieglych) ? odczyt.stratyZLatUbieglych : [],
      kosztyKryptoZLatUbieglych:
        typeof odczyt.kosztyKryptoZLatUbieglych === 'string' ? odczyt.kosztyKryptoZLatUbieglych : '',
      informacjePit8c: Array.isArray(odczyt.informacjePit8c) ? odczyt.informacjePit8c : [],
      ...zWarsztatu,
    };
  } catch {
    return { ...USTAWIENIA_DOMYSLNE };
  }
}

/**
 * Klucze, z ktorych warsztat silnika ("Dokumenty i silnik") sklada swoje
 * zadanie. Panel optymalizacji zapisuje je razem z wlasnym stanem.
 */
const KLUCZE_WARSZTATU = {
  plan: 'taxCalculationPlan',
  kosztyPrzewalutowania: 'includeFxConversionCosts',
  kosztyFinansowania: 'includeBankFundingFees',
  odsetki: 'includeInterestCosts',
  oplatyRachunku: 'includeAccountFees',
  oplatyFinansowania: 'fundingFeeEntries',
  stratyZLatUbieglych: 'priorYearLossEntries',
  kosztyKryptoZLatUbieglych: 'cryptoCostsCarriedForward',
  informacjePit8c: 'pit8cEntries',
} as const;

/**
 * Przepisuje ustawienia do kluczy warsztatu silnika.
 *
 * Obie czesci aplikacji buduja to samo zadanie dla silnika, ale czytaly je z
 * innych miejsc: panel optymalizacji z jednego wpisu `pit38_optymalizacja`,
 * warsztat z osobnych kluczy. Przelaczniki ustawione w jednym miejscu nie
 * docieraly do drugiego, wiec ten sam rok wychodzil z dwiema roznymi kwotami
 * podatku - a uzytkownik nie mial jak rozstrzygnac, ktora obowiazuje.
 */
function przepiszDoWarsztatu(ustawienia: UstawieniaOptymalizacji, syncLosses: boolean): void {
  try {
    localStorage.setItem(KLUCZE_WARSZTATU.plan, ustawienia.plan);
    localStorage.setItem(KLUCZE_WARSZTATU.kosztyPrzewalutowania, String(ustawienia.kosztyPrzewalutowania));
    localStorage.setItem(KLUCZE_WARSZTATU.kosztyFinansowania, String(ustawienia.kosztyFinansowania));
    localStorage.setItem(KLUCZE_WARSZTATU.odsetki, String(ustawienia.odsetki));
    localStorage.setItem(KLUCZE_WARSZTATU.oplatyRachunku, String(ustawienia.oplatyRachunku));
    localStorage.setItem(KLUCZE_WARSZTATU.oplatyFinansowania, JSON.stringify(ustawienia.oplatyFinansowania));
    if (syncLosses) localStorage.setItem(KLUCZE_WARSZTATU.stratyZLatUbieglych, JSON.stringify(ustawienia.stratyZLatUbieglych));
    localStorage.setItem(KLUCZE_WARSZTATU.informacjePit8c, JSON.stringify(ustawienia.informacjePit8c));
  } catch {
    // Brak magazynu nie moze blokowac przeliczenia.
  }
}

/**
 * Ustawienia zapisane wczesniej w warsztacie silnika.
 *
 * Panel optymalizacji i warsztat to dwa wejscia do tego samego rozliczenia.
 * Gdy panel otwierany jest pierwszy raz, a warsztat ma juz swoje wpisy, to one
 * sa prawda - inaczej wejscie na zakladke kasowaloby prace uzytkownika.
 */
function odczytajZWarsztatu(): Partial<UstawieniaOptymalizacji> {
  const przejete: Partial<UstawieniaOptymalizacji> = {};
  try {
    // Warsztat zapisuje nazwy planow silnika; starsze wersje zapisywaly nazwy
    // scenariuszy (defensible, conservative), ktore silnik mapuje na plany.
    const plan = localStorage.getItem(KLUCZE_WARSZTATU.plan);
    const PLANY: Record<string, PlanPodatkowy> = {
      aggressive_user: 'aggressive_user',
      balanced_user: 'balanced_user',
      conservative_user: 'conservative_user',
      defensible: 'balanced_user',
      conservative: 'conservative_user',
    };
    if (plan && Object.prototype.hasOwnProperty.call(PLANY, plan)) przejete.plan = PLANY[plan];

    const przelacznik = (klucz: string): boolean | undefined => {
      const wartosc = localStorage.getItem(klucz);
      if (wartosc === 'true') return true;
      if (wartosc === 'false') return false;
      return undefined;
    };
    const kosztyPrzewalutowania = przelacznik(KLUCZE_WARSZTATU.kosztyPrzewalutowania);
    if (kosztyPrzewalutowania !== undefined) przejete.kosztyPrzewalutowania = kosztyPrzewalutowania;
    const kosztyFinansowania = przelacznik(KLUCZE_WARSZTATU.kosztyFinansowania);
    if (kosztyFinansowania !== undefined) przejete.kosztyFinansowania = kosztyFinansowania;
    const odsetki = przelacznik(KLUCZE_WARSZTATU.odsetki);
    if (odsetki !== undefined) przejete.odsetki = odsetki;
    const oplatyRachunku = przelacznik(KLUCZE_WARSZTATU.oplatyRachunku);
    if (oplatyRachunku !== undefined) przejete.oplatyRachunku = oplatyRachunku;

    const lista = (klucz: string): unknown[] | undefined => {
      const surowa = localStorage.getItem(klucz);
      if (!surowa) return undefined;
      try {
        const odczyt = JSON.parse(surowa);
        return Array.isArray(odczyt) ? odczyt : undefined;
      } catch {
        return undefined;
      }
    };
    // Pusta lista w warsztacie to decyzja uzytkownika (usunal wpisy), nie brak danych.
    const oplaty = lista(KLUCZE_WARSZTATU.oplatyFinansowania);
    if (oplaty) {
      przejete.oplatyFinansowania = oplaty as UstawieniaOptymalizacji['oplatyFinansowania'];
    }
    const straty = lista(KLUCZE_WARSZTATU.stratyZLatUbieglych);
    if (straty) {
      przejete.stratyZLatUbieglych = straty as UstawieniaOptymalizacji['stratyZLatUbieglych'];
    }

    const krypto = localStorage.getItem(KLUCZE_WARSZTATU.kosztyKryptoZLatUbieglych);
    if (krypto) przejete.kosztyKryptoZLatUbieglych = krypto;

    const pit8c = lista(KLUCZE_WARSZTATU.informacjePit8c);
    if (pit8c && pit8c.length > 0) {
      przejete.informacjePit8c = pit8c as UstawieniaOptymalizacji['informacjePit8c'];
    }
  } catch {
    // Brak magazynu oznacza po prostu brak wczesniejszych ustawien.
  }
  return przejete;
}

export function zapiszUstawienia(ustawienia: UstawieniaOptymalizacji, syncLosses = true): void {
  try {
    localStorage.setItem(KLUCZ_MAGAZYNU, JSON.stringify(ustawienia));
  } catch {
    // Brak magazynu nie moze blokowac przeliczenia.
  }
  przepiszDoWarsztatu(ustawienia, syncLosses);
  globalThis.window?.dispatchEvent(new Event('tax-input-changed'));
}

/** Scala zmienione pola ze świeżym stanem magazynu przed zapisem. */
export function zapiszZmianeUstawien(zmiana: Partial<UstawieniaOptymalizacji>): UstawieniaOptymalizacji {
  const aktualne = odczytajUstawienia();
  const wynik = { ...aktualne, ...zmiana };
  zapiszUstawienia(wynik, 'stratyZLatUbieglych' in zmiana);
  return wynik;
}

/** Ile pozycji kosztowych jest aktywnych - do podsumowania w interfejsie. */
export function liczbaAktywnychPozycji(ustawienia: UstawieniaOptymalizacji): number {
  return POZYCJE_KOSZTOWE.filter((pozycja) => ustawienia[pozycja.klucz]).length;
}
