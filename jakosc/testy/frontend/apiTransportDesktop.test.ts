/**
 * Zbudowana aplikacja desktop (Tauri) nie ma serwera Node.
 *
 * Trasy bez odpowiednika w desktopie konczyly sie wzglednym fetch('/api/...').
 * Przy zleceniu Binance wyjatek byl brany za wynik niepewny: rejestr blokowal
 * walor, a sprawdzenie statusu tez nie moglo sie udac - blokada na zawsze.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { apiFetch, KOD_NIEDOSTEPNE_W_DESKTOPIE, MAX_ROWNOLEGLYCH_POBRAN, MAX_TICKEROW_NA_ZADANIE } from '../../../aplikacje/web/src/portfel/services/apiTransport.ts';

type Globalne = { isTauri?: boolean; location?: unknown; fetch: typeof fetch };

async function wDesktopie<T>(origin: { protocol: string; hostname: string }, dzialanie: (wywolania: string[]) => Promise<T>): Promise<T> {
  const globalne = globalThis as unknown as Globalne;
  const poprzednie = { isTauri: globalne.isTauri, location: globalne.location, fetch: globalne.fetch };
  const wywolania: string[] = [];
  globalne.isTauri = true;
  Object.defineProperty(globalThis, 'location', { value: origin, configurable: true, writable: true });
  globalne.fetch = (async (url: string) => {
    wywolania.push(String(url));
    return new Response('{"success":true}', { status: 200 });
  }) as typeof fetch;
  try {
    return await dzialanie(wywolania);
  } finally {
    globalne.isTauri = poprzednie.isTauri;
    Object.defineProperty(globalThis, 'location', { value: poprzednie.location, configurable: true, writable: true });
    globalne.fetch = poprzednie.fetch;
  }
}

test('zbudowany desktop odmawia tras brokera jednoznacznie, bez wyjatku sieciowego', async () => {
  await wDesktopie({ protocol: 'http:', hostname: 'tauri.localhost' }, async (wywolania) => {
    for (const trasa of ['/api/brokers/orders/create', '/api/brokers/orders/status', '/api/brokers/sync', '/api/brokers/freedom24/news']) {
      const odpowiedz = await apiFetch(trasa, { method: 'POST', body: '{}' });
      assert.equal(odpowiedz.status, 501, trasa);
      const dane = await odpowiedz.json();
      assert.equal(dane.success, false);
      assert.equal(dane.errorCode, KOD_NIEDOSTEPNE_W_DESKTOPIE);
      assert.equal(dane.ambiguous, undefined, 'odmowa nie moze wygladac na wynik niepewny');
    }
    assert.deepEqual(wywolania, [], 'bez serwera nie ma czego odpytywac');
  });
});

test('desktop w trybie deweloperskim (serwer na localhost) nadal pyta serwer', async () => {
  await wDesktopie({ protocol: 'http:', hostname: 'localhost' }, async (wywolania) => {
    const odpowiedz = await apiFetch('/api/brokers/sync', { method: 'POST', body: '{}' });
    assert.equal(odpowiedz.status, 200);
    assert.deepEqual(wywolania, ['/api/brokers/sync']);
  });
});

/** Atrapa IPC wtyczki HTTP (fetch -> fetch_send -> fetch_read_body); liczy rownolegle zadania. */
function zAtrapaWtyczkiHttp(odpowiedz: (url: string) => { status: number; cialo: unknown }) {
  const stan = { adresy: [] as string[], naraz: 0, maksNaraz: 0 };
  const tresci = new Map<number, { dane: Uint8Array; odczytane: boolean }>();
  let rid = 1;
  const ipc = async (cmd: string, args?: Record<string, any>): Promise<unknown> => {
    if (cmd === 'plugin:http|fetch') {
      const url = String(args?.clientConfig?.url);
      stan.adresy.push(url);
      stan.naraz += 1;
      stan.maksNaraz = Math.max(stan.maksNaraz, stan.naraz);
      await new Promise((resolve) => setTimeout(resolve, 5));
      stan.naraz -= 1;
      const numer = rid++;
      const { cialo } = odpowiedz(url);
      tresci.set(numer, { dane: new TextEncoder().encode(JSON.stringify(cialo)), odczytane: false });
      return numer;
    }
    if (cmd === 'plugin:http|fetch_send') {
      const numer = Number(args?.rid);
      const url = stan.adresy[numer - 1];
      return { status: odpowiedz(url).status, statusText: '', url, headers: [], rid: numer };
    }
    if (cmd === 'plugin:http|fetch_read_body') {
      const wpis = tresci.get(Number(args?.rid))!;
      if (wpis.odczytane) return [1];
      wpis.odczytane = true;
      return [...wpis.dane, 0];
    }
    return undefined;
  };
  return { stan, ipc };
}

test('desktop: /api/quotes odpowiada jak serwer web - {success, quotes:{TICKER:quote}} z limitem rownoleglosci', async () => {
  const { stan, ipc } = zAtrapaWtyczkiHttp((url) => url.includes('BRAK')
    ? { status: 404, cialo: {} }
    : { status: 200, cialo: { chart: { result: [{ meta: { currency: 'USD', regularMarketPrice: 10 } }] } } });
  const poprzednie = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: { __TAURI_INTERNALS__: { invoke: ipc } }, configurable: true, writable: true });
  try {
    await wDesktopie({ protocol: 'http:', hostname: 'tauri.localhost' }, async (wywolania) => {
      const tickery = Array.from({ length: 20 }, (_, i) => `T${i}`);
      const odpowiedz = await apiFetch(`/api/quotes?tickers=${encodeURIComponent([...tickery, 'brak', 't3'].join(','))}`);
      assert.equal(odpowiedz.status, 200);
      const dane = await odpowiedz.json();
      assert.equal(dane.success, true);
      assert.deepEqual(Object.keys(dane.quotes).sort(), [...tickery].sort(), 'brakujacy walor pominiety, duplikaty scalone');
      assert.equal(dane.quotes.T0.ticker, 'T0');
      assert.equal(dane.quotes.T0.price, 10);
      assert.equal(dane.quotes.T0.currency, 'USD');
      assert.ok(stan.maksNaraz <= MAX_ROWNOLEGLYCH_POBRAN, `rownolegle: ${stan.maksNaraz}`);
      assert.ok(stan.maksNaraz > 1, 'pobrania nie ida po kolei');
      assert.deepEqual(wywolania, [], 'bez serwera nie ma czego odpytywac');
    });
  } finally {
    if (poprzednie) Object.defineProperty(globalThis, 'window', poprzednie); else delete (globalThis as { window?: unknown }).window;
  }
});

test('desktop: /api/quotes odrzuca zbyt dluga liste tak jak serwer (400)', async () => {
  await wDesktopie({ protocol: 'http:', hostname: 'tauri.localhost' }, async () => {
    const zaDuzo = Array.from({ length: MAX_TICKEROW_NA_ZADANIE + 1 }, (_, i) => `T${i}`).join(',');
    const odpowiedz = await apiFetch(`/api/quotes?tickers=${zaDuzo}`);
    assert.equal(odpowiedz.status, 400);
    assert.equal((await odpowiedz.json()).success, false);
  });
});

test('desktop: /api/quotes bez tickerow daje pusta mape, a nieobslugiwana trasa /api/* odmowe 501', async () => {
  await wDesktopie({ protocol: 'http:', hostname: 'tauri.localhost' }, async (wywolania) => {
    const puste = await (await apiFetch('/api/quotes?tickers=')).json();
    assert.deepEqual(puste.quotes, {});
    const odmowa = await apiFetch('/api/history/ABC?range=1mo');
    assert.equal(odmowa.status, 501);
    assert.equal((await odmowa.json()).errorCode, KOD_NIEDOSTEPNE_W_DESKTOPIE);
    assert.deepEqual(wywolania, []);
  });
});

test('desktop: notowania pytaja dostawce o ten sam symbol co serwer (NBIS.US -> NBIS, CDR.PL -> CDR.WA)', async () => {
  const { stan, ipc } = zAtrapaWtyczkiHttp(() => (
    { status: 200, cialo: { chart: { result: [{ meta: { currency: 'USD', regularMarketPrice: 5 } }] } } }
  ));
  const poprzednie = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: { __TAURI_INTERNALS__: { invoke: ipc } }, configurable: true, writable: true });
  try {
    await wDesktopie({ protocol: 'http:', hostname: 'tauri.localhost' }, async () => {
      const dane = await (await apiFetch('/api/quotes?tickers=NBIS.US,CDR.PL,VWCE')).json();
      assert.deepEqual(Object.keys(dane.quotes).sort(), ['CDR.PL', 'NBIS.US', 'VWCE'], 'klucze zostaja tickerami z zapytania');
      const symbole = stan.adresy.map((adres) => /finance\/chart\/([^?]+)/.exec(adres)?.[1]).sort();
      assert.deepEqual(symbole, ['CDR.WA', 'NBIS', 'VWCE.DE']);
      stan.adresy.length = 0;
      const pojedyncze = await (await apiFetch('/api/quote/NBIS.US')).json();
      assert.equal(pojedyncze.quote.ticker, 'NBIS.US');
      assert.match(stan.adresy[0], /chart\/NBIS\?/);
    });
  } finally {
    if (poprzednie) Object.defineProperty(globalThis, 'window', poprzednie); else delete (globalThis as { window?: unknown }).window;
  }
});

const zWindow = async (ipc: (cmd: string, args?: Record<string, any>) => Promise<unknown>, dzialanie: () => Promise<void>) => {
  const poprzednie = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: { __TAURI_INTERNALS__: { invoke: ipc } }, configurable: true, writable: true });
  try {
    await wDesktopie({ protocol: 'http:', hostname: 'tauri.localhost' }, dzialanie);
  } finally {
    if (poprzednie) Object.defineProperty(globalThis, 'window', poprzednie); else delete (globalThis as { window?: unknown }).window;
  }
};

test('desktop: notowanie ma pelny ksztalt LiveMarketQuote jak odpowiedz serwera', async () => {
  const { ipc } = zAtrapaWtyczkiHttp((url) => url.includes('BEZZMIANY')
    ? { status: 200, cialo: { chart: { result: [{ meta: { currency: 'USD', regularMarketPrice: 50 } }] } } }
    : { status: 200, cialo: { chart: { result: [{ meta: {
      currency: 'USD', regularMarketPrice: 100, chartPreviousClose: 98, regularMarketDayHigh: 101, regularMarketDayLow: 97,
      regularMarketVolume: 5000, longName: 'Test Corp', instrumentType: 'EQUITY',
    } }] } } });
  await zWindow(ipc, async () => {
    const przed = Date.now();
    const dane = await (await apiFetch('/api/quotes?tickers=TESTCORP,BEZZMIANY')).json();
    const q = dane.quotes.TESTCORP;
    assert.deepEqual(
      { ...q, lastUpdated: undefined },
      {
        ticker: 'TESTCORP', name: 'Test Corp', category: 'STOCK_FOREIGN', price: 100, currency: 'USD',
        change24h: 2, changePercent24h: 2.04, high24h: 101, low24h: 97, volume24h: 5000, sparkline: [],
        lastUpdated: undefined, source: 'TRADINGVIEW', dostawcaDanych: 'YAHOO_FINANCE',
      },
    );
    assert.ok(Date.parse(q.lastUpdated) >= przed - 1000 && Date.parse(q.lastUpdated) <= Date.now() + 1000, 'lastUpdated = czas pobrania');
    // Dostawca nie podal poprzedniego zamkniecia: zmiana to brak danych (null), nie 0.
    const bez = dane.quotes.BEZZMIANY;
    assert.equal(bez.change24h, null);
    assert.equal(bez.changePercent24h, null);
    assert.equal(bez.high24h, null);
    assert.equal(bez.volume24h, null);
    assert.ok(Number.isFinite(Date.parse(bez.lastUpdated)));
    assert.equal(bez.name, 'BEZZMIANY');
  });
});

test('desktop: notowanie GPW dostaje kategorie STOCK_PL i zrodlo GPW, a krypto pelne pola z Binance 24h', async () => {
  const { ipc } = zAtrapaWtyczkiHttp((url) => url.includes('binance')
    ? { status: 200, cialo: { symbol: 'BTCUSDT', lastPrice: '60000.10', priceChange: '600.05', priceChangePercent: '1.01', highPrice: '61000', lowPrice: '59000', quoteVolume: '12345.6' } }
    : { status: 200, cialo: { chart: { result: [{ meta: { currency: 'PLN', regularMarketPrice: 120, chartPreviousClose: 118 } }] } } });
  await zWindow(ipc, async () => {
    const dane = await (await apiFetch('/api/quotes?tickers=CDR.PL,BTC')).json();
    assert.equal(dane.quotes['CDR.PL'].category, 'STOCK_PL');
    assert.equal(dane.quotes['CDR.PL'].source, 'GPW');
    assert.equal(dane.quotes['CDR.PL'].currency, 'PLN');
    const btc = dane.quotes.BTC;
    assert.equal(btc.category, 'CRYPTO');
    assert.equal(btc.price, 60000.1);
    assert.equal(btc.changePercent24h, 1.01);
    assert.equal(btc.high24h, 61000);
    assert.equal(btc.source, 'BINANCE');
    assert.equal(btc.dostawcaDanych, 'BINANCE');
    assert.ok(Number.isFinite(Date.parse(btc.lastUpdated)));
  });
});
