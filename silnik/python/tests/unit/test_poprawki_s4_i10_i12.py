from __future__ import annotations

from decimal import Decimal
import zipfile

import pandas as pd

from investment_tax_engine.app.canonical_tax_input_adapter import deduplicate_support_events, _event_to_legacy_row
from investment_tax_engine.app.source_resolver import _spreadsheet_source
from investment_tax_engine.normalize.events import normalize_tradernet_event
from investment_tax_engine.normalize.trades import normalize_api_trade
from investment_tax_engine.tax.dividends_engine import build_dividend_views
from investment_tax_engine.tax.pit38_engine import build_pit38_views
from investment_tax_engine.validation.quality_gates import build_quality_report
from investment_tax_engine.models.core import CanonicalEvent, CanonicalDataset, EngineConfig, Ledger, MergeResult


def _support(event_id: str, filename: str, account: str | None) -> dict:
    return {
        "event_id": event_id, "event_kind": "dividend",
        "source": {"parser": "json", "filename": filename},
        "identity": {"account_id": account},
        "date": {"pay_date": "2025-05-10"},
        "amounts": {"amount": "100", "currency": "USD"},
        "instrument": {"ticker": "ABC.US"},
        "raw": {"raw_payload": {"comment": "Dividend ABC"}},
    }


def test_s4_1_rozne_znane_rachunki_bez_dublowania_tego_samego_rachunku():
    events = [_support("a1", "one.json", "A"), _support("b1", "one.json", "B"),
              _support("a2", "one.json", "A"), _support("echo", "two.json", "A")]
    kept, dropped, undated = deduplicate_support_events(events)
    assert {event["event_id"] for event in kept} == {"a1", "b1"}
    assert [event["event_id"] for event in dropped] == ["a2", "echo"]
    assert undated == []
    assert sum(Decimal(event["amounts"]["amount"]) * 4 for event in kept) == 800


def test_s4_1_techniczne_zapisy_z_jednego_pliku_pozostaja_scalone():
    events = [_support("lock", "cash.json", None), _support("unlock", "cash.json", None),
              _support("debit", "cash.json", None)]
    for event, amount in zip(events, ("-25.61", "25.61", "-25.61")):
        event["event_kind"] = "commission"
        event["amounts"].update(amount=amount, currency="PLN")
    kept, dropped, _ = deduplicate_support_events(events)
    assert [event["event_id"] for event in kept] == ["lock"]
    assert len(dropped) == 2


def _div(event_id: str, kind: str, amount: str, account: str | None = None) -> CanonicalEvent:
    event = CanonicalEvent(
        event_id=event_id, event_kind=kind, symbol="ABC.US", linked_trade_id=None,
        amount=Decimal(amount), currency="USD", effective_at=pd.Timestamp("2025-05-10"),
        comment=None, source_name="BROKER_JSON", source_priority=70,
        source_record_id=event_id, tax_event_date=pd.Timestamp("2025-05-10"),
        amount_pln=Decimal(amount) * 4, fx_rate=Decimal("4"), country="US",
    )
    event.account_id = account
    return event


def test_s4_2_parowanie_wht_po_rachunku_i_kwocie():
    events = [_div("d100", "DIVIDEND", "100", "A"), _div("d200", "DIVIDEND", "200", "B"),
              _div("t30", "TAX", "-30", "B"), _div("t15", "TAX", "-15", "A")]
    dividends, taxes = build_dividend_views(events)
    assert {row["event_id"]: row["withholding_tax_foreign"] for row in dividends} == {"d100": "15.00", "d200": "30.00"}
    assert {row["event_id"]: row["matched_dividend_event_id"] for row in taxes} == {"t30": "d200", "t15": "d100"}


def test_s4_2_doplaty_po_poprawnym_sparowaniu_wht():
    events = [_div("d100", "DIVIDEND", "100"), _div("d200", "DIVIDEND", "200"),
              _div("t30", "TAX", "-30"), _div("t15", "TAX", "-15")]
    events[2].source_links = [{"related_event_id": "d200"}]
    events[3].source_links = [{"related_event_id": "d100"}]
    merge = MergeResult(ledger=Ledger(events_by_id={event.event_id: event for event in events}),
                        canonical_dataset=CanonicalDataset())
    payload = build_pit38_views(merge, [], EngineConfig(tax_year=2025))
    assert payload["summary"]["art30a"]["tax_to_pay_pln"] == "48.00"


def test_s4_2_bez_powiazania_roznica_odliczen_blokuje_parowanie():
    events = [_div("d100", "DIVIDEND", "100"), _div("d200", "DIVIDEND", "200"),
              _div("t30", "TAX", "-30"), _div("t15", "TAX", "-15")]
    _, taxes = build_dividend_views(events)
    assert all(row["matched_dividend_event_id"] is None and row["pairing_ambiguous"] for row in taxes)


def test_s4_2_jawny_ref_ma_pierwszenstwo_przed_proporcja():
    first = _div("d100", "DIVIDEND", "100")
    second = _div("d200", "DIVIDEND", "200")
    tax = _div("t15", "TAX", "-15")
    tax.source_links = [{"related_event_id": "d200"}]
    _, taxes = build_dividend_views([first, second, tax])
    assert taxes[0]["matched_dividend_event_id"] == "d200"


def test_s4_2_remis_o_tym_samym_odliczeniu_moze_byc_wybrany():
    events = [_div("d1", "DIVIDEND", "100"), _div("d2", "DIVIDEND", "100"), _div("t", "TAX", "-15")]
    _, taxes = build_dividend_views(events)
    assert taxes[0]["matched_dividend_event_id"] in {"d1", "d2"}
    assert taxes[0]["pairing_ambiguous"] is False


def test_s4_2_remis_blokuje_bramke_jakosci():
    events = [_div("d1", "DIVIDEND", "100"), _div("d2", "DIVIDEND", "200"), _div("t", "TAX", "-30")]
    merge = MergeResult(ledger=Ledger(events_by_id={event.event_id: event for event in events}),
                        canonical_dataset=CanonicalDataset())
    build_pit38_views(merge, [], EngineConfig(tax_year=2025))
    report = build_quality_report(merge.ledger.issues)
    assert any(issue.code == "DIVIDEND_TAX_PAIRING_AMBIGUOUS" for issue in report.blocking_issues)
    assert report.filing_ready is False


def test_s4_2_rachunek_przechodzi_z_wejscia_kanonicznego_do_zdarzenia():
    raw = _support("d", "one.json", "A")
    raw["raw"]["raw_payload"].update({"Rodzaj zlecenia": "Dywidenda", "Data": "2025-05-10",
                                      "Kwota": "100", "waluta": "USD"})
    row = _event_to_legacy_row(raw)
    assert normalize_tradernet_event(row).account_id == "A"


def test_i10_jawna_kwota_brutto_ma_pierwszenstwo_i_rozbieznosc_wymaga_przegladu():
    row = {"Symbol": "ABC.US", "Side": "SELL", "Quantity": 2, "Cena": 50,
           "gross_amount": 105, "Currency": "USD", "date": "2025-05-10", "account": "A"}
    trade = normalize_api_trade(row)
    assert trade.gross_amount == Decimal("105")
    assert trade.certainty_status == "CONDITIONAL"


def test_i12_resolver_sprawdza_zip_przed_otwarciem(tmp_path, monkeypatch):
    path = tmp_path / "trades.xlsx"
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("xl/worksheets/sheet1.xml", b"x" * (17 * 1024 * 1024))
    calls = []
    monkeypatch.setattr(pd, "ExcelFile", lambda *_a, **_kw: calls.append(1))
    source = _spreadsheet_source(path, tmp_path)
    assert calls == []
    assert any("SOURCE_INPUT_TOO_LARGE" in warning for warning in source.warnings)
