import { invoke } from '@tauri-apps/api/core';
import type { TaxEngineResponse } from '../hooks/useTaxEngineRun';
import type {
  AppPaths,
  ClearAppDataResult,
  StoredBackupFile,
  DiagnosticsExportOptions,
  DiagnosticsExportResult,
  ImportResult,
  LegacyStorageStatus,
  OllamaConfig,
  OllamaEnsureResult,
  OllamaModelInfo,
  OllamaRuntimeStatus,
  OllamaStopResult,
  RuntimeApi,
  RuntimeImportFile,
  RuntimeInfo,
  StorageFile,
  StorageFileReadResult,
  StorageMigrationResult,
  StorageMigrationStatus,
  StorageRecognitionOptions,
  TaxEngineJobStatus,
} from './runtimeApi.types';
import { buildTaxEngineRequest, type TaxEngineRequest } from './taxEngineConfig';
import { zastosujNormalizatorAi } from './normalizatorAiZadania';
import { storageFileReadResultToResponse } from './runtimeApi.web';

/** Błąd polecenia desktopu: Error z polami DesktopError (engine/errors.rs). */
export interface BladPoleceniaDesktopu extends Error {
  errorCode?: string;
  recoverable?: boolean;
}

/**
 * Polecenia Tauri odrzucają obietnicę obiektem DesktopError {errorCode, message,
 * recoverable} (albo tekstem), a wywołujący sprawdzają `instanceof Error` - bez
 * tego użytkownik widzi "[object Object]" zamiast przyczyny.
 */
export async function wywolaj<T = unknown>(polecenie: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(polecenie, args);
  } catch (blad: unknown) {
    if (blad instanceof Error) throw blad;
    if (blad && typeof blad === 'object') {
      const opis = blad as { errorCode?: unknown; message?: unknown; recoverable?: unknown };
      const wynik: BladPoleceniaDesktopu = new Error(
        typeof opis.message === 'string' && opis.message ? opis.message : `Polecenie desktopu ${polecenie} nie powiodło się.`,
      );
      if (typeof opis.errorCode === 'string') wynik.errorCode = opis.errorCode;
      if (typeof opis.recoverable === 'boolean') wynik.recoverable = opis.recoverable;
      throw wynik;
    }
    throw new Error(typeof blad === 'string' && blad ? blad : `Polecenie desktopu ${polecenie} nie powiodło się.`);
  }
}

function assertTauriResult<T>(result: T | { error?: string; success?: boolean }): T {
  if (result && typeof result === 'object' && 'success' in result && result.success === false) {
    throw new Error(String((result as { error?: unknown }).error || 'Desktop runtime command failed.'));
  }
  return result as T;
}

async function buildStorageRecognitionRequest(options: StorageRecognitionOptions = {}): Promise<TaxEngineRequest> {
  const request = buildTaxEngineRequest(options.year || new Date().getFullYear());
  request.canonicalTaxInputMode = 'required';
  request.aiNormalizerGpuRequired = true;
  request.aiNormalizerGpuConfirmed = false;
  request.aiNormalizerComputeBackend = 'unknown';
  request.allowCpuAi = false;
  await zastosujNormalizatorAi(request, () => tauriRuntimeApi.testOllamaGpu(), options.useAi);
  return request;
}

export const tauriRuntimeApi: RuntimeApi = {
  async getRuntimeInfo(): Promise<RuntimeInfo> {
    return assertTauriResult(await wywolaj<RuntimeInfo>('get_runtime_info'));
  },

  async getAppPaths(): Promise<AppPaths> {
    return assertTauriResult(await wywolaj<AppPaths>('get_app_paths'));
  },

  async getOllamaStatus(): Promise<OllamaRuntimeStatus> {
    return assertTauriResult(await wywolaj<OllamaRuntimeStatus>('get_ollama_status'));
  },

  async testOllamaGpu(): Promise<OllamaRuntimeStatus> {
    return assertTauriResult(await wywolaj<OllamaRuntimeStatus>('test_ollama_gpu'));
  },

  async ensureOllamaRunning(options = {}): Promise<OllamaEnsureResult> {
    return assertTauriResult(await wywolaj<OllamaEnsureResult>('ensure_ollama_running', { options }));
  },

  async stopOllama(): Promise<OllamaStopResult> {
    return assertTauriResult(await wywolaj<OllamaStopResult>('stop_ollama'));
  },

  async listOllamaModels(): Promise<OllamaModelInfo[]> {
    return assertTauriResult(await wywolaj<OllamaModelInfo[]>('list_ollama_models'));
  },

  async setOllamaConfig(config: Partial<OllamaConfig>): Promise<void> {
    assertTauriResult(await wywolaj('set_ollama_config', { config }));
  },

  async listStorageFiles(): Promise<StorageFile[]> {
    return assertTauriResult(await wywolaj<StorageFile[]>('list_storage_files'));
  },

  async listStorageFilePaths(): Promise<string[]> {
    const files = await this.listStorageFiles();
    return files.map((file) => file.relativePath);
  },

  async readStorageFile(relativePath: string): Promise<StorageFileReadResult> {
    return assertTauriResult(await wywolaj<StorageFileReadResult>('read_storage_file', { relativePath }));
  },

  async readStorageFileResponse(relativePath: string): Promise<Response> {
    return storageFileReadResultToResponse(await this.readStorageFile(relativePath));
  },

  async importFilesToStorage(files: RuntimeImportFile[]): Promise<ImportResult> {
    return assertTauriResult(await wywolaj<ImportResult>('import_files_to_storage', { files }));
  },

  async runTaxEngine(request: TaxEngineRequest): Promise<TaxEngineResponse> {
    const { jobId } = await this.startTaxEngineJob(request);
    while (true) {
      const status = await this.getTaxEngineJobStatus(jobId);
      if (status.state === 'done') {
        return this.getTaxEngineJobResult(jobId);
      }
      if (status.state === 'failed' || status.state === 'cancelled') {
        throw new Error(status.message || `Silnik zakończył job statusem ${status.state}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  },

  async startTaxEngineJob(request: TaxEngineRequest): Promise<{ jobId: string }> {
    return assertTauriResult(await wywolaj<{ jobId: string }>('start_tax_engine_job', { request }));
  },

  async getTaxEngineJobStatus(jobId: string): Promise<TaxEngineJobStatus> {
    return assertTauriResult(await wywolaj<TaxEngineJobStatus>('get_tax_engine_job_status', { jobId }));
  },

  async getTaxEngineJobResult(jobId: string): Promise<TaxEngineResponse> {
    return assertTauriResult(await wywolaj<TaxEngineResponse>('get_tax_engine_job_result', { jobId }));
  },

  async startStorageRecognitionJob(options: StorageRecognitionOptions = {}): Promise<{ jobId: string }> {
    return this.startTaxEngineJob(await buildStorageRecognitionRequest(options));
  },

  async getStorageRecognitionJobStatus(jobId: string): Promise<TaxEngineJobStatus> {
    return this.getTaxEngineJobStatus(jobId);
  },

  async getStorageRecognitionJobResult(jobId: string): Promise<TaxEngineResponse> {
    return this.getTaxEngineJobResult(jobId);
  },

  async cancelTaxEngineJob(jobId: string): Promise<void> {
    assertTauriResult(await wywolaj('cancel_tax_engine_job', { jobId }));
  },

  async openArtifact(path: string): Promise<void> {
    assertTauriResult(await wywolaj('open_artifact', { path }));
  },

  async downloadArtifact(path: string): Promise<void> {
    await this.openArtifact(path);
  },

  async exportDiagnosticsBundle(options: DiagnosticsExportOptions): Promise<DiagnosticsExportResult> {
    return assertTauriResult(await wywolaj<DiagnosticsExportResult>('export_diagnostics_bundle', { options }));
  },

  async listBackupSnapshots(): Promise<StoredBackupFile[]> {
    return assertTauriResult(await wywolaj<StoredBackupFile[]>('list_backup_snapshots'));
  },

  async writeBackupSnapshot(snapshot: unknown): Promise<StoredBackupFile> {
    return assertTauriResult(await wywolaj<StoredBackupFile>('write_backup_snapshot', { snapshot }));
  },

  async readBackupSnapshot(id: string): Promise<unknown> {
    return assertTauriResult(await wywolaj<unknown>('read_backup_snapshot', { id }));
  },

  async clearAppData(): Promise<ClearAppDataResult> {
    return assertTauriResult(await wywolaj<ClearAppDataResult>('clear_app_data'));
  },

  async detectLegacyStorage(): Promise<LegacyStorageStatus> {
    return assertTauriResult(await wywolaj<LegacyStorageStatus>('detect_legacy_storage'));
  },

  async copyLegacyStorageToAppData(): Promise<StorageMigrationResult> {
    return assertTauriResult(await wywolaj<StorageMigrationResult>('copy_legacy_storage_to_appdata'));
  },

  async getStorageMigrationStatus(): Promise<StorageMigrationStatus> {
    return assertTauriResult(await wywolaj<StorageMigrationStatus>('get_storage_migration_status'));
  },
};
