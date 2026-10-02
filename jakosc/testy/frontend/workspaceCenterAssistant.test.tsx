import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { WorkspaceCenter } from "../../../aplikacje/web/src/invest_analyzer/components/WorkspaceCenter.tsx";
import type { PitCaseFile, TaxEngineResponse } from "../../../aplikacje/web/src/invest_analyzer/hooks/useTaxEngineRun.ts";
import { getPitCaseFileBaselineStorageKey } from "../../../aplikacje/web/src/invest_analyzer/services/pitCaseFile.ts";
import { closeTaxYear } from "../../../aplikacje/web/src/invest_analyzer/services/yearClosure.ts";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

test("WorkspaceCenter pokazuje etapowego Asystenta PIT z werdyktem i rekomendowanym krokiem", () => {
  const engineResult: TaxEngineResponse = {
    success: true,
    status: "SUCCESS",
    audit_hash: "audit-1",
    annual_summary: { tax_year: "2025" },
    tax_filing_package: {
      audit_appendix: {
        pit_submission_readiness: {
          verdict: "NEEDS_EVIDENCE",
          score: 72,
          generatedAt: "2026-05-10T10:00:00.000Z",
          recommendedAction: {
            id: "DEFENSE:COST-1",
            severity: "evidence",
            category: "defense",
            label: "Brak potwierdzenia kosztu",
            userAction: "Dodaj opis i potwierdzenie dowodu kosztu.",
            linkedCostId: "COST-1",
          },
          checklist: [
            {
              id: "DATA:OK",
              severity: "info",
              category: "dane_quality",
              label: "Dane wejściowe są spójne",
              userAction: "Brak działania.",
            },
            {
              id: "DEFENSE:COST-1",
              severity: "evidence",
              category: "defense",
              label: "Brak potwierdzenia kosztu",
              userAction: "Dodaj opis i potwierdzenie dowodu kosztu.",
              linkedCostId: "COST-1",
            },
          ],
        },
        defense_evidence_links: [
          {
            evidenceId: "EVIDENCE-COST-1",
            costId: "COST-1",
            sourceRecordId: "SOURCE-COST-1",
            linkedTradeIds: ["TRADE-1"],
            amountPln: "24.73",
            defenseStatus: "needs_user_evidence",
            missingEvidence: ["potwierdzenie przelewu"],
            userActionLabel: "Dodaj dowód kosztu",
            riskLevel: "medium",
          },
        ],
        tax_trace_index: [
          {
            trace_id: "trace:aggressive_cost:COST-1",
            kind: "aggressive_cost",
            label: "Koszt zasilenia",
            amount_pln: "24.73",
            ledger_row_ids: ["AGG_COST_COST-1"],
            evidence_ids: ["EVIDENCE-COST-1"],
            checklist_item_ids: ["DEFENSE:COST-1"],
            source_record_ids: ["SOURCE-COST-1", "TRADE-1"],
            risk_level: "medium",
            tax_impact_kind: "SCENARIO_COST",
            explanation_pl: "Koszt wymaga dowodu.",
          },
        ],
      },
    },
  };

  const markup = renderToStaticMarkup(
    <WorkspaceCenter
      selectedYear={2025}
      engineLoading={false}
      engineResult={engineResult}
      files={[]}
      logs={[]}
      overrideCount={0}
      reportOrganizationStatus={{ year: 2025, status: "draft", updatedAt: "2026-05-10T10:00:00.000Z" }}
      onNavigate={() => undefined}
      onOpenHistorySearch={() => undefined}
    />,
  );

  assert.equal(markup.includes("Samocheck PIT"), true);
  assert.equal(markup.includes('data-motion="workspace-cockpit"'), true);
  assert.equal(markup.includes('data-motion="workspace-step-rail"'), true);
  assert.equal(markup.includes("Najważniejsza akcja"), true);
  assert.equal(markup.includes("Otwórz panel szczegółów"), true);
  assert.equal(markup.includes("Przejdź"), true);
  assert.equal(markup.includes("Dane"), true);
  assert.equal(markup.includes("Źródła brokera"), true);
  assert.equal(markup.includes("Kursy NBP"), true);
  assert.equal(markup.includes("Historia"), true);
  assert.equal(markup.includes("Dowody"), true);
  assert.equal(markup.includes("Pakiet PIT"), true);
  assert.equal(markup.includes("Wymaga danych"), true);
  assert.equal(markup.includes("Dodaj opis i potwierdzenie dowodu kosztu."), true);
  assert.equal(markup.includes("Asystent PIT przed złożeniem"), false);
  assert.equal(markup.includes("Panel dowodów PIT"), false);
  assert.equal(markup.includes("Konsola naprawy PIT"), false);
  assert.equal(markup.includes("Kontrola plików brokera"), false);
  assert.equal(markup.includes("Zamknięcie roku PIT"), false);
  assert.equal(markup.includes("Co wymaga uwagi"), false);
  assert.equal(markup.includes("Oznacz dowód jako zebrany"), false);
});

test("WorkspaceCenter pokazuje Broker File Control Tower jako operacyjny status importu", () => {
  const engineResult: TaxEngineResponse = {
    success: true,
    status: "SUCCESS",
    audit_hash: "audit-control-tower",
    annual_summary: { tax_year: "2025" },
    tax_filing_package: {
      audit_appendix: {
        broker_file_control_tower: {
          summary: {
            source_count: 3,
            canonical_source_count: 2,
            context_source_count: 1,
            duplicate_count: 0,
            conflict_count: 1,
            missing_coverage_count: 1,
            candidate_cost_count: 4,
          },
          sections: {
            what_was_imported: [],
            canonical_sources: [],
            context_sources: [],
            missing: [],
          },
          recommendedActions: [
            "Przewalutowania i różnice FX: dodaj dowód przewalutowania albo oznacz jako nie dotyczy.",
          ],
        },
        coverage_matrix: [
          {
            area: "transactions",
            label: "Transakcje",
            status: "complete",
            recordCount: 128,
            issueCount: 0,
            sourceIds: ["source:broker-json"],
            recommendation: "Transakcje są rozpoznane.",
          },
          {
            area: "fx",
            label: "Przewalutowania i różnice FX",
            status: "partial",
            recordCount: 2,
            issueCount: 1,
            sourceIds: ["source:cash"],
            recommendation: "Dodaj dowód przewalutowania.",
          },
        ],
        no_overpay_audit_v2: {
          summary: {
            candidateCostCount: 4,
            potentiallyMissedCount: 1,
            duplicateRiskCount: 0,
            missingEvidenceCount: 1,
            confidenceScore: 82,
          },
          candidateCosts: [],
          potentiallyMissedCosts: [],
          duplicateRisks: [],
          technicalRows: [],
          missingEvidence: [],
          coverageMatrix: [],
          statusSummary: {},
          recommendedActions: [],
        },
        broker_file_action_queue: [
          {
            action_id: "BFAQ-coverage-fx",
            severity: "blocking",
            area: "coverage:fx",
            label: "Brak danych FX",
            user_action: "Dodaj plik z przewalutowaniami.",
            source_ids: ["source:cash"],
            cost_ids: [],
            default_status: "open",
            reason: "coverage_matrix:fx",
          },
          {
            action_id: "BFAQ-cost-evidence",
            severity: "warning",
            area: "no_overpay",
            label: "Koszt wymaga dowodu",
            user_action: "Zachowaj potwierdzenie kosztu.",
            source_ids: ["source:fee"],
            cost_ids: ["COST-1"],
            default_status: "open",
            reason: "no_overpay_audit_v2",
          },
        ],
      },
    },
  };

  const markup = renderToStaticMarkup(
    <WorkspaceCenter
      selectedYear={2025}
      engineLoading={false}
      engineResult={engineResult}
      files={[]}
      logs={[]}
      overrideCount={0}
      reportOrganizationStatus={{ year: 2025, status: "draft", updatedAt: "2026-05-10T10:00:00.000Z" }}
      uiComplexityMode="expert"
      onNavigate={() => undefined}
      brokerFileActionOverrides={[
        {
          actionId: "BFAQ-cost-evidence",
          status: "resolved",
          updatedAt: "2026-05-12T20:00:00.000Z",
        },
      ]}
    />,
  );

  assert.equal(markup.includes("Kontrola plików brokera"), true);
  assert.equal(markup.includes("3 pliki"), true);
  assert.equal(markup.includes("2 źródeł"), true);
  assert.equal(markup.includes("Macierz kompletności danych"), true);
  assert.equal(markup.includes("Przewalutowania i różnice FX"), true);
  assert.equal(markup.includes("częściowe"), true);
  assert.equal(markup.includes("Przejdź do importu"), true);
  assert.equal(markup.includes("dodaj dowód przewalutowania albo oznacz jako nie dotyczy"), true);
  assert.equal(markup.includes("Akcje importu"), true);
  assert.equal(markup.includes("1/2"), true);
  assert.equal(markup.includes("0 kontroli PIT, 1 rozwiązane"), true);
});

test("WorkspaceCenter grupuje sprawy uwagi według wpływu na użytkownika", () => {
  const engineResult: TaxEngineResponse = {
    success: true,
    status: "SUCCESS",
    audit_hash: "audit-attention-groups",
    filing_ready: true,
    annual_summary: { tax_year: "2025" },
    transaction_history_rows: [{ row_id: "ROW-1" } as never],
    tax_filing_package: {
      audit_appendix: {
        pit_submission_readiness: {
          verdict: "NEEDS_EVIDENCE",
          score: 82,
          generatedAt: "2026-05-10T10:00:00.000Z",
          recommendedAction: {
            id: "DEFENSE:COST-1",
            severity: "evidence",
            category: "defense",
            label: "Dowód kosztu FX",
            userAction: "Zachowaj potwierdzenie przewalutowania.",
            linkedCostId: "COST-1",
          },
          checklist: [
            {
              id: "DEFENSE:COST-1",
              severity: "evidence",
              category: "defense",
              label: "Dowód kosztu FX",
              userAction: "Zachowaj potwierdzenie przewalutowania.",
              linkedCostId: "COST-1",
            },
          ],
        },
        broker_file_action_queue: [
          {
            action_id: "BFAQ-source-review",
            severity: "warning",
            area: "source_reconciliation",
            label: "Rekord tylko w pliku pomocniczym",
            user_action: "Sprawdź rekord pomocniczy bez zmiany PIT.",
            source_ids: ["source:xlsx"],
            cost_ids: [],
            default_status: "open",
            reason: "source_reconciliation",
          },
        ],
      },
    },
  };

  const markup = renderToStaticMarkup(
    <WorkspaceCenter
      selectedYear={2025}
      engineLoading={false}
      engineResult={engineResult}
      files={[]}
      logs={[
        {
          id: "log-false-traderzy",
          timestamp: "2026-05-14T10:00:00.000Z",
          level: "error",
          stage: "AUTO_IMPORT",
          message: "Błąd importu pliku Traderzy.xlsx",
          details: "Nie rozpoznano formatu",
        },
      ]}
      overrideCount={0}
      reportOrganizationStatus={{ year: 2025, status: "draft", updatedAt: "2026-05-10T10:00:00.000Z" }}
      uiComplexityMode="expert"
      onNavigate={() => undefined}
    />,
  );

  assert.equal(markup.includes("Kontrole PIT"), true);
  assert.equal(markup.includes("Dowody do zachowania"), true);
  assert.equal(markup.includes("Kontrola plików"), true);
  assert.equal(markup.includes("Informacje"), true);
  assert.equal(markup.includes("Brak kontroli PIT wymagających działania."), true);
  assert.equal(markup.includes("Dowód kosztu FX"), true);
  assert.equal(markup.includes("Rekord tylko w pliku pomocniczym"), false);
  assert.equal(markup.includes("Pokaż szczegóły"), true);
  assert.equal(markup.includes("Pominięto plik Traderzy.xlsx"), false);
});

test("WorkspaceCenter ostrzega, gdy pobrany pakiet PIT jest starszy niż bieżący case file", () => {
  const storage = new Map<string, string>();
  storage.set(
    getPitCaseFileBaselineStorageKey(2025),
    JSON.stringify({
      case_file_id: "case-old",
      generated_at: "2026-05-10T10:00:00.000Z",
      tax_year: "2025",
      plan_used: "aggressive_user",
      reproducible: true,
      reproducibility_status: "complete",
      input_fingerprint: "input-1",
      calculation_fingerprint: "calc-old",
    }),
  );
  const previousLocalStorage = (globalThis as typeof globalThis & { localStorage?: unknown }).localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });

  try {
    const engineResult: TaxEngineResponse = {
      success: true,
      status: "SUCCESS",
      audit_hash: "audit-2",
      filing_ready: true,
      annual_summary: { tax_year: "2025" },
      transaction_history_rows: [{ row_id: "ROW-1" } as never],
      tax_filing_package: {
        audit_appendix: {
          pit_case_file: {
            case_file_id: "case-new",
            generated_at: "2026-05-11T10:00:00.000Z",
            tax_year: "2025",
            plan_used: "aggressive_user",
            reproducible: true,
            reproducibility_status: "complete",
            input_fingerprint: "input-1",
            calculation_fingerprint: "calc-new",
          },
        },
      },
    };

    const markup = renderToStaticMarkup(
      <WorkspaceCenter
        selectedYear={2025}
        engineLoading={false}
        engineResult={engineResult}
        files={[]}
        logs={[]}
        overrideCount={0}
        reportOrganizationStatus={{ year: 2025, status: "downloaded", updatedAt: "2026-05-10T10:00:00.000Z" }}
        uiComplexityMode="expert"
        onNavigate={() => undefined}
      />,
    );

    assert.equal(markup.includes("Wygeneruj nowy pakiet"), true);
    assert.equal(markup.includes("Pakiet podatkowy jest nieaktualny"), true);
    assert.equal(markup.includes("fingerprint kalkulacji"), true);
  } finally {
    if (previousLocalStorage === undefined) {
      Reflect.deleteProperty(globalThis, "localStorage");
    } else {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: previousLocalStorage,
      });
    }
  }
});

test("WorkspaceCenter pokazuje status zamkniecia roku PIT i zmiany po zamknieciu", () => {
  const storage = new MemoryStorage();
  const closedCaseFile: PitCaseFile = {
    case_file_id: "case-2025",
    generated_at: "2026-05-11T10:00:00.000Z",
    tax_year: "2025",
    plan_used: "aggressive_user",
    audit_hash: "audit-1",
    reproducible: true,
    reproducibility_status: "complete",
    input_fingerprint: "input-1",
    calculation_fingerprint: "calc-1",
  };
  closeTaxYear(storage, closedCaseFile);

  const previousLocalStorage = (globalThis as typeof globalThis & { localStorage?: unknown }).localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });

  try {
    const engineResult: TaxEngineResponse = {
      success: true,
      status: "SUCCESS",
      audit_hash: "audit-2",
      filing_ready: true,
      annual_summary: { tax_year: "2025" },
      tax_filing_package: {
        audit_appendix: {
          pit_case_file: {
            ...closedCaseFile,
            calculation_fingerprint: "calc-2",
          },
        },
      },
    };

    const markup = renderToStaticMarkup(
      <WorkspaceCenter
        selectedYear={2025}
        engineLoading={false}
        engineResult={engineResult}
        files={[]}
        logs={[]}
        overrideCount={0}
        reportOrganizationStatus={{ year: 2025, status: "downloaded", updatedAt: "2026-05-10T10:00:00.000Z" }}
        uiComplexityMode="expert"
        onNavigate={() => undefined}
      />,
    );

    assert.equal(markup.includes("Zamknięcie roku PIT"), true);
    assert.equal(markup.includes("Dane lub kalkulacja zmieniły się po zamknięciu roku"), true);
    assert.equal(markup.includes("fingerprint kalkulacji"), true);
    assert.equal(markup.includes("Rok nie jest już zamrożony"), true);
  } finally {
    if (previousLocalStorage === undefined) {
      Reflect.deleteProperty(globalThis, "localStorage");
    } else {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: previousLocalStorage,
      });
    }
  }
});

test("WorkspaceCenter blokuje lokalne zmiany dowodow dla zamknietego roku", () => {
  const storage = new MemoryStorage();
  const closedCaseFile: PitCaseFile = {
    case_file_id: "case-2025",
    generated_at: "2026-05-11T10:00:00.000Z",
    tax_year: "2025",
    plan_used: "aggressive_user",
    audit_hash: "audit-1",
    reproducible: true,
    reproducibility_status: "complete",
    input_fingerprint: "input-1",
    calculation_fingerprint: "calc-1",
  };
  closeTaxYear(storage, closedCaseFile);

  const previousLocalStorage = (globalThis as typeof globalThis & { localStorage?: unknown }).localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });

  try {
    const engineResult: TaxEngineResponse = {
      success: true,
      status: "SUCCESS",
      audit_hash: "audit-1",
      filing_ready: true,
      annual_summary: { tax_year: "2025" },
      tax_filing_package: {
        audit_appendix: {
          pit_case_file: closedCaseFile,
          defense_evidence_links: [
            {
              evidenceId: "EVIDENCE-COST-1",
              costId: "COST-1",
              sourceRecordId: "SOURCE-COST-1",
              linkedTradeIds: ["TRADE-1"],
              amountPln: "24.73",
              defenseStatus: "needs_user_evidence",
              missingEvidence: ["potwierdzenie przelewu"],
              userActionLabel: "Dodaj dowód kosztu",
              riskLevel: "medium",
            },
          ],
        },
      },
    };

    const markup = renderToStaticMarkup(
      <WorkspaceCenter
        selectedYear={2025}
        engineLoading={false}
        engineResult={engineResult}
        files={[]}
        logs={[]}
        overrideCount={0}
        reportOrganizationStatus={{ year: 2025, status: "downloaded", updatedAt: "2026-05-10T10:00:00.000Z" }}
        uiComplexityMode="expert"
        onNavigate={() => undefined}
        onConfirmEvidence={() => undefined}
        onAddEvidenceNote={() => undefined}
      />,
    );

    assert.equal(markup.includes("Dowody są tylko do odczytu, bo rok jest zamknięty"), true);
    assert.equal(markup.includes("Oznacz dowód jako zebrany"), false);
    assert.equal(markup.includes("Dodaj notatkę"), false);
  } finally {
    if (previousLocalStorage === undefined) {
      Reflect.deleteProperty(globalThis, "localStorage");
    } else {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: previousLocalStorage,
      });
    }
  }
});

