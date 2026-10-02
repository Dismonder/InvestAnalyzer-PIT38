import test from "node:test";
import assert from "node:assert/strict";

import { normalizeImportFile, safeImportFileName } from "../../../aplikacje/web/src/invest_analyzer/services/importFileName.ts";

test("safeImportFileName strips Windows absolute paths to a safe filename", () => {
  const file = new File(["{}"], String.raw`C:\Users\TestUser\Downloads\investment-tax-engine\dane\pliki\broker_raport_bezbliansu.json`);

  assert.equal(safeImportFileName(file), "broker_raport_bezbliansu.json");
});

test("normalizeImportFile keeps file bytes but replaces unsafe path-like name", async () => {
  const file = new File(["test-content"], String.raw`C:\storage\Transakcje.xlsx`, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const normalized = normalizeImportFile(file);

  assert.equal(normalized.name, "Transakcje.xlsx");
  assert.equal(normalized.type, file.type);
  assert.equal(await normalized.text(), "test-content");
});
