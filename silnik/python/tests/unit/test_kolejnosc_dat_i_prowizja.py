"""Poprawki I8 (kolejnosc DD/MM vs MM/DD ustalana dla pliku) i I9 (nieczytelna prowizja)."""

from __future__ import annotations

from decimal import Decimal

import pandas as pd
import pytest

from investment_tax_engine.app.engine import InvestmentTaxEngine
from investment_tax_engine.models.core import EngineConfig
from investment_tax_engine.normalize.trades import (
    normalize_api_trade,
    to_timestamp,
    ustal_kolejnosc_dat,
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
        "id": "T1",
    }
    podstawa.update(zmiany)
    return podstawa


# --- I9: nieczytelna prowizja -------------------------------------------------

@pytest.mark.parametrize("prowizja", ["bad", "n/d?", "5%", "abc zl"])
def test_nieczytelna_prowizja_blokuje_wejscie_zamiast_zera(prowizja: str) -> None:
    raw = wiersz(Commission=prowizja)
    with pytest.raises(ValueError, match="prowizj"):
        normalize_api_trade(raw)

    dataset = InvestmentTaxEngine(EngineConfig()).normalize([{
        "source": "API_JSON_FULL",
        "source_file": "syntetyczny.json",
        "source_sheet": "root",
        "rows": [raw],
    }])
    assert dataset.trades == ()
    assert [issue.code for issue in dataset.issues] == ["NORMALIZE_ERROR"]
    assert "Commission" in dataset.issues[0].message
    assert prowizja in dataset.issues[0].message
    assert build_quality_report(dataset.issues).filing_ready is False


def test_prowizja_absurdalnie_duza_tez_blokuje() -> None:
    with pytest.raises(ValueError, match="prowizj"):
        normalize_api_trade(wiersz(Commission=1e308))


@pytest.mark.parametrize("prowizja", [None, "", "  ", "nan", "-", "—", "n/a"])
def test_brak_prowizji_to_zero_jak_dotad(prowizja) -> None:
    trade = normalize_api_trade(wiersz(Commission=prowizja))
    assert trade.commission == Decimal("0")
    assert trade.certainty_status == "CERTAIN"


def test_brak_pola_prowizji_to_zero_jak_dotad() -> None:
    raw = wiersz()
    del raw["Commission"]
    trade = normalize_api_trade(raw)
    assert trade.commission == Decimal("0")
    assert trade.certainty_status == "CERTAIN"


@pytest.mark.parametrize("prowizja", [0, "0", "0.00", "0,00", Decimal("0")])
def test_jawne_zero_w_prowizji_pozostaje_zerem(prowizja) -> None:
    trade = normalize_api_trade(wiersz(Commission=prowizja))
    assert trade.commission == Decimal("0")
    assert trade.certainty_status == "CERTAIN"


def test_czytelna_prowizja_bez_zmian() -> None:
    assert normalize_api_trade(wiersz(Commission="1 234,50")).commission == Decimal("1234.50")


@pytest.mark.parametrize("klucz", ["Prowizja", "fee_amount"])
def test_nieczytelna_prowizja_w_kolumnach_magazynu_tez_blokuje(klucz: str) -> None:
    """Magazyn czyta prowizje takze z 'Prowizja' i 'fee_amount'."""
    raw = wiersz()
    del raw["Commission"]
    raw[klucz] = "bad"
    with pytest.raises(ValueError, match=klucz):
        normalize_api_trade(raw)


def test_prowizja_z_kolumny_magazynu_nie_zmienia_zrodla_kwoty() -> None:
    """Czytelna 'Prowizja' nadal nie jest kwota prowizji transakcji (osobne wiersze prowizji)."""
    raw = wiersz()
    del raw["Commission"]
    raw["Prowizja"] = "5"
    trade = normalize_api_trade(raw)
    assert trade.commission == Decimal("0")
    assert trade.certainty_status == "CERTAIN"


@pytest.mark.parametrize("klucz", ["Commission", "Prowizja", "fee_amount"])
@pytest.mark.parametrize("wartosc", ["Zgrupowano", "grouped", {"a": 1}, ["x"], '{"fee": 1}', "[1, 2]"])
def test_agregat_lub_struktura_w_polu_prowizji_to_brak_prowizji_do_przegladu(klucz: str, wartosc) -> None:
    raw = wiersz()
    del raw["Commission"]
    raw[klucz] = wartosc
    trade = normalize_api_trade(raw)
    assert trade.commission == Decimal("0")
    assert trade.certainty_status == "CONDITIONAL"
    assert trade.review_status == "UNREVIEWED"


# --- I8: kolejnosc dat z ukosnikiem -------------------------------------------

def _daty(tekst: str) -> str:
    return tekst


def test_ustalanie_kolejnosci_dzien_pierwszy() -> None:
    assert ustal_kolejnosc_dat(["03/04/2025", "25/04/2025"]) == "DMY"


def test_ustalanie_kolejnosci_miesiac_pierwszy() -> None:
    assert ustal_kolejnosc_dat(["03/04/2025", "12/31/2025 14:30"]) == "MDY"


def test_ustalanie_kolejnosci_bez_rozstrzygniecia() -> None:
    assert ustal_kolejnosc_dat(["03/04/2025", "01/02/2026", "2025-03-04", 46024, None]) is None


def test_ustalanie_kolejnosci_ignoruje_iso_kropki_i_myslniki() -> None:
    assert ustal_kolejnosc_dat(["2025-12-31", "31.12.2025", "31-12-2025"]) is None


def test_sprzeczne_kolejnosci_w_pliku_to_blad() -> None:
    with pytest.raises(ValueError, match="DD/MM.*MM/DD|MM/DD.*DD/MM"):
        ustal_kolejnosc_dat(["25/04/2025", "12/31/2025"])


def test_plik_amerykanski_jedna_regula_dla_wszystkich_dat() -> None:
    """W pliku z 12/31/2025 dzien 03/04/2025 to 4 marca, a 01/02/2026 to 2 stycznia.

    Dawniej pandas przelaczal reguly sam: 03/04 -> 3 kwietnia, 12/31 -> 31 grudnia.
    """
    kolejnosc = ustal_kolejnosc_dat(["03/04/2025", "12/31/2025", "01/02/2026"])
    assert kolejnosc == "MDY"
    assert to_timestamp("03/04/2025", kolejnosc=kolejnosc) == pd.Timestamp("2025-03-04")
    assert to_timestamp("12/31/2025", kolejnosc=kolejnosc) == pd.Timestamp("2025-12-31")
    assert to_timestamp("01/02/2026", kolejnosc=kolejnosc) == pd.Timestamp("2026-01-02")
    assert to_timestamp("03/04/2025 14:30", kolejnosc=kolejnosc) == pd.Timestamp("2025-03-04 14:30")


def test_plik_europejski_jedna_regula_dla_wszystkich_dat() -> None:
    kolejnosc = ustal_kolejnosc_dat(["03/04/2025", "25/04/2025", "01/02/2026"])
    assert kolejnosc == "DMY"
    assert to_timestamp("03/04/2025", kolejnosc=kolejnosc) == pd.Timestamp("2025-04-03")
    assert to_timestamp("01/02/2026", kolejnosc=kolejnosc) == pd.Timestamp("2026-02-01")
    assert to_timestamp("03/04/2025 14:30", kolejnosc=kolejnosc) == pd.Timestamp("2025-04-03 14:30")


def test_domyslnie_bez_rozstrzygniecia_dzien_pierwszy() -> None:
    assert to_timestamp("03/04/2025") == pd.Timestamp("2025-04-03")
    assert to_timestamp("01/02/2024") == pd.Timestamp("2024-02-01")


def test_iso_i_serial_excela_nie_zalezy_od_kolejnosci() -> None:
    for kolejnosc in ("DMY", "MDY"):
        assert to_timestamp("2025-03-04", kolejnosc=kolejnosc) == pd.Timestamp("2025-03-04")
        assert to_timestamp(46024, kolejnosc=kolejnosc) == pd.Timestamp("2026-01-02")
        # Kropki i myslniki nigdy nie sa zapisem amerykanskim.
        assert to_timestamp("03.04.2025", kolejnosc=kolejnosc) == pd.Timestamp("2025-04-03")


def test_transakcja_z_przekazana_kolejnoscia_pliku() -> None:
    surowy = wiersz(date="03/04/2025 14:30")
    assert normalize_api_trade(surowy).executed_at == pd.Timestamp("2025-04-03 14:30")
    assert normalize_api_trade(surowy, kolejnosc_dat="MDY").executed_at == pd.Timestamp("2025-03-04 14:30")


def test_transakcja_sprzeczne_daty_w_jednym_wierszu_blokuja() -> None:
    surowy = wiersz(date="25/04/2025", settlement_date="12/31/2025")
    with pytest.raises(ValueError, match="DD/MM"):
        normalize_api_trade(surowy)


# --- I8: ustalanie kolejnosci dla pliku w warstwie magazynu ------------------

def _zrodlo_csv(tmp_path, daty: list[str]):
    from investment_tax_engine.app.source_resolver import BrokerStorageResolvedSource

    sciezka = tmp_path / "transakcje.csv"
    linie = ["Data;Operation;Instrument name;Quantity;price;Currency"]
    linie += [f"{data};Buy;ABC.US;2;10;USD" for data in daty]
    sciezka.write_text("\n".join(linie) + "\n", encoding="utf-8")
    return BrokerStorageResolvedSource(
        source_id=sciezka.name,
        filename=sciezka.name,
        relative_path=sciezka.name,
        path=str(sciezka),
        role="transaction_source",
        detected_type="broker_transactions_xlsx",
        score=100,
        reason="test",
    )


def test_magazyn_plik_amerykanski_ma_jedna_regule_i_przekazuje_ja_silnikowi(tmp_path) -> None:
    from investment_tax_engine.storage.transaction_intelligence import (
        build_normalized_events,
        sources_that_failed_to_read,
    )

    zrodlo = _zrodlo_csv(tmp_path, ["03/04/2025", "12/31/2025", "01/02/2026"])
    cache: dict = {}
    zdarzenia = build_normalized_events([zrodlo], tax_year=None, rows_cache=cache)
    assert sources_that_failed_to_read([zrodlo], rows_cache=cache) == []
    assert [z["date"]["trade_date"] for z in zdarzenia] == ["2025-03-04", "2025-12-31", "2026-01-02"]

    # Ta sama kolejnosc dociera do silnika razem z surowym wierszem.
    surowy = zdarzenia[0]["raw"]["raw_payload"]
    assert surowy["kolejnosc_dat_pliku"] == "MDY"
    assert normalize_api_trade(surowy).executed_at == pd.Timestamp("2025-03-04")


def test_magazyn_plik_europejski_zostaje_dzien_miesiac_rok(tmp_path) -> None:
    from investment_tax_engine.storage.transaction_intelligence import build_normalized_events

    zdarzenia = build_normalized_events(
        [_zrodlo_csv(tmp_path, ["03/04/2025", "25/04/2025", "01/02/2026"])], tax_year=None
    )
    assert [z["date"]["trade_date"] for z in zdarzenia] == ["2025-04-03", "2025-04-25", "2026-02-01"]
    assert "kolejnosc_dat_pliku" not in zdarzenia[0]["raw"]["raw_payload"]


def test_magazyn_sprzeczne_kolejnosci_w_pliku_blokuja_odczyt(tmp_path) -> None:
    from investment_tax_engine.storage.transaction_intelligence import (
        build_normalized_events,
        sources_that_failed_to_read,
    )

    zrodlo = _zrodlo_csv(tmp_path, ["25/04/2025", "12/31/2025"])
    cache: dict = {}
    build_normalized_events([zrodlo], tax_year=None, rows_cache=cache)
    bledy = sources_that_failed_to_read([zrodlo], rows_cache=cache)
    assert len(bledy) == 1
    assert bledy[0]["code"] == "SOURCE_INPUT_READ_FAILED" and bledy[0]["blocking"] is True
    assert "DD/MM" in bledy[0]["error"] and "MM/DD" in bledy[0]["error"]
