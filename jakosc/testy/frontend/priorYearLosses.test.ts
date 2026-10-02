import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTaxEngineRequest,
  readPriorYearLossEntries,
  savePriorYearLossEntries,
  readCryptoCostsForYear,
  readLegacyCryptoCosts,
  saveCryptoCostsForYear,
  firstUnusedPriorLossYear,
  isPriorLossYearAvailable,
  type PriorYearLossEntry,
} from "../../../aplikacje/web/src/invest_analyzer/services/taxEngineConfig.ts";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

test("straty z lat ubieglych przechodza do zadania silnika", () => {
  const storage = memoryStorage();
  const entries: PriorYearLossEntry[] = [
    { id: "l1", taxYear: 2024, amountPln: "200000.00", accepted: true },
  ];
  savePriorYearLossEntries(storage, entries);

  const request = buildTaxEngineRequest(2026, storage);

  assert.equal(request.priorYearLosses?.length, 1);
  assert.equal(request.priorYearLosses?.[0].taxYear, 2024);
  assert.equal(request.priorYearLosses?.[0].amountPln, "200000.00");
});

test("zapisane straty daja sie odczytac z powrotem", () => {
  const storage = memoryStorage();
  savePriorYearLossEntries(storage, [
    { id: "l1", taxYear: 2023, amountPln: "1000.00" },
    { id: "l2", taxYear: 2024, amountPln: "2000.00" },
  ]);

  const restored = readPriorYearLossEntries(storage);

  assert.equal(restored.length, 2);
  assert.deepEqual(
    restored.map((entry) => entry.taxYear),
    [2023, 2024],
  );
});

test("pozycje bez kwoty nie trafiaja do silnika", () => {
  const storage = memoryStorage();
  savePriorYearLossEntries(storage, [
    { id: "l1", taxYear: 2024, amountPln: "" },
    { id: "l2", taxYear: 2024, amountPln: "0" },
    { id: "l3", taxYear: 2024, amountPln: "500.00" },
  ]);

  const request = buildTaxEngineRequest(2026, storage);

  assert.equal(request.priorYearLosses?.length, 1);
  assert.equal(request.priorYearLosses?.[0].amountPln, "500.00");
});

test("strata wpisana po polsku (przecinek, spacje) trafia do silnika zamiast znikac", () => {
  const storage = memoryStorage();
  savePriorYearLossEntries(storage, [
    { id: "l1", taxYear: 2022, amountPln: "1234,56" },
    { id: "l2", taxYear: 2023, amountPln: "12 345,67", remainingPln: "1 000,50" },
    { id: "l3", taxYear: 2024, amountPln: "0,00" },
    { id: "l4", taxYear: 2025, amountPln: "-500" },
  ]);

  const straty = buildTaxEngineRequest(2026, storage).priorYearLosses ?? [];

  assert.deepEqual(straty.map((wpis) => [wpis.taxYear, wpis.amountPln]), [
    [2022, "1234.56"],
    [2023, "12345.67"],
    // Nieczytelny wpis nie znika po cichu - silnik zatrzyma przebieg z komunikatem.
    [2025, "-500"],
  ]);
  assert.equal(straty[1].remainingPln, "1000.50");
});

test("uszkodzony zapis nie wywraca budowania zadania", () => {
  const storage = memoryStorage();
  storage.setItem("priorYearLossEntries", "{to nie jest json");

  assert.deepEqual(readPriorYearLossEntries(storage), []);
  assert.deepEqual(buildTaxEngineRequest(2026, storage).priorYearLosses, []);
});

test("brak zapisanych strat daje puste zadanie, nie undefined", () => {
  const request = buildTaxEngineRequest(2026, memoryStorage());

  assert.deepEqual(request.priorYearLosses, []);
});

test("saldo starszej straty trafia do silnika bez zastępowania kwotą pierwotną", () => {
  const storage = memoryStorage();
  savePriorYearLossEntries(storage, [
    { id: "l1", taxYear: 2024, amountPln: "1000.00", remainingPln: "400.00" },
  ]);
  assert.equal(buildTaxEngineRequest(2026, storage).priorYearLosses?.[0].remainingPln, "400.00");
});

test("koszt krypto jest przypisany tylko do roku, a stary globalny wpis wymaga migracji", () => {
  const storage = memoryStorage();
  storage.setItem("cryptoCostsCarriedForward", "1000.00");
  assert.equal(buildTaxEngineRequest(2025, storage).cryptoCostsCarriedForward, undefined);
  assert.equal(buildTaxEngineRequest(2026, storage).cryptoCostsCarriedForward, undefined);
  assert.equal(readLegacyCryptoCosts(storage), "1000.00");
  saveCryptoCostsForYear(storage, 2025, "1000.00");
  saveCryptoCostsForYear(storage, 2026, "400.00");
  assert.equal(readCryptoCostsForYear(storage, 2025), "1000.00");
  assert.equal(buildTaxEngineRequest(2026, storage).cryptoCostsCarriedForward, "400.00");
  assert.equal(buildTaxEngineRequest(2027, storage).cryptoCostsCarriedForward, undefined);
});

test("formularz strat wybiera tylko wolny rok i odmawia duplikatu", () => {
  const losses = [{ id: "l1", taxYear: 2025, amountPln: "1000" }];
  assert.equal(firstUnusedPriorLossYear(losses, 2026), 2024);
  assert.equal(isPriorLossYearAvailable(losses, 2025), false);
  assert.equal(isPriorLossYearAvailable(losses, 2025, 0), true);
  assert.equal(firstUnusedPriorLossYear([2021, 2022, 2023, 2024, 2025].map((year) => ({
    id: String(year), taxYear: year, amountPln: "100",
  })), 2026), undefined);
});
