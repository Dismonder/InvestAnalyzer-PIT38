from __future__ import annotations

import re
from collections import defaultdict
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any

from investment_tax_engine.normalize.trades import determine_side, is_aggregation_marker, parse_amount
from investment_tax_engine.tax.fifo_engine import normalizuj_rachunek


CANONICAL_TAX_INPUT_SCHEMA = "canonical_tax_input.v2"
LEGACY_CANONICAL_TAX_INPUT_SCHEMA = "canonical_tax_input.v1"
CANONICAL_TAX_INPUT_TRADE_SOURCE = "CANONICAL_TAX_INPUT_TRADE"
CANONICAL_TAX_INPUT_EVENT_SOURCE = "CANONICAL_TAX_INPUT_EVENT"

# Zdarzenia, ktore nie sa transakcja, ale wchodza do rozliczenia: prowizje
# pomniejszaja dochod, odsetki od ujemnego salda sa kosztem finansowania,
# dywidendy i podatek u zrodla trafiaja do art. 30a, a zdarzenia korporacyjne
# oraz akcje przyznane niosa nabycie, bez ktorego pozniejsza sprzedaz nie ma
# podstawy kosztowej.
CONSUMABLE_SUPPORT_EVENT_KINDS: frozenset[str] = frozenset(
    {
        "commission",
        "interest",
        "dividend",
        # Podatek potracony u zrodla daje prawo do odliczenia od polskiego
        # podatku od dywidendy - bez niego pozycje 47 i 48 formularza pokazuja
        # pelne 19% mimo 15% juz zaplaconych za granica.
        "tax",
        "fx",
        "cash_movement",
        "corporate_action",
        "stock_award",
        "security_flow",
    }
)

# Zdarzenia wspierajace, ktore silnik przelicza na PIT-38 takze bez ani jednej
# transakcji: dywidenda (czesc G) i odsetki od ujemnego salda (koszt). Prowizja
# i podatek u zrodla bez transakcji albo dywidendy niczego nie licza.
CALCULATED_SUPPORT_EVENT_KINDS: frozenset[str] = frozenset({"dividend", "interest"})

# Swiadomie poza zakresem: position_snapshot i analytics to warstwa kontrolna
# i metryki, nbp_rate to kurs, a tariff_evidence to dowod taryfowy. Zadne z nich
# nie jest zdarzeniem podatkowym.

# Ten sam zestaw transakcji potrafi wystapic w kilku plikach naraz: pelny zrzut
# API, historia brokera, wyciag XLSX i raport depozytariusza opisuja te same
# zdarzenia. Bez rozstrzygniecia, ktore zrodlo jest wiodace, silnik policzylby
# jedna transakcje tyle razy, w ilu plikach sie pojawila.
#
# Kolejnosc odpowiada wiarygodnosci zapisu: pelny zrzut API niesie komplet pol
# transakcyjnych, raport depozytariusza jest warstwa kontrolna i scala pozycje,
# wiec ustepuje wszystkim zapisom pojedynczym.
PARSER_TRUST_ORDER = (
    "json",
    "legacy_broker_history_json",
    "broker_transactions_xlsx",
    "cash_flows_xlsx",
    "broker_report_json",
)
_PARSER_TRUST_RANK = {name: index for index, name in enumerate(PARSER_TRUST_ORDER)}
_UNKNOWN_PARSER_RANK = len(PARSER_TRUST_ORDER)


def _event_parser(event: dict[str, Any]) -> str:
    return str(_as_dict(event.get("source")).get("parser") or "")


def _parser_rank(event: dict[str, Any]) -> int:
    return _PARSER_TRUST_RANK.get(_event_parser(event), _UNKNOWN_PARSER_RANK)


_COMPOSITE_TRADE_ID = re.compile(r"^(\d+)\s*/\s*(\d+)$")


def _normalize_broker_id(value: str) -> str:
    """Sprowadza identyfikator do postaci porownywalnej miedzy plikami.

    Czesc raportow zapisuje identyfikator zlozony "<trade_id>/<order_id>",
    podczas gdy pozostale pliki niosa samo <trade_id>. Bez sprowadzenia obu
    postaci do wspolnej te same transakcje wygladalyby na rozne.
    """
    match = _COMPOSITE_TRADE_ID.match(value)
    return match.group(1) if match else value


def _broker_trade_key(event: dict[str, Any]) -> str | None:
    """Identyfikator transakcji nadany przez brokera, wspolny dla wszystkich plikow.

    Zwraca None, gdy zapis nie niesie wlasnego identyfikatora - takiego rekordu
    nie da sie bezpiecznie uznac za duplikat innego, wiec zostaje zachowany.
    """
    identity = _as_dict(event.get("identity"))
    for key in ("trade_id", "transaction_id", "trade_nb", "order_id"):
        value = identity.get(key)
        if value is None:
            continue
        text = str(value).strip()
        if text and text.lower() not in {"none", "nan"}:
            return f"{key}:{_normalize_broker_id(text)}"
    return None


def _rachunek_zdarzenia(event: dict[str, Any]) -> str | None:
    """Rachunek zapisu w postaci znormalizowanej tak samo jak w FIFO; None, gdy plik go nie niesie."""
    zrodla = (event, _as_dict(event.get("identity")), _raw_payload(event))
    for zrodlo in zrodla:
        for klucz in ("account_id", "account", "Rachunek"):
            wartosc = zrodlo.get(klucz)
            if wartosc is None or str(wartosc).strip().lower() in {"", "none", "nan"}:
                continue
            rachunek = normalizuj_rachunek(wartosc)
            if rachunek:
                return rachunek
    return None


CONFLICT_ACCOUNT_AMBIGUOUS = "OVERLAPPING_SOURCE_ACCOUNT_AMBIGUOUS"


class _KontekstRachunkow:
    """Ktore rachunki da sie rozroznic i ktore pary zapisow nie daja sie rozstrzygnac.

    Dwa rachunki uznajemy za rozne tylko wtedy, gdy wystepuja razem w co najmniej
    jednym pliku - tam jeden format identyfikatora obejmuje oba, wiec roznica jest
    prawdziwa. Ten sam rachunek bywa zapisany w dwoch formatach (numer i login,
    "U123" i "U123.TRD"); gdy kazdy rachunek jest tylko w swoim pliku, nie
    zgadujemy, czy to jeden rachunek, czy dwa.
    """

    def __init__(self, events: list[dict[str, Any]]) -> None:
        konta_pliku: dict[str, set[str]] = defaultdict(set)
        for event in events:
            konto = _rachunek_zdarzenia(event)
            if konto:
                konta_pliku[_plik_zdarzenia(event)].add(konto)
        self._wspolne: set[tuple[str, str]] = set()
        for konta in konta_pliku.values():
            for pierwsze in konta:
                for drugie in konta:
                    if pierwsze < drugie:
                        self._wspolne.add((pierwsze, drugie))
        self.konflikty: dict[tuple[str, ...], dict[str, Any]] = {}

    def rozroznialne(self, pierwsze: str, drugie: str) -> bool:
        return (min(pierwsze, drugie), max(pierwsze, drugie)) in self._wspolne

    def zglos(self, zapisy: list[dict[str, Any]]) -> None:
        """Rejestruje jeden konflikt na (walor, dzien, strona, rachunki), niezaleznie od liczby zapisow."""
        wzorzec = zapisy[0]
        konta = sorted({konto for konto in map(_rachunek_zdarzenia, zapisy) if konto})
        pliki = sorted({_plik_zdarzenia(event) for event in zapisy})
        walor = _ticker_bez_rynku(wzorzec)
        dzien = _dzien_zawarcia(wzorzec)
        strona = _operation_from_event(wzorzec) or ""
        klucz = (walor, dzien, strona, *konta)
        if klucz in self.konflikty:
            return
        ilosci = [
            str(_as_dict(event.get("amounts")).get("quantity") or "") for event in zapisy
        ]
        self.konflikty[klucz] = {
            "code": CONFLICT_ACCOUNT_AMBIGUOUS,
            "symbol": walor,
            "day": dzien,
            "side": strona,
            "kept_file": pliki[0],
            "dropped_file": pliki[-1],
            "accounts": konta,
            "kept_quantity": ilosci[0],
            "dropped_quantity": ilosci[-1],
        }


def _podziel_wg_rachunku(
    zapisy: list[dict[str, Any]], kontekst: _KontekstRachunkow
) -> list[list[dict[str, Any]]]:
    """Dzieli zapisy jednej grupy na rachunki, gdy kazdy z nich ma znany i rozny rachunek.

    Dwa zakupy tego samego waloru, dnia, ilosci i ceny na rachunkach A i B to dwie
    transakcje, nawet gdy pochodza z dwoch plikow - o ile rachunki wystepuja
    razem w jakims pliku. Gdy nie wystepuja, nie zgadujemy: wszystkie zapisy
    zostaja (kazdy osobno) i powstaje blokujacy konflikt do rozstrzygniecia
    przez uzytkownika. Gdy u ktoregokolwiek zapisu rachunku nie znamy (arkusz
    bez tego pola), zostaje dotychczasowe zachowanie: taki zapis bywa echem
    zapisu z API i nie da sie ustalic, ktorego rachunku.
    """
    konta = [_rachunek_zdarzenia(event) for event in zapisy]
    if not all(konta) or len(set(konta)) < 2:
        return [zapisy]
    rozne = sorted({str(konto) for konto in konta})
    if not all(
        kontekst.rozroznialne(pierwsze, drugie)
        for indeks, pierwsze in enumerate(rozne)
        for drugie in rozne[indeks + 1:]
    ):
        if len({_plik_zdarzenia(event) for event in zapisy}) > 1:
            kontekst.zglos(zapisy)
            return [[event] for event in zapisy]
        return [zapisy]
    wg_konta: dict[str, list[dict[str, Any]]] = {}
    for event, konto in zip(zapisy, konta):
        wg_konta.setdefault(str(konto), []).append(event)
    return list(wg_konta.values())


def _event_date_text(event: dict[str, Any]) -> str:
    """Data zdarzenia w postaci dziennej, pusta gdy zrodlo jej nie podalo."""
    date = _as_dict(event.get("date"))
    for key in ("datetime", "trade_date", "settlement_date", "pay_date"):
        value = date.get(key)
        if value is None:
            continue
        text = str(value).strip()
        if text and text.lower() not in {"none", "nan"}:
            return text[:10]
    return ""


def _normalized_abs_amount(text: str) -> str:
    """Kwota bez znaku i bez roznic zapisu, do porownywania miedzy plikami.

    Raport brokera zapisuje te sama oplate jako 5.43, a wyciag gotowkowy jako
    -5.43; znak jest konwencja zrodla, nie cecha zdarzenia. Rozne pliki podaja
    tez rozna liczbe miejsc po przecinku.
    """
    try:
        return str(abs(Decimal(text.replace(",", "."))).normalize())
    except (InvalidOperation, ValueError, ArithmeticError):
        return text.lstrip("+-")


def _event_comment(event: dict[str, Any]) -> str:
    """Opis operacji nadany przez brokera, znormalizowany po bialych znakach."""
    raw = _raw_payload(event)
    for key in ("Komentarz", "comment", "description", "Opis"):
        value = raw.get(key)
        if value is None:
            continue
        text = " ".join(str(value).split())
        if text:
            return text
    return ""


def _support_natural_key(event: dict[str, Any]) -> tuple[str, ...] | None:
    """Klucz tresciowy zdarzenia wspierajacego.

    Zdarzenia wspierajace prawie nie maja wlasnych identyfikatorow - 341 prowizji
    w typowym zbiorze niesie ich szesc - wiec deduplikacja po identyfikatorze tu
    nie zadziala.

    Klucz **nie zawiera rodzaju zdarzenia**, bo ten sam zapis bywa rozmaicie
    etykietowany w roznych plikach: dzienne naliczenie za ujemne saldo jest
    "interest" w wyciagu gotowkowym i "commission" w raporcie brokera. Rozstrzyga
    natomiast opis operacji, ktory broker powtarza co do znaku we wszystkich
    plikach - niesie stawke i saldo, wiec identyfikuje zdarzenie mocniej niz
    etykieta. Gdy opisu brak, rodzaj wraca do klucza, zeby nie scalac zapisow
    bez dowodu, ze opisuja to samo.

    Zwraca None dla zapisu bez daty. Takich nie wolno scalac: zwijaja sie wtedy
    po samej kwocie i skasowalyby prawdziwe koszty z roznych dni.
    """
    date_text = _event_date_text(event)
    if not date_text:
        return None
    amounts = _as_dict(event.get("amounts"))
    amount = ""
    for key in ("amount", "gross", "net", "price"):
        value = amounts.get(key)
        if value is None:
            continue
        text = str(value).strip()
        if text and text.lower() not in {"none", "nan"}:
            amount = _normalized_abs_amount(text)
            break
    comment = _event_comment(event)
    return (
        comment or _event_kind(event),
        date_text,
        amount,
        str(amounts.get("currency") or "").strip().upper(),
        _event_ticker(event),
    )


def _is_support_record(event: dict[str, Any]) -> bool:
    """Czy zapis jest zdarzeniem wspierajacym, ktore ma wejsc do rozliczenia."""
    if not isinstance(event, dict) or _status_needs_review(event):
        return False
    if str(event.get("canonical_record_status") or "").lower() in {"incomplete", "unrecognized"}:
        return False
    if _event_kind(event) not in CONSUMABLE_SUPPORT_EVENT_KINDS:
        return False
    amounts = _as_dict(event.get("amounts"))
    # Zdarzenie bez kwoty i bez ilosci nie wnosi nic do rozliczenia.
    return any(_is_non_zero(amounts.get(key)) for key in ("amount", "gross", "net", "quantity"))


def _canonical_event_stream(tax_input: Any) -> list[Any]:
    if not isinstance(tax_input, dict):
        return []
    if tax_input.get("schema_version") not in {CANONICAL_TAX_INPUT_SCHEMA, LEGACY_CANONICAL_TAX_INPUT_SCHEMA}:
        return []
    return (
        _as_list(_as_dict(tax_input.get("records")).get("_".join(["tax", "active", "events"])))
        if tax_input.get("schema_version") == LEGACY_CANONICAL_TAX_INPUT_SCHEMA
        else _as_list(tax_input.get("records"))
    )


# ---------------------------------------------------------------------------
# Wykup (termin zapadalnosci) papieru dluznego / noty strukturyzowanej
# ---------------------------------------------------------------------------

def _maturity_leg(event: dict[str, Any]) -> dict[str, str] | None:
    """Noga papierowa wykupu: ile sztuk, po ile, w jakiej walucie i kiedy.

    Broker zapisuje wykup jako zdarzenie korporacyjne w dwoch nogach:
    papierowej (liczba sztuk na dzien ustalenia praw) i pienieznej (sam wplyw).
    Sprzedaza jest tylko noga papierowa z kompletem danych - niczego nie
    zgadujemy, brak ilosci albo ceny zostawia zdarzenie do decyzji uzytkownika.
    """
    raw = _raw_payload(event)
    type_id = str(raw.get("type_id") or "").strip().lower()
    comment = str(raw.get("comment") or "").lower()
    if type_id != "maturity" and "redemption of securities" not in comment:
        return None
    ticker = str(raw.get("ticker") or _event_ticker(event) or "").strip().upper()
    currency = str(raw.get("currency") or _as_dict(event.get("amounts")).get("currency") or "").strip().upper()
    day = _event_date_text(event) or str(raw.get("date") or "")[:10]
    quantity = raw.get("q_on_ex_date")
    price = raw.get("amount_per_one")
    if not ticker or not _WZOR_DNIA.fullmatch(day) or not re.fullmatch(r"[A-Z]{3}", currency):
        return None
    try:
        quantity_dec = abs(Decimal(str(quantity).replace(",", ".")))
        price_dec = Decimal(str(price).replace(",", "."))
    except (InvalidOperation, ValueError):
        return None
    if quantity_dec <= 0 or price_dec <= 0:
        return None
    return {
        "ticker": ticker,
        "day": day,
        "quantity": format(quantity_dec.normalize(), "f"),
        "price": format(price_dec.normalize(), "f"),
        "gross": format((quantity_dec * price_dec).normalize(), "f"),
        "currency": currency,
    }


def _maturity_key(ticker: str, day: str) -> str:
    return f"{_SUFIKS_RYNKU.sub('', ticker.upper())}|{day}"


def maturity_sell_events(tax_input: Any) -> list[dict[str, Any]]:
    """Wykupy zapisane jako sprzedaz - jedna na zdarzenie, niezaleznie od liczby plikow."""
    found: dict[str, dict[str, Any]] = {}
    for event in _canonical_event_stream(tax_input):
        if not isinstance(event, dict):
            continue
        leg = _maturity_leg(event)
        if leg is None:
            continue
        key = "|".join([_maturity_key(leg["ticker"], leg["day"]), leg["quantity"], leg["price"], leg["currency"]])
        if key in found:
            continue
        source = dict(_as_dict(event.get("source")))
        found[key] = {
            **event,
            "event_id": f"MATURITY-SELL:{key}",
            "event_kind": "trade",
            "canonical_record_status": "ready",
            "status": {**_as_dict(event.get("status")), "needs_review": False},
            "instrument": {**_as_dict(event.get("instrument")), "ticker": leg["ticker"]},
            "amounts": {
                "quantity": leg["quantity"],
                "price": leg["price"],
                "gross": leg["gross"],
                "currency": leg["currency"],
            },
            "identity": {},
            "source": source,
            "raw": {
                "raw_payload": {
                    "id": f"MATURITY-{key}",
                    "operation": "sell",
                    "instr_nm": leg["ticker"],
                    "q": leg["quantity"],
                    "p": leg["price"],
                    "summ": leg["gross"],
                    "curr_c": leg["currency"],
                    "date": f"{leg['day']} 00:00:00",
                    "short_date": leg["day"],
                    "comment": "Wykup w terminie zapadalnosci (zdarzenie korporacyjne brokera)",
                }
            },
        }
    return list(found.values())


def _maturity_keys_settled(tax_input: Any) -> set[str]:
    return {
        _maturity_key(_event_ticker(event), _event_date_text(event))
        for event in maturity_sell_events(tax_input)
    }


def _is_settled_maturity_echo(event: dict[str, Any], settled: set[str]) -> bool:
    """Inny zapis tego samego wykupu (noga pieniezna, kopia w innym pliku)."""
    if not settled:
        return False
    raw = _raw_payload(event)
    text = " ".join(str(raw.get(name) or "") for name in ("type_id", "type", "comment")).lower()
    if "maturity" not in text and "redemption" not in text and "zapadalno" not in text:
        return False
    day = _event_date_text(event) or str(raw.get("date") or "")[:10]
    ticker = str(raw.get("ticker") or _event_ticker(event) or "").strip().upper()
    if ticker:
        return _maturity_key(ticker, day) in settled
    # Noga pieniezna nie ma pola waloru - walor stoi w komentarzu.
    comment = str(raw.get("comment") or "").upper()
    return any(key.split("|")[1] == day and key.split("|")[0] in comment for key in settled)



def _review_amount(event: dict[str, Any]) -> Decimal | None:
    amounts = _as_dict(event.get("amounts"))
    for key in ("amount", "gross", "net"):
        value = amounts.get(key)
        if value is None or str(value).strip() in {"", "None", "nan"}:
            continue
        try:
            return Decimal(str(value).replace(",", "."))
        except (InvalidOperation, ValueError):
            return None
    return None


def _is_zero_amount_fee(event: dict[str, Any]) -> bool:
    """Prowizja 0 (np. przewalutowanie w planie bez oplat) nie moze zmienic PIT.

    Brak kwoty to co innego niz kwota zero - zapis bez kwoty zostaje w kolejce.
    """
    if _event_kind(event) != "commission":
        return False
    amount = _review_amount(event)
    return amount is not None and amount == 0


def _settled_dividend_days(tax_input: Any) -> dict[str, list[datetime]]:
    """Dni wyplaty dywidend, ktore silnik juz rozlicza (rekord `dividend` bez przegladu)."""
    days: dict[str, list[datetime]] = defaultdict(list)
    for event in _canonical_event_stream(tax_input):
        if not isinstance(event, dict) or _event_kind(event) != "dividend" or _status_needs_review(event):
            continue
        ticker = _ticker_bez_rynku(event)
        try:
            day = datetime.strptime(_event_date_text(event), "%Y-%m-%d")
        except ValueError:
            continue
        if ticker:
            days[ticker].append(day)
    return days


def _is_settled_dividend_echo(event: dict[str, Any], dividends: dict[str, list[datetime]]) -> bool:
    """Broker powtarza wyplate dywidendy jako zdarzenie korporacyjne (brutto i netto).

    Skoro ta sama dywidenda jest juz rozliczona jako rekord `dividend`, jej echo
    nie niesie nowej decyzji. Dywidenda w papierach albo bez rozliczonego
    odpowiednika zostaje w kolejce.
    """
    if _event_kind(event) != "corporate_action" or not dividends:
        return False
    if "dividends on security" not in _event_comment(event).lower():
        return False
    ticker = _ticker_bez_rynku(event)
    try:
        day = datetime.strptime(_event_date_text(event), "%Y-%m-%d")
    except ValueError:
        return False
    return any(abs((settled_day - day).days) <= 3 for settled_day in dividends.get(ticker, []))


def _review_events(tax_input: Any) -> list[dict[str, Any]]:
    """Zdarzenia podatkowe zatrzymane do ręcznej decyzji."""
    settled = _maturity_keys_settled(tax_input)
    dividends = _settled_dividend_days(tax_input)
    return [
        event
        for event in _canonical_event_stream(tax_input)
        if isinstance(event, dict)
        and _event_kind(event) in CONSUMABLE_SUPPORT_EVENT_KINDS
        and not _is_support_record(event)
        # Wykup zapisany juz jako sprzedaz nie czeka na decyzje drugi raz.
        and not _is_settled_maturity_echo(event, settled)
        and not _is_zero_amount_fee(event)
        and not _is_settled_dividend_echo(event, dividends)
    ]


REVIEW_DECISIONS: frozenset[str] = frozenset({"no_tax_effect", "handled_manually", "pit8c_account", "no_pit8c_account"})


def review_decision_key(event: dict[str, Any]) -> str:
    """Klucz decyzji uzytkownika dla zdarzenia czekajacego na rozstrzygniecie.

    To samo zdarzenie wraca w kilku plikach brokera (raport z bilansem, bez
    bilansu, eksport API), za kazdym razem z innym identyfikatorem. Decyzja
    dotyczy zdarzenia, nie pliku, wiec klucz sklada sie z tresci: rodzaj,
    dzien, walor, ilosc, kwota i waluta.
    """
    amounts = _as_dict(event.get("amounts"))

    def _norm(value: Any) -> str:
        text = str(value if value is not None else "").strip()
        if not text or text.lower() in {"none", "nan"}:
            return ""
        return _normalized_abs_amount(text)

    amount = ""
    for key in ("amount", "gross", "net"):
        amount = _norm(amounts.get(key))
        if amount:
            break
    return "|".join(
        [
            _event_kind(event),
            _event_date_text(event),
            _ticker_bez_rynku(event),
            _norm(amounts.get("quantity")),
            amount,
            str(amounts.get("currency") or "").strip().upper(),
        ]
    )


def normalize_review_decisions(decisions: Any) -> dict[str, str]:
    """Decyzje uzytkownika: klucz zdarzenia -> rodzaj decyzji. Nieznane odpadaja."""
    if not isinstance(decisions, dict):
        return {}
    return {
        str(key): str(value)
        for key, value in decisions.items()
        if str(key).strip() and str(value) in REVIEW_DECISIONS
    }


# Podzial, scalenie, akcje bonusowe, dywidenda w akcjach, wydzielenie (spin-off),
# fuzja i zamiana z parytetem nie sa przychodem, ale zmieniaja liczbe akcji albo
# koszt na akcje w partiach FIFO. Decyzja "nie wplywa na PIT" zostawia wtedy stare
# ilosci i koszt jednostkowy.
_ZMIANA_LICZBY_AKCJI = re.compile(
    r"\bsplit|reverse[\s_-]*split|consolidat|scaleni[ea]|podzia[lł]\s+akcji"
    r"|\bbonus|akcj\w*\s+bonusow|bezp[lł]atn\w*\s+akcj"
    r"|(?:stock|share)[\s_-]*dividend|scrip|dywidend\w*\s+w\s+akcjach"
    r"|spin[\s_-]*off|wydzielen"
    r"|\bmerger|fuzj|przej[eę]ci|conversion|konwersj|exchange[\s_-]*ratio|parytet|zamian\w*\s+akcji"
    r"|rights[\s_-]*issue|prawa?\s+poboru|(?:new|zmiana)\s+isin|isin[\s_-]*change",
    re.IGNORECASE,
)

# Zdarzenia korporacyjne rozpoznane jako niezmieniajace liczby akcji: zmiana
# nazwy albo tickera, dywidenda pieniezna, podatek, wykup/zapadalnosc, kupon.
_BEZ_ZMIANY_LICZBY_AKCJI = re.compile(
    r"name[\s_-]*change|ticker[\s_-]*change|symbol[\s_-]*change|rebrand"
    r"|zmiana\s+(?:nazwy|tickera|symbolu)"
    r"|dividend|dywidend|corporate[\s_-]*action[\s_-]*tax|withholding|podatek"
    r"|maturity|redemption|termin\s+zapadalno|wykup|coupon|kupon",
    re.IGNORECASE,
)


def _tekst_zdarzenia_korporacyjnego(event: dict[str, Any]) -> str:
    raw = _raw_payload(event)
    return " ".join(str(raw.get(pole) or "") for pole in ("type_id", "type", "comment", "description", "name"))


def _zmienia_liczbe_akcji(event: dict[str, Any]) -> bool:
    return bool(_ZMIANA_LICZBY_AKCJI.search(_tekst_zdarzenia_korporacyjnego(event)))


def _rozpoznane_bez_zmiany_liczby_akcji(event: dict[str, Any]) -> bool:
    return bool(_BEZ_ZMIANY_LICZBY_AKCJI.search(_tekst_zdarzenia_korporacyjnego(event)))


class _SprzedazeWRoku:
    """Waloru sprzedane w roku rozliczenia - liczone leniwie, tylko gdy sa potrzebne."""

    def __init__(self, tax_input: Any, tax_year: int | None) -> None:
        self._tax_input = tax_input
        self._tax_year = tax_year
        self._symbole: set[str] | None = None
        self._isiny: set[str] = set()

    def _wczytaj(self) -> None:
        self._symbole = set()
        if self._tax_year is None or not isinstance(self._tax_input, dict):
            return
        for event in split_engine_events_from_canonical_tax_input(self._tax_input)["engine_records"]:
            data = _event_date_text(event)
            if _operation_from_event(event) != "SELL" or not data[:4].isdigit() or int(data[:4]) != self._tax_year:
                continue
            self._symbole.add(_ticker_bez_rynku(event))
            isin = str(_as_dict(event.get("instrument")).get("isin") or "").strip().upper()
            if isin:
                self._isiny.add(isin)
        self._symbole.discard("")

    def obejmuje(self, event: dict[str, Any]) -> bool:
        if self._symbole is None:
            self._wczytaj()
        isin = str(_as_dict(event.get("instrument")).get("isin") or "").strip().upper()
        return _ticker_bez_rynku(event) in (self._symbole or set()) or bool(isin and isin in self._isiny)


def _ma_walor(event: dict[str, Any]) -> bool:
    return bool(_ticker_bez_rynku(event) or _as_dict(event.get("instrument")).get("isin"))


def _przed_rokiem_lub_bez_daty(date_text: str, tax_year: int) -> bool:
    return not date_text[:4].isdigit() or int(date_text[:4]) < tax_year


def _zmiana_liczby_akcji_blokuje(
    event: dict[str, Any], date_text: str, tax_year: int | None, sprzedaze: _SprzedazeWRoku
) -> bool:
    """Nierozstrzygniete zdarzenie korporacyjne sprzed roku rozliczenia zmienia koszt sprzedazy w tym roku.

    Podzial, scalenie, akcje bonusowe, spin-off, fuzja czy zamiana z parytetem
    zmieniaja liczbe akcji albo koszt na akcje w partiach FIFO, wiec sprzedaz
    waloru w roku rozliczenia liczy koszt ze starych partii (10 szt. za 1000 zl
    przed podzialem 2:1 to 20 szt. po 50 zl). Ten sam wzorzec co dla akcji
    przyznanych: zdarzenie starsze blokuje tylko wtedy, gdy walor sprzedano w roku
    rozliczenia. Logika jest odwrocona: blokuje kazde zdarzenie korporacyjne poza
    rozpoznanym jako niezmieniajace liczby akcji (zmiana nazwy/tickera, dywidenda
    pieniezna, wykup). Bez daty albo bez waloru nie da sie wykluczyc wplywu, ale
    bez waloru blokuje tylko rozpoznana zmiana liczby akcji - nierozpoznane
    zdarzenie bez waloru nie da sie powiazac ze sprzedaza. Zdarzenie z roku
    rozliczenia blokuje juz osobna regula, a pozniejsze go nie dotyczy.
    """
    if tax_year is None or _event_kind(event) != "corporate_action":
        return False
    if not _przed_rokiem_lub_bez_daty(date_text, tax_year):
        return False
    zmienia = _zmienia_liczbe_akcji(event)
    if not _ma_walor(event):
        return zmienia
    if not zmienia and _rozpoznane_bez_zmiany_liczby_akcji(event):
        return False
    return sprzedaze.obejmuje(event)


def _blokuje_gdy_sprzedano(event: dict[str, Any], date_text: str, tax_year: int | None) -> bool:
    """Czy zdarzenie sprzed roku rozliczenia zablokuje rozliczenie, jesli walor okaze sie sprzedany w roku.

    Silnik ocenia potem sprzedaze z rejestru (z transakcjami recznymi), ktorych
    adapter nie widzi.
    """
    if tax_year is None or _event_kind(event) != "corporate_action" or not _przed_rokiem_lub_bez_daty(date_text, tax_year):
        return False
    return _ma_walor(event) and (_zmienia_liczbe_akcji(event) or not _rozpoznane_bez_zmiany_liczby_akcji(event))


def _wymaga_korekty_partii(
    event: dict[str, Any], date_text: str, tax_year: int | None, sprzedaze: _SprzedazeWRoku
) -> bool:
    """Zmiana liczby akcji waloru sprzedanego w roku rozliczenia wymaga korekty partii.

    Podzial zmienia koszt na akcje (art. 22 ust. 1a ustawy o PIT - koszt nabycia
    dzieli sie na nowa liczbe akcji), a silnik nie zgaduje wspolczynnika. Sama
    decyzja "nie wplywa na PIT" zostawilaby FIFO bez podzialu i zanizony dochod,
    wiec zwalnia blokade tylko "ujalem recznie w historii".
    """
    if tax_year is None or _event_kind(event) != "corporate_action" or not _zmienia_liczbe_akcji(event):
        return False
    if date_text[:4].isdigit() and int(date_text[:4]) > tax_year:
        return False
    return not _ma_walor(event) or sprzedaze.obejmuje(event)


BLOCKING_NOTE_SHARE_COUNT = (
    "Podział lub scalenie akcji zmienia koszt nabycia przypadający na akcję (art. 22 ust. 1a ustawy o PIT), "
    "a walor sprzedano w roku rozliczenia. Decyzja „nie wpływa na PIT” zostawia partie FIFO bez podziału "
    "i zaniża koszt lub dochód - skoryguj partie w Historii i oznacz zdarzenie jako „Ująłem ręcznie w historii”."
)


def _decyzja_nie_wystarcza(
    decyzja: str | None,
    event: dict[str, Any],
    date_text: str,
    tax_year: int | None,
    sprzedaze: _SprzedazeWRoku,
) -> bool:
    """Decyzja inna niz "ujalem recznie" nie zwalnia zmiany liczby akcji sprzedanego waloru."""
    return bool(
        decyzja
        and decyzja != "handled_manually"
        and _wymaga_korekty_partii(event, date_text, tax_year, sprzedaze)
    )


def review_queue(
    tax_input: Any, tax_year: int | None, decisions: Any = None
) -> list[dict[str, Any]]:
    """Kolejka zdarzen czekajacych na decyzje - jedna pozycja na zdarzenie.

    Interfejs pokazuje te liste i odsyla decyzje po kluczu. Pozycja z decyzja
    zostaje na liscie (mozna ja cofnac), ale nie blokuje juz rozliczenia.
    """
    accepted = normalize_review_decisions(decisions)
    grouped: dict[str, dict[str, Any]] = {}
    sprzedaze = _SprzedazeWRoku(tax_input, tax_year)
    for event in _review_events(tax_input):
        key = review_decision_key(event)
        kind = _event_kind(event)
        date_text = _event_date_text(event)
        is_tax_year = bool(
            tax_year is not None and date_text[:4].isdigit() and int(date_text[:4]) == tax_year
        )
        amounts = _as_dict(event.get("amounts"))
        entry = grouped.get(key)
        if entry is None:
            entry = {
                "decision_key": key,
                "kind": kind,
                "date": date_text or None,
                "symbol": _event_ticker(event) or None,
                "isin": str(_as_dict(event.get("instrument")).get("isin") or "").strip().upper() or None,
                "quantity": str(amounts.get("quantity")) if amounts.get("quantity") is not None else None,
                "amount": next(
                    (str(amounts.get(name)) for name in ("amount", "gross", "net") if amounts.get(name) is not None),
                    None,
                ),
                "currency": str(amounts.get("currency") or "").strip().upper() or None,
                "comment": _event_comment(event) or None,
                "changes_share_count": kind == "corporate_action" and _zmienia_liczbe_akcji(event),
                "blocks_when_sold": _blokuje_gdy_sprzedano(event, date_text, tax_year),
                "blocks_filing": kind == "stock_award"
                or is_tax_year
                or _zmiana_liczby_akcji_blokuje(event, date_text, tax_year, sprzedaze),
                "decision": accepted.get(key),
                "source_files": [],
                "occurrences": 0,
            }
            if _decyzja_nie_wystarcza(accepted.get(key), event, date_text, tax_year, sprzedaze):
                entry["decision_insufficient"] = True
                entry["blocks_filing"] = True
                entry["blocking_note"] = BLOCKING_NOTE_SHARE_COUNT
            grouped[key] = entry
        entry["occurrences"] += 1
        source_file = _plik_zdarzenia(event)
        if source_file and source_file not in entry["source_files"]:
            entry["source_files"].append(source_file)
    return sorted(grouped.values(), key=lambda row: (row["date"] or "", row["kind"], row["decision_key"]))


def records_held_for_review(tax_input: Any) -> dict[str, int]:
    """Zapisy nalezace do kategorii rozliczanych, ktore czekaja na decyzje uzytkownika.

    Zdarzenia korporacyjne i akcje przyznane sa z zalozenia oznaczane do
    przegladu: podzial, splata, przyznanie waloru czy wykup wymagaja
    rozstrzygniecia, jak wplywaja na koszt nabycia. Silnik slusznie ich nie
    zgaduje - ale do tej pory znikaly bez sladu, wiec uzytkownik nie mial skad
    wiedziec, ze czekaja na jego decyzje.
    """
    held: dict[str, int] = defaultdict(int)
    for event in _review_events(tax_input):
        held[_event_kind(event)] += 1
    return dict(sorted(held.items()))


def records_awaiting_decision_impact(
    tax_input: Any, tax_year: int | None, decisions: Any = None
) -> tuple[dict[str, int], dict[str, int]]:
    """Dzieli kolejkę decyzji na blokującą PIT i ostrzegawczą.

    Przyznane akcje bez potwierdzonego kosztu nabycia blokują zawsze: ich
    późniejsza sprzedaż albo stan posiadania może zmienić FIFO. Pozostałe
    zdarzenia blokują tylko w roku rozliczenia; starsze nadal są widocznym
    ostrzeżeniem, lecz nie unieważniają zamkniętego roku bez śladu wpływu.
    Wyjątek: zdarzenie korporacyjne sprzed roku rozliczenia (poza rozpoznaną
    zmianą nazwy, dywidendą pieniężną czy wykupem) blokuje, gdy walor sprzedano
    w roku rozliczenia (może zmienić koszt tej sprzedaży). Zmianę liczby akcji
    takiego waloru zwalnia tylko decyzja „ujęte ręcznie”, nie „bez wpływu na PIT”.
    """
    blocking: dict[str, int] = defaultdict(int)
    warning: dict[str, int] = defaultdict(int)
    accepted = normalize_review_decisions(decisions)
    sprzedaze = _SprzedazeWRoku(tax_input, tax_year)
    for event in _review_events(tax_input):
        kind = _event_kind(event)
        date_text = _event_date_text(event)
        decyzja = accepted.get(review_decision_key(event))
        # Zdarzenie rozstrzygniete przez uzytkownika nie czeka juz na decyzje -
        # poza zmiana liczby akcji sprzedanego waloru, ktorej wymaga korekty partii.
        if decyzja and not _decyzja_nie_wystarcza(decyzja, event, date_text, tax_year, sprzedaze):
            continue
        is_tax_year = bool(
            tax_year is not None and date_text[:4].isdigit() and int(date_text[:4]) == tax_year
        )
        if (
            decyzja
            or kind == "stock_award"
            or is_tax_year
            or _zmiana_liczby_akcji_blokuje(event, date_text, tax_year, sprzedaze)
        ):
            blocking[kind] += 1
        else:
            warning[kind] += 1
    return dict(sorted(blocking.items())), dict(sorted(warning.items()))


def deduplicate_support_events(
    events: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    """Zostawia jeden zapis na zdarzenie wspierajace.

    Zwraca (zachowane, odrzucone duplikaty, zapisy bez daty).

    Zapis bez daty nie trafia do rozliczenia: bez daty nie ma kursu NBP, wiec
    nie da sie go przeliczyc na zlote. Nie wolno go tez scalic z innym - klucz
    zwinalby sie wtedy po samej kwocie i skasowal prawdziwe koszty z roznych
    dni. Zostaje wiec zwrocony osobno, policzony i zaraportowany, zeby
    uzytkownik mogl uzupelnic date, zamiast stracic pozycje bez sladu.
    """
    by_key: dict[tuple[str, ...], list[dict[str, Any]]] = {}
    undated: list[dict[str, Any]] = []
    dropped: list[dict[str, Any]] = []

    for event in events:
        key = _support_natural_key(event)
        if key is None:
            undated.append(event)
            continue
        by_key.setdefault(key, []).append(event)

    context = _KontekstRachunkow(events)
    kept: list[dict[str, Any]] = []
    for records in by_key.values():
        accounts = [_rachunek_zdarzenia(event) for event in records]
        known = sorted({account for account in accounts if account})
        separate = (
            len(known) > 1 and all(accounts)
            and all(context.rozroznialne(first, second)
                    for index, first in enumerate(known) for second in known[index + 1:])
        )
        groups: dict[str, list[dict[str, Any]]] = {}
        for event, account in zip(records, accounts):
            groups.setdefault(str(account) if separate else "", []).append(event)
        for group in groups.values():
            best = min(group, key=_parser_rank)
            kept.append(best)
            dropped.extend(event for event in group if event is not best)
    return kept, dropped, undated


def _is_aggregated_summary(event: dict[str, Any]) -> bool:
    """Czy zapis jest podsumowaniem pozycji scalonej, a nie pojedyncza transakcja.

    Broker oznacza takie wiersze literalem agregacji w polach id i date.
    """
    raw = _raw_payload(event)
    return any(is_aggregation_marker(raw.get(key)) for key in ("id", "date", "pay_d"))


def _event_ticker(event: dict[str, Any]) -> str:
    return str(_as_dict(event.get("instrument")).get("ticker") or "").strip().upper()


_SUFIKS_RYNKU = re.compile(r"\.(US|EU|DE|UK|L|PL|PA|TO|CRPT|WA)$")


def symbol_bez_rynku(symbol: Any) -> str:
    """Ten sam walor bywa zapisany jako `NBIS` i jako `NBIS.US`."""
    return _SUFIKS_RYNKU.sub("", str(symbol or "").strip().upper())


def _ticker_bez_rynku(event: dict[str, Any]) -> str:
    return symbol_bez_rynku(_event_ticker(event))


_WZOR_DNIA = re.compile(r"\d{4}-\d{2}-\d{2}")


def _dzien_zawarcia(event: dict[str, Any]) -> str:
    """Dzien zawarcia transakcji na gieldzie, a nie dzien ksiegowania.

    Broker podaje oba: `trade_d_exch` (gielda) i `date` (ksiegowanie w innej
    strefie czasowej). Dla 22 z 542 transakcji na rachunku uzytkownika te dni
    sa rozne. Jeden plik zapisuje transakcje pod jedna data, drugi pod druga -
    bez sprowadzenia do dnia zawarcia ta sama sprzedaz wyglada na dwie i wchodzi
    do rozliczenia dwa razy (2025-06-04: 54 sztuki zamiast 27).
    """
    raw = _raw_payload(event)
    for key in ("trade_d_exch", "trade_d_exch ", "Execution Date"):
        value = raw.get(key)
        if value is None:
            continue
        # Surowa tresc bywa zredagowana na potrzeby audytu ("***:02:54.000"),
        # wiec bierzemy ja tylko wtedy, gdy naprawde wyglada jak data.
        text = str(value).strip()[:10]
        if _WZOR_DNIA.fullmatch(text):
            return text
    return _event_date_text(event)


def _klucz_gospodarczy(event: dict[str, Any]) -> str | None:
    """Transakcja opisana tym, co sie w niej wydarzylo, a nie numerem z pliku.

    Identyfikator brokera rozstrzyga tylko tam, gdzie plik go niesie - arkusze
    eksportowane z panelu nie maja go wcale (600 z 2573 rekordow na rachunku
    uzytkownika). Wtedy jedynym sladem tozsamosci jest walor, dzien zawarcia,
    ilosc, cena, strona i waluta.

    Zwraca None, gdy brakuje ktorejkolwiek z tych czterech rzeczy, ktore
    identyfikuja transakcje - takiego zapisu nie wolno z niczym scalac.
    """
    ticker = _ticker_bez_rynku(event)
    data = _dzien_zawarcia(event)
    amounts = _as_dict(event.get("amounts"))
    ilosc = _normalized_abs_amount(str(amounts.get("quantity") or ""))
    cena = _normalized_abs_amount(str(amounts.get("price") or ""))
    if not ticker or not data or not ilosc or not cena:
        return None
    strona = _operation_from_event(event) or ""
    waluta = str(amounts.get("currency") or "").upper()
    return "|".join((ticker, data, ilosc, cena, strona, waluta))


def _plik_zdarzenia(event: dict[str, Any]) -> str:
    return str(_as_dict(event.get("source")).get("filename") or "")


def _klucz_sasiedniego_dnia(
    klucz: str,
    wg_klucza: dict[str, list[dict[str, Any]]],
    event: dict[str, Any],
) -> str:
    """Sprowadza zapis do klucza z dnia sasiedniego, gdy to ta sama transakcja.

    Warunek jest waski: identyczny walor, ilosc, cena, strona i waluta, dzien
    rozni sie o jeden, a zapisy pochodza z ROZNYCH plikow. Dwie takie same
    transakcje z jednego pliku w kolejnych dniach zostaja osobno.
    """
    ticker, dzien, reszta = klucz.split("|", 2)
    try:
        dzien_iso = datetime.strptime(dzien, "%Y-%m-%d").date()
    except ValueError:
        return klucz
    for przesuniecie in (-1, 1):
        sasiad = f"{ticker}|{(dzien_iso + timedelta(days=przesuniecie)).isoformat()}|{reszta}"
        istniejace = wg_klucza.get(sasiad)
        if istniejace and all(
            _plik_zdarzenia(inny) != _plik_zdarzenia(event) for inny in istniejace
        ):
            return sasiad
    return klucz


def _scal_powtorzenia_miedzy_plikami(
    events: list[dict[str, Any]],
    kontekst: _KontekstRachunkow,
) -> tuple[list[dict[str, Any]], list[tuple[dict[str, Any], str]]]:
    """Ta sama transakcja opisana w kilku plikach to jedna transakcja.

    Liczy sie MAKSIMUM z jednego pliku, nie suma. Dwa identyczne wypelnienia
    tego samego zlecenia w jednym wyciagu to naprawde dwie transakcje i obie
    zostaja; ta sama transakcja powtorzona w drugim pliku znika. Zostawiamy
    zapisy z tego pliku, ktory ma ich najwiecej, a przy remisie - z parsera
    o wyzszym zaufaniu.

    Bez tego kroku rozliczenie liczylo te same operacje po kilka razy: 2573
    rekordy przy 1408 rzeczywistych transakcjach, jedna nawet szesciokrotnie,
    a dochod do opodatkowania wychodzil dwa razy za wysoki.
    """
    wg_klucza: dict[str, list[dict[str, Any]]] = {}
    bez_klucza: list[dict[str, Any]] = []
    kolejnosc: list[str] = []
    for event in events:
        klucz = _klucz_gospodarczy(event)
        if klucz is None:
            bez_klucza.append(event)
            continue
        # Ten sam walor, ta sama ilosc i cena, dzien obok: jeden plik zapisuje
        # transakcje pod dniem zawarcia na gieldzie, drugi pod dniem
        # ksiegowania (dla 22 z 542 transakcji na rachunku uzytkownika te dni
        # sa rozne). Bez sprowadzenia ich do jednego klucza ta sama sprzedaz
        # liczyla sie dwa razy - 54 sztuki NBIS zamiast 27.
        klucz = _klucz_sasiedniego_dnia(klucz, wg_klucza, event)
        if klucz not in wg_klucza:
            wg_klucza[klucz] = []
            kolejnosc.append(klucz)
        wg_klucza[klucz].append(event)

    zachowane: list[dict[str, Any]] = []
    odrzucone: list[tuple[dict[str, Any], str]] = []
    for klucz in kolejnosc:
        # Rozne rachunki to rozne transakcje, nawet o identycznym walorze, dniu,
        # ilosci i cenie - kazdy rachunek rozstrzyga sie osobno.
        for grupa in _podziel_wg_rachunku(wg_klucza[klucz], kontekst):
            if len(grupa) == 1:
                zachowane.extend(grupa)
                continue
            wg_pliku: dict[str, list[dict[str, Any]]] = {}
            for event in grupa:
                wg_pliku.setdefault(_plik_zdarzenia(event), []).append(event)
            najlepszy = max(
                wg_pliku.values(),
                key=lambda zapisy: (len(zapisy), -_parser_rank(zapisy[0])),
            )
            zachowane.extend(najlepszy)
            wybrane = {id(event) for event in najlepszy}
            for event in grupa:
                if id(event) not in wybrane:
                    odrzucone.append(
                        (event, "ta sama transakcja opisana juz w pliku o pelniejszym zapisie")
                    )

    return zachowane + bez_klucza, odrzucone


def _udzial_z_identyfikatorem(zapisy: list[dict[str, Any]]) -> float:
    """Jaka czesc zapisow niesie identyfikator transakcji od brokera."""
    if not zapisy:
        return 0.0
    z_id = sum(1 for event in zapisy if _broker_trade_key(event) is not None)
    return z_id / len(zapisy)


def _scal_pokrywajace_sie_zrodla(
    events: list[dict[str, Any]],
    kontekst: _KontekstRachunkow,
) -> tuple[list[dict[str, Any]], list[tuple[dict[str, Any], str]], list[dict[str, str]]]:
    """Jeden walor, jeden dzien i jedna strona transakcji na zrodlo.

    Klucz gospodarczy scala transakcje zapisane tak samo, ale pliki roznia sie
    tez ZIARNISTOSCIA: jeden zapisuje zlecenie zbiorczo (40 sztuk), drugi dwoma
    wypelnieniami (20 + 20). Takich zapisow nie da sie sparowac pojedynczo,
    a policzone razem podwajaja wolumen.

    Na rachunku uzytkownika zostawalo po tym 21 zapisow NBIS z pliku, ktory
    aplikacja sama zapisuje do magazynu obok eksportu z API - i to one dawaly
    324 sztuki sprzedazy bez pokrycia, czyli 175 tys. PLN przychodu z zerowym
    kosztem.

    Regula: dla kazdej trojki (walor, dzien, strona) zostaja zapisy z jednego zrodla -
    tego o wyzszym zaufaniu parsera, a przy remisie z pelniejszym zapisem.
    """
    wg_dnia: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
    bez_klucza: list[dict[str, Any]] = []
    kolejnosc: list[tuple[str, str, str]] = []
    for event in events:
        ticker = _ticker_bez_rynku(event)
        dzien = _dzien_zawarcia(event)
        strona = _operation_from_event(event)
        if not ticker or not dzien or not strona:
            bez_klucza.append(event)
            continue
        klucz = (ticker, dzien, strona)
        if klucz not in wg_dnia:
            wg_dnia[klucz] = []
            kolejnosc.append(klucz)
        wg_dnia[klucz].append(event)

    zachowane: list[dict[str, Any]] = []
    odrzucone: list[tuple[dict[str, Any], str]] = []
    konflikty: list[dict[str, str]] = []
    grupy_rachunkow = [
        (klucz, grupa) for klucz in kolejnosc for grupa in _podziel_wg_rachunku(wg_dnia[klucz], kontekst)
    ]
    for klucz, grupa in grupy_rachunkow:
        wg_pliku: dict[str, list[dict[str, Any]]] = {}
        for event in grupa:
            wg_pliku.setdefault(_plik_zdarzenia(event), []).append(event)
        if len(wg_pliku) <= 1:
            zachowane.extend(grupa)
            continue
        # O pierwszenstwie decyduje przede wszystkim to, czy zapisy niosa
        # identyfikatory nadane przez brokera. Kopia zapisana przez sama
        # aplikacje ma je puste, a eksport z API ma `trade_id`, `order_id`
        # i `trade_nb` - i to eksport jest dokumentem, nie kopia.
        najlepszy = min(
            wg_pliku.values(),
            key=lambda zapisy: (
                -_udzial_z_identyfikatorem(zapisy),
                _parser_rank(zapisy[0]),
                -len(zapisy),
            ),
        )
        wybrany_plik = _plik_zdarzenia(najlepszy[0])
        wybrana_ilosc = sum(
            (parse_amount(_as_dict(event.get("amounts")).get("quantity")) or Decimal("0") for event in najlepszy),
            Decimal("0"),
        )
        for plik, zapisy in wg_pliku.items():
            if plik == wybrany_plik:
                continue
            odrzucona_ilosc = sum(
                (parse_amount(_as_dict(event.get("amounts")).get("quantity")) or Decimal("0") for event in zapisy),
                Decimal("0"),
            )
            if abs(wybrana_ilosc - odrzucona_ilosc) > Decimal("0.00000001"):
                konflikty.append({
                    "code": "OVERLAPPING_SOURCE_QUANTITY_CONFLICT",
                    "symbol": klucz[0],
                    "day": klucz[1],
                    "side": klucz[2],
                    "kept_file": wybrany_plik,
                    "dropped_file": plik,
                    "kept_quantity": str(wybrana_ilosc),
                    "dropped_quantity": str(odrzucona_ilosc),
                })
        zachowane.extend(najlepszy)
        wybrane = {id(event) for event in najlepszy}
        for event in grupa:
            if id(event) not in wybrane:
                odrzucone.append(
                    (event, "inny plik opisuje ten sam walor w tym samym dniu pelniej")
                )

    return zachowane + bez_klucza, odrzucone, konflikty


def _sasiednie_dni_robocze(wczesniejszy: Any, pozniejszy: Any) -> bool:
    """Dni sasiednie lub rozdzielone samym weekendem (piatek - poniedzialek).

    Plik z data rozliczenia (T+1) przenosi piatkowa transakcje na poniedzialek.
    """
    przerwa = (pozniejszy - wczesniejszy).days
    if przerwa <= 1:
        return True
    return all((wczesniejszy + timedelta(days=i)).weekday() >= 5 for i in range(1, przerwa))


def _konflikty_ilosci_zrodel(
    events: list[dict[str, Any]], kontekst: _KontekstRachunkow
) -> list[dict[str, str]]:
    """Pliki, ktore opisuja ten sam walor i strone, ale inna laczna iloscia.

    Porownanie dzien po dniu dawalo na rachunku uzytkownika falszywe konflikty:
    jeden plik zapisuje transakcje pod dniem gieldy, drugi pod dniem ksiegowania,
    wiec wieczorne zlecenia laduja w sasiednich dniach (INTC 04-29/04-30:
    20+10 wobec 10+20 - razem po 30 sztuk). Dlatego ilosci sumujemy w skupiskach
    kolejnych dni (przerwa co najwyzej jeden dzien) i tylko w okresie, ktory
    obejmuja oba pliki - plik konczacy sie wczesniej nie jest "brakiem transakcji".
    Podsumowania "Zgrupowano" (suma okresu ze srednia cena) nie sa transakcjami.
    Plik odniesienia to ten, ktory wygralby arbitraz: z identyfikatorami brokera,
    potem wg zaufania parsera.

    Swiadomy kompromis: rozne podzialy tej samej ilosci miedzy sasiednie dni
    skupiska (np. 5+5 wobec 8+2) nie sa konfliktem. Regula ma wykrywac ZGUBIONE
    transakcje; o dniu transakcji rozstrzyga plik odniesienia (dzien gieldy
    z trade_d_exch), a nie drugi plik.
    """
    ilosci: dict[tuple[str, str, str], dict[str, dict[Any, Decimal]]] = defaultdict(
        lambda: defaultdict(lambda: defaultdict(lambda: Decimal("0")))
    )
    zasieg: dict[str, list[Any]] = {}
    zapisy_pliku: dict[str, list[dict[str, Any]]] = defaultdict(list)
    wpisy: list[tuple[dict[str, Any], str, str, Any]] = []
    for event in events:
        if _is_aggregated_summary(event):
            continue
        ticker = _ticker_bez_rynku(event)
        strona = _operation_from_event(event)
        try:
            dzien = datetime.strptime(_dzien_zawarcia(event)[:10], "%Y-%m-%d").date()
        except ValueError:
            continue
        if not ticker or not strona:
            continue
        wpisy.append((event, ticker, strona, dzien))

    # Rachunki porownujemy osobno tylko wtedy, gdy kazdy zapis walor-strona ma
    # znany rachunek i sa co najmniej dwa - inaczej ilosci z roznych rachunkow
    # dawalyby falszywy konflikt.
    konta_wg_klucza: dict[tuple[str, str], list[str | None]] = defaultdict(list)
    for event, ticker, strona, _ in wpisy:
        konta_wg_klucza[(ticker, strona)].append(_rachunek_zdarzenia(event))
    rozdzielane = {
        klucz
        for klucz, konta in konta_wg_klucza.items()
        if all(konta)
        and len(set(konta)) > 1
        and all(
            kontekst.rozroznialne(str(pierwsze), str(drugie))
            for pierwsze in set(konta)
            for drugie in set(konta)
            if str(pierwsze) < str(drugie)
        )
    }

    for event, ticker, strona, dzien in wpisy:
        plik = _plik_zdarzenia(event)
        ilosc = parse_amount(_as_dict(event.get("amounts")).get("quantity")) or Decimal("0")
        konto = (_rachunek_zdarzenia(event) or "") if (ticker, strona) in rozdzielane else ""
        ilosci[(ticker, strona, konto)][plik][dzien] += abs(ilosc)
        zakres = zasieg.setdefault(plik, [dzien, dzien])
        zakres[0] = min(zakres[0], dzien)
        zakres[1] = max(zakres[1], dzien)
        zapisy_pliku[plik].append(event)

    ranga = {
        plik: (-_udzial_z_identyfikatorem(zapisy), _parser_rank(zapisy[0]), -len(zapisy))
        for plik, zapisy in zapisy_pliku.items()
    }
    konflikty: list[dict[str, str]] = []
    for (ticker, strona, _konto), wg_pliku in ilosci.items():
        pliki = sorted(wg_pliku, key=lambda plik: ranga[plik])
        wzorzec = pliki[0]
        for inny in pliki[1:]:
            od = max(zasieg[wzorzec][0], zasieg[inny][0])
            do = min(zasieg[wzorzec][1], zasieg[inny][1])

            def w_okresie(d: Any) -> bool:
                return od <= d <= do

            def przy_krawedzi(d: Any) -> bool:
                # Transakcja z ostatniego dnia jednego pliku zapisana w drugim pod
                # nastepnym dniem roboczym (albo odwrotnie na poczatku okresu).
                return (d > do and _sasiednie_dni_robocze(do, d)) or (d < od and _sasiednie_dni_robocze(d, od))

            dni = sorted(
                d for d in set(wg_pliku[wzorzec]) | set(wg_pliku[inny]) if w_okresie(d) or przy_krawedzi(d)
            )

            def rozne(zakres: list[Any]) -> tuple[bool, Decimal, Decimal]:
                a = sum((wg_pliku[wzorzec].get(d, Decimal("0")) for d in zakres), Decimal("0"))
                b = sum((wg_pliku[inny].get(d, Decimal("0")) for d in zakres), Decimal("0"))
                return abs(a - b) > Decimal("0.00000001"), a, b

            skupisko: list[Any] = []
            for dzien in [*dni, None]:
                if skupisko and (dzien is None or not _sasiednie_dni_robocze(skupisko[-1], dzien)):
                    roznica, ilosc_wzorca, ilosc_innego = rozne(skupisko)
                    rdzen = [d for d in skupisko if w_okresie(d)]
                    if roznica and len(rdzen) != len(skupisko):
                        # Dzien spoza wspolnego okresu moze nalezec tylko do jednego pliku
                        # (nowa transakcja po koncu drugiego) - zgodny rdzen wystarczy.
                        roznica = rozne(rdzen)[0]
                    if roznica:
                        konflikty.append({
                            "code": "OVERLAPPING_SOURCE_QUANTITY_CONFLICT",
                            "symbol": ticker,
                            "day": skupisko[0].isoformat(),
                            "day_to": skupisko[-1].isoformat(),
                            "side": strona,
                            "kept_file": wzorzec,
                            "dropped_file": inny,
                            "kept_quantity": str(ilosc_wzorca),
                            "dropped_quantity": str(ilosc_innego),
                        })
                    skupisko = []
                if dzien is not None:
                    skupisko.append(dzien)
    return konflikty


def _dni_robocze_miedzy(wczesniejszy: Any, pozniejszy: Any) -> int:
    """Liczba dni roboczych (pon-pt) w przedziale (wczesniejszy, pozniejszy]."""
    return sum(
        1
        for przesuniecie in range(1, (pozniejszy - wczesniejszy).days + 1)
        if (wczesniejszy + timedelta(days=przesuniecie)).weekday() < 5
    )


# Ile dni roboczych moze dzielic dzien zawarcia od dnia rozliczenia (T+2, swieta,
# zamkniecie rejestru), zeby ten sam numer transakcji byl nadal tym samym zapisem.
_MAX_DNI_ROBOCZYCH_MIEDZY_DATAMI = 5

_ROZNE = "rozne"
_TA_SAMA = "ta_sama"
_NIEJEDNOZNACZNE = "niejednoznaczne"


def _cecha_liczbowa(event: dict[str, Any], klucz: str) -> str:
    wartosc = _as_dict(event.get("amounts")).get(klucz)
    if wartosc is None or not str(wartosc).strip() or str(wartosc).strip().lower() in {"none", "nan"}:
        return ""
    return _normalized_abs_amount(str(wartosc).strip())


def _porownaj_zapisy_o_tym_samym_numerze(
    pierwszy: dict[str, Any], drugi: dict[str, Any], kontekst: _KontekstRachunkow
) -> str:
    """Czy dwa zapisy o tym samym numerze transakcji opisuja jedna transakcje.

    Numery nadaja brokerzy i rachunki, wiec ten sam numer moze wrocic dla innego
    rachunku albo waloru. Zapisy sa rozne, gdy walor (bez sufiksu rynku) albo
    strona sa znane po obu stronach i sie roznia. Dzien porownujemy tylko wtedy,
    gdy nie zgadzaja sie ilosc i cena (albo ktorejs brakuje): plik z sama data
    rozliczenia przenosi transakcje o T+2 i swieta, a zgodna ilosc i cena przy
    tym samym numerze rozstrzygaja same. Cecha nieznana po jednej stronie
    niczego nie rozstrzyga - arkusz bez rachunku dalej jest echem eksportu API.

    Rachunki rozne po obu stronach: rozne transakcje, jesli rachunki wystepuja
    razem w jakims pliku; inaczej wynik jest niejednoznaczny (moze to byc ten
    sam rachunek w dwoch formatach).
    """
    walor_a, walor_b = _ticker_bez_rynku(pierwszy), _ticker_bez_rynku(drugi)
    if walor_a and walor_b and walor_a != walor_b:
        return _ROZNE
    strona_a, strona_b = _operation_from_event(pierwszy), _operation_from_event(drugi)
    if strona_a and strona_b and strona_a != strona_b:
        return _ROZNE
    ilosc_a, ilosc_b = _cecha_liczbowa(pierwszy, "quantity"), _cecha_liczbowa(drugi, "quantity")
    cena_a, cena_b = _cecha_liczbowa(pierwszy, "price"), _cecha_liczbowa(drugi, "price")
    zgodne_wartosci = bool(ilosc_a and ilosc_b and cena_a and cena_b and ilosc_a == ilosc_b and cena_a == cena_b)
    if not zgodne_wartosci:
        try:
            dzien_a = datetime.strptime(_dzien_zawarcia(pierwszy)[:10], "%Y-%m-%d").date()
            dzien_b = datetime.strptime(_dzien_zawarcia(drugi)[:10], "%Y-%m-%d").date()
        except ValueError:
            pass
        else:
            if _dni_robocze_miedzy(min(dzien_a, dzien_b), max(dzien_a, dzien_b)) > _MAX_DNI_ROBOCZYCH_MIEDZY_DATAMI:
                return _ROZNE
    konto_a, konto_b = _rachunek_zdarzenia(pierwszy), _rachunek_zdarzenia(drugi)
    if konto_a and konto_b and konto_a != konto_b:
        if kontekst.rozroznialne(konto_a, konto_b):
            return _ROZNE
        if _plik_zdarzenia(pierwszy) != _plik_zdarzenia(drugi):
            kontekst.zglos([pierwszy, drugi])
        return _NIEJEDNOZNACZNE
    return _TA_SAMA


def deduplicate_trade_events(events: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Zostawia jeden zapis na transakcje brokera, wybierajac najbardziej wiarygodne zrodlo.

    Dwa rodzaje duplikatow:

    1. Ten sam identyfikator transakcji w kilku plikach - zostaje zapis ze
       zrodla o najwyzszej wiarygodnosci.
    2. Podsumowanie pozycji scalonej, gdy ten sam instrument ma juz zapisy
       pojedyncze - agregat opisuje wtedy te same zdarzenia zbiorczo i policzony
       obok nich zdublowalby wolumen. Gdy zapisow pojedynczych brak, agregat
       zostaje, bo jest wowczas jedynym sladem tych transakcji.

    Zwraca krotke (zachowane, odrzucone). Odrzucone trafiaja do raportu budowy
    wejscia podatkowego, zeby kazde pominiecie dalo sie przesledzic.
    """
    # Porownaj caly wolumen kazdego pliku przed arbitrazem identyfikatorow.
    # Czesciowe pokrycie po ID mogloby ukryc roznice lub stworzyc falszywa.
    # Bez podsumowan "Zgrupowano" i z tolerancja na dzien gieldy/ksiegowania -
    # porownanie dzien po dniu dawalo na rachunku uzytkownika 36 falszywych
    # konfliktow (NBIS 2025-02-10: suma okresu 3098 szt. po 141 USD wobec 3 szt.
    # po 41,07 USD we wszystkich plikach z pojedynczymi transakcjami).
    kontekst_rachunkow = _KontekstRachunkow(events)
    konflikty_zrodel = _konflikty_ilosci_zrodel(events, kontekst_rachunkow)
    # Numer transakcji jest unikalny tylko w obrebie rachunku i waloru, wiec ten
    # sam numer nie wystarcza do uznania zapisu za duplikat - patrz
    # `_porownaj_zapisy_o_tym_samym_numerze`.
    slots: list[dict[str, Any]] = []
    slots_by_key: dict[str, list[int]] = {}
    without_key: list[dict[str, Any]] = []
    dropped: list[tuple[dict[str, Any], str]] = []

    for event in events:
        key = _broker_trade_key(event)
        if key is None:
            without_key.append(event)
            continue
        slot_index = next(
            (
                index
                for index in slots_by_key.get(key, [])
                if _porownaj_zapisy_o_tym_samym_numerze(slots[index], event, kontekst_rachunkow) == _TA_SAMA
            ),
            None,
        )
        if slot_index is None:
            slots_by_key.setdefault(key, []).append(len(slots))
            slots.append(event)
            continue
        current = slots[slot_index]
        if _parser_rank(event) < _parser_rank(current):
            slots[slot_index] = event
            dropped.append((current, "duplicate broker trade already covered by a more reliable source"))
        else:
            dropped.append((event, "duplicate broker trade already covered by a more reliable source"))

    identified = list(slots)
    tickers_with_individual_records = {
        _event_ticker(event) for event in identified if not _is_aggregated_summary(event)
    }
    tickers_with_individual_records.discard("")

    retained_without_key: list[dict[str, Any]] = []
    for event in without_key:
        if _is_aggregated_summary(event) and _event_ticker(event) in tickers_with_individual_records:
            dropped.append((event, "aggregated summary duplicates individually recorded trades for this instrument"))
            continue
        retained_without_key.append(event)

    kandydaci = identified + retained_without_key
    kept, odrzucone_powtorzenia = _scal_powtorzenia_miedzy_plikami(kandydaci, kontekst_rachunkow)
    dropped.extend(odrzucone_powtorzenia)
    kept, odrzucone_zrodla, _ = _scal_pokrywajace_sie_zrodla(kept, kontekst_rachunkow)
    dropped.extend(odrzucone_zrodla)
    return kept, [
        {
            "eventId": event.get("event_id"),
            "brokerTradeKey": _broker_trade_key(event),
            "parser": _event_parser(event),
            "filename": _as_dict(event.get("source")).get("filename"),
            "reason": reason,
        }
        for event, reason in dropped
    ] + konflikty_zrodel + list(kontekst_rachunkow.konflikty.values())


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _event_source_id(event: dict[str, Any]) -> str:
    return str((_as_dict(event.get("source"))).get("source_id") or "")


def _event_kind(event: dict[str, Any]) -> str:
    return str(event.get("event_kind") or "")


def _raw_payload(event: dict[str, Any]) -> dict[str, Any]:
    raw = _as_dict(event.get("raw"))
    payload = _as_dict(raw.get("raw_payload"))
    return dict(payload)


def _status_needs_review(event: dict[str, Any]) -> bool:
    return bool(_as_dict(event.get("status")).get("needs_review"))


def _operation_from_event(event: dict[str, Any]) -> str | None:
    raw = _raw_payload(event)
    side, recognized = determine_side(raw)
    return side if recognized else None


def _has_text(value: Any) -> bool:
    return value is not None and str(value).strip() not in {"", "None", "nan"}


def _is_non_zero(value: Any) -> bool:
    if value is None:
        return False
    try:
        return float(str(value).replace(",", ".")) != 0.0
    except Exception:
        return _has_text(value)


def _is_engine_ready_record(event: dict[str, Any]) -> bool:
    if not isinstance(event, dict) or _event_kind(event) != "trade" or _status_needs_review(event):
        return False
    if str(event.get("canonical_record_status") or "").lower() in {"incomplete", "unrecognized"}:
        return False
    date = _as_dict(event.get("date"))
    instrument = _as_dict(event.get("instrument"))
    amounts = _as_dict(event.get("amounts"))
    currency = str(amounts.get("currency") or "").strip().upper()
    return (
        _operation_from_event(event) in {"BUY", "SELL"}
        and any(_has_text(date.get(key)) for key in ("datetime", "trade_date", "settlement_date", "pay_date"))
        and any(_has_text(instrument.get(key)) for key in ("ticker", "isin", "name"))
        and _is_non_zero(amounts.get("quantity"))
        and currency not in {"", "UNKNOWN"}
        and any(_is_non_zero(amounts.get(key)) for key in ("price", "gross", "net", "amount"))
    )


def canonical_tax_input_has_engine_records(tax_input: dict[str, Any] | None) -> bool:
    if not isinstance(tax_input, dict) or tax_input.get("schema_version") not in {CANONICAL_TAX_INPUT_SCHEMA, LEGACY_CANONICAL_TAX_INPUT_SCHEMA}:
        return False
    split = split_engine_events_from_canonical_tax_input(tax_input)
    if split["engine_records"]:
        return True
    # Rok bez transakcji, za to z dywidenda albo odsetkami, ma co liczyc (czesc G
    # i koszty finansowania). Zapis bez daty nie ma kursu NBP, wiec nie wchodzi
    # do rozliczenia i nie czyni wejscia obliczeniowym.
    return any(
        _event_kind(event) in CALCULATED_SUPPORT_EVENT_KINDS and bool(_event_date_text(event))
        for event in split["support_records"]
    )


def zgodne_waluty_wykupu(pierwsza: Any, druga: Any) -> bool:
    """Ta sama waluta albo nieznana po jednej stronie - rowna liczba w innej walucie to inna kwota."""
    lewa, prawa = str(pierwsza or "").strip().upper(), str(druga or "").strip().upper()
    return not lewa or not prawa or lewa == prawa


def zgodne_kwoty_wykupu(pierwsza: Decimal | None, druga: Decimal | None) -> bool:
    """Ta sama kwota z dokladnoscia do grosza albo 0,1% - zapis tego samego wykupu w dwoch miejscach."""
    if pierwsza is None or druga is None:
        return False
    return abs(pierwsza - druga) <= max(Decimal("0.01"), abs(druga) * Decimal("0.001"))


def _with_maturity_sells(
    engine_records: list[dict[str, Any]], maturity_sells: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Dokleja wykupy, ktorych broker nie zapisal juz jako zwyklej sprzedazy."""

    def _quantity(event: dict[str, Any]) -> Decimal | None:
        try:
            return abs(Decimal(str(_as_dict(event.get("amounts")).get("quantity")).replace(",", ".")))
        except (InvalidOperation, ValueError):
            return None

    def _day(event: dict[str, Any]) -> datetime | None:
        try:
            return datetime.strptime(_event_date_text(event), "%Y-%m-%d")
        except ValueError:
            return None

    def _kwota(event: dict[str, Any], *nazwy: str) -> Decimal | None:
        amounts = _as_dict(event.get("amounts"))
        for nazwa in nazwy:
            try:
                wartosc = abs(Decimal(str(amounts.get(nazwa)).replace(",", ".")))
            except (InvalidOperation, ValueError):
                continue
            if wartosc > 0:
                return wartosc
        return None

    def _waluta(event: dict[str, Any]) -> str:
        return str(_as_dict(event.get("amounts")).get("currency") or "").strip().upper()

    existing_sells = [
        (
            _ticker_bez_rynku(event), _day(event), _quantity(event),
            _kwota(event, "price"), _kwota(event, "gross", "amount"), _waluta(event),
        )
        for event in engine_records
        if _operation_from_event(event) == "SELL"
    ]
    result = list(engine_records)
    for sell in maturity_sells:
        ticker, day, quantity = _ticker_bez_rynku(sell), _day(sell), _quantity(sell)
        cena, brutto, waluta = _kwota(sell, "price"), _kwota(sell, "gross", "amount"), _waluta(sell)
        # Echo wykupu to sprzedaz po cenie wykupu. Sam walor, ilosc i okno dni
        # lapaly tez zwykla sprzedaz tej samej ilosci z tych dni - wtedy wykup
        # pozostalych sztuk znikal razem z przychodem.
        already_recorded = any(
            other_ticker == ticker
            and other_quantity == quantity
            and day is not None
            and other_day is not None
            and abs((other_day - day).days) <= 3
            and zgodne_waluty_wykupu(other_currency, waluta)
            and (zgodne_kwoty_wykupu(other_price, cena) or zgodne_kwoty_wykupu(other_gross, brutto))
            for other_ticker, other_day, other_quantity, other_price, other_gross, other_currency in existing_sells
        )
        if not already_recorded:
            result.append(sell)
    return result


def split_engine_events_from_canonical_tax_input(tax_input: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    if tax_input.get("schema_version") not in {CANONICAL_TAX_INPUT_SCHEMA, LEGACY_CANONICAL_TAX_INPUT_SCHEMA}:
        return {"engine_records": [], "support_records": []}
    records = _as_dict(tax_input.get("records"))
    if tax_input.get("schema_version") == LEGACY_CANONICAL_TAX_INPUT_SCHEMA:
        return {
            "engine_records": [
                event
                for event in _as_list(records.get("_".join(["tax", "active", "events"])))
                if isinstance(event, dict) and _event_kind(event) == "trade" and not _status_needs_review(event)
            ],
            "support_records": [],
        }
    record_stream = _as_list(tax_input.get("records"))
    return {
        "engine_records": _with_maturity_sells(
            [event for event in record_stream if isinstance(event, dict) and _is_engine_ready_record(event)],
            maturity_sell_events(tax_input),
        ),
        "support_records": [
            event for event in record_stream if isinstance(event, dict) and _is_support_record(event)
        ],
    }


def count_event_kinds_in_canonical_tax_input(tax_input: Any, tax_year: int | None = None) -> dict[str, int]:
    """Liczy rodzaje zdarzen wprost w pliku wejsciowym.

    Celowo nie korzysta z `split_engine_events_from_canonical_tax_input`: bramka
    pokrycia kategorii ma wykryc miedzy innymi to, ze podzial przestal zwracac
    zdarzenia wspierajace. Gdyby liczyla jego wynikiem, awaria wyzerowalaby obie
    strony porownania i przeszlaby niezauwazona - dokladnie tak, jak sie stalo.
    """
    if not isinstance(tax_input, dict):
        return {}
    if tax_input.get("schema_version") not in {CANONICAL_TAX_INPUT_SCHEMA, LEGACY_CANONICAL_TAX_INPUT_SCHEMA}:
        return {}

    if tax_input.get("schema_version") == LEGACY_CANONICAL_TAX_INPUT_SCHEMA:
        stream = _as_list(_as_dict(tax_input.get("records")).get("_".join(["tax", "active", "events"])))
    else:
        stream = _as_list(tax_input.get("records"))

    counts: dict[str, int] = defaultdict(int)
    for event in stream:
        if not isinstance(event, dict):
            continue
        kind = _event_kind(event)
        if not kind or kind == "trade":
            continue
        # Artefakty wyniku sa zawezone do wybranego roku, wiec wejscie tez musi
        # byc. Po poszerzeniu wejscia o lata wczesniejsze bramka porownywala
        # zdarzenia z kilku lat z wynikiem jednego i potrafila zatrzymac
        # poprawne rozliczenie - na przyklad gdy dywidendy byly tylko w roku
        # poprzednim.
        if tax_year is not None:
            date_text = _event_date_text(event)
            if not date_text or not date_text[:4].isdigit() or int(date_text[:4]) != tax_year:
                continue
        counts[kind] += 1
    return dict(sorted(counts.items()))


def _event_to_legacy_row(event: dict[str, Any]) -> dict[str, Any]:
    row = _raw_payload(event)
    source = _as_dict(event.get("source"))
    identity = _as_dict(event.get("identity"))
    row.setdefault("source_event_id", event.get("event_id"))
    row.setdefault("source_manifest_id", source.get("source_id"))
    row.setdefault("source_section", source.get("section"))
    row.setdefault("source_json_path", source.get("json_path"))
    row.setdefault("source_row", source.get("row"))
    row.setdefault("source_filename", source.get("filename"))
    if identity.get("trade_id"):
        row.setdefault("id", identity.get("trade_id"))
    if identity.get("order_id"):
        row.setdefault("order_id", identity.get("order_id"))
    if identity.get("trade_nb"):
        row.setdefault("trade_nb", identity.get("trade_nb"))
    if _rachunek_zdarzenia(event):
        row.setdefault("account_id", _rachunek_zdarzenia(event))
    return row


def _entry_key(event: dict[str, Any], source_name: str) -> tuple[str, str, str]:
    source = _as_dict(event.get("source"))
    source_file = str(source.get("relative_path") or source.get("filename") or "canonical_tax_input.json")
    source_sheet = str(source.get("sheet") or source.get("section") or "canonical_tax_input")
    return source_name, source_file, source_sheet


def build_parsed_sources_from_canonical_tax_input(
    tax_input: dict[str, Any] | None,
    *,
    canonical_mode: str = "prefer",
    tax_year: int | None = None,
    review_decisions: Any = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    required_mode = str(canonical_mode or "prefer").lower() == "required"
    if not isinstance(tax_input, dict):
        return [], {
            "status": "required_missing" if required_mode else "fallback_legacy",
            "reason": "canonical_tax_input missing",
            "engineInputMode": "required" if required_mode else "prefer",
            "legacyFallbackUsed": not required_mode,
            "consumedByEngine": False,
            "consumedTradeEvents": 0,
            "consumedSupportEvents": 0,
        }
    if tax_input.get("schema_version") not in {CANONICAL_TAX_INPUT_SCHEMA, LEGACY_CANONICAL_TAX_INPUT_SCHEMA}:
        return [], {
            "status": "invalid_contract",
            "reason": "canonical_tax_input schema_version mismatch",
            "engineInputMode": "required" if required_mode else "prefer",
            "legacyFallbackUsed": False,
            "consumedByEngine": False,
            "consumedTradeEvents": 0,
            "consumedSupportEvents": 0,
        }

    split = split_engine_events_from_canonical_tax_input(tax_input)
    grouped_rows: dict[tuple[str, str, str], list[dict[str, Any]]] = defaultdict(list)
    skipped: list[dict[str, Any]] = []

    tradeable_events: list[dict[str, Any]] = []
    for event in split["engine_records"]:
        operation = _operation_from_event(event)
        if operation not in {"BUY", "SELL"}:
            skipped.append({"eventId": event.get("event_id"), "reason": "record has no BUY/SELL operation"})
            continue
        tradeable_events.append(event)

    tradeable_events, duplicate_events = deduplicate_trade_events(tradeable_events)
    source_quantity_conflicts = [
        row for row in duplicate_events if str(row.get("code") or "").startswith("OVERLAPPING_SOURCE_")
    ]
    duplicate_events = [row for row in duplicate_events if not row.get("code")]
    skipped.extend(duplicate_events)

    for event in tradeable_events:
        key = _entry_key(event, CANONICAL_TAX_INPUT_TRADE_SOURCE)
        grouped_rows[key].append(_event_to_legacy_row(event))

    support_events, duplicate_support, undated_support = deduplicate_support_events(split["support_records"])
    skipped.extend(
        {
            "eventId": event.get("event_id"),
            "parser": _event_parser(event),
            "filename": _as_dict(event.get("source")).get("filename"),
            "reason": "duplicate support event already covered by a more reliable source",
        }
        for event in duplicate_support
    )
    skipped.extend(
        {
            "eventId": event.get("event_id"),
            "parser": _event_parser(event),
            "filename": _as_dict(event.get("source")).get("filename"),
            "eventKind": _event_kind(event),
            "comment": _event_comment(event)[:160],
            "reason": "support event has no date, so it has no NBP rate and cannot enter the settlement",
        }
        for event in undated_support
    )

    # Liczba zdarzen kazdego rodzaju, ktora wchodzi do silnika. Bramka pokrycia
    # kategorii porownuje ja z artefaktami wyniku - to jedyny automat wykrywajacy
    # "cala kategoria zniknela po cichu".
    support_events_by_kind: dict[str, int] = defaultdict(int)
    for event in support_events:
        support_events_by_kind[_event_kind(event) or "unknown"] += 1
        key = _entry_key(event, CANONICAL_TAX_INPUT_EVENT_SOURCE)
        grouped_rows[key].append(_event_to_legacy_row(event))

    parsed = [
        {
            "source": source_name,
            "source_file": source_file,
            "source_sheet": source_sheet,
            "rows": rows,
        }
        for (source_name, source_file, source_sheet), rows in sorted(grouped_rows.items())
    ]
    consumed_trade_events = sum(1 for entry in parsed if entry["source"] == CANONICAL_TAX_INPUT_TRADE_SOURCE for _ in entry["rows"])
    consumed_support_events = sum(
        1 for entry in parsed if entry["source"] == CANONICAL_TAX_INPUT_EVENT_SOURCE for _ in entry["rows"]
    )
    status = "used" if parsed else ("required_no_records" if required_mode else "fallback_legacy")
    reason = "canonical_tax_input consumed by tax engine" if parsed else "canonical_tax_input has no consumable records"
    return parsed, {
        "status": status,
        "reason": reason,
        "inputFile": "canonical_tax_input.json",
        "engineInputMode": "required" if required_mode else "prefer",
        "legacyFallbackUsed": (not required_mode and not parsed),
        "consumedByEngine": bool(parsed),
        "consumedTradeEvents": consumed_trade_events,
        "consumedSupportEvents": consumed_support_events,
        "supportEventsByKind": dict(sorted(support_events_by_kind.items())),
        "recordsHeldForReviewByKind": records_held_for_review(tax_input),
        "recordsAwaitingUserDecisionBlockingByKind": records_awaiting_decision_impact(
            tax_input, tax_year, review_decisions
        )[0],
        "recordsAwaitingUserDecisionWarningByKind": records_awaiting_decision_impact(
            tax_input, tax_year, review_decisions
        )[1],
        "reviewQueue": review_queue(tax_input, tax_year, review_decisions),
        "reviewDecisionsApplied": len(
            [row for row in review_queue(tax_input, tax_year, review_decisions) if row["decision"]]
        ),
        "availableSupportEventsByKind": count_event_kinds_in_canonical_tax_input(tax_input, tax_year),
        "deduplicatedTradeEvents": len(duplicate_events),
        "sourceQuantityConflicts": source_quantity_conflicts,
        "deduplicatedSupportEvents": len(duplicate_support),
        # Zapisy bez daty trafiaja do silnika, ale nie da sie ich zdeduplikowac,
        # wiec wymagaja przegladu uzytkownika.
        "supportEventsWithoutDate": len(undated_support),
        "skipped": skipped,
    }
