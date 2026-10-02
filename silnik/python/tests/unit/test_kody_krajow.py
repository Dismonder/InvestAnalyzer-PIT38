"""Panstwo w PIT/ZG tylko ze slownika MF - prefiks ISIN XS to nie panstwo."""

from __future__ import annotations

import re
from pathlib import Path
from types import SimpleNamespace

from investment_tax_engine.normalize.classify import infer_country
from investment_tax_engine.normalize.kody_krajow import KODY_KRAJOW_MF
from investment_tax_engine.tax.pit_zg import UNKNOWN_COUNTRY, _country_of_trade

SCHEMAT = Path(__file__).resolve().parents[4] / "jakosc" / "schematy" / "pit38" / "KodyKrajow_v13-0E.xsd"


def test_lista_kodow_zgadza_sie_ze_slownikiem_ministerstwa():
    ze_schematu = set(re.findall(r'enumeration value="([A-Z]{2})"', SCHEMAT.read_text(encoding="utf-8")))
    assert KODY_KRAJOW_MF == ze_schematu


def test_isin_papieru_miedzynarodowego_nie_daje_panstwa_ani_zgadywania_z_tickera():
    # Euroobligacja rozliczana w Clearstream: XS nie jest panstwem, a koncowka
    # tickera nie mowi nic o emitencie.
    assert infer_country("BOND.US", "XS1234567895") is None
    assert infer_country("EUBOND", "EU0000000000") is None
    assert _country_of_trade(SimpleNamespace(symbol="BOND.US", isin="XS1234567895")) == UNKNOWN_COUNTRY


def test_panstwo_z_isin_ma_pierwszenstwo_a_bez_isin_zostaje_ticker():
    assert infer_country("NBIS.US", "NL0009805522") == "NL"
    assert infer_country("AAPL.US", "US0378331005") == "US"
    assert infer_country("AAPL.US", None) == "US"
    # Smiec w polu ISIN nie jest numerem - wtedy dalej decyduje ticker.
    assert infer_country("AAPL.US", "N/A") == "US"


def test_kraj_z_edytora_uzupelnia_panstwo_tylko_gdy_isin_i_symbol_milcza():
    # Nota DGT4016.JUN26 bez ISIN: blokade PIT/ZG usuwa pole "Kraj" w edytorze.
    assert _country_of_trade(SimpleNamespace(symbol="DGT4016.JUN26", isin=None, user_country="CY")) == "CY"
    # Euroobligacja XS - panstwo z numeru nieustalone, decyduje uzytkownik.
    assert _country_of_trade(SimpleNamespace(symbol="BOND", isin="XS1234567895", user_country="lu")) == "LU"
    # Znany kraj z ISIN wygrywa - edycja innego pola nie przestawia NBIS z NL.
    assert _country_of_trade(SimpleNamespace(symbol="NBIS.US", isin="NL0009805522", user_country="US")) == "NL"
    # Kod spoza slownika MF nie jest panstwem.
    assert _country_of_trade(SimpleNamespace(symbol="DGT4016.JUN26", isin=None, user_country="XS")) == UNKNOWN_COUNTRY
    assert _country_of_trade(SimpleNamespace(symbol="DGT4016.JUN26", isin=None, user_country=None)) == UNKNOWN_COUNTRY


def test_nadpisanie_transakcji_zapisuje_kraj_uzytkownika():
    from investment_tax_engine.app.manual_overrides import _apply_trade_values

    trade = SimpleNamespace(
        symbol="DGT4016.JUN26", isin=None, side="SELL", quantity=None, price=None, gross_amount=None,
        trade_currency="USD", commission=None, commission_currency="USD", instrument_class="STRUCTURED_PRODUCT",
        instrument_type_code=None, market_id=None, country=None, user_country=None, comment=None, message=None,
        executed_at=None, exchange_time=None, settlement_date=None, original_amount=None, original_currency=None,
    )
    _apply_trade_values(trade, {"country": " cy "})
    assert trade.user_country == "CY"
    assert _country_of_trade(trade) == "CY"
