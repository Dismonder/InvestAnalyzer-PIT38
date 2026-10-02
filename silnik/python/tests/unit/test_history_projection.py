from decimal import Decimal

import pandas as pd

from investment_tax_engine.app.history_projection import _row_date_trade, build_transaction_history_rows
from investment_tax_engine.models.core import CanonicalEvent, CanonicalTrade, RealizedTaxRow


def _trade(**overrides):
    defaults = {
        "trade_id": "t1",
        "order_id": None,
        "trade_number": None,
        "symbol": "NBIS.US",
        "isin": None,
        "side": "BUY",
        "instrument_type_code": None,
        "instrument_class": "EQUITY",
        "market_id": None,
        "quantity": 1,
        "price": 10,
        "gross_amount": 10,
        "trade_currency": "USD",
        "commission": 0,
        "commission_currency": "USD",
        "broker_reported_profit": None,
        "executed_at": pd.Timestamp("2026-04-20T15:42:11"),
        "exchange_time": None,
        "settlement_date": None,
        "confirm_time": None,
        "otc": False,
        "repo_close": None,
        "base_contract_code": None,
        "current_position_qty_after_trade": None,
        "source_name": "test",
        "source_priority": 1,
        "source_record_id": "src-1",
        "tax_event_date": pd.Timestamp("2026-04-20"),
    }
    defaults.update(overrides)
    return CanonicalTrade(**defaults)


def test_row_date_trade_prefers_real_execution_timestamp_over_tax_date():
    trade = _trade()

    assert _row_date_trade(trade) == pd.Timestamp("2026-04-20T15:42:11")


def test_cashflow_trade_fee_renders_as_child_row_under_linked_trade():
    trade = _trade(trade_id="645345448", executed_at=pd.Timestamp("2026-04-27T12:00:00"))
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
        cost_bucket="TRADE_COMMISSION",
        amount_pln=Decimal("-9.60"),
    )

    rows = build_transaction_history_rows(
        trades=[trade],
        events=[event],
        funding_fee_allocations=[],
        fifo_rows=[],
        tax_year=2026,
    )

    fee_row = next(row for row in rows if row.row_id == "EVENT-REPORT-CASHFLOW-3582135977")
    assert fee_row.parent_row_id == "TRADE-645345448"
    assert fee_row.details["linked_trade_id"] == "645345448"
    assert fee_row.details["cost_bucket"] == "TRADE_COMMISSION"


def test_cashflow_trade_fee_renders_under_trade_when_linked_id_is_short_prefix():
    trade = _trade(trade_id="646407672/568965503", executed_at=pd.Timestamp("2026-04-30T01:21:24"))
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
        cost_bucket="TRADE_COMMISSION",
        amount_pln=Decimal("-10.18"),
    )

    rows = build_transaction_history_rows(
        trades=[trade],
        events=[event],
        funding_fee_allocations=[],
        fifo_rows=[],
        tax_year=2026,
    )

    fee_row = next(row for row in rows if row.row_id == "EVENT-REPORT-CASHFLOW-3585932577")
    assert fee_row.parent_row_id == "TRADE-646407672/568965503"
    assert fee_row.details["linked_trade_id"] == "646407672"
    assert fee_row.details["resolved_linked_trade_id"] == "646407672/568965503"


def test_reconstructed_trade_fee_renders_under_trade_without_double_counting_status():
    trade = _trade(
        trade_id="642118338",
        commission=Decimal("2.60"),
        commission_pln=Decimal("10.40"),
        executed_at=pd.Timestamp("2026-04-17T15:20:08"),
    )
    event = CanonicalEvent(
        event_id="TRADERNET-FEE-1",
        event_kind="TRADE_FEE",
        symbol="NBIS.US",
        linked_trade_id="642118338",
        amount=Decimal("-2.60"),
        currency="USD",
        effective_at=pd.Timestamp("2026-04-17T15:20:08"),
        comment="(Trade 642118338 buy NBIS.US ) Market: usa, security type: stocks",
        source_name="TRADERNET_TABLE",
        source_priority=90,
        source_record_id="1",
        cost_bucket="RECONSTRUCTED_COMMISSION",
        amount_pln=Decimal("-10.40"),
    )

    rows = build_transaction_history_rows(
        trades=[trade],
        events=[event],
        funding_fee_allocations=[],
        fifo_rows=[],
        tax_year=2026,
    )

    fee_row = next(row for row in rows if row.row_id == "EVENT-TRADERNET-FEE-1")
    assert fee_row.parent_row_id == "TRADE-642118338"
    assert fee_row.tax_impact_kind == "TECHNICAL_ONLY"
    assert fee_row.tax_impact_label == "Prowizja powiązana z transakcją; nie jest liczona drugi raz"
    assert fee_row.details["commission_already_in_trade"] is True


def test_reconstructed_trade_fee_without_trade_commission_is_scenario_cost():
    trade = _trade(
        trade_id="642118338",
        commission=Decimal("0"),
        commission_pln=Decimal("0.00"),
        executed_at=pd.Timestamp("2026-04-17T15:20:08"),
    )
    event = CanonicalEvent(
        event_id="TRADERNET-FEE-1",
        event_kind="TRADE_FEE",
        symbol="NBIS.US",
        linked_trade_id="642118338",
        amount=Decimal("-2.60"),
        currency="USD",
        effective_at=pd.Timestamp("2026-04-17T15:20:08"),
        comment="(Trade 642118338 buy NBIS.US ) Market: usa, security type: stocks",
        source_name="TRADERNET_TABLE",
        source_priority=90,
        source_record_id="1",
        cost_bucket="RECONSTRUCTED_COMMISSION",
        amount_pln=Decimal("-10.40"),
    )

    rows = build_transaction_history_rows(
        trades=[trade],
        events=[event],
        funding_fee_allocations=[],
        fifo_rows=[],
        tax_year=2026,
    )

    fee_row = next(row for row in rows if row.row_id == "EVENT-TRADERNET-FEE-1")
    assert fee_row.parent_row_id == "TRADE-642118338"
    assert fee_row.tax_impact_kind == "SCENARIO_COST"
    assert fee_row.tax_impact_label == "Koszt wpływa na scenariusze podatkowe"
    assert fee_row.details["commission_already_in_trade"] is False


def test_sell_history_row_exposes_fifo_tax_and_economic_result():
    sell = _trade(
        trade_id="646407672/568965503",
        side="SELL",
        quantity=Decimal("40"),
        gross_amount=Decimal("5720"),
        amount_pln=Decimal("20785.45"),
        sell_net_revenue_pln=Decimal("20785.45"),
        gross_amount_pln=Decimal("20795.63"),
        commission=Decimal("2.80"),
        commission_pln=Decimal("10.18"),
        executed_at=pd.Timestamp("2026-04-30T01:21:24"),
        tax_event_date=pd.Timestamp("2026-04-30"),
    )
    fifo_rows = [
        RealizedTaxRow(
            row_id="fifo-1",
            symbol="NBIS.US",
            sell_trade_id=sell.trade_id,
            buy_trade_id="643800521/566642845",
            quantity=Decimal("15"),
            sell_tax_date=pd.Timestamp("2026-04-30"),
            buy_tax_date=pd.Timestamp("2026-04-22"),
            sell_fx_date=pd.Timestamp("2026-04-29"),
            buy_fx_date=pd.Timestamp("2026-04-21"),
            gross_revenue_pln=Decimal("7798.36"),
            sell_commission_alloc_pln=Decimal("3.82"),
            net_revenue_pln=Decimal("7794.54"),
            cost_pln=Decimal("8461.22"),
            pnl_pln=Decimal("-666.68"),
            acquisition_mode="STANDARD",
        ),
        RealizedTaxRow(
            row_id="fifo-2",
            symbol="NBIS.US",
            sell_trade_id=sell.trade_id,
            buy_trade_id="644219323/566971495",
            quantity=Decimal("10"),
            sell_tax_date=pd.Timestamp("2026-04-30"),
            buy_tax_date=pd.Timestamp("2026-04-23"),
            sell_fx_date=pd.Timestamp("2026-04-29"),
            buy_fx_date=pd.Timestamp("2026-04-22"),
            gross_revenue_pln=Decimal("5198.90"),
            sell_commission_alloc_pln=Decimal("2.54"),
            net_revenue_pln=Decimal("5196.36"),
            cost_pln=Decimal("5737.44"),
            pnl_pln=Decimal("-541.08"),
            acquisition_mode="STANDARD",
        ),
        RealizedTaxRow(
            row_id="fifo-3",
            symbol="NBIS.US",
            sell_trade_id=sell.trade_id,
            buy_trade_id="644222147/566976509",
            quantity=Decimal("15"),
            sell_tax_date=pd.Timestamp("2026-04-30"),
            buy_tax_date=pd.Timestamp("2026-04-23"),
            sell_fx_date=pd.Timestamp("2026-04-29"),
            buy_fx_date=pd.Timestamp("2026-04-22"),
            gross_revenue_pln=Decimal("7798.36"),
            sell_commission_alloc_pln=Decimal("3.82"),
            net_revenue_pln=Decimal("7794.54"),
            cost_pln=Decimal("8548.44"),
            pnl_pln=Decimal("-753.90"),
            acquisition_mode="STANDARD",
        ),
    ]

    rows = build_transaction_history_rows(
        trades=[sell],
        events=[],
        funding_fee_allocations=[],
        fifo_rows=fifo_rows,
        tax_year=2026,
    )

    sell_row = next(row for row in rows if row.row_id == "TRADE-646407672/568965503")
    assert sell_row.amount_pln == Decimal("20785.45")
    assert sell_row.pit_result_pln == Decimal("-1961.66")
    assert sell_row.economic_result_pln == Decimal("-1961.66")
    assert sell_row.details["sell_net_revenue_pln"] == Decimal("20785.45")
    assert sell_row.details["fifo_cost_pln"] == Decimal("22747.10")
    assert sell_row.details["fifo_matched_quantity"] == Decimal("40")
    assert sell_row.details["fifo_realized_rows"] == [
        {
            "row_id": "fifo-1",
            "buy_trade_id": "643800521/566642845",
            "quantity": Decimal("15"),
            "net_revenue_pln": Decimal("7794.54"),
            "cost_pln": Decimal("8461.22"),
            "pnl_pln": Decimal("-666.68"),
            "economic_result_pln": Decimal("-666.68"),
            "buy_reference_kind": "TRADE",
            "acquisition_mode": "STANDARD",
        },
        {
            "row_id": "fifo-2",
            "buy_trade_id": "644219323/566971495",
            "quantity": Decimal("10"),
            "net_revenue_pln": Decimal("5196.36"),
            "cost_pln": Decimal("5737.44"),
            "pnl_pln": Decimal("-541.08"),
            "economic_result_pln": Decimal("-541.08"),
            "buy_reference_kind": "TRADE",
            "acquisition_mode": "STANDARD",
        },
        {
            "row_id": "fifo-3",
            "buy_trade_id": "644222147/566976509",
            "quantity": Decimal("15"),
            "net_revenue_pln": Decimal("7794.54"),
            "cost_pln": Decimal("8548.44"),
            "pnl_pln": Decimal("-753.90"),
            "economic_result_pln": Decimal("-753.90"),
            "buy_reference_kind": "TRADE",
            "acquisition_mode": "STANDARD",
        },
    ]


def test_history_rows_expose_source_manifest_conflicts_and_tax_impact_label():
    trade = _trade(
        trade_id="645345448",
        source_name="API_JSON_FULL",
        source_record_id="645345448",
        source_links=[
            {
                "source_manifest_id": "file:broker_report",
                "conflict_count": 1,
                "source_subtype": "local_broker_report",
            }
        ],
    )
    event = CanonicalEvent(
        event_id="REPORT-CASHFLOW-3582135977",
        event_kind="NEGATIVE_BALANCE_INTEREST",
        symbol=None,
        linked_trade_id=None,
        amount=Decimal("-11.94"),
        currency="USD",
        effective_at=pd.Timestamp("2026-04-27"),
        comment="Fee for negative cash balance USD",
        source_name="API_JSON_FULL",
        source_priority=110,
        source_record_id="3582135977",
        cost_bucket="NEGATIVE_BALANCE_INTEREST",
        logical_world="investment_cost",
        amount_pln=Decimal("-47.76"),
        source_links=[
            {
                "source_manifest_id": "file:cashflow",
                "conflict_count": 2,
                "source_subtype": "local_cashflow",
            }
        ],
    )

    rows = build_transaction_history_rows(
        trades=[trade],
        events=[event],
        funding_fee_allocations=[],
        fifo_rows=[],
        tax_year=2026,
    )

    trade_row = next(row for row in rows if row.row_id == "TRADE-645345448")
    event_row = next(row for row in rows if row.row_id == "EVENT-REPORT-CASHFLOW-3582135977")
    assert trade_row.source_manifest_id == "file:broker_report"
    assert trade_row.conflict_count == 1
    assert trade_row.tax_impact_label == "Transakcja wpływa na rozliczenie PIT"
    assert event_row.source_manifest_id == "file:cashflow"
    assert event_row.conflict_count == 2
    assert event_row.tax_impact_label == "Koszt wpływa na scenariusze podatkowe"


def test_history_rows_expose_tax_impact_kind_and_polish_label():
    technical_event = CanonicalEvent(
        event_id="REPORT-CASHFLOW-BLOCK-1",
        event_kind="BLOCK",
        symbol=None,
        linked_trade_id=None,
        amount=Decimal("-100"),
        currency="USD",
        effective_at=pd.Timestamp("2026-04-27"),
        comment="Technical cash block",
        source_name="API_JSON_FULL",
        source_priority=110,
        source_record_id="block-1",
        logical_world="diagnostic_only",
        amount_pln=Decimal("-400"),
    )
    scenario_cost_event = CanonicalEvent(
        event_id="REPORT-CASHFLOW-INTEREST-1",
        event_kind="NEGATIVE_CASH_FEE",
        symbol=None,
        linked_trade_id=None,
        amount=Decimal("-11.94"),
        currency="USD",
        effective_at=pd.Timestamp("2026-04-27"),
        comment="Fee for negative cash balance USD",
        source_name="API_JSON_FULL",
        source_priority=110,
        source_record_id="interest-1",
        cost_bucket="NEGATIVE_BALANCE_INTEREST",
        logical_world="investment_cost",
        amount_pln=Decimal("-47.76"),
    )
    review_event = CanonicalEvent(
        event_id="REPORT-CASHFLOW-UNKNOWN-1",
        event_kind="REVIEW_REQUIRED",
        symbol=None,
        linked_trade_id=None,
        amount=Decimal("5"),
        currency="USD",
        effective_at=pd.Timestamp("2026-04-27"),
        comment="Unknown corporate action",
        source_name="API_JSON_FULL",
        source_priority=110,
        source_record_id="unknown-1",
        logical_world="diagnostic_only",
        amount_pln=Decimal("20"),
    )

    rows = build_transaction_history_rows(
        trades=[_trade(trade_id="tax-trade-1", logical_world="equity_tax")],
        events=[technical_event, scenario_cost_event, review_event],
        funding_fee_allocations=[],
        fifo_rows=[],
        tax_year=2026,
    )

    trade_row = next(row for row in rows if row.row_id == "TRADE-tax-trade-1")
    technical_row = next(row for row in rows if row.row_id == "EVENT-REPORT-CASHFLOW-BLOCK-1")
    cost_row = next(row for row in rows if row.row_id == "EVENT-REPORT-CASHFLOW-INTEREST-1")
    review_row = next(row for row in rows if row.row_id == "EVENT-REPORT-CASHFLOW-UNKNOWN-1")

    assert trade_row.tax_impact_kind == "PIT_COUNTED"
    assert trade_row.tax_impact_label_pl == "Liczone w PIT"
    assert technical_row.tax_impact_kind == "TECHNICAL_ONLY"
    assert technical_row.is_technical_only is True
    assert technical_row.tax_impact_label_pl == "Techniczne - nie liczone w PIT"
    assert cost_row.tax_impact_kind == "SCENARIO_COST"
    assert cost_row.tax_impact_label_pl == "Koszt w scenariuszach"
    assert review_row.tax_impact_kind == "REVIEW_REQUIRED"
    assert review_row.tax_impact_label_pl == "Do sprawdzenia"


def test_history_rows_expose_defense_presentation_fields_for_costs():
    scenario_cost_event = CanonicalEvent(
        event_id="REPORT-CASHFLOW-INTEREST-1",
        event_kind="NEGATIVE_CASH_FEE",
        symbol=None,
        linked_trade_id=None,
        amount=Decimal("-11.94"),
        currency="USD",
        effective_at=pd.Timestamp("2026-04-27"),
        comment="Fee for negative cash balance USD",
        source_name="LOCAL_FILE",
        source_priority=90,
        source_record_id="interest-1",
        cost_bucket="NEGATIVE_BALANCE_INTEREST",
        logical_world="investment_cost",
        amount_pln=Decimal("-47.76"),
        evidence_refs=["cashflow:interest-1"],
    )

    rows = build_transaction_history_rows(
        trades=[],
        events=[scenario_cost_event],
        funding_fee_allocations=[],
        fifo_rows=[],
        tax_year=2026,
    )

    cost_row = next(row for row in rows if row.row_id == "EVENT-REPORT-CASHFLOW-INTEREST-1")
    assert cost_row.defense_status == "needs_user_evidence"
    assert cost_row.evidence_count == 1
    assert cost_row.missing_evidence_count == 1
    assert cost_row.details["defense_status"] == "needs_user_evidence"
    assert cost_row.details["missing_evidence_count"] == 1
