from __future__ import annotations

import json
from decimal import Decimal
from hashlib import sha256
from typing import Any

import pandas as pd

from ..models.core import CanonicalEvent
from .trades import parse_amount, to_timestamp
from .classify import (
    classify_event_fields,
    clean_text,
    extract_symbol,
    extract_trade_id,
    infer_country,
)


def is_missing(val: Any) -> bool:
    if val is None or val == "":
        return True
    try:
        if pd.isna(val):
            return True
    except TypeError:
        pass
    return str(val).strip().lower() in {"nan", "null", "none"}


def to_decimal(val: Any, default: Decimal = Decimal("0")) -> Decimal:
    """Kwota zdarzenia. Wspolny parser obsluguje formaty spotykane w wyciagach."""
    parsed = parse_amount(val)
    return default if parsed is None else parsed


def _first_present(raw_row: dict[str, Any], keys: list[str]) -> Any:
    for key in keys:
        value = raw_row.get(key)
        if not is_missing(value):
            return value
    return None


def _stable_fallback_event_id(
    raw_row: dict[str, Any],
    *,
    source_name: str,
    source_file: str,
    source_sheet: str,
) -> str:
    explicit = _first_present(raw_row, ["Operacja №", "row_id", "id"])
    if explicit is not None:
        return clean_text(explicit)
    payload = {
        "source_name": source_name,
        "source_file": source_file,
        "source_sheet": source_sheet,
        "date": str(_first_present(raw_row, ["Data", "date", "datetime", "settlement_date", "executed_at", "exchange_time"]) or ""),
        "kind": str(_first_present(raw_row, ["Rodzaj zlecenia", "type", "type_code_name", "type_code", "name"]) or ""),
        "comment": str(_first_present(raw_row, ["Komentarz", "comment", "message", "description"]) or ""),
        "amount": str(_first_present(raw_row, ["Kwota", "amount", "sum"]) or ""),
        "currency": str(_first_present(raw_row, ["waluta", "currency", "curr"]) or ""),
    }
    digest = sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()[:16]
    return f"EVENT-{digest}"


def normalize_tradernet_event(
    raw_row: dict[str, Any],
    source_name: str = "TRADERNET_TABLE",
    source_file: str = "",
    source_sheet: str = "",
) -> CanonicalEvent:
    event_id = _stable_fallback_event_id(
        raw_row,
        source_name=source_name,
        source_file=source_file,
        source_sheet=source_sheet,
    )
    kind_text = clean_text(
        raw_row.get("Rodzaj zlecenia")
        or raw_row.get("type")
        or raw_row.get("type_code_name")
        or raw_row.get("type_code")
        or raw_row.get("name")
        or ""
    )
    comment = clean_text(raw_row.get("Komentarz") or raw_row.get("comment") or raw_row.get("message") or raw_row.get("description") or "")
    raw_amount = _first_present(raw_row, ["Kwota", "amount", "sum"])
    amount = parse_amount(raw_amount)
    currency = clean_text(_first_present(raw_row, ["waluta", "currency", "curr"]) or "").upper()
    effective_at = to_timestamp(
        raw_row.get("Data")
        or raw_row.get("date")
        or raw_row.get("datetime")
        or raw_row.get("settlement_date")
        or raw_row.get("executed_at")
        or raw_row.get("exchange_time"),
        # Kolejnosc DD/MM vs MM/DD ustalona dla calego pliku (patrz ustal_kolejnosc_dat).
        clean_text(raw_row.get("kolejnosc_dat_pliku") or "").upper() or None,
    )

    classified = classify_event_fields(kind_text, comment, amount if amount is not None else Decimal("0"))
    # Noga papierowa zdarzenia korporacyjnego (np. wykup noty „Termin zapadalnosci”:
    # ilosc bez kwoty) nie jest zdarzeniem pienieznym - kwote niesie noga pieniezna,
    # a wykup silnik zamienia na sprzedaz osobna sciezka. Na rachunku uzytkownika
    # dwa takie zapisy (DGT4016.JUN26, DGT4017.AUG25) blokowaly rozliczenie.
    # Tylko jawnie rozpoznany wykup (MATURITY) - dywidenda czy podatek z polem ilosci,
    # ale bez kwoty, nadal blokuje (inaczej przechodzilby jako przychod 0 zl).
    noga_papierowa = (
        amount is None
        and classified.get("event_kind") == "MATURITY"
        and parse_amount(_first_present(raw_row, ["quantity", "q", "Ilosc", "Ilość"])) not in (None, Decimal("0"))
    )
    if (
        classified["logical_world"] in {"equity_tax", "financing_costs"}
        and (amount is None or not currency)
        and not noga_papierowa
    ):
        raise ValueError(f"Tax event {event_id} has no valid amount or currency")
    amount = Decimal("0") if amount is None else amount
    symbol = extract_symbol(comment)
    linked_trade_id = extract_trade_id(comment)

    return CanonicalEvent(
        event_id=event_id,
        event_kind=str(classified["event_kind"]),
        symbol=symbol,
        linked_trade_id=linked_trade_id,
        amount=amount,
        currency=currency,
        effective_at=effective_at,
        comment=comment or None,
        source_name=source_name,
        source_priority=90 if source_name == "TRADERNET_TABLE" else 70,
        source_record_id=event_id,
        account_id=clean_text(_first_present(raw_row, ["account_id", "account", "Rachunek"])) or None,
        source_file=source_file,
        source_sheet=source_sheet,
        source_row_id=event_id,
        review_status="AUTO_REVIEWED",
        logical_world=str(classified["logical_world"]),
        cost_bucket=classified["cost_bucket"],
        cost_class=str(classified["cost_class"]),
        # Kraj z ISIN (zagraniczny emitent notowany na GPW ma PL w symbolu, ale NL/LU w ISIN),
        # a bez ISIN z konca symbolu.
        country=infer_country(symbol or "", _first_present(raw_row, ["isin", "ISIN"])),
        original_amount=amount,
        original_currency=currency,
        original_event_date=effective_at,
        evidence_refs=[f"{source_name}:{event_id}"],
        decision_trace_refs=[f"{source_name}:{event_id}:normalized"],
        sources=[source_name],
    )
