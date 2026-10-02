import test from 'node:test';
import assert from 'node:assert/strict';

import { najwczesniejszyDzienOperacji } from '../../../aplikacje/web/src/server/routes/brokers.ts';

test('raport depozytariusza zaczyna sie od pierwszej operacji, nie od 1970 r.', () => {
  const transakcje = [{ date: '2025-03-04 10:00:00' }, { short_date: '2025-01-21' }];
  const przeplywy = [{ date: '2025-01-23' }, { datetime: '2026-06-11T15:00:00' }];
  assert.equal(najwczesniejszyDzienOperacji(transakcje, przeplywy), '2025-01-21');
});

test('brak dat nie jest zgadywany', () => {
  assert.equal(najwczesniejszyDzienOperacji([{ date: '' }, { date: 'wczoraj' }, null as unknown as object], []), null);
});
