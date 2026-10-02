from __future__ import annotations

import pytest

from investment_tax_engine.ai.comment_context_extractor import (
    AiContextValidationError,
    build_ai_extracted_context,
    extract_context_for_event,
)
from investment_tax_engine.app.source_resolver import resolve_storage_sources
from investment_tax_engine.storage.transaction_intelligence import build_transaction_intelligence


class FakeOllamaClient:
    def __init__(self, payload=None, error: Exception | None = None):
        self.payload = payload
        self.error = error
        self.calls: list[dict] = []

    def generate_structured(self, *, prompt, schema, task_name):
        self.calls.append({"prompt": prompt, "schema": schema, "task_name": task_name})
        if self.error:
            raise self.error
        return dict(self.payload)


def _commission_event():
    return {
        "schema_version": "normalized_event.v1",
        "event_id": "event:commission-1",
        "event_kind": "commission",
        "source": {
            "filename": "Ruchy_gotówki.xlsx",
            "file_sha256": "abc",
            "parser": "cash_flows_xlsx",
            "row": "2",
        },
        "raw": {
            "raw_comment": "(Trade 651140653 buy NBIS.US) Market: usa, security type: stocks, commission currency: USD, service plan: Smart in USD",
            "raw_description": None,
            "raw_payload": {"Kwota": -2.8, "Waluta": "USD"},
        },
    }


def test_extract_context_for_event_accepts_schema_valid_high_confidence_response():
    client = FakeOllamaClient(
        {
            "schema_version": "ai.extracted_context.v1",
            "source_event_id": "event:commission-1",
            "detected_context_type": "trade_commission",
            "related_trade_id": "651140653",
            "related_order_id": None,
            "related_ticker": "NBIS.US",
            "operation": "buy",
            "fee_type": "trade_commission",
            "amount": 2.8,
            "currency": "USD",
            "extracted_terms": {
                "market": "usa",
                "security_type": "stocks",
                "service_plan": "Smart in USD",
                "commission_currency": "USD",
            },
            "summary_pl": "Prowizja powiazana z transakcja NBIS.US.",
            "confidence": 0.93,
            "needs_user_review": False,
            "warnings": [],
        }
    )

    context = extract_context_for_event(_commission_event(), client=client, min_confidence=0.8)

    assert context["validation_status"] == "accepted"
    assert context["related_trade_id"] == "651140653"
    assert context["related_ticker"] == "NBIS.US"
    assert context["ai_model"] == "unknown"
    assert client.calls[0]["task_name"] == "comment_context_extractor"
    assert "Ruchy_gotówki.xlsx" in client.calls[0]["prompt"]


def test_extract_context_for_event_rejects_low_confidence_response():
    client = FakeOllamaClient(
        {
            "schema_version": "ai.extracted_context.v1",
            "source_event_id": "event:commission-1",
            "detected_context_type": "trade_commission",
            "related_trade_id": "651140653",
            "related_order_id": None,
            "related_ticker": "NBIS.US",
            "operation": "buy",
            "fee_type": "trade_commission",
            "amount": 2.8,
            "currency": "USD",
            "extracted_terms": {},
            "summary_pl": "Niepewne powiazanie.",
            "confidence": 0.31,
            "needs_user_review": True,
            "warnings": [],
        }
    )

    context = extract_context_for_event(_commission_event(), client=client, min_confidence=0.8)

    assert context["validation_status"] == "rejected_low_confidence"
    assert context["needs_user_review"] is True
    assert any("confidence" in warning.lower() for warning in context["warnings"])


def test_extract_context_for_event_raises_for_invalid_schema_response():
    client = FakeOllamaClient({"schema_version": "wrong", "confidence": 0.9})

    with pytest.raises(AiContextValidationError):
        extract_context_for_event(_commission_event(), client=client)


def test_build_ai_extracted_context_reports_ollama_unavailable_without_crashing():
    client = FakeOllamaClient(error=TimeoutError("ollama timeout"))

    contexts = build_ai_extracted_context([_commission_event()], enabled=True, client=client)

    assert contexts
    assert contexts[0]["validation_status"] == "unavailable"
    assert contexts[0]["needs_user_review"] is True
    assert "ollama timeout" in contexts[0]["summary_pl"]


def test_build_ai_extracted_context_rejects_invalid_schema_without_crashing():
    client = FakeOllamaClient({"schema_version": "wrong", "confidence": 0.9})

    contexts = build_ai_extracted_context([_commission_event()], enabled=True, client=client)

    assert contexts
    assert contexts[0]["validation_status"] == "rejected_invalid_schema"
    assert contexts[0]["needs_user_review"] is True
    assert "contract" in contexts[0]["summary_pl"].lower()


def test_transaction_intelligence_can_attach_ai_context_when_enabled(tmp_path):
    import pandas as pd

    pd.DataFrame(
        [
            {
                "Data": "2025-06-17",
                "Typ": "Commission",
                "Kwota": -2.8,
                "Waluta": "USD",
                "Komentarz": "(Trade 651140653 buy NBIS.US) Market: usa, security type: stocks, commission currency: USD",
            }
        ]
    ).to_excel(tmp_path / "Ruchy_gotówki.xlsx", index=False)
    resolution = resolve_storage_sources(tmp_path, mode="canonical_stream")
    client = FakeOllamaClient(
        {
            "schema_version": "ai.extracted_context.v1",
            "source_event_id": "ignored-by-test",
            "detected_context_type": "trade_commission",
            "related_trade_id": "651140653",
            "related_order_id": None,
            "related_ticker": "NBIS.US",
            "operation": "buy",
            "fee_type": "trade_commission",
            "amount": 2.8,
            "currency": "USD",
            "extracted_terms": {"commission_currency": "USD"},
            "summary_pl": "Prowizja z komentarza ruchu gotowki.",
            "confidence": 0.91,
            "needs_user_review": False,
            "warnings": [],
        }
    )

    intelligence = build_transaction_intelligence(
        resolution.sources,
        tax_year=2025,
        ai_enabled=True,
        ai_client=client,
    )

    assert intelligence["ai_extracted_context"]
    assert intelligence["ai_extracted_context"][0]["validation_status"] == "accepted"
    assert intelligence["normalized_storage_manifest"][0]["ai_normalizer"]["status"] == "used"
    assert intelligence["source_registry"][0]["ollama_used"] is True
