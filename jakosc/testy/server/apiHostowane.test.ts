/**
 * Hostowana wersja (Worker Cloudflare) nie ma serwera Node: trasy bez odpowiednika
 * musza odmawiac jednoznacznie, a notowania i kursy musza miec ksztalt serwera web.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KOD_NIEDOSTEPNE_W_HOSTINGU,
  MAX_TICKEROW_NA_ZADANIE,
  obsluzApiHostowane,
} from '../../../aplikacje/web/src/hosting/apiHostowane.ts';

type Odpowiedzi = Record<string, { status?: number; cialo: unknown }>;

function atrapaFetch(odpowiedzi: Odpowiedzi, wywolania: string[] = []) {
  const fetchFn = async (url: string) => {
    wywolania.push(url);
    const klucz = Object.keys(odpowiedzi).find((fragment) => url.includes(fragment));
    if (!klucz) return new Response('{}', { status: 404 });
    const { status = 200, cialo } = odpowiedzi[klucz];
    return new Response(JSON.stringify(cialo), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return { fetchFn, wywolania };
}

const wynikYahoo = (symbol: string, cena: number, waluta = 'USD') => ({
  chart: {
    result: [{
      meta: {
        symbol, currency: waluta, regularMarketPrice: cena, chartPreviousClose: cena - 1,
        regularMarketDayHigh: cena + 0.5, regularMarketDayLow: cena - 0.5, regularMarketVolume: 1000,
        longName: 'Testowa Spółka', instrumentType: 'EQUITY',
        // Polnoc UTC + sesja 9:30-16:00; swiece o 10:00 i 10:15 leza w sesji regularnej.
        currentTradingPeriod: { regular: { start: 1_699_920_000 + 34_200, end: 1_699_920_000 + 57_600, gmtoffset: 0 } },
      },
      timestamp: [1_699_920_000 + 36_000, 1_699_920_000 + 36_900],
      indicators: { quote: [{ open: [cena - 1, cena], high: [cena, cena + 0.5], low: [cena - 1.5, cena - 0.5], close: [cena - 1, cena], volume: [10, 20] }] },
    }],
  },
});

const zadanie = (sciezka: string, init?: RequestInit) => new Request(`https://app.example${sciezka}`, init);

test('trasy serwera Node (silnik, magazyn, kopie, broker) dostaja 501 z kodem NIEDOSTEPNE_W_HOSTINGU, bez odpytywania sieci', async () => {
  const { fetchFn, wywolania } = atrapaFetch({});
  for (const [sciezka, metoda] of [
    ['/api/tax-engine/run', 'POST'], ['/api/storage/files', 'GET'], ['/api/backups', 'GET'],
    ['/api/brokers/sync', 'POST'], ['/api/brokers/freedom24/status', 'GET'], ['/api/ollama/status', 'GET'],
    ['/api/runtime/clear-app-data', 'POST'],
  ] as const) {
    const odpowiedz = await obsluzApiHostowane(zadanie(sciezka, { method: metoda, body: metoda === 'POST' ? '{}' : undefined }), { fetch: fetchFn });
    assert.equal(odpowiedz.status, 501, sciezka);
    const dane = await odpowiedz.json();
    assert.equal(dane.success, false);
    assert.equal(dane.errorCode, KOD_NIEDOSTEPNE_W_HOSTINGU);
    assert.equal(typeof dane.error, 'string');
    assert.equal(dane.ambiguous, undefined, 'odmowa nie moze wygladac na wynik niepewny');
  }
  assert.deepEqual(wywolania, []);
});

test('/api/health odpowiada trybem hosting', async () => {
  const odpowiedz = await obsluzApiHostowane(zadanie('/api/health'), { fetch: atrapaFetch({}).fetchFn });
  assert.equal(odpowiedz.status, 200);
  assert.equal((await odpowiedz.json()).tryb, 'hosting');
});

test('/api/quotes ma ksztalt serwera web: mapa po tickerze, cena, waluta, zrodlo danych', async () => {
  const { fetchFn, wywolania } = atrapaFetch({
    'chart/NBIS?': { cialo: wynikYahoo('NBIS', 100) },
    'chart/CDR.WA?': { cialo: wynikYahoo('CDR.WA', 250, 'PLN') },
  });
  const odpowiedz = await obsluzApiHostowane(zadanie('/api/quotes?tickers=NBIS.US,CDR,NIEMA'), { fetch: fetchFn });
  assert.equal(odpowiedz.status, 200);
  const dane = await odpowiedz.json();
  assert.equal(dane.success, true);
  assert.deepEqual(Object.keys(dane.quotes).sort(), ['CDR', 'NBIS.US']);
  assert.equal(dane.quotes['NBIS.US'].price, 100);
  assert.equal(dane.quotes['NBIS.US'].change24h, 1);
  assert.equal(dane.quotes['NBIS.US'].dostawcaDanych, 'YAHOO_FINANCE');
  assert.equal(dane.quotes.CDR.currency, 'PLN');
  assert.equal(dane.quotes.CDR.category, 'STOCK_PL');
  assert.deepEqual(dane.quotes.CDR.sparkline, [249, 250]);
  assert.deepEqual(dane.staleTickers, []);
  assert.ok(wywolania.some((url) => url.includes('chart/CDR.WA?')), 'ticker GPW idzie do Yahoo z sufiksem .WA');
});

test('/api/quotes odrzuca zbyt dluga liste jak serwer', async () => {
  const tickery = Array.from({ length: MAX_TICKEROW_NA_ZADANIE + 1 }, (_, i) => `T${i}`).join(',');
  const odpowiedz = await obsluzApiHostowane(zadanie(`/api/quotes?tickers=${tickery}`), { fetch: atrapaFetch({}).fetchFn });
  assert.equal(odpowiedz.status, 400);
});

test('pensy GBp sa przeliczane na funty, a brak ceny to 404 nie cena 0', async () => {
  const gbp = wynikYahoo('VOD.L', 7250, 'GBp');
  const { fetchFn } = atrapaFetch({
    'chart/VOD.L?': { cialo: gbp },
    'chart/PUSTY?': { cialo: { chart: { result: [{ meta: { currency: 'USD' } }] } } },
  });
  const funty = await (await obsluzApiHostowane(zadanie('/api/quote/VOD.UK'), { fetch: fetchFn })).json();
  assert.equal(funty.quote.price, 72.5);
  assert.equal(funty.quote.currency, 'GBP');
  const brak = await obsluzApiHostowane(zadanie('/api/quote/PUSTY'), { fetch: fetchFn });
  assert.equal(brak.status, 404);
});

test('/api/history zwraca swiece z etykieta i sesja; zakres max dopasowany do interwalu', async () => {
  const { fetchFn, wywolania } = atrapaFetch({ 'chart/NBIS?': { cialo: wynikYahoo('NBIS', 100) } });
  const odpowiedz = await obsluzApiHostowane(zadanie('/api/history/NBIS.US?range=max&interval=15m'), { fetch: fetchFn });
  const dane = await odpowiedz.json();
  assert.equal(dane.success, true);
  assert.equal(dane.data.range, '60d');
  assert.equal(dane.data.points.length, 2);
  assert.deepEqual(Object.keys(dane.data.points[0]).sort(), ['close', 'date', 'high', 'low', 'open', 'session', 'timestamp', 'volume']);
  assert.equal(dane.data.points[0].session, 'REGULAR');
  assert.ok(wywolania[0].includes('includePrePost=true'));
});

test('/api/nbp/rate bierze tabele z dnia poprzedniego i cofa sie przy braku tabeli', async () => {
  const { fetchFn, wywolania } = atrapaFetch({
    '/usd/2026-03-08/': { status: 404, cialo: {} },
    '/usd/2026-03-07/': { status: 404, cialo: {} },
    '/usd/2026-03-06/': { cialo: { table: 'A', rates: [{ no: '046/A/NBP/2026', effectiveDate: '2026-03-06', mid: 3.95 }] } },
  });
  const odpowiedz = await obsluzApiHostowane(zadanie('/api/nbp/rate?currency=usd&date=2026-03-09'), { fetch: fetchFn });
  const dane = await odpowiedz.json();
  assert.equal(dane.success, true);
  assert.equal(dane.data.mid, 3.95);
  assert.equal(dane.appliedTableDate, '2026-03-06');
  assert.equal(wywolania.length, 3);
  const pln = await (await obsluzApiHostowane(zadanie('/api/nbp/rate?currency=PLN&date=2026-03-09'), { fetch: fetchFn })).json();
  assert.equal(pln.data.mid, 1);
});

test('/api/search-tickers laczy wykaz lokalny z wynikami Yahoo i czysci sufiks .WA', async () => {
  const { fetchFn } = atrapaFetch({
    'finance/search?q=': { cialo: { quotes: [{ symbol: 'PKN.WA', shortname: 'Orlen', quoteType: 'EQUITY' }, { symbol: 'PKNX', shortname: 'Inny', quoteType: 'EQUITY', exchDisp: 'NYSE' }] } },
  });
  const dane = await (await obsluzApiHostowane(zadanie('/api/search-tickers?q=pkn'), { fetch: fetchFn })).json();
  const tickery = dane.results.map((w: { ticker: string }) => w.ticker);
  assert.ok(tickery.includes('PKN'), 'z wykazu lokalnego');
  assert.ok(tickery.includes('PKNX'), 'z Yahoo');
  assert.equal(dane.results.filter((w: { ticker: string }) => w.ticker === 'PKN').length, 1, 'bez duplikatu PKN/PKN.WA');
  const pusty = await (await obsluzApiHostowane(zadanie('/api/search-tickers?q='), { fetch: fetchFn })).json();
  assert.deepEqual(pusty.results, []);
});

test('pamiec brzegowa: druga odpowiedz z pamieci, force=true omija pamiec', async () => {
  const { fetchFn, wywolania } = atrapaFetch({ 'chart/NBIS?': { cialo: wynikYahoo('NBIS', 100) } });
  const magazyn = new Map<string, Response>();
  const cache = {
    match: async (klucz: Request) => magazyn.get(klucz.url)?.clone(),
    put: async (klucz: Request, odpowiedz: Response) => { magazyn.set(klucz.url, odpowiedz); },
  } as unknown as Cache;
  await obsluzApiHostowane(zadanie('/api/quote/NBIS'), { fetch: fetchFn, cache });
  await obsluzApiHostowane(zadanie('/api/quote/NBIS'), { fetch: fetchFn, cache });
  assert.equal(wywolania.length, 1, 'druga odpowiedz z pamieci');
  const [zapamietana] = magazyn.values();
  assert.equal(zapamietana.headers.get('Cache-Control'), 'public, max-age=10');
  await obsluzApiHostowane(zadanie('/api/quote/NBIS?force=true'), { fetch: fetchFn, cache });
  assert.equal(wywolania.length, 2, 'force omija pamiec');
});
