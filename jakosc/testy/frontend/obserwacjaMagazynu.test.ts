/**
 * Zmiana magazynu plikow (import, pobranie kompletu Freedom24, czyszczenie) musi
 * od razu uniewaznic wynik silnika - klucz zadania nie obejmuje zawartosci plikow,
 * wiec bez tego portfel oddawal stary wynik jako biezacy.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { zObserwacjaMagazynu } from '../../../aplikacje/web/src/invest_analyzer/services/runtimeApi.ts';
import type { RuntimeApi } from '../../../aplikacje/web/src/invest_analyzer/services/runtimeApi.types.ts';

function atrapa(bladImportu = false) {
  const api = {
    wywolania: [] as string[],
    async importFilesToStorage() {
      this.wywolania.push('import');
      if (bladImportu) throw new Error('dysk pełny');
      return { imported: [], skipped: [], failed: [], warnings: [] };
    },
    async clearAppData() {
      this.wywolania.push('clear');
      return { removedFiles: 0, removedDirs: 0, clearedRoots: [], warnings: [] };
    },
    async copyLegacyStorageToAppData() {
      this.wywolania.push('migracja');
      return { copied: 0 };
    },
    async listStorageFiles() {
      // Metody wolajace inne metody przez `this` musza dzialac po opakowaniu.
      this.wywolania.push('list');
      return [];
    },
  };
  return api as unknown as RuntimeApi & { wywolania: string[] };
}

test('import i czyszczenie magazynu uniewazniaja wynik, także gdy import się nie uda', async () => {
  let zmiany = 0;
  const api = zObserwacjaMagazynu(atrapa(), () => { zmiany += 1; });
  await api.importFilesToStorage([]);
  assert.equal(zmiany, 1);
  await api.clearAppData();
  assert.equal(zmiany, 2);
  await api.copyLegacyStorageToAppData();
  assert.equal(zmiany, 3, 'migracja dawnego magazynu też zmienia wejście');

  const zBledem = zObserwacjaMagazynu(atrapa(true), () => { zmiany += 1; });
  await assert.rejects(() => zBledem.importFilesToStorage([]), /dysk pełny/);
  assert.equal(zmiany, 4, 'częściowy import też mógł zmienić magazyn');
});

test('pozostałe metody działają bez zmian i bez unieważniania', async () => {
  let zmiany = 0;
  const api = zObserwacjaMagazynu(atrapa(), () => { zmiany += 1; });
  await api.listStorageFiles();
  assert.equal(zmiany, 0);
});
