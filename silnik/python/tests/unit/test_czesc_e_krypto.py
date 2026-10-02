"""
Testy czesci E PIT-38 - walut wirtualnych.

Kazdy przypadek odpowiada regule, ktora odroznia czesc E od czesci C i o ktora
najlatwiej sie potknac przy przepisywaniu wyciagu z gieldy.
"""

from __future__ import annotations

from decimal import Decimal

import pandas as pd

from investment_tax_engine.models.core import CanonicalDataset, CanonicalTrade, EngineRunResult, Ledger, MergeResult
from investment_tax_engine.tax.crypto_engine import (
    czy_wymiana_krypto_na_krypto,
    oblicz_czesc_e,
    waluta_przeciwstawna,
)
from investment_tax_engine.tax.filing_package import _czesc_e_pola


def transakcja(**nadpisania) -> CanonicalTrade:
    baza = dict(
        trade_id="T-1",
        order_id=None,
        trade_number=None,
        symbol="BTCPLN",
        isin=None,
        side="BUY",
        instrument_type_code=None,
        instrument_class="CRYPTO",
        market_id=None,
        quantity=Decimal("0.5"),
        price=Decimal("200000"),
        gross_amount=Decimal("100000"),
        trade_currency="PLN",
        commission=Decimal("0"),
        commission_currency="PLN",
        broker_reported_profit=None,
        executed_at=pd.Timestamp("2026-03-10 12:00:00"),
        exchange_time=pd.Timestamp("2026-03-10 12:00:00"),
        settlement_date=None,
        confirm_time=None,
        otc=False,
        repo_close=None,
        base_contract_code=None,
        current_position_qty_after_trade=None,
        source_name="TEST",
        source_priority=100,
        source_record_id="row-1",
        tax_event_date=pd.Timestamp("2026-03-10"),
        gross_fx_rate=None,
        logical_world="crypto_tax",
        sources=["TEST"],
    )
    baza.update(nadpisania)
    return CanonicalTrade(**baza)


def zbior(*transakcje: CanonicalTrade) -> MergeResult:
    ledger = Ledger()
    for t in transakcje:
        ledger.trades_by_id[t.trade_id] = t
    return MergeResult(ledger=ledger, canonical_dataset=CanonicalDataset(trades=transakcje, events=()))


def test_wymiana_krypto_na_krypto_nie_jest_przychodem():
    """Art. 17 ust. 1f: zamiana jednej waluty wirtualnej na inna nie rodzi przychodu."""
    wynik, _ = oblicz_czesc_e(
        zbior(
            transakcja(
                trade_id="SWAP-1",
                symbol="BTCUSDT",
                side="SELL",
                trade_currency="USDT",
                gross_amount=Decimal("50000"),
                gross_fx_rate=Decimal("4.00"),
            )
        ),
        tax_year=2026,
    )

    assert wynik.revenue_pln == Decimal("0.00"), "stablecoin to waluta wirtualna, nie srodek platniczy"
    assert wynik.swap_count == 1
    assert wynik.trade_count == 0
    assert wynik.rows[0].kind == "CRYPTO_SWAP"


def test_fiat_jako_baza_pary_binance_blokuje_neutralny_swap():
    wynik, issues = oblicz_czesc_e(
        zbior(
            transakcja(
                trade_id="EUR-USDT",
                symbol="EURUSDT",
                side="SELL",
                quantity=Decimal("25"),
                trade_currency="USDT",
                gross_amount=Decimal("27"),
                gross_fx_rate=Decimal("4.00"),
            )
        ),
        tax_year=2026,
    )

    assert wynik.swap_count == 0
    assert wynik.trade_count == 0
    assert wynik.revenue_pln == Decimal("0.00")
    assert wynik.rows[0].kind == "FIAT_AS_CRYPTO"
    issue = next(issue for issue in issues if issue.code == "CRYPTO_FIAT_ASSET_MISCLASSIFIED")
    assert issue.blocking
    assert "EURUSDT" in issue.message and "2026-03-10" in issue.message and "EUR-USDT" in issue.message
    assert "Historii transakcji" in issue.message and "edytor" in issue.message
    assert issue.details["trade_ids"] == ["EUR-USDT"]


def test_stablecoin_z_prefiksem_waluty_fiat_nie_jest_blokowany():
    # "USDT" zaczyna sie od "USD", ale to waluta wirtualna - zakup USDT za BTC
    # jest zwykla wymiana krypto-krypto, a nie waluta fiat w miejscu krypto.
    for symbol in ("USDT", "USDTBTC"):
        wynik, issues = oblicz_czesc_e(
            zbior(
                transakcja(
                    trade_id=f"SWAP-{symbol}",
                    symbol=symbol,
                    side="BUY",
                    quantity=Decimal("100"),
                    trade_currency="BTC",
                    gross_amount=Decimal("0.001"),
                    gross_fx_rate=None,
                )
            ),
            tax_year=2026,
        )
        assert not any(issue.code == "CRYPTO_FIAT_ASSET_MISCLASSIFIED" for issue in issues), symbol
        assert wynik.swap_count == 1, symbol


def test_zbycie_za_zlotowki_jest_przychodem():
    wynik, _ = oblicz_czesc_e(
        zbior(
            transakcja(
                trade_id="SELL-1",
                symbol="BTCPLN",
                side="SELL",
                gross_amount=Decimal("120000"),
                trade_currency="PLN",
            )
        ),
        tax_year=2026,
    )

    assert wynik.revenue_pln == Decimal("120000.00")
    assert wynik.trade_count == 1


def test_koszt_nabycia_liczy_sie_w_roku_poniesienia_bez_sprzedazy():
    """Art. 22 ust. 14: wydatek jest kosztem, nawet gdy nic nie sprzedano."""
    wynik, _ = oblicz_czesc_e(
        zbior(transakcja(trade_id="BUY-1", gross_amount=Decimal("80000"))),
        tax_year=2026,
    )

    assert wynik.costs_current_year_pln == Decimal("80000.00")
    assert wynik.revenue_pln == Decimal("0.00")
    assert wynik.income_pln == Decimal("0.00")
    # Bez FIFO: brak sprzedazy nie oznacza braku kosztu, tylko koszt do przeniesienia.
    assert wynik.costs_carried_out_pln == Decimal("80000.00")


def test_nadwyzka_kosztow_przechodzi_na_rok_nastepny_a_nie_jest_strata():
    """Art. 22 ust. 16: nadwyzka wchodzi do czesci E kolejnego roku."""
    wynik, issues = oblicz_czesc_e(
        zbior(
            transakcja(trade_id="BUY-1", gross_amount=Decimal("100000")),
            transakcja(
                trade_id="SELL-1",
                side="SELL",
                gross_amount=Decimal("60000"),
                tax_event_date=pd.Timestamp("2026-06-01"),
            ),
        ),
        tax_year=2026,
    )

    assert wynik.revenue_pln == Decimal("60000.00")
    assert wynik.total_costs_pln == Decimal("100000.00")
    assert wynik.income_pln == Decimal("0.00")
    assert wynik.costs_carried_out_pln == Decimal("40000.00")
    assert wynik.tax_19_pln == Decimal("0.00")
    assert any(i.code == "CRYPTO_COSTS_CARRIED_FORWARD" for i in issues)


def test_koszty_z_lat_ubieglych_obnizaja_dochod():
    wynik, _ = oblicz_czesc_e(
        zbior(
            transakcja(
                trade_id="SELL-1",
                side="SELL",
                gross_amount=Decimal("50000"),
            )
        ),
        tax_year=2026,
        costs_carried_in_pln=Decimal("30000.00"),
    )

    assert wynik.revenue_pln == Decimal("50000.00")
    assert wynik.costs_carried_in_pln == Decimal("30000.00")
    assert wynik.total_costs_pln == Decimal("30000.00")
    assert wynik.income_pln == Decimal("20000.00")
    assert wynik.tax_19_pln == Decimal("3800.00")


def test_prowizje_sa_kosztem_po_obu_stronach():
    wynik, _ = oblicz_czesc_e(
        zbior(
            transakcja(
                trade_id="SELL-1",
                side="SELL",
                gross_amount=Decimal("10000"),
                commission=Decimal("25"),
            )
        ),
        tax_year=2026,
    )

    assert wynik.revenue_pln == Decimal("10000.00")
    assert wynik.costs_current_year_pln == Decimal("25.00")
    assert wynik.income_pln == Decimal("9975.00")


def test_kwota_w_obcej_walucie_przelicza_sie_kursem_nbp():
    wynik, _ = oblicz_czesc_e(
        zbior(
            transakcja(
                trade_id="SELL-1",
                symbol="BTCUSD",
                side="SELL",
                trade_currency="USD",
                gross_amount=Decimal("10000"),
                gross_fx_rate=Decimal("3.7267"),
            )
        ),
        tax_year=2026,
    )

    assert wynik.revenue_pln == Decimal("37267.00")


def test_prowizja_bnb_nie_dziedziczy_kursu_usd_i_ostrzega_takze_przy_fiat():
    wynik, issues = oblicz_czesc_e(
        zbior(transakcja(
            symbol="BTCUSD", side="SELL", trade_currency="USD",
            gross_amount=Decimal("100"), gross_fx_rate=Decimal("4"),
            commission=Decimal("0.1"), commission_currency="BNB",
        )), tax_year=2026,
    )
    assert wynik.revenue_pln == Decimal("400.00")
    assert wynik.costs_current_year_pln == Decimal("0.00")
    assert wynik.rows[0].commission_pln == Decimal("0.00")
    assert any(i.code == "CRYPTO_SWAP_COMMISSION_NO_FX" and not i.blocking for i in issues)


def test_prowizja_eur_nie_dziedziczy_kursu_usd():
    wynik, issues = oblicz_czesc_e(
        zbior(transakcja(
            symbol="BTCUSD", side="SELL", trade_currency="USD",
            gross_amount=Decimal("100"), gross_fx_rate=Decimal("4"),
            commission=Decimal("1"), commission_currency="EUR",
        )), tax_year=2026,
    )
    assert wynik.costs_current_year_pln == Decimal("0.00")
    assert any(i.code == "CRYPTO_SWAP_COMMISSION_NO_FX" for i in issues)


def test_rozpoznane_stablecoiny_i_altcoiny_sa_wymiana():
    for quote in ("BNB", "FDUSD", "USDP", "PYUSD", "EURC", "EURI", "AEUR", "XUSD", "SUI", "TON", "SHIB", "PEPE"):
        trade = transakcja(symbol=f"BTC{quote}", trade_currency=quote)
        assert czy_wymiana_krypto_na_krypto(trade), quote
        wynik, _ = oblicz_czesc_e(zbior(trade), tax_year=2026)
        assert wynik.swap_count == 1
        assert wynik.costs_current_year_pln == Decimal("0.00")


def test_nieznana_waluta_przeciwstawna_blokuje_z_czytelnym_powodem():
    wynik, issues = oblicz_czesc_e(
        zbior(transakcja(symbol="BTCZZZ", trade_currency="ZZZ", side="SELL")),
        tax_year=2026,
    )
    assert wynik.revenue_pln == Decimal("0.00")
    issue = next(i for i in issues if i.code == "CRYPTO_COUNTER_CURRENCY_UNKNOWN")
    assert issue.blocking and "ZZZ" in issue.message
    assert "BTCZZZ" in issue.message and "2026-03-10" in issue.message and "T-1" in issue.message
    assert "Historii transakcji" in issue.message and "edytor" in issue.message
    assert issue.details["trade_ids"] == ["T-1"]


def test_waluta_tabeli_a_nbp_nie_jest_mylona_z_nieznana_waluta():
    wynik, issues = oblicz_czesc_e(
        zbior(transakcja(
            symbol="BTCHKD", trade_currency="HKD", side="SELL",
            gross_amount=Decimal("100"), gross_fx_rate=Decimal("0.5"),
        )), tax_year=2026,
    )
    assert wynik.revenue_pln == Decimal("50.00")
    assert not any(i.code == "CRYPTO_COUNTER_CURRENCY_UNKNOWN" for i in issues)


def test_brak_kursu_zatrzymuje_rozliczenie_zamiast_wyceniac_na_zero():
    """
    Operacja bez kursu NBP nie moze wejsc do deklaracji jako 0,00 PLN.

    Wczesniej kurs zastepowano zerem, wiec sprzedaz za 10 000 USD dawala
    przychod 0,00 zl, a ostrzezenie bylo nieblokujace: deklaracja wygladala na
    policzona i byla zaniżona o 19% tej kwoty.
    """
    wynik, issues = oblicz_czesc_e(
        zbior(
            transakcja(
                trade_id="SELL-1",
                symbol="BTCUSD",
                side="SELL",
                trade_currency="USD",
                gross_amount=Decimal("10000"),
                gross_fx_rate=None,
            )
        ),
        tax_year=2026,
    )

    brak_kursu = [i for i in issues if i.code == "CRYPTO_FX_RATE_MISSING"]
    assert brak_kursu, "brak kursu musi byc zgloszony"
    assert brak_kursu[0].blocking is True, "niespojnosc musi zatrzymac wydanie pakietu"
    assert brak_kursu[0].severity == "ERROR"
    assert "BTCUSD" in brak_kursu[0].message and "2026-03-10" in brak_kursu[0].message
    assert "SELL-1" in brak_kursu[0].message and "kurs NBP" in brak_kursu[0].message

    # Kwota nie zostaje wyceniona na zero i nie udaje policzonego przychodu.
    assert wynik.revenue_pln == Decimal("0.00")
    assert wynik.trade_count == 0
    assert wynik.skipped_no_fx_count == 1
    assert [w.kind for w in wynik.rows] == ["BRAK_KURSU"]


def test_nierozpoznana_strona_nie_staje_sie_kosztem_nabycia():
    """
    Galaz `else` przypisywala kazda nie-sprzedaz do kosztow, wiec operacja
    z pusta albo nieznana strona obnizala podatek o 19% swojej wartosci.
    """
    wynik, issues = oblicz_czesc_e(
        zbior(
            transakcja(
                trade_id="X-1",
                symbol="BTCPLN",
                side="TRANSFER",
                trade_currency="PLN",
                gross_amount=Decimal("50000"),
            )
        ),
        tax_year=2026,
    )

    assert wynik.costs_current_year_pln == Decimal("0.00")
    assert wynik.skipped_unknown_side_count == 1
    assert [w.kind for w in wynik.rows] == ["NIEZNANA_STRONA"]
    nieznana = [i for i in issues if i.code == "CRYPTO_SIDE_UNKNOWN"]
    assert nieznana and nieznana[0].blocking is True
    assert "BTCPLN" in nieznana[0].message and "2026-03-10" in nieznana[0].message
    assert "X-1" in nieznana[0].message and "Historii transakcji" in nieznana[0].message


def test_operacje_z_innego_roku_nie_wchodza_do_rozliczenia():
    wynik, _ = oblicz_czesc_e(
        zbior(
            transakcja(trade_id="BUY-2025", tax_event_date=pd.Timestamp("2025-11-02")),
            transakcja(
                trade_id="SELL-2026",
                side="SELL",
                gross_amount=Decimal("70000"),
                tax_event_date=pd.Timestamp("2026-02-02"),
            ),
        ),
        tax_year=2026,
    )

    assert wynik.revenue_pln == Decimal("70000.00")
    assert wynik.costs_current_year_pln == Decimal("0.00")


def test_rozpoznanie_waluty_przeciwstawnej():
    assert waluta_przeciwstawna(transakcja(symbol="BTCUSDT", trade_currency="USDT")) == "USDT"
    assert waluta_przeciwstawna(transakcja(symbol="BTC/PLN", trade_currency="PLN")) == "PLN"
    assert waluta_przeciwstawna(transakcja(symbol="ETH-USD", trade_currency="USD")) == "USD"
    # Sam symbol bez pary: decyduje waluta rozliczenia z wyciagu.
    assert waluta_przeciwstawna(transakcja(symbol="SOL", trade_currency="EUR")) == "EUR"

    assert czy_wymiana_krypto_na_krypto(transakcja(symbol="BTCUSDT", trade_currency="USDT"))
    assert not czy_wymiana_krypto_na_krypto(transakcja(symbol="BTCPLN", trade_currency="PLN"))


def test_podatek_liczy_sie_od_dochodu_zaokraglonego_do_pelnych_zlotych():
    wynik, _ = oblicz_czesc_e(
        zbior(
            transakcja(
                trade_id="SELL-1",
                side="SELL",
                gross_amount=Decimal("10000.49"),
            )
        ),
        tax_year=2026,
    )

    assert wynik.income_pln == Decimal("10000.49")
    # 10 000 zl po zaokragleniu podstawy, stad 1900 zl.
    assert wynik.tax_19_pln == Decimal("1900.00")


def test_podatek_krypto_w_wyniku_jest_kwota_formularza_w_pelnych_zlotych():
    wynik, _ = oblicz_czesc_e(
        zbior(transakcja(side="SELL", gross_amount=Decimal("101.00"))), tax_year=2026
    )
    assert wynik.income_pln == Decimal("101.00")
    assert wynik.tax_19_pln == Decimal("19")
    assert wynik.to_dict()["tax_19_pln"] == "19"
    run_result = EngineRunResult.__new__(EngineRunResult)
    run_result.crypto_part_e = wynik.to_dict()
    fields, _ = _czesc_e_pola(run_result)
    # Poz. 43 to 19% z poz. 41 z groszami (TKwota2), poz. 45 dopiero w pelnych zlotych.
    assert {field.position: field.value for field in fields if field.position in {"41", "43", "44", "45"}} == {
        "41": Decimal("101"), "43": Decimal("19.19"), "44": Decimal("0.00"), "45": wynik.tax_19_pln,
    }


def test_prowizja_od_wymiany_krypto_na_krypto_jest_kosztem():
    """Art. 22 ust. 14: sama wymiana nie jest przychodem, ale prowizja to wydatek na nabycie.

    Wczesniej caly wiersz wymiany byl pomijany razem z prowizja, wiec koszty
    czesci E byly o nia zanizone.
    """
    wynik, _ = oblicz_czesc_e(
        zbior(
            transakcja(
                trade_id="SWAP-PROWIZJA",
                symbol="BTCUSDT",
                side="SELL",
                trade_currency="USDT",
                gross_amount=Decimal("50000"),
                gross_fx_rate=Decimal("4.00"),
                commission=Decimal("25"),
                commission_currency="USDT",
            )
        ),
        tax_year=2026,
    )

    assert wynik.revenue_pln == Decimal("0.00"), "wymiana nadal nie jest przychodem"
    assert wynik.swap_count == 1
    assert wynik.costs_current_year_pln == Decimal("0.00"), "prowizja w krypto pozostaje niewyceniona"
    assert wynik.rows[0].commission_pln == Decimal("0.00")


def test_prowizja_wymiany_bez_kursu_jest_zgloszona_zamiast_wejsc_jako_zero():
    wynik, issues = oblicz_czesc_e(
        zbior(
            transakcja(
                trade_id="SWAP-BEZ-KURSU",
                symbol="BTCETH",
                side="SELL",
                trade_currency="ETH",
                gross_amount=Decimal("2"),
                gross_fx_rate=None,
                commission=Decimal("0.001"),
                commission_currency="ETH",
            )
        ),
        tax_year=2026,
    )

    assert wynik.costs_current_year_pln == Decimal("0.00")
    kody = {issue.code for issue in issues}
    assert "CRYPTO_SWAP_COMMISSION_NO_FX" in kody, kody
