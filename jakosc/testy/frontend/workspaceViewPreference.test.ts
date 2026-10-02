import test from "node:test";
import assert from "node:assert/strict";

import {
  getInitialWorkspaceView,
  WORKSPACE_VIEW_STORAGE_KEY,
} from "../../../aplikacje/web/src/invest_analyzer/services/workspaceViewPreference.ts";

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

test("getInitialWorkspaceView domyślnie prowadzi użytkownika do raportu rocznego", () => {
  const storage = new MemoryStorage();

  assert.equal(getInitialWorkspaceView(storage), "raport_roczny");
});

test("getInitialWorkspaceView zachowuje zapamiętany poprawny widok użytkownika", () => {
  const storage = new MemoryStorage();
  storage.setItem(WORKSPACE_VIEW_STORAGE_KEY, "historia_transakcji");

  assert.equal(getInitialWorkspaceView(storage), "historia_transakcji");
});

test("getInitialWorkspaceView ignoruje stary albo nieznany widok i wraca do raportu", () => {
  const storage = new MemoryStorage();
  storage.setItem(WORKSPACE_VIEW_STORAGE_KEY, "portfel_na_zywo");

  assert.equal(getInitialWorkspaceView(storage), "raport_roczny");
});

