from __future__ import annotations

from decimal import Decimal
from types import SimpleNamespace

from investment_tax_engine.models.core import (
    CanonicalTrade,
    BrokerFileActionOverride,
    CanonicalDataset,
    CostDecision,
    CostItem,
    DefenseEvidenceOverride,
    EngineConfig,
    EngineRunResult,
    FxCoverageGap,
    Issue,
    Ledger,
    MergeResult,
    QualityGateResult,
    ScenarioResult,
    TaxFilingRequest,
    TransactionHistoryRow,
)
from investment_tax_engine.tax.filing_package import _build_scenario_projection, generate_tax_filing_package, populate_form_summary
import pandas as pd


def make_engine_result(*, filing_ready: bool = True) -> EngineRunResult:
    merge_result = MergeResult(ledger=Ledger(), canonical_dataset=CanonicalDataset())
    return EngineRunResult(
        status="SUCCESS" if filing_ready else "SUCCESS_WITH_WARNINGS",
        filing_ready=filing_ready,
        config=EngineConfig(tax_year=2025),
        canonical_dataset=CanonicalDataset(),
        merge_result=merge_result,
        filing_profile="AGGRESSIVE",
        plan_used="aggressive_user",
        primary_scenario="aggressive_user",
        annual_summary={
            "tax_year": "2025",
            "pit38_rounded_revenue_pln": "1000",
            "pit38_rounded_cost_pln": "700",
            "pit38_income": "300",
            "pit38_loss": "0",
            "tax_19_pln": "57",
            "net_pln": "243",
            "art30b": {
                "pit38_rounded_revenue_pln": "1000",
                "pit38_rounded_cost_pln": "700",
                "pit38_income": "300",
                "pit38_loss": "0",
                "tax_19_pln": "57",
            },
            "art30a": {
                "gross_dividends_pln": "0",
                "foreign_withholding_tax_pln": "0",
            },
        },
        quality_report=QualityGateResult(
            filing_ready=filing_ready,
            final_status="SUCCESS" if filing_ready else "SUCCESS_WITH_WARNINGS",
            blocking_issues=[],
            warning_issues=[],
            informational_issues=[],
            metrics={},
        ),
        cost_decisions=[
            CostDecision(
                cost_id="FXC-1",
                plan_name="aggressive_user",
                included=True,
                reason="included_by_policy",
                evidence_level="STRONG",
                amount_pln=Decimal("12.34"),
                kind="FX_CONVERSION_SPREAD_COST",
                aggressive_only=True,
            )
        ],
    )


def test_pit8c_linked_plan_cost_goes_to_position_21_and_unlinked_to_23():
    for target, expected_21, expected_23 in [
        ("SELL-PL", Decimal("60"), Decimal("0")),
        (None, Decimal("50"), Decimal("10")),
    ]:
        result = make_engine_result()
        result.annual_summary["art30b"].update({
            "pit8c_revenue_pln": "100", "pit8c_cost_pln": "50",
            "pit8c_sell_trade_ids": ["SELL-PL"],
        })
        result.scenario_results["aggressive_user"] = ScenarioResult(
            scenario_name="aggressive_user", risk_level="high",
            gross_result_pln=Decimal("40"), taxable_base_pln=Decimal("40"),
            tax_19_pln=Decimal("7.60"), taxes_from_dane_pln=Decimal("0"),
            net_pln=Decimal("32.40"), total_revenue_pln=Decimal("100"),
            total_cost_pln=Decimal("60"),
        )
        result.cost_items = [SimpleNamespace(
            cost_id="PLAN-10", allocation_target=target, amount_pln=Decimal("10"),
        )]
        result.cost_decisions = [CostDecision(
            cost_id="PLAN-10", plan_name="aggressive_user", included=True,
            reason="included_by_policy", evidence_level="DIRECT",
            amount_pln=Decimal("10"), kind="ACCOUNT_FEE",
        )]
        fields = {field.position: field.value for field in _build_scenario_projection(result, "aggressive_user").form_fields}
        assert (fields["20"], fields["21"], fields["23"], fields["27"]) == (
            Decimal("100"), expected_21, expected_23, Decimal("60"),
        )
        assert fields["21"] + fields["23"] == fields["27"]


def test_plain_run_form_summary_matches_package_with_one_zloty_interest():
    result = make_engine_result()
    result.annual_summary["art30a"]["gross_credit_interest_pln"] = "1.00"
    result.scenario_results["aggressive_user"] = ScenarioResult(
        scenario_name="aggressive_user", risk_level="high",
        gross_result_pln=Decimal("300"), taxable_base_pln=Decimal("300"),
        tax_19_pln=Decimal("57"), taxes_from_dane_pln=Decimal("0"),
        net_pln=Decimal("243"), total_revenue_pln=Decimal("1000"),
        total_cost_pln=Decimal("700"),
    )
    populate_form_summary(result)
    fields = result.annual_summary["pit38_form_fields"]
    package_fields = {
        field.position: str(field.value)
        for field in _build_scenario_projection(result, "aggressive_user").form_fields
    }
    # Komplet pozycji, nie wybrane: sama poz. 31 i 45-51 wygladala dla eksportu
    # XML jak pelna mapa i zerowala czesc C.
    assert fields == package_fields
    assert fields["31"] == "300"
    assert fields["47"] == fields["49"] == "0.19"
    assert fields["51"] == result.annual_summary["pit38_form_total_tax_to_pay_pln"] == "57.19"
    # Zalacznik PIT/ZG z tej samej funkcji co poz. 34 - XML nie zgaduje panstwa.
    from investment_tax_engine.tax.filing_package import _pit_zg_rows_for_result
    assert result.annual_summary["pit_zg_rows"] == [
        {
            "country": row["country"],
            "income_pln": str(row["income_pln"].quantize(Decimal("0.01"))),
            "loss_pln": str(row["loss_pln"].quantize(Decimal("0.01"))),
            "foreign_tax_pln": str(row["foreign_tax_pln"].quantize(Decimal("0.01"))),
        }
        for row in _pit_zg_rows_for_result(result)
    ]


def test_pit_zg_allocates_active_extra_costs_by_link_and_revenue_without_changing_form():
    result = make_engine_result()
    result.scenario_results["aggressive_user"] = ScenarioResult(
        scenario_name="aggressive_user", risk_level="high",
        gross_result_pln=Decimal("200"), taxable_base_pln=Decimal("200"),
        tax_19_pln=Decimal("38"), taxes_from_dane_pln=Decimal("0"),
        net_pln=Decimal("162"), total_revenue_pln=Decimal("1000"),
        total_cost_pln=Decimal("800"),
    )
    result.merge_result.ledger.trades_by_id = {
        "SELL-US": SimpleNamespace(trade_id="SELL-US", symbol="AAA.US", isin="US0000000001"),
        "SELL-NL": SimpleNamespace(trade_id="SELL-NL", symbol="BBB.NL", isin="NL0000000001"),
        "BUY-NL": SimpleNamespace(trade_id="BUY-NL", symbol="BBB.NL", isin="NL0000000001"),
    }
    result.fifo_rows = [
        SimpleNamespace(sell_trade_id="SELL-US", gross_revenue_pln=Decimal("600"), cost_pln=Decimal("400"), sell_commission_alloc_pln=Decimal("0"), sell_tax_date=pd.Timestamp("2025-06-01")),
        SimpleNamespace(sell_trade_id="SELL-NL", gross_revenue_pln=Decimal("400"), cost_pln=Decimal("300"), sell_commission_alloc_pln=Decimal("0"), sell_tax_date=pd.Timestamp("2025-06-01")),
    ]
    result.cost_decisions.append(CostDecision(
        cost_id="FUNDING-A1", plan_name="aggressive_user", included=True,
        reason="included_by_policy", evidence_level="DIRECT", amount_pln=Decimal("40"), kind="BANK_FUNDING_FEE",
    ))
    result.funding_fee_allocations = [SimpleNamespace(
        allocation_id="A1", trade_id="BUY-NL", allocated_amount_pln=Decimal("40"),
    )]

    from investment_tax_engine.tax.filing_package import _pit_zg_rows_for_result
    rows = {row["country"]: row for row in _pit_zg_rows_for_result(result)}

    # Koszt powiązany 40 PLN trafia do NL; pozostałe 60 PLN dzieli się 60/40
    # według przychodu US/NL. Suma dochodów minus strat odpowiada poz. 28-29.
    assert rows["US"]["income_pln"] == Decimal("164.00")
    assert rows["NL"]["income_pln"] == Decimal("36.00")
    assert sum((row["income_pln"] - row["loss_pln"] for row in rows.values()), Decimal("0")) == Decimal("200.00")
    fields = {field.position: field.value for field in _build_scenario_projection(result, "aggressive_user").form_fields}
    assert fields["28"] - fields["29"] == Decimal("200.00")
    assert (fields["20"], fields["21"], fields["22"], fields["23"], fields["26"], fields["27"], fields["51"]) == (
        Decimal("0"), Decimal("0"), Decimal("1000"), Decimal("800"), Decimal("1000"), Decimal("800"), Decimal("38")
    )


def test_pit_zg_cost_without_trade_target_is_shared_by_revenue_and_pit8c_difference_stays_in_pl():
    # Prawdziwe dane: odsetki od ujemnego salda maja cel
    # "negative_cash_balance:USD:..." - nie transakcje. Taki koszt trafial do
    # "XX" (6 180 zl), a dochod z USA i Holandii zostawal zawyzony.
    result = make_engine_result()
    result.scenario_results["aggressive_user"] = ScenarioResult(
        scenario_name="aggressive_user", risk_level="high",
        gross_result_pln=Decimal("200"), taxable_base_pln=Decimal("200"),
        tax_19_pln=Decimal("38"), taxes_from_dane_pln=Decimal("0"),
        net_pln=Decimal("162"), total_revenue_pln=Decimal("1000"),
        total_cost_pln=Decimal("800"),
    )
    result.merge_result.ledger.trades_by_id = {
        "SELL-US": SimpleNamespace(trade_id="SELL-US", symbol="AAA.US", isin="US0000000001"),
        "SELL-NL": SimpleNamespace(trade_id="SELL-NL", symbol="BBB.NL", isin="NL0000000001"),
    }
    result.fifo_rows = [
        SimpleNamespace(sell_trade_id="SELL-US", gross_revenue_pln=Decimal("600"), cost_pln=Decimal("400"), sell_commission_alloc_pln=Decimal("0"), sell_tax_date=pd.Timestamp("2025-06-01")),
        SimpleNamespace(sell_trade_id="SELL-NL", gross_revenue_pln=Decimal("400"), cost_pln=Decimal("300"), sell_commission_alloc_pln=Decimal("0"), sell_tax_date=pd.Timestamp("2025-06-01")),
    ]
    result.cost_decisions.append(CostDecision(
        cost_id="COST-ODSETKI", plan_name="aggressive_user", included=True,
        reason="included_by_policy", evidence_level="DIRECT", amount_pln=Decimal("100"), kind="INVESTMENT_INTEREST",
    ))
    result.cost_items = [SimpleNamespace(
        cost_id="COST-ODSETKI", allocation_target="negative_cash_balance:USD:2025-05-31", amount_pln=Decimal("100"),
    )]

    from investment_tax_engine.tax.filing_package import _pit_zg_rows_for_result
    rows = {row["country"]: row for row in _pit_zg_rows_for_result(result)}
    assert "XX" not in rows, "koszt bez transakcji nie trafia do kraju nieustalonego"
    assert rows["US"]["income_pln"] == Decimal("140.00")  # 200 - 60% z 100
    assert rows["NL"]["income_pln"] == Decimal("60.00")   # 100 - 40% z 100

    # Roznica PIT-8C wobec wlasnego rachunku czesci polskiej nalezy do PL.
    result.annual_summary.setdefault("art30b", {}).update({
        "pit8c_revenue_pln": "250.00", "pit8c_cost_pln": "100.00",
        "pit8c_calculated_revenue_pln": "200.00", "pit8c_calculated_cost_pln": "100.00",
    })
    result.scenario_results["aggressive_user"].gross_result_pln = Decimal("250")
    rows = {row["country"]: row for row in _pit_zg_rows_for_result(result)}
    assert rows["US"]["income_pln"] == Decimal("140.00")
    assert rows["NL"]["income_pln"] == Decimal("60.00")
    assert rows["PL"]["income_pln"] == Decimal("50.00")
    assert sum((row["income_pln"] - row["loss_pln"] for row in rows.values()), Decimal("0")) == Decimal("250.00")


def test_pit_zg_refund_linked_to_trade_stays_in_its_country():
    # Oplata US +10 i jej zwrot -10 (oba powiazane z transakcja w US) oraz oplata NL +10.
    # Pominiecie zwrotu dawalo 20 zl "powiazanych" przy 10 zl do rozdzielenia:
    # skalowanie 0,5 przesuwalo 5 zl kosztu z NL do US (US 95 / NL 95 zamiast 100 / 90).
    result = make_engine_result()
    result.scenario_results["aggressive_user"] = ScenarioResult(
        scenario_name="aggressive_user", risk_level="high",
        gross_result_pln=Decimal("190"), taxable_base_pln=Decimal("190"),
        tax_19_pln=Decimal("36.10"), taxes_from_dane_pln=Decimal("0"),
        net_pln=Decimal("153.90"), total_revenue_pln=Decimal("200"),
        total_cost_pln=Decimal("10"),
    )
    result.merge_result.ledger.trades_by_id = {
        "SELL-US": SimpleNamespace(trade_id="SELL-US", symbol="AAA.US", isin="US0000000001"),
        "SELL-NL": SimpleNamespace(trade_id="SELL-NL", symbol="BBB.NL", isin="NL0000000001"),
    }
    result.fifo_rows = [
        SimpleNamespace(sell_trade_id="SELL-US", gross_revenue_pln=Decimal("100"), cost_pln=Decimal("0"), sell_commission_alloc_pln=Decimal("0"), sell_tax_date=pd.Timestamp("2025-06-01")),
        SimpleNamespace(sell_trade_id="SELL-NL", gross_revenue_pln=Decimal("100"), cost_pln=Decimal("0"), sell_commission_alloc_pln=Decimal("0"), sell_tax_date=pd.Timestamp("2025-06-01")),
    ]
    koszty = [
        ("FEE-US", "SELL-US", Decimal("10")),
        ("FEE-US-REFUND", "SELL-US", Decimal("-10")),
        ("FEE-NL", "SELL-NL", Decimal("10")),
    ]
    result.cost_decisions = [
        CostDecision(
            cost_id=cost_id, plan_name="aggressive_user", included=True,
            reason="included_by_policy", evidence_level="DIRECT", amount_pln=kwota, kind="ACCOUNT_FEE",
        )
        for cost_id, _target, kwota in koszty
    ]
    result.cost_items = [
        SimpleNamespace(cost_id=cost_id, allocation_target=target, amount_pln=kwota)
        for cost_id, target, kwota in koszty
    ]

    from investment_tax_engine.tax.filing_package import _pit_zg_rows_for_result
    rows = {row["country"]: row for row in _pit_zg_rows_for_result(result)}

    assert rows["US"]["income_pln"] == Decimal("100.00")
    assert rows["NL"]["income_pln"] == Decimal("90.00")
    assert sum((row["income_pln"] - row["loss_pln"] for row in rows.values()), Decimal("0")) == Decimal("190.00")
    fields = {field.position: field.value for field in _build_scenario_projection(result, "aggressive_user").form_fields}
    assert fields["28"] - fields["29"] == Decimal("190.00")


def test_pit_zg_unlinked_cost_is_shared_after_linked_refund_is_netted():
    # Koszty netto 40 zl: powiazane US +10 -10 = 0, NL +20, a 20 zl niepowiazane
    # dzieli sie po rowno wedlug przychodu (100/100).
    result = make_engine_result()
    result.scenario_results["aggressive_user"] = ScenarioResult(
        scenario_name="aggressive_user", risk_level="high",
        gross_result_pln=Decimal("160"), taxable_base_pln=Decimal("160"),
        tax_19_pln=Decimal("30.40"), taxes_from_dane_pln=Decimal("0"),
        net_pln=Decimal("129.60"), total_revenue_pln=Decimal("200"),
        total_cost_pln=Decimal("40"),
    )
    result.merge_result.ledger.trades_by_id = {
        "SELL-US": SimpleNamespace(trade_id="SELL-US", symbol="AAA.US", isin="US0000000001"),
        "SELL-NL": SimpleNamespace(trade_id="SELL-NL", symbol="BBB.NL", isin="NL0000000001"),
    }
    result.fifo_rows = [
        SimpleNamespace(sell_trade_id="SELL-US", gross_revenue_pln=Decimal("100"), cost_pln=Decimal("0"), sell_commission_alloc_pln=Decimal("0"), sell_tax_date=pd.Timestamp("2025-06-01")),
        SimpleNamespace(sell_trade_id="SELL-NL", gross_revenue_pln=Decimal("100"), cost_pln=Decimal("0"), sell_commission_alloc_pln=Decimal("0"), sell_tax_date=pd.Timestamp("2025-06-01")),
    ]
    koszty = [
        ("FEE-US", "SELL-US", Decimal("10")),
        ("FEE-US-REFUND", "SELL-US", Decimal("-10")),
        ("FEE-NL", "SELL-NL", Decimal("20")),
        ("FEE-SHARED", "negative_cash_balance:USD:2025-05-31", Decimal("20")),
    ]
    result.cost_decisions = [
        CostDecision(
            cost_id=cost_id, plan_name="aggressive_user", included=True,
            reason="included_by_policy", evidence_level="DIRECT", amount_pln=kwota, kind="ACCOUNT_FEE",
        )
        for cost_id, _target, kwota in koszty
    ]
    result.cost_items = [
        SimpleNamespace(cost_id=cost_id, allocation_target=target, amount_pln=kwota)
        for cost_id, target, kwota in koszty
    ]

    from investment_tax_engine.tax.filing_package import _pit_zg_rows_for_result
    rows = {row["country"]: row for row in _pit_zg_rows_for_result(result)}

    # US: 0 powiazane + 10 wspolne; NL: 20 powiazane + 10 wspolne.
    assert rows["US"]["income_pln"] == Decimal("90.00")
    assert rows["NL"]["income_pln"] == Decimal("70.00")
    assert sum((row["income_pln"] - row["loss_pln"] for row in rows.values()), Decimal("0")) == Decimal("160.00")


def test_pit_zg_linked_costs_of_mixed_signs_are_not_scaled():
    # Koszt US +30 i zwrot NL -10 powiazane z transakcjami, do rozdzialu netto 10 zl,
    # a niepowiazany zwrot -10 dzieli sie wedlug przychodu. Skalowanie powiazanych
    # (0,5) przesuwalo tez zwrot NL: US 15 / NL -5 zamiast US 30 / NL -10.
    result = make_engine_result()
    result.scenario_results["aggressive_user"] = ScenarioResult(
        scenario_name="aggressive_user", risk_level="high",
        gross_result_pln=Decimal("190"), taxable_base_pln=Decimal("190"),
        tax_19_pln=Decimal("36.10"), taxes_from_dane_pln=Decimal("0"),
        net_pln=Decimal("153.90"), total_revenue_pln=Decimal("200"),
        total_cost_pln=Decimal("10"),
    )
    result.merge_result.ledger.trades_by_id = {
        "SELL-US": SimpleNamespace(trade_id="SELL-US", symbol="AAA.US", isin="US0000000001"),
        "SELL-NL": SimpleNamespace(trade_id="SELL-NL", symbol="BBB.NL", isin="NL0000000001"),
    }
    result.fifo_rows = [
        SimpleNamespace(sell_trade_id="SELL-US", gross_revenue_pln=Decimal("100"), cost_pln=Decimal("0"), sell_commission_alloc_pln=Decimal("0"), sell_tax_date=pd.Timestamp("2025-06-01")),
        SimpleNamespace(sell_trade_id="SELL-NL", gross_revenue_pln=Decimal("100"), cost_pln=Decimal("0"), sell_commission_alloc_pln=Decimal("0"), sell_tax_date=pd.Timestamp("2025-06-01")),
    ]
    koszty = [
        ("FEE-US", "SELL-US", Decimal("30")),
        ("REFUND-NL", "SELL-NL", Decimal("-10")),
        ("REFUND-SHARED", "negative_cash_balance:USD:2025-05-31", Decimal("-10")),
    ]
    result.cost_decisions = [
        CostDecision(
            cost_id=cost_id, plan_name="aggressive_user", included=True,
            reason="included_by_policy", evidence_level="DIRECT", amount_pln=kwota, kind="ACCOUNT_FEE",
        )
        for cost_id, _target, kwota in koszty
    ]
    result.cost_items = [
        SimpleNamespace(cost_id=cost_id, allocation_target=target, amount_pln=kwota)
        for cost_id, target, kwota in koszty
    ]

    from investment_tax_engine.tax.filing_package import _pit_zg_rows_for_result
    rows = {row["country"]: row for row in _pit_zg_rows_for_result(result)}

    # US: koszt 30, wspolny zwrot -5 => dochod 75; NL: zwrot -10 i -5 => dochod 115.
    assert rows["US"]["income_pln"] == Decimal("75.00")
    assert rows["NL"]["income_pln"] == Decimal("115.00")
    assert sum((row["income_pln"] - row["loss_pln"] for row in rows.values()), Decimal("0")) == Decimal("190.00")


def test_generate_full_tax_filing_package_includes_calculation_and_justification():
    result = make_engine_result(filing_ready=True)

    package = generate_tax_filing_package(
        result,
        TaxFilingRequest(package_scope="full", filing_mode="CORRECTION"),
    )

    assert package.draft.form_type == "PIT-38"
    assert package.draft.filing_mode == "CORRECTION"
    assert package.calculation is not None
    assert package.justification is not None
    assert "Aggressive" in package.justification.summary
    assert any("FX_CONVERSION_SPREAD_COST" in note for note in package.justification.policy_notes)
    assert package.audit_appendix is not None


def test_tax_filing_package_includes_result_health_check_ok_for_active_nonzero_source():
    result = make_engine_result(filing_ready=True)
    result.merge_result.ledger.metadata["source_manifest_v2"] = [
        {
            "sourceId": "src:baseline",
            "filename": "historia_transakcji.json",
            "detectedType": "legacy_json",
            "sourceResolutionRole": "primary_tax",
            "contributesToTax": True,
        }
    ]
    result.transaction_history_rows = [
        TransactionHistoryRow(
            row_id="SELL-1",
            parent_row_id=None,
            row_kind="TRADE",
            display_date=pd.Timestamp("2025-06-01"),
            transaction_id="SELL-1",
            ticker="ABC",
            side="SELL",
            tax_impact_kind="PIT_COUNTED",
        )
    ]
    result.audit_hash = "stable-hash"

    package = generate_tax_filing_package(
        result,
        TaxFilingRequest(package_scope="full", filing_mode="ORIGINAL"),
    )

    assert package.audit_appendix is not None
    health = package.audit_appendix["result_health_check"]
    assert health["status"] == "ok"
    assert health["activeTaxSourceLabels"] == ["historia_transakcji.json"]
    assert health["recognizedStorageFileCount"] == 1
    assert health["sellRowCount"] == 1
    assert package.audit_appendix["pit_case_file"]["audit_hash"] == "stable-hash"


def test_result_health_check_flags_suspicious_zero_result_without_changing_hash():
    result = make_engine_result(filing_ready=True)
    result.audit_hash = "stable-zero-hash"
    result.annual_summary.update(
        {
            "pit38_rounded_revenue_pln": "0",
            "pit38_rounded_cost_pln": "0",
            "tax_19_pln": "0",
            "net_pln": "0",
            "art30b": {
                "pit38_rounded_revenue_pln": "0",
                "pit38_rounded_cost_pln": "0",
                "pit38_income": "0",
                "pit38_loss": "0",
                "tax_19_pln": "0",
            },
        }
    )
    result.merge_result.ledger.metadata["source_manifest_v2"] = [
        {
            "sourceId": "src:baseline",
            "filename": "historia_transakcji.json",
            "detectedType": "legacy_json",
            "sourceResolutionRole": "primary_tax",
            "contributesToTax": True,
        }
    ]
    result.transaction_history_rows = [
        TransactionHistoryRow(
            row_id="SELL-1",
            parent_row_id=None,
            row_kind="TRADE",
            display_date=pd.Timestamp("2025-06-01"),
            transaction_id="SELL-1",
            ticker="ABC",
            side="SELL",
            tax_impact_kind="PIT_COUNTED",
        )
    ]

    package = generate_tax_filing_package(
        result,
        TaxFilingRequest(package_scope="full", filing_mode="ORIGINAL"),
    )

    assert package.audit_appendix is not None
    health = package.audit_appendix["result_health_check"]
    assert health["status"] == "needs_review"
    assert any("przychód" in reason or "przychod" in reason for reason in health["reasons"])
    assert package.audit_appendix["pit_case_file"]["audit_hash"] == "stable-zero-hash"


def test_result_health_check_does_not_block_missing_supporting_files():
    result = make_engine_result(filing_ready=True)
    result.merge_result.ledger.metadata["source_manifest_v2"] = [
        {
            "sourceId": "src:baseline",
            "filename": "Tradesv1.xlsx",
            "detectedType": "broker_trades_excel",
            "sourceResolutionRole": "primary_tax",
            "contributesToTax": True,
        },
        {
            "sourceId": "src:fees",
            "filename": "Stawki.pdf",
            "detectedType": "fee_schedule_pdf",
            "sourceResolutionRole": "evidence",
            "contributesToTax": False,
        },
    ]

    package = generate_tax_filing_package(
        result,
        TaxFilingRequest(package_scope="full", filing_mode="ORIGINAL"),
    )

    assert package.audit_appendix is not None
    health = package.audit_appendix["result_health_check"]
    assert health["status"] == "ok"
    assert health["recognizedStorageFileCount"] == 2


def test_full_tax_filing_package_includes_import_intelligence_and_no_overpay_audit():
    result = make_engine_result(filing_ready=True)
    result.merge_result.ledger.metadata["source_manifest_v2"] = [
        {
            "sourceId": "src:trades-v1",
            "filename": "Tradesv1.xlsx",
            "hash": "abc123",
            "detectedType": "broker_trades_excel",
            "sections": ["sheet1"],
            "recordCounts": {"rows": 2, "trade_like_rows": 2, "event_like_rows": 0},
            "dateRange": {"from": "2025-01-10", "to": "2025-01-11"},
            "contributesToTax": True,
            "warnings": [],
            "errors": [],
        }
    ]
    result.merge_result.ledger.metadata["import_intelligence_report"] = {
        "sources": result.merge_result.ledger.metadata["source_manifest_v2"],
        "duplicates": [{"record_key": "ORDER-1", "sources": ["src:trades-v1", "src:broker-json"]}],
        "conflicts": [],
        "missingExpectedSections": [],
        "recommendedActions": ["Sprawdź duplikat ORDER-1 przed złożeniem PIT."],
    }
    result.cost_items = [
        CostItem(
            cost_id="FX-SPREAD-1",
            kind="FX_CONVERSION_SPREAD_COST",
            amount_foreign=Decimal("0"),
            currency="PLN",
            tax_event_date=pd.Timestamp("2025-02-01"),
            amount_pln=Decimal("25.00"),
            source_id="FX-ROW-1",
            evidence_level="TRACE",
            allocation_target="BUY-1",
            included_in_plan={"aggressive_user"},
            is_aggressive_only=True,
            derived_cost=True,
        ),
        CostItem(
            cost_id="BANK-FEE-EXCLUDED",
            kind="BANK_FUNDING_FEE",
            amount_foreign=Decimal("12.00"),
            currency="PLN",
            tax_event_date=pd.Timestamp("2025-02-02"),
            amount_pln=Decimal("12.00"),
            source_id="BANK-ROW-1",
            evidence_level="DIRECT",
            included_in_plan=set(),
            is_aggressive_only=True,
        ),
    ]
    result.cost_decisions = [
        CostDecision(
            cost_id="FX-SPREAD-1",
            plan_name="aggressive_user",
            included=True,
            reason="included_by_policy",
            evidence_level="TRACE",
            amount_pln=Decimal("25.00"),
            kind="FX_CONVERSION_SPREAD_COST",
            aggressive_only=True,
        ),
        CostDecision(
            cost_id="BANK-FEE-EXCLUDED",
            plan_name="aggressive_user",
            included=False,
            reason="missing_evidence",
            evidence_level="DIRECT",
            amount_pln=Decimal("12.00"),
            kind="BANK_FUNDING_FEE",
            aggressive_only=True,
        ),
    ]

    package = generate_tax_filing_package(
        result,
        TaxFilingRequest(package_scope="full", filing_mode="ORIGINAL"),
    )

    assert package.audit_appendix is not None
    appendix = package.audit_appendix
    assert appendix["source_manifest_v2"][0]["filename"] == "Tradesv1.xlsx"
    assert appendix["import_intelligence_report"]["duplicates"][0]["record_key"] == "ORDER-1"
    no_overpay = appendix["no_overpay_audit"]
    assert any(item["costId"] == "FX-SPREAD-1" for item in no_overpay["candidateCosts"])
    assert any(item["costId"] == "BANK-FEE-EXCLUDED" for item in no_overpay["excludedCosts"])
    assert no_overpay["duplicateRisks"][0]["record_key"] == "ORDER-1"
    assert no_overpay["confidenceScore"] < 100
    assert any("BANK-FEE-EXCLUDED" in action for action in no_overpay["recommendedActions"])
    assert appendix["defense_case_file"]["summary"]["source_count"] == 1

    control_tower = appendix["broker_file_control_tower"]
    assert control_tower["summary"]["source_count"] == 1
    assert control_tower["summary"]["canonical_source_count"] == 1
    assert control_tower["sections"]["canonical_sources"][0]["sourceId"] == "src:trades-v1"
    assert any("ORDER-1" in action for action in control_tower["recommendedActions"])

    coverage_by_area = {row["area"]: row for row in appendix["coverage_matrix"]}
    assert coverage_by_area["transactions"]["status"] == "complete"
    assert coverage_by_area["commissions"]["status"] == "complete"
    assert coverage_by_area["nbp"]["status"] == "complete"
    assert coverage_by_area["dividends"]["status"] == "not_applicable"

    no_overpay_v2 = appendix["no_overpay_audit_v2"]
    assert no_overpay_v2["summary"]["candidateCostCount"] == 2
    assert no_overpay_v2["summary"]["excludedCostCount"] == 1
    assert any(item["costId"] == "BANK-FEE-EXCLUDED" for item in no_overpay_v2["potentiallyMissedCosts"])
    assert any(item["record_key"] == "ORDER-1" for item in no_overpay_v2["duplicateRisks"])

    defense_v2 = appendix["defense_case_file_v2"]
    assert defense_v2["summary"]["defense_chain_count"] >= 1
    assert any(chain["costId"] == "FX-SPREAD-1" for chain in defense_v2["defenseChains"])
    assert any(chain["riskLevel"] in {"low", "medium", "high"} for chain in defense_v2["defenseChains"])

    legal_registry = {entry["basisId"]: entry for entry in appendix["legal_basis_registry"]}
    assert legal_registry["pit_38_2025"]["url"].startswith("https://www.podatki.gov.pl/")
    assert legal_registry["share_sale"]["source"] == "podatki.gov.pl"

    auto_recognition = appendix["auto_file_recognition_report"]
    assert auto_recognition["summary"]["recognizedSourceCount"] == 1
    assert auto_recognition["sources"][0]["filename"] == "Tradesv1.xlsx"
    assert auto_recognition["sources"][0]["fileRole"] == "transaction_source"

    aggressive_coverage = appendix["aggressive_cost_coverage_audit"]
    coverage_by_kind = {row["kind"]: row for row in aggressive_coverage["categories"]}
    assert coverage_by_kind["FX_CONVERSION_SPREAD_COST"]["includedCount"] == 1
    assert coverage_by_kind["FX_CONVERSION_SPREAD_COST"]["status"] == "included"
    assert coverage_by_kind["BANK_FUNDING_FEE"]["candidateCount"] == 1
    assert coverage_by_kind["BANK_FUNDING_FEE"]["status"] == "recognized_not_counted"
    assert aggressive_coverage["summary"]["blocksFiling"] is False

    action_queue = appendix["broker_file_action_queue"]
    assert action_queue
    assert all(item["action_id"].startswith("BFAQ-") for item in action_queue)
    assert all(item["default_status"] == "open" for item in action_queue)
    assert any(item["area"] == "import:duplicates" and item["severity"] == "warning" for item in action_queue)
    assert any("ORDER-1" in item["label"] and item["severity"] == "warning" for item in action_queue)
    missed_cost = next(item for item in action_queue if "BANK-FEE-EXCLUDED" in item["cost_ids"])
    assert missed_cost["history_search_term"] == "BANK-FEE-EXCLUDED"
    assert missed_cost["user_status"] == "open"
    assert missed_cost["status_source"] == "silnik"


def test_broker_file_action_override_updates_audit_only_without_changing_tax_or_hash():
    result = make_engine_result(filing_ready=True)
    result.audit_hash = "stable-audit-hash"
    result.merge_result.ledger.metadata["import_intelligence_report"] = {
        "duplicates": [{"record_key": "ORDER-1", "sources": ["src:a", "src:b"]}],
        "conflicts": [],
        "missingExpectedSections": [],
        "recommendedActions": [],
    }

    base_package = generate_tax_filing_package(
        result,
        TaxFilingRequest(package_scope="full", filing_mode="ORIGINAL"),
    )
    assert base_package.audit_appendix is not None
    action_id = next(
        item["action_id"]
        for item in base_package.audit_appendix["broker_file_action_queue"]
        if "ORDER-1" in item["label"]
    )

    package = generate_tax_filing_package(
        result,
        TaxFilingRequest(
            package_scope="full",
            filing_mode="ORIGINAL",
            broker_file_action_overrides=[
                BrokerFileActionOverride(
                    action_id=action_id,
                    status="ignored",
                    user_note="Duplikat sprawdzony w raporcie brokera; pozostawiony jako dowód.",
                    linked_row_id="ORDER-1",
                    updated_at="2026-05-12T10:00:00.000Z",
                )
            ],
        ),
    )

    assert package.draft.main_fields == base_package.draft.main_fields
    assert package.audit_appendix is not None
    assert package.audit_appendix["pit_case_file"]["audit_hash"] == base_package.audit_appendix["pit_case_file"]["audit_hash"]
    resolved = next(item for item in package.audit_appendix["broker_file_action_queue"] if item["action_id"] == action_id)
    assert resolved["user_status"] == "ignored"
    assert resolved["user_note"] == "Duplikat sprawdzony w raporcie brokera; pozostawiony jako dowód."
    assert resolved["linked_row_id"] == "ORDER-1"
    assert resolved["status_source"] == "local_user"


def test_auto_file_recognition_separates_nbp_evidence_and_candidate_roles():
    result = make_engine_result(filing_ready=True)
    result.merge_result.ledger.metadata["source_manifest_v2"] = [
        {
            "sourceId": "src:nbp-2025",
            "filename": "archiwum_tab_a_2025.csv",
            "detectedType": "nbp_archive",
            "sourceResolutionRole": "baseline_support",
            "contributesToTax": True,
        },
        {
            "sourceId": "src:fees",
            "filename": "Stawki.pdf",
            "detectedType": "fee_schedule_pdf",
            "sourceResolutionRole": "evidence",
            "contributesToTax": False,
        },
        {
            "sourceId": "src:new-broker",
            "filename": "broker_raport_bezbliansu.json",
            "detectedType": "broker_report_json",
            "sourceResolutionRole": "candidate_tax",
            "contributesToTax": False,
        },
    ]

    package = generate_tax_filing_package(
        result,
        TaxFilingRequest(package_scope="full", filing_mode="ORIGINAL"),
    )

    assert package.audit_appendix is not None
    by_filename = {
        source["filename"]: source
        for source in package.audit_appendix["auto_file_recognition_report"]["sources"]
    }
    assert by_filename["archiwum_tab_a_2025.csv"]["fileRole"] == "nbp_rates"
    assert by_filename["Stawki.pdf"]["fileRole"] == "evidence"
    assert by_filename["broker_raport_bezbliansu.json"]["fileRole"] == "transaction_report"


def test_generate_numbers_only_tax_package_omits_optional_documents():
    result = make_engine_result(filing_ready=True)

    package = generate_tax_filing_package(
        result,
        TaxFilingRequest(package_scope="numbers_only", filing_mode="ORIGINAL"),
    )

    assert package.draft.filing_mode == "ORIGINAL"
    assert package.calculation is None
    assert package.justification is None
    assert package.audit_appendix is None


def test_generate_justification_on_non_ready_result_emits_issue():
    result = make_engine_result(filing_ready=False)

    package = generate_tax_filing_package(
        result,
        TaxFilingRequest(package_scope="with_justification", filing_mode="CORRECTION"),
    )

    assert package.justification is not None
    assert any(issue.code == "JUSTIFICATION_GENERATED_ON_NON_READY_RESULT" for issue in result.merge_result.ledger.issues)


def test_aggressive_private_cash_fx_cost_has_defense_dossier_linked_to_trade():
    result = make_engine_result(filing_ready=True)
    buy_trade = CanonicalTrade(
        trade_id="BUY-1",
        order_id="ORDER-1",
        trade_number=None,
        symbol="NBIS.US",
        isin=None,
        side="BUY",
        instrument_type_code=None,
        instrument_class="EQUITY",
        market_id=None,
        quantity=Decimal("10"),
        price=Decimal("100"),
        gross_amount=Decimal("1000"),
        trade_currency="USD",
        commission=Decimal("2"),
        commission_currency="USD",
        broker_reported_profit=None,
        executed_at=pd.Timestamp("2025-12-15 14:30:00"),
        exchange_time=None,
        settlement_date=None,
        confirm_time=None,
        otc=False,
        repo_close=None,
        base_contract_code=None,
        current_position_qty_after_trade=None,
        source_name="LOCAL_FILE",
        source_priority=90,
        source_record_id="row-1",
        gross_amount_pln=Decimal("3800"),
        buy_total_cost_pln=Decimal("3807.60"),
    )
    result.merge_result.ledger.trades_by_id[buy_trade.trade_id] = buy_trade
    result.cost_items = [
        CostItem(
            cost_id="PCFX-LOSS-1",
            kind="PRIVATE_CASH_FX_INVESTMENT_LOSS",
            amount_foreign=Decimal("0"),
            currency="PLN",
            tax_event_date=pd.Timestamp("2025-12-15"),
            amount_pln=Decimal("123.45"),
            source_id="DEPOSIT-EUR-1",
            evidence_level="TRACE",
            allocation_target="BUY-1",
            included_in_plan={"aggressive_user"},
            is_aggressive_only=True,
            derived_cost=True,
            notes=[
                "private_cash_fx_loss_between_funding_and_investment_buy",
                "source_fx_rate=4.3200",
                "use_fx_rate=4.1200",
            ],
        )
    ]
    result.cost_decisions = [
        CostDecision(
            cost_id="PCFX-LOSS-1",
            plan_name="aggressive_user",
            included=True,
            reason="included_by_aggressive_policy",
            evidence_level="TRACE",
            amount_pln=Decimal("123.45"),
            kind="PRIVATE_CASH_FX_INVESTMENT_LOSS",
            aggressive_only=True,
            policy_level="AGGRESSIVE_ONLY",
        )
    ]

    package = generate_tax_filing_package(
        result,
        TaxFilingRequest(package_scope="full", filing_mode="ORIGINAL"),
    )

    assert package.justification is not None
    cost_entry = package.justification.cost_categories[0]
    assert cost_entry["kind"] == "PRIVATE_CASH_FX_INVESTMENT_LOSS"
    assert cost_entry["risk_level"] == "WYSOKIE"
    assert "art. 22 ust. 1" in " ".join(cost_entry["legal_basis"])
    assert "art. 23 ust. 1 pkt 38" in " ".join(cost_entry["legal_basis"])
    assert "agresywne" in cost_entry["tax_argument_pl"].lower()
    assert cost_entry["linked_trade"]["trade_id"] == "BUY-1"
    assert cost_entry["linked_trade"]["symbol"] == "NBIS.US"
    assert cost_entry["linked_trade"]["side"] == "BUY"
    assert cost_entry["source_id"] == "DEPOSIT-EUR-1"
    assert any("kurs" in evidence.lower() for evidence in cost_entry["recommended_evidence"])
    assert cost_entry["defense_status"] == "high_risk_review"
    assert "WYSOKIE" in cost_entry["defense_status_label_pl"]
    assert cost_entry["linked_trade_date"] == "2025-12-15T14:30:00"
    assert "decyzja kosztowa" in cost_entry["amount_reconciliation"]["summary"]
    assert "potwierdzenie" in " ".join(cost_entry["missing_evidence"]).lower()
    assert package.audit_appendix is not None
    assert package.audit_appendix["aggressive_cost_defense"][0]["cost_id"] == "PCFX-LOSS-1"
    readiness = package.audit_appendix["defense_readiness"]
    assert readiness["totalAggressiveItems"] == 1
    assert readiness["highRiskItems"] == 1
    assert readiness["status_counts"]["high_risk_review"] == 1
    assert readiness["score"] < 100
    memorandum = package.audit_appendix["memorandum_aggressive_user"]
    assert "## Założenia" in memorandum
    assert "## Podstawy prawne" in memorandum
    assert "## Koszty" in memorandum
    assert "## Ryzyka" in memorandum
    assert "## Dowody" in memorandum


def test_bank_funding_fee_defense_sums_two_user_entries_without_duplicates():
    result = make_engine_result(filing_ready=True)
    result.cost_items = [
        CostItem(
            cost_id="BANK-FEE-24-73",
            kind="BANK_FUNDING_FEE",
            amount_foreign=Decimal("24.73"),
            currency="PLN",
            tax_event_date=pd.Timestamp("2025-01-09"),
            amount_pln=Decimal("24.73"),
            source_id="USER-FUNDING-FEE-1",
            evidence_level="DIRECT",
            allocation_target="BUY-1",
            included_in_plan={"aggressive_user"},
            is_aggressive_only=True,
            notes=["Prowizja bankowa wpisana ręcznie: 24,73 PLN"],
        ),
        CostItem(
            cost_id="BANK-FEE-152-26",
            kind="BANK_FUNDING_FEE",
            amount_foreign=Decimal("152.26"),
            currency="PLN",
            tax_event_date=pd.Timestamp("2025-01-09"),
            amount_pln=Decimal("152.26"),
            source_id="USER-FUNDING-FEE-2",
            evidence_level="DIRECT",
            allocation_target="BUY-2",
            included_in_plan={"aggressive_user"},
            is_aggressive_only=True,
            notes=["Prowizja bankowa wpisana ręcznie: 152,26 PLN"],
        ),
    ]
    result.cost_decisions = [
        CostDecision(
            cost_id="BANK-FEE-24-73",
            plan_name="aggressive_user",
            included=True,
            reason="included_by_aggressive_policy",
            evidence_level="DIRECT",
            amount_pln=Decimal("24.73"),
            kind="BANK_FUNDING_FEE",
            aggressive_only=True,
            policy_level="AGGRESSIVE_ONLY",
        ),
        CostDecision(
            cost_id="BANK-FEE-152-26",
            plan_name="aggressive_user",
            included=True,
            reason="included_by_aggressive_policy",
            evidence_level="DIRECT",
            amount_pln=Decimal("152.26"),
            kind="BANK_FUNDING_FEE",
            aggressive_only=True,
            policy_level="AGGRESSIVE_ONLY",
        ),
    ]

    package = generate_tax_filing_package(
        result,
        TaxFilingRequest(package_scope="full", filing_mode="ORIGINAL"),
    )

    assert package.audit_appendix is not None
    readiness = package.audit_appendix["defense_readiness"]
    assert readiness["kind_totals_pln"]["BANK_FUNDING_FEE"] == "176.99"
    assert readiness["duplicate_cost_ids"] == []
    entries = package.audit_appendix["aggressive_cost_defense"]
    assert [entry["cost_id"] for entry in entries] == ["BANK-FEE-24-73", "BANK-FEE-152-26"]
    assert {entry["amount_reconciliation"]["decision_amount_pln"] for entry in entries} == {"24.73", "152.26"}


def test_negative_balance_interest_without_single_trade_link_requires_evidence_not_missing_link():
    result = make_engine_result(filing_ready=True)
    result.cost_items = [
        CostItem(
            cost_id="COST-3368752211",
            kind="INVESTMENT_INTEREST",
            amount_foreign=Decimal("4.31"),
            currency="USD",
            tax_event_date=pd.Timestamp("2025-11-15 00:00:00"),
            amount_pln=Decimal("15.68"),
            source_id="3368752211",
            evidence_level="DIRECT",
            allocation_target="saldo-ujemne-USD-2025-11-14",
            included_in_plan={"balanced_user", "aggressive_user"},
            is_aggressive_only=False,
            notes=[
                "source_cost_bucket=NEGATIVE_BALANCE_INTEREST",
                "Fee for negative cash balance USD, balance as at 2025-11-14 23:59:59: 8737.83",
            ],
        )
    ]
    result.cost_decisions = [
        CostDecision(
            cost_id="COST-3368752211",
            plan_name="aggressive_user",
            included=True,
            reason="included_by_policy",
            evidence_level="DIRECT",
            amount_pln=Decimal("15.68"),
            kind="INVESTMENT_INTEREST",
            aggressive_only=False,
            policy_level="STANDARD",
        )
    ]

    package = generate_tax_filing_package(
        result,
        TaxFilingRequest(package_scope="full", filing_mode="ORIGINAL"),
    )

    assert package.audit_appendix is not None
    entry = package.audit_appendix["aggressive_cost_defense"][0]
    assert entry["defense_status"] == "needs_user_evidence"
    assert "brak powiazania kosztu z konkretna transakcja" not in " ".join(entry["missing_evidence"])
    assert "saldo ujemne" in " ".join(entry["missing_evidence"]).lower()
    readiness = package.audit_appendix["defense_readiness"]
    assert readiness["status_counts"]["needs_user_evidence"] == 1
    assert readiness["blockingWarnings"] == []


def test_aggressive_cost_defense_deduplicates_repeated_cost_decisions():
    result = make_engine_result(filing_ready=True)
    result.cost_items = [
        CostItem(
            cost_id="COST-DUP-1",
            kind="INVESTMENT_INTEREST",
            amount_foreign=Decimal("4.31"),
            currency="USD",
            tax_event_date=pd.Timestamp("2025-11-15"),
            amount_pln=Decimal("15.68"),
            source_id="3368752211",
            evidence_level="DIRECT",
            allocation_target="negative_cash_balance:USD:2025-11-15",
            included_in_plan={"balanced_user", "aggressive_user"},
            is_aggressive_only=False,
        )
    ]
    repeated_decision = CostDecision(
        cost_id="COST-DUP-1",
        plan_name="aggressive_user",
        included=True,
        reason="included_by_policy",
        evidence_level="DIRECT",
        amount_pln=Decimal("15.68"),
        kind="INVESTMENT_INTEREST",
        aggressive_only=False,
        policy_level="STANDARD",
    )
    result.cost_decisions = [repeated_decision, repeated_decision]

    package = generate_tax_filing_package(
        result,
        TaxFilingRequest(package_scope="full", filing_mode="ORIGINAL"),
    )

    assert package.audit_appendix is not None
    entries = package.audit_appendix["aggressive_cost_defense"]
    readiness = package.audit_appendix["defense_readiness"]
    assert [entry["cost_id"] for entry in entries] == ["COST-DUP-1"]
    assert readiness["totalAggressiveItems"] == 1
    assert readiness["duplicate_cost_ids"] == []


def test_defense_evidence_graph_explains_missing_link_with_user_action():
    result = make_engine_result(filing_ready=True)
    result.cost_items = [
        CostItem(
            cost_id="PCFX-MISSING-LINK",
            kind="PRIVATE_CASH_FX_INVESTMENT_LOSS",
            amount_foreign=Decimal("0"),
            currency="PLN",
            tax_event_date=pd.Timestamp("2025-12-15"),
            amount_pln=Decimal("88.12"),
            source_id="DEPOSIT-EUR-1",
            evidence_level="TRACE",
            allocation_target="UNKNOWN-BUY-TRADE",
            included_in_plan={"aggressive_user"},
            is_aggressive_only=True,
            derived_cost=True,
            notes=["private_cash_fx_loss_between_funding_and_investment_buy"],
        )
    ]
    result.cost_decisions = [
        CostDecision(
            cost_id="PCFX-MISSING-LINK",
            plan_name="aggressive_user",
            included=True,
            reason="included_by_aggressive_policy",
            evidence_level="TRACE",
            amount_pln=Decimal("88.12"),
            kind="PRIVATE_CASH_FX_INVESTMENT_LOSS",
            aggressive_only=True,
            policy_level="AGGRESSIVE_ONLY",
        )
    ]

    package = generate_tax_filing_package(
        result,
        TaxFilingRequest(package_scope="full", filing_mode="ORIGINAL"),
    )

    assert package.audit_appendix is not None
    evidence_links = package.audit_appendix["defense_evidence_links"]
    assert len(evidence_links) == 1
    evidence = evidence_links[0]
    assert evidence["evidenceId"] == "EVIDENCE-PCFX-MISSING-LINK"
    assert evidence["costId"] == "PCFX-MISSING-LINK"
    assert evidence["sourceRecordId"] == "DEPOSIT-EUR-1"
    assert evidence["rawRowRef"] == "DEPOSIT-EUR-1"
    assert evidence["linkedTradeIds"] == []
    assert evidence["amountPln"] == "88.12"
    assert evidence["defenseStatus"] == "missing_link"
    assert evidence["riskLevel"] == "high"
    assert "Uzupełnij powiązanie" in evidence["userActionLabel"]
    assert any("potwierdzenie kursow" in item for item in evidence["missingEvidence"])

    readiness = package.audit_appendix["defense_readiness"]
    assert readiness["actionItems"][0]["costId"] == "PCFX-MISSING-LINK"
    assert "DEPOSIT-EUR-1" in readiness["blockingWarnings"][0]
    assert readiness["blockingWarnings"][0] != "PCFX-MISSING-LINK: brak powiazania kosztu z transakcja."


def test_calculation_report_contains_full_tax_breakdown_section():
    result = make_engine_result(filing_ready=True)

    package = generate_tax_filing_package(
        result,
        TaxFilingRequest(package_scope="full", filing_mode="ORIGINAL"),
    )

    assert package.calculation is not None
    breakdown = next(
        section for section in package.calculation.sections if section["title"] == "Jak policzono podatek"
    )
    values = breakdown["values"]
    assert values["revenue_pln"] == "1000.00"
    assert values["cost_pln"] == "700.00"
    assert values["aggressive_costs_pln"] == "12.34"
    assert values["prior_year_losses_pln"] == "0.00"
    assert values["taxes_from_dane_pln"] == "0.00"
    assert "Przychód minus koszty" in breakdown["explanation"]


def test_calculation_report_uses_prior_year_loss_from_engine_not_hardcoded_zero():
    result = make_engine_result(filing_ready=True)
    result.annual_summary["prior_year_loss_used_pln"] = "125.50"
    result.annual_summary["art30b"]["prior_year_loss_used_pln"] = "125.50"

    package = generate_tax_filing_package(
        result,
        TaxFilingRequest(package_scope="full", filing_mode="ORIGINAL"),
    )

    assert package.calculation is not None
    breakdown = next(
        section for section in package.calculation.sections if section["title"] == "Jak policzono podatek"
    )
    assert breakdown["values"]["prior_year_losses_pln"] == "125.50"


def test_variant_position_30_comes_from_its_own_taxable_base():
    result = make_engine_result()
    result.annual_summary["prior_year_loss_used_pln"] = "50.00"
    result.scenario_results["conservative"] = ScenarioResult(
        scenario_name="conservative",
        risk_level="low",
        gross_result_pln=Decimal("200.00"),
        taxable_base_pln=Decimal("180.00"),
        tax_19_pln=Decimal("34.20"),
        taxes_from_dane_pln=Decimal("0.00"),
        net_pln=Decimal("165.80"),
        total_revenue_pln=Decimal("600.00"),
        total_cost_pln=Decimal("400.00"),
    )

    projection = _build_scenario_projection(result, "conservative")
    fields = {field.position: field.value for field in projection.form_fields}

    assert fields["30"] == Decimal("20.00")
    assert fields["28"] - fields["30"] == fields["31"] == Decimal("180.00")


def test_pit8c_form_uses_foreign_credit_and_position_35(monkeypatch):
    from investment_tax_engine.tax import filing_package

    result = make_engine_result()
    result.annual_summary["art30b"].update({
        "pit8c_revenue_pln": "500.00", "pit8c_cost_pln": "100.00",
    })
    result.scenario_results["aggressive_user"] = ScenarioResult(
        scenario_name="aggressive_user", risk_level="medium",
        gross_result_pln=Decimal("450.00"), taxable_base_pln=Decimal("150.00"),
        tax_19_pln=Decimal("28.50"), taxes_from_dane_pln=Decimal("0"),
        net_pln=Decimal("421.50"), total_revenue_pln=Decimal("600.00"),
        total_cost_pln=Decimal("150.00"),
    )
    monkeypatch.setattr(filing_package, "_pit_zg_rows_for_result", lambda _result, _scenario_name=None: [
        {"income_pln": Decimal("50.00"), "foreign_tax_pln": Decimal("10.00")}
    ])
    fields = {field.position: field.value for field in
              _build_scenario_projection(result, "aggressive_user").form_fields}

    assert [fields[str(pos)] for pos in (20, 21, 22, 23)] == [
        Decimal("500.00"), Decimal("100.00"), Decimal("100.00"), Decimal("50.00")
    ]
    assert fields["26"] == Decimal("600.00")
    assert fields["27"] == Decimal("150.00")
    assert fields["28"] == Decimal("450.00")
    assert fields["30"] == Decimal("300.00")
    assert fields["31"] == Decimal("150")
    assert fields["33"] == Decimal("28.50")
    assert fields["34"] == Decimal("3.17")
    assert fields["35"] == Decimal("25") < fields["33"]
    assert fields["51"] == Decimal("25")


def test_full_package_includes_tax_ledger_gap_summary_and_no_baseline_delta():
    result = make_engine_result(filing_ready=True)
    result.annual_summary["taxes_from_dane_pln"] = "0.15"

    package = generate_tax_filing_package(
        result,
        TaxFilingRequest(package_scope="full", filing_mode="ORIGINAL"),
    )

    assert package.audit_appendix is not None
    ledger = package.audit_appendix["tax_calculation_ledger"]
    assert [row["line_id"] for row in ledger["rows"][:4]] == [
        "REVENUE_TOTAL",
        "COST_TOTAL",
        "AGGRESSIVE_COST_TOTAL",
        "PRIOR_YEAR_LOSSES_USED",
    ]
    assert ledger["rows"][0]["amount_pln"] == "1000.00"
    assert ledger["rows"][1]["amount_pln"] == "700.00"
    assert ledger["rows"][2]["amount_pln"] == "12.34"
    assert ledger["rows"][5]["line_id"] == "TAX_19"
    assert ledger["rows"][6]["line_id"] == "TAXES_FROM_DATA"
    assert ledger["rows"][6]["amount_pln"] == "0.15"
    assert ledger["metadata"]["benchmark_policy"] == "benchmark_user_is_diagnostic_only"

    delta = package.audit_appendix["result_delta_report"]
    assert delta["status"] == "NO_BASELINE"
    assert delta["rows"] == []
    assert "Brak poprzedniego snapshotu" in delta["summary"]

    gap_summary = package.audit_appendix["defense_gap_summary"]
    assert gap_summary["total_gaps"] >= 0
    assert "by_status" in gap_summary


def test_tax_ledger_uses_precise_scenario_totals_not_rounded_display_values():
    result = make_engine_result(filing_ready=True)
    result.annual_summary["pit38_rounded_revenue_pln"] = "233502"
    result.annual_summary["pit38_rounded_cost_pln"] = "231968"
    result.annual_summary["pit38_income"] = "1534"
    result.annual_summary["tax_19_pln"] = "291.35"
    result.annual_summary["art30b"]["pit38_rounded_revenue_pln"] = "233502"
    result.annual_summary["art30b"]["pit38_rounded_cost_pln"] = "231968"
    result.annual_summary["art30b"]["pit38_income"] = "1534"
    result.annual_summary["art30b"]["tax_19_pln"] = "291.35"
    result.scenario_results["aggressive_user"] = ScenarioResult(
        scenario_name="aggressive_user",
        risk_level="high",
        gross_result_pln=Decimal("1533.43"),
        taxable_base_pln=Decimal("1533.43"),
        tax_19_pln=Decimal("291.35"),
        taxes_from_dane_pln=Decimal("0.15"),
        net_pln=Decimal("1241.93"),
        total_revenue_pln=Decimal("233501.85"),
        total_cost_pln=Decimal("231968.42"),
    )

    package = generate_tax_filing_package(
        result,
        TaxFilingRequest(package_scope="full", filing_mode="ORIGINAL"),
    )

    assert package.audit_appendix is not None
    ledger = package.audit_appendix["tax_calculation_ledger"]
    rows = {row["line_id"]: row for row in ledger["rows"]}
    assert rows["REVENUE_TOTAL"]["amount_pln"] == "233501.85"
    assert rows["COST_TOTAL"]["amount_pln"] == "231968.42"
    assert rows["TAXABLE_BASE"]["amount_pln"] == "1533.43"
    readiness = package.audit_appendix["pit_submission_readiness"]
    assert not any(item["id"] == "calculation:taxable_base_mismatch" for item in readiness["checklist"])
    assert any(item["id"] == "calculation:display_rounding_delta" for item in readiness["checklist"])


def test_tax_ledger_still_blocks_real_decimal_mismatch():
    result = make_engine_result(filing_ready=True)
    result.scenario_results["aggressive_user"] = ScenarioResult(
        scenario_name="aggressive_user",
        risk_level="high",
        gross_result_pln=Decimal("300.00"),
        taxable_base_pln=Decimal("290.00"),
        tax_19_pln=Decimal("55.10"),
        taxes_from_dane_pln=Decimal("0.00"),
        net_pln=Decimal("244.90"),
        total_revenue_pln=Decimal("1000.00"),
        total_cost_pln=Decimal("700.00"),
    )

    package = generate_tax_filing_package(
        result,
        TaxFilingRequest(package_scope="full", filing_mode="ORIGINAL"),
    )

    assert package.audit_appendix is not None
    readiness = package.audit_appendix["pit_submission_readiness"]
    assert readiness["verdict"] == "BLOCKED"
    assert any(item["id"] == "calculation:taxable_base_mismatch" for item in readiness["checklist"])


def test_tax_form_rate_field_has_percent_value_type():
    result = make_engine_result(filing_ready=True)

    package = generate_tax_filing_package(
        result,
        TaxFilingRequest(package_scope="full", filing_mode="ORIGINAL"),
    )

    d32 = next(field for field in package.draft.form_fields if field.section == "D" and field.position == "32")
    assert d32.value == "19%"
    assert d32.value_type == "percent"


def test_defense_evidence_groups_recurring_negative_balance_interest():
    result = make_engine_result(filing_ready=True)
    result.cost_items = [
        CostItem(
            cost_id="COST-3368752211",
            kind="INVESTMENT_INTEREST",
            amount_foreign=Decimal("4.31"),
            currency="USD",
            tax_event_date=pd.Timestamp("2025-11-15"),
            amount_pln=Decimal("15.68"),
            source_id="3368752211",
            evidence_level="DIRECT",
            allocation_target="negative_cash_balance:USD:2025-11-15",
            included_in_plan={"aggressive_user"},
            is_aggressive_only=False,
        ),
        CostItem(
            cost_id="COST-3369078693",
            kind="INVESTMENT_INTEREST",
            amount_foreign=Decimal("4.31"),
            currency="USD",
            tax_event_date=pd.Timestamp("2025-11-16"),
            amount_pln=Decimal("15.68"),
            source_id="3369078693",
            evidence_level="DIRECT",
            allocation_target="negative_cash_balance:USD:2025-11-16",
            included_in_plan={"aggressive_user"},
            is_aggressive_only=False,
        ),
    ]
    result.cost_decisions = [
        CostDecision(
            cost_id=item.cost_id,
            plan_name="aggressive_user",
            included=True,
            reason="included_by_policy",
            evidence_level="DIRECT",
            amount_pln=item.amount_pln,
            kind="INVESTMENT_INTEREST",
            aggressive_only=False,
            policy_level="STANDARD",
        )
        for item in result.cost_items
    ]

    package = generate_tax_filing_package(
        result,
        TaxFilingRequest(package_scope="full", filing_mode="ORIGINAL"),
    )

    assert package.audit_appendix is not None
    groups = package.audit_appendix["defense_evidence_groups"]
    interest_group = next(group for group in groups if group["kind"] == "INVESTMENT_INTEREST")
    assert interest_group["label_pl"] == "Odsetki od salda ujemnego"
    assert interest_group["item_count"] == 2
    assert interest_group["amount_pln"] == "31.36"
    assert interest_group["date_from"] == "2025-11-15"
    assert interest_group["date_to"] == "2025-11-16"
    assert interest_group["context_label"] == "Kontekst finansowania"
    assert interest_group["defense_status"] == "needs_user_evidence"
    assert set(interest_group["cost_ids"]) == {"COST-3368752211", "COST-3369078693"}


def test_full_package_includes_tax_trace_index_for_ledger_evidence_and_checklist():
    result = make_engine_result(filing_ready=True)

    package = generate_tax_filing_package(
        result,
        TaxFilingRequest(package_scope="full", filing_mode="ORIGINAL"),
    )

    assert package.audit_appendix is not None
    trace_index = package.audit_appendix["tax_trace_index"]
    revenue_trace = next(entry for entry in trace_index if entry["trace_id"] == "trace:revenue:REVENUE_TOTAL")
    aggressive_trace = next(entry for entry in trace_index if entry["trace_id"] == "trace:aggressive_cost:AGG_COST_FXC-1")

    assert revenue_trace["kind"] == "revenue"
    assert revenue_trace["ledger_row_ids"] == ["REVENUE_TOTAL"]
    assert aggressive_trace["amount_pln"] == "12.34"
    assert aggressive_trace["evidence_ids"] == ["EVIDENCE-FXC-1"]
    assert aggressive_trace["checklist_item_ids"]
    assert "FXC-1" in aggressive_trace["source_record_ids"]
    assert package.draft.main_fields["tax_19"] == Decimal("57")


def test_full_package_includes_reproducible_pit_case_file():
    result = make_engine_result(filing_ready=True)
    result.audit_hash = "abc123def456"

    package = generate_tax_filing_package(
        result,
        TaxFilingRequest(package_scope="full", filing_mode="ORIGINAL"),
    )

    assert package.audit_appendix is not None
    case_file = package.audit_appendix["pit_case_file"]
    assert case_file["case_file_id"] == "pit-case:2025:abc123def456"
    assert case_file["tax_year"] == "2025"
    assert case_file["plan_used"] == "aggressive_user"
    assert case_file["audit_hash"] == "abc123def456"
    assert case_file["reproducible"] is True
    assert case_file["reproducibility_status"] == "REPRODUCIBLE_FROM_AUDIT_PACKAGE"
    assert len(case_file["input_fingerprint"]) == 64
    assert len(case_file["calculation_fingerprint"]) == 64
    assert case_file["package_sections"]["tax_calculation_ledger_rows"] >= 1
    assert case_file["package_sections"]["tax_trace_entries"] >= 1
    assert "Tax_Calculation_Ledger" in case_file["included_artifacts"]
    assert "PIT_Case_File" in case_file["included_artifacts"]
    assert any("Odtworzenie" in item for item in case_file["replay_instructions_pl"])


def test_result_delta_report_explains_changes_against_previous_ledger_snapshot():
    result = make_engine_result(filing_ready=True)
    result.merge_result.ledger.metadata["previous_tax_calculation_ledger"] = {
        "rows": [
            {"line_id": "REVENUE_TOTAL", "amount_pln": "900.00", "label": "Przychody PIT-38"},
            {"line_id": "COST_TOTAL", "amount_pln": "700.00", "label": "Koszty PIT-38"},
            {"line_id": "REMOVED_LINE", "amount_pln": "10.00", "label": "Stara pozycja"},
        ]
    }

    package = generate_tax_filing_package(
        result,
        TaxFilingRequest(package_scope="full", filing_mode="ORIGINAL"),
    )

    assert package.audit_appendix is not None
    delta = package.audit_appendix["result_delta_report"]
    assert delta["status"] == "CHANGED"
    changed = {row["line_id"]: row for row in delta["rows"]}
    assert changed["REVENUE_TOTAL"]["change_type"] == "changed"
    assert changed["REVENUE_TOTAL"]["delta_pln"] == "100.00"
    assert changed["REMOVED_LINE"]["change_type"] == "removed"
    assert changed["AGGRESSIVE_COST_TOTAL"]["change_type"] == "added"


def test_pit_submission_readiness_keeps_nonblocking_nbp_gap_in_sync_with_engine():
    result = make_engine_result(filing_ready=True)
    result.fx_coverage_gaps = [
        FxCoverageGap(
            currency="USD",
            start_date=pd.Timestamp("2025-01-02"),
            end_date=pd.Timestamp("2025-01-31"),
            provider_name="CSV",
            reason="missing archive rows",
        )
    ]
    result.quality_report.warning_issues.append(Issue(
        code="NBP_COVERAGE_GAP", severity="CRITICAL", stage="VALIDATE",
        scope_type="FX", scope_id="USD", message="Archiwum niepelne",
        details={"currency": "USD"}, blocking=False,
    ))
    result.merge_result.ledger.issues.extend(result.quality_report.warning_issues)

    package = generate_tax_filing_package(
        result,
        TaxFilingRequest(package_scope="full", filing_mode="ORIGINAL"),
    )

    assert package.audit_appendix is not None
    readiness = package.audit_appendix["pit_submission_readiness"]
    assert readiness["verdict"] != "BLOCKED"
    assert any(item["category"] == "nbp" and item["severity"] == "info" for item in readiness["checklist"])
    assert all(item["severity"] != "blocking" for item in readiness["checklist"])


def test_pit_submission_readiness_blocks_when_nbp_quality_gate_blocks():
    result = make_engine_result(filing_ready=False)
    result.fx_coverage_gaps = [FxCoverageGap(
        currency="USD", start_date=pd.Timestamp("2025-01-02"),
        end_date=pd.Timestamp("2025-01-31"), provider_name="CSV", reason="missing rate",
    )]
    issue = Issue(
        code="NBP_COVERAGE_GAP", severity="CRITICAL", stage="VALIDATE",
        scope_type="FX", scope_id="USD", message="Brak kursu",
        details={"currency": "USD"}, blocking=True,
    )
    result.quality_report.blocking_issues.append(issue)
    result.merge_result.ledger.issues.append(issue)

    package = generate_tax_filing_package(result, TaxFilingRequest(package_scope="full", filing_mode="ORIGINAL"))
    readiness = package.audit_appendix["pit_submission_readiness"]
    assert readiness["verdict"] == "BLOCKED"
    assert any(item["category"] == "nbp" and item["severity"] == "blocking" for item in readiness["checklist"])


def test_pit_submission_readiness_requires_evidence_without_changing_tax():
    result = make_engine_result(filing_ready=True)

    package = generate_tax_filing_package(
        result,
        TaxFilingRequest(package_scope="full", filing_mode="ORIGINAL"),
    )

    assert package.audit_appendix is not None
    readiness = package.audit_appendix["pit_submission_readiness"]
    assert readiness["verdict"] == "NEEDS_EVIDENCE"
    assert readiness["recommendedAction"]["category"] == "defense"
    assert readiness["recommendedAction"]["severity"] == "evidence"
    assert readiness["recommendedAction"]["linkedCostId"] == "FXC-1"
    assert package.draft.main_fields["tax_19"] == Decimal("57")


def test_pit_submission_readiness_reports_high_risk_when_evidence_link_exists():
    result = make_engine_result(filing_ready=True)
    buy_trade = CanonicalTrade(
        trade_id="BUY-RISK-1",
        order_id="ORDER-RISK-1",
        trade_number=None,
        symbol="NBIS.US",
        isin=None,
        side="BUY",
        instrument_type_code=None,
        instrument_class="EQUITY",
        market_id=None,
        quantity=Decimal("10"),
        price=Decimal("100"),
        gross_amount=Decimal("1000"),
        trade_currency="USD",
        commission=Decimal("2"),
        commission_currency="USD",
        broker_reported_profit=None,
        executed_at=pd.Timestamp("2025-12-15 14:30:00"),
        exchange_time=None,
        settlement_date=None,
        confirm_time=None,
        otc=False,
        repo_close=None,
        base_contract_code=None,
        current_position_qty_after_trade=None,
        source_name="LOCAL_FILE",
        source_priority=90,
        source_record_id="row-risk",
        gross_amount_pln=Decimal("3800"),
        buy_total_cost_pln=Decimal("3807.60"),
    )
    result.merge_result.ledger.trades_by_id[buy_trade.trade_id] = buy_trade
    result.cost_items = [
        CostItem(
            cost_id="PCFX-RISK-1",
            kind="PRIVATE_CASH_FX_INVESTMENT_LOSS",
            amount_foreign=Decimal("0"),
            currency="PLN",
            tax_event_date=pd.Timestamp("2025-12-15"),
            amount_pln=Decimal("123.45"),
            source_id="DEPOSIT-EUR-RISK",
            evidence_level="TRACE",
            allocation_target="BUY-RISK-1",
            included_in_plan={"aggressive_user"},
            is_aggressive_only=True,
            derived_cost=True,
            notes=["private_cash_fx_loss_between_funding_and_investment_buy"],
        )
    ]
    result.cost_decisions = [
        CostDecision(
            cost_id="PCFX-RISK-1",
            plan_name="aggressive_user",
            included=True,
            reason="included_by_aggressive_policy",
            evidence_level="TRACE",
            amount_pln=Decimal("123.45"),
            kind="PRIVATE_CASH_FX_INVESTMENT_LOSS",
            aggressive_only=True,
            policy_level="AGGRESSIVE_ONLY",
        )
    ]

    package = generate_tax_filing_package(
        result,
        TaxFilingRequest(package_scope="full", filing_mode="ORIGINAL"),
    )

    assert package.audit_appendix is not None
    readiness = package.audit_appendix["pit_submission_readiness"]
    assert readiness["verdict"] == "READY_WITH_RISK"
    assert readiness["recommendedAction"]["severity"] == "risk"
    assert "Sprawdź ryzyko" in readiness["recommendedAction"]["userAction"]
    assert "## Co zachować przed złożeniem" in package.audit_appendix["memorandum_aggressive_user"]


def test_pit_submission_readiness_blocks_inconsistent_tax_ledger():
    result = make_engine_result(filing_ready=True)
    result.annual_summary["tax_19_pln"] = "99.00"
    result.annual_summary["art30b"]["tax_19_pln"] = "99.00"

    package = generate_tax_filing_package(
        result,
        TaxFilingRequest(package_scope="full", filing_mode="ORIGINAL"),
    )

    assert package.audit_appendix is not None
    readiness = package.audit_appendix["pit_submission_readiness"]
    assert readiness["verdict"] == "BLOCKED"
    assert any(item["category"] == "calculation" and item["severity"] == "blocking" for item in readiness["checklist"])


def test_local_defense_evidence_override_updates_audit_without_changing_tax_amounts():
    result = make_engine_result(filing_ready=True)

    package = generate_tax_filing_package(
        result,
        TaxFilingRequest(
            package_scope="full",
            filing_mode="ORIGINAL",
            defense_evidence_overrides=[
                DefenseEvidenceOverride(
                    evidence_id="EVIDENCE-FXC-1",
                    defense_status="complete",
                    linked_trade_ids=["TRADE-1"],
                    updated_at="2026-05-10T10:00:00.000Z",
                    user_note="Potwierdzono dowód kosztu w dokumentach użytkownika.",
                    evidence_confirmed=True,
                    checked_at="2026-05-10T10:05:00.000Z",
                    included_in_filing_package=True,
                )
            ],
        ),
    )

    assert package.draft.main_fields["tax_19"] == Decimal("57")
    assert package.audit_appendix is not None
    evidence = package.audit_appendix["defense_evidence_links"][0]
    assert evidence["defenseStatus"] == "complete"
    assert evidence["defenseStatusSource"] == "potwierdzone lokalnie przez użytkownika"
    assert evidence["userNote"] == "Potwierdzono dowód kosztu w dokumentach użytkownika."
    assert evidence["evidenceConfirmed"] is True
    assert evidence["includedInFilingPackage"] is True

    entry = package.audit_appendix["aggressive_cost_defense"][0]
    assert entry["defense_status"] == "complete"
    assert entry["defense_status_source"] == "potwierdzone lokalnie przez użytkownika"

    readiness = package.audit_appendix["pit_submission_readiness"]
    assert readiness["verdict"] == "READY"
    assert package.audit_appendix["defense_readiness"]["completeItems"] == 1
    assert "Potwierdzono dowód kosztu" in package.audit_appendix["memorandum_aggressive_user"]
    assert package.audit_appendix["tax_advisor_brief"]["summary"]["tax_19_pln"] == "57.00"
    assert package.audit_appendix["tax_advisor_brief"]["result_health_check"]["status"] in {"ok", "needs_review", "blocked"}
    assert "Brief dla doradcy podatkowego" in package.audit_appendix["tax_advisor_brief"]["markdown"]


def test_pit_trust_os_appendix_contracts_are_diagnostic_only():
    result = make_engine_result(filing_ready=True)
    result.audit_hash = "trust-hash"
    result.cost_items = [
        CostItem(
            cost_id="FXC-1",
            kind="FX_CONVERSION_SPREAD_COST",
            amount_foreign=Decimal("0"),
            currency="PLN",
            tax_event_date=pd.Timestamp("2025-05-01"),
            amount_pln=Decimal("12.34"),
            source_id="FXC-1",
            evidence_level="STRONG",
            included_in_plan={"aggressive_user"},
            is_aggressive_only=True,
            derived_cost=True,
        )
    ]
    result.merge_result.ledger.metadata["source_manifest_v2"] = [
        {
            "sourceId": "src:baseline",
            "filename": "historia_transakcji.json",
            "hash": "abc123",
            "detectedType": "legacy_json",
            "sourceResolutionRole": "primary_tax",
            "contributesToTax": True,
            "recordCounts": {"sell": 1, "buy": 1},
            "dateRange": {"from": "2025-01-01", "to": "2025-12-31"},
        },
        {
            "sourceId": "src:pdf",
            "filename": "Stawki.pdf",
            "hash": "pdf123",
            "detectedType": "fee_schedule_pdf",
            "sourceResolutionRole": "evidence",
            "contributesToTax": False,
        },
    ]

    package = generate_tax_filing_package(
        result,
        TaxFilingRequest(package_scope="full", filing_mode="ORIGINAL"),
    )

    assert package.draft.main_fields["tax_19"] == Decimal("57")
    assert package.audit_appendix is not None
    appendix = package.audit_appendix
    assert appendix["source_trust_summary"]["summary"]["transaction_source_count"] == 1
    assert appendix["source_trust_summary"]["summary"]["status_counts"]["source_evidence"] == 1
    assert appendix["storage_smoke_report"]["status"] in {"pass", "warn"}
    assert appendix["nbp_coverage_report"]["status"] == "pass"
    assert appendix["no_overpay_audit_v3"]["summary"]["counted_total_pln"] == "12.34"
    assert appendix["defense_vault_summary"]["summary"]["total"] == 1
    assert appendix["advisor_review_pack"]["audit"]["audit_hash"] == "trust-hash"
    assert appendix["pit_case_file"]["audit_hash"] == "trust-hash"


def test_no_overpay_v3_candidate_does_not_change_tax_amount():
    result = make_engine_result(filing_ready=True)
    result.cost_items.append(
        CostItem(
            cost_id="INTEREST-CANDIDATE-1",
            kind="NEGATIVE_BALANCE_INTEREST",
            amount_foreign=Decimal("0"),
            currency="PLN",
            tax_event_date=pd.Timestamp("2025-06-01"),
            amount_pln=Decimal("99.99"),
            source_id="cash-row-1",
            evidence_level="MISSING",
            allocation_target="negative_cash_balance:PLN:2025-06-01",
            included_in_plan=set(),
            is_aggressive_only=True,
            derived_cost=False,
        )
    )

    package = generate_tax_filing_package(
        result,
        TaxFilingRequest(package_scope="full", filing_mode="ORIGINAL"),
    )

    assert package.draft.main_fields["tax_19"] == Decimal("57")
    assert package.audit_appendix is not None
    sections = package.audit_appendix["no_overpay_audit_v3"]["sections"]
    flat_items = [item for section in sections for item in section["items"]]
    candidate = next(item for item in flat_items if item["item_id"] == "INTEREST-CANDIDATE-1")
    assert candidate["decision"] in {"candidate", "requires_evidence", "excluded_by_policy"}
    assert package.audit_appendix["tax_advisor_brief"]["summary"]["tax_19_pln"] == "57.00"


def test_prowizja_powiazana_nie_jest_doliczana_do_poz_21_z_informacji_pit8c():
    """Koszty z informacji PIT-8C obejmuja prowizje - doliczona prowizja bylaby w poz. 21 drugi raz."""
    from types import SimpleNamespace

    from investment_tax_engine.tax.filing_package import _pit8c_linked_plan_cost

    def wynik(zrodlo: str):
        return SimpleNamespace(
            annual_summary={"art30b": {"pit8c_sell_trade_ids": ["S-1"], "pit8c_source": zrodlo}},
            cost_decisions=[
                SimpleNamespace(cost_id=cost_id, included=True, plan_name="aggressive_user") for cost_id in ("C-1", "C-2")
            ],
            cost_items=[
                SimpleNamespace(cost_id="C-1", amount_pln=Decimal("5.00"), allocation_target="S-1", kind="TRADE_COMMISSION"),
                SimpleNamespace(cost_id="C-2", amount_pln=Decimal("10.00"), allocation_target="S-1", kind="INVESTMENT_INTEREST"),
            ],
        )

    assert _pit8c_linked_plan_cost(wynik("informacja"), "aggressive_user") == Decimal("10.00")
    assert _pit8c_linked_plan_cost(wynik("transakcje"), "aggressive_user") == Decimal("15.00")
