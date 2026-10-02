import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pythonEngineDir, rootDir } from '../projectPaths.mjs';
import { sprawdzProgTestow } from './prog-testow.mjs';

// Stan na 2026-09-06: 318 testow. Prog z zapasem na zwykle porzadki.
const PROG_TESTOW_PYTHON = 310;

const pythonProjectDir = pythonEngineDir;
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

// Zmienna INVEST_PYTHON wskazuje interpreter wprost - tak samo jak robi to
// serwer aplikacji i pozostale skrypty. Bez niej kazdy szukal Pythona po
// swojemu i na maszynie innej niz ta, na ktorej zbudowano .venv, bral pierwszy
// z brzegu, ktoremu brakowalo zaleznosci silnika.
const wskazanyInterpreterRaw = String(process.env.INVEST_PYTHON || '').trim();
// `spawnSync` runs pytest from silnik/python. Resolve a documented relative
// override against the repository before changing cwd.
const wskazanyInterpreter = wskazanyInterpreterRaw && !isAbsolute(wskazanyInterpreterRaw)
  ? resolve(rootDir, wskazanyInterpreterRaw)
  : wskazanyInterpreterRaw;

const pythonExecutable = wskazanyInterpreter || candidates.find((candidate) => candidate.includes('\\') || candidate.includes('/')
  ? existsSync(candidate)
  : true);

// Wyjscie idzie do konsoli i jednoczesnie do bufora - podsumowanie pytest
// jest jedynym miejscem, z ktorego widac, ile testow naprawde sie wykonalo.
const result = spawnSync(pythonExecutable, ['-m', 'pytest'], {
  cwd: pythonProjectDir,
  encoding: 'utf8',
  shell: false,
  maxBuffer: 64 * 1024 * 1024,
});

if (result.error) {
  console.error(`Nie udało się uruchomić testów Python: ${result.error.message}`);
  process.exit(1);
}

const wyjscie = `${result.stdout || ''}${result.stderr || ''}`;
process.stdout.write(wyjscie);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const zdane = Number(/(\d+) passed/.exec(wyjscie)?.[1]);
const pominiete = Number(/(\d+) skipped/.exec(wyjscie)?.[1] ?? 0);

sprawdzProgTestow({ nazwa: 'Python', zdane, pominiete, prog: PROG_TESTOW_PYTHON });
