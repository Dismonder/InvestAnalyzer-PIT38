from __future__ import annotations

from decimal import Decimal

import pandas as pd

from investment_tax_engine.models.core import CanonicalEvent
from investment_tax_engine.tax.financing_ledger import (
    DEFAULT_DAILY_MARGIN_RATE,
    build_financing_ledger,
    mark_open_episodes,
    summarize_financing_ledger,
)


def _charge(day: str, amount: str, *, currency: str = "USD", amount_pln: str | None = None) -> CanonicalEvent:
    """Dzienne naliczenie za ujemne saldo, tak jak zapisuje je broker: kwota ujemna."""
    return CanonicalEvent(
        event_id=f"neg:{currency}:{day}",
        event_kind="NEGATIVE_CASH_FEE",
        symbol=None,
        linked_trade_id=None,
        amount=Decimal(amount),
        currency=currency,
        effective_at=pd.Timestamp(day),
        comment="Fee for negative cash balance",
        source_name="TRADERNET_TABLE",
        source_priority=90,
        source_record_id=f"row:{day}",
        cost_bucket="NEGATIVE_BALANCE_INTEREST",
        amount_pln=Decimal(amount_pln) if amount_pln is not None else None,
    )


def test_consecutive_days_form_one_financing_episode():
    episodes, issues = build_financing_ledger(
        [_charge("2025-11-14", "-5.00"), _charge("2025-11-15", "-5.00"), _charge("2025-11-16", "-4.00")]
    )

    assert issues == []
    assert len(episodes) == 1
    episode = episodes[0]
    assert episode.opened_on == pd.Timestamp("2025-11-14")
    assert episode.last_charged_on == pd.Timestamp("2025-11-16")
    assert episode.charged_days == 3
    assert episode.total_interest == Decimal("14.00")


def test_gap_longer_than_one_day_closes_the_episode():
    """Dzien bez naliczenia oznacza, ze saldo nie bylo juz ujemne."""
    episodes, _ = build_financing_ledger(
        [_charge("2025-11-14", "-5.00"), _charge("2025-11-15", "-5.00"), _charge("2025-11-20", "-3.00")]
    )

    assert len(episodes) == 2
    assert episodes[0].charged_days == 2
    assert episodes[1].opened_on == pd.Timestamp("2025-11-20")


def test_settlement_date_is_the_first_day_without_a_charge():
    episodes, _ = build_financing_ledger([_charge("2025-11-14", "-5.00"), _charge("2025-11-15", "-5.00")])

    assert episodes[0].settled_on == pd.Timestamp("2025-11-16")
    assert episodes[0].is_open is False


def test_charges_are_recorded_as_positive_cost():
    """Broker zapisuje obciazenie liczba ujemna; rejestr operuje kosztem."""
    episodes, _ = build_financing_ledger([_charge("2025-11-14", "-5.37")])

    assert episodes[0].total_interest == Decimal("5.37")
    assert episodes[0].charges[0].amount == Decimal("5.37")


def test_borrowed_capital_is_read_from_the_broker_description():
    """Broker podaje saldo i stawke w opisie naliczenia, wiec nie trzeba ich szacowac."""
    charge = _charge("2025-12-01", "-5.43")
    charge.comment = (
        "Fee for negative cash balance USD, fee rate as a percentage: 0.049315, "
        "balance as at 2025-11-30 23:59:59: 11005.36"
    )

    episodes, issues = build_financing_ledger([charge])

    assert episodes[0].peak_principal == Decimal("11005.36")
    assert episodes[0].principal_source == "broker_comment"
    assert episodes[0].daily_rate_used == Decimal("0.00049315")
    assert issues == [], "naliczenie zgadza sie z podanym saldem, wiec nie ma czego zglaszac"


def test_reported_balance_wins_over_the_tariff_estimate():
    """Szacunek z taryfy zalezy od domyslu, ktory prog obowiazuje - zapis brokera nie."""
    charge = _charge("2025-12-01", "-5.43")
    charge.comment = (
        "Fee for negative cash balance USD, fee rate as a percentage: 0.049315, "
        "balance as at 2025-11-30 23:59:59: 11005.36"
    )

    episodes, _ = build_financing_ledger([charge])
    tariff_estimate = Decimal("5.43") / DEFAULT_DAILY_MARGIN_RATE

    assert episodes[0].peak_principal != tariff_estimate
    assert episodes[0].peak_principal == Decimal("11005.36")


def test_charge_inconsistent_with_reported_balance_is_reported():
    """Gdy naliczenie nie wynika z podanego salda i stawki, opis nie opisuje tego zdarzenia."""
    charge = _charge("2025-12-01", "-99.99")
    charge.comment = (
        "Fee for negative cash balance USD, fee rate as a percentage: 0.049315, "
        "balance as at 2025-11-30 23:59:59: 11005.36"
    )

    _, issues = build_financing_ledger([charge])

    assert [issue.code for issue in issues] == ["FINANCING_CHARGE_DOES_NOT_MATCH_REPORTED_BALANCE"]


def test_capital_falls_back_to_the_tariff_rate_without_a_description():
    episodes, _ = build_financing_ledger([_charge("2025-11-14", "-5.37")])

    assert episodes[0].peak_principal == Decimal("5.37") / DEFAULT_DAILY_MARGIN_RATE
    assert episodes[0].principal_source == "derived_from_rate"
    assert episodes[0].daily_rate_used == DEFAULT_DAILY_MARGIN_RATE


def test_borrowed_capital_is_absent_when_no_rate_is_supplied():
    episodes, _ = build_financing_ledger([_charge("2025-11-14", "-5.37")], daily_rate=None)

    assert episodes[0].peak_principal is None
    assert episodes[0].total_interest == Decimal("5.37")


def test_each_currency_keeps_its_own_episodes():
    episodes, _ = build_financing_ledger(
        [_charge("2025-11-14", "-5.00"), _charge("2025-11-14", "-2.00", currency="EUR")]
    )

    assert {episode.currency for episode in episodes} == {"USD", "EUR"}
    assert all(episode.charged_days == 1 for episode in episodes)


def test_weekend_days_do_not_break_an_episode():
    """Odsetki biegna po dniach kalendarzowych, wiec sobota i niedziela licza sie tak samo."""
    episodes, _ = build_financing_ledger(
        [
            _charge("2026-03-20", "-7.00"),  # piatek
            _charge("2026-03-21", "-7.00"),  # sobota
            _charge("2026-03-22", "-7.00"),  # niedziela
            _charge("2026-03-23", "-7.00"),  # poniedzialek
        ]
    )

    assert len(episodes) == 1
    assert episodes[0].charged_days == 4


def test_episode_reaching_the_data_horizon_is_reported_as_unsettled():
    """Ostatnie naliczenie w zbiorze nie dowodzi splaty - dalszych wyciagow moze brakowac."""
    episodes, _ = build_financing_ledger([_charge("2026-05-10", "-5.00"), _charge("2026-05-11", "-5.00")])
    issues = mark_open_episodes(episodes, data_horizon=pd.Timestamp("2026-05-11"))

    assert episodes[0].is_open is True
    assert episodes[0].settled_on is None
    assert [issue.code for issue in issues] == ["FINANCING_EPISODE_NOT_SETTLED"]


def test_episode_ending_before_the_horizon_stays_settled():
    episodes, _ = build_financing_ledger([_charge("2026-05-01", "-5.00")])
    issues = mark_open_episodes(episodes, data_horizon=pd.Timestamp("2026-05-11"))

    assert episodes[0].is_open is False
    assert issues == []


def test_charge_without_a_date_is_reported_and_skipped():
    undated = _charge("2025-11-14", "-5.00")
    undated.effective_at = None

    episodes, issues = build_financing_ledger([undated])

    assert episodes == []
    assert [issue.code for issue in issues] == ["FINANCING_CHARGE_WITHOUT_DATE"]


def test_events_that_are_not_financing_charges_are_ignored():
    commission = CanonicalEvent(
        event_id="fee:1",
        event_kind="TRADE_COMMISSION",
        symbol="NBIS.US",
        linked_trade_id="1",
        amount=Decimal("-1.54"),
        currency="USD",
        effective_at=pd.Timestamp("2025-11-14"),
        comment="Prowizja za transakcje",
        source_name="TRADERNET_TABLE",
        source_priority=90,
        source_record_id="row:1",
        cost_bucket="TRADE_COMMISSION",
    )

    episodes, _ = build_financing_ledger([commission])

    assert episodes == []


def test_summary_reports_totals_per_currency_and_open_episodes():
    episodes, _ = build_financing_ledger(
        [
            _charge("2025-11-14", "-5.00", amount_pln="-20.00"),
            _charge("2025-11-15", "-5.00", amount_pln="-20.00"),
            _charge("2025-12-20", "-3.00", amount_pln="-12.00"),
        ]
    )
    mark_open_episodes(episodes, data_horizon=pd.Timestamp("2025-12-20"))

    summary = summarize_financing_ledger(episodes, tax_year=2025)

    assert summary["schema_version"] == "financing_ledger.v1"
    assert summary["episode_count"] == 2
    assert summary["charged_days"] == 3
    assert summary["open_episode_count"] == 1
    assert summary["total_interest_pln"] == Decimal("52.00")
    assert summary["by_currency"]["USD"]["total_interest"] == "13.00"


def test_summary_limits_episodes_to_the_selected_tax_year():
    episodes, _ = build_financing_ledger([_charge("2025-11-14", "-5.00"), _charge("2026-03-20", "-7.00")])

    assert summarize_financing_ledger(episodes, tax_year=2025)["episode_count"] == 1
    assert summarize_financing_ledger(episodes, tax_year=2026)["episode_count"] == 1
    assert summarize_financing_ledger(episodes, tax_year=None)["episode_count"] == 2


def test_summary_splits_cross_year_episode_by_charge_date():
    episodes, _ = build_financing_ledger([
        _charge("2025-12-31", "-5.00", amount_pln="-20.00"),
        _charge("2026-01-01", "-7.00", amount_pln="-28.00"),
    ])
    assert len(episodes) == 1
    previous = summarize_financing_ledger(episodes, tax_year=2025)
    current = summarize_financing_ledger(episodes, tax_year=2026)
    assert previous["total_interest_pln"] == Decimal("20.00")
    assert current["total_interest_pln"] == Decimal("28.00")
    assert previous["by_currency"]["USD"]["total_interest"] == "5.00"
    assert current["by_currency"]["USD"]["total_interest"] == "7.00"
    assert previous["charged_days"] == current["charged_days"] == 1
    assert previous["episodes"][0]["period_total_interest"] == "12.00"
    assert current["episodes"][0]["period_total_interest_pln"] == "48.00"
