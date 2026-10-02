from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from investment_tax_engine.validation.category_coverage import (
    CATEGORY_COVERAGE_ISSUE_CODE,
    build_category_coverage_issues,
    coverage_summary,
)
from investment_tax_engine.validation.quality_gates import build_quality_report


@dataclass
class _CostItem:
    kind: str


@dataclass
class _FifoRow:
    cost_pln: Decimal


@dataclass
class _Ledger:
    trades_by_id: dict[str, Any] = field(default_factory=dict)


@dataclass
class _MergeResult:
    ledger: _Ledger = field(default_factory=_Ledger)


@dataclass
class _Result:
    """Minimalny wynik silnika - bramka czyta z niego tylko artefakty kategorii."""

    cost_items: list[_CostItem] = field(default_factory=list)
    fifo_rows: list[_FifoRow] = field(default_factory=list)
    dividends_view: list[dict[str, Any]] = field(default_factory=list)
    private_cash_fx_view: list[Any] = field(default_factory=list)
    foreign_tax_view: list[Any] = field(default_factory=list)
    financing_ledger: dict[str, Any] = field(default_factory=dict)
    merge_result: _MergeResult = field(default_factory=_MergeResult)


def _report(**kinds: int) -> dict[str, Any]:
    return {"availableSupportEventsByKind": dict(kinds)}


def test_commission_on_input_without_a_cost_item_stops_the_gate():
    """Dokladnie ta awaria: 341 prowizji na wejsciu, zero pozycji kosztowych."""
    issues = build_category_coverage_issues(_Result(), _report(commission=341))

    assert [issue.code for issue in issues] == [CATEGORY_COVERAGE_ISSUE_CODE]
    assert "ponownie zaimportuj plik" in issues[0].message.lower()
    assert "dokumenty i silnik" in issues[0].message.lower()
    assert "podaj nazwę pliku" in issues[0].message.lower()
    assert issues[0].blocking is True
    assert issues[0].details["input_event_count"] == 341
    assert "prowizje" in issues[0].message


def test_commission_with_a_matching_cost_item_passes():
    result = _Result(cost_items=[_CostItem(kind="TRADE_COMMISSION")])

    assert build_category_coverage_issues(result, _report(commission=341)) == []


def test_a_cost_item_of_another_kind_does_not_cover_commissions():
    result = _Result(cost_items=[_CostItem(kind="INVESTMENT_INTEREST")])

    assert [issue.code for issue in build_category_coverage_issues(result, _report(commission=5))] == [
        CATEGORY_COVERAGE_ISSUE_CODE
    ]


def test_interest_requires_a_financing_episode():
    lost = build_category_coverage_issues(_Result(financing_ledger={"episode_count": 0}), _report(interest=36))
    kept = build_category_coverage_issues(_Result(financing_ledger={"episode_count": 1}), _report(interest=36))

    assert [issue.details["categories"] for issue in lost] == [["interest"]]
    assert kept == []


def test_dividends_require_a_dividend_row():
    lost = build_category_coverage_issues(_Result(), _report(dividend=5))
    kept = build_category_coverage_issues(_Result(dividends_view=[{"event_id": "DIV-1"}]), _report(dividend=5))

    assert len(lost) == 1
    assert kept == []


def test_awards_require_a_matched_acquisition_lot():
    """Wiersz FIFO o zerowej podstawie kosztowej to sprzedaz bez pokrycia, nie nabycie."""
    uncovered = _Result(fifo_rows=[_FifoRow(cost_pln=Decimal("0.00"))])
    covered = _Result(fifo_rows=[_FifoRow(cost_pln=Decimal("1200.00"))])

    assert len(build_category_coverage_issues(uncovered, _report(stock_award=9))) == 1
    assert build_category_coverage_issues(covered, _report(stock_award=9)) == []


def test_corporate_actions_and_awards_share_one_probe():
    result = _Result(fifo_rows=[_FifoRow(cost_pln=Decimal("10.00"))])

    assert build_category_coverage_issues(result, _report(corporate_action=22, stock_award=9)) == []
    assert len(build_category_coverage_issues(_Result(), _report(corporate_action=22, stock_award=9))) == 1


@dataclass
class _FxRow:
    use_reference: str = ""


def test_fx_events_require_a_cash_settlement_row():
    assert len(build_category_coverage_issues(_Result(), _report(fx=57))) == 1
    covered = _Result(private_cash_fx_view=[_FxRow(use_reference="TRADE-1")])
    assert build_category_coverage_issues(covered, _report(fx=57)) == []


def test_a_cash_row_without_a_conversion_does_not_cover_the_fx_category():
    """Widok gotowki ma tez wiersze z wplat i zakupow - to nie sa przewalutowania."""
    unrelated = _Result(private_cash_fx_view=[_FxRow(use_reference="")])

    assert [issue.code for issue in build_category_coverage_issues(unrelated, _report(fx=57))] == [
        CATEGORY_COVERAGE_ISSUE_CODE
    ]


def test_withholding_tax_on_input_requires_a_row_in_the_foreign_tax_view():
    """Kategoria `tax` nie miala wlasnej sondy, mimo ze niesie prawo do odliczenia."""
    lost = build_category_coverage_issues(_Result(), _report(tax=8))
    kept = build_category_coverage_issues(
        _Result(foreign_tax_view=[{"event_id": "TAX-1"}]), _report(tax=8)
    )

    assert [issue.details["categories"] for issue in lost] == [["tax"]]
    assert kept == []


def test_a_category_absent_from_the_input_is_not_required_on_output():
    assert build_category_coverage_issues(_Result(), _report(commission=0, dividend=0)) == []
    assert build_category_coverage_issues(_Result(), _report()) == []


def test_a_run_without_the_canonical_report_is_not_judged():
    """Sciezka jawnych plikow nie ma tego raportu - bramka nie moze zgadywac."""
    assert build_category_coverage_issues(_Result(), None) == []
    assert build_category_coverage_issues(_Result(), {"status": "used"}) == []


def test_the_gate_blocks_the_filing_package():
    issues = build_category_coverage_issues(_Result(), _report(commission=341))
    report = build_quality_report(issues)

    assert report.filing_ready is False
    assert report.final_status == "CALCULATION_BLOCKED"


def test_summary_reports_both_sides_for_every_category():
    result = _Result(cost_items=[_CostItem(kind="TRADE_COMMISSION")])

    summary = {tuple(row["categories"]): row for row in coverage_summary(result, _report(commission=341, dividend=5))}

    assert summary[("commission",)]["input_event_count"] == 341
    assert summary[("commission",)]["output_count"] == 1
    assert summary[("dividend",)]["input_event_count"] == 5
    assert summary[("dividend",)]["output_count"] == 0


@dataclass
class _Trade:
    commission: Decimal = Decimal("0")
    commission_pln: Decimal = Decimal("0")


def test_commission_inside_a_trade_also_counts_as_a_trace():
    """Prowizja podana przy transakcji nie tworzy osobnej pozycji kosztowej."""
    result = _Result(merge_result=_MergeResult(_Ledger({"T-1": _Trade(commission=Decimal("2.40"))})))

    assert build_category_coverage_issues(result, _report(commission=341)) == []


def test_counting_categories_does_not_go_through_the_splitter():
    """Bramka ma wykryc miedzy innymi to, ze podzial przestal zwracac zdarzenia."""
    from investment_tax_engine.app.canonical_tax_input_adapter import (
        count_event_kinds_in_canonical_tax_input,
    )

    tax_input = {
        "schema_version": "canonical_tax_input.v2",
        "records": [
            {"event_id": "E-1", "event_kind": "commission"},
            {"event_id": "E-2", "event_kind": "commission"},
            {"event_id": "E-3", "event_kind": "dividend"},
            {"event_id": "T-1", "event_kind": "trade"},
            "nie slownik",
        ],
    }

    assert count_event_kinds_in_canonical_tax_input(tax_input) == {"commission": 2, "dividend": 1}


def test_counting_categories_ignores_an_unknown_contract():
    from investment_tax_engine.app.canonical_tax_input_adapter import (
        count_event_kinds_in_canonical_tax_input,
    )

    assert count_event_kinds_in_canonical_tax_input({"schema_version": "cos.innego", "records": []}) == {}
    assert count_event_kinds_in_canonical_tax_input(None) == {}


def test_a_source_at_the_row_limit_is_reported():
    """Limit wierszy obcina po cichu - milczaca utrata transakcji jest najgorszym bledem."""
    from investment_tax_engine.storage.transaction_intelligence import sources_hitting_the_row_limit

    class _Source:
        def __init__(self, filename: str, rows: int) -> None:
            self.filename = filename
            self._rows = rows

    import investment_tax_engine.storage.transaction_intelligence as ti

    original = ti._source_rows
    ti._source_rows = lambda source, *, max_rows_per_source: [None] * min(source._rows, max_rows_per_source)
    try:
        hit = sources_hitting_the_row_limit(
            [_Source("maly.json", 840), _Source("ogromny.json", 5000)], max_rows_per_source=2000
        )
    finally:
        ti._source_rows = original

    assert [entry["filename"] for entry in hit] == ["ogromny.json"]
    assert hit[0]["limit"] == 2000


def test_sources_below_the_limit_are_not_reported():
    from investment_tax_engine.storage.transaction_intelligence import sources_hitting_the_row_limit

    class _Source:
        def __init__(self, filename: str, rows: int) -> None:
            self.filename = filename
            self._rows = rows

    import investment_tax_engine.storage.transaction_intelligence as ti

    original = ti._source_rows
    ti._source_rows = lambda source, *, max_rows_per_source: [None] * min(source._rows, max_rows_per_source)
    try:
        assert sources_hitting_the_row_limit([_Source("maly.json", 1999)], max_rows_per_source=2000) == []
    finally:
        ti._source_rows = original


def _report_with_review(available: dict, held: dict) -> dict:
    return {"availableSupportEventsByKind": available, "recordsHeldForReviewByKind": held}


def test_a_category_waiting_for_a_user_decision_is_not_a_lost_category():
    """Zapis odlozony do decyzji nie zniknal - czeka, wiec bramka go nie liczy jako straty."""
    result = _Result(fifo_rows=[])

    issues = build_category_coverage_issues(
        result, _report_with_review({"corporate_action": 22, "stock_award": 9}, {"corporate_action": 16, "stock_award": 9})
    )

    assert issues == []


def test_a_category_that_is_neither_settled_nor_held_still_stops_the_gate():
    result = _Result(fifo_rows=[])

    issues = build_category_coverage_issues(
        result, _report_with_review({"corporate_action": 22}, {"commission": 3})
    )

    assert [issue.code for issue in issues] == [CATEGORY_COVERAGE_ISSUE_CODE]


def test_withholding_tax_is_a_consumable_category():
    """Podatek u zrodla daje prawo do odliczenia, wiec musi docierac do silnika."""
    from investment_tax_engine.app.canonical_tax_input_adapter import CONSUMABLE_SUPPORT_EVENT_KINDS

    assert "tax" in CONSUMABLE_SUPPORT_EVENT_KINDS


def test_a_source_tax_row_is_not_classified_as_a_corporate_action():
    """Zdanie "Corporate action tax on security" wpadalo do kategorii korporacyjnej."""
    from investment_tax_engine.storage.transaction_intelligence import _is_source_tax_row

    tax_row = {
        "type": "Podatki",
        "type_id": "tax",
        "comment": "Corporate action tax on security ( MRVL.US ), record date 2025-10-10 . Tax rate 15",
    }
    assert _is_source_tax_row(tax_row, "corporate action tax on security ( mrvl.us )") is True

    real_corporate_action = {"type": "Akcja korporacyjna", "type_id": "corporate_action"}
    assert _is_source_tax_row(real_corporate_action, "corporate action split 2:1") is False

    commission = {"type": "Prowizja", "type_id": "commission"}
    assert _is_source_tax_row(commission, "trade commission for nbis.us") is False
