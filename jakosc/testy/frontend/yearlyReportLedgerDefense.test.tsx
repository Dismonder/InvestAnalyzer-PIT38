import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { YearlyReport } from "../../../aplikacje/web/src/invest_analyzer/components/YearlyReport.tsx";
import type { TaxEngineResponse } from "../../../aplikacje/web/src/invest_analyzer/hooks/useTaxEngineRun.ts";

function renderYearlyReport(
  engineResult: TaxEngineResponse,
  extraProps: Partial<React.ComponentProps<typeof YearlyReport>> = {},
) {
  const previousLocalStorage = (globalThis as typeof globalThis & { localStorage?: unknown }).localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      clear: () => undefined,
      getItem: () => null,
      key: () => null,
      removeItem: () => undefined,
      setItem: () => undefined,
      length: 0,
    },
  });

  try {
    return renderToStaticMarkup(
      <YearlyReport
        selectedYear={2025}
        engineLoading={false}
        packageLoading={false}
        engineResult={engineResult}
        runPythonEngine={async () => engineResult}
        reportOrganizationStatus={{ year: 2025, status: "draft", updatedAt: "2026-05-11T10:00:00.000Z" }}
        onReportOrganizationStatusChange={() => undefined}
        uiComplexityMode="expert"
        {...extraProps}
      />,
    );
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
}

test("YearlyReport pokazuje stawke PIT jako procent, nie jako walute", () => {
  const engineResult = {
    success: true,
    status: "SUCCESS",
    filing_ready: true,
    annual_summary: { tax_year: "2025", net_pln: "0" },
    tax_filing_package: {
      draft: {
        form_fields: [
          { section: "D", position: "32", label: "Stawka podatku", value: "19%", value_type: "percent" },
        ],
      },
    },
  } as TaxEngineResponse;

  const markup = renderYearlyReport(engineResult);

  assert.equal(markup.includes("19%"), true);
  assert.equal(markup.includes("Raport policzony. Brak otwartych kontroli podatkowych."), true);
  assert.equal(markup.includes("To nie zmienia kwoty automatycznie"), true);
  assert.equal(markup.includes("NaN\u00a0zł"), false);
  assert.equal(markup.includes("NaN zł"), false);
});

test("YearlyReport w trybie prostym pokazuje tylko kokpit bez sekcji audytowych", () => {
  const engineResult = {
    success: true,
    status: "SUCCESS",
    filing_ready: true,
    plan_used: "aggressive_user",
    annual_summary: {
      tax_year: "2025",
      pit38_rounded_revenue_pln: "233502",
      pit38_rounded_cost_pln: "231968",
      net_pln: "291.35",
    },
    scenario_results: {
      aggressive_user: {
        scenario_name: "aggressive_user",
        risk_level: "high",
        gross_result_pln: "1533.43",
        taxable_base_pln: "1533.43",
        tax_19_pln: "291.35",
        taxes_from_dane_pln: "0.00",
        net_pln: "291.35",
        total_revenue_pln: "233501.85",
        total_cost_pln: "231968.42",
        delta_vs_defensible_pln: "0.00",
        additional_costs: [],
        notes: [],
      },
    },
    tax_filing_package: {
      draft: {
        form_fields: [
          { section: "D", position: "31", label: "Podstawa opodatkowania", value: "1533" },
          { section: "G", position: "51", label: "Kwota do zapłaty", value: "291" },
        ],
      },
      calculation: {
        sections: [
          {
            title: "Jak policzono podatek",
            values: { revenue_pln: "233501.85", cost_pln: "231968.42" },
          },
        ],
      },
      audit_appendix: {
        pit_case_file: {
          case_file_id: "pit-case:2025:test",
          generated_at: "2026-05-11T10:00:00.000Z",
          tax_year: "2025",
          plan_used: "aggressive_user",
          reproducible: true,
          reproducibility_status: "complete",
          input_fingerprint: "input-test",
          calculation_fingerprint: "calc-test",
        },
        canonical_storage_history_rows: [{ row_id: "storage-row-1", parent_row_id: null, row_kind: "TRADE" }],
        canonical_storage_history_summary: {
          rawRowCount: 1847,
          deduplicatedRowCount: 884,
          mergedRecordCount: 963,
        },
        pit_submission_readiness: {
          verdict: "READY_WITH_RISK",
          score: 82,
          recommendedAction: null,
          checklist: [],
          generatedAt: "2026-05-11T10:00:00.000Z",
        },
        source_trust_summary: {
          summary: {
            source_count: 4,
            transaction_source_count: 1,
            report_source_count: 1,
            status_counts: { transaction_source: 1, transaction_report: 1, source_evidence: 1, nbp_rates: 1 },
          },
          items: [
            {
              source_id: "src:baseline",
              file_name: "historia_transakcji.json",
              file_hash: "hash-baseline",
              file_type: "json",
              detected_role: "transaction_history",
              usage_status: "transaction_source",
              quality: { parse_ok: true, confidence: "high" },
            },
            {
              source_id: "src:candidate",
              file_name: "broker_raport_bezbliansu.json",
              file_hash: "hash-candidate",
              file_type: "json",
              detected_role: "broker_report",
              usage_status: "transaction_report",
              quality: { parse_ok: true, confidence: "medium" },
              warnings: ["Wymaga kontroli przed promocją."],
            },
            {
              source_id: "src:evidence",
              file_name: "Stawki.pdf",
              file_hash: "hash-pdf",
              file_type: "pdf",
              detected_role: "evidence_document",
              usage_status: "source_evidence",
              quality: { parse_ok: true, confidence: "medium" },
            },
            {
              source_id: "src:nbp",
              file_name: "archiwum_tab_a_2025.csv",
              file_hash: "hash-nbp",
              file_type: "csv",
              detected_role: "nbp_rates",
              usage_status: "nbp_rates",
              quality: { parse_ok: true, confidence: "high" },
            },
          ],
        },
        no_overpay_audit_v3: {
          summary: {
            counted_total_pln: "12.34",
            candidate_total_pln: "56.78",
            requires_evidence_total_pln: "9.10",
            duplicate_risk_total_pln: "0",
            excluded_total_pln: "1.23",
          },
          sections: [
            {
              section_id: "fx_spread",
              title_pl: "FX",
              items: [
                { item_id: "fx-1", decision: "counted", amount_pln: "12.34" },
                { item_id: "fx-2", decision: "candidate", amount_pln: "56.78" },
                { item_id: "fx-3", decision: "requires_evidence", amount_pln: "9.10" },
              ],
            },
          ],
        },
        defense_vault_summary: {
          items: [
            {
              evidence_id: "ev:fx",
              title: "Potwierdzenie przewalutowania",
              status: "to_collect",
              linked_record_ids: ["FX-1"],
              linked_source_ids: ["src:baseline"],
              linked_no_overpay_item_ids: ["fx-3"],
            },
          ],
          summary: { available: 1, to_collect: 1, advisor_review: 0 },
        },
      },
    },
  } as TaxEngineResponse;

  const markup = renderYearlyReport(engineResult, {
    uiComplexityMode: "simple",
    onOpenStorageHistory: () => undefined,
  });

  assert.equal(markup.includes("Podatek PIT do zapłaty"), true);
  assert.equal(markup.includes("Netto scenariusza"), true);
  assert.equal(markup.includes("291,35"), true);
  assert.equal(markup.includes("291 zł"), true);
  assert.equal(markup.includes("Do zapłaty"), false);
  assert.equal(markup.includes("Przychód"), true);
  assert.equal(markup.includes("Koszty"), true);
  assert.equal(markup.includes("Podstawa opodatkowania"), true);
  assert.equal(markup.includes("Zachowaj dowody"), true);
  assert.equal(markup.includes("Jak policzono"), true);
  assert.equal(markup.includes("Czy dane są czytane poprawnie?"), true);
  assert.equal(markup.includes("Historia"), true);
  assert.equal(markup.includes("Surowe"), true);
  assert.equal(markup.includes("1847"), true);
  assert.equal(markup.includes("Po deduplikacji"), true);
  assert.equal(markup.includes("884"), true);
  assert.equal(markup.includes("Co może obniżyć podatek"), true);
  assert.equal(markup.includes("Sejf dowodowy"), true);
  assert.equal(markup.includes("Potwierdzenie przewalutowania"), true);
  assert.equal(markup.includes('data-motion="no-overpay-defense-card"'), true);
  assert.equal(markup.includes("Wynik"), true);
  assert.equal(markup.includes("Źródła danych"), true);
  assert.equal(markup.includes("Pokaż jak policzono"), false);
  assert.equal(markup.includes("Generuj i pobierz pakiet podatkowy"), false);
  assert.equal(markup.includes('data-motion="bank-report-shell"'), true);
  assert.equal(markup.includes('data-motion="bank-primary-card"'), true);
  assert.equal(markup.includes('data-motion="bank-secondary-card"'), true);
  assert.equal(markup.includes('data-motion="bank-metric-card"'), true);
  assert.equal(markup.includes('data-motion="bank-step-card"'), true);
  assert.equal(markup.includes('data-motion="result-trust-card"'), true);
  assert.equal(markup.includes('data-step-id="result"'), true);
  assert.equal(markup.includes('data-step-id="sources"'), true);
  assert.equal(markup.includes('data-step-id="evidence"'), true);
  assert.equal(markup.includes('data-step-id="package"'), true);
  assert.equal(markup.includes("Raport jako jedna ścieżka pracy"), false);
  assert.equal(markup.includes("Status raportu"), false);
  assert.equal(markup.includes("Rozliczenie kwoty podatku"), false);
  assert.equal(markup.includes("Status organizacyjny raportu"), false);
  assert.equal(markup.includes("Kontrola przed złożeniem PIT"), false);
  assert.equal(markup.includes("Odtwarzalność raportu"), false);
  assert.equal(markup.includes("Zamknięcie roku PIT"), false);
  assert.equal(markup.includes("Autorytatywny wynik silnika Python"), false);
  assert.equal(markup.includes("Scenariusze podatkowe"), false);
  assert.equal(markup.includes("Ledger kalkulacji podatku"), false);
  assert.equal(markup.includes("Artefakty audytowe"), false);
});

test("karta do zapłaty i podstawa przepisują poz. 51 i 31, netto zachowuje definicję scenariusza", () => {
  const markup = renderYearlyReport({
    success: true,
    status: "SUCCESS",
    filing_ready: true,
    primary_scenario: "defensible",
    annual_summary: { tax_year: "2025", net_pln: "70482.57" },
    scenario_results: { defensible: {
      scenario_name: "defensible", taxable_base_pln: "87015.66", tax_19_pln: "16532.98",
      net_pln: "70482.57", total_revenue_pln: "11170937.84", total_cost_pln: "11083922.18",
      risk_level: "medium", gross_result_pln: "87015.66", taxes_from_dane_pln: "0.11",
      delta_vs_defensible_pln: "0.00", additional_costs: [], notes: [],
    } },
    tax_filing_package: { draft: { form_fields: [
      { section: "D", position: "31", label: "Podstawa", value: "87016" },
      { section: "G", position: "51", label: "Do zapłaty", value: "16533" },
    ] } },
  } as TaxEngineResponse, { uiComplexityMode: "simple" });
  assert.match(markup, /16[\s\u00a0]?533 zł/);
  assert.match(markup, /87[\s\u00a0]?016 zł/);
  assert.match(markup, /70[\s\u00a0]?482,57/);
  assert.ok(!markup.includes('16\u00a0532,98'));
});

test("YearlyReport simple pokazuje kontrole danych zamiast samego Gotowe przy podejrzanym wyniku", () => {
  const engineResult = {
    success: true,
    status: "SUCCESS",
    filing_ready: true,
    plan_used: "aggressive_user",
    annual_summary: {
      tax_year: "2025",
      pit38_rounded_revenue_pln: "0",
      pit38_rounded_cost_pln: "0",
      net_pln: "0",
    },
    scenario_results: {
      aggressive_user: {
        scenario_name: "aggressive_user",
        risk_level: "high",
        gross_result_pln: "0.00",
        taxable_base_pln: "0.00",
        tax_19_pln: "0.00",
        taxes_from_dane_pln: "0.00",
        net_pln: "0.00",
        total_revenue_pln: "0.00",
        total_cost_pln: "0.00",
        delta_vs_defensible_pln: "0.00",
        additional_costs: [],
        notes: [],
      },
    },
    tax_filing_package: {
      audit_appendix: {
        result_health_check: {
          status: "needs_review",
          headline: "Wynik wymaga kontroli źródeł danych.",
          reasons: ["Historia zawiera sprzedaże, ale przychód PIT wynosi 0 zł."],
          activeTaxSourceIds: ["src:baseline"],
          activeTaxSourceLabels: ["historia_transakcji.json"],
          recognizedStorageFileCount: 4,
          taxHistoryRowCount: 1,
          sellRowCount: 1,
          revenuePln: "0",
          costPln: "0",
        },
      },
    },
  } as TaxEngineResponse;

  const markup = renderYearlyReport(engineResult, { uiComplexityMode: "simple" });

  assert.equal(markup.includes("Wymaga kontroli danych"), true);
  assert.equal(markup.includes("Historia zawiera sprzedaże, ale przychód PIT wynosi 0 zł."), true);
  assert.equal(markup.includes("Sprawdź źródła"), true);
});

test("YearlyReport wyjasnia zera PIT przy roku z samymi zakupami bez sprzedazy", () => {
  const engineResult = {
    success: true,
    status: "SUCCESS",
    filing_ready: true,
    plan_used: "aggressive_user",
    annual_summary: { tax_year: "2026", net_pln: "0" },
    scenario_results: {
      conservative: {
        scenario_name: "conservative",
        risk_level: "low",
        gross_result_pln: "0.00",
        taxable_base_pln: "0.00",
        tax_19_pln: "0.00",
        taxes_from_dane_pln: "0.00",
        net_pln: "0.00",
        total_revenue_pln: "0.00",
        total_cost_pln: "0.00",
        delta_vs_defensible_pln: "0.00",
        additional_costs: [],
        notes: [],
      },
      aggressive_user: {
        scenario_name: "aggressive_user",
        risk_level: "high",
        gross_result_pln: "0.00",
        taxable_base_pln: "0.00",
        tax_19_pln: "0.00",
        taxes_from_dane_pln: "0.00",
        net_pln: "0.00",
        total_revenue_pln: "0.00",
        total_cost_pln: "0.00",
        delta_vs_defensible_pln: "0.00",
        additional_costs: [],
        notes: [],
      },
    },
    transaction_history_rows: [
      {
        row_id: "BUY-1",
        parent_row_id: null,
        row_kind: "TRADE",
        side: "BUY",
        logical_world: "equity_tax",
        tax_impact_kind: "PIT_COUNTED",
      },
    ],
  } as TaxEngineResponse;

  const markup = renderYearlyReport(engineResult, { selectedYear: 2026 });

  assert.equal(markup.includes("To nie jest awaria silnika"), true);
  assert.equal(markup.includes("zakupy inwestycyjne: 1"), true);
  assert.equal(markup.includes("sprzedaże: 0"), true);
  assert.equal(markup.includes("zostają w lotach FIFO"), true);
});

test("YearlyReport grupuje powtarzalne odsetki i pokazuje kontekst finansowania", () => {
  const engineResult = {
    success: true,
    status: "SUCCESS",
    filing_ready: true,
    annual_summary: { tax_year: "2025", net_pln: "0" },
    tax_filing_package: {
      audit_appendix: {
        defense_readiness: {
          score: 40,
          totalAggressiveItems: 2,
          completeItems: 0,
          missingEvidenceItems: 2,
          highRiskItems: 0,
          blockingWarnings: [],
        },
        defense_gap_summary: {
          total_gaps: 2,
          by_status: { needs_user_evidence: 2 },
          by_kind: { INVESTMENT_INTEREST: 2 },
          action_items: [],
        },
        defense_evidence_groups: [
          {
            group_id: "INVESTMENT_INTEREST:USD:2025-11-15:2025-11-16",
            kind: "INVESTMENT_INTEREST",
            label_pl: "Odsetki od salda ujemnego",
            amount_pln: "31.36",
            cost_ids: ["COST-3368752211", "COST-3369078693"],
            source_record_ids: ["3368752211", "3369078693"],
            missing_evidence: ["dowód naliczenia odsetek", "historia salda ujemnego"],
            context_label: "Kontekst finansowania",
            context_ids: ["negative_cash_balance:USD:2025-11-15", "negative_cash_balance:USD:2025-11-16"],
            item_count: 2,
            date_from: "2025-11-15",
            date_to: "2025-11-16",
            defense_status: "needs_user_evidence",
            defense_status_label_pl: "Wymaga dowodu",
            risk_level: "medium",
          },
        ],
        aggressive_cost_defense: [
          {
            cost_id: "COST-3368752211",
            kind: "INVESTMENT_INTEREST",
            amount_pln: "15.68",
            allocation_target: "negative_cash_balance:USD:2025-11-15",
            defense_status: "needs_user_evidence",
            defense_status_label_pl: "Wymaga dowodu",
            missing_evidence: ["dowód naliczenia odsetek"],
            defense_status_source: "local_override",
          },
        ],
      },
    },
  } as TaxEngineResponse;

  const markup = renderYearlyReport(engineResult);

  assert.equal(markup.includes("Grupy dowodowe kosztów"), true);
  assert.equal(markup.includes("Odsetki od salda ujemnego"), true);
  assert.equal(markup.includes("Kontekst finansowania"), true);
  assert.equal(markup.includes("2 pozycje"), true);
  assert.equal(markup.includes("potwierdzone lokalnie przez użytkownika"), true);
  assert.equal(markup.includes("Brak powiązania"), false);
});

test("YearlyReport pokazuje Import Intelligence i No Overpay Guard bez zmiany kalkulacji", () => {
  const engineResult = {
    success: true,
    status: "SUCCESS",
    filing_ready: true,
    annual_summary: { tax_year: "2025", net_pln: "0" },
    tax_filing_package: {
      audit_appendix: {
        source_manifest_v2: [
          {
            sourceId: "sha256:abc",
            filename: "Tradesv1.xlsx",
            hash: "abc",
            detectedType: "broker_trades_excel",
            sections: ["rows"],
            recordCounts: { rows: 12 },
            contributesToTax: true,
            warnings: [],
            errors: [],
          },
        ],
        import_intelligence_report: {
          duplicates: [{ key: "ORDER-1", count: 2 }],
          conflicts: [],
          missingExpectedSections: [],
          recommendedActions: ["Sprawdź duplikaty w lokalnych plikach brokera."],
        },
        no_overpay_audit: {
          candidateCosts: [
            {
              costId: "FX-SPREAD-1",
              kind: "FX_CONVERSION_SPREAD_COST",
              labelPl: "Koszt spreadu przewalutowania",
              amountPln: "12.34",
              included: true,
              status: "liczone",
              reason: "ujęty przez politykę kosztów",
            },
          ],
          excludedCosts: [
            {
              costId: "BANK-FEE-1",
              kind: "BANK_FUNDING_FEE",
              labelPl: "Prowizja bankowa za zasilenie",
              amountPln: "24.73",
              included: false,
              status: "do_dowodu",
              reason: "brak potwierdzenia użytkownika",
            },
          ],
          duplicateRisks: [{ key: "ORDER-1", count: 2 }],
          technicalRows: [{ rowId: "TECH-1" }],
          missingEvidence: [{ evidenceId: "EVID-1" }],
          recommendedActions: ["BANK-FEE-1: sprawdź dowód prowizji."],
          confidenceScore: 86,
          summary: {
            candidateCostCount: 1,
            excludedCostCount: 1,
            duplicateRiskCount: 1,
            technicalRowCount: 1,
            missingEvidenceCount: 1,
            plan: "aggressive_user",
          },
        },
        defense_case_file: {
          summary: {
            source_count: 1,
            candidate_cost_count: 1,
            excluded_cost_count: 1,
            duplicate_risk_count: 1,
            missing_evidence_count: 1,
            defense_group_count: 0,
          },
          recommendedActions: ["Zachowaj plik Tradesv1.xlsx w pakiecie dowodowym."],
        },
        broker_file_control_tower: {
          summary: {
            source_count: 1,
            canonical_source_count: 1,
            context_source_count: 0,
            duplicate_count: 1,
            conflict_count: 0,
            missing_coverage_count: 0,
          },
          recommendedActions: ["Sprawdź duplikaty w lokalnych plikach brokera."],
          sections: {
            what_was_imported: [{ sourceId: "sha256:abc", filename: "Tradesv1.xlsx" }],
            canonical_sources: [{ sourceId: "sha256:abc", filename: "Tradesv1.xlsx" }],
            context_sources: [],
            missing: [],
          },
        },
        coverage_matrix: [
          { area: "transactions", label: "Transakcje", status: "complete", recordCount: 12, issueCount: 0, recommendation: "OK" },
          { area: "commissions", label: "Prowizje", status: "complete", recordCount: 1, issueCount: 0, recommendation: "OK" },
          { area: "nbp", label: "Kursy NBP", status: "complete", recordCount: 0, issueCount: 0, recommendation: "OK" },
        ],
        source_reconciliation_report: {
          primarySourceId: "sha256:abc",
          comparedSources: [
            {
              sourceId: "sha256:xlsx",
              filename: "Transakcje.xlsx",
              role: "supplemental",
              matchedCount: 12,
              primaryOnlyCount: 0,
              supplementalOnlyCount: 1,
              duplicateCount: 0,
              dateRangeGap: false,
              confidenceScore: 100,
              status: "matched",
              message: "Plik pomocniczy jest zgodny z głównym źródłem PIT.",
              supplementalOnlyBreakdown: [
                { kind: "negative_balance_interest", label: "Odsetki/prowizje salda ujemnego", count: 1 },
              ],
            },
          ],
          summary: {
            confidenceScore: 100,
            matchedSources: 1,
            needsReviewSources: 0,
            duplicateSources: 0,
            supplementalOnlyRecords: 1,
          },
          recommendedActions: [],
        },
        no_overpay_audit_v2: {
          summary: {
            candidateCostCount: 1,
            potentiallyMissedCount: 1,
            duplicateRiskCount: 1,
            technicalRowCount: 1,
            missingEvidenceCount: 1,
            confidenceScore: 86,
          },
          potentiallyMissedCosts: [
            {
              costId: "BANK-FEE-1",
              labelPl: "Prowizja bankowa za zasilenie",
              amountPln: "24.73",
              status: "wymaga_dowodu",
            },
          ],
          duplicateRisks: [{ record_key: "ORDER-1", sources: ["Tradesv1.xlsx", "Broker.json"] }],
          recommendedActions: ["BANK-FEE-1: zachowaj potwierdzenie przelewu."],
        },
        defense_case_file_v2: {
          summary: {
            defense_chain_count: 1,
            high_risk_count: 0,
            missing_evidence_count: 1,
          },
          defenseChains: [
            {
              costId: "FX-SPREAD-1",
              label: "Koszt spreadu przewalutowania",
              amountPln: "12.34",
              riskLevel: "medium",
              defenseStatus: "needs_user_evidence",
              sourceFile: "Tradesv1.xlsx",
              contextLabel: "zakup inwestycyjny",
              requiredEvidence: ["potwierdzenie przewalutowania"],
              legalBasisRefs: ["share_sale"],
            },
          ],
          recommendedActions: ["Zachowaj potwierdzenie przewalutowania."],
        },
        legal_basis_registry: [
          {
            basisId: "pit_38_2025",
            label: "PIT-38 za 2025 rok",
            source: "podatki.gov.pl",
            url: "https://www.podatki.gov.pl/twoj-e-pit/pit-38-za-2025-rok/",
            scope: "formularz PIT-38",
          },
          {
            basisId: "share_sale",
            label: "Zbycie akcji",
            source: "podatki.gov.pl",
            url: "https://www.podatki.gov.pl/podatki-osobiste/pit/informacje-podstawowe/co-jest-opodatkowane/zbycie-akcji/",
            scope: "odpłatne zbycie akcji",
          },
        ],
      },
    },
  } as TaxEngineResponse;

  const markup = renderYearlyReport(engineResult);

  assert.equal(markup.includes("Status Samocheck"), true);
  assert.equal(markup.includes("Canonical input zbudowany z lokalnych źródeł"), true);
  assert.equal(markup.includes("Broker File Control Tower"), true);
  assert.equal(markup.includes("Macierz kompletności"), true);
  assert.equal(markup.includes("Kontrola zgodności źródeł"), true);
  assert.equal(markup.includes("Zbiorczo kontekstowe: Odsetki/prowizje salda ujemnego: 1"), true);
  assert.equal(markup.includes("Źródło transakcyjne zweryfikowane z plikami pomocniczymi."), true);
  assert.equal(markup.includes("Transakcje"), true);
  assert.equal(markup.includes("kompletne"), true);
  assert.equal(markup.includes("Podstawa prawna"), true);
  assert.equal(markup.includes("PIT-38 za 2025 rok"), true);
  assert.equal(markup.includes("Zbycie akcji"), true);
  assert.equal(markup.includes("Import Intelligence + analiza kosztów"), true);
  assert.equal(markup.includes("Tradesv1.xlsx"), true);
  assert.equal(markup.includes("wpływa na PIT"), true);
  assert.equal(markup.includes("Koszt spreadu przewalutowania"), true);
  assert.equal(markup.includes("86/100"), true);
  assert.equal(markup.includes("BANK-FEE-1: sprawdź dowód prowizji."), true);
});

test("YearlyReport pokazuje sprawy importu w pakiecie PIT z lokalnymi statusami", () => {
  const engineResult = {
    success: true,
    status: "SUCCESS",
    filing_ready: true,
    annual_summary: { tax_year: "2025", net_pln: "0" },
    tax_filing_package: {
      audit_appendix: {
        broker_file_action_queue: [
          {
            action_id: "BFAQ-coverage-fx",
            severity: "warning",
            area: "coverage:fx",
            label: "Przewalutowania mają częściowe pokrycie.",
            user_action: "Dodaj dowód przewalutowania.",
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
      },
    },
  } as TaxEngineResponse;

  const markup = renderYearlyReport(engineResult, {
    brokerFileActionOverrides: [
      {
        actionId: "BFAQ-cost-fx-loss-1",
        status: "ignored",
        userNote: "Koszt zweryfikowany poza aplikacją.",
        linkedRowId: "FX-LOSS-1",
        updatedAt: "2026-05-12T12:00:00.000Z",
      },
    ],
    onOpenImport: () => undefined,
    onOpenHistorySearch: () => undefined,
  });

  assert.equal(markup.includes("Sprawy importu w pakiecie PIT"), true);
  assert.equal(markup.includes("1 otwarte / 2 razem"), true);
  assert.equal(markup.includes("Zignorowane"), true);
  assert.equal(markup.includes("Koszt zweryfikowany poza aplikacją."), true);
  assert.equal(markup.includes("Potencjalna strata FX wymaga decyzji dowodowej."), true);
  assert.equal(markup.includes("Typy rekordów tylko pomocniczych: Odsetki/prowizje salda ujemnego: 1"), true);
  assert.equal(markup.includes("Przejdź do importu"), true);
  assert.equal(markup.includes("Przejdź do historii"), true);
});

test("przychód i koszty PIT-38 mają grosze jak poz. 26 i 27, a nie pełne złote z pit38_rounded_*", () => {
  const wynik = {
    success: true,
    status: "SUCCESS",
    filing_ready: true,
    primary_scenario: "defensible",
    annual_summary: {
      tax_year: "2025",
      pit38_rounded_revenue_pln: "11170938",
      pit38_rounded_cost_pln: "11083922",
      pit38_form_revenue_pln: "11170937.84",
      pit38_form_cost_pln: "11083922.18",
      net_pln: "70482.57",
    },
    scenario_results: { defensible: {
      scenario_name: "defensible", taxable_base_pln: "87015.66", tax_19_pln: "16532.98",
      net_pln: "70482.57", total_revenue_pln: "11170937.84", total_cost_pln: "11083922.18",
      risk_level: "medium", gross_result_pln: "87015.66", taxes_from_dane_pln: "0.11",
      delta_vs_defensible_pln: "0.00", additional_costs: [], notes: [],
    } },
  } as TaxEngineResponse;
  for (const tryb of ["simple", "expert"] as const) {
    const markup = renderYearlyReport(wynik, { uiComplexityMode: tryb });
    assert.match(markup, /11[\s\u00a0]170[\s\u00a0]937,84/, `przychód z groszami (${tryb})`);
    assert.match(markup, /11[\s\u00a0]083[\s\u00a0]922,18/, `koszty z groszami (${tryb})`);
    assert.doesNotMatch(markup, /11[\s\u00a0]170[\s\u00a0]938,00/, `bez zaokrąglonego przychodu (${tryb})`);
  }
});
