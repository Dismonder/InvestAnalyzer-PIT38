import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTaxTraceViewModels,
  buildHistoryNavigationTargetFromTrace,
  buildHistorySearchQueryFromTrace,
  findTraceForLedgerLine,
  getTraceKindLabel,
} from "../../../aplikacje/web/src/invest_analyzer/services/taxTraceExplorer.ts";
import type { TaxFilingPackageAuditAppendix } from "../../../aplikacje/web/src/invest_analyzer/hooks/useTaxEngineRun.ts";

const auditAppendix: TaxFilingPackageAuditAppendix = {
  tax_calculation_ledger: {
    rows: [
      {
        line_id: "REVENUE_TOTAL",
        label: "Przychody PIT-38",
        amount_pln: "1000.00",
        source: "fifo_realized_rows",
        tax_effect: "PIT_COUNTED",
      },
      {
        line_id: "AGG_COST_FXC-1",
        label: "Koszt spreadu przewalutowania",
        amount_pln: "12.34",
        source: "FX-SOURCE-1",
        tax_effect: "SCENARIO_COST",
      },
    ],
  },
  defense_evidence_links: [
    {
      evidenceId: "EVIDENCE-FXC-1",
      costId: "FXC-1",
      sourceRecordId: "FX-SOURCE-1",
      rawRowRef: "raw:fx:1",
      linkedTradeIds: ["BUY-1"],
      amountPln: "12.34",
      defenseStatus: "missing_link",
      missingEvidence: ["potwierdzenie przewalutowania"],
      userActionLabel: "Uzupełnij dowód",
      riskLevel: "high",
    },
  ],
  pit_submission_readiness: {
    verdict: "NEEDS_EVIDENCE",
    score: 70,
    generatedAt: "2026-05-11T00:00:00Z",
    recommendedAction: null,
    checklist: [
      {
        id: "defense:FXC-1",
        severity: "evidence",
        category: "defense",
        label: "Brak dowodu",
        userAction: "Dodaj potwierdzenie",
        linkedCostId: "FXC-1",
        sourceId: "FX-SOURCE-1",
      },
    ],
  },
  tax_trace_index: [
    {
      trace_id: "trace:aggressive_cost:AGG_COST_FXC-1",
      kind: "aggressive_cost",
      label: "Koszt spreadu przewalutowania",
      amount_pln: 12.34,
      ledger_row_ids: ["AGG_COST_FXC-1"],
      evidence_ids: ["EVIDENCE-FXC-1"],
      checklist_item_ids: ["defense:FXC-1"],
      source_record_ids: ["FX-SOURCE-1", "BUY-1"],
      tax_impact_kind: "SCENARIO_COST",
      risk_level: "high",
      explanation_pl: "Koszt agresywny powiązany ze źródłem FX-SOURCE-1.",
    },
  ],
};

test("taxTraceExplorer laczy trace z ledgerem, dowodami i checklistą", () => {
  const trace = findTraceForLedgerLine(auditAppendix, "AGG_COST_FXC-1");

  assert.equal(trace?.entry.trace_id, "trace:aggressive_cost:AGG_COST_FXC-1");
  assert.equal(trace?.ledgerRows[0]?.line_id, "AGG_COST_FXC-1");
  assert.equal(trace?.evidenceLinks[0]?.evidenceId, "EVIDENCE-FXC-1");
  assert.equal(trace?.checklistItems[0]?.id, "defense:FXC-1");
  assert.equal(buildHistorySearchQueryFromTrace(trace!), "FX-SOURCE-1");
  assert.deepEqual(buildHistoryNavigationTargetFromTrace(trace!), {
    searchTerm: "FX-SOURCE-1",
    rowId: "FX-SOURCE-1",
  });
  assert.equal(getTraceKindLabel(trace!.entry.kind), "Koszt aggressive_user");
});

test("taxTraceExplorer zwraca stabilną listę modeli trace", () => {
  const traces = buildTaxTraceViewModels(auditAppendix);

  assert.equal(traces.length, 1);
  assert.equal(traces[0]?.entry.kind, "aggressive_cost");
});

