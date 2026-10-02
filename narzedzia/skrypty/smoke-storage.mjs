import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pythonEngineDir, rootDir, storageDir, tmpDir } from '../projectPaths.mjs';

const pythonProjectDir = pythonEngineDir;
const year = String(process.env.SMOKE_STORAGE_YEAR || 2025);
const sourceSelectionMode = String(process.env.SMOKE_SOURCE_SELECTION_MODE || 'canonical_stream');
const outDir = join(tmpDir, `smoke-storage-${year}-${sourceSelectionMode.replace(/[^a-z0-9_-]/gi, '_')}`);
// Wymusza prawdziwy magazyn uzytkownika: zestaw syntetyczny przechodzi te sama
// sciezke, ale nie dowodzi, ze wlasne pliki wlasciciela sie licza.
const requireRealStorageData = String(process.env.SMOKE_STORAGE_REQUIRE_DATA || '').toLowerCase() === 'true';
// Listowanie musi byc rekurencyjne: import zachowuje podkatalogi
// (storage.rs:245 sanitize_import_relative_path), wiec uzytkownik z plikami
// w podfolderze mial dotad puste przejscie mimo posiadania realnych danych.
function collectStorageDataFiles(dir) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      found.push(...collectStorageDataFiles(join(dir, entry.name)));
    } else if (entry.isFile() && entry.name !== '.gitkeep') {
      found.push(entry.name);
    }
  }
  return found;
}

// dane/pliki jest gitignorowane, wiec na kazdym swiezym klonie i w CI bylo
// puste - skrypt drukowal wtedy "status: pass" i konczyl sie przed ~30
// asercjami. Bramka, ktora ma dowodzic, ze pipeline podatkowy dziala, nie
// sprawdzala niczego wszedzie poza komputerem wlasciciela. Zestaw syntetyczny
// z jakosc/dane-testowe przechodzi te sama sciezke: rozpoznanie plikow,
// canonical_tax_input, kartoteki, FIFO i roczne podsumowanie.
const syntheticFixturesDir = join(rootDir, 'jakosc', 'dane-testowe');
// Wymuszenie zestawu syntetycznego, zeby dalo sie sprawdzic zachowanie
// swiezego klonu bez ruszania wlasnych plikow uzytkownika.
const forceSynthetic = ['1', 'true', 'yes', 'syntetyczny', 'synthetic'].includes(
  String(process.env.SMOKE_STORAGE_FIXTURES || '').trim().toLowerCase(),
);
const privateStorageFiles = forceSynthetic ? [] : collectStorageDataFiles(storageDir);
const usingSyntheticStorage = privateStorageFiles.length === 0 && existsSync(syntheticFixturesDir);
const syntheticStorageDir = join(tmpDir, 'smoke-storage-syntetyczny', 'pliki');

if (requireRealStorageData && usingSyntheticStorage) {
  console.error('  error: SMOKE_STORAGE_REQUIRE_DATA=true, a dane/pliki jest puste - zestaw syntetyczny tego nie zastapi.');
  process.exit(1);
}

if (usingSyntheticStorage) {
  rmSync(syntheticStorageDir, { recursive: true, force: true });
  mkdirSync(syntheticStorageDir, { recursive: true });
  for (const entry of readdirSync(syntheticFixturesDir, { withFileTypes: true })) {
    if (entry.isFile()) {
      copyFileSync(join(syntheticFixturesDir, entry.name), join(syntheticStorageDir, entry.name));
    }
  }
}

const effectiveStorageDir = usingSyntheticStorage ? syntheticStorageDir : storageDir;
const storageDataFiles = collectStorageDataFiles(effectiveStorageDir);
// Nazwy plikow uzytkownika. Zestaw syntetyczny nazywa je inaczej, wiec ta
// kontrola dotyczy wylacznie prawdziwego magazynu; asercje merytoryczne
// ponizej obowiazuja w obu przypadkach.
const expectedStorageFiles = usingSyntheticStorage
  ? []
  : [
      'broker_raport_bezbliansu.json',
      'broker_raport_zbliansem.json',
      'dezpozytariusz_raport_bezbilansu.json',
      'dezpozytariusz_raport_zbilansem.json',
      'Ruchy_gotówki.xlsx',
      'Traderzy.xlsx',
      'Transakcje.xlsx',
      'Stawki.pdf',
    ];
const expectedHistoryCategories = usingSyntheticStorage
  ? ['investment', 'cash_flow', 'fee_cost', 'position_check', 'evidence']
  : ['investment', 'cash_flow', 'fee_cost', 'position_check', 'analytics', 'evidence'];

// Zmienna INVEST_PYTHON wskazuje interpreter wprost - tak samo jak robi to
// serwer aplikacji. Bez tego kazdy skrypt szukal Pythona po swojemu
// i na maszynie innej niz ta, na ktorej zbudowano .venv, bral pierwszy
// z brzegu, ktoremu brakowalo zaleznosci silnika.
const wskazanyInterpreterRaw = String(process.env.INVEST_PYTHON || '').trim();
const wskazanyInterpreter = wskazanyInterpreterRaw && !isAbsolute(wskazanyInterpreterRaw)
  ? resolve(rootDir, wskazanyInterpreterRaw)
  : wskazanyInterpreterRaw;

const candidates = process.platform === 'win32'
  ? [
      join(pythonProjectDir, '.venv', 'Scripts', 'python.exe'),
      'python',
      'python3',
    ]
  : [
      join(pythonProjectDir, '.venv', 'bin', 'python'),
      'python3',
      'python',
    ];

const pythonExecutable = wskazanyInterpreter || candidates.find((candidate) => (
  candidate.includes('\\') || candidate.includes('/') ? existsSync(candidate) : true
));

if (!pythonExecutable) {
  console.error('Nie znaleziono interpretera Python do smoke:storage.');
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const result = spawnSync(
  pythonExecutable,
  [
    '-m',
    'investment_tax_engine.app.cli',
    '--year',
    year,
    '--package-scope',
    'full',
    '--source-selection-mode',
    sourceSelectionMode,
    '--storage-dir',
    effectiveStorageDir,
    '--out-dir',
    outDir,
    // Przebieg kontrolny nie nadpisuje kopii wynikow aplikacji w dane/out.
    '--bez-kopii-out',
  ],
  {
    cwd: pythonProjectDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      PYTHONPATH: join(pythonProjectDir, 'src'),
      INVEST_TAX_EXPORT_MODE: 'minimal',
    },
    maxBuffer: 80 * 1024 * 1024,
    shell: false,
  },
);

if (result.error) {
  console.error(`Nie udało się uruchomić silnika: ${result.error.message}`);
  process.exit(1);
}

if (result.status !== 0) {
  console.error(result.stderr || result.stdout || 'Silnik zakończył się błędem.');
  process.exit(result.status ?? 1);
}

let payload;
try {
  payload = JSON.parse(result.stdout);
} catch (error) {
  console.error(`Silnik nie zwrócił poprawnego JSON: ${error.message}`);
  process.exit(1);
}

const appendix = payload.tax_filing_package?.audit_appendix || {};
const health = appendix.result_health_check || {};
const smoke = appendix.storage_smoke_report || {};
const sourceTrust = appendix.source_trust_summary || {};
const canonicalRows = payload.canonical_storage_history_rows || appendix.canonical_storage_history_rows || [];
const canonicalSummary = appendix.canonical_storage_history_summary || payload.canonical_storage_history_summary || {};
const transactionDossiers = payload.transaction_dossiers || appendix.transaction_dossiers || [];
const transactionDossierSummary = payload.transaction_dossier_summary || appendix.transaction_dossier_summary || {};
const fieldSourceMap = payload.field_source_map || appendix.field_source_map || {};
const canonicalTaxInput = payload.canonical_tax_input || appendix.canonical_tax_input || {};
const canonicalTaxInputSummary = payload.canonical_tax_input_summary || appendix.canonical_tax_input_summary || {};
const categoryCounts = canonicalSummary.categoryCounts || {};
const sourceTrustItems = sourceTrust.items || [];
// Pliki swiadomie pominiete jako kopia innego pliku o identycznej zawartosci.
// Ich brak w mapie zrodel jest zamierzony: policzenie obu podwoiloby przychod,
// koszt i podatek. Bez tej listy prog zglaszal je jako brak rozpoznania.
const duplicateFiles = new Set(
  (
    (payload.source_resolution_preview || appendix.source_resolution_preview || {}).duplicateFiles || []
  ).map((entry) => String(entry.file || '').toLowerCase()),
);
const checks = smoke.checks || {};
const errors = [...(smoke.errors || [])];
const warnings = [...(smoke.warnings || [])];

// Pusty storage jest normalnym stanem swiezego klonu, bo dane/pliki sa
// gitignorowane. Skrot ponizej pomija wtedy asercje merytoryczne - ale mowi
// to wprost i nie udaje, ze pipeline podatkowy zostal sprawdzony.
if (storageDataFiles.length === 0) {
  console.error('  error: Brak danych do sprawdzenia - ani w dane/pliki, ani w zestawie syntetycznym.');
  console.error('  Zbuduj zestaw syntetyczny: python narzedzia/skrypty/zbuduj_dane_testowe.py');
  process.exit(1);
}

if (!checks.active_sources_exist) {
  errors.push('Brak aktywnego źródła PIT.');
}
if (!checks.annual_summary_not_zero) {
  errors.push('Podejrzane zera w rocznym wyniku PIT.');
}
if (!checks.helper_files_do_not_block) {
  errors.push('Plik pomocniczy blokuje PIT.');
}
if (!checks.nbp_sources_detected) {
  errors.push('NBP nie jest rozpoznane dla aktywnych danych.');
}
if ((health.recognizedStorageFileCount ?? 0) > 0 && canonicalRows.length === 0) {
  errors.push('Kanoniczna historia storage jest pusta mimo rozpoznanych plików.');
}
if ((categoryCounts.investment ?? 0) === 0) {
  errors.push('Kanoniczna historia nie ma domyślnych rekordów inwestycyjnych.');
}
if (transactionDossiers.length === 0) {
  errors.push('Brak kart transakcji Transaction Intelligence.');
}
if (Object.keys(fieldSourceMap).length === 0) {
  errors.push('Brak mapy źródeł pól dla kart transakcji.');
}
if (canonicalTaxInput.schema_version !== 'canonical_tax_input.v2') {
  errors.push('Brak poprawnego canonical_tax_input.');
}
if (canonicalTaxInputSummary.schema_version !== 'canonical_tax_input_summary.v2') {
  errors.push('Brak poprawnego canonical_tax_input_summary.');
}

const sourceTrustNames = new Set(
  sourceTrustItems
    .map((item) => String(item.file_name || item.filename || '').toLowerCase())
    .filter(Boolean),
);
const canonicalFileNames = new Set();
for (const row of canonicalRows) {
  for (const provenance of row.provenance || []) {
    const filename = String(provenance.filename || '').toLowerCase();
    if (filename) {
      canonicalFileNames.add(filename);
    }
  }
}
for (const filename of expectedStorageFiles) {
  const key = filename.toLowerCase();
  if (duplicateFiles.has(key)) {
    warnings.push(`Plik pominięty jako kopia o identycznej zawartości: ${filename}`);
    continue;
  }
  if (!sourceTrustNames.has(key)) {
    errors.push(`Brak pliku w mapie zaufania źródeł: ${filename}`);
    continue;
  }
  if (!canonicalFileNames.has(key)) {
    warnings.push(`Plik jest rozpoznany, ale nie ma wierszy w kanonicznej historii: ${filename}`);
  }
}
for (const category of expectedHistoryCategories) {
  if ((categoryCounts[category] ?? 0) === 0) {
    warnings.push(`Brak rekordów kategorii kanonicznej: ${category}`);
  }
}

console.log('Storage smoke summary:');
console.log(`  zestaw: ${usingSyntheticStorage ? 'syntetyczny (jakosc/dane-testowe)' : 'prawdziwy magazyn uzytkownika'}`);
console.log(`  year: ${year}`);
console.log(`  source selection: ${sourceSelectionMode}`);
console.log(`  status: ${smoke.status || 'unknown'}`);
console.log(`  result health: ${health.status || 'unknown'} - ${health.headline || ''}`);
console.log(`  transaction source count: ${sourceTrust.summary?.transaction_source_count ?? 0}`);
console.log(`  recognized files: ${health.recognizedStorageFileCount ?? 0}`);
console.log(`  canonical storage rows: ${canonicalRows.length}`);
console.log(`  canonical raw rows: ${canonicalSummary.rawRowCount ?? 'unknown'}`);
console.log(`  canonical deduplicated rows: ${canonicalSummary.deduplicatedRowCount ?? 'unknown'}`);
console.log(`  canonical categories: ${JSON.stringify(categoryCounts)}`);
console.log(`  transaction dossiers: ${transactionDossiers.length}`);
console.log(`  dossier summary: ${JSON.stringify(transactionDossierSummary)}`);
console.log(`  canonical input ready records: ${canonicalTaxInputSummary.engineReadyRecordCount ?? 'unknown'}`);
console.log(`  tax rows: ${health.taxHistoryRowCount ?? 0}`);
console.log(`  sell rows: ${health.sellRowCount ?? 0}`);
console.log(`  revenue PLN: ${health.revenuePln ?? '0'}`);
console.log(`  cost PLN: ${health.costPln ?? '0'}`);

for (const warning of warnings) {
  console.warn(`  warning: ${warning}`);
}

if (errors.length > 0 || smoke.status === 'fail') {
  for (const error of errors) {
    console.error(`  error: ${error}`);
  }
  process.exit(1);
}
