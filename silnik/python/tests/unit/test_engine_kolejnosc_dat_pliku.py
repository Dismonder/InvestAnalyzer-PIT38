"""Kolejnosc DD/MM vs MM/DD ustalana dla calego pliku takze w sciezce parserow (bez magazynu).

Data z ukosnikiem jest niejednoznaczna. Wiersz "03/04/2025" w pliku amerykanskim
(gdzie inny wiersz ma "12/31/2025") to 4 marca, a czytany osobno dawal 3 kwietnia -
inny dzien i inny kurs NBP. Zdarzenia (events.py) nie dostawaly kolejnosci wcale.
"""

from __future__ import annotations

import pandas as pd

from investment_tax_engine.app.engine import InvestmentTaxEngine
from investment_tax_engine.models.core import EngineConfig


def _zdarzenie(data: str, kwota: str = "-5") -> dict:
    return {
        "Data": data,
        "Kwota": kwota,
        "waluta": "USD",
        "Rodzaj zlecenia": "Prowizja",
        "Komentarz": "(Trade T1 buy ABC.US) commission",
    }


def _transakcja(data: str, numer: str) -> dict:
    return {
        "Symbol": "ABC.US",
        "Side": "BUY",
        "Quantity": 10,
        "Cena": 100.0,
        "Kwota": 1000.0,
        "Currency": "USD",
        "date": data,
        "account": "F24",
        "id": numer,
    }


def _normalizuj(zrodlo: str, wiersze: list[dict]):
    return InvestmentTaxEngine(EngineConfig()).normalize(
        [{"source": zrodlo, "source_file": "plik.xlsx", "source_sheet": "arkusz", "rows": wiersze}]
    )


def test_zdarzenia_dostaja_kolejnosc_miesiac_pierwszy_ustalona_dla_pliku():
    zbior = _normalizuj("TRADERNET_TABLE", [_zdarzenie("03/04/2025"), _zdarzenie("12/31/2025", "-7")])

    daty = {str(zdarzenie.amount): zdarzenie.effective_at for zdarzenie in zbior.events}

    assert daty["-5"] == pd.Timestamp("2025-03-04")
    assert daty["-7"] == pd.Timestamp("2025-12-31")


def test_zdarzenia_dzien_pierwszy_zostaja_dzien_pierwszy():
    zbior = _normalizuj("TRADERNET_TABLE", [_zdarzenie("03/04/2025"), _zdarzenie("25/04/2025", "-7")])

    daty = {str(zdarzenie.amount): zdarzenie.effective_at for zdarzenie in zbior.events}

    assert daty["-5"] == pd.Timestamp("2025-04-03")


def test_transakcje_plik_amerykanski_czyta_wszystkie_wiersze_jedna_regula():
    zbior = _normalizuj("API_JSON_FULL", [_transakcja("03/04/2025", "T1"), _transakcja("12/31/2025", "T2")])

    daty = {trade.trade_id: trade.executed_at for trade in zbior.trades}

    assert daty["T1"] == pd.Timestamp("2025-03-04")
    assert daty["T2"] == pd.Timestamp("2025-12-31")


def test_sprzeczne_kolejnosci_w_pliku_to_blad_odczytu_bez_liczenia_wierszy():
    zbior = _normalizuj("TRADERNET_TABLE", [_zdarzenie("25/04/2025"), _zdarzenie("12/31/2025", "-7")])

    assert zbior.events == ()
    assert zbior.trades == ()
    bledy = [issue for issue in zbior.issues if issue.code == "SOURCE_INPUT_READ_FAILED"]
    assert len(bledy) == 1
    assert bledy[0].blocking is True
    assert "plik.xlsx" in bledy[0].message
    assert "DD/MM" in bledy[0].message


def test_dane_z_wierszy_wejscia_nie_sa_mutowane():
    wiersze = [_zdarzenie("03/04/2025"), _zdarzenie("12/31/2025", "-7")]

    _normalizuj("TRADERNET_TABLE", wiersze)

    assert all("kolejnosc_dat_pliku" not in wiersz for wiersz in wiersze)
