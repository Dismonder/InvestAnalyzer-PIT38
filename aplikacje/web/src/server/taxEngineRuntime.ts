import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getPythonEngineRoot, getStorageRoot } from './workspacePaths.ts';

export function getTaxEngineRunOutputDir(workspaceRoot: string, runtimeRoot = path.join(os.tmpdir(), 'invest-analyzer-runtime')): string {
  // Wynik silnika może zawierać dane rachunku. Nie zostawiamy go w repozytorium
  // ani obok jedynych kopii wyciągów.
  return path.join(runtimeRoot, 'investment-tax-engine-dev-runtime', workspaceCacheNamespace(workspaceRoot), 'engine-output');
}

export function createTaxEngineRunOutputDir(workspaceRoot: string, cacheKey: string, runtimeRoot?: string): string {
  const outputRoot = getTaxEngineRunOutputDir(workspaceRoot, runtimeRoot);
  fs.mkdirSync(outputRoot, { recursive: true });
  // Pelny SHA-256 przekracza windowsowy limit dlugosci katalogu po dodaniu
  // sciezki tymczasowej i nazw artefaktow. Losowy sufiks izoluje przebiegi.
  return fs.mkdtempSync(path.join(outputRoot, `${cacheKey.slice(0, 12)}-`));
}

export function getRecentTaxEngineCachedOutputDirs(
  cacheDir: string,
  outputRoot: string,
  now = Date.now(),
  maxAgeMs = 7 * 24 * 60 * 60 * 1_000,
): Set<string> {
  const protectedDirs = new Set<string>();
  if (!fs.existsSync(cacheDir)) return protectedDirs;
  const cutoff = now - maxAgeMs;
  for (const entry of fs.readdirSync(cacheDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.meta\.json$/i.test(entry.name)) continue;
    const cachePath = path.join(cacheDir, entry.name);
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as { _runtimeOutputDir?: unknown; createdAt?: unknown };
      const createdAt = typeof cached.createdAt === 'number' ? cached.createdAt : fs.statSync(cachePath).mtimeMs;
      if (createdAt < cutoff || typeof cached._runtimeOutputDir !== 'string') continue;
      const directory = path.resolve(cached._runtimeOutputDir);
      if (path.dirname(directory) === path.resolve(outputRoot)) protectedDirs.add(directory);
    } catch {
      // Uszkodzony wpis cache nie wskazuje wiarygodnego katalogu wyniku.
    }
  }
  return protectedDirs;
}

export const TAX_ENGINE_CACHE_MAX_ENTRIES = 8;
export const TAX_ENGINE_CACHE_MAX_BYTES = 1_000_000_000;
export const TAX_ENGINE_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

/** Retencja dotyka tylko wpisów o kluczu SHA-256, tworzonych przez serwer. */
export function pruneTaxEngineCache(cacheDir: string, now = Date.now()): void {
  if (!fs.existsSync(cacheDir)) return;
  const entries: Array<{ key: string; jsonPath: string; metaPath: string; createdAt: number; size: number }> = [];
  for (const entry of fs.readdirSync(cacheDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/i.test(entry.name)) continue;
    const key = entry.name.slice(0, -5);
    const jsonPath = path.join(cacheDir, entry.name);
    const metaPath = path.join(cacheDir, `${key}.meta.json`);
    try {
      const stat = fs.statSync(jsonPath);
      const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) as { createdAt?: unknown; size?: unknown } : {};
      entries.push({ key, jsonPath, metaPath, createdAt: typeof meta.createdAt === 'number' ? meta.createdAt : stat.mtimeMs, size: stat.size });
    } catch {
      // Uszkodzone pliki pamięci również podlegają retencji.
      fs.rmSync(jsonPath, { force: true });
      fs.rmSync(metaPath, { force: true });
    }
  }
  entries.sort((a, b) => b.createdAt - a.createdAt);
  let bytes = 0;
  let kept = 0;
  for (const item of entries) {
    if (now - item.createdAt > TAX_ENGINE_CACHE_MAX_AGE_MS || kept >= TAX_ENGINE_CACHE_MAX_ENTRIES || bytes + item.size > TAX_ENGINE_CACHE_MAX_BYTES) {
      fs.rmSync(item.jsonPath, { force: true });
      fs.rmSync(item.metaPath, { force: true });
      continue;
    }
    bytes += item.size;
    kept += 1;
  }
}

/** Czyści wyłącznie bezpośrednie przestrzenie runtime o nazwie zakodowanej ścieżką. */
export function pruneOrphanedRuntimeNamespaces(runtimeRoot = path.join(os.tmpdir(), 'invest-analyzer-runtime'), now = Date.now()): void {
  const safeRoot = path.resolve(path.join(os.tmpdir(), 'invest-analyzer-runtime'));
  const targetRoot = path.resolve(runtimeRoot);
  if (targetRoot !== safeRoot || !fs.existsSync(safeRoot)) return;
  try {
    if (fs.lstatSync(safeRoot).isSymbolicLink()) return;
    const realRoot = fs.realpathSync(safeRoot);
    const realTemp = fs.realpathSync(os.tmpdir());
    if (realRoot !== realTemp && !realRoot.startsWith(`${realTemp}${path.sep}`)) return;
  } catch { return; }
  for (const entry of fs.readdirSync(safeRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'investment-tax-engine-dev-runtime') continue;
    const namespaceDir = path.join(safeRoot, entry.name);
    try { if (fs.lstatSync(namespaceDir).isSymbolicLink()) continue; } catch { continue; }
    let workspace: string;
    const identityPath = path.join(namespaceDir, 'workspace-root.txt');
    try {
      if (fs.existsSync(identityPath)) {
        workspace = fs.readFileSync(identityPath, 'utf8');
      } else {
        if (entry.name.length >= 80) continue;
        workspace = Buffer.from(entry.name, 'base64url').toString('utf8');
        if (Buffer.from(workspace).toString('base64url') !== entry.name) continue;
      }
    } catch { continue; }
    if (!workspace) continue;
    const modified = fs.statSync(namespaceDir).mtimeMs;
    if (now - modified > 24 * 60 * 60 * 1_000 && !fs.existsSync(workspace)) {
      fs.rmSync(namespaceDir, { recursive: true, force: true });
    }
  }
}

export function pruneTaxEngineRunOutputDirs(outputRoot: string, protectedDirs: ReadonlySet<string>, keep = 20): void {
  if (!fs.existsSync(outputRoot)) return;
  const directories = fs.readdirSync(outputRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const directory = path.join(outputRoot, entry.name);
      return { directory, modified: fs.statSync(directory).mtimeMs };
    })
    .sort((left, right) => right.modified - left.modified);
  let remaining = Math.max(0, keep - directories.filter(({ directory }) => protectedDirs.has(directory)).length);
  for (const { directory } of directories) {
    if (protectedDirs.has(directory)) continue;
    if (remaining > 0) { remaining -= 1; continue; }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

export function getTaxEngineCacheDir(workspaceRoot: string, runtimeRoot = path.join(os.tmpdir(), 'invest-analyzer-runtime')): string {
  return path.join(runtimeRoot, workspaceCacheNamespace(workspaceRoot), 'engine-cache');
}

function workspaceCacheNamespace(workspaceRoot: string): string {
  return Buffer.from(path.resolve(workspaceRoot)).toString('base64url').slice(0, 80);
}

const STORAGE_DIGEST_CACHE_LIMIT = 1_000;
const storageDigestCache = new Map<string, { metadata: string; digest: string }>();
const engineSourceDigestCache = new Map<string, { metadata: string; digest: string }>();

async function storageFileDigest(fullPath: string, stat: fs.Stats): Promise<string> {
  const metadata = `${stat.size}\t${stat.mtimeMs}\t${stat.ctimeMs}\t${stat.ino}\t${stat.dev}`;
  const cached = storageDigestCache.get(fullPath);
  if (cached?.metadata === metadata) {
    storageDigestCache.delete(fullPath);
    storageDigestCache.set(fullPath, cached);
    return cached.digest;
  }

  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(fullPath)) hash.update(chunk);
  const digest = hash.digest('hex');
  storageDigestCache.delete(fullPath);
  storageDigestCache.set(fullPath, { metadata, digest });
  if (storageDigestCache.size > STORAGE_DIGEST_CACHE_LIMIT) {
    const oldestPath = storageDigestCache.keys().next().value;
    if (oldestPath !== undefined) storageDigestCache.delete(oldestPath);
  }
  return digest;
}

/** Odcisk obejmuje treść, także gdy podmieniony plik zachowa mtime i rozmiar. */
export async function storageMetadataFingerprint(workspaceRoot: string): Promise<string> {
  const root = getStorageRoot(workspaceRoot);
  const rows: string[] = [];
  try {
    await fs.promises.access(root);
  } catch {
    return 'empty';
  }
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      const relativePath = path.relative(root, fullPath).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (!isIgnoredStorageRelativePath(relativePath)) await visit(fullPath);
      } else if (entry.isFile() && !isIgnoredStorageRelativePath(relativePath) && isAllowedStorageExtension(relativePath)) {
        const stat = await fs.promises.stat(fullPath);
        const digest = await storageFileDigest(fullPath, stat);
        rows.push(`${relativePath}\t${stat.mtimeMs}\t${stat.size}\t${digest}`);
      }
    }
  };
  await visit(root);
  return rows.sort((left, right) => left.localeCompare(right, 'pl')).join('\n') || 'empty';
}

/**
 * Odcisk kodu silnika. Wynik policzony starsza wersja silnika nie moze wrocic
 * z pamieci podrecznej po poprawce w rozliczeniu - te same pliki dalyby wtedy
 * stara kwote podatku bez zadnego sygnalu.
 */
export function engineSourceFingerprint(workspaceRoot: string): string {
  const root = path.join(workspaceRoot, 'silnik', 'python', 'src');
  if (!fs.existsSync(root)) return 'no-engine-source';
  const rows: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '__pycache__') continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.py')) {
        const stat = fs.statSync(fullPath);
        const metadata = `${stat.size}\t${stat.mtimeMs}\t${stat.ctimeMs}\t${stat.ino}\t${stat.dev}`;
        const cached = engineSourceDigestCache.get(fullPath);
        let digest = cached?.metadata === metadata ? cached.digest : '';
        if (!digest) {
          digest = createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex');
          engineSourceDigestCache.set(fullPath, { metadata, digest });
          if (engineSourceDigestCache.size > STORAGE_DIGEST_CACHE_LIMIT) {
            const oldestPath = engineSourceDigestCache.keys().next().value;
            if (oldestPath !== undefined) engineSourceDigestCache.delete(oldestPath);
          }
        }
        rows.push(`${path.relative(root, fullPath).split(path.sep).join('/')}\t${stat.mtimeMs}\t${stat.size}\t${digest}`);
      }
    }
  };
  visit(root);
  return rows.sort().join('|');
}

/** Stabilna serializacja parametrów zadania, niezależna od kolejności pól JSON. */
export function stableTaskFingerprint(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableTaskFingerprint).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableTaskFingerprint(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const IGNORED_STORAGE_DIR_NAMES = new Set(['.pytest_cache', '.venv', '__pycache__', 'backups', 'dist', 'wydania', 'node_modules', 'out']);

export function validateTaxYear(value: unknown, nowYear = new Date().getFullYear()): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error('Rok podatkowy musi być liczbą całkowitą.');
  }
  const minYear = 2000;
  const maxYear = nowYear + 1;
  if (value < minYear || value > maxYear) {
    throw new Error(`Rok podatkowy jest poza dozwolonym zakresem ${minYear}-${maxYear}.`);
  }
  return value;
}

/**
 * Formaty, w ktorych brokerzy udostepniaja wyciagi, oraz dokumenty dowodowe.
 *
 * Lista musi byc taka sama jak ALLOWED_IMPORT_EXTENSIONS w powloce desktop
 * (`aplikacje/komputerowa/tauri/src/security/extension_guard.rs`). Powloka
 * desktop odrzucala plik wykonywalny, a serwer webowy odsylal go przez
 * `res.sendFile` - ta sama aplikacja zachowywala sie inaczej zaleznie od
 * runtime'u, wbrew kryterium wydania "Unsafe extensions are blocked".
 */
export const ALLOWED_STORAGE_EXTENSIONS = [
  'json', 'csv', 'tsv', 'xlsx', 'xlsm', 'xls', 'xml', 'pdf', 'txt', 'zip', 'html', 'htm',
] as const;

export function storageExtension(filename: string): string {
  const base = path.basename(filename);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

export function isAllowedStorageExtension(filename: string): boolean {
  return (ALLOWED_STORAGE_EXTENSIONS as readonly string[]).includes(storageExtension(filename));
}

export function resolveStorageFilePath(workspaceRoot: string, filename: string): string {
  const relativePath = normalizeStorageRelativePath(filename);

  if (!isAllowedStorageExtension(relativePath)) {
    throw new Error(
      `Nieobsługiwana nazwa pliku storage: ${filename}. Dozwolone rozszerzenia: ${ALLOWED_STORAGE_EXTENSIONS.join(', ')}.`,
    );
  }

  const storageRoot = getStorageRoot(workspaceRoot);
  const resolved = path.resolve(storageRoot, relativePath);
  if (resolved !== storageRoot && !resolved.startsWith(`${storageRoot}${path.sep}`)) {
    throw new Error('Plik znajduje się poza katalogiem storage.');
  }
  assertStoragePathSafe(workspaceRoot, resolved);
  return resolved;
}

/** Odrzuca dowiązania także w katalogach nadrzędnych nieistniejącego jeszcze pliku. */
export function assertStoragePathSafe(workspaceRoot: string, targetPath: string): void {
  const root = path.resolve(getStorageRoot(workspaceRoot));
  const target = path.resolve(targetPath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error('Plik znajduje się poza katalogiem storage.');
  }
  const workspace = path.resolve(workspaceRoot);
  let realWorkspace: string | null = null;
  try { realWorkspace = fs.realpathSync(workspace); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let parent = workspace;
  for (const part of path.relative(workspace, root).split(path.sep)) {
    parent = path.join(parent, part);
    try {
      if (fs.lstatSync(parent).isSymbolicLink()) throw new Error('Dowiązanie w ścieżce storage jest zabronione.');
      const real = fs.realpathSync(parent);
      if (realWorkspace && real !== realWorkspace && !real.startsWith(`${realWorkspace}${path.sep}`)) {
        throw new Error('Plik znajduje się poza katalogiem storage.');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  let realRoot: string | null = null;
  for (const candidate of [root, ...path.relative(root, target).split(path.sep).filter(Boolean).map((_, index, parts) => path.join(root, ...parts.slice(0, index + 1)))]) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error('Dowiązanie w ścieżce storage jest zabronione.');
    const real = fs.realpathSync(candidate);
    if (candidate === root) realRoot = real;
    else if (realRoot && real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`)) {
      throw new Error('Plik znajduje się poza katalogiem storage.');
    }
  }
}

export async function listStorageFiles(workspaceRoot: string): Promise<string[]> {
  const storageRoot = getStorageRoot(workspaceRoot);
  const output: string[] = [];
  if (!fs.existsSync(storageRoot)) {
    return output;
  }
  const storageRootStat = await fs.promises.stat(storageRoot);
  if (!storageRootStat.isDirectory()) {
    return output;
  }

  async function visit(directory: string): Promise<void> {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      const relativePath = path.relative(storageRoot, fullPath).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (!isIgnoredStorageRelativePath(relativePath)) {
          await visit(fullPath);
        }
        continue;
      }
      // Plik, ktorego i tak nie wolno odczytac, nie ma po co pojawiac sie na
      // liscie - inaczej interfejs proponuje uzytkownikowi cos, co skonczy sie
      // bledem.
      if (
        entry.isFile()
        && !isIgnoredStorageRelativePath(relativePath)
        && isAllowedStorageExtension(relativePath)
      ) {
        output.push(relativePath);
      }
    }
  }

  await visit(storageRoot);
  return output.sort((left, right) => left.localeCompare(right, 'pl'));
}

function normalizeStorageRelativePath(filename: string): string {
  const normalized = String(filename || '').replace(/\\/g, '/');
  if (!normalized || normalized.includes('\0') || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error('Nieprawidłowa nazwa pliku storage.');
  }

  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) {
    throw new Error('Nieprawidłowa nazwa pliku storage.');
  }
  if (isIgnoredStorageRelativePath(parts.join('/'))) {
    throw new Error('Nieprawidłowa nazwa pliku storage.');
  }
  return parts.join(path.sep);
}

function isIgnoredStorageRelativePath(relativePath: string): boolean {
  return relativePath
    .split('/')
    .some((part) => part.startsWith('.') || IGNORED_STORAGE_DIR_NAMES.has(part.toLowerCase()));
}

export function resolvePythonExecutable(
  workspaceRoot: string,
  exists: (candidate: string) => boolean = fs.existsSync,
  env: NodeJS.ProcessEnv = process.env,
): string {
  // Jawne wskazanie interpretera ma pierwszenstwo. Bez tego na maszynie innej
  // niz ta, na ktorej zbudowano .venv, serwer probuje uruchomic obcy plik
  // wykonywalny i konczy sie to niejasnym bledem systemowym.
  const wskazany = (env.INVEST_PYTHON || '').trim();
  if (wskazany) {
    return wskazany;
  }

  const candidates = [
    path.join(getPythonEngineRoot(workspaceRoot), '.venv', 'Scripts', 'python.exe'),
    path.join(getPythonEngineRoot(workspaceRoot), '.venv', 'bin', 'python'),
    path.join(workspaceRoot, '.venv', 'Scripts', 'python.exe'),
    path.join(workspaceRoot, '.venv', 'bin', 'python'),
  ];

  return candidates.find(exists) || (process.platform === 'win32' ? 'python' : 'python3');
}

export interface RuntimeTempJson {
  filePath: string;
  cleanup: () => void;
}

export function writeRuntimeTempJsonSync(prefix: string, payload: unknown): RuntimeTempJson {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const filePath = path.join(tempDir, 'payload.json');
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
  return {
    filePath,
    cleanup: () => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}
