"""Rozpoznawanie walut wirtualnych.

Waluty wirtualne rozliczaja sie w czesci E PIT-38 wedlug innych regul niz
papiery: wydatek na nabycie jest kosztem w roku poniesienia, niezaleznie od
sprzedazy, i nie stosuje sie do nich kolejki FIFO (art. 22 ust. 14-15 ustawy
o PIT). Silnik ich nie rozlicza, ale musi je wydzielic - wczesniej symbol
z gieldy krypto w rodzaju "BTCUSDT" wpadal do klasy EQUITY i trafial do czesci C
deklaracji, czyli do zlej sekcji.
"""

from __future__ import annotations

from investment_tax_engine.normalize.classify import (
    infer_instrument_class,
    infer_logical_world_for_trade,
)


def klasa(symbol: str, kod_typu: str = "") -> str:
    return infer_instrument_class(symbol, kod_typu, False, None, None)


def test_para_z_gieldy_krypto_bez_separatora() -> None:
    assert klasa("BTCUSDT") == "CRYPTO"
    assert klasa("ETHUSDC") == "CRYPTO"
    assert klasa("SOLPLN") == "CRYPTO"
    assert klasa("BTCFDUSD") == "CRYPTO"
    assert klasa("ETHBTC") == "CRYPTO"
    assert klasa("PEPEUSDT") == "CRYPTO"


def test_para_z_separatorem() -> None:
    assert klasa("ETH/USDT") == "CRYPTO"
    assert klasa("BTC-USD") == "CRYPTO"


def test_sufiks_gieldy_krypto() -> None:
    assert klasa("BTC.CC") == "CRYPTO"


def test_sam_symbol_waluty_wirtualnej() -> None:
    assert klasa("SOL") == "CRYPTO"


def test_znacznik_z_aplikacji_ma_pierwszenstwo() -> None:
    """Aplikacja zna kategorie instrumentu, wiec jej wskazanie rozstrzyga."""
    assert klasa("JAKIS.TICKER", "CRYPTO") == "CRYPTO"


def test_jawny_typ_akcji_ma_pierwszenstwo_przed_tickerem_tokena() -> None:
    assert klasa("FET", "STOCK") == "EQUITY"
    assert klasa("FET", "ETF") == "EQUITY"
    assert klasa("FET", "BOND") == "EQUITY"
    assert klasa("FET") == "CRYPTO"


def test_akcje_i_para_walutowa_bez_zmian() -> None:
    """Regresja: nowa regula stoi przed reguly FX, wiec pilnujemy obu."""
    assert klasa("AAPL.US") == "EQUITY"
    assert klasa("CDR.WA") == "EQUITY"
    assert klasa("POL.WA") == "EQUITY"
    assert klasa("USD/PLN") == "FX"
    assert klasa("EUR/USD") == "FX"


def test_waluty_wirtualne_maja_wlasny_swiat_podatkowy() -> None:
    assert infer_logical_world_for_trade("CRYPTO") == "crypto_tax"
    assert infer_logical_world_for_trade("EQUITY") == "equity_tax"
    assert infer_logical_world_for_trade("FX") == "private_cash_fx"


def test_jawny_typ_nie_przestawia_klas_otc_i_fx_z_kodow_brokera() -> None:
    """Typ z aplikacji rozstrzyga kolizje tickerow, ale kod brokera nie zmienia OTC ani par FX."""
    from investment_tax_engine.normalize.classify import infer_instrument_class

    assert infer_instrument_class("FET", "STOCK", False, None, None) == "EQUITY"
    assert infer_instrument_class("BRK/B", "STOCK", False, None, None) == "EQUITY"
    assert infer_instrument_class("FET", None, False, None, None) == "CRYPTO"
    # Kod typu brokera wyklucza zgadywanie krypto po symbolu...
    assert infer_instrument_class("ATOM", "1", False, None, None) == "EQUITY"
    # ...ale nie przenosi transakcji OTC ani pary walutowej do czesci C.
    assert infer_instrument_class("ABC.US", "1", True, None, None) == "OTHER"
    assert infer_instrument_class("EUR/USD", "4", False, None, None) == "FX"
    assert infer_instrument_class("DGT4016.JUN26", "BOND", False, None, None) == "STRUCTURED_PRODUCT"


def test_para_walutowa_z_importu_csv_jest_fx_mimo_typu_papieru() -> None:
    """Import CSV nie ma kategorii FX - EUR/USD przychodzi jako STOCK, a nie jest papierem (czesc C)."""
    from investment_tax_engine.normalize.classify import infer_instrument_class

    for symbol in ("EUR/USD", "EUR.USD", "EURUSD", "USD-PLN"):
        assert infer_instrument_class(symbol, "STOCK", False, None, None) == "FX", symbol
    assert infer_instrument_class("BRK/B", "STOCK", False, None, None) == "EQUITY"
