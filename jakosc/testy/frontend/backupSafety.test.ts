import test from 'node:test';
import assert from 'node:assert/strict';
import { przywrocZKopiaBezpieczenstwa } from '../../../aplikacje/web/src/invest_analyzer/components/BackupPanel.tsx';

test('błąd zapisu kopii bezpieczeństwa przerywa przywracanie bez zmiany danych', async () => {
  let restoreCalls = 0;
  await assert.rejects(
    przywrocZKopiaBezpieczenstwa('wybrana kopia', 'Stan sprzed przywrócenia kopii', {
      collect: async () => 'bieżący stan',
      write: async () => { throw new Error('brak miejsca'); },
      restore: async () => { restoreCalls += 1; return 'przywrócono'; },
    }),
    /Nie udało się zapisać kopii bieżącego stanu — przywracanie przerwane, nic nie zmieniono\. \(brak miejsca\)/,
  );
  assert.equal(restoreCalls, 0);
});

test('niepełna kopia bieżącego stanu (skippedKeys) przerywa przywracanie bez zmiany danych', async () => {
  let restoreCalls = 0;
  let writeCalls = 0;
  await assert.rejects(
    przywrocZKopiaBezpieczenstwa('wybrana kopia', 'Stan sprzed przywrócenia kopii', {
      collect: async () => ({ skippedKeys: ['zbior-1'] }) as never,
      write: async () => { writeCalls += 1; },
      restore: async () => { restoreCalls += 1; return 'przywrócono'; },
    }),
    /niepełna.*zbior-1.*nic nie zmieniono/s,
  );
  assert.equal(restoreCalls, 0);
  assert.equal(writeCalls, 1);
  // Pusta lista pominietych kluczy to kopia pelna.
  assert.equal(await przywrocPelna(), 'przywrócono');
});

async function przywrocPelna() {
  return przywrocZKopiaBezpieczenstwa('kopia', 'powód', {
    collect: async () => ({ skippedKeys: [] }) as never,
    write: async () => undefined,
    restore: async () => 'przywrócono',
  });
}
