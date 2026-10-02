from __future__ import annotations

import json
from typing import Any

from investment_tax_engine.app.source_resolver import BrokerStorageResolvedSource


SCHEMA_VERSION = "ai.document_classification.v1"

DOCUMENT_KINDS = {
    "transactions",
    "cash_movements",
    "broker_report",
    "depository_report",
    "fee_table",
    "analytics",
    "tax_report",
    "unknown",
}
SOURCE_ROLES = {
    "pit_candidate",
    "cash_context",
    "position_reconciliation",
    "evidence",
    "analytics",
    "technical",
    "unknown",
}
BROKERS = {"freedom24", "xtb", "ibkr", "unknown"}

DOCUMENT_CLASSIFICATION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": True,
    "required": [
        "schema_version",
        "file_sha256",
        "detected_language",
        "document_kind",
        "source_role",
        "broker",
        "contains_investment_transactions",
        "contains_cash_movements",
        "contains_fees",
        "contains_fx",
        "contains_interest",
        "contains_dividends",
        "confidence",
        "needs_user_review",
        "reasoning_short",
        "warnings",
    ],
    "properties": {
        "schema_version": {"const": SCHEMA_VERSION},
        "file_sha256": {"type": "string"},
        "detected_language": {"enum": ["pl", "en", "mixed", "unknown"]},
        "document_kind": {"enum": sorted(DOCUMENT_KINDS)},
        "source_role": {"enum": sorted(SOURCE_ROLES)},
        "broker": {"enum": sorted(BROKERS)},
        "contains_investment_transactions": {"type": "boolean"},
        "contains_cash_movements": {"type": "boolean"},
        "contains_fees": {"type": "boolean"},
        "contains_fx": {"type": "boolean"},
        "contains_interest": {"type": "boolean"},
        "contains_dividends": {"type": "boolean"},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "needs_user_review": {"type": "boolean"},
        "reasoning_short": {"type": "string"},
        "warnings": {"type": "array", "items": {"type": "string"}},
    },
}


class AiDocumentClassificationError(ValueError):
    pass


def _bool(payload: dict[str, Any], key: str) -> bool:
    value = payload.get(key)
    if not isinstance(value, bool):
        raise AiDocumentClassificationError(f"Classification field '{key}' must be boolean.")
    return value


def _string(payload: dict[str, Any], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise AiDocumentClassificationError(f"Classification field '{key}' must be a non-empty string.")
    return value.strip()


def validate_document_classification(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise AiDocumentClassificationError("Document classification must be a JSON object.")
    if payload.get("schema_version") != SCHEMA_VERSION:
        raise AiDocumentClassificationError("Document classification contract version mismatch.")

    document_kind = _string(payload, "document_kind")
    if document_kind not in DOCUMENT_KINDS:
        raise AiDocumentClassificationError(f"Unsupported document kind: {document_kind}.")
    source_role = _string(payload, "source_role")
    if source_role not in SOURCE_ROLES:
        raise AiDocumentClassificationError(f"Unsupported source role: {source_role}.")
    broker = _string(payload, "broker")
    if broker not in BROKERS:
        raise AiDocumentClassificationError(f"Unsupported broker: {broker}.")
    detected_language = _string(payload, "detected_language")
    if detected_language not in {"pl", "en", "mixed", "unknown"}:
        raise AiDocumentClassificationError(f"Unsupported detected language: {detected_language}.")

    confidence = payload.get("confidence")
    if not isinstance(confidence, (int, float)) or isinstance(confidence, bool) or not 0 <= confidence <= 1:
        raise AiDocumentClassificationError("Classification confidence must be a number between 0 and 1.")
    warnings = payload.get("warnings")
    if not isinstance(warnings, list) or any(not isinstance(warning, str) for warning in warnings):
        raise AiDocumentClassificationError("Classification warnings must be a list of strings.")

    return {
        "schema_version": SCHEMA_VERSION,
        "file_sha256": _string(payload, "file_sha256"),
        "detected_language": detected_language,
        "document_kind": document_kind,
        "source_role": source_role,
        "broker": broker,
        "contains_investment_transactions": _bool(payload, "contains_investment_transactions"),
        "contains_cash_movements": _bool(payload, "contains_cash_movements"),
        "contains_fees": _bool(payload, "contains_fees"),
        "contains_fx": _bool(payload, "contains_fx"),
        "contains_interest": _bool(payload, "contains_interest"),
        "contains_dividends": _bool(payload, "contains_dividends"),
        "confidence": float(confidence),
        "needs_user_review": _bool(payload, "needs_user_review"),
        "reasoning_short": _string(payload, "reasoning_short"),
        "warnings": warnings,
    }


def deterministic_document_classification(source: BrokerStorageResolvedSource) -> dict[str, Any]:
    detected = source.detected_type
    role = source.role
    if detected in {"broker_report_json", "legacy_broker_history_json", "local_broker_history_json", "broker_transactions_xlsx"}:
        document_kind = "broker_report" if detected == "broker_report_json" else "transactions"
        source_role = "pit_candidate" if role == "candidate_tax" else "cash_context"
        contains_trades = True
    elif detected == "cash_flows_xlsx":
        document_kind = "cash_movements"
        source_role = "cash_context"
        contains_trades = False
    elif detected == "depositary_report_json":
        document_kind = "depository_report"
        source_role = "position_reconciliation"
        contains_trades = False
    elif detected == "fee_schedule_pdf":
        document_kind = "fee_table"
        source_role = "evidence"
        contains_trades = False
    elif detected == "traders_xlsx":
        document_kind = "analytics"
        source_role = "analytics"
        contains_trades = False
    elif detected == "nbp_archive":
        document_kind = "tax_report"
        source_role = "technical"
        contains_trades = False
    else:
        document_kind = "unknown"
        source_role = "unknown"
        contains_trades = False

    text = " ".join([source.filename, detected, source.reason]).lower()
    return {
        "schema_version": SCHEMA_VERSION,
        "file_sha256": source.hash,
        "source_id": source.source_id,
        "filename": source.filename,
        "detected_language": "mixed" if any(ch in text for ch in ["ą", "ę", "ł", "ó", "got"]) else "unknown",
        "document_kind": document_kind,
        "source_role": source_role,
        # Samo slowo "broker" w tekscie albo w nazwie pliku nie wskazuje na
        # Freedom24 - raport innego biura maklerskiego i plik z recznymi
        # transakcjami dostawaly przez to falszywa nazwe zrodla, ktora idzie
        # dalej do pakietu dowodowego.
        "broker": "freedom24" if ("freedom" in text or "tradernet" in text) else "unknown",
        "contains_investment_transactions": contains_trades,
        "contains_cash_movements": detected in {"cash_flows_xlsx", "broker_report_json"},
        "contains_fees": detected in {"cash_flows_xlsx", "broker_report_json", "fee_schedule_pdf"},
        "contains_fx": detected in {"cash_flows_xlsx", "broker_report_json", "nbp_archive"},
        "contains_interest": detected in {"cash_flows_xlsx", "broker_report_json"},
        "contains_dividends": detected in {"cash_flows_xlsx", "broker_report_json"},
        # To nie jest miara pewnosci modelu, tylko dwie stale: rozpoznano rodzaj
        # dokumentu albo nie. Nazwa pola zostaje ze wzgledu na format pakietu.
        "confidence": 0.95 if document_kind != "unknown" else 0.45,
        "confidence_source": "rule_based_two_values",
        "needs_user_review": document_kind == "unknown" or bool(source.errors),
        "reasoning_short": source.reason or f"Deterministycznie rozpoznano {detected}.",
        "warnings": list(source.warnings),
        "classification_method": "deterministic",
        "validation_status": "accepted",
    }


def _build_prompt(source: BrokerStorageResolvedSource) -> str:
    preview = {
        "filename": source.filename,
        "detected_type": source.detected_type,
        "role": source.role,
        "sections": source.sections,
        "record_counts": source.record_counts,
        "warnings": source.warnings,
        "errors": source.errors,
    }
    return "\n".join(
        [
            "Sklasyfikuj lokalny plik brokerski dla InvestAnalyzer.",
            "Zwracaj tylko JSON zgodny ze schematem ai.document_classification.v1.",
            "Nie licz podatku i nie promuj pliku do PIT.",
            json.dumps(preview, ensure_ascii=False, default=str)[:6000],
        ]
    )


def classify_source_with_ai(source: BrokerStorageResolvedSource, *, client: Any) -> dict[str, Any]:
    payload = client.generate_structured(
        prompt=_build_prompt(source),
        schema=DOCUMENT_CLASSIFICATION_SCHEMA,
        task_name="document_classifier",
    )
    classification = validate_document_classification(payload)
    classification["file_sha256"] = source.hash
    classification["source_id"] = source.source_id
    classification["filename"] = source.filename
    classification["classification_method"] = "ollama"
    classification["ai_model"] = getattr(client, "model", None) or "unknown"
    classification["validation_status"] = "accepted"
    return classification


def build_document_classifications(
    sources: list[BrokerStorageResolvedSource],
    *,
    enabled: bool = False,
    client: Any | None = None,
) -> list[dict[str, Any]]:
    classifications: list[dict[str, Any]] = []
    for source in sources:
        deterministic = deterministic_document_classification(source)
        should_use_ai = enabled and client is not None and (
            deterministic["needs_user_review"] or source.role == "fallback" or source.detected_type in {"json", "spreadsheet"}
        )
        if not should_use_ai:
            classifications.append(deterministic)
            continue
        try:
            classifications.append(classify_source_with_ai(source, client=client))
        except Exception as exc:
            deterministic["classification_method"] = "deterministic_ai_unavailable"
            deterministic["validation_status"] = "ai_unavailable"
            deterministic["warnings"] = [*deterministic["warnings"], str(exc)]
            classifications.append(deterministic)
    return classifications


__all__ = [
    "AiDocumentClassificationError",
    "DOCUMENT_CLASSIFICATION_SCHEMA",
    "SCHEMA_VERSION",
    "build_document_classifications",
    "classify_source_with_ai",
    "deterministic_document_classification",
    "validate_document_classification",
]
