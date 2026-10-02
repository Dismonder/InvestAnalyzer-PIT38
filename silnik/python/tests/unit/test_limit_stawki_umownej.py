"""Limit stawki umownej przy odliczaniu podatku u zrodla od dywidend.

Art. 30a ust. 9 ustawy o PIT pozwala odliczyc podatek zaplacony za granica, ale
nie wiecej, niz wynika z umowy o unikaniu podwojnego opodatkowania. Dla USA to
15%. Platnik pobiera 15% tylko od inwestora, ktory zlozyl formularz W-8BEN; bez
niego pobiera 30%, a nadwyzki 15 punktow NIE odlicza sie w Polsce - odzyskuje
sie ja od amerykanskiego urzedu.

Przed ta zmiana silnik odliczal cala pobrana kwote, wiec bez W-8BEN zanizal
podatek nalezny w Polsce.
"""

from __future__ import annotations

from decimal import Decimal

from investment_tax_engine.tax.policies import (
    DOMYSLNA_STAWKA_UMOWNA,
    stawka_umowna_dywidend,
)


def limit(brutto: str, pobrany: str, kraj: str | None) -> tuple[Decimal, Decimal]:
    """Powtarza regule silnika: odliczalne i nieodliczalne."""
    brutto_d = Decimal(brutto)
    pobrany_d = Decimal(pobrany)
    dozwolony = min(pobrany_d, brutto_d * stawka_umowna_dywidend(kraj))
    return dozwolony, pobrany_d - dozwolony


def test_z_w8ben_caly_podatek_jest_odliczalny() -> None:
    odliczalny, nieodliczalny = limit("1000.00", "150.00", "US")
    assert odliczalny == Decimal("150.00")
    assert nieodliczalny == Decimal("0.00")


def test_bez_w8ben_odliczamy_tylko_do_stawki_umownej() -> None:
    odliczalny, nieodliczalny = limit("1000.00", "300.00", "US")
    assert odliczalny == Decimal("150.00"), "USA: umowa przewiduje 15%"
    assert nieodliczalny == Decimal("150.00"), "nadwyzke odzyskuje sie od IRS"


def test_kraj_o_nizszej_stawce_umownej() -> None:
    """Wielka Brytania: 10% wedlug umowy."""
    odliczalny, _ = limit("1000.00", "200.00", "GB")
    assert odliczalny == Decimal("100.00")


def test_kraj_spoza_tabeli_dostaje_stawke_domyslna() -> None:
    assert stawka_umowna_dywidend("ZZ") == DOMYSLNA_STAWKA_UMOWNA
    odliczalny, _ = limit("1000.00", "400.00", "ZZ")
    assert odliczalny == Decimal("150.00")


def test_brak_kraju_nie_wywraca_wyliczenia() -> None:
    odliczalny, _ = limit("1000.00", "100.00", None)
    assert odliczalny == Decimal("100.00"), "pobrano mniej niz limit, wiec calosc"


def test_pobrano_mniej_niz_limit() -> None:
    odliczalny, nieodliczalny = limit("1000.00", "50.00", "US")
    assert odliczalny == Decimal("50.00")
    assert nieodliczalny == Decimal("0.00")
