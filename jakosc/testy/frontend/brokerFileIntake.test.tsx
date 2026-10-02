import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ImportData } from "../../../aplikacje/web/src/invest_analyzer/components/ImportData.tsx";
import {
  buildBrokerFileIntakeSummary,
  getStorageFileDisplayState,
} from "../../../aplikacje/web/src/invest_analyzer/services/brokerFileIntake.ts";
import { buildImportIntelligenceView } from "../../../aplikacje/web/src/invest_analyzer/services/importIntelligenceView.ts";
import { buildBrokerActionWorkbench } from "../../../aplikacje/web/src/invest_analyzer/services/brokerActionWorkbench.ts";
import {
  readBrokerFileActionOverrides,
  saveBrokerFileActionOverrides,
} from "../../../aplikacje/web/src/invest_analyzer/services/brokerFileActionOverrides.ts";
import { createMemoryStorageSource } from "../../../aplikacje/web/src/invest_analyzer/services/taxEngineConfig.ts";
import type { TaxFilingPackageAuditAppendix } from "../../../aplikacje/web/src/invest_analyzer/hooks/useTaxEngineRun.ts";

function auditAppendixFixture(): TaxFilingPackageAuditAppendix {
  return {
    broker_file_control_tower: {
      summary: {
        source_count: 3,
        canonical_source_count: 2,
        context_source_count: 1,
        conflict_count: 1,
        missing_coverage_count: 1,
        candidate_cost_count: 4,
      },
      sections: {
        canonical_sources: [
          {
            sourceId: "source:tax-json",
            filename: "broker_report_2025.json",
            detectedType: "broker_report",
            contributesToTax: true,
            hash: "abcdef1234567890",
            sections: ["trades", "commissions"],
            recordCounts: { trades: 128, commissions: 22 },
            dateRange: { from: "2025-01-01", to: "2025-12-31" },
          },
        ],
        context_sources: [
          {
            sourceId: "source:evidence-pdf",
            filename: "potwierdzenie_przelewu.pdf",
            detectedType: "evidence",
            contributesToTax: false,
            warnings: ["Brak powiązania z kosztem zasilenia."],
          },
        ],
      },
      recommendedActions: [
        "Dodaj brakujący plik z przewalutowaniami albo oznacz obszar jako nie dotyczy.",
      ],
    },
    source_manifest_v2: [
      {
        sourceId: "source:tax-json",
        filename: "broker_report_2025.json",
        relativePath: "broker_report_2025.json",
        detectedType: "broker_report",
        contributesToTax: true,
        hash: "abcdef1234567890",
        sections: ["trades", "commissions"],
        recordCounts: { trades: 128 },
        dateRange: { from: "2025-01-01", to: "2025-12-31" },
      },
      {
        sourceId: "source:evidence-pdf",
        filename: "potwierdzenie_przelewu.pdf",
        detectedType: "evidence",
        contributesToTax: false,
        warnings: ["Brak powiązania z kosztem zasilenia."],
      },
    ],
    import_intelligence_report: {
      duplicates: [{ sourceId: "source:tax-json", recordKey: "TRADE-1" }],
      conflicts: [{ sourceId: "source:tax-json", field: "commission" }],
      missingExpectedSections: ["Przewalutowania"],
      recommendedActions: ["Sprawdź, czy plik cash flow zawiera przewalutowania."],
    },
    no_overpay_audit_v2: {
      potentiallyMissedCosts: [
        {
          costId: "FX-LOSS-1",
          labelPl: "Potencjalna strata FX",
          status: "requires_evidence",
          userAction: "Dodaj dowód przewalutowania EUR/USD.",
        },
      ],
      recommendedActions: ["Zweryfikuj potencjalnie pominięte koszty FX."],
    },
    broker_file_action_queue: [
      {
        action_id: "BFAQ-coverage-fx",
        severity: "warning",
        area: "coverage:fx",
        label: "Przewalutowania i różnice FX mają częściowe pokrycie.",
        user_action: "Dodaj dowód przewalutowania albo opisz, dlaczego obszar nie dotyczy.",
        source_ids: ["source:tax-json"],
        cost_ids: [],
        history_search_term: null,
        default_status: "open",
        reason: "coverage_matrix:partial",
        supplemental_only_breakdown_label: "Odsetki/prowizje salda ujemnego: 1",
      },
      {
        action_id: "BFAQ-cost-fx-loss-1",
        severity: "warning",
        area: "no_overpay",
        label: "Potencjalna strata FX wymaga decyzji dowodowej.",
        user_action: "Dodaj dowód przewalutowania EUR/USD.",
        source_ids: ["source:evidence-pdf"],
        cost_ids: ["FX-LOSS-1"],
        history_search_term: "FX-LOSS-1",
        default_status: "open",
        reason: "potentially_missed_cost",
      },
    ],
    source_reconciliation_report: {
      primarySourceId: "source:tax-json",
      comparedSources: [
        {
          sourceId: "source:tax-json",
          filename: "broker_report_2025.json",
          role: "primary_tax",
          matchedCount: 128,
          primaryOnlyCount: 0,
          supplementalOnlyCount: 0,
          duplicateCount: 0,
          dateRangeGap: false,
          confidenceScore: 100,
          status: "matched",
          message: "Główne źródło PIT.",
        },
        {
          sourceId: "source:evidence-pdf",
          filename: "potwierdzenie_przelewu.pdf",
          role: "evidence",
          matchedCount: 0,
          primaryOnlyCount: 0,
          supplementalOnlyCount: 1,
          duplicateCount: 0,
          dateRangeGap: false,
          confidenceScore: 0,
          status: "needs_review",
          message: "Plik dowodowy wymaga ręcznej kontroli.",
          supplementalOnlyBreakdown: [
            { kind: "negative_balance_interest", label: "Odsetki/prowizje salda ujemnego", count: 1 },
          ],
        },
      ],
      summary: {
        confidenceScore: 50,
        matchedSources: 1,
        needsReviewSources: 1,
        duplicateSources: 0,
        supplementalOnlyRecords: 1,
      },
      recommendedActions: ["potwierdzenie_przelewu.pdf: sprawdź rekordy tylko w pliku pomocniczym."],
    },
    coverage_matrix: [
      {
        area: "transactions",
        label: "Transakcje",
        status: "complete",
        recordCount: 128,
        recommendation: "Transakcje są kompletne.",
      },
      {
        area: "fx",
        label: "Przewalutowania i różnice FX",
        status: "partial",
        issueCount: 1,
        recommendation: "Dodaj dowód przewalutowania.",
      },
      {
        area: "dividends",
        label: "Dywidendy",
        status: "not_applicable",
        recommendation: "Brak dywidend w danych.",
      },
    ],
    canonical_storage_history_rows: [{ row_id: "storage-row-1", parent_row_id: null, row_kind: "TRADE" }],
    canonical_storage_history_summary: {
      rawRowCount: 1847,
      deduplicatedRowCount: 884,
      mergedRecordCount: 963,
    },
    transaction_dossier_summary: {
      dossierCount: 12,
      conflictCount: 1,
      needsReviewCount: 2,
    },
    canonical_tax_input_summary: {
      recordCount: 4,
      engineReadyRecordCount: 1,
      incompleteRecordCount: 1,
      informationalRecordCount: 1,
      unrecognizedRecordCount: 1,
      aiCandidateCount: 0,
    },
    canonical_tax_input: {
      schema_version: "canonical_tax_input.v2",
      records: [
        {
          canonical_record_status: "ready",
          event_id: "evt-active-1",
          event_kind: "trade",
          source: { filename: "broker_report_2025.json", row: "1" },
          identity: { trade_id: "T-1" },
          date: { trade_date: "2025-02-03" },
          instrument: { ticker: "AAPL.US" },
          amounts: { quantity: 2, price: 100, currency: "USD" },
          operation: "BUY",
          raw: { raw_payload: { ticker: "AAPL.US", operation: "BUY", quantity: 2 } },
        },
        {
          canonical_record_status: "incomplete",
          event_id: "evt-review-1",
          event_kind: "trade",
          source: { filename: "potwierdzenie_przelewu.pdf", row: "raw-7" },
          date: { trade_date: "2025-02-04" },
          instrument: { ticker: "MSFT.US" },
          operation: "SELL",
          validation_errors: ["missing_quantity"],
          raw: { raw_payload: { ticker: "MSFT.US", operation: "SELL" } },
        },
        {
          canonical_record_status: "informational",
          event_id: "evt-info-1",
          event_kind: "cash_movement",
          source: { filename: "cash_flow.xlsx", row: "3" },
          date: { pay_date: "2025-02-05" },
          operation: "DEPOSIT",
          raw: { raw_payload: { amount: 1000, currency: "USD" } },
        },
        {
          canonical_record_status: "unrecognized",
          status: "unrecognized",
          source: { filename: "broken.csv", row: "9" },
          validation_errors: ["unrecognized_event"],
          raw: { raw_payload: { raw_line: "???;broken" } },
        },
      ],
    },
    source_registry: [
      {
        source_id: "source:tax-json",
        filename: "broker_report_2025.json",
        file_sha256: "abcdef1234567890",
        detected_type: "broker_report_json",
        source_role: "baseline_tax",
        parser: "broker_report_json",
        record_count: 150,
        used_record_count: 150,
        context_record_count: 0,
        needs_review_count: 0,
        pit_impact: "active",
        enriched_dossier_ids: ["dossier:tax-1", "dossier:tax-2"],
        reason: "Główne źródło transakcji.",
      },
      {
        source_id: "source:evidence-pdf",
        filename: "potwierdzenie_przelewu.pdf",
        file_sha256: "pdf123",
        detected_type: "fee_schedule_pdf",
        source_role: "evidence",
        parser: "fee_schedule_pdf",
        record_count: 1,
        used_record_count: 0,
        context_record_count: 1,
        needs_review_count: 1,
        pit_impact: "context_only",
        enriched_dossier_ids: [],
        reason: "Dowód do ręcznej kontroli.",
        warnings: ["Brak powiązania z kosztem zasilenia."],
      },
      {
        source_id: "source:nbp",
        filename: "archiwum_tab_a_2025.csv",
        file_sha256: "nbp123",
        detected_type: "nbp_archive",
        source_role: "nbp_rates",
        parser: "nbp_archive",
        record_count: 1,
        used_record_count: 1,
        context_record_count: 0,
        needs_review_count: 0,
        pit_impact: "active",
        enriched_dossier_ids: [],
        reason: "Kursy NBP dla silnika.",
      },
    ],
    normalized_storage_manifest: [
      {
        file_sha256: "abcdef1234567890",
        original_filename: "broker_report_2025.json",
        deterministic_parser: {
          parser_name: "broker_report_json",
          status: "parsed",
          warnings: [],
          errors: [],
        },
        ai_normalizer: {
          status: "disabled",
          warnings: [],
          errors: [],
        },
        final_status: "accepted",
        pit_impact: "active",
        reason: "Główne źródło transakcji.",
      },
      {
        file_sha256: "pdf123",
        original_filename: "potwierdzenie_przelewu.pdf",
        deterministic_parser: {
          parser_name: "fee_schedule_pdf",
          status: "parsed",
          warnings: ["Brak powiązania z kosztem zasilenia."],
          errors: [],
        },
        ai_normalizer: {
          status: "not_needed",
          warnings: [],
          errors: [],
        },
        final_status: "accepted_with_warnings",
        pit_impact: "context_only",
        reason: "Dowód do ręcznej kontroli.",
      },
      {
        file_sha256: "nbp123",
        original_filename: "archiwum_tab_a_2025.csv",
        deterministic_parser: {
          parser_name: "nbp_archive",
          status: "parsed",
          warnings: [],
          errors: [],
        },
        ai_normalizer: {
          status: "disabled",
          warnings: [],
          errors: [],
        },
        final_status: "accepted",
        pit_impact: "active",
        reason: "Kursy NBP dla silnika.",
      },
    ],
    ai_validation_report: {
      schema_version: "ai.validation_report.v1",
      safe_tax_policy: {
        allow_ai_to_promote_to_pit: false,
      },
      document_classification: {
        total: 2,
      },
      column_mapping: {
        total: 1,
      },
      extracted_context: {
        total: 0,
      },
    },
  };
}

test("buildBrokerFileIntakeSummary agreguje control tower i coverage matrix bez liczenia podatku", () => {
  const summary = buildBrokerFileIntakeSummary(auditAppendixFixture(), [], ["broker_report_2025.json"]);

  assert.equal(summary.totalSources, 3);
  assert.equal(summary.taxSources, 2);
  assert.equal(summary.evidenceOnlySources, 1);
  assert.equal(summary.conflictCount, 1);
  assert.deepEqual(summary.missingAreas, ["Przewalutowania i różnice FX"]);
  assert.equal(summary.coverageRows.length, 3);
  assert.equal(summary.coverageRows[1].status, "partial");
  assert.equal(summary.recommendedAction, "Dodaj brakujący plik z przewalutowaniami albo oznacz obszar jako nie dotyczy.");
  assert.equal(summary.processedStorageFiles.length, 1);
});

test("buildBrokerFileIntakeSummary buduje role źródeł i kolejkę akcji", () => {
  const summary = buildBrokerFileIntakeSummary(auditAppendixFixture(), [], ["broker_report_2025.json"]);

  assert.equal(summary.sourceRows.length, 3);
  assert.equal(summary.sourceRows[0].sourceId, "source:tax-json");
  assert.equal(summary.sourceRows[0].role, "tax");
  assert.equal(summary.sourceRows[0].roleLabel, "Źródło transakcyjne");
  assert.equal(summary.sourceRows[0].hashShort, "abcdef123456");
  assert.equal(summary.sourceRows[0].dateRangeLabel, "2025-01-01 - 2025-12-31");
  assert.equal(summary.sourceRows[0].recordCountLabel, "150 rekordów");
  const evidenceRow = summary.sourceRows.find((row) => row.sourceId === "source:evidence-pdf");
  assert.equal(evidenceRow?.role, "evidence");
  assert.equal(evidenceRow?.hasProblems, true);

  assert.equal(summary.actionRows.length, 2);
  const coverageAction = summary.actionRows.find((row) => row.actionId === "BFAQ-coverage-fx");
  assert.ok(coverageAction);
  assert.equal(coverageAction.status, "open");
  assert.equal(coverageAction.statusLabel, "Otwarte");
  assert.equal(coverageAction.supplementalOnlyBreakdownLabel, "Odsetki/prowizje salda ujemnego: 1");
  assert.equal(coverageAction.relatedSourceIds.includes("source:tax-json"), true);
  assert.equal(summary.actionRows.some((row) => row.relatedCostIds.includes("FX-LOSS-1")), true);
  assert.equal(summary.openActionCount, 2);
  assert.equal(summary.resolvedActionCount, 0);
  assert.equal(summary.actionProgress.total, 2);
});

test("buildImportIntelligenceView rozdziela źródła PIT od NBP i kontekstu", () => {
  const view = buildImportIntelligenceView({
    auditAppendix: auditAppendixFixture(),
    ollamaStatus: {
      available: true,
      serverRunning: true,
      baseUrl: "http://127.0.0.1:11434",
      model: "qwen2.5:7b",
      modelAvailable: true,
      models: [{ name: "qwen2.5:7b" }],
      exePath: "C:\\Users\\TestUser\\AppData\\Local\\Programs\\OllamaCLI\\ollama.exe",
      exeExists: true,
      canAutoStart: true,
      gpuConfirmed: true,
      computeBackend: "gpu",
      gpuBackend: "vulkan",
      gpuProbeStatus: "pass",
      logEvidence: ["inference compute id=gpu library=vulkan"],
    },
    language: "pl",
  });

  const nbp = view.sources.find((source) => source.filename === "archiwum_tab_a_2025.csv");
  const tax = view.sources.find((source) => source.filename === "broker_report_2025.json");

  assert.equal(view.summary.transactionSourceCount, 1);
  assert.equal(view.summary.nbpSourceCount, 1);
  assert.equal(view.attention.dossierReviewCount, 2);
  assert.equal(view.attention.conflictCount, 1);
  assert.equal(view.aiRunStatus.runtimeOnline, true);
  assert.equal(view.aiRunStatus.lastRunLabel, "AI zostanie użyta przy następnym przebiegu");
  assert.equal(nbp?.roleLabel, "kursy NBP");
  assert.equal(nbp?.inputImpactLabel, "kursy NBP");
  assert.equal(nbp?.inputStatusLabel, "kontekst danych");
  assert.equal(tax?.roleLabel, "źródło transakcji");
  assert.equal(tax?.aiStatusLabel, "nie użyto w tym przebiegu");
});

test("buildBrokerFileIntakeSummary pokazuje status reconciliation per źródło", () => {
  const summary = buildBrokerFileIntakeSummary(auditAppendixFixture(), [], []);
  const taxSource = summary.sourceRows.find((source) => source.sourceId === "source:tax-json");
  const evidenceSource = summary.sourceRows.find((source) => source.sourceId === "source:evidence-pdf");

  assert.equal(summary.sourceReconciliation?.summary.confidenceScore, 50);
  assert.equal(summary.sourceReconciliationBreakdownLabel, "Odsetki/prowizje salda ujemnego: 1");
  assert.equal(taxSource?.reconciliationStatus, "matched");
  assert.equal(taxSource?.reconciliationMessage, "Główne źródło PIT.");
  assert.equal(taxSource?.confidenceScore, 100);
  assert.equal(evidenceSource?.reconciliationStatus, "needs_review");
  assert.equal(evidenceSource?.reconciliationBreakdownLabel, "Odsetki/prowizje salda ujemnego: 1");
  assert.equal(evidenceSource?.hasProblems, true);
});

test("buildBrokerFileIntakeSummary pokazuje role resolvera świeżych plików storage", () => {
  const appendix: TaxFilingPackageAuditAppendix = {
    source_manifest_v2: [
      {
        sourceId: "storage:broker_report_json:abc",
        filename: "broker_raport_bezbliansu.json",
        relativePath: "Dane/broker_raport_bezbliansu.json",
        detectedType: "broker_report_json",
        contributesToTax: true,
        sourceResolutionRole: "primary_tax",
        sourceResolutionReason: "Najlepszy raport brokerski.",
        sourceResolutionScore: 1810,
        recordCounts: { trade_like_rows: 301, cash_flows: 55, commissions: 394 },
      },
      {
        sourceId: "storage:depositary_report_json:def",
        filename: "dezpozytariusz_raport_zbilansem.json",
        detectedType: "depositary_report_json",
        contributesToTax: false,
        sourceResolutionRole: "reconciliation",
        sourceResolutionReason: "Raport kontroli pozycji.",
      },
      {
        sourceId: "storage:fee_schedule_pdf:ghi",
        filename: "Stawki.pdf",
        detectedType: "fee_schedule_pdf",
        contributesToTax: false,
        sourceResolutionRole: "evidence",
      },
      {
        sourceId: "storage:broker_report_json:jkl",
        filename: "broker_raport_zbliansem.json",
        detectedType: "broker_report_json",
        contributesToTax: false,
        sourceResolutionRole: "fallback",
      },
    ],
    source_resolution_report: {
      selected: {
        primaryTax: "storage:broker_report_json:abc",
        reconciliation: "storage:depositary_report_json:def",
      },
    },
  };

  const summary = buildBrokerFileIntakeSummary(appendix, [], []);
  const byFilename = new Map(summary.sourceRows.map((source) => [source.filename, source]));

  assert.equal(byFilename.get("broker_raport_bezbliansu.json")?.roleLabel, "Źródło transakcyjne");
  assert.equal(byFilename.get("broker_raport_bezbliansu.json")?.pathLabel, "Dane/broker_raport_bezbliansu.json");
  assert.equal(byFilename.get("dezpozytariusz_raport_zbilansem.json")?.roleLabel, "Kontrola pozycji");
  assert.equal(byFilename.get("Stawki.pdf")?.roleLabel, "Dowód źródłowy");
  assert.equal(byFilename.get("broker_raport_zbliansem.json")?.roleLabel, "Pominięty fallback");
  assert.equal(summary.sourceMap.candidateCount, 0);
  assert.equal(summary.sourceMap.reconciliationCount, 1);

  const storageState = getStorageFileDisplayState(
    ["broker_raport_bezbliansu.json", "dezpozytariusz_raport_zbilansem.json", "Stawki.pdf"],
    [],
    summary.sourceRows,
  );
  assert.equal(storageState[0].auditRoleLabel, "Źródło transakcyjne");
  assert.equal(storageState[1].auditRoleLabel, "Kontrola pozycji");
  assert.equal(storageState[2].auditRoleLabel, "Dowód źródłowy");
});

test("buildBrokerFileIntakeSummary korzysta z auto_file_recognition_report jako pełnego inwentarza źródeł", () => {
  const appendix: TaxFilingPackageAuditAppendix = {
    auto_file_recognition_report: {
      summary: {
        recognizedSourceCount: 4,
        transactionSourceCount: 1,
        transactionReportCount: 1,
        evidenceSourceCount: 1,
        analyticsSourceCount: 1,
      },
      sources: [
        {
          sourceId: "auto:history",
          filename: "historia_transakcji.json",
          detectedType: "legacy_broker_history_json",
          fileRole: "primary_tax",
          contributesToTax: true,
          recordCounts: { rows: 207 },
        },
        {
          sourceId: "auto:broker-candidate",
          filename: "broker_raport_bezbliansu.json",
          detectedType: "broker_report_json",
          fileRole: "candidate_tax",
          contributesToTax: false,
          recordCounts: { trades: 301 },
        },
        {
          sourceId: "auto:traders",
          filename: "Traderzy.xlsx",
          detectedType: "traders_xlsx",
          fileRole: "analytics",
          contributesToTax: false,
        },
        {
          sourceId: "auto:fees",
          filename: "Stawki.pdf",
          detectedType: "fee_schedule_pdf",
          fileRole: "evidence",
          contributesToTax: false,
        },
      ],
    },
  };

  const summary = buildBrokerFileIntakeSummary(appendix, [], []);
  const byFilename = new Map(summary.sourceRows.map((source) => [source.filename, source]));

  assert.equal(summary.totalSources, 4);
  assert.equal(byFilename.get("historia_transakcji.json")?.roleLabel, "Źródło transakcyjne");
  assert.equal(byFilename.get("broker_raport_bezbliansu.json")?.roleLabel, "Raport transakcyjny");
  assert.equal(byFilename.get("Traderzy.xlsx")?.roleLabel, "Analityka / dowód");
  assert.equal(byFilename.get("Stawki.pdf")?.roleLabel, "Dowód źródłowy");
  assert.equal(summary.sourceMap.activeTaxCount, 1);
  assert.equal(summary.sourceMap.candidateCount, 1);
  assert.equal(summary.sourceMap.evidenceCount, 2);
});

test("buildBrokerFileIntakeSummary deduplikuje ten sam plik z resolvera i parsera baseline", () => {
  const appendix: TaxFilingPackageAuditAppendix = {
    source_manifest_v2: [
      {
        sourceId: "parser:history",
        filename: "historia_transakcji.json",
        detectedType: "local_broker_report_json",
        contributesToTax: true,
        recordCounts: { rows: 207 },
      },
    ],
    source_resolution_preview: {
      sources: [
        {
          sourceId: "resolver:history",
          filename: "historia_transakcji.json",
          relativePath: "historia_transakcji.json",
          detectedType: "legacy_broker_history_json",
          role: "baseline_tax",
          score: 80,
          reason: "Stabilny plik historii transakcji.",
          recordCounts: { rows: 207 },
        },
      ],
    },
  };

  const summary = buildBrokerFileIntakeSummary(appendix, [], []);

  assert.equal(summary.sourceRows.filter((source) => source.filename === "historia_transakcji.json").length, 1);
  assert.equal(summary.sourceRows[0].role, "baseline_tax");
  assert.equal(summary.sourceRows[0].roleLabel, "Źródło transakcyjne");
});

test("buildBrokerFileIntakeSummary używa preview safe resolvera bez oznaczania kandydata jako aktywnego PIT", () => {
  const appendix: TaxFilingPackageAuditAppendix = {
    source_resolution_preview: {
      mode: "legacy_locked",
      activePolicy: "legacy_locked",
      sources: [
        {
          sourceId: "storage:legacy",
          filename: "historia_transakcji.json",
          relativePath: "historia_transakcji.json",
          detectedType: "legacy_broker_history_json",
          role: "baseline_tax",
          score: 80,
          reason: "Stabilny plik historii transakcji.",
          recordCounts: { rows: 226 },
        },
        {
          sourceId: "storage:candidate",
          filename: "broker_raport_bezbliansu.json",
          relativePath: "broker_raport_bezbliansu.json",
          detectedType: "broker_report_json",
          role: "candidate_tax",
          score: 132,
          reason: "Nowy raport brokera wykryty jako kandydat.",
          recordCounts: { trades: 301 },
        },
        {
          sourceId: "storage:traders",
          filename: "Traderzy.xlsx",
          detectedType: "traders_xlsx",
          role: "analytics",
          score: 25,
          reason: "Plik podsumowujący brokera.",
        },
      ],
    },
    candidate_source_runs: [
      {
        source_id: "storage:candidate",
        filename: "broker_raport_bezbliansu.json",
        detected_type: "broker_report_json",
        status: "candidate_ready",
        reason: "Kandydat ma rozpoznane wiersze transakcji do kontroli safe-switch.",
        trade_row_count: 301,
        buy_count: 200,
        sell_count: 0,
      },
    ],
  };

  const summary = buildBrokerFileIntakeSummary(appendix, [], []);
  const byFilename = new Map(summary.sourceRows.map((source) => [source.filename, source]));

  assert.equal(byFilename.get("historia_transakcji.json")?.roleLabel, "Źródło transakcyjne");
  assert.equal(byFilename.get("broker_raport_bezbliansu.json")?.roleLabel, "Raport transakcyjny");
  assert.equal(byFilename.get("Traderzy.xlsx")?.roleLabel, "Analityka / dowód");
  assert.equal(summary.taxSources, 1);
  assert.equal(summary.actionRows.length, 0);
  assert.equal(summary.recommendedAction.includes("Wgraj pliki"), true);
  assert.equal(summary.sourceMap.activeTaxCount, 1);
  assert.equal(summary.sourceMap.candidateCount, 1);
});

test("buildBrokerFileIntakeSummary nakłada lokalne statusy akcji bez liczenia podatku", () => {
  const summary = buildBrokerFileIntakeSummary(auditAppendixFixture(), [], [], [
    {
      actionId: "BFAQ-cost-fx-loss-1",
      status: "ignored",
      userNote: "Koszt sprawdzony ręcznie, dowód zostaje poza aplikacją.",
      linkedRowId: "FX-LOSS-1",
      updatedAt: "2026-05-12T12:00:00.000Z",
    },
  ]);

  const ignored = summary.actionRows.find((row) => row.actionId === "BFAQ-cost-fx-loss-1");
  assert.ok(ignored);
  assert.equal(ignored.status, "ignored");
  assert.equal(ignored.statusLabel, "Zignorowane");
  assert.equal(ignored.userNote, "Koszt sprawdzony ręcznie, dowód zostaje poza aplikacją.");
  assert.equal(summary.ignoredActionCount, 1);
  assert.equal(summary.openActionCount, 1);
});

test("buildBrokerActionWorkbench buduje wspólny model dla importu, raportu i historii", () => {
  const workbench = buildBrokerActionWorkbench(auditAppendixFixture(), [
    {
      actionId: "BFAQ-cost-fx-loss-1",
      status: "ignored",
      userNote: "Koszt zostaje sprawdzony poza aplikacją.",
      linkedRowId: "FX-LOSS-1",
      updatedAt: "2026-05-12T12:00:00.000Z",
    },
  ]);

  assert.equal(workbench.total, 2);
  assert.equal(workbench.open, 1);
  assert.equal(workbench.ignored, 1);
  assert.equal(workbench.resolved, 0);
  assert.equal(workbench.warningOpen, 1);
  assert.equal(workbench.blockingOpen, 0);
  assert.equal(workbench.recommendedItem?.actionId, "BFAQ-coverage-fx");
  assert.equal(workbench.groups.warning.length, 1);
  assert.equal(workbench.groups.warning[0].supplementalOnlyBreakdownLabel, "Odsetki/prowizje salda ujemnego: 1");
  assert.equal(workbench.groups.ignored.length, 1);
  assert.equal(workbench.groups.ignored[0].userNote, "Koszt zostaje sprawdzony poza aplikacją.");
  assert.equal(workbench.groups.ignored[0].linkedRowId, "FX-LOSS-1");
});

test("brokerFileActionOverrides zapisuje statusy przez adapter storage", () => {
  const storage = createMemoryStorageSource();
  saveBrokerFileActionOverrides(storage, [
    {
      actionId: "BFAQ-cost-fx-loss-1",
      status: "resolved",
      userNote: "Dowód opisany w dokumentacji.",
      linkedRowId: "FX-LOSS-1",
      updatedAt: "2026-05-12T12:30:00.000Z",
    },
  ]);

  const loaded = readBrokerFileActionOverrides(storage);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].actionId, "BFAQ-cost-fx-loss-1");
  assert.equal(loaded[0].status, "resolved");
  assert.equal(loaded[0].linkedRowId, "FX-LOSS-1");
});

test("ImportData pokazuje neutralny plikowy control tower importu", () => {
  const markup = renderToStaticMarkup(
    <ImportData
      onImportComplete={() => undefined}
      auditAppendix={auditAppendixFixture()}
      files={[]}
      processedStorageFiles={["broker_report_2025.json"]}
      brokerFileActionOverrides={[]}
      uiComplexityMode="expert"
    />,
  );

  assert.equal(markup.includes("Kontrola plików brokera"), false);
  assert.equal(markup.includes("Samocheck źródeł"), false);
  assert.equal(markup.includes("Aktywne źródła PIT"), false);
  assert.equal(markup.includes('data-motion="import-summary"'), false);
  assert.equal(markup.includes('data-motion="import-source-card"'), false);
  assert.equal(markup.includes('data-motion="import-dropzone"'), true);
  assert.equal(markup.includes("Mapa źródeł"), true);
  assert.equal(markup.includes("Źródła danych przyjęte do canonical_tax_input"), true);
  assert.equal(markup.includes("Każdy plik przyjęty przez warstwę rozpoznania"), false);
  assert.equal(markup.includes("Klasyfikacje AI: 2"), false);
  assert.equal(markup.includes("Mapowania kolumn: 1"), false);
  assert.equal(markup.includes("AI zmienia PIT: nie"), false);
  assert.equal(markup.includes("Kanoniczny input PIT"), false);
  assert.equal(markup.includes("PIT rows: 128"), false);
  assert.equal(markup.includes("engine active: 117"), false);
  assert.equal(markup.includes("support: 54"), false);
  assert.equal(markup.includes("AI: wyłączona w przebiegu"), true);
  assert.equal(markup.includes("Karty: 2"), true);
  assert.equal(markup.includes("Wymaga kontroli źródeł"), false);
  assert.equal(markup.includes("Kontrola zgodności źródeł"), false);
  assert.equal(markup.includes("Pewność zgodności"), false);
  assert.equal(markup.includes("Zbiorczo tylko pomocnicze: Odsetki/prowizje salda ujemnego: 1"), false);
  assert.equal(markup.includes("Plik dowodowy wymaga ręcznej kontroli."), false);
  assert.equal(markup.includes("Odsetki/prowizje salda ujemnego: 1"), false);
  assert.equal(markup.includes("Źródła plików brokera"), false);
  assert.equal(markup.includes("Co zrobić teraz"), false);
  assert.equal(markup.includes("3 źródła"), false);
  assert.equal(markup.includes("1 transakcje PIT"), false);
  assert.equal(markup.includes("broker_report_2025.json"), true);
  assert.equal(markup.includes("Liczy PIT"), false);
  assert.equal(markup.includes("potwierdzenie_przelewu.pdf"), true);
  assert.equal(markup.includes("Z problemami"), false);
  assert.equal(markup.includes("Potencjalna strata FX"), false);
  assert.equal(markup.includes("Przewalutowania i różnice FX"), false);
  assert.equal(markup.includes("Dodaj dowód przewalutowania."), false);
  assert.equal(markup.includes("Kolejka akcji importu"), false);
  assert.equal(markup.includes("Otwarte"), false);
  assert.equal(markup.includes("Oznacz jako rozwiązane"), false);
  assert.equal(markup.includes("Notatka wymagana przy ignorowaniu sprawy"), false);
  assert.equal(markup.includes("Zapisz jako zignorowane"), false);
  assert.equal(markup.includes("Panel szczegółów"), false);
  assert.equal(markup.includes("Szczegóły źródła"), false);
  assert.equal(markup.includes("Powiązane akcje"), false);
  assert.equal(markup.includes("Import z rozpoznaniem AI i mapą źródeł"), true);
  assert.equal(markup.includes("Transaction Intelligence Layer"), true);
  assert.equal(markup.includes("Kliknij albo przeciągnij wiele plików tutaj"), true);
  assert.equal(markup.includes("Ollama AI Normalizer"), true);
  assert.equal(markup.includes("Centrum Weryfikacji Danych"), true);
  assert.equal(markup.includes("Health Score"), true);
  assert.equal(markup.includes("Gotowe rekordy"), true);
  assert.equal(markup.includes("Niepełne rekordy"), true);
  assert.equal(markup.includes("Informacyjne"), true);
  assert.equal(markup.includes("Nierozpoznane rekordy"), true);
  assert.equal(markup.includes("missing_quantity"), true);
  assert.equal(markup.includes("AAPL.US"), true);
  assert.equal(markup.includes("Konsola Ollama"), true);
  assert.equal(markup.includes("Plik z Freedom24"), false);
  assert.equal(markup.includes("Freedom24"), false);
});

test("ImportData w trybie prostym pokazuje skrót bez technicznych tabel", () => {
  const markup = renderToStaticMarkup(
    <ImportData
      onImportComplete={() => undefined}
      auditAppendix={auditAppendixFixture()}
      files={[]}
      processedStorageFiles={["broker_report_2025.json"]}
      brokerFileActionOverrides={[]}
    />,
  );

  assert.equal(markup.includes("Aktywne źródła PIT"), false);
  assert.equal(markup.includes("Pełny inwentarz"), false);
  assert.equal(markup.includes("Źródła transakcji PIT:"), false);
  assert.equal(markup.includes("Karty do kontroli: 2"), true);
  assert.equal(markup.includes("Braki NBP: 0"), true);
  assert.equal(markup.includes("AI do sprawdzenia: 0"), true);
  assert.equal(markup.includes("Kanoniczny input PIT"), false);
  assert.equal(markup.includes("Kontrakt silnika: canonical_tax_input.json"), false);
  assert.equal(markup.includes("PIT rows: 128"), false);
  assert.equal(markup.includes("engine active: 117"), false);
  assert.equal(markup.includes("Historia: 1"), false);
  assert.equal(markup.includes("Surowe: 1847"), false);
  assert.equal(markup.includes("Po deduplikacji: 884"), false);
  assert.equal(markup.includes("Dowody, NBP i kandydaci nie zmieniają PIT bez decyzji."), false);
  assert.equal(markup.includes("Mapa źródeł"), true);
  assert.equal(markup.includes("Źródła danych przyjęte do canonical_tax_input"), true);
  assert.equal(markup.includes("Klasyfikacje AI: 2"), false);
  assert.equal(markup.includes("Karty: 2"), true);
  assert.equal(markup.includes("Pliki dowodowe"), false);
  assert.equal(markup.includes("Samocheck źródeł"), false);
  assert.equal(markup.includes("Co zrobić teraz"), false);
  assert.equal(markup.includes("Panel szczegółów"), false);
  assert.equal(markup.includes("Kontrola plików brokera"), false);
  assert.equal(markup.includes("Braki / częściowe"), false);
  assert.equal(markup.includes("Konflikty"), true);
  assert.equal(markup.includes("Źródła plików brokera"), false);
  assert.equal(markup.includes("Kolejka akcji importu"), false);
  assert.equal(markup.includes("Macierz kompletności danych"), false);
  assert.equal(markup.includes("Promocja źródła PIT"), false);
  assert.equal(markup.includes("Kontrola zgodności źródeł"), false);
  assert.equal(markup.includes("Wymagane kolumny w pliku"), false);
  assert.equal(markup.includes("Pliki lokalne w storage"), false);
  assert.equal(markup.includes("Importuj do bazy"), false);
  assert.equal(markup.includes("Centrum Weryfikacji Danych"), true);
  assert.equal(markup.includes("Adapter obliczeń otrzyma jeden strumień danych"), true);
  assert.equal(markup.includes(["tax", "active", "events"].join("_")), false);
});

test("getStorageFileDisplayState oznacza pliki przetworzone i nowe", () => {
  const state = getStorageFileDisplayState(
    ["Dane/broker_report_2025.json", "Stawki.pdf", "cash_flow_2025.xlsx"],
    ["Dane/broker_report_2025.json"],
    [
      {
        sourceId: "source:tax-json",
        filename: "broker_report_2025.json",
        pathLabel: "Dane/broker_report_2025.json",
        detectedType: "broker_report",
        role: "tax",
        roleLabel: "Liczy PIT",
        hashShort: "abcdef123456",
        dateRangeLabel: "2025-01-01 - 2025-12-31",
        recordCountLabel: "128 rekordów",
        sectionsLabel: "trades",
        warningCount: 0,
        errorCount: 0,
        hasProblems: false,
      },
      {
        sourceId: "source:fee-pdf",
        filename: "Stawki.pdf",
        pathLabel: "Stawki.pdf",
        detectedType: "fee_schedule_pdf",
        role: "evidence",
        roleLabel: "Tylko dowód",
        hashShort: "fee123",
        dateRangeLabel: "brak zakresu",
        recordCountLabel: "0 rekordów",
        sectionsLabel: "dowód",
        warningCount: 0,
        errorCount: 0,
        hasProblems: false,
      },
    ],
  );

  assert.equal(state[0].filename, "Dane/broker_report_2025.json");
  assert.equal(state[0].processed, true);
  assert.equal(state[0].statusLabel, "Przetworzony");
  assert.equal(state[0].auditRoleLabel, "Liczy PIT");
  assert.equal(state[0].canImportToLocalBase, true);
  assert.equal(state[1].filename, "Stawki.pdf");
  assert.equal(state[1].auditRoleLabel, "Tylko dowód");
  assert.equal(state[1].canImportToLocalBase, false);
  assert.equal(state[1].nonImportableReason, "Plik jest dowodem audytowym i nie tworzy transakcji w lokalnej bazie.");
  assert.equal(state[2].filename, "cash_flow_2025.xlsx");
  assert.equal(state[2].processed, false);
  assert.equal(state[2].statusLabel, "Nowy plik");
  assert.equal(state[2].auditRoleLabel, "Wymaga ponownego przebiegu");
  assert.equal(state[2].canImportToLocalBase, true);
});

test("getStorageFileDisplayState blokuje raport depozytariusza przed przeliczeniem audytu", () => {
  const state = getStorageFileDisplayState(
    ["Dane/dezpozytariusz_raport_zbilansem.json"],
    [],
    [],
  );

  assert.equal(state[0].canImportToLocalBase, false);
  assert.equal(state[0].nonImportableReason?.includes("kontroli pozycji"), true);
});

test("getStorageFileDisplayState normalizuje wielkość liter i separatory ścieżek storage", () => {
  const state = getStorageFileDisplayState(
    ["Dane/BROKER_REPORT_2025.JSON"],
    ["dane\\broker_report_2025.json"],
    [{
      sourceId: "source:broker",
      filename: "broker_report_2025.json",
      pathLabel: "dane\\broker_report_2025.json",
      detectedType: "broker_report_json",
      role: "primary_tax",
      roleLabel: "Główne źródło PIT",
      hashShort: "abc123",
      dateRangeLabel: "2025-01-01 - 2025-12-31",
      recordCountLabel: "128 rekordów",
      sectionsLabel: "trades",
      warningCount: 0,
      errorCount: 0,
      hasProblems: false,
    }],
  );

  assert.equal(state[0].processed, true);
  assert.equal(state[0].auditRoleLabel, "Główne źródło PIT");
});

test("getStorageFileDisplayState dopasowuje źródło z audytu po nazwie bazowej pliku", () => {
  const state = getStorageFileDisplayState(
    ["Dane/broker_report_2025.json"],
    [],
    [{
      sourceId: "source:broker",
      filename: "broker_report_2025.json",
      pathLabel: "broker_report_2025.json",
      detectedType: "broker_report_json",
      role: "primary_tax",
      roleLabel: "Główne źródło PIT",
      hashShort: "abc123",
      dateRangeLabel: "2025-01-01 - 2025-12-31",
      recordCountLabel: "128 rekordów",
      sectionsLabel: "trades",
      warningCount: 0,
      errorCount: 0,
      hasProblems: false,
    }],
  );

  assert.equal(state[0].auditRoleLabel, "Główne źródło PIT");
  assert.equal(state[0].requiresEngineRun, false);
});

test("getStorageFileDisplayState nie zgaduje roli po niejednoznacznej nazwie bazowej", () => {
  const state = getStorageFileDisplayState(
    ["Dane/broker_report_2025.json"],
    [],
    [
      {
        sourceId: "source:primary",
        filename: "broker_report_2025.json",
        pathLabel: "Archive/broker_report_2025.json",
        detectedType: "broker_report_json",
        role: "duplicate",
        roleLabel: "Pominięty duplikat",
        hashShort: "dup123",
        dateRangeLabel: "2025-01-01 - 2025-12-31",
        recordCountLabel: "128 rekordów",
        sectionsLabel: "trades",
        warningCount: 0,
        errorCount: 0,
        hasProblems: false,
      },
      {
        sourceId: "source:fallback",
        filename: "broker_report_2025.json",
        pathLabel: "Fallback/broker_report_2025.json",
        detectedType: "broker_report_json",
        role: "fallback",
        roleLabel: "Fallback",
        hashShort: "fb123",
        dateRangeLabel: "2025-01-01 - 2025-12-31",
        recordCountLabel: "128 rekordów",
        sectionsLabel: "trades",
        warningCount: 0,
        errorCount: 0,
        hasProblems: false,
      },
    ],
  );

  assert.equal(state[0].auditRoleLabel, "Wymaga ponownego przebiegu");
  assert.equal(state[0].requiresEngineRun, true);
});

test("getStorageFileDisplayState dopasowuje przetworzony plik po nazwie bazowej", () => {
  const state = getStorageFileDisplayState(
    ["Dane/broker_report_2025.json"],
    ["broker_report_2025.json"],
    [],
  );

  assert.equal(state[0].processed, true);
  assert.equal(state[0].statusLabel, "Przetworzony");
});

test("getStorageFileDisplayState nie oznacza wielu plików jako przetworzonych po niejednoznacznej nazwie bazowej", () => {
  const state = getStorageFileDisplayState(
    ["Dane/broker_report_2025.json", "Archive/broker_report_2025.json"],
    ["broker_report_2025.json"],
    [],
  );

  assert.equal(state[0].processed, false);
  assert.equal(state[0].statusLabel, "Nowy plik");
  assert.equal(state[1].processed, false);
  assert.equal(state[1].statusLabel, "Nowy plik");
});
