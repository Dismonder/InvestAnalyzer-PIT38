"""Plik zadania nie moze dostac roku ani waluty z zalozenia.

`year=str(payload.get("year") or "2025")` liczylo caly PIT za 2025 rok, gdy
zadanie nie podalo roku. `currency=str(payload.get("currency") or "PLN")`
odliczalo oplate w dolarach jak zlotowke 1:1, z pominieciem kursu NBP.
"""

from decimal import Decimal

import pandas as pd
import pytest

from investment_tax_engine.app.cli import (
    BladDanychWejsciowych,
    _data_oplaty,
    _rok_z_zadania,
    _waluta_oplaty,
    parse_decimal_arg,
)


def test_zadanie_bez_roku_nie_dostaje_2025():
    with pytest.raises(ValueError, match="tax year"):
        _rok_z_zadania({"run_mode": "SAFE"})


def test_rok_z_zadania_jest_przepisywany():
    assert _rok_z_zadania({"year": 2024}) == "2024"


def test_oplata_bez_waluty_nie_staje_sie_zlotowka():
    with pytest.raises(ValueError, match="nie ma waluty"):
        _waluta_oplaty(None, "BANK-FUNDING-FEE")


def test_waluta_oplaty_jest_normalizowana():
    assert _waluta_oplaty(" usd ", "BANK-FUNDING-FEE") == "USD"


def test_waluta_oplaty_musi_byc_kodem():
    with pytest.raises(BladDanychWejsciowych, match="trzyliterowy kod"):
        _waluta_oplaty("zł", "BANK-FUNDING-FEE")


def test_polska_data_oplaty_nie_zamienia_dnia_z_miesiacem():
    # pd.Timestamp("03.04.2026") daje 4 marca - kurs NBP z niewlasciwego dnia.
    assert _data_oplaty("03.04.2026", "F1") == pd.Timestamp("2026-04-03")
    assert _data_oplaty("2026-04-03", "F1") == pd.Timestamp("2026-04-03")
    assert _data_oplaty("2026-04-03T10:00:00", "F1") == pd.Timestamp("2026-04-03")
    assert _data_oplaty(" 3.4.2026 ", "F1") == pd.Timestamp("2026-04-03")
    # Stare wpisy z pola tekstowego: rok na poczatku jest jednoznaczny (R12).
    assert _data_oplaty("2026/04/03", "F1") == pd.Timestamp("2026-04-03")
    assert _data_oplaty("2026.4.3", "F1") == pd.Timestamp("2026-04-03")


@pytest.mark.parametrize("zla", ["3/4/2026", "04/03/2026", "2026-02-30", "31.02.2026", "kwiecien", ""])
def test_niejednoznaczna_albo_bledna_data_oplaty_zatrzymuje_przebieg(zla):
    with pytest.raises(BladDanychWejsciowych, match="RRRR-MM-DD"):
        _data_oplaty(zla, "F1")


def test_kwota_z_jednostka_daje_polski_komunikat():
    assert parse_decimal_arg("40,50", field_name="funding_fee_amount") == Decimal("40.50")
    with pytest.raises(BladDanychWejsciowych, match="wpisz samą liczbę"):
        parse_decimal_arg("40 zł", field_name="funding_fee_amount")
