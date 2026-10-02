/**
 * Polecenia Tauri odrzucaja obietnice obiektem DesktopError
 * {errorCode, message, recoverable}, a wywolujacy sprawdzaja `instanceof Error`:
 * uzytkownik widzial "[object Object]" albo ogolnik zamiast przyczyny
 * (np. przy nieudanej kopii bezpieczenstwa).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

let atrapa: Invoke = async () => undefined;
Object.defineProperty(globalThis, 'window', {
  value: { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>) => atrapa(cmd, args) } },
  configurable: true,
  writable: true,
});
const { tauriRuntimeApi } = await import('../../../aplikacje/web/src/invest_analyzer/services/runtimeApi.tauri.ts');

test('blad polecenia Tauri (DesktopError) staje sie Error z komunikatem, kodem i recoverable', async () => {
  atrapa = async () => {
    throw { errorCode: 'BACKUP_WRITE_FAILED', message: 'Nie mozna zapisac kopii: brak miejsca', recoverable: true };
  };
  await assert.rejects(
    () => tauriRuntimeApi.writeBackupSnapshot({}),
    (blad: unknown) => {
      assert.ok(blad instanceof Error);
      assert.equal(blad.message, 'Nie mozna zapisac kopii: brak miejsca');
      assert.equal((blad as Error & { errorCode?: string }).errorCode, 'BACKUP_WRITE_FAILED');
      assert.equal((blad as Error & { recoverable?: boolean }).recoverable, true);
      return true;
    },
  );
});

test('blad Tauri bedacy tekstem lub Error jest zachowany jako Error', async () => {
  atrapa = async () => { throw 'polecenie nieznane'; };
  await assert.rejects(() => tauriRuntimeApi.getRuntimeInfo(), (blad: unknown) => {
    assert.ok(blad instanceof Error);
    assert.equal(blad.message, 'polecenie nieznane');
    return true;
  });
  const oryginal = new Error('zerwane polaczenie IPC');
  atrapa = async () => { throw oryginal; };
  await assert.rejects(() => tauriRuntimeApi.getAppPaths(), (blad: unknown) => blad === oryginal);
});

test('kazda metoda korzysta z wrappera: blad obiektowy nigdy nie wycieka jako obiekt', async () => {
  atrapa = async () => { throw { errorCode: 'X', message: 'przyczyna X', recoverable: false }; };
  const wywolania: Array<() => Promise<unknown>> = [
    () => tauriRuntimeApi.getRuntimeInfo(),
    () => tauriRuntimeApi.getOllamaStatus(),
    () => tauriRuntimeApi.stopOllama(),
    () => tauriRuntimeApi.listStorageFiles(),
    () => tauriRuntimeApi.readStorageFile('a.csv'),
    () => tauriRuntimeApi.importFilesToStorage([]),
    () => tauriRuntimeApi.getTaxEngineJobStatus('j1'),
    () => tauriRuntimeApi.getTaxEngineJobResult('j1'),
    () => tauriRuntimeApi.cancelTaxEngineJob('j1'),
    () => tauriRuntimeApi.listBackupSnapshots(),
    () => tauriRuntimeApi.readBackupSnapshot('b1'),
    () => tauriRuntimeApi.clearAppData(),
    () => tauriRuntimeApi.detectLegacyStorage(),
    () => tauriRuntimeApi.copyLegacyStorageToAppData(),
    () => tauriRuntimeApi.getStorageMigrationStatus(),
  ];
  for (const wywolanie of wywolania) {
    await assert.rejects(wywolanie, (blad: unknown) => blad instanceof Error && blad.message === 'przyczyna X');
  }
});

test('odpowiedz z success:false nadal jest bledem z komunikatem', async () => {
  atrapa = async () => ({ success: false, error: 'silnik niedostepny' });
  await assert.rejects(() => tauriRuntimeApi.getRuntimeInfo(), /silnik niedostepny/);
});
