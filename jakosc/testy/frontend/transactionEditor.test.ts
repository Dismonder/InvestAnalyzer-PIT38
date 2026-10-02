import test from "node:test";
import assert from "node:assert/strict";

import {
  filtrujRekordyEdycyjne,
  mapujRekordEdycyjnySilnika,
} from "../../../aplikacje/web/src/invest_analyzer/services/transactionEditor.ts";

test("mapujRekordEdycyjnySilnika mapuje rekord backendu do warstwy UI bez utraty diffów", () => {
  const rekord = mapujRekordEdycyjnySilnika({
    base_record_id: "488585388",
    manual_record_id: "manual-override-1",
    record_type: "TRADE",
    overlay_status: "MODIFIED",
    deleted: false,
    original_values: {
      symbol: "NBIS.US",
      quantity: "10",
      commission: "1.20",
    },
    current_values: {
      symbol: "NBIS.US",
      quantity: "12",
      commission: "2.50",
    },
    modified_fields: ["commission", "quantity"],
    validation_state: {
      is_valid: true,
      status: "VALID",
      errors: [],
      warnings: [],
    },
    diffs: [
      {
        field_name: "quantity",
        original_value: "10",
        current_value: "12",
      },
      {
        field_name: "commission",
        original_value: "1.20",
        current_value: "2.50",
      },
    ],
    title: "NBIS.US - BUY",
    ticker: "NBIS.US",
    display_date: "2025-01-21T10:00:00.000Z",
    source_name: "API_JSON_FULL",
  });

  assert.equal(rekord.manualRecordId, "manual-override-1");
  assert.equal(rekord.overlayStatus, "MODIFIED");
  assert.deepEqual(rekord.modifiedFields, ["commission", "quantity"]);
  assert.equal(rekord.diffs[0].fieldName, "quantity");
});

test("filtrujRekordyEdycyjne zwraca ukryte i błędne rekordy zgodnie z filtrem", () => {
  const rekordy = [
    mapujRekordEdycyjnySilnika({
      base_record_id: "trade-1",
      manual_record_id: "trade-1",
      record_type: "TRADE",
      overlay_status: "ORIGINAL",
      deleted: false,
      original_values: { symbol: "NBIS.US", date: "2025-01-21" },
      current_values: { symbol: "NBIS.US", date: "2025-01-21" },
      modified_fields: [],
      validation_state: { is_valid: true, status: "VALID", errors: [], warnings: [] },
      diffs: [],
      title: "NBIS.US - BUY",
      ticker: "NBIS.US",
      display_date: "2025-01-21T10:00:00.000Z",
      source_name: "API_JSON_FULL",
    }),
    mapujRekordEdycyjnySilnika({
      base_record_id: "event-1",
      manual_record_id: "manual-trade-2",
      record_type: "TRADE",
      overlay_status: "MODIFIED",
      deleted: false,
      original_values: { symbol: "AAPL.US", date: "2025-01-22", commission: "1.00" },
      current_values: { symbol: "AAPL.US", date: "2025-01-22", commission: "1.50" },
      modified_fields: ["commission"],
      validation_state: { is_valid: true, status: "VALID", errors: [], warnings: [] },
      diffs: [],
      title: "AAPL.US - SELL",
      ticker: "AAPL.US",
      display_date: "2025-01-22T09:00:00.000Z",
      source_name: "USER_OVERRIDE",
    }),
    mapujRekordEdycyjnySilnika({
      base_record_id: "event-1",
      manual_record_id: "manual-event-1",
      record_type: "EVENT",
      overlay_status: "MODIFIED",
      deleted: true,
      original_values: { symbol: "USD", date: "2025-01-22" },
      current_values: { symbol: "USD", date: "2025-01-22" },
      modified_fields: ["deleted"],
      validation_state: { is_valid: true, status: "VALID", errors: [], warnings: [] },
      diffs: [],
      title: "USD - EVENT",
      ticker: "USD",
      display_date: "2025-01-22T10:00:00.000Z",
      source_name: "USER_OVERRIDE",
    }),
    mapujRekordEdycyjnySilnika({
      base_record_id: null,
      manual_record_id: "manual-bonus-1",
      record_type: "BONUS_CONTEST_SHARE",
      overlay_status: "NEW",
      deleted: false,
      original_values: {},
      current_values: { symbol: "PTON.US", date: "2025-01-23" },
      modified_fields: ["symbol"],
      validation_state: {
        is_valid: false,
        status: "INVALID",
        errors: ["Brak danych."],
        warnings: [],
      },
      diffs: [],
      title: "PTON.US - Akcja bonusowa",
      ticker: "PTON.US",
      display_date: "2025-01-23T10:00:00.000Z",
      source_name: "Ręczna korekta użytkownika",
    }),
  ];

  assert.equal(filtrujRekordyEdycyjne(rekordy, { filtr: "ukryte", szukaj: "" }).length, 1);
  assert.equal(filtrujRekordyEdycyjne(rekordy, { filtr: "z_bledami", szukaj: "" }).length, 1);
  assert.equal(filtrujRekordyEdycyjne(rekordy, { filtr: "nowe", szukaj: "" }).length, 1);
  assert.equal(filtrujRekordyEdycyjne(rekordy, { filtr: "zmodyfikowane", szukaj: "" }).length, 1);
});

test("wyszukiwanie w edytorze znajduje rekord po ISIN (A33)", () => {
  const rekord = mapujRekordEdycyjnySilnika({
    base_record_id: "b1",
    manual_record_id: "m1",
    record_type: "TRADE",
    overlay_status: "ORIGINAL",
    deleted: false,
    original_values: { symbol: "NBIS.US", isin: "NL0009805522" },
    current_values: { symbol: "NBIS.US", isin: "NL0009805522" },
    modified_fields: [],
    validation_state: { is_valid: true, status: "VALID", errors: [], warnings: [] },
    diffs: [],
  } as never);
  assert.equal(filtrujRekordyEdycyjne([rekord], { filtr: "wszystkie", szukaj: "nl0009805522" } as never).length, 1);
  assert.equal(filtrujRekordyEdycyjne([rekord], { filtr: "wszystkie", szukaj: "US0000000000" } as never).length, 0);
});
