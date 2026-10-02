import { tauriRuntimeApi } from './runtimeApi.tauri';
import { webRuntimeApi } from './runtimeApi.web';
import { uniewaznijWynikiSilnika } from './ostatniWynikSilnika';
import type { RuntimeApi, RuntimeKind } from './runtimeApi.types';

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export function detectRuntime(): RuntimeKind {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    return 'tauri';
  }
  return 'web';
}

/**
 * Zmiana magazynu plikow zmienia wejscie silnika, choc zadanie - i jego klucz -
 * wyglada tak samo: zawartosc plikow nie wchodzi do klucza. Wynik z pamieci
 * karty trzeba wtedy od razu uniewaznic, a widoki oznaczyc jako nieaktualne;
 * inaczej portfel oddawal stary wynik jako biezacy (po imporcie pliku albo
 * pobraniu kompletu Freedom24 eksport byl przez chwile odblokowany).
 */
function poZmianieMagazynu(): void {
  uniewaznijWynikiSilnika();
  globalThis.window?.dispatchEvent(new Event('tax-input-changed'));
}

export function zObserwacjaMagazynu(api: RuntimeApi, poZmianie: () => void = poZmianieMagazynu): RuntimeApi {
  return {
    ...api,
    async importFilesToStorage(files) {
      try {
        return await api.importFilesToStorage.call(this, files);
      } finally {
        poZmianie();
      }
    },
    async clearAppData() {
      try {
        return await api.clearAppData.call(this);
      } finally {
        poZmianie();
      }
    },
    // Migracja magazynu z dawnego katalogu (desktop) tez zmienia pliki wejscia.
    async copyLegacyStorageToAppData() {
      try {
        return await api.copyLegacyStorageToAppData.call(this);
      } finally {
        poZmianie();
      }
    },
  };
}

export function getRuntimeApi(): RuntimeApi {
  return zObserwacjaMagazynu(detectRuntime() === 'tauri' ? tauriRuntimeApi : webRuntimeApi);
}

export const runtimeApi = getRuntimeApi();

export type {
  AppPaths,
  DiagnosticsExportOptions,
  DiagnosticsExportResult,
  ImportResult,
  LegacyStorageStatus,
  OllamaConfig,
  OllamaEnsureResult,
  OllamaEnsureOptions,
  OllamaModelInfo,
  OllamaRuntimeStatus,
  OllamaStatus,
  RuntimeApi,
  RuntimeImportFile,
  RuntimeInfo,
  RuntimeKind,
  StorageRecognitionOptions,
  StorageFile,
  StorageFileReadResult,
  StorageMigrationResult,
  StorageMigrationStatus,
  TaxEngineJobStatus,
} from './runtimeApi.types';
