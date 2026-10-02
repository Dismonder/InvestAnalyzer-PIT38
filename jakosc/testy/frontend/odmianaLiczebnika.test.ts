import test from 'node:test';
import assert from 'node:assert/strict';
import { odmienLiczebnik } from '../../../aplikacje/web/src/portfel/services/odmianaLiczebnika.ts';

test('odmiana liczebnikow uwzglednia zero, jeden i nascie', () => {
  const forma = (n: number) => odmienLiczebnik(n, 'rachunek', 'rachunki', 'rachunków');
  // Forma pojedyncza tylko dla dokladnie 1: "21 rachunków", "101 rachunków".
  assert.deepEqual([0, 1, 2, 5, 11, 12, 21, 22, 31, 101, 112, 122].map(forma), [
    'rachunków', 'rachunek', 'rachunki', 'rachunków', 'rachunków',
    'rachunków', 'rachunków', 'rachunki', 'rachunków', 'rachunków', 'rachunków', 'rachunki',
  ]);
});
