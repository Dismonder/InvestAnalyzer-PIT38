from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation
from functools import lru_cache
from pathlib import Path
from typing import Any


# Taryfa podaje stawke jako procent dzienny, np. "Margin rate (per day) 0.041095%".
# Jeden wiersz moze zawierac kilka progow - po jednym na plan uzytkownika.
_MARGIN_RATE_LINE = re.compile(r"margin\s+rate\s*\(per\s+day\)(?P<values>[^\n]*)", re.IGNORECASE)
_PERCENT_VALUE = re.compile(r"(\d+(?:[.,]\d+)?)\s*%")

# Stawka dzienna ponizej 1% - wyzsze liczby to nie oprocentowanie dzienne, tylko
# przypadkowe dopasowanie do innej kolumny tabeli.
MAX_PLAUSIBLE_DAILY_RATE_PERCENT = Decimal("1")


@lru_cache(maxsize=8)
def _read_pdf_text_cached(path_text: str, signature: tuple[int, int]) -> str:
    del signature  # czesc klucza cache, nie parametr odczytu
    try:
        from pypdf import PdfReader
    except ImportError:
        return ""
    try:
        reader = PdfReader(path_text)
        return "\n".join(page.extract_text() or "" for page in reader.pages)
    except Exception:
        return ""


def read_pdf_text(path: Path) -> str:
    """Tekst z pliku PDF albo pusty napis, gdy pliku nie da sie odczytac.

    Odczyt taryfy jest kontrola spojnosci, a nie zrodlem kwoty podatku, wiec
    brak biblioteki albo uszkodzony plik nie moze zatrzymac rozliczenia.

    Wynik jest pamietany dla danej wersji pliku - rozmiar i czas modyfikacji
    sa czescia klucza, wiec podmiana taryfy uniewaznia cache. Parsowanie
    dziesieciostronicowego PDF kosztuje okolo 400 ms i wchodzilo w kazdy
    przebieg silnika, a taryfa zmienia sie raz na jakis czas.
    """
    try:
        stat = path.stat()
    except OSError:
        return ""
    return _read_pdf_text_cached(str(path), (stat.st_size, int(stat.st_mtime_ns)))


def extract_daily_margin_rates(path: Path) -> list[Decimal]:
    """Dzienne stawki za ujemne saldo, odczytane wprost z taryfy.

    Zwraca ulamki dzienne, nie procenty: 0.041095% -> Decimal("0.00041095").
    """
    text = read_pdf_text(path)
    if not text:
        return []

    rates: list[Decimal] = []
    for line in _MARGIN_RATE_LINE.finditer(text):
        for raw_value in _PERCENT_VALUE.findall(line.group("values")):
            try:
                percent = Decimal(raw_value.replace(",", "."))
            except (InvalidOperation, ValueError):
                continue
            if percent <= 0 or percent > MAX_PLAUSIBLE_DAILY_RATE_PERCENT:
                continue
            rate = percent / Decimal("100")
            if rate not in rates:
                rates.append(rate)
    return sorted(rates)


def format_rate_as_percent(rate: Decimal) -> str:
    """Ulamek dzienny z powrotem na procent, tak jak zapisuje go taryfa."""
    percent = (rate * Decimal("100")).normalize()
    return f"{percent:f}%"


def classify_pdf_as_tariff_evidence(path: Path) -> dict[str, Any]:
    """Opis taryfy do pakietu dowodowego wraz z odczytanymi stawkami."""
    rates = extract_daily_margin_rates(path)
    readable = bool(read_pdf_text(path))
    if rates:
        summary = (
            "Taryfa oplat brokera. Odczytane dzienne stawki za ujemne saldo: "
            + ", ".join(format_rate_as_percent(rate) for rate in rates)
            + ". Sluza wylacznie do kontroli spojnosci naliczen, nie naliczaja kosztow PIT."
        )
    elif readable:
        summary = (
            "Taryfa oplat brokera. Nie znaleziono w niej dziennej stawki za ujemne saldo, "
            "wiec kontrola spojnosci naliczen opiera sie na opisach brokera."
        )
    else:
        summary = "PDF taryf/oplat jest dowodem. Treści nie udalo sie odczytac, wiec nie ma z czym porownac naliczen."

    return {
        "schema_version": "ai.extracted_context.v1",
        "source_event_id": f"pdf:{path.name}",
        "detected_context_type": "tariff_rule",
        "related_trade_id": None,
        "related_order_id": None,
        "related_ticker": None,
        "operation": "unknown",
        "fee_type": "NEGATIVE_BALANCE_INTEREST" if rates else None,
        "amount": None,
        "currency": None,
        "extracted_terms": {"daily_margin_rates": [str(rate) for rate in rates]},
        "summary_pl": summary,
        # Odczyt z pliku, a nie stala w kodzie: pewnosc zalezy od tego, czy
        # cokolwiek udalo sie odczytac.
        "confidence": 1.0 if rates else (0.4 if readable else 0.0),
        "needs_user_review": not rates,
        "warnings": [] if rates else ["Nie odczytano dziennej stawki za ujemne saldo z taryfy."],
    }


__all__ = [
    "classify_pdf_as_tariff_evidence",
    "format_rate_as_percent",
    "extract_daily_margin_rates",
    "read_pdf_text",
]
