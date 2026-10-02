"""Oplata finansowania bez kwoty albo bez daty nie moze znikac po cichu z rozliczenia."""

from __future__ import annotations

from argparse import Namespace

import pytest

from investment_tax_engine.app.cli import BladDanychWejsciowych, build_bundle


def _args(tmp_path, wpisy: list[str]) -> Namespace:
    return Namespace(
        year="2025",
        run_mode="SAFE",
        api_json="",
        trades_v1="",
        trades_legacy="",
        tradernet_table="",
        broker_json="",
        broker_xml="",
        depo_json="",
        tax_plan="aggressive_user",
        package_scope="",
        filing_mode="ORIGINAL",
        include_fx_conversion_costs="",
        include_bank_funding_fees="",
        include_interest_costs="",
        include_account_fees="",
        funding_fee_id="",
        funding_fee_amount="",
        funding_fee_currency="PLN",
        funding_fee_date="",
        funding_fee_deposit_id="",
        funding_fee_deposit_amount="",
        funding_fee_evidence_note="",
        funding_fee_json=wpisy,
        nbp_csv=[],
        out_dir=str(tmp_path),
    )


def test_oplata_z_kwota_bez_daty_to_blad_wejscia(tmp_path):
    with pytest.raises(BladDanychWejsciowych) as blad:
        build_bundle(_args(tmp_path, ['{"fundingEventId":"bank-fee-1","amount":"24.73","currency":"PLN"}']))

    assert "bank-fee-1" in str(blad.value)
    assert "brakuje daty" in str(blad.value)
    assert "24.73" in str(blad.value)


def test_oplata_z_data_bez_kwoty_to_blad_wejscia(tmp_path):
    with pytest.raises(BladDanychWejsciowych) as blad:
        build_bundle(_args(tmp_path, ['{"fundingEventId":"bank-fee-2","date":"2025-01-21","currency":"PLN"}']))

    assert "bank-fee-2" in str(blad.value)
    assert "kwot" in str(blad.value).lower()


@pytest.mark.parametrize("pusty", ['{}', '{"amount":"","date":"  "}', '{"amount":null,"date":null}'])
def test_calkiem_pusty_wpis_jest_pomijany(tmp_path, pusty):
    bundle = build_bundle(_args(tmp_path, [pusty]))

    assert bundle.user_overrides.funding_cost_events == []


def test_kompletna_oplata_nadal_wchodzi(tmp_path):
    bundle = build_bundle(
        _args(tmp_path, ['{"fundingEventId":"bank-fee-3","amount":"24.73","currency":"PLN","date":"2025-01-21"}'])
    )

    assert [event.funding_event_id for event in bundle.user_overrides.funding_cost_events] == ["bank-fee-3"]
