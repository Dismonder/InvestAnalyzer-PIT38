"""Bezpieczny zapis komorek arkusza: tekst z wyciagu nie moze zostac formula.

openpyxl zamienia na formule tylko tekst zaczynajacy sie od "=". Apostrof
zapisywany doslownie zmienialby tresc komorki, wiec dostaje go wylacznie taki
tekst; "-15.00 USD", "-1 234,56", "-" czy "@x" zostaja bez zmian (w XLSX nie sa
formulami). Regula CSV z aplikacji (zakodujKomorkeCsv) jest szersza, bo CSV
interpretuje Excel przy otwarciu.
"""

from __future__ import annotations

import pandas as pd


def neutralizuj_formule(value: object) -> object:
    if isinstance(value, str) and value.startswith("="):
        return "'" + value
    return value


def ramka_bezpieczna(rows: list[dict]) -> pd.DataFrame:
    """DataFrame z wierszy z zneutralizowanymi tekstami (bez przycinania dlugosci)."""
    if not all(isinstance(row, dict) for row in rows):
        return pd.DataFrame(rows)
    return pd.DataFrame(
        [{neutralizuj_formule(key): neutralizuj_formule(value) for key, value in row.items()} for row in rows]
    )
