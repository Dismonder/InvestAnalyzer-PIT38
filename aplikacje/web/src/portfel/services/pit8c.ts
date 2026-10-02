import type { BrokerAccount } from '../types';
import type { WpisPit8c } from './optymalizacjaPodatkowa';

/**
 * Ktorzy brokerzy wystawiaja informacje PIT-8C.
 *
 * Deklaracje PIT-8C sporzadza platnik majacy siedzibe w Polsce (art. 39 ust. 3
 * ustawy o PIT). Dla rachunku w XTB (X-Trade Brokers DM S.A.) i w eMaklerze
 * (Biuro maklerskie mBanku) kwoty z tej informacji przepisuje sie do poz. 20
 * i 21 zeznania. Rachunki u brokerow zagranicznych - IBKR, Freedom24, Revolut,
 * DEGIRO - nie daja PIT-8C, wiec ich przychody i koszty ida do poz. 22 i 23
 * ("przychody uzyskane za granica", broszura MF do PIT-38, wiersz 2 czesci C).
 */
const BROKERZY_Z_PIT_8C: ReadonlySet<BrokerAccount['brokerType']> = new Set([
  'XTB',
  'EMAKLER',
]);
const BROKERZY_BEZ_PIT_8C: ReadonlySet<BrokerAccount['brokerType']> = new Set([
  'IBKR', 'FREEDOM24', 'REVOLUT', 'DEGIRO',
]);

export function wystawiaPit8c(brokerType: BrokerAccount['brokerType'] | undefined): boolean {
  return brokerType !== undefined && BROKERZY_Z_PIT_8C.has(brokerType);
}

/**
 * Pusty wpis PIT-8C dodawany przyciskiem w panelu optymalizacji.
 *
 * Rok to rok rozliczenia wybrany w aplikacji: silnik dostaje tylko wpisy z tym rokiem,
 * wiec wpis za "poprzedni rok kalendarzowy" nie wplywal na wynik innego wybranego roku.
 */
export function nowyWpisPit8c(rokRozliczenia: number, id: string): WpisPit8c {
  return { id, taxYear: rokRozliczenia, revenuePln: '', costsPln: '', issuer: '' };
}

export function rachunekBezPit8c(brokerType: BrokerAccount['brokerType'] | undefined): boolean {
  return brokerType !== undefined && BROKERZY_BEZ_PIT_8C.has(brokerType);
}



/**
 * Kwota z pola formularza wpisanego recznie.
 *
 * Uzytkownik przepisuje ja z papierowej albo elektronicznej informacji PIT-8C,
 * wiec moze uzyc przecinka i spacji jako separatora tysiecy. Wartosc, ktorej
 * nie da sie odczytac jako liczby, jest traktowana jak brak wpisu - zamiast
 * zamieniac sie w zero, ktore wygladaloby jak zadeklarowane "nic".
 */
export function kwotaTekstowaZWpisu(tekst: string | undefined): string {
  if (typeof tekst !== 'string') return '';
  const value = tekst.trim();
  if (!value) return '';
  const compact = value.replace(/[\s\u00a0]/g, '');
  let normalized: string;
  if (/^\d{1,3}(?:[. ]\d{3})+,\d{1,2}$/.test(value) || /^\d{1,3}(?:\.\d{3})+,\d{1,2}$/.test(compact)) {
    normalized = compact.replace(/\./g, '').replace(',', '.');
  } else if (/^\d{1,3}(?:,\d{3})+\.\d{1,2}$/.test(compact)) {
    normalized = compact.replace(/,/g, '');
  } else if (/^\d{1,3}(?:[\s\u00a0]\d{3})+(?:[,.]\d{1,2})?$/.test(value)) {
    normalized = compact.replace(',', '.');
  } else if (/^\d+(?:[,.]\d{1,2})?$/.test(compact)) {
    normalized = compact.replace(',', '.');
  } else {
    return value;
  }
  return normalized;
}

export function poprawnaKwotaPit8c(tekst: string | undefined): boolean {
  const value = kwotaTekstowaZWpisu(tekst);
  return /^\d+(?:\.\d{1,2})?$/.test(value);
}

export function kwotaZWpisu(tekst: string | undefined): number | undefined {
  if (!poprawnaKwotaPit8c(tekst)) return undefined;
  return Number(kwotaTekstowaZWpisu(tekst));
}

/** Co wchodzi do poz. 20 i 21 zeznania i skad sie wzielo. */
export interface KwotyPit8c {
  przychod?: number;
  koszty?: number;
  zrodlo?: 'informacja' | 'transakcje';
  wyliczonyPrzychod?: number;
  wyliczoneKoszty?: number;
}

/**
 * Rozstrzyga, co wpisac w poz. 20 i 21 za dany rok.
 *
 * Pierwszenstwo ma otrzymana informacja PIT-8C: to jej kwoty urzad porownuje
 * z zeznaniem. Kilka informacji za ten sam rok (kilku platnikow) sumuje sie.
 * Dopiero gdy uzytkownik zadnej nie wpisal, w kafelkach staje kwota policzona
 * z transakcji - i jest tak oznaczona.
 */
export function kwotyPit8cDlaRoku(
  wpisy: readonly WpisPit8c[] | undefined,
  rok: number,
  wyliczone?: { przychod: number; koszty: number },
): KwotyPit8c {
  const zRoku = (wpisy ?? []).filter((wpis) => Number(wpis.taxYear) === rok);
  // Wpis liczy sie dopiero z obiema kwotami. Wypelniony do polowy dawalby
  // w drugiej pozycji zero, ktore wygladaloby jak zadeklarowane "brak kosztow"
  // albo "brak przychodu" - a to zwykle znaczy tylko, ze uzytkownik jeszcze
  // nie skonczyl przepisywac informacji.
  const kwoty = zRoku
    .map((wpis) => ({ przychod: kwotaZWpisu(wpis.revenuePln), koszty: kwotaZWpisu(wpis.costsPln) }))
    .filter(
      (wpis): wpis is { przychod: number; koszty: number } =>
        wpis.przychod !== undefined && wpis.koszty !== undefined
    );

  if (kwoty.length > 0) {
    return {
      przychod: kwoty.reduce((suma, wpis) => suma + wpis.przychod, 0),
      koszty: kwoty.reduce((suma, wpis) => suma + wpis.koszty, 0),
      zrodlo: 'informacja',
      wyliczonyPrzychod: wyliczone?.przychod,
      wyliczoneKoszty: wyliczone?.koszty,
    };
  }

  if (!wyliczone) return {};

  return {
    przychod: wyliczone.przychod,
    koszty: wyliczone.koszty,
    zrodlo: 'transakcje',
  };
}
