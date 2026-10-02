from __future__ import annotations

from investment_tax_engine.app.canonical_tax_input_adapter import (
    maturity_sell_events,
    records_awaiting_decision_impact,
    split_engine_events_from_canonical_tax_input,
)


def _record(event_id: str, kind: str, raw: dict, *, filename: str = "broker_raport_api.json", needs_review: bool = False) -> dict:
    return {
        "schema_version": "normalized_event.v1",
        "event_id": event_id,
        "event_kind": kind,
        "canonical_record_status": "ready" if kind == "trade" else "informational",
        "source": {"source_id": f"source:{filename}", "filename": filename, "relative_path": filename, "section": "corporate_actions"},
        "identity": {"trade_id": raw.get("id")},
        "date": {"trade_date": str(raw.get("date") or "")[:10] or None},
        "instrument": {"ticker": raw.get("ticker") or raw.get("instr_nm")},
        "amounts": {"quantity": raw.get("q"), "price": raw.get("p"), "currency": raw.get("currency") or raw.get("curr_c")},
        "status": {"needs_review": needs_review},
        "raw": {"raw_payload": raw},
    }


def _securities_leg(**changes) -> dict:
    return {
        "type": "Termin zapadalno\ufffdci",  # nazwa bywa uszkodzona kodowaniem - liczy sie type_id
        "type_id": "maturity",
        "date": "2026-06-11",
        "ticker": "NOTE1.JUN26",
        "currency": "USD",
        "q_on_ex_date": "3.00000000",
        "amount_per_one": 320.45,
        "comment": "Redemption of securities NOTE1.JUN26 (). Record date 2026-06-10.",
        **changes,
    }


def _cash_leg() -> dict:
    return _securities_leg(q_on_ex_date=None, comment="Redemption of securities (NOTE1.JUN26), record date 2026-06-10.")


def _tax_input(records: list[dict]) -> dict:
    return {"schema_version": "canonical_tax_input.v2", "records": records}


def test_two_legs_of_one_redemption_become_a_single_sell():
    tax_input = _tax_input(
        [
            _record("sec", "position_snapshot", _securities_leg()),
            _record("cash", "position_snapshot", _cash_leg()),
        ]
    )
    sells = maturity_sell_events(tax_input)
    assert len(sells) == 1
    amounts = sells[0]["amounts"]
    assert (amounts["quantity"], amounts["price"], amounts["currency"]) == ("3", "320.45", "USD")
    assert sells[0]["raw"]["raw_payload"]["operation"] == "sell"
    engine_records = split_engine_events_from_canonical_tax_input(tax_input)["engine_records"]
    assert [event["event_id"] for event in engine_records] == [sells[0]["event_id"]]


def test_same_redemption_repeated_in_three_files_is_one_sell():
    tax_input = _tax_input(
        [_record(f"sec-{name}", "position_snapshot", _securities_leg(), filename=name) for name in ("a.json", "b.json", "c.json")]
    )
    assert len(maturity_sell_events(tax_input)) == 1


def test_redemption_without_quantity_is_not_guessed():
    tax_input = _tax_input([_record("cash", "position_snapshot", _cash_leg())])
    assert maturity_sell_events(tax_input) == []


def test_redemption_already_recorded_as_regular_sell_is_not_added_again():
    regular_sell = _record(
        "t1",
        "trade",
        {"id": "T1", "operation": "sell", "instr_nm": "NOTE1.JUN26", "q": "3", "p": "320.45", "curr_c": "USD", "date": "2026-06-12"},
    )
    tax_input = _tax_input([regular_sell, _record("sec", "position_snapshot", _securities_leg())])
    engine_records = split_engine_events_from_canonical_tax_input(tax_input)["engine_records"]
    assert [event["event_id"] for event in engine_records] == ["t1"]


def test_settled_redemption_no_longer_waits_for_user_decision():
    echo = _record("ca", "corporate_action", _cash_leg(), filename="broker_raport_zbliansem.json", needs_review=True)
    other = _record(
        "split", "corporate_action", {"type_id": "split", "date": "2026-03-01", "ticker": "ABC.US", "comment": "Split"}, needs_review=True
    )
    blocking, _ = records_awaiting_decision_impact(_tax_input([_record("sec", "position_snapshot", _securities_leg()), echo, other]), 2026)
    assert blocking == {"corporate_action": 1}


def _review(kind: str, raw: dict, amounts: dict, *, ticker: str | None = None, day: str = "2026-04-03") -> dict:
    record = _record(f"r-{kind}-{amounts}", kind, {**raw, "ticker": ticker, "date": day}, needs_review=True)
    record["amounts"] = amounts
    return record


def test_zero_amount_fee_never_blocks_but_fee_without_amount_still_does():
    zero = _review("commission", {"comment": "Market: currencies"}, {"amount": "0", "currency": "USD"})
    unknown = _review("commission", {"comment": "Market: currencies"}, {"amount": None, "currency": "USD"}, day="2026-04-04")
    blocking, _ = records_awaiting_decision_impact(_tax_input([zero, unknown]), 2026)
    assert blocking == {"commission": 1}


def test_dividend_repeated_as_corporate_action_is_not_a_second_decision():
    settled = _record("div", "dividend", {"ticker": "NVDA.US", "date": "2026-04-03"})
    settled["amounts"] = {"amount": "0.20", "currency": "USD"}
    comment = "Dividends on security (Nvidia Corporation (NVDA.US)), record date 2026-03-11."
    gross = _review("corporate_action", {"comment": comment}, {"amount": "0.20", "currency": "USD"}, ticker="NVDA.US")
    net = _review("corporate_action", {"comment": comment}, {"amount": "0.17", "currency": "USD"}, ticker="NVDA.US")
    orphan = _review("corporate_action", {"comment": comment.replace("NVDA", "AMD")}, {"amount": "1", "currency": "USD"}, ticker="AMD.US")
    blocking, _ = records_awaiting_decision_impact(_tax_input([settled, gross, net, orphan]), 2026)
    assert blocking == {"corporate_action": 1}


def test_separate_sale_of_the_same_quantity_does_not_hide_the_redemption():
    """Zwykla sprzedaz 3 sztuk po cenie rynkowej i wykup kolejnych 3 w tych samych dniach to dwie transakcje.

    Sam walor, ilosc i okno dni uznawaly wykup za echo sprzedazy - przychod z wykupu znikal.
    """
    market_sale = _record(
        "t1",
        "trade",
        {"id": "T1", "operation": "sell", "instr_nm": "NOTE1.JUN26", "q": "3", "p": "301.10", "curr_c": "USD", "date": "2026-06-09"},
    )
    tax_input = _tax_input([market_sale, _record("sec", "position_snapshot", _securities_leg())])
    engine_records = split_engine_events_from_canonical_tax_input(tax_input)["engine_records"]
    assert [event["event_id"] for event in engine_records] == ["t1", maturity_sell_events(tax_input)[0]["event_id"]]


def test_review_item_marks_a_split_as_changing_the_share_count():
    from investment_tax_engine.app.canonical_tax_input_adapter import review_queue

    split = _record(
        "split", "corporate_action", {"type_id": "split", "date": "2026-03-01", "ticker": "ABC.US", "comment": "Split 1:10"}, needs_review=True
    )
    fee = _record(
        "fee", "corporate_action", {"type_id": "fee", "date": "2026-03-02", "ticker": "ABC.US", "comment": "Custody fee"}, needs_review=True
    )
    items = {item["symbol"] + item["date"]: item for item in review_queue(_tax_input([split, fee]), 2026)}
    assert items["ABC.US2026-03-01"]["changes_share_count"] is True
    assert items["ABC.US2026-03-02"]["changes_share_count"] is False


def test_sale_in_another_currency_at_the_same_number_is_not_the_redemption_echo():
    """Ta sama liczba w innej walucie to inna kwota - sprzedaz w EUR nie moze ukryc wykupu w USD."""
    sale_in_eur = _record(
        "t1",
        "trade",
        {"id": "T1", "operation": "sell", "instr_nm": "NOTE1.JUN26", "q": "3", "p": "320.45", "curr_c": "EUR", "date": "2026-06-12"},
    )
    tax_input = _tax_input([sale_in_eur, _record("sec", "position_snapshot", _securities_leg())])
    engine_records = split_engine_events_from_canonical_tax_input(tax_input)["engine_records"]
    assert [event["event_id"] for event in engine_records] == ["t1", maturity_sell_events(tax_input)[0]["event_id"]]
