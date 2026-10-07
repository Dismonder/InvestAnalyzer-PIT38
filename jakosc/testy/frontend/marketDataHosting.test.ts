/**
 * Wersja hostowana: API ma limit zadan na adres IP i pamiec brzegowa 10 s, wiec
 * odpytywanie nie moze byc czestsze niz 10 s, a po 429 ma stanac na czas z Retry-After.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.window = {
  setTimeout: () => 1,
  clearTimeout: () => undefined,
  addEventListener: () => undefined,
} as unknown as Window & typeof globalThis;
globalThis.document = { addEventListener: () => undefined } as unknown as Document;
globalThis.localStorage = { getItem: (key: string) => key === 'pit38_streaming_active' ? 'false' : null } as Storage;
const {
  MIN_INTERWAL_HOSTINGU_MS,
  MIN_INTERWAL_LOKALNY_MS,
  MAX_INTERWAL_MS,
  marketDataService,
  przytnijInterwalMs,
  sekundyWstrzymaniaPo429,
} = await import('../../../aplikacje/web/src/portfel/services/marketDataService.ts');

test('odstep odswiezania: w hostingu nie krotszy niz 10 s, lokalnie nie krotszy niz 2 s, nigdy dluzszy niz 60 s', () => {
  assert.equal(przytnijInterwalMs(2000, true), MIN_INTERWAL_HOSTINGU_MS);
  assert.equal(przytnijInterwalMs(3000, true), MIN_INTERWAL_HOSTINGU_MS);
  assert.equal(przytnijInterwalMs(15000, true), 15000);
  assert.equal(przytnijInterwalMs(2000, false), MIN_INTERWAL_LOKALNY_MS);
  assert.equal(przytnijInterwalMs(500, false), MIN_INTERWAL_LOKALNY_MS);
  assert.equal(przytnijInterwalMs(999999, false), MAX_INTERWAL_MS);
  assert.equal(przytnijInterwalMs(Number.NaN, true), MIN_INTERWAL_HOSTINGU_MS, 'smieciowy zapis to domyslny odstep przyciety do progu');
});

test('czas wstrzymania po 429: z Retry-After w granicach 5-300 s, bez naglowka 60 s', () => {
  assert.equal(sekundyWstrzymaniaPo429('60'), 60);
  assert.equal(sekundyWstrzymaniaPo429('7'), 7);
  assert.equal(sekundyWstrzymaniaPo429('1'), 5);
  assert.equal(sekundyWstrzymaniaPo429('9999'), 300);
  assert.equal(sekundyWstrzymaniaPo429(null), 60);
  assert.equal(sekundyWstrzymaniaPo429('Wed, 21 Oct 2026 07:28:00 GMT'), 60, 'data zamiast sekund: domyslne 60 s');
});

test('po 429 odpytywanie stoi do konca Retry-After i nie wysyla kolejnych zadan', async (t) => {
  let zapytan = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    zapytan++;
    return new Response(JSON.stringify({ success: false, error: 'limit' }), { status: 429, headers: { 'Retry-After': '30' } });
  });
  assert.equal(marketDataService.getWstrzymaneDo(), 0);
  await marketDataService.fetchRealQuotes(['LIMIT_A', 'LIMIT_B'], true);
  assert.equal(zapytan, 1);
  const koniec = marketDataService.getWstrzymaneDo();
  assert.ok(koniec > Date.now() + 25_000 && koniec <= Date.now() + 30_000, 'wstrzymanie na ok. 30 s z Retry-After');

  t.mock.method(globalThis, 'fetch', async () => {
    zapytan++;
    return new Response(JSON.stringify({ success: true, quotes: { LIMIT_A: { ticker: 'LIMIT_A', price: 1, currency: 'USD' } } }), { status: 200 });
  });
  await marketDataService.fetchRealQuotes(['LIMIT_A'], true);
  assert.equal(await marketDataService.fetchSingleTicker('LIMIT_A', true), null);
  assert.equal(zapytan, 1, 'w czasie wstrzymania zadne zadanie nie wychodzi');
});
