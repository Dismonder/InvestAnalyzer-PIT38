from __future__ import annotations

from investment_tax_engine.app.canonical_tax_input_adapter import deduplicate_trade_events


def _event(event_id: str, *, parser: str, filename: str, trade_id, ticker: str = "NBIS.US", raw=None):
    payload = {"instr_nm": ticker, "type": "1", "q": "3", "p": "34.98"}
    if raw:
        payload.update(raw)
    if trade_id is not None:
        payload["id"] = trade_id
    return {
        "event_id": event_id,
        "event_kind": "trade",
        "source": {"parser": parser, "filename": filename},
        "identity": {"trade_id": trade_id},
        "instrument": {"ticker": ticker},
        "amounts": {"quantity": "3", "currency": "USD"},
        "raw": {"raw_payload": payload},
    }


def test_same_broker_trade_in_many_files_is_counted_once():
    """Piec plikow moze opisywac ten sam zestaw transakcji."""
    events = [
        _event("e1", parser="json", filename="pelny_zrzut_api_transakcje.json", trade_id="491018680"),
        _event("e2", parser="legacy_broker_history_json", filename="historia_transakcji.json", trade_id="491018680"),
        _event("e3", parser="broker_transactions_xlsx", filename="Tradesv1.xlsx", trade_id="491018680"),
    ]

    kept, dropped = deduplicate_trade_events(events)

    assert len(kept) == 1
    assert len(dropped) == 2
    assert kept[0]["event_id"] == "e1"


def test_most_reliable_source_wins_regardless_of_input_order():
    events = [
        _event("e3", parser="broker_report_json", filename="broker_report.json", trade_id="491018680"),
        _event("e1", parser="json", filename="pelny_zrzut_api_transakcje.json", trade_id="491018680"),
    ]

    kept, dropped = deduplicate_trade_events(events)

    assert [event["event_id"] for event in kept] == ["e1"]
    assert dropped[0]["parser"] == "broker_report_json"


def test_distinct_broker_trades_are_all_kept():
    events = [
        _event("e1", parser="json", filename="api.json", trade_id="491018680"),
        _event("e2", parser="json", filename="api.json", trade_id="497263870"),
    ]

    kept, _ = deduplicate_trade_events(events)

    assert len(kept) == 2


def test_aggregated_summary_is_dropped_when_individual_trades_exist():
    """Agregat opisuje zbiorczo te same zdarzenia, ktore sa juz zapisane pojedynczo."""
    individual = _event("e1", parser="json", filename="api.json", trade_id="491018680")
    aggregate = _event(
        "e2",
        parser="broker_report_json",
        filename="broker_report.json",
        trade_id=None,
        raw={"id": "Zgrupowano", "date": "Zgrupowano", "short_date": "2025-01-27", "q": "611"},
    )

    kept, dropped = deduplicate_trade_events([individual, aggregate])

    assert [event["event_id"] for event in kept] == ["e1"]
    assert dropped[0]["reason"].startswith("aggregated summary")


def test_aggregated_summary_survives_when_it_is_the_only_record():
    """Bez zapisow pojedynczych agregat jest jedynym sladem tych transakcji."""
    aggregate = _event(
        "e1",
        parser="broker_report_json",
        filename="broker_report.json",
        trade_id=None,
        raw={"id": "Zgrupowano", "date": "Zgrupowano", "short_date": "2025-01-27", "q": "611"},
    )

    kept, dropped = deduplicate_trade_events([aggregate])

    assert [event["event_id"] for event in kept] == ["e1"]
    assert dropped == []


def test_aggregate_for_one_instrument_does_not_drop_aggregate_for_another():
    individual = _event("e1", parser="json", filename="api.json", trade_id="491018680", ticker="NBIS.US")
    other_aggregate = _event(
        "e2",
        parser="broker_report_json",
        filename="broker_report.json",
        trade_id=None,
        ticker="FRHC.US",
        raw={"id": "Zgrupowano", "date": "Zgrupowano", "short_date": "2025-01-21"},
    )

    kept, dropped = deduplicate_trade_events([individual, other_aggregate])

    assert {event["event_id"] for event in kept} == {"e1", "e2"}
    assert dropped == []


def test_records_without_identifier_are_never_silently_merged():
    first = _event("e1", parser="json", filename="api.json", trade_id=None, raw={"q": "3"})
    second = _event("e2", parser="json", filename="api.json", trade_id=None, raw={"q": "7"})

    kept, dropped = deduplicate_trade_events([first, second])

    assert len(kept) == 2
    assert dropped == []


def test_composite_broker_identifier_matches_plain_identifier():
    """Czesc raportow zapisuje identyfikator jako '<trade_id>/<order_id>'."""
    plain = _event("e1", parser="json", filename="api.json", trade_id="488585388")
    composite = _event(
        "e2",
        parser="broker_report_json",
        filename="broker_raport_bezbliansu.json",
        trade_id="488585388/427865477",
    )

    kept, dropped = deduplicate_trade_events([plain, composite])

    assert [event["event_id"] for event in kept] == ["e1"]
    assert len(dropped) == 1


def test_identifier_with_slash_that_is_not_composite_stays_distinct():
    first = _event("e1", parser="json", filename="api.json", trade_id="ABC/1")
    second = _event("e2", parser="json", filename="api.json", trade_id="ABC/2")

    kept, _ = deduplicate_trade_events([first, second])

    assert len(kept) == 2
