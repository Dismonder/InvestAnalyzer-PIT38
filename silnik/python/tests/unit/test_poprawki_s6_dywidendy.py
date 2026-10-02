from __future__ import annotations

from decimal import Decimal

import pandas as pd
import pytest

from investment_tax_engine.models.core import CanonicalDataset, CanonicalEvent, EngineConfig, Ledger, MergeResult
from investment_tax_engine.tax.dividends_engine import build_dividend_views
from investment_tax_engine.tax.pit38_engine import build_pit38_views
from investment_tax_engine.validation.quality_gates import build_quality_report


def _event(identifier, kind, amount, date="2026-05-10", account=None, ref=None):
    return CanonicalEvent(
        event_id=identifier, event_kind=kind, symbol="ABC.US", linked_trade_id=None,
        amount=Decimal(amount), currency="USD", effective_at=pd.Timestamp(date),
        comment=None, source_name="BROKER_JSON", source_priority=70,
        source_record_id=identifier, tax_event_date=pd.Timestamp(date),
        amount_pln=Decimal(amount) * 4, fx_rate=Decimal("4"), country="US",
        account_id=account, source_links=[{"related_event_id": ref}] if ref else [],
    )


def _pit(events):
    merge = MergeResult(ledger=Ledger(events_by_id={event.event_id: event for event in events}),
                        canonical_dataset=CanonicalDataset())
    payload = build_pit38_views(merge, [], EngineConfig(tax_year=2026))
    return payload["summary"]["art30a"], build_quality_report(merge.ledger.issues)


@pytest.mark.parametrize("use_account", [False, True])
def test_s6_1_powiazanie_lub_rachunek_przed_najblizsza_data(use_account):
    first = _event("d1", "DIVIDEND", "100", account="A" if use_account else None)
    second = _event("d2", "DIVIDEND", "50", "2026-05-11", "B" if use_account else None)
    tax = _event("t1", "TAX", "-15", "2026-05-11", "A" if use_account else None,
                 None if use_account else "d1")
    _, taxes = build_dividend_views([first, second, tax])
    assert taxes[0]["matched_dividend_event_id"] == "d1"
    amounts, report = _pit([first, second, tax])
    # Art. 30a ust. 9; PIT-38 poz. 48 = 60, poz. 49 = 114 - 60 = 54 zl.
    assert (amounts["foreign_withholding_creditable_pln"], amounts["tax_to_pay_pln"]) == ("60.00", "54.00")
    assert report.filing_ready


def test_s6_1_sprzeczne_powiazanie_i_rachunek_blokuja():
    events = [_event("d1", "DIVIDEND", "100", account="A"),
              _event("d2", "DIVIDEND", "50", "2026-05-11", "B"),
              _event("t1", "TAX", "-15", "2026-05-11", "B", "d1")]
    _, taxes = build_dividend_views(events)
    assert taxes[0]["matched_dividend_event_id"] is None
    assert taxes[0]["pairing_ambiguous"]
    _, report = _pit(events)
    assert not report.filing_ready
    assert any(issue.code == "DIVIDEND_TAX_PAIRING_AMBIGUOUS" for issue in report.blocking_issues)


def test_s6_1_podatek_bez_daty_respektuje_powiazanie():
    events = [_event("d1", "DIVIDEND", "100"), _event("d2", "DIVIDEND", "50"),
              _event("t1", "TAX", "-15", ref="d1")]
    events[-1].tax_event_date = events[-1].effective_at = None
    _, taxes = build_dividend_views(events)
    assert taxes[0]["matched_dividend_event_id"] == "d1"


def test_s6_2_zwrot_ze_sprzecznym_rachunkiem_i_powiazaniem_blokuje():
    events = _refund_events("d1")
    events[0].account_id = "A"
    events[1].account_id = "B"
    events[-1].account_id = "B"
    _, taxes = build_dividend_views(events)
    assert next(row for row in taxes if row["event_id"] == "r1")["pairing_ambiguous"]


@pytest.mark.parametrize("ref, credit, top_up", [("d1", "120.00", "32.00"), ("d2", "100.00", "52.00")])
def test_s6_2_jawny_zwrot_pokazuje_dwa_rozne_dopuszczalne_wyniki(ref, credit, top_up):
    events = _refund_events(ref)
    amounts, report = _pit(events)
    assert (amounts["foreign_withholding_creditable_pln"], amounts["tax_to_pay_pln"]) == (credit, top_up)
    assert report.filing_ready


def _refund_events(ref=None):
    return [_event("d1", "DIVIDEND", "100"), _event("d2", "DIVIDEND", "100"),
            _event("t1", "TAX", "-20", ref="d1"), _event("t2", "TAX", "-15", ref="d2"),
            _event("r1", "TAX", "5", "2026-05-20", ref=ref)]


def test_s6_2_zwrot_bez_powiazania_nie_zgaduje_nadplaty():
    events = _refund_events()
    _, taxes = build_dividend_views(events)
    refund = next(row for row in taxes if row["event_id"] == "r1")
    assert refund["matched_dividend_event_id"] is None
    assert refund["pairing_ambiguous"]
    _, report = _pit(events)
    assert not report.filing_ready
    assert any(issue.code == "DIVIDEND_TAX_PAIRING_AMBIGUOUS" for issue in report.blocking_issues)


def test_s6_4_potracenia_z_roznych_dni_oceniane_lacznie():
    events = [_event("d1", "DIVIDEND", "100"), _event("d2", "DIVIDEND", "100"),
              _event("t1", "TAX", "-15"), _event("t2", "TAX", "-15", "2026-05-11")]
    # Dwa potrącenia do jednej wypłaty: poz. 48 = 60; po jednym do każdej: 120.
    _, report = _pit(events)
    assert not report.filing_ready
    assert any(issue.code == "DIVIDEND_TAX_PAIRING_AMBIGUOUS" for issue in report.blocking_issues)


def test_s6_5_wczesny_zwrot_oceniany_z_pozniejszym_jawnym_zwrotem():
    events = [_event("d1", "DIVIDEND", "100"), _event("d2", "DIVIDEND", "100"),
              _event("t1", "TAX", "-20", ref="d1"), _event("t2", "TAX", "-20", ref="d2"),
              _event("r1", "TAX", "1", "2026-05-20"),
              _event("r2", "TAX", "5", "2026-05-21", ref="d1")]
    # r1 do d1: poz. 48 = 116; r1 do d2: 120. Sam r1 nie zmienia odliczenia.
    _, report = _pit(events)
    assert not report.filing_ready
    assert any(issue.code == "DIVIDEND_TAX_PAIRING_AMBIGUOUS" for issue in report.blocking_issues)


@pytest.mark.parametrize("ref", [None, "d1"])
def test_s6_r3_zwrot_w_dniu_wyplaty_pomniejsza_faktycznie_zaplacony_podatek(ref):
    events = [_event("d1", "DIVIDEND", "100"), _event("t1", "TAX", "-15", ref="d1"),
              _event("r1", "TAX", "5", ref=ref)]
    amounts, report = _pit(events)
    assert (amounts["foreign_withholding_creditable_pln"], amounts["tax_to_pay_pln"]) == ("40.00", "36.00")
    assert report.filing_ready


@pytest.mark.parametrize("ref", [None, "d-old"])
def test_s6_r4_zwrot_do_poprzedniego_roku_nie_trafia_do_nowej_dywidendy(ref):
    events = [_event("d-old", "DIVIDEND", "100", "2025-12-31"),
              _event("t-old", "TAX", "-20", "2025-12-31", ref="d-old"),
              _event("d-new", "DIVIDEND", "100", "2026-01-10"),
              _event("t-new", "TAX", "-15", "2026-01-10", ref="d-new"),
              _event("r-old", "TAX", "5", "2026-01-11", ref=ref)]
    amounts, report = _pit(events)
    assert (amounts["foreign_withholding_creditable_pln"], amounts["tax_to_pay_pln"]) == ("60.00", "16.00")
    # Nie rozstrzygamy sposobu korekty poprzedniego zeznania bez decyzji podatnika.
    assert not report.filing_ready


def test_s6_r5_duza_jednoznaczna_grupa_nie_ma_limitu_kombinacji():
    events = [_event("d1", "DIVIDEND", "100")]
    events.extend(_event(f"t{index}", "TAX", "-1", ref="d1") for index in range(7))
    amounts, report = _pit(events)
    assert amounts["foreign_withholding_creditable_pln"] == "28.00"
    assert report.filing_ready


@pytest.mark.parametrize("conflict", ["symbol", "refs", "late_account", "future_refund", "missing_target", "late_ref"])
def test_r6_c1_c2_jawne_sprzecznosci_nie_znikaja_po_filtrach(conflict):
    events = [_event("d1", "DIVIDEND", "100", account="A"),
              _event("d2", "DIVIDEND", "50", "2026-05-11", "B"),
              _event("t1", "TAX", "-15", "2026-05-11", ref="d1")]
    if conflict == "symbol":
        events[0].symbol = "XYZ.US"
    elif conflict == "refs":
        events[-1].linked_trade_id = "d2"
    elif conflict == "late_account":
        events[-1].account_id = "B"
        events[-1].tax_event_date = events[-1].effective_at = pd.Timestamp("2026-05-30")
    elif conflict == "future_refund":
        events = [_event("d1", "DIVIDEND", "100", "2026-05-11"),
                  _event("t1", "TAX", "-15", "2026-05-11", ref="d1"),
                  _event("r1", "TAX", "5", "2026-05-10", ref="d1")]
    elif conflict == "missing_target":
        events[-1].source_links = [{"related_event_id": "d-missing"}]
    else:
        events[-1].tax_event_date = events[-1].effective_at = pd.Timestamp("2026-05-30")
    _, report = _pit(events)
    assert not report.filing_ready
    assert any(issue.code == "DIVIDEND_TAX_PAIRING_AMBIGUOUS" for issue in report.blocking_issues)


def test_zwrot_nie_blokuje_z_powodu_wczesniej_calkowicie_zwroconego_wht():
    events = [_event("d-old", "DIVIDEND", "100", "2025-12-20"),
              _event("t-old", "TAX", "-15", "2025-12-20", ref="d-old"),
              _event("r-old", "TAX", "15", "2025-12-21", ref="d-old"),
              _event("d-new", "DIVIDEND", "100", "2026-01-10"),
              _event("t-new", "TAX", "-15", "2026-01-10", ref="d-new"),
              _event("r-new", "TAX", "5", "2026-01-11")]
    amounts, report = _pit(events)
    assert amounts["foreign_withholding_creditable_pln"] == "40.00"
    assert report.filing_ready
