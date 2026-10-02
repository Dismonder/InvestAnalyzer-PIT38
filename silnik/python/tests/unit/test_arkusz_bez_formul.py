"""Tekst z wyciagu zaczynajacy sie od '=' nie moze stac sie formula w XLSX."""

from __future__ import annotations

import openpyxl
import pandas as pd
import pytest

from investment_tax_engine.export.komorki import ramka_bezpieczna
from investment_tax_engine.export.workbook import rows_or_empty


def _zapisz_i_wczytaj(ramka: pd.DataFrame, sciezka):
    with pd.ExcelWriter(sciezka, engine="openpyxl") as writer:
        ramka.to_excel(writer, sheet_name="Test", index=False)
    return openpyxl.load_workbook(sciezka)["Test"]


def test_tekst_zaczynajacy_sie_od_znaku_rownosci_jest_tekstem(tmp_path):
    """openpyxl robi formule tylko z tekstu zaczynajacego sie od '='."""
    arkusz = _zapisz_i_wczytaj(rows_or_empty([{"komentarz": "=1+1"}]), tmp_path / "a.xlsx")
    komorka = arkusz["A2"]
    assert komorka.data_type == "s", "komorka nie moze byc formula"
    assert komorka.value == "'=1+1"


@pytest.mark.parametrize(
    "tekst",
    ["+cmd|' /C calc'!A0", "-cmd", "@SUM(A1:A2)", "-15.00 USD", "-1 234,56", "-1E-8", "-", "\t=1+1", "\r=1+1"],
)
def test_pozostale_teksty_zostaja_bez_zmian_bo_nie_sa_formulami(tmp_path, tekst):
    """Apostrof zapisany doslownie zmienialby tresc ('-15.00 USD)."""
    arkusz = _zapisz_i_wczytaj(rows_or_empty([{"komentarz": tekst}]), tmp_path / "a.xlsx")
    komorka = arkusz["A2"]
    assert komorka.data_type == "s"
    # XML normalizuje CR do LF przy odczycie, wiec porownujemy po ujednoliceniu.
    assert komorka.value.replace("\n", "\r") == tekst.replace("\n", "\r")


def test_liczby_i_zwykly_tekst_bez_zmian(tmp_path):
    arkusz = _zapisz_i_wczytaj(
        rows_or_empty([{"a": -5, "b": "-15.00", "c": "+3,5", "d": "zwykly tekst", "e": 12.5}]),
        tmp_path / "b.xlsx",
    )
    assert [arkusz.cell(row=2, column=col).value for col in range(1, 6)] == [-5, "-15.00", "+3,5", "zwykly tekst", 12.5]


def test_lista_kontrolna_dowodow_tez_bez_formul(tmp_path):
    arkusz = _zapisz_i_wczytaj(
        ramka_bezpieczna([{"note": '=HYPERLINK("http://x")', "kwota": 10}]), tmp_path / "c.xlsx"
    )
    assert arkusz["A2"].data_type == "s"
    assert arkusz["A2"].value.startswith("'=")
    assert arkusz["B2"].value == 10
