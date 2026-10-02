/**
 * Awaria przebiegu silnika ma dotrzec do uzytkownika jako zdanie z CLI
 * (komunikat i wskazowka), a nie jako traceback Pythona ze sciezkami plikow.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { opisAwariiSilnika } from "../../../aplikacje/web/src/server/createInvestAnalyzerServer.ts";

test("opis awarii z CLI: komunikat, wskazowka i rodzaj bledu", () => {
  const stdout = JSON.stringify({
    status: "ERROR",
    error: {
      code: "BladDanychWejsciowych",
      message: "Strata za 2025: kwota straty 'pięćset' nie jest liczbą - wpisz np. 1234,56.",
      hint: "Popraw ten wpis w ustawieniach podatkowych i przelicz ponownie.",
    },
  });
  assert.deepEqual(opisAwariiSilnika(`ostrzezenie z biblioteki\n${stdout}\n`), {
    code: "BladDanychWejsciowych",
    message: "Strata za 2025: kwota straty 'pięćset' nie jest liczbą - wpisz np. 1234,56.",
    hint: "Popraw ten wpis w ustawieniach podatkowych i przelicz ponownie.",
  });
});

test("bez opisu z CLI zostaje dotychczasowe zachowanie", () => {
  assert.equal(opisAwariiSilnika(""), null);
  assert.equal(opisAwariiSilnika("Traceback (most recent call last):"), null);
  assert.equal(opisAwariiSilnika(JSON.stringify({ status: "OK" })), null);
  assert.equal(opisAwariiSilnika(JSON.stringify({ status: "ERROR", error: { message: "  " } })), null);
});
