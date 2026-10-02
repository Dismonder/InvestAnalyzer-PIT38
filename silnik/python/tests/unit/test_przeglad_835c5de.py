from __future__ import annotations

from decimal import Decimal

import pandas as pd

from investment_tax_engine.app.engine import InvestmentTaxEngine
from investment_tax_engine.models.core import CanonicalEvent, EngineConfig, Ledger, MergeResult, CanonicalDataset
from investment_tax_engine.normalize.trades import normalize_api_trade
from investment_tax_engine.tax.dividends_engine import build_dividend_views
from investment_tax_engine.tax.pit38_engine import build_pit38_views
from investment_tax_engine.validation.quality_gates import build_quality_report


def _event(identifier: str, kind: str, amount: str) -> CanonicalEvent:
    return CanonicalEvent(
        event_id=identifier, event_kind=kind, symbol="ABC.US", linked_trade_id=None,
        amount=Decimal(amount), currency="USD", effective_at=pd.Timestamp("2025-05-10"),
        comment=None, source_name="BROKER_JSON", source_priority=70,
        source_record_id=identifier, tax_event_date=pd.Timestamp("2025-05-10"),
        amount_pln=Decimal(amount) * 4, fx_rate=Decimal("4"), country="US",
    )


def _row(**values) -> dict:
    return {"id": "T-1", "Symbol": "ABC.US", "Side": "SELL", "Quantity": 2,
            "Cena": "50.00", "Currency": "USD", "date": "2025-05-10", **values}


def test_wht_30_i_20_przy_dwoch_dywidendach_blokuje_rozne_odliczenia():
    events = [_event("d100", "DIVIDEND", "100"), _event("d200", "DIVIDEND", "200"),
              _event("t30", "TAX", "-30"), _event("t20", "TAX", "-20")]
    merge = MergeResult(ledger=Ledger(events_by_id={event.event_id: event for event in events}),
                        canonical_dataset=CanonicalDataset())
    build_pit38_views(merge, [], EngineConfig(tax_year=2025))
    report = build_quality_report(merge.ledger.issues)
    assert any(issue.code == "DIVIDEND_TAX_PAIRING_AMBIGUOUS" for issue in report.blocking_issues)
    assert not report.filing_ready


def test_wht_w_dwoch_wierszach_moze_trafic_do_jednej_dywidendy():
    first, second = _event("d100", "DIVIDEND", "100"), _event("d200", "DIVIDEND", "200")
    taxes = [_event("t10", "TAX", "-10"), _event("t5", "TAX", "-5")]
    for tax in taxes:
        tax.source_links = [{"related_event_id": "d100"}]
    dividends, _ = build_dividend_views([first, second, *taxes])
    assert {row["event_id"]: row["withholding_tax_foreign"] for row in dividends} == {
        "d100": "15.00", "d200": "0.00"}


def test_dwa_wiersze_wht_bez_ref_nie_sa_sztucznie_rozdzielane():
    events = [_event("d100", "DIVIDEND", "100"), _event("d200", "DIVIDEND", "200"),
              _event("t10", "TAX", "-10"), _event("t5", "TAX", "-5")]
    dividends, taxes = build_dividend_views(events)
    assert all(not tax["pairing_ambiguous"] for tax in taxes)
    assert any(set(row["withholding_tax_event_ids"]) == {"t10", "t5"} for row in dividends)


def test_duza_grupa_wht_blokuje_parowanie():
    events = [_event(f"d{index}", "DIVIDEND", "100") for index in range(7)]
    events.extend(_event(f"t{index}", "TAX", "-1") for index in range(7))
    _, taxes = build_dividend_views(events)
    assert all(tax["pairing_ambiguous"] for tax in taxes)


def test_kwota_netto_po_prowizji_przy_sprzedazy_i_kupnie():
    sell = normalize_api_trade(_row(Amount="98.00", Commission="2.00"))
    buy = normalize_api_trade(_row(Side="BUY", Kwota="102.00", Commission="2.00"))
    assert (sell.gross_amount, sell.certainty_status) == (Decimal("100"), "CERTAIN")
    assert (buy.gross_amount, buy.certainty_status) == (Decimal("100"), "CERTAIN")


def test_zgodna_kwota_ze_starej_kolumny_pozostaje_brutto():
    trade = normalize_api_trade(_row(Kwota="100.00", Commission="2.00"))
    assert (trade.gross_amount, trade.certainty_status) == (Decimal("100"), "CERTAIN")


def test_niewyjasniona_roznica_sprzedazy_blokuje_a_kupna_ostrzega():
    sell = normalize_api_trade(_row(gross_amount="105.00", Commission="1.00"))
    buy = normalize_api_trade(_row(Side="BUY", gross_amount="105.00", Commission="1.00", id="T-2"))
    engine = InvestmentTaxEngine(EngineConfig(tax_year=2025))
    issues = engine._trade_amount_mismatch_issues([sell, buy])
    report = build_quality_report(issues)
    assert [(issue.scope_id, issue.severity) for issue in issues] == [("T-1", "ERROR"), ("T-2", "WARNING")]
    assert all(issue.code == "TRADE_AMOUNT_MISMATCH" for issue in issues)
    assert any(issue.scope_id == "T-1" for issue in report.blocking_issues)
    assert "105.00" in issues[0].message and "100.00" in issues[0].message


def test_lokata_strukturyzowana_uzywa_kwot_brokera_bez_bramki_rozbieznosci():
    buy = normalize_api_trade(_row(id="DEP-BUY", instr_type_c="19", v="9000.00",
                                   Quantity=1, Cena="9020.21", Side="BUY"))
    sell = normalize_api_trade(_row(id="DEP-SELL", instr_type_c="19", v="9579.15",
                                    Quantity=1, Cena="9599.36"))
    engine = InvestmentTaxEngine(EngineConfig(tax_year=2025))
    issues = engine._trade_amount_mismatch_issues([buy, sell])
    assert buy.instrument_class == sell.instrument_class == "STRUCTURED_PRODUCT"
    assert (buy.gross_amount, sell.gross_amount) == (Decimal("9000.00"), Decimal("9579.15"))
    assert buy.amount_mismatch is None and sell.amount_mismatch is None
    assert issues == []
    assert build_quality_report(issues).filing_ready


def test_kwota_po_prowizji_nie_jest_odtwarzana_dla_lokaty():
    sell = normalize_api_trade(_row(instr_type_c="19", Amount="98.00", Commission="2.00"))
    assert sell.instrument_class == "STRUCTURED_PRODUCT"
    assert sell.gross_amount == Decimal("98.00")
    assert sell.amount_mismatch is None
