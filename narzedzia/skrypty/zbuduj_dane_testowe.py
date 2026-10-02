"""Buduje syntetyczny zestaw plikow wejsciowych do testow.

Prawdziwe wyciagi uzytkownika leza w `dane/pliki` i sa wylaczone z repozytorium,
bo zawieraja jego dane osobowe. Testy silnika byly na nich oparte, wiec na
swiezym klonie po prostu nie wykonywaly sie: szesnascie z nich konczylo sie
zielono, nie sprawdzajac niczego.

Ten skrypt zapisuje zestaw o tej samej strukturze, ale z wymyslonymi wartosciami:
inne kwoty, inne identyfikatory, walory z listy testowej, konto bez nazwiska i
bez adresu e-mail. Rozpoznawanie zrodel dziala po zawartosci, a nie po nazwie
pliku, wiec nazwy sa neutralne - dzieki temu bramka danych osobowych nie musi
robic dla tego katalogu zadnego wyjatku.

Uruchomienie: python narzedzia/skrypty/zbuduj_dane_testowe.py
"""

from __future__ import annotations

import json
import sys
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / "jakosc" / "dane-testowe"

# Walory z listy zarezerwowanej do przykladow, zeby nie sugerowac prawdziwego portfela.
BUY_SYMBOL = "TEST.US"
SECOND_SYMBOL = "PROBA.US"
AWARD_SYMBOL = "BONUS.US"
STRUCTURED_SYMBOL = "STRUKT4017.AUG25"
ACCOUNT_CODE = "TEST0001"

TRADES = [
    # (trade_id, data, symbol, operacja, cena, ilosc, prowizja)
    (900000001, "2025-02-03 10:15:00", BUY_SYMBOL, "buy", 100.00, 10, 2.50),
    (900000002, "2025-03-11 11:20:00", BUY_SYMBOL, "buy", 110.00, 5, 1.80),
    (900000003, "2025-06-17 12:05:00", BUY_SYMBOL, "sell", 130.00, 8, 2.10),
    (900000004, "2025-09-02 09:45:00", SECOND_SYMBOL, "buy", 50.00, 20, 1.20),
    (900000005, "2025-11-19 15:30:00", SECOND_SYMBOL, "sell", 62.50, 12, 1.40),
    (900000006, "2026-02-10 10:00:00", BUY_SYMBOL, "sell", 145.00, 7, 2.30),
    (900000007, "2026-04-08 13:40:00", SECOND_SYMBOL, "buy", 58.00, 15, 1.55),
]


def _trade_row(trade_id: int, moment: str, symbol: str, operation: str, price: float, qty: int, commission: float) -> dict:
    day = moment[:10]
    return {
        "trade_id": trade_id,
        "id": str(trade_id),
        "trade_nb": str(trade_id),
        "order_id": str(trade_id + 500000000),
        "transaction_id": trade_id + 2000000000,
        "date": moment,
        "short_date": day,
        "pay_d": day,
        "instr_nm": symbol,
        "instr_type": 1,
        "instr_kind": "akcja zwykla",
        "isin": "US0000000000",
        "issue_nb": None,
        "operation": operation,
        "p": price,
        "q": qty,
        "summ": round(price * qty, 2),
        "curr_c": "USD",
        "commission": commission,
        "commission_currency": "USD",
        "comment": f"(Trade {trade_id} {operation} {symbol} ) Market: usa, security type: stocks",
        "market": "usa",
        "mkt_id": 30000000001,
        "mkt_name": "usa",
        "office": 1,
        "broker": "TEST",
        "otc": 0,
        "offbalance": None,
        "profit": 0,
        "fifo_profit": "0.00000000",
        "turnover": "0.00000000",
        "yield": None,
        "repo_operation": None,
        "stamp_tax": 0,
        "forts_exchange_fee": 0,
        "smat": None,
        "is_dvp": 0,
        "das_exe_id": None,
        "itc_trd_match_id": None,
        "base_contract_code": None,
    }


def _cash_flow(day: str, amount: float, kind: str, type_id: str, comment: str) -> dict:
    return {
        "date": day,
        "account": "trading",
        "account_id": None,
        "sum": f"{amount} USD",
        "amount": amount,
        "currency": "USD",
        "type": kind,
        "type_id": type_id,
        "comment": comment,
    }


def build_broker_report() -> dict:
    """Raport brokera: transakcje, przeplywy gotowki i naliczenia."""
    trades = [_trade_row(*row) for row in TRADES]

    cash_flows = [
        _cash_flow("2025-01-15", 40000.00, "Wplata", "deposit", "Top up account through a bank transfer"),
        _cash_flow("2025-07-01", 5000.00, "Wplata", "deposit", "Top up account through a bank transfer"),
        _cash_flow("2025-12-19", -12000.00, "Wyplata", "withdrawal", "Debit. Withdrawal of funds"),
        _cash_flow("2026-01-20", 8000.00, "Wplata", "deposit", "Top up account through a bank transfer"),
    ]
    # Naliczenia za ujemne saldo w kolejnych dniach - test rejestru finansowania.
    for offset in range(4):
        day = (date(2025, 8, 4) + timedelta(days=offset)).isoformat()
        cash_flows.append(
            _cash_flow(
                day,
                -4.11,
                "Odsetki",
                "interest",
                "Fee for negative cash balance USD, fee rate as a percentage: 0.041095, "
                f"balance as at {day} 23:59:59: 10000.00",
            )
        )
    # Dywidenda i potracony u zrodla podatek - test odliczenia z art. 30a.
    cash_flows.append(_cash_flow("2025-10-20", 12.00, "Dywidenda", "dividend", f"Dividend for {BUY_SYMBOL}"))
    cash_flows.append(
        _cash_flow(
            "2025-10-20",
            -1.80,
            "Podatki",
            "tax",
            f"Corporate action tax on security ( {BUY_SYMBOL} ), record date 2025-10-10 . Tax rate 15",
        )
    )

    cash_in_outs = [
        {
            "id": 800000000 + index,
            "auth_login": "konto-testowe",
            "currency": "USD",
            "type": flow["type_id"],
            "datetime": f"{flow['date']} 12:00:00",
            "date_created": f"{flow['date']} 12:00:00.000000",
            "comment": flow["comment"],
            "amount": flow["amount"],
            "approved": 1,
            "commission": 0,
            "commission_currency": None,
            "corporate_action_id": None,
            "cps_id": None,
            "bank": None,
            "iban": None,
            "details": "[]",
            "notification_details": None,
        }
        for index, flow in enumerate(cash_flows)
    ]

    return {
        "date_start": "2025-01-01",
        "date_end": "2026-12-31",
        "companyDetails": {
            "address": "ul. Testowa 1",
            "companyName": "Broker Testowy",
            "brokerLicenceName": "-",
            "brokerLicenceNumber": "-",
            "brokerPhone": "-",
            "brokerEmail": "kontakt@example.com",
        },
        "plainAccountInfoData": {
            "account_type": "standard",
            "client_name": "Konto testowe",
            "client_code": ACCOUNT_CODE,
            "base_currency": "USD",
            "tariff_name": "Testowa",
            "client_date_open": "2025-01-01",
        },
        "accountInfo": [{"account": ACCOUNT_CODE, "currency": "USD"}],
        "userLanguage": "pl",
        "userReception": "web",
        "trades": {
            "detailed": trades,
            "securities": {BUY_SYMBOL: 0, SECOND_SYMBOL: 23},
            "total": {"count": len(trades)},
            "prtotal": {},
        },
        "cash_flows": {"detailed": cash_flows, "total": {"count": len(cash_flows)}},
        "cash_in_outs": cash_in_outs,
        "in_outs_securities": [],
        "securities_in_outs": [],
        "securities_in_outs_not_done_but_paid_before_period": [],
        "commissions": [],
        "corporate_actions": [],
        "ffbo_trades_offsetting": [],
        "account_at_start": {"USD": 0},
        "account_at_end": {"USD": 1000},
        "off_balance_money": {},
        "off_balance_iban_money": {},
        "off_balance_regular_money": {},
        "off_balance_securities": {},
        "off_balance_securities_prices": {},
        "off_balance_securities_accounts": {},
        "cash_flows_json": [],
        "cash_flows_off_balance_json": [],
        "securities_flows_json": [],
        "securities_flows_off_balance_json": [],
    }


def build_depositary_report() -> dict:
    """Raport depozytariusza - kontrola pozycji na koniec okresu."""
    return {
        "date_start": "2025-01-01",
        "date_end": "2026-12-31",
        "plainAccountInfoData": {
            "account_type": "standard",
            "client_name": "Konto testowe",
            "client_code": ACCOUNT_CODE,
            "base_currency": "USD",
            "tariff_name": "Testowa",
            "client_date_open": "2025-01-01",
        },
        "depoData": [
            {
                "name": BUY_SYMBOL,
                "instr_nm": BUY_SYMBOL,
                "isin": "US0000000000",
                "quantity_at_start": 0,
                "quantity_at_end": 0,
                "currency": "USD",
            },
            {
                "name": SECOND_SYMBOL,
                "instr_nm": SECOND_SYMBOL,
                "isin": "US0000000001",
                "quantity_at_start": 0,
                "quantity_at_end": 23,
                "currency": "USD",
            },
            {
                "name": AWARD_SYMBOL,
                "instr_nm": AWARD_SYMBOL,
                "isin": "US0000000002",
                "quantity_at_start": 0,
                "quantity_at_end": 3,
                "currency": "USD",
            },
        ],
        "repo_at_start": {},
        "repo_at_end": {},
        "swap_at_start": {},
        "swap_at_end": {},
        "depo_at_start": {},
        "depo_at_end": {},
        "mkt_prices": {BUY_SYMBOL: 145.00, SECOND_SYMBOL: 62.50, AWARD_SYMBOL: 15.00},
        "unique_securities": [BUY_SYMBOL, SECOND_SYMBOL, AWARD_SYMBOL],
        # Walor przyznany w promocji: nabycie bez ceny zakupu. Sprawdza sciezke
        # BONUS_CONTEST_SHARE i polityke award_policy w FIFO.
        "securities_in_outs": [
            {
                "id": 700000001,
                "type": "stock_award",
                "ticker": AWARD_SYMBOL,
                "quantity": 3,
                "market_value": 45.00,
                "cost": 0,
                "pay_d": "2025-05-06",
                "datetime": "2025-05-06 10:00:00",
                "balance_currency": "USD",
                "commission_currency": "USD",
            },
            # Wykup produktu strukturyzowanego: sprzedaz bez zlecenia klienta.
            {
                "id": 700000002,
                "type": "maturity",
                "ticker": STRUCTURED_SYMBOL,
                "quantity": 1,
                "market_value": 111.00,
                "cost": 100.00,
                "pay_d": "2025-08-19",
                "datetime": "2025-08-19 10:00:00",
                "balance_currency": "USD",
                "commission_currency": "USD",
            },
        ],
        "securities_flows_json": [
            {"ticker": AWARD_SYMBOL, "instr_type": "1", "mkt_id": "30000000001", "quantity_at_end": 3},
            {"ticker": SECOND_SYMBOL, "instr_type": "1", "mkt_id": "30000000001", "quantity_at_end": 23},
            {"ticker": STRUCTURED_SYMBOL, "instr_type": "19", "mkt_id": "30000000046", "quantity_at_end": 0},
        ],
    }


def build_history_list() -> list[dict]:
    """Historia transakcji w ukladzie plaskiej listy."""
    rows = []
    for trade_id, moment, symbol, operation, price, qty, commission in TRADES:
        rows.append(
            {
                "trade_id": trade_id,
                "id": str(trade_id),
                "date": moment,
                "short_date": moment[:10],
                "pay_d": moment[:10],
                "instr_nm": symbol,
                "operation": operation,
                "p": price,
                "q": qty,
                "summ": round(price * qty, 2),
                "curr_c": "USD",
                "commission": commission,
                "commission_currency": "USD",
                "comment": f"(Trade {trade_id} {operation} {symbol} )",
                "StartCash": 0,
                "EndCash": 0,
                "OrigClOrdID": None,
                "T2_confirm": None,
                "Yield": None,
                "acd": 0,
                "acd_deal": 0,
                "base_contract_code": None,
                "commiss_exchange": 0,
            }
        )
    return rows


# Klasa instrumentu decyduje o swiecie logicznym: repo jest wylacznie
# diagnostyczne, przewalutowanie idzie do gotowki prywatnej, produkt
# strukturyzowany rozlicza sie jak akcja. Zestaw musi miec po jednym z kazdej
# klasy, inaczej test klasyfikacji nie ma czego klasyfikowac.
KLASY_INSTRUMENTOW = [
    (910000001, "2025-04-14 09:30:00", "REPOTEST.US", "18", "buy", 100.00, 5),
    (910000002, "2025-04-15 09:30:00", "EUR/USD", "6", "buy", 1.0850, 1000),
    (910000003, "2025-04-16 09:30:00", STRUCTURED_SYMBOL, "19", "buy", 100.00, 1),
]


def build_typed_class_rows() -> list[dict]:
    rows = []
    for trade_id, moment, symbol, type_code, operation, price, qty in KLASY_INSTRUMENTOW:
        row = _trade_row(trade_id, moment, symbol, operation, price, qty, 0.0)
        row["instr_type_c"] = type_code
        rows.append(row)
    return rows


def build_api_dump() -> dict:
    """Zrzut API w ukladzie `trades.trade`."""
    return {
        "trades": {"trade": build_history_list() + build_typed_class_rows()},
        "max_trade_id": {"@text": str(TRADES[-1][0])},
    }


# Uklad naglowka i polskie znaki jak w tabeli A - plik jest w cp1250, wiec
# sluzy tez za dowod, ze obie warstwy czytaja go bez znakow zastepczych.
NBP_HEADER = "data;nr tabeli;pełny numer tabeli;1USD;1EUR;"
NBP_DESCRIPTION = ";;;dolar amerykański;euro;"


# Dni robocze bez tabeli A: swieta ustawowe i Wigilia. Bez nich archiwum nie ma
# ani jednej dluzszej przerwy, wiec test cofania do poprzedniego dnia publikacji
# przechodzil na samych weekendach i nie sprawdzal ukladu swiatecznego.
DNI_BEZ_TABELI = {
    2025: frozenset(
        {
            date(2025, 1, 1),   # Nowy Rok
            date(2025, 1, 6),   # Trzech Kroli
            date(2025, 4, 21),  # poniedzialek wielkanocny
            date(2025, 5, 1),   # Swieto Pracy
            date(2025, 6, 19),  # Boze Cialo
            date(2025, 8, 15),  # Wniebowziecie
            date(2025, 11, 11), # Swieto Niepodleglosci
            date(2025, 12, 24), # Wigilia - NBP nie publikuje
            date(2025, 12, 25),
            date(2025, 12, 26),
        }
    ),
    2026: frozenset(
        {
            date(2026, 1, 1),
            date(2026, 1, 6),
            date(2026, 4, 6),   # poniedzialek wielkanocny
            date(2026, 5, 1),
            date(2026, 6, 4),   # Boze Cialo
            date(2026, 11, 11),
            date(2026, 12, 24),
            date(2026, 12, 25),
        }
    ),
}


def build_nbp_archive(year: int) -> bytes:
    """Archiwum kursow w ukladzie i kodowaniu tabeli A."""
    rows = [NBP_HEADER, NBP_DESCRIPTION]
    day = date(year, 1, 1)
    end = date(year, 12, 31)
    usd, eur = 4.0000, 4.3000
    while day <= end:
        if day.weekday() < 5 and day not in DNI_BEZ_TABELI.get(year, frozenset()):
            numer = f"{len(rows) - 1:03d}/A/NBP/{year}"
            rows.append(f"{day:%Y%m%d};{numer};{numer};{usd:.4f};{eur:.4f};".replace(".", ","))
            usd += 0.0007
            eur += 0.0005
        day += timedelta(days=1)
    return ("\n".join(rows) + "\n").encode("cp1250")


def build_tariff_pdf(path: Path) -> None:
    """Taryfa oplat brokera w minimalnym, poprawnym PDF.

    Silnik odczytuje z niej dzienna stawke za ujemne saldo i porownuje ja z
    naliczeniami brokera (kontrola spojnosci, nie zrodlo kwoty podatku). Bez
    taryfy w zestawie syntetycznym ta sciezka - razem z indeksem dowodow - nie
    wykonywala sie nigdzie poza komputerem wlasciciela.

    PDF powstaje wprost z bajtow, zeby zestaw testowy nie potrzebowal
    biblioteki do zapisu; pypdf sluzy w projekcie wylacznie do odczytu.
    """
    nowa_linia = chr(10)
    linie = [
        "Tariffs and fees (test fixture)",
        "Margin rate (per day) 0.041095% 0.049315%",
        "Account maintenance fee 0.00%",
    ]
    tekst = "BT /F1 12 Tf 40 750 Td 16 TL" + nowa_linia
    tekst += "".join(f"({linia}) Tj T*" + nowa_linia for linia in linie)
    tekst += "ET"
    strumien = tekst.encode("latin-1")

    obiekty = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
        b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(strumien)).encode("ascii") + b" >>" + nowa_linia.encode()
        + b"stream" + nowa_linia.encode() + strumien + nowa_linia.encode() + b"endstream",
    ]

    out = bytearray(b"%PDF-1.4" + nowa_linia.encode())
    offsety = []
    for numer, obiekt in enumerate(obiekty, start=1):
        offsety.append(len(out))
        out += f"{numer} 0 obj{nowa_linia}".encode("ascii") + obiekt + f"{nowa_linia}endobj{nowa_linia}".encode("ascii")

    start_xref = len(out)
    out += f"xref{nowa_linia}0 {len(obiekty) + 1}{nowa_linia}".encode("ascii")
    out += f"0000000000 65535 f {nowa_linia}".encode("ascii")
    for offset in offsety:
        out += f"{offset:010d} 00000 n {nowa_linia}".encode("ascii")
    out += (
        f"trailer{nowa_linia}<< /Size {len(obiekty) + 1} /Root 1 0 R >>{nowa_linia}"
        f"startxref{nowa_linia}{start_xref}{nowa_linia}%%EOF{nowa_linia}"
    ).encode("ascii")
    path.write_bytes(bytes(out))


def build_workbook(path: Path, headers: list[str], rows: list[list]) -> None:
    import openpyxl

    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.title = "sheet1"
    sheet.append(headers)
    for row in rows:
        sheet.append(row)
    workbook.save(path)
    workbook.close()


def build_trade_workbooks() -> None:
    headers = ["trade_id", "date", "instr_nm", "operation", "p", "q", "summ", "curr_c", "commission", "commission_currency"]
    rows = [
        [trade_id, moment, symbol, operation, price, qty, round(price * qty, 2), "USD", commission, "USD"]
        for trade_id, moment, symbol, operation, price, qty, commission in TRADES
    ]
    build_workbook(TARGET / "wyciag-v1.xlsx", headers, rows)
    build_workbook(TARGET / "wyciag-stary.xlsx", headers, rows)
    build_workbook(
        TARGET / "tabela-brokera.xlsx",
        ["date", "type", "amount", "currency", "comment"],
        [
            ["2025-08-04", "Odsetki", -4.11, "USD", "Fee for negative cash balance USD, fee rate as a percentage: 0.041095"],
            ["2025-10-20", "Dywidenda", 12.00, "USD", f"Dividend for {BUY_SYMBOL}"],
        ],
    )


def main() -> int:
    TARGET.mkdir(parents=True, exist_ok=True)

    (TARGET / "api-zrzut.json").write_text(
        json.dumps(build_api_dump(), ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (TARGET / "historia-brokera.json").write_text(
        json.dumps(build_history_list(), ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (TARGET / "raport-brokera.json").write_text(
        json.dumps(build_broker_report(), ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (TARGET / "kontrola-pozycji.json").write_text(
        json.dumps(build_depositary_report(), ensure_ascii=False, indent=2), encoding="utf-8"
    )
    # Nazwa jak w archiwum NBP: po niej silnik rozpoznaje plik jako tabele A
    # (source_resolver: "archiwum_tab_a" -> rola nbp_rates). Pod nazwa
    # "kursy-2025.csv" kontrola pokrycia kursow nie widziala zadnego zrodla.
    (TARGET / "archiwum_tab_a_2025.csv").write_bytes(build_nbp_archive(2025))
    (TARGET / "archiwum_tab_a_2026.csv").write_bytes(build_nbp_archive(2026))
    # Nazwa pasuje do globa silnika ([Ss]tawki*.pdf), wiec taryfa jest
    # rozpoznawana, a jednoczesnie nie powiela nazwy prawdziwego pliku
    # uzytkownika - bramka danych osobowych slusznie by ja odrzucila.
    build_tariff_pdf(TARGET / "Stawki-przykladowe.pdf")
    build_trade_workbooks()

    written = sorted(item.name for item in TARGET.iterdir() if item.is_file())
    print(f"Zapisano {len(written)} plikow w {TARGET.relative_to(ROOT)}:")
    for name in written:
        print(f"  {name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
