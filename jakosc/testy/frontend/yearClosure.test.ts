import test from "node:test";
import assert from "node:assert/strict";

import {
  buildYearClosureStatus,
  closeTaxYear,
  getTaxYearClosureStorageKey,
  readTaxYearClosure,
  reopenTaxYear,
} from "../../../aplikacje/web/src/invest_analyzer/services/yearClosure.ts";
import type { PitCaseFile } from "../../../aplikacje/web/src/invest_analyzer/hooks/useTaxEngineRun.ts";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  failWrites = false;

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
    if (this.failWrites) {
      throw new Error("quota exceeded");
    }
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
    tax_trace_entries: 8,
  },
  included_artifacts: ["tax_report.xlsx", "tax_filing_package.json"],
  ...patch,
});

test("closeTaxYear zapisuje odtwarzalny snapshot zamknietego roku", () => {
  const storage = new MemoryStorage();
  const closure = closeTaxYear(storage, caseFile(), {
    decisionNote: "Pakiet sprawdzony przed wysylka.",
    artifacts: ["tax_report.xlsx"],
  });

  const restored = readTaxYearClosure(storage, 2025);

  assert.equal(getTaxYearClosureStorageKey(2025), "taxYearClosure:v1:2025");
  assert.equal(closure?.status, "closed");
  assert.equal(restored?.status, "closed");
  assert.equal(restored?.snapshot.caseFileId, "case-2025");
  assert.equal(restored?.snapshot.inputFingerprint, "input-1");
  assert.equal(restored?.snapshot.calculationFingerprint, "calc-1");
  assert.equal(restored?.decisions[0].kind, "close_year");
  assert.match(restored?.decisions[0].note || "", /sprawdzony/i);
});

test("closeTaxYear i reopenTaxYear nie zwracają zmian, których nie udało się zapisać", () => {
  const storage = new MemoryStorage();
  storage.failWrites = true;
  assert.equal(closeTaxYear(storage, caseFile()), null);

  storage.failWrites = false;
  closeTaxYear(storage, caseFile());
  storage.failWrites = true;
  assert.equal(reopenTaxYear(storage, 2025), null);
});

test("buildYearClosureStatus wykrywa zmiany danych po zamknieciu roku", () => {
  const storage = new MemoryStorage();
  closeTaxYear(storage, caseFile(), { decisionNote: "Zamkniecie roku." });
  const restored = readTaxYearClosure(storage, 2025);

  const status = buildYearClosureStatus(
    caseFile({ calculation_fingerprint: "calc-2" }),
    restored,
  );

  assert.equal(status.status, "changed_after_close");
  assert.equal(status.isReadOnly, false);
  assert.deepEqual(status.changedFields, ["fingerprint kalkulacji"]);
  assert.deepEqual(status.changedDetails, [
    {
      field: "calculationFingerprint",
      label: "fingerprint kalkulacji",
      previousValue: "calc-1",
      currentValue: "calc-2",
    },
  ]);
  assert.match(status.label, /zmieniły się po zamknięciu/i);
});

test("reopenTaxYear dopisuje decyzje i odblokowuje rok do pracy", () => {
  const storage = new MemoryStorage();
  closeTaxYear(storage, caseFile(), { decisionNote: "Zamkniecie roku." });

  const reopened = reopenTaxYear(storage, 2025, "Dopisanie brakujacego dowodu.");

  assert.equal(reopened?.status, "reopened");
  assert.equal(reopened?.decisions.at(-1)?.kind, "reopen_year");
  assert.equal(reopened?.decisions.at(-1)?.note, "Dopisanie brakujacego dowodu.");
});

test("ponowne zamknięcie roku zachowuje wszystkie decyzje i notatkę o otwarciu", () => {
  const storage = new MemoryStorage();
  closeTaxYear(storage, caseFile(), { decisionNote: "Pierwsze zamknięcie." });
  reopenTaxYear(storage, 2025, "Notatka przy otwarciu.");

  const closedAgain = closeTaxYear(storage, caseFile(), { decisionNote: "Ponowne zamknięcie." });

  assert.equal(closedAgain?.status, "closed");
  assert.equal(closedAgain?.decisions.length, 3);
  assert.deepEqual(closedAgain?.decisions.map(({ kind }) => kind), ["close_year", "reopen_year", "close_year"]);
  assert.equal(closedAgain?.decisions[1]?.note, "Notatka przy otwarciu.");
});


test('historia decyzji roku ma limit - najstarsze wpisy odpadaja powyzej stu', async () => {
  const { closeTaxYear, reopenTaxYear, readTaxYearClosure } = await import('../../../aplikacje/web/src/invest_analyzer/services/yearClosure.ts');
  const magazyn = new Map<string, string>();
  const storage = {
    getItem: (key: string) => magazyn.get(key) ?? null,
    setItem: (key: string, value: string) => void magazyn.set(key, value),
    removeItem: (key: string) => void magazyn.delete(key),
  };
  const caseFile = { tax_year: 2026, included_artifacts: [] } as never;
  for (let cykl = 0; cykl < 60; cykl += 1) {
    closeTaxYear(storage as never, caseFile, { decisionNote: `zamkniecie ${cykl}` });
    reopenTaxYear(storage as never, 2026, `otwarcie ${cykl}`);
  }
  const zamkniecie = readTaxYearClosure(storage as never, 2026);
  assert.ok(zamkniecie, 'zamkniecie roku zapisane');
  assert.equal(zamkniecie!.decisions.length, 100);
  assert.equal(zamkniecie!.decisions.at(-1)?.note, 'otwarcie 59');
});
