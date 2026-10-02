from __future__ import annotations

import json
import os
import re
import shutil
import sys
import time
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from decimal import Decimal
from hashlib import sha256
from pathlib import Path
from typing import Any, Iterable

import pandas as pd

from investment_tax_engine.ai.comment_context_extractor import build_ai_extracted_context
from investment_tax_engine.ai.column_mapper import deterministic_column_mapping, map_columns_with_ai
from investment_tax_engine.ai.document_classifier import build_document_classifications
from investment_tax_engine.app.source_resolver import BrokerStorageResolvedSource, _flatten_json_lists
from investment_tax_engine.app.spreadsheet_safety import (
    MAX_SPREADSHEET_ENTRY_RATIO, MAX_SPREADSHEET_UNCOMPRESSED_BYTES,
    MIN_SPREADSHEET_ENTRY_RATIO_BYTES, validate_spreadsheet_zip,
)
from investment_tax_engine.normalize.trades import (
    determine_side,
    is_aggregation_marker,
    operation_code,
    parse_amount,
    to_timestamp,
    ustal_kolejnosc_dat,
)


SCHEMA_NORMALIZED_EVENT = "normalized_event.v1"
SCHEMA_TRANSACTION_DOSSIER = "transaction_dossier.v1"
SCHEMA_CANONICAL_TAX_INPUT = "canonical_tax_input.v2"
MAX_SPREADSHEET_ROWS_PER_FILE = 200_000


def _json_safe(value: Any) -> Any:
    if value is None:
        return None
    # Szybka sciezka dla dokladnych typow wbudowanych: pd.isna dla nich daje
    # True tylko przy NaN, a funkcja jest wolana setki tysiecy razy na przebieg.
    # Wynik identyczny z pelna sciezka ponizej (podklasy, np. numpy.float64,
    # ida nadal pelna sciezka).
    typ = type(value)
    if typ is str or typ is int or typ is bool:
        return value
    if typ is float:
        return None if value != value else value
    try:
        if pd.isna(value):
            return None
    except Exception:
        pass
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (pd.Timestamp, datetime)):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(key): _json_safe(inner) for key, inner in value.items()}
    if isinstance(value, list):
        return [_json_safe(inner) for inner in value]
    if hasattr(value, "item"):
        try:
            return _json_safe(value.item())
        except Exception:
            pass
    return value


def _clean_text(value: Any) -> str | None:
    if value is None:
        return None
    if type(value) is str:
        return value.strip() or None
    try:
        if pd.isna(value):
            return None
    except Exception:
        pass
    text = str(value).strip()
    return text or None


def _text_blob(row: dict[str, Any]) -> str:
    return " ".join(str(value).lower() for value in row.values() if value is not None)


def _first_text(row: dict[str, Any], *keys: str) -> str | None:
    lower_map = {str(key).lower(): key for key in row.keys()}
    for key in keys:
        actual = key if key in row else lower_map.get(key.lower())
        if actual is None:
            continue
        value = _clean_text(row.get(actual))
        if value:
            return value
    return None


def _decimal_from_value(value: Any) -> Decimal | None:
    if _clean_text(value) is None:
        return None
    return parse_amount(value)


def _first_decimal(row: dict[str, Any], *keys: str) -> Decimal | None:
    lower_map = {str(key).lower(): key for key in row.keys()}
    for key in keys:
        actual = key if key in row else lower_map.get(key.lower())
        if actual is None:
            continue
        parsed = _decimal_from_value(row.get(actual))
        if parsed is not None:
            return parsed
    return None


_DATE_KEYS = (
    "date",
    # Raport depozytariusza wpisuje w pole date literal agregacji, a
    # faktyczna date pozycji scalonej zostawia w short_date.
    "short_date",
    "datetime",
    "executed_at",
    "exchange_time",
    "settlement_date",
    "Execution time",
    "Data",
    "Date",
    "trade_d_exch",
    "pay_d",
)

# Pola dat czytane gdzie indziej niz w _timestamp_from_row - tez wchodza do
# ustalania kolejnosci DD/MM vs MM/DD dla pliku.
_EXTRA_DATE_KEYS = ("Data rozliczenia", "Execution Date", "Obliczenia", "T2_confirm")


def _file_date_order(source_rows: list[tuple[dict[str, Any], str, str | None, str | None]]) -> str | None:
    """Kolejnosc DD/MM ("DMY") albo MM/DD ("MDY") dla calego pliku; ValueError przy sprzecznosci."""
    return ustal_kolejnosc_dat(
        raw[key]
        for raw, section, _row_ref, _sheet in source_rows
        if section != "read_error" and isinstance(raw, dict)
        for key in (*_DATE_KEYS, *_EXTRA_DATE_KEYS)
        if key in raw
    )


def _timestamp_from_row(row: dict[str, Any], order: str | None = None) -> pd.Timestamp | None:
    for key in _DATE_KEYS:
        value = _first_text(row, key)
        if not value:
            continue
        parsed = to_timestamp(value, order)
        if parsed is not None:
            return parsed
    return None


def _date_text(row: dict[str, Any], *keys: str, order: str | None = None) -> str | None:
    for key in keys:
        value = _first_text(row, key)
        if not value:
            continue
        parsed = to_timestamp(value, order)
        if parsed is None:
            # Wartosc nieczytelna jako data (np. literal agregacji) nie jest
            # data - przechodzimy do kolejnego pola zamiast ja zwracac.
            continue
        return str(parsed.date())
    return None


def _operation(row: dict[str, Any]) -> str | None:
    side, side_is_known = determine_side(row)
    if side_is_known:
        return side
    raw = operation_code(row)
    text = (raw or "").strip().lower()
    if "dividend" in text or "dywidend" in text:
        return "DIVIDEND"
    if "commission" in text or "fee" in text or "prowiz" in text:
        return "FEE"
    if "interest" in text or "odset" in text or "negative cash balance" in text:
        return "INTEREST"
    if "fx" in text or "exchange" in text or "przewalut" in text:
        return "FX"
    if "transfer" in text or "przelew" in text:
        return "TRANSFER"
    return raw.upper() if raw and raw.isalpha() and len(raw) <= 16 else None


def _ticker(row: dict[str, Any]) -> str | None:
    value = _first_text(
        row,
        "ticker",
        "symbol",
        "instr_nm",
        "Instrument name",
        "Instrument",
        "Papier wartościowy",
        "papier wartosciowy",
    )
    if value:
        return value.strip()
    comment = _first_text(row, "comment", "Komentarz", "description", "Opis")
    if comment:
        match = re.search(r"\b([A-Z0-9]{1,12}\.[A-Z]{1,5})\b", comment)
        if match:
            return match.group(1)
    return None


def _currency(row: dict[str, Any]) -> str | None:
    value = _first_text(row, "currency", "Currency", "curr", "c", "curr_c", "Waluta", "waluta")
    if value:
        normalized = value.strip().upper()
        if len(normalized) >= 3:
            return normalized[:3]
    amount_text = _first_text(row, "sum", "amount", "Kwota")
    if amount_text:
        match = re.search(r"\b(USD|EUR|PLN|GBP|CHF)\b", amount_text.upper())
        if match:
            return match.group(1)
    return None


def _record_id(row: dict[str, Any]) -> str | None:
    """Identyfikator rekordu z pol brokera.

    Literal agregacji powtarza sie w kazdym scalonym wierszu, wiec przyjety
    jako identyfikator sklejalby wszystkie te transakcje w jedna.
    """
    value = _first_text(
        row,
        "id",
        "trade_id",
        "transaction_id",
        "order_id",
        "trade_nb",
        "Operation ID",
        "Operacja №",
        "Numer",
        "raw_id",
    )
    if value is not None and is_aggregation_marker(value):
        return None
    return value


def _order_id(row: dict[str, Any]) -> str | None:
    return _first_text(row, "order_id", "Order ID", "order", "Numer zlecenia")


def _related_trade_id_from_comment(row: dict[str, Any]) -> str | None:
    comment = _first_text(row, "comment", "Komentarz", "description", "Opis", "details")
    if not comment:
        return None
    match = re.search(r"\(\s*Trade\s+([A-Za-z0-9_-]+)", comment, flags=re.IGNORECASE)
    if match:
        return match.group(1)
    match = re.search(r"\btrade\s*[:#]?\s*([0-9]{5,})\b", comment, flags=re.IGNORECASE)
    return match.group(1) if match else None


def _is_source_tax_row(row: dict[str, Any], text: str) -> bool:
    """Czy wiersz to podatek potracony u zrodla.

    Broker opisuje go zdaniem "Corporate action tax on security (...)", wiec samo
    slowo "corporate" wrzucalo go do kategorii zdarzen korporacyjnych. Ta jest
    oznaczana do przegladu i nie wchodzi do rozliczenia - potracony podatek
    przepadal wiec razem z nia, a to wlasnie on daje prawo do odliczenia od
    polskiego podatku od dywidendy.
    """
    type_id = str(row.get("type_id") or "").strip().lower()
    row_type = str(row.get("type") or "").strip().lower()
    if type_id == "tax" or row_type.startswith("podatk"):
        return True
    return "corporate action tax" in text or "withholding tax" in text


def _event_kind_from_row(source: BrokerStorageResolvedSource, section: str, row: dict[str, Any]) -> str:
    text = _text_blob(row)
    if source.detected_type == "fee_schedule_pdf":
        return "tariff_evidence"
    if source.detected_type == "nbp_archive":
        return "nbp_rate"
    if source.role == "analytics":
        return "analytics"
    if source.detected_type == "depositary_report_json":
        if "securities" in section.lower() or "flow" in section.lower():
            return "security_flow"
        return "position_snapshot"
    if _is_source_tax_row(row, text):
        return "tax"
    if section in {"corporate_actions"} or "corporate" in text:
        return "corporate_action"
    if section in {"securities_in_outs", "in_outs_securities", "securities_flows"}:
        if "stock_award" in text or "contest" in text or "award" in text:
            return "stock_award"
        if "maturity" in text or "redemption" in text:
            return "corporate_action"
        return "security_flow"
    if section == "commissions":
        return "commission"
    if source.detected_type == "cash_flows_xlsx" or section in {"cash_flows", "cash_in_outs"}:
        if "negative cash balance" in text or "interest" in text or "odset" in text:
            return "interest"
        if "commission" in text or "fee" in text or "prowiz" in text or "minimum for the order" in text:
            return "commission"
        if "dividend" in text or "dywidend" in text:
            return "dividend"
        if "fx" in text or "exchange" in text or "conversion" in text or "przewalut" in text:
            return "fx"
        return "cash_movement"
    if _operation(row) in {"BUY", "SELL"} or _ticker(row):
        return "trade"
    return "unknown"


def _source_rows(source: BrokerStorageResolvedSource, *, max_rows_per_source: int = 2000) -> list[tuple[dict[str, Any], str, str | None, str | None]]:
    path = Path(source.path)
    rows: list[tuple[dict[str, Any], str, str | None, str | None]] = []
    transaction_source = getattr(source, "role", None) in {"transaction_source", "transaction_report"}
    if not path.exists():
        return rows
    try:
        if source.detected_type in {
            "broker_report_json",
            "depositary_report_json",
            "legacy_broker_history_json",
            "local_broker_history_json",
            "json",
        }:
            payload = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(payload, dict):
                sections = source.sections or list(payload.keys())
                for section in sections:
                    raw_rows = _flatten_json_lists(payload.get(section))
                    for index, row in enumerate(raw_rows if transaction_source else raw_rows[:max_rows_per_source]):
                        rows.append((row, str(section), f"$.{section}[{index}]", None))
            else:
                raw_rows = _flatten_json_lists(payload)
                for index, row in enumerate(raw_rows if transaction_source else raw_rows[:max_rows_per_source]):
                    rows.append((row, "root", f"$[{index}]", None))
        elif source.detected_type in {"broker_transactions_xlsx", "cash_flows_xlsx", "traders_xlsx", "spreadsheet", "nbp_archive"} and path.suffix.lower() != ".csv":
            validate_spreadsheet_zip(path, max_uncompressed_bytes=MAX_SPREADSHEET_UNCOMPRESSED_BYTES)
            excel = pd.ExcelFile(path)
            remaining = MAX_SPREADSHEET_ROWS_PER_FILE
            for sheet_name in excel.sheet_names:
                frame = pd.read_excel(excel, sheet_name=sheet_name, nrows=remaining + 1)
                if len(frame) > remaining:
                    rows.clear()
                    raise ValueError(
                        f"SOURCE_INPUT_TOO_LARGE: {source.filename}: co najmniej {MAX_SPREADSHEET_ROWS_PER_FILE + 1} wierszy danych (limit {MAX_SPREADSHEET_ROWS_PER_FILE})."
                    )
                remaining -= len(frame)
                for index, row in enumerate(frame.to_dict("records")):
                    rows.append(({str(key): _json_safe(value) for key, value in row.items()}, sheet_name, str(index + 2), sheet_name))
            if source.detected_type in {"broker_transactions_xlsx", "cash_flows_xlsx"} and not rows:
                raise ValueError("Rozpoznane zrodlo transakcyjne nie zawiera wierszy danych.")
        elif source.detected_type in {"broker_transactions_xlsx", "cash_flows_xlsx", "nbp_archive"} and path.suffix.lower() == ".csv":
            # Archiwum NBP i eksporty transakcyjne mogą być w cp1250 oraz
            # używać średnika. `pd.read_csv` z domyslnymi ustawieniami
            # wywracalo sie najpierw na bajcie 0xb3, a po samej poprawce
            # kodowania - na separatorze ("Expected 1 fields, saw 33"). Plik
            # z kursami nie wchodzil wtedy do rozliczenia w ogole, a silnik
            # zglaszal luke pokrycia NBP dla USD i EUR.
            frame = None
            for kodowanie, separator in (("utf-8", ","), ("cp1250", ";"), ("utf-8", ";"), ("cp1250", ",")):
                try:
                    frame = pd.read_csv(path, encoding=kodowanie, sep=separator)
                except (UnicodeDecodeError, pd.errors.ParserError):
                    continue
                if len(frame.columns) > 1:
                    break
            if frame is None:
                raise ValueError(
                    "Nie rozpoznano kodowania ani separatora pliku CSV."
                )
            if source.detected_type in {"broker_transactions_xlsx", "cash_flows_xlsx"} and frame.empty:
                raise ValueError("Rozpoznane zrodlo transakcyjne nie zawiera wierszy danych.")
            for index, row in enumerate(frame.to_dict("records")):
                rows.append(({str(key): _json_safe(value) for key, value in row.items()}, "csv", str(index + 2), None))
        elif source.detected_type == "fee_schedule_pdf":
            rows.append(({"filename": source.filename, "comment": source.reason, "file_sha256": source.hash}, "pdf", "document", None))
    except Exception as exc:
        rows.append(({"error": str(exc), "filename": source.filename}, "read_error", "error", None))
    # Zrodla transakcyjne (rowniez JSON) musza wejsc w calosci do podatku.
    if transaction_source or source.detected_type in {"broker_transactions_xlsx", "cash_flows_xlsx", "traders_xlsx", "spreadsheet", "nbp_archive"}:
        return rows
    return rows[:max_rows_per_source]


def _kwota_prowizji(amounts: dict[str, Any]) -> Any:
    """Kwota prowizji z jedna kolejnoscia pierwszenstwa.

    Karta transakcji brala `commission` przed `amount`, a lista ruchow
    kosztowych zaczynala od `amount` - ta sama prowizja potrafila wystapic
    w dwoch roznych kwotach.
    """
    return amounts.get("commission") or amounts.get("amount") or amounts.get("gross")


def _stable_id(prefix: str, payload: Any) -> str:
    digest = sha256(json.dumps(_json_safe(payload), ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()[:16]
    return f"{prefix}:{digest}"


def _unrecognized_event(
    source: BrokerStorageResolvedSource,
    raw: Any,
    section: str,
    row_ref: str | None,
    sheet: str | None,
    error: str,
) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_NORMALIZED_EVENT,
        "event_id": _stable_id("event:unrecognized", [source.source_id, section, row_ref, raw, error]),
        "event_kind": "unknown",
        "source": {
            "file_sha256": source.hash,
            "source_id": source.source_id,
            "filename": source.filename,
            "relative_path": source.relative_path,
            "parser": source.detected_type,
            "sheet": sheet,
            "row": row_ref if sheet else None,
            "json_path": row_ref if row_ref and str(row_ref).startswith("$") else None,
            "section": section,
        },
        "identity": {
            "trade_id": None,
            "order_id": None,
            "transaction_id": None,
            "trade_nb": None,
            "related_trade_id": None,
        },
        "date": {
            "datetime": None,
            "trade_date": None,
            "settlement_date": None,
            "pay_date": None,
        },
        "instrument": {
            "ticker": None,
            "isin": None,
            "name": None,
            "type": None,
            "market": None,
        },
        "amounts": {
            "quantity": None,
            "price": None,
            "gross": None,
            "net": None,
            "amount": None,
            "commission": None,
            "currency": None,
            "commission_currency": None,
        },
        "raw": {
            "raw_payload": _json_safe(raw),
            "raw_comment": None,
            "raw_description": None,
            "unmapped_but_preserved": sorted(str(key) for key in raw.keys()) if isinstance(raw, dict) else [],
        },
        "ai": {
            "used": False,
            "model": None,
            "confidence": None,
            "notes": [],
        },
        "status": {
            "normalized": False,
            "status": "unrecognized",
            "needs_review": True,
            "errors": ["row_normalization_failed"],
            "warnings": [error],
        },
        "tax_active": False,
        "validation_errors": ["row_normalization_failed"],
    }


def sources_hitting_the_row_limit(
    sources: list[BrokerStorageResolvedSource],
    *,
    max_rows_per_source: int = 2000,
) -> list[dict[str, Any]]:
    """Zrodla, ktore dobily do limitu wierszy.

    Limit obcina po cichu, a milczaca utrata wierszy to najgorszy mozliwy blad
    w rozliczeniu podatkowym: wynik wyglada poprawnie i nic nie sygnalizuje, ze
    czesc transakcji nie weszla. Dzisiejsze pliki uzytkownika sa od limitu
    daleko (najwiekszy ma 840 wierszy), ale kolejny wyciag moze byc wiekszy.
    """
    hit: list[dict[str, Any]] = []
    for source in sources:
        if getattr(source, "role", None) in {"transaction_source", "transaction_report"} or getattr(source, "detected_type", None) in {"broker_transactions_xlsx", "cash_flows_xlsx", "traders_xlsx", "spreadsheet", "nbp_archive"}:
            # These tabular sources are now read in full, so the old per-source
            # cap does not apply and must not produce a false truncation warning.
            continue
        row_count = len(_source_rows(source, max_rows_per_source=max_rows_per_source))
        if row_count >= max_rows_per_source:
            hit.append({"filename": source.filename, "row_count": row_count, "limit": max_rows_per_source})
    return hit


def sources_that_failed_to_read(
    sources: list[BrokerStorageResolvedSource],
    *,
    max_rows_per_source: int = 2000,
    rows_cache: dict[str, list[tuple[dict[str, Any], str, str | None, str | None]]] | None = None,
) -> list[dict[str, Any]]:
    """Zrodla, ktorych nie dalo sie odczytac.

    Wyjatek przy czytaniu pliku konczyl jako jeden wiersz z sekcja
    "read_error" w tym samym strumieniu co dane. Nic tej sekcji dalej nie
    sprawdzalo, wiec rozliczenie powstawalo bez calego wyciagu i konczylo sie
    sukcesem - to ta sama cicha strata wierszy co obciecie limitem.
    """
    bledy: list[dict[str, Any]] = []
    for source in sources:
        source_rows = (rows_cache or {}).get(source.source_id)
        if source_rows is None:
            source_rows = _source_rows(source, max_rows_per_source=max_rows_per_source)
        for raw, section, _row_ref, _sheet in source_rows:
            if section == "read_error":
                bledy.append(
                    {
                        "filename": source.filename,
                        "error": str(raw.get("error") or ""),
                        "code": "SOURCE_INPUT_TOO_LARGE" if "SOURCE_INPUT_TOO_LARGE:" in str(raw.get("error") or "") else "SOURCE_INPUT_READ_FAILED",
                        "blocking": True,
                    }
                )
    return bledy


def build_normalized_events(
    sources: list[BrokerStorageResolvedSource],
    *,
    tax_year: int | None,
    max_rows_per_source: int = 2000,
    rows_cache: dict[str, list[tuple[dict[str, Any], str, str | None, str | None]]] | None = None,
) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for source in sources:
        source_rows = _source_rows(source, max_rows_per_source=max_rows_per_source)
        if rows_cache is not None:
            rows_cache[source.source_id] = source_rows
        # Jedna kolejnosc dat z ukosnikiem dla calego pliku. Sprzecznosc
        # (jedne daty DD/MM, drugie MM/DD) to blad odczytu pliku: ten sam wiersz
        # "read_error", co przy nieczytelnym pliku, wiec blokuje gotowosc.
        try:
            kolejnosc_dat = _file_date_order(source_rows)
        except ValueError as exc:
            kolejnosc_dat = None
            source_rows.append(({"error": str(exc), "filename": source.filename}, "read_error", "error", None))
        for raw, section, row_ref, sheet in source_rows:
            try:
                timestamp = _timestamp_from_row(raw, kolejnosc_dat)
                # FIFO potrzebuje nabyc z lat wczesniejszych: walor kupiony w
                # 2025 i sprzedany w 2026 musi miec swoja partie. Filtr rownosci
                # roku usuwal je zanim silnik cokolwiek zobaczyl, wiec sprzedaz
                # zostawala z zerowa podstawa kosztowa. Zawezenie do wybranego
                # roku robi pozniej sam silnik (_restrict_to_tax_year_horizon),
                # a koszty i wiersze rozliczenia maja wlasne filtry roczne.
                if tax_year is not None and timestamp is not None and timestamp.year > tax_year:
                    continue
                event_kind = _event_kind_from_row(source, section, raw)
                related_trade_id = _related_trade_id_from_comment(raw)
                event = {
                    "schema_version": SCHEMA_NORMALIZED_EVENT,
                    "event_id": _stable_id("event", [source.source_id, section, row_ref, raw]),
                    "event_kind": event_kind,
                    "source": {
                        "file_sha256": source.hash,
                        "source_id": source.source_id,
                        "filename": source.filename,
                        "relative_path": source.relative_path,
                        "parser": source.detected_type,
                        "sheet": sheet,
                        "row": row_ref if sheet else None,
                        "json_path": row_ref if row_ref and str(row_ref).startswith("$") else None,
                        "section": section,
                    },
                    "identity": {
                        "trade_id": _record_id(raw) if event_kind == "trade" else None,
                        "order_id": _order_id(raw),
                        "transaction_id": _first_text(raw, "transaction_id"),
                        "trade_nb": _first_text(raw, "trade_nb"),
                        "related_trade_id": related_trade_id,
                    },
                    "date": {
                        "datetime": timestamp.isoformat() if timestamp is not None else None,
                        "trade_date": _date_text(raw, "date", "short_date", "Execution time", "Data", "trade_d_exch", "exchange_time", order=kolejnosc_dat),
                        "settlement_date": _date_text(raw, "settlement_date", "Data rozliczenia", order=kolejnosc_dat),
                        "pay_date": _date_text(raw, "pay_d", order=kolejnosc_dat),
                    },
                    "instrument": {
                        "ticker": _ticker(raw),
                        "isin": _first_text(raw, "isin", "ISIN"),
                        "name": _first_text(raw, "instrument_name", "Instrument name", "instr_nm", "name"),
                        "type": _first_text(raw, "security_type", "instrument_type", "type"),
                        "market": _first_text(raw, "market", "Market"),
                    },
                    "amounts": {
                        "quantity": _json_safe(_first_decimal(raw, "q", "quantity", "Quantity", "qty", "Ilość", "Ilosc")),
                        "price": _json_safe(_first_decimal(raw, "p", "price", "Price", "Cena")),
                        "gross": _json_safe(_first_decimal(raw, "gross_amount", "v", "value", "Amount", "Kwota", "sum")),
                        "net": _json_safe(_first_decimal(raw, "net_amount", "net")),
                        "amount": _json_safe(_first_decimal(raw, "amount", "Amount", "Kwota", "sum", "v", "value")),
                        "commission": _json_safe(_first_decimal(raw, "commission", "Prowizja", "fee_amount")),
                        "currency": _currency(raw),
                        "commission_currency": _first_text(raw, "commission_currency"),
                    },
                    "raw": {
                        "raw_payload": _json_safe(raw),
                        "raw_comment": _first_text(raw, "comment", "Komentarz"),
                        "raw_description": _first_text(raw, "description", "Opis", "details"),
                        "unmapped_but_preserved": sorted(str(key) for key in raw.keys()) if isinstance(raw, dict) else [],
                    },
                    "ai": {
                        "used": False,
                        "model": None,
                        "confidence": None,
                        "notes": [],
                    },
                    "status": {
                        "normalized": event_kind != "unknown",
                        "status": "recognized" if event_kind != "unknown" else "unrecognized",
                        "needs_review": event_kind in {"unknown", "corporate_action", "stock_award"},
                        "errors": [],
                        "warnings": [] if event_kind != "unknown" else ["Nie rozpoznano typu zdarzenia deterministycznie."],
                    },
                    "tax_active": False,
                    "validation_errors": [],
                }
                # Silnik czyta daty z surowego wiersza, wiec kolejnosc ustalona
                # dla pliku musi tam dotrzec; DD/MM jest domyslne i bez znacznika.
                if kolejnosc_dat == "MDY" and isinstance(event["raw"]["raw_payload"], dict):
                    event["raw"]["raw_payload"]["kolejnosc_dat_pliku"] = kolejnosc_dat
                events.append(event)
            except Exception as exc:
                events.append(_unrecognized_event(source, raw, section, row_ref, sheet, str(exc)))
    return events


def _link_key(event: dict[str, Any]) -> str:
    identity = event.get("identity") or {}
    instrument = event.get("instrument") or {}
    date = event.get("date") or {}
    amounts = event.get("amounts") or {}
    event_kind = str(event.get("event_kind") or "")
    related = identity.get("related_trade_id")
    if related:
        return f"id:{related}"
    for key in ("trade_id", "order_id", "transaction_id", "trade_nb"):
        value = identity.get(key)
        if value:
            return f"id:{value}"
    if event_kind in {"position_snapshot", "security_flow"} and instrument.get("ticker"):
        return f"position:{instrument.get('ticker')}"
    fingerprint = [
        date.get("trade_date") or (str(date.get("datetime") or "")[:10]),
        event_kind,
        instrument.get("ticker") or instrument.get("isin") or "",
        amounts.get("quantity") or "",
        amounts.get("price") or "",
        amounts.get("gross") or amounts.get("amount") or "",
        amounts.get("currency") or "",
    ]
    return "fp:" + sha256(json.dumps(fingerprint, sort_keys=True).encode("utf-8")).hexdigest()[:16]


def link_events(events: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for event in events:
        groups[_link_key(event)].append(event)
    return dict(groups)


def _source_ref(event: dict[str, Any]) -> dict[str, Any]:
    source = event.get("source") or {}
    return {
        "source_file": source.get("filename"),
        "source_id": source.get("source_id"),
        "file_sha256": source.get("file_sha256"),
        "parser": source.get("parser"),
        "sheet": source.get("sheet"),
        "row": source.get("row"),
        "json_path": source.get("json_path"),
        "section": source.get("section"),
    }


def _field_source(event: dict[str, Any], value: Any, field_path: str) -> dict[str, Any]:
    return {
        **_source_ref(event),
        "field_path": field_path,
        "value": _json_safe(value),
        "confidence": 1.0,
        "source_kind": "deterministic",
    }


def _pick_core_event(events: list[dict[str, Any]]) -> dict[str, Any]:
    for event in events:
        if event.get("event_kind") == "trade":
            return event
    for event in events:
        if event.get("event_kind") not in {"tariff_evidence", "analytics"}:
            return event
    return events[0]


def _distinct_values(events: list[dict[str, Any]], getter) -> dict[str, list[dict[str, Any]]]:
    values: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for event in events:
        value = getter(event)
        if value is None or value == "":
            continue
        values[str(value)].append(event)
    return dict(values)


def detect_transaction_conflicts(groups: dict[str, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    conflicts: list[dict[str, Any]] = []
    field_getters = {
        "core_trade.price": lambda event: (event.get("amounts") or {}).get("price"),
        "core_trade.quantity": lambda event: (event.get("amounts") or {}).get("quantity"),
        "core_trade.gross_amount": lambda event: (event.get("amounts") or {}).get("gross") or (event.get("amounts") or {}).get("amount"),
        "core_trade.trade_currency": lambda event: (event.get("amounts") or {}).get("currency"),
        "core_trade.trade_date": lambda event: (event.get("date") or {}).get("trade_date"),
    }
    for group_key, events in groups.items():
        if len(events) < 2:
            continue
        trade_events = [event for event in events if event.get("event_kind") == "trade"]
        if len(trade_events) < 2:
            continue
        for field, getter in field_getters.items():
            values = _distinct_values(trade_events, getter)
            if len(values) <= 1:
                continue
            conflicts.append(
                {
                    "conflict_id": _stable_id("conflict", [group_key, field, sorted(values.keys())]),
                    "canonical_transaction_key": group_key,
                    "field": field,
                    "severity": "warning",
                    "values": [
                        {
                            "value": value,
                            "sources": [_source_ref(event) for event in source_events],
                        }
                        for value, source_events in sorted(values.items())
                    ],
                    "message": f"Rozne wartosci pola {field} dla tej samej transakcji.",
                }
            )
    return conflicts


def build_transaction_dossiers(events: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, Any], list[dict[str, Any]]]:
    groups = link_events(events)
    conflicts = detect_transaction_conflicts(groups)
    conflicts_by_key: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for conflict in conflicts:
        conflicts_by_key[str(conflict.get("canonical_transaction_key"))].append(conflict)

    dossiers: list[dict[str, Any]] = []
    field_source_map: dict[str, Any] = {}
    for group_key, grouped_events in groups.items():
        core = _pick_core_event(grouped_events)
        amounts = core.get("amounts") or {}
        instrument = core.get("instrument") or {}
        identity = core.get("identity") or {}
        date = core.get("date") or {}
        event_kind = str(core.get("event_kind") or "unknown")
        operation = _operation((core.get("raw") or {}).get("raw_payload") or {}) or {
            "trade": "UNKNOWN",
            "commission": "FEE",
            "cash_movement": "TRANSFER",
            "fx": "FX",
            "dividend": "DIVIDEND",
            "interest": "INTEREST",
            "stock_award": "STOCK_AWARD",
            "corporate_action": "MATURITY",
        }.get(event_kind, "UNKNOWN")

        dossier_id = _stable_id("dossier", group_key)
        field_sources: dict[str, list[dict[str, Any]]] = defaultdict(list)

        def set_field(field_path: str, value: Any, source_event: dict[str, Any]) -> Any:
            if value is not None and value != "":
                field_sources[field_path].append(_field_source(source_event, value, field_path))
            return value

        commission_events = [event for event in grouped_events if event.get("event_kind") == "commission"]
        cash_events = [event for event in grouped_events if event.get("event_kind") in {"cash_movement", "fx", "interest", "dividend"}]
        position_events = [event for event in grouped_events if event.get("event_kind") in {"position_snapshot", "security_flow"}]
        evidence_events = [event for event in grouped_events if event.get("event_kind") in {"tariff_evidence", "analytics"}]
        review_reasons: list[str] = []
        if event_kind in {"stock_award", "corporate_action", "unknown"}:
            review_reasons.append(f"Zdarzenie {event_kind} wymaga kontroli przed wplywem na PIT.")
        if conflicts_by_key.get(group_key):
            review_reasons.append("Wykryto konflikt danych miedzy zrodlami.")

        first_commission = commission_events[0] if commission_events else None
        first_commission_amount = None
        first_commission_currency = None
        if first_commission:
            first_amounts = first_commission.get("amounts") or {}
            first_commission_amount = _kwota_prowizji(first_amounts)
            first_commission_currency = first_amounts.get("commission_currency") or first_amounts.get("currency")

        dossier = {
            "schema_version": SCHEMA_TRANSACTION_DOSSIER,
            "canonical_transaction_id": dossier_id,
            "identity": {
                "primary_trade_id": identity.get("trade_id") or identity.get("transaction_id") or identity.get("order_id") or group_key.removeprefix("id:"),
                "broker_trade_id": identity.get("trade_id"),
                "order_id": identity.get("order_id"),
                "transaction_id": identity.get("transaction_id"),
                "trade_nb": identity.get("trade_nb"),
                "source_ids": sorted({str((event.get("source") or {}).get("source_id")) for event in grouped_events if (event.get("source") or {}).get("source_id")}),
                "dedupe_fingerprint": group_key,
            },
            "core_trade": {
                "operation": operation,
                "date_time": set_field("core_trade.date_time", date.get("datetime"), core),
                "trade_date": set_field("core_trade.trade_date", date.get("trade_date"), core),
                "settlement_date": set_field("core_trade.settlement_date", date.get("settlement_date"), core),
                "ticker": set_field("core_trade.ticker", instrument.get("ticker"), core),
                "isin": set_field("core_trade.isin", instrument.get("isin"), core),
                "instrument_name": set_field("core_trade.instrument_name", instrument.get("name"), core),
                "instrument_type": instrument.get("type") or ("stock_award" if event_kind == "stock_award" else "unknown"),
                "market": set_field("core_trade.market", instrument.get("market"), core),
                "quantity": set_field("core_trade.quantity", amounts.get("quantity"), core),
                "price": set_field("core_trade.price", amounts.get("price"), core),
                "gross_amount": set_field("core_trade.gross_amount", amounts.get("gross") or amounts.get("amount"), core),
                "net_amount": set_field("core_trade.net_amount", amounts.get("net"), core),
                "trade_currency": set_field("core_trade.trade_currency", amounts.get("currency"), core),
            },
            "fees_and_costs": {
                "broker_commission": {
                    "amount": set_field("fees_and_costs.broker_commission.amount", first_commission_amount, first_commission) if first_commission else None,
                    "currency": set_field("fees_and_costs.broker_commission.currency", first_commission_currency, first_commission) if first_commission else None,
                    "source": (first_commission.get("source") or {}).get("filename") if first_commission else None,
                    "linked_cash_movement_id": (first_commission.get("event_id") if first_commission else None),
                },
                "cash_movement_fees": [_source_ref(event) | {"amount": _kwota_prowizji(event.get("amounts") or {})} for event in commission_events],
                "negative_balance_interest": [_source_ref(event) | {"amount": (event.get("amounts") or {}).get("amount")} for event in grouped_events if event.get("event_kind") == "interest"],
                "transfer_fees": [],
                "fx_spread_cost_candidates": [],
                "tariff_evidence": [_source_ref(event) for event in evidence_events if event.get("event_kind") == "tariff_evidence"],
            },
            "cash_context": {
                "related_cash_movements": [_source_ref(event) | {"event_kind": event.get("event_kind"), "amount": (event.get("amounts") or {}).get("amount")} for event in cash_events],
                "account_balance_before": None,
                "account_balance_after": None,
                "funding_source": "unknown",
                "margin_or_negative_balance_detected": any(event.get("event_kind") == "interest" for event in grouped_events),
                "margin_context": [_source_ref(event) for event in grouped_events if event.get("event_kind") == "interest"],
            },
            "fx_context": {
                "trade_currency": amounts.get("currency"),
                "commission_currency": first_commission_currency,
                "base_currency": "PLN",
                "explicit_fx_transactions": [_source_ref(event) for event in grouped_events if event.get("event_kind") == "fx"],
                "nbp_rate_trade": None,
                "nbp_rate_commission": None,
                "nbp_rate_fee": None,
                "fx_warnings": [],
            },
            "tax_context": {
                "tax_year": int(str(date.get("trade_date") or date.get("datetime") or "0")[:4]) if str(date.get("trade_date") or date.get("datetime") or "")[:4].isdigit() else None,
                "is_transaction_record": event_kind == "trade",
                "tax_event_type": {
                    "BUY": "purchase",
                    "SELL": "sale",
                    "FEE": "fee",
                    "INTEREST": "interest",
                    "DIVIDEND": "dividend",
                    "STOCK_AWARD": "stock_award",
                    "MATURITY": "maturity",
                }.get(operation, "non_tax_context"),
                "nbp_required": event_kind == "trade" and amounts.get("currency") not in {None, "PLN"},
                "nbp_status": "not_required",
                "fifo_lot_links": [],
                "cost_basis_components": [],
                "revenue_components": [],
                "tax_warnings": [],
            },
            "position_context": {
                "position_before": None,
                "position_after": None,
                "depository_quantity_start": None,
                "depository_quantity_end": None,
                "reconciliation_status": "unknown" if not position_events else "warning",
                "reconciliation_notes": [_source_ref(event) for event in position_events],
            },
            "comments_and_descriptions": {
                "broker_comments": [
                    comment
                    for comment in ((event.get("raw") or {}).get("raw_comment") for event in grouped_events)
                    if comment
                ],
                "cash_movement_comments": [
                    comment
                    for event in cash_events
                    for comment in [(event.get("raw") or {}).get("raw_comment")]
                    if comment
                ],
                "pdf_evidence_comments": [
                    comment
                    for event in evidence_events
                    for comment in [(event.get("raw") or {}).get("raw_comment")]
                    if comment
                ],
                "ai_extracted_summary": None,
                "user_notes": [],
                "system_notes": [],
            },
            "lineage": {
                "source_files": sorted({str((event.get("source") or {}).get("filename")) for event in grouped_events if (event.get("source") or {}).get("filename")}),
                "raw_records": [_source_ref(event) | {"event_id": event.get("event_id"), "event_kind": event.get("event_kind")} for event in grouped_events],
                "field_sources": {},
                "ai_assisted_fields": [],
                "conflicts": conflicts_by_key.get(group_key, []),
            },
            "confidence": {
                "overall": 0.95 if not review_reasons else 0.75,
                "identity_match": 1.0 if group_key.startswith("id:") else 0.75,
                "amount_match": 0.5 if conflicts_by_key.get(group_key) else 1.0,
                "date_match": 0.5 if any(conflict.get("field") == "core_trade.trade_date" for conflict in conflicts_by_key.get(group_key, [])) else 1.0,
                "fee_match": 1.0 if commission_events else 0.0,
                "nbp_match": 0.0,
            },
            "review": {
                "needs_user_review": bool(review_reasons),
                "review_reasons": review_reasons,
                "safe_for_tax_engine": event_kind == "trade" and not review_reasons,
            },
        }
        dossier["lineage"]["field_sources"] = {key: value for key, value in field_sources.items()}
        field_source_map[dossier_id] = dossier["lineage"]["field_sources"]
        dossiers.append(dossier)

    return dossiers, field_source_map, conflicts


def _ai_source_ids(events: list[dict[str, Any]], ai_context: list[dict[str, Any]]) -> set[str]:
    source_by_event_id = {
        str(event.get("event_id")): str((event.get("source") or {}).get("source_id") or "")
        for event in events
    }
    return {
        source_id
        for context in ai_context
        for source_id in [source_by_event_id.get(str(context.get("source_event_id")))]
        if source_id
    }


def build_source_registry(
    sources: list[BrokerStorageResolvedSource],
    events: list[dict[str, Any]],
    dossiers: list[dict[str, Any]],
    *,
    ai_context: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    events_by_source: dict[str, list[dict[str, Any]]] = defaultdict(list)
    dossiers_by_source: dict[str, set[str]] = defaultdict(set)
    ai_used_source_ids = _ai_source_ids(events, ai_context or [])
    for event in events:
        source_id = str((event.get("source") or {}).get("source_id") or "")
        if source_id:
            events_by_source[source_id].append(event)
    for dossier in dossiers:
        dossier_id = str(dossier.get("canonical_transaction_id") or "")
        for source_id in (dossier.get("identity") or {}).get("source_ids") or []:
            dossiers_by_source[str(source_id)].add(dossier_id)

    registry: list[dict[str, Any]] = []
    for source in sources:
        source_events = events_by_source.get(source.source_id, [])
        used_count = sum(1 for event in source_events if event.get("event_kind") not in {"unknown", "analytics", "tariff_evidence"})
        review_count = sum(1 for event in source_events if (event.get("status") or {}).get("needs_review"))
        import_status = _source_import_status(source, source_events)
        recognition_status = _source_recognition_status(source, source_events)
        registry.append(
            {
                "source_id": source.source_id,
                "filename": source.filename,
                "relative_path": source.relative_path,
                "file_sha256": source.hash,
                "detected_type": source.detected_type,
                "source_role": source.role,
                "parser": source.detected_type,
                "record_count": len(source_events),
                "used_record_count": used_count,
                "rejected_record_count": 0,
                "context_record_count": len(source_events) - used_count,
                "needs_review_count": review_count,
                "ollama_used": source.source_id in ai_used_source_ids,
                "import_status": import_status,
                "recognition_status": recognition_status,
                "enriched_dossier_ids": sorted(dossiers_by_source.get(source.source_id, set())),
                "reason": source.reason,
                "warnings": list(source.warnings),
                "errors": list(source.errors),
            }
        )
    return registry


def build_evidence_index(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    evidence: list[dict[str, Any]] = []
    for event in events:
        if event.get("event_kind") not in {"tariff_evidence", "analytics"}:
            continue
        source = event.get("source") or {}
        evidence.append(
            {
                "evidence_id": _stable_id("evidence", [event.get("event_id"), source.get("filename")]),
                "filename": source.get("filename"),
                "file_sha256": source.get("file_sha256"),
                "evidence_kind": "tariff_pdf" if event.get("event_kind") == "tariff_evidence" else "analytics",
                "status": "available",
                "linked_dossier_ids": [],
                "summary": (event.get("raw") or {}).get("raw_comment") or (event.get("raw") or {}).get("raw_description"),
            }
        )
    return evidence


def _source_import_status(source: BrokerStorageResolvedSource, events: list[dict[str, Any]]) -> str:
    if not Path(source.path).exists():
        return "unreadable"
    if source.detected_type in {"json_unreadable"}:
        return "accepted_with_notes"
    if source.errors or source.warnings or not events:
        return "accepted_with_notes"
    return "accepted"


def _source_recognition_status(source: BrokerStorageResolvedSource, events: list[dict[str, Any]]) -> str:
    if source.detected_type in {"json_unreadable", "unknown"}:
        return "needs_mapping"
    if not events:
        return "needs_mapping"
    unknown_count = sum(1 for event in events if event.get("event_kind") == "unknown")
    review_count = sum(1 for event in events if (event.get("status") or {}).get("needs_review"))
    if unknown_count == len(events):
        return "needs_mapping"
    if unknown_count or review_count or source.warnings or source.errors:
        return "partially_recognized"
    return "recognized"


def build_column_mappings(
    sources: list[BrokerStorageResolvedSource],
    events: list[dict[str, Any]],
    *,
    enabled: bool = False,
    client: Any | None = None,
) -> list[dict[str, Any]]:
    spreadsheet_source_ids = {
        source.source_id
        for source in sources
        if source.detected_type in {"broker_transactions_xlsx", "cash_flows_xlsx", "traders_xlsx", "spreadsheet"}
    }
    grouped: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for event in events:
        source = event.get("source") or {}
        source_id = str(source.get("source_id") or "")
        if source_id not in spreadsheet_source_ids:
            continue
        sheet_name = str(source.get("sheet") or source.get("section") or "sheet")
        grouped[(source_id, sheet_name)].append(event)

    source_by_id = {source.source_id: source for source in sources}
    mappings: list[dict[str, Any]] = []
    for (source_id, sheet_name), source_events in grouped.items():
        first_payload = (source_events[0].get("raw") or {}).get("raw_payload") or {}
        if not isinstance(first_payload, dict):
            continue
        headers = [str(header) for header in first_payload.keys()]
        source = source_by_id[source_id]
        deterministic = deterministic_column_mapping(
            file_sha256=source.hash,
            sheet_name=sheet_name,
            headers=headers,
        )
        deterministic["source_id"] = source_id
        deterministic["filename"] = source.filename
        should_use_ai = enabled and client is not None and deterministic["confidence"] < 0.8
        if not should_use_ai:
            mappings.append(deterministic)
            continue
        try:
            ai_mapping = map_columns_with_ai(
                file_sha256=source.hash,
                sheet_name=sheet_name,
                headers=headers,
                sample_rows=[
                    (event.get("raw") or {}).get("raw_payload") or {}
                    for event in source_events[:5]
                    if isinstance((event.get("raw") or {}).get("raw_payload"), dict)
                ],
                client=client,
            )
            ai_mapping["source_id"] = source_id
            ai_mapping["filename"] = source.filename
            mappings.append(ai_mapping)
        except Exception as exc:
            deterministic["validation_status"] = "ai_unavailable"
            deterministic["mapping_method"] = "deterministic_ai_unavailable"
            deterministic["warnings"] = [*deterministic["warnings"], str(exc)]
            mappings.append(deterministic)
    return mappings


def build_ai_validation_report(
    *,
    classifications: list[dict[str, Any]],
    column_mappings: list[dict[str, Any]],
    ai_context: list[dict[str, Any]],
    ai_enabled: bool,
) -> dict[str, Any]:
    def count_status(rows: list[dict[str, Any]]) -> dict[str, int]:
        counts: dict[str, int] = defaultdict(int)
        for row in rows:
            counts[str(row.get("validation_status") or "unknown")] += 1
        return dict(counts)

    rejected_context = [
        context
        for context in ai_context
        if str(context.get("validation_status") or "").startswith("rejected")
        or context.get("validation_status") == "unavailable"
    ]
    return {
        "schema_version": "ai.validation_report.v1",
        "enabled": ai_enabled,
        "safe_tax_policy": {
            "allow_ai_to_promote_to_pit": False,
            "ai_changes_annual_summary": False,
            "ai_changes_audit_hash": False,
            "requires_deterministic_revalidation": True,
        },
        "document_classification": {
            "total": len(classifications),
            "status_counts": count_status(classifications),
            "ai_used": sum(1 for item in classifications if item.get("classification_method") == "ollama"),
            "needs_user_review": sum(1 for item in classifications if item.get("needs_user_review")),
        },
        "column_mapping": {
            "total": len(column_mappings),
            "status_counts": count_status(column_mappings),
            "ai_used": sum(1 for item in column_mappings if item.get("mapping_method") == "ollama"),
            "needs_user_review": sum(1 for item in column_mappings if item.get("needs_user_review")),
        },
        "extracted_context": {
            "total": len(ai_context),
            "status_counts": count_status(ai_context),
            "accepted": sum(1 for item in ai_context if item.get("validation_status") == "accepted"),
            "rejected_or_unavailable": len(rejected_context),
        },
        "rejected_examples": rejected_context[:20],
    }


def _manifest_entry(
    source: BrokerStorageResolvedSource,
    events: list[dict[str, Any]],
    *,
    ai_context: list[dict[str, Any]] | None = None,
    ai_enabled: bool = False,
) -> dict[str, Any]:
    source_events = [
        event for event in events if (event.get("source") or {}).get("source_id") == source.source_id
    ]
    source_event_ids = {str(event.get("event_id")) for event in source_events}
    source_ai_context = [
        context for context in (ai_context or []) if str(context.get("source_event_id")) in source_event_ids
    ]
    accepted_ai = [context for context in source_ai_context if context.get("validation_status") == "accepted"]
    unavailable_ai = [context for context in source_ai_context if context.get("validation_status") == "unavailable"]
    rejected_ai = [
        context for context in source_ai_context if str(context.get("validation_status") or "").startswith("rejected")
    ]
    final_role_by_detected_type = {
        "nbp_archive": "nbp_rates",
        "depositary_report_json": "position_reconciliation",
        "fee_schedule_pdf": "evidence",
        "traders_xlsx": "analytics",
        "cash_flows_xlsx": "cash_context",
        "broker_transactions_xlsx": "transaction_source",
    }
    final_role_by_source_role = {
        "baseline_tax": "transaction_source",
        "baseline_support": "cash_context",
        "candidate_tax": "transaction_source",
        "supplemental": "cash_context",
        "reconciliation": "position_reconciliation",
        "analytics": "analytics",
        "evidence": "evidence",
    }
    if not ai_enabled:
        ai_status = "disabled"
    elif source_ai_context and unavailable_ai:
        ai_status = "unavailable"
    elif source_ai_context:
        ai_status = "used"
    else:
        ai_status = "not_needed"
    import_status = _source_import_status(source, source_events)
    recognition_status = _source_recognition_status(source, source_events)
    return {
        "file_sha256": source.hash,
        "original_filename": source.filename,
        "stored_path": source.relative_path,
        "imported_at": None,
        "mime_type": source.detected_type,
        "size_bytes": Path(source.path).stat().st_size if Path(source.path).exists() else 0,
        "deterministic_parser": {
            "parser_name": source.detected_type,
            "status": "parsed" if source_events else "not_supported",
            "records_count": len(source_events),
            "warnings": list(source.warnings),
            "errors": list(source.errors),
        },
        "ai_normalizer": {
            "enabled": ai_enabled,
            "provider": "ollama",
            "model": next((context.get("ai_model") for context in source_ai_context if context.get("ai_model")), None),
            "status": ai_status,
            "classification_status": "ok" if source_ai_context else "skipped",
            "candidate_records_count": len(source_ai_context),
            "validated_records_count": len(accepted_ai),
            "promoted_records_count": 0,
            "needs_user_review_count": sum(1 for context in source_ai_context if context.get("needs_user_review")),
            "warnings": [
                warning
                for context in source_ai_context
                for warning in (context.get("warnings") or [])
            ],
            "errors": [context.get("summary_pl") for context in unavailable_ai + rejected_ai if context.get("summary_pl")],
        },
        "final_role": final_role_by_detected_type.get(
            source.detected_type,
            final_role_by_source_role.get(source.role, "unknown"),
        ),
        "final_status": "accepted_with_notes" if import_status == "accepted_with_notes" else import_status,
        "import_status": import_status,
        "recognition_status": recognition_status,
        "reason": source.reason,
    }


def _event_status_needs_review(event: dict[str, Any]) -> bool:
    return bool((event.get("status") or {}).get("needs_review"))


def _event_raw_payload(event: dict[str, Any]) -> dict[str, Any]:
    raw = event.get("raw") or {}
    payload = raw.get("raw_payload") if isinstance(raw, dict) else {}
    return payload if isinstance(payload, dict) else {}


def _event_source_id(event: dict[str, Any]) -> str:
    source = event.get("source") or {}
    return str(source.get("source_id") or "") if isinstance(source, dict) else ""


def _event_source_status(event: dict[str, Any], source_status_by_id: dict[str, dict[str, Any]]) -> dict[str, Any]:
    return source_status_by_id.get(_event_source_id(event), {})


def _event_source_type(event: dict[str, Any], source_status_by_id: dict[str, dict[str, Any]]) -> str:
    source_status = _event_source_status(event, source_status_by_id)
    if source_status.get("detected_type"):
        return str(source_status.get("detected_type") or "")
    source = event.get("source") or {}
    return str(source.get("parser") or "") if isinstance(source, dict) else ""


def _has_text(value: Any) -> bool:
    return value is not None and str(value).strip() not in {"", "None", "nan", "NaN"}


def _numeric_value(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _is_non_zero(value: Any) -> bool:
    number = _numeric_value(value)
    return number is not None and number != 0


def _event_currency(event: dict[str, Any]) -> str:
    amounts = event.get("amounts") or {}
    return str(amounts.get("currency") or "").strip().upper()


def _event_operation(event: dict[str, Any]) -> str | None:
    return _operation(_event_raw_payload(event))


def _engine_record_validation_errors(event: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if not isinstance(event, dict):
        return ["invalid_event"]
    if event.get("event_kind") != "trade":
        return ["not_calculation_record"]
    if _event_status_needs_review(event):
        errors.append("event_marked_needs_review")

    date = event.get("date") or {}
    instrument = event.get("instrument") or {}
    amounts = event.get("amounts") or {}
    operation = _event_operation(event)
    currency = _event_currency(event)

    if operation not in {"BUY", "SELL"}:
        errors.append("missing_buy_sell_operation")
    if not any(_has_text(date.get(key)) for key in ("datetime", "trade_date", "settlement_date", "pay_date")):
        errors.append("missing_tax_event_date")
    if not any(_has_text(instrument.get(key)) for key in ("ticker", "isin", "name")):
        errors.append("missing_instrument")
    if not _is_non_zero(amounts.get("quantity")):
        errors.append("missing_or_zero_quantity")
    if currency in {"", "UNKNOWN"}:
        errors.append("missing_currency")
    if not any(_is_non_zero(amounts.get(key)) for key in ("price", "gross", "net", "amount")):
        errors.append("missing_price_or_amount")
    return errors


def _tag_canonical_record(event: dict[str, Any], record_status: str, validation_errors: list[str] | None = None) -> dict[str, Any]:
    tagged = dict(event)
    status = dict(tagged.get("status") or {})
    existing_errors = list(status.get("errors") or [])
    errors = list(dict.fromkeys([*existing_errors, *(validation_errors or [])]))
    status["status"] = record_status
    status["errors"] = errors
    status["needs_review"] = record_status == "incomplete" or bool(status.get("needs_review"))
    tagged["status"] = status
    tagged["validation_errors"] = errors
    tagged["canonical_record_status"] = record_status
    safe = _json_safe(tagged)
    return safe if isinstance(safe, dict) else tagged


def _is_engine_ready_event(event: dict[str, Any]) -> bool:
    return not _engine_record_validation_errors(event)


def _build_canonical_tax_input_impl(payload: dict[str, Any]) -> dict[str, Any]:
    canonical_history = payload.get("canonical_storage_history") or []
    normalized_events = payload.get("normalized_events") or []
    dossiers = payload.get("transaction_dossiers") or []
    source_registry = payload.get("source_registry") or []
    manifest = payload.get("normalized_storage_manifest") or []
    conflicts = payload.get("transaction_conflicts") or []
    evidence = payload.get("evidence_index") or []
    ai_context = payload.get("ai_extracted_context") or []
    lineage_index = payload.get("storage_lineage_index") or {}

    dossier_index = {
        str(dossier.get("canonical_transaction_id")): dossier
        for dossier in dossiers
        if isinstance(dossier, dict) and dossier.get("canonical_transaction_id")
    }
    source_statuses = [
        {
            "source_id": source.get("source_id"),
            "filename": source.get("filename"),
            "file_sha256": source.get("file_sha256"),
            "source_role": source.get("source_role"),
            "detected_type": source.get("detected_type"),
            "import_status": source.get("import_status", "accepted"),
            "recognition_status": source.get("recognition_status", "recognized"),
            "reason": source.get("reason"),
        }
        for source in source_registry
        if isinstance(source, dict)
    ]
    records: list[dict[str, Any]] = []
    for event in normalized_events:
        if not isinstance(event, dict):
            records.append(
                {
                    "canonical_record_status": "unrecognized",
                    "status": {"status": "unrecognized", "errors": ["invalid_event_object"], "needs_review": True},
                    "validation_errors": ["invalid_event_object"],
                    "raw": {"raw_payload": _json_safe(event)},
                }
            )
            continue
        event_kind = str(event.get("event_kind") or "unknown")
        status = event.get("status") or {}
        if event_kind == "unknown" or status.get("normalized") is False:
            records.append(_tag_canonical_record(event, "unrecognized", ["unrecognized_event"]))
            continue
        validation_errors = _engine_record_validation_errors(event)
        if _is_engine_ready_event(event):
            records.append(_tag_canonical_record(event, "ready"))
        elif event_kind == "trade" or _event_status_needs_review(event):
            records.append(_tag_canonical_record(event, "incomplete", validation_errors))
        else:
            records.append(_tag_canonical_record(event, "informational", validation_errors))
    ai_candidates = [
        {
            **context,
            "canonical_record_status": "ai_context",
            "ai_policy": "AI output is stored as context and mapped data. The engine adapter consumes only complete deterministic records.",
        }
        for context in ai_context
        if isinstance(context, dict)
    ]
    tax_input = {
        "schema_version": SCHEMA_CANONICAL_TAX_INPUT,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "data_policy": {
            "single_record_stream": True,
            "import_is_permissive": True,
            "ai_output_is_contextual": True,
            "adapter_selects_complete_records": True,
            "technical_storage_sandbox_required": True,
            "calculation_record_validator": {
                "required_for_buy_sell": [
                    "date",
                    "BUY_OR_SELL",
                    "ticker_or_isin_or_instrument",
                    "quantity_non_zero",
                    "currency",
                    "price_or_amount",
                ],
            },
        },
        "engine_contract": {
            "input_file": "canonical_tax_input.json",
            "record_path": "records",
            "ai_candidate_path": "records.ai_candidates",
            "engine_adapter": "selects_complete_buy_sell_records",
            "legacy_fallback": False,
        },
        "records": records,
        "canonical_history_rows": canonical_history,
        "transaction_dossiers": list(dossier_index.values()),
        "ai_candidates": ai_candidates,
        "sources": {
            "registry": source_registry,
            "manifest": manifest,
            "statuses": source_statuses,
        },
        "lineage": {
            "storage_lineage_index": lineage_index,
            "field_source_map": payload.get("field_source_map") or {},
        },
        "review": {
            "conflicts": conflicts,
            "evidence_index": evidence,
            "needs_review_dossier_ids": [
                dossier_id
                for dossier_id, dossier in dossier_index.items()
                if (dossier.get("review") or {}).get("needs_user_review")
            ],
        },
    }
    tax_input["summary"] = build_canonical_tax_input_summary(tax_input)
    return tax_input


def build_canonical_tax_input(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        return _build_canonical_tax_input_impl(payload if isinstance(payload, dict) else {})
    except Exception as exc:
        tax_input = {
            "schema_version": SCHEMA_CANONICAL_TAX_INPUT,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "data_policy": {
                "single_record_stream": True,
                "import_is_permissive": True,
                "build_errors_are_non_blocking": True,
            },
            "engine_contract": {
                "input_file": "canonical_tax_input.json",
                "record_path": "records",
                "engine_adapter": "selects_complete_buy_sell_records",
                "legacy_fallback": False,
            },
            "records": [
                {
                    "canonical_record_status": "unrecognized",
                    "status": {"status": "unrecognized", "errors": ["canonical_tax_input_build_failed"], "needs_review": True},
                    "validation_errors": ["canonical_tax_input_build_failed"],
                    "raw": {"raw_payload": {"error": str(exc)}},
                }
            ],
            "canonical_history_rows": [],
            "transaction_dossiers": [],
            "ai_candidates": [],
            "sources": {"registry": [], "manifest": [], "statuses": []},
            "lineage": {"storage_lineage_index": {}, "field_source_map": {}},
            "review": {
                "conflicts": [],
                "evidence_index": [],
                "needs_review_dossier_ids": [],
                "build_errors": [str(exc)],
            },
        }
        tax_input["summary"] = build_canonical_tax_input_summary(tax_input)
        return tax_input


def build_canonical_tax_input_summary(tax_input: dict[str, Any]) -> dict[str, Any]:
    records = tax_input.get("records") or []
    record_list = records if isinstance(records, list) else []
    review = tax_input.get("review") or {}
    sources = tax_input.get("sources") or {}
    source_statuses = sources.get("statuses") or []
    status_counts: dict[str, int] = defaultdict(int)
    incomplete_by_source: dict[str, dict[str, Any]] = {}
    unknown_operation_records: list[dict[str, Any]] = []
    blocking_incomplete_count = 0
    for record in record_list:
        if isinstance(record, dict):
            record_status = str(record.get("canonical_record_status") or (record.get("status") or {}).get("status") or "unknown")
            status_counts[record_status] += 1
            if record_status == "incomplete":
                source = record.get("source") or {}
                filename = str(source.get("filename") or "unknown")
                group = incomplete_by_source.setdefault(filename, {"filename": filename, "count": 0, "reasons": {}, "blocking_count": 0})
                group["count"] += 1
                reasons = [str(reason) for reason in record.get("validation_errors") or []] or ["unknown"]
                # Kolejnosc pierwszego wystapienia, nie iteracji po zbiorze: kolejnosc
                # w set() zalezy od losowego ziarna haszowania, wiec raport roznil sie
                # miedzy przebiegami kolejnoscia kluczy przy tych samych danych.
                for reason in dict.fromkeys(reasons):
                    group["reasons"][reason] = group["reasons"].get(reason, 0) + 1
                instrument = record.get("instrument") or {}
                amounts = record.get("amounts") or {}
                has_instrument = any(_has_text(instrument.get(key)) for key in ("ticker", "isin", "name"))
                operation = _event_operation(record)
                quantity = _numeric_value(amounts.get("quantity"))
                incomplete_trade = (
                    operation in {"BUY", "SELL"}
                    and quantity is not None and quantity > 0
                    and bool(set(reasons) & {"missing_tax_event_date", "missing_price_or_amount", "missing_currency"})
                )
                raw_payload = _event_raw_payload(record)
                raw_operation_code = operation_code(raw_payload)
                # Tylko rekordy rozpoznane jako transakcja. Akcje przyznane,
                # zdarzenia korporacyjne i ruchy papierow maja kod operacji
                # spoza kupna/sprzedazy (stock_award, maturity) i trafiaja do
                # decyzji w przegladzie; blokada tutaj dublowala tamta i nie dalo
                # sie jej zdjac zadna decyzja (prawdziwy magazyn: 13 rekordow).
                unknown_side_trade = (
                    record.get("event_kind") == "trade"
                    and operation not in {"BUY", "SELL"}
                    and quantity is not None and quantity != 0
                    and (
                        set(reasons) == {"missing_buy_sell_operation"}
                        or bool(raw_operation_code)
                    )
                )
                if has_instrument and (incomplete_trade or unknown_side_trade):
                    blocking_incomplete_count += 1
                    group["blocking_count"] += 1
                    if unknown_side_trade:
                        source = record.get("source") or {}
                        identity = record.get("identity") or {}
                        unknown_operation_records.append({
                            "source": str(source.get("filename") or "unknown"),
                            "record_id": str(
                                record.get("event_id")
                                or identity.get("trade_id")
                                or identity.get("transaction_id")
                                or "unknown"
                            ),
                            "operation_code": raw_operation_code,
                            "ticker": str(instrument.get("ticker") or instrument.get("isin") or ""),
                            "quantity": str(amounts.get("quantity") or ""),
                        })
    return {
        "schema_version": "canonical_tax_input_summary.v2",
        "engineInputMode": "required",
        "recordCount": len(record_list),
        "engineReadyRecordCount": status_counts.get("ready", 0),
        "incompleteRecordCount": status_counts.get("incomplete", 0),
        "blockingIncompleteRecordCount": blocking_incomplete_count,
        "unrecognizedOperationRecords": unknown_operation_records,
        "incompleteRecordsBySource": [incomplete_by_source[name] for name in sorted(incomplete_by_source)],
        "informationalRecordCount": status_counts.get("informational", 0),
        "unrecognizedRecordCount": status_counts.get("unrecognized", 0),
        "statusCounts": dict(status_counts),
        "canonicalHistoryRowCount": len(tax_input.get("canonical_history_rows") or []),
        "transactionDossierCount": len(tax_input.get("transaction_dossiers") or []),
        "aiCandidateCount": len(tax_input.get("ai_candidates") or []),
        "conflictCount": len(review.get("conflicts") or []),
        "needsReviewDossierCount": len(review.get("needs_review_dossier_ids") or []),
        "sourceCounts": {
            "total": len(source_statuses),
            "accepted": sum(1 for source in source_statuses if source.get("import_status") == "accepted"),
            "acceptedWithNotes": sum(1 for source in source_statuses if source.get("import_status") == "accepted_with_notes"),
            "unreadable": sum(1 for source in source_statuses if source.get("import_status") == "unreadable"),
            "unsafeRejected": sum(1 for source in source_statuses if source.get("import_status") == "unsafe_rejected"),
        },
    }


def build_tax_input_build_report(tax_input: dict[str, Any]) -> dict[str, Any]:
    summary = tax_input.get("summary") or {}
    return {
        "schema_version": "tax_input_build_report.v1",
        "status": "built",
        "message": "Canonical tax input built from accepted storage files as one record stream.",
        "input_file": "canonical_tax_input.json",
        "engineInputMode": "required",
        "consumedByEngine": (
            int(summary.get("engineReadyRecordCount") or 0) > 0
        ),
        "legacyFallbackUsed": False,
        "engine_contract": tax_input.get("engine_contract") or {},
        "summary": summary,
        "data_policy": tax_input.get("data_policy") or {},
        "readiness": {
            "has_engine_ready_records": int(summary.get("engineReadyRecordCount") or 0) > 0,
            "has_incomplete_records": int(summary.get("incompleteRecordCount") or 0) > 0,
            "has_unrecognized_records": int(summary.get("unrecognizedRecordCount") or 0) > 0,
            "has_ai_candidates": int(summary.get("aiCandidateCount") or 0) > 0,
        },
    }


def build_transaction_intelligence(
    sources: list[BrokerStorageResolvedSource],
    *,
    tax_year: int | None,
    ai_enabled: bool = False,
    ai_client: Any | None = None,
    ai_min_confidence: float = 0.8,
) -> dict[str, Any]:
    rows_cache: dict[str, list[tuple[dict[str, Any], str, str | None, str | None]]] = {}
    events = build_normalized_events(sources, tax_year=tax_year, rows_cache=rows_cache)
    truncated_sources = sources_hitting_the_row_limit(sources)
    unreadable_sources = sources_that_failed_to_read(sources, rows_cache=rows_cache)
    effective_ai_client = ai_client
    if ai_enabled and effective_ai_client is None:
        from investment_tax_engine.ai.ollama_client import OllamaClient

        effective_ai_client = OllamaClient.from_environment()
    ai_context_max_events = 200
    try:
        ai_context_max_events = max(1, int(os.getenv("INVEST_AI_CONTEXT_MAX_EVENTS", "200")))
    except ValueError:
        ai_context_max_events = 200
    ai_context = build_ai_extracted_context(
        events,
        enabled=ai_enabled,
        client=effective_ai_client,
        min_confidence=ai_min_confidence,
        max_events=ai_context_max_events,
    )
    document_classifications = build_document_classifications(
        sources,
        enabled=ai_enabled,
        client=effective_ai_client,
    )
    column_mappings = build_column_mappings(
        sources,
        events,
        enabled=ai_enabled,
        client=effective_ai_client,
    )
    ai_validation_report = build_ai_validation_report(
        classifications=document_classifications,
        column_mappings=column_mappings,
        ai_context=ai_context,
        ai_enabled=ai_enabled,
    )
    dossiers, field_source_map, conflicts = build_transaction_dossiers(events)
    registry = build_source_registry(sources, events, dossiers, ai_context=ai_context)
    evidence = build_evidence_index(events)
    manifest = [
        _manifest_entry(source, events, ai_context=ai_context, ai_enabled=ai_enabled)
        for source in sources
    ]
    payload = {
        "source_registry": registry,
        "normalized_storage_manifest": manifest,
        "normalized_events": events,
        "ai_document_classification": document_classifications,
        "ai_column_mappings": column_mappings,
        "ai_extracted_context": ai_context,
        "ai_validation_report": ai_validation_report,
        "transaction_dossiers": dossiers,
        "transaction_dossier_summary": {
            "schemaVersion": SCHEMA_TRANSACTION_DOSSIER,
            "dossierCount": len(dossiers),
            "eventCount": len(events),
            "conflictCount": len(conflicts),
            "needsReviewCount": sum(1 for dossier in dossiers if (dossier.get("review") or {}).get("needs_user_review")),
            "safeForTaxEngineCount": sum(1 for dossier in dossiers if (dossier.get("review") or {}).get("safe_for_tax_engine")),
            "generatedAt": datetime.now(timezone.utc).isoformat(),
        },
        "transaction_conflicts": conflicts,
        "evidence_index": evidence,
        "field_source_map": field_source_map,
        "sources_at_row_limit": truncated_sources,
        "sources_unreadable": unreadable_sources,
    }
    canonical_tax_input = build_canonical_tax_input(payload)
    payload["canonical_tax_input"] = canonical_tax_input
    payload["canonical_tax_input_summary"] = canonical_tax_input.get("summary") or {}
    payload["tax_input_build_report"] = build_tax_input_build_report(canonical_tax_input)
    return payload


def write_transaction_intelligence_outputs(
    payload: dict[str, Any], output_dir: Path, mirror_dirs: Iterable[Path] = ()
) -> list[Path]:
    """Zapisuje pliki warstwy transakcji; kazdy plik serializowany jest raz.

    JSON bez wciec idzie koderem w C - z wcieciami json uzywal kodera
    pythonowego, kilka razy wolniejszego. Te same pliki (ok. 90 MB) szly
    dodatkowo drugi raz do kopii w dane/out. `mirror_dirs` dostaje ten sam tekst.
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []

    def zapisz(name: str, text: str) -> None:
        path = output_dir / name
        path.write_text(text, encoding="utf-8")
        written.append(path)

    def write_json(name: str, value: Any) -> None:
        zapisz(name, json.dumps(value, ensure_ascii=False, default=str))

    def write_jsonl(name: str, values: list[dict[str, Any]]) -> None:
        zapisz(name, "".join(json.dumps(value, ensure_ascii=False, default=str) + "\n" for value in values))

    write_json("source_registry.json", payload.get("source_registry") or [])
    write_json("normalized_storage_manifest.json", payload.get("normalized_storage_manifest") or [])
    write_jsonl("normalized_events.jsonl", payload.get("normalized_events") or [])
    write_json("ai_document_classification.json", payload.get("ai_document_classification") or [])
    write_json("ai_column_mappings.json", payload.get("ai_column_mappings") or [])
    write_jsonl("ai_extracted_context.jsonl", payload.get("ai_extracted_context") or [])
    write_json("ai_validation_report.json", payload.get("ai_validation_report") or {})
    write_json("transaction_dossiers.json", payload.get("transaction_dossiers") or [])
    write_json("transaction_conflicts.json", payload.get("transaction_conflicts") or [])
    write_json("evidence_index.json", payload.get("evidence_index") or [])
    write_json("field_source_map.json", payload.get("field_source_map") or {})
    write_json("canonical_storage_history.json", payload.get("canonical_storage_history") or [])
    write_json("storage_lineage_index.json", payload.get("storage_lineage_index") or {})
    write_json("canonical_tax_input.json", payload.get("canonical_tax_input") or {})
    write_json("canonical_tax_input_summary.json", payload.get("canonical_tax_input_summary") or {})
    write_json("tax_input_build_report.json", payload.get("tax_input_build_report") or {})
    for katalog in mirror_dirs:
        _skopiuj_do_kopii(written, Path(katalog))
    return written


def _skopiuj_do_kopii(pliki: list[Path], katalog: Path, limit_s: float = 120.0) -> None:
    """Kopia plikow przebiegu w dane/out - caly zestaw z jednego przebiegu.

    Serwer dopuszcza dwa przebiegi naraz (np. dwa lata). Oba zapisywaly po kolei
    te same nazwy w jednym katalogu kopii i zostawal zestaw zlozony z roznych
    przebiegow. Kopie robi teraz jeden przebieg naraz (blokada katalogiem), a kazdy
    plik podmieniany jest w calosci. Kopia jest pomocnicza: gdy blokady nie da sie
    uzyskac, przebieg idzie dalej bez niej.
    """
    katalog.mkdir(parents=True, exist_ok=True)
    blokada = katalog / ".zapis-kopii.lock"
    koniec = time.monotonic() + limit_s
    while True:
        try:
            blokada.mkdir()
            break
        except FileExistsError:
            try:
                # Blokada po przerwanym przebiegu nie moze zatrzymac kopii na zawsze.
                if time.time() - blokada.stat().st_mtime > 600:
                    blokada.rmdir()
                    continue
            except OSError:
                pass
            if time.monotonic() > koniec:
                print(f"UWAGA: kopia wynikow w {katalog} pominieta - trwa zapis innego przebiegu.", file=sys.stderr)
                return
            time.sleep(0.2)
    # Najpierw caly zestaw do plikow tymczasowych (dlugie kopiowanie ok. 90 MB), dopiero
    # potem szybka podmiana. Plik po pliku przerwany przebieg zostawial czesc wynikow
    # nowych i czesc starych; znacznik mowi, ze podmiana nie dobiegla konca.
    znacznik = katalog / "KOPIA_NIEPELNA.txt"
    tymczasowe: list[tuple[Path, Path]] = []
    try:
        for plik in pliki:
            tymczasowy = katalog / f".{plik.name}.{uuid.uuid4().hex}.tmp"
            tymczasowe.append((tymczasowy, katalog / plik.name))
            shutil.copyfile(plik, tymczasowy)
        znacznik.write_text(
            "Przebieg przerwany w trakcie podmiany kopii - pliki w tym katalogu moga pochodzic z dwoch "
            "roznych przebiegow. Uruchom przeliczenie ponownie.\n",
            encoding="utf-8",
        )
        for tymczasowy, cel in tymczasowe:
            os.replace(tymczasowy, cel)
        znacznik.unlink()
    finally:
        for tymczasowy, _ in tymczasowe:
            if tymczasowy.exists():
                tymczasowy.unlink()
        try:
            blokada.rmdir()
        except OSError:
            pass
