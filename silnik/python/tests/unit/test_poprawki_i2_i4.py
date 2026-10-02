"""I2: tolerancja kwoty transakcji nie zalezy od zapisu ceny (100 a 100.0).
I4: ten sam arkusz XLSX/CSV pod inna nazwa jest pomijany jak duplikat JSON.
"""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path

import pandas as pd
import pytest

from investment_tax_engine.app.source_resolver import resolve_storage_sources
from investment_tax_engine.normalize.trades import normalize_api_trade, tolerancja_kwoty_transakcji


def _transakcja(cena, kwota, ilosc=1000):
    return normalize_api_trade({"id": "T-1", "Symbol": "NBIS.US", "Side": "BUY", "Quantity": ilosc,
                                "Cena": cena, "Kwota": kwota, "Currency": "USD", "date": "2025-05-10"})


@pytest.mark.parametrize("cena", [100, 100.0, "100", "100.00"])
def test_i2_duza_rozbieznosc_jest_zglaszana_niezaleznie_od_zapisu_ceny(cena):
    trade = _transakcja(cena, 100400)
    assert trade.amount_mismatch is not None
    assert trade.certainty_status == "CONDITIONAL"


@pytest.mark.parametrize("cena", [100, 100.0, "100", "100.00"])
def test_i2_rozbieznosc_w_granicy_pol_centa_na_sztuke_przechodzi_niezaleznie_od_zapisu_ceny(cena):
    trade = _transakcja(cena, 100004)  # 1000 szt. x 0,005 = 5 USD tolerancji
    assert trade.amount_mismatch is None
    assert trade.certainty_status == "CERTAIN"


def test_i2_jedna_funkcja_tolerancji():
    assert tolerancja_kwoty_transakcji(Decimal("1000")) == Decimal("5")
    assert tolerancja_kwoty_transakcji(Decimal("1")) == Decimal("0.01")
    assert tolerancja_kwoty_transakcji(Decimal("0.5")) == Decimal("0.01")


def test_i2_kwota_co_do_centa_nie_daje_rozbieznosci():
    assert _transakcja("12.34", "37.02", ilosc=3).amount_mismatch is None
    assert _transakcja(12.34, 37.02, ilosc=3).amount_mismatch is None


def _bez_duplikatu(katalog: Path, nazwy: set[str]):
    wynik = resolve_storage_sources(katalog)
    przyjete = [zrodlo.relative_path for zrodlo in wynik.sources]
    assert len(przyjete) == 1 and przyjete[0] in nazwy
    pominiety = next(iter(nazwy - set(przyjete)))
    assert [wpis["file"] for wpis in wynik.duplicate_files] == [pominiety]
    assert pominiety in " ".join(wynik.sources[0].warnings)


def test_i4_kopia_xlsx_pod_inna_nazwa_jest_pomijana(tmp_path: Path):
    ramka = pd.DataFrame({"Data": ["2025-03-04"], "Symbol": ["AAPL"], "Ilosc": [10]})
    ramka.to_excel(tmp_path / "Transakcje.xlsx", index=False)
    (tmp_path / "Transakcje (1).xlsx").write_bytes((tmp_path / "Transakcje.xlsx").read_bytes())
    _bez_duplikatu(tmp_path, {"Transakcje.xlsx", "Transakcje (1).xlsx"})


def test_i4_kopia_csv_pod_inna_nazwa_jest_pomijana(tmp_path: Path):
    (tmp_path / "transakcje.csv").write_text("Data,Symbol,Ilosc\n2025-03-04,AAPL,10\n", encoding="utf-8")
    (tmp_path / "transakcje (1).csv").write_bytes((tmp_path / "transakcje.csv").read_bytes())
    _bez_duplikatu(tmp_path, {"transakcje.csv", "transakcje (1).csv"})


def test_i4_puste_arkusze_o_tej_samej_tresci_zostaja(tmp_path: Path):
    for nazwa in ("a.xlsx", "b.xlsx"):
        pd.DataFrame({"Data": [], "Symbol": []}).to_excel(tmp_path / nazwa, index=False)
    assert len(resolve_storage_sources(tmp_path).sources) == 2
