import type { OpenPosition } from '../types';

/** Czy pozycja (para ticker-rachunek z silnika) nalezy do rachunku. */
export function pozycjaNalezyDoRachunku(pozycja: OpenPosition, accountId: string): boolean {
  if (!accountId) return false;
  return (pozycja.lots ?? []).some((partia) => partia.accountId === accountId)
    || (pozycja.accountIds ?? []).includes(accountId);
}

function poTickerze(pozycje: readonly OpenPosition[], ticker: string): OpenPosition[] {
  const docelowy = ticker.trim().toUpperCase();
  return pozycje.filter((pozycja) => pozycja.ticker.trim().toUpperCase() === docelowy);
}

/**
 * Pozycja o danym tickerze NA WYBRANYM rachunku - dla ilosci, MAX i projekcji SL/TP.
 *
 * Silnik tworzy osobna pozycje dla kazdej pary ticker-rachunek, wiec samo `find`
 * po tickerze bralo pierwsza z brzegu: ilosc i MAX pokazywaly stan innego
 * rachunku. Brak pozycji na rachunku to brak pozycji (`undefined`) - ilosc z
 * innego rachunku nie nadaje sie do zlecenia. Bez wybranego rachunku
 * (pusty `accountId`) ograniczenia nie ma i zwracana jest pierwsza po tickerze.
 */
export function wybierzPozycjeRachunku(
  pozycje: readonly OpenPosition[],
  ticker: string,
  accountId: string,
): OpenPosition | undefined {
  const kandydaci = poTickerze(pozycje, ticker);
  if (!accountId) return kandydaci[0];
  return kandydaci.find((pozycja) => pozycjaNalezyDoRachunku(pozycja, accountId));
}

/** Pozycja rachunku, a gdy jej nie ma - pierwsza po tickerze. Tylko do informacji o walorze (nazwa, waluta), nie do ilosci. */
export function pozycjaTickeraDoInformacji(
  pozycje: readonly OpenPosition[],
  ticker: string,
  accountId: string,
): OpenPosition | undefined {
  return wybierzPozycjeRachunku(pozycje, ticker, accountId) ?? poTickerze(pozycje, ticker)[0];
}

// Stale i filtr rachunku leza tutaj, a nie w engineBridge: powloka (PortfelApp)
// potrzebuje ich przy starcie, a jeden statyczny import wciagal caly most silnika
// (ok. 45 kB) do pakietu startowego mimo trzech importow dynamicznych.

/** Rachunek, pod ktorym widac transakcje odczytane z dokumentow w magazynie. */
export const KONTO_MAGAZYNU_SILNIKA = 'Dokumenty w magazynie silnika';

/** Pozycje bez rachunku pozostają widoczne, ale nie mogą zasilać zleceń. */
export const RACHUNEK_NIEUSTALONY = 'account_unresolved';

/**
 * Pozycje do zleceń dla wybranego rachunku; pozycje nieustalone są wykluczone.
 *
 * Pozycje z wyciągów w magazynie silnika nie mają rachunku aplikacji - jak przed
 * podziałem na rachunki można z nich złożyć zlecenie na wybranym rachunku brokera
 * (broker sprawdzi stan). Pozycje INNEGO rachunku aplikacji są wykluczone.
 */
export function pozycjeNaRachunku(positions: OpenPosition[], accountId: string): OpenPosition[] {
  if (!accountId || accountId === RACHUNEK_NIEUSTALONY) return [];
  return positions.filter((position) =>
    position.accountIds.includes(accountId) || position.accountIds.includes(KONTO_MAGAZYNU_SILNIKA));
}
