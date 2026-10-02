"""Wylaczenie pliku z rozliczenia.

Przelacznik przy pliku w liscie magazynu byl ozdoba: zmienial stan widoku i
wymuszal pelne przeliczenie tym samym zestawem plikow. Te testy trzymaja caly
lancuch - od nazwy podanej przez uzytkownika po zestaw zrodel silnika.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from investment_tax_engine.app.source_resolver import (
    normalize_excluded_files,
    resolve_storage_sources,
)


def _magazyn(tmp_path: Path) -> Path:
    storage = tmp_path / "pliki"
    (storage / "Dane").mkdir(parents=True)
    (storage / "raport.json").write_text(json.dumps({"trades": []}), encoding="utf-8")
    (storage / "Dane" / "historia.json").write_text(json.dumps({"trades": []}), encoding="utf-8")
    (storage / "kursy.csv").write_text("data;1USD;\n", encoding="utf-8")
    return storage


def test_excluded_file_does_not_become_a_source(tmp_path):
    magazyn = _magazyn(tmp_path)

    komplet = resolve_storage_sources(magazyn, mode="canonical_stream")
    bez_raportu = resolve_storage_sources(magazyn, mode="canonical_stream", excluded_files=["raport.json"])

    assert {source.filename for source in komplet.sources} == {"raport.json", "historia.json", "kursy.csv"}
    assert {source.filename for source in bez_raportu.sources} == {"historia.json", "kursy.csv"}


def test_exclusion_is_written_into_the_audit(tmp_path):
    """Wylaczenie zmienia kwote podatku, wiec pakiet dowodowy musi je wymieniac."""
    magazyn = _magazyn(tmp_path)

    rozwiazanie = resolve_storage_sources(magazyn, mode="canonical_stream", excluded_files=["raport.json"])
    audyt = rozwiazanie.to_audit_dict()

    assert audyt["excludedFiles"] == ["raport.json"]
    assert audyt["summary"]["excludedFileCount"] == 1


def test_file_in_a_subdirectory_can_be_excluded_by_name_or_by_path(tmp_path):
    """Lista w aplikacji pokazuje raz sama nazwe, raz sciezke wzgledna."""
    magazyn = _magazyn(tmp_path)

    po_nazwie = resolve_storage_sources(magazyn, mode="canonical_stream", excluded_files=["historia.json"])
    po_sciezce = resolve_storage_sources(magazyn, mode="canonical_stream", excluded_files=["Dane/historia.json"])
    po_sciezce_windows = resolve_storage_sources(
        magazyn, mode="canonical_stream", excluded_files=["Dane" + chr(92) + "historia.json"]
    )

    for rozwiazanie in (po_nazwie, po_sciezce, po_sciezce_windows):
        assert "historia.json" not in {source.filename for source in rozwiazanie.sources}
        assert rozwiazanie.excluded_files == ["Dane/historia.json"]


def test_empty_exclusion_list_changes_nothing(tmp_path):
    magazyn = _magazyn(tmp_path)

    komplet = resolve_storage_sources(magazyn, mode="canonical_stream")
    z_pusta_lista = resolve_storage_sources(magazyn, mode="canonical_stream", excluded_files=[" ", ""])

    assert len(z_pusta_lista.sources) == len(komplet.sources)
    assert z_pusta_lista.excluded_files == []


def test_identical_workbook_prefers_transaction_source_independent_of_filename(tmp_path):
    from zestaw_wejsciowy import _synthetic_set

    zestaw = _synthetic_set()
    assert zestaw is not None, "Brak zestawu syntetycznego."
    magazyn = tmp_path / "pliki"
    magazyn.mkdir()
    shutil.copyfile(zestaw.trades_v1, magazyn / "A_analityka.xlsx")
    shutil.copyfile(zestaw.trades_v1, magazyn / "Z_transakcje.xlsx")

    rozwiazanie = resolve_storage_sources(magazyn)

    assert [source.filename for source in rozwiazanie.sources if source.role == "transaction_source"] == [
        "Z_transakcje.xlsx"
    ]
    assert rozwiazanie.duplicate_files == [
        {"file": "A_analityka.xlsx", "duplicate_of": "Z_transakcje.xlsx"}
    ]


def test_normalization_is_case_and_separator_insensitive():
    assert normalize_excluded_files(["Raport.JSON", "Dane" + chr(92) + "Historia.json", " ", None]) == {
        "raport.json",
        "dane/historia.json",
    }
