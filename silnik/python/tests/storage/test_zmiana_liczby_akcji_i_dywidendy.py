"""Nierozstrzygniety podzial akcji z lat wczesniejszych i rok z samymi dywidendami.

S1: podzial 2:1 z 2025 r. bez decyzji zmienia koszt sprzedazy z 2026 r., wiec
gdy walor sprzedano w roku rozliczenia, blokuje PIT-38 tak samo jak zdarzenie
z samego roku rozliczenia.
S3: rok z jedna dywidenda (bez transakcji) to dane obliczeniowe, a nie pusty plik.
"""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path

import pytest

from investment_tax_engine.app.canonical_tax_input_adapter import (
    canonical_tax_input_has_engine_records,
    records_awaiting_decision_impact,
    review_queue,
)
from investment_tax_engine.app.engine import InputBundle, InvestmentTaxEngine
from investment_tax_engine.models.core import EngineConfig, TaxFilingRequest


def _zdarzenie(event_id: str, kind: str, raw: dict, *, ticker: str | None = "ABC.US", needs_review: bool = False) -> dict:
    return {
        "schema_version": "normalized_event.v1",
        "event_id": event_id,
        "event_kind": kind,
        "source": {
            "source_id": "source:test",
            "filename": "historia.json",
            "relative_path": "historia.json",
            "section": "root",
            "parser": "json",
        },
        "identity": {"trade_id": raw.get("id")},
        "date": {"trade_date": raw.get("date"), "datetime": raw.get("date")},
        "instrument": {"ticker": ticker},
        "amounts": {
            "quantity": raw.get("q"),
            "price": raw.get("p"),
            "gross": raw.get("v"),
            "amount": raw.get("Kwota"),
            "currency": raw.get("curr_c") or raw.get("waluta"),
        },
        "raw": {"raw_payload": raw},
        "status": {"needs_review": needs_review},
    }


def _kupno(data: str = "2025-02-01") -> dict:
    return _zdarzenie(
        "kupno", "trade",
        {"id": "T1", "operation": "buy", "instr_nm": "ABC.US", "q": "10", "p": "100", "v": "1000", "curr_c": "PLN", "date": data},
    )


def _sprzedaz(data: str = "2026-03-10", ticker: str = "ABC.US") -> dict:
    return _zdarzenie(
        "sprzedaz", "trade",
        {"id": "T2", "operation": "sell", "instr_nm": ticker, "q": "10", "p": "150", "v": "1500", "curr_c": "PLN", "date": data},
        ticker=ticker,
    )


def _podzial(data: str | None = "2025-06-01", ticker: str | None = "ABC.US") -> dict:
    return _zdarzenie(
        "podzial", "corporate_action",
        {"type_id": "split", "comment": "Stock split 2:1", "date": data, "q": "10", "ticker": ticker},
        ticker=ticker, needs_review=True,
    )


def _wejscie(*rekordy: dict) -> dict:
    return {"schema_version": "canonical_tax_input.v2", "records": list(rekordy)}


def test_podzial_sprzed_roku_blokuje_gdy_walor_sprzedano_w_roku_rozliczenia():
    wejscie = _wejscie(_kupno(), _podzial(), _sprzedaz())

    blokujace, ostrzezenia = records_awaiting_decision_impact(wejscie, 2026)

    assert blokujace == {"corporate_action": 1}
    assert ostrzezenia == {}
    pozycja = next(row for row in review_queue(wejscie, 2026) if row["kind"] == "corporate_action")
    assert pozycja["changes_share_count"] is True
    assert pozycja["blocks_filing"] is True


def test_podzial_sprzed_roku_bez_sprzedazy_walora_w_roku_tylko_ostrzega():
    inny_walor = _sprzedaz(ticker="XYZ.US")
    wejscie = _wejscie(_kupno(), _podzial(), inny_walor)

    blokujace, ostrzezenia = records_awaiting_decision_impact(wejscie, 2026)

    assert blokujace == {}
    assert ostrzezenia == {"corporate_action": 1}


def test_podzial_sprzed_roku_ten_sam_walor_bez_sufiksu_rynku_blokuje():
    wejscie = _wejscie(_kupno(), _podzial(ticker="ABC"), _sprzedaz())

    blokujace, _ = records_awaiting_decision_impact(wejscie, 2026)

    assert blokujace == {"corporate_action": 1}


def test_zdarzenie_sprzed_roku_bez_zmiany_liczby_akcji_nie_blokuje():
    # Wykup / inna operacja korporacyjna nie zmienia liczby akcji w partiach FIFO.
    inne = _zdarzenie(
        "inne", "corporate_action",
        {"type_id": "name_change", "comment": "Zmiana nazwy spolki", "date": "2025-06-01", "ticker": "ABC.US"},
        needs_review=True,
    )
    wejscie = _wejscie(_kupno(), inne, _sprzedaz())

    blokujace, ostrzezenia = records_awaiting_decision_impact(wejscie, 2026)

    assert blokujace == {}
    assert ostrzezenia == {"corporate_action": 1}


def test_podzial_z_decyzja_uzytkownika_nie_blokuje():
    from investment_tax_engine.app.canonical_tax_input_adapter import review_decision_key

    podzial = _podzial()
    wejscie = _wejscie(_kupno(), podzial, _sprzedaz())

    blokujace, _ = records_awaiting_decision_impact(
        wejscie, 2026, {review_decision_key(podzial): "handled_manually"}
    )

    assert blokujace == {}


def test_podzial_bez_daty_i_z_walorem_sprzedanym_w_roku_blokuje():
    wejscie = _wejscie(_kupno(), _podzial(data=None), _sprzedaz())

    blokujace, _ = records_awaiting_decision_impact(wejscie, 2026)

    assert blokujace == {"corporate_action": 1}


def test_podzial_po_roku_rozliczenia_nie_blokuje():
    wejscie = _wejscie(_kupno(), _podzial(data="2027-01-15"), _sprzedaz())

    blokujace, ostrzezenia = records_awaiting_decision_impact(wejscie, 2026)

    assert blokujace == {}
    assert ostrzezenia == {"corporate_action": 1}


def _uruchom(tmp_path: Path, wejscie: dict, rok: int, decyzje: dict | None = None):
    pakiet = InputBundle(
        api_json_path=tmp_path / "brak_a",
        trades_v1_path=tmp_path / "brak_b",
        trades_legacy_path=tmp_path / "brak_c",
        tradernet_table_path=tmp_path / "brak_d",
        output_dir=tmp_path / "out",
        metadata={
            "canonical_tax_input": wejscie,
            "canonical_tax_input_mode": "required",
            **({"review_decisions": decyzje} if decyzje else {}),
        },
    )
    silnik = InvestmentTaxEngine(
        EngineConfig(
            run_mode="SAFE",
            nbp_allow_api_fallback=False,
            tax_year=rok,
            tax_filing_request=TaxFilingRequest(package_scope="full", filing_mode="ORIGINAL"),
        )
    )
    return silnik.run(pakiet)


def _problemy_decyzji(wynik):
    return [
        issue
        for issue in [*wynik.actionable_issues, *wynik.informational_issues]
        if issue.code == "RECORDS_AWAITING_USER_DECISION"
    ]


def test_przebieg_silnika_nierozstrzygniety_podzial_blokuje_i_wskazuje_walor(tmp_path):
    """Kupno 10 szt. za 1000 zl (2025), podzial 2:1 bez decyzji, sprzedaz 10 szt. za 1500 zl (2026).

    FIFO bez podzialu: koszt 1000, dochod 500; po podziale powinno byc 500 kosztu
    i 1000 dochodu. Silnik nie zgaduje, wiec rozliczenie 2026 r. ma byc zablokowane
    komunikatem wskazujacym walor i miejsce decyzji.
    """
    wejscie = _wejscie(_kupno(), _podzial(), _sprzedaz())

    wynik = _uruchom(tmp_path, wejscie, 2026)

    problemy = _problemy_decyzji(wynik)
    assert len(problemy) == 1
    problem = problemy[0]
    assert problem.blocking is True
    assert "ABC" in problem.message
    assert "podział" in problem.message.lower() or "podzial" in problem.message.lower()
    assert "Co wymaga decyzji" in problem.message


def test_przebieg_silnika_podzial_w_roku_bez_sprzedazy_walora_w_roku_nie_blokuje(tmp_path):
    wejscie = _wejscie(_kupno(), _podzial(), _sprzedaz(ticker="XYZ.US"))

    wynik = _uruchom(tmp_path, wejscie, 2026)

    problemy = _problemy_decyzji(wynik)
    assert all(problem.blocking is False for problem in problemy)


# --- S3: rok z samymi dywidendami -------------------------------------------------


def _dywidenda(kwota: str = "100", waluta: str = "PLN", data: str = "2025-05-20") -> dict:
    return _zdarzenie(
        "dywidenda", "dividend",
        {"Data": data, "Kwota": kwota, "waluta": waluta, "Rodzaj zlecenia": "Dywidenda", "Komentarz": "Dywidenda ABC.US", "date": data},
    )


def test_wejscie_z_sama_dywidenda_ma_rekordy_obliczeniowe():
    assert canonical_tax_input_has_engine_records(_wejscie(_dywidenda())) is True


def test_wejscie_z_sama_dywidenda_bez_daty_nie_ma_rekordow_obliczeniowych():
    bez_daty = _dywidenda()
    bez_daty["date"] = {}
    assert canonical_tax_input_has_engine_records(_wejscie(bez_daty)) is False


def test_wejscie_z_samym_wplywem_gotowki_nadal_jest_puste():
    wplata = _zdarzenie(
        "wplata", "cash_movement",
        {"Data": "2025-05-20", "Kwota": "1000", "waluta": "PLN", "Komentarz": "Top up account", "date": "2025-05-20"},
    )
    assert canonical_tax_input_has_engine_records(_wejscie(wplata)) is False
    assert canonical_tax_input_has_engine_records(_wejscie()) is False


def test_przebieg_silnika_rok_z_jedna_dywidenda_liczy_czesc_g_bez_pustego_wejscia(tmp_path):
    wynik = _uruchom(tmp_path, _wejscie(_dywidenda()), 2025)

    kody = {issue.code for issue in [*wynik.actionable_issues, *wynik.informational_issues]}
    assert "CANONICAL_TAX_INPUT_EMPTY" not in kody
    pola = {
        pole.position: pole.value
        for pole in wynik.tax_filing_package.draft.scenario_projections["aggressive_user"].form_fields
    }
    assert Decimal(str(pola["47"])) == Decimal("19.00")


def test_reczna_sprzedaz_waloru_z_podzialem_sprzed_roku_zaostrza_do_blokady():
    """Sprzedaz z Historii (poza plikiem wejsciowym) tez zmienia koszt po nierozstrzygnietym podziale."""
    from types import SimpleNamespace

    import pandas as pd

    wejscie = _wejscie(_kupno(), _podzial())
    raport = {
        "reviewQueue": review_queue(wejscie, 2026),
        "recordsAwaitingUserDecisionBlockingByKind": {},
        "recordsAwaitingUserDecisionWarningByKind": {"corporate_action": 1},
    }
    assert raport["reviewQueue"][0]["blocks_filing"] is False
    reczna = SimpleNamespace(
        side="SELL", tax_event_date=pd.Timestamp("2026-03-10"), symbol="ABC.US", isin=None
    )
    rejestr = SimpleNamespace(ledger=SimpleNamespace(trades_by_id={"reczna": reczna}))

    InvestmentTaxEngine._zablokuj_zmiany_liczby_akcji_przy_sprzedazy_recznej(raport, rejestr, 2026)

    assert raport["reviewQueue"][0]["blocks_filing"] is True
    assert raport["recordsAwaitingUserDecisionBlockingByKind"] == {"corporate_action": 1}
    assert raport["recordsAwaitingUserDecisionWarningByKind"] == {}


def test_reczna_sprzedaz_innego_waloru_nie_zaostrza_podzialu():
    from types import SimpleNamespace

    import pandas as pd

    wejscie = _wejscie(_kupno(), _podzial())
    raport = {
        "reviewQueue": review_queue(wejscie, 2026),
        "recordsAwaitingUserDecisionBlockingByKind": {},
        "recordsAwaitingUserDecisionWarningByKind": {"corporate_action": 1},
    }
    reczna = SimpleNamespace(
        side="SELL", tax_event_date=pd.Timestamp("2026-03-10"), symbol="XYZ.US", isin=None
    )
    rejestr = SimpleNamespace(ledger=SimpleNamespace(trades_by_id={"reczna": reczna}))

    InvestmentTaxEngine._zablokuj_zmiany_liczby_akcji_przy_sprzedazy_recznej(raport, rejestr, 2026)

    assert raport["reviewQueue"][0]["blocks_filing"] is False
    assert raport["recordsAwaitingUserDecisionBlockingByKind"] == {}


# --- S1b: odwrocona logika (kazde zdarzenie korporacyjne poza rozpoznanym bez wplywu) -----


def _zdarzenie_korporacyjne(event_id: str, type_id: str, komentarz: str, data: str = "2025-06-01", ticker: str = "ABC.US"):
    return _zdarzenie(
        event_id, "corporate_action",
        {"type_id": type_id, "comment": komentarz, "date": data, "q": "10", "ticker": ticker},
        ticker=ticker, needs_review=True,
    )


@pytest.mark.parametrize(
    "type_id,komentarz",
    [
        ("bonus", "Bonus issue 1 for 10"),
        ("spinoff", "Spin-off of DEF shares, ratio 1:5"),
        ("stock_dividend", "Stock dividend 5%"),
        ("scrip", "Scrip dividend"),
        ("merger", "Merger, exchange ratio 0.8"),
        ("conversion", "Zamiana akcji z parytetem 2:1"),
        ("isin_change", "Reverse 1:10, new ISIN US0000000001"),
        ("other", "Nierozpoznane zdarzenie korporacyjne"),
    ],
)
def test_nierozstrzygniete_zdarzenie_korporacyjne_sprzed_roku_blokuje_gdy_walor_sprzedano(type_id, komentarz):
    wejscie = _wejscie(_kupno(), _zdarzenie_korporacyjne("z", type_id, komentarz), _sprzedaz())

    blokujace, ostrzezenia = records_awaiting_decision_impact(wejscie, 2026)

    assert blokujace == {"corporate_action": 1}
    assert ostrzezenia == {}


@pytest.mark.parametrize(
    "type_id,komentarz",
    [
        ("name_change", "Name change: ABC Corp to ABC Holdings"),
        ("ticker_change", "Ticker change ABC to ABCH"),
        ("dividend", "Cash dividend 0.5 USD per share"),
        ("maturity", "Termin zapadalnosci"),
    ],
)
def test_rozpoznane_zdarzenie_bez_zmiany_liczby_akcji_nie_blokuje(type_id, komentarz):
    wejscie = _wejscie(_kupno(), _zdarzenie_korporacyjne("z", type_id, komentarz), _sprzedaz())

    blokujace, ostrzezenia = records_awaiting_decision_impact(wejscie, 2026)

    assert blokujace == {}
    assert ostrzezenia == {"corporate_action": 1}


def test_spinoff_nie_blokuje_gdy_walor_nie_byl_sprzedany_w_roku():
    wejscie = _wejscie(_kupno(), _zdarzenie_korporacyjne("z", "spinoff", "Spin-off of DEF"), _sprzedaz(ticker="XYZ.US"))

    blokujace, ostrzezenia = records_awaiting_decision_impact(wejscie, 2026)

    assert blokujace == {}
    assert ostrzezenia == {"corporate_action": 1}


def test_akcje_przyznane_maja_wlasna_regule_i_nie_zmieniaja_sie():
    przyznanie = _zdarzenie(
        "award", "stock_award", {"date": "2024-01-01", "q": "1", "instr_nm": "ZZZ.US"}, ticker="ZZZ.US", needs_review=True
    )
    wejscie = _wejscie(przyznanie, _sprzedaz())

    blokujace, _ = records_awaiting_decision_impact(wejscie, 2026)

    assert blokujace == {"stock_award": 1}


# --- S1c: decyzja "nie wplywa na PIT" nie zwalnia zmiany liczby akcji sprzedanego waloru ---


def test_no_tax_effect_nie_zwalnia_podzialu_sprzedanego_w_roku_waloru():
    from investment_tax_engine.app.canonical_tax_input_adapter import review_decision_key

    podzial = _podzial()
    wejscie = _wejscie(_kupno(), podzial, _sprzedaz())
    klucz = review_decision_key(podzial)

    blokujace, _ = records_awaiting_decision_impact(wejscie, 2026, {klucz: "no_tax_effect"})
    pozycja = review_queue(wejscie, 2026, {klucz: "no_tax_effect"})[0]

    assert blokujace == {"corporate_action": 1}
    assert pozycja["decision"] == "no_tax_effect"
    assert pozycja["decision_insufficient"] is True
    assert pozycja["blocks_filing"] is True
    assert "art. 22 ust. 1a" in pozycja["blocking_note"]


def test_handled_manually_zwalnia_podzial_sprzedanego_waloru():
    from investment_tax_engine.app.canonical_tax_input_adapter import review_decision_key

    podzial = _podzial()
    wejscie = _wejscie(_kupno(), podzial, _sprzedaz())

    blokujace, _ = records_awaiting_decision_impact(
        wejscie, 2026, {review_decision_key(podzial): "handled_manually"}
    )

    assert blokujace == {}


def test_no_tax_effect_zwalnia_podzial_waloru_niesprzedanego_w_roku():
    from investment_tax_engine.app.canonical_tax_input_adapter import review_decision_key

    podzial = _podzial()
    wejscie = _wejscie(_kupno(), podzial, _sprzedaz(ticker="XYZ.US"))

    blokujace, ostrzezenia = records_awaiting_decision_impact(
        wejscie, 2026, {review_decision_key(podzial): "no_tax_effect"}
    )

    assert blokujace == {}
    assert ostrzezenia == {}


def test_przebieg_silnika_no_tax_effect_zostawia_blokade_z_pouczeniem(tmp_path):
    from investment_tax_engine.app.canonical_tax_input_adapter import review_decision_key

    podzial = _podzial()
    wejscie = _wejscie(_kupno(), podzial, _sprzedaz())

    wynik = _uruchom(tmp_path, wejscie, 2026, {review_decision_key(podzial): "no_tax_effect"})

    problemy = _problemy_decyzji(wynik)
    assert len(problemy) == 1 and problemy[0].blocking is True
    assert "art. 22 ust. 1a" in problemy[0].message
    assert "Ująłem ręcznie w historii" in problemy[0].message


def _rejestr_z_reczna_sprzedaza(symbol: str = "ABC.US"):
    from types import SimpleNamespace

    import pandas as pd

    reczna = SimpleNamespace(side="SELL", tax_event_date=pd.Timestamp("2026-03-10"), symbol=symbol, isin=None)
    return SimpleNamespace(ledger=SimpleNamespace(trades_by_id={"reczna": reczna}))


def test_reczna_sprzedaz_niesie_no_tax_effect_do_blokady():
    from investment_tax_engine.app.canonical_tax_input_adapter import review_decision_key

    podzial = _podzial()
    decyzje = {review_decision_key(podzial): "no_tax_effect"}
    wejscie = _wejscie(_kupno(), podzial)
    raport = {
        "reviewQueue": review_queue(wejscie, 2026, decyzje),
        "recordsAwaitingUserDecisionBlockingByKind": {},
        "recordsAwaitingUserDecisionWarningByKind": {},
    }

    InvestmentTaxEngine._zablokuj_zmiany_liczby_akcji_przy_sprzedazy_recznej(
        raport, _rejestr_z_reczna_sprzedaza(), 2026
    )

    assert raport["reviewQueue"][0]["decision_insufficient"] is True
    assert raport["recordsAwaitingUserDecisionBlockingByKind"] == {"corporate_action": 1}


def test_reczna_sprzedaz_zaostrza_tez_nierozpoznane_zdarzenie_korporacyjne():
    wejscie = _wejscie(_kupno(), _zdarzenie_korporacyjne("z", "spinoff", "Spin-off of DEF"))
    raport = {
        "reviewQueue": review_queue(wejscie, 2026),
        "recordsAwaitingUserDecisionBlockingByKind": {},
        "recordsAwaitingUserDecisionWarningByKind": {"corporate_action": 1},
    }

    InvestmentTaxEngine._zablokuj_zmiany_liczby_akcji_przy_sprzedazy_recznej(
        raport, _rejestr_z_reczna_sprzedaza(), 2026
    )

    assert raport["recordsAwaitingUserDecisionBlockingByKind"] == {"corporate_action": 1}
