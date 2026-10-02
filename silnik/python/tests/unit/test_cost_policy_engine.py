from __future__ import annotations

from decimal import Decimal
from types import SimpleNamespace

import pandas as pd

from investment_tax_engine.models.core import CanonicalDataset, CanonicalEvent, CanonicalTrade, CostItem, EngineConfig, FundingCostEvent, Ledger, MergeResult, TaxPlanConfig, UserOverrides
from investment_tax_engine.tax.cost_policy_engine import extract_cost_items
from investment_tax_engine.tax.funding_cost_allocator import allocate_funding_costs
from investment_tax_engine.tax.fx_conversion_cost_engine import extract_fx_conversion_costs


def make_trade(**overrides) -> CanonicalTrade:
    base = dict(
        trade_id="BUY-1",
        order_id="O-1",
        trade_number="N-1",
        symbol="NBIS.US",
        isin=None,
        side="BUY",
        instrument_type_code="1",
        instrument_class="EQUITY",
        market_id="30000000001",
        quantity=Decimal("2"),
        price=Decimal("100"),
        gross_amount=Decimal("200"),
        trade_currency="USD",
        commission=Decimal("0"),
        commission_currency="USD",
        broker_reported_profit=Decimal("0"),
        executed_at=pd.Timestamp("2026-01-03 10:00:00"),
        exchange_time=pd.Timestamp("2026-01-03 10:00:00"),
        settlement_date=pd.Timestamp("2026-01-05 00:00:00"),
        confirm_time=None,
        otc=False,
        repo_close=None,
        base_contract_code=None,
        current_position_qty_after_trade=Decimal("0"),
        source_name="API_JSON_FULL",
        source_priority=110,
        source_record_id="fixture-row",
        tax_event_date=pd.Timestamp("2026-01-03"),
        gross_amount_pln=Decimal("400.00"),
        commission_pln=Decimal("0.00"),
        buy_total_cost_pln=Decimal("400.00"),
        logical_world="equity_tax",
        sources=["API_JSON_FULL"],
    )
    base.update(overrides)
    return CanonicalTrade(**base)


def make_deposit(deposit_id="DEP-1", date="2026-01-02", currency="PLN") -> CanonicalEvent:
    return CanonicalEvent(
        event_id=deposit_id, event_kind="DEPOSIT", symbol=None, linked_trade_id=None,
        amount=Decimal("1000"), currency=currency, effective_at=pd.Timestamp(date),
        comment=None, source_name="TEST", source_priority=100, source_record_id=deposit_id,
    )


def test_allocate_funding_fee_proportionally_to_first_purchase_batch():
    funding_event = FundingCostEvent(
        funding_event_id="FUND-1",
        amount=Decimal("25.00"),
        currency="PLN",
        date=pd.Timestamp("2026-01-02"),
        linked_deposit_id="DEP-1",
        source="USER_OVERRIDE",
        evidence_note="Bank transfer commission",
        deposit_amount=Decimal("1000.00"),
    )
    trades = [
        make_trade(trade_id="BUY-A", gross_amount_pln=Decimal("400.00"), buy_total_cost_pln=Decimal("400.00")),
        make_trade(
            trade_id="BUY-B",
            gross_amount_pln=Decimal("600.00"),
            buy_total_cost_pln=Decimal("600.00"),
            executed_at=pd.Timestamp("2026-01-04 10:00:00"),
            exchange_time=pd.Timestamp("2026-01-04 10:00:00"),
            tax_event_date=pd.Timestamp("2026-01-04"),
        ),
        make_trade(
            trade_id="BUY-C",
            gross_amount_pln=Decimal("300.00"),
            buy_total_cost_pln=Decimal("300.00"),
            executed_at=pd.Timestamp("2026-01-20 10:00:00"),
            exchange_time=pd.Timestamp("2026-01-20 10:00:00"),
            tax_event_date=pd.Timestamp("2026-01-20"),
        ),
    ]

    allocations = allocate_funding_costs(
        [funding_event],
        trades,
        deposit_events=[make_deposit()],
        allocation_mode="proportional_first_batch",
    )

    assert len(allocations) == 2
    assert allocations[0].trade_id == "BUY-A"
    assert allocations[0].allocated_amount_pln == Decimal("10.00")
    assert allocations[1].trade_id == "BUY-B"
    assert allocations[1].allocated_amount_pln == Decimal("15.00")
    assert {allocation.trade_id for allocation in allocations} == {"BUY-A", "BUY-B"}


def test_allocate_funding_fee_limits_default_batch_to_ten_buys_after_event_date():
    funding_event = FundingCostEvent(
        funding_event_id="FUND-LIMIT",
        amount=Decimal("12.00"),
        currency="PLN",
        date=pd.Timestamp("2026-01-02"),
        linked_deposit_id="DEP-LIMIT",
        source="USER_OVERRIDE",
        evidence_note="Bank transfer commission",
        deposit_amount=Decimal("5000.00"),
    )
    trades = [
        make_trade(
            trade_id=f"BUY-{index:02d}",
            gross_amount_pln=Decimal("100.00"),
            buy_total_cost_pln=Decimal("100.00"),
            executed_at=pd.Timestamp("2026-01-03 10:00:00") + pd.Timedelta(minutes=index),
            exchange_time=pd.Timestamp("2026-01-03 10:00:00") + pd.Timedelta(minutes=index),
            tax_event_date=pd.Timestamp("2026-01-03"),
        )
        for index in range(1, 13)
    ]

    allocations = allocate_funding_costs(
        [funding_event],
        trades,
        deposit_events=[make_deposit("DEP-LIMIT")],
        allocation_mode="proportional_first_batch",
    )

    assert len(allocations) == 10
    assert [allocation.trade_id for allocation in allocations] == [f"BUY-{index:02d}" for index in range(1, 11)]
    assert sum((allocation.allocated_amount_pln for allocation in allocations), Decimal("0.00")) == Decimal("12.00")


def test_funding_fee_requires_matching_deposit_with_currency_and_date():
    fee = FundingCostEvent(
        funding_event_id="FUND-1", amount=Decimal("25"), currency="PLN",
        date=pd.Timestamp("2026-01-02"), linked_deposit_id="DEP-1", source="USER_OVERRIDE",
    )
    trade = make_trade()
    for deposits in ([], [make_deposit(currency="USD")], [make_deposit(date="2026-02-02")]):
        assert allocate_funding_costs([fee], [trade], deposit_events=deposits) == []
    assert len(allocate_funding_costs([fee], [trade], deposit_events=[make_deposit()])) == 1


def test_fx_spread_uses_only_invested_currency_once():
    fx_trades = [make_trade(
        trade_id=f"FX-{index}", symbol="USD/PLN", instrument_class="FX", side="BUY",
        quantity=Decimal("100"), price=Decimal("4.10"), gross_amount=Decimal("410"),
        trade_currency="PLN", gross_fx_rate=Decimal("1"), gross_amount_pln=Decimal("410"),
        tax_event_date=pd.Timestamp("2026-01-02"), logical_world="private_cash_fx",
    ) for index in (1, 2)]
    purchase = make_trade(
        trade_id="INVEST", gross_amount=Decimal("25"), quantity=Decimal("1"),
        trade_currency="USD", tax_event_date=pd.Timestamp("2026-01-03"),
    )
    ledger = Ledger(trades_by_id={trade.trade_id: trade for trade in [*fx_trades, purchase]})
    result = MergeResult(ledger=ledger, canonical_dataset=CanonicalDataset())

    class Rates:
        def get_rate(self, currency, date):
            assert currency == "USD"
            return SimpleNamespace(rate=Decimal("4"))

    items, issues = extract_fx_conversion_costs(result, Rates())
    assert [(item.source_id, item.amount_pln, item.included_in_plan) for item in items] == [
        ("FX-1", Decimal("2.50"), {"aggressive_user"}),
        ("FX-2", Decimal("10.00"), set()),
    ]
    assert any(issue.code == "FX_CONVERSION_COST_WITHOUT_TRACE" and issue.scope_id == "FX-2" for issue in issues)


def test_cashflow_trade_commission_becomes_cost_when_trade_has_no_commission():
    trade = make_trade(trade_id="645345448", commission=Decimal("0"), commission_pln=Decimal("0.00"))
    event = CanonicalEvent(
        event_id="REPORT-CASHFLOW-3582135977",
        event_kind="TRADE_FEE",
        symbol="NBIS.US",
        linked_trade_id="645345448",
        amount=Decimal("-2.40"),
        currency="USD",
        effective_at=pd.Timestamp("2026-04-27"),
        comment="(Trade 645345448 sell NBIS.US )",
        source_name="API_JSON_FULL",
        source_priority=110,
        source_record_id="3582135977",
        tax_event_date=pd.Timestamp("2026-04-27"),
        amount_pln=Decimal("-9.60"),
        cost_bucket="TRADE_COMMISSION",
    )
    ledger = Ledger()
    ledger.trades_by_id[trade.trade_id] = trade
    ledger.events_by_id[event.event_id] = event
    merge_result = MergeResult(ledger=ledger, canonical_dataset=CanonicalDataset(trades=(trade,), events=(event,)))
    config = EngineConfig(
        tax_plan=TaxPlanConfig(include_fx_conversion_costs=False, include_bank_funding_fees=False)
    )

    items, _, _ = extract_cost_items(merge_result, config, fx_provider=None)

    assert len(items) == 1
    assert items[0].kind == "TRADE_COMMISSION"
    assert items[0].amount_pln == Decimal("9.60")
    assert items[0].allocation_target == "645345448"


def test_cashflow_trade_commission_does_not_duplicate_existing_trade_commission():
    trade = make_trade(trade_id="645345448", commission=Decimal("2.40"), commission_pln=Decimal("9.60"))
    event = CanonicalEvent(
        event_id="REPORT-CASHFLOW-3582135977",
        event_kind="TRADE_FEE",
        symbol="NBIS.US",
        linked_trade_id="645345448",
        amount=Decimal("-2.40"),
        currency="USD",
        effective_at=pd.Timestamp("2026-04-27"),
        comment="(Trade 645345448 sell NBIS.US )",
        source_name="API_JSON_FULL",
        source_priority=110,
        source_record_id="3582135977",
        tax_event_date=pd.Timestamp("2026-04-27"),
        amount_pln=Decimal("-9.60"),
        cost_bucket="TRADE_COMMISSION",
    )
    ledger = Ledger()
    ledger.trades_by_id[trade.trade_id] = trade
    ledger.events_by_id[event.event_id] = event
    merge_result = MergeResult(ledger=ledger, canonical_dataset=CanonicalDataset(trades=(trade,), events=(event,)))
    config = EngineConfig(
        tax_plan=TaxPlanConfig(include_fx_conversion_costs=False, include_bank_funding_fees=False)
    )

    items, _, _ = extract_cost_items(merge_result, config, fx_provider=None)

    assert items == []


def test_reconstructed_trade_commission_becomes_cost_when_trade_has_no_commission():
    trade = make_trade(trade_id="642118338", commission=Decimal("0"), commission_pln=Decimal("0.00"))
    event = CanonicalEvent(
        event_id="TRADERNET-FEE-1",
        event_kind="TRADE_FEE",
        symbol="NBIS.US",
        linked_trade_id="642118338",
        amount=Decimal("-2.60"),
        currency="USD",
        effective_at=pd.Timestamp("2026-04-17"),
        comment="(Trade 642118338 buy NBIS.US ) Market: usa, security type: stocks",
        source_name="TRADERNET_TABLE",
        source_priority=90,
        source_record_id="1",
        tax_event_date=pd.Timestamp("2026-04-17"),
        amount_pln=Decimal("-10.40"),
        cost_bucket="RECONSTRUCTED_COMMISSION",
    )
    ledger = Ledger()
    ledger.trades_by_id[trade.trade_id] = trade
    ledger.events_by_id[event.event_id] = event
    merge_result = MergeResult(ledger=ledger, canonical_dataset=CanonicalDataset(trades=(trade,), events=(event,)))
    config = EngineConfig(
        tax_plan=TaxPlanConfig(include_fx_conversion_costs=False, include_bank_funding_fees=False)
    )

    items, _, _ = extract_cost_items(merge_result, config, fx_provider=None)

    assert len(items) == 1
    assert items[0].kind == "TRADE_COMMISSION"
    assert items[0].amount_pln == Decimal("10.40")
    assert items[0].allocation_target == "642118338"


def test_reconstructed_trade_commission_does_not_duplicate_existing_trade_commission():
    trade = make_trade(trade_id="642118338", commission=Decimal("2.60"), commission_pln=Decimal("10.40"))
    event = CanonicalEvent(
        event_id="TRADERNET-FEE-1",
        event_kind="TRADE_FEE",
        symbol="NBIS.US",
        linked_trade_id="642118338",
        amount=Decimal("-2.60"),
        currency="USD",
        effective_at=pd.Timestamp("2026-04-17"),
        comment="(Trade 642118338 buy NBIS.US ) Market: usa, security type: stocks",
        source_name="TRADERNET_TABLE",
        source_priority=90,
        source_record_id="1",
        tax_event_date=pd.Timestamp("2026-04-17"),
        amount_pln=Decimal("-10.40"),
        cost_bucket="RECONSTRUCTED_COMMISSION",
    )
    ledger = Ledger()
    ledger.trades_by_id[trade.trade_id] = trade
    ledger.events_by_id[event.event_id] = event
    merge_result = MergeResult(ledger=ledger, canonical_dataset=CanonicalDataset(trades=(trade,), events=(event,)))
    config = EngineConfig(
        tax_plan=TaxPlanConfig(include_fx_conversion_costs=False, include_bank_funding_fees=False)
    )

    items, _, _ = extract_cost_items(merge_result, config, fx_provider=None)

    assert items == []


def test_cashflow_trade_commission_deduplicates_when_linked_id_is_trade_prefix():
    trade = make_trade(trade_id="646407672/568965503", commission=Decimal("2.80"), commission_pln=Decimal("10.18"))
    event = CanonicalEvent(
        event_id="REPORT-CASHFLOW-3585932577",
        event_kind="TRADE_FEE",
        symbol="NBIS.US",
        linked_trade_id="646407672",
        amount=Decimal("-2.80"),
        currency="USD",
        effective_at=pd.Timestamp("2026-04-30"),
        comment="(Trade 646407672 sell NBIS.US )",
        source_name="API_JSON_FULL",
        source_priority=110,
        source_record_id="3585932577",
        tax_event_date=pd.Timestamp("2026-04-30"),
        amount_pln=Decimal("-10.18"),
        cost_bucket="TRADE_COMMISSION",
    )
    ledger = Ledger()
    ledger.trades_by_id[trade.trade_id] = trade
    ledger.events_by_id[event.event_id] = event
    merge_result = MergeResult(ledger=ledger, canonical_dataset=CanonicalDataset(trades=(trade,), events=(event,)))
    config = EngineConfig(
        tax_plan=TaxPlanConfig(include_fx_conversion_costs=False, include_bank_funding_fees=False)
    )

    items, _, _ = extract_cost_items(merge_result, config, fx_provider=None)

    assert items == []


def _unlinked_commission_event(**overrides) -> CanonicalEvent:
    """Prowizja w opisie, ktorego wyrazenie regularne nie rozpoznaje."""
    base = dict(
        event_id="REPORT-CASHFLOW-NO-LINK",
        event_kind="TRADE_FEE",
        symbol="NBIS.US",
        linked_trade_id=None,
        amount=Decimal("-2.40"),
        currency="USD",
        effective_at=pd.Timestamp("2026-01-03"),
        comment="Oplata maklerska NBIS.US",
        source_name="API_JSON_FULL",
        source_priority=110,
        source_record_id="3582135977",
        tax_event_date=pd.Timestamp("2026-01-03"),
        amount_pln=Decimal("-9.60"),
        cost_bucket="TRADE_COMMISSION",
    )
    base.update(overrides)
    return CanonicalEvent(**base)


def _cost_items_for(trades, events):
    ledger = Ledger()
    for trade in trades:
        ledger.trades_by_id[trade.trade_id] = trade
    for event in events:
        ledger.events_by_id[event.event_id] = event
    merge_result = MergeResult(
        ledger=ledger,
        canonical_dataset=CanonicalDataset(trades=tuple(trades), events=tuple(events)),
    )
    config = EngineConfig(
        tax_plan=TaxPlanConfig(include_fx_conversion_costs=False, include_bank_funding_fees=False)
    )
    return extract_cost_items(merge_result, config, fx_provider=None)


def test_commission_without_a_trade_link_is_recognised_by_content():
    """Zerwane powiazanie po opisie nie moze policzyc tej samej prowizji drugi raz."""
    trade = make_trade(trade_id="645345448", commission=Decimal("2.40"), commission_pln=Decimal("9.60"))

    items, _, issues = _cost_items_for([trade], [_unlinked_commission_event()])

    assert items == []
    assert [issue.code for issue in issues] == ["COMMISSION_MATCHED_BY_CONTENT"]
    assert issues[0].details["matched_trade_id"] == "645345448"


def test_commission_booked_a_day_after_the_trade_is_still_recognised():
    """Broker ksieguje czesc prowizji nastepnego dnia - to nadal ta sama oplata."""
    trade = make_trade(trade_id="645345448", commission=Decimal("2.40"), commission_pln=Decimal("9.60"))
    event = _unlinked_commission_event(
        effective_at=pd.Timestamp("2026-01-04"), tax_event_date=pd.Timestamp("2026-01-04")
    )

    items, _, _ = _cost_items_for([trade], [event])

    assert items == []


def test_commission_from_a_different_week_stays_a_separate_cost():
    trade = make_trade(trade_id="645345448", commission=Decimal("2.40"), commission_pln=Decimal("9.60"))
    event = _unlinked_commission_event(
        effective_at=pd.Timestamp("2026-01-20"), tax_event_date=pd.Timestamp("2026-01-20")
    )

    items, _, issues = _cost_items_for([trade], [event])

    assert len(items) == 1
    assert items[0].amount_pln == Decimal("9.60")
    assert [issue.code for issue in issues] == []


def test_commission_of_a_different_amount_stays_a_separate_cost():
    trade = make_trade(trade_id="645345448", commission=Decimal("2.40"), commission_pln=Decimal("9.60"))
    event = _unlinked_commission_event(amount=Decimal("-3.10"), amount_pln=Decimal("-12.40"))

    items, _, _ = _cost_items_for([trade], [event])

    assert len(items) == 1
    assert items[0].amount_pln == Decimal("12.40")


def test_one_trade_covers_only_one_unlinked_commission():
    """Dwie prowizje tej samej kwoty przy jednej transakcji to jedna kopia i jeden realny koszt."""
    trade = make_trade(trade_id="645345448", commission=Decimal("2.40"), commission_pln=Decimal("9.60"))
    events = [
        _unlinked_commission_event(event_id="FEE-A"),
        _unlinked_commission_event(event_id="FEE-B"),
    ]

    items, _, _ = _cost_items_for([trade], events)

    assert len(items) == 1


def test_trade_claimed_by_an_explicit_link_is_not_reused_for_content_matching():
    """Transakcja pokrywa prowizje wskazana wprost, wiec druga jest realnym kosztem."""
    trade = make_trade(trade_id="645345448", commission=Decimal("2.40"), commission_pln=Decimal("9.60"))
    linked = _unlinked_commission_event(
        event_id="FEE-LINKED",
        linked_trade_id="645345448",
        comment="(Trade 645345448 sell NBIS.US )",
    )
    unlinked = _unlinked_commission_event(event_id="FEE-UNLINKED")

    items, _, _ = _cost_items_for([trade], [linked, unlinked])

    assert len(items) == 1
    assert items[0].source_id == "FEE-UNLINKED"


def test_commission_without_a_matching_trade_is_counted():
    trade = make_trade(trade_id="645345448", commission=Decimal("0"), commission_pln=Decimal("0.00"))

    items, _, issues = _cost_items_for([trade], [_unlinked_commission_event()])

    assert len(items) == 1
    assert [issue.code for issue in issues] == []


def test_cashflow_event_costs_are_limited_to_selected_tax_year():
    event_2025 = CanonicalEvent(
        event_id="REPORT-CASHFLOW-2025",
        event_kind="NEGATIVE_CASH_FEE",
        symbol=None,
        linked_trade_id=None,
        amount=Decimal("-11.00"),
        currency="USD",
        effective_at=pd.Timestamp("2025-12-31"),
        comment="Fee for negative cash balance USD",
        source_name="API_JSON_FULL",
        source_priority=110,
        source_record_id="2025",
        tax_event_date=pd.Timestamp("2025-12-31"),
        amount_pln=Decimal("-40.00"),
        cost_bucket="NEGATIVE_BALANCE_INTEREST",
    )
    event_2026 = CanonicalEvent(
        event_id="REPORT-CASHFLOW-2026",
        event_kind="NEGATIVE_CASH_FEE",
        symbol=None,
        linked_trade_id=None,
        amount=Decimal("-12.00"),
        currency="USD",
        effective_at=pd.Timestamp("2026-01-01"),
        comment="Fee for negative cash balance USD",
        source_name="API_JSON_FULL",
        source_priority=110,
        source_record_id="2026",
        tax_event_date=pd.Timestamp("2026-01-01"),
        amount_pln=Decimal("-48.00"),
        cost_bucket="NEGATIVE_BALANCE_INTEREST",
    )
    ledger = Ledger()
    ledger.events_by_id[event_2025.event_id] = event_2025
    ledger.events_by_id[event_2026.event_id] = event_2026
    merge_result = MergeResult(
        ledger=ledger,
        canonical_dataset=CanonicalDataset(events=(event_2025, event_2026)),
    )
    config = EngineConfig(
        tax_year=2026,
        tax_plan=TaxPlanConfig(include_fx_conversion_costs=False, include_bank_funding_fees=False),
    )

    items, _, _ = extract_cost_items(merge_result, config, fx_provider=None)

    assert [item.source_id for item in items] == ["REPORT-CASHFLOW-2026"]
    assert items[0].amount_pln == Decimal("48.00")


def test_negative_balance_interest_uses_financing_context_not_fee_rate_as_allocation_target():
    event = CanonicalEvent(
        event_id="3368752211",
        event_kind="NEGATIVE_CASH_FEE",
        symbol="0.049315",
        linked_trade_id=None,
        amount=Decimal("-4.31"),
        currency="USD",
        effective_at=pd.Timestamp("2025-11-15 03:00:00"),
        comment="Fee for negative cash balance USD, fee rate as a percentage: 0.049315, balance as at 2025-11-14 23:59:59: 8737.83",
        source_name="TRADERNET_TABLE",
        source_priority=90,
        source_record_id="3368752211",
        tax_event_date=pd.Timestamp("2025-11-15"),
        amount_pln=Decimal("-15.68"),
        cost_bucket="NEGATIVE_BALANCE_INTEREST",
    )
    ledger = Ledger()
    ledger.events_by_id[event.event_id] = event
    merge_result = MergeResult(ledger=ledger, canonical_dataset=CanonicalDataset(events=(event,)))
    config = EngineConfig(
        tax_year=2025,
        tax_plan=TaxPlanConfig(include_fx_conversion_costs=False, include_bank_funding_fees=False),
    )

    items, _, _ = extract_cost_items(merge_result, config, fx_provider=None)

    assert len(items) == 1
    assert items[0].allocation_target == "negative_cash_balance:USD:2025-11-15"


def test_private_cash_fx_buy_loss_becomes_aggressive_investment_cost():
    deposit = CanonicalEvent(
        event_id="DEP-USD-1",
        event_kind="DEPOSIT",
        symbol=None,
        linked_trade_id=None,
        amount=Decimal("1000.00"),
        currency="USD",
        effective_at=pd.Timestamp("2025-01-20"),
        comment="USD bought for investment purchase",
        source_name="API_JSON_FULL",
        source_priority=110,
        source_record_id="DEP-USD-1",
        tax_event_date=pd.Timestamp("2025-01-20"),
        fx_rate=Decimal("4.10"),
        logical_world="private_cash_fx",
    )
    buy = make_trade(
        trade_id="BUY-FX-LOSS",
        gross_amount=Decimal("1000.00"),
        commission=Decimal("0.00"),
        tax_event_date=pd.Timestamp("2025-01-21"),
        gross_fx_rate=Decimal("4.00"),
    )
    ledger = Ledger()
    ledger.events_by_id[deposit.event_id] = deposit
    ledger.trades_by_id[buy.trade_id] = buy
    merge_result = MergeResult(ledger=ledger, canonical_dataset=CanonicalDataset(trades=(buy,), events=(deposit,)))
    config = EngineConfig(
        tax_year=2025,
        tax_plan=TaxPlanConfig(include_fx_conversion_costs=True, include_bank_funding_fees=False),
    )

    items, _, _ = extract_cost_items(merge_result, config, fx_provider=None)

    private_fx_items = [item for item in items if item.kind == "PRIVATE_CASH_FX_INVESTMENT_LOSS"]
    assert len(private_fx_items) == 1
    assert private_fx_items[0].amount_pln == Decimal("100.00")
    assert private_fx_items[0].allocation_target == "BUY-FX-LOSS"
    assert private_fx_items[0].included_in_plan == {"aggressive_user"}
    assert private_fx_items[0].is_aggressive_only is True


def _conditional_cost_setup(conditional_ids: set[str]):
    """Koszt, ktorego domyslna polityka nie ujmuje w zadnym planie."""
    from investment_tax_engine.models.core import UserOverrides
    from investment_tax_engine.tax.cost_policy_engine import apply_tax_plan

    cost = CostItem(
        cost_id="COST-FX-1",
        kind="FX_CONVERSION_COST",
        amount_foreign=Decimal("12.00"),
        currency="USD",
        tax_event_date=pd.Timestamp("2026-01-03"),
        amount_pln=Decimal("48.00"),
        source_id="EV-1",
        included_in_plan=set(),
        is_aggressive_only=True,
    )
    config = EngineConfig(user_overrides=UserOverrides(conditional_cost_ids=set(conditional_ids)))
    decisions, totals = apply_tax_plan([cost], config)
    return {decision.plan_name: decision for decision in decisions}, totals


def test_cost_marked_by_the_user_enters_the_aggressive_plan():
    """Kanal conditional_cost_ids byl zadeklarowany i nigdzie nieczytany."""
    decisions, totals = _conditional_cost_setup({"COST-FX-1"})

    assert decisions["aggressive_user"].included is True
    assert decisions["aggressive_user"].reason == "included_by_user_decision"
    assert totals["aggressive_user"] == Decimal("48.00")


def test_cost_marked_by_the_user_does_not_enter_safer_plans():
    """Wskazanie recznie oznacza, ze podatnik bierze obrone kosztu na siebie."""
    decisions, _ = _conditional_cost_setup({"COST-FX-1"})

    assert decisions["balanced_user"].included is False
    assert decisions["conservative_user"].included is False


def test_without_the_user_decision_the_cost_stays_out():
    decisions, totals = _conditional_cost_setup(set())

    assert decisions["aggressive_user"].included is False
    assert totals["aggressive_user"] == Decimal("0.00")


def test_a_fee_linked_to_a_trade_without_its_own_commission_stays_a_cost():
    """Wskazanie transakcji wprost jest rozstrzygajace.

    Gdy zdarzenie wskazuje transakcje bez wlasnej prowizji, jest to oplata
    osobna. Wczesniej trafiala do dopasowania po tresci, ktore zabieralo inna
    transakcje o tej samej kwocie, a prawdziwy koszt przepadal.
    """
    trades = [
        make_trade(trade_id="111", commission=Decimal("0"), commission_pln=Decimal("0.00")),
        make_trade(trade_id="222", commission=Decimal("2.40"), commission_pln=Decimal("9.60")),
    ]

    items, _, issues = _cost_items_for(trades, [_unlinked_commission_event(linked_trade_id="111")])

    assert len(items) == 1
    assert items[0].amount_pln == Decimal("9.60")
    assert [issue.code for issue in issues] == []


def test_a_commission_recorded_only_in_zloty_is_still_recognised_as_a_duplicate():
    """Indeks liczony wylacznie z `commission` pomijal takie transakcje."""
    trade = make_trade(trade_id="333", commission=Decimal("0"), commission_pln=Decimal("9.60"))

    items, _, issues = _cost_items_for([trade], [_unlinked_commission_event()])

    assert items == []
    assert [issue.code for issue in issues] == ["COMMISSION_MATCHED_BY_CONTENT"]


def test_an_undated_fee_is_never_matched_to_a_trade_from_another_year():
    """Brak daty znaczyl zgode, wiec zdarzenie laczylo sie z dowolnym rokiem."""
    old_trade = make_trade(
        trade_id="444",
        commission=Decimal("2.40"),
        commission_pln=Decimal("9.60"),
        tax_event_date=pd.Timestamp("2019-05-05"),
        executed_at=pd.Timestamp("2019-05-05"),
        exchange_time=pd.Timestamp("2019-05-05"),
        settlement_date=pd.Timestamp("2019-05-07"),
    )
    undated = _unlinked_commission_event(effective_at=None, tax_event_date=None)

    items, _, _ = _cost_items_for([old_trade], [undated])

    assert len(items) == 1, "oplata bez daty zostaje kosztem, a nie znika jako rzekomy duplikat"


def test_a_dangling_link_still_falls_back_to_content_matching():
    """Identyfikator wskazujacy nieistniejaca transakcje to zerwane powiazanie."""
    trade = make_trade(trade_id="645345448", commission=Decimal("2.40"), commission_pln=Decimal("9.60"))

    items, _, issues = _cost_items_for([trade], [_unlinked_commission_event(linked_trade_id="NIE-MA-TAKIEJ")])

    assert items == []
    assert [issue.code for issue in issues] == ["COMMISSION_MATCHED_BY_CONTENT"]


def test_funding_fee_matched_to_a_purchase_from_another_year_is_reported_not_dropped():
    """Oplata finansowania spoza rozliczanego roku ma zostawic slad.

    Alokator dopasowywal ja do zakupu, a filtr roku kasowal wynik zwyklym
    `continue`. Jedyne zgloszenie, FUNDING_FEE_WITHOUT_INVESTMENT_USAGE,
    powstaje wylacznie przy braku alokacji, wiec uzytkownik widzial wpisana
    recznie kwote i zadnego kosztu - bez slowa wyjasnienia.
    """
    trade = make_trade(
        trade_id="BUY-2025",
        executed_at=pd.Timestamp("2025-03-10 10:00:00"),
        exchange_time=pd.Timestamp("2025-03-10 10:00:00"),
        tax_event_date=pd.Timestamp("2025-03-10"),
    )
    funding_event = FundingCostEvent(
        funding_event_id="FUND-2025",
        amount=Decimal("25.00"),
        currency="PLN",
        date=pd.Timestamp("2025-03-01"),
        linked_deposit_id="DEP-1",
        source="USER_OVERRIDE",
        evidence_note="Prowizja za przelew",
        deposit_amount=Decimal("1000.00"),
    )
    ledger = Ledger()
    ledger.trades_by_id[trade.trade_id] = trade
    ledger.events_by_id["DEP-1"] = make_deposit(date="2025-03-01")
    merge_result = MergeResult(ledger=ledger, canonical_dataset=CanonicalDataset(trades=(trade,), events=()))
    config = EngineConfig(
        tax_year=2026,
        tax_plan=TaxPlanConfig(include_fx_conversion_costs=False, include_bank_funding_fees=True),
        user_overrides=UserOverrides(funding_cost_events=[funding_event]),
    )

    items, allocations, issues = extract_cost_items(merge_result, config, fx_provider=None)

    assert allocations, "alokator ma dopasowac oplate do zakupu z 2025 roku"
    assert [item for item in items if item.kind == "BANK_FUNDING_FEE"] == []
    zgloszenia = [issue for issue in issues if issue.code == "FUNDING_FEE_OUTSIDE_TAX_YEAR"]
    assert len(zgloszenia) == len(allocations)
    assert "2025" in zgloszenia[0].message and "2026" in zgloszenia[0].message
    assert zgloszenia[0].blocking is False


def test_funding_fee_matched_inside_the_filed_year_still_becomes_a_cost():
    """Kontrola dla powyzszego: w rozliczanym roku oplata ma wejsc do kosztow."""
    trade = make_trade(trade_id="BUY-2026")
    funding_event = FundingCostEvent(
        funding_event_id="FUND-2026",
        amount=Decimal("25.00"),
        currency="PLN",
        date=pd.Timestamp("2026-01-02"),
        linked_deposit_id="DEP-1",
        source="USER_OVERRIDE",
        evidence_note="Prowizja za przelew",
        deposit_amount=Decimal("1000.00"),
    )
    ledger = Ledger()
    ledger.trades_by_id[trade.trade_id] = trade
    ledger.events_by_id["DEP-1"] = make_deposit()
    merge_result = MergeResult(ledger=ledger, canonical_dataset=CanonicalDataset(trades=(trade,), events=()))
    config = EngineConfig(
        tax_year=2026,
        tax_plan=TaxPlanConfig(include_fx_conversion_costs=False, include_bank_funding_fees=True),
        user_overrides=UserOverrides(funding_cost_events=[funding_event]),
    )

    items, _, issues = extract_cost_items(merge_result, config, fx_provider=None)

    assert [item.kind for item in items if item.kind == "BANK_FUNDING_FEE"] == ["BANK_FUNDING_FEE"]
    assert next(item for item in items if item.kind == "BANK_FUNDING_FEE").evidence_level == "DIRECT"
    assert [issue for issue in issues if issue.code == "FUNDING_FEE_OUTSIDE_TAX_YEAR"] == []


def test_unconfirmed_funding_fee_stays_out_of_automatic_costs():
    trade = make_trade()
    fee = FundingCostEvent(
        funding_event_id="FUND-UNKNOWN", amount=Decimal("25"), currency="PLN",
        date=pd.Timestamp("2026-01-02"), linked_deposit_id="MISSING", source="USER_OVERRIDE",
    )
    ledger = Ledger(trades_by_id={trade.trade_id: trade})
    result = MergeResult(ledger=ledger, canonical_dataset=CanonicalDataset(trades=(trade,), events=()))
    config = EngineConfig(
        tax_plan=TaxPlanConfig(include_fx_conversion_costs=False, include_bank_funding_fees=True),
        user_overrides=UserOverrides(funding_cost_events=[fee]),
    )
    items, allocations, issues = extract_cost_items(result, config, fx_provider=None)
    assert allocations == []
    assert not any(item.kind == "BANK_FUNDING_FEE" for item in items)
    assert any(issue.code == "FUNDING_FEE_DEPOSIT_UNCONFIRMED" for issue in issues)


def _oplata_przelewu(event_id: str, kwota: str, dzien: str) -> CanonicalEvent:
    return CanonicalEvent(
        event_id=event_id, event_kind="FUNDING_TRANSFER_FEE", symbol=None, linked_trade_id=None,
        amount=Decimal(kwota), currency="PLN", effective_at=pd.Timestamp(dzien),
        comment="Commission for withdrawal of funds ordered by 70292667",
        source_name="API_JSON_FULL", source_priority=110, source_record_id=event_id,
        tax_event_date=pd.Timestamp(dzien), amount_pln=Decimal(kwota), cost_bucket="FUNDING_TRANSFER_FEE",
    )


def _koszty_planow(events: list[CanonicalEvent], tax_plan: TaxPlanConfig | None = None, **ustawienia):
    from investment_tax_engine.tax.cost_policy_engine import apply_tax_plan

    ledger = Ledger()
    for event in events:
        ledger.events_by_id[event.event_id] = event
    merge_result = MergeResult(ledger=ledger, canonical_dataset=CanonicalDataset(events=tuple(events)))
    config = EngineConfig(
        tax_year=2026,
        tax_plan=tax_plan or TaxPlanConfig(include_fx_conversion_costs=False, include_bank_funding_fees=False),
        **ustawienia,
    )
    items, _, issues = extract_cost_items(merge_result, config, fx_provider=None)
    _, totals = apply_tax_plan(items, config)
    return items, issues, totals


def test_storno_oplaty_znosi_ja_zamiast_dublowac_koszt():
    """Oplata -25,61 zl i jej storno +25,61 zl: abs() dawal 51,22 zl kosztow zamiast zera."""
    items, issues, totals = _koszty_planow([
        _oplata_przelewu("F-1", "25.61", "2026-06-17"),
        _oplata_przelewu("F-2", "-25.61", "2026-06-18"),
        _oplata_przelewu("F-3", "-25.52", "2026-05-05"),
    ])

    assert not [issue for issue in issues if issue.code == "COST_REFUND_UNMATCHED"]
    assert sorted(item.amount_pln for item in items) == [Decimal("-25.61"), Decimal("25.52"), Decimal("25.61")]
    assert totals["aggressive_user"] == Decimal("25.52")


def test_zwrot_bez_pasujacego_obciazenia_nie_jest_kosztem():
    items, issues, totals = _koszty_planow([_oplata_przelewu("F-1", "10.00", "2026-03-02")])

    assert items == []
    assert [issue.code for issue in issues] == ["COST_REFUND_UNMATCHED"]
    assert totals.get("aggressive_user", Decimal("0")) == Decimal("0")


def test_storno_wskazanej_recznie_oplaty_idzie_za_nia():
    """Kategoria wylaczona przelacznikiem, oplata wskazana recznie: jej storno musi wejsc razem z nia."""
    oplata = _oplata_przelewu("F-2", "-25.61", "2026-06-18")
    storno = _oplata_przelewu("F-1", "25.61", "2026-06-17")
    oplata.cost_bucket = storno.cost_bucket = "ACCOUNT_FEE"
    items, _, totals = _koszty_planow(
        [storno, oplata],
        tax_plan=TaxPlanConfig(include_fx_conversion_costs=False, include_bank_funding_fees=False, include_account_fees=False),
        user_overrides=UserOverrides(conditional_cost_ids=["COST-F-2"]),
    )

    assert {item.cost_id for item in items} == {"COST-F-1", "COST-F-2"}
    assert totals["aggressive_user"] == Decimal("0.00")


def test_odsetki_od_kredytu_wchodza_tylko_po_wskazaniu_przez_podatnika():
    odsetki = CanonicalEvent(
        event_id="L-1", event_kind="LOAN_INTEREST", symbol=None, linked_trade_id=None,
        amount=Decimal("-12.00"), currency="PLN", effective_at=pd.Timestamp("2026-02-10"),
        comment="Loan interest", source_name="BANK", source_priority=50, source_record_id="L-1",
        tax_event_date=pd.Timestamp("2026-02-10"), amount_pln=Decimal("-12.00"), cost_bucket="LOAN_INTEREST",
    )

    _, issues, totals = _koszty_planow([odsetki])
    assert all(totals.get(plan, Decimal("0")) == Decimal("0") for plan in ("conservative_user", "balanced_user", "aggressive_user"))
    assert [issue.code for issue in issues] == ["LOAN_INTEREST_NOT_INCLUDED"]

    _, issues, totals = _koszty_planow([odsetki], user_overrides=UserOverrides(conditional_cost_ids=["COST-L-1"]))
    assert totals["aggressive_user"] == Decimal("12.00")
    assert totals.get("balanced_user", Decimal("0")) == Decimal("0")
    assert not issues


def test_storno_przy_kilku_rownych_oplatach_trafia_do_tej_z_tym_samym_zleceniem():
    def oplata(event_id: str, kwota: str, dzien: str, zlecenie: str) -> CanonicalEvent:
        zdarzenie = _oplata_przelewu(event_id, kwota, dzien)
        zdarzenie.comment = f"Commission for withdrawal of funds ordered by {zlecenie}"
        return zdarzenie

    items, _, _ = _koszty_planow([
        oplata("A", "-10.00", "2026-03-01", "111"),
        oplata("B", "-10.00", "2026-03-05", "222"),
        oplata("Z", "10.00", "2026-03-06", "222"),
    ])

    [zwrot] = [item for item in items if item.cost_id == "COST-Z"]
    assert "zwrot_kosztu=COST-B" in zwrot.notes


def test_recznie_wskazana_oplata_przezywa_wylaczenie_kategorii():
    items, _, totals = _koszty_planow(
        [_oplata_przelewu("F-1", "-25.61", "2026-06-18")],
        tax_plan=TaxPlanConfig(include_fx_conversion_costs=False, include_bank_funding_fees=False, include_account_fees=False),
        user_overrides=UserOverrides(conditional_cost_ids=["COST-F-1"]),
    )

    assert [item.cost_id for item in items] == ["COST-F-1"]
    assert totals["aggressive_user"] == Decimal("25.61")


def test_zwrot_bez_daty_nie_paruje_sie_z_obciazeniem():
    bez_daty = _oplata_przelewu("Z", "10.00", "2026-03-06")
    bez_daty.tax_event_date = None
    bez_daty.effective_at = None
    _, issues, totals = _koszty_planow([_oplata_przelewu("A", "-10.00", "2026-03-01"), bez_daty])

    assert [issue.code for issue in issues] == ["COST_REFUND_UNMATCHED"]
    assert totals["aggressive_user"] == Decimal("10.00")
