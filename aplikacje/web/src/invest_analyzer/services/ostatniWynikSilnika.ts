/**
 * Ostatni wynik silnika, wspólny dla obu połów aplikacji.
 *
 * Warsztat („Dokumenty i silnik”) i portfel (Portfel, PIT-38, Transakcje)
 * uruchamiały silnik osobno i trzymały wynik każdy u siebie: warsztat miał
 * 441 transakcji i podatek 17 376,32 zł, a portfel obok pokazywał „0 transakcji”.
 * Tu leży jeden wynik na rok - kto policzy, publikuje; kto wyświetla, czyta
 * i nasłuchuje. Pamięć karty, nie dysk: wynik zawiera dane rachunku.
 */

import type { TaxEngineResponse } from '../hooks/useTaxEngineRun';

export interface WynikSilnikaDlaRoku {
  rok: number;
  /** Odcisk żądania, z którego powstał wynik (te same dane i ustawienia). */
  kluczZadania: string;
  odpowiedz: TaxEngineResponse;
  policzonoO: string;
}

type Sluchacz = (wynik: WynikSilnikaDlaRoku) => void;

const wynikiWgRoku = new Map<number, WynikSilnikaDlaRoku>();
/**
 * Odpowiedz silnika ma kilka-kilkanascie MB. Trzymamy lata ostatnio liczone
 * (biezacy, poprzedni do kosztow krypto, jeden zapasowy), a nie kazdy odwiedzony.
 */
const LIMIT_LAT_W_PAMIECI = 3;
const sluchacze = new Set<Sluchacz>();

/** Wynik nadaje się do pokazania, gdy silnik faktycznie zwrócił rozliczenie. */
export function czyWynikZRozliczeniem(odpowiedz: TaxEngineResponse | null | undefined): boolean {
  if (!odpowiedz || odpowiedz.success === false) return false;
  return Boolean(odpowiedz.annual_summary) || Array.isArray(odpowiedz.transaction_history_rows);
}

export function opublikujWynikSilnika(rok: number, kluczZadania: string, odpowiedz: TaxEngineResponse): void {
  if (!Number.isInteger(rok) || !czyWynikZRozliczeniem(odpowiedz)) return;
  const wynik: WynikSilnikaDlaRoku = { rok, kluczZadania, odpowiedz, policzonoO: new Date().toISOString() };
  wynikiWgRoku.delete(rok);
  wynikiWgRoku.set(rok, wynik);
  while (wynikiWgRoku.size > LIMIT_LAT_W_PAMIECI) {
    wynikiWgRoku.delete(wynikiWgRoku.keys().next().value as number);
  }
  sluchacze.forEach((sluchacz) => {
    try {
      sluchacz(wynik);
    } catch {
      // Błąd jednego odbiorcy nie może zatrzymać pozostałych.
    }
  });
}

export function odczytajWynikSilnika(rok: number): WynikSilnikaDlaRoku | null {
  return wynikiWgRoku.get(rok) ?? null;
}

/** Wynik dla najpóźniejszego policzonego roku - z niego biorą się otwarte pozycje. */
export function odczytajNajnowszyWynikSilnika(): WynikSilnikaDlaRoku | null {
  let najnowszy: WynikSilnikaDlaRoku | null = null;
  for (const wynik of wynikiWgRoku.values()) {
    if (!najnowszy || wynik.rok > najnowszy.rok) najnowszy = wynik;
  }
  return najnowszy;
}

export function subskrybujWynikSilnika(sluchacz: Sluchacz): () => void {
  sluchacze.add(sluchacz);
  return () => {
    sluchacze.delete(sluchacz);
  };
}

/** Po zmianie plików w magazynie stary wynik przestaje opisywać dane. */
export function uniewaznijWynikiSilnika(): void {
  wynikiWgRoku.clear();
}
