import test from "node:test";
import assert from "node:assert/strict";

import type { EngineHistoryRow } from "../../../aplikacje/web/src/invest_analyzer/hooks/useTaxEngineRun.ts";
import {
  TRANSACTION_HISTORY_FILTER_OPTIONS,
  classifyTransactionHistoryGroup,
  getVisibleTransactionHistoryFilterOptions,
  getTransactionHistoryPresentation,
  matchesTransactionHistoryFilter,
} from "../../../aplikacje/web/src/invest_analyzer/services/transactionHistoryGrouping.ts";

function row(
  row_kind: string,
  side?: string | null,
  logical_world?: string | null,
  details?: Record<string, unknown> | null,
) {
  return { row_kind, side, logical_world, details } as Pick<
    EngineHistoryRow,
    "row_kind" | "side" | "logical_world" | "details"
  >;
}

test("transaction history filter labels include the expected Polish groups", () => {
  assert.deepEqual(
    TRANSACTION_HISTORY_FILTER_OPTIONS.map((option) => option.label),
    [
      "Wszystkie",
      "Transakcje",
      "Transfery",
      "Przewalutowania",
      "Koszty przewalutowania",
      "Długoterminowe",
      "Ruchy gotówkowe",
      "Koszty",
      "Dywidendy",
      "Podatki",
      "Akcje bonusowe",
      "Pozostałe",
    ],
  );
});

test("classifies and labels trades", () => {
  assert.equal(classifyTransactionHistoryGroup(row("TRADE", "BUY")), "trade");
  assert.equal(getTransactionHistoryPresentation(row("TRADE", "BUY")).label, "Kupno");
  assert.equal(getTransactionHistoryPresentation(row("TRADE", "SELL")).label, "Sprzedaż");
});

test("classifies and labels cost, bonus, fx, dividend and tax rows", () => {
  assert.equal(classifyTransactionHistoryGroup(row("ALLOCATED_COST")), "cost");
  assert.equal(getTransactionHistoryPresentation(row("ALLOCATED_COST")).label, "Koszt alokowany");

  assert.equal(classifyTransactionHistoryGroup(row("BONUS_CONTEST_SHARE")), "bonus");
  assert.equal(getTransactionHistoryPresentation(row("BONUS_CONTEST_SHARE")).label, "Akcja bonusowa");

  assert.equal(classifyTransactionHistoryGroup(row("FX_CONVERSION_SPREAD_COST")), "fx_cost");
  assert.equal(getTransactionHistoryPresentation(row("FX_CONVERSION_SPREAD_COST")).label, "Koszt przewalutowania");

  assert.equal(classifyTransactionHistoryGroup(row("DIVIDEND_NET")), "dividend");
  assert.equal(getTransactionHistoryPresentation(row("DIVIDEND_NET")).label, "Dywidenda");

  assert.equal(classifyTransactionHistoryGroup(row("FOREIGN_TAX")), "tax");
  assert.equal(getTransactionHistoryPresentation(row("FOREIGN_TAX")).label, "Podatek zagraniczny");
});

test("transfer rows get Polish labels and stay out of silnik math", () => {
  const bankTransferFx = row(
    "BANK_TRANSFER",
    null,
    "private_cash_fx",
    { event_kind: "BANK_TRANSFER", logical_world: "private_cash_fx" },
  );
  assert.equal(classifyTransactionHistoryGroup(bankTransferFx), "transfer");
  assert.equal(getTransactionHistoryPresentation(bankTransferFx).label, "Przelew bankowy");
  assert.equal(matchesTransactionHistoryFilter(bankTransferFx, "transfer"), true);
  assert.equal(matchesTransactionHistoryFilter(bankTransferFx, "other"), false);

  const bankTransfer = row("BANK_TRANSFER", null, "diagnostic_only", { event_kind: "BANK_TRANSFER" });
  assert.equal(classifyTransactionHistoryGroup(bankTransfer), "transfer");
  assert.equal(getTransactionHistoryPresentation(bankTransfer).label, "Przelew bankowy");

  const internalTransfer = row("INTERNAL_TRANSFER", null, "diagnostic_only", { event_kind: "INTERNAL_TRANSFER" });
  assert.equal(classifyTransactionHistoryGroup(internalTransfer), "transfer");
  assert.equal(getTransactionHistoryPresentation(internalTransfer).label, "Transfer wewnętrzny");

  const deposit = row("DEPOSIT", null, "cashflow", { event_kind: "DEPOSIT" });
  assert.equal(classifyTransactionHistoryGroup(deposit), "transfer");
  assert.equal(getTransactionHistoryPresentation(deposit).label, "Wpłata");

  const cashout = row("CASHOUT", null, "cashflow", { event_kind: "CASHOUT" });
  assert.equal(classifyTransactionHistoryGroup(cashout), "transfer");
  assert.equal(getTransactionHistoryPresentation(cashout).label, "Wypłata");

  const fundingFee = row("FUNDING_TRANSFER_FEE", null, "financing_costs", { cost_bucket: "FUNDING_TRANSFER_FEE" });
  assert.equal(classifyTransactionHistoryGroup(fundingFee), "cost");
  assert.equal(getTransactionHistoryPresentation(fundingFee).label, "Prowizja za zasilenie");
});

test("classifies long-term instruments and negative-balance interest with Polish labels", () => {
  const longTerm = {
    row_kind: "FEE",
    side: null,
    logical_world: "cashflow",
    ticker: "DGT4017.AUG25",
    transaction_id: "DEPO-MATURITY-16144337",
    details: { event_kind: "MATURITY" },
  } as Pick<EngineHistoryRow, "row_kind" | "side" | "logical_world" | "details" | "ticker" | "transaction_id">;
  assert.equal(classifyTransactionHistoryGroup(longTerm), "long_term");
  assert.equal(getTransactionHistoryPresentation(longTerm).label, "Wykup długoterminowy");

  const interest = row("FEE", null, "financing_costs", { cost_kind: "NEGATIVE_BALANCE_INTEREST" });
  assert.equal(classifyTransactionHistoryGroup(interest), "cost");
  assert.equal(getTransactionHistoryPresentation(interest).label, "Odsetki");

  const debtRepayment = row("DEBT_REPAYMENT", null, "financing_repayment", { event_kind: "DEBT_REPAYMENT" });
  assert.equal(classifyTransactionHistoryGroup(debtRepayment), "cash_movement");
  assert.equal(getTransactionHistoryPresentation(debtRepayment).label, "Spłata zadłużenia");
});

test("classifies cash-only block and release movements separately from transfers", () => {
  const block = row("BLOCK", null, "cashflow", { event_kind: "BLOCK", message: "Blokada środków" });
  assert.equal(classifyTransactionHistoryGroup(block), "cash_movement");
  assert.equal(getTransactionHistoryPresentation(block).label, "Blokada środków");

  const unblock = row("UNBLOCK", null, "cashflow", { event_kind: "UNBLOCK", message: "Odblokowanie środków" });
  assert.equal(classifyTransactionHistoryGroup(unblock), "cash_movement");
  assert.equal(getTransactionHistoryPresentation(unblock).label, "Odblokowanie środków");

  const reserve = row("CASH_RESERVE", null, "cashflow", { event_kind: "RESERVE", message: "Rezerwacja gotówki T+2" });
  assert.equal(classifyTransactionHistoryGroup(reserve), "cash_movement");
  assert.equal(getTransactionHistoryPresentation(reserve).label, "Rezerwacja środków");
});

test("fallback rows remain in Pozostałe", () => {
  const fallback = row("SOMETHING_ELSE");
  assert.equal(classifyTransactionHistoryGroup(fallback), "other");
  assert.equal(getTransactionHistoryPresentation(fallback).label, "Pozostałe");
  assert.equal(matchesTransactionHistoryFilter(fallback, "other"), true);
  assert.equal(matchesTransactionHistoryFilter(fallback, "tax"), false);
});

test("puste grupy filtrów są ukrywane", () => {
  const visible = getVisibleTransactionHistoryFilterOptions([
    row("TRADE", "BUY"),
    row("ALLOCATED_COST"),
  ]);

  assert.deepEqual(
    visible.map((option) => option.label),
    ["Wszystkie", "Transakcje", "Koszty"],
  );
});

