"""Data i strona transakcji nie moga byc zgadywane w ciszy.

Dwa bledy tej samej klasy:
 - "01/02/2024" pandas czytal jako 2 stycznia, a import CSV w przegladarce
   (odczytCsv.dataZPola) jako 1 lutego - ta sama data dawala w dwoch sciezkach
   aplikacji rozne dni i rozne kursy NBP,
 - kazdy nierozpoznany kod operacji (split, transfer) wracal jako "BUY"
   i dokladal do FIFO partie nabycia, ktorej nie bylo.
"""

from decimal import Decimal

from investment_tax_engine.normalize.trades import determine_side, parse_amount, to_timestamp


def test_data_z_ukosnikami_czyta_sie_jak_w_imporcie_csv():
    assert to_timestamp("01/02/2024").date().isoformat() == "2024-02-01"
    assert to_timestamp("05.02.2024").date().isoformat() == "2024-02-05"
    assert to_timestamp("2024-02-01").date().isoformat() == "2024-02-01"


def test_typograficzne_minusy_zachowuja_znak_kwoty():
    for minus in ("−", "‒", "–", "﹣", "－"):
        assert parse_amount(f"{minus}123,45") == Decimal("-123.45")
        assert parse_amount(f"USD {minus}123.45") == Decimal("-123.45")


def test_liczbowe_daty_sa_rozpoznawane_bez_epoki_nanosekundowej():
    assert to_timestamp(46024).isoformat() == "2026-01-02T00:00:00"
    assert to_timestamp("46024.5").isoformat() == "2026-01-02T12:00:00"
    assert to_timestamp("20260102").date().isoformat() == "2026-01-02"
    assert to_timestamp("1700000000").isoformat() == "2023-11-14T22:13:20"
    assert to_timestamp("1700000000000").isoformat() == "2023-11-14T22:13:20"
    assert to_timestamp("12345") is None


def test_znany_kod_operacji_jest_pewny():
    assert determine_side({"operation": "2"}) == ("SELL", True)
    assert determine_side({"operation": "1"}) == ("BUY", True)
    assert determine_side({"operation": "sprzedaż"}) == ("SELL", True)
    assert determine_side({"operation": "S"}) == ("SELL", True)
    assert determine_side({"Operation": "b"}) == ("BUY", True)
    assert determine_side({"operation": "purchase"}) == ("BUY", True)
    assert determine_side({"operation": "trade", "side": "SELL"}) == ("SELL", True)
    assert determine_side({"operation_type": "MARKET", "side": "BUY"}) == ("BUY", True)
    assert determine_side({"operation": "Kupno", "side": "SELL"}) == ("UNKNOWN", False)
    # Tradernet: type 1/2 to kupno/sprzedaż, więc sprzeczny wiersz nie jest zgadywany.
    assert determine_side({"operation": "sell", "type": "1"}) == ("UNKNOWN", False)
    assert determine_side({"operation": "Wykup", "side": "BUY"}) == ("UNKNOWN", False)
    assert determine_side({"Typ": "Sprzedaż - wykup"}) == ("SELL", True)
    assert determine_side({"operation": "Sprzedaż swapu"}) == ("SELL", True)
    assert determine_side({"operation": "Zakup swapu"}) == ("BUY", True)


def test_nieznany_kod_operacji_nie_jest_zamieniany_na_zakup():
    strona, pewna = determine_side({"operation": "split"})
    assert strona == "UNKNOWN"
    assert pewna is False
    assert determine_side({})[1] is False, "brak kodu operacji tez jest niepewny"
    # "Wykup" zawiera "kup", ale jest zbyciem papieru, a nie zakupem.
    assert determine_side({"operation": "Wykup obligacji"}) == ("UNKNOWN", False)
    assert determine_side({"operation": "wykup"}) == ("UNKNOWN", False)
    assert determine_side({"operation": "Kupno"}) == ("BUY", True)


def test_liczby_numpy_z_arkusza_tez_sa_datami_excela():
    # pandas oddaje komorki liczbowe jako numpy.int64, ktore nie jest int -
    # serial Excela wracal wtedy jako 1970-01-01 00:00:00.000046024.
    import numpy as np

    assert to_timestamp(np.int64(46024)).isoformat() == "2026-01-02T00:00:00"
    assert to_timestamp(np.float64(46024.5)).isoformat() == "2026-01-02T12:00:00"
    assert to_timestamp(np.int64(12345)) is None
    assert to_timestamp(True) is None
