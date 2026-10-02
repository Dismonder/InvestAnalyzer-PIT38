import test from "node:test";
import assert from "node:assert/strict";

import { bladFormularzaTransakcji } from "../../../aplikacje/web/src/portfel/services/formularzTransakcji.ts";

const DZIS = "2026-09-30";

test("formularz transakcji: poprawne dane przechodza, cena 0 dozwolona (akcje bez oplaty)", () => {
  assert.equal(bladFormularzaTransakcji({ date: "2026-09-30", quantity: "1.5", pricePerUnit: "123.45" }, DZIS), null);
  assert.equal(bladFormularzaTransakcji({ date: "2025-01-02", quantity: "10", pricePerUnit: "0" }, DZIS), null);
});

test("formularz transakcji: zerowa, ujemna albo pusta ilosc nie zapisuje sie jako 0", () => {
  for (const quantity of ["0", "-5", "", "abc"]) {
    assert.match(bladFormularzaTransakcji({ date: DZIS, quantity, pricePerUnit: "10" }, DZIS) ?? "", /Ilość/);
  }
});

test("formularz transakcji: ujemna cena i data z przyszlosci sa odrzucane", () => {
  assert.match(bladFormularzaTransakcji({ date: DZIS, quantity: "1", pricePerUnit: "-1" }, DZIS) ?? "", /Cena/);
  assert.match(bladFormularzaTransakcji({ date: "2026-10-01", quantity: "1", pricePerUnit: "1" }, DZIS) ?? "", /przyszłości/);
});
