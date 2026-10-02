import test from 'node:test';
import assert from 'node:assert/strict';
import { marketStatusService } from '../../../aplikacje/web/src/portfel/services/marketStatusService.ts';

test('nieudane odświeżenie zachowuje czas odczytu i oznacza pamięć jako nieaktualną', async (t) => {
  const zapis = new Map<string, string>();
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  const poprzedniMagazyn = globalThis.localStorage;
  t.after(() => { globalThis.localStorage = poprzedniMagazyn; });
  globalThis.localStorage = {
    getItem: (key: string) => zapis.get(key) ?? null,
    setItem: (key: string, value: string) => { zapis.set(key, value); },
  } as Storage;
  const odczytanoO = '2026-09-27T08:30:00.000Z';
  marketStatusService.saveToCache({
    success: true, serverTime: odczytanoO, odczytanoO,
    markets: [{ n: 'GPW', n2: 'WSE', s: 'OPEN' }],
  });
  const wynik = await marketStatusService.fetchMarketStatuses();
  assert.equal(wynik.nieaktualne, true);
  assert.equal(wynik.odczytanoO, odczytanoO);
  assert.equal(wynik.markets[0].s, 'OPEN');
});

test('udany odczyt zapisuje nowy czas i usuwa znacznik nieaktualności', async (t) => {
  const zapis = new Map<string, string>();
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    success: true, serverTime: '2026-09-27T09:00:00.000Z', markets: [{ n: 'GPW', n2: 'WSE', s: 'CLOSE' }],
  })));
  const poprzedniMagazyn = globalThis.localStorage;
  t.after(() => { globalThis.localStorage = poprzedniMagazyn; });
  globalThis.localStorage = {
    getItem: (key: string) => zapis.get(key) ?? null,
    setItem: (key: string, value: string) => { zapis.set(key, value); },
  } as Storage;
  const wynik = await marketStatusService.fetchMarketStatuses();
  assert.equal(wynik.nieaktualne, false);
  assert.ok(Number.isFinite(Date.parse(wynik.odczytanoO ?? '')));
  assert.equal(marketStatusService.getCachedStatus().nieaktualne, true);
  assert.equal(marketStatusService.getCachedStatus().odczytanoO, wynik.odczytanoO);
});
