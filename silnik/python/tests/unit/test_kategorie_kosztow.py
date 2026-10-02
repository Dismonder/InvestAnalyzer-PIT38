"""Kategorie kosztow, ktorych silnik wczesniej nie rozpoznawal.

Przed ta zmiana:
- odsetki zaplacone od kredytu maklerskiego wpadaly w regule odsetek
  OTRZYMANYCH i byly ksiegowane jako przychod z art. 30a, czyli koszt
  zamienial sie w przychod do opodatkowania,
- oplaty za prowadzenie rachunku i prowizje za przewalutowanie wpadaly do
  workowej reguly "ujemna kwota" na koncu klasyfikatora i zostawaly wylacznie
  zdarzeniem diagnostycznym, wiec nigdy nie pomniejszaly dochodu,
- pola include_* w konfiguracji byly zapisywane i nigdzie nieczytane, wiec
  przelaczniki kategorii w interfejsie nie mialy zadnego wplywu na wynik.
"""

from __future__ import annotations

from decimal import Decimal

from investment_tax_engine.normalize.classify import classify_event_fields


def kategoria(rodzaj: str, komentarz: str, kwota: str) -> dict[str, str | None]:
    return classify_event_fields(rodzaj, komentarz, Decimal(kwota))


def test_odsetki_od_kredytu_sa_kosztem_a_nie_przychodem() -> None:
    wynik = kategoria("Odsetki od kredytu", "margin loan interest", "-200.00")
    assert wynik["event_kind"] == "MARGIN_INTEREST"
    assert wynik["cost_bucket"] == "MARGIN_INTEREST"
    assert wynik["logical_world"] == "financing_costs"


def test_odsetki_po_angielsku_tez_sa_kosztem() -> None:
    assert kategoria("Interest", "margin interest charged", "-15.50")["event_kind"] == "MARGIN_INTEREST"
    assert kategoria("Debit interest", "", "-3.20")["event_kind"] == "MARGIN_INTEREST"


def test_kazde_odsetki_z_ujemna_kwota_traktujemy_jako_koszt() -> None:
    """Broker moze nazwac je dowolnie; znak kwoty rozstrzyga, kto komu placi."""
    assert kategoria("Odsetki", "", "-1.00")["event_kind"] == "MARGIN_INTEREST"


def test_odsetki_od_wolnych_srodkow_pozostaja_przychodem() -> None:
    wynik = kategoria("Odsetki od wolnych srodkow", "", "42.00")
    assert wynik["event_kind"] == "CREDIT_INTEREST"


def test_odsetki_od_ujemnego_salda_maja_wlasna_kategorie() -> None:
    """Regresja: nowa regula odsetek kredytowych nie moze przejac tej kategorii."""
    wynik = kategoria("Odsetki za ujemne saldo", "", "-120.00")
    assert wynik["event_kind"] == "NEGATIVE_CASH_FEE"
    assert wynik["cost_bucket"] == "NEGATIVE_BALANCE_INTEREST"


def test_oplata_za_prowadzenie_rachunku_jest_kosztem() -> None:
    wynik = kategoria("Oplata za prowadzenie rachunku", "", "-15.00")
    assert wynik["event_kind"] == "ACCOUNT_FEE"
    assert wynik["cost_bucket"] == "ACCOUNT_FEE"


def test_oplata_depozytowa_po_angielsku() -> None:
    assert kategoria("Fee", "custody fee for August", "-4.00")["event_kind"] == "ACCOUNT_FEE"


def test_przewalutowanie_jest_kosztem() -> None:
    wynik = kategoria("Przewalutowanie", "", "-30.00")
    assert wynik["event_kind"] == "FX_CONVERSION_FEE"
    assert wynik["cost_bucket"] == "FX_CONVERSION_FEE"


def test_prowizja_za_przewalutowanie_po_angielsku() -> None:
    assert kategoria("Fee", "currency conversion fee", "-2.50")["event_kind"] == "FX_CONVERSION_FEE"


def test_prowizja_transakcyjna_bez_zmian() -> None:
    """Regresja: najwazniejsza kategoria kosztu nie moze zmienic klasyfikacji."""
    wynik = kategoria("Prowizja za transakcje", "", "-5.00")
    assert wynik["cost_bucket"] == "RECONSTRUCTED_COMMISSION"


def test_dywidenda_bez_zmian() -> None:
    assert kategoria("Dywidenda", "AAPL.US", "25.00")["event_kind"] == "DIVIDEND"


def test_podatek_u_zrodla_nie_jest_dywidenda() -> None:
    """Regula dywidendy stala pierwsza i przejmowala podatek od dywidendy.

    Dodatkowo wzorzec "podatk" nie pasuje do mianownika "podatek"
    (p-o-d-a-t-e-k), czyli do najczestszej nazwy tej operacji u brokera.
    Efekt byl podwojny: koszt stawal sie przychodem, a przy 30% pobranym
    u zrodla rozliczenie wykazywalo dywidende, ktorej nie bylo.
    """
    assert kategoria("Podatek u zrodla od dywidendy", "AAPL.US withholding", "-3.75")["event_kind"] == "TAX"
    assert kategoria("Podatek od odsetek", "", "-5.00")["event_kind"] == "TAX"
    assert kategoria("Podatku u źródła", "", "-1.00")["event_kind"] == "TAX"


def test_dywidenda_z_podatkiem_w_komentarzu_zostaje_dywidenda() -> None:
    """Pole rodzaju ma pierwszenstwo przed komentarzem."""
    wynik = kategoria("Dywidenda", "withholding tax deducted at source", "21.25")
    assert wynik["event_kind"] == "DIVIDEND"


def test_dywidenda_nie_wpada_do_kosztow_przez_slowo_w_komentarzu() -> None:
    """Regresja: reguly kosztowe stoja PO rozstrzygnieciu dywidendy i podatku."""
    assert kategoria("Dywidenda", "AAPL.US dividend, currency conversion applied", "25.00")["event_kind"] == "DIVIDEND"
    assert kategoria("Wyplata dywidendy", "account fee included", "40.00")["event_kind"] == "DIVIDEND"


def test_podatek_rozpoznany_z_samego_komentarza() -> None:
    assert kategoria("Operacja", "AAPL.US withholding tax", "-3.75")["event_kind"] == "TAX"


def test_inne_prowizje_bez_zmian() -> None:
    assert kategoria("Inne prowizje", "", "-1.00")["event_kind"] == "FUNDING_TRANSFER_FEE"


def test_odsetki_od_kredytu_bez_sladu_rachunku_maklerskiego_nie_sa_odsetkami_od_marzy() -> None:
    """Kredyt hipoteczny czy gotowkowy z wyciagu bankowego nie finansuje z zalozenia inwestycji."""
    assert kategoria("Odsetki od kredytu hipotecznego", "", "-500.00")["cost_bucket"] == "LOAN_INTEREST"
    assert kategoria("Interest", "Loan interest - personal loan", "-12.00")["cost_bucket"] == "LOAN_INTEREST"
    # Kredyt maklerski (marza) zostaje kosztem odsetek inwestycyjnych.
    assert kategoria("Odsetki od kredytu", "margin loan interest", "-200.00")["cost_bucket"] == "MARGIN_INTEREST"


def test_reczna_oplata_depozytowa_i_za_przelew_trafia_do_znanych_koszykow() -> None:
    from investment_tax_engine.app.manual_overrides import _manual_event_tax_attributes

    assert _manual_event_tax_attributes("CUSTODY_FEE", "", Decimal("-5"))[1] == "ACCOUNT_FEE"
    assert _manual_event_tax_attributes("TRANSFER_FEE", "", Decimal("-5"))[1] == "FUNDING_TRANSFER_FEE"
    assert _manual_event_tax_attributes("LOAN_INTEREST", "", Decimal("-5"))[1] == "LOAN_INTEREST"
