import { REQUEST_CONTRACT_VERSION } from '../constants';
import type { TaxEngineResponse } from '../hooks/useTaxEngineRun';
import { parseTaxEngineResponseText } from './taxEngineResponse';
import type {
  AppPaths,
  ClearAppDataResult,
  StoredBackupFile,
  DiagnosticsExportOptions,
  DiagnosticsExportResult,
  ImportResult,
  RuntimeApi,
  RuntimeImportFile,
  RuntimeInfo,
  OllamaConfig,
  OllamaEnsureResult,
  OllamaModelInfo,
  OllamaRuntimeStatus,
  OllamaStopResult,
  StorageFile,
  StorageFileReadResult,
  StorageRecognitionOptions,
  TaxEngineJobStatus,
} from './runtimeApi.types';
import { buildTaxEngineRequest, type TaxEngineRequest } from './taxEngineConfig';
import { zastosujNormalizatorAi } from './normalizatorAiZadania';
import { decodeStorageText } from './textEncoding';

/**
 * Przebiegi silnika uruchomione w trybie przegladarkowym.
 *
 * Wpis musi zniknac po odebraniu wyniku. Odpowiedz silnika wazy megabajty
 * (kanoniczne wejscie, dossier transakcji, wiersze historii), a przeliczenie
 * uruchamia sie po kazdej zmianie transakcji - bez sprzatania mapa rosla przez
 * cala sesje i zjadala pamiec karty.
 */
const webJobs = new Map<string, { wynik: Promise<TaxEngineResponse>; zakonczony: boolean; startMs: number; controller: AbortController }>();

/**
 * Zadania w locie, po odcisku tresci.
 *
 * Wejscie na zakladke silnika odpalalo `/api/tax-engine/run`,
 * `/api/ollama/gpu-test` i `/api/storage/files` po 3-4 razy rownolegle:
 * kilka komponentow pytalo o to samo w tej samej chwili, a kazdy przebieg
 * silnika to osobny proces Pythona na minute. Identyczne zadanie, ktore juz
 * trwa, dostaje teraz te sama obietnice zamiast nowego procesu. Po zakonczeniu
 * wpis znika, wiec kolejne "Przelicz" zawsze liczy od nowa.
 */
const zadaniaWLocie = new Map<string, Promise<unknown>>();

function wspolneZadanie<T>(klucz: string, uruchom: () => Promise<T>): Promise<T> {
  const trwajace = zadaniaWLocie.get(klucz) as Promise<T> | undefined;
  if (trwajace) return trwajace;
  const nowe = uruchom().finally(() => {
    zadaniaWLocie.delete(klucz);
  });
  zadaniaWLocie.set(klucz, nowe);
  return nowe;
}

/** Czas poprzedniego przebiegu - jedyna uczciwa podstawa do szacowania postepu. */
const KLUCZ_CZASU_PRZEBIEGU = 'investAnalyzer:lastEngineRunMs';
const DOMYSLNY_CZAS_PRZEBIEGU_MS = 75_000;

function odczytajCzasPoprzedniegoPrzebiegu(): number | null {
  try {
    const zapis = Number(localStorage.getItem(KLUCZ_CZASU_PRZEBIEGU));
    return Number.isFinite(zapis) && zapis > 1_000 ? zapis : null;
  } catch {
    return null;
  }
}

function zapiszCzasPrzebiegu(ms: number): void {
  try {
    localStorage.setItem(KLUCZ_CZASU_PRZEBIEGU, String(Math.round(ms)));
  } catch {
    // Brak magazynu nie moze zatrzymac przebiegu.
  }
}

/** Opis trwajacego przebiegu: ile trwa i ile trwal poprzedni. */
export function opisTrwajacegoPrzebiegu(
  uplyneloMs: number,
  poprzedniMs: number | null,
): { progress: number; message: string } {
  const sekundy = Math.max(0, Math.round(uplyneloMs / 1000));
  const spodziewany = poprzedniMs ?? DOMYSLNY_CZAS_PRZEBIEGU_MS;
  // Szacunek z czasu, nie pomiar etapow: proces silnika nie raportuje postepu.
  const progress = Math.min(95, Math.max(3, Math.round((uplyneloMs / spodziewany) * 95)));
  const odniesienie = poprzedniMs
    ? `poprzedni przebieg trwał ok. ${Math.round(poprzedniMs / 1000)} s`
    : 'pełny przebieg trwa zwykle około minuty';
  const dluzej = uplyneloMs > spodziewany * 1.5 ? ' Trwa dłużej niż zwykle, ale proces nadal pracuje.' : '';
  return {
    progress,
    message: `Silnik liczy rozliczenie: czyta pliki, FIFO, kursy NBP. Trwa ${sekundy} s (${odniesienie}; pasek to szacunek z czasu).${dluzej}`,
  };
}
const OLLAMA_CONFIG_STORAGE_KEY = 'investAnalyzer:ollamaConfig:v1';

function fileNameFromPath(relativePath: string): string {
  return relativePath.split(/[\\/]/).pop() || relativePath;
}

function extensionFromPath(relativePath: string): string {
  const filename = fileNameFromPath(relativePath);
  const index = filename.lastIndexOf('.');
  return index >= 0 ? filename.slice(index).toLowerCase() : '';
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  let message = fallback;
  try {
    const text = await response.text();
    if (text) {
      try {
        const payload = JSON.parse(text) as { error?: unknown; message?: unknown };
        message = String(payload.error || payload.message || text);
      } catch {
        message = text;
      }
    }
  } catch {
    message = fallback;
  }
  return new Error(message);
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
}

function getStoredOllamaConfig(): OllamaConfig {
  if (typeof window === 'undefined') {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(OLLAMA_CONFIG_STORAGE_KEY);
    return raw ? normalizeOllamaConfig(JSON.parse(raw) as OllamaConfig) : {};
  } catch {
    return {};
  }
}

function normalizeOllamaConfig(config: Partial<OllamaConfig>): OllamaConfig {
  const gpuMode = config.gpuMode === 'auto' ? 'auto' : 'gpu';
  const gpuBackend = config.gpuBackend === 'rocm' || config.gpuBackend === 'cuda' || config.gpuBackend === 'auto'
    ? config.gpuBackend
    : 'vulkan';
  const gpuLoadLimitPercent = typeof config.gpuLoadLimitPercent === 'number'
    ? Math.min(95, Math.max(50, Math.round(config.gpuLoadLimitPercent)))
    : 85;
  const numBatch = typeof config.numBatch === 'number' && config.numBatch > 0 ? Math.round(config.numBatch) : 128;
  const maxParallel = typeof config.maxParallel === 'number' && config.maxParallel > 0
    ? Math.min(2, Math.round(config.maxParallel))
    : 1;
  return {
    ...config,
    gpuMode,
    gpuBackend,
    gpuLoadLimitPercent,
    numBatch,
    maxParallel,
    numGpu: typeof config.numGpu === 'number' ? config.numGpu : gpuMode === 'gpu' ? -1 : null,
  };
}

function setStoredOllamaConfig(config: Partial<OllamaConfig>): OllamaConfig {
  const merged = normalizeOllamaConfig({ ...getStoredOllamaConfig(), ...config });
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(OLLAMA_CONFIG_STORAGE_KEY, JSON.stringify(merged));
  }
  return merged;
}

function ollamaQuery(): string {
  const config = getStoredOllamaConfig();
  const query = new URLSearchParams();
  if (config.baseUrl) {
    query.set('baseUrl', config.baseUrl);
  }
  if (config.model) {
    query.set('model', config.model);
  }
  if (config.gpuMode) {
    query.set('gpuMode', config.gpuMode);
  }
  if (config.gpuBackend) {
    query.set('gpuBackend', config.gpuBackend);
  }
  if (typeof config.numGpu === 'number') {
    query.set('numGpu', String(config.numGpu));
  }
  if (typeof config.gpuLoadLimitPercent === 'number') {
    query.set('gpuLoadLimitPercent', String(config.gpuLoadLimitPercent));
  }
  if (typeof config.numBatch === 'number') {
    query.set('numBatch', String(config.numBatch));
  }
  if (typeof config.maxParallel === 'number') {
    query.set('maxParallel', String(config.maxParallel));
  }
  const text = query.toString();
  return text ? `?${text}` : '';
}

async function downloadBlob(blob: Blob, filename: string): Promise<void> {
  const downloadUrl = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = downloadUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(downloadUrl);
}

async function buildStorageRecognitionRequest(options: StorageRecognitionOptions = {}): Promise<TaxEngineRequest> {
  const request = buildTaxEngineRequest(options.year || new Date().getFullYear());
  request.canonicalTaxInputMode = 'required';
  request.aiNormalizerGpuRequired = true;
  request.aiNormalizerGpuConfirmed = false;
  request.aiNormalizerComputeBackend = 'unknown';
  request.allowCpuAi = false;
  await zastosujNormalizatorAi(request, () => webRuntimeApi.testOllamaGpu(), options.useAi);
  return request;
}

export const webRuntimeApi: RuntimeApi = {
  async getRuntimeInfo(): Promise<RuntimeInfo> {
    return { runtime: 'web', contractVersion: REQUEST_CONTRACT_VERSION };
  },

  async getAppPaths(): Promise<AppPaths> {
    return {
      dataDir: '',
      storageDir: '/storage',
      artifactsDir: '/api/tax-engine/download',
      backupsDir: '/api/backups',
      runsDir: '',
      logsDir: '',
      cacheDir: '',
      tempDir: '',
    };
  },

  async getOllamaStatus(): Promise<OllamaRuntimeStatus> {
    const response = await fetch(`/api/ollama/status${ollamaQuery()}`);
    if (!response.ok) {
      throw await responseError(response, 'Nie udało się sprawdzić statusu Ollama.');
    }
    return await response.json() as OllamaRuntimeStatus;
  },

  async testOllamaGpu(): Promise<OllamaRuntimeStatus> {
    const zapytanie = ollamaQuery();
    return wspolneZadanie(`gpu-test:${zapytanie}`, async () => {
      const response = await fetch(`/api/ollama/gpu-test${zapytanie}`, { method: 'POST' });
      if (!response.ok) {
        throw await responseError(response, 'Nie udało się potwierdzić GPU Ollama.');
      }
      return await response.json() as OllamaRuntimeStatus;
    });
  },

  async ensureOllamaRunning(options = {}): Promise<OllamaEnsureResult> {
    const response = await fetch('/api/ollama/ensure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...getStoredOllamaConfig(), options }),
    });
    if (!response.ok) {
      throw await responseError(response, 'Nie udało się uruchomić Ollama.');
    }
    return await response.json() as OllamaEnsureResult;
  },

  async stopOllama(): Promise<OllamaStopResult> {
    const status = await this.getOllamaStatus();
    return {
      stopped: false,
      status,
      message: 'Tryb web/dev nie zarządza procesem Ollama.',
    };
  },

  async listOllamaModels(): Promise<OllamaModelInfo[]> {
    const response = await fetch(`/api/ollama/models${ollamaQuery()}`);
    if (!response.ok) {
      throw await responseError(response, 'Nie udało się pobrać listy modeli Ollama.');
    }
    return await response.json() as OllamaModelInfo[];
  },

  async setOllamaConfig(config: Partial<OllamaConfig>): Promise<void> {
    const merged = setStoredOllamaConfig(config);
    const response = await fetch('/api/ollama/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(merged),
    });
    if (!response.ok) {
      throw await responseError(response, 'Nie udało się zapisać konfiguracji Ollama.');
    }
  },

  async listStorageFiles(): Promise<StorageFile[]> {
    const payload = await wspolneZadanie('storage-files', async () => {
      const response = await fetch('/api/storage/files');
      return await response.json() as { success?: boolean; error?: string; files?: string[] };
    });
    if (!payload.success) {
      throw new Error(payload.error || 'Nie udało się odczytać listy plików storage.');
    }
    return (payload.files || []).map((relativePath: string) => ({
      relativePath,
      fileName: fileNameFromPath(relativePath),
      extension: extensionFromPath(relativePath),
      sourceStatus: 'unknown',
    }));
  },

  async listStorageFilePaths(): Promise<string[]> {
    const files = await this.listStorageFiles();
    return files.map((file) => file.relativePath);
  },

  async readStorageFile(relativePath: string): Promise<StorageFileReadResult> {
    const response = await this.readStorageFileResponse(relativePath);
    const mimeType = response.headers.get('content-type') || 'application/octet-stream';
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    if (mimeType.includes('application/json') || mimeType.startsWith('text/')) {
      const decoded = decodeStorageText(bytes);
      return {
        relativePath,
        fileName: fileNameFromPath(relativePath),
        mimeType,
        text: decoded.text,
        encoding: decoded.encoding,
      };
    }
    let binary = '';
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return {
      relativePath,
      fileName: fileNameFromPath(relativePath),
      mimeType,
      base64: btoa(binary),
    };
  },

  async readStorageFileResponse(relativePath: string): Promise<Response> {
    const response = await fetch(`/api/storage/files/${encodeURIComponent(relativePath)}`);
    if (!response.ok) {
      throw await responseError(response, `${relativePath}: ${response.statusText || response.status}`);
    }
    return response;
  },

  async importFilesToStorage(files: RuntimeImportFile[]): Promise<ImportResult> {
    const response = await fetch('/api/storage/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files }),
    });
    if (!response.ok) {
      throw await responseError(response, 'Nie udało się zaimportować plików.');
    }
    const payload = await response.json();
    if (!payload.success) {
      throw new Error(payload.error || 'Nie udało się zaimportować plików.');
    }
    return {
      imported: payload.imported || [],
      skipped: payload.skipped || [],
      failed: payload.failed || [],
      warnings: payload.warnings || [],
    };
  },

  async runTaxEngine(request: TaxEngineRequest, signal?: AbortSignal): Promise<TaxEngineResponse> {
    const body = JSON.stringify(request);
    const run = async () => {
      const startMs = Date.now();
      const response = await fetch('/api/tax-engine/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal,
      });
      const wynik = parseTaxEngineResponseText(await response.text(), response.status);
      // Odpowiedz z pamieci serwera (`cached: true`) wraca w 2-3 s. Zapisana jako
      // czas przebiegu psula szacunek: kolejne prawdziwe liczenie (ok. minuty)
      // juz po kilku sekundach pokazywalo "trwa dluzej niz zwykle".
      const zPamieciSerwera = (wynik as { cached?: unknown }).cached === true;
      if (response.ok && !request.packageScope && !zPamieciSerwera) zapiszCzasPrzebiegu(Date.now() - startMs);
      return wynik;
    };
    return signal ? run() : wspolneZadanie(`tax-engine:${body}`, run);
  },

  async startTaxEngineJob(request: TaxEngineRequest): Promise<{ jobId: string }> {
    const jobId = `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const controller = new AbortController();
    const wpis = { wynik: this.runTaxEngine(request, controller.signal), zakonczony: false, startMs: Date.now(), controller };
    // Bez tego odrzucenie obietnicy miedzy startem a odbiorem wyniku ladowaloby
    // w konsoli jako nieobsluzony blad; wlasciwy komunikat i tak dostaje
    // wywolujacy przy getTaxEngineJobResult.
    wpis.wynik.then(
      () => {
        wpis.zakonczony = true;
      },
      () => {
        wpis.zakonczony = true;
      }
    );
    webJobs.set(jobId, wpis);
    return { jobId };
  },

  async getTaxEngineJobStatus(jobId: string): Promise<TaxEngineJobStatus> {
    const wpis = webJobs.get(jobId);
    if (!wpis) {
      throw new Error(`Nieznany job silnika: ${jobId}`);
    }
    const now = new Date().toISOString();
    // Status mowil "done" juz w pierwszej chwili, wiec wskaznik postepu
    // pokazywal 100% w trakcie liczenia. Teraz odpowiada stanowi przebiegu.
    // Proces silnika nie raportuje etapow, wiec stale "50%" przez minute nic
    // nie mowilo. Pokazujemy czas trwania i szacunek z poprzedniego przebiegu.
    const trwajacy = opisTrwajacegoPrzebiegu(Date.now() - wpis.startMs, odczytajCzasPoprzedniegoPrzebiegu());
    return {
      jobId,
      state: wpis.zakonczony ? 'done' : 'running',
      stage: wpis.zakonczony ? 'done' : 'scenario_eval',
      progress: wpis.zakonczony ? 100 : trwajacy.progress,
      message: wpis.zakonczony ? 'Przebieg zakończony.' : trwajacy.message,
      startedAt: new Date(wpis.startMs).toISOString(),
      updatedAt: now,
    };
  },

  async getTaxEngineJobResult(jobId: string): Promise<TaxEngineResponse> {
    const wpis = webJobs.get(jobId);
    if (!wpis) {
      throw new Error(`Nieznany job silnika: ${jobId}`);
    }
    try {
      return await wpis.wynik;
    } finally {
      // Wynik jest odebrany, wiec nie ma powodu trzymac go w pamieci karty.
      webJobs.delete(jobId);
    }
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
    webJobs.get(jobId)?.controller.abort();
    webJobs.delete(jobId);
  },

  async openArtifact(path: string): Promise<void> {
    await this.downloadArtifact(path);
  },

  async downloadArtifact(path: string): Promise<void> {
    const response = await fetch(`/api/tax-engine/download?path=${encodeURIComponent(path)}`);
    if (!response.ok) {
      throw new Error('Nie udało się pobrać artefaktu silnika.');
    }
    await downloadBlob(await response.blob(), path.split(/[\\/]/).pop() || 'tax-artifact');
  },

  async exportDiagnosticsBundle(_options: DiagnosticsExportOptions): Promise<DiagnosticsExportResult> {
    const payload = {
      runtime: 'web',
      generatedAt: new Date().toISOString(),
      note: 'Pakiet diagnostyczny desktopowy jest dostępny w runtime Tauri.',
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    await downloadBlob(blob, 'invest-analyzer-diagnostics-web.json');
    return { path: 'invest-analyzer-diagnostics-web.json', redacted: true };
  },

  async listBackupSnapshots(): Promise<StoredBackupFile[]> {
    const response = await fetch('/api/backups');
    const payload = await response.json();
    if (!response.ok || payload?.success === false) {
      throw new Error(payload?.error || 'Nie udało się odczytać listy kopii.');
    }
    return Array.isArray(payload?.backups) ? payload.backups : [];
  },

  async writeBackupSnapshot(snapshot: unknown): Promise<StoredBackupFile> {
    const response = await fetch('/api/backups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ snapshot }),
    });
    const payload = await response.json();
    if (!response.ok || payload?.success === false) {
      throw new Error(payload?.error || 'Nie udało się zapisać kopii.');
    }
    return payload.backup as StoredBackupFile;
  },

  async readBackupSnapshot(id: string): Promise<unknown> {
    const response = await fetch(`/api/backups/${encodeURIComponent(id)}`);
    const payload = await response.json();
    if (!response.ok || payload?.success === false) {
      throw new Error(payload?.error || 'Nie udało się odczytać kopii.');
    }
    return payload.snapshot;
  },

  async clearAppData(): Promise<ClearAppDataResult> {
    const response = await fetch('/api/runtime/clear-app-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'WYCZYSC_DANE_APLIKACJI' }),
    });
    if (!response.ok) {
      throw await responseError(response, 'Nie udało się wyczyścić danych aplikacji.');
    }
    const payload = await response.json() as ClearAppDataResult & { success?: boolean; error?: string };
    if (payload.success === false) {
      throw new Error(payload.error || 'Nie udało się wyczyścić danych aplikacji.');
    }
    return payload;
  },

  async detectLegacyStorage() {
    return {
      detected: false,
      sourceDir: null,
      targetDir: '/storage',
      fileCount: 0,
      totalBytes: 0,
      alreadyMigrated: false,
      manifestPath: null,
    };
  },

  async copyLegacyStorageToAppData() {
    throw new Error('Migracja storage jest dostępna tylko w aplikacji desktopowej.');
  },

  async getStorageMigrationStatus() {
    return {
      migrated: false,
      manifestPath: null,
      lastManifest: null,
    };
  },
};

export function storageFileReadResultToResponse(result: StorageFileReadResult): Response {
  if (typeof result.text === 'string') {
    return new Response(result.text, { headers: { 'content-type': result.mimeType } });
  }
  return new Response(base64ToBlob(result.base64 || '', result.mimeType), {
    headers: { 'content-type': result.mimeType },
  });
}
