import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createInvestAnalyzerServer } from '../../../aplikacje/web/src/server/createInvestAnalyzerServer.ts';
import { getTaxEngineCacheDir, getTaxEngineRunOutputDir } from '../../../aplikacje/web/src/server/taxEngineRuntime.ts';

test('brakujący artefakt wskazany w cache zwraca 410 z komunikatem o przeliczeniu', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tax-artifact-410-test-'));
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tax-artifact-runtime-'));
  const outputRoot = getTaxEngineRunOutputDir(workspaceRoot, runtimeRoot);
  const cacheRoot = getTaxEngineCacheDir(workspaceRoot, runtimeRoot);
  const removedRunDir = path.join(outputRoot, 'removed-run');
  fs.mkdirSync(cacheRoot, { recursive: true });
  fs.mkdirSync(outputRoot, { recursive: true });
  const cacheKey = 'a'.repeat(64);
  fs.writeFileSync(path.join(cacheRoot, `${cacheKey}.meta.json`), JSON.stringify({ _runtimeOutputDir: removedRunDir, createdAt: Date.now() }));
  const server = createInvestAnalyzerServer({ workspaceRoot, runtimeRoot }).listen(0, '127.0.0.1');

  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const artifactPath = path.join(removedRunDir, 'report.xlsx');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/tax-engine/download?${new URLSearchParams({ path: artifactPath })}`, {
      headers: { host: `localhost.:${address.port}` },
    });
    assert.equal(response.status, 410);
    assert.equal((await response.json()).error, 'Pliki tego przebiegu zostały usunięte — przelicz ponownie');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(cacheRoot, { recursive: true, force: true });
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('pobranie pliku spoza katalogu znanego przebiegu jest zabronione', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tax-artifact-scope-test-'));
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tax-artifact-scope-runtime-'));
  const outputRoot = getTaxEngineRunOutputDir(workspaceRoot, runtimeRoot);
  const cacheRoot = getTaxEngineCacheDir(workspaceRoot, runtimeRoot);
  const knownDir = path.join(outputRoot, 'known-run');
  const otherDir = path.join(outputRoot, 'other-run');
  fs.mkdirSync(knownDir, { recursive: true });
  fs.mkdirSync(otherDir, { recursive: true });
  fs.mkdirSync(cacheRoot, { recursive: true });
  fs.writeFileSync(path.join(cacheRoot, `${'c'.repeat(64)}.meta.json`), JSON.stringify({ _runtimeOutputDir: knownDir, createdAt: Date.now() }));
  const otherFile = path.join(otherDir, 'private.txt');
  fs.writeFileSync(otherFile, 'private');
  const server = createInvestAnalyzerServer({ workspaceRoot, runtimeRoot }).listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/tax-engine/download?${new URLSearchParams({ path: otherFile })}`);
    assert.equal(response.status, 403);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('logi przebiegu (stderr.log, stdout.log) nie są wydawane, a raport z tego samego katalogu tak', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tax-artifact-log-test-'));
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tax-artifact-log-runtime-'));
  const outputRoot = getTaxEngineRunOutputDir(workspaceRoot, runtimeRoot);
  const cacheRoot = getTaxEngineCacheDir(workspaceRoot, runtimeRoot);
  const runDir = path.join(outputRoot, 'run-z-logami');
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(cacheRoot, { recursive: true });
  fs.writeFileSync(path.join(cacheRoot, `${'d'.repeat(64)}.meta.json`), JSON.stringify({ _runtimeOutputDir: runDir, createdAt: Date.now() }));
  fs.writeFileSync(path.join(runDir, 'stderr.log'), 'Traceback: wyciag_atrapa.csv');
  fs.writeFileSync(path.join(runDir, 'stdout.log'), 'surowy wynik');
  fs.writeFileSync(path.join(runDir, 'Inny.LOG'), 'inny log');
  fs.writeFileSync(path.join(runDir, 'raport.json'), '{}');
  const server = createInvestAnalyzerServer({ workspaceRoot, runtimeRoot }).listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const pobierz = (plik: string) => fetch(`http://127.0.0.1:${address.port}/api/tax-engine/download?${new URLSearchParams({ path: path.join(runDir, plik) })}`);
    for (const log of ['stderr.log', 'stdout.log', 'Inny.LOG']) {
      const odpowiedz = await pobierz(log);
      assert.equal(odpowiedz.status, 403, `${log} nie może być wydany`);
      assert.doesNotMatch(await odpowiedz.text(), /Traceback|surowy|inny log/);
    }
    const raport = await pobierz('raport.json');
    assert.equal(raport.status, 200);
    await raport.body?.cancel();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});