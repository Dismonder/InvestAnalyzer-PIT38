/**
 * Bramka danych prywatnych skanuje sledzone pliki tekstowe pod katem poswiadczen
 * wpisanych w kod. Klucz do testu powstaje losowo w czasie testu, wiec w zrodle
 * testu nie ma literalu, ktory sam zatrzymalby bramke.
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { znajdzPoswiadczeniaWTekscie } from '../../../narzedzia/skrypty/skan-poswiadczen.mjs';

type Znalezisko = { linia: number; opis: string };
const skanuj = (tekst: string): Znalezisko[] => znajdzPoswiadczeniaWTekscie(tekst);

test('fałszywy klucz w pliku tymczasowym jest wykrywany, a raport nie ujawnia jego wartości', () => {
  const klucz = randomBytes(32).toString('hex'); // 64 znaki jak klucz Binance
  const katalog = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-skan-'));
  const plik = path.join(katalog, 'konfiguracja.ts');
  fs.writeFileSync(plik, [
    'export const ustawienia = {',
    `  apiKey: '${klucz}',`,
    `  binanceApiSecret: "${klucz}",`,
    `  const token = '${klucz.slice(0, 40)}';`,
    `  headers: { 'X-MBX-APIKEY': '${klucz}' },`,
    '};',
  ].join('\n'));
  try {
    const znaleziska = skanuj(fs.readFileSync(plik, 'utf8'));
    assert.deepEqual(znaleziska.map((z) => z.linia), [2, 3, 4, 5]);
    assert.ok(!JSON.stringify(znaleziska).includes(klucz.slice(6)), 'wartość klucza nie trafia do raportu');
  } finally {
    fs.rmSync(katalog, { recursive: true, force: true });
  }
});

test('klucz prywatny PEM jest wykrywany', () => {
  const naglowek = ['-----BEGIN ', 'RSA PRIVATE KEY-----'].join('');
  assert.equal(skanuj(`${naglowek}\nMIIE...`).length, 1);
  assert.equal(skanuj(['-----BEGIN ', 'PRIVATE KEY-----'].join('')).length, 1);
  assert.equal(skanuj('-----BEGIN PUBLIC KEY-----').length, 0);
});

test('atrapy i odczyty zmiennych nie zatrzymują bramki', () => {
  const dozwolone = [
    "apiKey: 'test-key-abcdefghijklmnopqrstuvwxyz'",
    "const secret = 'dummy-secret-value-0123456789abcdef'",
    `token: '${'x'.repeat(30)}'`,
    `password = "${'ab'.repeat(20)}"`,
    "queryId: 'example-query-id-1234567890abcd'",
    "headers: { 'X-MBX-APIKEY': apiKey.trim() }",
    "const apiKey = process.env.BINANCE_API_KEY;",
    "apiSecret: ''",
    "token: 'krotki'",
    "sid: 'abc'",
    "const opis = 'Brak klucza API Key lub API Secret dla Binance.'",
  ];
  for (const linia of dozwolone) assert.deepEqual(skanuj(linia), [], linia);
});

test('atrapa przed prawdziwą wartością w tej samej linii nie zasłania dopasowania', () => {
  const klucz = randomBytes(32).toString('hex');
  const linia = `apiKey: 'test-key-abcdefghijklmnopqrstuvwxyz', apiSecret: '${klucz}'`;
  assert.deepEqual(skanuj(linia).map((z) => z.linia), [1]);
});

test('PEM w długiej linii i długa linia z przypisaniem są skanowane oknami, nie pomijane', () => {
  const klucz = randomBytes(32).toString('hex');
  const wypelnienie = 'a '.repeat(1500);
  const pem = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
  assert.deepEqual(skanuj(`${pem}${wypelnienie}`).map((z) => z.linia), [1], 'PEM przed limitem długości');
  assert.deepEqual(skanuj(`${wypelnienie}\n${wypelnienie}{ apiKey: '${klucz}' }${wypelnienie}`).map((z) => z.linia), [2]);
  // Ta sama długa linia bez poświadczenia nie daje alarmu (i jedno znalezisko na linię).
  assert.deepEqual(skanuj(wypelnienie.repeat(3)), []);
  assert.equal(skanuj(`${wypelnienie}{ apiKey: '${klucz}', token: '${klucz}' }`).length, 1);
});

test('wartość w następnej linii po "=" albo ":" jest wykrywana', () => {
  const klucz = randomBytes(32).toString('hex');
  assert.deepEqual(skanuj(`const apiSecret =\n  '${klucz}';`).map((z) => z.linia), [1]);
  assert.deepEqual(skanuj(`  token:\n    "${klucz}",`).map((z) => z.linia), [1]);
  assert.deepEqual(skanuj(`const secret =\n  'dummy-secret-value-0123456789abcdef';`), []);
  assert.deepEqual(skanuj(`const zmienna =\n  '${klucz}';`), []);
});

test('zapis bez cudzysłowu (.env) i token w adresie URL są wykrywane', () => {
  const klucz = randomBytes(32).toString('hex');
  assert.equal(skanuj(`BINANCE_API_SECRET=${klucz}`).length, 1);
  assert.equal(skanuj(`export FREEDOM_TOKEN=${klucz}  # produkcja`).length, 1);
  assert.equal(skanuj(`fetch('https://api.przyklad.invalid/v1/dane?token=${klucz}&x=1')`).length, 1);
  assert.equal(skanuj(`const adres = "https://api.przyklad.invalid/v1?t=${klucz}";`).length, 1);
  assert.equal(skanuj(`https://api.przyklad.invalid/v1?access_token=${klucz}`).length, 1);
  const dozwolone = [
    'BINANCE_API_SECRET=',
    'BINANCE_API_SECRET=${BINANCE_SECRET}',
    'API_TOKEN=test-token-abcdefghijklmnopqrstuvwxyz0123',
    'token = nazwa_zmiennej_o_dlugiej_nazwie_bez_cyfr',
    'const url = `/api/x?token=${token}`;',
    'https://przyklad.invalid/?t=1700000000',
    "fetch('/api/x?t=' + Date.now())",
  ];
  for (const linia of dozwolone) assert.deepEqual(skanuj(linia), [], linia);
});

test('nazwy security/access/auth + key są traktowane jak nazwy poświadczeń', () => {
  const klucz = randomBytes(32).toString('hex');
  for (const nazwa of ['securityKey', 'access_key', 'authKey', 'ACCESS-KEY', 'secretAccessKey']) {
    assert.equal(skanuj(`const ${nazwa} = '${klucz}';`).length, 1, nazwa);
  }
  assert.deepEqual(skanuj(`const authKey = 'test-auth-key-abcdefghijklmnopqrstuvwxyz';`), []);
});
