from __future__ import annotations

from decimal import Decimal
from pathlib import Path

import pandas as pd

from zestaw_wejsciowy import zestaw_wejsciowy

from investment_tax_engine.ai.pdf_tariff_extractor import (
    _read_pdf_text_cached,
    classify_pdf_as_tariff_evidence,
    extract_daily_margin_rates,
    format_rate_as_percent,
    read_pdf_text,
)
from investment_tax_engine.models.core import CanonicalEvent
from investment_tax_engine.tax.financing_ledger import build_financing_ledger, check_rates_against_tariff


# Taryfa uzytkownika, gdy lezy na dysku, inaczej syntetyczna z tymi samymi
# progami. Test konczyl sie wczesniej `return`-em przy braku pliku, wiec na
# swiezym klonie przechodzil, nie odczytujac zadnego PDF - a to on jest jedynym
# dowodem, ze stawka pochodzi z taryfy, a nie ze stalej w kodzie.
TARIFF_PDF = zestaw_wejsciowy().tariff_pdf


def test_daily_margin_rates_are_read_from_the_tariff():
    """Stawka byla wpisana w kod jako stala; taryfa podaje dwa progi."""
    rates = extract_daily_margin_rates(TARIFF_PDF)

    assert Decimal("0.00041095") in rates
    assert Decimal("0.00049315") in rates


def test_a_missing_tariff_does_not_stop_anything():
    """Odczyt taryfy to kontrola spojnosci, nie zrodlo kwoty podatku."""
    assert extract_daily_margin_rates(Path("nie-ma-takiego-pliku.pdf")) == []


def test_a_file_that_is_not_a_pdf_returns_no_rates(tmp_path):
    fake = tmp_path / "Stawki.pdf"
    fake.write_text("to nie jest PDF", encoding="utf-8")

    assert extract_daily_margin_rates(fake) == []


def test_evidence_description_reports_what_was_actually_read():
    described = classify_pdf_as_tariff_evidence(TARIFF_PDF)

    assert described["extracted_terms"]["daily_margin_rates"] == ["0.00041095", "0.00049315"]
    assert described["needs_user_review"] is False
    assert "0.041095%" in described["summary_pl"]


def test_evidence_description_admits_when_nothing_was_read(tmp_path):
    """Wczesniej zwracalo confidence 1.0, nie otwierajac pliku ani razu."""
    fake = tmp_path / "Stawki.pdf"
    fake.write_bytes(b"nie PDF")

    described = classify_pdf_as_tariff_evidence(fake)

    assert described["extracted_terms"]["daily_margin_rates"] == []
    assert described["confidence"] == 0.0
    assert described["needs_user_review"] is True
    assert described["warnings"]


def test_percent_formatting_matches_the_tariff_notation():
    assert format_rate_as_percent(Decimal("0.00041095")) == "0.041095%"
    assert format_rate_as_percent(Decimal("0.00049315")) == "0.049315%"


def _charge(day: str, amount: str, comment: str) -> CanonicalEvent:
    return CanonicalEvent(
        event_id=f"neg:USD:{day}",
        event_kind="NEGATIVE_CASH_FEE",
        symbol=None,
        linked_trade_id=None,
        amount=Decimal(amount),
        currency="USD",
        effective_at=pd.Timestamp(day),
        comment=comment,
        source_name="TRADERNET_TABLE",
        source_priority=90,
        source_record_id=f"row:{day}",
        cost_bucket="NEGATIVE_BALANCE_INTEREST",
    )


def test_a_rate_present_in_the_tariff_raises_nothing():
    episodes, _ = build_financing_ledger(
        [
            _charge(
                "2025-12-01",
                "-5.43",
                "Fee for negative cash balance USD, fee rate as a percentage: 0.049315, "
                "balance as at 2025-11-30 23:59:59: 11005.36",
            )
        ]
    )

    issues = check_rates_against_tariff(episodes, [Decimal("0.00041095"), Decimal("0.00049315")])

    assert issues == []


def test_a_rate_outside_the_tariff_is_a_warning_not_a_blocker():
    """Rozjazd znaczy, ze taryfa moze byc nieaktualna - nie, ze wynik jest zly."""
    episodes, _ = build_financing_ledger(
        [
            _charge(
                "2025-12-01",
                "-9.90",
                "Fee for negative cash balance USD, fee rate as a percentage: 0.090000, "
                "balance as at 2025-11-30 23:59:59: 11000.00",
            )
        ]
    )

    issues = check_rates_against_tariff(episodes, [Decimal("0.00041095"), Decimal("0.00049315")])

    assert [issue.code for issue in issues] == ["FINANCING_RATE_OUTSIDE_TARIFF"]
    assert issues[0].severity == "WARNING"
    assert issues[0].blocking is False


def test_without_a_readable_tariff_there_is_nothing_to_compare():
    episodes, _ = build_financing_ledger([_charge("2025-12-01", "-5.43", "Fee for negative cash balance USD")])

    assert check_rates_against_tariff(episodes, []) == []


def test_reading_the_same_tariff_twice_parses_it_once(tmp_path):
    """Parsowanie PDF kosztuje ~400 ms i wchodzilo w kazdy przebieg silnika."""
    tariff = tmp_path / "Stawki.pdf"
    tariff.write_bytes(b"nie PDF, ale plik istnieje")

    read_pdf_text(tariff)
    after_first = _read_pdf_text_cached.cache_info()
    read_pdf_text(tariff)
    after_second = _read_pdf_text_cached.cache_info()

    assert after_second.misses == after_first.misses, "drugi odczyt nie moze parsowac pliku ponownie"
    assert after_second.hits == after_first.hits + 1


def test_a_changed_tariff_is_parsed_again(tmp_path):
    """Stary tekst z cache bylby gorszy niz koszt ponownego parsowania."""
    tariff = tmp_path / "Stawki.pdf"
    tariff.write_bytes(b"wersja pierwsza")
    read_pdf_text(tariff)
    after_first = _read_pdf_text_cached.cache_info()

    tariff.write_bytes(b"wersja druga, wyraznie dluzsza tresc pliku")
    read_pdf_text(tariff)
    after_change = _read_pdf_text_cached.cache_info()

    assert after_change.misses == after_first.misses + 1, "zmiana pliku musi uniewaznic cache"


def test_two_different_tariffs_do_not_share_one_entry(tmp_path):
    first = tmp_path / "Stawki.pdf"
    second = tmp_path / "Stawki-2027.pdf"
    first.write_bytes(b"tresc A")
    second.write_bytes(b"tresc B")

    read_pdf_text(first)
    before = _read_pdf_text_cached.cache_info()
    read_pdf_text(second)

    assert _read_pdf_text_cached.cache_info().misses == before.misses + 1


def test_a_tariff_that_disappears_is_not_served_from_cache(tmp_path):
    tariff = tmp_path / "Stawki.pdf"
    tariff.write_bytes(b"cokolwiek")
    read_pdf_text(tariff)

    tariff.unlink()

    assert read_pdf_text(tariff) == "", "brak pliku to pusty tekst, a nie wpis z cache"
