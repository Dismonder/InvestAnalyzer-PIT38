"""Plik z transakcjami musi byc oznaczony jako zrodlo podatkowe.

`_source_registry_entry_to_manifest` wpisywalo `contributesToTax: False` na
sztywno. `_build_result_health_check` liczy po tym polu liste aktywnych zrodel,
wiec kontrola zaufania pokazywala zero zrodel obok rozliczenia policzonego
z trzech wyciagow brokera, a raport rozpoznania dopisywal "Brak rozpoznanego
pliku z rekordami podatkowymi" przy komplecie danych.
"""

from investment_tax_engine.tax.filing_package import (
    _normalized_storage_entry_to_manifest,
    _source_registry_entry_to_manifest,
)


def test_wyciag_transakcyjny_z_rejestru_jest_zrodlem_podatkowym():
    wpis = _source_registry_entry_to_manifest(
        {"source_id": "src-1", "filename": "broker_raport.json", "source_role": "transaction_source", "record_count": 840}
    )

    assert wpis["sourceResolutionRole"] == "transaction_source"
    assert wpis["contributesToTax"] is True


def test_archiwum_nbp_nie_jest_zrodlem_podatkowym():
    wpis = _source_registry_entry_to_manifest(
        {"source_id": "src-2", "filename": "archiwum_tab_a_2025.csv", "source_role": "nbp_rates", "record_count": 1}
    )

    assert wpis["contributesToTax"] is False


def test_ten_sam_wybor_dla_manifestu_storage():
    wpis = _normalized_storage_entry_to_manifest(
        {"original_filename": "broker_raport.json", "final_role": "transaction_source", "file_sha256": "abc123"}
    )

    assert wpis["contributesToTax"] is True


def test_resolver_oznacza_wyciag_jako_zrodlo_podatkowe():
    """`to_manifest_dict` w ogole nie ustawialo pola contributesToTax."""
    from investment_tax_engine.app.source_resolver import BrokerStorageResolvedSource

    zrodlo = BrokerStorageResolvedSource(
        source_id="storage:abc",
        filename="broker_raport.json",
        relative_path="broker_raport.json",
        path="/tmp/broker_raport.json",
        role="transaction_source",
        detected_type="broker_report_json",
        score=100,
        reason="test",
    )

    assert zrodlo.to_manifest_dict()["contributesToTax"] is True

    kursy = BrokerStorageResolvedSource(
        source_id="storage:def",
        filename="archiwum_tab_a_2025.csv",
        relative_path="archiwum_tab_a_2025.csv",
        path="/tmp/archiwum.csv",
        role="nbp_rates",
        detected_type="nbp_archive",
        score=100,
        reason="test",
    )

    assert kursy.to_manifest_dict()["contributesToTax"] is False
