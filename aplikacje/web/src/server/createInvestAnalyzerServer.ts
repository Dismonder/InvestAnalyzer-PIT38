import express from "express";
import { koncowaObslugaBledu, zabezpieczTrasyAsync } from "./trasyAsync";
import path from "path";
import fs from "fs";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import {
  getTaxEngineRunOutputDir,
  createTaxEngineRunOutputDir,
  pruneTaxEngineRunOutputDirs,
  getRecentTaxEngineCachedOutputDirs,
  pruneTaxEngineCache,
  pruneOrphanedRuntimeNamespaces,
  engineSourceFingerprint,
  getTaxEngineCacheDir,
  storageMetadataFingerprint,
  stableTaskFingerprint,
  listStorageFiles,
  resolvePythonExecutable,
  resolveStorageFilePath,
  validateTaxYear,
  writeRuntimeTempJsonSync,
  isAllowedStorageExtension,
  assertStoragePathSafe,
  ALLOWED_STORAGE_EXTENSIONS,
  type RuntimeTempJson,
} from "./taxEngineRuntime.ts";
import { getServerErrorMessage, getServerErrorStatus } from "./errorResponse.ts";
import { getBackupsRoot, getPythonEngineRoot, getRepoTmpRoot, getStorageRoot, getWebDistRoot } from "./workspacePaths.ts";
import { isBackupId, listBackupSnapshots, readBackupSnapshot, writeBackupSnapshot, zachowajPoprzedniaWersjeEksportu } from "./backupStore.ts";
import nbpRouter from "./routes/nbp.ts";
import quotesRouter from "./routes/quotes.ts";
import brokersRouter from "./routes/brokers.ts";

export function writeCacheFileAtomically(filePath: string, contents: string): boolean {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, contents, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporaryPath, filePath);
    return true;
  } catch {
    try { fs.rmSync(temporaryPath, { force: true }); } catch { /* pamięć jest opcjonalna */ }
    return false;
  }
}

export type InvestAnalyzerServerOptions = {
  serveStatic?: boolean;
  staticDir?: string;
  workspaceRoot?: string;
  runtimeRoot?: string;
};

/**
 * Wynik z brakiem kursu NBP bywa skutkiem chwilowej awarii sieci ("NBP API request
 * failed"). Zapamietany na 7 dni zwracalby zablokowany wynik takze po powrocie sieci,
 * wiec takich wynikow nie zapisujemy. Nieblokujaca informacja o zakresie archiwum CSV
 * (NBP_COVERAGE_GAP z blocking=false) jest stalym elementem wyniku - gdyby ona
 * wylaczala pamiec, kazde przeliczenie szloby do silnika (~20 s na prawdziwych danych).
 */
export function wynikMaProblemNbp(result: unknown): boolean {
  const wpisy = (lista: unknown): Array<{ code?: unknown; blocking?: unknown; message?: unknown }> =>
    Array.isArray(lista) ? lista.filter((wpis) => wpis && typeof wpis === "object") : [];
  const wynik = (result ?? {}) as { issues?: unknown; actionable_issues?: unknown };
  return [...wpisy(wynik.issues), ...wpisy(wynik.actionable_issues)].some((wpis) => {
    if (typeof wpis.code !== "string" || !wpis.code.startsWith("NBP_")) return false;
    return (
      wpis.code === "NBP_RATE_NOT_FOUND" ||
      wpis.blocking === true ||
      (typeof wpis.message === "string" && /request failed|fetch failed|timed? ?out/i.test(wpis.message))
    );
  });
}

/** Wersja zasad pamieci wynikow silnika (wchodzi do klucza wpisu). 2: bez wynikow z awarii sieci NBP. */
export const ZASADY_PAMIECI_WYNIKOW = 2;

/** Limit pliku wgrywanego do magazynu: 32 MiB danych = 44 739 240 znakow base64 (jak desktop). */
const MAX_MIB_NA_PLIK = 32;
const MAX_BASE64_NA_PLIK = 44_739_240;

export function resolveServerPort(defaultPort = 3000): number {
  const parsedPort = Number(process.env.PORT || defaultPort);
  return Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : defaultPort;
}

const allowedServerHosts = new Set(["127.0.0.1", "localhost", "::1"]);
/** Eksport Freedom24 pobierany przez aplikacje - poprzednia wersja idzie do dane/backupy. */
const PLIKI_EKSPORTU_FREEDOM24 = new Set(["freedom24_komplet.json", "broker_raport_api.json", "dezpozytariusz_raport_api.json"]);
/** Opis awarii, ktory CLI silnika drukuje na stdout: {"status":"ERROR","error":{code,message,hint}}. */
export function opisAwariiSilnika(stdout: string): { code?: string; message: string; hint?: string } | null {
  const ostatniaLinia = stdout.trim().split(/\r?\n/).pop() || "";
  try {
    const wynik = JSON.parse(ostatniaLinia) as { status?: unknown; error?: { code?: unknown; message?: unknown; hint?: unknown } };
    if (wynik?.status !== "ERROR" || typeof wynik.error?.message !== "string" || !wynik.error.message.trim()) return null;
    return {
      code: typeof wynik.error.code === "string" ? wynik.error.code : undefined,
      message: wynik.error.message.trim(),
      hint: typeof wynik.error.hint === "string" ? wynik.error.hint.trim() : undefined,
    };
  } catch {
    return null;
  }
}

/** Jedyne pliki magazynu, ktore wolno podmienic w miejscu (w katalogu glownym magazynu). */
const PLIKI_NADPISYWANE_W_MIEJSCU = new Set([...PLIKI_EKSPORTU_FREEDOM24, "portfel_reczne_transakcje.json"]);
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_OLLAMA_MODEL = "qwen3:14b";

type OllamaConfigLike = {
  baseUrl?: unknown;
  model?: unknown;
  gpuMode?: unknown;
  numGpu?: unknown;
  gpuBackend?: unknown;
  gpuLoadLimitPercent?: unknown;
  numBatch?: unknown;
  maxParallel?: unknown;
  allowAutoStart?: unknown;
  allowAutoRunAi?: unknown;
};

function normalizeOllamaConfig(config: OllamaConfigLike = {}) {
  const requestedBaseUrl = String(config.baseUrl || process.env.INVEST_OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL).trim();
  const requestedModel = String(config.model || process.env.INVEST_OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL).trim() || DEFAULT_OLLAMA_MODEL;
  const requestedGpuMode = String(config.gpuMode || process.env.INVEST_OLLAMA_GPU_MODE || "gpu").trim().toLowerCase();
  const gpuMode = ["gpu", "auto"].includes(requestedGpuMode) ? requestedGpuMode : "gpu";
  const parsedNumGpu = Number(config.numGpu ?? process.env.INVEST_OLLAMA_NUM_GPU ?? (gpuMode === "gpu" ? -1 : ""));
  const numGpu = Number.isInteger(parsedNumGpu) ? (parsedNumGpu === 0 ? -1 : parsedNumGpu) : null;
  const requestedGpuBackend = String(config.gpuBackend || process.env.INVEST_OLLAMA_GPU_BACKEND || "vulkan").trim().toLowerCase();
  const gpuBackend = ["vulkan", "rocm", "cuda", "auto"].includes(requestedGpuBackend) ? requestedGpuBackend : "vulkan";
  const parsedGpuLimit = Number(config.gpuLoadLimitPercent ?? process.env.INVEST_OLLAMA_GPU_LOAD_LIMIT_PERCENT ?? 85);
  const gpuLoadLimitPercent = Number.isFinite(parsedGpuLimit) ? Math.min(95, Math.max(50, Math.round(parsedGpuLimit))) : 85;
  const parsedNumBatch = Number(config.numBatch ?? process.env.INVEST_OLLAMA_NUM_BATCH ?? (gpuLoadLimitPercent <= 85 ? 128 : 256));
  const numBatch = Number.isInteger(parsedNumBatch) && parsedNumBatch > 0 ? parsedNumBatch : 128;
  const parsedMaxParallel = Number(config.maxParallel ?? process.env.OLLAMA_NUM_PARALLEL ?? 1);
  const maxParallel = Number.isInteger(parsedMaxParallel) && parsedMaxParallel > 0 ? Math.min(2, parsedMaxParallel) : 1;
  const allowAutoStart = config.allowAutoStart === true || String(process.env.INVEST_OLLAMA_ALLOW_AUTO_START || "").toLowerCase() === "true";
  const allowAutoRunAi = config.allowAutoRunAi === true || String(process.env.INVEST_OLLAMA_ALLOW_AUTO_RUN_AI || "").toLowerCase() === "true";
  let baseUrl = DEFAULT_OLLAMA_BASE_URL;
  try {
    const parsed = new URL(requestedBaseUrl);
    const isLoopback = parsed.protocol === "http:" && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname);
    baseUrl = isLoopback ? parsed.toString().replace(/\/+$/, "") : DEFAULT_OLLAMA_BASE_URL;
  } catch {
    baseUrl = DEFAULT_OLLAMA_BASE_URL;
  }
  return { baseUrl, model: requestedModel, gpuMode, numGpu, gpuBackend, gpuLoadLimitPercent, numBatch, maxParallel, allowAutoStart, allowAutoRunAi };
}

function parseOllamaModels(payload: unknown) {
  const models = Array.isArray((payload as { models?: unknown })?.models) ? (payload as { models: unknown[] }).models : [];
  return models.map((model) => {
    const entry = model as Record<string, unknown>;
    return {
      name: String(entry.name || entry.model || ""),
      modifiedAt: typeof entry.modified_at === "string" ? entry.modified_at : null,
      size: typeof entry.size === "number" ? entry.size : null,
      digest: typeof entry.digest === "string" ? entry.digest : null,
      details: entry.details && typeof entry.details === "object" ? entry.details as Record<string, unknown> : null,
    };
  }).filter((model) => model.name);
}

function chooseEffectiveOllamaModel(requestedModel: string, models: Array<{ name: string }>, isExplicit: boolean) {
  if (isExplicit) {
    return requestedModel;
  }
  for (const preferred of [DEFAULT_OLLAMA_MODEL, "qwen3:8b", "qwen2.5:7b-instruct", "qwen2.5:7b", "llama3.1:8b-instruct", "llama3.1:8b"]) {
    if (models.some((model) => model.name === preferred)) {
      return preferred;
    }
  }
  return models[0]?.name || requestedModel;
}

export function resolveServerHost(defaultHost = "127.0.0.1"): string {
  const host = String(process.env.HOST || "").trim();
  if (!host) {
    return defaultHost;
  }
  return allowedServerHosts.has(host) ? host : defaultHost;
}

export function formatServerHostForLog(host: string): string {
  if (host === "127.0.0.1") {
    return "localhost";
  }
  return host.includes(":") ? `[${host}]` : host;
}

export function isAllowedLocalRequestHost(host: string): boolean {
  const match = /^(localhost\.?|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?$/i.exec(host);
  return Boolean(match && (!match[2] || (Number(match[2]) >= 1 && Number(match[2]) <= 65535)));
}

type ClearWorkspaceDataResult = {
  removedFiles: number;
  removedDirs: number;
  clearedRoots: string[];
  warnings: string[];
};

function assertWorkspaceChild(workspaceRoot: string, targetPath: string): string {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(targetPath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error("Refusing to clear a path outside workspace root.");
  }
  return target;
}

async function clearDirectoryContents(dir: string, result: ClearWorkspaceDataResult): Promise<void> {
  const rootStat = await fs.promises.lstat(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (rootStat?.isSymbolicLink()) throw new Error(`Odmowa czyszczenia dowiązania: ${dir}`);
  if (!rootStat) await fs.promises.mkdir(dir, { recursive: true });
  const removeEntry = async (entryPath: string): Promise<void> => {
    const stat = await fs.promises.lstat(entryPath);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      for (const child of await fs.promises.readdir(entryPath)) {
        await removeEntry(path.join(entryPath, child));
      }
      await fs.promises.rmdir(entryPath);
    } else {
      await fs.promises.unlink(entryPath);
    }
  };
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".gitkeep") {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    try {
      await removeEntry(fullPath);
      if (entry.isDirectory()) {
        result.removedDirs += 1;
      } else {
        result.removedFiles += 1;
      }
    } catch (error) {
      result.warnings.push(`Nie udało się usunąć ${fullPath}: ${getServerErrorMessage(error)}`);
    }
  }
}

async function clearWorkspaceAppData(workspaceRoot: string): Promise<ClearWorkspaceDataResult> {
  const result: ClearWorkspaceDataResult = {
    removedFiles: 0,
    removedDirs: 0,
    clearedRoots: [],
    warnings: [],
  };
  const roots = [
    getStorageRoot(workspaceRoot),
    path.join(workspaceRoot, "dane", "out"),
    getRepoTmpRoot(workspaceRoot),
    path.join(workspaceRoot, "dane", "logi"),
  ].map((root) => assertWorkspaceChild(workspaceRoot, root));

  const realWorkspace = await fs.promises.realpath(workspaceRoot);
  for (const root of roots) {
    let component = path.resolve(workspaceRoot);
    for (const part of path.relative(component, root).split(path.sep)) {
      component = path.join(component, part);
      const existing = await fs.promises.lstat(component).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (existing?.isSymbolicLink()) throw new Error(`Odmowa czyszczenia dowiązania: ${component}`);
      if (existing) {
        const real = await fs.promises.realpath(component);
        if (real !== realWorkspace && !real.startsWith(`${realWorkspace}${path.sep}`)) {
          throw new Error(`Odmowa czyszczenia poza workspace: ${component}`);
        }
      }
    }
    await clearDirectoryContents(root, result);
    result.clearedRoots.push(root);
  }
  return result;
}

export async function checkOllamaStatus(fetchImpl: typeof fetch = fetch, config: OllamaConfigLike = {}) {
  const { baseUrl, model, gpuMode, numGpu, gpuBackend, gpuLoadLimitPercent, numBatch, maxParallel } = normalizeOllamaConfig(config);
  const explicitModel = typeof config.model === "string" && config.model.trim().length > 0;
  const envModel = typeof process.env.INVEST_OLLAMA_MODEL === "string" && process.env.INVEST_OLLAMA_MODEL.trim().length > 0;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetchImpl(`${baseUrl}/api/tags`, { signal: controller.signal });
    if (!response.ok) {
      return {
        available: false,
        serverRunning: false,
        baseUrl,
        model,
        modelAvailable: false,
        models: [],
        exePath: null,
        exeExists: false,
        canAutoStart: false,
        gpuMode,
        numGpu,
        gpuBackend,
        gpuLoadLimitPercent,
        numBatch,
        maxParallel,
        gpuConfirmed: false,
        computeBackend: "unknown",
        gpuProbeStatus: "not_run",
        gpuFailureReason: "Web/dev nie potwierdza GPU z logów Ollama. AI pozostaje wyłączona bez desktopowego probe GPU.",
        logEvidence: [],
        error: `HTTP ${response.status}`,
      };
    }
    const models = parseOllamaModels(await response.json());
    const effectiveModel = chooseEffectiveOllamaModel(model, models, explicitModel || envModel);
    return {
      available: true,
      serverRunning: true,
      baseUrl,
      model: effectiveModel,
      modelAvailable: models.some((entry) => entry.name === effectiveModel),
      models,
      exePath: null,
      exeExists: false,
      canAutoStart: false,
      gpuMode,
      numGpu,
      gpuBackend,
      gpuLoadLimitPercent,
      numBatch,
      maxParallel,
      gpuConfirmed: false,
      computeBackend: "unknown",
      gpuProbeStatus: "not_run",
      gpuFailureReason: "Web/dev nie potwierdza GPU z logów Ollama. AI pozostaje wyłączona bez desktopowego probe GPU.",
      logEvidence: [],
      error: null,
    };
  } catch (error) {
    return {
      available: false,
      serverRunning: false,
      baseUrl,
      model,
      modelAvailable: false,
      models: [],
      exePath: null,
      exeExists: false,
      canAutoStart: false,
      gpuMode,
      numGpu,
      gpuBackend,
      gpuLoadLimitPercent,
      numBatch,
      maxParallel,
      gpuConfirmed: false,
      computeBackend: "unknown",
      gpuProbeStatus: "not_run",
      gpuFailureReason: "Web/dev nie potwierdza GPU z logów Ollama. AI pozostaje wyłączona bez desktopowego probe GPU.",
      logEvidence: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function createInvestAnalyzerServer(options: InvestAnalyzerServerOptions = {}) {
  const app = express();
  const workspaceRoot = options.workspaceRoot || process.cwd();
  const managedWriteLocks = new Map<string, Promise<void>>();
  const acquireManagedWriteLock = async (targetPath: string): Promise<() => void> => {
    const previous = managedWriteLocks.get(targetPath);
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    managedWriteLocks.set(targetPath, current);
    if (previous) await previous;
    return () => {
      if (managedWriteLocks.get(targetPath) === current) managedWriteLocks.delete(targetPath);
      release();
    };
  };
  const maskEnginePaths = (value: string): string => {
    const roots = [
      { root: path.resolve(workspaceRoot), marker: "<repozytorium>" },
      { root: path.resolve(process.cwd()), marker: "<repozytorium>" },
      { root: os.homedir(), marker: "<katalog domowy>" },
    ].sort((a, b) => b.root.length - a.root.length);
    return roots.reduce((result, { root, marker }) => {
      const pattern = root.split(/[/\\]/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[/\\\\]+");
      return result.replace(new RegExp(pattern, "gi"), marker);
    }, value);
  };
  const runtimeRoot = options.runtimeRoot;
  if (!runtimeRoot) pruneOrphanedRuntimeNamespaces();
  const taxEngineOutputDir = getTaxEngineRunOutputDir(workspaceRoot, runtimeRoot);
  const taxEngineCacheDir = getTaxEngineCacheDir(workspaceRoot, runtimeRoot);
  fs.mkdirSync(taxEngineCacheDir, { recursive: true });
  const workspaceIdentityPath = path.join(path.dirname(taxEngineCacheDir), "workspace-root.txt");
  if (!fs.existsSync(workspaceIdentityPath)) {
    try { fs.writeFileSync(workspaceIdentityPath, path.resolve(workspaceRoot), "utf8"); } catch { /* pamięć jest opcjonalna */ }
  }
  const taxEngineRateLimit = new Map<string, { count: number; resetAt: number }>();
  const activeTaxEngineRunDirs = new Set<string>();
  const activeTaxEngineDownloadDirs = new Map<string, number>();
  // Katalogi udanych przebiegow. Przebieg znika z aktywnych przy zakonczeniu
  // procesu, a metadane pamieci podrecznej powstaja dopiero po wyslaniu wyniku -
  // pobranie artefaktu w tym oknie (albo po nieudanym zapisie pamieci) dostawalo
  // 403, choc katalog istnial. Tylko nazwy, bez ochrony przed retencja.
  const ukonczonePrzebiegi = new Set<string>();
  const zapamietajUkonczonyPrzebieg = (katalog: string) => {
    ukonczonePrzebiegi.delete(katalog);
    ukonczonePrzebiegi.add(katalog);
    while (ukonczonePrzebiegi.size > 50) ukonczonePrzebiegi.delete(ukonczonePrzebiegi.values().next().value as string);
  };

  app.use("/api", (req, res, next) => {
    const host = req.headers.host || "";
    if (!isAllowedLocalRequestHost(host)) {
      res.status(403).json({ success: false, error: "API jest dostępne tylko przez adres lokalny." });
      return;
    }
    // GET nie ma kontroli Origin, a obca strona moze go wywolac (no-cors) i
    // obciazyc dostawcow notowan. Wlasny front jest same-origin (takze vite dev
    // w trybie middleware i devUrl Tauri), wiec nie wysyla cross-site.
    if (req.method === "GET" && req.headers["sec-fetch-site"] === "cross-site") {
      res.status(403).json({ success: false, error: "Żądanie API pochodzi z innej witryny." });
      return;
    }
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
      const origin = req.headers.origin;
      const expectedOrigin = new URL(`http://${host}`).origin;
      if (origin ? origin !== expectedOrigin : req.headers["sec-fetch-site"] !== undefined
        && !["same-origin", "none"].includes(String(req.headers["sec-fetch-site"]))) {
        res.status(403).json({ success: false, error: "Żądanie API pochodzi z innej witryny." });
        return;
      }
    }
    next();
  });

  // Wgrywanie plikow do magazynu ma wlasny, duzo wyzszy limit. Wyciag brokerski
  // z kilku lat po zakodowaniu base64 rosnie o jedna trzecia i spokojnie
  // przekracza 2 MB - przy wspolnym limicie konczylo sie surowym bledem 413
  // bez wyjasnienia, co poszlo nie tak. Limit pliku to 32 MiB danych (jak w
  // desktopie), a zadanie moze niesc kilka takich plikow (128 MB base64), wiec
  // limit zadania jest wyzszy niz pojedynczego pliku.
  app.use("/api/storage/files", express.json({ limit: "128mb" }));
  // Kopia bezpieczenstwa niesie caly stan aplikacji (transakcje, nadpisania), wiec
  // 2 MB to za malo; wlasny limit ma tez wlasny komunikat 413.
  app.use("/api/backups", express.json({ limit: "32mb" }));
  app.use(express.json({ limit: "2mb" }));

  // Czytelny komunikat zamiast surowego bledu parsera zadania.
  app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    const kod = (error as { type?: string; status?: number } | null)?.type;
    if (kod === "entity.too.large") {
      const kopia = _req.originalUrl.startsWith("/api/backups");
      res.status(413).json({
        success: false,
        error: kopia
          ? "Kopia jest za duża (limit 32 MB)."
          : "Żądanie jest za duże. Podziel import na mniejsze paczki plików.",
      });
      return;
    }
    if (kod === "entity.parse.failed") {
      res.status(400).json({ success: false, error: "Treść żądania nie jest poprawnym JSON-em." });
      return;
    }
    next(error);
  });
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  app.use("/api/tax-engine/run", (req, res, next) => {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || "local";
    const entry = taxEngineRateLimit.get(key);
    if (!entry || entry.resetAt <= now) {
      taxEngineRateLimit.set(key, { count: 1, resetAt: now + 60_000 });
      next();
      return;
    }
    entry.count += 1;
    if (entry.count > 30) {
      res.status(429).json({ success: false, error: "Zbyt wiele uruchomień silnika w krótkim czasie. Spróbuj ponownie za chwilę." });
      return;
    }
    next();
  });

  // Portfel inwestora: kursy NBP, notowania na zywo i integracje z brokerami.
  // Trasy musza byc zarejestrowane przed zbiorczym 404 dla /api.
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", time: new Date().toISOString() });
  });
  app.use("/api/nbp", nbpRouter);
  app.use("/api/brokers", brokersRouter);
  app.use("/api", quotesRouter);

  app.get("/api/ollama/status", async (req, res) => {
    res.json(await checkOllamaStatus(fetch, req.query));
  });

  app.get("/api/ollama/models", async (req, res) => {
    const status = await checkOllamaStatus(fetch, req.query);
    res.json(status.models);
  });

  app.post("/api/ollama/gpu-test", async (req, res) => {
    const status = await checkOllamaStatus(fetch, req.query);
    res.json({
      ...status,
      available: false,
      gpuConfirmed: false,
      computeBackend: "unknown",
      gpuProbeStatus: "fail",
      gpuFailureReason: "Web/dev nie ma dostępu do świeżych logów procesu Ollama, więc nie potwierdza GPU. Użyj aplikacji desktopowej do GPU-only AI.",
      logEvidence: [],
    });
  });

  app.post("/api/ollama/config", async (req, res) => {
    const config = normalizeOllamaConfig(req.body || {});
    res.json({ success: true, config });
  });

  app.post("/api/ollama/ensure", async (req, res) => {
    const status = await checkOllamaStatus(fetch, req.body || {});
    res.json({
      started: false,
      alreadyRunning: status.available,
      status,
      message: status.available
        ? "Ollama już działa."
        : "Web/dev nie uruchamia procesu Ollama. Autostart jest dostępny w aplikacji desktopowej.",
    });
  });

  app.post("/api/runtime/clear-app-data", async (req, res) => {
    if (!req.is("application/json") || req.body?.confirm !== "WYCZYSC_DANE_APLIKACJI") {
      res.status(400).json({ success: false, error: "Wyczyszczenie danych wymaga potwierdzenia w JSON." });
      return;
    }
    try {
      res.json({ success: true, ...(await clearWorkspaceAppData(workspaceRoot)) });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getServerErrorMessage(error, "Nie udało się wyczyścić danych aplikacji."),
      });
    }
  });

  // Kopie decyzji uzytkownika leza w dane/backupy - poza pamiecia przegladarki,
  // zeby przetrwaly jej wyczyszczenie.
  app.get("/api/backups", (_req, res) => {
    try {
      const backups = listBackupSnapshots(getBackupsRoot(workspaceRoot)).map(({ path: _path, ...backup }) => backup);
      res.json({ success: true, backups });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getServerErrorMessage(error, "Nie udało się odczytać listy kopii."),
      });
    }
  });

  app.post("/api/backups", (req, res) => {
    try {
      const snapshot = req.body?.snapshot;
      if (!snapshot || typeof snapshot !== "object") {
        res.status(400).json({ success: false, error: "Brak treści kopii w żądaniu." });
        return;
      }
      const { path: _path, ...backup } = writeBackupSnapshot(getBackupsRoot(workspaceRoot), snapshot);
      res.json({ success: true, backup });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getServerErrorMessage(error, "Nie udało się zapisać kopii."),
      });
    }
  });

  app.get("/api/backups/:id", (req, res) => {
    try {
      if (!isBackupId(req.params.id)) {
        res.status(400).json({ success: false, error: "Nieprawidłowy identyfikator kopii." });
        return;
      }
      res.json({ success: true, snapshot: readBackupSnapshot(getBackupsRoot(workspaceRoot), req.params.id) });
    } catch (error: unknown) {
      // Brakujacy plik kopii to 404, a nie awaria serwera. Kod bierzemy z oryginalnego bledu:
      // getServerErrorMessage usuwa komunikaty z kodami systemowymi (ENOENT), wiec po sanitacji juz go nie ma.
      const brakPliku = (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
      const message = brakPliku ? "Nie znaleziono kopii." : getServerErrorMessage(error, "Nie udało się odczytać kopii.");
      res.status(brakPliku ? 404 : 500).json({ success: false, error: message });
    }
  });

  app.post("/api/tax-engine/run", async (req, res) => {
    let reservedRunDir: string | null = null;
    try {
      const {
        year,
        runMode,
        taxPlan,
        packageScope,
        filingMode,
        includeFxConversionCosts,
        includeBankFundingFees,
        includeInterestCosts,
        includeAccountFees,
        fundingFees,
        priorYearLosses,
        cryptoCostsCarriedForward,
        conditionalCostIds,
        excludedStorageFiles,
        manualFxOverrides,
        nbpAllowManualOverride,
        fundingFee,
        transactionOverrides,
        pit8cEntries,
        defenseEvidenceOverrides,
        brokerFileActionOverrides,
        reviewDecisions,
        sourceSelectionMode,
        selectedCandidateSourceId,
        aiNormalizerEnabled,
        aiNormalizerGpuMode,
        aiNormalizerNumGpu,
        aiNormalizerGpuBackend,
        aiNormalizerGpuLoadLimitPercent,
        aiNormalizerNumBatch,
        aiNormalizerMaxParallel,
        aiNormalizerGpuConfirmed,
        aiNormalizerComputeBackend,
        canonicalTaxInputMode,
        forceRecalculate,
      } = req.body;
      const validatedYear = validateTaxYear(year);
      const cacheTask = { ...req.body } as Record<string, unknown>;
      delete cacheTask.forceRecalculate;
      // Base64 całego zadania tworzyło na Windows ścieżkę dłuższą niż limit
      // systemu; prawidłowy JSON wyniku był wtedy błędnie zgłaszany jako
      // nieczytelny. Hash zachowuje pełny klucz bez przekazywania treści plików.
      const cacheKey = createHash('sha256').update(stableTaskFingerprint({
        storage: await storageMetadataFingerprint(workspaceRoot),
        engine: engineSourceFingerprint(workspaceRoot),
        year: validatedYear,
        task: cacheTask,
        // Wersja zasad zapisu do pamieci. Podnies ja przy zmianie tego, co wolno
        // zapamietac: wpisy zapisane wedlug starych zasad (np. wyniki z awarii
        // sieci NBP) maja wtedy inny klucz i nigdy nie sa zwracane.
        zasadyPamieci: ZASADY_PAMIECI_WYNIKOW,
      })).digest('hex');
      const cachePath = path.join(taxEngineCacheDir, `${cacheKey}.json`);
      if (forceRecalculate !== true && fs.existsSync(cachePath)) {
        try {
          const metadataPath = path.join(taxEngineCacheDir, `${cacheKey}.meta.json`);
          const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as { _runtimeOutputDir?: unknown; size?: unknown };
          const _runtimeOutputDir = metadata._runtimeOutputDir;
          if (typeof metadata.size === 'number' && fs.statSync(cachePath).size === metadata.size
            && typeof _runtimeOutputDir === 'string'
            && path.dirname(_runtimeOutputDir) === taxEngineOutputDir && fs.existsSync(_runtimeOutputDir)) {
            res.type('application/json');
            res.once('finish', () => setImmediate(() => {
              try {
                pruneTaxEngineCache(taxEngineCacheDir);
                const cachedRunDirs = getRecentTaxEngineCachedOutputDirs(taxEngineCacheDir, taxEngineOutputDir);
                pruneTaxEngineRunOutputDirs(taxEngineOutputDir, new Set([...activeTaxEngineRunDirs, ...activeTaxEngineDownloadDirs.keys(), ...cachedRunDirs]));
              } catch {
                // Sprzątanie po odpowiedzi nie może zakłócić trafienia cache.
              }
            }));
            const strumienWyniku = fs.createReadStream(cachePath);
            // Wpis moze zniknac miedzy sprawdzeniem a odczytem (retencja po
            // rownoleglym przebiegu). Nieobsluzony blad strumienia zamykal caly
            // proces serwera, a z nim kazda inna trwajaca operacje.
            strumienWyniku.on('error', () => {
              if (!res.headersSent) {
                res.status(503).json({ success: false, error: 'Wynik z pamięci zniknął w trakcie odczytu — przelicz ponownie.' });
              } else {
                res.destroy();
              }
            });
            strumienWyniku.pipe(res);
            return;
          }
        } catch {
          // Uszkodzony wpis nie jest wynikiem; kolejny przebieg go zastąpi.
        }
      }
      if (activeTaxEngineRunDirs.size >= 2) {
        return res.status(429).json({ success: false, error: 'Dwa przebiegi silnika już trwają. Poczekaj na ich zakończenie.' });
      }
      const runOutputDir = createTaxEngineRunOutputDir(workspaceRoot, cacheKey, runtimeRoot);
      activeTaxEngineRunDirs.add(runOutputDir);
      reservedRunDir = runOutputDir;
      const { spawn } = await import("child_process");
      const pythonExecutable = resolvePythonExecutable(workspaceRoot);
      const pythonEngineRoot = getPythonEngineRoot(workspaceRoot);
      const args = [
        path.join(pythonEngineRoot, "src/investment_tax_engine/app/cli.py"),
        "--year", String(validatedYear),
        "--run-mode", String(runMode || "SAFE"),
        "--tax-plan", String(taxPlan || "aggressive_user"),
        "--source-selection-mode", String(sourceSelectionMode || "canonical_stream"),
        "--canonical-tax-input-mode", String(canonicalTaxInputMode || "required"),
        "--out-dir", runOutputDir,
        // Katalog magazynu podajemy wprost. Bez tej flagi silnik szukal
        // katalogu "dane/pliki" w gore od wlasnego katalogu roboczego, wiec
        // liczyl z magazynu repozytorium nawet wtedy, gdy serwer dostal inny
        // workspaceRoot. Lista plikow w interfejsie pochodzila z jednego
        // katalogu, a rozliczenie z drugiego - i nic tego nie sygnalizowalo.
        "--storage-dir", getStorageRoot(workspaceRoot),
      ];
      let transactionOverridesTemp: RuntimeTempJson | null = null;
      let pit8cEntriesTemp: RuntimeTempJson | null = null;
      let defenseEvidenceOverridesTemp: RuntimeTempJson | null = null;
      let brokerFileActionOverridesTemp: RuntimeTempJson | null = null;
      let reviewDecisionsTemp: RuntimeTempJson | null = null;
      if (packageScope) {
        args.push("--package-scope", String(packageScope));
      }
      if (filingMode) {
        args.push("--filing-mode", String(filingMode));
      }
      if (typeof includeFxConversionCosts === "boolean") {
        args.push("--include-fx-conversion-costs", String(includeFxConversionCosts));
      }
      if (typeof includeBankFundingFees === "boolean") {
        args.push("--include-bank-funding-fees", String(includeBankFundingFees));
      }
      if (typeof includeInterestCosts === "boolean") {
        args.push("--include-interest-costs", String(includeInterestCosts));
      }
      if (typeof includeAccountFees === "boolean") {
        args.push("--include-account-fees", String(includeAccountFees));
      }
      const aiComputeBackend = String(aiNormalizerComputeBackend || "unknown").toLowerCase();
      const aiGpuConfirmed = aiNormalizerGpuConfirmed === true && aiComputeBackend === "gpu";
      const aiAllowCpu = false;
      const aiGpuRequired = true;
      const effectiveAiEnabled = aiNormalizerEnabled === true && aiGpuConfirmed;
      args.push("--ai-normalizer-enabled", effectiveAiEnabled ? "true" : "false");
      if (selectedCandidateSourceId) {
        args.push("--selected-candidate-source-id", String(selectedCandidateSourceId));
      }
      const normalizedFundingFees = Array.isArray(fundingFees) && fundingFees.length > 0
        ? fundingFees
        : (fundingFee?.amount && fundingFee?.date ? [fundingFee] : []);
      for (const entry of normalizedFundingFees) {
        args.push("--funding-fee-json", JSON.stringify({
          id: entry.id,
          amount: entry.amount,
          // Brak waluty nie jest kwotą w PLN. Silnik ma ją odrzucić jako
          // niepełną daną zamiast tworzyć fałszywy koszt.
          currency: entry.currency,
          date: entry.date,
          depositId: entry.depositId,
          depositAmount: entry.depositAmount,
          evidenceNote: entry.evidenceNote,
        }));
      }
      // Straty z lat ubieglych podaje uzytkownik; limit ustawowy nalicza silnik.
      for (const entry of Array.isArray(priorYearLosses) ? priorYearLosses : []) {
        if (!entry?.taxYear || !entry?.amountPln) continue;
        args.push("--prior-year-loss-json", JSON.stringify({
          taxYear: entry.taxYear,
          amountPln: entry.amountPln,
          remainingPln: entry.remainingPln,
          accepted: entry.accepted,
        }));
      }
      // Koszty nabycia krypto z lat ubieglych. Czesc E przenosi nadwyzke na rok
      // nastepny, a silnik nie zna rozliczen sprzed okresu objetego danymi.
      const kosztyKrypto = String(cryptoCostsCarriedForward ?? "").trim();
      if (kosztyKrypto) {
        args.push("--crypto-costs-carried-forward", kosztyKrypto);
      }
      // Pliki wylaczone przez uzytkownika z rozliczenia. Bez tego przelacznik
      // w liscie plikow zmienialby wylacznie wyglad, a silnik liczylby dalej z
      // kompletu - tak dzialal do tej pory.
      for (const fileName of Array.isArray(excludedStorageFiles) ? excludedStorageFiles : []) {
        const cleaned = String(fileName || "").trim();
        if (cleaned) args.push("--exclude-file", cleaned);
      }
      // Koszty wskazane recznie przez uzytkownika do ujecia w planie agresywnym.
      for (const costId of Array.isArray(conditionalCostIds) ? conditionalCostIds : []) {
        const cleaned = String(costId || "").trim();
        if (cleaned) args.push("--conditional-cost-id", cleaned);
      }
      // Reczna korekta kursu dziala tylko przy jawnej zgodzie uzytkownika.
      if (manualFxOverrides && typeof manualFxOverrides === "object" && !Array.isArray(manualFxOverrides)) {
        for (const [key, value] of Object.entries(manualFxOverrides as Record<string, unknown>)) {
          const rate = String(value ?? "").trim();
          if (key.trim() && rate) args.push("--manual-fx-override", `${key.trim()}=${rate}`);
        }
      }
      if (nbpAllowManualOverride === true) {
        args.push("--nbp-allow-manual-override", "true");
      }
      if (Array.isArray(transactionOverrides)) {
        transactionOverridesTemp = writeRuntimeTempJsonSync("investment-tax-engine-overrides", transactionOverrides);
        args.push("--transaction-overrides-json-path", transactionOverridesTemp.filePath);
      }
      if (Array.isArray(pit8cEntries) && pit8cEntries.length > 0) {
        pit8cEntriesTemp = writeRuntimeTempJsonSync("investment-tax-engine-pit8c", pit8cEntries);
        args.push("--pit8c-json-path", pit8cEntriesTemp.filePath);
      }
      if (Array.isArray(defenseEvidenceOverrides)) {
        defenseEvidenceOverridesTemp = writeRuntimeTempJsonSync(
          "investment-tax-engine-defense-evidence-overrides",
          defenseEvidenceOverrides,
        );
        args.push("--defense-evidence-overrides-json-path", defenseEvidenceOverridesTemp.filePath);
      }
      if (Array.isArray(brokerFileActionOverrides)) {
        brokerFileActionOverridesTemp = writeRuntimeTempJsonSync(
          "investment-tax-engine-broker-file-action-overrides",
          brokerFileActionOverrides,
        );
        args.push("--broker-file-action-overrides-json-path", brokerFileActionOverridesTemp.filePath);
      }

      // Decyzje uzytkownika o zdarzeniach czekajacych na rozstrzygniecie.
      if (Array.isArray(reviewDecisions) && reviewDecisions.length > 0) {
        const czyste = reviewDecisions
          .filter((wpis: unknown): wpis is { decisionKey: string; decision: string } =>
            Boolean(wpis) && typeof wpis === "object" &&
            typeof (wpis as { decisionKey?: unknown }).decisionKey === "string" &&
            typeof (wpis as { decision?: unknown }).decision === "string")
          .map((wpis) => ({ decisionKey: wpis.decisionKey, decision: wpis.decision }));
        reviewDecisionsTemp = writeRuntimeTempJsonSync("investment-tax-engine-review-decisions", czyste);
        args.push("--review-decisions-json-path", reviewDecisionsTemp.filePath);
      }

      const requestedAiGpuMode = String(aiNormalizerGpuMode || process.env.INVEST_OLLAMA_GPU_MODE || "gpu").toLowerCase();
      const aiGpuMode = ["gpu", "auto"].includes(requestedAiGpuMode) ? requestedAiGpuMode : "gpu";
      const parsedAiNumGpu = Number(aiNormalizerNumGpu ?? process.env.INVEST_OLLAMA_NUM_GPU ?? (aiGpuMode === "gpu" ? -1 : ""));
      const aiNumGpu = Number.isInteger(parsedAiNumGpu) ? String(parsedAiNumGpu === 0 ? -1 : parsedAiNumGpu) : "";
      const requestedAiGpuBackend = String(aiNormalizerGpuBackend || process.env.INVEST_OLLAMA_GPU_BACKEND || "vulkan").toLowerCase();
      const aiGpuBackend = ["vulkan", "rocm", "cuda", "auto"].includes(requestedAiGpuBackend) ? requestedAiGpuBackend : "vulkan";
      const parsedAiGpuLimit = Number(aiNormalizerGpuLoadLimitPercent ?? process.env.INVEST_OLLAMA_GPU_LOAD_LIMIT_PERCENT ?? 85);
      const aiGpuLimit = Number.isFinite(parsedAiGpuLimit) ? String(Math.min(95, Math.max(50, Math.round(parsedAiGpuLimit)))) : "85";
      const parsedAiNumBatch = Number(aiNormalizerNumBatch ?? process.env.INVEST_OLLAMA_NUM_BATCH ?? (Number(aiGpuLimit) <= 85 ? 128 : 256));
      const aiNumBatch = Number.isInteger(parsedAiNumBatch) && parsedAiNumBatch > 0 ? String(parsedAiNumBatch) : "128";
      const parsedAiMaxParallel = Number(aiNormalizerMaxParallel ?? process.env.OLLAMA_NUM_PARALLEL ?? 1);
      const aiMaxParallel = Number.isInteger(parsedAiMaxParallel) && parsedAiMaxParallel > 0 ? String(Math.min(2, parsedAiMaxParallel)) : "1";
      const pythonProcess = spawn(pythonExecutable, args, {
        env: {
          ...process.env,
          PYTHONPATH: path.join(pythonEngineRoot, "src"),
          INVEST_AI_NORMALIZER_ENABLED: effectiveAiEnabled ? "true" : "false",
          INVEST_OLLAMA_GPU_REQUIRED: aiGpuRequired ? "true" : "false",
          INVEST_OLLAMA_GPU_CONFIRMED: aiGpuConfirmed ? "true" : "false",
          INVEST_OLLAMA_ALLOW_CPU_AI: aiAllowCpu ? "true" : "false",
          INVEST_OLLAMA_COMPUTE_BACKEND: aiComputeBackend,
          INVEST_OLLAMA_GPU_MODE: aiGpuMode,
          INVEST_OLLAMA_GPU_BACKEND: aiGpuBackend,
          INVEST_OLLAMA_GPU_LOAD_LIMIT_PERCENT: aiGpuLimit,
          INVEST_OLLAMA_NUM_BATCH: aiNumBatch,
          INVEST_OLLAMA_REQUEST_COOLDOWN_MS: "250",
          OLLAMA_NUM_PARALLEL: aiMaxParallel,
          OLLAMA_MAX_LOADED_MODELS: "1",
          ...(aiNumGpu ? { INVEST_OLLAMA_NUM_GPU: aiNumGpu } : {}),
        },
      });

      let outputData = "";
      let errorData = "";

      pythonProcess.stdout.on("data", (chunk) => {
        outputData += chunk.toString();
      });

      pythonProcess.stderr.on("data", (chunk) => {
        errorData += chunk.toString();
      });

      let responded = false;
      const configuredTimeout = Number(process.env.INVEST_TAX_ENGINE_TIMEOUT_MS);
      const runTimeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 15 * 60_000;
      let stopReason: string | null = null;
      let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
      const stopRun = (reason: string) => {
        if (responded || stopReason) return;
        stopReason = reason;
        pythonProcess.kill();
        forceKillTimer = setTimeout(() => pythonProcess.kill('SIGKILL'), 5_000);
        forceKillTimer.unref?.();
      };
      const runTimer = setTimeout(() => stopRun(`Przekroczono limit czasu silnika (${Math.round(runTimeoutMs / 1000)} s).`), runTimeoutMs);
      runTimer.unref?.();
      const onRequestClose = () => {
        if (!res.writableEnded) stopRun('Żądanie zostało przerwane.');
      };
      res.on('close', onRequestClose);
      const cleanupTemp = () => {
        clearTimeout(runTimer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        res.off('close', onRequestClose);
        transactionOverridesTemp?.cleanup();
        transactionOverridesTemp = null;
        pit8cEntriesTemp?.cleanup();
        pit8cEntriesTemp = null;
        defenseEvidenceOverridesTemp?.cleanup();
        defenseEvidenceOverridesTemp = null;
        brokerFileActionOverridesTemp?.cleanup();
        brokerFileActionOverridesTemp = null;
        reviewDecisionsTemp?.cleanup();
        reviewDecisionsTemp = null;
      };

      pythonProcess.on("error", (error) => {
        console.error("[silnik] nie udało się uruchomić Pythona:", error);
        cleanupTemp();
        activeTaxEngineRunDirs.delete(runOutputDir);
        reservedRunDir = null;
        fs.rmSync(runOutputDir, { recursive: true, force: true });
        if (!responded) {
          responded = true;
          if (!res.destroyed) res.status(500).json({ success: false, errorCode: "ENGINE_FAILED", error: maskEnginePaths(`Nie udało się uruchomić Pythona: ${error.message}`) });
        }
      });

      pythonProcess.on("close", (code) => {
        cleanupTemp();
        activeTaxEngineRunDirs.delete(runOutputDir);
        reservedRunDir = null;
        if (responded) {
          return;
        }
        responded = true;
        if (stopReason) {
          fs.rmSync(runOutputDir, { recursive: true, force: true });
          if (!res.destroyed) res.status(stopReason.startsWith('Przekroczono') ? 504 : 499).json({ success: false, error: stopReason });
          return;
        }
        // Pelny stderr (traceback z nazwami plikow wyciagow i wartosciami) trafia
        // wylacznie do pliku w katalogu przebiegu - nie do konsoli ani odpowiedzi.
        const runId = path.basename(runOutputDir);
        const zapiszLogPrzebiegu = (nazwa: string, tresc: string) => {
          if (!tresc) return;
          try {
            fs.mkdirSync(runOutputDir, { recursive: true });
            fs.writeFileSync(path.join(runOutputDir, nazwa), tresc, "utf8");
          } catch {
            // Brak logu nie moze zmienic odpowiedzi.
          }
        };
        // Katalog przebiegu z logiem tez podlega retencji: seria awarii nie moze rosnac bez limitu.
        const sprzatnijPoOdpowiedzi = () => res.once('finish', () => setImmediate(() => {
          try {
            const cachedRunDirs = getRecentTaxEngineCachedOutputDirs(taxEngineCacheDir, taxEngineOutputDir);
            pruneTaxEngineRunOutputDirs(taxEngineOutputDir, new Set([...activeTaxEngineRunDirs, ...activeTaxEngineDownloadDirs.keys(), ...cachedRunDirs]));
          } catch {
            // Sprzątanie po odpowiedzi nie może zmienić wysłanej odpowiedzi.
          }
        }));
        zapiszLogPrzebiegu("stderr.log", errorData);
        if (code !== 0) {
          sprzatnijPoOdpowiedzi();
          // CLI opisuje awarie JSON-em na stdout (komunikat i wskazowka), a na stderr
          // zostawia traceback dla dziennika. Uzytkownik dostawal dotad sam traceback
          // ze sciezkami plikow zamiast zdania, co poprawic.
          const opis = opisAwariiSilnika(outputData);
          console.error(`[silnik] przebieg ${runId} zakończony kodem ${code}${opis?.code ? `, błąd ${opis.code}` : ""}; pełny stderr w pliku stderr.log tego przebiegu.`);
          const bladWpisu = opis?.code === "BladDanychWejsciowych";
          res.status(bladWpisu ? 400 : 500).json({
            success: false,
            errorCode: bladWpisu ? "ENGINE_INPUT_INVALID" : "ENGINE_FAILED",
            error: maskEnginePaths(opis
              ? [opis.message, opis.hint].filter(Boolean).join(" ")
              : `Silnik zakończył się błędem (kod ${code}). Szczegóły w pliku stderr.log przebiegu ${runId}.`),
            runId,
          });
        } else {
          try {
            const result = JSON.parse(outputData);
            const response = { success: true, ...result };
            zapamietajUkonczonyPrzebieg(runOutputDir);
            fs.mkdirSync(taxEngineCacheDir, { recursive: true });
            const zapisDoPamieci = !wynikMaProblemNbp(result);
            res.once('finish', () => setImmediate(() => {
              if (zapisDoPamieci) {
                try {
                  const cachedResponse = { ...response, cached: true };
                  const serialized = JSON.stringify(cachedResponse);
                  const metadataPath = path.join(taxEngineCacheDir, `${cacheKey}.meta.json`);
                  fs.rmSync(metadataPath, { force: true });
                  if (writeCacheFileAtomically(cachePath, serialized) && writeCacheFileAtomically(metadataPath, JSON.stringify({
                    _runtimeOutputDir: runOutputDir,
                    createdAt: Date.now(),
                    size: Buffer.byteLength(serialized),
                  }))) pruneTaxEngineCache(taxEngineCacheDir);
                } catch {
                  // Zapis pamięci nie może zmienić wysłanej odpowiedzi.
                }
              }
              try {
                const cachedRunDirs = getRecentTaxEngineCachedOutputDirs(taxEngineCacheDir, taxEngineOutputDir);
                pruneTaxEngineRunOutputDirs(taxEngineOutputDir, new Set([...activeTaxEngineRunDirs, ...activeTaxEngineDownloadDirs.keys(), ...cachedRunDirs]));
              } catch {
                // Retencja nie może zmienić wysłanej odpowiedzi.
              }
            }));
            res.json({ ...response, cached: false });
          } catch {
            zapiszLogPrzebiegu("stdout.log", outputData);
            sprzatnijPoOdpowiedzi();
            // Silnik zakonczyl sie kodem 0, ale jego wyniku nie da sie odczytac.
            // Wczesniej szlo stad `success: true` BEZ zadnej kwoty - klient
            // widzial udane przeliczenie i budowal z brakujacych pol
            // podsumowanie zlozone z zer, czyli podatek 0,00 zl jako wynik.
            res.status(502).json({
              success: false,
              errorCode: "ENGINE_OUTPUT_UNREADABLE",
              error:
                "Silnik zakończył pracę, ale jego wyniku nie da się odczytać jako JSON. " +
                "Rozliczenie NIE zostało policzone - to nie znaczy, że podatek wynosi zero.",
              runId,
            });
          }
        }
      });
    } catch (error: unknown) {
      if (reservedRunDir) {
        activeTaxEngineRunDirs.delete(reservedRunDir);
        fs.rmSync(reservedRunDir, { recursive: true, force: true });
      }
      const message = getServerErrorMessage(error, "Nie udało się uruchomić silnika.");
      // Uzytkownik dostaje ogolny komunikat, ale przyczyna musi trafic do logu
      // serwera - inaczej nieudany start przebiegu nie zostawial zadnego sladu.
      if (message === "Nie udało się uruchomić silnika.") {
        console.error("[silnik] nie udało się uruchomić przebiegu:", error);
      }
      res.status(getServerErrorStatus(message)).json({ success: false, error: message });
    }
  });

  app.get("/api/tax-engine/download", async (req, res) => {
    try {
      const rawPath = String(req.query.path || "");
      if (!rawPath) {
        return res.status(400).json({ success: false, error: "Missing artifact path." });
      }

      const resolvedArtifactPath = path.resolve(rawPath);
      const allowedRoots = [path.resolve(taxEngineOutputDir)];
      const isWithinAllowedRoot = allowedRoots.some((rootPath) => (
        resolvedArtifactPath === rootPath ||
        resolvedArtifactPath.startsWith(`${rootPath}${path.sep}`)
      ));

      if (!isWithinAllowedRoot) {
        return res.status(403).json({ success: false, error: "Artifact path is outside allowed runtime directories." });
      }
      const relativeArtifactPath = path.relative(path.resolve(taxEngineOutputDir), resolvedArtifactPath);
      const pathParts = relativeArtifactPath.split(path.sep);
      const runDir = path.join(path.resolve(taxEngineOutputDir), pathParts[0] || '');
      const knownRunDirs = new Set([...activeTaxEngineRunDirs, ...activeTaxEngineDownloadDirs.keys(), ...ukonczonePrzebiegi,
        ...getRecentTaxEngineCachedOutputDirs(taxEngineCacheDir, taxEngineOutputDir, Date.now(), Number.POSITIVE_INFINITY)]);
      if (pathParts.length < 2 || !knownRunDirs.has(runDir)) {
        return res.status(403).json({ success: false, error: 'Artefakt nie należy do wskazanego przebiegu silnika.' });
      }
      // Logi przebiegu (stderr.log, stdout.log) to diagnostyka serwera z tracebackiem i nazwami wyciagow,
      // nie artefakt rozliczenia - nie sa wydawane przez przegladarke.
      if (/\.log$/i.test(resolvedArtifactPath)) {
        return res.status(403).json({ success: false, error: "Logi przebiegu nie są udostępniane do pobrania." });
      }
      if (!fs.existsSync(resolvedArtifactPath) || !fs.statSync(resolvedArtifactPath).isFile()) {
        if (knownRunDirs.has(runDir) && !fs.existsSync(runDir)) {
          return res.status(410).json({ success: false, error: "Pliki tego przebiegu zostały usunięte — przelicz ponownie" });
        }
        return res.status(404).json({ success: false, error: "Artifact not found." });
      }

      const realArtifactPath = fs.realpathSync(resolvedArtifactPath);
      const realAllowedRoots = allowedRoots.filter((rootPath) => fs.existsSync(rootPath)).map((rootPath) => fs.realpathSync(rootPath));
      const realRunDir = fs.realpathSync(runDir);
      if (!realAllowedRoots.some((rootPath) => realArtifactPath.startsWith(`${rootPath}${path.sep}`))
        || !realArtifactPath.startsWith(`${realRunDir}${path.sep}`)) {
        return res.status(403).json({ success: false, error: "Artifact path is outside allowed runtime directories." });
      }

      const reservedDownloadDir = runDir;
      if (reservedDownloadDir) activeTaxEngineDownloadDirs.set(reservedDownloadDir, (activeTaxEngineDownloadDirs.get(reservedDownloadDir) ?? 0) + 1);
      let released = false;
      const releaseDownloadDir = () => {
        if (released) return;
        released = true;
        if (reservedDownloadDir) {
          const remaining = (activeTaxEngineDownloadDirs.get(reservedDownloadDir) ?? 1) - 1;
          if (remaining > 0) activeTaxEngineDownloadDirs.set(reservedDownloadDir, remaining);
          else activeTaxEngineDownloadDirs.delete(reservedDownloadDir);
        }
      };
      res.once("close", releaseDownloadDir);
      res.once("finish", releaseDownloadDir);
      res.download(realArtifactPath, path.basename(resolvedArtifactPath), (error) => {
        releaseDownloadDir();
        if (error) {
          if (!res.headersSent) res.status(500).json({ success: false, error: getServerErrorMessage(error, "Nie udało się pobrać artefaktu.") });
          else res.destroy(error);
        }
      });
    } catch (error: unknown) {
      res.status(500).json({ success: false, error: getServerErrorMessage(error, "Nie udało się pobrać artefaktu.") });
    }
  });

  app.get("/api/storage/files", async (_req, res) => {
    try {
      const files = await listStorageFiles(workspaceRoot);
      res.json({ success: true, files });
    } catch (error: unknown) {
      // Blad odczytu wychodzil ze statusem 200 - dla posrednikow i klienta to
      // udane zadanie, a lista plikow byla po prostu pusta.
      res.status(500).json({
        success: false,
        error: getServerErrorMessage(error, "Nie udało się odczytać listy plików storage."),
      });
    }
  });

  app.post("/api/storage/files", async (req, res) => {
    try {
      const files = req.body?.files;
      if (!Array.isArray(files)) {
        res.status(400).json({ success: false, error: "Missing or invalid 'files' array." });
        return;
      }
      if (files.length > 50) {
        res.status(400).json({ success: false, error: "Zbyt wiele plików (limit 50)." });
        return;
      }

      const imported: any[] = [];
      const skipped: any[] = [];
      const failed: any[] = [];
      const warnings: string[] = [];
      
      const storageRoot = getStorageRoot(workspaceRoot);
      const fsPromises = await import("fs/promises");
      assertStoragePathSafe(workspaceRoot, storageRoot);
      await fsPromises.mkdir(storageRoot, { recursive: true });

      for (const file of files) {
        if (!file || typeof file !== 'object' || Array.isArray(file)) {
          failed.push({
            fileName: "nieznany",
            relativePath: "nieznany",
            errorCode: "INVALID_FILE_OBJECT",
            message: "Element w tablicy files nie jest obiektem.",
            recoverable: false
          });
          continue;
        }
        
        const rawFileName = typeof file.fileName === 'string' ? file.fileName : "";
        if (!rawFileName || rawFileName.includes('\0') || rawFileName.length > 255 || rawFileName.replace(/\./g, '').length === 0) {
          failed.push({
            fileName: rawFileName.substring(0, 50) || "nieznany",
            relativePath: "nieznany",
            errorCode: "INVALID_FILE_NAME",
            message: "Nazwa pliku jest pusta, za długa, lub zawiera niedozwolone znaki.",
            recoverable: false
          });
          continue;
        }

        if (file.relativePath !== undefined && typeof file.relativePath !== 'string') {
          failed.push({
            fileName: rawFileName,
            relativePath: "nieznany",
            errorCode: "INVALID_RELATIVE_PATH",
            message: "Ścieżka relativePath musi być tekstem.",
            recoverable: false
          });
          continue;
        }

        // Przed sprawdzeniem znakow i dekodowaniem (jak w desktopie): 32 MiB danych
        // na plik. Kontrola znakow bez grupy powtarzanej: dawny regex (?:[A-Za-z0-9+/]{4})*\n        // przepelnial stos na pliku kilkudziesieciu MB i konczyl sie 500.
        if (typeof file.base64 === 'string' && file.base64.length > MAX_BASE64_NA_PLIK) {
          failed.push({
            fileName: rawFileName,
            relativePath: String(file.relativePath || rawFileName),
            errorCode: "FILE_TOO_LARGE",
            message: `Plik jest zbyt duży (limit ${MAX_MIB_NA_PLIK} MiB na plik).`,
            recoverable: false
          });
          continue;
        }
        if (typeof file.base64 !== 'string' || file.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64)) {
          failed.push({
            fileName: rawFileName,
            relativePath: String(file.relativePath || rawFileName),
            errorCode: "INVALID_BASE64",
            message: "Brak poprawnej zawartości base64.",
            recoverable: false
          });
          continue;
        }


        const rawRelativePath = String(file.relativePath || rawFileName).trim();
        
        let safeFileName = rawFileName.replace(/^[.\\/]+|[\\/]+/g, '_');
        if (!safeFileName) safeFileName = 'plik';

        let relativePath = rawRelativePath.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\//, '');
        const isUnsafe = relativePath.split('/').some((p: string) => p === '..' || p === '.' || p === '') || /^[a-zA-Z]:/.test(relativePath);
        if (isUnsafe) {
          relativePath = safeFileName;
        }

        try {
          if (!isAllowedStorageExtension(relativePath)) {
            const ext = path.extname(relativePath).slice(1).toLowerCase();
            const err = new Error(ext ? `Rozszerzenie .${ext} nie jest obsługiwane przy imporcie. Dozwolone: ${ALLOWED_STORAGE_EXTENSIONS.join(', ')}.` : "Plik bez rozszerzenia nie moze zostac zaimportowany.");
            (err as any).errorCode = 'UNSUPPORTED_FILE_TYPE';
            throw err;
          }

          const targetPath = path.resolve(storageRoot, relativePath);
          if (targetPath === storageRoot || !targetPath.startsWith(`${storageRoot}${path.sep}`)) {
            const err = new Error('Target path escapes allowed directory.');
            (err as any).errorCode = 'PATH_TRAVERSAL_BLOCKED';
            throw err;
          }

          const targetDir = path.dirname(targetPath);
          assertStoragePathSafe(workspaceRoot, targetPath);
          await fsPromises.mkdir(targetDir, { recursive: true });
          assertStoragePathSafe(workspaceRoot, targetPath);

          const bytes = Buffer.from(file.base64 || "", "base64");
          
          const crypto = await import("crypto");
          let finalTargetPath = targetPath;
          let finalRelativePath = relativePath;
          let fileExtension = path.extname(targetPath);
          let fileStem = path.basename(targetPath, fileExtension);
          const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
          
          const nadpisz = file.overwrite === true && PLIKI_NADPISYWANE_W_MIEJSCU.has(relativePath);
          const releaseManagedWriteLock = nadpisz ? await acquireManagedWriteLock(targetPath) : undefined;
          try {
          let fileExists = false;
          try {
            await fsPromises.access(targetPath);
            fileExists = true;
          } catch {
            // Does not exist
          }

          // Pliki zarzadzane przez aplikacje podmieniamy w miejscu. Bez tego
          // kazde przeliczenie zostawialoby kolejna kopie, a silnik liczylby
          // te same transakcje po wielokroc. Tylko te: wyciag wgrany przez
          // uzytkownika bywa jedyna kopia, wiec sama flaga od klienta nie moze
          // go zastapic - dostaje kopie ze znacznikiem czasu jak kazdy plik.
          if (fileExists && nadpisz) {
            // Eksport Freedom24 jest źródłem podatkowym: wolno go odświeżyć w
            // miejscu, lecz poprzednia wersja musi zostać zachowana poza
            // magazynem skanowanym przez silnik.
            if (PLIKI_EKSPORTU_FREEDOM24.has(relativePath)) {
              const backupRoot = getBackupsRoot(workspaceRoot);
              await fsPromises.mkdir(backupRoot, { recursive: true });
              const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
              if (await zachowajPoprzedniaWersjeEksportu(backupRoot, targetPath, bytes, timestamp)) {
                warnings.push('Previous Freedom24 export copied to backupy before update.');
              }
            }
            fileExists = false;
          }

          if (fileExists) {
            const existingBytes = await fsPromises.readFile(targetPath);
            const existingHash = crypto.createHash("sha256").update(existingBytes).digest("hex");
            const newHash = crypto.createHash("sha256").update(bytes).digest("hex");
            
            if (existingHash === newHash) {
              const stat = await fsPromises.stat(targetPath);
              skipped.push({
                relativePath: finalRelativePath,
                fileName: path.basename(finalTargetPath),
                extension: fileExtension || ".",
                sizeBytes: stat.size,
                modifiedAt: stat.mtime.toISOString(),
                sha256: existingHash,
                sourceStatus: "unknown"
              });
              continue;
            }
            
            warnings.push(`File already exists and differs, writing timestamped copy: ${relativePath}`);
            finalTargetPath = path.join(targetDir, `${fileStem}-${timestamp}${fileExtension}`);
            finalRelativePath = path.relative(storageRoot, finalTargetPath).replace(/\\/g, '/');
          }

          // Zapis atomowy: najpierw plik tymczasowy obok, potem podmiana nazwy.
          // Silnik skanuje ten katalog w tle, a przy zwyklym zapisie moglby
          // trafic na plik w polowie zapisany i przerwac przebieg bledem
          // skladni JSON. Zmiana nazwy w obrebie jednego katalogu jest
          // niepodzielna, wiec silnik widzi albo stara, albo nowa wersje.
          const sciezkaTymczasowa = path.join(targetDir, `.${randomUUID()}.tmp`);
          try {
            await fsPromises.writeFile(sciezkaTymczasowa, bytes, { flag: 'wx' });
            if (nadpisz && !fileExists) {
              assertStoragePathSafe(workspaceRoot, finalTargetPath);
              await fsPromises.rename(sciezkaTymczasowa, finalTargetPath);
            } else {
              let collision = 0;
              while (true) {
                assertStoragePathSafe(workspaceRoot, finalTargetPath);
                try {
                  await fsPromises.link(sciezkaTymczasowa, finalTargetPath);
                  break;
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                  collision += 1;
                  finalTargetPath = path.join(targetDir, `${fileStem}-${timestamp}-${collision}${fileExtension}`);
                  finalRelativePath = path.relative(storageRoot, finalTargetPath).replace(/\\/g, '/');
                }
              }
              await fsPromises.unlink(sciezkaTymczasowa);
            }
          } catch (bladZapisu) {
            await fsPromises.rm(sciezkaTymczasowa, { force: true }).catch(() => undefined);
            throw bladZapisu;
          }
          const stat = await fsPromises.stat(finalTargetPath);
          
          imported.push({
            relativePath: finalRelativePath,
            fileName: path.basename(finalTargetPath),
            extension: path.extname(finalTargetPath) || ".",
            sizeBytes: stat.size,
            modifiedAt: stat.mtime.toISOString(),
            sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
            sourceStatus: "unknown"
          });
          } finally {
            releaseManagedWriteLock?.();
          }
        } catch (error: any) {
          const msg = getServerErrorMessage(error);
          warnings.push(`${safeFileName}: ${msg}`);
          failed.push({
            fileName: safeFileName,
            relativePath,
            errorCode: error.errorCode || (error.code === 'ENOENT' ? 'STORAGE_NOT_FOUND' : 'STORAGE_PERMISSION_DENIED'),
            message: msg,
            recoverable: false
          });
        }
      }

      res.json({ success: true, imported, skipped, failed, warnings });
    } catch (error: unknown) {
      const message = getServerErrorMessage(error, "Nie udało się zaimportować plików.");
      res.status(getServerErrorStatus(message)).json({ success: false, error: message });
    }
  });

  app.get("/api/storage/files/*", async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    try {
      const filename = String(req.params[0] || "");
      const storagePath = resolveStorageFilePath(workspaceRoot, filename);

      const fs = await import("fs/promises");
      const stat = await fs.stat(storagePath);
      const extension = path.extname(storagePath).toLowerCase();
      // Zaimportowany HTML/XML/SVG nie moze wykonac skryptu pod originem aplikacji
      // (localStorage z kluczami brokerow, /api). PDF bez piaskownicy, bo ta
      // wylacza wbudowany podglad PDF w przegladarce.
      if (extension !== ".pdf") {
        res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
      }

      if (!stat.isFile()) {
        return res.status(404).json({ success: false, error: `Plik storage nie istnieje albo nie jest zwykłym plikiem: ${filename}.` });
      }
      if (!/^(\.json|\.csv|\.tsv|\.txt|\.pdf|\.xlsx|\.xlsm|\.xls|\.zip)$/.test(extension)) {
        res.attachment(path.basename(storagePath));
      }

      if (extension === ".json") {
        const content = (await fs.readFile(storagePath, "utf-8")).replace(/^﻿/, "");
        try {
          JSON.parse(content);
          res.type("application/json").send(content);
        } catch {
          res.status(400).json({ error: `Nieprawidłowy JSON w pliku storage: ${filename}.` });
        }
      } else {
        res.sendFile(storagePath);
      }
    } catch (error: unknown) {
      const message = getServerErrorMessage(error, "Nie udało się odczytać pliku.");
      res.status(getServerErrorStatus(message)).json({ error: message });
    }
  });

  app.use("/api", (_req, res) => {
    res.status(404).json({ success: false, error: "Nieznany endpoint API." });
  });

  if (options.serveStatic) {
    const wydaniaPath = options.staticDir || getWebDistRoot(workspaceRoot);
    app.use(express.static(wydaniaPath));
    // Brakujacy plik wydania to 404, nie index.html: otwarta karta po aktualizacji
    // prosi o stary fragment kodu, a HTML w miejscu skryptu dawal blad typu MIME.
    app.use("/assets", (_req, res) => {
      res.status(404).type("text/plain").send("Nie ma takiego pliku wydania.");
    });
    app.get("*", (_req, res) => {
      res.sendFile(path.join(wydaniaPath, "index.html"));
    });
  }

  // Odrzucenia z async tras trafiaja do koncowej obslugi bledu zamiast
  // zawieszac zadanie i wywracac proces (Express 4 ich nie przechwytuje).
  zabezpieczTrasyAsync(app);
  app.use(koncowaObslugaBledu);

  return app;
}
