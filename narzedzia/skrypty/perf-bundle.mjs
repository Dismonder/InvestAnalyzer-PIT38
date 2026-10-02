import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { wydaniaWebDir, rootDir } from '../projectPaths.mjs';

const root = rootDir;
const assetsDir = path.join(wydaniaWebDir, 'assets');
function positiveLimit(name, fallback) {
  const value = process.env[name] ? Number(process.env[name]) : fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} musi być skończoną liczbą dodatnią (otrzymano: ${process.env[name]}).`);
  }
  return value;
}
const maxEntryChunkKb = positiveLimit('MAX_ENTRY_CHUNK_KB', 145);
// Progi po polaczeniu dwoch aplikacji w jeden produkt. Pakiet startowy zszedl
// z 2273 kB do 674 kB (leniwe zakladki, generator PDF na zadanie), wiec limit
// startowy jest ostrzejszy niz wczesniej. Laczny rozmiar jest wiekszy, bo
// produkt wozi teraz portfel, notowania i warsztat silnika naraz - to swiadomy
// zakres, nie regres.
// 2026-09-30: 800 -> 560. Zaleznosci recharts i jspdf oraz motion i date-fns
// wyjete z vendor-core (poczatkowy JS 757 -> 496 kB); prog lapie ich ponowny wyciek do startu.
// 2026-10-01: 560 -> 500. Poczatkowy JS 464,7 kB; prog ma lapac wyciek zaleznosci do startu.
const maxInitialJsKb = positiveLimit('MAX_INITIAL_JS_KB', 500);
// Budzet calkowitego JS byl dotad wylaczony domyslnie (null), wiec kontrola
// nigdy sie nie wykonywala, mimo ze raport drukowal "Total JS" tuz obok
// egzekwowanego budzetu poczatkowego. Wartosc odpowiada obecnemu rozmiarowi
// (1363 kB) z zapasem na rozwoj.
// 2026-09-21: 2500 -> 2600. Doszly obrot roku, sesje na wykresie, wiadomosci i ranking
// z Freedom24, suma rachunku, logowanie haslem/SMS i panel decyzji hurtowych (+ok. 10 kB).
// Progi, ktore czuje uzytkownik przy starcie (poczatkowy JS, plik wejsciowy), zostaja bez zmian.
// 2026-09-21 (2): 2600 -> 2750. Wykres gieldowy (lightweight-charts, ok. 150 kB) laduje sie wylacznie
// z zakladka Wykresy; poczatkowy JS przy tej zmianie spadl z 702 do 672 kB.
// 2026-10-01: 2750 -> 2900. Laczny JS 2743,4 kB rosnie z zakresem produktu
// (kwarantanna i ponowienia), a nie mierzy czasu startu; ten chroni osobny, ostrzejszy prog.
const maxTotalJsKb = positiveLimit('MAX_TOTAL_JS_KB', 2900);

function collectFiles(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      collectFiles(fullPath, files);
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

const files = collectFiles(assetsDir);
const jsFiles = files.filter((file) => file.endsWith('.js'));
const rows = jsFiles.map((file) => {
  const content = readFileSync(file);
  return {
    file: path.relative(root, file).replaceAll(path.sep, '/'),
    kb: content.length / 1024,
    gzipKb: gzipSync(content).length / 1024,
  };
}).sort((a, b) => b.kb - a.kb);

const totalJsKb = rows.reduce((sum, row) => sum + row.kb, 0);
const entryRows = rows.filter((row) => /assets\/index-.*\.js$/.test(row.file));
const xlsxRows = rows.filter((row) => row.file.includes('xlsx'));
const failures = [];

const rowByFile = new Map(rows.map((row) => [row.file, row]));
const staticImportPattern = /import\s*(?:[^"'()]*?from\s*)?["']([^"']+\.js)["']/g;
const initialFiles = new Set();

function addStaticDependencies(row) {
  if (!row || initialFiles.has(row.file)) return;
  initialFiles.add(row.file);

  const content = readFileSync(path.join(root, row.file), 'utf8');
  const dir = path.dirname(row.file);
  for (const match of content.matchAll(staticImportPattern)) {
    const importPath = match[1];
    if (!importPath.startsWith('.')) continue;
    const dependencyFile = path.normalize(path.join(dir, importPath)).replaceAll(path.sep, '/');
    addStaticDependencies(rowByFile.get(dependencyFile));
  }
}

for (const row of entryRows) {
  addStaticDependencies(row);
}

const initialRows = rows.filter((row) => initialFiles.has(row.file));
const initialJsKb = initialRows.reduce((sum, row) => sum + row.kb, 0);

for (const row of entryRows) {
  if (row.kb > maxEntryChunkKb) {
    failures.push(`Entry chunk ${row.file} ma ${row.kb.toFixed(1)} kB, limit ${maxEntryChunkKb} kB.`);
  }
}

if (initialJsKb > maxInitialJsKb) {
  failures.push(`Początkowy JS ma ${initialJsKb.toFixed(1)} kB, limit ${maxInitialJsKb} kB.`);
}

if (maxTotalJsKb !== null && totalJsKb > maxTotalJsKb) {
  failures.push(`Łączny JS ma ${totalJsKb.toFixed(1)} kB, limit ${maxTotalJsKb} kB.`);
}

if (xlsxRows.length === 0) {
  failures.push('xlsx nie jest wydzielony do osobnego asynchronicznego chunku.');
}

if (xlsxRows.length > 1) {
  failures.push(`xlsx jest zdublowany w ${xlsxRows.length} chunkach: ${xlsxRows.map((row) => row.file).join(', ')}.`);
}

if (initialRows.some((row) => row.file.includes('xlsx'))) {
  failures.push('xlsx trafił do początkowego grafu JS zamiast ładować się dopiero przy imporcie pliku.');
}

console.log('Bundle performance summary:');
for (const row of rows) {
  console.log(`${row.file.padEnd(55)} ${row.kb.toFixed(1).padStart(8)} kB gzip ${row.gzipKb.toFixed(1).padStart(8)} kB`);
}
console.log(`Initial JS: ${initialJsKb.toFixed(1)} kB`);
console.log(`Total JS (including lazy/worker chunks): ${totalJsKb.toFixed(1)} kB`);

if (failures.length > 0) {
  console.error('Bundle performance gate failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}
