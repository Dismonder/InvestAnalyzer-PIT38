import test from "node:test";
import assert from "node:assert/strict";

import { buildPitCaseFileSummary } from "../../../aplikacje/web/src/invest_analyzer/services/pitCaseFile.ts";
import type { TaxFilingPackageAuditAppendix } from "../../../aplikacje/web/src/invest_analyzer/hooks/useTaxEngineRun.ts";

test("pitCaseFile summary pokazuje odtwarzalny pakiet PIT", () => {
  const auditAppendix: TaxFilingPackageAuditAppendix = {
    pit_case_file: {
      case_file_id: "pit-case:2025:abc123",
      generated_at: "2026-05-11T00:00:00Z",
      tax_year: "2025",
      plan_used: "aggressive_user",
      audit_hash: "abc123",
      reproducible: true,
      reproducibility_status: "REPRODUCIBLE_FROM_AUDIT_PACKAGE",
      input_fingerprint: "a".repeat(64),
      calculation_fingerprint: "b".repeat(64),
      package_sections: {
        tax_calculation_ledger_rows: 8,
        tax_trace_entries: 6,
        defense_evidence_links: 2,
      },
      included_artifacts: ["Tax_Calculation_Ledger", "PIT_Case_File"],
      replay_instructions_pl: ["Odtworzenie: użyj audit_hash i fingerprintów."],
      warnings: [],
    },
  };

  const summary = buildPitCaseFileSummary(auditAppendix);

  assert.equal(summary.available, true);
  assert.equal(summary.statusLabel, "Odtwarzalny");
  assert.equal(summary.caseFileId, "pit-case:2025:abc123");
  assert.equal(summary.sectionCountLabel, "8 wierszy ledgeru / 6 ścieżek kwot");
  assert.deepEqual(summary.warnings, []);
});

test("pitCaseFile summary jasno pokazuje brak case file", () => {
  const summary = buildPitCaseFileSummary({});

  assert.equal(summary.available, false);
  assert.equal(summary.statusLabel, "Brak case file");
  assert.equal(summary.reproducible, false);
  assert.ok(summary.warnings[0]?.includes("Wygeneruj pełny pakiet"));
});

