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
 * API jest publiczne i bez logowania, wiec broni sie samo:
 *  - wejscie jest walidowane wzorcami (shared/walidacjaNotowan.ts) - do dostawcow
 *    idzie tylko to, co ma sens; nieznana waluta nie trafia do NBP;
 *  - obce strony nie uzyja go z przegladarki jako proxy (Sec-Fetch-Site: cross-site
 *    dostaje 403), a kazdy adres IP (IPv6: prefiks /64) ma limit zadan na minute
 *    (429 z Retry-After); limit notowan liczy sie dopiero po chybieniu pamieci
 *    brzegowej, bo trafienie nie kosztuje dostawcy;
 *  - plan darmowy pozwala na 50 subrequestow na wywolanie (fetch + Cache API):
 *    kazde zadanie ma budzet pobran, a instrumenty, na ktore go zabraklo, wracaja
 *    jawnie w `staleTickers`/`pominieteLimitPobran` zamiast cicho znikac;
 *  - pamiec brzegowa ma kanoniczny klucz (tylko znane parametry, posortowane):
 *    smieciowe parametry nie omijaja pamieci i nie mnoza wpisow; `force=true`
 *    omija tylko wpisy starsze niz kilka sekund;
 *  - odpowiedz dostawcy jest czytana z limitem rozmiaru, a kazda odpowiedz API
 *    niesie naglowki bezpieczenstwa; wyjatek na szczycie konczy sie neutralnym 500.
 *
 * Modul jest czysty: `fetch`, pamiec brzegowa i ograniczniki przychodza z zewnatrz,
 * wiec testy podstawiaja atrapy, a Worker podaje swoje.
 */
import { SYMBOL_MAP, kandydaciSymboluDostawcy, symbolYahooKrypto } from '../shared/symbolDostawcy';
import {
  czyInterwalSrodsesyjny,
  dopasujInterwalDoZakresu,
  etykietaPunktu,
  graniceSesjiRegularnej,
  normalizePenceQuote,
  normalizedQuoteCurrency,
  sesjaSwiecy,
} from '../shared/notowaniaYahoo';
import {
  DOZWOLONE_INTERWALY,
  DOZWOLONE_ZAKRESY,
  MAX_DLUGOSC_TICKERA,
  MAX_DLUGOSC_ZAPYTANIA,
  czyPoprawnaDataKursu,
  kluczLimituZAdresu,
  normalizujListeTickerow,
  normalizujTicker,
  normalizujWalute,
  normalizujZapytanie,
} from '../shared/walidacjaNotowan';

import { KOD_NIEDOSTEPNE_W_HOSTINGU, KOMUNIKAT_NIEDOSTEPNE_W_HOSTINGU } from '../shared/kodyHostingu';

export { KOD_NIEDOSTEPNE_W_HOSTINGU, KOMUNIKAT_NIEDOSTEPNE_W_HOSTINGU };
export {
  DOZWOLONE_INTERWALY,
  DOZWOLONE_ZAKRESY,
  MAX_DLUGOSC_TICKERA,
  MAX_DLUGOSC_ZAPYTANIA,
  czyPoprawnaDataKursu,
  kluczLimituZAdresu,
  normalizujListeTickerow,
  normalizujTicker,
  normalizujWalute,
  normalizujZapytanie,
};

/** Limity jak w GET /api/quotes serwera (routes/quotes.ts). */
export const MAX_TICKEROW_NA_ZADANIE = 100;
/** Plan darmowy Workers dopuszcza 6 jednoczesnych polaczen wychodzacych. */
export const MAX_ROWNOLEGLYCH_POBRAN = 6;
/** Plan darmowy: 50 subrequestow na wywolanie (fetch i Cache API razem); zostaje zapas na match/put. */
export const BUDZET_POBRAN_NA_ZADANIE = 44;
/** Granica dlugosci adresu zadania. */
export const MAX_DLUGOSC_ADRESU = 2048;
/** `force=true` nie odswieza wpisu mlodszego niz tyle sekund (klient nie wymusi lawiny pobran). */
export const SEKUNDY_SWIEZOSCI_PRZY_FORCE = 5;

/** Odpowiedz dostawcy wieksza niz to jest odrzucana (10 lat swiec dziennych to ok. 200 kB). */
export const MAX_BAJTOW_ODPOWIEDZI_DOSTAWCY = 4 * 1024 * 1024;

/** Czas trzymania odpowiedzi w pamieci brzegowej: notowania krotko, historia i wyszukiwanie dluzej. */
const SEKUNDY_PAMIECI = { quotes: 10, history: 60, search: 300, nbp: 3600 } as const;

export type FetchHostingu = (url: string, init?: RequestInit) => Promise<Response>;

/** Ogranicznik zadan: `true` = zadanie miesci sie w limicie dla klucza (adresu IP). */
export type OgranicznikZadan = (klucz: string) => Promise<boolean>;

export interface ZaleznosciHostingu {
  fetch: FetchHostingu;
  /** Pamiec brzegowa (Cache API). Brak = bez pamieci; testy i srodowiska bez Cache API. */
  cache?: Cache;
  teraz?: () => Date;
  /** Adres IP klienta (naglowek CF-Connecting-IP w Workerze) - klucz limitow. */
  ip?: string;
  /** Limity per IP: `api` dla calego /api, `notowania` dla tras odpytujacych Yahoo po chybieniu pamieci. Brak = bez limitu. */
  limity?: { api?: OgranicznikZadan; notowania?: OgranicznikZadan };
}

/** Budzet subrequestow jednego wywolania Workera. */
export interface BudzetPobran {
  pozostalo: number;
  /** Ile pobran odrzucono po wyczerpaniu budzetu. */
  odrzucone: number;
}

export const nowyBudzet = (pobran = BUDZET_POBRAN_NA_ZADANIE): BudzetPobran => ({ pozostalo: pobran, odrzucone: 0 });

const NAGLOWKI_DOSTAWCY = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json',
};

/** Naglowek z czasem zapisu w pamieci brzegowej (do oceny swiezosci przy `force`). */
const NAGLOWEK_ZAPISU = 'X-Zapisano';

/**
 * Naglowki kazdej odpowiedzi API. JSON nie jest dokumentem: nie wolno go osadzic
 * w ramce, interpretowac jako HTML ani czytac z obcego originu w trybie no-cors.
 */
export const NAGLOWKI_BEZPIECZENSTWA_API: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};

function json(cialo: unknown, status = 200, naglowki: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(cialo), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...NAGLOWKI_BEZPIECZENSTWA_API,
      ...naglowki,
    },
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

const bladWejscia = (komunikat: string): Response => json({ success: false, error: komunikat }, 400);

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

/**
 * Tresc odpowiedzi jako JSON, czytana strumieniem z gornym limitem bajtow. Dostawca
 * (albo ktos w jego miejscu) nie moze zapchac pamieci Workera jedna odpowiedzia.
 * `null` przy przekroczeniu, braku tresci albo nieprawidlowym JSON.
 */
export async function odczytajJsonZLimitem(odpowiedz: Response, maxBajtow = MAX_BAJTOW_ODPOWIEDZI_DOSTAWCY): Promise<any | null> {
  const zadeklarowane = Number(odpowiedz.headers.get('content-length'));
  if (Number.isFinite(zadeklarowane) && zadeklarowane > maxBajtow) return null;
  if (!odpowiedz.body) return null;
  const czytnik = odpowiedz.body.getReader();
  const czesci: Uint8Array[] = [];
  let razem = 0;
  try {
    for (;;) {
      const { done, value } = await czytnik.read();
      if (done) break;
      razem += value.byteLength;
      if (razem > maxBajtow) {
        await czytnik.cancel().catch(() => {});
        return null;
      }
      czesci.push(value);
    }
  } catch {
    return null;
  }
  const calosc = new Uint8Array(razem);
  let pozycja = 0;
  for (const czesc of czesci) {
    calosc.set(czesc, pozycja);
    pozycja += czesc.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(calosc));
  } catch {
    return null;
  }
}

/** Jedno pobranie z dostawcy w ramach budzetu; po wyczerpaniu budzetu `null` bez sieci. */
async function pobierzJsonDostawcy(fetchFn: FetchHostingu, url: string, limitMs: number, budzet?: BudzetPobran): Promise<any | null> {
  if (budzet) {
    if (budzet.pozostalo <= 0) {
      budzet.odrzucone += 1;
      return null;
    }
    budzet.pozostalo -= 1;
  }
  try {
    const odpowiedz = await fetchFn(url, { headers: NAGLOWKI_DOSTAWCY, signal: AbortSignal.timeout(limitMs) });
    if (!odpowiedz.ok) return null;
    return await odczytajJsonZLimitem(odpowiedz);
  } catch {
    return null;
  }
}

/** Notowanie z Yahoo w ksztalcie serwera web (fetchYahooQuote w routes/quotes.ts); null gdy brak. */
export async function notowanieYahoo(fetchFn: FetchHostingu, ticker: string, budzet?: BudzetPobran): Promise<Record<string, unknown> | null> {
  const upperTicker = ticker.trim().toUpperCase();
  const mapping = SYMBOL_MAP[upperTicker];
  // Kryptowaluta: tylko para z dolarem (SOL-USD); goly symbol to u Yahoo akcja o tym samym tickerze.
  const krypto = symbolYahooKrypto(upperTicker);
  for (const candidate of krypto ? [krypto.symbol] : kandydaciSymboluDostawcy(upperTicker)) {
    if (budzet && budzet.pozostalo <= 0) {
      budzet.odrzucone += 1;
      return null;
    }
    const data = await pobierzJsonDostawcy(
      fetchFn,
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(candidate)}?interval=1d&range=5d`,
      3500,
      budzet,
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
      name: krypto?.name || mapping?.name || meta.longName || meta.shortName || upperTicker,
      category: krypto ? 'CRYPTO' : (mapping?.category || (meta.instrumentType === 'ETF' ? 'ETF' : (isPLN ? 'STOCK_PL' : 'STOCK_FOREIGN'))),
      price: zaokragl2(price),
      currency: krypto ? 'USD' : (mapping?.currency || normalizedQuoteCurrency(sourceCurrency) || defaultCurrency),
      change24h: zaokragl2(change24h),
      changePercent24h: zaokragl2(changePercent24h),
      high24h: zakres(meta.regularMarketDayHigh),
      low24h: zakres(meta.regularMarketDayLow),
      quoteUnit: sourceCurrency === 'GBp' || String(sourceCurrency).toUpperCase() === 'GBX' ? 'pence converted to GBP' : undefined,
      volume24h: typeof meta.regularMarketVolume === 'number' ? meta.regularMarketVolume : null,
      sparkline,
      lastUpdated: new Date().toISOString(),
      // `source` to etykieta rynku jak w serwerze (krypto: BINANCE); prawdziwy dostawca jest w `dostawcaDanych`.
      source: krypto ? 'BINANCE' : (mapping?.source || (candidate.endsWith('.WA') ? 'GPW' : 'TRADINGVIEW')),
      dostawcaDanych: 'YAHOO_FINANCE',
    };
  }
  return null;
}

/** Historia swiec z Yahoo w ksztalcie serwera web (fetchHistoricalChart), bez swiec nocnych z probek serwera. */
export async function historiaYahoo(fetchFn: FetchHostingu, ticker: string, range: string, interval: string, budzet?: BudzetPobran): Promise<Record<string, unknown> | null> {
  const upperTicker = ticker.trim().toUpperCase();
  const { interval: validInterval, range: validRange } = dopasujInterwalDoZakresu(interval, range);
  const krypto = symbolYahooKrypto(upperTicker);
  for (const yahooSymbol of krypto ? [krypto.symbol] : kandydaciSymboluDostawcy(upperTicker)) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=${validInterval}&range=${validRange}${czyInterwalSrodsesyjny(validInterval) ? '&includePrePost=true' : ''}`;
    const data = await pobierzJsonDostawcy(fetchFn, url, 4000, budzet);
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

/**
 * Kurs NBP z tabeli A na dzien poprzedzajacy (T-1), jak serwer i desktop; cofanie o dni
 * bez tabeli (swieta, weekendy). Waluta musi byc wczesniej zwalidowana (normalizujWalute).
 */
export async function kursNbp(fetchFn: FetchHostingu, currency: string, date: string, budzet?: BudzetPobran): Promise<Response> {
  const waluta = currency.toUpperCase();
  if (waluta === 'PLN') {
    const rate = { currency: waluta, code: waluta, table: 'A', no: 'BRAK/PLN', effectiveDate: date.slice(0, 10), mid: 1 };
    return json({ success: true, data: rate, requestedDate: date, appliedTableDate: rate.effectiveDate, source: 'NBP_API_OFFICIAL' });
  }
  let targetDate = poprzedniDzienUtc(date);
  for (let proba = 0; proba < 10; proba++) {
    if (budzet) {
      if (budzet.pozostalo <= 0) {
        budzet.odrzucone += 1;
        break;
      }
      budzet.pozostalo -= 1;
    }
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
      const data: any = await odczytajJsonZLimitem(odpowiedz);
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
export async function szukajTickerow(fetchFn: FetchHostingu, q: string, budzet?: BudzetPobran): Promise<Record<string, unknown>> {
  const zapytanie = normalizujZapytanie(q);
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
      budzet,
    );
    for (const item of Array.isArray(data?.quotes) ? data.quotes : []) {
      const rawSymbol: string = typeof item?.symbol === 'string' ? item.symbol : '';
      if (!rawSymbol || !normalizujTicker(rawSymbol)) continue;
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
 * Kanoniczny klucz pamieci brzegowej: sciezka i tylko znane parametry w stalej
 * kolejnosci. Dowolne inne parametry (albo inna kolejnosc) nie tworza nowego wpisu
 * i nie omijaja pamieci.
 */
export function kluczPamieciBrzegowej(request: Request, sciezka: string, parametry: Record<string, string>): Request {
  const origin = new URL(request.url).origin;
  const kanoniczny = new URL(sciezka, origin);
  for (const [nazwa, wartosc] of Object.entries(parametry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    kanoniczny.searchParams.set(nazwa, wartosc);
  }
  return new Request(kanoniczny.toString(), { method: 'GET' });
}

/** Czy wpis z pamieci jest mlodszy niz prog swiezosci (wg naglowka zapisu). */
function czySwiezy(zapamietana: Response, teraz: Date, sekundy: number): boolean {
  const zapisano = Date.parse(zapamietana.headers.get(NAGLOWEK_ZAPISU) || '');
  return Number.isFinite(zapisano) && teraz.getTime() - zapisano < sekundy * 1000;
}

interface OpcjePamieci {
  /** `force=true`: pomin odczyt, chyba ze wpis jest mlodszy niz prog swiezosci. */
  wymuszone: boolean;
  /** Wywolywane po chybieniu pamieci, przed liczeniem; odpowiedz przerywa (np. 429). */
  przedPoliczeniem?: () => Promise<Response | null>;
}

/**
 * Odpowiedz z pamieci brzegowej albo policzona i odlozona na `sekundy`.
 * `force=true` omija odczyt (jak na serwerze) tylko dla wpisow starszych niz
 * SEKUNDY_SWIEZOSCI_PRZY_FORCE; nowa odpowiedz i tak trafia do pamieci.
 */
async function zPamieciaBrzegowa(
  zal: ZaleznosciHostingu,
  klucz: Request,
  opcje: OpcjePamieci,
  sekundy: number,
  policz: () => Promise<Response>,
): Promise<Response> {
  const teraz = zal.teraz?.() ?? new Date();
  if (zal.cache) {
    try {
      const zapamietana = await zal.cache.match(klucz);
      if (zapamietana && (!opcje.wymuszone || czySwiezy(zapamietana, teraz, SEKUNDY_SWIEZOSCI_PRZY_FORCE))) return zapamietana;
    } catch {
      // Brak pamieci brzegowej nie jest bledem - liczymy od nowa.
    }
  }
  if (opcje.przedPoliczeniem) {
    const przerwanie = await opcje.przedPoliczeniem();
    if (przerwanie) return przerwanie;
  }
  const odpowiedz = await policz();
  if (odpowiedz.ok && zal.cache) {
    const doPamieci = new Response(odpowiedz.clone().body, odpowiedz);
    doPamieci.headers.set('Cache-Control', `public, max-age=${sekundy}`);
    doPamieci.headers.set(NAGLOWEK_ZAPISU, teraz.toISOString());
    try {
      await zal.cache.put(klucz, doPamieci);
    } catch {
      // Odpowiedz i tak wraca do klienta.
    }
  }
  return odpowiedz;
}

type Trasa =
  | { rodzaj: 'health' }
  | { rodzaj: 'quotes' }
  | { rodzaj: 'quote'; ticker: string }
  | { rodzaj: 'history'; ticker: string }
  | { rodzaj: 'nbp' }
  | { rodzaj: 'search' }
  | { rodzaj: 'supported-assets' }
  | { rodzaj: 'nieznana' };

function rozpoznajTrase(sciezka: string): Trasa {
  if (sciezka === '/api/health') return { rodzaj: 'health' };
  if (sciezka === '/api/quotes') return { rodzaj: 'quotes' };
  if (sciezka.startsWith('/api/quote/')) return { rodzaj: 'quote', ticker: bezpiecznyDecode(sciezka.slice('/api/quote/'.length)) };
  if (sciezka.startsWith('/api/history/')) return { rodzaj: 'history', ticker: bezpiecznyDecode(sciezka.slice('/api/history/'.length)) };
  if (sciezka === '/api/nbp/rate') return { rodzaj: 'nbp' };
  if (sciezka === '/api/search-tickers') return { rodzaj: 'search' };
  if (sciezka === '/api/supported-assets') return { rodzaj: 'supported-assets' };
  return { rodzaj: 'nieznana' };
}

function bezpiecznyDecode(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return '';
  }
}

async function sprawdzLimit(ogranicznik: OgranicznikZadan | undefined, klucz: string): Promise<boolean> {
  if (!ogranicznik) return true;
  try {
    return await ogranicznik(klucz);
  } catch {
    // Awaria ogranicznika nie wylacza API - lepiej przepuscic niz odmowic wszystkim.
    return true;
  }
}

const odmowaLimitu = (komunikat: string): Response =>
  json({ success: false, error: komunikat }, 429, { 'Retry-After': '60' });

/** Router `/api/*` hostowanej wersji. Nigdy nie rzuca: kazdy wyjatek konczy sie neutralnym 500. */
export async function obsluzApiHostowane(request: Request, zal: ZaleznosciHostingu): Promise<Response> {
  try {
    const odpowiedz = await obsluzApiHostowaneWewnetrznie(request, zal);
    if (request.method.toUpperCase() === 'HEAD') {
      return new Response(null, { status: odpowiedz.status, headers: odpowiedz.headers });
    }
    return odpowiedz;
  } catch (blad) {
    console.error('[api-hosting] nieobsluzony wyjatek:', blad instanceof Error ? blad.message : String(blad));
    return json({ success: false, error: 'Błąd wewnętrzny API hostingu.' }, 500);
  }
}

async function obsluzApiHostowaneWewnetrznie(request: Request, zal: ZaleznosciHostingu): Promise<Response> {
  if (request.url.length > MAX_DLUGOSC_ADRESU) {
    return json({ success: false, error: 'Adres żądania jest za długi.' }, 414);
  }
  const url = new URL(request.url);
  const sciezka = url.pathname;
  const metoda = request.method.toUpperCase();

  // Obca strona nie uzyje tego API jako proxy przez przegladarke uzytkownika.
  // `same-site` tez odpada: inna poddomena tej samej witryny (np. inny Worker
  // pod *.dismonder.workers.dev) nie jest tym frontem.
  const zrodloZadania = request.headers.get('sec-fetch-site');
  if (zrodloZadania === 'cross-site' || zrodloZadania === 'same-site') {
    return json({ success: false, error: 'Żądanie API pochodzi z innej witryny.' }, 403);
  }

  if (metoda === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { Allow: 'GET, HEAD, OPTIONS', ...NAGLOWKI_BEZPIECZENSTWA_API } });
  }

  const trasa = rozpoznajTrase(sciezka);
  // Trasy serwera Node odmawiaja z kodem hostingu niezaleznie od metody - po tym
  // kodzie widoki rozpoznaja wersje hostowana (takze przy POST do silnika).
  if (trasa.rodzaj === 'nieznana') return niedostepneWHostingu();

  if (metoda !== 'GET' && metoda !== 'HEAD') {
    return json({ success: false, error: 'Ta trasa przyjmuje tylko GET.' }, 405, { Allow: 'GET, HEAD, OPTIONS' });
  }

  const kluczLimitu = kluczLimituZAdresu(zal.ip || request.headers.get('cf-connecting-ip'));
  if (!(await sprawdzLimit(zal.limity?.api, kluczLimitu))) {
    return odmowaLimitu('Zbyt wiele żądań z tego adresu. Spróbuj ponownie za chwilę.');
  }
  // Limit notowan dopiero po chybieniu pamieci brzegowej: trafienie nie kosztuje dostawcy.
  const limitNotowan = async (): Promise<Response | null> =>
    (await sprawdzLimit(zal.limity?.notowania, kluczLimitu))
      ? null
      : odmowaLimitu('Zbyt wiele zapytań o notowania z tego adresu. Spróbuj ponownie za chwilę.');

  const wymuszone = url.searchParams.get('force') === 'true';
  const budzet = nowyBudzet();

  switch (trasa.rodzaj) {
    case 'health':
      return json({ ok: true, status: 'ok', tryb: 'hosting', timestamp: (zal.teraz?.() ?? new Date()).toISOString() });

    case 'quotes': {
      const { tickery, odrzucone } = normalizujListeTickerow(url.searchParams.get('tickers'));
      if (tickery.length === 0 && odrzucone > 0) return bladWejscia('Żaden z podanych symboli nie wygląda na symbol instrumentu.');
      if (tickery.length > MAX_TICKEROW_NA_ZADANIE) {
        return bladWejscia(`Zbyt wiele instrumentów w jednym zapytaniu (limit ${MAX_TICKEROW_NA_ZADANIE}).`);
      }
      const klucz = kluczPamieciBrzegowej(request, '/api/quotes', { tickers: [...tickery].sort().join(',') });
      return zPamieciaBrzegowa(zal, klucz, { wymuszone, przedPoliczeniem: limitNotowan }, SEKUNDY_PAMIECI.quotes, async () => {
        const pominiete: string[] = [];
        const wyniki = await mapaZLimitem(tickery, MAX_ROWNOLEGLYCH_POBRAN, async (ticker) => {
          if (budzet.pozostalo <= 0) {
            pominiete.push(ticker);
            return null;
          }
          return notowanieYahoo(zal.fetch, ticker, budzet);
        });
        const quotes: Record<string, unknown> = {};
        tickery.forEach((ticker, indeks) => {
          if (wyniki[indeks]) quotes[ticker] = wyniki[indeks];
        });
        const niepobrane = pominiete.sort();
        return json({
          success: true,
          quotes,
          // Instrumenty, na ktore zabraklo budzetu pobran w tym wywolaniu (plan darmowy:
          // 50 subrequestow) - klient zachowuje poprzednie notowanie zamiast pustki.
          staleTickers: niepobrane,
          pominieteLimitPobran: niepobrane,
          allStale: false,
          timestamp: new Date().toISOString(),
          fetchedCount: tickery.length - niepobrane.length,
          cachedCount: 0,
          source: 'REAL_LIVE_FEED',
        });
      });
    }

    case 'quote': {
      const ticker = normalizujTicker(trasa.ticker);
      if (!ticker) return bladWejscia('Nieprawidłowy symbol instrumentu.');
      const klucz = kluczPamieciBrzegowej(request, `/api/quote/${encodeURIComponent(ticker)}`, {});
      return zPamieciaBrzegowa(zal, klucz, { wymuszone, przedPoliczeniem: limitNotowan }, SEKUNDY_PAMIECI.quotes, async () => {
        const quote = await notowanieYahoo(zal.fetch, ticker, budzet);
        return quote
          ? json({ success: true, quote })
          : json({ success: false, error: `Quote for ${ticker} not found` }, 404);
      });
    }

    case 'history': {
      const ticker = normalizujTicker(trasa.ticker);
      if (!ticker) return bladWejscia('Nieprawidłowy symbol instrumentu.');
      const range = url.searchParams.get('range') || '1mo';
      const interval = url.searchParams.get('interval') || '1d';
      if (!DOZWOLONE_ZAKRESY.has(range)) return bladWejscia('Nieprawidłowy zakres historii.');
      if (!DOZWOLONE_INTERWALY.has(interval)) return bladWejscia('Nieprawidłowy interwał historii.');
      const klucz = kluczPamieciBrzegowej(request, `/api/history/${encodeURIComponent(ticker)}`, { range, interval });
      return zPamieciaBrzegowa(zal, klucz, { wymuszone, przedPoliczeniem: limitNotowan }, SEKUNDY_PAMIECI.history, async () => {
        const data = await historiaYahoo(zal.fetch, ticker, range, interval, budzet);
        return data
          ? json({ success: true, data })
          : json({ success: false, error: `Brak historii notowań dla ${ticker}.` }, 404);
      });
    }

    case 'nbp': {
      const currency = normalizujWalute(url.searchParams.get('currency') || 'USD');
      const date = (url.searchParams.get('date') || (zal.teraz?.() ?? new Date()).toISOString().slice(0, 10)).trim();
      if (!currency) return bladWejscia('Nieprawidłowy kod waluty (oczekiwany kod z tabeli A NBP, np. USD).');
      if (!czyPoprawnaDataKursu(date, zal.teraz?.() ?? new Date())) return bladWejscia('Nieprawidłowa data kursu (oczekiwane RRRR-MM-DD).');
      const klucz = kluczPamieciBrzegowej(request, '/api/nbp/rate', { currency, date });
      return zPamieciaBrzegowa(zal, klucz, { wymuszone }, SEKUNDY_PAMIECI.nbp, () => kursNbp(zal.fetch, currency, date, budzet));
    }

    case 'search': {
      const q = normalizujZapytanie(url.searchParams.get('q'));
      const klucz = kluczPamieciBrzegowej(request, '/api/search-tickers', { q: q.toLowerCase() });
      return zPamieciaBrzegowa(zal, klucz, { wymuszone, przedPoliczeniem: limitNotowan }, SEKUNDY_PAMIECI.search, async () =>
        json(await szukajTickerow(zal.fetch, q, budzet)));
    }

    case 'supported-assets':
      return json(wykazInstrumentow(), 200, { 'Cache-Control': 'public, max-age=3600' });
  }
}
