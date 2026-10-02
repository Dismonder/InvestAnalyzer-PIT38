from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path

import pytest

from zestaw_wejsciowy import zestaw_wejsciowy

from investment_tax_engine.merge.depo_reconcile import (
    build_supplemental_depo_records,
    reconcile_positions_vs_depo,
)
from investment_tax_engine.models.core import Ledger


# Raport depozytariusza: prawdziwy, gdy jest na dysku, inaczej syntetyczny.
# Wczesniej caly plik byl pomijany bez prywatnego zestawu.
PRIVATE_DEPO_FIXTURE = zestaw_wejsciowy().depo_json
FIXTURE_ROOT = PRIVATE_DEPO_FIXTURE.parent


def load_depo_payload() -> dict:
    return json.loads(PRIVATE_DEPO_FIXTURE.read_text(encoding="utf-8"))


def _rows_of_type(payload, wanted: str) -> list[dict]:
    return [
        row
        for row in payload.get("securities_in_outs", [])
        if str(row.get("type") or "").strip().lower() == wanted
    ]


def test_every_stock_award_becomes_an_event_that_waits_for_a_decision():
    """Walor przyznany nie ma ceny zakupu, wiec silnik nie moze jej zgadnac.

    Test sprawdza regule, a nie konkretne walory: kazdy wiersz `stock_award` z
    raportu ma dac zdarzenie BONUS_CONTEST_SHARE oznaczone do przegladu i zadnej
    transakcji nabycia.
    """
    payload = load_depo_payload()
    award_rows = _rows_of_type(payload, "stock_award")
    assert award_rows, "zestaw wejsciowy musi zawierac przynajmniej jeden walor przyznany"

    trades, events = build_supplemental_depo_records(payload, source_file=str(FIXTURE_ROOT))

    bonus_events = [event for event in events if event.event_kind == "BONUS_CONTEST_SHARE"]
    expected_symbols = {str(row.get("ticker", "")).upper() for row in award_rows}

    assert expected_symbols <= {event.symbol for event in bonus_events}
    assert not any(trade.trade_id.startswith("DEPO-AWARD-") for trade in trades)
    assert all(
        event.grant_tax_status == "REVIEW_REQUIRED"
        for event in bonus_events
        if event.symbol in expected_symbols
    )


def test_every_maturity_becomes_a_sale_with_a_matching_event():
    payload = load_depo_payload()
    maturity_rows = _rows_of_type(payload, "maturity")
    assert maturity_rows, "zestaw wejsciowy musi zawierac przynajmniej jeden wykup"

    trades, events = build_supplemental_depo_records(payload, source_file=str(FIXTURE_ROOT))

    expected_symbols = {str(row.get("ticker", "")).upper() for row in maturity_rows}
    maturity_symbols = {trade.symbol for trade in trades if trade.trade_id.startswith("DEPO-MATURITY-")}
    event_symbols = {event.symbol for event in events if event.event_kind == "MATURITY"}

    assert expected_symbols <= maturity_symbols
    assert expected_symbols <= event_symbols


def test_depo_reconciliation_emits_position_mismatch_for_missing_ledger_positions():
    payload = load_depo_payload()
    ledger = Ledger()

    rows = reconcile_positions_vs_depo(ledger, payload, aggregate_tolerance=Decimal("0.00000001"))

    # Ksiega jest pusta, wiec kazda niezerowa pozycja z raportu musi sie
    # rozjechac. Test sprawdza regule, a nie konkretny walor.
    expected = {
        str(row.get("ticker") or "").upper()
        for row in payload.get("securities_flows_json", [])
        if str(row.get("quantity_at_end") or "0") not in {"0", "0.0", ""}
    }
    assert expected, "zestaw wejsciowy musi miec pozycje na koniec okresu"

    assert rows
    reported = {issue.scope_id for issue in ledger.issues if issue.code == "DEPO_POSITION_MISMATCH"}
    assert expected <= reported, f"brak zgloszenia dla: {sorted(expected - reported)}"
