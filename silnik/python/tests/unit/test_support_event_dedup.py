from __future__ import annotations

from investment_tax_engine.app.canonical_tax_input_adapter import (
    deduplicate_support_events,
    _is_support_record,
)


def _support(
    event_id: str,
    kind: str,
    *,
    parser: str = "json",
    filename: str = "api.json",
    date: str | None = "2025-11-14",
    amount: str = "-5.37",
    currency: str = "USD",
    ticker: str = "",
):
    return {
        "event_id": event_id,
        "event_kind": kind,
        "source": {"parser": parser, "filename": filename},
        "identity": {},
        "instrument": {"ticker": ticker},
        "date": {"datetime": date} if date else {},
        "amounts": {"amount": amount, "currency": currency},
        "raw": {"raw_payload": {"Kwota": amount, "waluta": currency}},
    }


def test_the_same_charge_in_two_files_is_counted_once():
    """Odsetki wystepuja i w Ruchach gotowki, i w tabeli tradernet."""
    kept, dropped, undated = deduplicate_support_events(
        [
            _support("e1", "interest", parser="cash_flows_xlsx", filename="Ruchy_gotowki.xlsx"),
            _support("e2", "interest", parser="broker_transactions_xlsx", filename="tradernet.xlsx"),
        ]
    )

    assert len(kept) == 1
    assert len(dropped) == 1
    assert undated == []


def test_more_reliable_source_wins():
    kept, _, _ = deduplicate_support_events(
        [
            _support("e1", "commission", parser="broker_report_json", filename="broker_report.json"),
            _support("e2", "commission", parser="json", filename="api.json"),
        ]
    )

    assert [event["event_id"] for event in kept] == ["e2"]


def test_same_amount_on_different_days_stays_separate():
    """Dwie prowizje po tyle samo, ale z roznych dni, to dwa osobne koszty."""
    kept, dropped, _ = deduplicate_support_events(
        [
            _support("e1", "commission", date="2025-11-14"),
            _support("e2", "commission", date="2025-11-15"),
        ]
    )

    assert len(kept) == 2
    assert dropped == []


def test_same_day_different_instruments_stay_separate():
    kept, _, _ = deduplicate_support_events(
        [
            _support("e1", "commission", ticker="NBIS.US"),
            _support("e2", "commission", ticker="FRHC.US"),
        ]
    )

    assert len(kept) == 2


def test_records_without_a_date_are_reported_separately_not_merged():
    """Bez daty nie ma kursu NBP, wiec zapis nie moze wejsc do rozliczenia.

    Nie wolno go tez scalic: klucz zwinalby sie po samej kwocie i skasowal
    prawdziwe koszty z roznych dni. Ma zostac policzony i zaraportowany.
    """
    kept, dropped, undated = deduplicate_support_events(
        [
            _support("e1", "commission", date=None, amount="11.95", currency="EUR"),
            _support("e2", "commission", date=None, amount="11.95", currency="EUR"),
        ]
    )

    assert kept == []
    assert dropped == []
    assert len(undated) == 2, "oba zapisy musza zostac zgloszone, zaden nie moze zniknac"


def test_tax_relevant_kinds_are_recognised():
    for kind in ("commission", "interest", "dividend", "fx", "cash_movement", "corporate_action", "stock_award"):
        assert _is_support_record(_support("e", kind)) is True, kind


def test_control_and_metric_kinds_are_not_tax_events():
    for kind in ("position_snapshot", "analytics", "nbp_rate", "tariff_evidence", "trade"):
        assert _is_support_record(_support("e", kind)) is False, kind


def test_record_needing_review_is_not_consumed():
    event = _support("e", "commission")
    event["status"] = {"needs_review": True}

    assert _is_support_record(event) is False


def test_record_without_any_amount_is_not_consumed():
    event = _support("e", "commission", amount="0")
    event["amounts"] = {"currency": "USD"}

    assert _is_support_record(event) is False


def test_same_charge_labelled_differently_across_files_is_counted_once():
    """Naliczenie za ujemne saldo bywa 'interest' w wyciagu i 'commission' w raporcie."""
    kept, dropped, _ = deduplicate_support_events(
        [
            {
                **_support("e1", "interest", parser="broker_transactions_xlsx", filename="tradernet.xlsx"),
                "raw": {"raw_payload": {"Komentarz": "Fee for negative cash balance USD, rate 0.049315"}},
            },
            {
                **_support("e2", "commission", parser="broker_report_json", filename="broker_report.json"),
                "raw": {"raw_payload": {"Komentarz": "Fee for negative cash balance USD, rate 0.049315"}},
            },
        ]
    )

    assert len(kept) == 1
    assert len(dropped) == 1
    assert kept[0]["event_id"] == "e1", "wygrywa zrodlo o wyzszej wiarygodnosci"


def test_opposite_sign_conventions_describe_the_same_charge():
    """Raport brokera zapisuje oplate dodatnio, wyciag gotowkowy ujemnie."""
    positive = _support("e1", "commission", parser="broker_report_json", amount="5.43")
    negative = _support("e2", "commission", parser="broker_transactions_xlsx", amount="-5.43")

    kept, dropped, _ = deduplicate_support_events([positive, negative])

    assert len(kept) == 1
    assert len(dropped) == 1
    assert kept[0]["amounts"]["amount"] == "-5.43", "zachowany ma byc zapis ze znakiem kosztu"


def test_different_precision_of_the_same_amount_is_one_record():
    kept, _, _ = deduplicate_support_events(
        [
            _support("e1", "commission", parser="json", amount="-5.40"),
            _support("e2", "commission", parser="cash_flows_xlsx", amount="-5.4"),
        ]
    )

    assert len(kept) == 1
