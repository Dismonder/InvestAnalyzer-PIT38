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

function odpowiedz(ticker: string, price: number): Response {
  return new Response(JSON.stringify({ success: true, quotes: { [ticker]: { ticker, price, currency: 'USD' } } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('starsze odswiezenie nie nadpisuje nowszego ani nie konczy jego pobierania', async (t) => {
  const odpowiedzi: Array<(response: Response) => void> = [];
  t.mock.method(globalThis, 'fetch', () => new Promise<Response>((resolve) => { odpowiedzi.push(resolve); }));

  const starsze = marketDataService.fetchRealQuotes(['TEST_RACE'], true);
  const nowsze = marketDataService.fetchRealQuotes(['TEST_RACE'], true);
  odpowiedzi[0](odpowiedz('TEST_RACE', 100));
  await starsze;
  assert.equal(marketDataService.getIsFetching(), true);
  assert.equal(marketDataService.getQuotes().TEST_RACE, undefined);
  odpowiedzi[1](odpowiedz('TEST_RACE', 200));
  await nowsze;
  assert.equal(marketDataService.getQuotes().TEST_RACE.price, 200);
  assert.equal(marketDataService.getIsFetching(), false);
});

test('spozniona odpowiedz nie nadpisuje nowej, a blad zdejmuje stan pobierania', async (t) => {
  const odpowiedzi: Array<(response: Response) => void> = [];
  t.mock.method(globalThis, 'fetch', () => new Promise<Response>((resolve) => { odpowiedzi.push(resolve); }));

  const starsze = marketDataService.fetchRealQuotes(['TEST_LATE'], true);
  const nowsze = marketDataService.fetchRealQuotes(['TEST_LATE'], true);
  odpowiedzi[1](odpowiedz('TEST_LATE', 300));
  await nowsze;
  odpowiedzi[0](odpowiedz('TEST_LATE', 100));
  await starsze;
  assert.equal(marketDataService.getQuotes().TEST_LATE.price, 300);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  await marketDataService.fetchRealQuotes(['TEST_LATE'], true);
  assert.equal(marketDataService.getIsFetching(), false);
});

test('niepelne notowanie z transportu jest uzupelniane bezpiecznymi wartosciami, a bez ceny odrzucane', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    success: true,
    quotes: {
      TEST_PELNE: { ticker: 'TEST_PELNE', price: 10, currency: 'USD' },
      TEST_BEZ_CENY: { ticker: 'TEST_BEZ_CENY', currency: 'USD' },
      TEST_ZLA_CENA: { ticker: 'TEST_ZLA_CENA', price: 'abc', currency: 'USD' },
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

  await marketDataService.fetchRealQuotes(['TEST_PELNE', 'TEST_BEZ_CENY', 'TEST_ZLA_CENA'], true);

  const q = marketDataService.getQuotes();
  assert.equal(q.TEST_BEZ_CENY, undefined);
  assert.equal(q.TEST_ZLA_CENA, undefined);
  const pelne = q.TEST_PELNE;
  assert.equal(pelne.price, 10);
  // Widoki wolaja .toFixed na tych polach: brak ma byc null/pusta tablica, nie undefined.
  assert.equal(pelne.change24h, null);
  assert.equal(pelne.changePercent24h, null);
  assert.deepEqual(pelne.sparkline, []);
  assert.equal(pelne.name, 'TEST_PELNE');
});
