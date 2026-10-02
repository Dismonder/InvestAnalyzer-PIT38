import test from "node:test";
import assert from "node:assert/strict";

import { buildPitRepairConsole } from "../../../aplikacje/web/src/invest_analyzer/services/pitRepairConsole.ts";
import type { TaxFilingPackageAuditAppendix } from "../../../aplikacje/web/src/invest_analyzer/hooks/useTaxEngineRun.ts";

const auditAppendix: TaxFilingPackageAuditAppendix = {
  pit_submission_readiness: {
    verdict: "NEEDS_EVIDENCE",
    score: 68,
    generatedAt: "2026-05-11T10:00:00.000Z",
    recommendedAction: null,
    checklist: [
      {
        id: "NBP:USD:2025-01-21",
        severity: "blocking",
        category: "nbp",
        label: "Brak kursu NBP USD",
        userAction: "Uzupełnij kurs NBP dla 2025-01-21.",
        linkedRowId: "row-nbp-1",
        sourceId: "NBP-USD-2025-01-21",
      },
      {
        id: "DEFENSE:COST-1",
        severity: "evidence",
        category: "defense",
        label: "Brak dowodu kosztu",
        userAction: "Dodaj potwierdzenie przewalutowania.",
        linkedCostId: "COST-1",
        sourceId: "FX-SOURCE-1",
      },
      {
        id: "DEFENSE:RISK-1",
        severity: "risk",
        category: "defense",
        label: "Wysokie ryzyko planu agresywnego",
        userAction: "Sprawdź argumentację i zachowaj dokumenty.",
        linkedCostId: "COST-2",
      },
    ],
  },
  defense_evidence_links: [
    {
      evidenceId: "EVIDENCE-COST-1",
      costId: "COST-1",
      sourceRecordId: "FX-SOURCE-1",
      linkedTradeIds: ["BUY-1"],
      amountPln: "12.34",
      defenseStatus: "missing_link",
      missingEvidence: ["potwierdzenie przewalutowania"],
      userActionLabel: "Dopnij koszt do zakupu",
      riskLevel: "high",
    },
  ],
  tax_trace_index: [
    {
      trace_id: "trace:aggressive_cost:AGG_COST_COST-1",
      kind: "aggressive_cost",
      label: "Koszt FX",
      amount_pln: 12.34,
      ledger_row_ids: ["AGG_COST_COST-1"],
      evidence_ids: ["EVIDENCE-COST-1"],
      checklist_item_ids: ["DEFENSE:COST-1"],
      source_record_ids: ["FX-SOURCE-1", "BUY-1"],
      risk_level: "high",
      tax_impact_kind: "SCENARIO_COST",
      explanation_pl: "Koszt wymaga dowodu i powiązania z zakupem.",
    },
  ],
};

test("buildPitRepairConsole grupuje blokady, braki dowodowe i ryzyka w zadania użytkowe", () => {
  const consoleState = buildPitRepairConsole(auditAppendix);

  assert.equal(consoleState.items.length, 3);
  assert.equal(consoleState.groups.find((group) => group.id === "blocking")?.count, 1);
  assert.equal(consoleState.groups.find((group) => group.id === "evidence")?.count, 1);
  assert.equal(consoleState.groups.find((group) => group.id === "risk")?.count, 1);
  assert.equal(consoleState.recommendedItem?.id, "NBP:USD:2025-01-21");
});

test("buildPitRepairConsole buduje cel historii z sourceId, linkedRowId i trace", () => {
  const consoleState = buildPitRepairConsole(auditAppendix);
  const evidenceItem = consoleState.items.find((item) => item.id === "DEFENSE:COST-1");

  assert.equal(evidenceItem?.traceId, "trace:aggressive_cost:AGG_COST_COST-1");
  assert.equal(evidenceItem?.historyTarget.searchTerm, "FX-SOURCE-1");
  assert.equal(evidenceItem?.historyTarget.rowId, "FX-SOURCE-1");
  assert.equal(evidenceItem?.details.includes("potwierdzenie przewalutowania"), true);
});

