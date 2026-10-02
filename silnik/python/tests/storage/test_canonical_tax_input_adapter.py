from __future__ import annotations

from investment_tax_engine.app.engine import InvestmentTaxEngine
from investment_tax_engine.app.canonical_tax_input_adapter import (
    build_parsed_sources_from_canonical_tax_input,
    canonical_tax_input_has_engine_records,
    records_awaiting_decision_impact,
)
from investment_tax_engine.models.core import EngineConfig, InputBundle


def _event(event_id: str, event_kind: str, raw: dict, *, source_id: str = "source:active") -> dict:
    return {
        "schema_version": "normalized_event.v1",
        "event_id": event_id,
        "event_kind": event_kind,
        "source": {
            "source_id": source_id,
            "filename": "historia_transakcji.json",
            "relative_path": "historia_transakcji.json",
            "section": "root",
            "sheet": None,
            "row": None,
        },
        "identity": {
            "trade_id": raw.get("id"),
            "order_id": raw.get("order_id"),
            "trade_nb": raw.get("trade_nb"),
        },
        "date": {"trade_date": raw.get("date") or raw.get("Data")},
        "instrument": {"ticker": raw.get("instr_nm") or raw.get("ticker")},
        "amounts": {
            "quantity": raw.get("q") or raw.get("Quantity"),
            "price": raw.get("p") or raw.get("Cena"),
            "gross": raw.get("v") or raw.get("Kwota"),
            "currency": raw.get("curr_c") or raw.get("waluta"),
        },
        "raw": {"raw_payload": raw},
        "status": {"needs_review": False},
    }


def test_canonical_tax_input_adapter_builds_legacy_parser_entries():
    tax_input = {
        "schema_version": "canonical_tax_input.v2",
        "records": [
            _event(
                "event:trade:1",
                "trade",
                {
                    "id": "T1",
                    "operation": "buy",
                    "instr_nm": "ABC.US",
                    "q": "2",
                    "p": "10",
                    "v": "20",
                    "curr_c": "USD",
                    "date": "2025-01-10",
                },
            ),
            _event(
                "event:fee:1",
                "commission",
                {
                    "Data": "2025-01-10",
                    "Kwota": "-2.50",
                    "waluta": "USD",
                    "Komentarz": "(Trade T1 buy ABC.US) commission",
                },
                source_id="source:support",
            ),
        ],
    }

    parsed, report = build_parsed_sources_from_canonical_tax_input(tax_input)

    assert canonical_tax_input_has_engine_records(tax_input) is True
    assert report["status"] == "used"
    assert report["consumedTradeEvents"] == 1
    # Prowizja pomniejsza dochod, wiec musi dotrzec do silnika razem z transakcja.
    assert report["consumedSupportEvents"] == 1
    assert {entry["source"] for entry in parsed} == {
        "CANONICAL_TAX_INPUT_TRADE",
        "CANONICAL_TAX_INPUT_EVENT",
    }


def test_canonical_adapter_reports_quantity_conflict_separately_from_dropped_events():
    api = _event("api", "trade", {
        "operation": "sell", "instr_nm": "ABC.US", "q": "4", "p": "10",
        "v": "40", "curr_c": "USD", "date": "2025-06-10",
    })
    api["source"] = {"filename": "api.json", "parser": "json"}
    report_row = _event("report", "trade", {
        "operation": "sell", "instr_nm": "ABC.US", "q": "5", "p": "11",
        "v": "55", "curr_c": "USD", "date": "2025-06-10",
    })
    report_row["source"] = {"filename": "report.json", "parser": "broker_report_json"}

    parsed, report = build_parsed_sources_from_canonical_tax_input({
        "schema_version": "canonical_tax_input.v2", "records": [api, report_row],
    })

    assert report["consumedTradeEvents"] == 1
    assert report["deduplicatedTradeEvents"] == 1
    assert report["sourceQuantityConflicts"][0]["kept_quantity"] == "4"
    assert report["sourceQuantityConflicts"][0]["dropped_quantity"] == "5"
    assert all("code" not in row for row in report["skipped"])
    assert len(parsed) == 1


def test_canonical_tax_input_adapter_rejects_ai_or_review_records():
    tax_input = {
        "schema_version": "canonical_tax_input.v2",
        "records": [
            {
                **_event("event:trade:review", "trade", {"id": "T2", "operation": "buy"}),
                "status": {"needs_review": True},
            }
        ],
        "ai_candidates": [{"candidate_id": "AI-1"}],
    }

    parsed, report = build_parsed_sources_from_canonical_tax_input(tax_input)

    assert parsed == []
    assert report["status"] == "fallback_legacy"


def test_reviewed_awards_and_current_year_actions_block_filing_but_old_action_warns():
    tax_input = {
        "schema_version": "canonical_tax_input.v2",
        "records": [
            {**_event("award", "stock_award", {"date": "2024-01-01", "q": "1", "instr_nm": "ABC.US"}), "status": {"needs_review": True}},
            {**_event("action-current", "corporate_action", {"date": "2026-03-01", "q": "1"}), "status": {"needs_review": True}},
            {**_event("action-old", "corporate_action", {"date": "2025-03-01", "q": "1"}), "status": {"needs_review": True}},
        ],
    }

    blocking, warning = records_awaiting_decision_impact(tax_input, 2026)

    assert blocking == {"corporate_action": 1, "stock_award": 1}
    assert warning == {"corporate_action": 1}


def test_canonical_tax_input_required_does_not_silent_fallback_to_legacy():
    tax_input = {
        "schema_version": "canonical_tax_input.v2",
        "records": [],
    }

    parsed, report = build_parsed_sources_from_canonical_tax_input(tax_input, canonical_mode="required")

    assert parsed == []
    assert report["status"] == "required_no_records"
    assert report["legacyFallbackUsed"] is False
    assert report["consumedByEngine"] is False


def test_engine_parse_sources_prefers_canonical_tax_input_when_consumable(tmp_path):
    tax_input = {
        "schema_version": "canonical_tax_input.v2",
        "records": [
            _event(
                "event:trade:1",
                "trade",
                {
                    "id": "T1",
                    "operation": "sell",
                    "instr_nm": "ABC.US",
                    "q": "1",
                    "p": "12",
                    "v": "12",
                    "curr_c": "USD",
                    "date": "2025-02-01",
                },
            )
        ],
    }
    bundle = InputBundle(
        api_json_path=tmp_path / "missing_api.json",
        trades_v1_path=tmp_path / "missing_trades.xlsx",
        trades_legacy_path=tmp_path / "missing_legacy.xlsx",
        tradernet_table_path=tmp_path / "missing_cash.xlsx",
        output_dir=tmp_path / "out",
        metadata={
            "canonical_tax_input": tax_input,
            "canonical_tax_input_mode": "prefer",
        },
    )
    engine = InvestmentTaxEngine(EngineConfig(run_mode="SAFE", tax_year=2025))

    validation = engine.validate_input_bundle(bundle)
    parsed = engine.parse_sources(bundle)

    assert validation.errors == []
    assert parsed[0]["source"] == "CANONICAL_TAX_INPUT_TRADE"
    assert bundle.metadata["canonical_tax_input_consumption_runtime"]["status"] == "used"


def test_engine_required_canonical_input_does_not_require_legacy_files(tmp_path):
    tax_input = {
        "schema_version": "canonical_tax_input.v2",
        "records": [],
    }
    bundle = InputBundle(
        api_json_path=tmp_path / "missing_api.json",
        trades_v1_path=tmp_path / "missing_trades.xlsx",
        trades_legacy_path=tmp_path / "missing_legacy.xlsx",
        tradernet_table_path=tmp_path / "missing_cash.xlsx",
        output_dir=tmp_path / "out",
        metadata={
            "canonical_tax_input": tax_input,
            "canonical_tax_input_mode": "required",
        },
    )
    engine = InvestmentTaxEngine(EngineConfig(run_mode="SAFE", tax_year=2025))

    validation = engine.validate_input_bundle(bundle)
    parsed = engine.parse_sources(bundle)

    assert validation.errors == []
    assert any(issue.code == "CANONICAL_TAX_INPUT_EMPTY" and issue.blocking is False for issue in validation.issues)
    assert parsed == []
    assert bundle.metadata["canonical_tax_input_consumption_runtime"]["status"] == "required_no_records"
    assert bundle.metadata["canonical_tax_input_consumption_runtime"]["legacyFallbackUsed"] is False


def test_user_decision_removes_event_from_blocking_queue_across_files():
    from investment_tax_engine.app.canonical_tax_input_adapter import (
        review_decision_key,
        review_queue,
    )

    award_a = {**_event("award-a", "stock_award", {"date": "2024-01-01", "q": "1", "instr_nm": "ABC.US"}), "status": {"needs_review": True}}
    award_b = {**_event("award-b", "stock_award", {"date": "2024-01-01", "q": "1", "instr_nm": "ABC.US"}), "status": {"needs_review": True}}
    action = {**_event("action-current", "corporate_action", {"date": "2026-03-01", "q": "1"}), "status": {"needs_review": True}}
    tax_input = {"schema_version": "canonical_tax_input.v2", "records": [award_a, award_b, action]}

    queue = review_queue(tax_input, 2026)
    # Ta sama akcja przyznana z dwoch plikow to jedna pozycja do decyzji.
    assert len(queue) == 2
    award_row = next(row for row in queue if row["kind"] == "stock_award")
    assert award_row["occurrences"] == 2
    assert award_row["blocks_filing"] is True
    assert award_row["decision"] is None

    key = review_decision_key(award_a)
    assert key == review_decision_key(award_b)
    blocking, _ = records_awaiting_decision_impact(tax_input, 2026, {key: "handled_manually"})
    assert blocking == {"corporate_action": 1}
    decided = review_queue(tax_input, 2026, {key: "handled_manually"})
    assert next(row for row in decided if row["kind"] == "stock_award")["decision"] == "handled_manually"

    # Nieznany rodzaj decyzji niczego nie odblokowuje.
    blocking_unknown, _ = records_awaiting_decision_impact(tax_input, 2026, {key: "whatever"})
    assert blocking_unknown == {"corporate_action": 1, "stock_award": 2}
