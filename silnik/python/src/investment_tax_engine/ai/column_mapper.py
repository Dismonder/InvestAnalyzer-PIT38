from __future__ import annotations

import json
from typing import Any


SCHEMA_VERSION = "ai.column_mapping.v1"

MAPPED_COLUMN_KEYS = {
    "date",
    "time",
    "operation_type",
    "ticker",
    "isin",
    "quantity",
    "price",
    "gross_amount",
    "net_amount",
    "commission",
    "currency",
    "description",
    "transaction_id",
}

COLUMN_MAPPING_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": True,
    "required": [
        "schema_version",
        "file_sha256",
        "sheet_name",
        "header_row_index",
        "mapped_columns",
        "unmapped_columns",
        "confidence",
        "needs_user_review",
        "warnings",
    ],
    "properties": {
        "schema_version": {"const": SCHEMA_VERSION},
        "file_sha256": {"type": "string"},
        "sheet_name": {"type": "string"},
        "header_row_index": {"type": "number"},
        "mapped_columns": {"type": "object"},
        "unmapped_columns": {"type": "array", "items": {"type": "string"}},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "needs_user_review": {"type": "boolean"},
        "warnings": {"type": "array", "items": {"type": "string"}},
    },
}


class AiColumnMappingError(ValueError):
    pass


def _normalize_header(value: str) -> str:
    return (
        value.strip()
        .lower()
        .replace("ą", "a")
        .replace("ć", "c")
        .replace("ę", "e")
        .replace("ł", "l")
        .replace("ń", "n")
        .replace("ó", "o")
        .replace("ś", "s")
        .replace("ż", "z")
        .replace("ź", "z")
    )


HEADER_ALIASES: dict[str, set[str]] = {
    "date": {"date", "data", "execution time", "trade date", "trade_d_exch"},
    "time": {"time", "czas"},
    "operation_type": {"operation", "typ", "type", "side", "operacja"},
    "ticker": {"ticker", "instrument name", "instr_nm", "instrument", "symbol"},
    "isin": {"isin"},
    "quantity": {"quantity", "qty", "q", "ilosc", "ilosc sztuk"},
    "price": {"price", "p", "cena"},
    "gross_amount": {"amount", "kwota", "gross amount", "value", "v", "sum"},
    "net_amount": {"net amount", "net"},
    "commission": {"commission", "prowizja", "fee", "fee amount"},
    "currency": {"currency", "waluta", "curr", "curr_c"},
    "description": {"description", "opis", "comment", "komentarz", "details"},
    "transaction_id": {"operation id", "transaction id", "id", "trade_id", "order id", "numer"},
}


def validate_column_mapping(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise AiColumnMappingError("Column mapping must be a JSON object.")
    if payload.get("schema_version") != SCHEMA_VERSION:
        raise AiColumnMappingError("Column mapping contract version mismatch.")
    mapped_columns = payload.get("mapped_columns")
    if not isinstance(mapped_columns, dict):
        raise AiColumnMappingError("Column mapping field 'mapped_columns' must be an object.")
    normalized_mapping: dict[str, str | None] = {}
    for key in MAPPED_COLUMN_KEYS:
        value = mapped_columns.get(key)
        if value is not None and not isinstance(value, str):
            raise AiColumnMappingError(f"Mapped column '{key}' must be string or null.")
        normalized_mapping[key] = value.strip() if isinstance(value, str) and value.strip() else None

    unmapped = payload.get("unmapped_columns")
    if not isinstance(unmapped, list) or any(not isinstance(column, str) for column in unmapped):
        raise AiColumnMappingError("Column mapping field 'unmapped_columns' must be a list of strings.")
    confidence = payload.get("confidence")
    if not isinstance(confidence, (int, float)) or isinstance(confidence, bool) or not 0 <= confidence <= 1:
        raise AiColumnMappingError("Column mapping confidence must be a number between 0 and 1.")
    warnings = payload.get("warnings")
    if not isinstance(warnings, list) or any(not isinstance(warning, str) for warning in warnings):
        raise AiColumnMappingError("Column mapping warnings must be a list of strings.")

    return {
        "schema_version": SCHEMA_VERSION,
        "file_sha256": str(payload.get("file_sha256") or ""),
        "sheet_name": str(payload.get("sheet_name") or ""),
        "header_row_index": int(payload.get("header_row_index") or 0),
        "mapped_columns": normalized_mapping,
        "unmapped_columns": [column for column in unmapped if column],
        "confidence": float(confidence),
        "needs_user_review": bool(payload.get("needs_user_review")),
        "warnings": warnings,
    }


def deterministic_column_mapping(
    *,
    file_sha256: str,
    sheet_name: str,
    headers: list[str],
    header_row_index: int = 0,
) -> dict[str, Any]:
    normalized_headers = {_normalize_header(header): header for header in headers}
    mapped: dict[str, str | None] = {}
    used: set[str] = set()
    for target, aliases in HEADER_ALIASES.items():
        match = next((normalized_headers[alias] for alias in aliases if alias in normalized_headers), None)
        mapped[target] = match
        if match:
            used.add(match)
    unmapped = [header for header in headers if header not in used]
    required = ["date", "operation_type", "ticker", "quantity", "price", "gross_amount", "currency"]
    matched_required = sum(1 for key in required if mapped.get(key))
    confidence = matched_required / len(required)
    return {
        "schema_version": SCHEMA_VERSION,
        "file_sha256": file_sha256,
        "sheet_name": sheet_name,
        "header_row_index": header_row_index,
        "mapped_columns": mapped,
        "unmapped_columns": unmapped,
        "confidence": confidence,
        "needs_user_review": confidence < 0.8,
        "warnings": [] if confidence >= 0.8 else ["Niepewne mapowanie kolumn; wymaga kontroli."],
        "mapping_method": "deterministic",
        "validation_status": "accepted",
    }


def _build_prompt(*, file_sha256: str, sheet_name: str, headers: list[str], sample_rows: list[dict[str, Any]]) -> str:
    preview = {
        "file_sha256": file_sha256,
        "sheet_name": sheet_name,
        "headers": headers,
        "sample_rows": sample_rows[:5],
    }
    return "\n".join(
        [
            "Zmapuj kolumny arkusza brokerskiego do standardu InvestAnalyzer.",
            "Zwracaj tylko JSON zgodny ze schematem ai.column_mapping.v1.",
            "Nie licz podatku i nie decyduj o aktywnym PIT.",
            json.dumps(preview, ensure_ascii=False, default=str)[:6000],
        ]
    )


def map_columns_with_ai(
    *,
    file_sha256: str,
    sheet_name: str,
    headers: list[str],
    sample_rows: list[dict[str, Any]],
    client: Any,
) -> dict[str, Any]:
    payload = client.generate_structured(
        prompt=_build_prompt(file_sha256=file_sha256, sheet_name=sheet_name, headers=headers, sample_rows=sample_rows),
        schema=COLUMN_MAPPING_SCHEMA,
        task_name="column_mapper",
    )
    mapping = validate_column_mapping(payload)
    mapping["file_sha256"] = file_sha256
    mapping["sheet_name"] = sheet_name
    mapping["mapping_method"] = "ollama"
    mapping["ai_model"] = getattr(client, "model", None) or "unknown"
    mapping["validation_status"] = "accepted"
    return mapping


__all__ = [
    "AiColumnMappingError",
    "COLUMN_MAPPING_SCHEMA",
    "SCHEMA_VERSION",
    "deterministic_column_mapping",
    "map_columns_with_ai",
    "validate_column_mapping",
]
