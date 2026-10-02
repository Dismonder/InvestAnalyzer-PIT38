from __future__ import annotations

import json
from typing import Any


SCHEMA_VERSION = "ai.extracted_context.v1"

CONTEXT_TYPES = {
    "trade_commission",
    "negative_balance_interest",
    "bank_transfer",
    "internal_transfer",
    "stock_award",
    "maturity",
    "tariff_rule",
    "margin_rule",
    "generic_comment",
    "unknown",
}
OPERATIONS = {"buy", "sell", "fx", "transfer", "fee", "interest", "award", "maturity", "unknown"}
FEE_TYPES = {"trade_commission", "transfer_fee", "margin_interest", "custody", "otc", "other", None}

EXTRACTED_CONTEXT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": True,
    "required": [
        "schema_version",
        "source_event_id",
        "detected_context_type",
        "operation",
        "summary_pl",
        "confidence",
        "needs_user_review",
        "warnings",
    ],
    "properties": {
        "schema_version": {"const": SCHEMA_VERSION},
        "source_event_id": {"type": "string"},
        "detected_context_type": {"enum": sorted(CONTEXT_TYPES)},
        "related_trade_id": {"type": ["string", "null"]},
        "related_order_id": {"type": ["string", "null"]},
        "related_ticker": {"type": ["string", "null"]},
        "operation": {"enum": sorted(OPERATIONS)},
        "fee_type": {"enum": sorted(value for value in FEE_TYPES if value is not None) + [None]},
        "amount": {"type": ["number", "null"]},
        "currency": {"type": ["string", "null"]},
        "extracted_terms": {"type": "object"},
        "summary_pl": {"type": "string"},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "needs_user_review": {"type": "boolean"},
        "warnings": {"type": "array", "items": {"type": "string"}},
    },
}


class AiContextValidationError(ValueError):
    pass


def _require_string(payload: dict[str, Any], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise AiContextValidationError(f"AI context field '{key}' must be a non-empty string.")
    return value.strip()


def _optional_string(payload: dict[str, Any], key: str) -> str | None:
    value = payload.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise AiContextValidationError(f"AI context field '{key}' must be a string or null.")
    return value.strip() or None


def validate_extracted_context(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise AiContextValidationError("AI context must be a JSON object.")
    if payload.get("schema_version") != SCHEMA_VERSION:
        raise AiContextValidationError("AI context contract version mismatch.")

    detected_context_type = _require_string(payload, "detected_context_type")
    if detected_context_type not in CONTEXT_TYPES:
        raise AiContextValidationError(f"Unsupported AI context type: {detected_context_type}.")

    operation = _require_string(payload, "operation").lower()
    if operation not in OPERATIONS:
        raise AiContextValidationError(f"Unsupported AI operation: {operation}.")

    fee_type = payload.get("fee_type")
    if fee_type not in FEE_TYPES:
        raise AiContextValidationError(f"Unsupported AI fee type: {fee_type}.")

    confidence = payload.get("confidence")
    if not isinstance(confidence, (int, float)) or isinstance(confidence, bool):
        raise AiContextValidationError("AI context confidence must be a number.")
    if confidence < 0 or confidence > 1:
        raise AiContextValidationError("AI context confidence must be between 0 and 1.")

    needs_user_review = payload.get("needs_user_review")
    if not isinstance(needs_user_review, bool):
        raise AiContextValidationError("AI context needs_user_review must be a boolean.")

    warnings = payload.get("warnings")
    if not isinstance(warnings, list) or any(not isinstance(warning, str) for warning in warnings):
        raise AiContextValidationError("AI context warnings must be a list of strings.")

    extracted_terms = payload.get("extracted_terms")
    if extracted_terms is None:
        extracted_terms = {}
    if not isinstance(extracted_terms, dict):
        raise AiContextValidationError("AI context extracted_terms must be an object.")

    normalized = {
        "schema_version": SCHEMA_VERSION,
        "source_event_id": _require_string(payload, "source_event_id"),
        "detected_context_type": detected_context_type,
        "related_trade_id": _optional_string(payload, "related_trade_id"),
        "related_order_id": _optional_string(payload, "related_order_id"),
        "related_ticker": _optional_string(payload, "related_ticker"),
        "operation": operation,
        "fee_type": fee_type,
        "amount": payload.get("amount"),
        "currency": _optional_string(payload, "currency"),
        "extracted_terms": extracted_terms,
        "summary_pl": _require_string(payload, "summary_pl"),
        "confidence": float(confidence),
        "needs_user_review": needs_user_review,
        "warnings": warnings,
    }
    amount = normalized["amount"]
    if amount is not None and not isinstance(amount, (int, float)):
        raise AiContextValidationError("AI context amount must be a number or null.")
    return normalized


def unavailable_context(source_event_id: str, reason: str = "Ollama disabled") -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "source_event_id": source_event_id,
        "detected_context_type": "unknown",
        "related_trade_id": None,
        "related_order_id": None,
        "related_ticker": None,
        "operation": "unknown",
        "fee_type": None,
        "amount": None,
        "currency": None,
        "extracted_terms": {},
        "summary_pl": reason,
        "confidence": 0.0,
        "needs_user_review": True,
        "warnings": [reason],
        "validation_status": "unavailable",
        "ai_model": None,
    }


def rejected_context(source_event_id: str, reason: str, *, status: str = "rejected_invalid_schema") -> dict[str, Any]:
    context = unavailable_context(source_event_id, reason)
    context["validation_status"] = status
    context["detected_context_type"] = "unknown"
    context["summary_pl"] = reason
    return context


def _event_comment(event: dict[str, Any]) -> str | None:
    raw = event.get("raw") or {}
    comment = raw.get("raw_comment") or raw.get("raw_description")
    if comment:
        return str(comment)
    payload = raw.get("raw_payload")
    if isinstance(payload, dict):
        for key in ("comment", "Komentarz", "description", "Opis", "details"):
            value = payload.get(key)
            if value:
                return str(value)
    return None


def _build_prompt(event: dict[str, Any]) -> str:
    source = event.get("source") or {}
    raw = event.get("raw") or {}
    raw_payload = raw.get("raw_payload") or {}
    trimmed_payload = json.dumps(raw_payload, ensure_ascii=False, default=str)[:6000]
    return "\n".join(
        [
            "Wyodrebnij semantyczny kontekst zdarzenia brokerskiego.",
            "Zwracaj wylacznie JSON zgodny ze schematem ai.extracted_context.v1.",
            "Nie licz podatku i nie promuj rekordu do PIT.",
            f"source_event_id: {event.get('event_id')}",
            f"plik: {source.get('filename')}",
            f"parser: {source.get('parser')}",
            f"typ_zdarzenia: {event.get('event_kind')}",
            f"komentarz: {_event_comment(event) or ''}",
            f"raw_payload: {trimmed_payload}",
        ]
    )


def extract_context_for_event(
    event: dict[str, Any],
    *,
    client: Any,
    min_confidence: float = 0.8,
) -> dict[str, Any]:
    payload = client.generate_structured(
        prompt=_build_prompt(event),
        schema=EXTRACTED_CONTEXT_SCHEMA,
        task_name="comment_context_extractor",
    )
    context = validate_extracted_context(payload)
    context["source_event_id"] = str(event.get("event_id") or context["source_event_id"])
    context["ai_model"] = getattr(client, "model", None) or "unknown"
    context["prompt_version"] = "comment_context_extractor.v1"
    context["validation_status"] = "accepted"
    if context["confidence"] < min_confidence:
        context["validation_status"] = "rejected_low_confidence"
        context["needs_user_review"] = True
        context["warnings"] = [
            *context["warnings"],
            f"AI confidence {context['confidence']:.2f} below required {min_confidence:.2f}.",
        ]
    return context


def build_ai_extracted_context(
    events: list[dict[str, Any]],
    *,
    enabled: bool = False,
    client: Any | None = None,
    min_confidence: float = 0.8,
    max_events: int = 200,
) -> list[dict[str, Any]]:
    if not enabled:
        return []
    if client is None:
        from investment_tax_engine.ai.ollama_client import OllamaClient

        client = OllamaClient.from_environment()

    contexts: list[dict[str, Any]] = []
    for event in events:
        if len(contexts) >= max_events:
            break
        if not _event_comment(event):
            continue
        try:
            contexts.append(extract_context_for_event(event, client=client, min_confidence=min_confidence))
        except AiContextValidationError as exc:
            contexts.append(rejected_context(str(event.get("event_id") or "unknown"), str(exc)))
        except Exception as exc:
            contexts.append(unavailable_context(str(event.get("event_id") or "unknown"), str(exc)))
            break
    return contexts


__all__ = [
    "AiContextValidationError",
    "EXTRACTED_CONTEXT_SCHEMA",
    "SCHEMA_VERSION",
    "build_ai_extracted_context",
    "extract_context_for_event",
    "rejected_context",
    "unavailable_context",
    "validate_extracted_context",
]
