/**
 * Przycisk "Zapisz kopie" wysyla powod 'Kopia na zadanie'. Kazdy niepusty powod
 * uchodzil za kopie automatyczna (limit 10), wiec kopie reczne byly rotowane
 * razem z kopiami "Stan sprzed ...". Rodzaj wynika teraz z jawnego pola purpose.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { collectBackupSnapshot } from '../../../aplikacje/web/src/invest_analyzer/services/backup.ts';
import { BACKUP_LIMIT_AUTOMATYCZNYCH, listBackupSnapshots, writeBackupSnapshot } from '../../../aplikacje/web/src/server/backupStore.ts';

async function zPamiecia<T>(uzyj: (ustaw: (klucz: string, wartosc: string) => void) => Promise<T>): Promise<T> {
  const poprzedni = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const magazyn = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (k: string) => magazyn.get(k) ?? null,
    setItem: (k: string, v: string) => void magazyn.set(k, v),
    removeItem: (k: string) => void magazyn.delete(k),
    clear: () => magazyn.clear(),
    key: (i: number) => [...magazyn.keys()][i] ?? null,
    get length() { return magazyn.size; },
  } });
  try {
    return await uzyj((k, v) => void magazyn.set(k, v));
  } finally {
    if (poprzedni) Object.defineProperty(globalThis, 'localStorage', poprzedni); else delete (globalThis as any).localStorage;
  }
}

test('kopie z przycisku (reczne) nie sa rotowane limitem kopii automatycznych', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-rodzaj-'));
  await zPamiecia(async (ustaw) => {
    for (let i = 0; i < BACKUP_LIMIT_AUTOMATYCZNYCH + 5; i += 1) {
      ustaw('priorYearLossEntries', `[{"taxYear":${2000 + i}}]`);
      // Sciezka przycisku "Zapisz kopie" (BackupPanel.createBackup).
      const snapshot = await collectBackupSnapshot('Kopia na żądanie');
      writeBackupSnapshot(root, snapshot, new Date(Date.UTC(2026, 0, 1, 0, 0, i)));
    }
    for (let i = 0; i < BACKUP_LIMIT_AUTOMATYCZNYCH + 3; i += 1) {
      ustaw('priorYearLossEntries', `[{"taxYear":${3000 + i}}]`);
      // Sciezka przywracania (przywrocZKopiaBezpieczenstwa) i czyszczenia danych.
      const snapshot = await collectBackupSnapshot(i % 2 ? 'Stan sprzed przywrócenia kopii' : 'Kopia przed wyczyszczeniem danych');
      writeBackupSnapshot(root, snapshot, new Date(Date.UTC(2026, 1, 1, 0, 0, i)));
    }
  });
  const kopie = listBackupSnapshots(root);
  const automatyczne = kopie.filter((kopia) => kopia.id.includes('-auto'));
  assert.equal(automatyczne.length, BACKUP_LIMIT_AUTOMATYCZNYCH, 'kopie zabezpieczajace rotowane osobnym limitem');
  assert.equal(kopie.length - automatyczne.length, BACKUP_LIMIT_AUTOMATYCZNYCH + 5, 'wszystkie kopie reczne zostaja');
});

test('kopia bez pola purpose (starszy format) jest reczna', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-rodzaj-stary-'));
  for (let i = 0; i < BACKUP_LIMIT_AUTOMATYCZNYCH + 2; i += 1) {
    writeBackupSnapshot(root, { createdAt: `k${i}`, reason: 'Kopia na żądanie', n: i }, new Date(Date.UTC(2026, 0, 1, 0, 0, i)));
  }
  assert.equal(listBackupSnapshots(root).length, BACKUP_LIMIT_AUTOMATYCZNYCH + 2);
});
