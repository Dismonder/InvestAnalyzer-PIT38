import test from 'node:test';
import assert from 'node:assert/strict';
import { wierszeCzesciC, wierszeCzesciEF } from '../../../aplikacje/web/src/portfel/services/pdfExporter.ts';

test('PDF pokazuje osobno przychód z PIT-8C i pozostały przychód z pól silnika', () => {
  const rows = wierszeCzesciC({ '20': 40, '21': 10, '22': 60, '23': 20 });
  assert.deepEqual(rows.map((row) => row[1]), ['Poz. 20', 'Poz. 21', 'Poz. 22', 'Poz. 23']);
  assert.deepEqual(rows.map((row) => row[2]), ['40,00 PLN', '10,00 PLN', '60,00 PLN', '20,00 PLN']);
});

test('PDF ujawnia niezerowe pozycje E/F silnika z groszami w poz. 43', () => {
  const rows = wierszeCzesciEF({ '36': 100.25, '37': 0, '38': 0, '39': 100.25, '41': 100, '43': 19.19, '45': 19 });
  assert.deepEqual(rows.map((row) => row[1]), [
    'Poz. 36 (część E)', 'Poz. 39 (część E)', 'Poz. 40 (część E)',
    'Poz. 41 (część F)', 'Poz. 42 (część F)', 'Poz. 43 (część F)',
    'Poz. 44 (część F)', 'Poz. 45 (część F)',
  ]);
  assert.match(rows.find((row) => row[1].startsWith('Poz. 43'))![2], /19,19/);
  // Silnik podaje stawkę tekstem "19%", którego mapa pól liczbowych nie przenosi.
  assert.equal(rows.find((row) => row[1].startsWith('Poz. 42'))![2], '19%');
  assert.deepEqual(wierszeCzesciEF({}), []);
});

test('PDF bez rozbicia z silnika pokazuje sumy z jawną etykietą zamiast kresek', () => {
  const rows = wierszeCzesciC({}, { revenuePLN: 100, costsPLN: 60 });
  assert.deepEqual(rows.map((row) => row[1]), ['Poz. 20 + 22', 'Poz. 21 + 23']);
  assert.deepEqual(rows.map((row) => row[2]), ['100,00 PLN', '60,00 PLN']);
});
