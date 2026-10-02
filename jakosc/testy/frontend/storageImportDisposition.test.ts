import test from "node:test";
import assert from "node:assert/strict";

import {
  getStorageFileDisposition,
  isBrokerReportFile,
  storageDispositionMessage,
} from "../../../aplikacje/web/src/invest_analyzer/services/storageImportDisposition.ts";

test("Traderzy.xlsx jest plikiem analitycznym, nie tabelą transakcji", () => {
  assert.equal(getStorageFileDisposition("Traderzy.xlsx"), "analytics");
  assert.equal(getStorageFileDisposition("Dane/traders_summary.XLSX"), "analytics");
  assert.match(
    storageDispositionMessage("Traderzy.xlsx", "analytics"),
    /Przyjęto plik Traderzy\.xlsx jako podsumowanie brokera\/analitykę/i,
  );
});

test("storage disposition rozdziela import, dowody, reconciliation i NBP", () => {
  assert.equal(getStorageFileDisposition("broker_raport.json"), "transactions");
  assert.equal(isBrokerReportFile("broker_raport_bezbliansu.json"), true);
  assert.equal(getStorageFileDisposition("Transakcje.xlsx"), "transactions");
  assert.equal(getStorageFileDisposition("Ruchy_gotówki.csv"), "transactions");
  assert.equal(getStorageFileDisposition("archiwum_tab_a_2025.csv"), "nbp");
  assert.equal(getStorageFileDisposition("dezpozytariusz_raport.json"), "reconciliation");
  assert.equal(getStorageFileDisposition("Stawki.pdf"), "evidence");
  assert.equal(getStorageFileDisposition("readme.txt"), "raw_data");
});

