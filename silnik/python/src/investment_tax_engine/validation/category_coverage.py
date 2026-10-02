from __future__ import annotations

from decimal import Decimal
from typing import Any, Callable, Iterable

from investment_tax_engine.models.core import Issue


CATEGORY_COVERAGE_ISSUE_CODE = "CATEGORY_COVERAGE_LOST"


class CoverageProbe:
    """Jedna kategoria wejsciowa i artefakt, ktory musi po niej zostac w wyniku."""

    def __init__(self, kinds: frozenset[str], label: str, output_label: str, counter: Callable[[Any], int]) -> None:
        self.kinds = kinds
        self.label = label
        self.output_label = output_label
        self.counter = counter


def _cost_items_with_kind(result: Any, kind: str) -> int:
    return sum(1 for item in getattr(result, "cost_items", []) or [] if getattr(item, "kind", None) == kind)


def _commission_trace_count(result: Any) -> int:
    """Prowizja moze zostac osobna pozycja kosztowa albo wejsc w koszt transakcji.

    Gdy broker podaje ja przy samej transakcji, silnik slusznie nie tworzy
    drugiej pozycji - slad zostaje wtedy w polu `commission` transakcji.
    Bramka uznaje oba miejsca, bo oba oznaczaja, ze prowizja nie przepadla.
    """
    standalone = _cost_items_with_kind(result, "TRADE_COMMISSION")
    if standalone > 0:
        return standalone
    merge_result = getattr(result, "merge_result", None)
    ledger = getattr(merge_result, "ledger", None)
    trades = getattr(ledger, "trades_by_id", None) or {}
    return sum(
        1
        for trade in trades.values()
        if _as_decimal(getattr(trade, "commission", None)) != 0
        or _as_decimal(getattr(trade, "commission_pln", None)) != 0
    )


def _financing_episode_count(result: Any) -> int:
    ledger = getattr(result, "financing_ledger", None) or {}
    try:
        return int(ledger.get("episode_count") or 0)
    except (AttributeError, TypeError, ValueError):
        return 0


def _dividend_row_count(result: Any) -> int:
    return len(getattr(result, "dividends_view", []) or [])


def _acquisition_lot_count(result: Any) -> int:
    """Wiersze FIFO z niezerowa podstawa kosztowa, czyli realnie dopasowane nabycia."""
    rows = getattr(result, "fifo_rows", []) or []
    return sum(1 for row in rows if _as_decimal(getattr(row, "cost_pln", None)) > 0)


def _fx_row_count(result: Any) -> int:
    """Wiersze rozliczenia gotowki pochodzace z przewalutowania.

    Zliczanie calego widoku dawalo falszywe OK: sa w nim tez wiersze z wplat i
    zakupow, wiec kategoria przewalutowan mogla zniknac w calosci, a bramka i
    tak przechodzila.
    """
    rows = getattr(result, "private_cash_fx_view", []) or []
    return sum(1 for row in rows if str(getattr(row, "use_reference", "") or "").strip())


def _withholding_row_count(result: Any) -> int:
    return len(getattr(result, "foreign_tax_view", []) or [])


def _as_decimal(value: Any) -> Decimal:
    if value is None:
        return Decimal("0")
    try:
        return Decimal(str(value))
    except (ArithmeticError, TypeError, ValueError):
        return Decimal("0")


# Kategoria obecna na wejsciu i pusta na wyjsciu zatrzymuje bramke. Ta awaria
# wystapila juz trzykrotnie: zaslepka bramek jakosci, zdarzenia wspierajace i
# straznik rozszerzen - za kazdym razem calosc znikala bez jednego komunikatu.
COVERAGE_PROBES: tuple[CoverageProbe, ...] = (
    CoverageProbe(
        frozenset({"commission"}),
        "prowizje",
        "pozycje kosztowe TRADE_COMMISSION albo prowizja w transakcji",
        _commission_trace_count,
    ),
    CoverageProbe(
        frozenset({"interest"}),
        "naliczenia odsetek",
        "epizody w rejestrze finansowania",
        _financing_episode_count,
    ),
    CoverageProbe(
        frozenset({"dividend"}),
        "dywidendy",
        "wiersze zestawienia dywidend",
        _dividend_row_count,
    ),
    CoverageProbe(
        frozenset({"corporate_action", "stock_award"}),
        "zdarzenia korporacyjne i akcje przyznane",
        "partie nabycia dopasowane w FIFO",
        _acquisition_lot_count,
    ),
    CoverageProbe(
        frozenset({"fx"}),
        "przewalutowania",
        "wiersze rozliczenia gotowki",
        _fx_row_count,
    ),
    CoverageProbe(
        frozenset({"tax"}),
        "podatek u zrodla",
        "wiersze zestawienia podatku zaplaconego za granica",
        _withholding_row_count,
    ),
)


def _held_for_review_counts(consumption_report: Any) -> dict[str, int]:
    """Zapisy odlozone do decyzji uzytkownika - to tez jest slad kategorii."""
    if not isinstance(consumption_report, dict):
        return {}
    held = consumption_report.get("recordsHeldForReviewByKind")
    if not isinstance(held, dict):
        return {}
    counts: dict[str, int] = {}
    for kind, count in held.items():
        try:
            counts[str(kind)] = int(count)
        except (TypeError, ValueError):
            continue
    return counts


def _input_counts(consumption_report: Any) -> dict[str, int]:
    if not isinstance(consumption_report, dict):
        return {}
    # Liczymy to, co bylo w pliku wejsciowym. Licznik zdarzen skonsumowanych
    # spadlby do zera razem z cala kategoria i bramka nie mialaby czego porownac.
    # Bez zapasowego licznika zdarzen skonsumowanych: spada on do zera razem z
    # kategoria, ktora bramka ma wykryc, wiec jako podstawa porownania jest
    # bezuzyteczny.
    by_kind = consumption_report.get("availableSupportEventsByKind")
    if not isinstance(by_kind, dict):
        return {}
    counts: dict[str, int] = {}
    for kind, count in by_kind.items():
        try:
            counts[str(kind)] = int(count)
        except (TypeError, ValueError):
            continue
    return counts


def build_category_coverage_issues(result: Any, consumption_report: Any) -> list[Issue]:
    """Sprawdza, czy kazda kategoria z wejscia zostawila slad w wyniku.

    Porownanie obu sciezek silnika nie zadziala jako bramka, bo czytaja rozne
    zestawy plikow. Sprawdzamy wiec relacje wejscie-wyjscie w jednym przebiegu:
    dla kazdego rodzaju zdarzenia obecnego w canonical_tax_input.json musi
    powstac odpowiadajacy artefakt.
    """
    counts = _input_counts(consumption_report)
    if not counts:
        return []

    held_for_review = _held_for_review_counts(consumption_report)
    issues: list[Issue] = []
    for probe in COVERAGE_PROBES:
        on_input = sum(counts.get(kind, 0) for kind in probe.kinds)
        if on_input <= 0:
            continue
        produced = probe.counter(result)
        if produced > 0:
            continue
        # Zapis odlozony do decyzji uzytkownika nie zniknal - czeka. Kategoria
        # zostawila slad, tylko w kolejce przegladu, a nie w rozliczeniu.
        if sum(held_for_review.get(kind, 0) for kind in probe.kinds) > 0:
            continue
        issues.append(
            Issue(
                code=CATEGORY_COVERAGE_ISSUE_CODE,
                severity="CRITICAL",
                stage="QUALITY_GATES",
                scope_type="ENGINE",
                scope_id=",".join(sorted(probe.kinds)),
                message=(
                    f"W pliku wejściowym wykryto {on_input} zdarzeń z kategorii „{probe.label}”, "
                    f"ale wynik nie zawiera żadnego oczekiwanego elementu ({probe.output_label}); "
                    "ta kategoria zniknęła podczas przetwarzania. Ponownie zaimportuj plik w „Dokumenty i silnik”. "
                    "Jeśli problem się powtórzy, zgłoś go i podaj nazwę pliku ze szczegółów importu."
                ),
                details={
                    "categories": sorted(probe.kinds),
                    "input_event_count": on_input,
                    "expected_output": probe.output_label,
                },
                blocking=True,
                policy_decision="category_present_on_input_must_leave_a_trace",
            )
        )
    return issues


def coverage_summary(result: Any, consumption_report: Any) -> list[dict[str, Any]]:
    """Zestawienie wejscie-wyjscie dla pakietu dowodowego."""
    counts = _input_counts(consumption_report)
    summary: list[dict[str, Any]] = []
    for probe in COVERAGE_PROBES:
        on_input = sum(counts.get(kind, 0) for kind in probe.kinds)
        summary.append(
            {
                "categories": sorted(probe.kinds),
                "label": probe.label,
                "input_event_count": on_input,
                "output_artifact": probe.output_label,
                "output_count": probe.counter(result),
            }
        )
    return summary


def category_coverage_codes() -> Iterable[str]:
    return (CATEGORY_COVERAGE_ISSUE_CODE,)
