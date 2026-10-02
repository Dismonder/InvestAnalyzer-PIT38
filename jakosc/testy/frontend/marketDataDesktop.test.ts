/**
 * W zbudowanym desktopie (tauri://) nie ma serwera Node. fetchRealQuotes wolal
 * surowe fetch('/api/quotes?...'), ktore trafialo w pliki aplikacji, wiec notowania
 * nie odswiezaly sie wcale. Ma isc przez apiFetch (transport desktopowy).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const zapytania: Array<{ url: string; body: string }> = [];
// Atrapa IPC wtyczki HTTP: fetch -> fetch_send -> fetch_read_body (dane, potem znacznik konca).
const odpowiedzi = new Map<number, { dane: Uint8Array; przeczytane: boolean }>();
let nastepnyRid = 100;
function ipc(cmd: string, args?: Record<string, any>): Promise<unknown> {
  if (cmd === 'plugin:http|fetch') {
    const url = String(args?.clientConfig?.url);
    zapytania.push({ url, body: '' });
    const rid = nastepnyRid++;
    const cena = url.includes('MDDESKTOP') ? 123.45 : 1;
    const tekst = JSON.stringify({ chart: { result: [{ meta: { currency: 'USD', regularMarketPrice: cena } }] } });
    odpowiedzi.set(rid, { dane: new TextEncoder().encode(tekst), przeczytane: false });
    return Promise.resolve(rid);
  }
  if (cmd === 'plugin:http|fetch_send') {
    return Promise.resolve({ status: 200, statusText: 'OK', url: 'https://x', headers: [], rid: args?.rid });
  }
  if (cmd === 'plugin:http|fetch_read_body') {
    const wpis = odpowiedzi.get(Number(args?.rid))!;
    const wynik = new Uint8Array(wpis.dane.length + 1);
    if (!wpis.przeczytane) {
      wynik.set(wpis.dane);
      wpis.przeczytane = true;
    } else {
      wynik[wynik.length - 1] = 1;
      return Promise.resolve(Array.from(new Uint8Array([1])));
    }
    return Promise.resolve(Array.from(wynik));
  }
  return Promise.resolve(undefined);
}

Object.assign(globalThis, {
  isTauri: true,
  window: {
    __TAURI_INTERNALS__: { invoke: ipc },
    setTimeout: () => 1,
    clearTimeout: () => undefined,
    addEventListener: () => undefined,
  },
  document: { addEventListener: () => undefined },
  localStorage: { getItem: (klucz: string) => (klucz === 'pit38_streaming_active' ? 'false' : null) },
});
Object.defineProperty(globalThis, 'location', {
  value: { protocol: 'http:', hostname: 'tauri.localhost' },
  configurable: true,
  writable: true,
});
const { marketDataService } = await import('../../../aplikacje/web/src/portfel/services/marketDataService.ts');

test('desktop: fetchRealQuotes idzie przez transport desktopowy, nie przez surowy fetch /api/quotes', async (t) => {
  const surowe: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    surowe.push(String(url));
    return new Response('<html></html>', { status: 200 });
  });

  await marketDataService.fetchRealQuotes(['MDDESKTOP'], true);

  assert.deepEqual(surowe, [], 'zbudowany desktop nie ma serwera pod /api/quotes');
  assert.equal(marketDataService.getQuotes().MDDESKTOP?.price, 123.45);
  assert.ok(zapytania.some((z) => z.url.includes('finance/chart/MDDESKTOP')), 'notowanie pobrane u dostawcy przez wtyczke HTTP');
});
