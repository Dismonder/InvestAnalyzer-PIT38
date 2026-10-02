import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RejestratorNocny, czySesjaNocna, swieceZProbek } from '../../../aplikacje/web/src/server/overnightRecorder.ts';

// Wrzesien 2026: Nowy Jork = UTC-4. 2026-09-21 to poniedzielnik.
const ny = (dzien: number, godzina: number, minuta = 0) => Date.UTC(2026, 8, dzien, godzina + 4, minuta);

test('sesja nocna: niedziela 20:00 - piątek 04:00 czasu NY, bez weekendu i bez dnia', () => {
  assert.equal(czySesjaNocna(ny(21, 20)), true); // pon 20:00
  assert.equal(czySesjaNocna(ny(22, 3, 59)), true); // wt 03:59
  assert.equal(czySesjaNocna(ny(22, 4)), false); // wt 04:00 - zaczyna sie pre-market
  assert.equal(czySesjaNocna(ny(21, 12)), false); // srodek dnia
  assert.equal(czySesjaNocna(ny(20, 21)), true); // niedziela wieczor
  assert.equal(czySesjaNocna(ny(25, 21)), false); // piatek wieczor
  assert.equal(czySesjaNocna(ny(26, 2)), false); // sobota nad ranem
  assert.equal(czySesjaNocna(ny(25, 2)), true); // piatek nad ranem
});

test('próbki składają się w świece; próbki z dnia i bez ceny odpadają', () => {
  const t = (godzina: number, minuta: number) => ny(21, godzina, minuta) / 1000;
  const swiece = swieceZProbek(
    [
      { t: t(20, 1), p: 100 }, { t: t(20, 7), p: 103 }, { t: t(20, 14), p: 99 },
      { t: t(20, 16), p: 101 },
      { t: t(12, 0), p: 500 }, // dzien - nie jest sesja nocna
      { t: t(20, 3), p: 0 },
    ],
    15 * 60,
  );
  assert.deepEqual(swiece.map((s) => [s.open, s.high, s.low, s.close, s.liczbaProbek]), [[100, 103, 99, 99, 3], [101, 101, 101, 101, 1]]);
});

test('rejestrator zapisuje tylko w nocy, tylko obserwowane walory i tylko prawdziwą cenę', async () => {
  const katalog = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-noc-'));
  let teraz = ny(21, 12);
  const ceny: Record<string, number | null> = { 'NBIS.US': 221.5, 'BRAK.US': null };
  const rejestrator = new RejestratorNocny(katalog, async (ticker) => ceny[ticker] ?? null, () => teraz);
  try {
    rejestrator.obserwuj('NBIS.US');
    rejestrator.obserwuj('BRAK.US');
    rejestrator.obserwuj('../../etc/passwd');
    assert.equal(await rejestrator.probkuj(), 0, 'w dzień nic nie zapisujemy');
    teraz = ny(21, 21);
    assert.equal(await rejestrator.probkuj(), 1);
    teraz = ny(21, 21, 1);
    ceny['NBIS.US'] = 222;
    assert.equal(await rejestrator.probkuj(), 1);
    assert.deepEqual(rejestrator.odczytaj('NBIS.US').map((x) => x.p), [221.5, 222]);
    assert.deepEqual(fs.readdirSync(katalog), ['NBIS.US.jsonl']);
    fs.appendFileSync(path.join(katalog, 'NBIS.US.jsonl'), '{"t": 17'); // przerwany zapis
    assert.equal(rejestrator.odczytaj('NBIS.US').length, 2);
    assert.deepEqual(rejestrator.odczytaj('../../etc/passwd'), []);
  } finally {
    fs.rmSync(katalog, { recursive: true, force: true });
  }
});

test('błąd próbki w interwale jest obsłużony bez danych osobowych w logu', async () => {
  const katalog = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-noc-error-'));
  const rejestrator = new RejestratorNocny(katalog, async () => 1, () => ny(21, 21));
  const originalError = console.error;
  const logs: string[] = [];
  console.error = (message) => { logs.push(String(message)); };
  rejestrator.probkuj = async () => { throw Object.assign(new Error('tajna ścieżka'), { code: 'ENOSPC' }); };
  try {
    rejestrator.start(10);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.ok(logs.length > 0);
    assert.match(logs[0], /ENOSPC/);
    assert.doesNotMatch(logs[0], /tajna/);
  } finally {
    rejestrator.stop();
    console.error = originalError;
    fs.rmSync(katalog, { recursive: true, force: true });
  }
});

test('przycinanie usuwa próbki starsze niż okres obserwacji i pliki bez świeżych próbek', () => {
  const katalog = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-noc-przycinanie-'));
  const teraz = ny(21, 12);
  const sek = (dniTemu: number) => Math.floor(teraz / 1000) - dniTemu * 86_400;
  const linie = (probki: Array<[number, number]>) => probki.map(([t, p]) => JSON.stringify({ t, p })).join('\n') + '\n';
  fs.writeFileSync(path.join(katalog, 'STARY.US.jsonl'), linie([[sek(30), 10], [sek(9), 11]]));
  fs.writeFileSync(path.join(katalog, 'NBIS.US.jsonl'), linie([[sek(20), 1], [sek(8), 2], [sek(6), 3], [sek(1), 4]]) + '{"t": 17');
  fs.writeFileSync(path.join(katalog, 'notatka.txt'), 'nie jest plikiem próbek');
  const rejestrator = new RejestratorNocny(katalog, async () => null, () => teraz);
  try {
    rejestrator.przytnij();
    assert.deepEqual(fs.readdirSync(katalog).sort(), ['NBIS.US.jsonl', 'notatka.txt']);
    assert.deepEqual(rejestrator.odczytaj('NBIS.US', 30).map((x) => x.p), [3, 4]);
    assert.doesNotMatch(fs.readFileSync(path.join(katalog, 'NBIS.US.jsonl'), 'utf8'), /"t": 17/);
    // Ponowne przycięcie nic nie zmienia.
    rejestrator.przytnij();
    assert.deepEqual(rejestrator.odczytaj('NBIS.US', 30).map((x) => x.p), [3, 4]);
  } finally {
    fs.rmSync(katalog, { recursive: true, force: true });
  }
});

test('rejestrator przycina pliki próbek raz na dobę, także w dzień', async () => {
  const katalog = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-noc-doba-'));
  let teraz = ny(21, 12);
  const stary = path.join(katalog, 'STARY.US.jsonl');
  const zapiszStary = () => fs.writeFileSync(stary, JSON.stringify({ t: Math.floor(teraz / 1000) - 10 * 86_400, p: 5 }) + '\n');
  zapiszStary();
  const rejestrator = new RejestratorNocny(katalog, async () => null, () => teraz);
  try {
    await rejestrator.probkuj();
    assert.equal(fs.existsSync(stary), false, 'pierwsza runda przycina');
    zapiszStary();
    teraz += 3_600_000;
    await rejestrator.probkuj();
    assert.equal(fs.existsSync(stary), true, 'w ciągu doby nie przycina ponownie');
    teraz += 24 * 3_600_000;
    await rejestrator.probkuj();
    assert.equal(fs.existsSync(stary), false, 'po dobie przycina ponownie');
  } finally {
    fs.rmSync(katalog, { recursive: true, force: true });
  }
});