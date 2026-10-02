from __future__ import annotations

from decimal import Decimal
from pathlib import Path
import pandas as pd
import pytest

import investment_tax_engine.app.engine as engine_module
from investment_tax_engine.app.cli import parse_prior_year_loss_payload
from investment_tax_engine.models.core import CanonicalDataset, EngineConfig, Ledger, MergeResult, PriorYearLoss, RealizedTaxRow, UserOverrides
from investment_tax_engine.tax.pit38_engine import (
    AUDIT_HASH_KEYS,
    PRIOR_LOSS_CARRY_FORWARD_YEARS,
    PRIOR_LOSS_ONE_TIME_CAP_PLN,
    _is_within_carry_forward_window,
    build_pit38_views,
    compute_audit_hash,
    prior_loss_annual_limit,
)


def _loss_case(income: str, losses: list[tuple[int, str]]):
    row = RealizedTaxRow(
        row_id="SELL", symbol="ABC", sell_trade_id="SELL", buy_trade_id="BUY",
        quantity=Decimal("1"), sell_tax_date=pd.Timestamp("2026-02-01"),
        buy_tax_date=pd.Timestamp("2025-02-01"), sell_fx_date=pd.Timestamp("2026-01-31"),
        buy_fx_date=pd.Timestamp("2025-01-31"), gross_revenue_pln=Decimal(income),
        sell_commission_alloc_pln=Decimal("0"), net_revenue_pln=Decimal(income),
        cost_pln=Decimal("0"), pnl_pln=Decimal(income), acquisition_mode="BUY",
    )
    merge = MergeResult(ledger=Ledger(), canonical_dataset=CanonicalDataset())
    config = EngineConfig(tax_year=2026, user_overrides=UserOverrides(prior_year_losses=[
        PriorYearLoss(tax_year=year, amount_pln=Decimal(amount),
                      remaining_pln=Decimal(amount), accepted=True)
        for year, amount in losses
    ]))
    return build_pit38_views(merge, [row], config), merge


def test_same_year_loss_entries_block_and_are_not_deducted():
    payload, merge = _loss_case("8000000", [(2025, "4000000"), (2025, "4000000")])
    assert payload["summary"]["prior_year_losses_available_pln"] == "0.00"
    assert payload["summary"]["prior_year_loss_used_pln"] == "0.00"
    assert any(issue.code == "DUPLICATE_PRIOR_YEAR_LOSS" and issue.blocking and "2025" in issue.message for issue in merge.ledger.issues)


def test_older_loss_without_confirmed_remaining_blocks_deduction():
    row = RealizedTaxRow(
        row_id="SELL", symbol="ABC", sell_trade_id="SELL", buy_trade_id="BUY",
        quantity=Decimal("1"), sell_tax_date=pd.Timestamp("2026-02-01"),
        buy_tax_date=pd.Timestamp("2025-02-01"), sell_fx_date=pd.Timestamp("2026-01-31"),
        buy_fx_date=pd.Timestamp("2025-01-31"), gross_revenue_pln=Decimal("1000"),
        sell_commission_alloc_pln=Decimal("0"), net_revenue_pln=Decimal("1000"),
        cost_pln=Decimal("0"), pnl_pln=Decimal("1000"), acquisition_mode="BUY",
    )
    merge = MergeResult(ledger=Ledger(), canonical_dataset=CanonicalDataset())
    config = EngineConfig(tax_year=2026, user_overrides=UserOverrides(prior_year_losses=[
        PriorYearLoss(tax_year=2024, amount_pln=Decimal("1000"),
                      remaining_pln=Decimal("1000"), remaining_confirmed=False),
    ]))
    payload = build_pit38_views(merge, [row], config)
    assert payload["summary"]["prior_year_loss_used_pln"] == "0.00"
    assert any(issue.code == "PRIOR_YEAR_LOSS_REMAINING_UNCONFIRMED" and issue.blocking and "2024" in issue.message for issue in merge.ledger.issues)


def test_cli_requires_explicit_remaining_even_when_equal_to_original():
    old = parse_prior_year_loss_payload({"taxYear": 2024, "amountPln": "1000.00"})
    confirmed = parse_prior_year_loss_payload({"taxYear": 2024, "amountPln": "1000.00", "remainingPln": "1000.00"})
    exhausted = parse_prior_year_loss_payload({"taxYear": 2024, "amountPln": "1000.00", "remainingPln": "0"})
    assert old is not None and old.remaining_confirmed is False
    assert confirmed is not None and confirmed.remaining_confirmed is True
    assert exhausted is not None and exhausted.remaining_pln == Decimal("0")


def test_original_loss_sets_annual_limit_and_confirmed_balance_sets_availability():
    row = RealizedTaxRow(
        row_id="SELL", symbol="ABC", sell_trade_id="SELL", buy_trade_id="BUY",
        quantity=Decimal("1"), sell_tax_date=pd.Timestamp("2026-02-01"),
        buy_tax_date=pd.Timestamp("2025-02-01"), sell_fx_date=pd.Timestamp("2026-01-31"),
        buy_fx_date=pd.Timestamp("2025-01-31"), gross_revenue_pln=Decimal("7000000"),
        sell_commission_alloc_pln=Decimal("0"), net_revenue_pln=Decimal("7000000"),
        cost_pln=Decimal("0"), pnl_pln=Decimal("7000000"), acquisition_mode="BUY",
    )
    merge = MergeResult(ledger=Ledger(), canonical_dataset=CanonicalDataset())
    config = EngineConfig(tax_year=2026, user_overrides=UserOverrides(prior_year_losses=[
        PriorYearLoss(tax_year=2024, amount_pln=Decimal("12000000"), remaining_pln=Decimal("7000000")),
    ]))
    payload = build_pit38_views(merge, [row], config)
    assert payload["summary"]["prior_year_losses_available_pln"] == "6000000.00"
    assert payload["summary"]["prior_year_loss_used_pln"] == "6000000.00"
    config.user_overrides.prior_year_losses[0].remaining_pln = Decimal("1000000")
    payload = build_pit38_views(MergeResult(ledger=Ledger(), canonical_dataset=CanonicalDataset()), [row], config)
    assert payload["summary"]["prior_year_losses_available_pln"] == "1000000.00"


def test_prior_loss_usage_respects_each_loss_year_limit():
    payload, _ = _loss_case("7000000", [(2023, "10000000"), (2024, "2000000")])
    assert payload["summary"]["prior_year_losses_available_pln"] == "7000000.00"
    assert [entry["used_in_year"] for entry in payload["prior_year_loss_ledger"]] == ["5000000.00", "2000000.00"]


def test_loss_up_to_the_one_time_cap_can_be_deducted_in_full():
    """Ustawa daje wybor: 50% rocznie albo jednorazowo do 5 000 000 zl.

    Dla straty mniejszej niz ten prog wariant jednorazowy pozwala odliczyc
    calosc w jednym roku, wiec regula polowy go nie ogranicza.
    """
    assert prior_loss_annual_limit(Decimal("200000.00")) == Decimal("200000.00")
    assert prior_loss_annual_limit(PRIOR_LOSS_ONE_TIME_CAP_PLN) == PRIOR_LOSS_ONE_TIME_CAP_PLN


def test_large_loss_is_capped_at_half_per_year():
    """Powyzej dwukrotnosci progu jednorazowego wiaze regula polowy."""
    assert prior_loss_annual_limit(Decimal("12000000.00")) == Decimal("6000000.00")


def test_between_the_thresholds_the_more_favourable_option_applies():
    """Dla straty 8 mln wariant jednorazowy (5 mln) bije polowe (4 mln)."""
    assert prior_loss_annual_limit(Decimal("8000000.00")) == Decimal("5000000.00")


def test_zero_and_negative_loss_give_no_deduction():
    assert prior_loss_annual_limit(Decimal("0.00")) == Decimal("0.00")
    assert prior_loss_annual_limit(Decimal("-100.00")) == Decimal("0.00")


def test_loss_is_deductible_only_in_the_five_following_years():
    assert _is_within_carry_forward_window(2025, 2026) is True
    assert _is_within_carry_forward_window(2021, 2026) is True, "piaty rok jeszcze sie liczy"
    assert _is_within_carry_forward_window(2020, 2026) is False, "szosty rok jest juz poza oknem"
    assert PRIOR_LOSS_CARRY_FORWARD_YEARS == 5


def test_loss_from_the_settled_year_or_later_is_not_deductible():
    assert _is_within_carry_forward_window(2026, 2026) is False
    assert _is_within_carry_forward_window(2027, 2026) is False


def test_audit_hash_changes_when_the_prior_year_loss_ledger_changes():
    """Odcisk przebiegu musi obejmowac rozstrzygniecia o stratach.

    Hash liczyl sie w dwoch miejscach z osobna, a wersja z `engine.py`
    nadpisywala pierwsza i pomijala `prior_year_loss_ledger`. Dwa przebiegi
    roznice sie wylacznie decyzja o stracie z lat ubieglych dostawaly ten sam
    odcisk - a to on ma odrozniac pakiety dowodowe od siebie.
    """
    podstawa = {
        "summary": {"total_pnl_pln": "1000.00"},
        "scenario_results": {},
        "dividends_view": [],
        "foreign_tax_view": [],
        "private_cash_fx_view": [],
        "financing_comparison": {},
        "prior_year_loss_ledger": [
            {"tax_year": 2024, "amount_pln": "500.00", "status": "AUTO_NEEDS_CONFIRMATION"}
        ],
    }
    po_zatwierdzeniu = {
        **podstawa,
        "prior_year_loss_ledger": [{"tax_year": 2024, "amount_pln": "500.00", "status": "ACCEPTED"}],
    }

    assert compute_audit_hash(podstawa) != compute_audit_hash(po_zatwierdzeniu)


def test_audit_hash_ignores_keys_outside_the_declared_list():
    """Odcisk zalezy od zadeklarowanej listy kluczy, a nie od reszty przebiegu."""
    podstawa = {key: [] for key in AUDIT_HASH_KEYS}

    assert compute_audit_hash(podstawa) == compute_audit_hash({**podstawa, "performance_profile": {"x": 1}})


def test_both_hash_call_sites_use_the_same_key_list():
    """Jedna lista kluczy - drugi zestaw juz raz sie rozjechal.

    `engine._refresh_annual_payload_hash` przeliczal odcisk po doliczeniu
    decyzji kosztowych wlasna kopia listy. Rozjazd byl niewidoczny, bo obie
    wersje zwracaly poprawnie wygladajacy hash.
    """
    zrodlo = Path(engine_module.__file__).read_text(encoding="utf-8")

    assert "compute_audit_hash(annual_payload)" in zrodlo
    assert "sha256(" not in zrodlo.split("_refresh_annual_payload_hash")[1].split("def ")[0]


def test_rejected_entry_for_the_same_year_does_not_block_the_accepted_loss():
    # Wpis odrzucony przez uzytkownika nie jest druga kwota straty - blokowal
    # dotad odliczenie zaakceptowanego wpisu za ten sam rok.
    row = RealizedTaxRow(
        row_id="SELL", symbol="ABC", sell_trade_id="SELL", buy_trade_id="BUY",
        quantity=Decimal("1"), sell_tax_date=pd.Timestamp("2026-02-01"),
        buy_tax_date=pd.Timestamp("2025-02-01"), sell_fx_date=pd.Timestamp("2026-01-31"),
        buy_fx_date=pd.Timestamp("2025-01-31"), gross_revenue_pln=Decimal("1000"),
        sell_commission_alloc_pln=Decimal("0"), net_revenue_pln=Decimal("1000"),
        cost_pln=Decimal("0"), pnl_pln=Decimal("1000"), acquisition_mode="BUY",
    )
    merge = MergeResult(ledger=Ledger(), canonical_dataset=CanonicalDataset())
    config = EngineConfig(tax_year=2026, user_overrides=UserOverrides(prior_year_losses=[
        PriorYearLoss(tax_year=2025, amount_pln=Decimal("400"), remaining_pln=Decimal("400"), accepted=True),
        PriorYearLoss(tax_year=2025, amount_pln=Decimal("900"), remaining_pln=Decimal("900"), accepted=False),
    ]))
    payload = build_pit38_views(merge, [row], config)
    assert not any(issue.code == "DUPLICATE_PRIOR_YEAR_LOSS" for issue in merge.ledger.issues)
    # Strata do 5 mln zl moze byc odliczona jednorazowo w calosci (art. 9 ust. 3 pkt 2).
    assert payload["summary"]["prior_year_loss_used_pln"] == "400.00"


def test_wpis_straty_po_polsku_i_bledny_wpis_uzytkownika():
    from investment_tax_engine.app.cli import BladDanychWejsciowych

    wpis = parse_prior_year_loss_payload({"taxYear": 2024, "amountPln": "1 234,56", "remainingPln": "1 000,50"})
    assert wpis.amount_pln == Decimal("1234.56") and wpis.remaining_pln == Decimal("1000.50")
    assert parse_prior_year_loss_payload({"taxYear": 2024, "amountPln": "0,00"}) is None
    # Minus zamienialby odliczenie w doliczenie do dochodu.
    with pytest.raises(BladDanychWejsciowych, match="dodatnia"):
        parse_prior_year_loss_payload({"taxYear": 2024, "amountPln": "-500"})
    with pytest.raises(BladDanychWejsciowych, match="między 0 a kwotą straty"):
        parse_prior_year_loss_payload({"taxYear": 2024, "amountPln": "500", "remainingPln": "900"})
    with pytest.raises(BladDanychWejsciowych, match="Strata za 2024"):
        parse_prior_year_loss_payload({"taxYear": 2024, "amountPln": "pięćset"})
