from __future__ import annotations

from investment_tax_engine.models.core import Issue
from investment_tax_engine.validation.quality_gates import build_quality_report


def _issue(
    code: str,
    severity: str,
    *,
    blocking: bool = False,
    stage: str = "TAX_FX",
    details: dict | None = None,
) -> Issue:
    return Issue(
        code=code,
        severity=severity,
        stage=stage,
        scope_type="ENGINE",
        scope_id="S-1",
        message=f"{code} test issue",
        blocking=blocking,
        details=details or {},
    )


def test_missing_nbp_rate_blocks_filing_package():
    """Bramka 1: brak kursu NBP dla ktorejkolwiek transakcji zatrzymuje pakiet."""
    report = build_quality_report(
        [_issue("NBP_RATE_NOT_FOUND", "CRITICAL")]
    )

    assert report.filing_ready is False
    assert report.final_status == "CALCULATION_BLOCKED"
    assert report.metrics["blocking_count"] == 1
    assert report.metrics["warning_count"] == 0
    assert [issue.code for issue in report.blocking_issues] == ["NBP_RATE_NOT_FOUND"]


def test_nbp_coverage_gap_alone_is_a_warning_not_a_blocker():
    """Luka w archiwum nie znaczy, ze kursu brakuje - fallback mogl go dostarczyc."""
    report = build_quality_report(
        [_issue("NBP_COVERAGE_GAP", "CRITICAL", details={"currency": "USD"})]
    )

    assert report.filing_ready is True
    assert report.final_status == "SUCCESS_WITH_WARNINGS"
    assert [issue.code for issue in report.warning_issues] == ["NBP_COVERAGE_GAP"]


def test_nbp_coverage_gap_blocks_when_a_rate_in_that_currency_is_missing():
    report = build_quality_report(
        [
            _issue("NBP_COVERAGE_GAP", "CRITICAL", details={"currency": "USD"}),
            _issue("NBP_RATE_NOT_FOUND", "CRITICAL", details={"currency": "USD"}),
        ]
    )

    assert report.filing_ready is False
    assert report.final_status == "CALCULATION_BLOCKED"
    assert report.metrics["blocking_count"] == 2


def test_nbp_coverage_gap_in_another_currency_stays_a_warning():
    """Brak kursu dolara nie podwaza kursow euro dostarczonych przez fallback."""
    report = build_quality_report(
        [
            _issue("NBP_COVERAGE_GAP", "CRITICAL", details={"currency": "EUR"}),
            _issue("NBP_RATE_NOT_FOUND", "CRITICAL", details={"currency": "USD"}),
        ]
    )

    assert [issue.code for issue in report.blocking_issues] == ["NBP_RATE_NOT_FOUND"]
    assert [issue.code for issue in report.warning_issues] == ["NBP_COVERAGE_GAP"]


def test_missing_rate_without_a_currency_blocks_every_coverage_gap():
    """Brak kursu bez wskazanej waluty moze dotyczyc kazdej z nich."""
    report = build_quality_report(
        [
            _issue("NBP_COVERAGE_GAP", "CRITICAL", details={"currency": "EUR"}),
            _issue("SELL_WITHOUT_PLN_REVENUE", "CRITICAL"),
        ]
    )

    assert report.filing_ready is False
    assert report.metrics["blocking_count"] == 2


def test_coverage_gap_marked_blocking_at_runtime_still_blocks():
    report = build_quality_report(
        [_issue("NBP_COVERAGE_GAP", "CRITICAL", blocking=True, details={"currency": "USD"})]
    )

    assert report.filing_ready is False


def test_sell_exceeding_fifo_lots_blocks_filing_package():
    """Bramka 2: ujemny stan posiadania w FIFO zatrzymuje pakiet."""
    report = build_quality_report(
        [_issue("SELL_EXCEEDS_FIFO_LOTS", "CRITICAL", blocking=True, stage="FIFO")]
    )

    assert report.filing_ready is False
    assert report.final_status == "CALCULATION_BLOCKED"
    assert report.metrics["blocking_count"] == 1
    assert report.metrics["runtime_blocking_count"] == 1


def test_unresolved_statement_conflicts_block_filing_package():
    """Bramka 3: nierozwiazane konflikty miedzy wyciagami zatrzymuja pakiet."""
    report = build_quality_report(
        [
            _issue("DUPLICATE_TRADE_ID", "CRITICAL", stage="MERGE"),
            _issue("DEPO_POSITION_MISMATCH", "CRITICAL", stage="RECONCILE"),
        ]
    )

    assert report.filing_ready is False
    assert report.final_status == "CALCULATION_BLOCKED"
    assert report.metrics["blocking_count"] == 2


def test_resolved_field_conflict_stays_a_warning():
    """merge_engine wybiera zwyciezce wedlug priorytetu zrodel, wiec konflikt jest rozwiazany."""
    report = build_quality_report(
        [_issue("FIELD_CONFLICT", "WARNING", stage="MERGE")]
    )

    assert report.filing_ready is True
    assert report.final_status == "SUCCESS_WITH_WARNINGS"
    assert report.metrics["blocking_count"] == 0
    assert report.metrics["warning_count"] == 1


def test_funding_and_fx_trace_gaps_stay_diagnostic():
    """Braki sladu kosztow scenariuszowych nie sa bramka krytyczna."""
    report = build_quality_report(
        [
            _issue("FUNDING_FEE_WITHOUT_DEPOSIT_LINK", "ERROR", stage="COST_POLICY"),
            _issue("FX_CONVERSION_COST_WITHOUT_TRACE", "ERROR", stage="COST_POLICY"),
        ]
    )

    assert report.filing_ready is True
    assert report.final_status == "SUCCESS_WITH_WARNINGS"
    assert report.metrics["blocking_count"] == 0
    assert report.metrics["warning_count"] == 2


def test_clean_run_reports_success():
    report = build_quality_report(
        [_issue("BROKER_XML_NOT_SUPPLIED", "INFO", stage="INTAKE")]
    )

    assert report.filing_ready is True
    assert report.final_status == "SUCCESS"
    assert report.metrics["blocking_count"] == 0
    assert report.metrics["warning_count"] == 0
    assert report.metrics["info_count"] == 1


def test_blocking_and_warning_issues_are_separated():
    report = build_quality_report(
        [
            _issue("NBP_RATE_NOT_FOUND", "CRITICAL"),
            _issue("FIELD_CONFLICT", "WARNING", stage="MERGE"),
            _issue("BROKER_XML_NOT_SUPPLIED", "INFO", stage="INTAKE"),
        ]
    )

    assert report.filing_ready is False
    assert report.metrics == {
        "blocking_count": 1,
        "runtime_blocking_count": 0,
        "warning_count": 1,
        "info_count": 1,
    }


def test_sale_without_matching_lots_blocks_under_default_policy():
    """Przy domyslnej polityce sprzedaz bez pokrycia zglasza AWARD_POLICY_UNRESOLVED.

    Kod SELL_EXCEEDS_FIFO_LOTS jest w tej konfiguracji nieosiagalny, wiec sama
    jego obecnosc w bramce nie chronila przed niczym.
    """
    report = build_quality_report([_issue("AWARD_POLICY_UNRESOLVED", "ERROR", stage="FIFO")])

    assert report.filing_ready is False
    assert report.final_status == "CALCULATION_BLOCKED"
    assert report.metrics["blocking_count"] == 1


def test_unnormalizable_row_blocks_the_filing():
    """Wiersz, ktorego nie udalo sie znormalizowac, oznacza niepelny zbior danych."""
    report = build_quality_report([_issue("NORMALIZE_ERROR", "ERROR", stage="NORMALIZE")])

    assert report.filing_ready is False
    assert report.final_status == "CALCULATION_BLOCKED"


def test_missing_required_input_blocks_the_filing():
    report = build_quality_report([_issue("MISSING_REQUIRED_INPUT", "CRITICAL", stage="INTAKE")])

    assert report.filing_ready is False


def test_dividend_without_pln_amount_blocks_filing_package():
    """Dywidenda bez kwoty w zlotych zatrzymuje pakiet.

    `event.amount_pln or Decimal("0.00")` w zestawieniu dywidend zamienialo brak
    kursu NBP w przychod 0,00 PLN. Transakcje mialy na to bramki
    BUY_WITHOUT_PLN_COST i SELL_WITHOUT_PLN_REVENUE, dywidendy nie mialy zadnej.
    """
    report = build_quality_report([_issue("DIVIDEND_WITHOUT_PLN_AMOUNT", "ERROR")])

    assert report.filing_ready is False
    assert [issue.code for issue in report.blocking_issues] == ["DIVIDEND_WITHOUT_PLN_AMOUNT"]
