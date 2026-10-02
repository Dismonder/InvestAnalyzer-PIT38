/**
 * Kopie w dane/backupy: osobne limity dla kopii recznych i automatycznych
 * ("Stan sprzed ..."), pominiecie kopii identycznej z ostatnia, zapis atomowy,
 * wlasny limit 32 MB dla /api/backups i retencja kopii *.bak.json z nadpisan
 * eksportu Freedom24.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';

import {
  BACKUP_LIMIT,
  BACKUP_LIMIT_AUTOMATYCZNYCH,
  listBackupSnapshots,
  writeBackupSnapshot,
} from '../../../aplikacje/web/src/server/backupStore.ts';
import { createInvestAnalyzerServer } from '../../../aplikacje/web/src/server/createInvestAnalyzerServer.ts';

const tmp = (nazwa: string) => fs.mkdtempSync(path.join(os.tmpdir(), `ia-${nazwa}-`));
const moment = (sekundy: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, sekundy));

test('kopie automatyczne i reczne maja osobne limity rotacji', () => {
  const root = tmp('rotacja');
  for (let i = 0; i < 5; i += 1) writeBackupSnapshot(root, { createdAt: `r${i}`, n: i }, moment(i));
  for (let i = 0; i < BACKUP_LIMIT_AUTOMATYCZNYCH + 6; i += 1) {
    writeBackupSnapshot(root, { createdAt: `a${i}`, reason: 'Stan sprzed wczytania kopii', purpose: 'safety', n: 100 + i }, moment(100 + i));
  }
  const listed = listBackupSnapshots(root);
  const automatyczne = listed.filter((kopia) => kopia.id.includes('-auto'));
  assert.equal(automatyczne.length, BACKUP_LIMIT_AUTOMATYCZNYCH);
  assert.equal(listed.length - automatyczne.length, 5, 'kopie reczne nie sa wypierane przez automatyczne');
  assert.ok(BACKUP_LIMIT >= 30);
});

test('kopia identyczna z ostatnia (poza czasem utworzenia) nie jest zapisywana ponownie', () => {
  const root = tmp('hash');
  const pierwsza = writeBackupSnapshot(root, { createdAt: 'a', local: { x: '1' } }, moment(1));
  const powtorka = writeBackupSnapshot(root, { createdAt: 'b', local: { x: '1' } }, moment(2));
  assert.equal(powtorka.id, pierwsza.id);
  assert.equal(listBackupSnapshots(root).length, 1);
  const zmieniona = writeBackupSnapshot(root, { createdAt: 'c', local: { x: '2' } }, moment(3));
  assert.notEqual(zmieniona.id, pierwsza.id);
  assert.equal(listBackupSnapshots(root).length, 2);
});

test('zapis kopii jest atomowy: nie zostawia plikow tymczasowych i nie tworzy czesciowego pliku', () => {
  const root = tmp('atomowy');
  const zapisana = writeBackupSnapshot(root, { createdAt: 'a', n: 1 }, moment(1));
  assert.deepEqual(fs.readdirSync(root), [zapisana.id]);
  // Porzucony plik tymczasowy po awarii nie jest kopia i nie jest listowany.
  fs.writeFileSync(path.join(root, '.kopia-20260101-000000.json.tmp'), '{"ucie');
  assert.equal(listBackupSnapshots(root).length, 1);
});

async function zSerwerem(uzyj: (adres: string, root: string) => Promise<void>) {
  const root = tmp('serwer');
  const runtimeRoot = tmp('serwer-rt');
  fs.mkdirSync(path.join(root, 'dane', 'pliki'), { recursive: true });
  const serwer = http.createServer(createInvestAnalyzerServer({ workspaceRoot: root, runtimeRoot }));
  await new Promise<void>((resolve) => serwer.listen(0, '127.0.0.1', resolve));
  try {
    await uzyj(`http://127.0.0.1:${(serwer.address() as AddressInfo).port}`, root);
  } finally {
    await new Promise<void>((resolve) => serwer.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
}

const post = (adres: string, sciezka: string, cialo: unknown) =>
  fetch(`${adres}${sciezka}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cialo) });

test('/api/backups przyjmuje kopie do 32 MB, a wieksza odrzuca 413 z komunikatem o kopii', async () => {
  await zSerwerem(async (adres) => {
    const duza = await post(adres, '/api/backups', { snapshot: { createdAt: 'a', dane: 'x'.repeat(3 * 1024 * 1024) } });
    assert.equal(duza.status, 200);
    const zaDuza = await post(adres, '/api/backups', { snapshot: { createdAt: 'b', dane: 'y'.repeat(33 * 1024 * 1024) } });
    assert.equal(zaDuza.status, 413);
    assert.match(String((await zaDuza.json()).error), /Kopia.*32 MB/);
  });
});

test('nadpisania eksportu Freedom24: retencja ostatnich 10 kopii .bak i brak kopii przy identycznej tresci', async () => {
  await zSerwerem(async (adres, root) => {
    const wyslij = (tresc: string) => post(adres, '/api/storage/files', {
      files: [{ fileName: 'freedom24_komplet.json', relativePath: 'freedom24_komplet.json', base64: Buffer.from(tresc).toString('base64'), overwrite: true }],
    });
    const baki = () => fs.readdirSync(path.join(root, 'dane', 'backupy')).filter((nazwa) => nazwa.includes('.bak'));
    await wyslij('{"v":0}');
    await wyslij('{"v":1}');
    assert.equal(baki().length, 1);
    await wyslij('{"v":1}');
    assert.equal(baki().length, 1, 'ta sama tresc nie tworzy kolejnej kopii');
    for (let i = 2; i < 16; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 3));
      await wyslij(`{"v":${i}}`);
    }
    assert.equal(baki().length, 10, 'zostaje ostatnich 10 kopii');
  });
});

test('kolizja znacznika czasu nie nadpisuje kopii wczesniejszej wersji eksportu', async () => {
  const root = tmp('kolizja');
  const backupy = path.join(root, 'backupy');
  const cel = path.join(root, 'freedom24_komplet.json');
  const { zachowajPoprzedniaWersjeEksportu } = await import('../../../aplikacje/web/src/server/backupStore.ts');
  // Ten sam znacznik czasu (ta sama milisekunda): A -> B, potem B -> C.
  fs.writeFileSync(cel, 'A');
  assert.equal(await zachowajPoprzedniaWersjeEksportu(backupy, cel, Buffer.from('B'), 'T'), true);
  fs.writeFileSync(cel, 'B');
  assert.equal(await zachowajPoprzedniaWersjeEksportu(backupy, cel, Buffer.from('C'), 'T'), true);
  fs.writeFileSync(cel, 'C');
  const tresci = fs.readdirSync(backupy).map((nazwa) => fs.readFileSync(path.join(backupy, nazwa), 'utf8')).sort();
  assert.deepEqual(tresci, ['A', 'B'], 'obie poprzednie wersje zachowane');
  // Najnowsza kopia (do porownania "identyczna z ostatnia") to nadal ta z kolizyjna nazwa.
  assert.equal(await zachowajPoprzedniaWersjeEksportu(backupy, cel, Buffer.from('D'), 'T2'), true);
  assert.equal(fs.readdirSync(backupy).length, 3);
});

test('rotacja kopii .bak nie usuwa kopii wlasnie zapisanej mimo cofnietego zegara', async () => {
  const root = tmp('rotacja-bak');
  const backupy = path.join(root, 'backupy');
  const cel = path.join(root, 'freedom24_komplet.json');
  const { zachowajPoprzedniaWersjeEksportu, KOPII_EKSPORTU_FREEDOM24 } = await import('../../../aplikacje/web/src/server/backupStore.ts');
  fs.writeFileSync(cel, 'v0');
  for (let i = 1; i <= KOPII_EKSPORTU_FREEDOM24 + 2; i += 1) {
    await zachowajPoprzedniaWersjeEksportu(backupy, cel, Buffer.from(`v${i}`), `2027-01-01T00-00-${String(i).padStart(2, '0')}`);
    fs.writeFileSync(cel, `v${i}`);
  }
  // Zegar cofniety: znacznik sortuje sie ponizej wszystkich istniejacych.
  await zachowajPoprzedniaWersjeEksportu(backupy, cel, Buffer.from('nowa'), '2020-01-01T00-00-00');
  const tresci = fs.readdirSync(backupy).map((nazwa) => fs.readFileSync(path.join(backupy, nazwa), 'utf8'));
  assert.equal(tresci.length, KOPII_EKSPORTU_FREEDOM24);
  assert.ok(tresci.includes(`v${KOPII_EKSPORTU_FREEDOM24 + 2}`), 'kopia wlasnie zapisana zostaje');
});

test('GET /api/backups/:id: brakująca kopia to 404, uszkodzona to 500, a ścieżka nie wycieka', async () => {
  await zSerwerem(async (adres, root) => {
    const brak = await fetch(`${adres}/api/backups/kopia-20260101-000000.json`);
    assert.equal(brak.status, 404);
    const cialo = await brak.json() as { success: boolean; error: string };
    assert.equal(cialo.success, false);
    assert.doesNotMatch(cialo.error, /ENOENT|[\\/]/);

    fs.mkdirSync(path.join(root, 'dane', 'backupy'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dane', 'backupy', 'kopia-20260101-000001.json'), '{"ucie');
    const uszkodzona = await fetch(`${adres}/api/backups/kopia-20260101-000001.json`);
    assert.equal(uszkodzona.status, 500);
  });
});