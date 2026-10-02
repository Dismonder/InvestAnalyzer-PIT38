import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pythonEngineDir, rootDir, storageDir, tmpDir } from '../projectPaths.mjs';

const pythonProjectDir = pythonEngineDir;
const year = String(process.env.SMOKE_STORAGE_YEAR || 2025);
const outDir = join(tmpDir, `smoke-storage-ollama-${year}`);
const ollamaMode = String(process.env.SMOKE_STORAGE_USE_OLLAMA || '').toLowerCase();
let useOllama = ['1', 'true', 'yes', 'on'].includes(ollamaMode);
const ollamaExplicitlyDisabled = ['0', 'false', 'no', 'off'].includes(ollamaMode);
const fullAiStorageRun = ['1', 'true', 'yes', 'on'].includes(String(process.env.SMOKE_STORAGE_FULL_AI || '').toLowerCase());
const gpuConfirmed = String(process.env.INVEST_OLLAMA_GPU_CONFIRMED || '').toLowerCase() === 'true';
const requireRealStorageData = String(process.env.SMOKE_STORAGE_REQUIRE_DATA || '').toLowerCase() === 'true';
// Listowanie musi byc rekurencyjne - import zachowuje podkatalogi, wiec
// uzytkownik z plikami w podfolderze mial puste przejscie mimo realnych danych.
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

// dane/pliki jest gitignorowane, wiec na swiezym klonie i w CI bylo puste, a
// skrypt konczyl sie wtedy komunikatem "status: pass" przed wszystkimi
// asercjami. Zestaw syntetyczny przechodzi te sama sciezke Transaction
// Intelligence, wiec bramka wreszcie cos znaczy poza komputerem wlasciciela.
const syntheticFixturesDir = join(rootDir, 'jakosc', 'dane-testowe');
// Wymuszenie zestawu syntetycznego, zeby dalo sie sprawdzic zachowanie
// swiezego klonu bez ruszania wlasnych plikow uzytkownika.
const forceSynthetic = ['1', 'true', 'yes', 'syntetyczny', 'synthetic'].includes(
  String(process.env.SMOKE_STORAGE_FIXTURES || '').trim().toLowerCase(),
);
const privateStorageFiles = forceSynthetic ? [] : collectStorageDataFiles(storageDir);
const usingSyntheticStorage = privateStorageFiles.length === 0 && existsSync(syntheticFixturesDir);
const syntheticStorageDir = join(tmpDir, 'smoke-storage-ollama-syntetyczny', 'pliki');

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
const timeoutMs = Number(process.env.SMOKE_STORAGE_TIMEOUT_MS || 240000);
let ollamaProbe = { enabled: useOllama, ok: false, model: process.env.INVEST_OLLAMA_MODEL || '', error: '' };

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
  console.error('Nie znaleziono interpretera Python do smoke:storage:ollama.');
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

async function requestJson(url, options = {}, timeout = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function probeOllamaStructuredJson() {
  const baseUrl = String(process.env.INVEST_OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const tags = await requestJson(`${baseUrl}/api/tags`, {}, 10000);
  const models = Array.isArray(tags.models) ? tags.models.map((model) => String(model.name || model.model || '')).filter(Boolean) : [];
  const requestedModel = String(process.env.INVEST_OLLAMA_MODEL || '').trim();
  const model = requestedModel
    || (models.includes('qwen3:14b') ? 'qwen3:14b' : '')
    || (models.includes('qwen3:8b') ? 'qwen3:8b' : '')
    || (models.includes('qwen2.5:7b-instruct') ? 'qwen2.5:7b-instruct' : '')
    || (models.includes('qwen2.5:7b') ? 'qwen2.5:7b' : '')
    || models[0];
  if (!model) {
    throw new Error('Ollama działa, ale nie ma pobranego modelu.');
  }
  const schema = {
    type: 'object',
    properties: {
      schema_version: { type: 'string' },
      status: { type: 'string' },
      confidence: { type: 'number' },
    },
    required: ['schema_version', 'status', 'confidence'],
  };
  const payload = await requestJson(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      format: schema,
      prompt: 'Zwroc wylacznie JSON: schema_version=ollama.smoke.v1, status=ok, confidence=1.',
      options: { temperature: 0, num_predict: 80 },
    }),
  }, 120000);
  const parsed = JSON.parse(String(payload.response || '{}'));
  if (parsed.schema_version !== 'ollama.smoke.v1' || parsed.status !== 'ok') {
    throw new Error('Ollama nie zwrocila oczekiwanego JSON schema.');
  }
  return { model };
}

if (!gpuConfirmed && useOllama) {
  console.error('Ollama smoke nie uruchamia AI bez INVEST_OLLAMA_GPU_CONFIRMED=true. CPU fallback jest wyłączony.');
  process.exit(1);
}

if (!useOllama && !ollamaExplicitlyDisabled && gpuConfirmed) {
  try {
    ollamaProbe = { enabled: true, ok: true, ...(await probeOllamaStructuredJson()), error: '' };
    useOllama = true;
  } catch (error) {
    ollamaProbe = {
      enabled: false,
      ok: false,
      model: process.env.INVEST_OLLAMA_MODEL || '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

if (useOllama && !ollamaProbe.ok) {
  try {
    ollamaProbe = { enabled: true, ok: true, ...(await probeOllamaStructuredJson()), error: '' };
  } catch (error) {
    console.error(`Ollama smoke failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

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
    'canonical_stream',
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
      INVEST_AI_NORMALIZER_ENABLED: useOllama && fullAiStorageRun && gpuConfirmed ? 'true' : 'false',
      INVEST_OLLAMA_GPU_REQUIRED: 'true',
      INVEST_OLLAMA_GPU_CONFIRMED: gpuConfirmed ? 'true' : 'false',
      INVEST_OLLAMA_ALLOW_CPU_AI: 'false',
      INVEST_OLLAMA_COMPUTE_BACKEND: gpuConfirmed ? 'gpu' : 'unknown',
      INVEST_AI_CONTEXT_MAX_EVENTS: useOllama && fullAiStorageRun ? String(process.env.SMOKE_STORAGE_AI_CONTEXT_MAX_EVENTS || '3') : String(process.env.INVEST_AI_CONTEXT_MAX_EVENTS || '200'),
    },
    maxBuffer: 100 * 1024 * 1024,
    shell: false,
    timeout: timeoutMs,
  },
);

if (result.error) {
  if (result.error.code === 'ETIMEDOUT') {
    console.error(`Storage Ollama smoke przekroczył timeout ${timeoutMs} ms.`);
    process.exit(1);
  }
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
const dossiers = payload.transaction_dossiers || appendix.transaction_dossiers || [];
const events = payload.normalized_events || appendix.normalized_events || [];
const aiContext = payload.ai_extracted_context || appendix.ai_extracted_context || [];
const aiDocumentClassification = payload.ai_document_classification || appendix.ai_document_classification || [];
const aiColumnMappings = payload.ai_column_mappings || appendix.ai_column_mappings || [];
const aiValidationReport = payload.ai_validation_report || appendix.ai_validation_report || {};
const fieldSourceMap = payload.field_source_map || appendix.field_source_map || {};
const evidenceIndex = payload.evidence_index || appendix.evidence_index || [];
const canonicalTaxInput = payload.canonical_tax_input || appendix.canonical_tax_input || {};
const canonicalTaxInputSummary = payload.canonical_tax_input_summary || appendix.canonical_tax_input_summary || {};

const requiredFiles = [
  'source_registry.json',
  'normalized_storage_manifest.json',
  'normalized_events.jsonl',
  'ai_document_classification.json',
  'ai_column_mappings.json',
  'ai_extracted_context.jsonl',
  'ai_validation_report.json',
  'transaction_dossiers.json',
  'transaction_conflicts.json',
  'evidence_index.json',
  'field_source_map.json',
  'canonical_storage_history.json',
  'storage_lineage_index.json',
  'canonical_tax_input.json',
];

const errors = [];
if (storageDataFiles.length === 0) {
  console.error('  error: Brak danych do sprawdzenia - ani w dane/pliki, ani w zestawie syntetycznym.');
  console.error('  Zbuduj zestaw syntetyczny: python narzedzia/skrypty/zbuduj_dane_testowe.py');
  process.exit(1);
}
for (const filename of requiredFiles) {
  if (!existsSync(join(outDir, filename))) {
    errors.push(`Brak pliku wyjściowego Transaction Intelligence: ${filename}`);
  }
}
if (events.length === 0) {
  errors.push('Brak normalized_events.');
}
if (dossiers.length === 0) {
  errors.push('Brak transaction_dossiers.');
}
if (Object.keys(fieldSourceMap).length === 0) {
  errors.push('Brak field_source_map.');
}
if (!Array.isArray(aiContext)) {
  errors.push('ai_extracted_context nie jest listą.');
}
if (!Array.isArray(aiDocumentClassification) || aiDocumentClassification.length === 0) {
  errors.push('Brak ai_document_classification.');
}
if (!Array.isArray(aiColumnMappings)) {
  errors.push('ai_column_mappings nie jest listą.');
}
if (!aiValidationReport || aiValidationReport.schema_version !== 'ai.validation_report.v1') {
  errors.push('Brak poprawnego ai_validation_report.');
}
// Taryfa oplat jako dowod. Zestaw syntetyczny nie moze powielac nazwy
// prawdziwego pliku uzytkownika, wiec sprawdzamy ksztalt nazwy, nie doslowna.
const tariffName = usingSyntheticStorage ? 'stawki-przykladowe.pdf' : 'stawki.pdf';
if (!evidenceIndex.some((item) => String(item.filename || '').toLowerCase() === tariffName)) {
  errors.push(`${tariffName} nie trafił do evidence_index.`);
}
if (canonicalTaxInput.schema_version !== 'canonical_tax_input.v2') {
  errors.push('Brak poprawnego canonical_tax_input.');
}
if (!canonicalTaxInputSummary || canonicalTaxInputSummary.schema_version !== 'canonical_tax_input_summary.v2') {
  errors.push('Brak poprawnego canonical_tax_input_summary.');
}

console.log('Storage Ollama smoke summary:');
console.log(`  zestaw: ${usingSyntheticStorage ? 'syntetyczny (jakosc/dane-testowe)' : 'prawdziwy magazyn uzytkownika'}`);
console.log(`  year: ${year}`);
console.log(`  normalized events: ${events.length}`);
console.log(`  transaction dossiers: ${dossiers.length}`);
console.log(`  ai extracted context rows: ${aiContext.length}`);
console.log(`  ai document classifications: ${aiDocumentClassification.length}`);
console.log(`  ai column mappings: ${aiColumnMappings.length}`);
console.log(`  ollama enabled: ${useOllama ? 'yes' : 'no'}`);
console.log(`  ollama structured probe: ${ollamaProbe.ok ? `yes (${ollamaProbe.model})` : 'no'}`);
console.log(`  full AI storage run: ${fullAiStorageRun ? 'yes' : 'no'}`);
console.log(`  evidence index rows: ${evidenceIndex.length}`);
console.log(`  out dir: ${outDir}`);

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`  error: ${error}`);
  }
  process.exit(1);
}
