from __future__ import annotations

from decimal import Decimal, InvalidOperation
from typing import Any

from investment_tax_engine.models.core import (
    CanonicalDataset,
    CanonicalEvent,
    CanonicalTrade,
    EngineConfig,
    Issue,
    Ledger,
    MergeResult,
)


EMPTY_VALUES = {None, "", "nan", "null"}
API_TRUTH_SOURCES = {"API_JSON_FULL"}
API_TRUTH_FIELDS = {
    "commission_currency",
    "executed_at",
    "exchange_time",
    "settlement_date",
    "confirm_time",
    "otc",
    "repo_close",
    "base_contract_code",
    "current_position_qty_after_trade",
}
DERIVED_STATUS_FIELDS = {"certainty_status", "review_status", "amount_mismatch"}
INFORMATIONAL_TOLERANCE_FIELDS = {"broker_reported_profit"}
INFORMATIONAL_TOLERANCE = Decimal("0.01")


def is_empty(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str) and value.strip().lower() in EMPTY_VALUES:
        return True
    return False


def normalize_value(value: Any) -> Any:
    if isinstance(value, str):
        return " ".join(value.split()).strip()
    return value


def values_match_for_merge(field_name: str, old_val: Any, new_val: Any) -> bool:
    if normalize_value(old_val) == normalize_value(new_val):
        return True

    if field_name in INFORMATIONAL_TOLERANCE_FIELDS:
        try:
            return abs(Decimal(str(old_val)) - Decimal(str(new_val))) <= INFORMATIONAL_TOLERANCE
        except (ArithmeticError, InvalidOperation, ValueError):
            return False

    return False


def resolve_merge_winner(existing: CanonicalTrade, incoming: CanonicalTrade, field_name: str) -> tuple[str, str]:
    if field_name in DERIVED_STATUS_FIELDS:
        return (
            (incoming.source_name, "prefer_higher_priority_status")
            if incoming.source_priority > existing.source_priority
            else (existing.source_name, "preserve_higher_priority_status")
        )

    if field_name in API_TRUTH_FIELDS:
        if existing.source_name in API_TRUTH_SOURCES and incoming.source_name not in API_TRUTH_SOURCES:
            return existing.source_name, "preserve_api_truth"
        if incoming.source_name in API_TRUTH_SOURCES and existing.source_name not in API_TRUTH_SOURCES:
            return incoming.source_name, "prefer_api_truth"

    if incoming.source_priority > existing.source_priority:
        return incoming.source_name, "prefer_higher_priority_source"
    return existing.source_name, "preserve_higher_priority_source"


def should_emit_field_conflict(field_name: str, winner_reason: str) -> bool:
    if field_name in DERIVED_STATUS_FIELDS:
        return False
    if winner_reason in {"preserve_api_truth", "prefer_api_truth"}:
        return False
    return True


def merge_field(existing: CanonicalTrade, incoming: CanonicalTrade, field_name: str, ledger: Ledger) -> None:
    old_val = getattr(existing, field_name)
    new_val = getattr(incoming, field_name)

    if is_empty(old_val) and not is_empty(new_val):
        setattr(existing, field_name, new_val)
        existing.source_links.append({"field": field_name, "winner": incoming.source_name, "reason": "fill_missing"})
        return

    if is_empty(new_val):
        return

    if values_match_for_merge(field_name, old_val, new_val):
        return

    winner, winner_reason = resolve_merge_winner(existing, incoming, field_name)
    if winner == incoming.source_name:
        setattr(existing, field_name, new_val)

    existing.source_links.append(
        {
            "field": field_name,
            "existing": None if old_val is None else str(old_val),
            "incoming": None if new_val is None else str(new_val),
            "winner": winner,
            "reason": winner_reason,
        }
    )

    if should_emit_field_conflict(field_name, winner_reason):
        ledger.issues.append(
            Issue(
                code="FIELD_CONFLICT",
                severity="WARNING",
                stage="MERGE",
                scope_type="TRADE",
                scope_id=existing.trade_id,
                message=f"Konflikt wartości pola „{field_name}” podczas łączenia danych. Sprawdź rekordy w Historii transakcji.",
                details={
                    "field": field_name,
                    "existing_value": None if old_val is None else str(old_val),
                    "incoming_value": None if new_val is None else str(new_val),
                    "winner": winner,
                    "reason": winner_reason,
                },
                blocking=False,
            )
        )


def upsert_trade(ledger: Ledger, incoming: CanonicalTrade) -> None:
    existing = ledger.trades_by_id.get(incoming.trade_id)

    if existing is None:
        ledger.trades_by_id[incoming.trade_id] = incoming
        ledger.index_by_symbol.setdefault(incoming.symbol, set()).add(incoming.trade_id)
        if incoming.order_id:
            ledger.index_by_order_id.setdefault(incoming.order_id, set()).add(incoming.trade_id)
        if incoming.tax_event_date:
            ledger.index_by_date.setdefault(str(incoming.tax_event_date.date()), set()).add(incoming.trade_id)
        return

    if existing.source_name == incoming.source_name and existing.source_record_id != incoming.source_record_id:
        ledger.issues.append(
            Issue(
                code="DUPLICATE_TRADE_ID",
                severity="CRITICAL",
                stage="MERGE",
                scope_type="TRADE",
                scope_id=incoming.trade_id,
                message="W tym samym źródle wykryto powielony identyfikator transakcji. Sprawdź duplikaty w Historii transakcji.",
                details={
                    "existing_source_record_id": existing.source_record_id,
                    "incoming_source_record_id": incoming.source_record_id,
                    "source_name": incoming.source_name,
                },
                blocking=False,
            )
        )

    for field_name in (
        "order_id",
        "trade_number",
        "symbol",
        "isin",
        "side",
        "instrument_type_code",
        "instrument_class",
        "market_id",
        "quantity",
        "price",
        "gross_amount",
        "trade_currency",
        "commission",
        "commission_currency",
        "broker_reported_profit",
        "executed_at",
        "exchange_time",
        "settlement_date",
        "confirm_time",
        "otc",
        "repo_close",
        "base_contract_code",
        "current_position_qty_after_trade",
        "logical_world",
        "cost_bucket",
        "cost_class",
        "country",
        "certainty_status",
        "review_status",
        "amount_mismatch",
        "comment",
        "message",
    ):
        merge_field(existing, incoming, field_name, ledger)

    for src in incoming.sources or [incoming.source_name]:
        if src not in existing.sources:
            existing.sources.append(src)

    existing.evidence_refs.extend(ref for ref in incoming.evidence_refs if ref not in existing.evidence_refs)
    existing.decision_trace_refs.extend(
        ref for ref in incoming.decision_trace_refs if ref not in existing.decision_trace_refs
    )


def upsert_event(ledger: Ledger, incoming: CanonicalEvent) -> None:
    existing = ledger.events_by_id.get(incoming.event_id)
    if existing is None:
        ledger.events_by_id[incoming.event_id] = incoming
        if incoming.symbol:
            ledger.index_by_symbol.setdefault(incoming.symbol, set()).add(incoming.event_id)
        if incoming.tax_event_date:
            ledger.index_by_date.setdefault(str(incoming.tax_event_date.date()), set()).add(incoming.event_id)
        return

    if incoming.source_priority > existing.source_priority:
        ledger.events_by_id[incoming.event_id] = incoming


def build_dataset_from_ledger(ledger: Ledger) -> CanonicalDataset:
    return CanonicalDataset(
        trades=tuple(ledger.trades_by_id.values()),
        events=tuple(ledger.events_by_id.values()),
        issues=tuple(ledger.issues),
        metadata=dict(ledger.metadata),
    )


def merge_dataset(dataset: CanonicalDataset, config: EngineConfig) -> MergeResult:
    ledger = Ledger(metadata=dict(dataset.metadata))
    ledger.issues.extend(dataset.issues)

    for trade in sorted(dataset.trades, key=lambda item: (-item.source_priority, item.trade_id)):
        upsert_trade(ledger, trade)

    for event in sorted(dataset.events, key=lambda item: (-item.source_priority, item.event_id)):
        upsert_event(ledger, event)

    unmatched_trades = [
        trade.trade_id
        for trade in dataset.trades
        if trade.source_name not in API_TRUTH_SOURCES and trade.trade_id not in ledger.trades_by_id
    ]
    unmatched_events = [
        event.event_id
        for event in dataset.events
        if event.event_id not in ledger.events_by_id
    ]

    if config.run_mode == "STRICT":
        weak_matches = [trade.trade_id for trade in dataset.trades if trade.match_strength == "WEAK"]
        for trade_id in weak_matches:
            ledger.issues.append(
                Issue(
                    code="UNMATCHED_TRADE_ROW",
                    severity="CRITICAL",
                    stage="MERGE",
                    scope_type="TRADE",
                    scope_id=trade_id,
                    message="Tryb STRICT odrzuca wiersze słabo dopasowane do transakcji. Otwórz je w Historii transakcji i popraw dane lub dopasowanie.",
                    blocking=False,
                )
            )

    return MergeResult(
        ledger=ledger,
        canonical_dataset=build_dataset_from_ledger(ledger),
        unmatched_trades=unmatched_trades,
        unmatched_events=unmatched_events,
        reconciliation_summary={
            "trade_count": len(ledger.trades_by_id),
            "event_count": len(ledger.events_by_id),
            "issue_count": len(ledger.issues),
        },
    )
