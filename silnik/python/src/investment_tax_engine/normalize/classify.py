from __future__ import annotations

import re
from decimal import Decimal

from investment_tax_engine.normalize.kody_krajow import KODY_KRAJOW_MF


SYMBOL_PATTERN = re.compile(r"([A-Z0-9]+(?:[./-][A-Z0-9]+)+)")
TRADE_ID_PATTERN = re.compile(r"(?:\bTrade\b|\btransakcj\w*\b)\s*[:#]?\s*(\d+)", re.IGNORECASE)


def clean_text(value: object) -> str:
    return " ".join(str(value or "").split()).strip()


# Najczestsze waluty wirtualne i stablecoiny. Lista jest awaryjna - wlasciwym
# zrodlem jest znacznik CRYPTO ustawiany przez aplikacje, ktora zna kategorie
# instrumentu. Sluzy temu, zeby plik z gieldy krypto nie przeszedl po cichu
# jako akcje.
WALUTY_WIRTUALNE = {
    "BTC", "ETH", "SOL", "ADA", "XRP", "DOGE", "DOT", "AVAX", "MATIC", "LTC",
    "BCH", "LINK", "UNI", "ATOM", "XLM", "TRX", "ETC", "FIL", "NEAR", "ALGO",
    "USDT", "USDC", "BUSD", "DAI", "TUSD", "BNB", "FDUSD", "USDP",
    "PYUSD", "EURC", "EURI", "AEUR", "XUSD", "SUI", "TON", "SHIB",
    "PEPE", "AAVE", "ARB", "OP", "APT", "INJ", "RENDER", "POL",
    "WIF", "BONK", "FET", "ICP", "HBAR", "VET", "USDD", "RLUSD",
}


#: Klasy papierow wysylane przez aplikacje dla transakcji recznych (engineBridge).
TYPY_PAPIEROW_APLIKACJI = {"STOCK", "ETF", "BOND"}

#: PLN oraz kody z tabeli A NBP; nieznany kod nie staje sie automatycznie krypto.
WALUTY_URZEDOWE = {
    "PLN", "THB", "USD", "AUD", "HKD", "CAD", "NZD", "SGD", "EUR", "HUF",
    "CHF", "GBP", "UAH", "JPY", "CZK", "DKK", "ISK", "NOK", "SEK", "RON",
    "TRY", "ILS", "CLP", "PHP", "MXN", "ZAR", "BRL", "MYR", "IDR", "INR",
    "KRW", "CNY", "XDR",
}

_PARA_WALUT = re.compile(r"^([A-Z]{3})[/.\-]?([A-Z]{3})$")


def czy_para_walut(symbol: str) -> bool:
    """EUR/USD, EUR.USD, EURUSD - dwie rozne waluty urzedowe to wymiana walut, nie papier."""
    dopasowanie = _PARA_WALUT.match((symbol or "").strip().upper())
    return bool(dopasowanie) and dopasowanie.group(1) != dopasowanie.group(2) and {
        dopasowanie.group(1), dopasowanie.group(2)
    } <= WALUTY_URZEDOWE


def _czy_waluta_wirtualna(symbol: str) -> bool:
    tekst = (symbol or "").strip().upper()
    if not tekst:
        return False
    if tekst.endswith(".CC") or tekst.endswith("-USD") and tekst[:-4] in WALUTY_WIRTUALNE:
        return True
    # Sufiksy gieldowe (.WA, .US itd.) moga miec ten sam rdzen co token.
    if "." in tekst:
        return False
    rdzen = tekst.split(".")[0].split("/")[0].split("-")[0]
    if rdzen in WALUTY_WIRTUALNE:
        return True
    # Pary z gieldy krypto zapisywane bez separatora, np. BTCUSDT.
    for kwotowana in ("USDT", "USDC", "FDUSD", "BUSD", "USDP", "PYUSD", "EURC", "EURI", "AEUR", "XUSD", "BTC", "ETH", "BNB", "PLN", "USD", "EUR"):
        if tekst.endswith(kwotowana) and tekst[: -len(kwotowana)] in WALUTY_WIRTUALNE:
            return True
    return False


def infer_instrument_class(
    symbol: str,
    instrument_type_code: str | None,
    otc: bool,
    repo_close: bool | None,
    base_contract_code: str | None,
) -> str:
    normalized_symbol = clean_text(symbol).upper()
    normalized_type = clean_text(instrument_type_code)
    normalized_base_contract = clean_text(base_contract_code).upper()

    # Waluty wirtualne rozliczaja sie inaczej niz papiery (czesc E PIT-38,
    # art. 22 ust. 14-15 ustawy o PIT: koszt w roku poniesienia, bez FIFO).
    # Bez tej reguly symbol z gieldy krypto w rodzaju "BTCUSDT" wpadal do klasy
    # EQUITY i trafial do kolejki FIFO czesci C - czyli do zlej sekcji
    # deklaracji. Znacznik CRYPTO ustawia aplikacja, ktora zna kategorie
    # instrumentu; lista symboli jest awaryjna dla plikow bez tej informacji.
    typ = normalized_type.upper()
    if typ == "CRYPTO":
        return "CRYPTO"
    # Papier wskazany jawnie w aplikacji (transakcje reczne portfela): ticker
    # kolidujacy z tokenem (akcja FET) albo z ukosnikiem (BRK/B) nie zmienia
    # klasy. Noty DGT i kontrakty zachowuja wlasna klase.
    if typ in TYPY_PAPIEROW_APLIKACJI:
        # Import CSV nie ma kategorii FX - para walutowa przychodzi jako STOCK,
        # a nie jest papierem wartosciowym (czesc C). BRK/B zostaje akcja.
        if czy_para_walut(normalized_symbol):
            return "FX"
        if normalized_symbol.startswith("DGT") or normalized_base_contract:
            return "STRUCTURED_PRODUCT"
        return "EQUITY"
    # Lista tokenow jest awaryjna tylko dla plikow bez typu instrumentu - kod
    # typu brokera (np. Freedom24) wyklucza zgadywanie krypto po symbolu.
    if not typ and _czy_waluta_wirtualna(normalized_symbol):
        return "CRYPTO"
    if normalized_type == "6" or "/" in normalized_symbol:
        return "FX"
    if normalized_type == "18" or normalized_symbol == "FRHC.US":
        return "REPO"
    if normalized_type == "19" or normalized_symbol.startswith("DGT") or normalized_base_contract:
        return "STRUCTURED_PRODUCT"
    if otc:
        return "OTHER"
    return "EQUITY"


def infer_logical_world_for_trade(instrument_class: str) -> str:
    if instrument_class == "CRYPTO":
        return "crypto_tax"
    if instrument_class == "FX":
        return "private_cash_fx"
    if instrument_class == "REPO":
        return "diagnostic_only"
    if instrument_class in {"EQUITY", "STRUCTURED_PRODUCT"}:
        return "equity_tax"
    return "diagnostic_only"


def infer_acquisition_mode(instrument_class: str) -> str:
    if instrument_class == "REPO":
        return "REPO"
    if instrument_class == "STRUCTURED_PRODUCT":
        return "STRUCTURED_PRODUCT"
    return "STANDARD"


def infer_country_from_symbol(symbol: str) -> str | None:
    normalized_symbol = clean_text(symbol).upper()
    if normalized_symbol.endswith(".US"):
        return "US"
    # Polska gielda: .PL (Freedom24) i .WA (Warszawa). Bez tego dywidenda
    # polskiego emitenta miala kraj nieustalony i liczyla sie jak zagraniczna.
    if normalized_symbol.endswith((".PL", ".WA")):
        return "PL"
    return None


def infer_country_from_isin(isin: str | None) -> str | None:
    """Panstwo z prefiksu ISIN - dwie pierwsze litery to kod ISO 3166-1 alfa-2.

    Prefiks nadaje krajowa agencja numerujaca, wiec jest pewniejszy niz
    koncowka tickera: ten sam walor bywa notowany pod roznymi symbolami.
    """
    normalized = clean_text(isin).upper()
    if len(normalized) < 2:
        return None
    prefix = normalized[:2]
    # XS, EU czy XA-XF to prefiksy agencji numerujacych, nie panstwa - takiego
    # kodu nie ma w slowniku KodyKrajow, wiec PIT/ZG z nim jest odrzucany.
    return prefix if prefix in KODY_KRAJOW_MF else None


_ISIN = re.compile(r"^[A-Z]{2}[A-Z0-9]{9}[0-9]$")


def infer_country(symbol: str, isin: str | None = None) -> str | None:
    """Panstwo zrodla dochodu. Potrzebne do zalacznika PIT/ZG, ktory sklada
    sie odrebnie dla kazdego panstwa.

    Prawdziwy ISIN papieru miedzynarodowego (XS...) mowi wprost, ze panstwa nie
    da sie odczytac z numeru - wtedy nie zgadujemy go z koncowki tickera, tylko
    zostawiamy do ustalenia przez uzytkownika.
    """
    z_isin = infer_country_from_isin(isin)
    if z_isin:
        return z_isin
    if _ISIN.match(clean_text(isin).upper()):
        return None
    return infer_country_from_symbol(symbol)


def extract_trade_id(comment: str | None) -> str | None:
    if not comment:
        return None
    match = TRADE_ID_PATTERN.search(comment)
    return match.group(1) if match else None


def extract_symbol(comment: str | None) -> str | None:
    if not comment:
        return None
    candidates = SYMBOL_PATTERN.findall(comment.upper())
    if not candidates:
        return None
    for candidate in candidates:
        if candidate in {"NO.63758878", "NO.62500164"}:
            continue
        return candidate
    return candidates[0]


# Frazy rozpoznajace kategorie kosztow. Wyciagniete obok regul, zeby dalo sie je
# uzupelniac bez grzebania w logice klasyfikacji.
OPLATY_RACHUNKU_PL = (
    "oplata za prowadzenie",
    "opłata za prowadzenie",
    "oplata za rachunek",
    "opłata za rachunek",
    "oplata depozytowa",
    "opłata depozytowa",
    "oplata abonamentowa",
    "opłata abonamentowa",
    "oplata za przechowywanie",
    "opłata za przechowywanie",
)
OPLATY_RACHUNKU_EN = (
    "account maintenance",
    "maintenance fee",
    "custody fee",
    "platform fee",
    "account fee",
    "inactivity fee",
    "safekeeping fee",
)
PRZEWALUTOWANIE_PL = ("przewalutowanie", "wymiana waluty", "konwersja waluty")
PRZEWALUTOWANIE_EN = ("currency conversion", "fx fee", "conversion fee", "currency exchange fee")
# Odsetki od kredytu albo pozyczki bez sladu rachunku maklerskiego: z wyciagu bankowego
# moga pochodzic z kredytu hipotecznego czy gotowkowego. Automatyczne doliczanie ich do
# kosztow zbycia papierow wymaga dowodu, ze kredyt sfinansowal inwestycje (art. 22 ust. 1).
ODSETKI_OD_KREDYTU = (
    "odsetki od kredytu",
    "odsetki od pozyczki",
    "odsetki od pożyczki",
    "loan interest",
)
ZNACZNIKI_RACHUNKU_MAKLERSKIEGO = ("margin", "maklersk", "brokerage", "debit", "debet")

ODSETKI_KOSZTOWE_PL = (
    "odsetki od kredytu",
    "odsetki od pozyczki",
    "odsetki od pożyczki",
    "odsetki debetowe",
    "odsetki od debetu",
    "odsetki naliczone",
)
ODSETKI_KOSZTOWE_EN = (
    "margin interest",
    "margin loan",
    "loan interest",
    "interest on margin",
    "debit interest",
    "interest charged",
)


def classify_event_fields(kind_text: str, comment: str | None, amount: Decimal) -> dict[str, str | None]:
    normalized_kind = clean_text(kind_text).lower()
    normalized_comment = clean_text(comment).lower()

    if "block_commission" in normalized_kind or "blokowanie prowizji" in normalized_kind:
        return {
            "event_kind": "BLOCK",
            "logical_world": "diagnostic_only",
            "cost_bucket": None,
            "cost_class": "DIAGNOSTIC",
        }

    if "unblock_commission" in normalized_kind or "odblokowanie prowizj" in normalized_kind:
        return {
            "event_kind": "UNBLOCK",
            "logical_world": "diagnostic_only",
            "cost_bucket": None,
            "cost_class": "DIAGNOSTIC",
        }

    if "prowizja za transakcje" in normalized_kind:
        return {
            "event_kind": "TRADE_FEE",
            "logical_world": "equity_tax",
            "cost_bucket": "RECONSTRUCTED_COMMISSION",
            "cost_class": "CERTAIN",
        }

    # Odsetki OTRZYMANE od wolnych srodkow na rachunku - przychod z art. 30a
    # ust. 1 pkt 3 ustawy o PIT. Musi stac przed regula ujemnego salda, bo obie
    # mowia o odsetkach; tamta dotyczy odsetek zaplaconych, czyli kosztu.
    # Zryczaltowany podatek od tego przychodu zaokragla sie inaczej niz reszta
    # formularza: do pelnych groszy w gore (art. 63 par. 1a Ordynacji).
    if amount >= 0 and (
        "odsetki od wolnych" in normalized_kind
        or "interest on free" in normalized_comment
        or "interest on cash balance" in normalized_comment
        or "savings interest" in normalized_comment
        or ("odsetki" in normalized_kind and "ujemne" not in normalized_kind)
    ):
        return {
            "event_kind": "CREDIT_INTEREST",
            "logical_world": "equity_tax",
            "cost_bucket": None,
            "cost_class": "CERTAIN",
        }

    if "ujemne saldo" in normalized_kind or "negative cash balance" in normalized_comment:
        return {
            "event_kind": "NEGATIVE_CASH_FEE",
            "logical_world": "financing_costs",
            "cost_bucket": "NEGATIVE_BALANCE_INTEREST",
            "cost_class": "CONDITIONAL",
        }

    # Dywidenda i podatek u zrodla rozstrzygaja sie razem, bo ich nazwy sie
    # zazebiaja: "Podatek u zrodla od dywidendy" zawiera oba slowa. Pierwszenstwo
    # ma pole rodzaju zdarzenia, bo to ono opisuje operacje; komentarz decyduje
    # dopiero wtedy, gdy rodzaj nic nie mowi. Wczesniej regula dywidendy stala
    # pierwsza i przejmowala podatek u zrodla - koszt stawal sie przychodem.
    wynik_dywidendy = {
        "event_kind": "DIVIDEND",
        "logical_world": "equity_tax",
        "cost_bucket": None,
        "cost_class": "CERTAIN",
    }
    wynik_podatku = {
        "event_kind": "TAX",
        "logical_world": "equity_tax",
        "cost_bucket": "SOURCE_TAX",
        "cost_class": "CERTAIN",
    }
    # Uwaga na odmiane: wzorzec "podatk" NIE pasuje do mianownika "podatek"
    # (p-o-d-a-t-e-k), a wlasnie tak brokerzy najczesciej nazywaja te operacje.
    # Przez to "Podatek u zrodla od dywidendy" wpadal wczesniej do dywidend.
    FORMY_PODATKU = ("podatek", "podatku", "podatki", "podatkow", "podatkiem", "podatków")
    rodzaj_o_podatku = (
        any(forma in normalized_kind for forma in FORMY_PODATKU)
        or "withholding" in normalized_kind
    )
    rodzaj_o_dywidendzie = "dywid" in normalized_kind or "dividend" in normalized_kind
    komentarz_o_podatku = (
        "corporate action tax" in normalized_comment
        or "withholding" in normalized_comment
        or any(forma in normalized_comment for forma in FORMY_PODATKU)
        or "podatek u \u017ar\u00f3d\u0142a" in normalized_comment
    )
    komentarz_o_dywidendzie = "dividend" in normalized_comment or "dywid" in normalized_comment

    if rodzaj_o_podatku:
        return wynik_podatku
    if rodzaj_o_dywidendzie:
        return wynik_dywidendy
    if komentarz_o_podatku:
        return wynik_podatku
    if komentarz_o_dywidendzie:
        return wynik_dywidendy

    # Oplaty za prowadzenie rachunku i przechowywanie papierow. Bez tej reguly
    # wpadaly do workowej regulyy "ujemna kwota" na koncu funkcji, ktora oznacza
    # zdarzenie jako czysto diagnostyczne - czyli nigdy nie trafialy do kosztow,
    # mimo ze przelacznik "oplaty za rachunek" sugerowal uzytkownikowi, ze trafia.
    if any(fraza in normalized_kind for fraza in OPLATY_RACHUNKU_PL) or any(
        fraza in normalized_comment for fraza in OPLATY_RACHUNKU_EN
    ):
        return {
            "event_kind": "ACCOUNT_FEE",
            "logical_world": "equity_tax",
            "cost_bucket": "ACCOUNT_FEE",
            "cost_class": "CONDITIONAL",
        }

    # Prowizja i spread za przewalutowanie srodkow na potrzeby zakupu papieru
    # albo powrotu do zlotego po sprzedazy.
    if any(fraza in normalized_kind for fraza in PRZEWALUTOWANIE_PL) or any(
        fraza in normalized_comment for fraza in PRZEWALUTOWANIE_EN
    ):
        return {
            "event_kind": "FX_CONVERSION_FEE",
            "logical_world": "equity_tax",
            "cost_bucket": "FX_CONVERSION_FEE",
            "cost_class": "CONDITIONAL",
        }

    # Odsetki ZAPLACONE od kredytu albo pozyczki pod zakup papierow. Musi stac
    # przed regula odsetek otrzymanych, bo tamta lapie kazde "odsetki" bez slowa
    # "ujemne" - przez co odsetki od kredytu maklerskiego byly ksiegowane jako
    # przychod z art. 30a i opodatkowane, zamiast pomniejszac dochod.
    saldo_ujemne = "ujemne saldo" in normalized_kind or "negative cash balance" in normalized_comment
    znacznik_maklerski = any(
        znacznik in normalized_kind or znacznik in normalized_comment for znacznik in ZNACZNIKI_RACHUNKU_MAKLERSKIEGO
    )
    if not saldo_ujemne and not znacznik_maklerski and any(
        fraza in normalized_kind or fraza in normalized_comment for fraza in ODSETKI_OD_KREDYTU
    ):
        return {
            "event_kind": "LOAN_INTEREST",
            "logical_world": "financing_costs",
            "cost_bucket": "LOAN_INTEREST",
            "cost_class": "CONDITIONAL",
        }
    if not saldo_ujemne and (
        any(fraza in normalized_kind for fraza in ODSETKI_KOSZTOWE_PL)
        or any(fraza in normalized_comment for fraza in ODSETKI_KOSZTOWE_EN)
        or any(fraza in normalized_kind for fraza in ODSETKI_KOSZTOWE_EN)
        or (("odsetki" in normalized_kind or "interest" in normalized_kind) and amount < 0)
    ):
        return {
            "event_kind": "MARGIN_INTEREST",
            "logical_world": "financing_costs",
            "cost_bucket": "MARGIN_INTEREST",
            "cost_class": "CONDITIONAL",
        }

    if "termin zapadalności" in normalized_kind or "redemption of securities" in normalized_comment:
        return {
            "event_kind": "MATURITY",
            "logical_world": "equity_tax",
            "cost_bucket": None,
            "cost_class": "CERTAIN",
        }

    if "spłata zadłużenia" in normalized_kind or "debt coverage" in normalized_comment:
        return {
            "event_kind": "DEBT_REPAYMENT",
            "logical_world": "financing_repayment",
            "cost_bucket": None,
            "cost_class": "DIAGNOSTIC",
        }

    if "przelew bankowy" in normalized_kind or "blik" in normalized_kind:
        return {
            "event_kind": "BANK_TRANSFER",
            "logical_world": "private_cash_fx",
            "cost_bucket": None,
            "cost_class": "DIAGNOSTIC",
        }

    if "przelew wewnątrzny" in normalized_kind or "intercompany" in normalized_comment:
        return {
            "event_kind": "INTERNAL_TRANSFER",
            "logical_world": "diagnostic_only",
            "cost_bucket": None,
            "cost_class": "DIAGNOSTIC",
        }

    if "blokada" in normalized_kind and "prowiz" not in normalized_kind:
        return {
            "event_kind": "BLOCK",
            "logical_world": "diagnostic_only",
            "cost_bucket": None,
            "cost_class": "DIAGNOSTIC",
        }

    if "odblokowanie" in normalized_kind and "prowiz" not in normalized_kind:
        return {
            "event_kind": "UNBLOCK",
            "logical_world": "diagnostic_only",
            "cost_bucket": None,
            "cost_class": "DIAGNOSTIC",
        }

    if "inne prowizje" in normalized_kind or "order fee" in normalized_comment or "commission for withdrawal" in normalized_comment:
        return {
            "event_kind": "FUNDING_TRANSFER_FEE",
            "logical_world": "financing_costs",
            "cost_bucket": "FUNDING_TRANSFER_FEE",
            "cost_class": "CONDITIONAL",
        }

    if amount < 0:
        return {
            "event_kind": "OTHER",
            "logical_world": "diagnostic_only",
            "cost_bucket": "FX_SPREAD_DIAGNOSTIC",
            "cost_class": "DIAGNOSTIC",
        }

    return {
        "event_kind": "OTHER",
        "logical_world": "diagnostic_only",
        "cost_bucket": None,
        "cost_class": "DIAGNOSTIC",
    }
