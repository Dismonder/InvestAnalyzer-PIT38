"""Rozpoznawanie pary walutowej przy koszcie spreadu.

Silnik liczyl koszt spreadu wylacznie dla pary EUR/USD wpisanej na sztywno.
Polski inwestor zamienia zlotowki na dolary, wiec ta pozycja nigdy mu sie nie
naliczala, mimo ze plan agresywny ja przewiduje.
"""

from __future__ import annotations

from investment_tax_engine.tax.fx_conversion_cost_engine import rozbij_pare_walutowa


def test_ukosnik() -> None:
    assert rozbij_pare_walutowa("USD/PLN") == ("USD", "PLN")


def test_male_litery_i_spacje() -> None:
    assert rozbij_pare_walutowa("  eur/usd ") == ("EUR", "USD")


def test_myslnik_i_podkreslnik() -> None:
    assert rozbij_pare_walutowa("USD-PLN") == ("USD", "PLN")
    assert rozbij_pare_walutowa("EUR_PLN") == ("EUR", "PLN")


def test_zapis_bez_separatora() -> None:
    assert rozbij_pare_walutowa("USDPLN") == ("USD", "PLN")


def test_symbol_akcji_nie_jest_para() -> None:
    assert rozbij_pare_walutowa("AAPL.US") is None
    assert rozbij_pare_walutowa("") is None
    assert rozbij_pare_walutowa("USD") is None


def test_trzy_czlony_to_nie_para() -> None:
    assert rozbij_pare_walutowa("USD/PLN/EUR") is None
