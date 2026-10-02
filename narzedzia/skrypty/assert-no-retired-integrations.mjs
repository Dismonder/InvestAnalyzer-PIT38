import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { rootDir } from '../projectPaths.mjs';

const root = rootDir;
const activeRoots = [
  path.join('aplikacje', 'web', 'src'),
  path.join('aplikacje', 'web', 'server.ts'),
  'package.json',
  path.join('aplikacje', 'web', 'vite.config.ts'),
  path.join('aplikacje', 'komputerowa', 'tauri', 'src'),
  path.join('silnik', 'python', 'src'),
  path.join('narzedzia', 'skrypty'),
];

// jakosc/testy celowo poza zakresem: testy importu plikow brokera odwoluja sie
// do nazwy Freedom24 jako formatu pliku, co jest wspierane. Bramka sciga
// integracje po API, a nie obsluge formatu.
//
// Sama nazwa Freedom24 i sciezka /api/freedom24 zeszly z listy: integracja
// z Tradernet jest znowu czescia produktu i pobiera komplet danych do
// rozliczenia. Na liscie zostaja konkretne pozostalosci po STAREJ integracji
// (FREEDOM24_API_LIVE, TradernetContext, FreedomDashboard, parseFreedom24),
// bo ich powrot oznaczalby cofniecie sie do poprzedniej architektury.

const banned = [
  'FREEDOM24_API_LIVE',
  'api:broker_report',
  '--api-live-json',
  'TradernetContext',
  'FreedomDashboard',
  'AuthPage',
  "kind: 'freedom24'",
  "kind === 'freedom24'",
  'parseFreedom24',
  'mapFreedom24',
  'API REQUEST',
];

const ignoredDirs = new Set([
  'node_modules',
  'wydania',
  'dane',
  '__pycache__',
  '.pytest_cache',
  '.venv',
]);

const ignoredFiles = new Set([
  path.normalize('narzedzia/skrypty/assert-no-retired-integrations.mjs'),
]);

function walk(target, files = []) {
  const fullPath = path.resolve(root, target);
  const rel = path.relative(root, fullPath);
  if (ignoredFiles.has(path.normalize(rel))) {
    return files;
  }
  const stat = statSync(fullPath, { throwIfNoEntry: false });
  if (!stat) {
    return files;
  }
  if (stat.isDirectory()) {
    if (ignoredDirs.has(path.basename(fullPath))) {
      return files;
    }
    for (const entry of readdirSync(fullPath)) {
      walk(path.join(rel, entry), files);
    }
    return files;
  }
  if (stat.isFile()) {
    files.push(fullPath);
  }
  return files;
}

const files = activeRoots.flatMap((entry) => walk(entry));
const failures = [];

for (const file of files) {
  const content = readFileSync(file, 'utf8');
  for (const token of banned) {
    if (content.includes(token)) {
      failures.push(`${path.relative(root, file)} zawiera wycofany ślad: ${token}`);
    }
  }
}

if (failures.length > 0) {
  console.error('Aktywny kod nadal zawiera wycofane integracje:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`OK: brak wycofanych integracji w ${files.length} aktywnych plikach.`);
