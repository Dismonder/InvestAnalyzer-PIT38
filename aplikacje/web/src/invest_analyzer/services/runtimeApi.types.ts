import type { TaxEngineRequest } from './taxEngineConfig';
import type { TaxEngineResponse } from '../hooks/useTaxEngineRun';

export type RuntimeKind = 'web' | 'tauri';

export interface RuntimeInfo {
  runtime: RuntimeKind;
  appVersion?: string;
  contractVersion?: string;
}

export interface AppPaths {
  dataDir: string;
  storageDir: string;
  artifactsDir: string;
  backupsDir: string;
  runsDir: string;
  logsDir: string;
  cacheDir: string;
  tempDir: string;
}

export interface StorageFile {
  relativePath: string;
  fileName: string;
  extension: string;
  sizeBytes?: number;
  modifiedAt?: string;
  sha256?: string;
  sourceStatus?: 'active' | 'candidate' | 'ignored' | 'unknown';
}

export interface StorageFileReadResult {
  relativePath: string;
  fileName: string;
  mimeType: string;
  text?: string;
  /** Kodowanie, w ktorym udalo sie odczytac tresc: "utf-8" albo "windows-1250". */
  encoding?: string;
  base64?: string;
}

export interface RuntimeImportFile {
  relativePath: string;
  fileName: string;
  base64: string;
  /**
   * Nadpisz plik o tej samej nazwie zamiast zapisywac kopie ze znacznikiem
   * czasu. Uzywaja tego wylacznie pliki zarzadzane przez aplikacje (transakcje
   * wpisane recznie, komplet danych z Freedom24): sa odtwarzane przy kazdym
   * przeliczeniu, wiec kopie mnozylyby te same transakcje w oczach silnika.
   * Pliki wgrywane przez uzytkownika zostaja przy zachowawczym domysle.
   */
  overwrite?: boolean;
}

export interface ImportFailure {
  fileName: string;
  relativePath: string;
  errorCode: string;
  message: string;
  recoverable: boolean;
}

export interface ImportResult {
  imported: StorageFile[];
  skipped: StorageFile[];
  failed?: ImportFailure[];
  warnings: string[];
}

export type TaxEngineJobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export type TaxEngineJobStage =
  | 'preflight'
  | 'storage_scan'
  | 'source_parse'
  | 'normalization'
  | 'nbp_rates'
  | 'fifo'
  | 'costs'
  | 'scenario_eval'
  | 'audit_hash'
  | 'artifacts'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface TaxEngineJobStatus {
  jobId: string;
  state: TaxEngineJobState;
  stage: TaxEngineJobStage;
  progress: number;
  message: string;
  startedAt: string;
  updatedAt: string;
  errorCode?: string;
}

export interface DiagnosticsExportOptions {
  mode: 'safe' | 'anonymized' | 'full';
}

export interface DiagnosticsExportResult {
  path: string;
  redacted: boolean;
}

export interface StorageRecognitionOptions {
  useAi?: boolean;
  forceReprocess?: boolean;
  year?: number;
}

/** Kopia decyzji uzytkownika zapisana poza pamiecia przegladarki. */
export interface StoredBackupFile {
  id: string;
  /** Tylko desktop; serwer web nie ujawnia sciezek katalogu uzytkownika. */
  path?: string;
  createdAt: string;
  sizeBytes: number;
}

export interface ClearAppDataResult {
  removedFiles: number;
  removedDirs: number;
  clearedRoots: string[];
  warnings: string[];
}

export interface LegacyStorageStatus {
  detected: boolean;
  sourceDir?: string | null;
  targetDir: string;
  fileCount: number;
  totalBytes: number;
  unreadableCount?: number;
  alreadyMigrated: boolean;
  manifestPath?: string | null;
}

export interface StorageMigrationEntry {
  sourceRelativePath: string;
  targetRelativePath?: string | null;
  sha256?: string | null;
  sizeBytes: number;
  status: string;
}

export interface StorageMigrationResult {
  migrationId: string;
  startedAt: string;
  finishedAt: string;
  sourceDir: string;
  targetDir: string;
  manifestPath: string;
  copied: number;
  skipped: number;
  renamed: number;
  entries: StorageMigrationEntry[];
}

export interface StorageMigrationStatus {
  migrated: boolean;
  manifestPath?: string | null;
  lastManifest?: unknown;
}

export interface OllamaModelInfo {
  name: string;
  modifiedAt?: string | null;
  size?: number | null;
  digest?: string | null;
  details?: Record<string, unknown> | null;
}

export interface OllamaConfig {
  baseUrl?: string | null;
  model?: string | null;
  exePath?: string | null;
  autoStart?: boolean | null;
  gpuMode?: 'gpu' | 'auto' | string | null;
  numGpu?: number | null;
  gpuBackend?: 'vulkan' | 'rocm' | 'cuda' | 'auto' | string | null;
  gpuLoadLimitPercent?: number | null;
  numBatch?: number | null;
  maxParallel?: number | null;
  allowAutoStart?: boolean | null;
  allowAutoRunAi?: boolean | null;
}

export interface OllamaEnsureOptions {
  requireGpu?: boolean;
  restartIfGpuUnconfirmed?: boolean;
}

export interface OllamaRuntimeStatus {
  available: boolean;
  serverRunning: boolean;
  baseUrl: string;
  model: string | null;
  modelAvailable: boolean;
  models: OllamaModelInfo[];
  exePath?: string | null;
  exeExists: boolean;
  canAutoStart: boolean;
  gpuMode?: string | null;
  numGpu?: number | null;
  gpuBackend?: string | null;
  gpuLoadLimitPercent?: number | null;
  numBatch?: number | null;
  maxParallel?: number | null;
  gpuConfirmed: boolean;
  computeBackend: 'gpu' | 'cpu' | 'unknown' | string;
  gpuProbeStatus: 'not_run' | 'pass' | 'fail' | string;
  gpuFailureReason?: string | null;
  logEvidence?: string[];
  error?: string | null;
}

export type OllamaStatus = OllamaRuntimeStatus;

export interface OllamaEnsureResult {
  started: boolean;
  alreadyRunning: boolean;
  status: OllamaRuntimeStatus;
  message: string;
}

export interface OllamaStopResult {
  stopped: boolean;
  status: OllamaRuntimeStatus;
  message: string;
}

export interface RuntimeApi {
  getRuntimeInfo(): Promise<RuntimeInfo>;
  getAppPaths(): Promise<AppPaths>;
  getOllamaStatus(): Promise<OllamaRuntimeStatus>;
  testOllamaGpu(): Promise<OllamaRuntimeStatus>;
  ensureOllamaRunning(options?: OllamaEnsureOptions): Promise<OllamaEnsureResult>;
  stopOllama(): Promise<OllamaStopResult>;
  listOllamaModels(): Promise<OllamaModelInfo[]>;
  setOllamaConfig(config: Partial<OllamaConfig>): Promise<void>;
  listStorageFiles(): Promise<StorageFile[]>;
  listStorageFilePaths(): Promise<string[]>;
  readStorageFile(relativePath: string): Promise<StorageFileReadResult>;
  readStorageFileResponse(relativePath: string): Promise<Response>;
  importFilesToStorage(files: RuntimeImportFile[]): Promise<ImportResult>;
  runTaxEngine(request: TaxEngineRequest): Promise<TaxEngineResponse>;
  startTaxEngineJob(request: TaxEngineRequest): Promise<{ jobId: string }>;
  getTaxEngineJobStatus(jobId: string): Promise<TaxEngineJobStatus>;
  getTaxEngineJobResult(jobId: string): Promise<TaxEngineResponse>;
  startStorageRecognitionJob(options?: StorageRecognitionOptions): Promise<{ jobId: string }>;
  getStorageRecognitionJobStatus(jobId: string): Promise<TaxEngineJobStatus>;
  getStorageRecognitionJobResult(jobId: string): Promise<TaxEngineResponse>;
  cancelTaxEngineJob(jobId: string): Promise<void>;
  openArtifact(path: string): Promise<void>;
  downloadArtifact(path: string): Promise<void>;
  exportDiagnosticsBundle(options: DiagnosticsExportOptions): Promise<DiagnosticsExportResult>;
  listBackupSnapshots(): Promise<StoredBackupFile[]>;
  writeBackupSnapshot(snapshot: unknown): Promise<StoredBackupFile>;
  readBackupSnapshot(id: string): Promise<unknown>;
  clearAppData(): Promise<ClearAppDataResult>;
  detectLegacyStorage(): Promise<LegacyStorageStatus>;
  copyLegacyStorageToAppData(): Promise<StorageMigrationResult>;
  getStorageMigrationStatus(): Promise<StorageMigrationStatus>;
}
