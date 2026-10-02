/**
 * Zestawienie pozycji z FIFO silnika ze stanem rachunku u brokera.
 * Osobny, maly modul: potrzebny od startu, a most do silnika jest dociagany
 * dopiero przy przeliczeniu.
 */

import type { OpenPosition } from '../types';

/** Pozycja odczytana z rachunku brokera (adapter Freedom24, tylko odczyt). */
export interface PozycjaBrokera {
  ticker: string;
  market: string | null;
  quantity: number | null;
  currency: string;
  /** Cena rynkowa wg brokera; `null`, gdy jej nie podal. */
  marketPrice?: number | null;
}

export interface RozbieznoscZBrokerem {
  ticker: string;
  rodzaj: 'BRAK_W_TRANSAKCJACH' | 'INNA_ILOSC' | 'BRAK_U_BROKERA' | 'ILOSC_NIEZNANA';
  iloscZTransakcji: number | null;
  iloscUBrokera: number | null;
  opis: string;
}

function bazaTickera(ticker: string): string {
  return ticker.trim().toUpperCase().split('.')[0];
}

/**
 * Zestawia pozycje z FIFO silnika ze stanem rachunku u brokera.
 *
 * Pozycja obecna w obu zrodlach jest JEDNA - broker jej nie dubluje, tylko
 * potwierdza ilosc. Pozycja widoczna wylacznie u brokera nie trafia do tabeli
 * z kosztem: bez zapisu nabycia koszt w PLN jest nieznany, a zero udawaloby
 * darmowe akcje. Wraca jako rozbieznosc do pokazania uzytkownikowi.
 */
export function zestawPozycjeZBrokerem(
  pozycjeZTransakcji: readonly OpenPosition[],
  pozycjeBrokera: readonly PozycjaBrokera[],
): RozbieznoscZBrokerem[] {
  const rozbieznosci: RozbieznoscZBrokerem[] = [];
  const zTransakcji = new Map<string, number>();
  for (const pozycja of pozycjeZTransakcji) {
    const baza = bazaTickera(pozycja.ticker);
    zTransakcji.set(baza, (zTransakcji.get(baza) ?? 0) + pozycja.totalQuantity);
  }
  const uBrokera = new Set<string>();
  for (const pozycja of pozycjeBrokera) {
    const baza = bazaTickera(pozycja.ticker);
    if (!baza) continue;
    uBrokera.add(baza);
    const ilosc = zTransakcji.get(baza);
    if (pozycja.quantity === null) {
      rozbieznosci.push({
        ticker: baza,
        rodzaj: 'ILOSC_NIEZNANA',
        iloscZTransakcji: ilosc ?? null,
        iloscUBrokera: null,
        opis: `${baza}: broker nie podał ilości, nie da się potwierdzić stanu.`,
      });
    } else if (ilosc === undefined) {
      rozbieznosci.push({
        ticker: baza,
        rodzaj: 'BRAK_W_TRANSAKCJACH',
        iloscZTransakcji: null,
        iloscUBrokera: pozycja.quantity,
        opis:
          `${baza}: broker pokazuje ${pozycja.quantity} szt., a w transakcjach silnika nie ma nabycia. ` +
          'Koszt nabycia jest nieznany - dodaj dokument albo zapis nabycia (np. akcje bonusowe).',
      });
    } else if (Math.abs(ilosc - pozycja.quantity) > 1e-8) {
      rozbieznosci.push({
        ticker: baza,
        rodzaj: 'INNA_ILOSC',
        iloscZTransakcji: ilosc,
        iloscUBrokera: pozycja.quantity,
        opis: `${baza}: z transakcji wynika ${ilosc} szt., broker pokazuje ${pozycja.quantity} szt.`,
      });
    }
  }
  if (pozycjeBrokera.length > 0) {
    for (const [baza, ilosc] of zTransakcji) {
      if (uBrokera.has(baza)) continue;
      rozbieznosci.push({
        ticker: baza,
        rodzaj: 'BRAK_U_BROKERA',
        iloscZTransakcji: ilosc,
        iloscUBrokera: null,
        opis: `${baza}: z transakcji wynika ${ilosc} szt., a broker nie pokazuje tej pozycji (inny rachunek albo brak sprzedaży w dokumentach).`,
      });
    }
  }
  return rozbieznosci;
}
