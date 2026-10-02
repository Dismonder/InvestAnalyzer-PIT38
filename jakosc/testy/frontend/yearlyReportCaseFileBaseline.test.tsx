import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { YearlyReport } from "../../../aplikacje/web/src/invest_analyzer/components/YearlyReport.tsx";
import type { TaxEngineResponse } from "../../../aplikacje/web/src/invest_analyzer/hooks/useTaxEngineRun.ts";
import { getPitCaseFileBaselineStorageKey } from "../../../aplikacje/web/src/invest_analyzer/services/pitCaseFile.ts";

test("YearlyReport pokazuje od razu, że case file zmienił się od ostatniego pakietu", () => {
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
      input_fingerprint: "input-a",
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
      filing_ready: true,
      annual_summary: { tax_year: "2025", net_pln: "0" },
      tax_filing_package: {
        audit_appendix: {
          pit_case_file: {
            case_file_id: "case-new",
            generated_at: "2026-05-11T10:00:00.000Z",
            tax_year: "2025",
            plan_used: "aggressive_user",
            reproducible: true,
            reproducibility_status: "complete",
            input_fingerprint: "input-a",
            calculation_fingerprint: "calc-new",
            package_sections: {
              tax_calculation_ledger_rows: 1,
              tax_trace_entries: 1,
            },
          },
        },
      },
    };

    const markup = renderToStaticMarkup(
      <YearlyReport
        selectedYear={2025}
        engineLoading={false}
        packageLoading={false}
        engineResult={engineResult}
        runPythonEngine={async () => engineResult}
        reportOrganizationStatus={{ year: 2025, status: "downloaded", updatedAt: "2026-05-10T10:00:00.000Z" }}
        onReportOrganizationStatusChange={() => undefined}
        uiComplexityMode="expert"
      />,
    );

    assert.equal(markup.includes("Dane lub kalkulacja zmieniły się od ostatniego pakietu"), true);
    assert.equal(markup.includes("fingerprint kalkulacji"), true);
    assert.equal(markup.includes("Wygeneruj nowy pakiet przed złożeniem PIT"), true);
    assert.equal(markup.includes("Wygeneruj nowy pakiet podatkowy"), true);
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

