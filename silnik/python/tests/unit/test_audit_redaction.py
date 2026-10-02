from __future__ import annotations

from investment_tax_engine.export.audit_json import redact_string


def test_dates_survive_redaction():
    """Data jest osia sladu audytowego i nie moze zniknac za maska."""
    assert redact_string("2025-11-14") == "2025-11-14"
    assert redact_string("2025-11-14T15:02:54") == "2025-11-14T15:02:54"
    assert redact_string("financing:USD:2025-11-14") == "financing:USD:2025-11-14"


def test_amounts_and_rates_survive_redaction():
    assert redact_string("13845.96666261102") == "13845.96666261102"
    assert redact_string("0.00041095") == "0.00041095"
    assert redact_string("-5.37") == "-5.37"


def test_broker_identifiers_survive_redaction():
    assert redact_string("491018680") == "491018680"
    assert redact_string("488585388/427865477") == "488585388/427865477"


def test_phone_numbers_are_redacted():
    assert "***" in redact_string("+48123456789")
    assert "***" in redact_string("48 123 456 789")
    assert "***" in redact_string("(22) 123-45-67")


def test_email_addresses_are_redacted():
    assert redact_string("jan@example.com") == "***@***"


def test_phone_inside_a_sentence_is_redacted_without_eating_the_rest():
    result = redact_string("Kontakt: 48 123 456 789 w sprawie 2025-11-14")
    assert "***" in result
    assert "2025-11-14" in result
    assert result.startswith("Kontakt:")


def test_oversized_cell_is_marked_not_silently_cut():
    """Openpyxl obcina komorke po cichu; pakiet dowodowy musi to sygnalizowac."""
    from investment_tax_engine.export.workbook import EXCEL_MAX_CELL_LENGTH, rows_or_empty

    frame = rows_or_empty([{"trace": "x" * (EXCEL_MAX_CELL_LENGTH + 500)}])
    cell = frame.iloc[0]["trace"]

    assert len(cell) <= EXCEL_MAX_CELL_LENGTH
    assert cell.endswith("eksporcie JSON]")


def test_normal_cells_are_left_untouched():
    from investment_tax_engine.export.workbook import rows_or_empty

    frame = rows_or_empty([{"date": "2025-11-14", "amount": "89.77"}])

    assert frame.iloc[0]["date"] == "2025-11-14"
    assert frame.iloc[0]["amount"] == "89.77"


def test_provenance_fields_survive_redaction():
    """source_name mowi, z ktorego pliku pochodzi transakcja - to rdzen sladu dowodowego."""
    from investment_tax_engine.export.audit_json import redact_payload

    payload = {
        "source_name": "API_JSON_FULL",
        "plan_name": "aggressive_user",
        "scenario_name": "defensible",
        "instrument_name": "NBIS.US",
        "trade_id": "491018680",
    }

    assert redact_payload(payload, True) == payload


def test_boolean_policy_flag_is_not_treated_as_sensitive():
    """bool dziedziczy po int, wiec bez wyjatku flaga zamieniala sie w gwiazdki."""
    from investment_tax_engine.export.audit_json import redact_payload

    payload = {"include_fx_conversion_costs": True, "pii_redaction_enabled": False}

    assert redact_payload(payload, True) == payload


def test_boolean_under_a_sensitive_key_is_still_a_flag_not_a_personal_datum():
    """Wartosc logiczna nie jest niczyim nazwiskiem ani adresem, nawet pod taka nazwa."""
    from investment_tax_engine.export.audit_json import redact_payload

    assert redact_payload({"email": True}, True) == {"email": True}
    assert redact_payload({"email": "jan@example.com"}, True) == {"email": "***"}


def test_personal_fields_are_still_redacted():
    from investment_tax_engine.export.audit_json import redact_payload

    payload = {"client_name": "Jan Kowalski", "email": "jan@example.com", "pesel": "90010112345"}
    result = redact_payload(payload, True)

    assert set(result.values()) == {"***"}


def test_pit38_form_values_round_half_up_not_bankers():
    """Ordynacja podatkowa wymaga zaokraglania w gore od polowy."""
    from decimal import Decimal

    from investment_tax_engine.tax.filing_package import _q0, _q2

    assert _q0(Decimal("12344.50")) == Decimal("12345")
    assert _q0(Decimal("2344.50")) == Decimal("2345")
    assert _q2(Decimal("1.005")) == Decimal("1.01")
    # Zaokraglenie w dol dziala bez zmian.
    assert _q0(Decimal("12344.49")) == Decimal("12344")


def test_each_tax_component_is_rounded_once_not_the_sum():
    """Ordynacja podatkowa art. 63 par. 1: kazdy podatek do pelnych zlotych osobno.

    Sprawdzane na prawdziwym budowaniu pozycji formularza, a nie na samej
    arytmetyce - zaokraglanie dopiero sumy dawalo w pozycji 51 o zlotowke wiecej
    niz w pozycji 35 tego samego formularza.
    """
    from dataclasses import dataclass, field
    from decimal import Decimal
    from typing import Any

    from investment_tax_engine.tax.filing_package import _build_scenario_projection

    @dataclass
    class _Scenario:
        total_revenue_pln: Decimal
        total_cost_pln: Decimal
        gross_result_pln: Decimal
        taxable_base_pln: Decimal
        tax_19_pln: Decimal

    @dataclass
    class _Result:
        scenario_results: dict[str, Any]
        annual_summary: dict[str, Any] = field(default_factory=dict)

    # Podstawa 34334 zl -> podatek 6523,46 zl. Dywidenda 0,74 zl -> doplata 0,14 zl.
    scenario = _Scenario(
        total_revenue_pln=Decimal("1499215.59"),
        total_cost_pln=Decimal("1464881.37"),
        gross_result_pln=Decimal("34334.22"),
        taxable_base_pln=Decimal("34334.22"),
        tax_19_pln=Decimal("6523.50"),
    )
    result = _Result(
        scenario_results={"aggressive_user": scenario},
        annual_summary={"art30a": {"gross_dividends_pln": "0.74", "foreign_withholding_tax_pln": "0.00"}},
    )

    projection = _build_scenario_projection(result, "aggressive_user")
    fields = {field_entry.position: field_entry.value for field_entry in projection.form_fields}

    assert fields["35"] == Decimal("6523"), "podatek nalezny z art. 30b"
    assert fields["51"] == Decimal("6523"), "laczny podatek nie moze byc wyzszy od sumy zaokraglonych pozycji"
    assert fields["35"] == fields["51"], "obie pozycje opisuja ten sam podatek powiekszony o 0 zl doplaty"


def test_a_real_dividend_top_up_reaches_the_total():
    """Zaokraglanie kazdej pozycji osobno nie moze zgubic realnej doplaty."""
    from dataclasses import dataclass, field
    from decimal import Decimal
    from typing import Any

    from investment_tax_engine.tax.filing_package import _build_scenario_projection

    @dataclass
    class _Scenario:
        total_revenue_pln: Decimal
        total_cost_pln: Decimal
        gross_result_pln: Decimal
        taxable_base_pln: Decimal
        tax_19_pln: Decimal

    @dataclass
    class _Result:
        scenario_results: dict[str, Any]
        annual_summary: dict[str, Any] = field(default_factory=dict)

    # 10 000 zl dywidendy z USA, 15% potracone u zrodla: 1900 - 1500 = 400 zl doplaty.
    scenario = _Scenario(
        total_revenue_pln=Decimal("100000.00"),
        total_cost_pln=Decimal("90000.00"),
        gross_result_pln=Decimal("10000.00"),
        taxable_base_pln=Decimal("10000.00"),
        tax_19_pln=Decimal("1900.00"),
    )
    result = _Result(
        scenario_results={"aggressive_user": scenario},
        annual_summary={"art30a": {"gross_dividends_pln": "10000.00", "foreign_withholding_tax_pln": "1500.00"}},
    )

    projection = _build_scenario_projection(result, "aggressive_user")
    fields = {field_entry.position: field_entry.value for field_entry in projection.form_fields}

    assert fields["47"] == Decimal("1900.00"), "polskie 19% od dywidendy brutto"
    assert fields["48"] == Decimal("1500.00"), "podatek zaplacony u zrodla"
    assert fields["49"] == Decimal("400"), "roznica 1900 - 1500 wchodzi do poz. 49"
    assert fields["35"] == Decimal("1900")
    assert fields["51"] == Decimal("2300"), "1900 z art. 30b plus 400 zl doplaty od dywidendy"


def test_the_form_adds_up_when_a_prior_year_loss_is_deducted():
    """Poz. 28 minus poz. 30 musi dawac poz. 31.

    Pozycja 30 byla wpisana na sztywno jako zero, a pozycja 31 juz uwzgledniala
    odliczenie - przepisane zeznanie urzad przeliczylby na wyzsza podstawe.
    """
    from dataclasses import dataclass, field
    from decimal import Decimal
    from typing import Any

    from investment_tax_engine.tax.filing_package import _build_scenario_projection

    @dataclass
    class _Scenario:
        total_revenue_pln: Decimal
        total_cost_pln: Decimal
        gross_result_pln: Decimal
        taxable_base_pln: Decimal
        tax_19_pln: Decimal

    @dataclass
    class _Result:
        scenario_results: dict[str, Any]
        annual_summary: dict[str, Any] = field(default_factory=dict)

    # Dochod 10 000, odliczona strata 3 000, podstawa 7 000.
    scenario = _Scenario(
        total_revenue_pln=Decimal("100000.00"),
        total_cost_pln=Decimal("90000.00"),
        gross_result_pln=Decimal("10000.00"),
        taxable_base_pln=Decimal("7000.00"),
        tax_19_pln=Decimal("1330.00"),
    )
    result = _Result(
        scenario_results={"aggressive_user": scenario},
        annual_summary={"prior_year_loss_used_pln": "3000.00", "art30a": {}},
    )

    fields = {f.position: f.value for f in _build_scenario_projection(result, "aggressive_user").form_fields}

    assert fields["28"] == Decimal("10000.00"), "dochod przed odliczeniem"
    assert fields["30"] == Decimal("3000.00"), "odliczona strata musi byc widoczna"
    assert fields["31"] == Decimal("7000"), "podstawa po odliczeniu"
    assert fields["28"] - fields["30"] == fields["31"], "formularz musi sie domykac"
