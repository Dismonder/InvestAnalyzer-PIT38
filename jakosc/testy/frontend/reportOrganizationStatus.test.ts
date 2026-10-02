import test from "node:test";
import assert from "node:assert/strict";

import {
  getDefaultTaxReportOrganizationStatus,
  markTaxReportOrganizationStatus,
  readTaxReportOrganizationStatus,
  TAX_REPORT_ORGANIZATION_LABELS,
} from "../../../aplikacje/web/src/invest_analyzer/services/reportOrganizationStatus.ts";

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

test("getDefaultTaxReportOrganizationStatus zwraca lokalny status nieprzygotowany", () => {
  const status = getDefaultTaxReportOrganizationStatus(2026);

  assert.equal(status.year, 2026);
  assert.equal(status.status, "draft");
  assert.equal(TAX_REPORT_ORGANIZATION_LABELS[status.status], "Nieprzygotowany");
});

test("markTaxReportOrganizationStatus zapisuje i odczytuje status opłacony bez udziału silnika", () => {
  const storage = new MemoryStorage();
  const saved = markTaxReportOrganizationStatus(storage, 2026, "paid");
  const loaded = readTaxReportOrganizationStatus(storage, 2026);

  assert.equal(saved.status, "paid");
  assert.equal(loaded.status, "paid");
  assert.equal(TAX_REPORT_ORGANIZATION_LABELS[loaded.status], "Opłacony");
});

test("readTaxReportOrganizationStatus izoluje statusy między latami", () => {
  const storage = new MemoryStorage();
  markTaxReportOrganizationStatus(storage, 2025, "submitted");
  markTaxReportOrganizationStatus(storage, 2026, "downloaded");

  assert.equal(readTaxReportOrganizationStatus(storage, 2025).status, "submitted");
  assert.equal(readTaxReportOrganizationStatus(storage, 2026).status, "downloaded");
});

