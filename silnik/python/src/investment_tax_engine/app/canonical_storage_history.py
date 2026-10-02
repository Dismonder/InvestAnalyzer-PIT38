from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from decimal import Decimal
from pathlib import Path
from typing import Any

import pandas as pd

from investment_tax_engine.app.source_resolver import BrokerStorageResolvedSource, _flatten_json_lists
from investment_tax_engine.app.spreadsheet_safety import validate_spreadsheet_zip
from investment_tax_engine.models.core import Issue, TransactionHistoryRow


@dataclass
class StorageSourceRun:
    source_id: str
    filename: str
    detected_type: str
    status: str
    reason: str
    record_count: int = 0
    trade_row_count: int = 0
    buy_count: int = 0
    sell_count: int = 0
    date_range: dict[str, str | None] = field(default_factory=lambda: {"from": None, "to": None})
    issue_count: int = 0
    diagnostic_issue_count: int = 0
    record_preview: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _source_usage_label(source: BrokerStorageResolvedSource) -> tuple[str, str, str, bool]:
    if source.role == "baseline_tax":
        return ("Transakcje", "TRANSACTION_SOURCE", "recognized_source", False)
    if source.role == "baseline_support":
        return ("Kontekst baseline", "SUPPLEMENTAL", "baseline_support_context", True)
    if source.role == "candidate_tax":
        return ("Raport transakcyjny", "TRANSACTION_SOURCE", "recognized_source", False)
    if source.role == "supplemental":
        return ("Pomocniczy", "SUPPLEMENTAL", "supplemental", True)
    if source.role == "reconciliation":
        return ("Kontrola pozycji", "RECONCILIATION", "position_reconciliation", True)
    if source.role in {"analytics", "evidence"}:
        return ("Dowod / analityka", "EVIDENCE", "source_evidence", True)
    return ("Techniczny", "TECHNICAL", "recognized_source", True)


def _side_from_row(row: dict[str, Any]) -> str | None:
    for key in ("operation", "Operation", "side", "Side", "type", "Type", "Rodzaj zlecenia"):
        value = row.get(key)
        if value is None or value == "":
            continue
        normalized = str(value).strip().lower()
        if normalized in {"2", "sell", "s", "sprzedaż", "sprzedaz"} or "sprzeda" in normalized:
            return "SELL"
        if normalized in {"1", "buy", "b", "kupno", "zakup"} or "kup" in normalized:
            return "BUY"
    return None


def _date_from_row(row: dict[str, Any]) -> pd.Timestamp | None:
    for key in ("date", "executed_at", "exchange_time", "settlement_date", "Data", "Execution time", "pay_d", "trade_d_exch"):
        value = row.get(key)
        if value is None or value == "":
            continue
        try:
            timestamp = pd.Timestamp(value)
        except Exception:
            continue
        if not pd.isna(timestamp):
            return timestamp.normalize()
    return None


def _is_trade_row(row: dict[str, Any]) -> bool:
    return bool({"operation", "side", "type", "q", "quantity", "price", "p", "symbol", "ticker", "instr_nm"}.intersection(row.keys()))


def _date_range(dates: list[pd.Timestamp]) -> dict[str, str | None]:
    if not dates:
        return {"from": None, "to": None}
    return {"from": str(min(dates).date()), "to": str(max(dates).date())}


def _decimal_from_row(row: dict[str, Any], *keys: str) -> Decimal | None:
    for key in keys:
        value = row.get(key)
        if value is None or value == "":
            continue
        try:
            return Decimal(str(value).replace(" ", "").replace(",", "."))
        except Exception:
            continue
    return None


def _trade_amount_from_row(row: dict[str, Any]) -> Decimal:
    direct = _decimal_from_row(
        row,
        "value_pln",
        "amount_pln",
        "sum_pln",
        "gross_pln",
        "gross_amount",
        "net_amount",
        "amount",
        "sum",
        "value",
        "v",
    )
    if direct is not None:
        return abs(direct)
    quantity = _decimal_from_row(row, "q", "quantity", "qty", "Quantity", "Ilość", "Ilosc")
    price = _decimal_from_row(row, "p", "price", "Price", "Cena")
    if quantity is not None and price is not None:
        return abs(quantity * price)
    return Decimal("0")


def _string_from_row(row: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = row.get(key)
        if value is None or value == "":
            continue
        return str(value)
    return None


def _record_id_from_row(row: dict[str, Any]) -> str | None:
    return _string_from_row(
        row,
        "id",
        "trade_id",
        "transaction_id",
        "order_id",
        "Numer",
        "Operacja №",
        "Operation ID",
        "raw_id",
    )


def _quantity_from_row(row: dict[str, Any]) -> Decimal | None:
    return _decimal_from_row(row, "q", "quantity", "qty", "Quantity", "Ilość", "Ilosc")


def _currency_from_row(row: dict[str, Any]) -> str | None:
    value = _string_from_row(row, "currency", "Currency", "curr", "c", "curr_c", "waluta")
    if value:
        return value.strip()
    amount_text = _string_from_row(row, "sum")
    if amount_text and " " in amount_text.strip():
        return amount_text.strip().split()[-1]
    return None


def _ticker_from_row(row: dict[str, Any]) -> str | None:
    return _string_from_row(row, "symbol", "ticker", "instr_nm", "Tickery", "Instrument", "Instrument name", "Papier wartościowy")


DISPLAY_CATEGORY_LABELS: dict[str, tuple[str, str]] = {
    "investment": ("Inwestycyjne", "Investment"),
    "cash_flow": ("Gotówka/FX", "Cash/FX"),
    "fee_cost": ("Koszty i opłaty", "Costs and fees"),
    "fx": ("Gotówka/FX", "Cash/FX"),
    "dividend": ("Dywidendy", "Dividends"),
    "position_check": ("Kontrola pozycji", "Position checks"),
    "evidence": ("Dowody/analityka", "Evidence/analytics"),
    "analytics": ("Dowody/analityka", "Evidence/analytics"),
    "technical": ("Techniczne", "Technical"),
}


def _row_text(row: dict[str, Any]) -> str:
    return " ".join(str(value).lower() for value in row.values() if value is not None)


def _display_category_for_row(
    *,
    source: BrokerStorageResolvedSource,
    row: dict[str, Any],
    row_kind: str,
    tax_kind: str,
) -> str:
    text = _row_text(row)
    if row_kind in {"TRADE", "STORAGE_RECORD"} and (_side_from_row(row) or _ticker_from_row(row)):
        if "dividend" in text or "dywidend" in text:
            return "dividend"
        return "investment"
    if tax_kind in {"TRANSACTION_SOURCE", "TRANSACTION_SOURCE"} and (_side_from_row(row) or _ticker_from_row(row)):
        return "investment"
    if row_kind in {"POSITION_RECONCILIATION"} or source.role == "reconciliation":
        return "position_check"
    if row_kind == "CASH_FLOW":
        if any(marker in text for marker in ("dividend", "dywidend", "withholding", "podatek źródł", "podatek zrodl")):
            return "dividend"
        if any(marker in text for marker in ("commission", "fee", "prowiz", "interest", "odset", "minimum for the order", "service plan")):
            return "fee_cost"
        if any(marker in text for marker in ("fx", "exchange", "conversion", "przewalut", "currency")):
            return "fx"
        return "cash_flow"
    if row_kind == "ANALYTICS" or source.role == "analytics":
        return "analytics"
    if row_kind == "EVIDENCE_DOCUMENT" or source.role == "evidence":
        return "evidence"
    return "technical"


def _canonical_fingerprint(*, source: BrokerStorageResolvedSource, row: dict[str, Any], row_kind: str, display_date: pd.Timestamp | None) -> str:
    parts = [
        str(display_date.date()) if display_date is not None else "",
        row_kind,
        _side_from_row(row) or "",
        _ticker_from_row(row) or "",
        str(_quantity_from_row(row) or ""),
        str(_trade_amount_from_row(row) or ""),
        _currency_from_row(row) or "",
        _record_id_from_row(row) or "",
    ]
    # Keep evidence/analytics rows separate when they do not describe a trade-like event.
    if row_kind in {"EVIDENCE", "RECONCILIATION", "TECHNICAL_ONLY"} and not any(parts[2:6]):
        parts.append(source.source_id)
    return json.dumps(parts, ensure_ascii=False, sort_keys=False)


def _canonical_row(
    *,
    source: BrokerStorageResolvedSource,
    row: dict[str, Any],
    index: int,
    row_kind: str,
    tax_label: str,
    tax_kind: str,
    is_technical_only: bool,
) -> dict[str, Any]:
    display_date = _date_from_row(row)
    fingerprint = _canonical_fingerprint(source=source, row=row, row_kind=row_kind, display_date=display_date)
    usage_status = _source_usage_label(source)[2]
    effective_tax_kind = tax_kind
    effective_tax_label = tax_label
    display_category = _display_category_for_row(
        source=source,
        row=row,
        row_kind=row_kind,
        tax_kind=effective_tax_kind,
    )
    display_label_pl, display_label_en = DISPLAY_CATEGORY_LABELS.get(display_category, DISPLAY_CATEGORY_LABELS["technical"])
    return {
        "row_id": f"storage:{source.source_id}:canonical:{index}",
        "parent_row_id": None,
        "row_kind": row_kind,
        "display_date": str(display_date.isoformat()) if display_date is not None else None,
        "transaction_id": _record_id_from_row(row),
        "ticker": _ticker_from_row(row),
        "base_record_id": None,
        "manual_record_id": None,
        "side": _side_from_row(row),
        "quantity": str(_quantity_from_row(row)) if _quantity_from_row(row) is not None else None,
        "amount": str(_trade_amount_from_row(row)),
        "currency": _currency_from_row(row),
        "amount_pln": None,
        "comment": _string_from_row(row, "comment", "Komentarz", "type", "Rodzaj zlecenia", "name"),
        "message": effective_tax_label,
        "source_name": source.filename,
        "source_manifest_id": source.source_id,
        "conflict_count": 0,
        "tax_impact_label": effective_tax_label,
        "tax_impact_kind": effective_tax_kind,
        "is_technical_only": is_technical_only,
        "tax_impact_label_pl": effective_tax_label,
        "display_category": display_category,
        "display_category_label_pl": display_label_pl,
        "display_category_label_en": display_label_en,
        "lineage_summary": source.filename,
        "dedupe_status": "single_source",
        "defense_status": None,
        "evidence_count": 0,
        "missing_evidence_count": 0,
        "source_refs": [source.source_id],
        "provenance": [
            {
                "sourceId": source.source_id,
                "filename": source.filename,
                "relativePath": source.relative_path,
                "role": source.role,
                "detectedType": source.detected_type,
                "recordIndex": index,
            }
        ],
        "logical_world": "storage_canonical",
        "overlay_status": "READ_ONLY",
        "read_only": True,
        "details": {
            "canonical_storage": True,
            "storage_role": source.role,
            "usage_status": usage_status,
            "detected_type": source.detected_type,
            "dedupe_fingerprint": fingerprint,
            "is_complete_trade_candidate": effective_tax_kind == "TRANSACTION_SOURCE",
            "raw_preview": {str(key): str(value) for key, value in list(row.items())[:24]},
        },
    }


def _merge_canonical_rows(rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    by_fingerprint: dict[str, dict[str, Any]] = {}
    lineage_index: dict[str, Any] = {}
    for row in rows:
        fingerprint = str((row.get("details") or {}).get("dedupe_fingerprint") or row.get("row_id"))
        existing = by_fingerprint.get(fingerprint)
        if existing is None:
            by_fingerprint[fingerprint] = row
            lineage_index[fingerprint] = {
                "rowId": row.get("row_id"),
                "sourceRefs": list(row.get("source_refs") or []),
                "provenance": list(row.get("provenance") or []),
            }
            continue
        source_refs = list(dict.fromkeys([*(existing.get("source_refs") or []), *(row.get("source_refs") or [])]))
        provenance = [*(existing.get("provenance") or []), *(row.get("provenance") or [])]
        existing["source_refs"] = source_refs
        existing["provenance"] = provenance
        existing["conflict_count"] = max(0, len(source_refs) - 1)
        existing["source_name"] = ", ".join(
            dict.fromkeys(
                str(item.get("filename"))
                for item in provenance
                if isinstance(item, dict) and item.get("filename")
            )
        )
        existing["lineage_summary"] = existing["source_name"]
        existing["dedupe_status"] = "merged_from_sources"
        details = dict(existing.get("details") or {})
        details["deduped_source_count"] = len(source_refs)
        existing["details"] = details
        lineage_index[fingerprint] = {
            "rowId": existing.get("row_id"),
            "sourceRefs": source_refs,
            "provenance": provenance,
        }
    merged = sorted(
        by_fingerprint.values(),
        key=lambda row: (
            str(row.get("display_date") or "9999-12-31"),
            str(row.get("source_name") or ""),
            str(row.get("row_id") or ""),
        ),
    )
    return merged, lineage_index


def _rows_from_json_section(payload: Any, section: str) -> list[dict[str, Any]]:
    if not isinstance(payload, dict) or section not in payload:
        return []
    return _flatten_json_lists(payload.get(section))


def _canonical_rows_for_source(
    source: BrokerStorageResolvedSource,
    *,
    tax_year: int | None,
    max_rows_per_source: int,
) -> list[dict[str, Any]]:
    label, tax_kind, _, technical = _source_usage_label(source)
    rows: list[dict[str, Any]] = []
    path = Path(source.path)

    def append_rows(raw_rows: list[dict[str, Any]], row_kind: str, row_label: str = label, row_tax_kind: str = tax_kind, row_technical: bool = technical) -> None:
        for index, raw in enumerate(raw_rows):
            if len(rows) >= max_rows_per_source:
                break
            date = _date_from_row(raw)
            if tax_year is not None and date is not None and date.year != tax_year:
                continue
            rows.append(
                _canonical_row(
                    source=source,
                    row=raw,
                    index=index,
                    row_kind=row_kind,
                    tax_label=row_label,
                    tax_kind=row_tax_kind,
                    is_technical_only=row_technical,
                )
            )

    try:
        if source.detected_type in {"broker_report_json", "depositary_report_json", "legacy_broker_history_json", "local_broker_history_json", "json"}:
            payload = json.loads(path.read_text(encoding="utf-8"))
            if source.detected_type == "broker_report_json":
                append_rows(_rows_from_json_section(payload, "trades"), "TRADE")
                append_rows(_rows_from_json_section(payload, "cash_flows"), "CASH_FLOW", "Pomocniczy", "SUPPLEMENTAL", True)
                append_rows(_rows_from_json_section(payload, "cash_in_outs"), "CASH_FLOW", "Pomocniczy", "SUPPLEMENTAL", True)
            elif source.detected_type == "depositary_report_json":
                append_rows(_rows_from_json_section(payload, "depoData"), "POSITION_RECONCILIATION", "Kontrola pozycji", "RECONCILIATION", True)
                append_rows(_rows_from_json_section(payload, "securities_flows"), "POSITION_RECONCILIATION", "Kontrola pozycji", "RECONCILIATION", True)
            else:
                append_rows(_flatten_json_lists(payload), "STORAGE_RECORD")
        elif source.detected_type in {"broker_transactions_xlsx", "cash_flows_xlsx", "traders_xlsx", "nbp_archive", "spreadsheet"} and path.suffix.lower() != ".csv":
            validate_spreadsheet_zip(path)
            excel = pd.ExcelFile(path)
            for sheet_name in excel.sheet_names[:4]:
                frame = pd.read_excel(path, sheet_name=sheet_name, nrows=max_rows_per_source)
                raw_rows = [{str(key): value for key, value in row.items()} for row in frame.to_dict("records")]
                row_kind = "TRADE" if source.detected_type == "broker_transactions_xlsx" else "CASH_FLOW"
                if source.detected_type == "traders_xlsx":
                    row_kind = "ANALYTICS"
                append_rows(raw_rows, row_kind)
        elif source.detected_type == "fee_schedule_pdf":
            append_rows([{"name": source.filename, "comment": source.reason}], "EVIDENCE_DOCUMENT", "Dowód / analityka", "EVIDENCE", True)
        elif source.detected_type == "nbp_archive":
            append_rows([{"name": source.filename, "comment": source.reason}], "NBP_RATES", "Pomocniczy", "SUPPLEMENTAL", True)
    except Exception as exc:
        rows.append(
            _canonical_row(
                source=source,
                row={"comment": f"Nie odczytano podgladu storage: {exc}"},
                index=0,
                row_kind="STORAGE_READ_ERROR",
                tax_label="Techniczny",
                tax_kind="TECHNICAL_ONLY",
                is_technical_only=True,
            )
        )
    return rows


def build_canonical_storage_history(
    sources: list[BrokerStorageResolvedSource],
    *,
    tax_year: int | None,
    max_rows_per_source: int = 500,
    max_total_rows: int = 5000,
) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    for source in sources:
        if len(rows) >= max_total_rows:
            break
        rows.extend(
            _canonical_rows_for_source(
                source,
                tax_year=tax_year,
                max_rows_per_source=max_rows_per_source,
            )
        )
    rows = rows[:max_total_rows]
    merged, lineage_index = _merge_canonical_rows(rows)
    category_counts: dict[str, int] = {}
    source_coverage: dict[str, dict[str, Any]] = {
        source.source_id: {
            "sourceId": source.source_id,
            "filename": source.filename,
            "role": source.role,
            "detectedType": source.detected_type,
            "rowCount": 0,
            "hasRows": False,
            "noRowsExpected": source.detected_type in {"nbp_archive"},
        }
        for source in sources
    }
    for row in merged:
        category = str(row.get("display_category") or "technical")
        category_counts[category] = category_counts.get(category, 0) + 1
        for provenance in row.get("provenance") or []:
            if not isinstance(provenance, dict):
                continue
            source_id = str(provenance.get("sourceId") or "")
            if source_id in source_coverage:
                source_coverage[source_id]["rowCount"] += 1
                source_coverage[source_id]["hasRows"] = True
    source_files_without_rows = [
        item
        for item in source_coverage.values()
        if not item["hasRows"] and not item["noRowsExpected"]
    ]
    return {
        "rows": merged,
        "lineageIndex": lineage_index,
        "summary": {
            "sourceCount": len(sources),
            "rawRowCount": len(rows),
            "canonicalRowCount": len(merged),
            "deduplicatedRowCount": max(0, len(rows) - len(merged)),
            "mergedRecordCount": sum(1 for row in merged if row.get("dedupe_status") == "merged_from_sources"),
            "categoryCounts": category_counts,
            "sourceCoverage": list(source_coverage.values()),
            "sourceFilesWithoutRows": source_files_without_rows,
        },
    }


