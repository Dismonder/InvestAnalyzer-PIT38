"""Odpornosc normalizacji na zepsute dane z wyciagu.

Wyciagi brokerskie potrafia byc niechlujne. Wazne, zeby silnik albo policzyl
poprawnie, albo powiedzial wprost, ze nie umie - a nie zwrocil liczbe, ktora
wyglada sensownie i jest zla.
"""

from __future__ import annotations

from decimal import Decimal

import pandas as pd
import pytest

from investment_tax_engine.app.engine import InvestmentTaxEngine
from investment_tax_engine.models.core import EngineConfig
from investment_tax_engine.normalize.events import normalize_tradernet_event
from investment_tax_engine.normalize.trades import (
    bez_strefy_czasowej,
    kwota_wiarygodna,
    normalize_api_trade,
    to_timestamp,
)
from investment_tax_engine.validation.quality_gates import build_quality_report


def wiersz(**zmiany) -> dict:
    podstawa = {
        "Symbol": "AAPL.US",
        "Side": "BUY",
        "Quantity": 10,
        "Cena": 150.0,
        "Kwota": 1500.0,
        "Commission": 1.0,
        "Currency": "USD",
        "date": "2024-02-05T15:30:00",
        "account": "F24",
    }
    podstawa.update(zmiany)
    return podstawa


def test_data_ze_strefa_czasowa_nie_wywraca_silnika() -> None:
    """Pelny format ISO ze strefa konczyl caly przebieg bledem przy zapisie
    arkusza: "Excel does not support datetimes with timezones"."""
    znacznik = to_timestamp("2024-02-05T10:00:00Z")
    assert znacznik is not None
    assert znacznik.tzinfo is None


def test_strefa_nie_przesuwa_daty_transakcji() -> None:
    """Data ma trafic do deklaracji taka, jaka wykazal broker.

    Przeliczenie strefy przesuneloby transakcje z 1:00 nad ranem na dzien
    wczesniejszy, a razem z nia kurs NBP.
    """
    znacznik = to_timestamp("2024-02-05T01:00:00+02:00")
    assert znacznik is not None
    assert znacznik.date().isoformat() == "2024-02-05"


def test_znacznik_bez_strefy_zostaje_bez_zmian() -> None:
    surowy = pd.Timestamp("2024-02-05 15:30:00")
    assert bez_strefy_czasowej(surowy) == surowy


def test_kwota_poza_zakresem_jest_odrzucana() -> None:
    assert kwota_wiarygodna(Decimal("1500.00")) is True
    assert kwota_wiarygodna(Decimal("1e308")) is False
    assert kwota_wiarygodna(None) is False


def test_nieczytelna_kwota_jest_odtwarzana_z_ilosci_i_ceny() -> None:
    """Bez tego koszt nabycia spadal do samej prowizji."""
    transakcja = normalize_api_trade(wiersz(Kwota="abc"))
    assert transakcja.gross_amount == Decimal("1500")
    assert transakcja.certainty_status == "CONDITIONAL", "wiersz ma trafic do przegladu"


def test_brak_kwoty_tez_jest_odtwarzany() -> None:
    transakcja = normalize_api_trade(wiersz(Kwota=None))
    assert transakcja.gross_amount == Decimal("1500")


def test_poprawny_wiersz_nie_jest_oznaczany_do_przegladu() -> None:
    transakcja = normalize_api_trade(wiersz())
    assert transakcja.gross_amount == Decimal("1500.0")
    assert transakcja.certainty_status == "CERTAIN"


def test_ujemna_cena_trafia_do_przegladu() -> None:
    transakcja = normalize_api_trade(wiersz(Cena=-150.0, Kwota=-1500.0))
    assert transakcja.certainty_status == "CONDITIONAL"


def test_absurdalna_kwota_nie_wywraca_arytmetyki() -> None:
    """Wczesniej 1e308 psulo dzialania dziesietne, a blad byl maskowany
    komunikatem o braku kursu NBP."""
    transakcja = normalize_api_trade(wiersz(Kwota=1e308))
    assert transakcja.gross_amount == Decimal("1500"), "odtworzone z ilosci i ceny"


def test_sprzedaz_bez_ceny_i_kwoty_brutto_blokuje_wejscie() -> None:
    raw = wiersz(Side="SELL", Cena=None, Kwota=None)
    with pytest.raises(ValueError, match="neither price nor gross amount"):
        normalize_api_trade(raw)

    dataset = InvestmentTaxEngine(EngineConfig()).normalize([{
        "source": "API_JSON_FULL",
        "source_file": "syntetyczny.json",
        "source_sheet": "root",
        "rows": [raw],
    }])
    assert dataset.trades == ()
    assert [issue.code for issue in dataset.issues] == ["NORMALIZE_ERROR"]
    assert "syntetyczny.json" in dataset.issues[0].message
    assert "wiersz 1" in dataset.issues[0].message
    assert "usuń plik z magazynu" in dataset.issues[0].message
    assert dataset.issues[0].message.endswith("neither price nor gross amount")
    assert build_quality_report(dataset.issues).filing_ready is False


def test_jawne_zero_w_cenie_i_kwocie_pozostaje_zerem() -> None:
    trade = normalize_api_trade(wiersz(Cena="0", Kwota="0"))
    assert trade.price == Decimal("0")
    assert trade.gross_amount == Decimal("0")


@pytest.mark.parametrize("kind", ["Dywidenda", "Podatek u zrodla", "Prowizja za transakcje"])
@pytest.mark.parametrize("brak", ["Kwota", "waluta"])
def test_zdarzenie_podatkowe_bez_kwoty_lub_waluty_blokuje_wejscie(kind: str, brak: str) -> None:
    row = {"Rodzaj zlecenia": kind, "Data": "01/02/2024", "Kwota": "5", "waluta": "USD"}
    row[brak] = None
    with pytest.raises(ValueError, match="no valid amount or currency"):
        normalize_tradernet_event(row)

    dataset = InvestmentTaxEngine(EngineConfig()).normalize([{
        "source": "TRADERNET_TABLE",
        "source_file": "syntetyczny.xlsx",
        "source_sheet": "root",
        "rows": [row],
    }])
    assert [issue.code for issue in dataset.issues] == ["NORMALIZE_ERROR"]
    assert build_quality_report(dataset.issues).filing_ready is False


def test_data_zdarzenia_dd_mm_yyyy_ma_ten_sam_dzien_co_transakcja() -> None:
    event = normalize_tradernet_event({
        "Rodzaj zlecenia": "Dywidenda",
        "Data": "01/02/2024",
        "Kwota": "5",
        "waluta": "USD",
    })
    trade = normalize_api_trade(wiersz(date="01/02/2024"))
    assert event.effective_at == trade.executed_at == pd.Timestamp("2024-02-01")


def test_polska_data_z_kropkami_czytana_jako_dzien_miesiac_rok() -> None:
    """Domyslny parser czytal "05.02.2024" jako 2 maja zamiast 5 lutego.

    Skutek byl cichy: silnik bral kurs NBP z innego dnia, a przy dacie
    granicznej nawet z innego roku podatkowego.
    """
    znacznik = to_timestamp("05.02.2024")
    assert znacznik is not None
    assert znacznik.date().isoformat() == "2024-02-05"


def test_data_z_myslnikami_po_europejsku() -> None:
    znacznik = to_timestamp("05-02-2024")
    assert znacznik is not None
    assert znacznik.date().isoformat() == "2024-02-05"


def test_data_z_godzina_tez_dzien_pierwszy() -> None:
    znacznik = to_timestamp("31.12.2023 23:59")
    assert znacznik is not None
    assert znacznik.date().isoformat() == "2023-12-31"


def test_format_iso_bez_zmian() -> None:
    """Regresja: reguly europejskiej nie wolno stosowac do zapisu ISO."""
    znacznik = to_timestamp("2024-02-05")
    assert znacznik is not None
    assert znacznik.date().isoformat() == "2024-02-05"


def test_noga_papierowa_wykupu_noty_bez_kwoty_nie_blokuje_wejscia() -> None:
    # Wykup noty: zapis papierowy ma ilosc i ticker, kwote niesie osobna noga pieniezna.
    row = {
        "type": "Termin zapadalności",
        "comment": "Redemption of securities NOTE1.JUN26 (). Record date 2026",
        "date": "2026-06-11",
        "quantity": "3",
        "ticker": "NOTE1.JUN26",
    }
    event = normalize_tradernet_event(row)
    assert event.amount == Decimal("0")


def test_dywidenda_z_iloscia_ale_bez_kwoty_nadal_blokuje() -> None:
    # Wyjatek dla nogi papierowej dotyczy tylko wykupu (MATURITY), nie dywidendy.
    row = {"type": "Dywidenda", "comment": "Dividend ABC.US", "date": "2026-03-02", "quantity": "1"}
    with pytest.raises(ValueError, match="no valid amount or currency"):
        normalize_tradernet_event(row)
