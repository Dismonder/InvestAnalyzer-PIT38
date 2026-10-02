"""FIFO osobno dla kazdego rachunku i wedlug godziny zakupu (art. 24 ust. 10 ustawy o PIT).

Wspolna kolejka dla waloru brala do sprzedazy na rachunku B najstarsza partie
z rachunku A, a zakupy z jednego dnia ustawiala wedlug identyfikatora
transakcji zamiast godziny. Oba bledy zmienialy koszt w poz. 23 i podatek.
"""

from __future__ import annotations

from decimal import Decimal

import pandas as pd

from investment_tax_engine.models.core import CanonicalTrade, EngineConfig
from investment_tax_engine.tax.fifo_engine import build_fifo_tax_rows, open_lots_by_symbol, open_lots_detail
from investment_tax_engine.validation.quality_gates import is_blocking_issue


def transakcja(trade_id: str, strona: str, kwota_pln: str, czas: str, rachunek: str | None = None) -> CanonicalTrade:
    chwila = pd.Timestamp(czas)
    kwota = Decimal(kwota_pln)
    return CanonicalTrade(
        trade_id=trade_id,
        order_id=f"O-{trade_id}",
        trade_number=trade_id,
        symbol="NBIS.US",
        isin=None,
        side=strona,
        instrument_type_code="1",
        instrument_class="EQUITY",
        market_id=None,
        quantity=Decimal("1"),
        price=kwota,
        gross_amount=kwota,
        trade_currency="PLN",
        commission=Decimal("0"),
        commission_currency="PLN",
        broker_reported_profit=None,
        executed_at=chwila,
        exchange_time=chwila,
        settlement_date=None,
        confirm_time=None,
        otc=False,
        repo_close=None,
        base_contract_code=None,
        current_position_qty_after_trade=None,
        source_name="API_JSON_FULL",
        source_priority=110,
        source_record_id=trade_id,
        account_id=rachunek,
        tax_event_date=chwila.normalize(),
        buy_total_cost_pln=kwota if strona == "BUY" else None,
        sell_gross_revenue_pln=kwota if strona == "SELL" else None,
        sell_net_revenue_pln=kwota if strona == "SELL" else None,
    )


def test_sprzedaz_na_rachunku_b_bierze_partie_z_rachunku_b():
    zakup_a = transakcja("BUY-A", "BUY", "100", "2025-03-03 10:00", rachunek="A")
    zakup_b = transakcja("BUY-B", "BUY", "200", "2025-03-04 10:00", rachunek="B")
    sprzedaz_b = transakcja("SELL-B", "SELL", "300", "2025-03-05 10:00", rachunek="B")

    wiersze, issues = build_fifo_tax_rows([zakup_a, zakup_b, sprzedaz_b], EngineConfig())

    assert [(issue.code, issue.severity) for issue in issues] == [("FIFO_SPLIT_BY_ACCOUNT", "INFO")]
    assert "…A" in issues[0].message and "…B" in issues[0].message
    assert [(w.buy_trade_id, w.cost_pln) for w in wiersze] == [("BUY-B", Decimal("200.00"))]
    assert [partia["origin_trade_id"] for partia in open_lots_detail([zakup_a, zakup_b, sprzedaz_b], EngineConfig())] == ["BUY-A"]
    assert open_lots_by_symbol([zakup_a, zakup_b], EngineConfig()) == {"NBIS.US": Decimal("2")}


def test_ten_sam_rachunek_zapisany_inaczej_nie_rozdziela_kolejki():
    zakup_1 = transakcja("BUY-1", "BUY", "100", "2025-03-03 10:00", rachunek="pl 12-34")
    zakup_2 = transakcja("BUY-2", "BUY", "200", "2025-03-04 10:00", rachunek="PL1234")
    sprzedaz = transakcja("SELL-1", "SELL", "300", "2025-03-05 10:00", rachunek="PL 1234")

    wiersze, issues = build_fifo_tax_rows([zakup_1, zakup_2, sprzedaz], EngineConfig())

    assert not issues
    assert [w.buy_trade_id for w in wiersze] == ["BUY-1"]


def test_zapis_bez_rachunku_zostawia_wspolna_kolejke_i_ostrzega():
    """Transakcji bez rachunku nie da sie przypisac - zgadywanie zmienialoby koszt po cichu."""
    zakup_a = transakcja("BUY-A", "BUY", "100", "2025-03-03 10:00", rachunek="A")
    zakup_b = transakcja("BUY-B", "BUY", "200", "2025-03-04 10:00", rachunek="B")
    zakup_reczny = transakcja("BUY-R", "BUY", "150", "2025-03-04 11:00", rachunek=None)
    sprzedaz_b = transakcja("SELL-B", "SELL", "300", "2025-03-05 10:00", rachunek="B")

    wiersze, issues = build_fifo_tax_rows([zakup_a, zakup_b, zakup_reczny, sprzedaz_b], EngineConfig())

    assert [w.buy_trade_id for w in wiersze] == ["BUY-A"]
    assert [issue.code for issue in issues] == ["FIFO_ACCOUNT_UNRESOLVED"]
    assert issues[0].severity == "WARNING"
    assert not is_blocking_issue(issues[0])


def test_sprzedaz_bez_partii_na_swoim_rachunku_wraca_do_wspolnej_kolejki():
    """Ten sam rachunek zapisany w dwoch zrodlach inaczej albo przeniesienie papierow.

    Kolejka rachunku dawala sprzedaz z zerowym kosztem i blokade, ktorej
    uzytkownik nie moze usunac - rachunku transakcji nie da sie zmienic.
    """
    zakup = transakcja("BUY-1", "BUY", "100", "2025-03-03 10:00", rachunek="FREEDOM24_1")
    sprzedaz = transakcja("SELL-1", "SELL", "300", "2025-03-05 10:00", rachunek="D123456")

    wiersze, issues = build_fifo_tax_rows([zakup, sprzedaz], EngineConfig())

    assert [(w.buy_trade_id, w.cost_pln) for w in wiersze] == [("BUY-1", Decimal("100.00"))]
    assert [(issue.code, issue.severity) for issue in issues] == [("FIFO_ACCOUNT_UNRESOLVED", "WARNING")]
    assert "SELL-1" in issues[0].message
    assert not is_blocking_issue(issues[0])


def test_sprzedaz_bez_partii_na_zadnym_rachunku_nadal_blokuje():
    zakup_a = transakcja("BUY-A", "BUY", "100", "2025-03-03 10:00", rachunek="A")
    sprzedaz_a = transakcja("SELL-A", "SELL", "150", "2025-03-04 10:00", rachunek="A")
    sprzedaz_b = transakcja("SELL-B", "SELL", "300", "2025-03-05 10:00", rachunek="B")

    wiersze, issues = build_fifo_tax_rows([zakup_a, sprzedaz_a, sprzedaz_b], EngineConfig())

    assert [w.acquisition_mode for w in wiersze] == ["STANDARD", "UNRESOLVED_AWARD"]
    assert [issue.code for issue in issues] == ["FIFO_SPLIT_BY_ACCOUNT", "AWARD_POLICY_UNRESOLVED"]
    assert is_blocking_issue(issues[1])


def test_zakupy_z_jednego_dnia_ustawia_godzina_a_nie_identyfikator():
    wczesniejszy = transakcja("Z_B", "BUY", "100", "2025-03-03 09:00")
    pozniejszy = transakcja("A_B", "BUY", "200", "2025-03-03 10:00")
    sprzedaz = transakcja("S_B", "SELL", "300", "2025-03-03 11:00")

    wiersze, issues = build_fifo_tax_rows([wczesniejszy, pozniejszy, sprzedaz], EngineConfig())

    assert not issues
    assert [(w.buy_trade_id, w.cost_pln, w.pnl_pln) for w in wiersze] == [("Z_B", Decimal("100.00"), Decimal("200.00"))]


def test_zakup_bez_godziny_nie_jest_przestawiany():
    """Sama data to brak godziny - kolejnosc takiej partii pozostaje jak dotad."""
    bez_godziny = transakcja("A_B", "BUY", "200", "2025-03-03")
    z_godzina = transakcja("Z_B", "BUY", "100", "2025-03-03 09:00")
    sprzedaz = transakcja("S_B", "SELL", "300", "2025-03-03 11:00")

    wiersze, _ = build_fifo_tax_rows([bez_godziny, z_godzina, sprzedaz], EngineConfig())

    assert [w.buy_trade_id for w in wiersze] == ["A_B"]
