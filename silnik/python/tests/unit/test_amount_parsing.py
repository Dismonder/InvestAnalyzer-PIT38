from __future__ import annotations

from decimal import Decimal

import pytest

from investment_tax_engine.normalize.trades import parse_amount, to_decimal


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("1234.56", Decimal("1234.56")),
        ("1 234.56", Decimal("1234.56")),
        ("1\u00a0234,56", Decimal("1234.56")),  # spacja nierozdzielajaca, standard w polskim XLSX
        ("1,234.56", Decimal("1234.56")),
        ("1.234,56", Decimal("1234.56")),
        ("12 345,67", Decimal("12345.67")),
        ("1234.56 USD", Decimal("1234.56")),
        ("$1234.56", Decimal("1234.56")),
        ("-5.37", Decimal("-5.37")),
        ("(123.45)", Decimal("-123.45")),  # zapis ksiegowy wartosci ujemnej
        ("0", Decimal("0")),
        (Decimal("7.25"), Decimal("7.25")),
        (42, Decimal("42")),
    ],
)
def test_statement_formats_parse_to_the_same_number(raw, expected):
    assert parse_amount(raw) == expected


@pytest.mark.parametrize("raw", ["", "   ", "abc", None, "nan", "null", "-", "."])
def test_unreadable_values_give_none_not_zero(raw):
    """Zero i "nie da sie odczytac" to dwie rozne rzeczy.

    Wczesniej oba dawaly Decimal("0"), wiec zakup z nieczytelna cena wchodzil
    do FIFO z zerowa podstawa kosztowa, a cala pozniejsza sprzedaz stawala sie
    dochodem - bez zadnego zgloszenia.
    """
    assert parse_amount(raw) is None


def test_to_decimal_keeps_the_documented_default():
    assert to_decimal("abc") == Decimal("0")
    assert to_decimal("abc", Decimal("-1")) == Decimal("-1")
    assert to_decimal("1 234,56") == Decimal("1234.56")


def test_boolean_is_not_an_amount():
    assert parse_amount(True) is None
    assert parse_amount(False) is None


# --- Formaty, ktore wczesniej dawaly bledna liczbe albo ciche zero ---------
#
# Audyt wykazal, ze "1,234" bylo czytane jako 1.234, czyli tysiac razy za malo,
# a "1,234,567", "12.34-" i "1e-05" konczyly sie zerem. Zero w cenie zakupu
# oznacza zerowa podstawe kosztowa i cala sprzedaz jako dochod.

@pytest.mark.parametrize(
    "raw,expected",
    [
        # Grupa trzech cyfr po jednym separatorze to tysiace, nie czesc dziesietna.
        ("1,234", Decimal("1234")),
        ("$1,000", Decimal("1000")),
        ("-1,500", Decimal("-1500")),
        ("12,345", Decimal("12345")),
        # Kilka separatorow to zawsze tysiace.
        ("1,234,567", Decimal("1234567")),
        ("1.234.567", Decimal("1234567")),
        ("1 234 567", Decimal("1234567")),
        # Ostatni separator jest dziesietny.
        ("1,234.56", Decimal("1234.56")),
        ("1.234,56", Decimal("1234.56")),
        ("1,234,567.89", Decimal("1234567.89")),
        # Inna liczba cyfr po przecinku niz trzy jest jednoznacznie dziesietna.
        ("12,34", Decimal("12.34")),
        ("1,2345", Decimal("1.2345")),
        ("0,5", Decimal("0.5")),
        # Kropka z trzema cyframi to zwykla liczba dziesietna - tak zapisane sa
        # kursy w tych wyciagach ("0.041095"), wiec reguly tysiecy tu nie ma.
        ("1.234", Decimal("1.234")),
        ("0.041095", Decimal("0.041095")),
        # Zapisy wartosci ujemnych.
        ("(123.45)", Decimal("-123.45")),
        ("12.34-", Decimal("-12.34")),
        ("1 234,56-", Decimal("-1234.56")),
        # Notacja wykladnicza z arkusza.
        ("1e-05", Decimal("0.00001")),
        ("2.5E3", Decimal("2500")),
    ],
)
def test_formats_that_used_to_be_wrong_or_zero(raw, expected):
    assert parse_amount(raw) == expected


def test_a_percentage_is_not_an_amount():
    """Wczesniej znak procentu byl obcinany, wiec "5%" dawalo 5 - sto razy za duzo."""
    assert parse_amount("5%") is None
    assert parse_amount("0.049315%") is None


def test_a_float_keeps_its_value_instead_of_going_through_text():
    """Zapis tekstowy malej liczby ("1e-05") gubil ja przy ponownym parsowaniu."""
    assert parse_amount(0.00001) == Decimal("0.00001")
    assert parse_amount(1234.56) == Decimal("1234.56")


def test_the_ambiguous_group_is_recognisable_for_the_caller():
    from investment_tax_engine.normalize.trades import is_ambiguous_thousands_group

    assert is_ambiguous_thousands_group("1,234") is True
    assert is_ambiguous_thousands_group("1.234") is False, "kropka to separator dziesietny"
    assert is_ambiguous_thousands_group("12,34") is False
    assert is_ambiguous_thousands_group("1,2345") is False
    assert is_ambiguous_thousands_group("1,234.56") is False


def test_zero_na_poczatku_nie_jest_grupa_tysiecy():
    # "0,125" to ilosc albo cena z polskim przecinkiem, nie 125 - grupa tysiecy
    # nie zaczyna sie od zera.
    from investment_tax_engine.normalize.trades import is_ambiguous_thousands_group, parse_amount

    assert is_ambiguous_thousands_group("0,125") is False
    assert parse_amount("0,125") == Decimal("0.125")
    assert parse_amount("-0,250") == Decimal("-0.250")
    assert parse_amount("1,234") == Decimal("1234")
