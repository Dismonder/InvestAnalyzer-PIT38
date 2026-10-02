import test from "node:test";
import assert from "node:assert/strict";

import { buildWorkspaceReadiness } from "../../../aplikacje/web/src/invest_analyzer/services/workspaceReadiness.ts";
import type { TaxEngineResponse } from "../../../aplikacje/web/src/invest_analyzer/hooks/useTaxEngineRun.ts";

function buildEngineResult(overrides: Partial<TaxEngineResponse> = {}): TaxEngineResponse {
  return {
    success: true,
    status: "success",
    filing_ready: true,
    plan_used: "aggressive_user",
    audit_hash: "audit-123",
    actionable_issues: [],
    informational_issues: [],
    transaction_history_rows: [{ row_id: "row-1", parent_row_id: null, row_kind: "TRADE" }],
    ...overrides,
  };
}

test("buildWorkspaceReadiness: brak danych ustawia Import jako nie rozpoczęty", () => {
  const readiness = buildWorkspaceReadiness({
    selectedYear: 2026,
    transactionCount: 0,
    fileCount: 0,
    enabledFileCount: 0,
    overrideCount: 0,
    engineLoading: false,
    engineResult: null,
    logs: [],
  });

  assert.equal(readiness.stages.find((stage) => stage.id === "import")?.status, "not_started");
  assert.equal(readiness.stages.find((stage) => stage.id === "tax_report")?.status, "not_started");
});

test("buildWorkspaceReadiness: blokujące issue silnika blokuje Jakość danych", () => {
  const readiness = buildWorkspaceReadiness({
    selectedYear: 2026,
    transactionCount: 10,
    fileCount: 1,
    enabledFileCount: 1,
    overrideCount: 0,
    engineLoading: false,
    engineResult: buildEngineResult({
      filing_ready: false,
      actionable_issues: [
        {
          code: "MISSING_FX_RATE",
          severity: "ERROR",
          stage: "FX",
          scope_type: "transaction",
          scope_id: "t-1",
          message: "Brak kursu NBP",
          blocking: true,
        },
      ],
      quality_report: { metrics: { blocking_count: 1 } },
    }),
    logs: [],
  });

  assert.equal(readiness.stages.find((stage) => stage.id === "dane_quality")?.status, "blocked");
  assert.equal(readiness.attentionItems.length, 1);
  assert.equal(readiness.attentionItems[0].code, "MISSING_FX_RATE");
});

test("buildWorkspaceReadiness: informacyjne issue nie trafiają do listy Co wymaga uwagi", () => {
  const readiness = buildWorkspaceReadiness({
    selectedYear: 2026,
    transactionCount: 10,
    fileCount: 1,
    enabledFileCount: 1,
    overrideCount: 2,
    engineLoading: false,
    engineResult: buildEngineResult({
      informational_issues: [
        {
          code: "BROKER_XML_NOT_SUPPLIED",
          severity: "INFO",
          stage: "RECONCILE",
          scope_type: "broker_xml",
          scope_id: "broker_xml",
          message: "XML parity checks skipped",
          blocking: false,
        },
      ],
    }),
    logs: [],
  });

  assert.equal(readiness.attentionItems.length, 0);
  assert.equal(readiness.stages.find((stage) => stage.id === "manual_overrides")?.count, 2);
});

test("buildWorkspaceReadiness: kontrola zdrowia wyniku ma priorytet nad dowodami", () => {
  const readiness = buildWorkspaceReadiness({
    selectedYear: 2026,
    transactionCount: 10,
    fileCount: 4,
    enabledFileCount: 4,
    overrideCount: 0,
    engineLoading: false,
    engineResult: buildEngineResult({
      tax_filing_package: {
        audit_appendix: {
          result_health_check: {
            status: "needs_review",
            headline: "Wynik wymaga kontroli źródeł danych.",
            reasons: ["Aktywne źródła mają transakcje, ale przychód PIT wynosi 0 zł."],
            activeTaxSourceIds: ["src:baseline"],
            activeTaxSourceLabels: ["historia_transakcji.json"],
            recognizedStorageFileCount: 4,
            taxHistoryRowCount: 1,
            sellRowCount: 1,
            revenuePln: "0",
            costPln: "0",
          },
          pit_submission_readiness: {
            verdict: "NEEDS_EVIDENCE",
            score: 80,
            recommendedAction: null,
            checklist: [
              {
                id: "evidence-1",
                severity: "evidence",
                category: "defense",
                label: "Zachowaj dowód kosztu",
                userAction: "Zachowaj potwierdzenie.",
              },
            ],
            generatedAt: "2026-05-14T00:00:00.000Z",
          },
        },
      },
    }),
    logs: [],
  });

  assert.equal(readiness.settlementStatus.kind, "needs_review");
  assert.equal(readiness.attentionItems[0].code, "RESULT_HEALTH_CHECK");
  assert.equal(readiness.recommendedAction.label, "Sprawdź źródła danych");
});

test("buildWorkspaceReadiness: pobrany pakiet podatkowy ustawia status pakietu jako gotowy", () => {
  const readiness = buildWorkspaceReadiness({
    selectedYear: 2026,
    transactionCount: 10,
    fileCount: 1,
    enabledFileCount: 1,
    overrideCount: 0,
    engineLoading: false,
    engineResult: buildEngineResult(),
    logs: [],
    reportStatus: {
      year: 2026,
      status: "downloaded",
      updatedAt: "2026-04-26T10:00:00.000Z",
    },
  });

  assert.equal(readiness.stages.find((stage) => stage.id === "tax_package")?.status, "ready");
  assert.match(readiness.stages.find((stage) => stage.id === "tax_package")?.message || "", /pobrany/i);
});

test("buildWorkspaceReadiness: nieaktualny case file wymusza ponowne wygenerowanie pakietu", () => {
  const readiness = buildWorkspaceReadiness({
    selectedYear: 2026,
    transactionCount: 10,
    fileCount: 1,
    enabledFileCount: 1,
    overrideCount: 0,
    engineLoading: false,
    engineResult: buildEngineResult(),
    logs: [],
    reportStatus: {
      year: 2026,
      status: "downloaded",
      updatedAt: "2026-04-26T10:00:00.000Z",
    },
    pitCaseFileBaselineStatus: {
      status: "CHANGED",
      label: "Dane lub kalkulacja zmieniły się od ostatniego pakietu",
      changedFields: ["fingerprint kalkulacji"],
      baselineGeneratedAt: "2026-05-10T10:00:00Z",
      currentGeneratedAt: "2026-05-11T10:00:00Z",
    },
  });

  const packageStage = readiness.stages.find((stage) => stage.id === "tax_package");

  assert.equal(packageStage?.status, "needs_attention");
  assert.equal(packageStage?.primaryActionLabel, "Wygeneruj nowy pakiet");
  assert.match(packageStage?.message || "", /zmieniły się od ostatniego pakietu/i);
  assert.equal(readiness.recommendedAction.label, "Wygeneruj nowy pakiet");
  assert.equal(readiness.attentionItems.some((item) => item.code === "PIT_CASE_FILE_CHANGED"), true);
});

test("buildWorkspaceReadiness: zmiana po zamknieciu roku wymusza ponowne zamkniecie roku", () => {
  const readiness = buildWorkspaceReadiness({
    selectedYear: 2026,
    transactionCount: 10,
    fileCount: 1,
    enabledFileCount: 1,
    overrideCount: 0,
    engineLoading: false,
    engineResult: buildEngineResult(),
    logs: [],
    reportStatus: {
      year: 2026,
      status: "downloaded",
      updatedAt: "2026-05-10T10:00:00.000Z",
    },
    taxYearClosureStatus: {
      status: "changed_after_close",
      label: "Dane lub kalkulacja zmieniły się po zamknięciu roku",
      changedFields: ["fingerprint kalkulacji"],
      changedDetails: [
        {
          field: "calculationFingerprint",
          label: "fingerprint kalkulacji",
          previousValue: "calc-1",
          currentValue: "calc-2",
        },
      ],
      isReadOnly: false,
      snapshotHash: "closure-1",
      closedAt: "2026-05-10T10:00:00.000Z",
    },
  });

  const packageStage = readiness.stages.find((stage) => stage.id === "tax_package");

  assert.equal(packageStage?.status, "needs_attention");
  assert.equal(packageStage?.primaryActionLabel, "Zamknij rok ponownie");
  assert.match(packageStage?.message || "", /zmieniły się po zamknięciu roku/i);
  assert.equal(readiness.recommendedAction.label, "Zamknij rok ponownie");
  assert.equal(readiness.attentionItems.some((item) => item.code === "TAX_YEAR_CHANGED_AFTER_CLOSE"), true);
  assert.equal(readiness.metrics.some((metric) => metric.label === "Zamknięcie roku" && metric.value === "Wymaga ponownego zamknięcia"), true);
});

test("buildWorkspaceReadiness: rekomenduje następny krok dla NBP gap", () => {
  const readiness = buildWorkspaceReadiness({
    selectedYear: 2026,
    transactionCount: 10,
    fileCount: 1,
    enabledFileCount: 1,
    overrideCount: 0,
    engineLoading: false,
    engineResult: buildEngineResult({
      actionable_issues: [
        {
          code: "NBP_COVERAGE_GAP",
          severity: "WARNING",
          stage: "FX",
          scope_type: "currency",
          scope_id: "USD",
          message: "NBP coverage gap for USD",
          blocking: false,
        },
      ],
      fx_coverage_gaps: [{ currency: "USD" }],
    }),
    logs: [],
  });

  assert.equal(readiness.taxReadiness.score, 82);
  assert.equal(readiness.taxReadiness.nbpGaps, 1);
  assert.equal(readiness.recommendedAction.label, "Uzupełnij kursy NBP");
  assert.equal(readiness.recommendedAction.targetView, "raport_roczny");
});

test("buildWorkspaceReadiness: używa werdyktu kontroli PIT jako rekomendacji", () => {
  const readiness = buildWorkspaceReadiness({
    selectedYear: 2026,
    transactionCount: 10,
    fileCount: 1,
    enabledFileCount: 1,
    overrideCount: 0,
    engineLoading: false,
    engineResult: buildEngineResult({
      tax_filing_package: {
        audit_appendix: {
          pit_submission_readiness: {
            verdict: "NEEDS_EVIDENCE",
            score: 72,
            generatedAt: "2026-05-01T12:00:00Z",
            recommendedAction: {
              id: "defense:FXC-1",
              severity: "evidence",
              category: "defense",
              label: "Brak dowodu dla kosztu FXC-1",
              userAction: "Dodaj opis kosztu",
              linkedCostId: "FXC-1",
            },
            checklist: [
              {
                id: "defense:FXC-1",
                severity: "evidence",
                category: "defense",
                label: "Brak dowodu dla kosztu FXC-1",
                userAction: "Dodaj opis kosztu",
                linkedCostId: "FXC-1",
              },
            ],
          },
        },
      },
    }),
    logs: [],
  });

  assert.equal(readiness.stages.find((stage) => stage.id === "tax_report")?.status, "needs_attention");
  assert.equal(readiness.attentionItems.some((item) => item.code === "defense:FXC-1"), true);
  assert.equal(readiness.recommendedAction.label, "Dodaj opis kosztu");
  assert.equal(readiness.recommendedAction.message, "Brak dowodu dla kosztu FXC-1");
});

test("buildWorkspaceReadiness: rozdziela gotowy wynik od dowodów do zachowania", () => {
  const readiness = buildWorkspaceReadiness({
    selectedYear: 2026,
    transactionCount: 10,
    fileCount: 2,
    enabledFileCount: 2,
    overrideCount: 0,
    engineLoading: false,
    engineResult: buildEngineResult({
      quality_report: { metrics: { blocking_count: 0 } },
      tax_filing_package: {
        audit_appendix: {
          pit_submission_readiness: {
            verdict: "NEEDS_EVIDENCE",
            score: 82,
            generatedAt: "2026-05-13T10:00:00Z",
            recommendedAction: {
              id: "defense:FXC-1",
              severity: "evidence",
              category: "defense",
              label: "Dowód kosztu: Koszt spreadu przewalutowania",
              userAction: "Zachowaj potwierdzenie przewalutowania.",
              linkedCostId: "FXC-1",
            },
            checklist: [
              {
                id: "defense:FXC-1",
                severity: "evidence",
                category: "defense",
                label: "Dowód kosztu: Koszt spreadu przewalutowania",
                userAction: "Zachowaj potwierdzenie przewalutowania.",
                linkedCostId: "FXC-1",
              },
              {
                id: "defense:FXC-2",
                severity: "evidence",
                category: "defense",
                label: "Dowód kosztu: Koszt spreadu przewalutowania",
                userAction: "Zachowaj potwierdzenie kursu.",
                linkedCostId: "FXC-2",
              },
            ],
          },
        },
      },
    }),
    logs: [],
  });

  assert.equal(readiness.settlementStatus.label, "Gotowe, zachowaj dowody");
  assert.equal(readiness.settlementStatus.blockingCount, 0);
  assert.equal(readiness.settlementStatus.evidenceCount, 2);
  assert.equal(readiness.settlementStatus.message.includes("Brak otwartych kontroli podatkowych"), true);
  assert.equal(readiness.attentionItems.every((item) => item.kind === "evidence_needed"), true);
});

test("buildWorkspaceReadiness: otwarte akcje importu trafiaja do rekomendacji i uwagi", () => {
  const readiness = buildWorkspaceReadiness({
    selectedYear: 2026,
    transactionCount: 10,
    fileCount: 2,
    enabledFileCount: 2,
    overrideCount: 0,
    engineLoading: false,
    engineResult: buildEngineResult({
      tax_filing_package: {
        audit_appendix: {
          broker_file_action_queue: [
            {
              action_id: "BFAQ-coverage-fx",
              severity: "blocking",
              area: "coverage:fx",
              label: "Brak danych FX",
              user_action: "Dodaj plik z przewalutowaniami albo opisz brak danych.",
              source_ids: ["source:cash"],
              cost_ids: [],
              history_search_term: "FX",
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
              history_search_term: "COST-1",
              default_status: "open",
              reason: "no_overpay_audit_v2",
              supplemental_only_breakdown_label: "Odsetki/prowizje salda ujemnego: 1",
            },
          ],
        },
      },
    }),
    logs: [],
  });

  const importStage = readiness.stages.find((stage) => stage.id === "import");
  assert.equal(importStage?.status, "needs_attention");
  assert.equal(importStage?.primaryActionLabel, "Obsłuż akcje importu");
  assert.match(importStage?.message || "", /Otwarte akcje importu: 2/);
  assert.equal(readiness.recommendedAction.label, "Przejrzyj akcje importu");
  assert.equal(readiness.recommendedAction.targetView, "import_danych");
  assert.equal(readiness.attentionItems.some((item) => item.code === "BFAQ-coverage-fx" && item.targetView === "import_danych"), true);
  assert.equal(
    readiness.attentionItems.some((item) => item.code === "BFAQ-cost-evidence" && item.message.includes("Odsetki/prowizje salda ujemnego: 1")),
    true,
  );
  assert.equal(readiness.metrics.some((metric) => metric.label === "Akcje importu" && metric.value === "2/2"), true);
});

test("buildWorkspaceReadiness: lokalny resolved usuwa akcje importu z otwartych spraw bez zmiany silnika", () => {
  const readiness = buildWorkspaceReadiness({
    selectedYear: 2026,
    transactionCount: 10,
    fileCount: 2,
    enabledFileCount: 2,
    overrideCount: 0,
    engineLoading: false,
    engineResult: buildEngineResult({
      tax_filing_package: {
        audit_appendix: {
          broker_file_action_queue: [
            {
              action_id: "BFAQ-coverage-fx",
              severity: "blocking",
              area: "coverage:fx",
              label: "Brak danych FX",
              user_action: "Dodaj plik z przewalutowaniami albo opisz brak danych.",
              source_ids: ["source:cash"],
              cost_ids: [],
              default_status: "open",
              reason: "coverage_matrix:fx",
            },
          ],
        },
      },
    }),
    logs: [],
    brokerFileActionOverrides: [
      {
        actionId: "BFAQ-coverage-fx",
        status: "resolved",
        userNote: "Sprawdzone w pliku cash statement.",
        updatedAt: "2026-05-12T20:00:00.000Z",
      },
    ],
  });

  assert.equal(readiness.stages.find((stage) => stage.id === "import")?.status, "ready");
  assert.equal(readiness.attentionItems.some((item) => item.code === "BFAQ-coverage-fx"), false);
  assert.equal(readiness.metrics.some((metric) => metric.label === "Akcje importu" && metric.value === "0/1"), true);
});

test("buildWorkspaceReadiness: centrum pracy nie zawiera etapów ani widoków Freedom24 API", () => {
  const readiness = buildWorkspaceReadiness({
    selectedYear: 2026,
    transactionCount: 10,
    fileCount: 1,
    enabledFileCount: 1,
    overrideCount: 0,
    engineLoading: false,
    engineResult: buildEngineResult(),
    logs: [],
  });

  assert.equal(readiness.stages.some((stage) => String(stage.id) === "freedom24"), false);
  assert.equal(readiness.stages.some((stage) => String(stage.targetView) === "portfel_na_zywo"), false);
  assert.equal("freedom24Data" in readiness, false);
  assert.equal("syncTimeline" in readiness, false);
});

