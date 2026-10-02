"""Akcje przyznane blokuja PIT za rok tylko wtedy, gdy moga zmienic jego FIFO.

Na prawdziwym rachunku trzy akcje z promocji przyznane i sprzedane w 2025 r.
blokowaly gotowosc zeznania za 2026 r., choc nie moga zmienic ani grosza.
"""

from __future__ import annotations

from types import SimpleNamespace

import pandas as pd

from investment_tax_engine.app.engine import InvestmentTaxEngine


def _pozycja(symbol: str | None, data: str | None, *, decyzja: str | None = None, wystapienia: int = 1) -> dict:
    return {
        "decision_key": f"stock_award|{data}|{symbol}",
        "kind": "stock_award",
        "date": data,
        "symbol": symbol,
        "blocks_filing": True,
        "decision": decyzja,
        "occurrences": wystapienia,
    }


def _rejestr(*sprzedaze: tuple[str, str]) -> SimpleNamespace:
    transakcje = {
        f"S-{i}": SimpleNamespace(side="SELL", symbol=symbol, isin=None, tax_event_date=pd.Timestamp(data))
        for i, (symbol, data) in enumerate(sprzedaze)
    }
    transakcje["B-0"] = SimpleNamespace(side="BUY", symbol="XYZ.US", isin=None, tax_event_date=pd.Timestamp("2026-03-01"))
    return SimpleNamespace(ledger=SimpleNamespace(trades_by_id=transakcje))


def _raport(*pozycje: dict) -> dict:
    return {
        "reviewQueue": list(pozycje),
        "recordsAwaitingUserDecisionBlockingByKind": {"stock_award": sum(p["occurrences"] for p in pozycje)},
        "recordsAwaitingUserDecisionWarningByKind": {},
    }


def test_akcje_przyznane_i_sprzedane_przed_rokiem_rozliczenia_nie_blokuja():
    raport = _raport(_pozycja("AHT.US", "2025-01-21", wystapienia=3))
    InvestmentTaxEngine._zwolnij_akcje_przyznane_spoza_roku(raport, _rejestr(("AHT.US", "2025-08-22")), 2026)
    assert raport["reviewQueue"][0]["blocks_filing"] is False
    assert raport["recordsAwaitingUserDecisionBlockingByKind"] == {}
    assert raport["recordsAwaitingUserDecisionWarningByKind"] == {"stock_award": 3}


def test_sprzedaz_waloru_w_roku_rozliczenia_utrzymuje_blokade_takze_bez_sufiksu_rynku():
    raport = _raport(_pozycja("AHT.US", "2025-01-21"))
    InvestmentTaxEngine._zwolnij_akcje_przyznane_spoza_roku(raport, _rejestr(("AHT", "2026-02-03")), 2026)
    assert raport["reviewQueue"][0]["blocks_filing"] is True
    assert raport["recordsAwaitingUserDecisionBlockingByKind"] == {"stock_award": 1}


def test_przyznanie_w_roku_rozliczenia_i_bez_daty_blokuja_dalej():
    w_roku = _pozycja("ABC.US", "2026-05-05")
    bez_daty = _pozycja("DEF.US", None)
    bez_symbolu = _pozycja(None, "2024-01-01")
    raport = _raport(w_roku, bez_daty, bez_symbolu)
    InvestmentTaxEngine._zwolnij_akcje_przyznane_spoza_roku(raport, _rejestr(), 2026)
    assert [p["blocks_filing"] for p in raport["reviewQueue"]] == [True, True, True]


def test_przyznanie_po_roku_rozliczenia_nie_zmienia_jego_fifo():
    raport = _raport(_pozycja("ABC.US", "2027-01-10"), _pozycja("GHI.US", "2026-01-10"))
    InvestmentTaxEngine._zwolnij_akcje_przyznane_spoza_roku(raport, _rejestr(("ABC.US", "2026-06-01")), 2026)
    assert [p["blocks_filing"] for p in raport["reviewQueue"]] == [False, True]
    assert raport["recordsAwaitingUserDecisionBlockingByKind"] == {"stock_award": 1}
    assert raport["recordsAwaitingUserDecisionWarningByKind"] == {"stock_award": 1}


def test_rozstrzygniete_pozycje_nie_wchodza_do_licznikow():
    raport = _raport(
        _pozycja("AHT.US", "2025-01-21"),
        _pozycja("MOMO.US", "2025-01-21", decyzja="no_tax_effect"),
        {"decision_key": "corporate_action|2026-03-01|NOTA", "kind": "corporate_action", "date": "2026-03-01",
         "symbol": "NOTA", "blocks_filing": True, "decision": None, "occurrences": 2},
    )
    InvestmentTaxEngine._zwolnij_akcje_przyznane_spoza_roku(raport, _rejestr(), 2026)
    assert raport["recordsAwaitingUserDecisionBlockingByKind"] == {"corporate_action": 2}
    assert raport["recordsAwaitingUserDecisionWarningByKind"] == {"stock_award": 1}


def test_sprzedaz_pod_nowym_tickerem_z_tym_samym_isin_utrzymuje_blokade():
    # Zmiana tickera ABC -> XYZ zostawia ISIN; sprzedaz XYZ w roku moze zuzyc
    # w FIFO partie z przyznania ABC.
    pozycja = {**_pozycja("ABC.US", "2025-01-21"), "isin": "US0000000001"}
    raport = _raport(pozycja)
    rejestr = _rejestr()
    rejestr.ledger.trades_by_id["S-XYZ"] = SimpleNamespace(
        side="SELL", symbol="XYZ.US", isin="us0000000001", tax_event_date=pd.Timestamp("2026-03-03")
    )
    InvestmentTaxEngine._zwolnij_akcje_przyznane_spoza_roku(raport, rejestr, 2026)
    assert raport["reviewQueue"][0]["blocks_filing"] is True
