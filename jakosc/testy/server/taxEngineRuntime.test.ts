import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import {
  ALLOWED_STORAGE_EXTENSIONS,
  createTaxEngineRunOutputDir,
  getRecentTaxEngineCachedOutputDirs,
  pruneTaxEngineCache,
  getTaxEngineCacheDir,
  getTaxEngineRunOutputDir,
  pruneTaxEngineRunOutputDirs,
  pruneOrphanedRuntimeNamespaces,
  listStorageFiles,
  resolvePythonExecutable,
  resolveStorageFilePath,
  stableTaskFingerprint,
  storageMetadataFingerprint,
  validateTaxYear,
  engineSourceFingerprint,
} from '../../../aplikacje/web/src/server/taxEngineRuntime.ts';
import { ZASADY_PAMIECI_WYNIKOW, createInvestAnalyzerServer, writeCacheFileAtomically } from '../../../aplikacje/web/src/server/createInvestAnalyzerServer.ts';

test('atomowa podmiana zachowuje kompletny plik otwarty przez czytelnika', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-cache-atomic-test-'));
  const filePath = path.join(directory, 'wynik.json');
  const previous = JSON.stringify({ payload: 'stara'.repeat(20_000) });
  const next = JSON.stringify({ payload: 'nowa'.repeat(20_000) });
  fs.writeFileSync(filePath, previous);
  const reader = fs.createReadStream(filePath);
  const chunks: Buffer[] = [];
  reader.on('data', (chunk: Buffer) => chunks.push(chunk));
  try {
    const results = await Promise.all([
      Promise.resolve().then(() => writeCacheFileAtomically(filePath, next)),
      Promise.resolve().then(() => writeCacheFileAtomically(filePath, previous)),
    ]);
    assert.ok(results.some((result) => result === true), 'co najmniej jeden zapis musi zostać opublikowany');
    await new Promise<void>((resolve, reject) => { reader.once('end', resolve); reader.once('error', reject); });
    assert.equal(Buffer.concat(chunks).toString('utf8'), previous);
    assert.ok([previous, next].includes(fs.readFileSync(filePath, 'utf8')));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('sprzątanie pomija junction katalogu głównego oraz używa pełnej tożsamości długiej przestrzeni', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-prune-test-'));
  const originalTmpdir = os.tmpdir;
  const runtimeRoot = path.join(tempRoot, 'invest-analyzer-runtime');
  const outside = path.join(tempRoot, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  try {
    os.tmpdir = () => tempRoot;
    fs.symlinkSync(outside, runtimeRoot, 'junction');
    pruneOrphanedRuntimeNamespaces(runtimeRoot, Date.now() + 3 * 24 * 60 * 60 * 1_000);
    assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
    fs.unlinkSync(runtimeRoot);
    fs.mkdirSync(runtimeRoot);
    const longNameWithIdentity = 'a'.repeat(80);
    const longNameWithoutIdentity = 'b'.repeat(80);
    const missingWorkspace = path.join(tempRoot, 'deleted-workspace');
    for (const name of [longNameWithIdentity, longNameWithoutIdentity]) {
      const namespace = path.join(runtimeRoot, name);
      fs.mkdirSync(namespace);
      fs.utimesSync(namespace, new Date(0), new Date(0));
    }
    fs.writeFileSync(path.join(runtimeRoot, longNameWithIdentity, 'workspace-root.txt'), missingWorkspace);
    pruneOrphanedRuntimeNamespaces(runtimeRoot, Date.now() + 3 * 24 * 60 * 60 * 1_000);
    assert.equal(fs.existsSync(path.join(runtimeRoot, longNameWithIdentity)), false);
    assert.equal(fs.existsSync(path.join(runtimeRoot, longNameWithoutIdentity)), true);
  } finally {
    os.tmpdir = originalTmpdir;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('tax engine dev output directory is inside organized dane tmp', () => {
  const workspaceRoot = 'C:\\Users\\TestUser\\Downloads\\investment-tax-engine';

  const outputDir = getTaxEngineRunOutputDir(workspaceRoot);

  assert.equal(path.isAbsolute(outputDir), true);
  assert.equal(outputDir.includes(path.resolve(workspaceRoot)), false, 'wynik silnika nie może trafić do repozytorium');
  assert.match(outputDir, /invest-analyzer-runtime/i);
  assert.match(outputDir, /investment-tax-engine-dev-runtime/i);
});

test('przebiegi silnika maja osobne katalogi, a retencja chroni aktywny przebieg', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-runs-test-'));
  const outputRoot = getTaxEngineRunOutputDir(workspaceRoot);
  try {
    const runs = Array.from({ length: 22 }, (_, index) => {
      const directory = createTaxEngineRunOutputDir(workspaceRoot, index % 2 === 0 ? 'a'.repeat(64) : 'b'.repeat(64));
      fs.writeFileSync(path.join(directory, 'artifact.json'), String(index));
      fs.utimesSync(directory, new Date(1_700_000_000_000 + index * 1_000), new Date(1_700_000_000_000 + index * 1_000));
      return directory;
    });
    assert.notEqual(runs[0], runs[2], 'ponowny przebieg tego samego klucza nie nadpisuje artefaktów');
    assert.ok(path.basename(runs[0]).length <= 19, 'nazwa katalogu nie może zawierać pełnego klucza SHA-256');
    pruneTaxEngineRunOutputDirs(outputRoot, new Set([runs[0]]));
    assert.equal(fs.readdirSync(outputRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length, 20);
    assert.equal(fs.existsSync(path.join(runs[0], 'artifact.json')), true);
    assert.equal(fs.existsSync(runs[1]), false);
    assert.equal(fs.existsSync(runs[21]), true);
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('retencja chroni przebiegi wskazane przez świeże wpisy cache, ale pomija stare', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-cache-retention-test-'));
  const outputRoot = path.join(workspaceRoot, 'outputs');
  const cacheRoot = path.join(workspaceRoot, 'cache');
  const now = Date.now();
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.mkdirSync(cacheRoot, { recursive: true });
  const recentRun = path.join(outputRoot, 'recent-run');
  const oldRun = path.join(outputRoot, 'old-run');
  fs.mkdirSync(recentRun);
  fs.mkdirSync(oldRun);
  const recentCache = path.join(cacheRoot, `${'a'.repeat(64)}.meta.json`);
  const oldCache = path.join(cacheRoot, `${'b'.repeat(64)}.meta.json`);
  fs.writeFileSync(recentCache, JSON.stringify({ _runtimeOutputDir: recentRun, createdAt: now }));
  fs.writeFileSync(oldCache, JSON.stringify({ _runtimeOutputDir: oldRun, createdAt: now - 8 * 24 * 60 * 60 * 1_000 }));

  try {
    assert.deepEqual(getRecentTaxEngineCachedOutputDirs(cacheRoot, outputRoot, now), new Set([recentRun]));
    pruneTaxEngineRunOutputDirs(outputRoot, getRecentTaxEngineCachedOutputDirs(cacheRoot, outputRoot, now), 0);
    assert.equal(fs.existsSync(recentRun), true);
    assert.equal(fs.existsSync(oldRun), false);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('retencja cache usuwa wpisy stare, ponad limit i ponad limit rozmiaru', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-cache-prune-'));
  const now = Date.now();
  fs.mkdirSync(root, { recursive: true });
  const add = (key: string, createdAt: number, size: number) => {
    fs.writeFileSync(path.join(root, `${key}.json`), 'x'.repeat(size));
    fs.writeFileSync(path.join(root, `${key}.meta.json`), JSON.stringify({ createdAt, size }));
  };
  try {
    for (let i = 0; i < 9; i += 1) add(String(i).repeat(64), now - i, 2);
    add('f'.repeat(64), now - 8 * 24 * 60 * 60 * 1_000, 1);
    pruneTaxEngineCache(root, now);
    assert.equal(fs.readdirSync(root).filter((name) => name.endsWith('.json') && !name.endsWith('.meta.json')).length, 8);
    assert.equal(fs.existsSync(path.join(root, `${'f'.repeat(64)}.meta.json`)), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('limit rozmiaru cache usuwa starszy wpis po przekroczeniu 1 GB', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-cache-size-'));
  const now = Date.now();
  fs.mkdirSync(root, { recursive: true });
  const addSparse = (key: string, createdAt: number) => {
    const file = path.join(root, `${key}.json`);
    fs.writeFileSync(file, '');
    fs.truncateSync(file, 600_000_000);
    fs.writeFileSync(path.join(root, `${key}.meta.json`), JSON.stringify({ createdAt, size: 600_000_000 }));
    return file;
  };
  try {
    const older = addSparse('1'.repeat(64), now - 1);
    const newer = addSparse('2'.repeat(64), now);
    pruneTaxEngineCache(root, now);
    assert.equal(fs.existsSync(newer), true);
    assert.equal(fs.existsSync(older), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('trafienie cache streamuje gotową odpowiedź cached:true bez odczytu pliku JSON', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-cache-hit-workspace-'));
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-cache-hit-runtime-'));
  const storage = path.join(workspaceRoot, 'dane', 'pliki');
  fs.mkdirSync(storage, { recursive: true });
  const body = { year: 2025, runMode: 'SAFE' };
  const fingerprint = stableTaskFingerprint({ storage: await storageMetadataFingerprint(workspaceRoot), engine: engineSourceFingerprint(workspaceRoot), year: 2025, task: body, zasadyPamieci: ZASADY_PAMIECI_WYNIKOW });
  const cacheKey = createHash('sha256').update(fingerprint).digest('hex');
  const cacheDir = getTaxEngineCacheDir(workspaceRoot, runtimeRoot);
  const outputRoot = getTaxEngineRunOutputDir(workspaceRoot, runtimeRoot);
  const outputDir = path.join(outputRoot, 'existing-run');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  const cachePath = path.join(cacheDir, `${cacheKey}.json`);
  const responseBody = JSON.stringify({ success: true, cached: true, payload: 'x'.repeat(2_000_000) });
  fs.writeFileSync(cachePath, responseBody);
  fs.writeFileSync(path.join(cacheDir, `${cacheKey}.meta.json`), JSON.stringify({ _runtimeOutputDir: outputDir, createdAt: Date.now(), size: Buffer.byteLength(responseBody) }));
  const server = http.createServer(createInvestAnalyzerServer({ workspaceRoot, runtimeRoot }));
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tax-engine/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).cached, true);
  } finally {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('blad odczytu wpisu cache daje 503 zamiast zamkniecia serwera', async () => {
  // Wpis moze zniknac miedzy sprawdzeniem a odczytem (retencja po rownoleglym
  // przebiegu). Katalog w miejscu pliku daje ten sam blad strumienia (EISDIR).
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-cache-error-workspace-'));
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-cache-error-runtime-'));
  fs.mkdirSync(path.join(workspaceRoot, 'dane', 'pliki'), { recursive: true });
  const body = { year: 2025, runMode: 'SAFE' };
  const fingerprint = stableTaskFingerprint({ storage: await storageMetadataFingerprint(workspaceRoot), engine: engineSourceFingerprint(workspaceRoot), year: 2025, task: body, zasadyPamieci: ZASADY_PAMIECI_WYNIKOW });
  const cacheKey = createHash('sha256').update(fingerprint).digest('hex');
  const cacheDir = getTaxEngineCacheDir(workspaceRoot, runtimeRoot);
  const outputDir = path.join(getTaxEngineRunOutputDir(workspaceRoot, runtimeRoot), 'existing-run');
  fs.mkdirSync(path.join(cacheDir, `${cacheKey}.json`), { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, `${cacheKey}.meta.json`), JSON.stringify({ _runtimeOutputDir: outputDir, createdAt: Date.now(), size: fs.statSync(path.join(cacheDir, `${cacheKey}.json`)).size }));
  const server = http.createServer(createInvestAnalyzerServer({ workspaceRoot, runtimeRoot }));
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const adres = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tax-engine/run`;
    const response = await fetch(adres, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).success, false);
    assert.equal(server.listening, true, 'serwer dziala dalej');
  } finally {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('obcięty wpis ze starą sumą rozmiaru nie jest trafieniem cache', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-cache-truncated-workspace-'));
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-cache-truncated-runtime-'));
  fs.mkdirSync(path.join(workspaceRoot, 'dane', 'pliki'), { recursive: true });
  const body = { year: 2025, runMode: 'SAFE' };
  const fingerprint = stableTaskFingerprint({ storage: await storageMetadataFingerprint(workspaceRoot), engine: engineSourceFingerprint(workspaceRoot), year: 2025, task: body, zasadyPamieci: ZASADY_PAMIECI_WYNIKOW });
  const cacheKey = createHash('sha256').update(fingerprint).digest('hex');
  const cacheDir = getTaxEngineCacheDir(workspaceRoot, runtimeRoot);
  const outputDir = path.join(getTaxEngineRunOutputDir(workspaceRoot, runtimeRoot), 'existing-run');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  const cachePath = path.join(cacheDir, `${cacheKey}.json`);
  fs.writeFileSync(cachePath, '{"success":true,"cached":');
  fs.writeFileSync(path.join(cacheDir, `${cacheKey}.meta.json`), JSON.stringify({ _runtimeOutputDir: outputDir, createdAt: Date.now(), size: 1_000 }));
  const server = http.createServer(createInvestAnalyzerServer({ workspaceRoot, runtimeRoot }));
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tax-engine/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const result = await response.json() as { cached?: unknown };
    assert.notEqual(result.cached, true);
  } finally {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('trwające pobieranie rezerwuje katalog przebiegu podczas retencji', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-download-retention-workspace-'));
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-download-retention-runtime-'));
  fs.mkdirSync(path.join(workspaceRoot, 'dane', 'pliki'), { recursive: true });
  const body = { year: 2025, runMode: 'SAFE' };
  const fingerprint = stableTaskFingerprint({ storage: await storageMetadataFingerprint(workspaceRoot), engine: engineSourceFingerprint(workspaceRoot), year: 2025, task: body, zasadyPamieci: ZASADY_PAMIECI_WYNIKOW });
  const cacheKey = createHash('sha256').update(fingerprint).digest('hex');
  const cacheDir = getTaxEngineCacheDir(workspaceRoot, runtimeRoot);
  const outputRoot = getTaxEngineRunOutputDir(workspaceRoot, runtimeRoot);
  const downloadDir = path.join(outputRoot, 'download-run');
  const cachedDir = path.join(outputRoot, 'cached-run');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(downloadDir, { recursive: true });
  fs.mkdirSync(cachedDir, { recursive: true });
  const artifactPath = path.join(downloadDir, 'large-artifact.bin');
  fs.writeFileSync(artifactPath, 'x');
  fs.truncateSync(artifactPath, 48 * 1024 * 1024);
  const old = new Date(0);
  fs.utimesSync(downloadDir, old, old);
  fs.utimesSync(cachedDir, old, old);
  for (let index = 0; index < 23; index += 1) {
    const directory = path.join(outputRoot, `recent-${index}`);
    fs.mkdirSync(directory, { recursive: true });
    const timestamp = new Date(1_700_000_000_000 + index * 1_000);
    fs.utimesSync(directory, timestamp, timestamp);
  }
  const serialized = JSON.stringify({ success: true, cached: true });
  fs.writeFileSync(path.join(cacheDir, `${cacheKey}.json`), serialized);
  fs.writeFileSync(path.join(cacheDir, `${cacheKey}.meta.json`), JSON.stringify({ _runtimeOutputDir: cachedDir, createdAt: Date.now(), size: Buffer.byteLength(serialized) }));
  fs.writeFileSync(path.join(cacheDir, `${'b'.repeat(64)}.meta.json`), JSON.stringify({ _runtimeOutputDir: downloadDir, createdAt: Date.now() }));
  const server = http.createServer(createInvestAnalyzerServer({ workspaceRoot, runtimeRoot }));
  let downloadResponse: Response | undefined;
  let secondDownloadResponse: Response | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    downloadResponse = await fetch(`${baseUrl}/api/tax-engine/download?path=${encodeURIComponent(artifactPath)}`);
    assert.equal(downloadResponse.status, 200);
    secondDownloadResponse = await fetch(`${baseUrl}/api/tax-engine/download?path=${encodeURIComponent(artifactPath)}`);
    assert.equal(secondDownloadResponse.status, 200);
    await downloadResponse.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const hit = await fetch(`${baseUrl}/api/tax-engine/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal((await hit.json()).cached, true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(fs.existsSync(downloadDir), true, 'retencja nie może usunąć katalogu, gdy drugie pobieranie trwa');
  } finally {
    await downloadResponse?.body?.cancel().catch(() => undefined);
    await secondDownloadResponse?.body?.cancel().catch(() => undefined);
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('odcisk cache zmienia się po podmianie treści z tym samym mtime i rozmiarem', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tmp-engine-cache-fingerprint-'));
  const storage = path.join(workspaceRoot, 'dane', 'pliki');
  fs.mkdirSync(storage, { recursive: true });
  const filePath = path.join(storage, 'broker.json');
  fs.writeFileSync(filePath, '{}');
  try {
    const before = await storageMetadataFingerprint(workspaceRoot);
    const oldTime = fs.statSync(filePath).mtime;
    fs.writeFileSync(filePath, '[]');
    fs.utimesSync(filePath, oldTime, oldTime);
    const after = await storageMetadataFingerprint(workspaceRoot);
    assert.notEqual(after, before);
    assert.notEqual(
      stableTaskFingerprint({ year: 2025, options: { plan: 'safe' } }),
      stableTaskFingerprint({ year: 2026, options: { plan: 'safe' } }),
    );
    assert.equal(getTaxEngineCacheDir(workspaceRoot).includes(workspaceRoot), false);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('drugi odcisk nie czyta ponownie niezmienionych plików, a zmiana treści unieważnia skrót', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tmp-engine-stream-fingerprint-'));
  const storage = path.join(workspaceRoot, 'dane', 'pliki');
  fs.mkdirSync(storage, { recursive: true });
  const filePath = path.join(storage, 'broker.json');
  fs.writeFileSync(filePath, '{}');
  const originalCreateReadStream = fs.createReadStream;
  let readCount = 0;
  fs.createReadStream = ((...args: Parameters<typeof fs.createReadStream>) => {
    readCount += 1;
    return originalCreateReadStream(...args);
  }) as typeof fs.createReadStream;

  try {
    const before = await storageMetadataFingerprint(workspaceRoot);
    assert.equal(readCount, 1);
    assert.equal(await storageMetadataFingerprint(workspaceRoot), before);
    assert.equal(readCount, 1, 'niezmieniony plik powinien skorzystać ze skrótu w pamięci');

    fs.writeFileSync(filePath, '[]');
    const after = await storageMetadataFingerprint(workspaceRoot);
    assert.notEqual(after, before);
    assert.equal(readCount, 2, 'zmieniony plik powinien zostać ponownie zahashowany');
  } finally {
    fs.createReadStream = originalCreateReadStream;
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('storage file resolver blocks traversal but accepts inert file extensions', () => {
  const workspaceRoot = 'C:\\Users\\TestUser\\Downloads\\investment-tax-engine';
  const safePath = resolveStorageFilePath(workspaceRoot, 'raport.json');
  const nestedSafePath = resolveStorageFilePath(workspaceRoot, 'Dane/broker_raport.json');

  assert.equal(path.isAbsolute(safePath), true);
  assert.equal(safePath, path.resolve(workspaceRoot, 'dane', 'pliki', 'raport.json'));
  assert.equal(nestedSafePath, path.resolve(workspaceRoot, 'dane', 'pliki', 'Dane', 'broker_raport.json'));

  assert.throws(() => resolveStorageFilePath(workspaceRoot, '../package.json'), /nazwa pliku/i);
  assert.throws(() => resolveStorageFilePath(workspaceRoot, '..\\package.json'), /nazwa pliku/i);
  assert.throws(() => resolveStorageFilePath(workspaceRoot, 'Dane/../raport.json'), /nazwa pliku/i);
  assert.throws(() => resolveStorageFilePath(workspaceRoot, 'Dane//raport.json'), /nazwa pliku/i);
  assert.throws(() => resolveStorageFilePath(workspaceRoot, '.secret.json'), /nazwa pliku/i);
  assert.throws(() => resolveStorageFilePath(workspaceRoot, 'Dane/.cache.json'), /nazwa pliku/i);
  assert.throws(() => resolveStorageFilePath(workspaceRoot, 'Backups/old.json'), /nazwa pliku/i);
  assert.throws(() => resolveStorageFilePath(workspaceRoot, 'DIST/asset.json'), /nazwa pliku/i);
  assert.throws(() => resolveStorageFilePath(workspaceRoot, 'node_modules/package.json'), /nazwa pliku/i);
  // Powloka desktop odrzuca te rozszerzenia od zawsze; serwer webowy odsylal je
  // przez res.sendFile. Ta sama aplikacja zachowywala sie inaczej zaleznie od
  // runtime'u, wbrew kryterium wydania "Unsafe extensions are blocked".
  for (const unsafeName of ['program.exe', 'skrypt.ps1', 'instalator.msi', 'biblioteka.dll', 'wsad.bat', 'skrot.lnk']) {
    assert.throws(() => resolveStorageFilePath(workspaceRoot, unsafeName), /Nieobsługiwana nazwa pliku/i, unsafeName);
  }
  assert.throws(() => resolveStorageFilePath(workspaceRoot, 'bez_rozszerzenia'), /Nieobsługiwana nazwa pliku/i);

  for (const allowedName of ['raport.json', 'kursy.csv', 'wyciag.xlsx', 'taryfa.pdf', 'raport.xml', 'notatka.txt']) {
    assert.equal(
      resolveStorageFilePath(workspaceRoot, allowedName),
      path.resolve(workspaceRoot, 'dane', 'pliki', allowedName),
      allowedName,
    );
  }
});

test('lista dozwolonych rozszerzeń jest taka sama w obu runtime’ach', async () => {
  const rustGuard = await fs.promises.readFile(
    path.resolve('aplikacje', 'komputerowa', 'tauri', 'src', 'security', 'extension_guard.rs'),
    'utf8',
  );
  const start = rustGuard.indexOf('ALLOWED_IMPORT_EXTENSIONS: &[&str] = &[');
  assert.ok(start >= 0, 'nie znaleziono listy rozszerzeń w powłoce desktop');
  const literal = rustGuard.slice(start, rustGuard.indexOf('];', start));
  const listed = (literal.match(/"([a-z]+)"/g) ?? []).map((entry) => entry.replaceAll('"', ''));

  assert.ok(listed.length > 0, 'nie udało się odczytać listy z powłoki desktop');
  assert.deepEqual([...ALLOWED_STORAGE_EXTENSIONS].sort(), listed.sort());
});

test('storage file lister returns nested files as relative paths', async () => {
  const workspaceRoot = await fs.promises.mkdtemp(path.join(process.cwd(), 'tmp-storage-list-'));
  await fs.promises.mkdir(path.join(workspaceRoot, 'dane', 'pliki', 'Dane'), { recursive: true });
  await fs.promises.writeFile(path.join(workspaceRoot, 'dane', 'pliki', 'root.json'), '{}');
  await fs.promises.writeFile(path.join(workspaceRoot, 'dane', 'pliki', 'Dane', 'broker.json'), '{}');
  await fs.promises.writeFile(path.join(workspaceRoot, 'dane', 'pliki', 'Dane', 'ignore.exe'), '');

  try {
    // Plik, ktorego i tak nie wolno odczytac, nie ma po co pojawiac sie na liscie.
    assert.deepEqual(await listStorageFiles(workspaceRoot), ['Dane/broker.json', 'root.json']);
  } finally {
    await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('storage file lister ignores technical directories case-insensitively', async () => {
  const workspaceRoot = await fs.promises.mkdtemp(path.join(process.cwd(), 'tmp-storage-list-ignored-'));
  await fs.promises.mkdir(path.join(workspaceRoot, 'dane', 'pliki', 'Dane'), { recursive: true });
  await fs.promises.mkdir(path.join(workspaceRoot, 'dane', 'pliki', 'Backups'), { recursive: true });
  await fs.promises.mkdir(path.join(workspaceRoot, 'dane', 'pliki', 'DIST'), { recursive: true });
  await fs.promises.writeFile(path.join(workspaceRoot, 'dane', 'pliki', 'Dane', 'broker.json'), '{}');
  await fs.promises.writeFile(path.join(workspaceRoot, 'dane', 'pliki', 'Backups', 'old.json'), '{}');
  await fs.promises.writeFile(path.join(workspaceRoot, 'dane', 'pliki', 'DIST', 'asset.json'), '{}');

  try {
    assert.deepEqual(await listStorageFiles(workspaceRoot), ['Dane/broker.json']);
  } finally {
    await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('storage file lister ignores hidden files at every nesting level', async () => {
  const workspaceRoot = await fs.promises.mkdtemp(path.join(process.cwd(), 'tmp-storage-list-hidden-files-'));
  await fs.promises.mkdir(path.join(workspaceRoot, 'dane', 'pliki', 'Dane'), { recursive: true });
  await fs.promises.writeFile(path.join(workspaceRoot, 'dane', 'pliki', '.secret.json'), '{}');
  await fs.promises.writeFile(path.join(workspaceRoot, 'dane', 'pliki', 'Dane', '.cache.json'), '{}');
  await fs.promises.writeFile(path.join(workspaceRoot, 'dane', 'pliki', 'Dane', 'broker.json'), '{}');

  try {
    assert.deepEqual(await listStorageFiles(workspaceRoot), ['Dane/broker.json']);
  } finally {
    await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('storage file lister returns an empty list when storage directory is missing', async () => {
  const workspaceRoot = await fs.promises.mkdtemp(path.join(process.cwd(), 'tmp-storage-missing-'));

  try {
    assert.deepEqual(await listStorageFiles(workspaceRoot), []);
  } finally {
    await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('storage file lister returns an empty list when storage path is not a directory', async () => {
  const workspaceRoot = await fs.promises.mkdtemp(path.join(process.cwd(), 'tmp-storage-file-'));
  await fs.promises.mkdir(path.join(workspaceRoot, 'dane'), { recursive: true });
  await fs.promises.writeFile(path.join(workspaceRoot, 'dane', 'pliki'), 'not a directory');

  try {
    assert.deepEqual(await listStorageFiles(workspaceRoot), []);
  } finally {
    await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('tax year validation rejects invalid or unsafe values', () => {
  assert.equal(validateTaxYear(2025, 2026), 2025);

  assert.throws(() => validateTaxYear('2025', 2026), /liczbą całkowitą/i);
  assert.throws(() => validateTaxYear(1899, 2026), /zakresem/i);
  assert.throws(() => validateTaxYear(2200, 2026), /zakresem/i);
  assert.throws(() => validateTaxYear(2025.5, 2026), /liczbą całkowitą/i);
});

test('python executable resolver prefers virtual environments and falls back safely', () => {
  const workspaceRoot = path.resolve('C:\\workspace\\tax-app');
  const windowsVenv = path.join(workspaceRoot, 'silnik', 'python', '.venv', 'Scripts', 'python.exe');
  const unixVenv = path.join(workspaceRoot, 'silnik', 'python', '.venv', 'bin', 'python');

  // Otoczenie podajemy jawnie: bez tego test zalezal od zmiennych maszyny,
  // na ktorej akurat dziala, i wywracal sie u kazdego, kto ma ustawione
  // INVEST_PYTHON.
  const bezWskazania = {} as NodeJS.ProcessEnv;

  assert.equal(
    resolvePythonExecutable(workspaceRoot, (candidate) => candidate === windowsVenv, bezWskazania),
    windowsVenv,
  );
  assert.equal(
    resolvePythonExecutable(workspaceRoot, (candidate) => candidate === unixVenv, bezWskazania),
    unixVenv,
  );
  assert.match(resolvePythonExecutable(workspaceRoot, () => false, bezWskazania), /^python/);
});

test('wskazanie interpretera zmienna srodowiskowa ma pierwszenstwo', () => {
  // Na maszynie innej niz ta, na ktorej zbudowano .venv, automatyczne szukanie
  // trafia na interpreter bez zaleznosci silnika. Jawne wskazanie musi wygrac.
  const wybrany = resolvePythonExecutable('/warsztat', () => true, {
    INVEST_PYTHON: '/opt/python/bin/python3',
  } as NodeJS.ProcessEnv);

  assert.equal(wybrany, '/opt/python/bin/python3');
});


test("INVEST_PYTHON wskazuje interpreter wprost, z pominieciem .venv", () => {
  const wybrany = resolvePythonExecutable(
    "/warsztat",
    () => true,
    { INVEST_PYTHON: "/opt/python/bin/python3" } as NodeJS.ProcessEnv,
  );
  assert.equal(wybrany, "/opt/python/bin/python3");
});

test("pusta zmienna INVEST_PYTHON nie przeslania wykrywania .venv", () => {
  const wybrany = resolvePythonExecutable(
    "/warsztat",
    (kandydat) => kandydat.includes(".venv"),
    { INVEST_PYTHON: "   " } as NodeJS.ProcessEnv,
  );
  assert.ok(wybrany.includes(".venv"), `oczekiwano sciezki z .venv, otrzymano ${wybrany}`);
});

test('zmiana kodu silnika zmienia odcisk, wiec stary wynik nie wraca z pamieci podrecznej', async () => {
  const os = await import('node:os');
  const { engineSourceFingerprint } = await import('../../../aplikacje/web/src/server/taxEngineRuntime.ts');
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-engine-fingerprint-'));
  try {
    assert.equal(engineSourceFingerprint(workspaceRoot), 'no-engine-source');
    const pakiet = path.join(workspaceRoot, 'silnik', 'python', 'src', 'pakiet');
    fs.mkdirSync(path.join(pakiet, '__pycache__'), { recursive: true });
    const sourcePath = path.join(pakiet, 'fifo.py');
    fs.writeFileSync(sourcePath, 'STAWKA = 19\n');
    const przed = engineSourceFingerprint(workspaceRoot);
    // Pliki skompilowane nie sa kodem zrodlowym - nie moga uniewazniac wyniku.
    fs.writeFileSync(path.join(pakiet, '__pycache__', 'fifo.cpython-312.pyc'), 'x');
    assert.equal(engineSourceFingerprint(workspaceRoot), przed);
    const mtime = fs.statSync(sourcePath).mtime;
    fs.writeFileSync(sourcePath, 'STAWKA = 20\n');
    fs.utimesSync(sourcePath, mtime, mtime);
    assert.notEqual(engineSourceFingerprint(workspaceRoot), przed);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('storage odrzuca junction katalogu w ścieżce', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-link-test-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-outside-test-'));
  const storage = path.join(workspaceRoot, 'dane', 'pliki');
  fs.mkdirSync(storage, { recursive: true });
  fs.writeFileSync(path.join(outside, 'private.json'), '{}');
  try {
    fs.symlinkSync(outside, path.join(storage, 'linked'), 'junction');
    assert.throws(() => resolveStorageFilePath(workspaceRoot, 'linked/private.json'), /Dowiązanie/);
    assert.throws(() => resolveStorageFilePath(workspaceRoot, 'linked/new.json'), /Dowiązanie/);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
