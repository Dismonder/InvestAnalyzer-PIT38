from __future__ import annotations

import hashlib
import json
import numbers
import re
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any, Iterable

import pandas as pd

from ..models.core import CanonicalTrade
from .classify import (
    clean_text,
    infer_acquisition_mode,
    infer_country,
    infer_instrument_class,
    infer_logical_world_for_trade,
)


SOURCE_PRIORITIES = {
    "CANONICAL_TAX_INPUT_TRADE": 120,
    "CANONICAL_TAX_INPUT_EVENT": 115,
    "API_JSON_FULL": 110,
    "TRADES_V1": 100,
    "TRADERNET_TABLE": 90,
    "BROKER_REPORT_JSON": 85,
    "BROKER_JSON": 70,
    "BROKER_XML": 60,
    "TRADES_LEGACY": 40,
}


def is_missing(val: Any) -> bool:
    if val is None or val == "":
        return True
    try:
        if pd.isna(val):
            return True
    except TypeError:
        pass
    return str(val).strip().lower() in {"nan", "null", "none"}


# Separator tysiecy pisany spacja - zwykla, nierozdzielajaca i waska. Polskie
# arkusze uzywaja nierozdzielajacej, wiec musi byc obsluzona jawnie.
_THOUSANDS_SPACES = (" ", " ", " ", " ")

# "1,234" - przecinek i dokladnie trzy cyfry. Zapis jest niejednoznaczny: po
# angielsku to tysiac dwiescie trzydziesci cztery, po polsku jeden i 234
# tysieczne. Rozstrzygamy na korzysc tysiecy, bo w tych wyciagach przecinek nie
# wystepuje w roli separatora dziesietnego ani razu - liczby sa zapisane po
# angielsku ("100.12", "0.041095"), a polskie arkusze uzywaja spacji
# nierozdzielajacej razem z przecinkiem ("1 234,56"), co rozpoznajemy osobno.
#
# Reguly nie stosujemy do kropki: "1.234" zostaje liczba 1,234, bo kropka jest
# tu normalnym separatorem dziesietnym i kursy maja po kilka miejsc po kropce.
# Grupa tysiecy nie zaczyna sie od zera: "0,125" to 0.125, nie 125.
_AMBIGUOUS_GROUP = re.compile(r"^[+-]?[1-9]\d{0,2},\d{3}$")

# Kwota zapisana z minusem na koncu - format eksportow ksiegowych.
_TRAILING_MINUS = re.compile(r"^(.*\d)\s*-$")
_UNICODE_MINUS = re.compile(r"(^|[\s(])([\u2212\u2012\u2013\ufe63\uff0d])(?=\s*\d)")


def normalize_numeric_sign(text: str) -> str:
    """Normalizuje typograficzny minus tylko wtedy, gdy rozpoczyna liczbę."""
    return _UNICODE_MINUS.sub(r"\1-", text)


def is_ambiguous_thousands_group(text: str) -> bool:
    """Czy zapis to "1,234" - jednakowo poprawny jako 1234 i jako 1,234.

    Dotyczy wylacznie przecinka; kropka z trzema cyframi to zwykla liczba
    dziesietna, bo tak zapisane sa kursy i ceny w tych wyciagach.
    """
    return bool(_AMBIGUOUS_GROUP.match(str(text).strip()))


def parse_amount(val: Any) -> Decimal | None:
    """Kwota z wyciagu brokera, albo None gdy nie da sie jej odczytac.

    Wyciagi podaja liczby w wielu zapisach naraz: "1 234.56", "1 234,56"
    (spacja nierozdzielajaca jest standardem w polskim XLSX), "1,234.56",
    "1.234,56", "1234.56 USD", "(123.45)" i "123.45-" dla wartosci ujemnych.
    Kazdy z nich musi dac te sama liczbe.

    Wczesniej wszystkie te formaty zwracaly zero, bo Decimal odrzucal je jako
    nieprawidlowe, a wyjatek byl polykany. Zakup z wyzerowana cena wchodzil do
    FIFO z zerowa podstawa kosztowa i cala pozniejsza sprzedaz stawala sie
    dochodem - bez zadnego zgloszenia.

    Czego celowo NIE przyjmujemy: procentow ("5%") i wartosci bez cyfr. Procent
    nie jest kwota, a wczesniejsza wersja gubila znak procentu i zwracala 5,
    czyli liczbe sto razy wieksza niz opisywana wielkosc.
    """
    if is_missing(val):
        return None
    if isinstance(val, Decimal):
        return val
    if isinstance(val, bool):
        return None
    if isinstance(val, int):
        return Decimal(val)
    if isinstance(val, float):
        # Liczba z arkusza jest juz liczba - zapis tekstowy ("1e-05") tylko
        # psulby ja przy ponownym parsowaniu.
        return Decimal(str(val))

    text = str(val).strip()
    if not text:
        return None
    text = normalize_numeric_sign(text)

    # Procent to nie kwota. Milczace obciecie znaku dawalo liczbe sto razy wieksza.
    if "%" in text:
        return None

    negative = False
    # Zapis ksiegowy: kwota w nawiasie oznacza wartosc ujemna.
    if text.startswith("(") and text.endswith(")"):
        negative = True
        text = text[1:-1].strip()
    # Minus na koncu - format eksportow ksiegowych i niemieckich.
    trailing = _TRAILING_MINUS.match(text)
    if trailing:
        negative = True
        text = trailing.group(1).strip()

    for space in _THOUSANDS_SPACES:
        text = text.replace(space, "")

    # Notacja wykladnicza z arkusza: zostawiamy ja Decimalowi w calosci.
    exponent = ""
    scientific = re.match(r"^([+-]?[\d.,]+)[eE]([+-]?\d+)$", text)
    if scientific:
        text, exponent = scientific.group(1), "E" + scientific.group(2)

    # Odrzucamy oznaczenie waluty i inne znaki opisowe.
    text = re.sub(r"[^0-9,.+-]", "", text)
    if not any(char.isdigit() for char in text):
        return None

    commas = text.count(",")
    dots = text.count(".")

    if commas and dots:
        # Separatorem dziesietnym jest ten, ktory stoi blizej konca.
        if text.rfind(",") > text.rfind("."):
            text = text.replace(".", "").replace(",", ".")
        else:
            text = text.replace(",", "")
    elif commas > 1:
        # Kilka przecinkow to zawsze separatory tysiecy: "1,234,567".
        text = text.replace(",", "")
    elif dots > 1:
        text = text.replace(".", "")
    elif commas == 1:
        # Jeden przecinek: grupa trzech cyfr to tysiace, reszta to czesc dziesietna.
        text = text.replace(",", "") if is_ambiguous_thousands_group(text) else text.replace(",", ".")

    if text in {"", "+", "-", ".", "+.", "-."}:
        return None

    try:
        parsed = Decimal(text + exponent)
    except (ArithmeticError, ValueError, TypeError):
        return None
    return -parsed if negative else parsed


def to_decimal(val: Any, default: Decimal = Decimal("0")) -> Decimal:
    parsed = parse_amount(val)
    return default if parsed is None else parsed


# Gorna granica wiarygodnej kwoty. Powyzej tego rzedu wartosc nie pochodzi
# z wyciagu maklerskiego, tylko z uszkodzonego pola, a arytmetyka dziesietna
# zaczyna na niej zwracac bledy zamiast liczb.
MAKSYMALNA_WIARYGODNA_KWOTA = Decimal("1e13")


def kwota_wiarygodna(wartosc: Decimal | None) -> bool:
    if wartosc is None:
        return False
    try:
        return wartosc.is_finite() and abs(wartosc) < MAKSYMALNA_WIARYGODNA_KWOTA
    except (InvalidOperation, TypeError):
        return False


def bez_strefy_czasowej(ts: pd.Timestamp) -> pd.Timestamp:
    """Zdejmuje strefe czasowa, zachowujac godzine zapisana przez brokera.

    Wyciagi potrafia podawac daty w pelnym formacie ISO ze strefa
    ("2024-02-05T10:00:00Z"). Taka wartosc przechodzila przez caly silnik
    i wywracala go dopiero przy zapisie arkusza kontrolnego:
    "Excel does not support datetimes with timezones" - przebieg konczyl sie
    bez wyniku, a uzytkownik nie dostawal zadnego rozliczenia.

    Swiadomie NIE przeliczamy na czas uniwersalny: data z wyciagu ma trafic do
    deklaracji taka, jaka wykazal broker. Przeliczenie strefy potrafiloby
    przesunac transakcje na sasiedni dzien, a razem z nia kurs NBP.
    """
    if ts.tzinfo is None and getattr(ts, "tz", None) is None:
        return ts
    return ts.tz_localize(None)


# Data zapisana po europejsku: dzien, miesiac, rok, rozdzielone kropka,
# myslnikiem albo ukosnikiem. Nikt nie zapisuje tak miesiaca przed dniem,
# a domyslny parser czytal "05.02.2024" jako 2 maja zamiast 5 lutego - i bral
# kurs NBP z innego dnia, czasem nawet z innego roku podatkowego.
#
# Ukosnik dopisany, bo import CSV w przegladarce czyta "01/02/2024" jako
# 1 lutego (odczytCsv.dataZPola), a pandas czytal to samo jako 2 stycznia -
# ta sama data dawala w dwoch sciezkach aplikacji dwa rozne dni i dwa rozne
# kursy NBP.
_DATA_DZIEN_PIERWSZY = re.compile(r"^\s*\d{1,2}[./\-]\d{1,2}[./\-]\d{4}")
_LICZBOWA_DATA = re.compile(r"^\d+(?:\.\d+)?$")

# Tylko zapis z ukosnikiem bywa amerykanski (MM/DD/RRRR). Kropka i myslnik
# zawsze oznaczaja dzien przed miesiacem.
_DATA_Z_UKOSNIKIEM = re.compile(r"^\s*(\d{1,2})/(\d{1,2})/(\d{4})(?!\d)")

KOLEJNOSC_DZIEN_PIERWSZY = "DMY"
KOLEJNOSC_MIESIAC_PIERWSZY = "MDY"


def ustal_kolejnosc_dat(wartosci: Iterable[Any]) -> str | None:
    """Kolejnosc DD/MM ("DMY") albo MM/DD ("MDY") dla calego pliku lub kolumny.

    Data z ukosnikiem jest niejednoznaczna: "03/04/2025" to 3 kwietnia albo
    4 marca. Pandas rozstrzygal to osobno dla kazdej daty (przelaczal sie na
    miesiac-dzien przy "12/31/2025"), wiec w pliku amerykanskim "03/04/2025"
    dawalo 3 kwietnia, a "12/31/2025" 31 grudnia - dwie reguly w jednym pliku,
    czyli inny dzien i inny kurs NBP.

    Kolejnosc wynika z tego, ze ktorakolwiek data w pliku ma czesc wieksza niz
    12: pierwsza -> DD/MM, druga -> MM/DD. Sprzeczne dowody to blad odczytu dat
    (ValueError), a brak dowodu zwraca None - wtedy obowiazuje europejski
    DD/MM. Daty ISO, z kropka, myslnikiem i liczbowe nie biora udzialu.
    """
    przyklad_dmy: str | None = None
    przyklad_mdy: str | None = None
    for wartosc in wartosci:
        if not isinstance(wartosc, str):
            continue
        dopasowanie = _DATA_Z_UKOSNIKIEM.match(wartosc)
        if dopasowanie is None:
            continue
        pierwsza, druga = int(dopasowanie.group(1)), int(dopasowanie.group(2))
        # Data, ktorej zadna kolejnosc nie czyta, nie jest dowodem na nic.
        if pierwsza > 31 or druga > 31 or (pierwsza > 12 and druga > 12):
            continue
        if pierwsza > 12 and przyklad_dmy is None:
            przyklad_dmy = wartosc.strip()
        elif druga > 12 and przyklad_mdy is None:
            przyklad_mdy = wartosc.strip()
    if przyklad_dmy and przyklad_mdy:
        raise ValueError(
            "Nie da się jednoznacznie odczytać dat z ukośnikiem: "
            f"'{przyklad_dmy}' wskazuje kolejność DD/MM, a '{przyklad_mdy}' kolejność MM/DD. "
            "Ujednolić zapis dat w pliku źródłowym (najlepiej RRRR-MM-DD)."
        )
    if przyklad_dmy:
        return KOLEJNOSC_DZIEN_PIERWSZY
    if przyklad_mdy:
        return KOLEJNOSC_MIESIAC_PIERWSZY
    return None


def _numeric_timestamp(value: Any) -> pd.Timestamp | None:
    """Konwertuje rozpoznane formaty liczbowe dat; inne liczby odrzuca."""
    if isinstance(value, bool):
        return None
    if isinstance(value, numbers.Real):
        if not pd.notna(value):
            return None
        number = str(value)
    elif isinstance(value, str) and _LICZBOWA_DATA.fullmatch(value.strip()):
        number = value.strip()
    else:
        return None

    try:
        numeric = Decimal(number)
        integral = number.partition(".")[0]
        has_zero_fraction = "." not in number or numeric == numeric.to_integral_value()
        if has_zero_fraction and len(integral) == 8:
            return pd.Timestamp(datetime.strptime(integral, "%Y%m%d"))
        if has_zero_fraction and len(integral) == 10:
            return pd.Timestamp("1970-01-01") + pd.Timedelta(seconds=int(integral))
        if has_zero_fraction and len(integral) == 13:
            return pd.Timestamp("1970-01-01") + pd.Timedelta(milliseconds=int(integral))

        excel_epoch = datetime(1899, 12, 30)
        earliest = Decimal((datetime(1990, 1, 1) - excel_epoch).days)
        latest = Decimal((datetime(2101, 1, 1) - excel_epoch).days)
        if earliest <= numeric < latest:
            whole_days = int(numeric)
            fraction = numeric - whole_days
            seconds = int(fraction * Decimal(86400))
            micros = int((fraction * Decimal(86400) - seconds) * Decimal(1_000_000))
            return pd.Timestamp(excel_epoch + timedelta(days=whole_days, seconds=seconds, microseconds=micros))
    except (ArithmeticError, TypeError, ValueError, OverflowError):
        return None
    return None


def to_timestamp(val: Any, kolejnosc: str | None = None) -> pd.Timestamp | None:
    """Data z wyciagu. `kolejnosc` ("DMY"/"MDY") dotyczy tylko zapisu z ukosnikiem
    i pochodzi z ustal_kolejnosc_dat dla calego pliku; bez niej DD/MM."""
    if is_missing(val):
        return None
    try:
        numeric = _numeric_timestamp(val)
        if numeric is not None:
            return bez_strefy_czasowej(numeric)
        if isinstance(val, numbers.Real) or (
            isinstance(val, str) and _LICZBOWA_DATA.fullmatch(val.strip())
        ):
            return None
        if isinstance(val, str) and _DATA_DZIEN_PIERWSZY.match(val):
            miesiac_pierwszy = (
                kolejnosc == KOLEJNOSC_MIESIAC_PIERWSZY and _DATA_Z_UKOSNIKIEM.match(val) is not None
            )
            ts = pd.Timestamp(pd.to_datetime(val, dayfirst=not miesiac_pierwszy))
        else:
            ts = pd.Timestamp(val)
        if pd.isna(ts):
            return None
        return bez_strefy_czasowej(ts)
    except (TypeError, ValueError):
        return None


def get_val(raw_row: dict[str, Any], keys: list[str], default: Any = None) -> Any:
    for key in keys:
        if key in raw_row and not is_missing(raw_row[key]):
            return raw_row[key]
    return default


# Raport depozytariusza zastepuje wartosci pol scalonych pozycji literalem
# agregacji. Taka wartosc jest obecna, ale nic nie identyfikuje ani nie datuje,
# wiec nie moze byc traktowana jak dana.
AGGREGATION_MARKERS = frozenset({"zgrupowano", "grouped", "agregat", "aggregated"})


def is_aggregation_marker(value: Any) -> bool:
    return clean_text(value).strip().lower() in AGGREGATION_MARKERS


def first_timestamp(
    raw_row: dict[str, Any], keys: list[str], kolejnosc: str | None = None
) -> pd.Timestamp | None:
    """Pierwsza wartosc z listy pol, ktora faktycznie daje sie odczytac jako data.

    get_val zatrzymuje sie na pierwszym obecnym polu. Gdy broker wpisze w pole
    date literal agregacji, a prawdziwa date zostawi w short_date, zatrzymanie
    sie na pierwszym polu gubi date transakcji - a bez daty nie ma kursu NBP.
    """
    for key in keys:
        if key not in raw_row or is_missing(raw_row[key]):
            continue
        timestamp = to_timestamp(raw_row[key], kolejnosc)
        if timestamp is not None:
            return timestamp
    return None


def determine_trade_currency(raw_row: dict[str, Any], symbol: str) -> tuple[str, str]:
    explicit_currency = clean_text(get_val(raw_row, ["curr_c", "Currency", "Waluta", "waluta", "currency", "curr"], ""))
    if explicit_currency:
        return explicit_currency.upper(), "CERTAIN"

    normalized_symbol = clean_text(symbol).upper()
    if "/" in normalized_symbol:
        parts = [part for part in normalized_symbol.split("/") if part]
        if len(parts) >= 2:
            return parts[-1], "CONDITIONAL"
        return "USD", "CONDITIONAL"
    if normalized_symbol.endswith(".US") or normalized_symbol.startswith("DGT"):
        return "USD", "CONDITIONAL"
    return "UNKNOWN", "REVIEW_REQUIRED"


DATE_KEYS = (
    "date", "short_date", "Data", "executed_at", "exchange_time", "settlement_date",
    "trade_d_exch", "trade_d_exch ", "Execution Date", "pay_d", "Obliczenia", "T2_confirm",
)

# Zrodlo kwoty prowizji transakcji. Kolumny "Prowizja" i "fee_amount" czyta
# magazyn (storage) jako osobne wiersze prowizji, wiec ich kwota tu NIE wchodzi
# (podwojny koszt) - sprawdzamy w nich tylko, czy wpis da sie odczytac.
COMMISSION_KEYS = ["commission", "Opłata", "Fee", "Commission"]
COMMISSION_CHECK_KEYS = [*COMMISSION_KEYS, "Prowizja", "fee_amount"]

# Zapis "brak prowizji" spotykany w arkuszach - to nie jest nieczytelna kwota.
_PUSTA_PROWIZJA = frozenset({"-", "–", "—", "n/a", "n/d", "brak"})


def _prowizja_strukturalna(wartosc: Any) -> bool:
    """Slownik, lista albo tekst wygladajacy na JSON - to nie kwota, ale tez nie blad odczytu."""
    if isinstance(wartosc, (dict, list, tuple, set)):
        return True
    return isinstance(wartosc, str) and wartosc.strip()[:1] in {"{", "["}


def ocena_prowizji(raw_row: dict[str, Any]) -> tuple[tuple[str, Any] | None, bool]:
    """(blad, warunkowa) dla pol prowizji wiersza.

    blad = (pole, wartosc), gdy prowizja jest wpisana, ale nie da sie jej odczytac
    jako kwoty. Brak pola, puste pole i jawne zero to zero prowizji. Wartosc
    niepusta, ktorej parse_amount nie odczyta ("bad") albo spoza zakresu
    rozsadku, dawala dotad prowizje 0 i wiersz CERTAIN - koszt zanizony bez
    sygnalu.

    warunkowa = literal agregacji ("Zgrupowano") albo struktura w polu prowizji:
    prowizja liczona jako brak, ale wiersz idzie do przegladu bez blokady.
    """
    blad: tuple[str, Any] | None = None
    warunkowa = False
    for klucz in COMMISSION_CHECK_KEYS:
        if klucz not in raw_row:
            continue
        wartosc = raw_row[klucz]
        if _prowizja_strukturalna(wartosc):
            warunkowa = True
            continue
        if is_missing(wartosc):
            continue
        if isinstance(wartosc, str) and wartosc.strip().lower() in _PUSTA_PROWIZJA | {""}:
            continue
        if is_aggregation_marker(wartosc):
            warunkowa = True
            continue
        if blad is None and not kwota_wiarygodna(parse_amount(wartosc)):
            blad = (klucz, wartosc)
    return blad, warunkowa


OPERATION_KEYS = (
    "operation", "Operation", "operation_type", "operationType", "oper",
    "side", "Side", "type", "Type", "Typ", "Rodzaj zlecenia",
)


def operation_code(raw_row: dict[str, Any]) -> str:
    """Surowy kod operacji z pól używanych przez parsery brokerów."""
    return clean_text(get_val(raw_row, list(OPERATION_KEYS), ""))


def operation_review_kind(code: str | None) -> str:
    """Rodzaj ręcznego rozstrzygnięcia dla operacji spoza kupna/sprzedaży."""
    normalized = clean_text(code).lower().replace("_", " ").replace("-", " ")
    if "reverse split" in normalized or ("odwrotn" in normalized and "split" in normalized):
        return "reverse_split"
    if "split" in normalized or "podział" in normalized or "podzial" in normalized:
        return "split"
    if "transfer" in normalized or "przenies" in normalized or "przelew" in normalized:
        return "transfer"
    return "unrecognized"


def determine_side(raw_row: dict[str, Any]) -> tuple[str, bool]:
    """Zwraca BUY/SELL tylko dla jawnie rozpoznanych kodów operacji."""
    recognized: set[str] = set()
    for key in OPERATION_KEYS:
        if key not in raw_row or is_missing(raw_row[key]):
            continue
        normalized = clean_text(raw_row[key]).lower()
        if normalized in {"2", "sell", "s", "sprzedaż", "sprzedaz"} or "sprzeda" in normalized or "sell" in normalized:
            recognized.add("SELL")
        # Wykup nie tworzy partii nabycia FIFO - wiersz z wykupem idzie do przeglądu,
        # nawet gdy inne pole podaje stronę.
        elif "wykup" in normalized:
            return "UNKNOWN", False
        elif (
            normalized in {"1", "buy", "b", "kupno", "zakup", "purchase"}
            or "kup" in normalized or "zakup" in normalized
            or "buy" in normalized or "purchase" in normalized
        ):
            recognized.add("BUY")
    return (next(iter(recognized)), True) if len(recognized) == 1 else ("UNKNOWN", False)


def build_trade_id(raw_row: dict[str, Any], source_name: str) -> str:
    existing = clean_text(get_val(raw_row, ["id", "trade_id", "Numer", "number", "source_record_id"], ""))
    # Literal agregacji powtarza sie w kazdym scalonym wierszu, wiec przyjety
    # jako identyfikator sklejalby wszystkie te transakcje w jedna. Zamiast tego
    # schodzimy do skrotu z tresci wiersza, ktory rozroznia je co do sztuki.
    if existing and is_aggregation_marker(existing):
        existing = ""
    if existing:
        return existing

    row_str = json.dumps(raw_row, sort_keys=True, default=str)
    digest = hashlib.md5(row_str.encode("utf-8")).hexdigest()[:12]
    return f"{source_name}-{digest}"


def tolerancja_kwoty_transakcji(quantity: Decimal) -> Decimal:
    """Dopuszczalna roznica miedzy kwota brokera a ilosc x cena.

    Pol centa (grosza) na sztuke, ale nie mniej niz 0,01 - tyle moze wniesc
    zaokraglenie ceny do najmniejszej jednostki waluty. Regula nie zalezy od zapisu
    ceny: krok liczony z wykladnika Decimal dawal dla ceny 100 (int z JSON) tolerancje
    ilosc/2, a dla 100.0 - ilosc/20, czyli wynik zalezal od formatowania liczby.
    """
    return max(quantity * Decimal("0.005"), Decimal("0.01"))


def normalize_api_trade(
    raw_row: dict[str, Any],
    source_name: str = "API_JSON_FULL",
    source_file: str = "",
    source_sheet: str = "",
    kolejnosc_dat: str | None = None,
) -> CanonicalTrade:
    symbol = clean_text(get_val(raw_row, ["instr_nm", "Tickery", "ticker", "Ticker", "Symbol"], "UNKNOWN"))
    trade_id = build_trade_id(raw_row, source_name)
    order_id = clean_text(get_val(raw_row, ["order_id", "Order ID"], "")) or None
    trade_number = clean_text(get_val(raw_row, ["trade_nb", "Trade Number"], "")) or None
    instrument_type_code = clean_text(get_val(raw_row, ["instr_type_c", "Instrument Class"], "")) or None
    otc = clean_text(get_val(raw_row, ["otc", "OTC"], "0")) == "1"
    repo_close_raw = get_val(raw_row, ["repo_close"], None)
    repo_close = None if is_missing(repo_close_raw) else clean_text(repo_close_raw) == "1"
    base_contract_code = clean_text(get_val(raw_row, ["base_contract_code", "Base Contract"], "")) or None
    instrument_class = infer_instrument_class(symbol, instrument_type_code, otc, repo_close, base_contract_code)
    trade_currency, certainty_status = determine_trade_currency(raw_row, symbol)
    logical_world = infer_logical_world_for_trade(instrument_class)
    side, strona_pewna = determine_side(raw_row)

    # Kolejnosc DD/MM vs MM/DD ustala wywolujacy dla calego pliku. Bez niej
    # bierzemy ja z dat tego wiersza (sprzecznosc w wierszu to blad), a bez
    # dowodu - europejskie DD/MM.
    if kolejnosc_dat is None:
        kolejnosc_dat = clean_text(get_val(raw_row, ["kolejnosc_dat_pliku"], "")).upper() or None
    if kolejnosc_dat is None:
        kolejnosc_dat = ustal_kolejnosc_dat(
            raw_row[klucz]
            for klucz in DATE_KEYS
            if klucz in raw_row and not is_missing(raw_row[klucz])
        )

    executed_at = first_timestamp(
        raw_row, ["date", "short_date", "Data", "executed_at", "exchange_time", "settlement_date"], kolejnosc_dat
    )
    exchange_time = first_timestamp(
        raw_row,
        ["trade_d_exch", "trade_d_exch ", "Execution Date", "Data", "exchange_time", "executed_at", "short_date"],
        kolejnosc_dat,
    )
    # Daty rozliczenia celowo nie zastepujemy data zawarcia: gdy broker jej nie
    # poda, brak jest informacja, a nie powodem do zgadywania.
    settlement_date = first_timestamp(raw_row, ["pay_d", "Obliczenia", "settlement_date"], kolejnosc_dat)
    confirm_time = to_timestamp(get_val(raw_row, ["T2_confirm"]), kolejnosc_dat)

    quantity = to_decimal(get_val(raw_row, ["q", "Quantity", "quantity"]))
    price = parse_amount(get_val(raw_row, ["p", "Cena", "price"]))
    amount_keys = ["gross_amount", "v", "summ", "Kwota", "Gross Amount", "Value", "value", "Amount", "sum"]
    amount_key = next((key for key in amount_keys if key in raw_row and not is_missing(raw_row[key])), None)
    gross_amount = parse_amount(raw_row[amount_key]) if amount_key else None
    commission_raw = None
    for klucz_prowizji in COMMISSION_KEYS:
        if klucz_prowizji in raw_row:
            if _prowizja_strukturalna(raw_row[klucz_prowizji]):
                break
            if not is_missing(raw_row[klucz_prowizji]):
                commission_raw = raw_row[klucz_prowizji]
                break
    commission = to_decimal(commission_raw)
    # Nieczytelna prowizja to wyjatek jak brak ceny i kwoty: silnik zglasza
    # NORMALIZE_ERROR (blokuje gotowosc) zamiast wpuscic wiersz z prowizja 0.
    nieczytelna, prowizja_warunkowa = ocena_prowizji(raw_row)
    if nieczytelna is not None:
        pole, wartosc = nieczytelna
        raise ValueError(
            f"Nie da się odczytać prowizji transakcji {trade_id}: pole '{pole}' ma wartość '{wartosc}'. "
            "Popraw prowizję w pliku źródłowym albo w Historii transakcji."
        )

    # Kwoty spoza zakresu rozsadku traktujemy jak nieczytelne. Liczba w rodzaju
    # 1e308 przechodzila dalej i wywracala arytmetyke dziesietna, a blad byl
    # potem maskowany komunikatem o braku kursu NBP.
    if not kwota_wiarygodna(gross_amount):
        gross_amount = None
    if not kwota_wiarygodna(price):
        price = None
    if not kwota_wiarygodna(quantity):
        quantity = Decimal("0")
    if not kwota_wiarygodna(commission):
        commission = Decimal("0")

    # GRANT i akcje korporacyjne maja osobna sciezke zdarzen. Zwykle BUY/SELL
    # bez ceny i kwoty nie moga wejsc do FIFO jako transakcja za zero.
    if side in {"BUY", "SELL"} and quantity > 0 and price is None and gross_amount is None:
        raise ValueError(f"BUY/SELL {trade_id} has neither price nor gross amount")
    price = Decimal("0") if price is None else price
    gross_amount = Decimal("0") if gross_amount is None else gross_amount

    # Kwota brutto nieczytelna albo nieobecna. Bez tego odtworzenia koszt
    # nabycia spadal do samej prowizji: transakcja za 1500 USD wchodzila do
    # rozliczenia jako 3,96 zl kosztu i nic tego nie sygnalizowalo.
    gross_amount_odtworzona = False
    if gross_amount == 0 and quantity > 0 and price > 0:
        gross_amount = quantity * price
        gross_amount_odtworzona = True
    commission_currency = clean_text(get_val(raw_row, ["commission_currency", "Commission Currency"], trade_currency)) or trade_currency
    expected_gross = quantity * price
    tolerance = tolerancja_kwoty_transakcji(quantity)
    amount_mismatch = None
    if (instrument_class == "EQUITY" and side in {"BUY", "SELL"} and not gross_amount_odtworzona
            and quantity > 0 and price > 0 and gross_amount > 0):
        difference = gross_amount - expected_gross
        net_adjustment = commission if side == "SELL" else -commission
        if (difference != 0 and amount_key in {"value", "Value", "Amount", "Kwota", "sum", "summ"}
                and commission > 0 and commission_currency.upper() == trade_currency.upper()
                and abs(difference + net_adjustment) <= tolerance):
            gross_amount += net_adjustment
        elif abs(difference) > tolerance:
            amount_mismatch = {
                "source_field": amount_key,
                "reported_amount": str(gross_amount),
                "quantity_times_price": str(expected_gross),
                "commission": str(commission),
                "commission_currency": commission_currency,
                "currency": trade_currency,
            }
    kwota_rozbiezna = (
        amount_mismatch is not None
    )
    broker_profit_raw = get_val(raw_row, ["profit", "Zysk", "Profit"], None)
    broker_reported_profit = None if is_missing(broker_profit_raw) else to_decimal(broker_profit_raw)

    # Wiersz, ktorego kwoty nie da sie potwierdzic, idzie do przegladu zamiast
    # cicho wejsc do rozliczenia z zanizona podstawa.
    if gross_amount_odtworzona or kwota_rozbiezna or gross_amount < 0 or price < 0 or quantity < 0 or not strona_pewna or prowizja_warunkowa:
        certainty_status = "CONDITIONAL"

    acquisition_mode = infer_acquisition_mode(instrument_class)
    tax_cost_policy = "STANDARD"
    source_links = [
        {"field": "operation_code", "value": operation_code(raw_row)},
        {"field": "source_command", "value": clean_text(get_val(raw_row, ["source_command"], ""))},
        {"field": "source_subtype", "value": clean_text(get_val(raw_row, ["source_subtype"], ""))},
    ]
    source_manifest_id = clean_text(get_val(raw_row, ["source_manifest_id"], ""))
    if source_manifest_id:
        source_links.append({"source_manifest_id": source_manifest_id})
    conflict_count = clean_text(get_val(raw_row, ["conflict_count"], ""))
    if conflict_count:
        source_links.append({"conflict_count": conflict_count})

    trade = CanonicalTrade(
        trade_id=trade_id,
        order_id=order_id,
        trade_number=trade_number,
        symbol=symbol,
        isin=clean_text(get_val(raw_row, ["isin", "ISIN"], "")) or None,
        side=side,
        instrument_type_code=instrument_type_code,
        instrument_class=instrument_class,
        market_id=clean_text(get_val(raw_row, ["mkt_id", "Market ID"], "")) or None,
        quantity=quantity,
        price=price,
        gross_amount=gross_amount,
        trade_currency=trade_currency,
        commission=commission,
        commission_currency=commission_currency,
        broker_reported_profit=broker_reported_profit,
        executed_at=executed_at,
        exchange_time=exchange_time or executed_at,
        settlement_date=settlement_date,
        confirm_time=confirm_time,
        otc=otc,
        repo_close=repo_close,
        base_contract_code=base_contract_code,
        current_position_qty_after_trade=to_decimal(get_val(raw_row, ["curr_q", "Current Quantity"]), Decimal("0")),
        source_name=source_name,
        source_priority=SOURCE_PRIORITIES.get(source_name, 10),
        source_record_id=trade_id,
        account_id=clean_text(get_val(raw_row, ["account", "Rachunek"], "")) or None,
        source_file=source_file,
        source_sheet=source_sheet,
        source_row_id=trade_id,
        certainty_status=certainty_status,
        review_status="UNREVIEWED" if certainty_status != "CERTAIN" else "AUTO_REVIEWED",
        amount_mismatch=amount_mismatch,
        acquisition_mode=acquisition_mode,
        tax_cost_policy=tax_cost_policy,
        logical_world=logical_world,
        cost_bucket=("BUY_COMMISSION" if side == "BUY" else "SELL_COMMISSION") if side in {"BUY", "SELL"} else None,
        cost_class="CERTAIN",
        country=infer_country(symbol, clean_text(get_val(raw_row, ["isin", "ISIN"], "")) or None),
        original_amount=gross_amount,
        original_currency=trade_currency,
        original_event_date=exchange_time or executed_at or settlement_date,
        comment=clean_text(get_val(raw_row, ["comment", "Komentarz"], "")) or None,
        message=clean_text(get_val(raw_row, ["message", "Message", "Opis"], "")) or None,
        evidence_refs=[f"{source_name}:{trade_id}"],
        decision_trace_refs=[f"{source_name}:{trade_id}:normalized"],
        sources=[source_name],
        source_links=source_links,
    )
    return trade


def normalize_trade_row(
    raw_row: dict[str, Any],
    source_name: str,
    source_file: str = "",
    source_sheet: str = "",
    kolejnosc_dat: str | None = None,
) -> CanonicalTrade:
    return normalize_api_trade(
        raw_row=raw_row,
        source_name=source_name,
        source_file=source_file,
        source_sheet=source_sheet,
        kolejnosc_dat=kolejnosc_dat,
    )
