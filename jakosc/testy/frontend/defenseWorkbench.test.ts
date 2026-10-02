import test from "node:test";
import assert from "node:assert/strict";

import { buildDefenseWorkbench } from "../../../aplikacje/web/src/invest_analyzer/services/defenseWorkbench.ts";
import type { TaxFilingPackageAuditAppendix } from "../../../aplikacje/web/src/invest_analyzer/hooks/useTaxEngineRun.ts";
import type { DefenseEvidenceOverride } from "../../../aplikacje/web/src/invest_analyzer/services/defenseEvidenceOverrides.ts";

const auditAppendix: TaxFilingPackageAuditAppendix = {
  pit_submission_readiness: {
    verdict: "NEEDS_EVIDENCE",
    score: 64,
    generatedAt: "2026-05-11T10:00:00.000Z",
    recommendedAction: null,
    checklist: [
      {
        id: "NBP:USD:2025-01-21",
        severity: "blocking",
        category: "nbp",
        label: "Brak kursu NBP USD",
        userAction: "Uzupełnij kurs NBP.",
        linkedRowId: "row-nbp",
      },
      {
        id: "DEFENSE:COST-1",
        severity: "evidence",
        category: "defense",
        label: "Brak potwierdzenia kosztu",
        userAction: "Dodaj potwierdzenie przelewu i opis powiązania.",
        linkedCostId: "COST-1",
        sourceId: "SOURCE-1",
      },
      {
        id: "DEFENSE:RISK-1",
        severity: "risk",
        category: "defense",
        label: "Wysokie ryzyko kosztu agresywnego",
        userAction: "Zweryfikuj argumentację przed złożeniem.",
        linkedCostId: "COST-2",
      },
    ],
  },
  defense_evidence_links: [
    {
      evidenceId: "EVIDENCE-COST-1",
      costId: "COST-1",
      sourceRecordId: "SOURCE-1",
      linkedTradeIds: ["TRADE-1"],
      amountPln: "176.99",
      defenseStatus: "needs_user_evidence",
      missingEvidence: ["potwierdzenie przelewu", "opis związku z zakupem"],
      userActionLabel: "Dodaj dowód kosztu",
      riskLevel: "medium",
    },
    {
      evidenceId: "EVIDENCE-COST-ORPHAN",
      costId: "COST-ORPHAN",
      sourceRecordId: "SOURCE-ORPHAN",
      linkedTradeIds: [],
      amountPln: "15.68",
      defenseStatus: "missing_link",
      missingEvidence: ["link do transakcji"],
      userActionLabel: "Podłącz rekord historii",
      riskLevel: "high",
    },
  ],
  tax_trace_index: [
    {
      trace_id: "trace:aggressive_cost:COST-1",
      kind: "aggressive_cost",
      label: "Koszt zasilenia",
      amount_pln: 176.99,
      ledger_row_ids: ["AGG_COST_COST-1"],
      evidence_ids: ["EVIDENCE-COST-1"],
      checklist_item_ids: ["DEFENSE:COST-1"],
      source_record_ids: ["SOURCE-1", "TRADE-1"],
      risk_level: "medium",
      tax_impact_kind: "SCENARIO_COST",
      explanation_pl: "Koszt wymaga dowodu i powiązania z zakupem.",
    },
  ],
};

test("buildDefenseWorkbench łączy checklistę, evidence, trace i lokalne override", () => {
  const overrides: DefenseEvidenceOverride[] = [
    {
      evidenceId: "EVIDENCE-COST-1",
      defenseStatus: "complete",
      linkedTradeIds: ["TRADE-1"],
      linkedRowId: "row-trade-1",
      updatedAt: "2026-05-11T11:00:00.000Z",
      userNote: "Potwierdzenie przelewu zachowane w dokumentach.",
      evidenceConfirmed: true,
      checkedAt: "2026-05-11T11:05:00.000Z",
      includedInFilingPackage: true,
    },
  ];

  const workbench = buildDefenseWorkbench(auditAppendix, overrides);
  const item = workbench.items.find((entry) => entry.evidenceId === "EVIDENCE-COST-1");

  assert.equal(workbench.groups.find((group) => group.id === "blocking")?.count, 1);
  assert.equal(workbench.groups.find((group) => group.id === "evidence")?.count, 2);
  assert.equal(workbench.groups.find((group) => group.id === "risk")?.count, 1);
  assert.equal(workbench.progress.totalEvidenceItems, 3);
  assert.equal(workbench.progress.confirmedEvidenceItems, 1);
  assert.equal(workbench.progress.highRiskItems, 2);
  assert.equal(workbench.progress.missingLinkItems, 1);
  assert.equal(item?.traceId, "trace:aggressive_cost:COST-1");
  assert.equal(item?.evidenceConfirmed, true);
  assert.equal(item?.localNote, "Potwierdzenie przelewu zachowane w dokumentach.");
  assert.equal(item?.linkedRowId, "row-trade-1");
  assert.equal(item?.historyTarget.rowId, "row-trade-1");
  assert.equal(item?.historyTarget.searchTerm, "row-trade-1");
});

test("buildDefenseWorkbench dodaje orphan evidence jako pozycję do naprawy", () => {
  const workbench = buildDefenseWorkbench(auditAppendix, []);
  const orphan = workbench.items.find((entry) => entry.evidenceId === "EVIDENCE-COST-ORPHAN");

  assert.equal(orphan?.label, "COST-ORPHAN");
  assert.equal(orphan?.groupId, "evidence");
  assert.equal(orphan?.defenseStatus, "missing_link");
  assert.equal(orphan?.missingEvidence.includes("link do transakcji"), true);
  assert.equal(orphan?.historyTarget.searchTerm, "SOURCE-ORPHAN");
});

