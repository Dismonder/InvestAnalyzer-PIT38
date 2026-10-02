import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDepositBalanceSeries,
  selectExternalCashMovements,
} from "../../../aplikacje/web/src/invest_analyzer/services/dashboardData.ts";
import type { EngineHistoryRow } from "../../../aplikacje/web/src/invest_analyzer/hooks/useTaxEngineRun.ts";

function row(overrides: Partial<EngineHistoryRow>): EngineHistoryRow {
  return {
    row_id: overrides.row_id || "row-1",
    parent_row_id: null,
    row_kind: "BANK_TRANSFER",
    display_date: "2025-01-21 11:00:00",
    amount_pln: "1000.00",
    ...overrides,
  } as EngineHistoryRow;
}

test("buildDepositBalanceSeries zwraca pustą serię, gdy silnik nie ma historii", () => {
  assert.deepEqual(buildDepositBalanceSeries(undefined, 2025), []);
  assert.deepEqual(buildDepositBalanceSeries([], 2025), []);
});

test("buildDepositBalanceSeries kumuluje wpłaty i wypłaty w kolejności dat", () => {
  const series = buildDepositBalanceSeries(
    [
      row({ row_id: "a", display_date: "2025-01-21 11:00:00", amount_pln: "43501.43" }),
      row({ row_id: "b", display_date: "2025-02-26 11:00:00", amount_pln: "6929.23" }),
      row({ row_id: "c", display_date: "2025-12-23 15:40:20", amount_pln: "-27590.42" }),
    ],
    2025,
  );

  assert.deepEqual(series, [
    { date: "2025-01-21", balancePln: 43501.43 },
    { date: "2025-02-26", balancePln: 50430.66 },
    { date: "2025-12-23", balancePln: 22840.24 },
  ]);
});

test("buildDepositBalanceSeries liczy tylko przepływy własnych środków", () => {
  const series = buildDepositBalanceSeries(
    [
      row({ row_id: "a", amount_pln: "1000.00" }),
      row({ row_id: "b", row_kind: "TRADE", amount_pln: "99999.00" }),
      row({ row_id: "c", row_kind: "TRADE_FEE", amount_pln: "-12.00" }),
      row({ row_id: "d", row_kind: "WITHDRAWAL", display_date: "2025-03-01", amount_pln: "-250.00" }),
    ],
    2025,
  );

  assert.deepEqual(series, [
    { date: "2025-01-21", balancePln: 1000 },
    { date: "2025-03-01", balancePln: 750 },
  ]);
});

test("buildDepositBalanceSeries pomija inne lata i wiersze bez daty", () => {
  const series = buildDepositBalanceSeries(
    [
      row({ row_id: "a", display_date: "2024-06-01", amount_pln: "500.00" }),
      row({ row_id: "b", display_date: null, amount_pln: "500.00" }),
      row({ row_id: "c", display_date: "2025-06-01", amount_pln: "500.00" }),
    ],
    2025,
  );

  assert.deepEqual(series, [{ date: "2025-06-01", balancePln: 500 }]);
});

test("buildDepositBalanceSeries łączy kilka przepływów z tego samego dnia w jeden punkt", () => {
  const series = buildDepositBalanceSeries(
    [
      row({ row_id: "a", display_date: "2025-01-21 11:00:00", amount_pln: "10527.68" }),
      row({ row_id: "b", row_kind: "WITHDRAWAL", display_date: "2025-01-21 13:55:52", amount_pln: "-1000.00" }),
    ],
    2025,
  );

  assert.deepEqual(series, [{ date: "2025-01-21", balancePln: 9527.68 }]);
});


test("przelew między własnymi subkontami nie jest wpłatą", () => {
  // W danych użytkownika para -4132,10 i +3987,50 PLN przeliczyła się po różnych
  // kursach, więc do salda wpłat wnosiła fikcyjne -144,60 PLN.
  const series = buildDepositBalanceSeries(
    [
      row({ row_id: "a", display_date: "2025-01-21", amount_pln: "43501.43" }),
      row({ row_id: "b", row_kind: "INTERNAL_TRANSFER", display_date: "2025-01-21", amount_pln: "-4132.10" }),
      row({ row_id: "c", row_kind: "INTERNAL_TRANSFER", display_date: "2025-02-20", amount_pln: "3987.50" }),
    ],
    2025,
  );

  assert.deepEqual(series, [{ date: "2025-01-21", balancePln: 43501.43 }]);
});

test("wykres obsługuje też DEPOSIT, WITHDRAWAL i CASH_MOVEMENT", () => {
  const series = buildDepositBalanceSeries(
    [
      row({ row_id: "a", row_kind: "DEPOSIT", display_date: "2025-03-01", amount_pln: "1000.00" }),
      row({ row_id: "b", row_kind: "WITHDRAWAL", display_date: "2025-04-01", amount_pln: "-250.00" }),
      row({ row_id: "c", row_kind: "CASH_MOVEMENT", display_date: "2025-05-01", amount_pln: "50.00" }),
    ],
    2025,
  );

  assert.deepEqual(series, [
    { date: "2025-03-01", balancePln: 1000 },
    { date: "2025-04-01", balancePln: 750 },
    { date: "2025-05-01", balancePln: 800 },
  ]);
});

test("kafelek i wykres czytają ten sam zbiór wierszy", () => {
  const rows = [
    row({ row_id: "a", display_date: "2025-01-21", amount_pln: "43501.43" }),
    row({ row_id: "b", row_kind: "INTERNAL_TRANSFER", display_date: "2025-01-21", amount_pln: "-4132.10" }),
    row({ row_id: "c", display_date: "2025-12-23", amount_pln: "-27590.42" }),
  ];

  const movements = selectExternalCashMovements(rows, 2025);
  const paidIn = movements.filter((m) => m.amountPln > 0).reduce((sum, m) => sum + m.amountPln, 0);
  const series = buildDepositBalanceSeries(rows, 2025);
  const finalBalance = series[series.length - 1].balancePln;

  assert.equal(paidIn, 43501.43, "kafelek: suma wpłat");
  assert.equal(finalBalance, 15911.01, "wykres: saldo po wypłacie");
  assert.equal(Math.round((paidIn - 27590.42) * 100) / 100, finalBalance, "obie liczby muszą się domykać");
});

test("kwota z separatorem tysięcy nie staje się cicho zerem", () => {
  const series = buildDepositBalanceSeries(
    [row({ row_id: "a", display_date: "2025-01-21", amount_pln: "1,234,567.89" })],
    2025,
  );

  assert.deepEqual(series, [{ date: "2025-01-21", balancePln: 1234567.89 }]);
});
