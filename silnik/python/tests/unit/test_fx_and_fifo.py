from __future__ import annotations

from decimal import Decimal
from dataclasses import asdict, replace

import pandas as pd
import pytest

from investment_tax_engine.models.core import (
    CanonicalDataset,
    CanonicalEvent,
    CanonicalTrade,
    EngineConfig,
    FxLookupResult,
    Ledger,
    MergeResult,
    PriorYearLoss,
    RealizedTaxRow,
    UserOverrides,
)
from investment_tax_engine.export.fifo_view import fifo_rows_as_dicts
from investment_tax_engine.tax.fifo_engine import build_fifo_tax_rows, open_lots_detail
from investment_tax_engine.tax.fx_engine import apply_nbp_fx_to_trade
from investment_tax_engine.tax.pit38_engine import build_pit38_views
from investment_tax_engine.validation.quality_gates import is_blocking_issue
from investment_tax_engine.app.canonical_tax_input_adapter import normalize_review_decisions
from investment_tax_engine.tax.pit_zg import build_pit_zg_rows, foreign_capital_tax_credit


class StubFxProvider:
    provider_name = "STUB"

    def get_rate(self, currency: str, tax_event_date: pd.Timestamp) -> FxLookupResult:
        mapping = {
            "USD": Decimal("4.10"),
            "EUR": Decimal("4.50"),
            "PLN": Decimal("1.00"),
        }
        return FxLookupResult(
            currency=currency,
            tax_event_date=tax_event_date,
            fx_date=tax_event_date - pd.Timedelta(days=1),
            rate=mapping[currency],
            source=self.provider_name,
        )

    def coverage_report(self, start_date: pd.Timestamp, end_date: pd.Timestamp, currencies: set[str]):
        return []


def make_trade(**overrides) -> CanonicalTrade:
    base = dict(
        trade_id="T-1",
        order_id="O-1",
        trade_number="N-1",
        symbol="NBIS.US",
        isin=None,
        side="BUY",
        instrument_type_code="1",
        instrument_class="EQUITY",
        market_id="30000000001",
        quantity=Decimal("10"),
        price=Decimal("100"),
        gross_amount=Decimal("1000"),
        trade_currency="USD",
        commission=Decimal("5"),
        commission_currency="EUR",
        broker_reported_profit=Decimal("0"),
        executed_at=pd.Timestamp("2026-04-17 10:00:00"),
        exchange_time=pd.Timestamp("2026-04-17 10:00:00"),
        settlement_date=pd.Timestamp("2026-04-19 00:00:00"),
        confirm_time=None,
        otc=False,
        repo_close=None,
        base_contract_code=None,
        current_position_qty_after_trade=Decimal("0"),
        source_name="API_JSON_FULL",
        source_priority=110,
        source_record_id="fixture-row",
        sources=["API_JSON_FULL"],
        logical_world="equity_tax",
    )
    base.update(overrides)
    return CanonicalTrade(**base)


def test_krypto_fiat_z_prowizja_bnb_lub_w_nabytym_pepe_nie_szuka_kursu_nbp():
    for symbol, commission_currency in (("BTCUSD", "BNB"), ("PEPEUSD", "PEPE")):
        trade = make_trade(
            symbol=symbol, instrument_class="CRYPTO", logical_world="crypto_tax",
            commission=Decimal("0.1"), commission_currency=commission_currency,
        )
        apply_nbp_fx_to_trade(trade, StubFxProvider(), EngineConfig())
        assert trade.gross_amount_pln == Decimal("4100.00")
        assert trade.commission_pln == Decimal("0.00")
        assert trade.commission_fx_rate is None


def make_bonus_grant(**overrides) -> CanonicalEvent:
    base = dict(
        event_id="BONUS-GRANT-1",
        event_kind="BONUS_CONTEST_SHARE",
        symbol="PTON.US",
        linked_trade_id=None,
        amount=Decimal("8.57"),
        currency="USD",
        effective_at=pd.Timestamp("2025-02-09"),
        comment="Gift Share bonus from broker campaign",
        source_name="DEPO_JSON",
        source_priority=80,
        source_record_id="award-1",
        quantity=Decimal("1"),
        tax_event_date=pd.Timestamp("2025-02-09"),
        amount_pln=Decimal("34.00"),
        logical_world="equity_tax",
        country="US",
        grant_tax_status="REVIEW_REQUIRED",
        grant_market_value=Decimal("8.57"),
        grant_value_pln=Decimal("34.00"),
        acquisition_mode="BONUS_CONTEST_SHARE",
    )
    base.update(overrides)
    return CanonicalEvent(**base)


def test_apply_nbp_fx_uses_separate_commission_currency_lookup():
    trade = make_trade()

    apply_nbp_fx_to_trade(trade, StubFxProvider(), EngineConfig())

    assert trade.gross_amount_pln == Decimal("4100.00")
    assert trade.commission_pln == Decimal("22.50")
    assert trade.buy_total_cost_pln == Decimal("4122.50")
    assert trade.gross_fx_rate == Decimal("4.10")
    assert trade.commission_fx_rate == Decimal("4.50")


def test_fifo_ignores_repo_and_realizes_zero_cost_bonus_grant_in_pln():
    repo_trade = make_trade(
        trade_id="REPO-1",
        symbol="FRHC.US",
        instrument_type_code="18",
        instrument_class="REPO",
        logical_world="diagnostic_only",
        acquisition_mode="REPO",
        buy_total_cost_pln=Decimal("4000.00"),
        tax_event_date=pd.Timestamp("2026-01-01"),
        gross_fx_date=pd.Timestamp("2025-12-31"),
    )
    bonus_grant = make_bonus_grant()
    award_sell = make_trade(
        trade_id="AWARD-SELL",
        side="SELL",
        symbol="PTON.US",
        quantity=Decimal("1"),
        gross_amount=Decimal("8.57"),
        commission=Decimal("2.02"),
        commission_currency="USD",
        sell_net_revenue_pln=Decimal("26.86"),
        gross_fx_date=pd.Timestamp("2025-02-09"),
        tax_event_date=pd.Timestamp("2025-02-10"),
    )

    realized, issues = build_fifo_tax_rows([repo_trade, award_sell], EngineConfig(), bonus_grants=[bonus_grant])

    assert not issues
    assert len(realized) == 1
    assert realized[0].symbol == "PTON.US"
    assert realized[0].cost_pln == Decimal("0.00")
    assert realized[0].net_revenue_pln == Decimal("26.86")
    assert realized[0].acquisition_mode == "BONUS_CONTEST_SHARE"


def test_pit38_views_respect_tax_year_and_keep_2025_lot_for_2026_realization():
    buy_2025 = make_trade(
        trade_id="BUY-2025",
        quantity=Decimal("1"),
        gross_amount=Decimal("100"),
        commission=Decimal("0"),
        commission_currency="USD",
        buy_total_cost_pln=Decimal("400.00"),
        tax_event_date=pd.Timestamp("2025-12-20"),
        gross_fx_date=pd.Timestamp("2025-12-19"),
    )
    sell_2026 = make_trade(
        trade_id="SELL-2026",
        side="SELL",
        quantity=Decimal("1"),
        gross_amount=Decimal("150"),
        commission=Decimal("0"),
        commission_currency="USD",
        sell_gross_revenue_pln=Decimal("600.00"),
        sell_net_revenue_pln=Decimal("600.00"),
        tax_event_date=pd.Timestamp("2026-01-10"),
        gross_fx_date=pd.Timestamp("2026-01-09"),
    )
    dividend_2025 = CanonicalEvent(
        event_id="DIV-2025",
        event_kind="DIVIDEND",
        symbol="NBIS.US",
        linked_trade_id=None,
        amount=Decimal("5.00"),
        currency="USD",
        effective_at=pd.Timestamp("2025-06-01"),
        comment=None,
        source_name="BROKER_JSON",
        source_priority=70,
        source_record_id="DIV-2025",
        tax_event_date=pd.Timestamp("2025-06-01"),
        amount_pln=Decimal("20.00"),
        logical_world="equity_tax",
        country="US",
    )
    dividend_2026 = CanonicalEvent(
        event_id="DIV-2026",
        event_kind="DIVIDEND",
        symbol="NBIS.US",
        linked_trade_id=None,
        amount=Decimal("7.00"),
        currency="USD",
        effective_at=pd.Timestamp("2026-06-01"),
        comment=None,
        source_name="BROKER_JSON",
        source_priority=70,
        source_record_id="DIV-2026",
        tax_event_date=pd.Timestamp("2026-06-01"),
        amount_pln=Decimal("28.00"),
        logical_world="equity_tax",
        country="US",
    )

    realized, issues = build_fifo_tax_rows([buy_2025, sell_2026], EngineConfig())
    assert not issues
    assert len(realized) == 1

    merge_result = MergeResult(
        ledger=Ledger(events_by_id={"DIV-2025": dividend_2025, "DIV-2026": dividend_2026}),
        canonical_dataset=CanonicalDataset(),
    )

    config_2025 = EngineConfig()
    config_2025.tax_year = 2025
    payload_2025 = build_pit38_views(merge_result, realized, config_2025)

    config_2026 = EngineConfig()
    config_2026.tax_year = 2026
    payload_2026 = build_pit38_views(merge_result, realized, config_2026)

    assert payload_2025["summary"]["total_revenue_pln"] == "0.00"
    assert payload_2025["summary"]["total_cost_pln"] == "0.00"
    assert payload_2025["summary"]["net_pln"] == "0.00"
    assert [row["event_id"] for row in payload_2025["dividends_view"]] == ["DIV-2025"]

    assert payload_2026["summary"]["total_revenue_pln"] == "600.00"
    assert payload_2026["summary"]["total_cost_pln"] == "400.00"
    assert payload_2026["summary"]["net_pln"] == "162.00"
    assert [row["event_id"] for row in payload_2026["dividends_view"]] == ["DIV-2026"]


def test_a_loss_computed_from_data_is_offered_but_does_not_deduct_by_itself():
    """Odliczenie wymaga, zeby strata byla wykazana w PIT-38 za rok jej poniesienia.

    Silnik zna tylko wgrane pliki: nie wie, czy strate zgloszono, ani ile z niej
    odliczono w poprzednich latach. Sam z siebie oferowalby ja w pelnej kwocie
    rok po roku. Wyliczenie z danych jest wiec propozycja - podatek obniza
    dopiero wpis potwierdzony przez uzytkownika.
    """
    buy_2025 = make_trade(
        trade_id="BUY-LOSS-2025",
        quantity=Decimal("1"),
        gross_amount=Decimal("250"),
        commission=Decimal("0"),
        commission_currency="USD",
        buy_total_cost_pln=Decimal("1000.00"),
        tax_event_date=pd.Timestamp("2025-03-01"),
        gross_fx_date=pd.Timestamp("2025-02-28"),
    )
    sell_2025 = make_trade(
        trade_id="SELL-LOSS-2025",
        side="SELL",
        quantity=Decimal("1"),
        gross_amount=Decimal("175"),
        commission=Decimal("0"),
        commission_currency="USD",
        sell_gross_revenue_pln=Decimal("700.00"),
        sell_net_revenue_pln=Decimal("700.00"),
        tax_event_date=pd.Timestamp("2025-12-20"),
        gross_fx_date=pd.Timestamp("2025-12-19"),
    )
    buy_2026 = make_trade(
        trade_id="BUY-GAIN-2026",
        quantity=Decimal("1"),
        gross_amount=Decimal("25"),
        commission=Decimal("0"),
        commission_currency="USD",
        buy_total_cost_pln=Decimal("100.00"),
        tax_event_date=pd.Timestamp("2026-01-10"),
        gross_fx_date=pd.Timestamp("2026-01-09"),
    )
    sell_2026 = make_trade(
        trade_id="SELL-GAIN-2026",
        side="SELL",
        quantity=Decimal("1"),
        gross_amount=Decimal("150"),
        commission=Decimal("0"),
        commission_currency="USD",
        sell_gross_revenue_pln=Decimal("600.00"),
        sell_net_revenue_pln=Decimal("600.00"),
        tax_event_date=pd.Timestamp("2026-04-10"),
        gross_fx_date=pd.Timestamp("2026-04-09"),
    )

    realized, issues = build_fifo_tax_rows([buy_2025, sell_2025, buy_2026, sell_2026], EngineConfig())
    assert not issues

    payload_2026 = build_pit38_views(
        MergeResult(ledger=Ledger(), canonical_dataset=CanonicalDataset()),
        realized,
        EngineConfig(tax_year=2026),
    )

    assert payload_2026["summary"]["total_pnl_pln"] == "500.00"
    # Strata jest widoczna w rejestrze, ale nie zmniejsza podstawy.
    assert payload_2026["summary"]["prior_year_losses_available_pln"] == "0.00"
    assert payload_2026["summary"]["prior_year_loss_used_pln"] == "0.00"
    assert payload_2026["summary"]["pit38_income"] == "500"
    assert payload_2026["summary"]["pit38_form_income_pln"] == "500.00"
    assert payload_2026["summary"]["pit38_form_base_pln"] == "500"
    assert payload_2026["summary"]["pit38_form_tax_pln"] == "95.00"
    assert payload_2026["summary"]["pit38_form_tax_due_pln"] == "95"
    assert payload_2026["scenario_results"]["aggressive_user"].taxable_base_pln == Decimal("500.00")
    assert payload_2026["prior_year_loss_ledger"] == [
        {
            "tax_year": 2025,
            "loss_pln": "300.00",
            "remaining_pln": "300.00",
            "used_in_year": "0.00",
            "source": "AUTO_FROM_REALIZED_FIFO",
            "status": "AUTO_NEEDS_CONFIRMATION",
        }
    ]


def test_a_loss_confirmed_by_the_user_does_reduce_the_tax():
    """Wpis uzytkownika oznacza: strate wykazalem, tyle z niej zostalo."""
    from investment_tax_engine.models.core import PriorYearLoss, UserOverrides

    config = EngineConfig(
        tax_year=2026,
        user_overrides=UserOverrides(
            prior_year_losses=[
                PriorYearLoss(
                    tax_year=2025,
                    amount_pln=Decimal("300.00"),
                    remaining_pln=Decimal("300.00"),
                    accepted=True,
                )
            ]
        ),
    )
    payload = build_pit38_views(
        MergeResult(ledger=Ledger(), canonical_dataset=CanonicalDataset()),
        [],
        config,
    )

    assert payload["summary"]["prior_year_losses_available_pln"] == "300.00"
    assert payload["prior_year_loss_ledger"][0]["status"] == "ACCEPTED"


def test_pit8c_replaces_only_polish_fifo_and_recalculates_loss_usage():
    def row(name: str, revenue: str, cost: str) -> RealizedTaxRow:
        return RealizedTaxRow(
            row_id=name, symbol=name, sell_trade_id=name, buy_trade_id=f"BUY-{name}",
            quantity=Decimal("1"), sell_tax_date=pd.Timestamp("2026-02-01"),
            buy_tax_date=pd.Timestamp("2025-02-01"), sell_fx_date=pd.Timestamp("2026-01-31"),
            buy_fx_date=pd.Timestamp("2025-01-31"), gross_revenue_pln=Decimal(revenue),
            sell_commission_alloc_pln=Decimal("0"), net_revenue_pln=Decimal(revenue),
            cost_pln=Decimal(cost), pnl_pln=Decimal(revenue) - Decimal(cost),
            acquisition_mode="BUY",
        )

    rows = [row("POLISH", "200.00", "100.00"), row("FOREIGN", "100.00", "50.00")]
    merge = MergeResult(ledger=Ledger(), canonical_dataset=CanonicalDataset())
    def config() -> EngineConfig:
        return EngineConfig(tax_year=2026, user_overrides=UserOverrides(prior_year_losses=[
            PriorYearLoss(tax_year=2025, amount_pln=Decimal("300"),
                          remaining_pln=Decimal("300"), accepted=True)
        ]))

    baseline = build_pit38_views(merge, rows, config())
    with_pit8c = config()
    with_pit8c.tax_plan.pit8c_sell_trade_ids = {"POLISH"}
    with_pit8c.tax_plan.pit8c_no_sell_trade_ids = {"FOREIGN"}
    with_pit8c.tax_plan.pit8c_entries = [{"revenuePln": "500.00", "costsPln": "100.00"}]
    payload = build_pit38_views(merge, rows, with_pit8c)
    summary = payload["summary"]
    assert baseline["summary"]["prior_year_loss_used_pln"] == "150.00"
    assert baseline["summary"]["pit38_form_revenue_pln"] == "300.00"
    assert baseline["summary"]["pit38_form_cost_pln"] == "150.00"
    assert "pit8c_revenue_pln" not in baseline["summary"]["art30b"]
    polish_only = config()
    polish_only.tax_plan.pit8c_sell_trade_ids = {"POLISH"}
    calculated = build_pit38_views(merge, rows, polish_only)["summary"]["art30b"]
    assert calculated["pit8c_source"] == "transakcje"
    assert calculated["pit8c_sell_trade_ids"] == ["POLISH"]
    assert calculated["pit8c_revenue_pln"] == "200.00"
    assert calculated["pit8c_cost_pln"] == "100.00"
    assert summary["prior_year_loss_used_pln"] == "300.00"
    assert summary["pit38_form_revenue_pln"] == "600.00"
    assert summary["pit38_form_cost_pln"] == "150.00"
    assert summary["art30b"]["pit8c_calculated_revenue_pln"] == "200.00"
    assert summary["art30b"]["pit8c_revenue_difference_pln"] == "300.00"
    assert summary["pit38_form_base_pln"] == "150"

    with_pit8c.tax_plan.pit8c_entries = [{"revenuePln": "-1.00", "costsPln": "100.00"}]
    build_pit38_views(merge, rows, with_pit8c)
    assert any(issue.code == "PIT8C_INPUT_INVALID" and is_blocking_issue(issue) for issue in merge.ledger.issues)


def test_pit8c_unknown_source_requires_decision_and_does_not_double_count():
    row = RealizedTaxRow(
        row_id="R", symbol="ABC", sell_trade_id="SELL", buy_trade_id="BUY",
        quantity=Decimal("1"), sell_tax_date=pd.Timestamp("2026-02-01"),
        buy_tax_date=pd.Timestamp("2025-01-01"), sell_fx_date=pd.Timestamp("2026-01-31"),
        buy_fx_date=pd.Timestamp("2024-12-31"), gross_revenue_pln=Decimal("200"),
        sell_commission_alloc_pln=Decimal("0"), net_revenue_pln=Decimal("200"),
        cost_pln=Decimal("100"), pnl_pln=Decimal("100"), acquisition_mode="BUY",
    )

    def run(decision=None, with_entry=True, parser="spreadsheet", source_name="CANONICAL_TAX_INPUT_TRADE",
            source_file="unknown.xlsx"):
        trade = make_trade(trade_id="SELL", side="SELL", source_name=source_name,
                           source_file=source_file)
        ledger = Ledger(trades_by_id={"SELL": trade}, metadata={
            "canonical_tax_input": {"records": [{"source": {
                "relative_path": source_file, "parser": parser}}]},
        })
        config = EngineConfig(tax_year=2026)
        if with_entry:
            config.tax_plan.pit8c_entries = [{"revenuePln": "250.00", "costsPln": "120.00"}]
        if decision:
            config.tax_plan.pit8c_source_decisions = {"pit8c_source:unknown.xlsx": decision}
        payload = build_pit38_views(MergeResult(ledger=ledger, canonical_dataset=CanonicalDataset()), [row], config)
        return payload, ledger

    baseline, baseline_ledger = run(with_entry=False)
    assert baseline["summary"]["pit38_form_revenue_pln"] == "200.00"
    assert not any(issue.code == "PIT8C_SOURCE_UNCONFIRMED" for issue in baseline_ledger.issues)

    pending, ledger = run()
    assert any(issue.code == "PIT8C_SOURCE_UNCONFIRMED" and is_blocking_issue(issue) for issue in ledger.issues)
    assert ledger.metadata["canonical_tax_input_consumption_runtime"]["reviewQueue"][0]["decision_key"] == "pit8c_source:unknown.xlsx"
    assert pending["summary"]["pit38_form_revenue_pln"] == "450.00"  # Wynik zablokowany.

    polish, ledger = run("pit8c_account")
    assert polish["summary"]["pit38_form_revenue_pln"] == "250.00"
    assert polish["summary"]["art30b"]["pit8c_calculated_revenue_pln"] == "200.00"
    assert not any(issue.code == "PIT8C_SOURCE_UNCONFIRMED" for issue in ledger.issues)

    known_foreign, ledger = run(parser="broker_report_json")
    assert known_foreign["summary"]["pit38_form_revenue_pln"] == "450.00"
    assert not any(issue.code == "PIT8C_SOURCE_UNCONFIRMED" for issue in ledger.issues)

    manual, ledger = run(source_name="USER_OVERRIDE")
    assert any(issue.scope_id == "pit8c_record:SELL" for issue in ledger.issues if issue.code == "PIT8C_SOURCE_UNCONFIRMED")

    # Zrzut API Freedom24 bywa obiektem JSON, wiec resolver daje mu ogolny parser
    # "json" - nadal jest to rachunek zagraniczny, nie zrodlo do potwierdzenia.
    api_dump, ledger = run(parser="json", source_file="pelny_zrzut_api_transakcje.json")
    assert api_dump["summary"]["pit38_form_revenue_pln"] == "450.00"
    assert not any(issue.code == "PIT8C_SOURCE_UNCONFIRMED" for issue in ledger.issues)
    other_json, ledger = run(parser="json", source_file="inny_broker.json")
    assert any(issue.code == "PIT8C_SOURCE_UNCONFIRMED" for issue in ledger.issues)

    _, ledger = run("no_tax_effect")
    assert any(issue.code == "PIT8C_SOURCE_UNCONFIRMED" for issue in ledger.issues)

    foreign, ledger = run("no_pit8c_account")
    assert foreign["summary"]["pit38_form_revenue_pln"] == "450.00"
    assert foreign["summary"]["art30b"]["pit8c_calculated_revenue_pln"] == "0.00"
    assert Decimal(foreign["summary"]["pit38_form_revenue_pln"]) - Decimal(foreign["summary"]["art30b"]["pit8c_revenue_pln"]) == Decimal("200.00")  # poz. 22
    assert Decimal(foreign["summary"]["pit38_form_cost_pln"]) - Decimal(foreign["summary"]["art30b"]["pit8c_cost_pln"]) == Decimal("100.00")  # poz. 23
    assert not any(issue.code == "PIT8C_SOURCE_UNCONFIRMED" for issue in ledger.issues)


@pytest.mark.parametrize("entry", [
    {"costsPln": "1.00"},
    {"revenuePln": "abc", "costsPln": "1.00"},
    {"revenuePln": "-1.00", "costsPln": "1.00"},
    {"revenuePln": "1.001", "costsPln": "1.00"},
    {"revenuePln": "1.000", "costsPln": "1.00"},
    {"revenuePln": "", "costsPln": "1.00"},
    {"revenuePln": "NaN", "costsPln": "1.00"},
    {"revenuePln": "1e2", "costsPln": "1.00"},
    {"revenuePln": "+1.00", "costsPln": "1.00"},
    {"_input_error": "PIT-8C musi byc lista wpisow"},
    None,
])
def test_invalid_pit8c_entry_blocks_but_returns_result(entry):
    config = EngineConfig(tax_year=2026)
    config.tax_plan.pit8c_entries = [entry]
    merge = MergeResult(ledger=Ledger(), canonical_dataset=CanonicalDataset())
    result = build_pit38_views(merge, [], config)
    assert result["summary"]["pit38_form_revenue_pln"] == "0.00"
    assert any(issue.code == "PIT8C_INPUT_INVALID" and is_blocking_issue(issue) for issue in merge.ledger.issues)


def test_only_invalid_pit8c_entries_keep_calculated_polish_part_instead_of_zero():
    def row(name: str, revenue: str, cost: str) -> RealizedTaxRow:
        return RealizedTaxRow(
            row_id=name, symbol=name, sell_trade_id=name, buy_trade_id=f"BUY-{name}",
            quantity=Decimal("1"), sell_tax_date=pd.Timestamp("2026-02-01"),
            buy_tax_date=pd.Timestamp("2025-02-01"), sell_fx_date=pd.Timestamp("2026-01-31"),
            buy_fx_date=pd.Timestamp("2025-01-31"), gross_revenue_pln=Decimal(revenue),
            sell_commission_alloc_pln=Decimal("0"), net_revenue_pln=Decimal(revenue),
            cost_pln=Decimal(cost), pnl_pln=Decimal(revenue) - Decimal(cost),
            acquisition_mode="BUY",
        )

    rows = [row("POLISH", "200.00", "100.00"), row("FOREIGN", "100.00", "50.00")]
    merge = MergeResult(ledger=Ledger(), canonical_dataset=CanonicalDataset())
    config = EngineConfig(tax_year=2026)
    config.tax_plan.pit8c_sell_trade_ids = {"POLISH"}
    config.tax_plan.pit8c_no_sell_trade_ids = {"FOREIGN"}
    config.tax_plan.pit8c_entries = [{"revenuePln": "abc", "costsPln": "1.00"}]
    summary = build_pit38_views(merge, rows, config)["summary"]
    # Pusta suma poprawnych wpisow dawala 0 w poz. 20/21, czyli polski dochod
    # znikal z formularza. Zostaje wlasny rachunek czesci polskiej.
    assert summary["art30b"]["pit8c_revenue_pln"] == "200.00"
    assert summary["art30b"]["pit8c_cost_pln"] == "100.00"
    assert summary["art30b"]["pit8c_source"] == "transakcje"
    assert summary["pit38_form_revenue_pln"] == "300.00"
    assert summary["pit38_form_cost_pln"] == "150.00"
    assert any(issue.code == "PIT8C_INPUT_INVALID" and is_blocking_issue(issue) for issue in merge.ledger.issues)


def test_pit8c_config_survives_dataclass_copy():
    config = EngineConfig()
    config.tax_plan.pit8c_entries = [{"revenuePln": "1.00", "costsPln": "0.00"}]
    config.tax_plan.pit8c_sell_trade_ids = {"SELL"}
    copied = replace(config.tax_plan)
    assert copied.pit8c_entries == config.tax_plan.pit8c_entries
    assert asdict(copied)["pit8c_sell_trade_ids"] == {"SELL"}


def test_pit8c_review_decisions_are_accepted_by_engine_adapter():
    assert normalize_review_decisions({
        "pit8c_source:unknown.xlsx": "pit8c_account",
        "pit8c_record:MANUAL": "no_pit8c_account",
        "pit8c_source:bad.xlsx": "no_tax_effect",
    }) == {
        "pit8c_source:unknown.xlsx": "pit8c_account",
        "pit8c_record:MANUAL": "no_pit8c_account",
        "pit8c_source:bad.xlsx": "no_tax_effect",
    }


def test_pit38_views_label_private_cash_fx_investment_loss_separately():
    deposit = CanonicalEvent(
        event_id="DEP-USD-LOSS",
        event_kind="DEPOSIT",
        symbol=None,
        linked_trade_id=None,
        amount=Decimal("1000.00"),
        currency="USD",
        effective_at=pd.Timestamp("2025-01-20"),
        comment="USD funding for investment",
        source_name="API_JSON_FULL",
        source_priority=110,
        source_record_id="DEP-USD-LOSS",
        tax_event_date=pd.Timestamp("2025-01-20"),
        fx_rate=Decimal("4.10"),
        logical_world="private_cash_fx",
    )
    buy = make_trade(
        trade_id="BUY-USES-USD",
        gross_amount=Decimal("1000.00"),
        commission=Decimal("0.00"),
        tax_event_date=pd.Timestamp("2025-01-21"),
        gross_fx_rate=Decimal("4.00"),
        buy_total_cost_pln=Decimal("4000.00"),
    )
    realized, issues = build_fifo_tax_rows([buy], EngineConfig())
    assert not issues
    merge_result = MergeResult(
        ledger=Ledger(
            trades_by_id={buy.trade_id: buy},
            events_by_id={deposit.event_id: deposit},
        ),
        canonical_dataset=CanonicalDataset(trades=(buy,), events=(deposit,)),
    )

    payload = build_pit38_views(
        merge_result,
        realized,
        EngineConfig(tax_year=2025),
        {"aggressive_user": Decimal("100.00")},
    )

    assert payload["summary"]["private_cash_fx_investment_loss_pln"] == "100.00"
    assert "PRIVATE_CASH_FX_INVESTMENT_LOSS" in payload["scenario_results"]["aggressive_user"].additional_costs


def test_fifo_rejects_implicit_award_when_no_explicit_buy_exists():
    sell_only = make_trade(
        trade_id="SELL-ONLY",
        side="SELL",
        symbol="PTON.US",
        quantity=Decimal("1"),
        gross_amount=Decimal("8.57"),
        commission=Decimal("2.02"),
        commission_currency="USD",
        sell_gross_revenue_pln=Decimal("34.00"),
        sell_net_revenue_pln=Decimal("26.86"),
        tax_event_date=pd.Timestamp("2025-02-10"),
        gross_fx_date=pd.Timestamp("2025-02-09"),
    )

    realized, issues = build_fifo_tax_rows([sell_only], EngineConfig(award_policy="REQUIRE_EXPLICIT"))

    assert any(issue.code == "AWARD_POLICY_UNRESOLVED" for issue in issues)

    # Przychod ze sprzedazy istnieje niezaleznie od tego, czy znamy nabycie.
    # Pominiecie go zanizaloby podatek i ukrylo problem, wiec ilosc bez pokrycia
    # wchodzi z zerowa podstawa kosztowa - a bramka FIFO i tak zatrzymuje
    # rozliczenie, wiec uzytkownik widzi pelna kwote razem z powodem.
    assert len(realized) == 1
    row = realized[0]
    assert row.quantity == Decimal("1")
    assert row.net_revenue_pln == Decimal("26.86")
    assert row.cost_pln == Decimal("0.00")
    assert row.pnl_pln == Decimal("26.86")
    assert row.buy_trade_id is None
    assert row.buy_reference_kind == "UNCOVERED"


def test_fifo_requires_dedicated_short_sale_engine_for_sell_before_buy():
    sell_first = make_trade(
        trade_id="SELL-FIRST",
        side="SELL",
        symbol="NBIS.US",
        quantity=Decimal("5"),
        gross_amount=Decimal("500"),
        commission=Decimal("0"),
        commission_currency="USD",
        sell_gross_revenue_pln=Decimal("2000.00"),
        sell_net_revenue_pln=Decimal("2000.00"),
        tax_event_date=pd.Timestamp("2025-02-10"),
        gross_fx_date=pd.Timestamp("2025-02-09"),
    )
    buy_later = make_trade(
        trade_id="BUY-LATER",
        side="BUY",
        symbol="NBIS.US",
        quantity=Decimal("5"),
        gross_amount=Decimal("400"),
        commission=Decimal("0"),
        commission_currency="USD",
        buy_total_cost_pln=Decimal("1600.00"),
        tax_event_date=pd.Timestamp("2025-02-20"),
        gross_fx_date=pd.Timestamp("2025-02-19"),
    )

    realized, issues = build_fifo_tax_rows([sell_first, buy_later], EngineConfig())

    assert any(issue.code == "SHORT_SALE_UNSUPPORTED_CASE" for issue in issues)
    # Sprzedaz bez pokrycia nie moze zniknac razem z przychodem. Test pilnowal
    # wczesniej pustej listy, czyli utrwalal zgubienie 2000 zl - kwoty realnej
    # niezaleznie od tego, czy silnik potrafi rozliczyc krotka sprzedaz.
    # Bramka FIFO i tak zatrzymuje rozliczenie, wiec uzytkownik widzi kwote
    # razem z powodem zatrzymania, zamiast cichej luki.
    assert len(realized) == 1
    assert realized[0].net_revenue_pln == Decimal("2000.00")
    assert realized[0].cost_pln == Decimal("0.00"), "nabycia nie znamy, wiec podstawa jest zerowa"
    assert realized[0].acquisition_mode == "SHORT_SALE_UNRESOLVED"
    assert realized[0].buy_reference_kind == "UNCOVERED"


def test_a_partly_covered_sale_splits_into_a_matched_and_an_uncovered_row():
    """Sprzedaz wieksza niz posiadane partie rozpada sie na dwie czesci.

    Wzorzec z niemieckiego silnika podatkowego: transakcja, ktora czesciowo
    zamyka pozycje, a czesciowo wykracza poza nia, dzieli sie na podzdarzenia,
    a kwoty pieniezne rozdzielaja sie proporcjonalnie do ilosci. U nas znaczy
    to tyle, ze czesc pokryta dostaje prawdziwa podstawe kosztowa, a czesc
    niepokryta - zerowa, i obie sa widoczne osobno.
    """
    buy = make_trade(
        trade_id="BUY-SMALL",
        side="BUY",
        symbol="TEST.US",
        quantity=Decimal("3"),
        gross_amount=Decimal("300"),
        commission=Decimal("0"),
        commission_currency="USD",
        buy_total_cost_pln=Decimal("1200.00"),
        tax_event_date=pd.Timestamp("2025-01-10"),
        gross_fx_date=pd.Timestamp("2025-01-09"),
    )
    sell = make_trade(
        trade_id="SELL-BIG",
        side="SELL",
        symbol="TEST.US",
        quantity=Decimal("5"),
        gross_amount=Decimal("600"),
        commission=Decimal("0"),
        commission_currency="USD",
        sell_gross_revenue_pln=Decimal("2500.00"),
        sell_net_revenue_pln=Decimal("2000.00"),
        tax_event_date=pd.Timestamp("2025-03-10"),
        gross_fx_date=pd.Timestamp("2025-03-09"),
    )

    realized, issues = build_fifo_tax_rows([buy, sell], EngineConfig(award_policy="ALLOW_ZERO_COST"))

    assert len(realized) == 2, "czesc pokryta i czesc niepokryta to dwa osobne wiersze"
    pokryta, niepokryta = realized
    assert pokryta.quantity == Decimal("3") and pokryta.cost_pln == Decimal("1200.00")
    assert niepokryta.quantity == Decimal("2") and niepokryta.cost_pln == Decimal("0.00")
    # Prowizja 500 zl dzieli sie proporcjonalnie do ilosci: 3/5 i 2/5.
    assert pokryta.sell_commission_alloc_pln == Decimal("300.00")
    assert niepokryta.sell_commission_alloc_pln == Decimal("200.00")
    # Caly przychod netto sprzedazy jest wykazany, nic nie ginie.
    assert pokryta.net_revenue_pln + niepokryta.net_revenue_pln == Decimal("2000.00")
    assert any(issue.code == "SELL_EXCEEDS_FIFO_LOTS" for issue in issues)


def test_fifo_does_not_mutate_sell_trade_when_gross_revenue_is_missing():
    buy = make_trade(
        trade_id="BUY-NO-MUTATION",
        quantity=Decimal("1"),
        gross_amount=Decimal("100"),
        commission=Decimal("0"),
        commission_currency="USD",
        buy_total_cost_pln=Decimal("400.00"),
        tax_event_date=pd.Timestamp("2026-01-10"),
        gross_fx_date=pd.Timestamp("2026-01-09"),
    )
    sell = make_trade(
        trade_id="SELL-NO-MUTATION",
        side="SELL",
        quantity=Decimal("1"),
        gross_amount=Decimal("150"),
        commission=Decimal("0"),
        commission_currency="USD",
        sell_gross_revenue_pln=None,
        sell_net_revenue_pln=Decimal("600.00"),
        tax_event_date=pd.Timestamp("2026-02-10"),
        gross_fx_date=pd.Timestamp("2026-02-09"),
    )

    realized, issues = build_fifo_tax_rows([buy, sell], EngineConfig())

    assert not issues
    assert len(realized) == 1
    assert sell.sell_gross_revenue_pln is None


def test_fifo_realized_row_ids_are_stable_and_unique_for_split_lots():
    buy_a = make_trade(
        trade_id="BUY-SPLIT-A",
        quantity=Decimal("1"),
        gross_amount=Decimal("100"),
        commission=Decimal("0"),
        commission_currency="USD",
        buy_total_cost_pln=Decimal("400.00"),
        tax_event_date=pd.Timestamp("2026-01-10"),
        gross_fx_date=pd.Timestamp("2026-01-09"),
    )
    buy_b = make_trade(
        trade_id="BUY-SPLIT-B",
        quantity=Decimal("1"),
        gross_amount=Decimal("105"),
        commission=Decimal("0"),
        commission_currency="USD",
        buy_total_cost_pln=Decimal("420.00"),
        tax_event_date=pd.Timestamp("2026-01-11"),
        gross_fx_date=pd.Timestamp("2026-01-10"),
    )
    sell = make_trade(
        trade_id="SELL-SPLIT",
        side="SELL",
        quantity=Decimal("2"),
        gross_amount=Decimal("300"),
        commission=Decimal("0"),
        commission_currency="USD",
        sell_gross_revenue_pln=Decimal("1200.00"),
        sell_net_revenue_pln=Decimal("1200.00"),
        tax_event_date=pd.Timestamp("2026-02-10"),
        gross_fx_date=pd.Timestamp("2026-02-09"),
    )

    realized, issues = build_fifo_tax_rows([buy_a, buy_b, sell], EngineConfig())
    row_ids = [row.row_id for row in realized]

    assert not issues
    assert len(row_ids) == 2
    assert len(row_ids) == len(set(row_ids))
    assert row_ids == [
        "RR-SELL-SPLIT-BUY-SPLIT-A-0001",
        "RR-SELL-SPLIT-BUY-SPLIT-B-0002",
    ]


def test_a_year_that_ends_with_income_carries_no_loss_forward():
    """Strata roku to wynik calego roku, a nie suma stratnych pozycji.

    Sumowanie samych minusow dawalo strate do odliczenia nawet wtedy, gdy rok
    zakonczyl sie dochodem - na danych uzytkownika bylo to 7453,73 zl przy
    realnym dochodzie 1533 zl za 2025.
    """
    losing_buy = make_trade(
        trade_id="BUY-LOSS",
        quantity=Decimal("1"),
        gross_amount=Decimal("250"),
        commission=Decimal("0"),
        commission_currency="USD",
        buy_total_cost_pln=Decimal("1000.00"),
        tax_event_date=pd.Timestamp("2025-02-10"),
        gross_fx_date=pd.Timestamp("2025-02-09"),
    )
    losing_sell = make_trade(
        trade_id="SELL-LOSS",
        side="SELL",
        quantity=Decimal("1"),
        gross_amount=Decimal("175"),
        commission=Decimal("0"),
        commission_currency="USD",
        sell_gross_revenue_pln=Decimal("700.00"),
        sell_net_revenue_pln=Decimal("700.00"),
        tax_event_date=pd.Timestamp("2025-03-20"),
        gross_fx_date=pd.Timestamp("2025-03-19"),
    )
    winning_buy = make_trade(
        trade_id="BUY-GAIN",
        symbol="TSLA.US",
        quantity=Decimal("1"),
        gross_amount=Decimal("100"),
        commission=Decimal("0"),
        commission_currency="USD",
        buy_total_cost_pln=Decimal("400.00"),
        tax_event_date=pd.Timestamp("2025-04-10"),
        gross_fx_date=pd.Timestamp("2025-04-09"),
    )
    winning_sell = make_trade(
        trade_id="SELL-GAIN",
        symbol="TSLA.US",
        side="SELL",
        quantity=Decimal("1"),
        gross_amount=Decimal("300"),
        commission=Decimal("0"),
        commission_currency="USD",
        sell_gross_revenue_pln=Decimal("1200.00"),
        sell_net_revenue_pln=Decimal("1200.00"),
        tax_event_date=pd.Timestamp("2025-05-15"),
        gross_fx_date=pd.Timestamp("2025-05-14"),
    )

    realized, issues = build_fifo_tax_rows(
        [losing_buy, losing_sell, winning_buy, winning_sell], EngineConfig()
    )
    assert not issues

    payload_2026 = build_pit38_views(
        MergeResult(ledger=Ledger(), canonical_dataset=CanonicalDataset()),
        realized,
        EngineConfig(tax_year=2026),
    )

    # 2025: -300 na jednej pozycji, +800 na drugiej, czyli rok na plusie.
    assert payload_2026["prior_year_loss_ledger"] == []
    assert payload_2026["summary"]["prior_year_losses_available_pln"] == "0.00"
    assert payload_2026["summary"]["prior_year_loss_used_pln"] == "0.00"


def test_fifo_ledger_disagreeing_with_the_broker_is_reported():
    """Rejestr partii, a nie suma kupna i sprzedazy, niesie podstawe kosztowa.

    Wzorzec z niemieckiego silnika podatkowego: raport brokera jest stanem
    faktycznym, a odtworzony rejestr - hipoteza. Uzgodnienie liczone dotad
    wprost z transakcji nie widzialo rozjazdu rejestru: obie strony liczylo z
    tego samego zrodla. Sprzedaz bez pokrycia zostawia rejestr pusty, choc
    broker raportuje posiadane sztuki - i wlasnie to musi byc widoczne.
    """
    from investment_tax_engine.merge.depo_reconcile import reconcile_fifo_lots_vs_depo
    from investment_tax_engine.models.core import Ledger

    buy = make_trade(
        trade_id="BUY-REC",
        side="BUY",
        symbol="TEST.US",
        quantity=Decimal("10"),
        gross_amount=Decimal("1000"),
        commission=Decimal("0"),
        commission_currency="USD",
        buy_total_cost_pln=Decimal("4000.00"),
        tax_event_date=pd.Timestamp("2025-01-10"),
        gross_fx_date=pd.Timestamp("2025-01-09"),
    )
    ledger = Ledger()
    ledger.trades_by_id[buy.trade_id] = buy
    payload = {"securities_flows_json": [{"ticker": "TEST.US", "quantity_at_end": "7"}]}

    rows = reconcile_fifo_lots_vs_depo(ledger, payload)

    assert rows == [
        {
            "symbol": "TEST.US",
            "depo_qty": "7",
            "fifo_open_qty": "10",
            "difference": "3",
            "matches": False,
        }
    ]
    assert any(issue.code == "FIFO_LEDGER_POSITION_MISMATCH" for issue in ledger.issues)


def test_fifo_ledger_matching_the_broker_raises_nothing():
    from investment_tax_engine.merge.depo_reconcile import reconcile_fifo_lots_vs_depo
    from investment_tax_engine.models.core import Ledger

    buy = make_trade(
        trade_id="BUY-OK",
        side="BUY",
        symbol="TEST.US",
        quantity=Decimal("7"),
        gross_amount=Decimal("700"),
        commission=Decimal("0"),
        commission_currency="USD",
        buy_total_cost_pln=Decimal("2800.00"),
        tax_event_date=pd.Timestamp("2025-01-10"),
        gross_fx_date=pd.Timestamp("2025-01-09"),
    )
    ledger = Ledger()
    ledger.trades_by_id[buy.trade_id] = buy
    payload = {"securities_flows_json": [{"ticker": "TEST.US", "quantity_at_end": "7"}]}

    rows = reconcile_fifo_lots_vs_depo(ledger, payload)

    assert rows[0]["matches"] is True
    assert not [issue for issue in ledger.issues if issue.code == "FIFO_LEDGER_POSITION_MISMATCH"]


def test_open_lots_detail_keeps_prior_year_lot_and_remaining_cost():
    from investment_tax_engine.tax.fifo_engine import open_lots_detail

    buy_2025 = make_trade(
        trade_id="BUY-2025-OPEN",
        side="BUY",
        quantity=Decimal("4"),
        gross_amount=Decimal("400"),
        commission=Decimal("0"),
        commission_currency="USD",
        buy_total_cost_pln=Decimal("1600.00"),
        tax_event_date=pd.Timestamp("2025-03-10"),
        gross_fx_date=pd.Timestamp("2025-03-07"),
    )
    sell_2026 = make_trade(
        trade_id="SELL-2026-PART",
        side="SELL",
        quantity=Decimal("1"),
        gross_amount=Decimal("150"),
        commission=Decimal("0"),
        commission_currency="USD",
        sell_gross_revenue_pln=Decimal("600.00"),
        sell_net_revenue_pln=Decimal("600.00"),
        tax_event_date=pd.Timestamp("2026-01-10"),
        gross_fx_date=pd.Timestamp("2026-01-09"),
    )

    lots = open_lots_detail([buy_2025, sell_2026], EngineConfig())

    assert len(lots) == 1
    lot = lots[0]
    assert lot["origin_trade_id"] == "BUY-2025-OPEN"
    assert lot["open_date"].startswith("2025-03-10")
    assert Decimal(lot["quantity_open"]) == Decimal("4")
    assert Decimal(lot["quantity_remaining"]) == Decimal("3")
    assert Decimal(lot["cost_remaining_pln"]) == Decimal("1200.00")
    assert lot["currency"] == buy_2025.trade_currency

    # Pozycja sprzedana w calosci nie zostaje w portfelu.
    sell_rest = make_trade(
        trade_id="SELL-2026-REST",
        side="SELL",
        quantity=Decimal("3"),
        gross_amount=Decimal("450"),
        commission=Decimal("0"),
        commission_currency="USD",
        sell_gross_revenue_pln=Decimal("1800.00"),
        sell_net_revenue_pln=Decimal("1800.00"),
        tax_event_date=pd.Timestamp("2026-02-10"),
        gross_fx_date=pd.Timestamp("2026-02-09"),
    )
    assert open_lots_detail([buy_2025, sell_2026, sell_rest], EngineConfig()) == []


def test_fifo_assigns_last_grosz_of_lot_cost_to_final_sale():
    buy = make_trade(
        trade_id="BUY-THREE", quantity=Decimal("3"), buy_total_cost_pln=Decimal("100.00"),
        tax_event_date=pd.Timestamp("2025-01-01"),
    )
    sells = [make_trade(
        trade_id=f"SELL-{index}", side="SELL", quantity=Decimal("1"),
        sell_gross_revenue_pln=Decimal("50.00"), sell_net_revenue_pln=Decimal("50.00"),
        tax_event_date=pd.Timestamp(f"2025-02-0{index}"),
    ) for index in (1, 2, 3)]

    rows, issues = build_fifo_tax_rows([buy, *sells], EngineConfig())

    assert not issues
    assert [row.cost_pln for row in rows] == [Decimal("33.33"), Decimal("33.33"), Decimal("33.34")]
    assert sum((row.cost_pln for row in rows), Decimal("0")) == Decimal("100.00")
    assert Decimal(open_lots_detail([buy, sells[0]], EngineConfig())[0]["cost_remaining_pln"]) == Decimal("66.67")
    assert Decimal(open_lots_detail([buy, *sells[:2]], EngineConfig())[0]["cost_remaining_pln"]) == Decimal("33.34")


def test_fifo_assigns_last_grosz_of_sale_to_final_matched_lot():
    buys = [make_trade(
        trade_id=f"BUY-{index}", quantity=Decimal("1"), buy_total_cost_pln=Decimal("10.00"),
        tax_event_date=pd.Timestamp(f"2025-01-0{index}"),
    ) for index in (1, 2, 3)]
    sell = make_trade(
        trade_id="SELL-THREE", side="SELL", quantity=Decimal("3"),
        sell_gross_revenue_pln=Decimal("100.00"), sell_net_revenue_pln=Decimal("99.99"),
        tax_event_date=pd.Timestamp("2025-02-01"),
    )

    rows, issues = build_fifo_tax_rows([*buys, sell], EngineConfig())

    assert not issues
    assert [row.gross_revenue_pln for row in rows] == [Decimal("33.33"), Decimal("33.33"), Decimal("33.34")]
    assert sum((row.gross_revenue_pln for row in rows), Decimal("0")) == Decimal("100.00")
    assert sum((row.sell_commission_alloc_pln for row in rows), Decimal("0")) == Decimal("0.01")
    assert sum((row.net_revenue_pln for row in rows), Decimal("0")) == Decimal("99.99")


def test_part_c_uses_gross_sale_and_sell_commission_as_cost():
    buy = make_trade(
        trade_id="BUY-C", quantity=Decimal("1"), buy_total_cost_pln=Decimal("400.00"),
        tax_event_date=pd.Timestamp("2025-01-01"),
    )
    sell = make_trade(
        trade_id="SELL-C", side="SELL", quantity=Decimal("1"),
        sell_gross_revenue_pln=Decimal("600.00"), sell_net_revenue_pln=Decimal("595.00"),
        tax_event_date=pd.Timestamp("2025-02-01"),
    )
    rows, issues = build_fifo_tax_rows([buy, sell], EngineConfig())
    merge_result = MergeResult(
        ledger=Ledger(trades_by_id={buy.trade_id: buy, sell.trade_id: sell}),
        canonical_dataset=CanonicalDataset(),
    )

    payload = build_pit38_views(merge_result, rows, EngineConfig(tax_year=2025))
    zg = build_pit_zg_rows(rows, merge_result.ledger.trades_by_id)[0]

    assert not issues
    assert payload["summary"]["total_revenue_pln"] == "600.00"
    assert payload["summary"]["total_cost_pln"] == "405.00"
    assert payload["summary"]["total_pnl_pln"] == "195.00"
    assert zg["revenue_pln"] == Decimal("600.00")
    assert zg["cost_pln"] == Decimal("405.00")
    exported = fifo_rows_as_dicts(rows, 2025)
    assert exported[0]["gross_revenue_pln"] == Decimal("600.00")
    assert exported[0]["cost_pln"] + exported[0]["sell_commission_alloc_pln"] == Decimal("405.00")


def test_unmatched_withholding_cannot_offset_another_dividends_polish_tax():
    buy = make_trade(
        trade_id="BUY-TAX", quantity=Decimal("1"), buy_total_cost_pln=Decimal("400.00"),
        tax_event_date=pd.Timestamp("2025-01-01"),
    )
    sell = make_trade(
        trade_id="SELL-TAX", side="SELL", quantity=Decimal("1"),
        sell_gross_revenue_pln=Decimal("600.00"), sell_net_revenue_pln=Decimal("600.00"),
        tax_event_date=pd.Timestamp("2025-02-01"),
    )
    dividend = CanonicalEvent(
        event_id="DIV-TAX", event_kind="DIVIDEND", symbol="NBIS.US", linked_trade_id=None,
        amount=Decimal("1000"), currency="USD", effective_at=pd.Timestamp("2025-03-01"),
        comment=None, source_name="BROKER_JSON", source_priority=70, source_record_id="DIV-TAX",
        tax_event_date=pd.Timestamp("2025-03-01"), amount_pln=Decimal("1000.00"), country="US",
    )
    withholding = CanonicalEvent(
        event_id="TAX-UNMATCHED", event_kind="TAX", symbol="NBIS.US", linked_trade_id=None,
        amount=Decimal("-200"), currency="EUR", effective_at=pd.Timestamp("2025-06-01"),
        comment=None, source_name="BROKER_JSON", source_priority=70, source_record_id="TAX-UNMATCHED",
        tax_event_date=pd.Timestamp("2025-06-01"), amount_pln=Decimal("-200.00"), country="DE",
    )
    rows, _ = build_fifo_tax_rows([buy, sell], EngineConfig())
    merge_result = MergeResult(
        ledger=Ledger(
            trades_by_id={buy.trade_id: buy, sell.trade_id: sell},
            events_by_id={dividend.event_id: dividend, withholding.event_id: withholding},
        ),
        canonical_dataset=CanonicalDataset(),
    )

    payload = build_pit38_views(merge_result, rows, EngineConfig(tax_year=2025))
    zg = build_pit_zg_rows(
        rows, merge_result.ledger.trades_by_id,
        payload["foreign_tax_view"], payload["dividends_view"],
    )

    assert payload["foreign_tax_view"][0]["matched_dividend_event_id"] is None
    assert payload["summary"]["art30a"]["polish_tax_19_pln"] == "190.00"
    assert payload["summary"]["art30a"]["credit_used_pln"] == "0.00"
    assert payload["summary"]["art30a"]["foreign_tax_not_creditable_pln"] == "200.00"
    assert payload["summary"]["art30a"]["tax_to_pay_pln"] == "190.00"
    assert any(issue.code == "FOREIGN_TAX_WITHOUT_DIVIDEND" for issue in merge_result.ledger.issues)
    assert foreign_capital_tax_credit(zg, Decimal("38.00"), Decimal("200.00")) == Decimal("0.00")
    assert zg[0]["foreign_tax_pln"] == Decimal("0.00")


def _dividend_case(*events: CanonicalEvent):
    from investment_tax_engine.models.core import EngineRunResult
    from investment_tax_engine.tax.filing_package import _build_fallback_projection_from_summary

    merge = MergeResult(
        ledger=Ledger(events_by_id={event.event_id: event for event in events}),
        canonical_dataset=CanonicalDataset(),
    )
    payload = build_pit38_views(merge, [], EngineConfig(tax_year=2025))
    result = EngineRunResult.__new__(EngineRunResult)
    result.annual_summary = payload["summary"]
    result.primary_scenario = "aggressive_user"
    result.plan_used = "aggressive_user"
    projection = _build_fallback_projection_from_summary(result)
    fields = {field.position: field.value for field in projection.form_fields}
    return payload, merge.ledger.issues, fields


def _dividend_event(event_id: str, country: str, amount: str, kind: str = "DIVIDEND") -> CanonicalEvent:
    return CanonicalEvent(
        event_id=event_id, event_kind=kind, symbol=f"TEST.{country}", linked_trade_id=None,
        amount=Decimal(amount), currency="PLN", effective_at=pd.Timestamp("2025-03-01"),
        comment=None, source_name="TEST", source_priority=70, source_record_id=event_id,
        tax_event_date=pd.Timestamp("2025-03-01"), amount_pln=Decimal(amount), country=country,
        cost_bucket="SOURCE_TAX" if kind == "TAX" else None,
    )


def test_polish_dividend_is_excluded_from_part_g_but_us_dividend_is_included():
    payload, issues, fields = _dividend_case(
        _dividend_event("PL-DIV", "PL", "1000.00"),
        _dividend_event("US-DIV", "US", "1000.00"),
        _dividend_event("US-TAX", "US", "-150.00", "TAX"),
    )

    assert fields["47"] == Decimal("190.00")
    assert fields["48"] == Decimal("150.00")
    assert fields["49"] == Decimal("40")
    assert fields.get("46", Decimal("0")) == Decimal("0")
    assert payload["summary"]["art30a"]["gross_dividends_pln"] == "1000.00"
    zg = build_pit_zg_rows([], {}, payload["foreign_tax_view"], payload["dividends_view"])
    assert [row["country"] for row in zg] == ["US"]
    domestic = next(issue for issue in issues if issue.code == "DOMESTIC_DIVIDEND_EXCLUDED")
    assert domestic.blocking is False
    assert "1000" in domestic.message and "TEST.PL" in domestic.message


def test_refund_in_same_year_reduces_credit_in_part_g():
    refund = _dividend_event("US-REFUND", "US", "50.00", "TAX")
    refund.effective_at = pd.Timestamp("2025-08-01")
    refund.tax_event_date = refund.effective_at
    payload, _, fields = _dividend_case(
        _dividend_event("US-DIV", "US", "1000.00"),
        _dividend_event("US-TAX", "US", "-150.00", "TAX"),
        refund,
    )

    assert fields["47"] == Decimal("190.00")
    assert fields["48"] == Decimal("100.00")
    assert fields["49"] == Decimal("90")
    assert payload["summary"]["art30a"]["foreign_withholding_tax_pln"] == "100.00"
    assert payload["summary"]["taxes_from_dane_pln"] == "100.00"


def test_unmatched_refund_does_not_increase_credit():
    payload, issues, fields = _dividend_case(
        _dividend_event("US-DIV", "US", "1000.00"),
        _dividend_event("US-TAX", "US", "-100.00", "TAX"),
        _dividend_event("DE-REFUND", "DE", "50.00", "TAX"),
    )

    assert fields["48"] == Decimal("100.00")
    assert fields["49"] == Decimal("90")
    assert payload["summary"]["art30a"]["foreign_withholding_tax_pln"] == "100.00"
    assert any(issue.code == "FOREIGN_TAX_WITHOUT_DIVIDEND" for issue in issues)


def test_us_thirty_percent_withholding_still_has_fifteen_percent_credit():
    _, _, fields = _dividend_case(
        _dividend_event("US-DIV", "US", "1000.00"),
        _dividend_event("US-TAX", "US", "-300.00", "TAX"),
    )
    assert fields["47"] == Decimal("190.00")
    assert fields["48"] == Decimal("150.00")
    assert fields["49"] == Decimal("40")


def test_unknown_country_dividend_remains_in_part_g():
    unknown = _dividend_event("UNKNOWN-DIV", "XX", "1000.00")
    unknown.country = None
    _, issues, fields = _dividend_case(unknown)
    assert fields["47"] == Decimal("190.00")
    assert not any(issue.code == "DOMESTIC_DIVIDEND_EXCLUDED" for issue in issues)


def test_zdarzenie_bez_kwoty_i_waluty_nie_szuka_kursu_nbp():
    """Noga papierowa wykupu noty i przydzial akcji bez wyceny nie maja czego
    przeliczac - pusta waluta dawala blokujacy NBP_RATE_NOT_FOUND."""
    from investment_tax_engine.models.core import EngineConfig
    from investment_tax_engine.tax.fx_engine import apply_nbp_fx_to_event

    class BezKursow:
        def get_rate(self, currency, date):
            raise AssertionError(f"kurs nie powinien byc potrzebny: {currency!r}")

    event = make_bonus_grant(
        amount=Decimal("0"), currency="", amount_pln=None, grant_value_pln=None, grant_market_value=None
    )
    apply_nbp_fx_to_event(event, BezKursow(), EngineConfig())

    assert event.amount_pln == Decimal("0.00")
    assert event.status == "FX_NOT_REQUIRED"
    assert event.grant_value_pln is None, "nieznana wycena przydzialu to nie zero"


def test_zakres_kursow_nbp_pomija_prowizje_w_walucie_wirtualnej():
    # Prowizja w BNB albo w nabytej walucie nie jest wyceniana, wiec szukanie
    # dla niej kursow NBP dawalo falszywa luke kursowa NBP_COVERAGE_GAP.
    from types import SimpleNamespace

    from investment_tax_engine.app.engine import InvestmentTaxEngine

    transakcje = {
        f"K-{i}": make_trade(
            trade_id=f"K-{i}", symbol=symbol, instrument_class="CRYPTO", logical_world="crypto_tax",
            trade_currency="USD", commission=Decimal("0.1"), commission_currency=prowizja,
        )
        for i, (symbol, prowizja) in enumerate((("BTCUSD", "BNB"), ("PEPEUSD", "PEPE"), ("ETHUSD", "EUR")))
    }
    silnik = InvestmentTaxEngine(EngineConfig())
    _, _, waluty = silnik._detect_fx_horizon(SimpleNamespace(ledger=SimpleNamespace(trades_by_id=transakcje, events_by_id={})))
    assert waluty == {"USD", "EUR"}


def test_suma_odliczen_krajowych_nie_przekracza_podatku_przed_odliczeniem():
    """Strata z trzeciego panstwa obniza dochod laczny - kazdy limit krajowy rownal sie calemu podatkowi."""
    wiersze = [
        {"country": "US", "income_pln": Decimal("100.00"), "foreign_tax_pln": Decimal("20.00")},
        {"country": "DE", "income_pln": Decimal("100.00"), "foreign_tax_pln": Decimal("20.00")},
        {"country": "NL", "income_pln": Decimal("0.00"), "foreign_tax_pln": Decimal("0.00")},
    ]

    assert foreign_capital_tax_credit(wiersze, Decimal("9.50"), Decimal("50.00")) == Decimal("9.50")
