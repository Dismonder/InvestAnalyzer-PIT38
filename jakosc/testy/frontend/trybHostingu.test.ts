import test from 'node:test';
import assert from 'node:assert/strict';
import { czyTrybHostowany, zapiszTrybZeZdrowia } from '../../../aplikacje/web/src/shared/trybHostingu.ts';

function magazyn(poczatkowe: Record<string, string> = {}) {
  const dane = new Map(Object.entries(poczatkowe));
  return {
    getItem: (k: string) => dane.get(k) ?? null,
    setItem: (k: string, v: string) => { dane.set(k, v); },
    removeItem: (k: string) => { dane.delete(k); },
    dane,
  };
}

test('adres workers.dev to tryb hostowany; localhost i tauri nie', () => {
  assert.equal(czyTrybHostowany({ location: { hostname: 'investanalyzer-app.dismonder.workers.dev' }, sessionStorage: magazyn() }), true);
  assert.equal(czyTrybHostowany({ location: { hostname: 'localhost' }, sessionStorage: magazyn() }), false);
  assert.equal(czyTrybHostowany({ location: { hostname: 'tauri.localhost' }, sessionStorage: magazyn() }), false);
});

test('wlasna domena: tryb z zapamietanej sondy /api/health', () => {
  const m = magazyn();
  assert.equal(zapiszTrybZeZdrowia({ ok: true, tryb: 'hosting' }, m), true);
  assert.equal(czyTrybHostowany({ location: { hostname: 'portfel.example.pl' }, sessionStorage: m }), true);
  assert.equal(zapiszTrybZeZdrowia({ ok: true, status: 'ok' }, m), false, 'serwer Node nie podaje trybu');
  assert.equal(czyTrybHostowany({ location: { hostname: 'portfel.example.pl' }, sessionStorage: m }), false);
});

test('brak sessionStorage albo wyjatek z niego nie wywraca rozpoznania', () => {
  assert.equal(czyTrybHostowany({ location: { hostname: 'x.example' } }), false);
  const wybuchajacy = { getItem: () => { throw new Error('zablokowany'); } };
  assert.equal(czyTrybHostowany({ location: { hostname: 'x.example' }, sessionStorage: wybuchajacy }), false);
  assert.equal(zapiszTrybZeZdrowia({ tryb: 'hosting' }, { setItem: () => { throw new Error('pelny'); }, removeItem: () => {} }), true);
});
