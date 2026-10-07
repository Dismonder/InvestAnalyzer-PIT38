import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ZACHOWANE_KLUCZE,
  usunKluczePozaZachowanymi,
  wyczyscDaneAplikacji,
} from '../../../aplikacje/web/src/portfel/services/czyszczenieDanych.ts';

function magazyn(poczatkowe: Record<string, string>) {
  const dane = new Map(Object.entries(poczatkowe));
  return {
    dane,
    get length() { return dane.size; },
    key: (i: number) => [...dane.keys()][i] ?? null,
    removeItem: (k: string) => { dane.delete(k); },
  };
}

test('czyszczenie usuwa wszystkie dane aplikacji, zostawia tylko motyw i jezyk', async () => {
  const local = magazyn({
    pit38_accounts: '[{"apiKey":"sekret"}]', pit38_transactions: '[]', pit38_alerts: '[]', pit38_broker_orders: '[]',
    pit38_taxpayer_pesel: '00000000000', pit38_2fa_credentials: '{}', 'taxYearClosure:2025': '{}', 'defenseVault:v1': '{}',
    cryptoCostsCarriedForward: '12', 'investAnalyzer:lastEngineRunMs': '5', pit38_notifications: '[]',
    pit38_theme: 'dark', pit38_lang: 'pl', theme: 'light', 'uiLanguage:v1': 'pl',
  });
  const sesja = magazyn({ ia_tryb_hostingu: 'hosting', ia_przeladowanie_po_bledzie_modulu: '1' });
  let indexedDbWyczyszczone = 0;
  const wynik = await wyczyscDaneAplikacji({ localStorage: local, sessionStorage: sesja, indexedDb: async () => { indexedDbWyczyszczone++; } });

  assert.deepEqual([...local.dane.keys()].sort(), ['pit38_lang', 'pit38_theme', 'theme', 'uiLanguage:v1']);
  assert.deepEqual(sesja.dane.size, 0, 'sessionStorage czyszczony w calosci');
  assert.equal(indexedDbWyczyszczone, 1);
  assert.equal(wynik.indexedDb, 'wyczyszczono');
  assert.ok(wynik.usunieteKlucze.includes('pit38_accounts') && wynik.usunieteKlucze.includes('pit38_taxpayer_pesel'));
  assert.deepEqual(wynik.usunieteKluczeSesji, ['ia_przeladowanie_po_bledzie_modulu', 'ia_tryb_hostingu']);
  for (const klucz of ZACHOWANE_KLUCZE) assert.ok(!wynik.usunieteKlucze.includes(klucz));
});

test('usuwanie nie gubi kluczy przy przesuwajacych sie indeksach i znosi zablokowany magazyn', () => {
  const local = magazyn(Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`pit38_k${i}`, 'x'])));
  const usuniete = usunKluczePozaZachowanymi(local);
  assert.equal(usuniete.length, 25);
  assert.equal(local.dane.size, 0);

  const zablokowany = { length: 3, key: () => { throw new Error('SecurityError'); }, removeItem: () => {} };
  assert.deepEqual(usunKluczePozaZachowanymi(zablokowany), []);
  assert.deepEqual(usunKluczePozaZachowanymi(undefined), []);
});

test('awaria IndexedDB nie przerywa czyszczenia reszty; brak IndexedDB jest pomijany', async () => {
  const local = magazyn({ pit38_accounts: '[]' });
  const zBledem = await wyczyscDaneAplikacji({ localStorage: local, sessionStorage: magazyn({}), indexedDb: async () => { throw new Error('zablokowana'); } });
  assert.equal(zBledem.indexedDb, 'blad');
  assert.equal(local.dane.size, 0, 'localStorage i tak wyczyszczony');
  const bez = await wyczyscDaneAplikacji({ localStorage: magazyn({}), sessionStorage: magazyn({}) });
  assert.equal(bez.indexedDb, 'pominieto');
});
