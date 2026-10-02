import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPitTrustViewModel } from '../../../aplikacje/web/src/invest_analyzer/services/pitTrustView.ts';

test('buildPitTrustViewModel: aggregates source trust, storage smoke, NBP and evidence counts', () => {
  const model = buildPitTrustViewModel({
    source_trust_summary: {
      summary: {
        source_count: 8,
        transaction_source_count: 2,
        report_source_count: 1,
        status_counts: {
          source_evidence: 3,
        },
      },
    },
    storage_smoke_report: { status: 'pass' },
    nbp_coverage_report: { status: 'pass' },
    result_health_check: {
      status: 'ok',
      headline: 'OK',
      reasons: [],
      activeTaxSourceIds: ['src:1', 'src:2'],
      activeTaxSourceLabels: ['A', 'B'],
      recognizedStorageFileCount: 10,
      taxHistoryRowCount: 20,
      sellRowCount: 5,
      revenuePln: '1000',
      costPln: '700',
    },
    defense_vault_summary: {
      summary: {
        available: 4,
        to_collect: 2,
        advisor_review: 1,
      },
    },
    no_overpay_audit_v3: {
      summary: {
        counted_total_pln: '160.18',
        candidate_total_pln: '25',
        requires_evidence_total_pln: '9',
      },
    },
    advisor_review_pack: {
      tax_year: 2025,
    },
  });

  assert.equal(model.overallStatus, 'ok');
  assert.equal(model.activeSourceCount, 2);
  assert.equal(model.candidateSourceCount, 1);
  assert.equal(model.evidenceSourceCount, 3);
  assert.equal(model.recognizedFileCount, 10);
  assert.equal(model.storageSmokeStatus, 'ok');
  assert.equal(model.nbpStatus, 'ok');
  assert.equal(model.defenseToCollectCount, 2);
  assert.equal(model.noOverpayCandidatePln, '25');
  assert.equal(model.advisorPackReady, true);
});

test('buildPitTrustViewModel: fail and blocked statuses become blocked', () => {
  const model = buildPitTrustViewModel({
    source_trust_summary: {
      summary: {
        source_count: 1,
        transaction_source_count: 1,
        report_source_count: 0,
      },
    },
    storage_smoke_report: { status: 'fail', errors: ['missing active source'] },
    nbp_coverage_report: { status: 'blocked' },
    result_health_check: {
      status: 'needs_review',
      headline: 'Review',
      reasons: ['Suspicious zero'],
      activeTaxSourceIds: ['src:1'],
      activeTaxSourceLabels: ['A'],
      recognizedStorageFileCount: 1,
      taxHistoryRowCount: 1,
      sellRowCount: 1,
      revenuePln: '0',
      costPln: '0',
    },
  });

  assert.equal(model.overallStatus, 'blocked');
  assert.equal(model.storageSmokeStatus, 'blocked');
  assert.equal(model.nbpStatus, 'blocked');
  assert.equal(model.resultHealthStatus, 'needs_review');
  assert.match(model.headline, /zablokowany/);
});

test('buildPitTrustViewModel: review-needed sources do not become import blockers', () => {
  const model = buildPitTrustViewModel({
    source_trust_summary: {
      summary: {
        source_count: 2,
        transaction_source_count: 1,
        report_source_count: 1,
        review_needed_source_count: 1,
      },
    },
    storage_smoke_report: { status: 'pass' },
    nbp_coverage_report: { status: 'pass' },
    result_health_check: {
      status: 'ok',
      headline: 'OK',
      reasons: [],
      activeTaxSourceIds: ['src:1'],
      activeTaxSourceLabels: ['A'],
      recognizedStorageFileCount: 2,
      taxHistoryRowCount: 1,
      sellRowCount: 1,
      revenuePln: '10',
      costPln: '8',
    },
  });

  assert.equal(model.blockedSourceCount, 1);
  assert.equal(model.overallStatus, 'needs_review');
  assert.match(model.headline, /kontroli/);
});

test('buildPitTrustViewModel: empty appendix is safe for initial render', () => {
  const model = buildPitTrustViewModel(null);

  assert.equal(model.overallStatus, 'unknown');
  // Brak audytu to nie jest zero zrodel. `asNumber(undefined)` dawalo tu 0,
  // wiec ekran pisal "Zrodla transakcji: 0" przy rozliczeniu policzonym
  // z trzech plikow brokera.
  assert.equal(model.sourceCount, null);
  assert.equal(model.activeSourceCount, null);
  assert.match(model.sourceSummary, /nie policzono/);
  assert.equal(model.advisorPackReady, false);
});
