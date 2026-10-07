/**
 * Walidacja wejscia API notowan i kursow - wspolna dla hostowanego Workera
 * (hosting/apiHostowane.ts) i lokalnego serwera Express (server/routes/quotes.ts,
 * server/routes/nbp.ts). Do dostawcow (Yahoo, NBP) idzie tylko to, co ma ksztalt
 * symbolu, waluty albo daty; reszta konczy sie 400 bez odpytywania sieci.
 * Bez importow Node - modul dziala w Workerze, przegladarce i testach.
 */

export const MAX_DLUGOSC_TICKERA = 24;
export const MAX_DLUGOSC_ZAPYTANIA = 64;

/** Symbole Yahoo: litery, cyfry, kropka, myslnik, daszek indeksu (^GSPC), rownosc par walut (EURUSD=X). */
export const WZOR_TICKERA = /^[A-Z0-9^][A-Z0-9.\-^=]{0,23}$/;
export const WZOR_WALUTY = /^[A-Z]{3}$/;
export const WZOR_DATY = /^\d{4}-\d{2}-\d{2}$/;

/** Zakresy i interwaly, ktore przyjmuje dostawca (i ktore wysyla aplikacja). */
export const DOZWOLONE_ZAKRESY: ReadonlySet<string> = new Set(['1d', '5d', '7d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'ytd', 'max', '60d', '730d']);
export const DOZWOLONE_INTERWALY: ReadonlySet<string> = new Set(['1m', '2m', '5m', '15m', '30m', '60m', '90m', '1h', '1d', '5d', '1wk', '1mo', '3mo']);

/**
 * Waluty z tabeli A NBP (kursy srednie) plus PLN. Nieznany kod nie idzie do NBP:
 * API odpowiada na niego 404 tak samo jak na dzien bez tabeli, wiec bez tej listy
 * jedna literowka kosztowala 10 zapytan do NBP i odpowiedz 503 bez pamieci.
 */
export const WALUTY_NBP: ReadonlySet<string> = new Set([
  'PLN', 'THB', 'USD', 'AUD', 'HKD', 'CAD', 'NZD', 'SGD', 'EUR', 'HUF', 'CHF', 'GBP', 'UAH', 'JPY', 'CZK', 'DKK',
  'ISK', 'NOK', 'SEK', 'RON', 'BGN', 'TRY', 'ILS', 'CLP', 'PHP', 'MXN', 'ZAR', 'BRL', 'MYR', 'IDR', 'INR', 'KRW',
  'CNY', 'XDR',
]);

/** Symbol po normalizacji (duze litery) albo null, gdy nie wyglada na symbol instrumentu. */
export function normalizujTicker(surowy: string | null | undefined): string | null {
  const ticker = String(surowy ?? '').trim().toUpperCase();
  return ticker.length <= MAX_DLUGOSC_TICKERA && WZOR_TICKERA.test(ticker) ? ticker : null;
}

/** Lista tickerow z parametru `tickers`: bez duplikatow i bez wpisow, ktore nie sa symbolami (`odrzucone` = ile takich bylo). */
export function normalizujListeTickerow(parametr: string | null | undefined): { tickery: string[]; odrzucone: number } {
  const wpisy = String(parametr || '').split(',').map((t) => t.trim()).filter(Boolean);
  const znormalizowane = wpisy.map(normalizujTicker);
  const tickery = [...new Set(znormalizowane.filter((t): t is string => t !== null))];
  return { tickery, odrzucone: znormalizowane.filter((t) => t === null).length };
}

/** Kod waluty (3 litery) z tabeli A NBP albo null. */
export function normalizujWalute(surowa: string | null | undefined): string | null {
  const waluta = String(surowa ?? '').trim().toUpperCase();
  return WZOR_WALUTY.test(waluta) && WALUTY_NBP.has(waluta) ? waluta : null;
}

/** Data `RRRR-MM-DD` istniejaca w kalendarzu, w zakresie od 2002 (archiwum NBP) do nastepnego roku. */
export function czyPoprawnaDataKursu(data: string, teraz: Date = new Date()): boolean {
  if (!WZOR_DATY.test(data)) return false;
  const [rok, miesiac, dzien] = data.split('-').map(Number);
  if (rok < 2002 || rok > teraz.getUTCFullYear() + 1) return false;
  const kalendarz = new Date(Date.UTC(rok, miesiac - 1, dzien));
  return kalendarz.getUTCFullYear() === rok && kalendarz.getUTCMonth() === miesiac - 1 && kalendarz.getUTCDate() === dzien;
}

/** Zapytanie wyszukiwarki: bez znakow sterujacych, przyciete do limitu dlugosci. */
export function normalizujZapytanie(q: string | null | undefined): string {
  return String(q || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_DLUGOSC_ZAPYTANIA);
}

/**
 * Klucz ogranicznika zadan z adresu IP. IPv6 jest liczone per prefiks /64 (jeden
 * abonent dostaje zwykle cala /64, wiec pelny adres dawalby mu 2^64 osobnych
 * limitow); IPv4 per adres. Pusty adres daje wspolny klucz zastepczy.
 */
export function kluczLimituZAdresu(ip: string | null | undefined): string {
  const adres = String(ip ?? '').trim();
  if (!adres) return 'brak-ip';
  if (!adres.includes(':')) return adres;
  const bezStrefy = adres.split('%')[0].toLowerCase();
  const [lewa = '', prawa = ''] = bezStrefy.split('::');
  const lewe = lewa ? lewa.split(':') : [];
  const prawe = prawa ? prawa.split(':') : [];
  const brakujace = Math.max(0, 8 - lewe.length - prawe.length);
  const grupy = [...lewe, ...Array.from({ length: brakujace }, () => '0'), ...prawe]
    .slice(0, 8)
    .map((g) => g.padStart(4, '0').slice(-4));
  return `${grupy.slice(0, 4).join(':')}::/64`;
}
