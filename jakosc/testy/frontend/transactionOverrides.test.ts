import test from "node:test";
import assert from "node:assert/strict";

import {
  bruttoAutomatycznePoZmianie,
  collectModifiedFields,
  czyBruttoZIloczynu,
  updateTradeFieldValues,
  validateEditableRecordValues,
} from "../../../aplikacje/web/src/invest_analyzer/services/transactionOverrides.ts";

test("collectModifiedFields returns only fields changed by the override layer", () => {
  const modified = collectModifiedFields(
    {
      quantity: "10",
      commission: "1.20",
      comment: "oryginal",
    },
    {
      quantity: "12",
      commission: "1.20",
      comment: "korekta",
    },
  );

  assert.deepEqual(modified, ["comment", "quantity"]);
});

test("validateEditableRecordValues blocks invalid trade values with Polish errors", () => {
  const result = validateEditableRecordValues("TRADE", {
    date: "",
    symbol: "NBIS.US",
    side: "BUY",
    quantity: "-1",
    price: "12.10",
    gross_amount: "121.00",
    trade_currency: "USD",
    commission: "-0.50",
    commission_currency: "USD",
  });

  assert.equal(result.isValid, false);
  assert.ok(result.errors.includes("Data jest wymagana."));
  assert.ok(result.errors.includes("Ilość dla transakcji kupna lub sprzedaży musi być większa od zera."));
  assert.ok(result.errors.includes("Prowizja nie może być ujemna."));
});

test("validateEditableRecordValues accepts a complete bonus contest share", () => {
  const result = validateEditableRecordValues("BONUS_CONTEST_SHARE", {
    date: "2025-03-01",
    symbol: "PTON.US",
    quantity: "1",
    grant_market_value: "12.50",
    currency: "USD",
    promotion_basis: "Kampania promocyjna",
  });

  assert.equal(result.isValid, true);
  assert.deepEqual(result.errors, []);
});

test("walidacja ostrzega, gdy kwota brutto nie zgadza się z ilością i ceną", () => {
  const result = validateEditableRecordValues("TRADE", {
    date: "2025-03-01",
    symbol: "AAPL.US",
    side: "BUY",
    quantity: "10",
    price: "12.00",
    gross_amount: "100.00",
    trade_currency: "USD",
    commission: "0",
    commission_currency: "USD",
  });

  assert.equal(result.isValid, true);
  assert.ok(result.warnings.some((warning) => warning.includes("Silnik rozliczy kwotę brutto")));
});

test("zmiana ilości lub ceny przelicza zgodną kwotę brutto", () => {
  const initial = { quantity: "10", price: "10", gross_amount: "100" };
  const changedQuantity = updateTradeFieldValues(initial, "quantity", "20");
  assert.equal(changedQuantity.gross_amount, "200");
  assert.equal(updateTradeFieldValues(changedQuantity, "price", "6").gross_amount, "120");
  assert.equal(initial.gross_amount, "100");

  // Ta sama tolerancja co w walidacji pozwala rozpoznać zaokrąglone brutto.
  assert.equal(updateTradeFieldValues({ ...initial, gross_amount: "100.01" }, "price", "6").gross_amount, "60");
});

test("ręczna kwota brutto pozostaje bez zmian przy korekcie ilości lub ceny", () => {
  const initial = { quantity: "10", price: "10", gross_amount: "105" };
  assert.equal(updateTradeFieldValues(initial, "quantity", "20").gross_amount, "105");
  assert.equal(updateTradeFieldValues(initial, "price", "6").gross_amount, "105");
});

test("przeliczenie brutto nie pokazuje artefaktu zmiennoprzecinkowego", () => {
  const values = { quantity: "0,1", price: "2", gross_amount: "0,2" };
  assert.equal(updateTradeFieldValues(values, "price", "3").gross_amount, "0.3");
});

test("waluta prowizji podąża za transakcją tylko gdy była taka sama lub pusta", () => {
  const initial = { trade_currency: "USD", commission_currency: "USD" };
  assert.equal(updateTradeFieldValues(initial, "trade_currency", "EUR").commission_currency, "EUR");
  assert.equal(updateTradeFieldValues({ ...initial, commission_currency: "" }, "trade_currency", "EUR").commission_currency, "EUR");
  assert.equal(updateTradeFieldValues({ ...initial, commission_currency: "GBP" }, "trade_currency", "EUR").commission_currency, "GBP");
});


test("brutto dalej podąża za iloczynem po skasowaniu i ponownym wpisaniu ilości", () => {
  // Pole ilości bywa w trakcie pisania puste - ocena po poprzedniej wartości
  // gubiła przeliczanie po pierwszym skasowaniu cyfry.
  let values: Record<string, string | null> = { quantity: "10", price: "10", gross_amount: "100" };
  let automatyczne = czyBruttoZIloczynu(values);
  for (const wpis of ["1", "", "2", "20"]) {
    values = updateTradeFieldValues(values, "quantity", wpis, automatyczne);
  }
  assert.equal(values.gross_amount, "200");

  // Własna kwota wpisana przez użytkownika wyłącza przeliczanie.
  values = updateTradeFieldValues(values, "gross_amount", "250", automatyczne);
  automatyczne = bruttoAutomatycznePoZmianie(automatyczne, "gross_amount", "250");
  assert.equal(automatyczne, false);
  assert.equal(updateTradeFieldValues(values, "quantity", "30", automatyczne).gross_amount, "250");

  // Nowy wpis z pustą kwotą uzupełnia ją sam.
  assert.equal(czyBruttoZIloczynu({ quantity: "", price: "", gross_amount: "" }), true);
});

test("własne brutto równe iloczynowi zostaje własne - zmiana ilości go nie nadpisze", () => {
  let values: Record<string, string | null> = { quantity: "10", price: "10", gross_amount: "100" };
  let automatyczne = czyBruttoZIloczynu(values);
  values = updateTradeFieldValues(values, "gross_amount", "100", automatyczne);
  automatyczne = bruttoAutomatycznePoZmianie(automatyczne, "gross_amount", "100");
  assert.equal(automatyczne, false);
  assert.equal(updateTradeFieldValues(values, "quantity", "20", automatyczne).gross_amount, "100");

  // Wyczyszczenie pola przywraca przeliczanie.
  assert.equal(bruttoAutomatycznePoZmianie(false, "gross_amount", " "), true);
  // Zmiana innego pola nie zmienia stanu.
  assert.equal(bruttoAutomatycznePoZmianie(false, "quantity", "5"), false);
});
