"""Zalacznik PIT/ZG - dochody z zagranicy odrebnie dla kazdego panstwa.

Program liczyl poprawna kwote podatku, ale nie skladal zalacznika, ktory
broszura MF do PIT-38 nazywa obowiazkowym dla dochodow z art. 30b uzyskanych
za granica. Rozliczenie z zagranicznego rachunku maklerskiego bylo przez to
niekompletne, mimo ze kwota sie zgadzala.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from types import SimpleNamespace

import pandas as pd

from investment_tax_engine.app.engine import InvestmentTaxEngine
from investment_tax_engine.models.core import EngineConfig
from investment_tax_engine.tax.pit_zg import (
    build_pit_zg_rows,
    foreign_capital_tax_credit,
    proportional_credit_limit,
)


@dataclass
class _Row:
    sell_trade_id: str
    gross_revenue_pln: Decimal
    cost_pln: Decimal
    sell_commission_alloc_pln: Decimal = Decimal("0.00")
    sell_tax_date: pd.Timestamp = pd.Timestamp("2025-06-17")


@dataclass
class _Trade:
    symbol: str
    isin: str | None = None


def _rows_and_trades():
    trades = {
        "S-US": _Trade(symbol="TEST.US", isin="US0000000000"),
        "S-IE": _Trade(symbol="FUND.US", isin="IE00B4L5Y983"),
    }
    rows = [
        _Row("S-US", Decimal("10000.00"), Decimal("7000.00")),
        _Row("S-US", Decimal("2000.00"), Decimal("1500.00")),
        _Row("S-IE", Decimal("5000.00"), Decimal("6000.00")),
    ]
    return rows, trades


def test_one_row_per_country_not_per_transaction():
    """Zalacznik sklada sie odrebnie dla kazdego panstwa, nie dla kazdej sprzedazy."""
    rows, trades = _rows_and_trades()

    zalaczniki = build_pit_zg_rows(rows, trades)

    assert [entry["country"] for entry in zalaczniki] == ["IE", "US"]
    assert [entry["row_count"] for entry in zalaczniki] == [1, 2]


def test_income_and_loss_are_reported_separately_per_country():
    """Strata w jednym panstwie nie pomniejsza dochodu wykazanego w drugim."""
    rows, trades = _rows_and_trades()

    zalaczniki = {entry["country"]: entry for entry in build_pit_zg_rows(rows, trades)}

    assert zalaczniki["US"]["income_pln"] == Decimal("3500.00")
    assert zalaczniki["US"]["loss_pln"] == Decimal("0.00")
    assert zalaczniki["IE"]["income_pln"] == Decimal("0.00")
    assert zalaczniki["IE"]["loss_pln"] == Decimal("1000.00")


def test_country_comes_from_isin_before_the_ticker_suffix():
    """Fundusz irlandzki notowany pod symbolem .US to dochod z Irlandii.

    Koncowka tickera mowi o rynku notowan, prefiks ISIN o panstwie waloru -
    a zalacznik sklada sie wedlug panstwa uzyskania dochodu.
    """
    trades = {"S-1": _Trade(symbol="CSPX.US", isin="IE00B5BMR087")}
    rows = [_Row("S-1", Decimal("1000.00"), Decimal("800.00"))]

    assert build_pit_zg_rows(rows, trades)[0]["country"] == "IE"


def test_unknown_country_is_named_rather_than_silently_dropped():
    """Wiersz bez ISIN i bez rozpoznanej koncowki nie moze zniknac z zalacznika."""
    trades = {"S-1": _Trade(symbol="ZAGADKA")}
    rows = [_Row("S-1", Decimal("1000.00"), Decimal("800.00"))]

    zalaczniki = build_pit_zg_rows(rows, trades)

    assert [entry["country"] for entry in zalaczniki] == ["XX"]
    assert zalaczniki[0]["income_pln"] == Decimal("200.00")


def test_dividend_withholding_does_not_enter_the_art_30b_foreign_tax():
    """Takze podatek bez dopasowania pozostaje w czesci G, nie w PIT/ZG.

    Zalacznik do PIT-38 dotyczy art. 30b; dywidendy z art. 30a maja wlasne
    pozycje 46-49 formularza. Zliczenie ich tutaj odliczyloby ten sam podatek
    dwa razy.
    """
    rows, trades = _rows_and_trades()
    podatki = [
        {"country": "US", "source_tax_pln": "150.00", "matched_dividend_event_id": "DIV-1"},
        {"country": "US", "source_tax_pln": "40.00", "matched_dividend_event_id": None},
    ]

    zalaczniki = {entry["country"]: entry for entry in build_pit_zg_rows(rows, trades, podatki)}

    assert zalaczniki["US"]["foreign_tax_pln"] == Decimal("0.00")
    assert foreign_capital_tax_credit(zalaczniki.values(), Decimal("665.00"), Decimal("3500")) == Decimal("0.00")


def test_pit_zg_reports_gross_revenue_and_sell_commission_as_cost():
    rows = [_Row("S-1", Decimal("600.00"), Decimal("400.00"), Decimal("5.00"))]
    trades = {"S-1": _Trade(symbol="ABC.US", isin="US0000000000")}

    row = build_pit_zg_rows(rows, trades)[0]

    assert row["revenue_pln"] == Decimal("600.00")
    assert row["cost_pln"] == Decimal("405.00")
    assert row["income_pln"] == Decimal("195.00")


def test_unknown_country_blocks_only_a_row_with_income_or_foreign_tax():
    engine = InvestmentTaxEngine(EngineConfig(tax_year=2025))
    trades = {"S-1": _Trade(symbol="ZAGADKA")}

    def issues_for(row):
        result = SimpleNamespace(
            fifo_rows=[row],
            merge_result=SimpleNamespace(ledger=SimpleNamespace(trades_by_id=trades)),
        )
        return engine._pit_zg_country_issues(result)

    assert issues_for(_Row("S-1", Decimal("100.00"), Decimal("100.00"))) == []
    issues = issues_for(_Row("S-1", Decimal("120.00"), Decimal("100.00")))
    assert len(issues) == 1
    assert issues[0].severity == "ERROR"
    assert issues[0].blocking is True
    assert engine.resolve_quality(issues).filing_ready is False


def test_a_country_without_income_reports_no_deductible_foreign_tax():
    """Bez dochodu z danego panstwa nie ma polskiego podatku do pomniejszenia."""
    trades = {"S-1": _Trade(symbol="STRATA.US", isin="US1111111111")}
    rows = [_Row("S-1", Decimal("1000.00"), Decimal("1500.00"))]
    podatki = [{"country": "US", "source_tax_pln": "80.00", "matched_dividend_event_id": None}]

    zalacznik = build_pit_zg_rows(rows, trades, podatki)[0]

    assert zalacznik["loss_pln"] == Decimal("500.00")
    assert zalacznik["foreign_tax_pln"] == Decimal("0.00")


def test_proportional_limit_follows_the_share_of_foreign_income():
    """Limit z broszury: podatek przed odliczeniem * dochod zagraniczny / dochod laczny."""
    assert proportional_credit_limit(Decimal("1900.00"), Decimal("5000"), Decimal("10000")) == Decimal("950.00")
    assert proportional_credit_limit(Decimal("1900.00"), Decimal("10000"), Decimal("10000")) == Decimal("1900.00")
    assert proportional_credit_limit(Decimal("1900.00"), Decimal("0"), Decimal("10000")) == Decimal("0.00")
    assert proportional_credit_limit(Decimal("1900.00"), Decimal("5000"), Decimal("0")) == Decimal("0.00")


def test_credit_is_capped_per_country_not_on_the_total():
    """Nadwyzka z kraju o wysokiej stawce nie zjada limitu innego kraju.

    Przy jednym wspolnym limicie podatek 900 zl z panstwa A o dochodzie 1000 zl
    skonsumowalby limit przypadajacy takze na panstwo B - i odliczenie wyszloby
    wyzsze, niz pozwala metoda proporcjonalna.
    """
    zalaczniki = [
        {"country": "A", "income_pln": Decimal("1000"), "foreign_tax_pln": Decimal("900")},
        {"country": "B", "income_pln": Decimal("9000"), "foreign_tax_pln": Decimal("0")},
    ]

    kredyt = foreign_capital_tax_credit(zalaczniki, Decimal("1900.00"), Decimal("10000"))

    assert kredyt == Decimal("190.00"), "limit dla panstwa A to 19% z jego 1000 zl dochodu"


def test_no_foreign_tax_means_no_credit():
    zalaczniki = [{"country": "US", "income_pln": Decimal("3500"), "foreign_tax_pln": Decimal("0")}]

    assert foreign_capital_tax_credit(zalaczniki, Decimal("665.00"), Decimal("3500")) == Decimal("0.00")
