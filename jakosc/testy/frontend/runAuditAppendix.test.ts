/**
 * Zwykły przebieg silnika ma audyt źródeł - raport nie może pisać
 * „Audyt źródeł niedostępny / Historia: 0” nad wynikiem, który te dane niesie.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRunAuditAppendix } from '../../../aplikacje/web/src/invest_analyzer/services/runAuditAppendix.ts';
import { buildResultTrustModel } from '../../../aplikacje/web/src/invest_analyzer/services/resultTrust.ts';

const przebieg: any = {
  success: true,
  source_resolution_preview: { mode: 'canonical_stream' },
  canonical_storage_history_rows: [{ row_id: 'a' }, { row_id: 'b' }, { row_id: 'c' }],
  canonical_storage_history_summary: { rawRowCount: 5, deduplicatedRowCount: 3 },
  source_registry: [
    { source_id: 's1', filename: 'freedom24_komplet.json', source_role: 'transaction_source', used_record_count: 441, record_count: 542 },
    { source_id: 's2', filename: 'kopia.json', source_role: 'transaction_source', used_record_count: 0, record_count: 457 },
    { source_id: 's3', filename: 'archiwum_tab_a_2026.csv', source_role: 'nbp_rates', used_record_count: 0 },
  ],
};

test('przebieg bez pakietu ma audyt źródeł zbudowany z rejestru źródeł', () => {
  const zalacznik = buildRunAuditAppendix(przebieg);
  assert.ok(zalacznik);
  assert.equal(zalacznik.source_manifest_v2?.length, 3);
  assert.equal(zalacznik.canonical_storage_history_rows?.length, 3);
  const doPodatku = (zalacznik.source_manifest_v2 || []).filter((zrodlo) => zrodlo.contributesToTax);
  // Tylko źródło, z którego silnik faktycznie wziął rekordy; kopia z zerem użytych - nie.
  assert.deepEqual(doPodatku.map((zrodlo) => zrodlo.filename), ['freedom24_komplet.json']);

  const zaufanie = buildResultTrustModel(przebieg, zalacznik);
  assert.notEqual(zaufanie.label, 'Audyt źródeł niedostępny');
  assert.deepEqual(zaufanie.activeTaxSources, ['freedom24_komplet.json']);
  assert.equal(zaufanie.recognizedFileCount, 3);
});

test('brak przebiegu nie tworzy audytu z niczego', () => {
  assert.equal(buildRunAuditAppendix(null), null);
  assert.equal(buildRunAuditAppendix({ success: true } as any), null);
});
