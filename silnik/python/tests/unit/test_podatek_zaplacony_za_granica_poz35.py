"""Poz. 35 PIT-38 to poz. 33 minus poz. 34.

`tax_due = _q0(rounded_tax_from_base)` pomijalo podatek zaplacony za granica
od dochodow z art. 30b: kwota wchodzila do poz. 34, ale ani poz. 35, ani kwota
do zaplaty w poz. 51 sie o nia nie zmniejszaly. Eksporter XML we frontendzie
liczy `p35 = p33 - p34`, wiec obie sciezki podawaly inna kwote.
"""

from __future__ import annotations

from decimal import Decimal


def _fields(projection) -> dict[str, Decimal]:
    return {field.position: field.value for field in projection.form_fields}


def _projekcja_z_podatkiem_zagranicznym(monkeypatch, dochod: str, podatek_zagraniczny: str):
    from investment_tax_engine.models.core import EngineRunResult
    from investment_tax_engine.tax import filing_package

    monkeypatch.setattr(
        filing_package,
        "_pit_zg_rows_for_result",
        lambda result: [
            {"country": "US", "income_pln": dochod, "foreign_tax_pln": podatek_zagraniczny}
        ],
    )

    result = EngineRunResult.__new__(EngineRunResult)
    result.annual_summary = {
        "pit38_rounded_revenue_pln": dochod,
        "pit38_rounded_cost_pln": "0",
        "pit38_income": dochod,
        "tax_19_pln": "0.00",
        "art30a": {},
    }
    result.primary_scenario = "aggressive_user"
    result.plan_used = "aggressive_user"
    return filing_package._build_fallback_projection_from_summary(result)


def test_poz_35_pomniejsza_sie_o_poz_34(monkeypatch):
    pola = _fields(_projekcja_z_podatkiem_zagranicznym(monkeypatch, "1000.00", "100.00"))

    assert pola["33"] == Decimal("190.00"), "19% z podstawy 1000 zl"
    assert pola["34"] == Decimal("100.00"), "podatek zaplacony za granica w granicach limitu"
    assert pola["35"] == Decimal("90"), "poz. 35 = poz. 33 - poz. 34"
    assert pola["51"] == Decimal("90"), "kwota do zaplaty nie moze ignorowac odliczenia"


def test_odliczenie_wieksze_niz_podatek_nie_daje_ujemnej_kwoty(monkeypatch):
    pola = _fields(_projekcja_z_podatkiem_zagranicznym(monkeypatch, "1000.00", "500.00"))

    assert pola["34"] <= pola["33"], "odliczenie ograniczone limitem proporcjonalnym"
    assert pola["35"] >= Decimal("0"), "podatek nalezny nie moze byc ujemny"
