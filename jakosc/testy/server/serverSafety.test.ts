import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import { createInvestAnalyzerServer, checkOllamaStatus } from '../../../aplikacje/web/src/server/createInvestAnalyzerServer.ts';
import { getTaxEngineRunOutputDir } from '../../../aplikacje/web/src/server/taxEngineRuntime.ts';
import { cacheQuote, quoteCache } from '../../../aplikacje/web/src/server/routes/quotes.ts';

async function withServer(root: string, run: (url: string, runtimeRoot: string) => Promise<void>) {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-server-runtime-'));
  const server = http.createServer(createInvestAnalyzerServer({ workspaceRoot: root, runtimeRoot }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, runtimeRoot);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
}

function tempWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-server-safety-'));
  fs.mkdirSync(path.join(root, 'dane', 'pliki'), { recursive: true });
  return root;
}

test('dwa różne pliki o tej samej nazwie w jednym żądaniu pozostają na dysku', async () => {
  const root = tempWorkspace();
  try {
    await withServer(root, async (url) => {
      const response = await fetch(`${url}/api/storage/files`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ files: [
          { fileName: 'same.json', relativePath: 'same.json', base64: Buffer.from('{"a":1}').toString('base64') },
          { fileName: 'same.json', relativePath: 'same.json', base64: Buffer.from('{"a":2}').toString('base64') },
        ] }),
      });
      const result = await response.json() as { imported: Array<{ relativePath: string }>; failed: unknown[] };
      assert.equal(result.failed.length, 0);
      assert.equal(result.imported.length, 2);
      assert.notEqual(result.imported[0].relativePath, result.imported[1].relativePath);
      assert.deepEqual(result.imported.map(({ relativePath }) => fs.readFileSync(path.join(root, 'dane', 'pliki', relativePath), 'utf8')), ['{"a":1}', '{"a":2}']);
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('magazyn odrzuca odczyt i zapis przez junction katalogu', async () => {
  const root = tempWorkspace();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-server-outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'secret.json'), '{"private":true}');
    fs.symlinkSync(outside, path.join(root, 'dane', 'pliki', 'linked'), 'junction');
    await withServer(root, async (url) => {
      const read = await fetch(`${url}/api/storage/files/linked/secret.json`);
      assert.notEqual(read.status, 200);
      const write = await fetch(`${url}/api/storage/files`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ files: [{ fileName: 'new.json', relativePath: 'linked/new.json', base64: 'e30=' }] }) });
      const result = await write.json() as { failed: unknown[] };
      assert.equal(result.failed.length, 1);
      assert.equal(fs.existsSync(path.join(outside, 'new.json')), false);
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('czyszczenie usuwa samo junction i odmawia, gdy korzeń jest junction', async () => {
  const root = tempWorkspace();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-clear-outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'keep.json'), '{}');
    const storage = path.join(root, 'dane', 'pliki');
    fs.symlinkSync(outside, path.join(storage, 'linked'), 'junction');
    await withServer(root, async (url) => {
      const clear = () => fetch(`${url}/api/runtime/clear-app-data`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: 'WYCZYSC_DANE_APLIKACJI' }) });
      assert.equal((await clear()).status, 200);
      assert.equal(fs.existsSync(path.join(storage, 'linked')), false);
      assert.equal(fs.existsSync(path.join(outside, 'keep.json')), true);
      fs.rmdirSync(storage);
      fs.symlinkSync(outside, storage, 'junction');
      assert.equal((await clear()).status, 500);
      assert.equal(fs.existsSync(path.join(outside, 'keep.json')), true);
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('timeout Ollamy obejmuje odczyt odpowiedzi', async () => {
  const start = Date.now();
  const status = await checkOllamaStatus((async (_url, init) => ({ ok: true, json: () => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('abort')));
  }) }) as Response) as typeof fetch);
  assert.equal(status.available, false);
  assert.ok(Date.now() - start >= 1400 && Date.now() - start < 5000);
});

test('mapa notowań usuwa wygasłe wpisy i ma limit 500', () => {
  quoteCache.clear();
  try {
    cacheQuote('OLD', { price: 1 }, 1000);
    cacheQuote('NEW', { price: 2 }, 5000);
    assert.equal(quoteCache.has('OLD'), false);
    for (let i = 0; i < 510; i++) cacheQuote(`T${i}`, { price: i }, 5000);
    assert.equal(quoteCache.size, 500);
    assert.equal(quoteCache.has('NEW'), false);
  } finally { quoteCache.clear(); }
});

test('limit czasu kończy atrapę procesu silnika z czytelnym błędem', async () => {
  const root = tempWorkspace();
  const oldPython = process.env.INVEST_PYTHON;
  const oldTimeout = process.env.INVEST_TAX_ENGINE_TIMEOUT_MS;
  try {
    const script = path.join(root, 'silnik', 'python', 'src', 'investment_tax_engine', 'app', 'cli.py');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, 'setInterval(() => {}, 1000);');
    process.env.INVEST_PYTHON = process.execPath;
    process.env.INVEST_TAX_ENGINE_TIMEOUT_MS = '250';
    await withServer(root, async (url) => {
      const response = await fetch(`${url}/api/tax-engine/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ year: 2025 }) });
      const result = await response.json() as { error: string };
      assert.equal(response.status, 504);
      assert.match(result.error, /Przekroczono limit czasu/);
    });
  } finally {
    if (oldPython === undefined) delete process.env.INVEST_PYTHON; else process.env.INVEST_PYTHON = oldPython;
    if (oldTimeout === undefined) delete process.env.INVEST_TAX_ENGINE_TIMEOUT_MS; else process.env.INVEST_TAX_ENGINE_TIMEOUT_MS = oldTimeout;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('awaria silnika: odpowiedź i konsola bez stderr, pełny stderr w pliku przebiegu, ścieżki maskowane', async () => {
  const root = tempWorkspace();
  const oldPython = process.env.INVEST_PYTHON;
  const script = path.join(root, 'silnik', 'python', 'src', 'investment_tax_engine', 'app', 'cli.py');
  try {
    fs.mkdirSync(path.dirname(script), { recursive: true });
    process.env.INVEST_PYTHON = process.execPath;
    await withServer(root, async (url, runtimeRoot) => {
      for (const [engineCode, expectedCode] of [
        ['BladDanychWejsciowych', 'ENGINE_INPUT_INVALID'],
        ['InnyBlad', 'ENGINE_FAILED'],
      ]) {
        const message = `Niepoprawne dane w ${path.join(root, 'prywatny.json')}`;
        const hint = `Sprawdź ${path.join(os.homedir(), 'sekret.json')}`;
        const traceback = `Traceback: ${path.join(root, 'silnik', 'plik.py')} oraz ${path.join(os.homedir(), 'modul.py')} oraz ${JSON.stringify(path.join(root, 'escaped.py'))} wyciag_2025.xlsx amount=SEKRETNA-WARTOSC-1234`;
        fs.writeFileSync(script, `process.stdout.write(JSON.stringify(${JSON.stringify({ status: 'ERROR', error: { code: engineCode, message, hint } })}) + '\\n'); process.stderr.write(${JSON.stringify(traceback)}); process.exitCode = 1;`);
        const logiKonsoli: string[] = [];
        const oryginalnyBlad = console.error;
        console.error = (...argumenty: unknown[]) => { logiKonsoli.push(argumenty.map(String).join(' ')); };
        let response: Response;
        try {
          response = await fetch(`${url}/api/tax-engine/run`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ year: 2025 }),
          });
        } finally { console.error = oryginalnyBlad; }
        const result = await response.json() as { errorCode: string; error: string; logs?: string; runId?: string };
        assert.equal(response.status, expectedCode === 'ENGINE_INPUT_INVALID' ? 400 : 500);
        assert.equal(result.errorCode, expectedCode);
        assert.match(result.error, /Niepoprawne dane.*Sprawdź/);
        assert.match(result.error, /<repozytorium>/);
        assert.match(result.error, /<katalog domowy>/);
        assert.equal(result.logs, undefined, 'odpowiedź nie niesie stderr');
        for (const wyciek of ['Traceback', 'SEKRETNA-WARTOSC-1234', 'wyciag_2025', root, os.homedir()]) {
          assert.ok(!JSON.stringify(result).includes(wyciek), `odpowiedź zawiera: ${wyciek}`);
          assert.ok(!logiKonsoli.join('\n').includes(wyciek), `konsola zawiera: ${wyciek}`);
        }
        const runId = String(result.runId);
        assert.match(runId, /\S/);
        assert.ok(logiKonsoli.join('\n').includes(runId), 'konsola wskazuje identyfikator przebiegu');
        const stderrLog = fs.readFileSync(path.join(getTaxEngineRunOutputDir(root, runtimeRoot), runId, 'stderr.log'), 'utf8');
        assert.match(stderrLog, /SEKRETNA-WARTOSC-1234/, 'pełny stderr trafia do pliku przebiegu');
      }
      process.env.INVEST_PYTHON = path.join(root, 'brak', 'python.exe');
      const launchResponse = await fetch(`${url}/api/tax-engine/run`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ year: 2025 }),
      });
      const launchResult = await launchResponse.json() as { errorCode: string; error: string };
      assert.equal(launchResponse.status, 500);
      assert.equal(launchResult.errorCode, 'ENGINE_FAILED');
      assert.match(launchResult.error, /Nie udało się uruchomić Pythona.*<repozytorium>/);
      assert.ok(!launchResult.error.includes(root));
    });
  } finally {
    if (oldPython === undefined) delete process.env.INVEST_PYTHON; else process.env.INVEST_PYTHON = oldPython;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('zerwanie połączenia kończy atrapę procesu silnika', async () => {
  const root = tempWorkspace();
  const oldPython = process.env.INVEST_PYTHON;
  const marker = path.join(root, 'child.pid');
  try {
    const script = path.join(root, 'silnik', 'python', 'src', 'investment_tax_engine', 'app', 'cli.py');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`);
    process.env.INVEST_PYTHON = process.execPath;
    await withServer(root, async (url) => {
      const request = http.request(`${url}/api/tax-engine/run`, { method: 'POST', headers: { 'content-type': 'application/json' } });
      request.on('error', () => undefined);
      request.end(JSON.stringify({ year: 2025 }));
      const waitFor = async (condition: () => boolean) => {
        for (let i = 0; i < 100; i++) {
          if (condition()) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.fail('Nie doczekano się zakończenia atrapy procesu.');
      };
      await waitFor(() => fs.existsSync(marker));
      const pid = Number(fs.readFileSync(marker, 'utf8'));
      request.destroy();
      await waitFor(() => {
        try { process.kill(pid, 0); return false; }
        catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
      });
    });
  } finally {
    if (oldPython === undefined) delete process.env.INVEST_PYTHON; else process.env.INVEST_PYTHON = oldPython;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('nieczytelny wynik silnika nie zwraca surowego wyjścia w odpowiedzi', async () => {
  const root = tempWorkspace();
  const oldPython = process.env.INVEST_PYTHON;
  const script = path.join(root, 'silnik', 'python', 'src', 'investment_tax_engine', 'app', 'cli.py');
  try {
    fs.mkdirSync(path.dirname(script), { recursive: true });
    process.env.INVEST_PYTHON = process.execPath;
    const wyjscie = `nie-JSON ${path.join(root, 'prywatny.json')} ${path.join(os.homedir(), 'sekret.json')}`;
    fs.writeFileSync(script, `process.stdout.write(${JSON.stringify(wyjscie)});`);
    await withServer(root, async (url) => {
      const response = await fetch(`${url}/api/tax-engine/run`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ year: 2025 }),
      });
      const result = await response.json() as { errorCode: string; logs?: string; runId?: string };
      assert.equal(response.status, 502);
      assert.equal(result.errorCode, 'ENGINE_OUTPUT_UNREADABLE');
      assert.equal(result.logs, undefined);
      assert.ok(!JSON.stringify(result).includes('nie-JSON'));
      assert.match(String(result.runId), /\S/);
      assert.ok(!JSON.stringify(result).includes(root));
      assert.ok(!JSON.stringify(result).includes(os.homedir()));
    });
  } finally {
    if (oldPython === undefined) delete process.env.INVEST_PYTHON; else process.env.INVEST_PYTHON = oldPython;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
