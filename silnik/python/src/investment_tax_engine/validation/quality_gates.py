from __future__ import annotations

from typing import Iterable

from investment_tax_engine.models.core import Issue, QualityGateResult


# Bramka 1 - brak kursu NBP dla ktorejkolwiek transakcji.
# BUY_WITHOUT_PLN_COST i SELL_WITHOUT_PLN_REVENUE to bezposredni skutek braku
# kursu: transakcja bez kwoty w PLN nie da sie rozliczyc w PIT-38.
NBP_GATE_CODES = frozenset(
    {
        "NBP_RATE_NOT_FOUND",
        "BUY_WITHOUT_PLN_COST",
        "SELL_WITHOUT_PLN_REVENUE",
        # Dywidenda i podatek u zrodla bez kwoty w zlotych - to samo dla czesci G.
        "DIVIDEND_WITHOUT_PLN_AMOUNT",
    }
)

# NBP_COVERAGE_GAP mowi, ze lokalne archiwum CSV nie obejmuje calego zakresu dat
# - nie mowi, ze ktorykolwiek kurs jest nieznany. Gdy fallback na API dostarczyl
# komplet kursow, rozliczenie jest policzone poprawnie i zatrzymywanie go byloby
# blednym alarmem; do pakietu dowodowego trafia wtedy ostrzezenie, ze czesc
# kursow nie pochodzi z zarchiwizowanego pliku.
# Luka blokuje dopiero wtedy, gdy w tej samej walucie faktycznie zabraklo kursu.
CONDITIONAL_NBP_GATE_CODE = "NBP_COVERAGE_GAP"

# Bramka 2 - ujemny stan posiadania w FIFO, czyli sprzedaz wiekszej liczby
# walorow niz zostalo kupionych, oraz pozostale naruszenia integralnosci lotow.
#
# AWARD_POLICY_UNRESOLVED jest tu kluczowy: przy domyslnej polityce
# award_policy="REQUIRE_EXPLICIT" to wlasnie on, a nie SELL_EXCEEDS_FIFO_LOTS,
# opisuje sprzedaz bez pokrycia w partiach. Drugi kod pozostaje w zestawie dla
# konfiguracji, ktore te polityke zmieniaja.
FIFO_GATE_CODES = frozenset(
    {
        "SELL_EXCEEDS_FIFO_LOTS",
        "AWARD_POLICY_UNRESOLVED",
        "INVALID_SELL_QUANTITY",
        "INVALID_BUY_QUANTITY",
        "SHORT_SALE_UNSUPPORTED_CASE",
        # Rejestr partii niesie podstawe kosztowa. Gdy rozjezdza sie ze stanem
        # u brokera, koszt w rozliczeniu dotyczy innego stanu posiadania.
        "FIFO_LEDGER_POSITION_MISMATCH",
    }
)

# Bramka 4 - dane wejsciowe niekompletne. Wiersz, ktorego nie udalo sie
# znormalizowac, oraz brak wymaganego pliku wejsciowego oznaczaja, ze
# rozliczenie liczy sie na niepelnym zbiorze.
INPUT_INTEGRITY_GATE_CODES = frozenset(
    {
        "NORMALIZE_ERROR",
        "TRADE_AMOUNT_MISMATCH",
        "SOURCE_INPUT_READ_FAILED",
        "SOURCE_INPUT_TOO_LARGE",
        "INCOMPLETE_TRANSACTION_SKIPPED",
        "MISSING_REQUIRED_INPUT",
        "CANONICAL_TAX_INPUT_EMPTY",
        # Zalacznik PIT/ZG bez panstwa zrodla - kod "XX" nie istnieje w slowniku.
        "PIT_ZG_COUNTRY_UNKNOWN",
        # Zdarzenie odłożone do decyzji może zmienić koszt FIFO albo wynik
        # bieżącego roku; pakiet nie może wtedy dostać zielonego statusu.
        "RECORDS_AWAITING_USER_DECISION",
        "PIT8C_SOURCE_UNCONFIRMED",
        "PIT8C_INPUT_INVALID",
    }
)

# Bramka 3 - nierozwiazane konflikty miedzy wyciagami tego samego okresu.
# FIELD_CONFLICT tu nie nalezy: merge_engine wybiera zwyciezce wedlug priorytetu
# zrodel, wiec konflikt jest rozwiazany i zostaje ostrzezeniem audytowym.
# DEPO_POSITION_MISMATCH niesie policy_decision "depo_control_layer_blocks_filing_ready".
CONFLICT_GATE_CODES = frozenset(
    {
        "DUPLICATE_TRADE_ID",
        "DEPO_POSITION_MISMATCH",
        "OVERLAPPING_SOURCE_QUANTITY_CONFLICT",
        "OVERLAPPING_SOURCE_ACCOUNT_AMBIGUOUS",
    }
)

# Bramka 5 - cala kategoria zdarzen obecna na wejsciu i pusta na wyjsciu.
# Ta awaria wystapila juz trzykrotnie i za kazdym razem przeszla bez sladu:
# zaslepka bramek jakosci, zdarzenia wspierajace, straznik rozszerzen.
CATEGORY_COVERAGE_GATE_CODES = frozenset({"CATEGORY_COVERAGE_LOST"})

BLOCKING_GATE_CODES = (
    NBP_GATE_CODES
    | FIFO_GATE_CODES
    | CONFLICT_GATE_CODES
    | INPUT_INTEGRITY_GATE_CODES
    | CATEGORY_COVERAGE_GATE_CODES
)

BLOCKING_SEVERITIES = frozenset({"ERROR", "CRITICAL"})

REVIEW_SEVERITIES = frozenset({"WARNING", "ERROR", "CRITICAL"})


def is_blocking_issue(issue: Issue) -> bool:
    """Czy pojedyncza niespojnosc zatrzymuje wydanie pakietu ostatecznego.

    Blokuja: niespojnosci jawnie oznaczone flaga blocking oraz te, ktore naleza
    do jednej z trzech bramek krytycznych i maja wage ERROR albo CRITICAL.
    """
    if issue.blocking:
        return True
    return issue.code in BLOCKING_GATE_CODES and issue.severity in BLOCKING_SEVERITIES


def _currencies_without_rates(issues: list[Issue]) -> set[str]:
    """Waluty, w ktorych naprawde zabraklo kursu."""
    currencies: set[str] = set()
    for issue in issues:
        if issue.code not in NBP_GATE_CODES:
            continue
        currency = str(issue.details.get("currency") or "").upper()
        if currency:
            currencies.add(currency)
        else:
            # Brak kursu bez wskazanej waluty musi blokowac kazda luke pokrycia.
            currencies.add("*")
    return currencies


def _coverage_gap_blocks(issue: Issue, currencies_without_rates: set[str]) -> bool:
    if not currencies_without_rates:
        return False
    if "*" in currencies_without_rates:
        return True
    return str(issue.details.get("currency") or "").upper() in currencies_without_rates


def build_quality_report(issues: Iterable[Issue]) -> QualityGateResult:
    """Klasyfikuje niespojnosci i rozstrzyga, czy wolno wydac pakiet ostateczny.

    Silnik jest fail-closed: kazda niespojnosc krytyczna zatrzymuje pakiet,
    zamiast wypuszczac rozliczenie o nieznanej poprawnosci. Wynik pozostaje
    policzony i w pelni audytowalny - blokowane jest wylacznie uznanie go
    za gotowy do zlozenia.
    """
    all_issues = list(issues)
    blocking: list[Issue] = []
    warnings: list[Issue] = []
    infos: list[Issue] = []
    currencies_without_rates = _currencies_without_rates(all_issues)

    for issue in all_issues:
        if issue.code == CONDITIONAL_NBP_GATE_CODE and not issue.blocking:
            if _coverage_gap_blocks(issue, currencies_without_rates):
                blocking.append(issue)
            else:
                warnings.append(issue)
            continue
        if is_blocking_issue(issue):
            blocking.append(issue)
        elif issue.severity in REVIEW_SEVERITIES:
            warnings.append(issue)
        else:
            infos.append(issue)

    if blocking:
        status = "CALCULATION_BLOCKED"
    elif warnings:
        status = "SUCCESS_WITH_WARNINGS"
    else:
        status = "SUCCESS"

    return QualityGateResult(
        filing_ready=not blocking,
        final_status=status,
        blocking_issues=blocking,
        warning_issues=warnings,
        informational_issues=infos,
        metrics={
            "blocking_count": len(blocking),
            "runtime_blocking_count": sum(1 for issue in blocking if issue.blocking),
            "warning_count": len(warnings),
            "info_count": len(infos),
        },
    )
