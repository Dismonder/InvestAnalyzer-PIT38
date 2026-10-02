import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import localforage from 'localforage';

import { ErrorBoundary } from '../../../aplikacje/web/src/invest_analyzer/components/ErrorBoundary.tsx';
import { StorageService } from '../../../aplikacje/web/src/invest_analyzer/services/storage.ts';
import { runtimeApi } from '../../../aplikacje/web/src/invest_analyzer/services/runtimeApi.ts';
import {
  trescZgodyBezKopii,
  usunUszkodzoneWpisyDoKwarantanny,
  wykonajOdzyskiwanieZKopia,
} from '../../../aplikacje/web/src/invest_analyzer/services/odzyskiwanieAwaryjne.ts';

function utworzMagazyn(start: Record<string, string>) {
  const dane = new Map(Object.entries(start));
  return {
    dane,
    magazyn: {
      get length() { return dane.size; },
      key: (index: number) => [...dane.keys()][index] ?? null,
      getItem: (key: string) => dane.get(key) ?? null,
      setItem: (key: string, value: string) => { dane.set(key, value); },
      removeItem: (key: string) => { dane.delete(key); },
      clear: () => { dane.clear(); },
    },
  };
}

test('błąd zapisu kopii nie zmienia danych ani nie przeładowuje strony', async () => {
  const stan = { rekord: 'oryginalny' };
  let reloads = 0;

  await assert.rejects(wykonajOdzyskiwanieZKopia({
    collect: async () => ({ local: { 'investAnalyzer:record': JSON.stringify(stan) } }),
    write: async () => { throw new Error('backup unavailable'); },
    apply: () => { stan.rekord = 'usunięty'; },
    reload: () => { reloads += 1; },
  }), /backup unavailable/);
  assert.equal(stan.rekord, 'oryginalny');
  assert.equal(reloads, 0);
});

test('niepełna migawka zachowuje dane i blokuje odzyskiwanie', async () => {
  let applyCalls = 0;
  let reloads = 0;
  await assert.rejects(wykonajOdzyskiwanieZKopia({
    collect: async () => ({ skippedKeys: ['transactionOverrides'] }),
    write: async () => ({ id: 'backup-1' }),
    apply: () => { applyCalls += 1; },
    reload: () => { reloads += 1; },
  }), /niepełna.*transactionOverrides/);
  assert.equal(applyCalls, 0);
  assert.equal(reloads, 0);
});

test('ErrorBoundary.handleReset kopiuje raz, blokuje równoległy klik i zatrzymuje się przy błędzie clearAll', async () => {
  const rawAccounts = '{"name":"account with secret"';
  const local = utworzMagazyn({
    pit38_transactions: '[{"id":"keep"}]',
    pit38_accounts: rawAccounts,
    'investAnalyzer:recovery-quarantine:old': JSON.stringify({ entries: [{ key: 'old', value: 'old raw' }] }),
  });
  const session = utworzMagazyn({ 'ia_session:value': 'keep' });
  const reloads: number[] = [];
  const win = {
    localStorage: local.magazyn,
    sessionStorage: session.magazyn,
    location: { reload: () => { reloads.push(1); } },
  };
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originals = [
    [localforage, 'getItem'],
    [runtimeApi, 'writeBackupSnapshot'],
    [StorageService, 'clearAll'],
  ] as const;
  const descriptors = originals.map(([object, key]) => Object.getOwnPropertyDescriptor(object, key));
  const originalConsoleError = Object.getOwnPropertyDescriptor(console, 'error');
  let kopie = 0;
  let czyszczenia = 0;
  const wyslaneMigawki: Array<{ local: Record<string, string> }> = [];
  const boundary = new ErrorBoundary({ children: null });

  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
    Object.defineProperty(localforage, 'getItem', { configurable: true, value: async () => null });
    Object.defineProperty(runtimeApi, 'writeBackupSnapshot', {
      configurable: true,
      value: async (snapshot: unknown) => {
        kopie += 1;
        wyslaneMigawki.push(snapshot as { local: Record<string, string> });
        return { id: `backup-${kopie}` };
      },
    });
    Object.defineProperty(StorageService, 'clearAll', {
      configurable: true,
      value: async () => {
        czyszczenia += 1;
        if (czyszczenia === 1) throw new Error('clearAll failed');
      },
    });
    Object.defineProperty(console, 'error', { configurable: true, value: () => undefined });

    boundary.state = { hasError: true, error: new Error('widget failure'), recoveryBusy: false, recoveryMessage: null };
    boundary.setState = ((update: React.SetStateAction<typeof boundary.state>) => {
      const next = typeof update === 'function' ? update(boundary.state) : update;
      boundary.state = { ...boundary.state, ...next };
    }) as typeof boundary.setState;

    await Promise.all([boundary.handleReset(), boundary.handleReset()]);
    assert.equal(kopie, 1);
    assert.equal(czyszczenia, 1);
    assert.equal(local.dane.get('pit38_transactions'), '[{"id":"keep"}]');
    assert.equal(local.dane.get('pit38_accounts'), rawAccounts);
    assert.equal(local.dane.get('investAnalyzer:recovery-quarantine:old') !== undefined, true);
    const firstQuarantine = [...local.dane.entries()].find(([key]) => key.startsWith('investAnalyzer:recovery-quarantine:') && key !== 'investAnalyzer:recovery-quarantine:old');
    assert.equal(JSON.parse(firstQuarantine![1]).entries[0].value, rawAccounts);
    assert.equal(Object.hasOwn(wyslaneMigawki[0].local, 'pit38_accounts'), false);
    assert.equal(JSON.stringify(wyslaneMigawki[0]).includes(rawAccounts), false);
    assert.equal(session.dane.get('ia_session:value'), 'keep');
    assert.equal(reloads.length, 0);
    assert.equal(
      boundary.state.recoveryMessage,
      'Odzyskiwanie nie zostało dokończone (clearAll failed). Kopia bezpieczeństwa sprzed operacji: backup-1.',
    );
    assert.equal(boundary.state.recoveryBusy, false);

    await boundary.handleReset();
    assert.equal(kopie, 2);
    assert.equal(czyszczenia, 2);
    assert.equal(local.dane.has('pit38_accounts'), false);
    assert.equal(local.dane.has('pit38_transactions'), false);
    assert.equal(local.dane.has('investAnalyzer:recovery-quarantine:old'), true);
    const kwarantanny = [...local.dane.entries()].filter(([key]) => key.startsWith('investAnalyzer:recovery-quarantine:'));
    assert.equal(kwarantanny.length, 3);
    assert.ok(kwarantanny.some(([, value]) => JSON.parse(value).entries?.some((entry: { value: string }) => entry.value === rawAccounts)));
    assert.equal(Object.hasOwn(wyslaneMigawki[1].local, 'pit38_accounts'), false);
    assert.equal(JSON.stringify(wyslaneMigawki[1]).includes(rawAccounts), false);
    assert.equal(session.dane.size, 0);
    assert.equal(reloads.length, 1);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else delete (globalThis as typeof globalThis & { window?: unknown }).window;
    originals.forEach(([object, key], index) => {
      if (descriptors[index]) Object.defineProperty(object, key, descriptors[index]!);
      else delete (object as Record<string, unknown>)[key];
    });
    if (originalConsoleError) Object.defineProperty(console, 'error', originalConsoleError);
    else delete (console as Console & { error?: typeof console.error }).error;
  }
});

test('po udanej kopii stosuje odzyskiwanie i przeładowuje dopiero po nim', async () => {
  const order: string[] = [];
  const id = await wykonajOdzyskiwanieZKopia({
    collect: async () => ({ local: { 'investAnalyzer:state': 'raw' } }),
    write: async (snapshot) => {
      assert.equal(snapshot.local['investAnalyzer:state'], 'raw');
      order.push('backup');
      return { id: 'backup-3' };
    },
    apply: () => { order.push('clear'); },
    reload: () => { order.push('reload'); },
  });
  assert.equal(id, 'backup-3');
  assert.deepEqual(order, ['backup', 'clear', 'reload']);
});

test('komunikat o nieudanej kopii mówi wprost, że nic nie usunięto, i zachowuje szczegół błędu', async () => {
  const bezSkutkow = { apply: () => { throw new Error('apply nie może ruszyć'); }, reload: () => undefined };
  // Surowy błąd przeglądarki ("Failed to fetch", "Unexpected end of JSON input") nie mówi, co się stało z danymi.
  await assert.rejects(wykonajOdzyskiwanieZKopia({
    collect: async () => ({ local: {} }),
    write: async () => { throw new TypeError('Failed to fetch'); },
    ...bezSkutkow,
  }), /Nie udało się zapisać kopii bezpieczeństwa — odzyskiwanie przerwane, nic nie usunięto\. \(Failed to fetch\)/);
  await assert.rejects(wykonajOdzyskiwanieZKopia({
    collect: async () => { throw new Error('odczyt magazynu'); },
    write: async () => ({ id: 'backup-0' }),
    ...bezSkutkow,
  }), /Nie udało się przygotować kopii bezpieczeństwa — odzyskiwanie przerwane, nic nie usunięto\. \(odczyt magazynu\)/);
});

test('błąd po zapisaniu kopii podaje jej identyfikator i nie twierdzi, że nic nie zmieniono', async () => {
  let reloads = 0;
  await assert.rejects(wykonajOdzyskiwanieZKopia({
    collect: async () => ({ local: {} }),
    write: async () => ({ id: 'backup-9' }),
    apply: () => { throw new Error('magazyn odmówił'); },
    reload: () => { reloads += 1; },
  }), (blad: Error) => {
    assert.match(blad.message, /Odzyskiwanie nie zostało dokończone \(magazyn odmówił\)/);
    assert.match(blad.message, /backup-9/);
    assert.doesNotMatch(blad.message, /nic nie usunięto/);
    return true;
  });
  assert.equal(reloads, 0);
});

test('bez kopii tylko za jawną zgodą: odmowa zachowuje dane, zgoda idzie dalej i zwraca brak kopii', async () => {
  const pytania: Array<{ rodzaj: string }> = [];
  let applyCalls = 0;
  let reloads = 0;
  const zaleznosci = (zgoda: boolean) => ({
    collect: async () => ({ local: { 'investAnalyzer:state': 'raw' } }),
    write: async () => { throw new TypeError('Failed to fetch'); },
    apply: () => { applyCalls += 1; },
    reload: () => { reloads += 1; },
    potwierdzBezKopii: (powod: { rodzaj: string }) => { pytania.push(powod); return zgoda; },
  });
  await assert.rejects(wykonajOdzyskiwanieZKopia(zaleznosci(false)), /nic nie usunięto/);
  assert.equal(applyCalls, 0);
  assert.equal(reloads, 0);
  assert.deepEqual(pytania, [{ rodzaj: 'blad', szczegol: 'Failed to fetch' }]);

  assert.equal(await wykonajOdzyskiwanieZKopia(zaleznosci(true)), null);
  assert.equal(applyCalls, 1);
  assert.equal(reloads, 1);
});

test('niepełna kopia za zgodą: kopia i tak zostaje zapisana, a operacja idzie dalej', async () => {
  let writeCalls = 0;
  const order: string[] = [];
  const id = await wykonajOdzyskiwanieZKopia({
    collect: async () => ({ local: {}, skippedKeys: ['transactionOverrides'] }),
    write: async () => { writeCalls += 1; return { id: 'backup-niepelna' }; },
    apply: () => { order.push('apply'); },
    reload: () => { order.push('reload'); },
    potwierdzBezKopii: (powod) => powod.rodzaj === 'niepelna' && powod.pominiete.includes('transactionOverrides'),
  });
  assert.equal(id, 'backup-niepelna');
  assert.equal(writeCalls, 1);
  assert.deepEqual(order, ['apply', 'reload']);
});

test('treść pytania o zgodę nazywa skutek dla danej operacji', () => {
  const czyszczenie = trescZgodyBezKopii('czyszczenie', { rodzaj: 'blad', szczegol: 'Failed to fetch' });
  assert.match(czyszczenie, /Nie udało się zapisać kopii bezpieczeństwa\. \(Failed to fetch\)/);
  assert.match(czyszczenie, /NIE BĘDZIE ich jak odzyskać/);
  assert.match(czyszczenie, /wyczyścić dane przeglądarki BEZ kopii\?/);
  const kwarantanna = trescZgodyBezKopii('kwarantanna', { rodzaj: 'niepelna', pominiete: ['transactionOverrides'] });
  assert.match(kwarantanna, /niepełna.*transactionOverrides/);
  assert.match(kwarantanna, /kwarantanny/);
  assert.doesNotMatch(kwarantanna, /NIE BĘDZIE ich jak odzyskać/);
});

test('uszkodzony wpis pit38_accounts trafia do lokalnej kwarantanny przed usunięciem', () => {
  const raw = '{"account":"sekret-nie-wysyłaj"';
  const { dane, magazyn } = utworzMagazyn({
    pit38_accounts: raw,
    'inna-aplikacja:profil': '{uszkodzone',
    'investAnalyzer:recovery-quarantine:7': 'poprzednia kopia',
  });

  assert.deepEqual(usunUszkodzoneWpisyDoKwarantanny(magazyn, [], [], 7), ['pit38_accounts']);
  assert.equal(dane.has('pit38_accounts'), false);
  assert.equal(dane.get('inna-aplikacja:profil'), '{uszkodzone');
  const quarantine = JSON.parse(dane.get('investAnalyzer:recovery-quarantine:7:1')!);
  assert.equal(quarantine.entries[0].key, 'pit38_accounts');
  assert.equal(quarantine.entries[0].value, raw);
  assert.equal(dane.get('investAnalyzer:recovery-quarantine:7'), 'poprzednia kopia');
});

test('błąd zapisu lokalnej kwarantanny nie usuwa surowego wpisu', () => {
  const { dane, magazyn } = utworzMagazyn({ pit38_accounts: '{niepoprawny' });
  const bezMiejsca = { ...magazyn, setItem: () => { throw new Error('brak miejsca'); } };
  assert.throws(() => usunUszkodzoneWpisyDoKwarantanny(bezMiejsca, [], []), /brak miejsca/);
  assert.equal(dane.get('pit38_accounts'), '{niepoprawny');
  assert.equal([...dane.keys()].some((key) => key.startsWith('investAnalyzer:recovery-quarantine:')), false);
});
