"""Zalacznik PIT/ZG - dochody z zagranicy w rozbiciu na panstwa.

Broszura Ministerstwa Finansow do PIT-38:

    "Zalacznik ten skladaja osoby, ktore w roku podatkowym uzyskaly dochody za
    granica, o ktorych mowa w art. 30b ust. 5a i 5b ustawy oraz art. 30b
    ust. 5e i 5f ustawy, podlegajace opodatkowaniu w Polsce, do ktorych ma
    zastosowanie metoda odliczenia podatku zaplaconego za granica. (...)
    Zalacznik PIT/ZG nalezy zlozyc odrebnie dla kazdego panstwa, w ktorym
    uzyskano dochod."

Dwie rzeczy wynikaja z tego wprost i obie byly u nas nieobecne:

1. Rozliczenie na zagranicznym rachunku maklerskim bez tego zalacznika jest
   niekompletne - silnik liczyl poprawna kwote podatku, ale nie mial czym
   udokumentowac, z jakiego panstwa pochodzi dochod.
2. Zalacznik dotyczy **art. 30b**, czyli odplatnego zbycia. Dywidendy z
   art. 30a rozlicza sie w czesci G samego PIT-38 (poz. 46-49) i nie maja tu
   wlasnych, numerowanych pozycji; podajemy je osobno wylacznie informacyjnie.

Limit odliczenia (metoda proporcjonalna), tez z broszury:

    "Odliczenie podatku zaplaconego za granica nie moze (...) przekroczyc tej
    czesci podatku obliczonego przed dokonaniem odliczenia, ktora
    proporcjonalnie przypada na dochod uzyskany za granica."
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any, Iterable, Mapping

from ..normalize.classify import infer_country
from ..normalize.kody_krajow import KODY_KRAJOW_MF

UNKNOWN_COUNTRY = "XX"

# Pozycje czesci C.3 formularza PIT/ZG - tej, ktora wypelnia sie do PIT-38.
POSITION_INCOME = "29"
POSITION_FOREIGN_TAX = "30"


def _d(value: Any) -> Decimal:
    if isinstance(value, Decimal):
        return value
    if value is None or value == "":
        return Decimal("0.00")
    try:
        return Decimal(str(value))
    except (ArithmeticError, ValueError):
        return Decimal("0.00")


def _country_of_trade(trade: Any) -> str:
    """Panstwo zrodla dochodu - z ISIN, a w drugiej kolejnosci z symbolu.

    Prefiks ISIN jest pewniejszy niz koncowka tickera: ten sam walor bywa
    notowany pod roznymi symbolami, a ISIN nadaje krajowa agencja numerujaca.
    """
    if trade is None:
        return UNKNOWN_COUNTRY
    country = infer_country(getattr(trade, "symbol", ""), getattr(trade, "isin", None))
    if country:
        return country
    # Nota bez ISIN albo papier z ISIN XS: panstwo moze podac tylko uzytkownik
    # (pole "Kraj" w edytorze transakcji). Bez tego blokada nie dawala sie usunac.
    podany = str(getattr(trade, "user_country", None) or "").strip().upper()
    return podany if podany in KODY_KRAJOW_MF else UNKNOWN_COUNTRY


def symbole_bez_kraju(fifo_rows: Iterable[Any], trades_by_id: Mapping[str, Any]) -> list[str]:
    """Symbole sprzedazy, dla ktorych nie da sie ustalic panstwa (wiersz "XX").

    Sama kwota wiersza nie mowi uzytkownikowi, ktore transakcje uzupelnic.
    """
    symbole: set[str] = set()
    for row in fifo_rows:
        trade = trades_by_id.get(getattr(row, "sell_trade_id", ""))
        if _country_of_trade(trade) == UNKNOWN_COUNTRY:
            symbole.add(str(getattr(row, "symbol", None) or getattr(trade, "symbol", None) or "?"))
    return sorted(symbole)


def build_pit_zg_rows(
    fifo_rows: Iterable[Any],
    trades_by_id: Mapping[str, Any],
    foreign_tax_view: Iterable[Mapping[str, Any]] = (),
    dividends_view: Iterable[Mapping[str, Any]] = (),
    additional_costs_by_country: Mapping[str, Decimal] | None = None,
) -> list[dict]:
    """Po jednym wierszu na panstwo. `fifo_rows` musi byc juz zawezone do roku.

    Podatek bez powiazanej dywidendy pozostaje w art. 30a do przegladu.
    Brak powiazania nie dowodzi, ze dotyczy sprzedazy z art. 30b.
    """
    rows: dict[str, dict] = {}

    def entry(country: str) -> dict:
        return rows.setdefault(
            country,
            {
                "country": country,
                "revenue_pln": Decimal("0.00"),
                "cost_pln": Decimal("0.00"),
                "additional_cost_pln": Decimal("0.00"),
                "income_pln": Decimal("0.00"),
                "loss_pln": Decimal("0.00"),
                "foreign_tax_pln": Decimal("0.00"),
                "dividend_income_pln": Decimal("0.00"),
                "dividend_foreign_tax_pln": Decimal("0.00"),
                "row_count": 0,
            },
        )

    for row in fifo_rows:
        country = _country_of_trade(trades_by_id.get(getattr(row, "sell_trade_id", "")))
        current = entry(country)
        current["revenue_pln"] += _d(getattr(row, "gross_revenue_pln", 0))
        current["cost_pln"] += _d(getattr(row, "cost_pln", 0)) + _d(getattr(row, "sell_commission_alloc_pln", 0))
        current["row_count"] += 1

    for dividend_row in dividends_view:
        country = str(dividend_row.get("country") or UNKNOWN_COUNTRY).upper()
        if country == "PL":
            continue
        current = entry(country)
        current["dividend_income_pln"] += _d(dividend_row.get("gross_dividend_pln"))
        current["dividend_foreign_tax_pln"] += _d(dividend_row.get("withholding_tax_pln"))

    for country, amount in (additional_costs_by_country or {}).items():
        entry(str(country or UNKNOWN_COUNTRY).upper())["additional_cost_pln"] += _d(amount)

    for current in rows.values():
        net = current["revenue_pln"] - current["cost_pln"] - current["additional_cost_pln"]
        current["income_pln"] = max(net, Decimal("0.00"))
        current["loss_pln"] = max(-net, Decimal("0.00"))
        if current["income_pln"] == Decimal("0.00"):
            # Bez dochodu z danego panstwa nie ma polskiego podatku, od ktorego
            # mozna by cokolwiek odliczyc - zalacznik pokazuje wtedy sam dochod.
            current["foreign_tax_pln"] = Decimal("0.00")

    return [rows[country] for country in sorted(rows)]


def proportional_credit_limit(
    tax_before_credit_pln: Decimal,
    foreign_income_pln: Decimal,
    total_income_pln: Decimal,
) -> Decimal:
    """Limit odliczenia podatku zaplaconego za granica (metoda proporcjonalna).

    podatek_przed_odliczeniem * dochod_zagraniczny / dochod_laczny
    """
    if total_income_pln <= Decimal("0") or foreign_income_pln <= Decimal("0"):
        return Decimal("0.00")
    share = min(foreign_income_pln / total_income_pln, Decimal("1"))
    return (tax_before_credit_pln * share).quantize(Decimal("0.01"))


def foreign_capital_tax_credit(
    pit_zg_rows: Iterable[Mapping[str, Any]],
    tax_before_credit_pln: Decimal,
    total_income_pln: Decimal,
) -> Decimal:
    """Kwota do pozycji 34 PIT-38: podatek zagraniczny w granicach limitu.

    Limit liczy sie osobno dla kazdego panstwa - nadwyzka z kraju o wysokiej
    stawce nie moze skonsumowac limitu przypadajacego na inny kraj.
    """
    total = Decimal("0.00")
    for row in pit_zg_rows:
        paid = _d(row.get("foreign_tax_pln"))
        if paid <= Decimal("0"):
            continue
        limit = proportional_credit_limit(
            tax_before_credit_pln, _d(row.get("income_pln")), total_income_pln
        )
        total += min(paid, limit)
    # Strata z innego panstwa zmniejsza dochod laczny, wiec udzial kraju w dochodzie
    # przekracza 1 i kazdy limit krajowy rowna sie calemu podatkowi. Suma odliczen
    # nie moze jednak przekroczyc podatku obliczonego przed odliczeniem (art. 30b ust. 3).
    total = min(total, max(tax_before_credit_pln, Decimal("0.00")))
    return total.quantize(Decimal("0.01"))
