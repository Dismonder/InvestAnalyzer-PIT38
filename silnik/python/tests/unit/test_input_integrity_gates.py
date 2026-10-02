from __future__ import annotations

import pytest

from investment_tax_engine.app.engine import InvestmentTaxEngine
from investment_tax_engine.models.core import EngineConfig
from investment_tax_engine.storage.transaction_intelligence import build_canonical_tax_input
from investment_tax_engine.validation.quality_gates import build_quality_report


@pytest.mark.parametrize(
    ("instrument", "operation", "quantity", "date", "price", "currency", "blocked"),
    [
        ("ABC.US", "sell", 2, None, 10, "USD", True),
        ("ABC.US", "buy", 2, "2025-01-02", None, "USD", True),
        ("ABC.US", "sell", 2, "2025-01-02", 10, None, True),
        (None, "sell", 2, "2025-01-02", 10, None, False),
        (None, None, None, "2025-01-02", 10, "USD", False),
    ],
)
def test_only_plausible_incomplete_trade_blocks(instrument, operation, quantity, date, price, currency, blocked):
    event = {
        "event_kind": "trade",
        "source": {"filename": "transactions.json"},
        "date": {"trade_date": date},
        "instrument": {"ticker": instrument},
        "amounts": {"quantity": quantity, "price": price, "currency": currency},
        "raw": {"raw_payload": {"operation": operation}},
        "status": {"normalized": True, "needs_review": False},
    }
    summary = build_canonical_tax_input({"normalized_events": [event]})["summary"]
    issues = InvestmentTaxEngine._canonical_input_integrity_issues({"canonical_tax_input_summary": summary})
    report = build_quality_report(issues)

    assert summary["incompleteRecordCount"] == 1
    assert summary["blockingIncompleteRecordCount"] == int(blocked)
    assert report.filing_ready is not blocked
    assert ("INCOMPLETE_TRANSACTION_SKIPPED" in [issue.code for issue in report.blocking_issues]) is blocked
    assert "transactions.json: 1" in issues[0].message
    assert any(reason in issues[0].message for reason in (
        "missing_tax_event_date", "missing_price_or_amount", "missing_currency",
        "missing_instrument", "missing_buy_sell_operation",
    ))


def test_unreadable_source_enters_blocking_gate():
    issues = InvestmentTaxEngine._canonical_input_integrity_issues({
        "sources_unreadable": [{"filename": "historia_transakcji.json", "error": "invalid JSON"}],
    })
    report = build_quality_report(issues)
    assert [issue.code for issue in report.blocking_issues] == ["SOURCE_INPUT_READ_FAILED"]
    assert report.filing_ready is False


def test_nierozpoznany_split_ma_liste_rekordow_i_blokuje_pakiet():
    event = {
        "event_id": "split-record-42",
        "event_kind": "trade",
        "source": {"filename": "historia.csv"},
        "date": {"trade_date": "2025-01-02"},
        "instrument": {"ticker": "ABC.US"},
        "amounts": {"quantity": "10", "price": "0", "currency": "USD"},
        "raw": {"raw_payload": {"operation": "reverse_split"}},
        "status": {"normalized": True, "needs_review": False},
    }
    summary = build_canonical_tax_input({"normalized_events": [event]})["summary"]
    issues = InvestmentTaxEngine._canonical_input_integrity_issues({"canonical_tax_input_summary": summary})
    report = build_quality_report(issues)

    assert report.filing_ready is False
    issue = next(issue for issue in report.blocking_issues if issue.code == "INCOMPLETE_TRANSACTION_SKIPPED")
    assert issue.details["unrecognized_operation_records"] == [{
        "source": "historia.csv",
        "record_id": "split-record-42",
        "operation_code": "reverse_split",
        "ticker": "ABC.US",
        "quantity": "10",
    }]
    assert "Split/odwrotny split: popraw ilości ręcznie" in issue.message


def test_kanoniczna_i_zwykla_sciezka_akceptuja_kody_kupna_sprzedazy():
    for operation in ("1", "2", "buy", "sell", "b", "s", "purchase", "kupno", "sprzedaż"):
        event = {
            "event_id": f"trade-{operation}",
            "event_kind": "trade",
            "source": {"filename": "syntetyczne.csv"},
            "date": {"trade_date": "2025-01-02"},
            "instrument": {"ticker": "ABC.US"},
            "amounts": {"quantity": "1", "price": "10", "currency": "USD"},
            "raw": {"raw_payload": {"operation": operation}},
            "status": {"normalized": True, "needs_review": False},
        }
        summary = build_canonical_tax_input({"normalized_events": [event]})["summary"]
        assert summary["engineReadyRecordCount"] == 1, operation
        assert summary["blockingIncompleteRecordCount"] == 0, operation


def test_zwykla_sciezka_blokuje_pelna_transakcje_bez_strony_lecz_pomija_snapshot():
    engine = InvestmentTaxEngine(EngineConfig())
    complete = engine.normalize([{
        "source": "API_JSON_FULL",
        "source_file": "syntetyczne.json",
        "source_sheet": "",
        "rows": [{
            "id": "blank-side-trade", "instr_nm": "ABC.US", "q": "2",
            "p": "10", "v": "20", "curr_c": "USD", "date": "2025-01-02",
        }],
    }])
    snapshot = engine.normalize([{
        "source": "API_JSON_FULL",
        "source_file": "syntetyczne.json",
        "source_sheet": "",
        "rows": [{"id": "position-snapshot", "instr_nm": "ABC.US", "q": "2", "p": "0", "v": "0", "curr_c": "USD"}],
    }])

    assert [issue.code for issue in engine._canonical_input_integrity_issues(complete.metadata)] == [
        "INCOMPLETE_TRANSACTION_SKIPPED"
    ]
    assert engine._canonical_input_integrity_issues(snapshot.metadata) == []
