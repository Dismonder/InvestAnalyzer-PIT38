import test from 'node:test';
import assert from 'node:assert/strict';

import { applyTaxReportOrganizationStatusRead } from '../../../aplikacje/web/src/invest_analyzer/App.tsx';
import type { TaxReportOrganizationStatus } from '../../../aplikacje/web/src/invest_analyzer/services/reportOrganizationStatus.ts';

test('spóźniony odczyt statusu roku nie nadpisuje statusu wybranego później roku', async () => {
  let selectedYear = 2025;
  let cancelled = false;
  let resolveRead!: (status: TaxReportOrganizationStatus | null) => void;
  const read = new Promise<TaxReportOrganizationStatus | null>((resolve) => { resolveRead = resolve; });
  const applied: TaxReportOrganizationStatus[] = [];
  const pending = applyTaxReportOrganizationStatusRead(
    2024,
    () => !cancelled && selectedYear === 2024,
    () => read,
    (status) => applied.push(status),
  );

  selectedYear = 2025;
  cancelled = true;
  resolveRead({ year: 2024, status: 'submitted', updatedAt: '2024-01-01T00:00:00.000Z' });
  await pending;

  assert.deepEqual(applied, []);
});
