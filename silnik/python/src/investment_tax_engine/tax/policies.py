from __future__ import annotations

from decimal import Decimal


# Stawki dywidendowe z umow o unikaniu podwojnego opodatkowania. Wiecej niz
# stawka umowna nie wolno odliczyc w Polsce (art. 30a ust. 9 ustawy o PIT):
# nadwyzke pobrana przez platnika odzyskuje sie od zagranicznego urzedu.
# Typowa sytuacja: brak formularza W-8BEN, wiec USA pobiera 30% zamiast 15%.
STAWKI_UMOWNE_DYWIDEND = {
    "US": Decimal("0.15"),
    "DE": Decimal("0.15"),
    "FR": Decimal("0.15"),
    "GB": Decimal("0.10"),
    "NL": Decimal("0.15"),
    "IE": Decimal("0.15"),
    "CH": Decimal("0.15"),
    "AT": Decimal("0.15"),
    "IT": Decimal("0.10"),
    "ES": Decimal("0.15"),
    "BE": Decimal("0.10"),
    "SE": Decimal("0.15"),
    "DK": Decimal("0.15"),
    "NO": Decimal("0.15"),
    "FI": Decimal("0.15"),
    "CZ": Decimal("0.05"),
    "LT": Decimal("0.05"),
    "KZ": Decimal("0.15"),
    "CY": Decimal("0.00"),
}

# Kraj spoza tabeli: przyjmujemy najczestsza stawke portfelowa (15%).
#
# To zalozenie, nie odczyt z umowy. Kazda umowa ma wlasna stawke - w tabeli
# wyzej sa i 5%, i 10%, i 0%. Gdy prawdziwa stawka jest nizsza niz przyjete
# 15%, silnik odliczy za duzo i podatek wyjdzie zanizony; gdy wyzsza -
# za malo. Dlatego uzycie tej wartosci nie moze przejsc po cichu:
# `czy_stawka_umowna_znana` pozwala wywolujacemu zglosic to uzytkownikowi.
DOMYSLNA_STAWKA_UMOWNA = Decimal("0.15")


def _znormalizuj(kod_kraju: str | None) -> str:
    return str(kod_kraju or "").strip().upper()


def czy_stawka_umowna_znana(kod_kraju: str | None) -> bool:
    """Czy stawke dla tego panstwa mamy w tabeli, czy tylko zakladamy."""
    return _znormalizuj(kod_kraju) in STAWKI_UMOWNE_DYWIDEND


def stawka_umowna_dywidend(kod_kraju: str | None) -> Decimal:
    return STAWKI_UMOWNE_DYWIDEND.get(_znormalizuj(kod_kraju), DOMYSLNA_STAWKA_UMOWNA)


TAX_PLANS = {
    "aggressive_user": {
        "include_fx_conversion_costs": True,
        "include_account_fees": True,
        "include_interest_costs": True,
        "include_misc_investment_costs": True,
    },
    "balanced_user": {
        "include_fx_conversion_costs": False,
        "include_account_fees": True,
        "include_interest_costs": True,
        "include_misc_investment_costs": False,
    },
    "conservative_user": {
        "include_fx_conversion_costs": False,
        "include_account_fees": False,
        "include_interest_costs": False,
        "include_misc_investment_costs": False,
    },
}


PLAN_TO_SCENARIO = {
    "aggressive_user": "aggressive_user",
    "balanced_user": "defensible",
    "conservative_user": "conservative",
}


SCENARIO_TO_PLAN = {
    "aggressive_user": "aggressive_user",
    "defensible": "balanced_user",
    "conservative": "conservative_user",
}
