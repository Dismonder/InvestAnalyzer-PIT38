"""Scalanie nadpisan uzytkownika z konfiguracji i z zadania.

`_merge_user_overrides_from_bundle` budowal nowy obiekt pole po polu i pominal
koszt krypto przeniesiony z lat ubieglych: wartosc podana w aplikacji spadala
do zera, a czesc E liczyla podatek od calego przychodu ze statusem gotowym do
zlozenia. Test pilnuje wszystkich pol - nowe pole dodane do UserOverrides bez
scalania od razu go wywroci.
"""

from __future__ import annotations

from dataclasses import fields
from decimal import Decimal
from pathlib import Path

from investment_tax_engine.app.engine import InvestmentTaxEngine
from investment_tax_engine.models.core import (
    EngineConfig,
    InputBundle,
    PriorYearLoss,
    UserOverrides,
)


def _bundle(overrides: UserOverrides) -> InputBundle:
    brak = Path("brak.json")
    return InputBundle(
        api_json_path=brak, trades_v1_path=brak, trades_legacy_path=brak,
        tradernet_table_path=brak, user_overrides=overrides,
    )


def test_koszt_krypto_z_lat_ubieglych_przezywa_scalanie():
    silnik = InvestmentTaxEngine(EngineConfig(tax_year=2026))
    scalone = silnik._merge_user_overrides_from_bundle(
        _bundle(UserOverrides(crypto_costs_carried_forward_pln=Decimal("1600.00")))
    )
    assert scalone.crypto_costs_carried_forward_pln == Decimal("1600.00")


def test_koszt_krypto_z_konfiguracji_zostaje_gdy_zadanie_go_nie_podaje():
    silnik = InvestmentTaxEngine(EngineConfig(
        tax_year=2026, user_overrides=UserOverrides(crypto_costs_carried_forward_pln=Decimal("250.00")),
    ))
    scalone = silnik._merge_user_overrides_from_bundle(_bundle(UserOverrides()))
    assert scalone.crypto_costs_carried_forward_pln == Decimal("250.00")


def test_zadne_pole_nadpisan_nie_ginie_przy_scalaniu():
    z_zadania = UserOverrides(
        manual_fx_overrides={"USD:2026-01-02": Decimal("4.0000")},
        conditional_cost_ids={"KOSZT-1"},
        prior_year_losses=[PriorYearLoss(tax_year=2025, amount_pln=Decimal("10"), remaining_pln=Decimal("10"))],
        crypto_costs_carried_forward_pln=Decimal("1.00"),
        funding_cost_events=[object()],  # type: ignore[list-item]
        transaction_overrides=[object()],  # type: ignore[list-item]
    )
    domyslne = UserOverrides()
    scalone = InvestmentTaxEngine(EngineConfig(tax_year=2026))._merge_user_overrides_from_bundle(_bundle(z_zadania))
    for pole in fields(UserOverrides):
        assert getattr(z_zadania, pole.name) != getattr(domyslne, pole.name), f"test nie ustawia pola {pole.name}"
        assert getattr(scalone, pole.name) == getattr(z_zadania, pole.name), f"scalanie gubi pole {pole.name}"
