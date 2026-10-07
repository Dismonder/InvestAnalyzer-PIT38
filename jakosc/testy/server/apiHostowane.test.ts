/**
 * Hostowana wersja (Worker Cloudflare) nie ma serwera Node: trasy bez odpowiednika
 * musza odmawiac jednoznacznie, a notowania i kursy musza miec ksztalt serwera web.
 * Druga czesc: API jest publiczne, wiec sprawdzamy walidacje wejscia, limity,
 * kanoniczne klucze pamieci brzegowej, naglowki i odpornosc na wyjatki.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUDZET_POBRAN_NA_ZADANIE,
  KOD_NIEDOSTEPNE_W_HOSTINGU,
  MAX_DLUGOSC_TICKERA,
  MAX_TICKEROW_NA_ZADANIE,
  SEKUNDY_SWIEZOSCI_PRZY_FORCE,
  czyPoprawnaDataKursu,
  kluczLimituZAdresu,
  normalizujListeTickerow,
  normalizujTicker,
  normalizujWalute,
  normalizujZapytanie,
  obsluzApiHostowane,
  odczytajJsonZLimitem,
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

function atrapaCache() {
  const magazyn = new Map<string, Response>();
  const cache = {
    match: async (klucz: Request) => magazyn.get(klucz.url)?.clone(),
    put: async (klucz: Request, odpowiedz: Response) => { magazyn.set(klucz.url, odpowiedz); },
  } as unknown as Cache;
  return { cache, magazyn };
}

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

test('pamiec brzegowa: druga odpowiedz z pamieci, force=true omija tylko wpisy starsze niz kilka sekund', async () => {
  const { fetchFn, wywolania } = atrapaFetch({ 'chart/NBIS?': { cialo: wynikYahoo('NBIS', 100) } });
  const { cache, magazyn } = atrapaCache();
  const start = Date.parse('2026-10-07T10:00:00Z');
  const oCzasie = (ms: number) => ({ fetch: fetchFn, cache, teraz: () => new Date(start + ms) });
  await obsluzApiHostowane(zadanie('/api/quote/NBIS'), oCzasie(0));
  await obsluzApiHostowane(zadanie('/api/quote/NBIS'), oCzasie(1000));
  assert.equal(wywolania.length, 1, 'druga odpowiedz z pamieci');
  const [zapamietana] = magazyn.values();
  assert.equal(zapamietana.headers.get('Cache-Control'), 'public, max-age=10');
  await obsluzApiHostowane(zadanie('/api/quote/NBIS?force=true'), oCzasie(2000));
  assert.equal(wywolania.length, 1, 'force na swiezym wpisie nie wymusza pobrania (klient nie zrobi lawiny)');
  await obsluzApiHostowane(zadanie('/api/quote/NBIS?force=true'), oCzasie(SEKUNDY_SWIEZOSCI_PRZY_FORCE * 1000 + 1));
  assert.equal(wywolania.length, 2, 'force na starszym wpisie omija pamiec');
});

// --- Utwardzenie publicznego API (2026-10-07) ---

test('kazda odpowiedz API niesie naglowki bezpieczenstwa (nosniff, CSP, HSTS, CORP, noindex)', async () => {
  const { fetchFn } = atrapaFetch({ 'chart/NBIS?': { cialo: wynikYahoo('NBIS', 100) } });
  for (const sciezka of ['/api/health', '/api/quote/NBIS', '/api/supported-assets', '/api/tax-engine/run']) {
    const odpowiedz = await obsluzApiHostowane(zadanie(sciezka), { fetch: fetchFn });
    assert.equal(odpowiedz.headers.get('X-Content-Type-Options'), 'nosniff', sciezka);
    assert.equal(odpowiedz.headers.get('X-Frame-Options'), 'DENY', sciezka);
    assert.equal(odpowiedz.headers.get('Cross-Origin-Resource-Policy'), 'same-origin', sciezka);
    assert.equal(odpowiedz.headers.get('X-Robots-Tag'), 'noindex, nofollow', sciezka);
    assert.match(odpowiedz.headers.get('Content-Security-Policy') || '', /default-src 'none'/, sciezka);
    assert.match(odpowiedz.headers.get('Strict-Transport-Security') || '', /max-age=31536000/, sciezka);
    assert.equal(odpowiedz.headers.get('Access-Control-Allow-Origin'), null, 'API jest tylko same-origin');
  }
});

test('walidacja symboli: zle wpisy sa pomijane w liscie, pojedynczy zly symbol to 400, nic nie idzie do dostawcy', async () => {
  const { fetchFn, wywolania } = atrapaFetch({ 'chart/NBIS?': { cialo: wynikYahoo('NBIS', 100) } });
  const mieszane = await obsluzApiHostowane(zadanie('/api/quotes?tickers=NBIS,<script>,..%2F..%2Fetc,a%20b'), { fetch: fetchFn });
  assert.equal(mieszane.status, 200);
  assert.deepEqual(Object.keys((await mieszane.json()).quotes), ['NBIS']);
  assert.ok(wywolania.every((url) => url.includes('chart/NBIS?')), 'do dostawcy idzie tylko poprawny symbol');

  const liczbaPrzed = wywolania.length;
  for (const sciezka of ['/api/quotes?tickers=<script>', '/api/quote/..%2F..%2Fadmin', '/api/quote/%7B%7D', '/api/history/A%20B', `/api/quote/${'A'.repeat(25)}`]) {
    const odpowiedz = await obsluzApiHostowane(zadanie(sciezka), { fetch: fetchFn });
    assert.equal(odpowiedz.status, 400, sciezka);
    assert.equal((await odpowiedz.json()).success, false);
  }
  assert.equal(wywolania.length, liczbaPrzed, 'odrzucone wejscie nie dociera do dostawcy');

  // Symbole, ktore aplikacja naprawde wysyla, przechodza: sufiksy brokera, nota, indeks, para walut.
  for (const sciezka of ['/api/quote/NBIS.US', '/api/quote/CDR.PL', '/api/quote/DGT4016.JUN26', '/api/quote/%5EGSPC', '/api/quote/EURUSD%3DX', '/api/quote/BRK-B']) {
    const odpowiedz = await obsluzApiHostowane(zadanie(sciezka), { fetch: fetchFn });
    assert.notEqual(odpowiedz.status, 400, sciezka);
  }
});

test('walidacja historii, kursu NBP i wyszukiwarki', async () => {
  const { fetchFn, wywolania } = atrapaFetch({ 'finance/search?q=': { cialo: { quotes: [] } } });
  for (const sciezka of [
    '/api/history/NBIS?range=99y', '/api/history/NBIS?range=1mo&interval=7m', '/api/history/NBIS?range=1mo%0D%0AX-Inj:1',
    '/api/nbp/rate?currency=usdx&date=2026-03-09', '/api/nbp/rate?currency=US%24&date=2026-03-09',
    '/api/nbp/rate?currency=USD&date=2026-13-01', '/api/nbp/rate?currency=USD&date=2026-02-30',
    '/api/nbp/rate?currency=USD&date=1999-01-01', '/api/nbp/rate?currency=USD&date=2026-03-09%2F..',
  ]) {
    const odpowiedz = await obsluzApiHostowane(zadanie(sciezka), { fetch: fetchFn });
    assert.equal(odpowiedz.status, 400, sciezka);
  }
  assert.deepEqual(wywolania, [], 'odrzucone wejscie nie dociera do dostawcy');

  const dlugie = 'x'.repeat(200) + '\u0000\u001f';
  const odpowiedz = await obsluzApiHostowane(zadanie(`/api/search-tickers?q=${encodeURIComponent(dlugie)}`), { fetch: fetchFn });
  assert.equal(odpowiedz.status, 200);
  assert.equal((await odpowiedz.json()).query.length, 64, 'zapytanie przyciete do limitu, bez znakow sterujacych');
  assert.ok(wywolania[0].includes(`q=${'x'.repeat(64)}&`), 'do Yahoo idzie przyciete zapytanie');
});

test('adres za dlugi to 414, obce metody to 405 z Allow, OPTIONS to 204, HEAD bez tresci', async () => {
  const { fetchFn, wywolania } = atrapaFetch({});
  const zaDlugi = await obsluzApiHostowane(zadanie(`/api/quotes?tickers=${'A,'.repeat(1100)}`), { fetch: fetchFn });
  assert.equal(zaDlugi.status, 414);

  const post = await obsluzApiHostowane(zadanie('/api/quotes', { method: 'POST', body: '{}' }), { fetch: fetchFn });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('Allow'), 'GET, HEAD, OPTIONS');
  const del = await obsluzApiHostowane(zadanie('/api/nbp/rate', { method: 'DELETE' }), { fetch: fetchFn });
  assert.equal(del.status, 405);

  const options = await obsluzApiHostowane(zadanie('/api/quotes', { method: 'OPTIONS' }), { fetch: fetchFn });
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('Allow'), 'GET, HEAD, OPTIONS');

  const head = await obsluzApiHostowane(zadanie('/api/health', { method: 'HEAD' }), { fetch: fetchFn });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(head.headers.get('Content-Type'), 'application/json; charset=utf-8');
  assert.deepEqual(wywolania, []);
});

test('zadanie cross-site (obca strona uzywa przegladarki jako proxy) dostaje 403, same-origin przechodzi', async () => {
  const { fetchFn } = atrapaFetch({});
  const obce = await obsluzApiHostowane(zadanie('/api/health', { headers: { 'Sec-Fetch-Site': 'cross-site' } }), { fetch: fetchFn });
  assert.equal(obce.status, 403);
  const swoje = await obsluzApiHostowane(zadanie('/api/health', { headers: { 'Sec-Fetch-Site': 'same-origin' } }), { fetch: fetchFn });
  assert.equal(swoje.status, 200);
  const bezNaglowka = await obsluzApiHostowane(zadanie('/api/health'), { fetch: fetchFn });
  assert.equal(bezNaglowka.status, 200, 'klienci bez Sec-Fetch-Site (curl, stare przegladarki) nie sa odrzucani');
});

test('limity per IP: 429 z Retry-After, osobny limit notowan, awaria ogranicznika nie blokuje API', async () => {
  const { fetchFn, wywolania } = atrapaFetch({ 'chart/NBIS?': { cialo: wynikYahoo('NBIS', 100) } });
  const klucze: string[] = [];
  const zablokowane = await obsluzApiHostowane(zadanie('/api/health'), {
    fetch: fetchFn, ip: '203.0.113.7', limity: { api: async (klucz) => { klucze.push(klucz); return false; } },
  });
  assert.equal(zablokowane.status, 429);
  assert.equal(zablokowane.headers.get('Retry-After'), '60');
  assert.deepEqual(klucze, ['203.0.113.7'], 'kluczem limitu jest adres IP');

  const tylkoNotowania = { api: async () => true, notowania: async () => false };
  assert.equal((await obsluzApiHostowane(zadanie('/api/health'), { fetch: fetchFn, limity: tylkoNotowania })).status, 200);
  assert.equal((await obsluzApiHostowane(zadanie('/api/nbp/rate?currency=PLN&date=2026-03-09'), { fetch: fetchFn, limity: tylkoNotowania })).status, 200);
  assert.equal((await obsluzApiHostowane(zadanie('/api/quote/NBIS'), { fetch: fetchFn, limity: tylkoNotowania })).status, 429);
  assert.equal((await obsluzApiHostowane(zadanie('/api/search-tickers?q=nb'), { fetch: fetchFn, limity: tylkoNotowania })).status, 429);
  assert.deepEqual(wywolania, [], 'odrzucone limitem zadanie nie dociera do dostawcy');

  const zKluczemZNaglowka: string[] = [];
  await obsluzApiHostowane(zadanie('/api/health', { headers: { 'CF-Connecting-IP': '198.51.100.9' } }), {
    fetch: fetchFn, limity: { api: async (klucz) => { zKluczemZNaglowka.push(klucz); return true; } },
  });
  assert.deepEqual(zKluczemZNaglowka, ['198.51.100.9']);

  const awaria = await obsluzApiHostowane(zadanie('/api/quote/NBIS'), { fetch: fetchFn, limity: { api: async () => { throw new Error('binding offline'); } } });
  assert.equal(awaria.status, 200, 'awaria ogranicznika przepuszcza zadanie');
});

test('klucz pamieci brzegowej jest kanoniczny: kolejnosc i smieciowe parametry nie mnoza wpisow', async () => {
  const { fetchFn, wywolania } = atrapaFetch({
    'chart/NBIS?': { cialo: wynikYahoo('NBIS', 100) }, 'chart/CDR.WA?': { cialo: wynikYahoo('CDR.WA', 250, 'PLN') },
    'finance/search?q=': { cialo: { quotes: [] } },
  });
  const { cache, magazyn } = atrapaCache();
  await obsluzApiHostowane(zadanie('/api/quotes?tickers=NBIS,CDR'), { fetch: fetchFn, cache });
  const poPierwszym = wywolania.length;
  await obsluzApiHostowane(zadanie('/api/quotes?tickers=cdr,NBIS,CDR&smiec=1&utm_source=x&z=%00'), { fetch: fetchFn, cache });
  assert.equal(wywolania.length, poPierwszym, 'inna kolejnosc, duplikaty i obce parametry trafiaja w ten sam wpis');
  assert.deepEqual([...magazyn.keys()], ['https://app.example/api/quotes?tickers=CDR%2CNBIS']);

  await obsluzApiHostowane(zadanie('/api/search-tickers?q=Nbis&x=1'), { fetch: fetchFn, cache });
  const poSzukaniu = wywolania.length;
  await obsluzApiHostowane(zadanie('/api/search-tickers?q=nbis'), { fetch: fetchFn, cache });
  assert.equal(wywolania.length, poSzukaniu, 'wielkosc liter zapytania nie tworzy nowego wpisu');
  assert.ok([...magazyn.keys()].includes('https://app.example/api/search-tickers?q=nbis'));

  await obsluzApiHostowane(zadanie('/api/history/NBIS?interval=1d&range=1mo&force=false'), { fetch: fetchFn, cache });
  assert.ok([...magazyn.keys()].includes('https://app.example/api/history/NBIS?interval=1d&range=1mo'), 'parametry posortowane, bez force');
});

test('za duza odpowiedz dostawcy jest odrzucana zamiast czytana do konca', async () => {
  const wielkie = new Response(`{"chart":{"result":[{"meta":{"currency":"USD","regularMarketPrice":1}}]},"x":"${'a'.repeat(5 * 1024 * 1024)}"}`, {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
  const zDeklaracja = new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Length': String(100 * 1024 * 1024) } });
  assert.equal(await odczytajJsonZLimitem(wielkie), null);
  assert.equal(await odczytajJsonZLimitem(zDeklaracja), null);
  assert.deepEqual(await odczytajJsonZLimitem(new Response('{"ok":1}')), { ok: 1 }, 'maly JSON przechodzi');
  assert.equal(await odczytajJsonZLimitem(new Response('{"a":123456}'), 5), null, 'limit jawny');
  assert.equal(await odczytajJsonZLimitem(new Response('nie json')), null);

  const fetchFn = async () => new Response(`{"chart":{"result":[{"meta":{"currency":"USD","regularMarketPrice":5}}]},"pad":"${'b'.repeat(4 * 1024 * 1024 + 1)}"}`, { status: 200 });
  const odpowiedz = await obsluzApiHostowane(zadanie('/api/quote/NBIS'), { fetch: fetchFn });
  assert.equal(odpowiedz.status, 404, 'brak notowania zamiast wyjatku');
});

test('wyjatek w trakcie obslugi konczy sie neutralnym 500 bez szczegolow', async () => {
  const { fetchFn } = atrapaFetch({});
  const oryginalnyError = console.error;
  const zalogowane: unknown[] = [];
  console.error = (...args: unknown[]) => { zalogowane.push(args); };
  try {
    const odpowiedz = await obsluzApiHostowane(zadanie('/api/health'), { fetch: fetchFn, teraz: () => { throw new Error('tajny szczegol C:/sciezka'); } });
    assert.equal(odpowiedz.status, 500);
    const dane = await odpowiedz.json();
    assert.equal(dane.success, false);
    assert.ok(!JSON.stringify(dane).includes('tajny'), 'szczegoly wyjatku nie wychodza do klienta');
    assert.equal(odpowiedz.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(zalogowane.length, 1, 'wyjatek trafia do logu Workera');
  } finally {
    console.error = oryginalnyError;
  }
});

test('pomocniki walidacji: ticker, lista, data, zapytanie', () => {
  assert.equal(normalizujTicker(' nbis.us '), 'NBIS.US');
  assert.equal(normalizujTicker('^GSPC'), '^GSPC');
  assert.equal(normalizujTicker('EURUSD=X'), 'EURUSD=X');
  assert.equal(normalizujTicker(''), null);
  assert.equal(normalizujTicker('.NBIS'), null);
  assert.equal(normalizujTicker('NB IS'), null);
  assert.equal(normalizujTicker('NBIS/B'), null);
  assert.equal(normalizujTicker('A'.repeat(MAX_DLUGOSC_TICKERA + 1)), null);
  assert.deepEqual(normalizujListeTickerow(' nbis, cdr ,,NBIS,<x>'), { tickery: ['NBIS', 'CDR'], odrzucone: 1 });
  const teraz = new Date('2026-10-07T10:00:00Z');
  assert.equal(czyPoprawnaDataKursu('2026-02-28', teraz), true);
  assert.equal(czyPoprawnaDataKursu('2027-12-31', teraz), true, 'nastepny rok jeszcze dozwolony');
  assert.equal(czyPoprawnaDataKursu('2028-01-01', teraz), false);
  assert.equal(czyPoprawnaDataKursu('2001-12-31', teraz), false);
  assert.equal(czyPoprawnaDataKursu('2026-2-8', teraz), false);
  assert.equal(normalizujZapytanie('  pkn\u0000\u0007 orlen  '), 'pkn orlen');
});

// --- Druga runda po audycie (2026-10-07): budzet subrequestow, limit po chybieniu pamieci, IPv6, waluty NBP ---

test('budzet pobran na wywolanie: ponad limit instrumentow wraca jawnie jako pominiete, nie znika po cichu', async () => {
  let pobran = 0;
  const fetchFn = async (url: string) => {
    pobran++;
    const symbol = decodeURIComponent(url.split('chart/')[1].split('?')[0]);
    return new Response(JSON.stringify(wynikYahoo(symbol, 10)), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const tickery = Array.from({ length: BUDZET_POBRAN_NA_ZADANIE + 16 }, (_, i) => `A${i + 1}.US`);
  const odpowiedz = await obsluzApiHostowane(zadanie(`/api/quotes?tickers=${tickery.join(',')}`), { fetch: fetchFn });
  assert.equal(odpowiedz.status, 200);
  const dane = await odpowiedz.json();
  assert.equal(pobran, BUDZET_POBRAN_NA_ZADANIE, 'ani jedno pobranie ponad budzet (plan darmowy: 50 subrequestow)');
  assert.equal(Object.keys(dane.quotes).length, BUDZET_POBRAN_NA_ZADANIE);
  assert.equal(dane.pominieteLimitPobran.length, 16);
  assert.deepEqual(dane.staleTickers, dane.pominieteLimitPobran, 'klient zachowuje poprzednie notowanie pominietych');
  assert.equal(dane.fetchedCount, BUDZET_POBRAN_NA_ZADANIE);
  for (const t of dane.pominieteLimitPobran) assert.ok(!(t in dane.quotes));
});

test('limit notowan liczy sie dopiero po chybieniu pamieci brzegowej: trafienie nie kosztuje dostawcy', async () => {
  const { fetchFn, wywolania } = atrapaFetch({ 'chart/NBIS?': { cialo: wynikYahoo('NBIS', 100) } });
  const { cache } = atrapaCache();
  let sprawdzenNotowan = 0;
  const limity = { api: async () => true, notowania: async () => { sprawdzenNotowan++; return sprawdzenNotowan > 1; } };
  const pierwsze = await obsluzApiHostowane(zadanie('/api/quote/NBIS'), { fetch: fetchFn, cache, limity });
  assert.equal(pierwsze.status, 429, 'chybienie pamieci + limit = 429');
  assert.deepEqual(wywolania, []);
  assert.equal((await obsluzApiHostowane(zadanie('/api/quote/NBIS'), { fetch: fetchFn, cache, limity })).status, 200);
  assert.equal(wywolania.length, 1);
  const zablokowane = { api: async () => true, notowania: async () => false };
  const zPamieci = await obsluzApiHostowane(zadanie('/api/quote/NBIS'), { fetch: fetchFn, cache, limity: zablokowane });
  assert.equal(zPamieci.status, 200, 'trafienie w pamiec nie pyta ogranicznika notowan');
  assert.equal(wywolania.length, 1);
});

test('klucz limitu: IPv4 per adres, IPv6 per prefiks /64, brak adresu = klucz zastepczy', async () => {
  assert.equal(kluczLimituZAdresu('203.0.113.7'), '203.0.113.7');
  assert.equal(kluczLimituZAdresu('2001:db8:1:2:3:4:5:6'), '2001:0db8:0001:0002::/64');
  assert.equal(kluczLimituZAdresu('2001:DB8::1'), '2001:0db8:0000:0000::/64');
  assert.equal(kluczLimituZAdresu('::1'), '0000:0000:0000:0000::/64');
  assert.equal(kluczLimituZAdresu('fe80::1%eth0'), 'fe80:0000:0000:0000::/64');
  assert.equal(kluczLimituZAdresu(''), 'brak-ip');
  assert.equal(kluczLimituZAdresu(null), 'brak-ip');
  const klucze: string[] = [];
  await obsluzApiHostowane(zadanie('/api/health'), { fetch: atrapaFetch({}).fetchFn, ip: '2001:db8:1:2:ffff:ffff:ffff:ffff', limity: { api: async (k) => { klucze.push(k); return true; } } });
  await obsluzApiHostowane(zadanie('/api/health'), { fetch: atrapaFetch({}).fetchFn, ip: '2001:db8:1:2::1', limity: { api: async (k) => { klucze.push(k); return true; } } });
  assert.equal(klucze[0], klucze[1], 'dwa adresy z tej samej /64 dziela limit');
});

test('kurs NBP tylko dla walut z tabeli A: nieznany kod to 400 bez odpytywania NBP', async () => {
  const { fetchFn, wywolania } = atrapaFetch({ '/chf/2026-03-08/': { cialo: { table: 'A', rates: [{ no: '1', effectiveDate: '2026-03-08', mid: 4.5 }] } } });
  for (const waluta of ['XYZ', 'BTC', 'usdt', 'ABC']) {
    const odpowiedz = await obsluzApiHostowane(zadanie(`/api/nbp/rate?currency=${waluta}&date=2026-03-09`), { fetch: fetchFn });
    assert.equal(odpowiedz.status, 400, waluta);
  }
  assert.deepEqual(wywolania, []);
  const chf = await obsluzApiHostowane(zadanie('/api/nbp/rate?currency=chf&date=2026-03-09'), { fetch: fetchFn });
  assert.equal(chf.status, 200);
  assert.equal(normalizujWalute(' eur '), 'EUR');
  assert.equal(normalizujWalute('XDR'), 'XDR');
  assert.equal(normalizujWalute('ZZZ'), null);
});

test('zadanie same-site (inny poddomena tej samej witryny) tez dostaje 403', async () => {
  const { fetchFn } = atrapaFetch({});
  const sameSite = await obsluzApiHostowane(zadanie('/api/health', { headers: { 'Sec-Fetch-Site': 'same-site' } }), { fetch: fetchFn });
  assert.equal(sameSite.status, 403);
});

test('kryptowaluty ida do Yahoo jako para z dolarem (SOL-USD), nie jako akcja o tym samym tickerze', async () => {
  const { fetchFn, wywolania } = atrapaFetch({
    'chart/SOL-USD?': { cialo: wynikYahoo('SOL-USD', 150) },
    'chart/SOL?': { cialo: wynikYahoo('SOL', 2) },
    'chart/NBIS?': { cialo: wynikYahoo('NBIS', 100) },
  });
  const pojedyncze = await (await obsluzApiHostowane(zadanie('/api/quote/sol'), { fetch: fetchFn })).json();
  assert.equal(pojedyncze.quote.price, 150);
  assert.equal(pojedyncze.quote.category, 'CRYPTO');
  assert.equal(pojedyncze.quote.currency, 'USD');
  assert.equal(pojedyncze.quote.name, 'Solana');
  assert.ok(wywolania.every((url) => !url.includes('chart/SOL?')), 'goly symbol SOL (Emeren Group) nigdy nie jest pytany');

  const lista = await (await obsluzApiHostowane(zadanie('/api/quotes?tickers=SOL,NBIS'), { fetch: fetchFn })).json();
  assert.equal(lista.quotes.SOL.price, 150);
  assert.equal(lista.quotes.NBIS.category, 'STOCK_FOREIGN');

  const historia = await (await obsluzApiHostowane(zadanie('/api/history/LINK?range=1mo&interval=1d'), { fetch: async (url: string) => {
    wywolania.push(url);
    return new Response(JSON.stringify(wynikYahoo('LINK-USD', 20)), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } })).json();
  assert.equal(historia.data.meta.symbol, 'LINK-USD');
  assert.ok(wywolania.at(-1)!.includes('chart/LINK-USD?'));
});
