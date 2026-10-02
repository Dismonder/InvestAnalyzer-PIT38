from __future__ import annotations

from collections import defaultdict
from decimal import Decimal

import pandas as pd

from investment_tax_engine.models.core import (
    CanonicalEvent,
    CanonicalTrade,
    FundingFeeAllocation,
    RealizedTaxRow,
    TransactionHistoryRow,
)
from investment_tax_engine.merge.trade_links import resolve_linked_trade_id


def _same_tax_year(value: pd.Timestamp | None, tax_year: int | None) -> bool:
    if value is None:
        return False
    if tax_year is None:
        return True
    return pd.Timestamp(value).year == tax_year


def _row_date_trade(trade: CanonicalTrade) -> pd.Timestamp | None:
    return trade.exchange_time or trade.executed_at or trade.tax_event_date or trade.settlement_date


def _row_date_event(event: CanonicalEvent) -> pd.Timestamp | None:
    return event.effective_at or event.tax_event_date


def _trade_row_id(trade: CanonicalTrade) -> str:
    return f"TRADE-{trade.trade_id}"


def _event_row_id(event: CanonicalEvent) -> str:
    return f"EVENT-{event.event_id}"


def _source_manifest_id(source_links: list[dict]) -> str | None:
    for link in source_links:
        value = link.get("source_manifest_id")
        if value:
            return str(value)
    return None


def _conflict_count(source_links: list[dict]) -> int:
    total = 0
    for link in source_links:
        try:
            total += int(link.get("conflict_count") or 0)
        except (TypeError, ValueError):
            continue
    return total


SCENARIO_COST_BUCKETS = {
    "TRADE_COMMISSION",
    "RECONSTRUCTED_COMMISSION",
    "NEGATIVE_BALANCE_INTEREST",
    "FUNDING_TRANSFER_FEE",
    "SOURCE_TAX",
}

TRADE_COMMISSION_BUCKETS = {"TRADE_COMMISSION", "RECONSTRUCTED_COMMISSION"}

TECHNICAL_EVENT_KINDS = {
    "BANK_TRANSFER",
    "CASH_MOVEMENT",
    "DEPOSIT",
    "INTERNAL_TRANSFER",
    "WITHDRAWAL",
    "BLOCK",
    "UNBLOCK",
    "BLOCK_COMMISSION",
    "UNBLOCK_COMMISSION",
    "INITIAL_MARGIN",
    "VARIATION_MARGIN",
    "FINANCING_REPAYMENT",
}

REVIEW_EVENT_KINDS = {
    "REVIEW_REQUIRED",
    "CORPORATE_ACTION",
    "SECURITY_EVENT",
}

PIT_EVENT_KINDS = {
    "DIVIDEND",
    "FOREIGN_DIVIDEND",
    "SOURCE_TAX",
    "TAX",
    "BONUS_CONTEST_SHARE",
}


def _commission_already_in_trade(
    *,
    event: CanonicalEvent,
    trade_lookup: dict[str, CanonicalTrade],
    resolved_linked_trade_id: str | None = None,
) -> bool:
    if event.cost_bucket not in TRADE_COMMISSION_BUCKETS:
        return False
    linked_trade_id = resolved_linked_trade_id or resolve_linked_trade_id(trade_lookup, event.linked_trade_id)
    linked_trade = trade_lookup.get(linked_trade_id) if linked_trade_id else None
    if linked_trade is None:
        return False
    return abs(linked_trade.commission or Decimal("0")) > 0 or abs(linked_trade.commission_pln or Decimal("0")) > 0


def _tax_impact_label_pl(kind: str) -> str:
    return {
        "PIT_COUNTED": "Liczone w PIT",
        "SCENARIO_COST": "Koszt w scenariuszach",
        "TECHNICAL_ONLY": "Techniczne - nie liczone w PIT",
        "REVIEW_REQUIRED": "Do sprawdzenia",
        "ANALYTICAL_ONLY": "Analityczne - nie wpływa na PIT",
    }.get(kind, "Do sprawdzenia")


def _trade_tax_impact_kind(trade: CanonicalTrade) -> str:
    logical_world = getattr(trade, "logical_world", None)
    if logical_world == "diagnostic_only":
        return "TECHNICAL_ONLY"
    if logical_world == "private_cash_fx":
        return "ANALYTICAL_ONLY"
    return "PIT_COUNTED"


def _trade_tax_impact_label(trade: CanonicalTrade) -> str:
    if _trade_tax_impact_kind(trade) == "TECHNICAL_ONLY":
        return "Bez bezpośredniego wpływu na PIT"
    if _trade_tax_impact_kind(trade) == "ANALYTICAL_ONLY":
        return "Analityczne przewalutowanie bez wpływu na PIT"
    return "Transakcja wpływa na rozliczenie PIT"


def _event_tax_impact_kind(
    event: CanonicalEvent,
    trade_lookup: dict[str, CanonicalTrade] | None = None,
    resolved_linked_trade_id: str | None = None,
) -> str:
    event_kind = (event.event_kind or "").upper()
    logical_world = getattr(event, "logical_world", None)
    if event_kind in REVIEW_EVENT_KINDS:
        return "REVIEW_REQUIRED"
    if trade_lookup and _commission_already_in_trade(
        event=event,
        trade_lookup=trade_lookup,
        resolved_linked_trade_id=resolved_linked_trade_id,
    ):
        return "TECHNICAL_ONLY"
    if event.cost_bucket in SCENARIO_COST_BUCKETS:
        return "SCENARIO_COST"
    if event_kind in TECHNICAL_EVENT_KINDS or logical_world in {"diagnostic_only", "cash_movement", "financing_repayment"}:
        return "TECHNICAL_ONLY"
    if logical_world == "private_cash_fx" or event_kind in {"FX_CONVERSION", "CURRENCY_CONVERSION", "CONVERSION"}:
        return "ANALYTICAL_ONLY"
    if event_kind in PIT_EVENT_KINDS or logical_world in {"dividend_tax", "foreign_dividend", "source_tax"}:
        return "PIT_COUNTED"
    return "REVIEW_REQUIRED"


def _event_tax_impact_label(
    event: CanonicalEvent,
    trade_lookup: dict[str, CanonicalTrade] | None = None,
    resolved_linked_trade_id: str | None = None,
) -> str:
    if trade_lookup and _commission_already_in_trade(
        event=event,
        trade_lookup=trade_lookup,
        resolved_linked_trade_id=resolved_linked_trade_id,
    ):
        return "Prowizja powiązana z transakcją; nie jest liczona drugi raz"
    kind = _event_tax_impact_kind(event, trade_lookup, resolved_linked_trade_id)
    if kind == "SCENARIO_COST":
        return "Koszt wpływa na scenariusze podatkowe"
    if kind == "PIT_COUNTED":
        return "Zdarzenie wpływa na przychód, podatek albo kredyt podatkowy"
    if kind == "TECHNICAL_ONLY":
        return "Widoczne w historii, bez automatycznego wpływu na PIT"
    if kind == "ANALYTICAL_ONLY":
        return "Widoczne analitycznie, bez automatycznego wpływu na PIT"
    return "Wymaga klasyfikacji wpływu podatkowego"


def _event_defense_status(event: CanonicalEvent, tax_impact_kind: str, resolved_linked_trade_id: str | None) -> str | None:
    if tax_impact_kind != "SCENARIO_COST":
        return None
    if event.cost_bucket in {"NEGATIVE_BALANCE_INTEREST"} or event.event_kind in {"NEGATIVE_CASH_FEE", "NEGATIVE_BALANCE_INTEREST"}:
        return "needs_user_evidence"
    if event.cost_bucket in TRADE_COMMISSION_BUCKETS and resolved_linked_trade_id:
        return "complete"
    if event.linked_trade_id and resolved_linked_trade_id:
        return "complete"
    return "needs_user_evidence"


def _event_missing_evidence_count(event: CanonicalEvent, defense_status: str | None) -> int:
    if not defense_status or defense_status == "complete":
        return 0
    if event.cost_bucket in {"NEGATIVE_BALANCE_INTEREST"} or event.event_kind in {"NEGATIVE_CASH_FEE", "NEGATIVE_BALANCE_INTEREST"}:
        return 1
    return 1


def build_transaction_history_rows(
    *,
    trades: list[CanonicalTrade],
    events: list[CanonicalEvent],
    funding_fee_allocations: list[FundingFeeAllocation],
    fifo_rows: list[RealizedTaxRow],
    tax_year: int | None,
) -> list[TransactionHistoryRow]:
    rows: list[TransactionHistoryRow] = []
    trade_lookup = {trade.trade_id: trade for trade in trades}
    sell_realized_rollups: dict[str, dict[str, object]] = defaultdict(lambda: {
        "pit_result_pln": Decimal("0.00"),
        "economic_result_pln": Decimal("0.00"),
        "grant_value_pln": Decimal("0.00"),
        "fifo_net_revenue_pln": Decimal("0.00"),
        "fifo_cost_pln": Decimal("0.00"),
        "fifo_gross_revenue_pln": Decimal("0.00"),
        "fifo_sell_commission_pln": Decimal("0.00"),
        "fifo_matched_quantity": Decimal("0.00"),
        "fifo_realized_rows": [],
    })

    for realized in fifo_rows:
        rollup = sell_realized_rollups[realized.sell_trade_id]
        rollup["pit_result_pln"] += realized.pnl_pln
        rollup["economic_result_pln"] += realized.economic_result_pln or realized.pnl_pln
        rollup["grant_value_pln"] += realized.grant_value_pln or Decimal("0.00")
        rollup["fifo_net_revenue_pln"] += realized.net_revenue_pln
        rollup["fifo_cost_pln"] += realized.cost_pln
        rollup["fifo_gross_revenue_pln"] += realized.gross_revenue_pln
        rollup["fifo_sell_commission_pln"] += realized.sell_commission_alloc_pln
        rollup["fifo_matched_quantity"] += realized.quantity
        rollup["fifo_realized_rows"].append(
            {
                "row_id": realized.row_id,
                "buy_trade_id": realized.buy_trade_id,
                "quantity": realized.quantity,
                "net_revenue_pln": realized.net_revenue_pln,
                "cost_pln": realized.cost_pln,
                "pnl_pln": realized.pnl_pln,
                "economic_result_pln": realized.economic_result_pln or realized.pnl_pln,
                "buy_reference_kind": realized.buy_reference_kind,
                "acquisition_mode": realized.acquisition_mode,
            }
        )

    parent_dates: dict[str, pd.Timestamp | None] = {}

    for trade in sorted(trades, key=lambda item: (_row_date_trade(item) or pd.Timestamp.min, item.trade_id)):
        display_date = _row_date_trade(trade)
        if not _same_tax_year(display_date, tax_year):
            continue
        realized_rollup = sell_realized_rollups.get(trade.trade_id)
        tax_impact_kind = _trade_tax_impact_kind(trade)
        tax_impact_label = _trade_tax_impact_label(trade)
        tax_impact_label_pl = _tax_impact_label_pl(tax_impact_kind)
        trade_details = {
            "order_id": trade.order_id,
            "trade_number": trade.trade_number,
            "settlement_date": trade.settlement_date,
            "commission": trade.commission,
            "commission_currency": trade.commission_currency,
            "commission_pln": trade.commission_pln,
            "buy_total_cost_pln": trade.buy_total_cost_pln,
            "sell_net_revenue_pln": trade.sell_net_revenue_pln,
            "gross_amount_pln": trade.gross_amount_pln,
            "country": trade.country,
            "manual_record_id": trade.manual_record_id,
            "overlay_status": trade.overlay_status,
            "executed_at": trade.executed_at,
            "exchange_time": trade.exchange_time,
            "tax_event_date": trade.tax_event_date,
            "source_timestamp_raw": trade.exchange_time or trade.executed_at,
            "source_manifest_id": _source_manifest_id(trade.source_links),
            "conflict_count": _conflict_count(trade.source_links),
            "tax_impact_label": tax_impact_label,
            "tax_impact_kind": tax_impact_kind,
            "is_technical_only": tax_impact_kind == "TECHNICAL_ONLY",
            "tax_impact_label_pl": tax_impact_label_pl,
        }
        if realized_rollup:
            trade_details.update(
                {
                    "fifo_net_revenue_pln": realized_rollup["fifo_net_revenue_pln"],
                    "fifo_cost_pln": realized_rollup["fifo_cost_pln"],
                    "fifo_gross_revenue_pln": realized_rollup["fifo_gross_revenue_pln"],
                    "fifo_sell_commission_pln": realized_rollup["fifo_sell_commission_pln"],
                    "fifo_matched_quantity": realized_rollup["fifo_matched_quantity"],
                    "fifo_realized_rows": list(realized_rollup["fifo_realized_rows"]),
                    "pit_result_pln": realized_rollup["pit_result_pln"],
                    "economic_result_pln": realized_rollup["economic_result_pln"],
                }
            )
        grant_value_pln = None
        if realized_rollup and realized_rollup["grant_value_pln"] != Decimal("0.00"):
            grant_value_pln = realized_rollup["grant_value_pln"]
        row = TransactionHistoryRow(
            row_id=_trade_row_id(trade),
            parent_row_id=None,
            row_kind="TRADE",
            display_date=display_date,
            transaction_id=trade.trade_id,
            ticker=trade.symbol,
            base_record_id=trade.trade_id,
            manual_record_id=trade.manual_record_id or trade.trade_id,
            read_only=False,
            side=trade.side,
            quantity=trade.quantity,
            amount=trade.gross_amount,
            currency=trade.trade_currency,
            amount_pln=trade.amount_pln,
            comment=trade.comment,
            message=trade.message,
            source_name=trade.source_name,
            source_manifest_id=_source_manifest_id(trade.source_links),
            conflict_count=_conflict_count(trade.source_links),
            tax_impact_label=tax_impact_label,
            tax_impact_kind=tax_impact_kind,
            is_technical_only=tax_impact_kind == "TECHNICAL_ONLY",
            tax_impact_label_pl=tax_impact_label_pl,
            source_refs=list(trade.evidence_refs),
            provenance=list(trade.source_links),
            logical_world=trade.logical_world,
            acquisition_mode=trade.acquisition_mode,
            pit_result_pln=realized_rollup["pit_result_pln"] if realized_rollup else None,
            economic_result_pln=realized_rollup["economic_result_pln"] if realized_rollup else None,
            grant_value_pln=grant_value_pln,
            overlay_status=trade.overlay_status,
            is_modified=trade.is_modified,
            is_new=trade.is_new,
            modified_fields=list(trade.modified_fields),
            original_snapshot=dict(trade.original_snapshot),
            current_snapshot=dict(trade.current_snapshot),
            details=trade_details,
        )
        rows.append(row)
        parent_dates[row.row_id] = display_date

    for event in sorted(events, key=lambda item: (_row_date_event(item) or pd.Timestamp.min, item.event_id)):
        display_date = _row_date_event(event)
        if not _same_tax_year(display_date, tax_year):
            continue
        row_kind = event.event_kind
        parent_row_id = None
        resolved_linked_trade_id = resolve_linked_trade_id(trade_lookup, event.linked_trade_id)
        commission_already_in_trade = _commission_already_in_trade(
            event=event,
            trade_lookup=trade_lookup,
            resolved_linked_trade_id=resolved_linked_trade_id,
        )
        if event.cost_bucket in TRADE_COMMISSION_BUCKETS and resolved_linked_trade_id:
            parent_row_id = f"TRADE-{resolved_linked_trade_id}"
        tax_impact_kind = _event_tax_impact_kind(event, trade_lookup, resolved_linked_trade_id)
        tax_impact_label = _event_tax_impact_label(event, trade_lookup, resolved_linked_trade_id)
        tax_impact_label_pl = _tax_impact_label_pl(tax_impact_kind)
        defense_status = _event_defense_status(event, tax_impact_kind, resolved_linked_trade_id)
        evidence_count = len(event.evidence_refs) if event.evidence_refs else (1 if event.source_record_id else 0)
        missing_evidence_count = _event_missing_evidence_count(event, defense_status)
        rows.append(
            TransactionHistoryRow(
                row_id=_event_row_id(event),
                parent_row_id=parent_row_id,
                row_kind=row_kind,
                display_date=display_date,
                transaction_id=event.event_id,
                ticker=event.symbol,
                base_record_id=event.event_id,
                manual_record_id=event.manual_record_id or event.event_id,
                read_only=False,
                quantity=event.quantity,
                amount=event.amount,
                currency=event.currency,
                amount_pln=event.amount_pln,
                comment=event.comment,
                message=event.comment,
                source_name=event.source_name,
                source_manifest_id=_source_manifest_id(event.source_links),
                conflict_count=_conflict_count(event.source_links),
                tax_impact_label=tax_impact_label,
                tax_impact_kind=tax_impact_kind,
                is_technical_only=tax_impact_kind == "TECHNICAL_ONLY",
                tax_impact_label_pl=tax_impact_label_pl,
                defense_status=defense_status,
                evidence_count=evidence_count,
                missing_evidence_count=missing_evidence_count,
                source_refs=list(event.evidence_refs),
                provenance=list(event.source_links),
                logical_world=event.logical_world,
                acquisition_mode=event.acquisition_mode,
                grant_tax_status=event.grant_tax_status,
                grant_value_pln=event.grant_value_pln,
                overlay_status=event.overlay_status,
                is_modified=event.is_modified,
                is_new=event.is_new,
                modified_fields=list(event.modified_fields),
                original_snapshot=dict(event.original_snapshot),
                current_snapshot=dict(event.current_snapshot),
                details={
                    "event_kind": event.event_kind,
                    "linked_trade_id": event.linked_trade_id,
                    "resolved_linked_trade_id": resolved_linked_trade_id,
                    "source_record_id": event.source_record_id,
                    "source_links": list(event.source_links),
                    "cost_bucket": event.cost_bucket,
                    "cost_class": event.cost_class,
                    "country": event.country,
                    "grant_market_value": event.grant_market_value,
                    "promotion_basis": event.promotion_basis,
                    "completeness_status": event.completeness_status,
                    "pit_cost_pln": Decimal("0.00") if event.event_kind == "BONUS_CONTEST_SHARE" else None,
                    "economic_cost_pln": event.economic_cost_pln,
                    "manual_record_id": event.manual_record_id,
                    "overlay_status": event.overlay_status,
                    "effective_at": event.effective_at,
                    "tax_event_date": event.tax_event_date,
                    "source_timestamp_raw": event.effective_at,
                    "source_manifest_id": _source_manifest_id(event.source_links),
                    "conflict_count": _conflict_count(event.source_links),
                    "tax_impact_label": tax_impact_label,
                    "tax_impact_kind": tax_impact_kind,
                    "is_technical_only": tax_impact_kind == "TECHNICAL_ONLY",
                    "tax_impact_label_pl": tax_impact_label_pl,
                    "defense_status": defense_status,
                    "evidence_count": evidence_count,
                    "missing_evidence_count": missing_evidence_count,
                    "commission_already_in_trade": commission_already_in_trade,
                },
            )
        )
        parent_dates[_event_row_id(event)] = display_date

    for allocation in sorted(funding_fee_allocations, key=lambda item: (parent_dates.get(f"TRADE-{item.trade_id}") or pd.Timestamp.min, item.allocation_id)):
        parent_row_id = f"TRADE-{allocation.trade_id}"
        parent_date = parent_dates.get(parent_row_id)
        if not _same_tax_year(parent_date, tax_year):
            continue
        parent_trade = trade_lookup.get(allocation.trade_id)
        rows.append(
            TransactionHistoryRow(
                row_id=f"ALLOCATED-COST-{allocation.allocation_id}",
                parent_row_id=parent_row_id,
                row_kind="ALLOCATED_COST",
                display_date=parent_date,
                transaction_id=allocation.funding_event_id,
                ticker=parent_trade.symbol if parent_trade else allocation.symbol,
                base_record_id=None,
                manual_record_id=allocation.funding_event_id,
                amount=allocation.original_amount,
                currency=allocation.original_currency,
                amount_pln=allocation.allocated_amount_pln,
                comment=allocation.evidence_note,
                message=allocation.evidence_note,
                source_name="USER_OVERRIDE",
                source_manifest_id="manual:override",
                conflict_count=0,
                tax_impact_label="Ręczny koszt wpływa na scenariusze podatkowe",
                tax_impact_kind="SCENARIO_COST",
                is_technical_only=False,
                tax_impact_label_pl=_tax_impact_label_pl("SCENARIO_COST"),
                defense_status="needs_user_evidence",
                evidence_count=len(allocation.source_refs) if allocation.source_refs else 1,
                missing_evidence_count=1,
                read_only=True,
                source_refs=list(allocation.source_refs),
                provenance=[{"allocation_id": allocation.allocation_id, "trade_id": allocation.trade_id}],
                logical_world="equity_tax",
                allocation_ratio=allocation.allocation_ratio,
                allocation_method=allocation.method,
                deposit_id=allocation.deposit_id,
                deposit_amount=allocation.deposit_amount,
                details={
                    "funding_fee_entry_id": allocation.funding_event_id,
                    "parent_row_id": parent_row_id,
                    "parent_trade_id": allocation.trade_id,
                    "allocation_ratio": allocation.allocation_ratio,
                    "allocation_method": allocation.method,
                    "basis_amount_pln": allocation.basis_amount_pln,
                    "deposit_id": allocation.deposit_id,
                    "deposit_amount": allocation.deposit_amount,
                    "tax_impact_label": "Ręczny koszt wpływa na scenariusze podatkowe",
                    "tax_impact_kind": "SCENARIO_COST",
                    "is_technical_only": False,
                    "tax_impact_label_pl": _tax_impact_label_pl("SCENARIO_COST"),
                    "defense_status": "needs_user_evidence",
                    "evidence_count": len(allocation.source_refs) if allocation.source_refs else 1,
                    "missing_evidence_count": 1,
                },
            )
        )

    rows.sort(
        key=lambda row: (
            row.display_date or pd.Timestamp.min,
            0 if row.parent_row_id is None else 1,
            row.parent_row_id or row.row_id,
            row.row_id,
        )
    )
    return rows
