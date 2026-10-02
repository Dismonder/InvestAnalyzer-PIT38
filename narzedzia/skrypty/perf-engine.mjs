import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { pythonEngineDir, rootDir, tmpDir } from '../projectPaths.mjs';

const pythonProjectDir = pythonEngineDir;
const outDir = join(tmpDir, 'perf-engine');
const maxRuntimeMs = process.env.MAX_ENGINE_RUN_MS ? Number(process.env.MAX_ENGINE_RUN_MS) : 180000;
if (!Number.isFinite(maxRuntimeMs) || maxRuntimeMs <= 0) {
  throw new Error(`MAX_ENGINE_RUN_MS musi być skończoną liczbą dodatnią (otrzymano: ${process.env.MAX_ENGINE_RUN_MS}).`);
}
const year = String(process.env.PERF_ENGINE_YEAR || 2025);
const exportMode = String(process.env.PERF_ENGINE_EXPORT_MODE || 'full').trim().toLowerCase() || 'full';

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
  console.error('Nie znaleziono interpretera Python do pomiaru silnika.');
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const startedAt = performance.now();
const result = spawnSync(
  pythonExecutable,
  ['-m', 'investment_tax_engine.app.cli', '--year', year, '--out-dir', outDir, '--bez-kopii-out'],
  {
    cwd: pythonProjectDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      PYTHONPATH: join(pythonProjectDir, 'src'),
      INVEST_TAX_EXPORT_MODE: exportMode,
    },
    maxBuffer: 80 * 1024 * 1024,
    shell: false,
  },
);
const elapsedMs = performance.now() - startedAt;

if (result.error) {
  console.error(`Nie udało się uruchomić silnika Python: ${result.error.message}`);
  process.exit(1);
}

if (result.status !== 0) {
  console.error(result.stderr || result.stdout || 'Silnik Python zakończył się błędem.');
  process.exit(result.status ?? 1);
}

let payload;
try {
  payload = JSON.parse(result.stdout);
} catch (error) {
  console.error(`Silnik Python nie zwrócił poprawnego JSON: ${error.message}`);
  process.exit(1);
}

const historyRows = Array.isArray(payload.transaction_history_rows) ? payload.transaction_history_rows.length : 0;
const editableRecords = Array.isArray(payload.editable_records) ? payload.editable_records.length : 0;
const issueCount = Number(payload.issue_count || 0);
const auditHash = String(payload.audit_hash || '').slice(0, 12);

console.log('Engine performance summary:');
console.log(`  year: ${year}`);
console.log(`  export mode: ${exportMode}`);
console.log(`  runtime: ${elapsedMs.toFixed(0)} ms`);
console.log(`  history rows: ${historyRows}`);
console.log(`  editable records: ${editableRecords}`);
console.log(`  actionable issues: ${issueCount}`);
console.log(`  audit hash: ${auditHash || 'brak'}`);

if (payload.performance_profile?.stages?.length) {
  console.log('  stages:');
  for (const stage of payload.performance_profile.stages) {
    const skippedLabel = stage.skipped ? ' (pominięty)' : '';
    console.log(`    ${stage.stage}: ${Number(stage.duration_ms || 0).toFixed(1)} ms${skippedLabel}`);
  }
}

if (elapsedMs > maxRuntimeMs) {
  console.error(`Engine performance gate failed: ${elapsedMs.toFixed(0)} ms > ${maxRuntimeMs} ms`);
  process.exit(1);
}
