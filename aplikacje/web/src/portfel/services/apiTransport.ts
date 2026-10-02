import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { marketDataService } from './marketDataService';
import { kandydaciSymboluDostawcy, SYMBOL_MAP } from '../../shared/symbolDostawcy';
import { dzisiajLokalnie } from './formularzTransakcji';

const CRYPTO_TICKERS = new Set([
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX',
  'LINK', 'DOT', 'NEAR', 'SUI', 'PEPE', 'SHIB', 'LTC',
]);

function previousUtcDay(date: string): string {
  const day = new Date(`${date.slice(0, 10)}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

function normalizePencePrice(value: unknown, currency: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return currency === 'GBp' || String(currency).toUpperCase() === 'GBX' ? value / 100 : value;
}

/**
 * Zbudowana aplikacja desktop nie ma serwera Node: względny fetch('/api/...')
 * trafia w pliki aplikacji. Tryb deweloperski Tauri (devUrl localhost:3000) ma
 * serwer i tam zwykły fetch działa.
 */
function bezSerweraAplikacji(): boolean {
  const miejsce = (globalThis as { location?: { protocol?: string; hostname?: string } }).location;
  return miejsce?.protocol === 'tauri:' || miejsce?.hostname === 'tauri.localhost';
}

export const KOD_NIEDOSTEPNE_W_DESKTOPIE = 'NIEDOSTEPNE_W_DESKTOPIE';

/**
 * Jednoznaczna odmowa zamiast wyjątku sieciowego. Wyjątek przy składaniu
 * zlecenia Binance był traktowany jak wynik niepewny: rejestr blokował walor,
 * a sprawdzenie statusu też nie mogło się udać - blokada na zawsze.
 */
function niedostepneWDesktopie(): Response {
  return new Response(JSON.stringify({
    success: false,
    status: 'REJECTED',
    errorCode: KOD_NIEDOSTEPNE_W_DESKTOPIE,
    message: 'Ta funkcja wymaga lokalnego serwera aplikacji (wersja przeglądarkowa). W wersji desktop nie jest jeszcze dostępna - nic nie zostało wysłane do brokera.',
  }), { status: 501, headers: { 'Content-Type': 'application/json' } });
}

/** Limity jak w GET /api/quotes serwera (routes/quotes.ts). */
export const MAX_TICKEROW_NA_ZADANIE = 100;
export const MAX_ROWNOLEGLYCH_POBRAN = 8;

/** Jak Promise.all(items.map(fn)), ale z co najwyzej `limit` zadaniami naraz; kolejnosc wynikow jak wejscia. */
async function mapaZLimitem<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const wyniki: R[] = new Array(items.length);
  let nastepny = 0;
  const robotnik = async () => {
    while (nastepny < items.length) {
      const indeks = nastepny++;
      wyniki[indeks] = await fn(items[indeks]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, robotnik));
  return wyniki;
}

/** Liczba skonczona albo null: brak pola u dostawcy zostaje brakiem, nie zerem. */
function liczbaLubNull(wartosc: unknown): number | null {
  return typeof wartosc === 'number' && Number.isFinite(wartosc) ? wartosc : null;
}

const zaokragl2 = (wartosc: number): number => Number(wartosc.toFixed(2));

/**
 * Notowanie jednego waloru bezposrednio u dostawcow (Binance dla krypto, Yahoo dla reszty);
 * null gdy brak. Ksztalt jak w odpowiedzi serwera web (routes/quotes.ts), zeby widoki
 * (LiveMarketQuote) dzialaly tak samo w obu wersjach. Zmiana dzienna tylko gdy dostawca
 * podal poprzednie zamkniecie - inaczej null, nie 0.
 */
async function pobierzNotowanieDesktop(ticker: string): Promise<Record<string, unknown> | null> {
  if (CRYPTO_TICKERS.has(ticker.toUpperCase())) {
    const cryptoTicker = ticker.toUpperCase();
    const extUrl = `https://api.binance.com/api/v3/ticker/24hr?symbol=${cryptoTicker}USDT`;
    const res = await tauriFetch(extUrl, { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      const cena = parseFloat(data.lastPrice ?? data.price);
      if (Number.isFinite(cena)) {
        const zmiana = liczbaLubNull(parseFloat(data.priceChange));
        const zmianaProc = liczbaLubNull(parseFloat(data.priceChangePercent));
        const wysoka = liczbaLubNull(parseFloat(data.highPrice));
        const niska = liczbaLubNull(parseFloat(data.lowPrice));
        const obrot = liczbaLubNull(parseFloat(data.quoteVolume));
        // Para konczy sie na USDT, wiec cena jest w stablecoinie, nie
        // w dolarach. Etykieta 'USD' szla dalej do wyceny portfela
        // i do rozliczenia jako waluta fiat.
        return {
          ticker,
          name: cryptoTicker,
          category: 'CRYPTO',
          price: cena,
          currency: 'USD',
          change24h: zmiana === null ? null : zaokragl2(zmiana),
          changePercent24h: zmianaProc === null ? null : zaokragl2(zmianaProc),
          high24h: wysoka,
          low24h: niska,
          volume24h: obrot,
          sparkline: [],
          lastUpdated: new Date().toISOString(),
          source: 'BINANCE',
          dostawcaDanych: 'BINANCE',
          parazrodlowa: `${cryptoTicker}USDT`,
          uwaga: 'Cena z pary USDT na Binance; aplikacja nie ma osobnej waluty dla stablecoina.',
        };
      }
    }
  }
  // Ten sam symbol dostawcy co na serwerze: NBIS.US -> NBIS, CDR.PL -> CDR.WA, VWCE -> VWCE.DE.
  const mapowanie = SYMBOL_MAP[ticker.trim().toUpperCase()];
  for (const symbol of kandydaciSymboluDostawcy(ticker)) {
    const extUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
    const res = await tauriFetch(extUrl, { method: 'GET' });
    if (!res.ok) continue;
    const data = await res.json();
    const wynik = data?.chart?.result?.[0];
    const meta = wynik?.meta;
    const sourceCurrency = meta?.currency;
    const cena = normalizePencePrice(meta?.regularMarketPrice, sourceCurrency);
    const currency = sourceCurrency === 'GBp' || String(sourceCurrency).toUpperCase() === 'GBX' ? 'GBP' : sourceCurrency;
    if (cena === null || !(cena > 0) || !currency) continue;
    const poprzednie = normalizePencePrice(meta?.chartPreviousClose ?? meta?.previousClose, sourceCurrency);
    const zmiana = poprzednie !== null && poprzednie > 0 ? cena - poprzednie : null;
    const zmianaProc = zmiana !== null && poprzednie ? (zmiana / poprzednie) * 100 : null;
    const zakres = (pole: unknown): number | null => {
      const wartosc = normalizePencePrice(pole, sourceCurrency);
      return wartosc === null ? null : zaokragl2(wartosc);
    };
    const zamkniecia: number[] = (wynik?.indicators?.quote?.[0]?.close ?? [])
      .map((wartosc: unknown) => normalizePencePrice(wartosc, sourceCurrency))
      .filter((wartosc: number | null): wartosc is number => wartosc !== null)
      .map(zaokragl2);
    const jestPLN = sourceCurrency === 'PLN' || symbol.endsWith('.WA');
    return {
      ticker,
      name: mapowanie?.name || meta?.longName || meta?.shortName || ticker.trim().toUpperCase(),
      category: mapowanie?.category || (meta?.instrumentType === 'ETF' ? 'ETF' : (jestPLN ? 'STOCK_PL' : 'STOCK_FOREIGN')),
      price: zaokragl2(cena),
      currency: mapowanie?.currency || currency,
      change24h: zmiana === null ? null : zaokragl2(zmiana),
      changePercent24h: zmianaProc === null ? null : zaokragl2(zmianaProc),
      high24h: zakres(meta?.regularMarketDayHigh),
      low24h: zakres(meta?.regularMarketDayLow),
      volume24h: liczbaLubNull(meta?.regularMarketVolume),
      // Pojedynczy punkt to nie szereg; pusta tablica znaczy "brak szeregu".
      sparkline: zamkniecia.length >= 2 ? zamkniecia : [],
      quoteUnit: sourceCurrency === 'GBp' ? 'pence converted to GBP' : undefined,
      lastUpdated: new Date().toISOString(),
      source: mapowanie?.source || (symbol.endsWith('.WA') ? 'GPW' : 'TRADINGVIEW'),
      dostawcaDanych: 'YAHOO_FINANCE',
    };
  }
  return null;
}

/**
 * Zintegrowany helper transportowy dla zapytań API.
 * W trybie WEB korzysta z wbudowanego serwera Express.
 * W trybie DESKTOP (Tauri) mapuje żądania na zewnętrzne API za pomocą wtyczki HTTP.
 */
export async function apiFetch(url: string, options?: RequestInit): Promise<Response> {
  if (!isTauri()) {
    return fetch(url, options);
  }

  // Intercepting Express calls in Desktop mode
  const baseParts = url.split('?');
  const path = baseParts[0];
  const qs = baseParts[1] ? `?${baseParts[1]}` : '';
  const searchParams = new URLSearchParams(qs);

  try {
    if (path.startsWith('/api/brokers/freedom24/')) {
      const requestBody = options?.body ? JSON.parse(String(options.body)) : {};
      const command = path.endsWith('/status')
        ? 'freedom24_status'
        : path.endsWith('/auth-check')
        ? 'freedom24_auth_check'
        : path.endsWith('/portfolio')
        ? 'freedom24_portfolio'
        : path.endsWith('/full-export')
        ? 'freedom24_full_export'
        : null;
      if (!command) {
        return bezSerweraAplikacji()
          ? niedostepneWDesktopie()
          : fetch(url, options);
      }
      const result = await invoke<{ status: number; body: unknown }>(command, { request: requestBody });
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (path.startsWith('/api/nbp/rate')) {
      const currency = (searchParams.get('currency') || 'USD').toUpperCase();
      const date = searchParams.get('date') || dzisiajLokalnie();
      if (currency === 'PLN') {
        const rate = { currency, code: currency, table: 'A', no: 'BRAK/PLN', effectiveDate: date.slice(0, 10), mid: 1 };
        return new Response(JSON.stringify({ success: true, data: rate, requestedDate: date, appliedTableDate: rate.effectiveDate, source: 'NBP_API_OFFICIAL' }));
      }
      let targetDate = previousUtcDay(date);
      for (let attempt = 0; attempt < 10; attempt++) {
        const extUrl = `https://api.nbp.pl/api/exchangerates/rates/a/${encodeURIComponent(currency.toLowerCase())}/${targetDate}/?format=json`;
        const res = await tauriFetch(extUrl, { method: 'GET', headers: { Accept: 'application/json' } });
        if (res.ok) {
          const data = await res.json();
          if (data?.rates?.length > 0) {
            const rateInfo = data.rates[0];
            const rate = { currency, code: currency, table: data.table || 'A', no: rateInfo.no, effectiveDate: rateInfo.effectiveDate, mid: rateInfo.mid };
            return new Response(JSON.stringify({ success: true, data: rate, requestedDate: date, appliedTableDate: rate.effectiveDate, source: 'NBP_API_OFFICIAL' }));
          }
          break;
        }
        if (res.status !== 404) break;
        targetDate = previousUtcDay(targetDate);
      }
      return new Response(JSON.stringify({ success: false, error: `Nie udało się pobrać kursu NBP dla ${currency} na dzień ${date}.`, currency, requestedDate: date }), { status: 503 });
    }

    if (path.startsWith('/api/quote/')) {
       const ticker = path.split('/').pop()!;
       const quote = await pobierzNotowanieDesktop(ticker);
       if (quote) return new Response(JSON.stringify({ success: true, quote }));
       return new Response(JSON.stringify({ success: false, error: 'Quote not found' }), { status: 404 });
    }

    if (path === '/api/quotes') {
       // Jak GET /api/quotes serwera: lista po przecinku, limit i rownolegle pobrania.
       const tickery = [...new Set((searchParams.get('tickers') || '')
         .split(',')
         .map((t) => t.trim().toUpperCase())
         .filter(Boolean))];
       if (tickery.length > MAX_TICKEROW_NA_ZADANIE) {
         return new Response(JSON.stringify({
           success: false,
           error: `Zbyt wiele instrumentów w jednym zapytaniu (limit ${MAX_TICKEROW_NA_ZADANIE}).`,
         }), { status: 400, headers: { 'Content-Type': 'application/json' } });
       }
       const wyniki = await mapaZLimitem(tickery, MAX_ROWNOLEGLYCH_POBRAN, async (ticker) => {
         try {
           return await pobierzNotowanieDesktop(ticker);
         } catch (e) {
           console.warn(`[Desktop Transport] Notowanie ${ticker} niedostępne`, e);
           return null;
         }
       });
       const quotes: Record<string, unknown> = {};
       tickery.forEach((ticker, indeks) => {
         if (wyniki[indeks]) quotes[ticker] = wyniki[indeks];
       });
       return new Response(JSON.stringify({
         success: true,
         quotes,
         staleTickers: [],
         allStale: false,
         timestamp: new Date().toISOString(),
         fetchedCount: tickery.length,
         cachedCount: 0,
         source: 'REAL_LIVE_FEED',
       }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (path.startsWith('/api/supported-assets')) {
        // Fallback or static list if possible
        // Actually, returning a 404 here gracefully forces the fallback in marketDataService
        return new Response(JSON.stringify({ success: false }), { status: 404 });
    }

    if (path.startsWith('/api/search-tickers')) {
        const q = searchParams.get('q');
        const extUrl = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q || '')}&quotesCount=8&newsCount=0`;
        const res = await tauriFetch(extUrl, { method: 'GET' });
        if (res.ok) {
           const data = await res.json();
           const results = (data.quotes || []).map((q: any) => ({
               ticker: q.symbol,
               name: q.shortname || q.longname || q.symbol,
               exchange: q.exchange,
               currency: 'USD',
               category: q.quoteType === 'ETF' ? 'ETF' : 'STOCK_FOREIGN',
               brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'DEGIRO']
           }));
           return new Response(JSON.stringify({ success: true, results }));
        }
        return new Response(JSON.stringify({ success: false }));
    }

    // Default fallback
    if (path.startsWith('/api/') && bezSerweraAplikacji()) {
      return niedostepneWDesktopie();
    }
    return fetch(url, options);

  } catch(e) {
    console.warn(`[Desktop Transport] Failed to intercept ${path}`, e);
    return new Response(JSON.stringify({ success: false, error: String(e) }), { status: 500 });
  }
}
