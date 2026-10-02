from __future__ import annotations

import pandas as pd

from investment_tax_engine.ai.column_mapper import deterministic_column_mapping, validate_column_mapping
from investment_tax_engine.ai.document_classifier import (
    deterministic_document_classification,
    validate_document_classification,
)
from investment_tax_engine.app.source_resolver import resolve_storage_sources
from investment_tax_engine.storage.transaction_intelligence import build_transaction_intelligence


def test_deterministic_document_classifier_recognizes_user_storage_roles(tmp_path):
    pd.DataFrame(
        [
            {
                "Execution time": "2025-06-17",
                "Operation": "Buy",
                "Instrument name": "NBIS.US",
                "Quantity": 2,
                "Price": 10,
                "Amount": 20,
                "Currency": "USD",
            }
        ]
    ).to_excel(tmp_path / "Transakcje.xlsx", index=False)
    (tmp_path / "Stawki.pdf").write_bytes(b"%PDF-1.4\n")

    resolution = resolve_storage_sources(tmp_path, mode="canonical_stream")
    classifications = [
        deterministic_document_classification(source)
        for source in resolution.sources
    ]

    by_file = {classification["filename"]: classification for classification in classifications}
    assert by_file["Transakcje.xlsx"]["document_kind"] == "transactions"
    assert by_file["Transakcje.xlsx"]["contains_investment_transactions"] is True
    assert by_file["Stawki.pdf"]["document_kind"] == "fee_table"
    assert by_file["Stawki.pdf"]["source_role"] == "evidence"
    validate_document_classification(by_file["Transakcje.xlsx"])


def test_deterministic_column_mapper_maps_broker_headers_without_ai():
    mapping = deterministic_column_mapping(
        file_sha256="abc",
        sheet_name="Sheet1",
        headers=[
            "Execution time",
            "Operation",
            "Instrument name",
            "Quantity",
            "Price",
            "Amount",
            "Currency",
            "Operation ID",
        ],
    )

    assert mapping["mapped_columns"]["date"] == "Execution time"
    assert mapping["mapped_columns"]["ticker"] == "Instrument name"
    assert mapping["mapped_columns"]["transaction_id"] == "Operation ID"
    assert mapping["confidence"] >= 0.8
    validate_column_mapping(mapping)


def test_transaction_intelligence_writes_ai_classification_mapping_and_validation_report(tmp_path):
    pd.DataFrame(
        [
            {
                "Execution time": "2025-06-17",
                "Operation": "Buy",
                "Instrument name": "NBIS.US",
                "Quantity": 2,
                "Price": 10,
                "Amount": 20,
                "Currency": "USD",
                "Operation ID": "651140653",
            }
        ]
    ).to_excel(tmp_path / "Transakcje.xlsx", index=False)
    resolution = resolve_storage_sources(tmp_path, mode="canonical_stream")

    intelligence = build_transaction_intelligence(resolution.sources, tax_year=2025)

    assert intelligence["ai_document_classification"]
    assert intelligence["ai_column_mappings"]
    assert intelligence["ai_validation_report"]["schema_version"] == "ai.validation_report.v1"
    assert intelligence["ai_validation_report"]["safe_tax_policy"]["allow_ai_to_promote_to_pit"] is False
