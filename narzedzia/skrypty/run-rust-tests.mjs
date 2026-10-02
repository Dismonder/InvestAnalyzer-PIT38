import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { rootDir } from '../projectPaths.mjs';
import { sprawdzProgTestow } from './prog-testow.mjs';

// Stan na 2026-09-06: 47 testow. Prog z zapasem na zwykle porzadki.
const PROG_TESTOW_RUST = 44;

const result = spawnSync(
  'cargo',
  ['test', '--manifest-path', join(rootDir, 'aplikacje', 'komputerowa', 'tauri', 'Cargo.toml')],
  { encoding: 'utf8', shell: false, maxBuffer: 64 * 1024 * 1024 },
);

if (result.error) {
  console.error(`Nie udało się uruchomić testów Rust: ${result.error.message}`);
  process.exit(1);
}

const wyjscie = `${result.stdout || ''}${result.stderr || ''}`;
process.stdout.write(wyjscie);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

// cargo drukuje podsumowanie osobno dla kazdego celu; licza sie wszystkie razem.
const sumujPodsumowania = (wzorzec) =>
  [...wyjscie.matchAll(wzorzec)].reduce((suma, dopasowanie) => suma + Number(dopasowanie[1]), 0);

const zdane = sumujPodsumowania(/test result: ok\. (\d+) passed/g);
const pominiete = sumujPodsumowania(/(\d+) ignored/g);

sprawdzProgTestow({ nazwa: 'Rust', zdane, pominiete, prog: PROG_TESTOW_RUST });
