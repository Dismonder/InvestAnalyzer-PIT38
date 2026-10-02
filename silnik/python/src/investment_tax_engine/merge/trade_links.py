from __future__ import annotations

from collections.abc import Mapping
from typing import Any


def resolve_linked_trade_id(trades_by_id: Mapping[str, Any], linked_trade_id: str | None) -> str | None:
    """Resolve broker short trade references to canonical trade IDs.

    Broker cash-flow rows often reference the broker trade number, while the
    canonical trade ID can be composed as "trade_number/order_id".
    Return a match only when it is unambiguous.
    """
    linked = str(linked_trade_id or "").strip()
    if not linked:
        return None
    if linked in trades_by_id:
        return linked

    matches: list[str] = []
    for trade_id, trade in trades_by_id.items():
        candidate_values = {
            str(trade_id),
            str(getattr(trade, "order_id", "") or ""),
            str(getattr(trade, "trade_number", "") or ""),
            str(getattr(trade, "source_record_id", "") or ""),
        }
        if "/" in str(trade_id):
            candidate_values.update(part for part in str(trade_id).split("/") if part)
        if linked in candidate_values:
            matches.append(str(trade_id))

    unique_matches = sorted(set(matches))
    if len(unique_matches) == 1:
        return unique_matches[0]
    return None
