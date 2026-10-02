import test from "node:test";
import assert from "node:assert/strict";

import { buildResultTrustModel } from "../../../aplikacje/web/src/invest_analyzer/services/resultTrust.ts";
import type { TaxEngineResponse } from "../../../aplikacje/web/src/invest_analyzer/hooks/useTaxEngineRun.ts";

test("buildResultTrustModel: pokazuje aktywne źródła i OK dla zdrowego wyniku", () => {
  const model = buildResultTrustModel({ success: true, status: "SUCCESS" } as TaxEngineResponse, {
    result_health_check: {
      status: "ok",
      headline: "Dane źródłowe wyglądają spójnie.",
      reasons: [],
      activeTaxSourceIds: ["src:baseline"],
      activeTaxSourceLabels: ["historia_transakcji.json"],
      recognizedStorageFileCount: 8,
      taxHistoryRowCount: 10,
      sellRowCount: 2,
      revenuePln: "1000",
      costPln: "700",
    },
  });

  assert.equal(model.status, "ok");
  assert.equal(model.label, "Dane czytane poprawnie");
  assert.deepEqual(model.activeTaxSources, ["historia_transakcji.json"]);
  assert.equal(model.recognizedFileCount, 8);
});

test("buildResultTrustModel: needs_review daje akcję sprawdzenia źródeł", () => {
  const model = buildResultTrustModel({ success: true, status: "SUCCESS" } as TaxEngineResponse, {
    result_health_check: {
      status: "needs_review",
      headline: "Wynik wymaga kontroli źródeł danych.",
      reasons: ["Historia zawiera sprzedaże, ale przychód PIT wynosi 0 zł."],
      activeTaxSourceIds: ["src:baseline"],
      activeTaxSourceLabels: ["historia_transakcji.json"],
      recognizedStorageFileCount: 4,
      taxHistoryRowCount: 1,
      sellRowCount: 1,
      revenuePln: "0",
      costPln: "0",
    },
  });

  assert.equal(model.status, "needs_review");
  assert.equal(model.label, "Wymaga kontroli danych");
  assert.equal(model.summary, "Historia zawiera sprzedaże, ale przychód PIT wynosi 0 zł.");
  assert.equal(model.recommendedAction, "Sprawdź źródła danych");
});


test("buildResultTrustModel: brak przebiegu i brak plików to nie jest 'dane czytane poprawnie'", () => {
  // Bez zrodel i bez wyniku funkcja spadala do ostatniego return i ekran pisal
  // "Dane czytane poprawnie - zrodla wygladaja spojnie" nad kompletem zer.
  const model = buildResultTrustModel(null, null);

  assert.equal(model.status, "needs_review");
  assert.equal(model.label, "Brak wczytanych źródeł");
  assert.equal(model.recognizedFileCount, 0);
  assert.doesNotMatch(model.recommendedAction, /spójnie/i, "nie wolno potwierdzac spojnosci bez danych");
});
