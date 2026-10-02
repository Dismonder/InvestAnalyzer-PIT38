from __future__ import annotations

from argparse import Namespace
from decimal import Decimal
import json
import sys

import pandas as pd
import pytest

from investment_tax_engine.app.cli import args_from_sidecar_request, build_bundle, load_defense_evidence_overrides
from investment_tax_engine.app import cli


def test_cli_requires_year_without_sidecar_request(monkeypatch, capsys):
    monkeypatch.setattr(sys, "argv", ["investment-tax-engine"])
    with pytest.raises(SystemExit) as exit_info:
        cli.main()
    assert exit_info.value.code == 2
    assert "--year is required" in capsys.readouterr().err


def test_cli_accepts_sidecar_request_without_year(monkeypatch):
    monkeypatch.setattr(sys, "argv", ["investment-tax-engine", "--request", "task.json"])
    called = []
    monkeypatch.setattr(cli, "run_sidecar_request", lambda path: called.append(path) or 0)
    with pytest.raises(SystemExit) as exit_info:
        cli.main()
    assert exit_info.value.code == 0
    assert called == ["task.json"]


def test_ui_response_projection_drops_only_exact_duplicate_lists():
    dossiers = [
        {"id": f"dossier-{index}", "lineage": [{"source": "synthetic", "detail": "x" * 160}]}
        for index in range(80)
    ]
    history_rows = [
        {"id": f"row-{index}", "raw": {"description": "synthetic history " * 16}}
        for index in range(60)
    ]
    before = {
        "annual_summary": {"tax_year": 2025, "revenue_pln": 1234.56, "tax_pln": 234.56},
        "scenario_results": {"aggressive_user": {"gross_result_pln": 1000.0}},
        "tax_filing_package": {"draft": {"form_fields": {"22": {"value": "1234.56"}}}, "issues": []},
        "issues": [{"code": "SYNTHETIC_REVIEW", "blocking": False}],
        "transaction_dossiers": dossiers,
        "canonical_storage_history_rows": history_rows,
        "canonical_tax_input": {
            "records": [{"canonical_record_id": "synthetic-1", "amounts": {"gross_pln": 10}}],
            "transaction_dossiers": dossiers,
            "canonical_history_rows": history_rows,
        },
    }

    after = cli._project_response_for_ui(before)
    before_bytes = len(json.dumps(before, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    after_bytes = len(json.dumps(after, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))

    for key in ("annual_summary", "scenario_results", "tax_filing_package", "issues"):
        assert after[key] == before[key]
    assert after["transaction_dossiers"] == dossiers
    assert after["canonical_storage_history_rows"] == history_rows
    assert "transaction_dossiers" not in after["canonical_tax_input"]
    assert "canonical_history_rows" not in after["canonical_tax_input"]
    assert before["canonical_tax_input"]["transaction_dossiers"] == dossiers
    assert before["canonical_tax_input"]["canonical_history_rows"] == history_rows
    assert after_bytes < before_bytes


def test_build_bundle_accepts_polish_decimal_strings_for_funding_fee(tmp_path):
    args = Namespace(
        year="2025",
        run_mode="SAFE",
        api_json="",
        trades_v1="",
        trades_legacy="",
        tradernet_table="",
        broker_json="",
        broker_xml="",
        depo_json="",
        tax_plan="aggressive_user",
        package_scope="",
        filing_mode="ORIGINAL",
        include_fx_conversion_costs="",
        include_bank_funding_fees="",
        include_interest_costs="",
        include_account_fees="",
        funding_fee_id="BANK-FUNDING-FEE",
        funding_fee_amount="152,26",
        funding_fee_currency="USD",
        funding_fee_date="2025-01-21",
        funding_fee_deposit_id="82160362",
        funding_fee_deposit_amount="10 527,68",
        funding_fee_evidence_note="Domyslna alokacja: proportional_first_batch.",
        nbp_csv=[],
        out_dir=str(tmp_path),
    )

    bundle = build_bundle(args)

    event = bundle.user_overrides.funding_cost_events[0]
    assert event.amount == Decimal("152.26")
    assert event.deposit_amount == Decimal("10527.68")


def test_build_bundle_accepts_repeatable_funding_fee_json_payloads(tmp_path):
    args = Namespace(
        year="2025",
        run_mode="SAFE",
        api_json="",
        trades_v1="",
        trades_legacy="",
        tradernet_table="",
        broker_json="",
        broker_xml="",
        depo_json="",
        tax_plan="aggressive_user",
        package_scope="",
        filing_mode="ORIGINAL",
        include_fx_conversion_costs="",
        include_bank_funding_fees="",
        include_interest_costs="",
        include_account_fees="",
        funding_fee_id="",
        funding_fee_amount="",
        funding_fee_currency="PLN",
        funding_fee_date="",
        funding_fee_deposit_id="",
        funding_fee_deposit_amount="",
        funding_fee_evidence_note="",
        funding_fee_json=[
            '{"id":"fee-1","amount":"36.85","currency":"USD","date":"2025-01-21","depositId":"82160362","depositAmount":"10527.68","evidenceNote":"note-1"}',
            '{"id":"fee-2","amount":"10,25","currency":"EUR","date":"2025-02-01","depositId":"D-2","depositAmount":"5000,00","evidenceNote":"note-2"}',
        ],
        nbp_csv=[],
        out_dir=str(tmp_path),
    )

    bundle = build_bundle(args)

    assert len(bundle.user_overrides.funding_cost_events) == 2
    assert bundle.user_overrides.funding_cost_events[0].amount == Decimal("36.85")
    assert bundle.user_overrides.funding_cost_events[1].amount == Decimal("10.25")


def test_build_bundle_preserves_camel_case_funding_event_ids(tmp_path):
    args = Namespace(
        year="2025",
        run_mode="SAFE",
        api_json="",
        trades_v1="",
        trades_legacy="",
        tradernet_table="",
        broker_json="",
        broker_xml="",
        depo_json="",
        tax_plan="aggressive_user",
        package_scope="",
        filing_mode="ORIGINAL",
        include_fx_conversion_costs="",
        include_bank_funding_fees="",
        include_interest_costs="",
        include_account_fees="",
        funding_fee_id="",
        funding_fee_amount="",
        funding_fee_currency="PLN",
        funding_fee_date="",
        funding_fee_deposit_id="",
        funding_fee_deposit_amount="",
        funding_fee_evidence_note="",
        funding_fee_json=[
            '{"fundingEventId":"bank-fee-24-73","amount":"24.73","currency":"PLN","date":"2025-01-21"}',
            '{"fundingEventId":"bank-fee-152-26","amount":"152.26","currency":"PLN","date":"2025-01-21"}',
        ],
        nbp_csv=[],
        out_dir=str(tmp_path),
    )

    bundle = build_bundle(args)
    event_ids = [event.funding_event_id for event in bundle.user_overrides.funding_cost_events]

    assert event_ids == ["bank-fee-24-73", "bank-fee-152-26"]
    assert [event.source_refs for event in bundle.user_overrides.funding_cost_events] == [
        ["CLI_USER_OVERRIDE:bank-fee-24-73"],
        ["CLI_USER_OVERRIDE:bank-fee-152-26"],
    ]


def test_build_bundle_loads_defense_evidence_overrides_for_audit_only(tmp_path):
    overrides_path = tmp_path / "defense-overrides.json"
    overrides_path.write_text(
        """
        [
          {
            "evidenceId": "EVIDENCE-COST-3368752211",
            "defenseStatus": "complete",
            "linkedTradeIds": ["TRADE-1"],
            "updatedAt": "2026-05-10T10:00:00.000Z",
            "userNote": "Dowód zebrany lokalnie.",
            "evidenceConfirmed": true,
            "checkedAt": "2026-05-10T10:05:00.000Z",
            "includedInFilingPackage": true
          }
        ]
        """,
        encoding="utf-8",
    )
    args = Namespace(
        year="2025",
        run_mode="SAFE",
        api_json="",
        trades_v1="",
        trades_legacy="",
        tradernet_table="",
        broker_json="",
        broker_xml="",
        depo_json="",
        tax_plan="aggressive_user",
        package_scope="full",
        filing_mode="ORIGINAL",
        include_fx_conversion_costs="",
        include_bank_funding_fees="",
        include_interest_costs="",
        include_account_fees="",
        funding_fee_id="",
        funding_fee_amount="",
        funding_fee_currency="PLN",
        funding_fee_date="",
        funding_fee_deposit_id="",
        funding_fee_deposit_amount="",
        funding_fee_evidence_note="",
        funding_fee_json=[],
        transaction_overrides_json_path="",
        defense_evidence_overrides_json_path=str(overrides_path),
        nbp_csv=[],
        out_dir=str(tmp_path),
    )

    bundle = build_bundle(args)
    overrides = load_defense_evidence_overrides(args.defense_evidence_overrides_json_path)

    assert len(bundle.user_overrides.funding_cost_events) == 0
    assert len(bundle.user_overrides.transaction_overrides) == 0
    assert len(overrides) == 1
    assert overrides[0].evidence_id == "EVIDENCE-COST-3368752211"
    assert overrides[0].defense_status == "complete"
    assert overrides[0].evidence_confirmed is True


def test_build_bundle_attaches_transaction_intelligence_metadata_and_writes_outputs(tmp_path):
    storage_dir = tmp_path / "pliki"
    output_dir = tmp_path / "out"
    storage_dir.mkdir()
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
    ).to_excel(storage_dir / "Transakcje.xlsx", index=False)

    args = Namespace(
        year="2025",
        run_mode="SAFE",
        api_json="",
        trades_v1="",
        trades_legacy="",
        tradernet_table="",
        broker_json="",
        broker_xml="",
        depo_json="",
        tax_plan="aggressive_user",
        package_scope="full",
        filing_mode="ORIGINAL",
        include_fx_conversion_costs="",
        include_bank_funding_fees="",
        include_interest_costs="",
        include_account_fees="",
        funding_fee_id="",
        funding_fee_amount="",
        funding_fee_currency="PLN",
        funding_fee_date="",
        funding_fee_deposit_id="",
        funding_fee_deposit_amount="",
        funding_fee_evidence_note="",
        funding_fee_json=[],
        transaction_overrides_json_path="",
        defense_evidence_overrides_json_path="",
        broker_file_action_overrides_json_path="",
        source_selection_mode="canonical_stream",
        selected_candidate_source_id="",
        nbp_csv=[],
        out_dir=str(output_dir),
        storage_dir=str(storage_dir),
    )

    bundle = build_bundle(args)
    metadata = bundle.metadata

    assert metadata["transaction_dossier_summary"]["dossierCount"] >= 1
    assert metadata["transaction_dossiers"][0]["schema_version"] == "transaction_dossier.v1"
    assert metadata["field_source_map"]
    assert (output_dir / "transaction_dossiers.json").exists()
    assert (output_dir / "normalized_events.jsonl").exists()
    assert (output_dir / "canonical_storage_history.json").exists()
    assert (output_dir / "storage_lineage_index.json").exists()


def test_sidecar_request_maps_ai_normalizer_flag_to_args():
    args = args_from_sidecar_request(
        {
            "year": 2025,
            "flags": {
                "ai_normalizer_enabled": True,
            },
        }
    )

    assert args.ai_normalizer_enabled == "true"


def _args_dla_magazynu(storage_dir, output_dir, **overrides):
    base = dict(
        year="2025",
        run_mode="SAFE",
        api_json="",
        trades_v1="",
        trades_legacy="",
        tradernet_table="",
        broker_json="",
        broker_xml="",
        depo_json="",
        tax_plan="aggressive_user",
        package_scope="full",
        filing_mode="ORIGINAL",
        include_fx_conversion_costs="",
        include_bank_funding_fees="",
        include_interest_costs="",
        include_account_fees="",
        funding_fee_id="",
        funding_fee_amount="",
        funding_fee_currency="PLN",
        funding_fee_date="",
        funding_fee_deposit_id="",
        funding_fee_deposit_amount="",
        funding_fee_evidence_note="",
        funding_fee_json=[],
        transaction_overrides_json_path="",
        defense_evidence_overrides_json_path="",
        broker_file_action_overrides_json_path="",
        source_selection_mode="canonical_stream",
        selected_candidate_source_id="",
        nbp_csv=[],
        out_dir=str(output_dir),
        storage_dir=str(storage_dir),
    )
    base.update(overrides)
    return Namespace(**base)


def test_excluded_file_is_dropped_from_the_explicit_paths_too(tmp_path):
    """Wylaczenie musi objac tez sciezki domyslne, nie tylko strumien kanoniczny.

    Silnik siega po `historia_transakcji.json` i archiwa NBP wprost z magazynu,
    obok listy zrodel. Filtr zalozony tylko na liscie zostawialby te pliki w
    rozliczeniu - wylaczenie dzialaloby polowicznie i nie dalo sie tego zobaczyc.
    """
    storage_dir = tmp_path / "pliki"
    output_dir = tmp_path / "out"
    storage_dir.mkdir()
    (storage_dir / "historia_transakcji.json").write_text('{"trades": []}', encoding="utf-8")
    (storage_dir / "archiwum_tab_a_2025.csv").write_text("data;1USD;\n;\n", encoding="cp1250")

    z_kompletem = build_bundle(_args_dla_magazynu(storage_dir, output_dir))
    bez_historii = build_bundle(
        _args_dla_magazynu(storage_dir, output_dir, exclude_file=["historia_transakcji.json"])
    )

    assert z_kompletem.broker_json_path is not None
    assert bez_historii.broker_json_path is None
    assert bez_historii.nbp_csv_paths, "wylaczenie jednego pliku nie moze zabrac pozostalych"


def test_excluded_nbp_archive_is_not_used(tmp_path):
    storage_dir = tmp_path / "pliki"
    output_dir = tmp_path / "out"
    storage_dir.mkdir()
    (storage_dir / "archiwum_tab_a_2025.csv").write_text("data;1USD;\n;\n", encoding="cp1250")

    bundle = build_bundle(
        _args_dla_magazynu(storage_dir, output_dir, exclude_file=["archiwum_tab_a_2025.csv"])
    )

    assert bundle.nbp_csv_paths == []


def test_json_default_serializes_sets_as_sorted_lists():
    # str(set) dawal "{'b', 'a'}" o kolejnosci zaleznej od procesu - ten sam
    # przebieg dawal rozny wynik JSON (np. policy_tags w cost_items).
    import json as _json

    from investment_tax_engine.app.cli import _json_default

    assert _json.dumps({"tagi": {"wymaga_decyzji", "aggressive_only"}}, default=_json_default) == (
        '{"tagi": ["aggressive_only", "wymaga_decyzji"]}'
    )
    assert _json.dumps({"d": __import__("decimal").Decimal("1.50")}, default=_json_default) == '{"d": "1.50"}'


def test_ujemny_koszt_krypto_z_lat_ubieglych_zatrzymuje_przebieg(tmp_path):
    from investment_tax_engine.app.cli import BladDanychWejsciowych

    args = Namespace(
        year="2026", run_mode="SAFE", api_json="", trades_v1="", trades_legacy="", tradernet_table="",
        broker_json="", broker_xml="", depo_json="", tax_plan="aggressive_user", package_scope="",
        filing_mode="ORIGINAL", include_fx_conversion_costs="", include_bank_funding_fees="",
        include_interest_costs="", include_account_fees="", funding_fee_id="", funding_fee_amount="",
        funding_fee_currency="", funding_fee_date="", funding_fee_deposit_id="", funding_fee_deposit_amount="",
        funding_fee_evidence_note="", nbp_csv=[], out_dir=str(tmp_path),
        crypto_costs_carried_forward="-100",
    )
    # Koszt ujemny podnosilby dochod z walut wirtualnych w czesci E.
    with pytest.raises(BladDanychWejsciowych, match="nie może być ujemna"):
        build_bundle(args)
    args.crypto_costs_carried_forward = "1 250,40"
    assert build_bundle(args).user_overrides.crypto_costs_carried_forward_pln == Decimal("1250.40")



def test_sidecar_blad_wpisu_ma_wlasny_kod_i_wskazowke(tmp_path, monkeypatch):
    import json as _json

    import investment_tax_engine.app.cli as cli

    def zly_wpis(payload):
        raise cli.BladDanychWejsciowych("Strata za 2025: kwota straty '-500' musi być dodatnia.")

    monkeypatch.setattr(cli, "args_from_sidecar_request", zly_wpis)
    zadanie = tmp_path / "request.json"
    zadanie.write_text(_json.dumps({"contract_version": cli.REQUEST_CONTRACT_VERSION, "run_id": "r1"}), encoding="utf-8")

    assert cli.run_sidecar_request(str(zadanie)) == 1
    blad = _json.loads((tmp_path / "error.json").read_text(encoding="utf-8"))
    # Desktop pokazuje tresc z error.json - ma byc zdanie i wskazowka, nie sam wyjatek.
    assert blad["error_code"] == "ENGINE_INPUT_INVALID"
    assert "musi być dodatnia" in blad["message"]
    assert cli.WSKAZOWKA_BLEDU_WPISU in blad["message"]


def test_zadanie_sidecara_moze_pominac_kopie_w_dane_out():
    assert args_from_sidecar_request({"year": 2026, "flags": {"bez_kopii_out": True}}).bez_kopii_out is True
    assert args_from_sidecar_request({"year": 2026}).bez_kopii_out is False


def test_przebieg_kontrolny_nie_kopiuje_wynikow_do_out_obok_magazynu(tmp_path, monkeypatch):
    """Aplikacja kopiuje wyniki warstwy transakcji do dane/out; przebieg kontrolny i testy - nie."""
    import shutil

    storage_dir = tmp_path / "pliki"
    storage_dir.mkdir()
    (storage_dir / "historia_transakcji.json").write_text('{"trades": []}', encoding="utf-8")
    kopia = tmp_path / "out"

    monkeypatch.delenv("INVEST_BEZ_KOPII_OUT", raising=False)
    build_bundle(_args_dla_magazynu(storage_dir, tmp_path / "wyniki"))
    assert (kopia / "canonical_tax_input.json").exists(), "zwykly przebieg nadal kopiuje wyniki"
    shutil.rmtree(kopia)

    build_bundle(_args_dla_magazynu(storage_dir, tmp_path / "wyniki", bez_kopii_out=True))
    assert not kopia.exists()

    monkeypatch.setenv("INVEST_BEZ_KOPII_OUT", "1")
    build_bundle(_args_dla_magazynu(storage_dir, tmp_path / "wyniki"))
    assert not kopia.exists()
