from __future__ import annotations

from decimal import Decimal


def _fields(projection) -> dict[str, Decimal]:
    return {field.position: field.value for field in projection.form_fields}


def _projection(gross_dividend: str, foreign_tax: str, gross_credit_interest: str = "0.00"):
    """Projekcja PIT-38 dla samych dywidend, bez zyskow kapitalowych."""
    from investment_tax_engine.models.core import EngineRunResult
    from investment_tax_engine.tax.filing_package import _build_fallback_projection_from_summary

    result = EngineRunResult.__new__(EngineRunResult)
    result.annual_summary = {
        "pit38_rounded_revenue_pln": "0",
        "pit38_rounded_cost_pln": "0",
        "pit38_income": "0",
        "tax_19_pln": "0.00",
        "art30a": {
            "gross_dividends_pln": gross_dividend,
            "foreign_withholding_tax_pln": foreign_tax,
            "gross_credit_interest_pln": gross_credit_interest,
        },
    }
    result.primary_scenario = "aggressive_user"
    result.plan_used = "aggressive_user"
    return _build_fallback_projection_from_summary(result)


def test_difference_up_to_polish_rate_is_charged():
    """USA pobiera 15% wedlug W-8BEN, w Polsce nalezy sie 19% - roznica to doplata.

    Broszura MF do PIT-38 o czesci G: podatnik wykazuje "wysokosc podatku
    zaplaconego za granica (...) (poz. 48) oraz roznice pomiedzy zryczaltowanym
    podatkiem a podatkiem zaplaconym za granica (poz. 49)". Pozycja 49 to wiec
    doplata 47 - 48, a nie nadwyzka liczona w druga strone.
    """
    fields = _fields(_projection("10000.00", "1500.00"))

    assert fields["47"] == Decimal("1900.00"), "polski podatek od dywidendy brutto"
    assert fields["48"] == Decimal("1500.00"), "podatek zaplacony u zrodla"
    assert fields["49"] == Decimal("400"), "roznica 1900 - 1500 to doplata"
    assert fields["51"] == Decimal("400"), "doplata 400 zl musi trafic do sumy"


def test_foreign_rate_above_polish_does_not_create_negative_tax():
    """Niemcy pobieraja 26,375%; nadwyzka nie zmniejsza podatku, tylko przepada."""
    projekcja = _projection("10000.00", "2637.50")
    fields = _fields(projekcja)

    assert fields["47"] == Decimal("1900.00")
    assert fields["48"] == Decimal("1900.00"), "kredyt ograniczony do polskiego podatku"
    assert fields["49"] == Decimal("0"), "nie ma czego doplacac, gdy zrodlo pobralo wiecej"
    assert fields["51"] == Decimal("0"), "podatek nie moze byc ujemny"
    # Formularz nie ma pozycji na nadwyzke, ale uzytkownik ma prawo znac te kwote.
    assert projekcja.foreign_tax_excess_pln == Decimal("737.50")


def test_equal_rates_leave_nothing_to_pay():
    fields = _fields(_projection("10000.00", "1900.00"))

    assert fields["48"] == Decimal("1900.00")
    assert fields["49"] == Decimal("0.00")
    assert fields["51"] == Decimal("0")


def test_no_dividends_leaves_the_capital_gains_tax_untouched():
    from investment_tax_engine.models.core import EngineRunResult
    from investment_tax_engine.tax.filing_package import _build_fallback_projection_from_summary

    result = EngineRunResult.__new__(EngineRunResult)
    result.annual_summary = {
        "pit38_rounded_revenue_pln": "233502",
        "pit38_rounded_cost_pln": "231968",
        "pit38_income": "1533",
        "tax_19_pln": "291.35",
        "art30a": {"gross_dividends_pln": "0.00", "foreign_withholding_tax_pln": "0.00"},
    }
    result.primary_scenario = "aggressive_user"
    result.plan_used = "aggressive_user"

    fields = _fields(_build_fallback_projection_from_summary(result))

    assert fields["51"] == Decimal("291"), "bez dywidend suma to sam podatek z art. 30b"


def test_interest_tax_is_rounded_up_to_full_grosz_not_to_full_zloty():
    """Wyjatek z art. 63 par. 1a Ordynacji podatkowej.

    Broszura MF do PIT-38: kwoty w poz. 46 i 49 podaje sie po zaokragleniu do
    pelnych zlotych, ale "w przypadku zryczaltowanego podatku dochodowego,
    o ktorym mowa w art. 30a ust. 1 pkt 1-3 ustawy, kwote nalezy zaokraglic do
    pelnych groszy w gore". Odsetki od wolnych srodkow to pkt 3, wiec 19% ze
    100,55 zl daje 19,1045 zl, a na formularzu 19,11 zl - nie 19 zl.
    """
    fields = _fields(_projection("0.00", "0.00", gross_credit_interest="100.55"))

    assert fields["47"] == Decimal("19.11"), "19% ze 100,55 zaokraglone do groszy w gore"
    assert fields["49"] == Decimal("19.11"), "poz. 49 dziedziczy zaokraglenie odsetek"
    assert fields["51"] == Decimal("19.11"), "podatek od odsetek wchodzi do sumy"


def test_dividends_keep_the_full_zloty_rounding():
    """Dywidendy to art. 30a ust. 1 pkt 4 - wyjatek groszowy ich nie obejmuje."""
    fields = _fields(_projection("100.55", "0.00"))

    assert fields["47"] == Decimal("19.10"), "19% ze 100,55 to 19,1045, w poz. 47 z groszami"
    assert fields["49"] == Decimal("19"), "poz. 49 dla dywidend idzie do pelnych zlotych"


def test_interest_and_dividends_are_rounded_each_by_its_own_rule():
    """Skladniki o roznych regulach zaokraglaja sie osobno i dopiero sumuja.

    Zaokraglanie dopiero sumy mieszaloby dwie reguly ustawowe w jedna.
    """
    fields = _fields(_projection("100.55", "0.00", gross_credit_interest="100.55"))

    assert fields["49"] == Decimal("38.11"), "19 zl od dywidend plus 19,11 zl od odsetek"


def test_no_interest_changes_nothing():
    """Brak odsetek nie moze ruszyc kwot liczonych dotychczas."""
    bez_pola = _fields(_projection("10000.00", "1500.00"))

    assert bez_pola["47"] == Decimal("1900.00")
    assert bez_pola["49"] == Decimal("400")
    assert bez_pola["51"] == Decimal("400")


def test_nieznane_panstwo_zglasza_zalozona_stawke_umowna():
    """
    Stawka 15% dla panstwa spoza tabeli to zalozenie, nie odczyt z umowy.

    Gdy prawdziwa stawka jest nizsza, silnik odliczy za duzo i podatek wyjdzie
    zanizony - uzytkownik musi o tym wiedziec.
    """
    from investment_tax_engine.tax.policies import (
        czy_stawka_umowna_znana,
        stawka_umowna_dywidend,
        DOMYSLNA_STAWKA_UMOWNA,
    )

    assert czy_stawka_umowna_znana("US") is True
    assert czy_stawka_umowna_znana("gb") is True, "kod z malych liter tez sie liczy"
    assert czy_stawka_umowna_znana("XX") is False
    assert czy_stawka_umowna_znana(None) is False
    assert czy_stawka_umowna_znana("") is False

    # Sama stawka nadal wychodzi, zeby rozliczenie sie policzylo.
    assert stawka_umowna_dywidend("XX") == DOMYSLNA_STAWKA_UMOWNA
    assert stawka_umowna_dywidend("GB") != DOMYSLNA_STAWKA_UMOWNA
