import { spawnSync } from 'node:child_process';

const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'jakosc/testy/integracje/freedom24.integration.test.ts'], {
  encoding: 'utf8',
  env: { ...process.env, FREEDOM24_INTEGRATION: '1' },
});
const output = `${result.stdout || ''}${result.stderr || ''}`;
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
if (result.status === 0 && /ok\s+\d+\s+- Freedom24 integration: authenticated read-only endpoints\s+# SKIP/.test(output)) {
  console.error('POMINIĘTO — brak poświadczeń, integracja NIE została sprawdzona');
  process.exit(1);
}
process.exit(result.status ?? 1);
