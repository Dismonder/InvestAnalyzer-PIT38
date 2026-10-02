"""Podzial wierszy FIFO na rok rozliczany i pozostale lata.

`result.fifo_rows` celowo obejmuje wszystkie lata - rejestr strat z lat ubieglych
liczy sie wlasnie z nich. Pakiet dowodowy dostawal jednak te sama, niefiltrowana
liste, wiec arkusz `FIFO_Realized` i `fifo_rows.json` nie sumowaly sie do pozycji
22 i 23 formularza. Kontrolujacy, ktory zsumowal arkusz, dostawal inna kwote niz
PIT-38 i nie mial jak tej roznicy wyjasnic.

Tutaj wiersze dostaja jawny rok i znacznik przynaleznosci, a eksport rozdziela
je na dwa zbiory: rozliczany rok (uzgadnia sie z formularzem) i reszta
(widoczna, ale opisana wprost).
"""

from __future__ import annotations

from dataclasses import asdict
from typing import Any, Iterable

TAX_YEAR_KEY = "tax_year"
IN_FILING_YEAR_KEY = "in_filing_year"


def _row_year(row: Any) -> int | None:
    sell_date = getattr(row, "sell_tax_date", None)
    year = getattr(sell_date, "year", None)
    return int(year) if year is not None else None


def fifo_rows_as_dicts(rows: Iterable[Any], filing_year: int | None) -> list[dict]:
    """Wiersze FIFO jako slowniki, z rokiem sprzedazy i znacznikiem roku."""
    prepared: list[dict] = []
    for row in rows:
        year = _row_year(row)
        payload = asdict(row)
        payload[TAX_YEAR_KEY] = year
        payload[IN_FILING_YEAR_KEY] = filing_year is None or year == filing_year
        prepared.append(payload)
    return prepared


def split_by_filing_year(rows: list[dict]) -> tuple[list[dict], list[dict]]:
    """(wiersze rozliczanego roku, wiersze pozostalych lat)."""
    in_year = [row for row in rows if row.get(IN_FILING_YEAR_KEY)]
    other_years = [row for row in rows if not row.get(IN_FILING_YEAR_KEY)]
    return in_year, other_years
