/**
 * Pamiec wynikow silnika (7 dni) nie moze utrwalac wyniku zablokowanego przez
 * chwilowa awarie sieci NBP (NBP_RATE_NOT_FOUND "request failed" itp.) - zwykle
 * przeliczenie zwracalo by wtedy zablokowany wynik mimo przywroconej sieci.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';

import { createInvestAnalyzerServer } from '../../../aplikacje/web/src/server/createInvestAnalyzerServer.ts';
import { getTaxEngineRunOutputDir } from '../../../aplikacje/web/src/server/taxEngineRuntime.ts';

async function dwaPrzebiegi(wynikSilnika: Record<string, unknown>): Promise<[boolean, boolean]> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-cache-nbp-'));
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-cache-nbp-runtime-'));
  fs.mkdirSync(path.join(root, 'dane', 'pliki'), { recursive: true });
  const script = path.join(root, 'silnik', 'python', 'src', 'investment_tax_engine', 'app', 'cli.py');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, `process.stdout.write(JSON.stringify(${JSON.stringify(wynikSilnika)}));`);
  const stary = process.env.INVEST_PYTHON;
  process.env.INVEST_PYTHON = process.execPath;
  const serwer = http.createServer(createInvestAnalyzerServer({ workspaceRoot: root, runtimeRoot }));
  await new Promise<void>((resolve) => serwer.listen(0, '127.0.0.1', resolve));
  try {
    const adres = `http://127.0.0.1:${(serwer.address() as AddressInfo).port}/api/tax-engine/run`;
    const wyslij = async () => (await (await fetch(adres, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ year: 2025 }),
    })).json()) as { success: boolean; cached: boolean };
    const pierwszy = await wyslij();
    assert.equal(pierwszy.success, true);
    await new Promise((resolve) => setTimeout(resolve, 300)); // zapis pamieci po wyslaniu odpowiedzi
    const drugi = await wyslij();
    return [pierwszy.cached, drugi.cached];
  } finally {
    if (stary === undefined) delete process.env.INVEST_PYTHON; else process.env.INVEST_PYTHON = stary;
    await new Promise<void>((resolve) => serwer.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
}

test('wynik z problemem NBP nie trafia do pamieci wynikow', async () => {
  for (const kod of ['NBP_RATE_NOT_FOUND', 'NBP_COVERAGE_GAP']) {
    const [pierwszy, drugi] = await dwaPrzebiegi({
      issues: [{ code: kod, message: 'NBP API request failed for USD:2025-03-01', severity: 'ERROR' }],
      actionable_issues: [{ code: kod }],
    });
    assert.equal(pierwszy, false);
    assert.equal(drugi, false, `${kod}: kolejne przeliczenie musi isc do silnika`);
  }
});

test('wynik NBP bez zapisu do pamięci nadal uruchamia retencję katalogów', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-cache-nbp-retention-'));
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-cache-nbp-retention-rt-'));
  fs.mkdirSync(path.join(root, 'dane', 'pliki'), { recursive: true });
  const outputRoot = getTaxEngineRunOutputDir(root, runtimeRoot);
  fs.mkdirSync(outputRoot, { recursive: true });
  for (let index = 0; index < 21; index += 1) {
    const directory = path.join(outputRoot, `old-${index}`);
    fs.mkdirSync(directory);
    fs.utimesSync(directory, new Date(0), new Date(0));
  }
  const script = path.join(root, 'silnik', 'python', 'src', 'investment_tax_engine', 'app', 'cli.py');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, `process.stdout.write(JSON.stringify({ issues: [{ code: 'NBP_RATE_NOT_FOUND', blocking: true }] }));`);
  const stary = process.env.INVEST_PYTHON;
  process.env.INVEST_PYTHON = process.execPath;
  const serwer = http.createServer(createInvestAnalyzerServer({ workspaceRoot: root, runtimeRoot }));
  await new Promise<void>((resolve) => serwer.listen(0, '127.0.0.1', resolve));
  try {
    const odpowiedz = await fetch(`http://127.0.0.1:${(serwer.address() as AddressInfo).port}/api/tax-engine/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ year: 2025 }),
    });
    assert.equal((await odpowiedz.json()).cached, false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(fs.readdirSync(outputRoot).length <= 20, 'retencja usuwa nadmiarowe katalogi po odpowiedzi bez cache');
  } finally {
    if (stary === undefined) delete process.env.INVEST_PYTHON; else process.env.INVEST_PYTHON = stary;
    await new Promise<void>((resolve) => serwer.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test('nieblokujaca informacja o zakresie archiwum NBP nie wylacza pamieci wynikow', async () => {
  const [pierwszy, drugi] = await dwaPrzebiegi({
    issues: [{ code: 'NBP_COVERAGE_GAP', severity: 'CRITICAL', blocking: false, message: 'Zakres dat wykracza poza dane w archiwum CSV' }],
    actionable_issues: [{ code: 'NBP_COVERAGE_GAP', blocking: false }],
  });
  assert.equal(pierwszy, false);
  assert.equal(drugi, true);
});

test('wynik bez problemow NBP nadal jest zapamietywany', async () => {
  const [pierwszy, drugi] = await dwaPrzebiegi({
    issues: [{ code: 'FIELD_CONFLICT', severity: 'WARNING' }],
    actionable_issues: [],
  });
  assert.equal(pierwszy, false);
  assert.equal(drugi, true);
});

test('wpis pamieci zapisany przed zmiana zasad (bez wersji w kluczu) nie jest uzywany', async () => {
  const { createHash } = await import('node:crypto');
  const { stableTaskFingerprint, storageMetadataFingerprint, engineSourceFingerprint, getTaxEngineCacheDir, getTaxEngineRunOutputDir } =
    await import('../../../aplikacje/web/src/server/taxEngineRuntime.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-cache-wersja-'));
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-cache-wersja-rt-'));
  fs.mkdirSync(path.join(root, 'dane', 'pliki'), { recursive: true });
  const script = path.join(root, 'silnik', 'python', 'src', 'investment_tax_engine', 'app', 'cli.py');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, `process.stdout.write(JSON.stringify({ marker: 'swiezy', issues: [] }));`);
  const body = { year: 2025 };
  // Klucz z czasow sprzed wersjonowania zasad: bez pola wersji w odcisku.
  const staryKlucz = createHash('sha256').update(stableTaskFingerprint({
    storage: await storageMetadataFingerprint(root), engine: engineSourceFingerprint(root), year: 2025, task: body,
  })).digest('hex');
  const cacheDir = getTaxEngineCacheDir(root, runtimeRoot);
  const outputDir = path.join(getTaxEngineRunOutputDir(root, runtimeRoot), 'stary-przebieg');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  const stary = JSON.stringify({ success: true, cached: true, marker: 'stary-zablokowany' });
  fs.writeFileSync(path.join(cacheDir, `${staryKlucz}.json`), stary);
  fs.writeFileSync(path.join(cacheDir, `${staryKlucz}.meta.json`), JSON.stringify({ _runtimeOutputDir: outputDir, createdAt: Date.now(), size: Buffer.byteLength(stary) }));
  const stareEnv = process.env.INVEST_PYTHON;
  process.env.INVEST_PYTHON = process.execPath;
  const serwer = http.createServer(createInvestAnalyzerServer({ workspaceRoot: root, runtimeRoot }));
  await new Promise<void>((resolve) => serwer.listen(0, '127.0.0.1', resolve));
  try {
    const odpowiedz = await fetch(`http://127.0.0.1:${(serwer.address() as AddressInfo).port}/api/tax-engine/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const wynik = (await odpowiedz.json()) as { marker: string; cached: boolean };
    assert.equal(wynik.marker, 'swiezy', 'stary wpis nie moze zwrocic zablokowanego wyniku');
    assert.equal(wynik.cached, false);
  } finally {
    if (stareEnv === undefined) delete process.env.INVEST_PYTHON; else process.env.INVEST_PYTHON = stareEnv;
    await new Promise<void>((resolve) => serwer.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
