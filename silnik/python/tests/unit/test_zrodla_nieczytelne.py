"""Plik, ktorego nie dalo sie odczytac, nie moze zniknac po cichu.

Wyjatek przy czytaniu zrodla konczyl jako jeden wiersz z sekcja "read_error"
w tym samym strumieniu co dane. Nic tej sekcji dalej nie sprawdzalo, wiec
rozliczenie powstawalo bez calego wyciagu i konczylo sie sukcesem.
"""

from investment_tax_engine.app.source_resolver import BrokerStorageResolvedSource, resolve_storage_sources
from investment_tax_engine.storage.transaction_intelligence import _source_rows, sources_that_failed_to_read, sources_hitting_the_row_limit
import json


def _zrodlo(sciezka: str, nazwa: str) -> BrokerStorageResolvedSource:
    return BrokerStorageResolvedSource(
        source_id=nazwa,
        filename=nazwa,
        relative_path=nazwa,
        path=sciezka,
        role="transaction_source",
        detected_type="broker_report_json",
        score=100,
        reason="test",
    )


def test_uszkodzony_json_jest_zgloszony(tmp_path):
    uszkodzony = tmp_path / "transakcje.json"
    uszkodzony.write_text('{"trades": [', encoding="utf-8")

    bledy = sources_that_failed_to_read([_zrodlo(str(uszkodzony), "transakcje.json")])

    assert len(bledy) == 1, "plik nie do odczytania musi byc wymieniony z nazwy"
    assert bledy[0]["filename"] == "transakcje.json"
    assert bledy[0]["error"], "powod odczytu musi trafic do raportu"


def test_poprawny_plik_nie_jest_zglaszany(tmp_path):
    dobry = tmp_path / "transakcje.json"
    dobry.write_text('{"trades": [{"id": 1}]}', encoding="utf-8")

    assert sources_that_failed_to_read([_zrodlo(str(dobry), "transakcje.json")]) == []


def test_json_transaction_source_over_2000_rows_is_read_in_full(tmp_path):
    path = tmp_path / "historia_transakcji.json"
    path.write_text(json.dumps([{"id": index} for index in range(2001)]), encoding="utf-8")
    source = resolve_storage_sources(tmp_path).sources[0]

    assert source.role == "transaction_source"
    assert len(_source_rows(source)) == 2001
    assert sources_hitting_the_row_limit([source]) == []


def test_unreadable_named_history_keeps_transaction_role_and_reports_failure(tmp_path):
    path = tmp_path / "historia_transakcji.json"
    path.write_text('{"trades": [', encoding="utf-8")
    source = resolve_storage_sources(tmp_path).sources[0]

    assert source.role == "transaction_source"
    assert source.detected_type == "legacy_broker_history_json"
    assert sources_that_failed_to_read([source])[0]["code"] == "SOURCE_INPUT_READ_FAILED"
