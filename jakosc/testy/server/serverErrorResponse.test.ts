import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getServerErrorMessage,
  getServerErrorStatus,
  isApplicationMessage,
} from "../../../aplikacje/web/src/server/errorResponse.ts";

test("własne komunikaty walidacyjne przechodzą bez zmian", () => {
  assert.equal(getServerErrorMessage(new Error("Rok podatkowy musi być liczbą całkowitą.")), "Rok podatkowy musi być liczbą całkowitą.");
  assert.equal(getServerErrorMessage("Nazwa pliku zawiera niedozwolony separator."), "Nazwa pliku zawiera niedozwolony separator.");
  assert.equal(getServerErrorMessage({ code: "E_UNKNOWN" }, "Awaria serwera"), "Awaria serwera");
});

test("błąd systemu plików nie oddaje ścieżki z nazwą konta", () => {
  // ENOENT niesie pełną ścieżkę: "stat 'C:\Users\<nazwa>\...'" na Windows,
  // "/home/<nazwa>/..." na Linux. Kontrola musi działać na obu, inaczej test
  // przechodzi tylko na jednym systemie i nie pilnuje niczego na drugim.
  const katalogDomowy = os.homedir();
  const nazwaKonta = path.basename(katalogDomowy);
  let systemError: unknown = null;
  try {
    fs.statSync(path.join(katalogDomowy, "nie-ma-takiego-pliku-investanalyzer.json"));
  } catch (error) {
    systemError = error;
  }

  assert.ok(systemError instanceof Error, "test wymaga prawdziwego błędu systemowego");
  assert.ok(
    (systemError as Error).message.includes(nazwaKonta),
    "kontrola: komunikat systemowy zawiera nazwę konta"
  );

  const sent = getServerErrorMessage(systemError, "Nie udało się odczytać pliku.");

  assert.equal(sent, "Nie udało się odczytać pliku.");
  assert.equal(sent.includes(nazwaKonta), false, "nazwa konta nie może trafić do przeglądarki");
  assert.equal(/Users/i.test(sent), false, "ścieżka windowsowa też nie może wyciec");
});

test("komunikat aplikacji ze ścieżką hosta też jest zasłaniany", () => {
  const leaky = String.raw`Nie udało się odczytać pliku storage: C:\Users\TestUser\dane\raport.json`;

  assert.equal(isApplicationMessage(leaky), false);
  assert.equal(getServerErrorMessage(new Error(leaky)), "Wystąpił błąd serwera.");
});

test("nieznany błąd wewnętrzny nie wycieka treścią", () => {
  assert.equal(
    getServerErrorMessage(new Error("Cannot read properties of undefined (reading 'foo')")),
    "Wystąpił błąd serwera.",
  );
});

test("getServerErrorStatus rozpoznaje błędy walidacji jako 400", () => {
  assert.equal(getServerErrorStatus("Rok podatkowy musi być liczbą całkowitą."), 400);
  assert.equal(getServerErrorStatus("Nazwa pliku zawiera niedozwolony separator."), 400);
  assert.equal(getServerErrorStatus("Nie udało się uruchomić silnika."), 500);
});
