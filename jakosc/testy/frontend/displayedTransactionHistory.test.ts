import test from "node:test";
import assert from "node:assert/strict";

import type { EngineEditableRecord, EngineHistoryRow, PrivateCashFxViewRow } from "../../../aplikacje/web/src/invest_analyzer/hooks/useTaxEngineRun.ts";
import { classifyTransactionHistoryGroup, getVisibleTransactionHistoryFilterOptions } from "../../../aplikacje/web/src/invest_analyzer/services/transactionHistoryGrouping.ts";
import * as displayedHistoryModule from "../../../aplikacje/web/src/invest_analyzer/services/displayedTransactionHistory.ts";
import {
  buildDisplayedTransactionHistoryRows,
  formatDisplayDateTime,
  formatMoney,
  formatQuantity,
  getDisplayedHistoryRowPresentation,
  getHistoryInstrumentDisplay,
  getVisibleHistoryDefenseStatusFilterOptions,
  getVisibleHistoryTaxImpactFilterOptions,
  matchesHistoryDefenseStatusFilter,
  matchesHistoryTaxImpactFilter,
} from "../../../aplikacje/web/src/invest_analyzer/services/displayedTransactionHistory.ts";

function engineRow(overrides: Partial<EngineHistoryRow> = {}): EngineHistoryRow {
  return {
    row_id: "trade-1",
    parent_row_id: null,
    row_kind: "BANK_TRANSFER",
    display_date: "2026-04-24T10:00:00.000Z",
    transaction_id: "bank-transfer-1",
    ticker: "USD",
    logical_world: "cashflow",
    details: { event_kind: "BANK_TRANSFER" },
    ...overrides,
  };
}

function fxRow(overrides: Partial<PrivateCashFxViewRow> = {}): PrivateCashFxViewRow {
  return {
    row_id: "fx-view-1",
    source_event_id: "source-1",
    use_reference: "use-1",
    currency: "USD",
    quantity: "100.50",
    source_fx_rate: "3.98",
    use_fx_rate: "4.07",
    pnl_pln: "9.05",
    source_date: "2026-04-24T10:00:00.000Z",
    use_date: "2026-04-24T12:00:00.000Z",
    note: "FX conversion",
    ...overrides,
  };
}

function editableRecord(overrides: Partial<EngineEditableRecord> = {}): EngineEditableRecord {
  return {
    base_record_id: "bank-transfer-1",
    manual_record_id: "bank-transfer-1",
    record_type: "EVENT",
    overlay_status: "ORIGINAL",
    deleted: false,
    original_values: {},
    current_values: {},
    modified_fields: [],
    validation_state: {
      is_valid: true,
      status: "VALID",
      errors: [],
      warnings: [],
    },
    diffs: [],
    ...overrides,
  };
}

test("buildDisplayedTransactionHistoryRows scala wiersze silnika i private_cash_fx_view", () => {
  const rows = buildDisplayedTransactionHistoryRows({
    engineHistoryRows: [engineRow()],
    privateCashFxViewRows: [fxRow()],
    editableRecords: [],
  });

  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.row_id, "trade-1");
  assert.equal(rows[1]?.row_kind, "PRIVATE_CASH_FX");
  assert.equal(rows[1]?.logical_world, "private_cash_fx");
  assert.equal(rows[1]?.read_only, true);
  assert.equal(rows[1]?.transaction_id, "use-1");
  assert.equal(rows[1]?.details?.ui_row_source, "private_cash_fx_view");
  assert.equal(classifyTransactionHistoryGroup(rows[1]!), "fx");
});

test("widoczne grupy filtrowe są liczone z finalnego widoku historii", () => {
  const rows = buildDisplayedTransactionHistoryRows({
    engineHistoryRows: [engineRow()],
    privateCashFxViewRows: [fxRow()],
    editableRecords: [],
  });

  assert.deepEqual(
    getVisibleTransactionHistoryFilterOptions(rows).map((option) => option.label),
    ["Wszystkie", "Transfery", "Przewalutowania"],
  );
});

test("editable_records nadają wierszowi możliwość edycji", () => {
  const rows = buildDisplayedTransactionHistoryRows({
    engineHistoryRows: [engineRow()],
    privateCashFxViewRows: [fxRow()],
    editableRecords: [editableRecord()],
  });

  assert.equal(rows[0]?.read_only, false);
  assert.equal(rows[0]?.details?.can_edit, true);
  assert.equal(rows[0]?.details?.edit_record_id, "bank-transfer-1");
  assert.equal(rows[1]?.details?.can_edit, false);
});

test("formatter daty nie pokazuje fałszywej godziny 00:00 dla date-only", () => {
  assert.equal(formatDisplayDateTime("2026-04-20T15:42:11"), "20.04.2026 15:42");
  assert.equal(formatDisplayDateTime("2026-04-20"), "20.04.2026");
});

test("formattery ilości i kwot usuwają zbędne zera i trzymają polski format", () => {
  assert.equal(formatQuantity("20.00000000"), "20");
  assert.equal(formatQuantity("0.12500000"), "0,125");
  assert.equal(formatMoney("3156.00", "USD"), "3 156,00 USD");
  assert.equal(formatMoney("46891.93", "PLN"), "46 891,93 PLN");
});

test("LONG-TERM nie zastępuje nazwy instrumentu w historii", () => {
  const rowWithName = engineRow({
    row_kind: "FEE",
    ticker: "LONG-TERM",
    transaction_id: "103226707",
    details: {
      event_kind: "MATURITY",
      instrument_name: "DGT4017.AUG25",
    },
  });
  assert.equal(getHistoryInstrumentDisplay(rowWithName).primary, "DGT4017.AUG25");

  const rowWithoutName = engineRow({
    row_kind: "FEE",
    ticker: "LONG-TERM",
    transaction_id: "103226708",
    details: { event_kind: "MATURITY" },
  });
  assert.equal(getHistoryInstrumentDisplay(rowWithoutName).primary, "Instrument długoterminowy");
  assert.equal(getHistoryInstrumentDisplay(rowWithoutName).secondary, "103226708");
});

test("buildDisplayedTransactionHistoryRows przenosi manifest źródła, konflikty i wpływ podatkowy do szybkiego podglądu", () => {
  const rows = buildDisplayedTransactionHistoryRows({
    engineHistoryRows: [
      engineRow({
        source_manifest_id: "file:broker_report",
        conflict_count: 2,
        tax_impact_label: "Koszt wpływa na scenariusz aggressive_user",
        details: {
          source_record_id: "3582135977",
          source_manifest_id: "file:broker_report",
          conflict_count: 2,
          tax_impact_label: "Koszt wpływa na scenariusz aggressive_user",
        },
      }),
    ],
    privateCashFxViewRows: [],
    editableRecords: [editableRecord()],
  });

  assert.equal(rows[0].source_manifest_id, "file:broker_report");
  assert.equal(rows[0].conflict_count, 2);
  assert.equal(rows[0].tax_impact_label, "Koszt wpływa na scenariusz aggressive_user");
  assert.equal(rows[0].details?.source_manifest_id, "file:broker_report");
  assert.match(String(rows[0].details?.search_text), /file:broker_report/);
  assert.match(String(rows[0].details?.search_text), /koszt wpływa/);
});

test("prezentacja wpływu podatkowego odróżnia techniczne rekordy od edytowalności", () => {
  const rows = buildDisplayedTransactionHistoryRows({
    engineHistoryRows: [
      engineRow({
        row_kind: "CASH_MOVEMENT",
        logical_world: "diagnostic_only",
        tax_impact_label: "Widoczne w historii, bez automatycznego wpływu na PIT",
        details: {
          event_kind: "CASH_MOVEMENT",
          tax_impact_kind: "TECHNICAL_ONLY",
        },
      }),
    ],
    privateCashFxViewRows: [],
    editableRecords: [editableRecord()],
  });

  const presentation = getDisplayedHistoryRowPresentation(rows[0]!);

  assert.equal(presentation.taxImpactKind, "TECHNICAL_ONLY");
  assert.equal(presentation.isTechnicalOnly, true);
  assert.equal(presentation.statusLabel, "Techniczne");
  assert.equal(presentation.editabilityLabel, "Można edytować");
  assert.equal(rows[0]?.details?.ui_status, "Techniczne");
  assert.equal(rows[0]?.details?.editability_label, "Można edytować");
});

test("widoczne filtry wpływu na PIT są liczone z finalnej projekcji historii", () => {
  const rows = buildDisplayedTransactionHistoryRows({
    engineHistoryRows: [
      engineRow({
        row_id: "trade-1",
        row_kind: "TRADE",
        transaction_id: "trade-1",
        side: "BUY",
        logical_world: "equity_tax",
        tax_impact_label: "Transakcja wpływa na rozliczenie PIT",
      }),
      engineRow({
        row_id: "fee-1",
        row_kind: "NEGATIVE_CASH_FEE",
        transaction_id: "fee-1",
        logical_world: "financing_costs",
        tax_impact_label: "Koszt wpływa na scenariusze podatkowe",
        details: { cost_bucket: "NEGATIVE_BALANCE_INTEREST" },
      }),
      engineRow({
        row_id: "cash-1",
        row_kind: "BLOCK",
        transaction_id: "cash-1",
        logical_world: "diagnostic_only",
        tax_impact_label: "Widoczne w historii, bez automatycznego wpływu na PIT",
      }),
      engineRow({
        row_id: "review-1",
        row_kind: "REVIEW_REQUIRED",
        transaction_id: "review-1",
        logical_world: "diagnostic_only",
        tax_impact_label: "Wymaga klasyfikacji wpływu podatkowego",
      }),
    ],
    privateCashFxViewRows: [],
    editableRecords: [],
  });

  assert.deepEqual(
    getVisibleHistoryTaxImpactFilterOptions(rows).map((option) => option.label),
    ["Wszystkie", "Liczone w PIT", "Koszty/scenariusze", "Techniczne", "Do sprawdzenia"],
  );
  assert.equal(matchesHistoryTaxImpactFilter(rows[0]!, "pit_counted"), true);
  assert.equal(matchesHistoryTaxImpactFilter(rows[1]!, "scenario_cost"), true);
  assert.equal(matchesHistoryTaxImpactFilter(rows[2]!, "technical"), true);
  assert.equal(matchesHistoryTaxImpactFilter(rows[3]!, "review"), true);
});

test("filtry statusu dowodowego rozdzielają kompletne, braki i pozycje do sprawdzenia", () => {
  const rows = buildDisplayedTransactionHistoryRows({
    engineHistoryRows: [
      engineRow({
        row_id: "complete-1",
        row_kind: "TRADE",
        transaction_id: "complete-1",
        defense_status: "complete",
      }),
      engineRow({
        row_id: "evidence-1",
        row_kind: "NEGATIVE_CASH_FEE",
        transaction_id: "evidence-1",
        defense_status: "needs_user_evidence",
      }),
      engineRow({
        row_id: "missing-1",
        row_kind: "PRIVATE_CASH_FX",
        transaction_id: "missing-1",
        defense_status: "missing_link",
      }),
      engineRow({
        row_id: "risk-1",
        row_kind: "PRIVATE_CASH_FX",
        transaction_id: "risk-1",
        defense_status: "high_risk_review",
      }),
      engineRow({
        row_id: "unknown-1",
        row_kind: "CASH_MOVEMENT",
        transaction_id: "unknown-1",
      }),
    ],
    privateCashFxViewRows: [],
    editableRecords: [],
  });

  assert.deepEqual(
    getVisibleHistoryDefenseStatusFilterOptions(rows).map((option) => option.label),
    ["Wszystkie", "Kompletne", "Wymaga dowodu", "Brak powiązania", "Wysokie ryzyko", "Bez statusu"],
  );
  assert.equal(matchesHistoryDefenseStatusFilter(rows[0]!, "complete"), true);
  assert.equal(matchesHistoryDefenseStatusFilter(rows[1]!, "needs_user_evidence"), true);
  assert.equal(matchesHistoryDefenseStatusFilter(rows[2]!, "missing_link"), true);
  assert.equal(matchesHistoryDefenseStatusFilter(rows[3]!, "high_risk_review"), true);
  assert.equal(matchesHistoryDefenseStatusFilter(rows[4]!, "unknown"), true);
});

test("tryby historii rozdzielają pracę podatkową, dowodową i techniczną", () => {
  const rows = buildDisplayedTransactionHistoryRows({
    engineHistoryRows: [
      engineRow({
        row_id: "trade-1",
        row_kind: "TRADE",
        transaction_id: "trade-1",
        logical_world: "equity_tax",
      }),
      engineRow({
        row_id: "fee-1",
        row_kind: "NEGATIVE_CASH_FEE",
        transaction_id: "fee-1",
        details: { cost_bucket: "NEGATIVE_BALANCE_INTEREST" },
      }),
      engineRow({
        row_id: "technical-1",
        row_kind: "BLOCK",
        transaction_id: "technical-1",
        logical_world: "diagnostic_only",
      }),
      engineRow({
        row_id: "fx-1",
        row_kind: "PRIVATE_CASH_FX",
        transaction_id: "fx-1",
        logical_world: "private_cash_fx",
      }),
      engineRow({
        row_id: "evidence-1",
        row_kind: "PRIVATE_CASH_FX",
        transaction_id: "evidence-1",
        defense_status: "missing_link",
        missing_evidence_count: 1,
      }),
    ],
    privateCashFxViewRows: [],
    editableRecords: [],
  });

  const moduleWithModes = displayedHistoryModule as typeof displayedHistoryModule & {
    matchesHistoryViewMode?: (row: EngineHistoryRow, mode: string) => boolean;
    getVisibleHistoryViewModeOptions?: (rows: EngineHistoryRow[]) => Array<{ id: string; label: string }>;
  };

  assert.equal(typeof moduleWithModes.matchesHistoryViewMode, "function");
  assert.equal(typeof moduleWithModes.getVisibleHistoryViewModeOptions, "function");
  assert.deepEqual(
    moduleWithModes.getVisibleHistoryViewModeOptions(rows).map((option) => option.label),
    ["Inwestycyjne", "Koszty i opłaty", "Gotówka/FX", "Podatkowo", "Dowodowo", "Technicznie", "Wszystkie ze storage", "Do naprawy"],
  );
  assert.deepEqual(
    rows.filter((row) => moduleWithModes.matchesHistoryViewMode!(row, "investment")).map((row) => row.row_id),
    ["trade-1", "fee-1"],
  );
  assert.deepEqual(
    rows.filter((row) => moduleWithModes.matchesHistoryViewMode!(row, "costs")).map((row) => row.row_id),
    ["fee-1"],
  );
  assert.deepEqual(
    rows.filter((row) => moduleWithModes.matchesHistoryViewMode!(row, "cash_fx")).map((row) => row.row_id),
    ["fx-1"],
  );
  assert.deepEqual(
    rows.filter((row) => moduleWithModes.matchesHistoryViewMode!(row, "evidence")).map((row) => row.row_id),
    ["evidence-1"],
  );
  assert.deepEqual(
    rows.filter((row) => moduleWithModes.matchesHistoryViewMode!(row, "technical")).map((row) => row.row_id),
    ["technical-1", "fx-1"],
  );
  assert.deepEqual(
    rows.filter((row) => moduleWithModes.matchesHistoryViewMode!(row, "fix")).map((row) => row.row_id),
    ["evidence-1"],
  );
});


test("formatMoney: wartość z samych spacji to brak kwoty, nie zero", () => {
  // `String(" ").replace(/\s/g, "")` daje "", a `Number("")` to 0 - kwota,
  // ktorej silnik nie podal, pokazywala sie jako "0,00 PLN".
  assert.equal(formatMoney("   ", "PLN"), "-");
  assert.equal(formatMoney("", "PLN"), "-");
  assert.equal(formatMoney(null, "PLN"), "-");
  assert.equal(formatMoney("1 234,56", "PLN"), "1 234,56 PLN");
});

test("sama data jest datą kalendarzową, a grosze zaokrąglane połówką w górę (A33)", () => {
  // Niezależnie od strefy czasowej komputera 1 stycznia nie staje się 31 grudnia.
  assert.equal(formatDisplayDateTime("2025-01-01"), "01.01.2025");
  assert.equal(formatMoney("1.005", "USD"), "1,01 USD");
  assert.equal(formatMoney("4.015", "PLN"), "4,02 PLN");
  assert.equal(formatMoney("-1234.5", "PLN"), "-1 234,50 PLN");
});
