import test from "node:test";
import assert from "node:assert/strict";

import {
  getUiComplexityMode,
  getUiLanguage,
  getHistoryShowTechnicalRows,
  HISTORY_SHOW_TECHNICAL_ROWS_KEY,
  saveUiComplexityMode,
  saveUiLanguage,
  saveHistoryShowTechnicalRows,
  UI_COMPLEXITY_MODE_KEY,
  UI_LANGUAGE_KEY,
} from "../../../aplikacje/web/src/invest_analyzer/services/uiPreferences.ts";
import type { KeyValueStorageSource } from "../../../aplikacje/web/src/invest_analyzer/services/taxEngineConfig.ts";

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorageSource {
  const dane = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => dane.get(key) ?? null,
    setItem: (key: string, value: string) => {
      dane.set(key, value);
    },
  };
}

test("historia domyślnie ukrywa techniczne rekordy i zapisuje preferencję przełącznika", () => {
  const storage = memoryStorage();

  assert.equal(getHistoryShowTechnicalRows(storage), false);

  saveHistoryShowTechnicalRows(true, storage);
  assert.equal(storage.getItem(HISTORY_SHOW_TECHNICAL_ROWS_KEY), "true");
  assert.equal(getHistoryShowTechnicalRows(storage), true);

  saveHistoryShowTechnicalRows(false, storage);
  assert.equal(storage.getItem(HISTORY_SHOW_TECHNICAL_ROWS_KEY), "false");
  assert.equal(getHistoryShowTechnicalRows(storage), false);
});

test("tryb złożoności UI domyślnie jest prosty i zapisuje tryb eksperta", () => {
  const storage = memoryStorage();

  assert.equal(getUiComplexityMode(storage), "simple");

  saveUiComplexityMode("expert", storage);
  assert.equal(storage.getItem(UI_COMPLEXITY_MODE_KEY), "expert");
  assert.equal(getUiComplexityMode(storage), "expert");

  saveUiComplexityMode("simple", storage);
  assert.equal(storage.getItem(UI_COMPLEXITY_MODE_KEY), "simple");
  assert.equal(getUiComplexityMode(storage), "simple");

  assert.equal(getUiComplexityMode(memoryStorage({ [UI_COMPLEXITY_MODE_KEY]: "unknown" })), "simple");
});

test("język UI domyślnie jest polski i zapisuje angielski", () => {
  const storage = memoryStorage();

  assert.equal(getUiLanguage(storage), "pl");

  saveUiLanguage("en", storage);
  assert.equal(storage.getItem(UI_LANGUAGE_KEY), "en");
  assert.equal(getUiLanguage(storage), "en");

  saveUiLanguage("pl", storage);
  assert.equal(storage.getItem(UI_LANGUAGE_KEY), "pl");
  assert.equal(getUiLanguage(storage), "pl");

  assert.equal(getUiLanguage(memoryStorage({ [UI_LANGUAGE_KEY]: "de" })), "pl");
});

