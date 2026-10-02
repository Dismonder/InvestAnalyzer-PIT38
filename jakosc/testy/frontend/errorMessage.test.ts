import test from "node:test";
import assert from "node:assert/strict";

import { getErrorMessage } from "../../../aplikacje/web/src/invest_analyzer/services/errorMessage.ts";

test("getErrorMessage odczytuje komunikat z Error", () => {
  assert.equal(getErrorMessage(new Error("Niepoprawny plik")), "Niepoprawny plik");
});

test("getErrorMessage obsługuje tekst i nieznany typ bez rzucania błędu", () => {
  assert.equal(getErrorMessage("Błąd tekstowy"), "Błąd tekstowy");
  assert.equal(getErrorMessage({ code: 500 }, "Awaria importu"), "Awaria importu");
  assert.equal(getErrorMessage(null, "Awaria importu"), "Awaria importu");
});

