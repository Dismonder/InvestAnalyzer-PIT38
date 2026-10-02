import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { sprawdzProgTestow } from './prog-testow.mjs';

// Stan na 2026-09-06: 265 testow. Prog z zapasem na zwykle porzadki.
const PROG_TESTOW_FRONTEND = 258;

const result = spawnSync(
  process.execPath,
  [
    '--import',
    'tsx',
    '--test',
    'jakosc/testy/frontend/*.test.ts',
    'jakosc/testy/frontend/*.test.tsx',
    'jakosc/testy/server/*.test.ts',
  ],
  {
    encoding: 'utf8', shell: false, maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      FREEDOM24_DISABLE_LIVE: '1',
      INVEST_PYTHON: process.env.INVEST_PYTHON || path.resolve('silnik/python/.venv/Scripts/python.exe'),
    },
  },
);

if (result.error) {
  console.error(`Nie udało się uruchomić testów frontendu: ${result.error.message}`);
  process.exit(1);
}

const wyjscie = `${result.stdout || ''}${result.stderr || ''}`;
process.stdout.write(wyjscie);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const zdane = Number(/^.\s*pass (\d+)$/m.exec(wyjscie)?.[1]);
const pominiete =
  Number(/^.\s*skipped (\d+)$/m.exec(wyjscie)?.[1] ?? 0) + Number(/^.\s*todo (\d+)$/m.exec(wyjscie)?.[1] ?? 0);

sprawdzProgTestow({ nazwa: 'Frontend i serwer', zdane, pominiete, prog: PROG_TESTOW_FRONTEND });
