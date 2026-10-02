import test from "node:test";
import assert from "node:assert/strict";

import { buildTaxYearClosureAuditExport } from "../../../aplikacje/web/src/invest_analyzer/services/yearClosureExport.ts";
import {
  buildYearClosureStatus,
  closeTaxYear,
  readTaxYearClosure,
} from "../../../aplikacje/web/src/invest_analyzer/services/yearClosure.ts";
import type { PitCaseFile } from "../../../aplikacje/web/src/invest_analyzer/hooks/useTaxEngineRun.ts";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const caseFile = (patch: Partial<PitCaseFile> = {}): PitCaseFile => ({
  case_file_id: "case-2025",
  generated_at: "2026-05-11T10:00:00.000Z",
  tax_year: "2025",
  plan_used: "aggressive_user",
  audit_hash: "audit-1",
  reproducible: true,
  reproducibility_status: "complete",
  input_fingerprint: "input-1",
  calculation_fingerprint: "calc-1",
  package_sections: {
    tax_calculation_ledger_rows: 12,
  },
  included_artifacts: ["tax_report.xlsx"],
  ...patch,
});

test("buildTaxYearClosureAuditExport buduje JSON z decyzjami i roznicami po zamknieciu", () => {
  const storage = new MemoryStorage();
  closeTaxYear(storage, caseFile(), { decisionNote: "Zamkniecie po kontroli PIT." });
  const closure = readTaxYearClosure(storage, 2025);
  assert.ok(closure);

  const currentCaseFile = caseFile({
    calculation_fingerprint: "calc-2",
    audit_hash: "audit-2",
  });
  const status = buildYearClosureStatus(currentCaseFile, closure);

  const auditExport = buildTaxYearClosureAuditExport({
    closure,
    currentCaseFile,
    status,
    generatedAt: "2026-05-11T12:00:00.000Z",
  });

  assert.equal(auditExport.taxYear, 2025);
  assert.equal(auditExport.status, "changed_after_close");
  assert.equal(auditExport.generatedAt, "2026-05-11T12:00:00.000Z");
  assert.equal(auditExport.closedSnapshot.caseFileId, "case-2025");
  assert.deepEqual(
    auditExport.changedDetails.map((detail) => detail.field),
    ["calculationFingerprint", "auditHash"],
  );
  assert.equal(auditExport.currentCaseFile?.calculationFingerprint, "calc-2");
  assert.equal(auditExport.decisions[0].note, "Zamkniecie po kontroli PIT.");
  assert.match(auditExport.recommendation, /zamknij rok ponownie/i);
});

