from __future__ import annotations

import json
import zipfile
from decimal import Decimal
from pathlib import Path

import pandas as pd
import pytest
import investment_tax_engine.storage.transaction_intelligence as transaction_intelligence

from investment_tax_engine.app.source_resolver import resolve_storage_sources
from investment_tax_engine.app.source_resolver import BrokerStorageResolvedSource
from investment_tax_engine.normalize.trades import parse_amount
from investment_tax_engine.storage.transaction_intelligence import (
    _date_text,
    _source_rows,
    _timestamp_from_row,
    build_canonical_tax_input,
    build_tax_input_build_report,
    build_transaction_intelligence,
    sources_that_failed_to_read,
    write_transaction_intelligence_outputs,
    build_canonical_tax_input_summary,
)


def test_storage_kwot_i_dat_uzywa_znaku_i_parsera_liczbowego():
    for minus in ("−", "‒", "–", "﹣", "－"):
        assert transaction_intelligence._decimal_from_value(f"{minus}123.45") == Decimal("-123.45")
    assert _timestamp_from_row({"date": 46024}).isoformat() == "2026-01-02T00:00:00"


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("1,234", Decimal("1234")),
        ("(123.45)", Decimal("-123.45")),
        ("123.45-", Decimal("-123.45")),
        ("1,234,567", Decimal("1234567")),
        ("1 234,56", Decimal("1234.56")),
        ("−5", Decimal("-5")),
        (1234, Decimal("1234")),
        (1234.56, Decimal("1234.56")),
        ("5%", None),
        (None, None),
        ("  ", None),
    ],
)
def test_storage_kwoty_sa_zgodne_z_parse_amount(value, expected):
    assert parse_amount(value) == expected
    assert transaction_intelligence._decimal_from_value(value) == expected


def test_complete_trade_with_unknown_side_blocks_but_position_snapshot_does_not():
    def record(quantity: int, *, snapshot: bool = False) -> dict:
        entry = {
            "event_kind": "trade", "instrument": {"ticker": "ABC"},
            "amounts": {"quantity": quantity, "currency": "USD", "price": 10},
            "date": {"trade_date": "2025-01-02"}, "raw": {"raw_payload": {}},
            "source": {"filename": "synthetic.csv"},
        }
        if snapshot:
            entry["date"] = {}
            entry["amounts"].pop("price")
        errors = transaction_intelligence._engine_record_validation_errors(entry)
        return {**entry, "canonical_record_status": "incomplete", "validation_errors": errors}

    for quantity in (2, -2):
        complete = record(quantity)
        assert complete["validation_errors"] == ["missing_buy_sell_operation"]
        assert build_canonical_tax_input_summary({"records": [complete]})["blockingIncompleteRecordCount"] == 1
    snapshot = record(2, snapshot=True)
    assert {"missing_tax_event_date", "missing_price_or_amount"} <= set(snapshot["validation_errors"])
    assert build_canonical_tax_input_summary({"records": [snapshot]})["blockingIncompleteRecordCount"] == 0


def test_stock_award_and_corporate_action_codes_do_not_block_as_unknown_trades():
    # Prawdziwy magazyn: 9 akcji przyznanych (stock_award) i 4 zdarzenia
    # korporacyjne (maturity, "Termin zapadalnosci") z instrumentem i iloscia
    # blokowaly jako "nierozpoznana transakcja", choc czekaja juz na decyzje
    # w przegladzie - tej blokady nie dalo sie zdjac.
    def record(event_kind: str, code: str) -> dict:
        return {
            "event_kind": event_kind, "instrument": {"ticker": "PTON.US"},
            "amounts": {"quantity": "1", "currency": "USD"},
            "date": {"trade_date": "2025-06-02"}, "raw": {"raw_payload": {"type": code}},
            "source": {"filename": "broker.json"}, "canonical_record_status": "incomplete",
            "validation_errors": ["not_calculation_record"],
        }

    records = [record("stock_award", "stock_award"), record("corporate_action", "maturity"),
               record("corporate_action", "Termin zapadalności")]
    summary = build_canonical_tax_input_summary({"records": records})
    assert summary["blockingIncompleteRecordCount"] == 0
    assert summary["unrecognizedOperationRecords"] == []
    # Ta sama operacja jako rekord transakcji nadal blokuje.
    trade = {**record("trade", "reverse_split"), "amounts": {"quantity": "10", "currency": "USD", "price": 0},
             "validation_errors": ["missing_buy_sell_operation"]}
    assert build_canonical_tax_input_summary({"records": [trade]})["blockingIncompleteRecordCount"] == 1
from investment_tax_engine.validation.quality_gates import INPUT_INTEGRITY_GATE_CODES


def _write_user_storage_fixture(tmp_path):
    pd.DataFrame(
        [
            {
                "Execution time": "2025-06-17 14:30:00",
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
    pd.DataFrame(
        [
            {
                "Data": "2025-06-17",
                "Typ": "Commission",
                "Kwota": -2.8,
                "Waluta": "USD",
                "Komentarz": "(Trade 651140653 buy NBIS.US) Market: usa, security type: stocks, commission currency: USD, service plan: Smart in USD",
            }
        ]
    ).to_excel(tmp_path / "Ruchy_gotówki.xlsx", index=False)
    (tmp_path / "broker_raport_bezbliansu.json").write_text(
        json.dumps(
            {
                "trades": [
                    {
                        "id": "651140653",
                        "order_id": "O-1",
                        "operation": "buy",
                        "instr_nm": "NBIS.US",
                        "q": "2",
                        "p": "10",
                        "v": "20",
                        "curr_c": "USD",
                        "date": "2025-06-17",
                        "comment": "No fee on OTC trades in D accounts is charged",
                    }
                ],
                "cash_flows": [],
                "commissions": [],
                "securities_in_outs": [
                    {
                        "transaction_id": "AWARD-1",
                        "date": "2025-07-01",
                        "instr_nm": "PTON.US",
                        "q": "1",
                        "comment": "stock_award contest shares",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    (tmp_path / "dezpozytariusz_raport_zbilansem.json").write_text(
        json.dumps({"depoData": [{"ticker": "NBIS.US", "date": "2025-06-18", "depo_at_end": 2}]}),
        encoding="utf-8",
    )
    (tmp_path / "Stawki.pdf").write_bytes(b"%PDF-1.4\n")


def test_transaction_intelligence_builds_events_dossier_field_sources_and_evidence(tmp_path):
    _write_user_storage_fixture(tmp_path)

    resolution = resolve_storage_sources(tmp_path, mode="canonical_stream")
    intelligence = build_transaction_intelligence(resolution.sources, tax_year=2025)

    events = intelligence["normalized_events"]
    assert any(event["event_kind"] == "trade" and event["instrument"]["ticker"] == "NBIS.US" for event in events)
    assert any(event["event_kind"] in {"commission", "cash_movement"} for event in events)
    assert not any(
        event["event_kind"] == "trade" and event["source"]["filename"] == "Ruchy_gotówki.xlsx"
        for event in events
    )
    assert any(event["event_kind"] == "position_snapshot" for event in events)
    assert any(event["event_kind"] == "tariff_evidence" for event in events)

    dossiers = intelligence["transaction_dossiers"]
    nbis_dossier = next(
        dossier for dossier in dossiers if dossier["core_trade"]["ticker"] == "NBIS.US"
    )
    assert nbis_dossier["identity"]["primary_trade_id"] == "651140653"
    assert nbis_dossier["fees_and_costs"]["cash_movement_fees"]
    assert nbis_dossier["comments_and_descriptions"]["broker_comments"]
    assert nbis_dossier["position_context"]["reconciliation_status"] in {"ok", "warning", "unknown"}
    assert nbis_dossier["review"]["safe_for_tax_engine"] is True

    field_source_map = intelligence["field_source_map"]
    dossier_sources = field_source_map[nbis_dossier["canonical_transaction_id"]]
    assert "core_trade.price" in dossier_sources
    assert dossier_sources["core_trade.price"][0]["source_file"]
    assert "fees_and_costs.broker_commission.amount" in dossier_sources

    evidence = intelligence["evidence_index"]
    assert any(item["filename"] == "Stawki.pdf" and item["evidence_kind"] == "tariff_pdf" for item in evidence)


def _resolved_tabular_source(path, detected_type="broker_transactions_xlsx"):
    return BrokerStorageResolvedSource(
        source_id=path.name,
        filename=path.name,
        relative_path=path.name,
        path=str(path),
        role="transaction_source" if detected_type == "broker_transactions_xlsx" else "data_context",
        detected_type=detected_type,
        score=100,
        reason="test fixture",
    )


def test_transaction_csv_is_read_and_unreadable_csv_is_a_blocking_input_error(tmp_path):
    csv_path = tmp_path / "transakcje.csv"
    csv_path.write_text(
        "Data;Operation;Instrument name;Quantity\n01/02/2024;Buy;ABC.US;2\n",
        encoding="utf-8",
    )
    parsed = _source_rows(_resolved_tabular_source(csv_path))
    assert len(parsed) == 1
    assert parsed[0][0]["Instrument name"] == "ABC.US"
    assert parsed[0][1] == "csv"

    unreadable_path = tmp_path / "transakcje_uszkodzone.csv"
    unreadable_path.write_bytes(b"Data;Operation\n\x81;Buy\n")
    unreadable = _source_rows(_resolved_tabular_source(unreadable_path))
    assert len(unreadable) == 1 and unreadable[0][1] == "read_error"
    assert "SOURCE_INPUT_READ_FAILED" in INPUT_INTEGRITY_GATE_CODES
    failures = sources_that_failed_to_read([_resolved_tabular_source(unreadable_path)])
    assert failures[0]["blocking"] is True
    assert failures[0]["code"] == "SOURCE_INPUT_READ_FAILED"

    empty_path = tmp_path / "transakcje_puste.csv"
    empty_path.write_text("Data;Operation\n", encoding="utf-8")
    empty = _source_rows(_resolved_tabular_source(empty_path))
    assert len(empty) == 1 and empty[0][1] == "read_error"


def test_spreadsheet_row_limit_keeps_all_rows_or_blocks_without_truncation(tmp_path, monkeypatch):
    path = tmp_path / "multi.xlsx"
    with pd.ExcelWriter(path) as writer:
        pd.DataFrame({"value": [1, 2]}).to_excel(writer, sheet_name="one", index=False)
        pd.DataFrame({"value": [3, 4]}).to_excel(writer, sheet_name="two", index=False)
    source = _resolved_tabular_source(path)
    monkeypatch.setattr(transaction_intelligence, "MAX_SPREADSHEET_ROWS_PER_FILE", 4)
    parsed = _source_rows(source)
    assert len(parsed) == 4
    assert [row[0]["value"] for row in parsed] == [1, 2, 3, 4]

    with pd.ExcelWriter(path) as writer:
        pd.DataFrame({"value": [1, 2, 3]}).to_excel(writer, sheet_name="one", index=False)
        pd.DataFrame({"value": [4, 5, 6]}).to_excel(writer, sheet_name="two", index=False)
    parsed = _source_rows(source)
    assert len(parsed) == 1 and parsed[0][1] == "read_error"
    assert "multi.xlsx" in parsed[0][0]["error"]
    assert "5" in parsed[0][0]["error"]
    failures = sources_that_failed_to_read([source])
    assert failures[0]["blocking"] is True
    assert failures[0]["code"] == "SOURCE_INPUT_TOO_LARGE"
    assert "SOURCE_INPUT_TOO_LARGE" in INPUT_INTEGRITY_GATE_CODES


def test_spreadsheet_zip_bomb_blocks_before_excel_parser(tmp_path, monkeypatch):
    path = tmp_path / "bombowy.xlsx"
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("xl/worksheets/sheet1.xml", b"A" * (17 * 1024 * 1024))

    def unexpected_excel_file(*args, **kwargs):
        pytest.fail("Pandas nie powinien otwierac zbyt duzego archiwum")

    monkeypatch.setattr(transaction_intelligence.pd, "ExcelFile", unexpected_excel_file)
    source = _resolved_tabular_source(path)
    rows = _source_rows(source)
    assert len(rows) == 1 and rows[0][1] == "read_error"
    assert rows[0][0]["error"].startswith("SOURCE_INPUT_TOO_LARGE:")
    failures = sources_that_failed_to_read([source])
    assert failures[0]["code"] == "SOURCE_INPUT_TOO_LARGE"
    assert failures[0]["blocking"] is True


def test_spreadsheet_zip_checks_total_uncompressed_size(tmp_path, monkeypatch):
    path = tmp_path / "suma.xlsx"
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as archive:
        for index in range(3):
            archive.writestr(f"xl/worksheets/sheet{index}.xml", b"A" * 1024 * 1024)
    monkeypatch.setattr(transaction_intelligence, "MAX_SPREADSHEET_UNCOMPRESSED_BYTES", 2 * 1024 * 1024)

    rows = _source_rows(_resolved_tabular_source(path))
    assert len(rows) == 1 and rows[0][1] == "read_error"
    assert rows[0][0]["error"].startswith("SOURCE_INPUT_TOO_LARGE:")


def test_zwykly_arkusz_testowy_nie_jest_blokowany_przez_limit_zip():
    path = Path(__file__).resolve().parents[4] / "jakosc" / "dane-testowe" / "wyciag-v1.xlsx"
    rows = _source_rows(_resolved_tabular_source(path))
    assert rows
    assert all(section != "read_error" for _, section, _, _ in rows)


def test_storage_dates_use_shared_day_first_parser():
    assert _timestamp_from_row({"date": "01/02/2024"}) == pd.Timestamp("2024-02-01")
    assert _date_text({"date": "01/02/2024"}, "date") == "2024-02-01"


def test_spreadsheet_sources_read_all_sheets_and_rows_without_truncation(tmp_path):
    path = tmp_path / "Transakcje.xlsx"
    with pd.ExcelWriter(path) as writer:
        for sheet_index in range(13):
            pd.DataFrame({"Execution time": ["2024-01-01"] * 160, "Operation": ["Buy"] * 160}).to_excel(
                writer, sheet_name=f"Sheet{sheet_index}", index=False
            )

    rows = _source_rows(_resolved_tabular_source(path))
    assert len(rows) == 2080
    assert len({row[3] for row in rows}) == 13


def test_transaction_intelligence_reports_conflicts_without_changing_tax_source(tmp_path):
    (tmp_path / "broker_raport_bezbliansu.json").write_text(
        json.dumps(
            {
                "trades": [
                    {
                        "id": "T-CONFLICT",
                        "operation": "sell",
                        "instr_nm": "ABC.US",
                        "q": "1",
                        "p": "10",
                        "v": "10",
                        "curr_c": "USD",
                        "date": "2025-03-01",
                    }
                ],
                "cash_flows": [],
                "commissions": [],
            }
        ),
        encoding="utf-8",
    )
    pd.DataFrame(
        [
            {
                "Execution time": "2025-03-01",
                "Operation": "Sell",
                "Instrument name": "ABC.US",
                "Quantity": 1,
                "Price": 11,
                "Amount": 11,
                "Currency": "USD",
                "Operation ID": "T-CONFLICT",
            }
        ]
    ).to_excel(tmp_path / "Transakcje.xlsx", index=False)

    resolution = resolve_storage_sources(tmp_path, mode="canonical_stream")
    intelligence = build_transaction_intelligence(resolution.sources, tax_year=2025)

    conflicts = intelligence["transaction_conflicts"]
    assert any(conflict["field"] == "core_trade.price" for conflict in conflicts)
    assert intelligence["transaction_dossier_summary"]["conflictCount"] >= 1


def test_transaction_intelligence_marks_nbp_archives_as_nbp_rates(tmp_path):
    (tmp_path / "archiwum_tab_a_2025.csv").write_text(
        "data,USD,EUR\n2025-01-02,4.00,4.30\n",
        encoding="utf-8",
    )

    resolution = resolve_storage_sources(tmp_path, mode="canonical_stream")
    intelligence = build_transaction_intelligence(resolution.sources, tax_year=2025)

    assert any(event["event_kind"] == "nbp_rate" for event in intelligence["normalized_events"])
    manifest_entry = next(
        entry
        for entry in intelligence["normalized_storage_manifest"]
        if entry["original_filename"] == "archiwum_tab_a_2025.csv"
    )
    assert manifest_entry["final_role"] == "nbp_rates"
    assert manifest_entry["import_status"] == "accepted"
    assert manifest_entry["recognition_status"] == "recognized"
    assert "pit_eligibility" not in manifest_entry
    assert "pit_impact" not in manifest_entry


def test_canonical_tax_input_keeps_ai_and_context_out_of_tax_active(tmp_path):
    _write_user_storage_fixture(tmp_path)

    resolution = resolve_storage_sources(tmp_path, mode="canonical_stream")
    intelligence = build_transaction_intelligence(resolution.sources, tax_year=2025)
    intelligence["canonical_storage_history"] = [
        {
            "row_id": "tax-row-1",
            "tax_impact_kind": "PIT_COUNTED",
            "source_refs": ["source:active"],
            "provenance": [{"filename": "historia_transakcji.json"}],
        },
        {
            "row_id": "candidate-row-1",
            "tax_impact_kind": "CANDIDATE_PREVIEW",
            "source_refs": ["source:candidate"],
            "provenance": [{"filename": "broker_raport_bezbliansu.json"}],
        },
        {
            "row_id": "context-row-1",
            "tax_impact_kind": "EVIDENCE",
            "source_refs": ["source:pdf"],
            "provenance": [{"filename": "Stawki.pdf"}],
        },
    ]
    intelligence["ai_extracted_context"] = [
        {
            "schema_version": "ai.extracted_context.v1",
            "source_event_id": "event:1",
            "confidence": 0.95,
            "validation_status": "accepted",
        }
    ]
    intelligence["source_registry"].append(
        {
            "source_id": "source:incomplete",
            "filename": "unknown.xlsx",
            "file_sha256": "incomplete",
            "source_role": "candidate_tax",
            "detected_type": "broker_transactions_xlsx",
            "import_status": "accepted",
            "recognition_status": "recognized",
            "pit_eligibility": "tax_candidate",
            "pit_impact": "candidate",
        }
    )
    intelligence["normalized_events"].append(
        {
            "schema_version": "normalized_event.v1",
            "event_id": "event:incomplete",
            "event_kind": "trade",
            "source": {"source_id": "source:incomplete", "filename": "unknown.xlsx"},
            "identity": {"trade_id": "T-INCOMPLETE"},
            "date": {"trade_date": "2025-06-17"},
            "instrument": {"ticker": "MISS.US"},
            "amounts": {"quantity": None, "price": 10, "gross": 20, "currency": "USD"},
            "raw": {"raw_payload": {"operation": "buy", "date": "2025-06-17", "instr_nm": "MISS.US"}},
            "status": {"needs_review": False},
        }
    )

    tax_input = build_canonical_tax_input(intelligence)

    assert tax_input["schema_version"] == "canonical_tax_input.v2"
    assert tax_input["data_policy"]["single_record_stream"] is True
    assert tax_input["engine_contract"]["record_path"] == "records"
    assert isinstance(tax_input["records"], list)
    assert tax_input["ai_candidates"][0]["canonical_record_status"] == "ai_context"
    assert "event:incomplete" in {event["event_id"] for event in tax_input["records"]}
    incomplete = next(event for event in tax_input["records"] if event["event_id"] == "event:incomplete")
    assert incomplete["canonical_record_status"] == "incomplete"
    assert "missing_or_zero_quantity" in incomplete["validation_errors"]
    assert tax_input["summary"]["recordCount"] >= 1
    assert tax_input["summary"]["engineInputMode"] == "required"
    assert "engineReadyRecordCount" in tax_input["summary"]
    assert tax_input["summary"]["incompleteRecordCount"] >= 1
    assert "unrecognizedRecordCount" in tax_input["summary"]

    report = build_tax_input_build_report(tax_input)
    assert report["input_file"] == "canonical_tax_input.json"
    assert report["engineInputMode"] == "required"
    assert report["legacyFallbackUsed"] is False
    assert report["readiness"]["has_engine_ready_records"] is True


def test_canonical_tax_input_preserves_unrecognized_rows_without_raising():
    intelligence = {
        "normalized_events": [
            {
                "schema_version": "normalized_event.v1",
                "event_id": "event:bad-row",
                "event_kind": "unknown",
                "source": {"source_id": "source:bad", "filename": "weird.csv", "parser": "csv"},
                "raw": {"raw_payload": {"A": "???", "B": object()}},
                "status": {"normalized": False, "needs_review": True, "errors": ["bad_business_data"]},
            }
        ],
        "source_registry": [
            {
                "source_id": "source:bad",
                "filename": "weird.csv",
                "detected_type": "csv",
                "import_status": "accepted_with_notes",
                "recognition_status": "needs_mapping",
                "pit_eligibility": "needs_review",
                "pit_impact": "context_only",
            }
        ],
    }

    tax_input = build_canonical_tax_input(intelligence)

    assert tax_input["schema_version"] == "canonical_tax_input.v2"
    assert len(tax_input["records"]) == 1
    assert tax_input["records"][0]["canonical_record_status"] == "unrecognized"
    assert tax_input["summary"]["unrecognizedRecordCount"] == 1


def test_transaction_intelligence_writes_canonical_tax_input_artifacts(tmp_path):
    _write_user_storage_fixture(tmp_path)
    resolution = resolve_storage_sources(tmp_path, mode="canonical_stream")
    intelligence = build_transaction_intelligence(resolution.sources, tax_year=2025)
    intelligence["canonical_storage_history"] = [
        {
            "row_id": "tax-row-1",
            "tax_impact_kind": "PIT_COUNTED",
            "source_refs": ["source:active"],
            "provenance": [{"filename": "historia_transakcji.json"}],
        }
    ]
    intelligence["canonical_tax_input"] = build_canonical_tax_input(intelligence)
    intelligence["canonical_tax_input_summary"] = intelligence["canonical_tax_input"]["summary"]
    intelligence["tax_input_build_report"] = build_tax_input_build_report(intelligence["canonical_tax_input"])

    out_dir = tmp_path / "out"
    written = write_transaction_intelligence_outputs(intelligence, out_dir)
    written_names = {path.name for path in written}

    assert "canonical_tax_input.json" in written_names
    assert "canonical_tax_input_summary.json" in written_names
    assert "tax_input_build_report.json" in written_names
    parsed = json.loads((out_dir / "canonical_tax_input.json").read_text(encoding="utf-8"))
    assert parsed["engine_contract"]["input_file"] == "canonical_tax_input.json"


def test_outputs_are_serialized_once_into_run_dir_and_mirror(tmp_path: Path) -> None:
    # Kopia w dane/out dostaje ten sam tekst co katalog przebiegu - bez drugiej
    # serializacji ok. 90 MB danych przy kazdym przebiegu.
    payload = {"canonical_tax_input": {"engine_contract": {"input_file": "canonical_tax_input.json"}}, "normalized_events": [{"a": 1}, {"b": "ż"}]}
    out_dir, mirror = tmp_path / "run", tmp_path / "mirror"
    written = write_transaction_intelligence_outputs(payload, out_dir, [mirror])
    assert all(path.parent == out_dir for path in written)
    for name in ("canonical_tax_input.json", "normalized_events.jsonl", "source_registry.json"):
        assert (out_dir / name).read_bytes() == (mirror / name).read_bytes()
    assert json.loads((mirror / "canonical_tax_input.json").read_text(encoding="utf-8"))["engine_contract"]["input_file"] == "canonical_tax_input.json"
    assert [json.loads(line) for line in (out_dir / "normalized_events.jsonl").read_text(encoding="utf-8").splitlines()] == [{"a": 1}, {"b": "ż"}]


def test_kopia_w_dane_out_to_zawsze_komplet_z_jednego_przebiegu(tmp_path: Path) -> None:
    # Dwa przebiegi naraz (serwer dopuszcza dwa) nie moga zostawic w kopii
    # plikow z roznych lat - blokada katalogu i podmiana calych plikow.
    import threading

    mirror = tmp_path / "out"

    def przebieg(rok: int) -> None:
        payload = {
            "canonical_tax_input": {"rok": rok},
            "normalized_events": [{"rok": rok, "nr": i} for i in range(2000)],
            "source_registry": [{"rok": rok}],
        }
        write_transaction_intelligence_outputs(payload, tmp_path / f"run-{rok}", [mirror])

    watki = [threading.Thread(target=przebieg, args=(rok,)) for rok in (2025, 2026, 2025, 2026)]
    for watek in watki:
        watek.start()
    for watek in watki:
        watek.join()

    lata = {
        json.loads((mirror / "canonical_tax_input.json").read_text(encoding="utf-8"))["rok"],
        json.loads((mirror / "source_registry.json").read_text(encoding="utf-8"))[0]["rok"],
        json.loads((mirror / "normalized_events.jsonl").read_text(encoding="utf-8").splitlines()[-1])["rok"],
    }
    assert len(lata) == 1, f"kopia zlozona z roznych przebiegow: {lata}"
    assert not list(mirror.glob(".*.tmp")) and not (mirror / ".zapis-kopii.lock").exists()


def test_porzucona_blokada_kopii_nie_zatrzymuje_zapisu_a_zajeta_pomija_kopie(tmp_path: Path) -> None:
    import os
    import time

    from investment_tax_engine.storage.transaction_intelligence import _skopiuj_do_kopii

    plik = tmp_path / "run" / "canonical_tax_input.json"
    plik.parent.mkdir(parents=True)
    plik.write_text('{"rok": 2026}', encoding="utf-8")
    mirror = tmp_path / "out"
    blokada = mirror / ".zapis-kopii.lock"
    blokada.mkdir(parents=True)
    stara = time.time() - 3600
    os.utime(blokada, (stara, stara))
    _skopiuj_do_kopii([plik], mirror)
    assert (mirror / "canonical_tax_input.json").read_text(encoding="utf-8") == '{"rok": 2026}'

    # Swieza blokada innego przebiegu: kopia pominieta, przebieg nie staje.
    (mirror / "canonical_tax_input.json").unlink()
    blokada.mkdir()
    _skopiuj_do_kopii([plik], mirror, limit_s=0.3)
    assert not (mirror / "canonical_tax_input.json").exists()
    blokada.rmdir()


def test_przerwana_podmiana_kopii_zostawia_znacznik_a_udana_go_usuwa(tmp_path: Path, monkeypatch) -> None:
    """Plik po pliku przerwany przebieg zostawial w dane/out czesc wynikow nowych, a czesc starych - bez sladu."""
    import os

    import pytest

    from investment_tax_engine.storage import transaction_intelligence as warstwa

    przebieg = tmp_path / "run"
    przebieg.mkdir()
    pliki = []
    for nazwa in ("canonical_tax_input.json", "source_registry.json"):
        plik = przebieg / nazwa
        plik.write_text('{"nowy": true}', encoding="utf-8")
        pliki.append(plik)
    mirror = tmp_path / "out"
    mirror.mkdir()

    prawdziwa_podmiana = os.replace
    wywolania: list[object] = []

    def przerwij_przy_drugiej(zrodlo, cel):
        wywolania.append(cel)
        if len(wywolania) == 2:
            raise OSError("przerwany przebieg")
        return prawdziwa_podmiana(zrodlo, cel)

    monkeypatch.setattr(warstwa.os, "replace", przerwij_przy_drugiej)
    with pytest.raises(OSError):
        warstwa._skopiuj_do_kopii(pliki, mirror)
    assert (mirror / "KOPIA_NIEPELNA.txt").exists()
    assert not list(mirror.glob(".*.tmp")) and not (mirror / ".zapis-kopii.lock").exists()

    monkeypatch.setattr(warstwa.os, "replace", prawdziwa_podmiana)
    warstwa._skopiuj_do_kopii(pliki, mirror)
    assert not (mirror / "KOPIA_NIEPELNA.txt").exists()
    assert (mirror / "source_registry.json").read_text(encoding="utf-8") == '{"nowy": true}'
