import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.window = {
  setTimeout: () => 1,
  clearTimeout: () => undefined,
  addEventListener: () => undefined,
} as unknown as Window & typeof globalThis;
globalThis.document = { addEventListener: () => undefined } as unknown as Document;
globalThis.localStorage = { getItem: (key: string) => key === 'pit38_streaming_active' ? 'false' : null } as Storage;
const { marketDataService } = await import('../../../aplikacje/web/src/portfel/services/marketDataService.ts');

const odpowiedz = (quotes: Record<string, unknown>) =>
  new Response(JSON.stringify({ success: true, quotes }), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('pusta mapa notowan (wszystko nieudane) nie ustawia lastFetchedAt', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => odpowiedz({ EMPTY_ONE: { ticker: 'EMPTY_ONE', price: 5, currency: 'USD' } }));
  await marketDataService.fetchRealQuotes(['EMPTY_ONE'], true);
  const czas = marketDataService.getLastFetchedAt();
  assert.ok(czas);
  await new Promise((resolve) => setTimeout(resolve, 5));
  t.mock.method(globalThis, 'fetch', async () => odpowiedz({}));
  await marketDataService.fetchRealQuotes(['EMPTY_ONE'], true);
  assert.equal(marketDataService.getLastFetchedAt(), czas);
});

test('sledzone tickery sa wysylane paczkami po najwyzej 100', async (t) => {
  const zapytania: string[][] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    const tickery = decodeURIComponent(new URL(url, 'http://localhost').searchParams.get('tickers') || '').split(',');
    zapytania.push(tickery);
    return odpowiedz(Object.fromEntries(tickery.map((ticker) => [ticker, { ticker, price: 1, currency: 'USD' }])));
  });
  const wszystkie = Array.from({ length: 250 }, (_, i) => `PACZKA${i}`);
  await marketDataService.fetchRealQuotes(wszystkie, true);
  assert.ok(zapytania.length >= 3, `liczba zapytan: ${zapytania.length}`);
  assert.ok(zapytania.every((tickery) => tickery.length <= 100 && tickery.length > 0));
  const razem = new Set(zapytania.flat());
  for (const ticker of wszystkie) assert.ok(razem.has(ticker), `brak ${ticker}`);
  assert.equal(zapytania.flat().length, razem.size, 'kazdy ticker dokladnie raz');
  assert.equal(marketDataService.getQuotes().PACZKA249.price, 1, 'wyniki wszystkich paczek zlaczone');
});

test('lastFetchedAt nie rusza sie, gdy serwer odda wylacznie ceny z zapasu', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => odpowiedz({ STALE_ONE: { ticker: 'STALE_ONE', price: 10, currency: 'USD' } }));
  await marketDataService.fetchRealQuotes(['STALE_ONE'], true);
  const swiezyCzas = marketDataService.getLastFetchedAt();
  assert.ok(swiezyCzas, 'swieza cena ustawia czas pobrania');

  await new Promise((resolve) => setTimeout(resolve, 5));
  t.mock.method(globalThis, 'fetch', async () => odpowiedz({
    STALE_ONE: { ticker: 'STALE_ONE', price: 10, currency: 'USD', stale: true, fetchedAt: swiezyCzas },
  }));
  await marketDataService.fetchRealQuotes(['STALE_ONE'], true);
  assert.equal(marketDataService.getLastFetchedAt(), swiezyCzas);

  await new Promise((resolve) => setTimeout(resolve, 5));
  t.mock.method(globalThis, 'fetch', async () => odpowiedz({
    STALE_ONE: { ticker: 'STALE_ONE', price: 10, currency: 'USD', stale: true },
    STALE_TWO: { ticker: 'STALE_TWO', price: 20, currency: 'USD' },
  }));
  await marketDataService.fetchRealQuotes(['STALE_TWO'], true);
  assert.notEqual(marketDataService.getLastFetchedAt(), swiezyCzas, 'przynajmniej jedna swieza cena odswieza czas');
});
