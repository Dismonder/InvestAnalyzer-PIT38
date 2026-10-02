"""Kraj dywidendy z importu: sufiks symbolu (.WA/.PL) i ISIN, nie tylko .US.

Dywidenda polskiego emitenta z krajem None liczyla sie jako zagraniczna (poz. 47-49),
zamiast byc wylaczona jako krajowa (rozlicza ja platnik).
"""

from __future__ import annotations

from decimal import Decimal

import pandas as pd
import pytest

from investment_tax_engine.models.core import (
    CanonicalDataset,
    EngineConfig,
    Ledger,
    MergeResult,
)
from investment_tax_engine.normalize.classify import infer_country, infer_country_from_symbol
from investment_tax_engine.normalize.events import normalize_tradernet_event
from investment_tax_engine.tax.pit38_engine import build_pit38_views


def _zdarzenie(rodzaj: str, symbol: str, kwota: str, **dodatkowe):
    surowy = {
        "Rodzaj zlecenia": rodzaj,
        "Data": "2025-03-01",
        "Kwota": kwota,
        "waluta": "PLN",
        "Komentarz": f"{rodzaj} {symbol} test",
        **dodatkowe,
    }
    event = normalize_tradernet_event(surowy)
    event.tax_event_date = pd.Timestamp("2025-03-01")
    event.amount_pln = event.amount
    return event


def _rozlicz(*events):
    merge = MergeResult(
        ledger=Ledger(events_by_id={event.event_id: event for event in events}),
        canonical_dataset=CanonicalDataset(),
    )
    payload = build_pit38_views(merge, [], EngineConfig(tax_year=2025))
    return payload, {issue.code: issue for issue in merge.ledger.issues}


@pytest.mark.parametrize(
    ("symbol", "oczekiwany"),
    [("XYZ.WA", "PL"), ("XYZ.PL", "PL"), ("xyz.wa", "PL"), ("ABC.US", "US"), ("FOO.DE", None), ("XYZ", None)],
)
def test_kraj_z_sufiksu_symbolu(symbol, oczekiwany):
    assert infer_country_from_symbol(symbol) == oczekiwany


def test_kraj_zdarzenia_isin_wygrywa_z_sufiksem_symbolu():
    assert _zdarzenie("Dywidenda", "XYZ.WA", "100").country == "PL"
    assert _zdarzenie("Dywidenda", "ABC.US", "100").country == "US"
    assert _zdarzenie("Dywidenda", "FOO.DE", "100").country is None
    assert _zdarzenie("Dywidenda", "FOO.DE", "100", isin="PLXYZ0000012").country == "PL"
    # Zagraniczny emitent notowany na GPW: kraj z ISIN, nie z konca symbolu.
    assert _zdarzenie("Dywidenda", "XYZ.WA", "100", isin="NL0000000012").country == "NL"
    assert _zdarzenie("Dywidenda", "XYZ.WA", "100", ISIN="LU0000000012").country == "LU"
    # Numer ISIN papieru miedzynarodowego (XS) nie jest krajem i nie ma go zgadywac sufiks.
    assert _zdarzenie("Dywidenda", "XYZ.WA", "100", isin="XS0000000012").country is None


def test_zagraniczny_emitent_na_gpw_zostaje_w_czesci_g():
    """XYZ.WA z ISIN NL: dywidenda i podatek u zrodla sa zagraniczne (czesc G)."""
    payload, issues = _rozlicz(
        _zdarzenie("Dywidenda", "XYZ.WA", "100", isin="NL0000000012"),
        _zdarzenie("Podatek u zrodla", "XYZ.WA", "-15", isin="NL0000000012"),
    )

    art30a = payload["summary"]["art30a"]
    assert art30a["gross_dividends_pln"] == "100.00"
    assert art30a["foreign_withholding_tax_pln"] == "15.00"
    assert "DOMESTIC_DIVIDEND_EXCLUDED" not in issues


@pytest.mark.parametrize("symbol", ["CEZ.PRG", "XYZ.WA"])
def test_podatek_paruje_z_dywidenda_gdy_isin_ma_tylko_jeden_wiersz(symbol):
    """Kraj porownujemy tylko gdy znany po obu stronach (None nie blokuje parowania)."""
    from investment_tax_engine.tax.dividends_engine import build_dividend_views

    dywidenda = _zdarzenie("Dywidenda", symbol, "100", isin="CZ0000000012")
    podatek = _zdarzenie("Podatek u zrodla", symbol, "-15")
    podatek.country = None  # brak ISIN i brak kraju z symbolu po stronie podatku
    dywidendy, podatki = build_dividend_views([dywidenda, podatek])
    assert dywidendy[0]["withholding_tax_pln"] == "15.00"
    assert podatki[0]["matched_dividend_event_id"] == dywidenda.event_id

    dywidenda2 = _zdarzenie("Dywidenda", symbol, "100")
    dywidenda2.country = None
    podatek2 = _zdarzenie("Podatek u zrodla", symbol, "-15", isin="CZ0000000012")
    dywidendy, podatki = build_dividend_views([dywidenda2, podatek2])
    assert dywidendy[0]["withholding_tax_pln"] == "15.00"


def test_kraj_transakcji_z_isin_wyprzedza_sufiks_i_pit_zg_sie_nie_zmienia():
    from types import SimpleNamespace

    from investment_tax_engine.normalize.trades import normalize_api_trade
    from investment_tax_engine.tax.pit_zg import _country_of_trade

    def transakcja(**pola):
        return normalize_api_trade(
            {"Symbol": "XYZ.WA", "Side": "BUY", "Quantity": 1, "Cena": 10, "Kwota": 10,
             "Currency": "PLN", "date": "2025-03-01", "id": "T-KRAJ", **pola}
        )

    for pola, oczekiwany in [({}, "PL"), ({"isin": "NL0000000012"}, "NL"), ({"isin": "XS0000000012"}, None)]:
        trade = transakcja(**pola)
        assert trade.country == oczekiwany
        # Kraj w PIT/ZG liczy ta sama regula (ISIN pierwszy), wiec nie zmienia sie.
        z_pit_zg = _country_of_trade(SimpleNamespace(symbol=trade.symbol, isin=trade.isin, user_country=None))
        assert z_pit_zg == (oczekiwany or "XX")


def test_kraj_pozycji_depo_z_isin():
    from investment_tax_engine.merge.depo_reconcile import build_supplemental_depo_records

    def kraj(**pola):
        payload = {"securities_in_outs": [{
            "type": "stock_award", "id": "A1", "ticker": "XYZ.WA", "quantity": "1",
            "market_value": "10", "balance_currency": "PLN", "pay_d": "2025-03-01", **pola,
        }]}
        return build_supplemental_depo_records(payload)[1][0].country

    assert kraj() == "PL"
    assert kraj(isin="NL0000000012") == "NL"


def test_infer_country_z_sufiksem_nadal_pomija_isin_miedzynarodowy():
    assert infer_country("XYZ.WA", "XS0000000012") is None
    assert infer_country("XYZ.WA", None) == "PL"


def test_polska_dywidenda_z_importu_jest_wylaczona_jako_krajowa():
    """100 zl dywidendy z .WA i 19 zl potraconego przez platnika.

    Przed poprawka country=None: dywidenda szla do czesci G jako zagraniczna
    (brutto 100 zl), a potracone 19 zl bylo odliczane od podatku (poz. 49 nizej o 4 zl).
    """
    payload, issues = _rozlicz(
        _zdarzenie("Dywidenda", "XYZ.WA", "100"),
        _zdarzenie("Podatek u zrodla", "XYZ.WA", "-19"),
    )

    assert payload["summary"]["art30a"]["gross_dividends_pln"] == "0.00"
    assert "DOMESTIC_DIVIDEND_EXCLUDED" in issues
    assert "XYZ.WA" in issues["DOMESTIC_DIVIDEND_EXCLUDED"].message
    assert "TREATY_RATE_ASSUMED" not in issues


def test_dywidenda_us_bez_zmian():
    payload, issues = _rozlicz(
        _zdarzenie("Dywidenda", "ABC.US", "100"),
        _zdarzenie("Podatek u zrodla", "ABC.US", "-15"),
    )

    art30a = payload["summary"]["art30a"]
    assert art30a["gross_dividends_pln"] == "100.00"
    assert art30a["foreign_withholding_tax_pln"] == "15.00"
    assert "DOMESTIC_DIVIDEND_EXCLUDED" not in issues
    assert "TREATY_RATE_ASSUMED" not in issues


def test_dywidenda_z_krajem_nieustalonym_dostaje_ostrzezenie_o_stawce():
    payload, issues = _rozlicz(_zdarzenie("Dywidenda", "FOO.DE", "100"))

    assert Decimal(payload["summary"]["art30a"]["gross_dividends_pln"]) == Decimal("100.00")
    assert "TREATY_RATE_ASSUMED" in issues
    assert "nieustalone" in issues["TREATY_RATE_ASSUMED"].message
    assert "DOMESTIC_DIVIDEND_EXCLUDED" not in issues
