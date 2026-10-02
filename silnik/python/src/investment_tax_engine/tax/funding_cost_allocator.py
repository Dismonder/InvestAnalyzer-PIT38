from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP

import pandas as pd

from investment_tax_engine.models.core import CanonicalEvent, CanonicalTrade, FundingCostEvent, FundingFeeAllocation


Q2 = Decimal("0.01")
MAX_FUNDING_FEE_ALLOCATION_TRADES = 10
MAX_DEPOSIT_FEE_GAP_DAYS = 3


def q2(value: Decimal) -> Decimal:
    return value.quantize(Q2, rounding=ROUND_HALF_UP)


def _trade_basis_pln(trade: CanonicalTrade) -> Decimal:
    for candidate in (trade.buy_total_cost_pln, trade.gross_amount_pln, trade.amount_pln):
        if candidate is not None and candidate > 0:
            return candidate
    return Decimal("0.00")


def confirmed_deposit(funding_event: FundingCostEvent, events: list[CanonicalEvent]) -> bool:
    """A reference alone is not evidence that the fee belongs to a deposit."""
    if not funding_event.linked_deposit_id:
        return False
    fee_date = pd.Timestamp(funding_event.date).normalize()
    for event in events:
        if funding_event.linked_deposit_id not in {event.event_id, event.source_record_id}:
            continue
        deposit_date = event.tax_event_date or event.effective_at
        if (
            event.event_kind in {"BANK_TRANSFER", "DEPOSIT"}
            and event.amount > 0
            and event.currency.upper() == funding_event.currency.upper()
            and deposit_date is not None
            and abs((pd.Timestamp(deposit_date).normalize() - fee_date).days) <= MAX_DEPOSIT_FEE_GAP_DAYS
        ):
            return True
    return False


def _eligible_buys(funding_event: FundingCostEvent, trades: list[CanonicalTrade]) -> list[CanonicalTrade]:
    eligible: list[CanonicalTrade] = []
    start = pd.Timestamp(funding_event.date).normalize()
    cumulative = Decimal("0.00")
    deposit_amount = funding_event.deposit_amount_pln or funding_event.deposit_amount or Decimal("0.00")

    for trade in sorted(
        trades,
        key=lambda item: (
            pd.Timestamp(item.tax_event_date or item.exchange_time or item.executed_at or pd.Timestamp.max),
            item.trade_id,
        ),
    ):
        if trade.side != "BUY" or trade.logical_world != "equity_tax":
            continue
        trade_date = pd.Timestamp(trade.tax_event_date or trade.exchange_time or trade.executed_at or pd.Timestamp.min).normalize()
        if trade_date < start:
            continue
        basis = _trade_basis_pln(trade)
        if basis <= 0:
            continue
        eligible.append(trade)
        cumulative += basis
        if len(eligible) >= MAX_FUNDING_FEE_ALLOCATION_TRADES:
            break
        if deposit_amount > 0 and cumulative >= deposit_amount:
            break

    return eligible


def allocate_funding_costs(
    funding_events: list[FundingCostEvent],
    trades: list[CanonicalTrade],
    *,
    deposit_events: list[CanonicalEvent] = (),
    allocation_mode: str = "proportional_first_batch",
) -> list[FundingFeeAllocation]:
    allocations: list[FundingFeeAllocation] = []

    for funding_event in funding_events:
        if not confirmed_deposit(funding_event, deposit_events):
            continue
        eligible = _eligible_buys(funding_event, trades)
        if not eligible:
            continue

        if allocation_mode == "first_trade_only":
            trade = eligible[0]
            allocations.append(
                FundingFeeAllocation(
                    allocation_id=f"ALLOC-{funding_event.funding_event_id}-{trade.trade_id}",
                    funding_event_id=funding_event.funding_event_id,
                    trade_id=trade.trade_id,
                    symbol=trade.symbol,
                    allocated_amount_pln=q2(funding_event.amount_pln or funding_event.amount),
                    basis_amount_pln=_trade_basis_pln(trade),
                    allocation_ratio=Decimal("1.00000000"),
                    method=allocation_mode,
                    deposit_id=funding_event.linked_deposit_id,
                    deposit_amount=funding_event.deposit_amount,
                    original_amount=funding_event.amount,
                    original_currency=funding_event.currency,
                    evidence_note=funding_event.evidence_note,
                    source_refs=list(funding_event.source_refs),
                )
            )
            continue

        basis_values = [_trade_basis_pln(trade) for trade in eligible]
        basis_total = sum(basis_values, Decimal("0.00"))
        if basis_total <= 0:
            continue

        funding_amount_pln = q2(funding_event.amount_pln or funding_event.amount)
        remaining = funding_amount_pln
        for index, trade in enumerate(eligible):
            basis = basis_values[index]
            ratio = (basis / basis_total) if basis_total else Decimal("0.00")
            allocated = remaining if index == len(eligible) - 1 else q2(funding_amount_pln * ratio)
            remaining = q2(remaining - allocated)
            allocations.append(
                FundingFeeAllocation(
                    allocation_id=f"ALLOC-{funding_event.funding_event_id}-{trade.trade_id}",
                    funding_event_id=funding_event.funding_event_id,
                    trade_id=trade.trade_id,
                    symbol=trade.symbol,
                    allocated_amount_pln=allocated,
                    basis_amount_pln=basis,
                    allocation_ratio=ratio.quantize(Decimal("0.00000001"), rounding=ROUND_HALF_UP),
                    method=allocation_mode,
                    deposit_id=funding_event.linked_deposit_id,
                    deposit_amount=funding_event.deposit_amount,
                    original_amount=funding_event.amount,
                    original_currency=funding_event.currency,
                    evidence_note=funding_event.evidence_note,
                    source_refs=list(funding_event.source_refs),
                )
            )

    return allocations
