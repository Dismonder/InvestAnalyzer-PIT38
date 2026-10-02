"""Niezalezne rachunki PIT-38(18) na syntetycznych kwotach.

Oczekiwania w komentarzach powstaly z przepisow i arytmetyki dziesietnej.
Fikstura NBP jest lokalna; testy nie lacza sie z siecia.
"""

from __future__ import annotations

import json
from decimal import Decimal

import pandas as pd
import pytest
from openpyxl import Workbook

from investment_tax_engine.app.engine import InputBundle, InvestmentTaxEngine
from investment_tax_engine.models.core import (
    CanonicalDataset, CanonicalEvent, EngineConfig, EngineRunResult, Ledger,
    MergeResult, PriorYearLoss, TaxFilingRequest, UserOverrides,
)
from investment_tax_engine.tax.filing_package import _build_scenario_projection
from investment_tax_engine.tax.fx_engine import apply_nbp_fx_to_event
from investment_tax_engine.tax.nbp_provider import LocalCsvNbpProvider
from investment_tax_engine.tax.pit38_engine import build_pit38_views
from investment_tax_engine.tax.crypto_engine import oblicz_czesc_e
from investment_tax_engine.normalize.trades import normalize_api_trade


def _api_trade(number, day, side, quantity, price, commission, symbol="GOLD.US"):
    gross = Decimal(quantity) * Decimal(price)
    return {
        "trade_id": number, "id": str(number), "date": f"{day} 12:00:00",
        "short_date": day, "pay_d": day, "instr_nm": symbol,
        "operation": side.lower(), "p": str(price), "q": str(quantity),
        "summ": str(gross), "curr_c": "USD", "commission": str(commission),
        "commission_currency": "USD", "comment": f"(Trade {number} {side.lower()} {symbol} )",
        "StartCash": 0, "EndCash": 0, "OrigClOrdID": None,
        "T2_confirm": None, "Yield": None, "acd": 0, "acd_deal": 0,
        "base_contract_code": None, "commiss_exchange": 0,
    }


def _run(tmp_path, trades, rates, *, year=2025, config=None):
    api_path = tmp_path / "api.json"
    api_path.write_text(json.dumps({"trades": {"trade": trades}}), encoding="utf-8")
    csv_path = tmp_path / "archiwum_tab_a_test.csv"
    csv_path.write_text(
        "dane;nr tabeli;pełny numer tabeli;1USD;\n"
        ";;;dolar amerykanski;\n"
        + "".join(
            f"{day.replace('-', '')};001/A/NBP/{day[:4]};001/A/NBP/{day[:4]};{rate.replace('.', ',')};\n"
            for day, rate in rates
        ),
        encoding="cp1250",
    )
    for name, header in (
        ("v1.xlsx", ("trade_id", "date", "instr_nm", "operation", "p", "q", "summ", "curr_c", "commission", "commission_currency")),
        ("stary.xlsx", ("trade_id", "date", "instr_nm", "operation", "p", "q", "summ", "curr_c", "commission", "commission_currency")),
        ("tabela.xlsx", ("date", "type", "amount", "currency", "comment")),
    ):
        workbook = Workbook()
        workbook.active.title = "sheet1"
        workbook.active.append(header)
        workbook.save(tmp_path / name)
    config = config or EngineConfig(
        run_mode="SAFE", tax_year=year, nbp_allow_api_fallback=False,
        tax_filing_request=TaxFilingRequest(package_scope="full", filing_mode="ORIGINAL"),
    )
    if config.tax_filing_request is None:
        config.tax_filing_request = TaxFilingRequest(package_scope="full", filing_mode="ORIGINAL")
    bundle = InputBundle(
        api_json_path=api_path,
        trades_v1_path=tmp_path / "v1.xlsx",
        trades_legacy_path=tmp_path / "stary.xlsx",
        tradernet_table_path=tmp_path / "tabela.xlsx",
        nbp_csv_paths=[csv_path], output_dir=tmp_path / "wynik",
    )
    return InvestmentTaxEngine(config).run(bundle)


def _fields(result):
    assert result.tax_filing_package is not None
    assert result.filing_ready, [issue.code for issue in result.quality_report.blocking_issues]
    return {field.position: field.value for field in result.tax_filing_package.draft.form_fields}


def test_usd_prowizje_poniedzialek_i_po_swiecie(tmp_path):
    # Art. 11a ust. 1-2 PIT: dla pon. 2025-05-05 ostatnia tabela to pt. 05-02;
    # dla wt. 05-06 (po swiecie 05-03 i niedzieli) tabela z pon. 05-05.
    # Kupno 10 * 10 USD + 1 USD prowizji = 101 * 4,00 = 404,00 PLN.
    # Sprzedaz 10 * 15 USD - 2 USD prowizji = 148 * 4,10 = 606,80 PLN.
    # Art. 30b ust. 2: poz. 22=615,00; 23=412,20; 28=202,80.
    result = _run(tmp_path, [
        _api_trade(10001, "2025-05-05", "BUY", "10", "10", "1"),
        _api_trade(10002, "2025-05-06", "SELL", "10", "15", "2"),
    ], [("2025-05-02", "4.0000"), ("2025-05-05", "4.1000")])
    fields = _fields(result)
    assert fields["22"] == Decimal("615.00")
    assert fields["23"] == Decimal("412.20")
    assert fields["28"] == Decimal("202.80")
    assert fields["31"] == Decimal("203")
    assert fields["33"] == Decimal("38.57")
    assert fields["35"] == Decimal("39")


def test_fifo_czesciowa_sprzedaz_i_partia_z_poprzedniego_roku(tmp_path):
    # Art. 24 ust. 10 PIT: przy niemoznosci wskazania partii zbywa sie najpierw
    # papiery nabyte najwczesniej. Art. 11a ust. 1-2: koszt zostaje przy kursie
    # z dnia poprzedzajacego NABYCIE, takze gdy nabycie bylo w innym roku.
    # 10 szt. z 2024: 10*10*4,00=400; 5 szt. z 2025: 5*20*4,10=410.
    # Sprzedaz 12 szt. zuzywa 10+2: koszt 400+2/5*410=564,00.
    # Przychod 12*30*4,20=1512; poz. 28=948; podatek 948*19%=180,12 -> 180.
    result = _run(tmp_path, [
        _api_trade(20001, "2024-12-31", "BUY", "10", "10", "0"),
        _api_trade(20002, "2025-01-07", "BUY", "5", "20", "0"),
        _api_trade(20003, "2025-06-03", "SELL", "12", "30", "0"),
    ], [("2024-12-30", "4.0000"), ("2025-01-03", "4.1000"), ("2025-06-02", "4.2000")])
    fields = _fields(result)
    january_buy = next(trade for trade in result.canonical_dataset.trades if trade.trade_id == "20002")
    assert january_buy.gross_fx_date == pd.Timestamp("2025-01-03")
    assert [row.cost_pln for row in result.fifo_rows] == [Decimal("400.00"), Decimal("164.00")]
    assert fields["22"] == Decimal("1512.00")
    assert fields["23"] == Decimal("564.00")
    assert fields["28"] == Decimal("948.00")
    assert fields["35"] == Decimal("180")


def test_roczny_wynik_netto_i_strata_z_lat_ubieglych(tmp_path):
    # Art. 9 ust. 2-3 PIT: rozlicza sie wynik calego zrodla, nie osobno
    # zyskowna i stratna pozycje. A: (75-25)*4=+200; B: (25-50)*4=-100.
    # Rok: przychod 300+100=400, koszt 100+200=300, dochod 100.
    # Potwierdzona strata 2024 = 80: wariant jednorazowy do 5 mln pozwala
    # odliczyc 80 w 2025; poz. 30=80, 31=20, 33=3,80, 35=4.
    config = EngineConfig(run_mode="SAFE", tax_year=2025, nbp_allow_api_fallback=False,
        user_overrides=UserOverrides(prior_year_losses=[PriorYearLoss(
            tax_year=2024, amount_pln=Decimal("80"), remaining_pln=Decimal("80"))]))
    result = _run(tmp_path, [
        _api_trade(30001, "2025-01-07", "BUY", "1", "25", "0", "GAIN.US"),
        _api_trade(30002, "2025-01-07", "BUY", "1", "50", "0", "LOSS.US"),
        _api_trade(30003, "2025-01-08", "SELL", "1", "75", "0", "GAIN.US"),
        _api_trade(30004, "2025-01-08", "SELL", "1", "25", "0", "LOSS.US"),
    ], [("2025-01-03", "4.0000"), ("2025-01-07", "4.0000")], config=config)
    fields = _fields(result)
    assert {key: fields[key] for key in ("26", "27", "28", "29", "30", "31", "33", "35")} == {
        "26": Decimal("400.00"), "27": Decimal("300.00"),
        "28": Decimal("100.00"), "29": Decimal("0"), "30": Decimal("80.00"),
        "31": Decimal("20"), "33": Decimal("3.80"), "35": Decimal("4"),
    }


def test_strata_8_mln_limit_jednorazowy_5_mln(tmp_path):
    # Art. 9 ust. 3 PIT: dla straty 8 mln 50%=4 mln albo jednorazowo 5 mln
    # w jednym z pieciu nastepnych lat. Przy dochodzie 6 mln wybieramy 5 mln.
    # Koszt 1 mln USD*4=4 mln; przychod 2,5 mln USD*4=10 mln.
    # Poz. 28=6 mln, 30=5 mln, 31=1 mln, 33=190 tys., 35=190 tys.
    config = EngineConfig(run_mode="SAFE", tax_year=2025, nbp_allow_api_fallback=False,
        user_overrides=UserOverrides(prior_year_losses=[PriorYearLoss(
            tax_year=2024, amount_pln=Decimal("8000000"), remaining_pln=Decimal("8000000"))]))
    result = _run(tmp_path, [
        _api_trade(31001, "2025-01-07", "BUY", "1", "1000000", "0"),
        _api_trade(31002, "2025-01-08", "SELL", "1", "2500000", "0"),
    ], [("2025-01-03", "4.0000"), ("2025-01-07", "4.0000")], config=config)
    fields = _fields(result)
    assert (fields["28"], fields["30"], fields["31"], fields["33"], fields["35"]) == (
        Decimal("6000000.00"), Decimal("5000000.00"), Decimal("1000000"),
        Decimal("190000.00"), Decimal("190000"))


def test_pola_groszowe_i_zaokraglenia_podatku(tmp_path):
    # Art. 63 par. 1 Ordynacji + PIT-38(18) XSD: 26-30 sa kwotami z groszami.
    # Kupno 125 USD*4=500,00; sprzedaz 250,375 USD*4=1001,50.
    # Poz. 28=501,50; poz. 31=502 PLN; poz. 33=502*19%=95,38;
    # poz. 35=95 PLN (koncowka 0,38 jest pomijana).
    result = _run(tmp_path, [
        _api_trade(40001, "2025-01-07", "BUY", "1", "125", "0"),
        _api_trade(40002, "2025-01-08", "SELL", "1", "250.375", "0"),
    ], [("2025-01-03", "4.0000"), ("2025-01-07", "4.0000")])
    fields = _fields(result)
    assert (fields["26"], fields["27"], fields["28"], fields["30"]) == (
        Decimal("1001.50"), Decimal("500.00"), Decimal("501.50"), Decimal("0.00"))
    assert (fields["31"], fields["33"], fields["35"]) == (
        Decimal("502"), Decimal("95.38"), Decimal("95"))


def _dividend_projection(tmp_path, withholding_usd):
    _run(tmp_path, [], [("2025-06-02", "4.0000")])
    provider = LocalCsvNbpProvider([tmp_path / "archiwum_tab_a_test.csv"])
    config = EngineConfig(tax_year=2025, nbp_allow_api_fallback=False)

    def event(name, kind, amount):
        item = CanonicalEvent(
            event_id=name, event_kind=kind, symbol="DIV.US", linked_trade_id=None,
            amount=Decimal(amount), currency="USD", effective_at=pd.Timestamp("2025-06-03"),
            comment=None, source_name="BROKER_JSON", source_priority=70,
            source_record_id=name, logical_world="equity_tax", country="US",
        )
        apply_nbp_fx_to_event(item, provider, config)
        return item

    dividend = event("DIV", "DIVIDEND", "250")
    tax = event("WHT", "TAX", str(-Decimal(withholding_usd)))
    merge = MergeResult(
        ledger=Ledger(events_by_id={"DIV": dividend, "WHT": tax}),
        canonical_dataset=CanonicalDataset(events=(dividend, tax)),
    )
    payload = build_pit38_views(merge, [], config)
    result = EngineRunResult(
        status="SUCCESS", filing_ready=True, config=config,
        canonical_dataset=merge.canonical_dataset, merge_result=merge,
        annual_summary=payload["summary"], scenario_results=payload["scenario_results"],
    )
    fields = {field.position: field.value for field in
              _build_scenario_projection(result, "aggressive_user").form_fields}
    return fields, dividend, tax


def test_dywidenda_usa_15_proc_wht_czesc_g(tmp_path):
    # Art. 30a ust. 1 pkt 4 i ust. 9 PIT: dywidenda 250 USD * 4 = 1000 PLN.
    # Podatek USA (W-8BEN) 37,50 USD * 4 = 150 PLN. Polski 19%=190 PLN.
    # Poz. 47=190, 48=150, 49=40 PLN, 51=40 PLN. Poz. 45=0 (czesc F).
    fields, dividend, tax = _dividend_projection(tmp_path, "37.50")
    assert (dividend.fx_date, tax.fx_date) == (pd.Timestamp("2025-06-02"),) * 2
    assert (fields["45"], fields["46"], fields["47"], fields["48"], fields["49"], fields["50"], fields["51"]) == (
        Decimal("0"), Decimal("0"), Decimal("190.00"), Decimal("150.00"),
        Decimal("40"), Decimal("0"), Decimal("40"))


def test_krypto_nadwyzka_kosztow_w_roku(tmp_path):
    # Art. 17 ust. 1f, art. 22 ust. 14 i 16, art. 30b ust. 1a PIT:
    # 2025: zakup 1000 USD*4=4000 PLN; zbycie 600 USD*4=2400 PLN.
    # Poz. 36=2400, 37=4000, 39=0, 40=1600 do 2026, podatek 0.
    trades_2025 = [
        _api_trade(60001, "2025-01-07", "BUY", "1", "1000", "0", "BTCUSD"),
        _api_trade(60002, "2025-01-08", "SELL", "1", "600", "0", "BTCUSD"),
    ]
    result = _run(tmp_path, trades_2025,
                  [("2025-01-03", "4.0000"), ("2025-01-07", "4.0000")])
    fields = _fields(result)
    assert (fields["36"], fields["37"], fields["38"], fields["39"], fields["40"], fields["45"]) == (
        Decimal("2400.00"), Decimal("4000.00"), Decimal("0.00"),
        Decimal("0.00"), Decimal("1600.00"), Decimal("0"))


def test_krypto_koszt_przeniesiony_z_poprzedniego_roku(tmp_path):
    # Art. 22 ust. 16 PIT: nadwyzka kosztow z 2025 (1600 zl, patrz test wyzej)
    # powieksza koszty 2026. Zbycie 1 BTC za 1000 USD * 4 = 4000 zl, koszty roku 0,
    # koszty z lat ubieglych 1600: poz. 36=4000, 37=0, 38=1600, 39=2400,
    # 40=0, podatek 19% * 2400 = 456 zl. Wczesniej silnik gubil koszt przeniesiony
    # przy scalaniu nadpisan i liczyl 760 zl ze statusem gotowym do zlozenia.
    config = EngineConfig(
        run_mode="SAFE", tax_year=2026, nbp_allow_api_fallback=False,
        user_overrides=UserOverrides(crypto_costs_carried_forward_pln=Decimal("1600.00")),
    )
    trades = [
        _api_trade(60011, "2025-01-07", "BUY", "1", "1000", "0", "BTCUSD"),
        _api_trade(60012, "2026-01-08", "SELL", "1", "1000", "0", "BTCUSD"),
    ]
    result = _run(tmp_path, trades,
                  [("2025-01-03", "4.0000"), ("2026-01-07", "4.0000")], year=2026, config=config)
    fields = _fields(result)
    assert (fields["36"], fields["37"], fields["38"], fields["39"], fields["40"], fields["45"]) == (
        Decimal("4000.00"), Decimal("0.00"), Decimal("1600.00"),
        Decimal("2400.00"), Decimal("0.00"), Decimal("456"))


def test_wymiana_krypto_krypto_neutralna_w_czesci_e():
    # Art. 17 ust. 1f PIT: zamiana BTC na USDT nie jest przychodem.
    # 1 BTC za 2000 USDT: poz. 36=0, podatek=0, brak przeniesienia kosztu
    # samej zamiany. Nie istnieje prawny kurs NBP waluty USDT.
    raw = _api_trade(60003, "2025-01-08", "SELL", "1", "2000", "0", "BTCUSDT")
    raw["curr_c"] = "USDT"
    raw["commission_currency"] = "USDT"
    trade = normalize_api_trade(raw)
    trade.tax_event_date = pd.Timestamp("2025-01-08")
    merge = MergeResult(
        ledger=Ledger(trades_by_id={trade.trade_id: trade}),
        canonical_dataset=CanonicalDataset(trades=(trade,)),
    )
    result, issues = oblicz_czesc_e(merge, tax_year=2025)
    assert not issues
    assert (result.revenue_pln, result.costs_current_year_pln,
            result.costs_carried_out_pln, result.tax_19_pln, result.swap_count) == (
        Decimal("0.00"), Decimal("0.00"), Decimal("0.00"), Decimal("0.00"), 1)


def test_pelny_przebieg_wymiany_btc_usdt_nie_zada_kursu_usdt(tmp_path):
    # Art. 17 ust. 1f PIT: BTC za 2000 USDT nie tworzy przychodu.
    raw = _api_trade(60004, "2025-01-08", "SELL", "1", "2000", "0", "BTCUSDT")
    raw["curr_c"] = "USDT"
    raw["commission_currency"] = "USDT"
    result = _run(tmp_path, [raw], [("2025-01-03", "4.0000"), ("2025-01-07", "4.0000")])
    fields = _fields(result)
    assert (fields["36"], fields["37"], fields["45"]) == (
        Decimal("0.00"), Decimal("0.00"), Decimal("0"))
    assert not [
        issue for issue in result.merge_result.ledger.issues
        if issue.code == "NBP_RATE_NOT_FOUND" and "USDT" in issue.message
    ]
    assert not [
        issue for issue in result.merge_result.ledger.issues
        if issue.code == "NBP_COVERAGE_GAP" and issue.details.get("currency") == "USDT"
    ]


def test_wymiana_krypto_przelicza_prowizje_fiat_po_nbp(tmp_path):
    raw = _api_trade(60005, "2025-01-08", "SELL", "1", "2000", "0.5", "BTCUSDT")
    raw["curr_c"] = "USDT"
    raw["commission_currency"] = "USD"
    result = _run(tmp_path, [raw], [("2025-01-03", "4.0000"), ("2025-01-07", "4.0000")])
    trade = next(trade for trade in result.canonical_dataset.trades if trade.trade_id == "60005")
    assert trade.commission_fx_rate == Decimal("4.0000")
    assert trade.commission_pln == Decimal("2.00")
    assert result.crypto_part_e["costs_current_year_pln"] == "2.00"
    assert result.crypto_part_e["revenue_pln"] == "0.00"
    assert result.filing_ready is True


def test_prowizja_krypto_przy_swapie_pozostaje_bez_wyceny_i_z_ostrzezeniem(tmp_path):
    raw = _api_trade(60006, "2025-01-08", "SELL", "1", "2000", "0.001", "BTCUSDT")
    raw["curr_c"] = "USDT"
    raw["commission_currency"] = "BTC"
    result = _run(tmp_path, [raw], [("2025-01-03", "4.0000"), ("2025-01-07", "4.0000")])
    assert result.filing_ready is True
    assert result.crypto_part_e["costs_current_year_pln"] == "0.00"
    assert any(issue.code == "CRYPTO_SWAP_COMMISSION_NO_FX" for issue in result.merge_result.ledger.issues)
    assert not any(
        issue.code == "NBP_COVERAGE_GAP" and issue.details.get("currency") in {"USDT", "BTC"}
        for issue in result.merge_result.ledger.issues
    )


@pytest.mark.parametrize(
    ("operation", "buy_quantity", "split_quantity", "sell_quantity", "split_record_id"),
    [
        ("split", "10", "10", "10", 62001),
        ("reverse_split", "20", "20", "10", 63001),
    ],
)
def test_split_i_reverse_split_blokuja_bez_fikcyjnego_zakupu(
    tmp_path, operation, buy_quantity, split_quantity, sell_quantity, split_record_id
):
    # Ręcznie: split 2:1 daje koszt sprzedaży 200 zł i podatek 76 zł;
    # odwrotny 1:2 daje koszt 800 zł i podatek 0 zł. Silnik nie zmienia FIFO,
    # dopóki operacja nie zostanie ujęta jako zdarzenie, więc blokuje pakiet.
    buy_id = split_record_id - 1
    sell_id = split_record_id + 1
    split_row = _api_trade(split_record_id, "2025-01-08", operation, split_quantity, "0", "0", "ABC.US")
    split_row["operation"] = operation
    result = _run(tmp_path, [
        _api_trade(buy_id, "2025-01-07", "BUY", buy_quantity, "10", "0", "ABC.US"),
        split_row,
        _api_trade(sell_id, "2025-01-09", "SELL", sell_quantity, "15", "0", "ABC.US"),
    ], [("2025-01-03", "4.0000"), ("2025-01-07", "4.0000"), ("2025-01-08", "4.0000")])

    split_trade = next(trade for trade in result.canonical_dataset.trades if trade.trade_id == str(split_record_id))
    assert split_trade.side == "UNKNOWN"
    assert result.filing_ready is False
    issue = next(issue for issue in result.quality_report.blocking_issues if issue.code == "INCOMPLETE_TRANSACTION_SKIPPED")
    assert "Split/odwrotny split: popraw ilości ręcznie" in issue.message
    assert any(
        row["record_id"] == str(split_record_id)
        for row in issue.details["unrecognized_operation_records"]
    )
    assert result.fifo_rows
    assert not any(row.buy_trade_id == str(split_record_id) for row in result.fifo_rows)
    assert all(row.buy_trade_id == str(buy_id) for row in result.fifo_rows)


def test_pit8c_polska_i_sprzedaz_zagraniczna(tmp_path):
    # Art. 30b ust. 2, art. 45 ust. 1a pkt 1 PIT; PIT-38(18) czesc C:
    # wpis PIT-8C 220/110 zastępuje wyliczenie 200/100
    # dla rachunku polskiego; obrot zagraniczny 100/50 idzie do poz. 22/23.
    # Razem poz. 26=320, 27=160, 28=160. Art. 9 ust. 3: strata 2024=40
    # odliczona jednorazowo: poz. 30=40, 31=120. Poz. 33=22,80,
    # poz. 34=0 (brak podatku od zyskow zaplaconego za granica), 35=51=23.
    config = EngineConfig(run_mode="SAFE", tax_year=2025, nbp_allow_api_fallback=False,
        user_overrides=UserOverrides(prior_year_losses=[PriorYearLoss(
            tax_year=2024, amount_pln=Decimal("40"), remaining_pln=Decimal("40"))]))
    config.tax_plan.pit8c_sell_trade_ids = {"70002"}
    config.tax_plan.pit8c_no_sell_trade_ids = {"70004"}
    config.tax_plan.pit8c_entries = [{"revenuePln": "220.00", "costsPln": "110.00"}]
    trades = [
        _api_trade(70001, "2025-01-07", "BUY", "1", "25", "0", "POL.WA"),
        _api_trade(70002, "2025-01-08", "SELL", "1", "50", "0", "POL.WA"),
        _api_trade(70003, "2025-01-07", "BUY", "1", "12.5", "0", "FOR.US"),
        _api_trade(70004, "2025-01-08", "SELL", "1", "25", "0", "FOR.US"),
    ]
    for trade in trades:
        trade["isin"] = "PL0000000000" if trade["instr_nm"] == "POL.WA" else "US0000000000"
    result = _run(tmp_path, trades,
                  [("2025-01-03", "4.0000"), ("2025-01-07", "4.0000")], config=config)
    fields = _fields(result)
    expected = {
        "20": "220.00", "21": "110.00", "22": "100.00", "23": "50.00",
        "24": "0", "25": "0", "26": "320.00", "27": "160.00",
        "28": "160.00", "30": "40.00", "31": "120", "33": "22.80",
        "34": "0", "35": "23", "51": "23",
    }
    assert {key: fields[key] for key in expected} == {key: Decimal(value) for key, value in expected.items()}
