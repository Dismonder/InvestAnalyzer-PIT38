import React, { useCallback, useEffect, useRef, useState } from 'react';
import { formatLiczba } from '../../portfel/services/nbpService';
import { odmienLiczebnik } from '../../portfel/services/odmianaLiczebnika';
import { Archive, Download, RotateCcw, Save, Upload } from 'lucide-react';

import { runtimeApi } from '../services/runtimeApi';
import type { StoredBackupFile } from '../services/runtimeApi.types';
import {
  backupFileName,
  collectBackupSnapshot,
  isBackupSnapshot,
  parseBackupFileContent,
  restoreBackupSnapshot,
} from '../services/backup';
import type { BackupSnapshot } from '../services/backup';
import { pominieteKluczeKopii } from '../services/kopiaPrzedCzyszczeniem';

export async function przywrocZKopiaBezpieczenstwa<TSnapshot, TResult>(
  snapshot: TSnapshot,
  powod: string,
  zaleznosci: {
    collect: (powod: string) => Promise<TSnapshot>;
    write: (snapshot: TSnapshot) => Promise<unknown>;
    restore: (snapshot: TSnapshot) => Promise<TResult>;
  },
): Promise<TResult> {
  let pominiete: string[] = [];
  try {
    const kopia = await zaleznosci.collect(powod);
    await zaleznosci.write(kopia);
    pominiete = pominieteKluczeKopii(kopia);
  } catch (blad) {
    const szczegol = blad instanceof Error ? blad.message : String(blad);
    throw new Error(`Nie udało się zapisać kopii bieżącego stanu — przywracanie przerwane, nic nie zmieniono. (${szczegol})`);
  }
  // Kopia bezpieczenstwa bez czesci danych nie zabezpiecza przed nadpisaniem: przywrocenie przerwane.
  if (pominiete.length > 0) {
    throw new Error(`Kopia bieżącego stanu jest niepełna (nie udało się odczytać: ${pominiete.join(', ')}) — przywracanie przerwane, nic nie zmieniono.`);
  }
  return zaleznosci.restore(snapshot);
}

const zaleznosciPrzywracania = {
  collect: collectBackupSnapshot,
  write: (snapshot: BackupSnapshot) => runtimeApi.writeBackupSnapshot(snapshot),
  restore: restoreBackupSnapshot,
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${formatLiczba(bytes / 1024, 1)} kB`;
  return `${formatLiczba(bytes / (1024 * 1024), 1)} MB`;
}

/**
 * Po przywroceniu aplikacja musi wczytac stan od nowa.
 *
 * Wiekszosc decyzji uzytkownika siedzi w localStorage, a ekrany trzymaja ich
 * kopie w stanie Reacta, ustawiona przy pierwszym renderze. `onRestored`
 * odswieza tylko dane z localforage, wiec panel ustawien nadal mial stara liste
 * prowizji - i pierwszy zapis z tego ekranu kasowal wlasnie przywrocone wpisy.
 * Pelne przeladowanie jest jedynym pewnym sposobem, zeby kazdy ekran zobaczyl
 * przywrocony stan.
 */
function reloadAfterRestore(): void {
  globalThis.setTimeout(() => globalThis.location?.reload(), 1200);
}

function formatMoment(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString('pl-PL');
}

function ograniczonyZakres(klucze: string[]): string {
  return klucze.length
    ? ` Ostrzeżenie: starsza kopia ma ograniczony zakres. Pozostawiono bez zmian: ${klucze.join(', ')}.`
    : '';
}

/**
 * Kopie decyzji uzytkownika. Pliki brokera leza na dysku i mozna je wgrac
 * ponownie; recznych korekt, strat z lat ubieglych i rozstrzygniec dowodowych
 * nie da sie odtworzyc z niczego.
 */
export function BackupPanel({ onRestored }: { onRestored?: () => void }) {
  const [backups, setBackups] = useState<StoredBackupFile[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      setBackups(await runtimeApi.listBackupSnapshots());
    } catch (listError) {
      setError(listError instanceof Error ? listError.message : 'Nie udało się odczytać listy kopii.');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createBackup = async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const snapshot = await collectBackupSnapshot('Kopia na żądanie');
      const stored = await runtimeApi.writeBackupSnapshot(snapshot);
      setStatus(`Zapisano kopię ${stored.id} (${formatSize(stored.sizeBytes)}).${snapshot.skippedKeys?.length ? ` Ostrzeżenie: nie udało się odczytać ${snapshot.skippedKeys.length} pozycji (${snapshot.skippedKeys.join(', ')}); kopia jest niepełna.` : ''}`);
      await refresh();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Nie udało się zapisać kopii.');
    } finally {
      setBusy(false);
    }
  };

  const restore = async (id: string) => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const snapshot = await runtimeApi.readBackupSnapshot(id);
      if (!isBackupSnapshot(snapshot)) {
        throw new Error('Plik kopii ma nieznany format.');
      }
      // Przywrocenie nadpisuje biezacy stan, wiec najpierw zapisujemy go jako
      // kopie - inaczej pomylka w wyborze kopii bylaby nieodwracalna.
      const summary = await przywrocZKopiaBezpieczenstwa(snapshot, 'Stan sprzed przywrócenia kopii', zaleznosciPrzywracania);
      setStatus(
        `Przywrócono kopię z ${formatMoment(summary.createdAt)}: ${summary.localKeys} ${odmienLiczebnik(summary.localKeys, 'ustawienie', 'ustawienia', 'ustawień')} i ${summary.offlineKeys} ${odmienLiczebnik(summary.offlineKeys, 'zbiór', 'zbiory', 'zbiorów')} danych.${ograniczonyZakres(summary.untouchedKeys)} Odświeżam aplikację…`,
      );
      onRestored?.();
      reloadAfterRestore();
    } catch (restoreError) {
      setError(restoreError instanceof Error ? restoreError.message : 'Nie udało się przywrócić kopii.');
    } finally {
      setBusy(false);
    }
  };

  const exportPortable = async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const snapshot = await collectBackupSnapshot('Eksport przenośny');
      const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = backupFileName(snapshot.createdAt);
      link.click();
      URL.revokeObjectURL(url);
      setStatus(`Pobrano plik ${backupFileName(snapshot.createdAt)}.${snapshot.skippedKeys?.length ? ` Ostrzeżenie: nie udało się odczytać ${snapshot.skippedKeys.length} pozycji (${snapshot.skippedKeys.join(', ')}); kopia jest niepełna.` : ''}`);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : 'Nie udało się wyeksportować kopii.');
    } finally {
      setBusy(false);
    }
  };

  const importPortable = async (file: File) => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const snapshot = parseBackupFileContent(await file.text());
      const summary = await przywrocZKopiaBezpieczenstwa(snapshot, 'Stan sprzed wczytania kopii', zaleznosciPrzywracania);
      setStatus(
        `Wczytano kopię z ${formatMoment(summary.createdAt)}: ${summary.localKeys} ${odmienLiczebnik(summary.localKeys, 'ustawienie', 'ustawienia', 'ustawień')} i ${summary.offlineKeys} ${odmienLiczebnik(summary.offlineKeys, 'zbiór', 'zbiory', 'zbiorów')} danych.${ograniczonyZakres(summary.untouchedKeys)} Odświeżam aplikację…`,
      );
      onRestored?.();
      reloadAfterRestore();
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : 'Nie udało się wczytać kopii.');
    } finally {
      setBusy(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <h3 className="mb-1 flex items-center gap-2 text-sm font-bold tracking-wider text-gray-800 dark:text-gray-200">
        <Archive className="h-4 w-4 text-blue-500" />
        Kopie Twoich decyzji
      </h3>
      <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
        Pliki brokera leżą na dysku i można je wgrać ponownie. Kopia obejmuje to, czego nie da się odtworzyć:
        ręczne korekty transakcji, straty z lat ubiegłych, prowizje bankowe, rozstrzygnięcia dowodowe i zamknięcia roku.
        {' '}Kopia nie obejmuje plików źródłowych z magazynu ani danych podatnika (PESEL, adres).
      </p>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={createBackup}
          disabled={busy}
          className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-medium text-blue-600 transition-colors hover:bg-blue-100 disabled:opacity-50 dark:border-blue-800 dark:bg-blue-900/30 dark:text-blue-400"
        >
          <Save size={16} /> Zapisz kopię
        </button>
        <button
          type="button"
          onClick={exportPortable}
          disabled={busy}
          className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900/50 dark:text-gray-300"
        >
          <Download size={16} /> Pobierz plik kopii
        </button>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
          className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900/50 dark:text-gray-300"
        >
          <Upload size={16} /> Wczytaj plik kopii
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importPortable(file);
          }}
        />
      </div>

      {status ? <p className="mt-3 text-sm text-emerald-600 dark:text-emerald-400">{status}</p> : null}
      {error ? <p className="mt-3 text-sm text-rose-600 dark:text-rose-400">{error}</p> : null}

      <div className="mt-4">
        {backups.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">Nie ma jeszcze żadnej zapisanej kopii.</p>
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-gray-700">
            {backups.slice(0, 10).map((backup) => (
              <li key={backup.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-gray-800 dark:text-gray-200">
                    {formatMoment(backup.createdAt)}
                  </p>
                  <p className="truncate text-xs text-gray-500 dark:text-gray-400">
                    {backup.id} · {formatSize(backup.sizeBytes)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => restore(backup.id)}
                  disabled={busy}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-700"
                >
                  <RotateCcw size={14} /> Przywróć
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
