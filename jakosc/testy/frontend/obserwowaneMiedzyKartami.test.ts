import test from 'node:test';
import assert from 'node:assert/strict';

const magazyn = new Map<string, string>([['pit38_streaming_active', 'false']]);
const sluchacze: Array<(zdarzenie: { key: string | null }) => void> = [];
globalThis.window = {
  setTimeout: () => 1,
  clearTimeout: () => undefined,
  addEventListener: (nazwa: string, fn: (zdarzenie: { key: string | null }) => void) => { if (nazwa === 'storage') sluchacze.push(fn); },
} as unknown as Window & typeof globalThis;
globalThis.document = { addEventListener: () => undefined } as unknown as Document;
globalThis.localStorage = {
  getItem: (klucz: string) => magazyn.get(klucz) ?? null,
  setItem: (klucz: string, wartosc: string) => { magazyn.set(klucz, wartosc); },
} as Storage;
globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
const { marketDataService } = await import('../../../aplikacje/web/src/portfel/services/marketDataService.ts');

test('zapis obserwowanych scala sie z biezacym magazynem, a nie kasuje zmian z drugiej karty', () => {
  marketDataService.setFavorites(['AAA']);
  // Druga karta dopisala BBB - pierwsza jeszcze o tym nie wie (bez zdarzenia storage).
  magazyn.set('pit38_favorite_tickers', JSON.stringify(['AAA', 'BBB']));
  marketDataService.toggleFavorite('CCC');
  assert.deepEqual(JSON.parse(magazyn.get('pit38_favorite_tickers') ?? '[]'), ['AAA', 'BBB', 'CCC']);
  // Usuniecie jednego tickera tez dotyczy biezacego stanu.
  magazyn.set('pit38_favorite_tickers', JSON.stringify(['AAA', 'BBB', 'CCC', 'DDD']));
  marketDataService.toggleFavorite('AAA');
  assert.deepEqual(JSON.parse(magazyn.get('pit38_favorite_tickers') ?? '[]'), ['BBB', 'CCC', 'DDD']);
});

test('zdarzenie storage odswieza liste w pamieci karty', () => {
  magazyn.set('pit38_favorite_tickers', JSON.stringify(['ZZZ']));
  assert.ok(sluchacze.length > 0);
  for (const sluchacz of sluchacze) sluchacz({ key: 'pit38_favorite_tickers' });
  assert.deepEqual(marketDataService.getFavorites(), ['ZZZ']);
  assert.equal(marketDataService.isFavorite('zzz'), true);
});
