import { Router } from 'express';

import fs from 'node:fs';
import path from 'node:path';
import { RejestratorNocny, swieceZProbek } from '../overnightRecorder';
import { SYMBOL_MAP, kandydaciSymboluDostawcy } from '../../shared/symbolDostawcy';

// Mapowanie symboli mieszka we wspolnym module (uzywa go tez desktop); reeksport dla starych importow.
export { SYMBOL_MAP, kandydaciSymboluDostawcy };

// Czyste pomocniki Yahoo mieszkaja we wspolnym module (uzywa go tez Worker hostingu); reeksport dla starych importow.
export {
  czyInterwalSrodsesyjny,
  graniceSesjiRegularnej,
  najdluzszyZakres,
  normalizePenceQuote,
  normalizedQuoteCurrency,
  sekundyInterwalu,
  sesjaSwiecy,
} from '../../shared/notowaniaYahoo';
export type { SesjaSwiecy } from '../../shared/notowaniaYahoo';
import {
  czyInterwalSrodsesyjny,
  graniceSesjiRegularnej,
  najdluzszyZakres,
  normalizePenceQuote,
  normalizedQuoteCurrency,
  sekundyInterwalu,
  sesjaSwiecy,
} from '../../shared/notowaniaYahoo';

/** Katalog z kluczami dostawcow (ten sam co dla brokera); nadpisywalny jak w kliencie Freedom24. */
function katalogKluczy(): string {
  return process.env.FREEDOM24_CREDENTIALS_DIR || path.resolve(process.cwd(), 'dane', 'API');
}

/** Klucze Alpaca czyta wylacznie serwer, z plikow `alpaca key.txt` i `alpaca secret.txt`. */
function kluczeAlpaca(): { id: string; secret: string } | null {
  try {
    const id = fs.readFileSync(path.join(katalogKluczy(), 'alpaca key.txt'), 'utf8').trim();
    const secret = fs.readFileSync(path.join(katalogKluczy(), 'alpaca secret.txt'), 'utf8').trim();
    return id && secret ? { id, secret } : null;
  } catch {
    return null;
  }
}

export function zrodloCenyNocnej(): 'ALPACA' | 'CENA_CALODOBOWA' {
  return kluczeAlpaca() ? 'ALPACA' : 'CENA_CALODOBOWA';
}

/**
 * Cena z sesji nocnej. Z kluczem Alpaca: ostatnia swieca z feedu `overnight`
 * (Blue Ocean ATS). Bez klucza: cena "calodobowa" dostawcy notowan.
 */
export async function cenaNocna(ticker: string): Promise<number | null> {
  const symbol = ticker.toUpperCase().split('.')[0];
  const alpaca = kluczeAlpaca();
  if (alpaca) {
    try {
      const res = await fetch(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/bars/latest?feed=overnight`, {
        headers: { 'APCA-API-KEY-ID': alpaca.id, 'APCA-API-SECRET-KEY': alpaca.secret, Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const cena = Number(((await res.json()) as any)?.bar?.c);
        if (cena > 0) return cena;
      }
    } catch {
      // Spadamy na cene calodobowa ponizej.
    }
  }
  for (const kandydat of kandydaciSymboluDostawcy(ticker.toUpperCase())) {
    const wynik = await fetchYahooChartRaw(kandydat, '1d', '1d');
    const cena = Number(normalizePenceQuote(wynik?.meta?.fulldayPrice, wynik?.meta?.currency));
    if (cena > 0) return cena;
  }
  return null;
}

export const rejestratorNocny = new RejestratorNocny(path.resolve(process.cwd(), 'dane', 'notowania_nocne'), cenaNocna);
// Testy nie moga odpytywac dostawcow w tle.
if (!process.argv.includes('--test') && !process.execArgv.includes('--test')) rejestratorNocny.start();

const router = Router();

// In-memory quote cache with high-frequency micro-TTL (Binance: 1.5s, Stocks: 2.5s)
export interface CachedQuote {
  quote: any;
  cachedAt: number;
}

export const quoteCache = new Map<string, CachedQuote>();
/**
 * Ostatnia dobra cena kazdego tickera, niezalezna od TTL: quoteCache czysci wpisy
 * starsze niz TTL przy kazdym zapisie, wiec zapas na czas awarii dostawcy zyl
 * jeden cykl. Limit wieku: STALE_QUOTE_MAX_AGE_MS; limit rozmiaru jak quoteCache.
 */
export const ostatnieDobreNotowania = new Map<string, CachedQuote>();
export const CRYPTO_CACHE_TTL_MS = 1500; // 1.5 seconds for Binance crypto
export const STOCK_CACHE_TTL_MS = 2500;  // 2.5 seconds for Equities, ETFs & GPW
const MAX_QUOTE_CACHE_ENTRIES = 500;
/** Limity dla GET /api/quotes: lista z zapytania i liczba rownoleglych pobran u dostawcy. */
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
/** Najstarsza cena z zapasu, jaka moze zastapic notowanie przy awarii dostawcy. */
export const STALE_QUOTE_MAX_AGE_MS = 15 * 60_000;

export function cacheQuote(ticker: string, quote: any, now = Date.now()): void {
  for (const [key, entry] of quoteCache) {
    const ttl = CRYPTO_MAP[key] ? CRYPTO_CACHE_TTL_MS : STOCK_CACHE_TTL_MS;
    if (now - entry.cachedAt >= ttl) quoteCache.delete(key);
  }
  quoteCache.delete(ticker);
  quoteCache.set(ticker, { quote, cachedAt: now });
  while (quoteCache.size > MAX_QUOTE_CACHE_ENTRIES) {
    const oldest = quoteCache.keys().next().value;
    if (oldest === undefined) break;
    quoteCache.delete(oldest);
  }
  ostatnieDobreNotowania.delete(ticker);
  ostatnieDobreNotowania.set(ticker, { quote, cachedAt: now });
  for (const [key, entry] of ostatnieDobreNotowania) {
    if (now - entry.cachedAt > STALE_QUOTE_MAX_AGE_MS) ostatnieDobreNotowania.delete(key);
  }
  while (ostatnieDobreNotowania.size > MAX_QUOTE_CACHE_ENTRIES) {
    const oldest = ostatnieDobreNotowania.keys().next().value;
    if (oldest === undefined) break;
    ostatnieDobreNotowania.delete(oldest);
  }
}

export const CRYPTO_MAP: Record<string, { binancePair: string; name: string; brokers?: string[] }> = {
  BTC: { binancePair: 'BTCUSDT', name: 'Bitcoin', brokers: ['BINANCE', 'REVOLUT', 'XTB', 'FREEDOM24', 'CUSTOM'] },
  ETH: { binancePair: 'ETHUSDT', name: 'Ethereum', brokers: ['BINANCE', 'REVOLUT', 'XTB', 'FREEDOM24', 'CUSTOM'] },
  SOL: { binancePair: 'SOLUSDT', name: 'Solana', brokers: ['BINANCE', 'REVOLUT', 'XTB', 'CUSTOM'] },
  BNB: { binancePair: 'BNBUSDT', name: 'BNB', brokers: ['BINANCE', 'REVOLUT', 'CUSTOM'] },
  XRP: { binancePair: 'XRPUSDT', name: 'XRP', brokers: ['BINANCE', 'REVOLUT', 'XTB', 'CUSTOM'] },
  DOGE: { binancePair: 'DOGEUSDT', name: 'Dogecoin', brokers: ['BINANCE', 'REVOLUT', 'XTB', 'CUSTOM'] },
  ADA: { binancePair: 'ADAUSDT', name: 'Cardano', brokers: ['BINANCE', 'REVOLUT', 'XTB', 'CUSTOM'] },
  AVAX: { binancePair: 'AVAXUSDT', name: 'Avalanche', brokers: ['BINANCE', 'REVOLUT', 'CUSTOM'] },
  LINK: { binancePair: 'LINKUSDT', name: 'Chainlink', brokers: ['BINANCE', 'REVOLUT', 'CUSTOM'] },
  DOT: { binancePair: 'DOTUSDT', name: 'Polkadot', brokers: ['BINANCE', 'REVOLUT', 'CUSTOM'] },
  NEAR: { binancePair: 'NEARUSDT', name: 'NEAR Protocol', brokers: ['BINANCE', 'REVOLUT', 'CUSTOM'] },
  SUI: { binancePair: 'SUIUSDT', name: 'Sui', brokers: ['BINANCE', 'REVOLUT', 'CUSTOM'] },
  PEPE: { binancePair: 'PEPEUSDT', name: 'Pepe', brokers: ['BINANCE', 'REVOLUT', 'CUSTOM'] },
  SHIB: { binancePair: 'SHIBUSDT', name: 'Shiba Inu', brokers: ['BINANCE', 'REVOLUT', 'CUSTOM'] },
  LTC: { binancePair: 'LTCUSDT', name: 'Litecoin', brokers: ['BINANCE', 'REVOLUT', 'XTB', 'CUSTOM'] },
};

// Fetch real crypto quotes from Binance API
export async function fetchBinanceCrypto(cryptoTickers: string[]): Promise<Record<string, any>> {
  if (cryptoTickers.length === 0) return {};
  
  const results: Record<string, any> = {};
  const symbols = cryptoTickers
    .map(t => CRYPTO_MAP[t]?.binancePair)
    .filter(Boolean);

  if (symbols.length === 0) return {};

  try {
    const symbolsParam = encodeURIComponent(JSON.stringify(symbols));
    const url = `https://api.binance.com/api/v3/ticker/24hr?symbols=${symbolsParam}`;
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(3500),
    });
    
    if (response.ok) {
      const data: any = await response.json();
      if (Array.isArray(data)) {
        for (const item of data) {
          const tickerEntry = Object.entries(CRYPTO_MAP).find(([_, v]) => v.binancePair === item.symbol);
          if (tickerEntry) {
            const [ticker, info] = tickerEntry;
            const price = parseFloat(item.lastPrice);
            const change24h = parseFloat(item.priceChange);
            const changePercent24h = parseFloat(item.priceChangePercent);
            const high24h = parseFloat(item.highPrice);
            const low24h = parseFloat(item.lowPrice);
            const volume24h = parseFloat(item.quoteVolume);
            
            // Binance /ticker/24hr nie oddaje szeregu cen. Wczesniej powstawal
            // tu szesciopunktowy "sparkline" z otwarcia, ekstremow i dwoch
            // wymyslonych punktow posrednich (mid1, mid2) - wykres rysowany
            // z liczb, ktorych rynek nigdy nie podal.
            const sparkline: number[] = [];

            results[ticker] = {
              ticker,
              name: info.name,
              category: 'CRYPTO',
              price,
              currency: 'USD',
              change24h: Number(change24h.toFixed(2)),
              changePercent24h: Number(changePercent24h.toFixed(2)),
              high24h,
              low24h,
              volume24h,
              sparkline,
              lastUpdated: new Date().toISOString(),
              source: 'BINANCE',
              dostawcaDanych: 'BINANCE',
            };
          }
        }
      }
    }
  } catch (err) {
    console.error('Error fetching Binance crypto quotes:', err);
  }

  return results;
}

// Helper to execute chart fetch with headers and timeout
export async function fetchYahooChartRaw(yahooSymbol: string, interval = '1d', range = '5d'): Promise<any | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=${interval}&range=${range}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(3500),
    });

    if (response.ok) {
      const data: any = await response.json();
      const result = data?.chart?.result?.[0];
      if (result && result.meta) {
        return result;
      }
    }
  } catch (err) {
    // ignore and continue
  }
  return null;
}

// Fetch real equity / ETF quotes from Yahoo Finance with smart symbol resolution
export async function fetchYahooQuote(ticker: string): Promise<any | null> {
  const upperTicker = ticker.toUpperCase();
  const mapping = SYMBOL_MAP[upperTicker];
  const candidates = kandydaciSymboluDostawcy(upperTicker);

  for (const candidate of candidates) {
    try {
      const result = await fetchYahooChartRaw(candidate, '1d', '5d');
      if (result && result.meta) {
        const meta = result.meta;
        const sourceCurrency = meta.currency;
        const price = normalizePenceQuote(meta.regularMarketPrice ?? meta.chartPreviousClose, sourceCurrency);
        // Odpowiedz bez ceny to brak notowania, nie cena 0.
        if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) continue;
        const prevClose = normalizePenceQuote(meta.chartPreviousClose, sourceCurrency) ?? price;
        const change24h = price - prevClose;
        const changePercent24h = prevClose !== 0 ? (change24h / prevClose) * 100 : 0;
        
        const closeArray: number[] = result.indicators?.quote?.[0]?.close || [];
        const cleanSparkline = closeArray
          .filter((v): v is number => typeof v === 'number' && !isNaN(v))
          .map(v => normalizePenceQuote(v, sourceCurrency))
          .filter((v): v is number => typeof v === 'number')
          .map(v => Number(v.toFixed(2)));

        // Pusty szereg zostaje pusty. Wstawienie biezacej ceny dawalo wykres
        // plaskiej linii nie do odroznienia od spokojnej sesji.

        const isPLN = sourceCurrency === 'PLN' || candidate.endsWith('.WA');
        const isEUR = sourceCurrency === 'EUR' || candidate.endsWith('.DE');
        const defaultCurrency = isPLN ? 'PLN' : (isEUR ? 'EUR' : 'USD');
        const category = mapping?.category || (meta.instrumentType === 'ETF' ? 'ETF' : (isPLN ? 'STOCK_PL' : 'STOCK_FOREIGN'));

        const quote = {
          ticker: upperTicker,
          name: mapping?.name || meta.longName || meta.shortName || upperTicker,
          category,
          price: Number(price.toFixed(2)),
          currency: mapping?.currency || normalizedQuoteCurrency(sourceCurrency) || defaultCurrency,
          change24h: Number(change24h.toFixed(2)),
          changePercent24h: Number(changePercent24h.toFixed(2)),
          // Maksimum 52 tygodni podstawione za maksimum dnia to inna liczba
          // o tej samej nazwie - brak danych zostaje brakiem.
          high24h: typeof meta.regularMarketDayHigh === 'number' ? Number((normalizePenceQuote(meta.regularMarketDayHigh, sourceCurrency) as number).toFixed(2)) : null,
          low24h: typeof meta.regularMarketDayLow === 'number' ? Number((normalizePenceQuote(meta.regularMarketDayLow, sourceCurrency) as number).toFixed(2)) : null,
          quoteUnit: sourceCurrency === 'GBp' || String(sourceCurrency).toUpperCase() === 'GBX' ? 'pence converted to GBP' : undefined,
          volume24h: typeof meta.regularMarketVolume === 'number' ? meta.regularMarketVolume : null,
          sparkline: cleanSparkline,
          lastUpdated: new Date().toISOString(),
          // `source` mowi, na jakim rynku papier jest notowany. Dane pochodza
          // z Yahoo Finance niezaleznie od tej etykiety - ekran pisal
          // "Rzeczywiste zrodlo: FREEDOM24" dla ceny, ktorej Freedom24 nie
          // przyslalo.
          source: mapping?.source || (candidate.endsWith('.WA') ? 'GPW' : 'TRADINGVIEW'),
          dostawcaDanych: 'YAHOO_FINANCE',
        };

        return quote;
      }
    } catch (err) {
      console.error(`Error fetching Yahoo quote for ${ticker} (${candidate}):`, err);
    }
  }

  return null;
}

// Fetch historical candles / chart data
export async function fetchHistoricalChart(ticker: string, range = '1d', interval = '15m'): Promise<any> {
  const upperTicker = ticker.toUpperCase();

  // Crypto historical via Binance
  if (CRYPTO_MAP[upperTicker]) {
    const pair = CRYPTO_MAP[upperTicker].binancePair;
    let binanceInterval = interval;
    if (interval === '1m') binanceInterval = '1m';
    else if (interval === '5m') binanceInterval = '5m';
    else if (interval === '15m') binanceInterval = '15m';
    else if (interval === '1h') binanceInterval = '1h';
    else if (interval === '4h') binanceInterval = '4h';
    else if (interval === '1d') binanceInterval = '1d';
    else if (interval === '1w') binanceInterval = '1w';
    else {
      if (range === '1d') binanceInterval = '15m';
      else if (range === '5d') binanceInterval = '1h';
      else if (range === '1mo') binanceInterval = '1d';
      else if (range === '6mo') binanceInterval = '1d';
      else if (range === '1y') binanceInterval = '1w';
    }

    let limit = 100;
    if (range === '1d') {
      if (binanceInterval === '1m') limit = 360;
      else if (binanceInterval === '5m') limit = 144;
      else if (binanceInterval === '15m') limit = 96;
      else if (binanceInterval === '1h') limit = 24;
      else limit = 30;
    } else if (range === '5d') {
      if (binanceInterval === '1m') limit = 500;
      else if (binanceInterval === '5m') limit = 500;
      else if (binanceInterval === '15m') limit = 480;
      else if (binanceInterval === '1h') limit = 120;
      else limit = 30;
    } else if (range === '1mo') {
      if (binanceInterval === '1m') limit = 500;
      else if (binanceInterval === '5m') limit = 500;
      else if (binanceInterval === '15m') limit = 500;
      else if (binanceInterval === '1h') limit = 500;
      else if (binanceInterval === '1d') limit = 31;
      else limit = 60;
    } else if (range === '6mo') {
      if (binanceInterval === '1m') limit = 500;
      else if (binanceInterval === '5m') limit = 500;
      else if (binanceInterval === '15m') limit = 500;
      else if (binanceInterval === '1h') limit = 500;
      else if (binanceInterval === '1d') limit = 180;
      else limit = 26;
    } else if (range === '1y') {
      if (binanceInterval === '1d') limit = 365;
      else if (binanceInterval === '1w') limit = 52;
      else limit = 500;
    }

    try {
      const url = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${binanceInterval}&limit=${limit}`;
      const response = await fetch(url);
      if (response.ok) {
        const klines: any[] = await response.json();
        const dataPoints = klines.map((k) => {
          const timestamp = k[0];
          const open = parseFloat(k[1]);
          const high = parseFloat(k[2]);
          const low = parseFloat(k[3]);
          const close = parseFloat(k[4]);
          const volume = parseFloat(k[5]);
          const dateObj = new Date(timestamp);
          const isIntradaySingleDay = range === '1d' && (binanceInterval === '1m' || binanceInterval === '5m' || binanceInterval === '15m' || binanceInterval === '1h');
          const isIntradayMultiDay = (range === '5d' || range === '1mo' || range === '6mo' || range === '1y') && (binanceInterval === '1m' || binanceInterval === '5m' || binanceInterval === '15m' || binanceInterval === '1h');
          
          let date = dateObj.toLocaleDateString('pl-PL', { day: 'numeric', month: 'numeric' });
          if (isIntradaySingleDay) {
            date = dateObj.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
          } else if (isIntradayMultiDay) {
            date = `${dateObj.toLocaleDateString('pl-PL', { day: 'numeric', month: 'numeric' })} ${dateObj.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })}`;
          }

          return { timestamp, date, open, high, low, close, volume };
        });

        return {
          ticker: upperTicker,
          range,
          interval: binanceInterval,
          points: dataPoints,
        };
      }
    } catch (e) {
      console.warn(`[Binance History] Error fetching ${upperTicker}`, e);
    }
  }

  // Stock / ETF historical via Yahoo
  const mapping = SYMBOL_MAP[upperTicker];
  const candidates = kandydaciSymboluDostawcy(upperTicker);
  
  let validInterval = interval;
  let validRange = range === 'max' ? najdluzszyZakres(interval) : range;

  // Yahoo Finance API technical constraints:
  // 1m is only available for 1d or 5d (up to 7d max)
  // 5m / 15m is available for up to 60d (so 1d, 5d, 1mo work natively; for 6mo/1y Yahoo requires 1d or 1wk interval, or 1h up to 730d)
  if (validInterval === '1m') {
    if (validRange !== '1d' && validRange !== '5d' && validRange !== '7d') {
      // 1m only allowed on 1d/5d on Yahoo, for larger ranges we adapt to 5m/1h or 1d
      validInterval = '5m';
      if (validRange === '6mo' || validRange === '1y') validInterval = '1h';
    }
  } else if (validInterval === '5m' || validInterval === '15m') {
    if (validRange === '6mo' || validRange === '1y') {
      // Yahoo allows 60 days max for 15m, so for 6mo/1y with intraday request we use 1h (which supports up to 730 days)
      validInterval = '1h';
    }
  }

  for (const yahooSymbol of candidates) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=${validInterval}&range=${validRange}${czyInterwalSrodsesyjny(validInterval) ? '&includePrePost=true' : ''}`;
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(4000),
      });

      if (response.ok) {
        const data: any = await response.json();
        const result = data?.chart?.result?.[0];
        if (result) {
          const timestamps: number[] = result.timestamp || [];
          const granice = graniceSesjiRegularnej(result.meta);
          const quotes = result.indicators?.quote?.[0] || {};
          const opens = quotes.open || [];
          const highs = quotes.high || [];
          const lows = quotes.low || [];
          const closes = quotes.close || [];
          const volumes = quotes.volume || [];
          const candlePrice = (value: number) => Number((normalizePenceQuote(value, result.meta?.currency) as number).toFixed(2));

          const points = [];
          for (let i = 0; i < timestamps.length; i++) {
            if (closes[i] !== null && closes[i] !== undefined && !isNaN(closes[i])) {
              const ts = timestamps[i] * 1000;
              const dateObj = new Date(ts);
              const isIntradaySingleDay = validRange === '1d';
              const isIntradayMultiDay = (validRange === '5d' || validRange === '1mo' || validRange === '6mo' || validRange === '1y') && (validInterval === '1m' || validInterval === '5m' || validInterval === '15m' || validInterval === '1h');

              let dateStr = dateObj.toLocaleDateString('pl-PL', { day: 'numeric', month: 'numeric' });
              if (isIntradaySingleDay) {
                dateStr = dateObj.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
              } else if (isIntradayMultiDay) {
                dateStr = `${dateObj.toLocaleDateString('pl-PL', { day: 'numeric', month: 'numeric' })} ${dateObj.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })}`;
              }

              points.push({
                timestamp: ts,
                date: dateStr,
                open: candlePrice(opens[i] || closes[i]),
                high: candlePrice(highs[i] || closes[i]),
                low: candlePrice(lows[i] || closes[i]),
                close: candlePrice(closes[i]),
                volume: volumes[i] || 0,
                session: sesjaSwiecy(timestamps[i], granice),
              });
            }
          }

          // Swiece z sesji nocnej pochodza z wlasnych probek serwera (zadne zrodlo
          // nie oddaje ich historii). Pojawiaja sie od pierwszej nocy po otwarciu wykresu.
          if (czyInterwalSrodsesyjny(validInterval)) {
            rejestratorNocny.obserwuj(upperTicker);
            const pierwsza = timestamps.length > 0 ? timestamps[0] : 0;
            for (const swieca of swieceZProbek(rejestratorNocny.odczytaj(upperTicker), sekundyInterwalu(validInterval))) {
              if (swieca.timestamp < pierwsza) continue;
              const dateObj = new Date(swieca.timestamp * 1000);
              const godzina = dateObj.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
              points.push({
                timestamp: swieca.timestamp * 1000,
                date: validRange === '1d' ? godzina : `${dateObj.toLocaleDateString('pl-PL', { day: 'numeric', month: 'numeric' })} ${godzina}`,
                open: Number(swieca.open.toFixed(2)),
                high: Number(swieca.high.toFixed(2)),
                low: Number(swieca.low.toFixed(2)),
                close: Number(swieca.close.toFixed(2)),
                volume: 0,
                session: 'OVERNIGHT',
              });
            }
            points.sort((a, b) => a.timestamp - b.timestamp);
          }

          if (points.length > 0) {
            return {
              ticker: upperTicker,
              range: validRange,
              interval: validInterval,
              extendedHours: czyInterwalSrodsesyjny(validInterval) && granice !== null,
              overnightSource: zrodloCenyNocnej(),
              points,
            };
          }
        }
      }
    } catch (err) {
      // Continue to next candidate
    }
  }

  // Przebieg pogladowy da sie zbudowac tylko wokol ceny, ktora naprawde
  // odczytano. Wczesniej stalo tu `|| (PKN ? 64.25 : CDR ? 263.10 : NVDA ?
  // 225.16 : 100.0)`, wiec kazdy nieznany instrument dostawal wykres wokol
  // 100 zl, a NVDA wokol 225,16 - tej samej wymyslonej ceny, ktora usunieto
  // juz z marketDataService.
  const cachedQuote = quoteCache.get(upperTicker)?.quote;
  const basePrice =
    typeof cachedQuote?.price === 'number' && cachedQuote.price > 0 ? cachedQuote.price : null;
  if (basePrice === null) {
    return {
      ticker: upperTicker,
      range: validRange,
      interval: validInterval,
      points: [],
      synthetic: true,
      syntheticReason:
        `Nie udalo sie pobrac notowan ${upperTicker} ze zrodla, a aplikacja nie zna ostatniej ` +
        'ceny tego instrumentu - nie ma wokol czego narysowac wykresu.',
    };
  }
  const now = Date.now();
  const pointCount = validRange === '1d' ? 24 : validRange === '5d' ? 30 : 45;
  const intervalStepMs = validRange === '1d' ? 3600 * 1000 : 24 * 3600 * 1000;
  const fallbackPoints = [];

  for (let i = pointCount; i >= 0; i--) {
    const ts = now - i * intervalStepMs;
    const dateObj = new Date(ts);
    const isIntraday = validRange === '1d' || validRange === '5d';
    const dateStr = isIntraday
      ? dateObj.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })
      : dateObj.toLocaleDateString('pl-PL', { day: 'numeric', month: 'numeric' });
    const wave = Math.sin((pointCount - i) * 0.4) * (basePrice * 0.015);
    const close = Number((basePrice - (i * 0.002 * basePrice) + wave).toFixed(2));
    fallbackPoints.push({
      timestamp: ts,
      date: dateStr,
      open: Number((close * 0.998).toFixed(2)),
      high: Number((close * 1.006).toFixed(2)),
      low: Number((close * 0.994).toFixed(2)),
      close,
      volume: 15000 + Math.floor(Math.random() * 5000),
    });
  }

  // Znacznik jest obowiazkowy: to przebieg wyliczony z ostatniej znanej ceny,
  // a nie notowania z gieldy. Bez niego wykres wygladal identycznie jak
  // prawdziwy i nie dalo sie odroznic awarii zrodla od spokojnej sesji.
  return {
    ticker: upperTicker,
    range: validRange,
    interval: validInterval,
    points: fallbackPoints,
    synthetic: true,
    syntheticReason: 'Nie udało się pobrać notowań ze źródła. Wykres jest poglądowy.',
  };
}

// Quotes Endpoint (Favorites & Tickers) with Ultra-Fast Micro-Cache
router.get('/quotes', async (req, res) => {
  const tickersQuery = typeof req.query.tickers === 'string' ? req.query.tickers : '';
  const forceRefresh = req.query.force === 'true' || req.query.fresh === '1';
  const tickers = [...new Set(tickersQuery
    .split(',')
    .map(t => t.trim().toUpperCase())
    .filter(Boolean))];
  // GET nie ma kontroli Origin: obca strona moze go wywolac, wiec lista ma limit.
  if (tickers.length > MAX_TICKEROW_NA_ZADANIE) {
    return res.status(400).json({
      success: false,
      error: `Zbyt wiele instrumentów w jednym zapytaniu (limit ${MAX_TICKEROW_NA_ZADANIE}).`,
    });
  }

  // Bez listy nie ma o co pytac - sztywna lista dwunastu instrumentow zniknela.
  const requestedTickers = tickers;

  const now = Date.now();
  const quotesMap: Record<string, any> = {};
  const tickersToFetch: string[] = [];

  // Check cache first (differential TTL: crypto 1.5s, stocks 2.5s)
  for (const ticker of requestedTickers) {
    const isCrypto = !!CRYPTO_MAP[ticker];
    const ttl = isCrypto ? CRYPTO_CACHE_TTL_MS : STOCK_CACHE_TTL_MS;
    const cached = quoteCache.get(ticker);

    if (!forceRefresh && cached && now - cached.cachedAt < ttl) {
      quotesMap[ticker] = cached.quote;
    } else {
      tickersToFetch.push(ticker);
    }
  }
  const nieaktualne: string[] = [];

  if (tickersToFetch.length > 0) {
    const cryptoTickers = tickersToFetch.filter(t => CRYPTO_MAP[t]);
    const stockTickers = tickersToFetch.filter(t => !CRYPTO_MAP[t]);

    const [cryptoResults, stockResults] = await Promise.all([
      fetchBinanceCrypto(cryptoTickers),
      mapaZLimitem(stockTickers, MAX_ROWNOLEGLYCH_POBRAN, fetchYahooQuote),
    ]);

    // Merge crypto results
    for (const [ticker, quote] of Object.entries(cryptoResults)) {
      quotesMap[ticker] = quote;
      cacheQuote(ticker, quote, now);
    }

    // Merge stock results (keep previous cached value if transient error occurs)
    stockTickers.forEach((ticker, index) => {
      const quote = stockResults[index];
      if (quote) {
        quotesMap[ticker] = quote;
        cacheQuote(ticker, quote, now);
      } else {
        const prev = ostatnieDobreNotowania.get(ticker);
        // Stara cena z zapasu nie moze uchodzic za biezaca: oznaczamy ja i podajemy
        // czas pobrania, a zbyt stara pomijamy.
        if (prev && now - prev.cachedAt <= STALE_QUOTE_MAX_AGE_MS) {
          quotesMap[ticker] = { ...prev.quote, stale: true, fetchedAt: new Date(prev.cachedAt).toISOString() };
          nieaktualne.push(ticker);
        }
      }
    });
  }

  const wszystkieNieaktualne = nieaktualne.length > 0 && nieaktualne.length === Object.keys(quotesMap).length;
  res.json({
    success: true,
    quotes: quotesMap,
    staleTickers: nieaktualne,
    allStale: wszystkieNieaktualne,
    timestamp: new Date().toISOString(),
    refreshIntervalRecommendationMs: 3000,
    cryptoTtlMs: CRYPTO_CACHE_TTL_MS,
    stockTtlMs: STOCK_CACHE_TTL_MS,
    fetchedCount: tickersToFetch.length,
    cachedCount: requestedTickers.length - tickersToFetch.length,
    source: wszystkieNieaktualne ? 'STALE_CACHE' : 'REAL_LIVE_FEED',
  });
});

router.get('/quote/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const forceRefresh = req.query.force === 'true';
  const now = Date.now();
  const isCrypto = !!CRYPTO_MAP[ticker];
  const ttl = isCrypto ? CRYPTO_CACHE_TTL_MS : STOCK_CACHE_TTL_MS;
  const cached = quoteCache.get(ticker);
  
  if (!forceRefresh && cached && now - cached.cachedAt < ttl) {
    return res.json({ success: true, quote: cached.quote, source: 'CACHE' });
  }

  if (isCrypto) {
    const cryptoData = await fetchBinanceCrypto([ticker]);
    const quote = cryptoData[ticker];
    if (quote) {
      cacheQuote(ticker, quote, now);
      return res.json({ success: true, quote });
    }
  }

  const quote = await fetchYahooQuote(ticker);
  if (quote) {
    cacheQuote(ticker, quote, now);
    return res.json({ success: true, quote });
  }

  // Awaria dostawcy: ostatnia dobra cena, jak w /api/quotes - z limitem wieku
  // i oznaczeniem, ze nie jest biezacym odczytem.
  const ostatnia = ostatnieDobreNotowania.get(ticker);
  if (ostatnia && now - ostatnia.cachedAt <= STALE_QUOTE_MAX_AGE_MS) {
    return res.json({
      success: true,
      quote: { ...ostatnia.quote, stale: true, fetchedAt: new Date(ostatnia.cachedAt).toISOString() },
      source: 'STALE_CACHE',
    });
  }

  return res.status(404).json({ success: false, error: `Quote for ${ticker} not found` });
});

// Historical Chart Data Endpoint
router.get('/history/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const range = (req.query.range as string) || '1mo';
  const interval = (req.query.interval as string) || '1d';

  try {
    const chartData = await fetchHistoricalChart(ticker, range, interval);
    res.json({ success: true, data: chartData });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// All Supported Assets List Endpoint
router.get('/supported-assets', (req, res) => {
  const stockList = Object.entries(SYMBOL_MAP).map(([ticker, val]) => ({
    ticker,
    name: val.name,
    category: val.category,
    currency: val.currency,
    exchange: val.source === 'GPW' ? 'GPW Warszawa' : (val.currency === 'EUR' ? 'XETRA / Europa' : 'USA (NASDAQ/NYSE)'),
    // Wykaz nie mowi, u kogo instrument jest dostepny - lista brokerow
    // podstawiona za brak wpisu byla obietnica, ktorej nikt nie sprawdzil.
    brokers: val.brokers || [],
    source: val.source,
  }));

  const cryptoList = Object.entries(CRYPTO_MAP).map(([ticker, val]) => ({
    ticker,
    name: val.name,
    category: 'CRYPTO',
    currency: 'USD',
    exchange: 'Binance Spot',
    brokers: val.brokers || [],
    source: 'BINANCE',
  }));

  res.json({
    success: true,
    total: stockList.length + cryptoList.length,
    assets: [...stockList, ...cryptoList],
  });
});

// Global Live Search for Tickers across All Markets & Brokers
router.get('/search-tickers', async (req, res) => {
  const q = ((req.query.q as string) || '').trim();
  if (!q) {
    return res.json({ success: true, results: [] });
  }

  const queryUpper = q.toUpperCase();
  const resultsMap = new Map<string, any>();

  // 1. Check local SYMBOL_MAP
  for (const [ticker, val] of Object.entries(SYMBOL_MAP)) {
    if (ticker.includes(queryUpper) || val.name.toUpperCase().includes(queryUpper)) {
      resultsMap.set(ticker, {
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

  // 2. Check local CRYPTO_MAP
  for (const [ticker, val] of Object.entries(CRYPTO_MAP)) {
    if (ticker.includes(queryUpper) || val.name.toUpperCase().includes(queryUpper)) {
      resultsMap.set(ticker, {
        ticker,
        name: val.name,
        category: 'CRYPTO',
        currency: 'USD',
        exchange: 'Binance Spot',
        brokers: val.brokers || [],
        isKnown: true,
      });
    }
  }

  // 3. Query Yahoo Finance Search API for real-time discovery of global stocks/ETFs
  if (q.length >= 2) {
    try {
      const yahooSearchUrl = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`;
      const yRes = await fetch(yahooSearchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(3000),
      });

      if (yRes.ok) {
        const data: any = await yRes.json();
        if (Array.isArray(data.quotes)) {
          for (const item of data.quotes) {
            const rawSymbol = item.symbol || '';
            if (!rawSymbol) continue;
            
            // Clean symbol for display
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

            if (!resultsMap.has(cleanTicker) && !resultsMap.has(rawSymbol)) {
              resultsMap.set(cleanTicker, {
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
      }
    } catch (err) {
      // Ignore search fetch errors
    }
  }

  res.json({
    success: true,
    query: q,
    results: Array.from(resultsMap.values()),
  });
});

export default router;
