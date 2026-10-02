"""S5-1: niezgodna kwota ZAKUPU, ktorego partia poszla do sprzedazy w roku rozliczenia, blokuje.
S5-2: zwrot podatku u zrodla parowany wg jawnego powiazania i blokujacy, gdy nierozstrzygalny.
"""

from __future__ import annotations

from decimal import Decimal

import pandas as pd

from investment_tax_engine.app.engine import InvestmentTaxEngine
from investment_tax_engine.models.core import (
    CanonicalDataset, CanonicalEvent, EngineConfig, Ledger, MergeResult,
)
from investment_tax_engine.normalize.trades import normalize_api_trade
from investment_tax_engine.tax.dividends_engine import build_dividend_views
from investment_tax_engine.tax.fifo_engine import build_fifo_tax_rows
from investment_tax_engine.tax.pit38_engine import build_pit38_views
from investment_tax_engine.validation.quality_gates import build_quality_report


def _transakcja(trade_id: str, strona: str, ilosc: int, cena: str, data: str, kwota: str | None = None):
    wiersz = {"id": trade_id, "Symbol": "ABC.US", "Side": strona, "Quantity": ilosc,
              "Cena": cena, "Currency": "PLN", "date": data}
    if kwota is not None:
        wiersz["gross_amount"] = kwota
    trade = normalize_api_trade(wiersz)
    trade.tax_event_date = pd.Timestamp(data)
    trade.exchange_time = trade.executed_at = pd.Timestamp(data)
    if strona == "BUY":
        trade.buy_total_cost_pln = trade.gross_amount
    else:
        trade.sell_gross_revenue_pln = trade.sell_net_revenue_pln = trade.gross_amount
    return trade


def _zablokowane(trades, rok=2025):
    silnik = InvestmentTaxEngine(EngineConfig(tax_year=rok))
    issues = silnik._trade_amount_mismatch_issues(trades)
    wiersze, _ = build_fifo_tax_rows(trades, EngineConfig())
    silnik._eskaluj_niezgodnosc_zuzytych_zakupow(issues, wiersze)
    return {issue.scope_id: issue for issue in issues}, wiersze


def test_s5_1_zakup_z_niezgodna_kwota_zuzyty_w_roku_rozliczenia_blokuje():
    zakup = _transakcja("B-1", "BUY", 10, "10.00", "2025-03-03", kwota="120.00")
    sprzedaz = _transakcja("S-1", "SELL", 10, "20.00", "2025-06-03")
    issues, wiersze = _zablokowane([zakup, sprzedaz])
    assert wiersze[0].cost_pln == Decimal("120.00")  # koszt ze zlej kwoty: dochod 80 zamiast 100
    assert issues["B-1"].code == "TRADE_AMOUNT_MISMATCH"
    assert issues["B-1"].blocking and issues["B-1"].severity == "ERROR"
    assert not build_quality_report(list(issues.values())).filing_ready


def test_s5_1_zakup_zuzyty_tylko_czesciowo_tez_blokuje():
    zakup = _transakcja("B-1", "BUY", 10, "10.00", "2025-03-03", kwota="120.00")
    sprzedaz = _transakcja("S-1", "SELL", 4, "20.00", "2025-06-03")
    issues, _ = _zablokowane([zakup, sprzedaz])
    assert issues["B-1"].blocking


def test_s5_1_niesprzedany_zakup_tylko_ostrzega():
    zakup = _transakcja("B-1", "BUY", 10, "10.00", "2025-03-03", kwota="120.00")
    issues, _ = _zablokowane([zakup])
    assert (issues["B-1"].severity, issues["B-1"].blocking) == ("WARNING", False)


def test_s5_1_zakup_zuzyty_w_innym_roku_niz_rozliczenia_tylko_ostrzega():
    zakup = _transakcja("B-1", "BUY", 10, "10.00", "2024-03-03", kwota="120.00")
    sprzedaz = _transakcja("S-1", "SELL", 10, "20.00", "2024-06-03")
    issues, _ = _zablokowane([zakup, sprzedaz], rok=2025)
    assert (issues["B-1"].severity, issues["B-1"].blocking) == ("WARNING", False)


def test_s5_1_zgodny_zakup_nie_daje_zgloszenia():
    zakup = _transakcja("B-1", "BUY", 10, "10.00", "2025-03-03")
    sprzedaz = _transakcja("S-1", "SELL", 10, "20.00", "2025-06-03")
    issues, _ = _zablokowane([zakup, sprzedaz])
    assert issues == {}


def _zdarzenie(identyfikator: str, rodzaj: str, kwota: str, data: str = "2025-05-10") -> CanonicalEvent:
    return CanonicalEvent(
        event_id=identyfikator, event_kind=rodzaj, symbol="ABC.US", linked_trade_id=None,
        amount=Decimal(kwota), currency="USD", effective_at=pd.Timestamp(data),
        comment=None, source_name="BROKER_JSON", source_priority=70,
        source_record_id=identyfikator, tax_event_date=pd.Timestamp(data),
        amount_pln=Decimal(kwota) * 4, fx_rate=Decimal("4"), country="US",
    )


def _dwie_dywidendy_z_potraceniami_i_zwrotem(powiazanie: str | None):
    zdarzenia = [_zdarzenie("d1", "DIVIDEND", "100"), _zdarzenie("d2", "DIVIDEND", "100"),
                 _zdarzenie("t1", "TAX", "-15"), _zdarzenie("t2", "TAX", "-15"),
                 _zdarzenie("r1", "TAX", "5", data="2025-05-20")]
    zdarzenia[2].source_links = [{"related_event_id": "d1"}]
    zdarzenia[3].source_links = [{"related_event_id": "d2"}]
    if powiazanie:
        zdarzenia[4].source_links = [{"related_event_id": powiazanie}]
    return zdarzenia


def _pit(zdarzenia):
    merge = MergeResult(ledger=Ledger(events_by_id={e.event_id: e for e in zdarzenia}),
                        canonical_dataset=CanonicalDataset())
    payload = build_pit38_views(merge, [], EngineConfig(tax_year=2025))
    return payload, build_quality_report(merge.ledger.issues)


def test_s5_2_zwrot_z_jawnym_powiazaniem_pomniejsza_podatek_wlasciwej_dywidendy():
    zdarzenia = _dwie_dywidendy_z_potraceniami_i_zwrotem("d1")
    dywidendy, podatki = build_dividend_views(zdarzenia)
    assert {w["event_id"]: w["withholding_tax_foreign"] for w in dywidendy} == {"d1": "10.00", "d2": "15.00"}
    assert {w["event_id"]: w["matched_dividend_event_id"] for w in podatki}["r1"] == "d1"
    payload, raport = _pit(zdarzenia)
    art30a = payload["summary"]["art30a"]
    # odliczenie 40 + 60 = 100 zl (art. 30a ust. 9: zwrot zmniejsza podatek zaplacony), doplata 152 - 100
    assert (art30a["foreign_withholding_creditable_pln"], art30a["tax_to_pay_pln"]) == ("100.00", "52.00")
    assert not any(i.code == "DIVIDEND_TAX_PAIRING_AMBIGUOUS" for i in raport.blocking_issues)


def test_s5_2_zwrot_bez_powiazania_przy_rownych_dywidendach_nie_blokuje():
    zdarzenia = _dwie_dywidendy_z_potraceniami_i_zwrotem(None)
    _, podatki = build_dividend_views(zdarzenia)
    zwrot = next(w for w in podatki if w["event_id"] == "r1")
    assert zwrot["pairing_ambiguous"] is False and zwrot["matched_dividend_event_id"] in {"d1", "d2"}
    payload, _ = _pit(zdarzenia)
    assert payload["summary"]["art30a"]["foreign_withholding_creditable_pln"] == "100.00"


def _nierozstrzygalny_zwrot():
    # d1 (100 USD, potracone 20) i d2 (200 USD, potracone 40) przekraczaja limit umowny 15%;
    # zwrot 8 USD do d1 obniza odliczenie o 12 zl, do d2 - nie zmienia go.
    zdarzenia = [_zdarzenie("d1", "DIVIDEND", "100"), _zdarzenie("d2", "DIVIDEND", "200"),
                 _zdarzenie("t1", "TAX", "-20"), _zdarzenie("t2", "TAX", "-40"),
                 _zdarzenie("r1", "TAX", "8", data="2025-05-20")]
    zdarzenia[2].source_links = [{"related_event_id": "d1"}]
    zdarzenia[3].source_links = [{"related_event_id": "d2"}]
    return zdarzenia


def test_s5_2_zwrot_bez_powiazania_zmieniajacy_odliczenie_blokuje():
    zdarzenia = _nierozstrzygalny_zwrot()
    _, podatki = build_dividend_views(zdarzenia)
    zwrot = next(w for w in podatki if w["event_id"] == "r1")
    assert zwrot["pairing_ambiguous"] is True and zwrot["matched_dividend_event_id"] is None
    _, raport = _pit(zdarzenia)
    assert any(i.code == "DIVIDEND_TAX_PAIRING_AMBIGUOUS" for i in raport.blocking_issues)
    assert not raport.filing_ready


def test_s5_2_jawne_powiazanie_rozstrzyga_zwrot_zmieniajacy_odliczenie():
    zdarzenia = _nierozstrzygalny_zwrot()
    zdarzenia[4].source_links = [{"related_event_id": "d1"}]
    dywidendy, podatki = build_dividend_views(zdarzenia)
    assert {w["event_id"]: w["matched_dividend_event_id"] for w in podatki}["r1"] == "d1"
    payload, raport = _pit(zdarzenia)
    assert payload["summary"]["art30a"]["foreign_withholding_creditable_pln"] == "168.00"
    assert not any(i.code == "DIVIDEND_TAX_PAIRING_AMBIGUOUS" for i in raport.blocking_issues)


def test_s5_1_caly_przebieg_silnika_zatrzymuje_rozliczenie_przy_zuzytym_zakupie(tmp_path):
    import json
    from zestaw_wejsciowy import _synthetic_set
    from investment_tax_engine.app.engine import InputBundle

    # Test przerabia kwote konkretnej transakcji, wiec zawsze na zestawie syntetycznym
    # (prywatny ma inny ksztalt rekordow i nie moze byc modyfikowany w tescie).
    zestaw = _synthetic_set()
    assert zestaw is not None, "Brak zestawu syntetycznego (narzedzia/skrypty/zbuduj_dane_testowe.py)."
    dane = json.loads(zestaw.api_json.read_text(encoding="utf-8"))
    zakup = dane["trades"]["trade"][0]
    assert zakup["operation"] == "buy" and zakup["p"] * zakup["q"] == zakup["summ"]
    zakup["summ"] = zakup["summ"] + 200  # kwota rozna od ilosc x cena
    api = tmp_path / "api.json"
    api.write_text(json.dumps(dane), encoding="utf-8")
    silnik = InvestmentTaxEngine(EngineConfig(run_mode="SAFE", nbp_allow_api_fallback=False, tax_year=2025))
    wynik = silnik.run(InputBundle(api_json_path=api, trades_v1_path=None, trades_legacy_path=None, tradernet_table_path=None,
                                    nbp_csv_paths=list(zestaw.nbp_csv), output_dir=tmp_path / "out"))
    niezgodnosci = [i for i in wynik.merge_result.ledger.issues if i.code == "TRADE_AMOUNT_MISMATCH"]
    assert [i.scope_id for i in niezgodnosci] == [str(zakup["trade_id"])] or [i.scope_id for i in niezgodnosci] == [str(zakup["id"])]
    assert all(i.blocking for i in niezgodnosci)
    assert any(i.code == "TRADE_AMOUNT_MISMATCH" for i in wynik.quality_report.blocking_issues)
    assert wynik.filing_ready is False


def test_kontrola_zip_obejmuje_arkusz_xlsx_nazwany_xls(tmp_path):
    # Zmiana rozszerzenia na .xls nie moze omijac limitu rozpakowanego rozmiaru.
    import zipfile

    import pytest

    from investment_tax_engine.app.spreadsheet_safety import validate_spreadsheet_zip

    plik = tmp_path / "arkusz.xls"
    with zipfile.ZipFile(plik, "w", compression=zipfile.ZIP_DEFLATED) as archiwum:
        archiwum.writestr("xl/worksheets/sheet1.xml", "0" * (2 * 1024 * 1024))
    with pytest.raises(ValueError, match="SOURCE_INPUT_TOO_LARGE"):
        validate_spreadsheet_zip(plik, max_uncompressed_bytes=1024 * 1024)
