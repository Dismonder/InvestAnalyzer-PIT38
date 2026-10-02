import type { CurrencyCode, LiveMarketQuote, OpenPosition, Transaction } from '../types';

/** Waluty prowizji w formularzu transakcji - te same co waluty transakcji. */
export const WALUTY_PROWIZJI: readonly CurrencyCode[] = ['PLN', 'USD', 'EUR', 'GBP', 'CHF'];

/**
 * Dzisiejsza data (RRRR-MM-DD) w czasie lokalnym. `toISOString().slice(0, 10)` daje date UTC:
 * po polnocy w Polsce transakcja dostawala wczorajsza date, a z nia kurs NBP i rok podatkowy.
 */
export function dzisiajLokalnie(teraz: Date = new Date()): string {
  const dwie = (liczba: number) => String(liczba).padStart(2, '0');
  return `${teraz.getFullYear()}-${dwie(teraz.getMonth() + 1)}-${dwie(teraz.getDate())}`;
}

/**
 * Blad formularza transakcji albo null. `parseFloat(...) || 0` zapisywalo pusta
 * albo ujemna ilosc jako 0/-5, a data z przyszlosci trafiala do rozliczenia bez
 * kursu NBP. Cena 0 jest dozwolona (akcje otrzymane bez oplaty maja koszt 0).
 */
export function bladFormularzaTransakcji(
  pola: { date: string; quantity: string; pricePerUnit: string },
  dzisiaj: string = dzisiajLokalnie(),
): string | null {
  const ilosc = Number.parseFloat(pola.quantity);
  const cena = Number.parseFloat(pola.pricePerUnit);
  if (!Number.isFinite(ilosc) || ilosc <= 0) return 'Ilość musi być większa od zera.';
  if (!Number.isFinite(cena) || cena < 0) return 'Cena nie może być ujemna.';
  if (pola.date > dzisiaj) return 'Data transakcji nie może być z przyszłości.';
  return null;
}

/** Poczatkowa waluta prowizji: zapisana przy edycji, w innym razie waluta transakcji. */
export function poczatkowaWalutaProwizji(
  edytowana: Pick<Transaction, 'currency' | 'commissionCurrency'> | null | undefined,
  domyslnaWaluta: CurrencyCode,
): CurrencyCode {
  return edytowana ? (edytowana.commissionCurrency ?? edytowana.currency) : domyslnaWaluta;
}

/**
 * Waluta prowizji po zmianie waluty transakcji: podaza za nia, dopoki uzytkownik
 * swiadomie nie wybral innej (jak updateTradeFieldValues). Prowizja 4,90 przy zakupie
 * w zlotych nie moze pojsc do silnika jako 4,90 USD.
 */
export function walutaProwiziPoZmianieWaluty(
  nowaWaluta: CurrencyCode,
  biezacaWalutaProwizji: CurrencyCode,
  uzytkownikZmienilProwizje: boolean,
): CurrencyCode {
  return uzytkownikZmienilProwizje ? biezacaWalutaProwizji : nowaWaluta;
}

/** Podpowiedz do formularza sprzedazy calej pozycji. */
export interface PodpowiedzZamkniecia {
  ticker: string;
  name: string;
  type: 'SELL';
  quantity: number;
  category: OpenPosition['category'];
  accountId: string;
  /** Cena z notowania; 0 = brak notowania, uzytkownik wpisuje cene z potwierdzenia brokera. */
  pricePerUnit: number;
  /** Waluta ceny: waluta NOTOWANIA, gdy jest; inaczej waluta pozycji. */
  currency: CurrencyCode;
}

/**
 * "Zamknij pozycje" nie zapisuje sprzedazy od razu: sprzedaz wchodzi do PIT-38, wiec cena,
 * ilosc i data maja przejsc przez formularz. Bez notowania cena zostaje pusta (0), nie cena zakupu.
 */
export function podpowiedzZamknieciaPozycji(
  pozycja: OpenPosition,
  notowanie: Pick<LiveMarketQuote, 'price' | 'currency'> | undefined,
  accountId: string,
): PodpowiedzZamkniecia {
  const maNotowanie = typeof notowanie?.price === 'number' && notowanie.price > 0;
  return {
    ticker: pozycja.ticker,
    name: pozycja.name || pozycja.ticker,
    type: 'SELL',
    quantity: pozycja.totalQuantity,
    category: pozycja.category || 'STOCK_FOREIGN',
    accountId,
    pricePerUnit: maNotowanie ? (notowanie as { price: number }).price : 0,
    currency: maNotowanie && notowanie?.currency ? notowanie.currency : pozycja.currency,
  };
}

/**
 * Czy zapis transakcji ma dopisac rachunek. Transakcja z id spoza listy rachunkow zostaje
 * z tym id (widoki oznaczaja ja jako nieprzypisana) - dopisywanie rachunku CUSTOM dla
 * dowolnego id tworzylo fikcyjne rachunki. Wyjatkiem jest pierwszy zapis, gdy nie ma
 * zadnego rachunku: formularz sam oferuje wtedy "Glowny rachunek maklerski" (acc_main).
 */
export function czyUtworzycRachunekDlaTransakcji(accountId: string, istniejaceIdRachunkow: readonly string[]): boolean {
  return accountId === DOMYSLNY_RACHUNEK_FORMULARZA && istniejaceIdRachunkow.length === 0;
}

export const DOMYSLNY_RACHUNEK_FORMULARZA = 'acc_main';

/**
 * Stawka i kwota podatku u zrodla dywidendy z pol formularza.
 *
 * Kwota (w walucie dywidendy) ma pierwszenstwo przed stawka: silnik dostaje pobrany podatek,
 * a stawka jest tylko zapasowym sposobem policzenia. Edycja dywidendy bez tego pola zgubila
 * kwote z wyciagu (1,44 USD) i po zapisie podatek wychodzil ze stawki (1,50 USD).
 */
export function podatekZrodlaDywidendy(
  typ: string,
  stawkaTekst: string,
  kwotaTekst: string,
): { foreignTaxRate: number | undefined; foreignTaxAmount: number | undefined } {
  if (typ !== 'DIVIDEND') return { foreignTaxRate: undefined, foreignTaxAmount: undefined };
  const kwota = kwotaTekst.trim() === '' ? Number.NaN : parseFloat(kwotaTekst);
  return {
    foreignTaxRate: parseFloat(stawkaTekst) || 0,
    foreignTaxAmount: Number.isFinite(kwota) ? kwota : undefined,
  };
}
