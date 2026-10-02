import test from "node:test";
import assert from "node:assert/strict";

import {
  getLastBusinessDayBefore,
  isPolishBusinessDay,
} from "../../../aplikacje/web/src/shared/kalendarzPl.ts";

test("swieta ruchome sa liczone z daty Wielkanocy, takze po 2026 r.", () => {
  // Wielkanoc 2027: 28 marca. Poniedzialek Wielkanocny 29.03, Boze Cialo 27.05.
  assert.equal(isPolishBusinessDay("2027-03-29"), false);
  assert.equal(isPolishBusinessDay("2027-05-27"), false);
  assert.equal(isPolishBusinessDay("2027-03-30"), true);
  // Dotychczasowa tabela 2022-2026 musi dawac to samo.
  for (const dzien of ["2022-04-18", "2022-06-16", "2023-04-10", "2023-06-08", "2024-04-01", "2024-05-30", "2025-04-21", "2025-06-19", "2026-04-06", "2026-06-04"]) {
    assert.equal(isPolishBusinessDay(dzien), false, dzien);
  }
  // Wczesniej niz tabela: Wielkanoc 2021 - 4 kwietnia.
  assert.equal(isPolishBusinessDay("2021-04-05"), false);
});

test("Wigilia jest dniem wolnym od 2025 r., wczesniej roboczym", () => {
  assert.equal(isPolishBusinessDay("2025-12-24"), false);
  assert.equal(isPolishBusinessDay("2024-12-24"), true);
});

test("T-1 pomija swieta ruchome i Wigilie", () => {
  // Transakcja we wtorek po Poniedzialku Wielkanocnym 2027 -> piatek 26.03.
  assert.equal(getLastBusinessDayBefore("2027-03-30"), "2027-03-26");
  // Transakcja 29.12.2025 (pon) -> 23.12.2025 (wt): 24-26.12 i weekend wolne.
  assert.equal(getLastBusinessDayBefore("2025-12-29"), "2025-12-23");
  assert.equal(getLastBusinessDayBefore("2026-01-02T10:00:00"), "2025-12-31");
});
