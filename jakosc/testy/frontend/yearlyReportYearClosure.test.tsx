import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { YearlyReport } from "../../../aplikacje/web/src/invest_analyzer/components/YearlyReport.tsx";
import type { PitCaseFile, TaxEngineResponse } from "../../../aplikacje/web/src/invest_analyzer/hooks/useTaxEngineRun.ts";
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

function renderReportWithStorage(storage: Storage, caseFile: PitCaseFile, filingReady = true) {
  const previousLocalStorage = (globalThis as typeof globalThis & { localStorage?: unknown }).localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });

  try {
    const engineResult: TaxEngineResponse = {
      success: true,
      status: "SUCCESS",
      filing_ready: filingReady,
      annual_summary: { tax_year: caseFile.tax_year, net_pln: "0" },
      tax_filing_package: {
        audit_appendix: {
          pit_case_file: caseFile,
        },
      },
    };

    return renderToStaticMarkup(
      <YearlyReport
        selectedYear={Number(caseFile.tax_year)}
        engineLoading={false}
        packageLoading={false}
        engineResult={engineResult}
        runPythonEngine={async () => engineResult}
        reportOrganizationStatus={{ year: Number(caseFile.tax_year), status: "downloaded", updatedAt: "2026-05-10T10:00:00.000Z" }}
        onReportOrganizationStatusChange={() => undefined}
        uiComplexityMode="expert"
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

test("YearlyReport pokazuje zamkniety rok jako tryb tylko do odczytu", () => {
  const storage = new MemoryStorage();
  const caseFile: PitCaseFile = {
    case_file_id: "case-2025",
    generated_at: "2026-05-11T10:00:00.000Z",
    tax_year: "2025",
    plan_used: "aggressive_user",
    audit_hash: "audit-1",
    reproducible: true,
    reproducibility_status: "complete",
    input_fingerprint: "input-1",
    calculation_fingerprint: "calc-1",
    package_sections: { tax_calculation_ledger_rows: 12, tax_trace_entries: 8 },
    included_artifacts: ["tax_report.xlsx"],
  };
  closeTaxYear(storage, caseFile, { decisionNote: "Pakiet sprawdzony przed zlozeniem." });

  const markup = renderReportWithStorage(storage, caseFile);

  assert.equal(markup.includes("Zamknięcie roku PIT"), true);
  assert.equal(markup.includes("Rok zamknięty"), true);
  assert.equal(markup.includes("Tryb tylko do odczytu"), true);
  assert.equal(markup.includes("Otwórz rok ponownie"), true);
  assert.equal(markup.includes("Powód ponownego otwarcia"), true);
  assert.equal(markup.includes("Aktualizacja danych, dowodów lub pakietu PIT."), true);
  assert.equal(markup.includes("Pakiet sprawdzony przed zlozeniem."), true);
});

test("YearlyReport blokuje przeliczenie i generowanie pakietu dla zamknietego roku", () => {
  const storage = new MemoryStorage();
  const caseFile: PitCaseFile = {
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
  closeTaxYear(storage, caseFile, { decisionNote: "Rok zamknięty po kontroli." });
  storage.setItem("priorYearLossEntries", JSON.stringify([
    { id: "loss-2024", taxYear: 2024, amountPln: "1000.00", remainingPln: "400.00" },
  ]));

  const markup = renderReportWithStorage(storage, caseFile);

  assert.match(markup, /<button[^>]*disabled=""[^>]*>[\s\S]*Przelicz raport w Python/);
  assert.match(markup, /<button[^>]*disabled=""[^>]*>[\s\S]*Generuj i pobierz pakiet podatkowy/);
  assert.equal(markup.includes("Otwórz rok ponownie, aby przeliczyć raport albo wygenerować nowy pakiet."), true);
  assert.equal(markup.includes("Otwórz rok ponownie, aby zmienić straty z lat ubiegłych."), true);
  assert.match(markup, /<input[^>]*disabled=""[^>]*value="400\.00"/);
  assert.match(markup, /<button[^>]*disabled=""[^>]*>Dodaj stratę<\/button>/);
});

test("YearlyReport ostrzega, gdy dane zmienily sie po zamknieciu roku", () => {
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

  const changedCaseFile: PitCaseFile = {
    ...closedCaseFile,
    case_file_id: "case-2025-new",
    calculation_fingerprint: "calc-2",
  };
  const markup = renderReportWithStorage(storage, changedCaseFile);

  assert.equal(markup.includes("Dane lub kalkulacja zmieniły się po zamknięciu roku"), true);
  assert.equal(markup.includes("fingerprint kalkulacji"), true);
  assert.equal(markup.includes("Rok nie jest już zamrożony"), true);
});

test("YearlyReport nie pozwala zamknac roku, gdy rozliczenie nie jest gotowe do zlozenia", () => {
  const caseFile: PitCaseFile = {
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
  const niegotowe = renderReportWithStorage(new MemoryStorage(), caseFile, false);
  assert.match(niegotowe, /<button[^>]*disabled=""[^>]*>Zamknij rok 2025/);
  assert.equal(niegotowe.includes("Rok można zamknąć dopiero przy zielonej gotowości rozliczenia."), true);

  const gotowe = renderReportWithStorage(new MemoryStorage(), caseFile, true);
  assert.doesNotMatch(gotowe, /<button[^>]*disabled=""[^>]*>Zamknij rok 2025/);
});
