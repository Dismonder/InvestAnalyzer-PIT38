import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPitCaseFileBaselineStatus,
  readPitCaseFileBaseline,
  writePitCaseFileBaseline,
} from "../../../aplikacje/web/src/invest_analyzer/services/pitCaseFile.ts";
import type { PitCaseFile } from "../../../aplikacje/web/src/invest_analyzer/hooks/useTaxEngineRun.ts";

const makeCaseFile = (overrides: Partial<PitCaseFile> = {}): PitCaseFile => ({
  case_file_id: "pit-case:2025:abc123",
  generated_at: "2026-05-11T00:00:00Z",
  tax_year: "2025",
  plan_used: "aggressive_user",
  audit_hash: "abc123",
  reproducible: true,
  reproducibility_status: "REPRODUCIBLE_FROM_AUDIT_PACKAGE",
  input_fingerprint: "input-a",
  calculation_fingerprint: "calc-a",
  package_sections: {
    tax_calculation_ledger_rows: 8,
    tax_trace_entries: 6,
  },
  included_artifacts: ["PIT_Case_File"],
  replay_instructions_pl: ["Użyj case file do odtworzenia przebiegu."],
  warnings: [],
  ...overrides,
});

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

test("baseline case file pokazuje brak poprzedniego pakietu", () => {
  const status = buildPitCaseFileBaselineStatus(makeCaseFile(), null);

  assert.equal(status.status, "NO_BASELINE");
  assert.equal(status.changedFields.length, 0);
  assert.match(status.label, /Brak poprzedniego pakietu/);
});

test("baseline case file wykrywa zgodnosc z ostatnim pakietem", () => {
  const current = makeCaseFile({ generated_at: "2026-05-12T00:00:00Z" });
  const baseline = makeCaseFile({ generated_at: "2026-05-11T00:00:00Z" });

  const status = buildPitCaseFileBaselineStatus(current, baseline);

  assert.equal(status.status, "MATCH");
  assert.equal(status.changedFields.length, 0);
  assert.equal(status.baselineGeneratedAt, "2026-05-11T00:00:00Z");
  assert.match(status.label, /Zgodny z ostatnim pakietem/);
});

test("baseline case file wykrywa zmiane danych albo kalkulacji", () => {
  const current = makeCaseFile({
    input_fingerprint: "input-b",
    calculation_fingerprint: "calc-b",
  });
  const baseline = makeCaseFile();

  const status = buildPitCaseFileBaselineStatus(current, baseline);

  assert.equal(status.status, "CHANGED");
  assert.deepEqual(status.changedFields, ["fingerprint danych", "fingerprint kalkulacji"]);
  assert.match(status.label, /zmieniły się od ostatniego pakietu/);
});

test("baseline case file zapisuje i odczytuje ostatni pobrany pakiet dla roku", () => {
  const storage = new MemoryStorage();
  const caseFile = makeCaseFile({ tax_year: "2025" });

  writePitCaseFileBaseline(storage, caseFile);
  const restored = readPitCaseFileBaseline(storage, 2025);

  assert.equal(restored?.case_file_id, "pit-case:2025:abc123");
  assert.equal(restored?.tax_year, "2025");
});

