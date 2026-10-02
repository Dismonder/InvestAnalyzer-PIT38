from __future__ import annotations

from decimal import Decimal

import pandas as pd

from investment_tax_engine.models.core import CanonicalEvent
from investment_tax_engine.tax.dividends_engine import build_dividend_views


def make_event(event_id: str, kind: str, date: str, amount: str) -> CanonicalEvent:
    return CanonicalEvent(
        event_id=event_id,
        event_kind=kind,
        symbol="NVDA.US",
        linked_trade_id=None,
        amount=Decimal(amount),
        currency="USD",
        effective_at=pd.Timestamp(date),
        comment=None,
        source_name="BROKER_JSON",
        source_priority=70,
        source_record_id=event_id,
        tax_event_date=pd.Timestamp(date),
        amount_pln=(Decimal(amount) * Decimal("4.00")).quantize(Decimal("0.01")),
        logical_world="equity_tax",
        country="US",
    )


def test_dividend_withholding_tax_matches_symbol_country_and_date_window():
    dividend = make_event("DIV-APR", "DIVIDEND", "2026-04-03", "10.00")
    matching_tax = make_event("TAX-APR", "TAX", "2026-04-03", "-1.50")
    stale_tax = make_event("TAX-JAN", "TAX", "2026-01-03", "-9.99")

    dividends_view, foreign_tax_view = build_dividend_views([dividend, matching_tax, stale_tax])

    assert len(dividends_view) == 1
    assert dividends_view[0]["withholding_tax_foreign"] == "1.50"
    assert dividends_view[0]["withholding_tax_pln"] == "6.00"
    assert {row["event_id"] for row in foreign_tax_view} == {"TAX-APR", "TAX-JAN"}


def test_one_withholding_tax_is_not_credited_to_two_dividends():
    """Bez wylacznosci ten sam podatek pojawial sie przy kazdej wyplacie w oknie."""
    first = make_event("DIV-1", "DIVIDEND", "2026-04-01", "10.00")
    second = make_event("DIV-2", "DIVIDEND", "2026-04-10", "10.00")
    tax = make_event("TAX-1", "TAX", "2026-04-02", "-1.50")

    dividends_view, foreign_tax_view = build_dividend_views([first, second, tax])

    by_id = {row["event_id"]: row for row in dividends_view}
    assert by_id["DIV-1"]["withholding_tax_foreign"] == "1.50"
    assert by_id["DIV-2"]["withholding_tax_foreign"] == "0.00"
    assert foreign_tax_view[0]["matched_dividend_event_id"] == "DIV-1"


def test_withholding_tax_goes_to_the_nearest_dividend():
    first = make_event("DIV-EARLY", "DIVIDEND", "2026-04-01", "10.00")
    second = make_event("DIV-LATE", "DIVIDEND", "2026-04-12", "10.00")
    tax = make_event("TAX-1", "TAX", "2026-04-11", "-1.50")

    dividends_view, _ = build_dividend_views([first, second, tax])

    by_id = {row["event_id"]: row for row in dividends_view}
    assert by_id["DIV-LATE"]["withholding_tax_foreign"] == "1.50"
    assert by_id["DIV-EARLY"]["withholding_tax_foreign"] == "0.00"


def test_undated_withholding_tax_does_not_attach_to_every_dividend():
    """Podatek bez daty pasowal wczesniej do wszystkich wyplat tego waloru."""
    first = make_event("DIV-1", "DIVIDEND", "2026-04-01", "10.00")
    second = make_event("DIV-2", "DIVIDEND", "2026-09-01", "10.00")
    undated_tax = make_event("TAX-UNDATED", "TAX", "2026-04-02", "-1.50")
    undated_tax.tax_event_date = None
    undated_tax.effective_at = None

    dividends_view, foreign_tax_view = build_dividend_views([first, second, undated_tax])

    assert [row["withholding_tax_foreign"] for row in dividends_view] == ["0.00", "0.00"]
    assert foreign_tax_view[0]["matched_dividend_event_id"] is None
    assert foreign_tax_view[0]["source_tax_foreign"] == "1.50", "nieprzypisany podatek nadal musi byc widoczny"


def test_undated_withholding_tax_attaches_when_there_is_only_one_dividend():
    dividend = make_event("DIV-ONLY", "DIVIDEND", "2026-04-01", "10.00")
    undated_tax = make_event("TAX-UNDATED", "TAX", "2026-04-02", "-1.50")
    undated_tax.tax_event_date = None
    undated_tax.effective_at = None

    dividends_view, _ = build_dividend_views([dividend, undated_tax])

    assert dividends_view[0]["withholding_tax_foreign"] == "1.50"


def test_two_taxes_for_one_dividend_are_summed():
    dividend = make_event("DIV-1", "DIVIDEND", "2026-04-01", "10.00")
    first_tax = make_event("TAX-A", "TAX", "2026-04-01", "-1.00")
    second_tax = make_event("TAX-B", "TAX", "2026-04-02", "-0.50")

    dividends_view, _ = build_dividend_views([dividend, first_tax, second_tax])

    assert dividends_view[0]["withholding_tax_foreign"] == "1.50"
    assert dividends_view[0]["withholding_tax_event_ids"] == ["TAX-A", "TAX-B"]


def test_withholding_refund_reduces_paid_tax_and_never_makes_it_negative():
    dividend = make_event("DIV", "DIVIDEND", "2026-04-01", "100.00")
    withheld = make_event("TAX", "TAX", "2026-04-01", "-20.00")
    refund = make_event("REFUND", "TAX", "2026-08-02", "5.00")

    dividends, taxes = build_dividend_views([dividend, withheld, refund])

    assert dividends[0]["withholding_tax_foreign"] == "15.00"
    assert dividends[0]["withholding_tax_pln"] == "60.00"
    assert [row["source_tax_foreign"] for row in taxes] == ["20.00", "-5.00"]

    excess_refund = make_event("EXCESS", "TAX", "2026-04-03", "30.00")
    dividends, taxes = build_dividend_views([dividend, withheld, excess_refund])
    assert dividends[0]["withholding_tax_foreign"] == "20.00"
    assert taxes[1]["matched_dividend_event_id"] is None


def test_linked_refund_matches_earlier_dividend_not_the_nearest_later_dividend():
    january = make_event("DIV-JAN", "DIVIDEND", "2026-01-10", "100.00")
    january_tax = make_event("TAX-JAN", "TAX", "2026-01-10", "-30.00")
    june = make_event("DIV-JUN", "DIVIDEND", "2026-06-10", "100.00")
    june_tax = make_event("TAX-JUN", "TAX", "2026-06-10", "-15.00")
    january_refund = make_event("REFUND-JAN", "TAX", "2026-06-11", "15.00")
    january_refund.source_links = [{"related_event_id": "DIV-JAN"}]

    dividends, taxes = build_dividend_views([january, january_tax, june, june_tax, january_refund])

    by_id = {row["event_id"]: row for row in dividends}
    assert by_id["DIV-JAN"]["withholding_tax_foreign"] == "15.00"
    assert by_id["DIV-JUN"]["withholding_tax_foreign"] == "15.00"
    by_tax_id = {row["event_id"]: row for row in taxes}
    assert by_tax_id["REFUND-JAN"]["matched_dividend_event_id"] == "DIV-JAN"


def test_refund_listed_before_its_deduction_still_matches_the_right_dividend():
    # Kolejnosc zdarzen z plikow nie musi byc chronologiczna - zwrot podany przed
    # potraceniem nie znajdowal dywidendy, bo liczono tylko juz przypisane potracenia.
    january = make_event("DIV-JAN", "DIVIDEND", "2026-01-10", "100.00")
    january_tax = make_event("TAX-JAN", "TAX", "2026-01-10", "-30.00")
    june = make_event("DIV-JUN", "DIVIDEND", "2026-06-10", "100.00")
    june_tax = make_event("TAX-JUN", "TAX", "2026-06-10", "-15.00")
    january_refund = make_event("REFUND-JAN", "TAX", "2026-06-11", "15.00")
    january_refund.source_links = [{"related_event_id": "DIV-JAN"}]

    dividends, taxes = build_dividend_views([january_refund, june, june_tax, january, january_tax])

    by_id = {row["event_id"]: row for row in dividends}
    assert by_id["DIV-JAN"]["withholding_tax_foreign"] == "15.00"
    assert by_id["DIV-JUN"]["withholding_tax_foreign"] == "15.00"
    assert {row["event_id"]: row for row in taxes}["REFUND-JAN"]["matched_dividend_event_id"] == "DIV-JAN"


def test_undated_refund_is_not_attached_to_the_only_dividend():
    # Zwrot bez daty moze dotyczyc wyplaty z innego roku - nie pomniejsza
    # automatycznie podatku jedynej dywidendy.
    dividend = make_event("DIV", "DIVIDEND", "2026-03-10", "100.00")
    deduction = make_event("TAX", "TAX", "2026-03-10", "-15.00")
    refund = make_event("REFUND", "TAX", "2026-03-10", "5.00")
    refund.tax_event_date = None
    refund.effective_at = None

    dividends, taxes = build_dividend_views([dividend, deduction, refund])

    assert dividends[0]["withholding_tax_foreign"] == "15.00"
    assert {row["event_id"]: row for row in taxes}["REFUND"]["matched_dividend_event_id"] is None


def test_podatek_u_zrodla_po_kursie_dnia_wyplaty_dywidendy_a_nie_ksiegowania():
    """Art. 11a: podatek potracono przy wyplacie dywidendy, broker zaksiegowal go dzien pozniej.

    Kurs z dnia ksiegowania dawal 57 zl zamiast 60 zl w poz. 48.
    """
    dividend = make_event("DIV-JUN", "DIVIDEND", "2026-06-11", "100.00")
    dividend.fx_rate = Decimal("4.00")
    tax = make_event("TAX-JUN", "TAX", "2026-06-12", "-15.00")
    tax.fx_rate = Decimal("3.80")
    tax.amount_pln = Decimal("-57.00")

    dividends_view, foreign_tax_view = build_dividend_views([dividend, tax])

    assert dividends_view[0]["withholding_tax_pln"] == "60.00"
    assert foreign_tax_view[0]["source_tax_pln"] == "60.00"
