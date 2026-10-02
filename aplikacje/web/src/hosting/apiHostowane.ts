/**
 * Lekkie API dla hostowanej wersji aplikacji (Worker Cloudflare, plan darmowy).
 *
 * Telefon nie ma serwera Node ani silnika Pythona, wiec tutaj dziala tylko to,
 * co da sie policzyc z publicznych zrodel bez stanu: notowania i historia z Yahoo
 * Finance, kursy NBP, wyszukiwarka tickerow. Ksztalt odpowiedzi jest taki sam jak
 * w serwerze web (routes/quotes.ts, routes/nbp.ts), zeby widoki nie rozrozniały
 * wersji. Reszta tras (silnik podatkowy, magazyn plikow, kopie, Ollama, broker)
 * dostaje jednoznaczna odmowe 501 z kodem NIEDOSTEPNE_W_HOSTINGU - jak desktop
 * bez serwera (apiTransport.ts), zeby odmowa nie wygladala na wynik niepewny.
 *
 * Modul jest czysty: `fetch` i pamiec brzegowa przychodza z zewnatrz, wiec testy
 * podstawiaja atrapy, a Worker podaje swoje.
 */
import { SYMBOL_MAP, kandydaciSymboluDostawcy } from '../shared/symbolDostawcy';
import {
  czyInterwalSrodsesyjny,
  dopasujInterwalDoZakresu,
  etykietaPunktu,
  graniceSesjiRegularnej,
  normalizePenceQuote,
  normalizedQuoteCurrency,
  sesjaSwiecy,
} from '../shared/notowaniaYahoo';

import { KOD_NIEDOSTEPNE_W_HOSTINGU, KOMUNIKAT_NIEDOSTEPNE_W_HOSTINGU } from '../shared/kodyHostingu';

export { KOD_NIEDOSTEPNE_W_HOSTINGU, KOMUNIKAT_NIEDOSTEPNE_W_HOSTINGU };

/** Limity jak w GET /api/quotes serwera (routes/quotes.ts). */
export const MAX_TICKEROW_NA_ZADANIE = 100;
export const MAX_ROWNOLEGLYCH_POBRAN = 8;

/** Czas trzymania odpowiedzi w pamieci brzegowej: notowania krotko, historia i wyszukiwanie dluzej. */
const SEKUNDY_PAMIECI = { quotes: 10, history: 60, search: 300, nbp: 3600 } as const;

export type FetchHostingu = (url: string, init?: RequestInit) => Promise<Response>;

export interface ZaleznosciHostingu {
  fetch: FetchHostingu;
  /** Pamiec brzegowa (Cache API). Brak = bez pamieci; testy i srodowiska bez Cache API. */
  cache?: Cache;
  teraz?: () => Date;
}

const NAGLOWKI_DOSTAWCY = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json',
};

function json(cialo: unknown, status = 200, naglowki: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(cialo), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...naglowki },
  });
}

export function niedostepneWHostingu(): Response {
  return json({
    success: false,
    status: 'REJECTED',
    errorCode: KOD_NIEDOSTEPNE_W_HOSTINGU,
    error: KOMUNIKAT_NIEDOSTEPNE_W_HOSTINGU,
    message: KOMUNIKAT_NIEDOSTEPNE_W_HOSTINGU,
  }, 501);
}

const zaokragl2 = (wartosc: number): number => Number(wartosc.toFixed(2));

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

async function pobierzJsonDostawcy(fetchFn: FetchHostingu, url: string, limitMs: number): Promise<any | null> {
  try {
    const odpowiedz = await fetchFn(url, { headers: NAGLOWKI_DOSTAWCY, signal: AbortSignal.timeout(limitMs) });
    if (!odpowiedz.ok) return null;
    return await odpowiedz.json();
  } catch {
    return null;
  }
}

/** Notowanie z Yahoo w ksztalcie serwera web (fetchYahooQuote w routes/quotes.ts); null gdy brak. */
export async function notowanieYahoo(fetchFn: FetchHostingu, ticker: string): Promise<Record<string, unknown> | null> {
  const upperTicker = ticker.trim().toUpperCase();
  const mapping = SYMBOL_MAP[upperTicker];
  for (const candidate of kandydaciSymboluDostawcy(upperTicker)) {
    const data = await pobierzJsonDostawcy(
      fetchFn,
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(candidate)}?interval=1d&range=5d`,
      3500,
    );
    const result = data?.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta) continue;
    const sourceCurrency = meta.currency;
    const price = normalizePenceQuote(meta.regularMarketPrice ?? meta.chartPreviousClose, sourceCurrency);
    // Odpowiedz bez ceny to brak notowania, nie cena 0.
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) continue;
    const prevClose = normalizePenceQuote(meta.chartPreviousClose, sourceCurrency) ?? price;
    const change24h = price - prevClose;
    const changePercent24h = prevClose !== 0 ? (change24h / prevClose) * 100 : 0;
    const closeArray: unknown[] = result.indicators?.quote?.[0]?.close || [];
    const sparkline = closeArray
      .filter((v): v is number => typeof v === 'number' && !Number.isNaN(v))
      .map((v) => normalizePenceQuote(v, sourceCurrency))
      .filter((v): v is number => typeof v === 'number')
      .map(zaokragl2);
    const isPLN = sourceCurrency === 'PLN' || candidate.endsWith('.WA');
    const isEUR = sourceCurrency === 'EUR' || candidate.endsWith('.DE');
    const defaultCurrency = isPLN ? 'PLN' : (isEUR ? 'EUR' : 'USD');
    const zakres = (pole: unknown): number | null =>
      typeof pole === 'number' ? zaokragl2(normalizePenceQuote(pole, sourceCurrency) as number) : null;
    return {
      ticker: upperTicker,
      name: mapping?.name || meta.longName || meta.shortName || upperTicker,
      category: mapping?.category || (meta.instrumentType === 'ETF' ? 'ETF' : (isPLN ? 'STOCK_PL' : 'STOCK_FOREIGN')),
      price: zaokragl2(price),
      currency: mapping?.currency || normalizedQuoteCurrency(sourceCurrency) || defaultCurrency,
      change24h: zaokragl2(change24h),
      changePercent24h: zaokragl2(changePercent24h),
      high24h: zakres(meta.regularMarketDayHigh),
      low24h: zakres(meta.regularMarketDayLow),
      quoteUnit: sourceCurrency === 'GBp' || String(sourceCurrency).toUpperCase() === 'GBX' ? 'pence converted to GBP' : undefined,
      volume24h: typeof meta.regularMarketVolume === 'number' ? meta.regularMarketVolume : null,
      sparkline,
      lastUpdated: new Date().toISOString(),
      source: mapping?.source || (candidate.endsWith('.WA') ? 'GPW' : 'TRADINGVIEW'),
      dostawcaDanych: 'YAHOO_FINANCE',
    };
  }
  return null;
}

/** Historia swiec z Yahoo w ksztalcie serwera web (fetchHistoricalChart), bez swiec nocnych z probek serwera. */
export async function historiaYahoo(fetchFn: FetchHostingu, ticker: string, range: string, interval: string): Promise<Record<string, unknown> | null> {
  const upperTicker = ticker.trim().toUpperCase();
  const { interval: validInterval, range: validRange } = dopasujInterwalDoZakresu(interval, range);
  for (const yahooSymbol of kandydaciSymboluDostawcy(upperTicker)) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=${validInterval}&range=${validRange}${czyInterwalSrodsesyjny(validInterval) ? '&includePrePost=true' : ''}`;
    const data = await pobierzJsonDostawcy(fetchFn, url, 4000);
    const result = data?.chart?.result?.[0];
    if (!result) continue;
    const timestamps: number[] = result.timestamp || [];
    const granice = graniceSesjiRegularnej(result.meta);
    const quotes = result.indicators?.quote?.[0] || {};
    const opens = quotes.open || [];
    const highs = quotes.high || [];
    const lows = quotes.low || [];
    const closes = quotes.close || [];
    const volumes = quotes.volume || [];
    const candlePrice = (value: number) => zaokragl2(normalizePenceQuote(value, result.meta?.currency) as number);
    const points = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (closes[i] === null || closes[i] === undefined || Number.isNaN(closes[i])) continue;
      const ts = timestamps[i] * 1000;
      points.push({
        timestamp: ts,
        date: etykietaPunktu(ts, validRange, validInterval),
        open: candlePrice(opens[i] || closes[i]),
        high: candlePrice(highs[i] || closes[i]),
        low: candlePrice(lows[i] || closes[i]),
        close: candlePrice(closes[i]),
        volume: volumes[i] || 0,
        session: sesjaSwiecy(timestamps[i], granice),
      });
    }
    if (points.length > 0) {
      return {
        ticker: upperTicker,
        range: validRange,
        interval: validInterval,
        points,
        meta: {
          currency: normalizedQuoteCurrency(result.meta?.currency),
          exchange: result.meta?.exchangeName,
          symbol: yahooSymbol,
        },
      };
    }
  }
  return null;
}

function poprzedniDzienUtc(date: string): string {
  const day = new Date(`${date.slice(0, 10)}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

/** Kurs NBP z tabeli A na dzien poprzedzajacy (T-1), jak serwer i desktop; cofanie o dni bez tabeli. */
export async function kursNbp(fetchFn: FetchHostingu, currency: string, date: string): Promise<Response> {
  const waluta = currency.toUpperCase();
  if (waluta === 'PLN') {
    const rate = { currency: waluta, code: waluta, table: 'A', no: 'BRAK/PLN', effectiveDate: date.slice(0, 10), mid: 1 };
    return json({ success: true, data: rate, requestedDate: date, appliedTableDate: rate.effectiveDate, source: 'NBP_API_OFFICIAL' });
  }
  let targetDate = poprzedniDzienUtc(date);
  for (let proba = 0; proba < 10; proba++) {
    let odpowiedz: Response;
    try {
      odpowiedz = await fetchFn(
        `https://api.nbp.pl/api/exchangerates/rates/a/${encodeURIComponent(waluta.toLowerCase())}/${targetDate}/?format=json`,
        { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) },
      );
    } catch {
      break;
    }
    if (odpowiedz.ok) {
      const data: any = await odpowiedz.json();
      const rateInfo = data?.rates?.[0];
      if (rateInfo) {
        const rate = { currency: waluta, code: waluta, table: data.table || 'A', no: rateInfo.no, effectiveDate: rateInfo.effectiveDate, mid: rateInfo.mid };
        return json({ success: true, data: rate, requestedDate: date, appliedTableDate: rate.effectiveDate, source: 'NBP_API_OFFICIAL' });
      }
      break;
    }
    if (odpowiedz.status !== 404) break;
    targetDate = poprzedniDzienUtc(targetDate);
  }
  return json({ success: false, error: `Nie udało się pobrać kursu NBP dla ${waluta} na dzień ${date}.`, currency: waluta, requestedDate: date }, 503);
}

/** Wyszukiwarka: najpierw wykaz lokalny (SYMBOL_MAP), potem Yahoo - jak /search-tickers serwera. */
export async function szukajTickerow(fetchFn: FetchHostingu, q: string): Promise<Record<string, unknown>> {
  const zapytanie = q.trim();
  if (!zapytanie) return { success: true, query: zapytanie, results: [] };
  const queryUpper = zapytanie.toUpperCase();
  const wyniki = new Map<string, Record<string, unknown>>();
  for (const [ticker, val] of Object.entries(SYMBOL_MAP)) {
    if (ticker.includes(queryUpper) || val.name.toUpperCase().includes(queryUpper)) {
      wyniki.set(ticker, {
        ticker,
        name: val.name,
        category: val.category,
        currency: val.currency,
        exchange: val.source === 'GPW' ? 'GPW Warszawa' : (val.currency === 'EUR' ? 'XETRA' : 'NASDAQ/NYSE'),
        brokers: val.brokers || [],
        isKnown: true,
      });
    }
  }
  if (zapytanie.length >= 2) {
    const data = await pobierzJsonDostawcy(
      fetchFn,
      `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(zapytanie)}&quotesCount=8&newsCount=0`,
      3000,
    );
    for (const item of Array.isArray(data?.quotes) ? data.quotes : []) {
      const rawSymbol: string = item.symbol || '';
      if (!rawSymbol) continue;
      let cleanTicker = rawSymbol;
      let exchange = item.exchDisp || item.exchange || 'Global';
      let category = 'STOCK_FOREIGN';
      let currency = 'USD';
      if (rawSymbol.endsWith('.WA')) {
        cleanTicker = rawSymbol.replace('.WA', '');
        exchange = 'GPW Warszawa';
        category = 'STOCK_PL';
        currency = 'PLN';
      } else if (rawSymbol.endsWith('.DE')) {
        cleanTicker = rawSymbol.replace('.DE', '');
        exchange = 'XETRA';
        category = 'ETF';
        currency = 'EUR';
      } else if (item.quoteType === 'ETF') {
        category = 'ETF';
      } else if (item.quoteType === 'CRYPTOCURRENCY') {
        category = 'CRYPTO';
      }
      if (!wyniki.has(cleanTicker) && !wyniki.has(rawSymbol)) {
        wyniki.set(cleanTicker, {
          ticker: cleanTicker,
          yahooSymbol: rawSymbol,
          name: item.shortname || item.longname || cleanTicker,
          category,
          currency,
          exchange,
          brokers: category === 'STOCK_PL'
            ? ['XTB', 'EMAKLER', 'IBKR', 'FREEDOM24']
            : (category === 'CRYPTO' ? ['BINANCE', 'REVOLUT'] : ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'DEGIRO']),
          isKnown: false,
        });
      }
    }
  }
  return { success: true, query: zapytanie, results: Array.from(wyniki.values()) };
}

export function wykazInstrumentow(): Record<string, unknown> {
  const assets = Object.entries(SYMBOL_MAP).map(([ticker, val]) => ({
    ticker,
    name: val.name,
    category: val.category,
    currency: val.currency,
    exchange: val.source === 'GPW' ? 'GPW Warszawa' : (val.currency === 'EUR' ? 'XETRA / Europa' : 'USA (NASDAQ/NYSE)'),
    brokers: val.brokers || [],
    source: val.source,
  }));
  return { success: true, total: assets.length, assets };
}

/**
 * Odpowiedz z pamieci brzegowej albo policzona i odlozona na `sekundy`.
 * Klucz to adres zadania; `force=true` w zapytaniu omija pamiec (jak na serwerze).
 */
async function zPamieciaBrzegowa(
  zal: ZaleznosciHostingu,
  request: Request,
  sekundy: number,
  policz: () => Promise<Response>,
): Promise<Response> {
  const url = new URL(request.url);
  const omin = url.searchParams.get('force') === 'true' || !zal.cache;
  url.searchParams.delete('force');
  const klucz = new Request(url.toString(), { method: 'GET' });
  if (!omin) {
    try {
      const zapamietana = await zal.cache!.match(klucz);
      if (zapamietana) return zapamietana;
    } catch {
      // Brak pamieci brzegowej nie jest bledem - liczymy od nowa.
    }
  }
  const odpowiedz = await policz();
  if (odpowiedz.ok && zal.cache) {
    const doPamieci = new Response(odpowiedz.clone().body, odpowiedz);
    doPamieci.headers.set('Cache-Control', `public, max-age=${sekundy}`);
    try {
      await zal.cache.put(klucz, doPamieci);
    } catch {
      // Odpowiedz i tak wraca do klienta.
    }
  }
  return odpowiedz;
}

/** Router `/api/*` hostowanej wersji. */
export async function obsluzApiHostowane(request: Request, zal: ZaleznosciHostingu): Promise<Response> {
  const url = new URL(request.url);
  const sciezka = url.pathname;
  const metoda = request.method.toUpperCase();

  if (sciezka === '/api/health') {
    return json({ ok: true, status: 'ok', tryb: 'hosting', timestamp: (zal.teraz?.() ?? new Date()).toISOString() });
  }

  if (metoda === 'GET' && sciezka === '/api/quotes') {
    const tickery = [...new Set((url.searchParams.get('tickers') || '')
      .split(',')
      .map((t) => t.trim().toUpperCase())
      .filter(Boolean))];
    if (tickery.length > MAX_TICKEROW_NA_ZADANIE) {
      return json({ success: false, error: `Zbyt wiele instrumentów w jednym zapytaniu (limit ${MAX_TICKEROW_NA_ZADANIE}).` }, 400);
    }
    return zPamieciaBrzegowa(zal, request, SEKUNDY_PAMIECI.quotes, async () => {
      const wyniki = await mapaZLimitem(tickery, MAX_ROWNOLEGLYCH_POBRAN, (ticker) => notowanieYahoo(zal.fetch, ticker));
      const quotes: Record<string, unknown> = {};
      tickery.forEach((ticker, indeks) => {
        if (wyniki[indeks]) quotes[ticker] = wyniki[indeks];
      });
      return json({
        success: true,
        quotes,
        staleTickers: [],
        allStale: false,
        timestamp: new Date().toISOString(),
        fetchedCount: tickery.length,
        cachedCount: 0,
        source: 'REAL_LIVE_FEED',
      });
    });
  }

  if (metoda === 'GET' && sciezka.startsWith('/api/quote/')) {
    const ticker = decodeURIComponent(sciezka.slice('/api/quote/'.length));
    return zPamieciaBrzegowa(zal, request, SEKUNDY_PAMIECI.quotes, async () => {
      const quote = await notowanieYahoo(zal.fetch, ticker);
      return quote
        ? json({ success: true, quote })
        : json({ success: false, error: `Quote for ${ticker.toUpperCase()} not found` }, 404);
    });
  }

  if (metoda === 'GET' && sciezka.startsWith('/api/history/')) {
    const ticker = decodeURIComponent(sciezka.slice('/api/history/'.length));
    const range = url.searchParams.get('range') || '1mo';
    const interval = url.searchParams.get('interval') || '1d';
    return zPamieciaBrzegowa(zal, request, SEKUNDY_PAMIECI.history, async () => {
      const data = await historiaYahoo(zal.fetch, ticker, range, interval);
      return data
        ? json({ success: true, data })
        : json({ success: false, error: `Brak historii notowań dla ${ticker.toUpperCase()}.` }, 404);
    });
  }

  if (metoda === 'GET' && sciezka === '/api/nbp/rate') {
    const currency = url.searchParams.get('currency') || 'USD';
    const date = url.searchParams.get('date') || (zal.teraz?.() ?? new Date()).toISOString().slice(0, 10);
    return zPamieciaBrzegowa(zal, request, SEKUNDY_PAMIECI.nbp, () => kursNbp(zal.fetch, currency, date));
  }

  if (metoda === 'GET' && sciezka === '/api/search-tickers') {
    return zPamieciaBrzegowa(zal, request, SEKUNDY_PAMIECI.search, async () =>
      json(await szukajTickerow(zal.fetch, url.searchParams.get('q') || '')));
  }

  if (metoda === 'GET' && sciezka === '/api/supported-assets') {
    return json(wykazInstrumentow(), 200, { 'Cache-Control': 'public, max-age=3600' });
  }

  return niedostepneWHostingu();
}
