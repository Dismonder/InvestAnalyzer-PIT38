"""Rejestr finansowania ujemnego salda gotowki.

Broker udostepnia srodki ponad stan konta i nalicza za nie odsetki **kazdego
dnia kalendarzowego**, dopoki saldo pozostaje ujemne. Do rozliczenia i do oceny
wyniku inwestycyjnego trzeba oddzielic kapital pozyczony od wlasnego oraz
pokazac, ile kosztowalo utrzymanie dlugu az do jego uregulowania.

Modul grupuje dzienne naliczenia w **epizody finansowania**: ciagi kolejnych dni
z naliczeniem. Przerwa dluzsza niz jeden dzien oznacza, ze saldo tego dnia nie
bylo juz ujemne, czyli dlug zostal uregulowany i epizod sie zamyka.

Zrodlem kwot sa naliczenia faktycznie pobrane przez brokera - nie sa
przeliczane od nowa. Wysokosc pozyczonego kapitalu i stawke dzienna broker
podaje w opisie kazdego naliczenia, wiec sa odczytywane, a nie szacowane.
Stawka z taryfy zostaje jako wartosc zapasowa dla zapisow bez opisu.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any, Iterable

import pandas as pd

from investment_tax_engine.models.core import CanonicalEvent, Issue


# Taryfa brokera (Stawki.pdf) podaje dwa progi: "Margin rate (per day) 0.041095%" (15%
# rocznie) oraz 0.049315% (18% rocznie). Ktory obowiazuje, wynika z planu
# uzytkownika, dlatego jest to wylacznie wartosc zapasowa - pierwszenstwo ma
# stawka podana przez brokera przy konkretnym naliczeniu.
DEFAULT_DAILY_MARGIN_RATE = Decimal("0.00041095")

# Broker opisuje kazde naliczenie zdaniem w rodzaju:
#   "Fee for negative cash balance USD, fee rate as a percentage: 0.049315,
#    balance as at 2025-11-30 23:59:59: 11005.36"
# Sa tam obie wielkosci potrzebne do rozliczenia: stawka dzienna i faktyczne
# saldo, ktore ta stawka obciazono. Odczytanie ich jest dokladniejsze niz
# szacowanie kapitalu z taryfy, bo nie zalezy od domyslu, ktory prog obowiazuje.
_FEE_RATE_PATTERN = re.compile(r"fee rate as a percentage:\s*([0-9]+(?:\.[0-9]+)?)", re.IGNORECASE)
# Saldo stoi po ostatnim dwukropku, bo znacznik czasu w srodku zdania tez je ma.
_BALANCE_PATTERN = re.compile(r"balance as at .*:\s*(-?[0-9]+(?:\.[0-9]+)?)", re.IGNORECASE)

# Naliczenie jest zaokraglane do grosza, wiec iloczyn salda i stawki moze sie
# od niego roznic o pol grosza w kazda strone. Wieksza rozbieznosc oznacza, ze
# opis brokera nie opisuje tego naliczenia.
_CHARGE_RECONCILIATION_TOLERANCE = Decimal("0.02")


def _decimal_or_none(text: str) -> Decimal | None:
    try:
        return Decimal(text)
    except (InvalidOperation, ValueError):
        return None


def read_reported_daily_rate(comment: str | None) -> Decimal | None:
    """Stawka dzienna podana przez brokera, przeliczona z procentu na ulamek."""
    if not comment:
        return None
    match = _FEE_RATE_PATTERN.search(comment)
    if not match:
        return None
    value = _decimal_or_none(match.group(1))
    return value / Decimal("100") if value is not None else None


def read_reported_balance(comment: str | None) -> Decimal | None:
    """Saldo, ktore broker obciazyl danym naliczeniem, jako wartosc dodatnia."""
    if not comment:
        return None
    match = _BALANCE_PATTERN.search(comment)
    if not match:
        return None
    value = _decimal_or_none(match.group(1))
    return abs(value) if value is not None else None

# Naliczenie wystepuje w kazdym dniu kalendarzowym trwania dlugu, wlacznie
# z sobotami i niedzielami. Brak naliczenia przez pelna dobe oznacza wiec, ze
# saldo nie bylo juz ujemne.
MAX_GAP_DAYS_WITHIN_EPISODE = 1

FINANCING_EVENT_KINDS = frozenset({"NEGATIVE_CASH_FEE", "NEGATIVE_BALANCE_INTEREST"})
FINANCING_COST_BUCKETS = frozenset({"NEGATIVE_BALANCE_INTEREST"})


@dataclass
class FinancingCharge:
    """Pojedyncze dzienne naliczenie za ujemne saldo."""

    charge_date: pd.Timestamp
    amount: Decimal
    currency: str
    event_id: str
    amount_pln: Decimal | None = None
    nbp_rate: Decimal | None = None
    nbp_rate_date: pd.Timestamp | None = None
    # Kapital obciazony tego dnia. Gdy broker poda saldo w opisie, jest to
    # wartosc odczytana; w przeciwnym razie oszacowana ze stawki taryfowej.
    principal: Decimal | None = None
    principal_source: str | None = None
    daily_rate: Decimal | None = None
    daily_rate_source: str | None = None
    source_file: str = ""
    source_record_id: str = ""


@dataclass
class FinancingEpisode:
    """Nieprzerwany okres, w ktorym konto pozostawalo na minusie."""

    episode_id: str
    currency: str
    opened_on: pd.Timestamp
    last_charged_on: pd.Timestamp
    settled_on: pd.Timestamp | None
    charged_days: int
    total_interest: Decimal
    daily_rate_used: Decimal | None
    charges: list[FinancingCharge] = field(default_factory=list)
    total_interest_pln: Decimal | None = None
    peak_principal: Decimal | None = None
    average_principal: Decimal | None = None
    # "broker_comment" gdy saldo pochodzi z opisu naliczen, "derived_from_rate"
    # gdy zostalo oszacowane ze stawki, "mixed" gdy w epizodzie sa oba.
    principal_source: str | None = None

    @property
    def is_open(self) -> bool:
        """Czy dlug nie zostal jeszcze uregulowany na koniec dostepnych danych."""
        return self.settled_on is None


def _is_financing_charge(event: CanonicalEvent) -> bool:
    if event.cost_bucket in FINANCING_COST_BUCKETS:
        return True
    return event.event_kind in FINANCING_EVENT_KINDS


def _charge_date(event: CanonicalEvent) -> pd.Timestamp | None:
    for value in (event.tax_event_date, event.effective_at, event.original_event_date):
        if value is not None and not pd.isna(value):
            return pd.Timestamp(value).normalize()
    return None


def _charge_amount(event: CanonicalEvent) -> Decimal:
    """Koszt jako wartosc dodatnia.

    Broker zapisuje obciazenie liczba ujemna; rejestr operuje kwotami kosztu.
    """
    amount = event.amount if event.amount is not None else Decimal("0")
    return -amount if amount < 0 else amount


def _charge_amount_pln(event: CanonicalEvent) -> Decimal | None:
    if event.amount_pln is None:
        return None
    return -event.amount_pln if event.amount_pln < 0 else event.amount_pln


def _resolve_principal(
    amount: Decimal,
    comment: str | None,
    fallback_rate: Decimal | None,
) -> tuple[Decimal | None, str | None, Decimal | None, str | None]:
    """Kapital obciazony danym naliczeniem oraz stawka, ktora go obciazyla.

    Zwraca (kapital, zrodlo kapitalu, stawka, zrodlo stawki).

    Pierwszenstwo ma zapis brokera: opis naliczenia niesie i stawke, i saldo,
    wiec nie trzeba niczego zakladac. Gdy opisu brak, kapital jest szacowany ze
    stawki taryfowej - wtedy zalezy od domyslu, ktory prog taryfy obowiazuje,
    i jest oznaczony jako wielkosc pochodna.
    """
    reported_rate = read_reported_daily_rate(comment)
    reported_balance = read_reported_balance(comment)

    rate = reported_rate if reported_rate is not None else fallback_rate
    # Etykieta "tariff" sugerowala odczyt taryfy dla tego naliczenia. Taryfa
    # podaje dwa progi (15% i 18% rocznie), a ktory obowiazuje, wynika z planu
    # uzytkownika - bierzemy nizszy. To zalozenie, nie odczyt, wiec pakiet
    # dowodowy musi je tak nazywac.
    rate_source = (
        "broker_comment"
        if reported_rate is not None
        else ("tariff_default_assumed" if rate is not None else None)
    )

    if reported_balance is not None and reported_balance > 0:
        return reported_balance, "broker_comment", rate, rate_source

    if rate is not None and rate > 0 and amount > 0:
        return amount / rate, "derived_from_rate", rate, rate_source

    return None, None, rate, rate_source


def _reconciliation_issue(charge: "FinancingCharge") -> Issue | None:
    """Sprawdza, czy naliczenie zgadza sie z podanym saldem i stawka.

    Kontrola ma sens tylko wtedy, gdy obie wielkosci pochodza z zapisu brokera -
    inaczej porownywaloby sie liczbe z samej siebie.
    """
    if charge.principal_source != "broker_comment" or charge.daily_rate_source != "broker_comment":
        return None
    if charge.principal is None or charge.daily_rate is None:
        return None

    expected = charge.principal * charge.daily_rate
    if abs(expected - charge.amount) <= _CHARGE_RECONCILIATION_TOLERANCE:
        return None

    return Issue(
        code="FINANCING_CHARGE_DOES_NOT_MATCH_REPORTED_BALANCE",
        severity="WARNING",
        stage="FINANCING",
        scope_type="EVENT",
        scope_id=charge.event_id,
        message=(
            "Naliczenie za ujemne saldo nie zgadza się z saldem i stawką podanymi przez brokera."
        ),
        details={
            "charge": str(charge.amount),
            "reported_balance": str(charge.principal),
            "reported_daily_rate": str(charge.daily_rate),
            "expected_charge": str(expected),
            "currency": charge.currency,
            "date": charge.charge_date.date().isoformat(),
        },
        blocking=False,
    )


def check_rates_against_tariff(
    episodes: Iterable["FinancingEpisode"],
    tariff_rates: Iterable[Decimal],
) -> list[Issue]:
    """Porownuje stawki uzyte w naliczeniach z taryfa odczytana z PDF.

    To kontrola spojnosci, nie podstawa wyliczenia: stawka podana przez brokera
    przy konkretnym naliczeniu zawsze ma pierwszenstwo. Rozjazd z taryfa znaczy,
    ze albo taryfa jest nieaktualna, albo naliczenie odbiega od cennika - w obu
    przypadkach warto, zeby uzytkownik o tym wiedzial przed zlozeniem zeznania.
    """
    known = {Decimal(str(rate)) for rate in tariff_rates}
    if not known:
        return []

    issues: list[Issue] = []
    for episode in episodes:
        used = episode.daily_rate_used
        if used is None or used in known:
            continue
        issues.append(
            Issue(
                code="FINANCING_RATE_OUTSIDE_TARIFF",
                severity="WARNING",
                stage="FINANCING_LEDGER",
                scope_type="ENGINE",
                scope_id=episode.episode_id,
                message=(
                    f"Stawka dzienna {used} użyta w naliczeniach nie występuje w taryfie "
                    f"({', '.join(str(rate) for rate in sorted(known))}). "
                    "Sprawdź, czy taryfa jest aktualna."
                ),
                details={
                    "used_daily_rate": str(used),
                    "tariff_daily_rates": [str(rate) for rate in sorted(known)],
                    "rate_sources": sorted(
                        {charge.daily_rate_source for charge in episode.charges if charge.daily_rate_source}
                    ),
                },
                blocking=False,
                policy_decision="tariff_mismatch_is_a_warning_not_a_blocker",
            )
        )
    return issues


def build_financing_ledger(
    events: Iterable[CanonicalEvent],
    *,
    daily_rate: Decimal | None = DEFAULT_DAILY_MARGIN_RATE,
    max_gap_days: int = MAX_GAP_DAYS_WITHIN_EPISODE,
) -> tuple[list[FinancingEpisode], list[Issue]]:
    """Buduje epizody finansowania z dziennych naliczen za ujemne saldo."""
    issues: list[Issue] = []
    charges_by_currency: dict[str, list[FinancingCharge]] = {}

    for event in events:
        if not _is_financing_charge(event):
            continue
        charge_date = _charge_date(event)
        if charge_date is None:
            issues.append(
                Issue(
                    code="FINANCING_CHARGE_WITHOUT_DATE",
                    severity="WARNING",
                    stage="FINANCING",
                    scope_type="EVENT",
                    scope_id=event.event_id,
                    message="Naliczenie za ujemne saldo nie ma daty, więc nie da się przypisać go do epizodu finansowania.",
                    blocking=False,
                )
            )
            continue

        amount = _charge_amount(event)
        if amount <= 0:
            continue

        currency = (event.currency or "").upper()
        principal, principal_source, rate, rate_source = _resolve_principal(
            amount, event.comment, daily_rate
        )
        charge = FinancingCharge(
            charge_date=charge_date,
            amount=amount,
            currency=currency,
            event_id=event.event_id,
            amount_pln=_charge_amount_pln(event),
            nbp_rate=event.nbp_rate,
            nbp_rate_date=event.nbp_rate_date,
            principal=principal,
            principal_source=principal_source,
            daily_rate=rate,
            daily_rate_source=rate_source,
            source_file=event.source_file,
            source_record_id=event.source_record_id,
        )
        mismatch = _reconciliation_issue(charge)
        if mismatch is not None:
            issues.append(mismatch)
        charges_by_currency.setdefault(currency, []).append(charge)

    episodes: list[FinancingEpisode] = []
    for currency in sorted(charges_by_currency):
        ordered = sorted(charges_by_currency[currency], key=lambda charge: charge.charge_date)
        run: list[FinancingCharge] = []
        for charge in ordered:
            if run and (charge.charge_date - run[-1].charge_date).days > max_gap_days:
                episodes.append(_close_episode(run, currency, daily_rate))
                run = []
            run.append(charge)
        if run:
            episodes.append(_close_episode(run, currency, daily_rate))

    episodes.sort(key=lambda episode: (episode.opened_on, episode.currency))
    return episodes, issues


def _close_episode(
    charges: list[FinancingCharge],
    currency: str,
    daily_rate: Decimal | None,
) -> FinancingEpisode:
    opened_on = charges[0].charge_date
    last_charged_on = charges[-1].charge_date
    total_interest = sum((charge.amount for charge in charges), Decimal("0"))

    pln_values = [charge.amount_pln for charge in charges if charge.amount_pln is not None]
    total_interest_pln = sum(pln_values, Decimal("0")) if len(pln_values) == len(charges) else None

    principals = [charge.principal for charge in charges if charge.principal is not None]
    peak_principal = max(principals) if principals else None
    average_principal = (sum(principals, Decimal("0")) / Decimal(len(principals))) if principals else None

    principal_sources = {charge.principal_source for charge in charges if charge.principal_source}
    if len(principal_sources) == 1:
        principal_source = next(iter(principal_sources))
    elif principal_sources:
        principal_source = "mixed"
    else:
        principal_source = None

    reported_rates = {charge.daily_rate for charge in charges if charge.daily_rate is not None}
    episode_rate = next(iter(reported_rates)) if len(reported_rates) == 1 else daily_rate

    return FinancingEpisode(
        episode_id=f"financing:{currency}:{opened_on.date().isoformat()}",
        currency=currency,
        opened_on=opened_on,
        last_charged_on=last_charged_on,
        # Dlug przestal istniec pierwszego dnia bez naliczenia.
        settled_on=last_charged_on + pd.Timedelta(days=1),
        charged_days=len(charges),
        total_interest=total_interest,
        total_interest_pln=total_interest_pln,
        daily_rate_used=episode_rate,
        peak_principal=peak_principal,
        average_principal=average_principal,
        principal_source=principal_source,
        charges=list(charges),
    )


def mark_open_episodes(
    episodes: list[FinancingEpisode],
    *,
    data_horizon: pd.Timestamp | None,
) -> list[Issue]:
    """Oznacza jako nieuregulowany epizod trwajacy do konca dostepnych danych.

    Ostatnie naliczenie w zbiorze nie dowodzi splaty - moze oznaczac, ze dlug
    trwa nadal, a kolejnych wyciagow po prostu jeszcze nie ma.
    """
    if data_horizon is None or not episodes:
        return []

    horizon = pd.Timestamp(data_horizon).normalize()
    issues: list[Issue] = []
    for episode in episodes:
        if episode.last_charged_on < horizon:
            continue
        episode.settled_on = None
        issues.append(
            Issue(
                code="FINANCING_EPISODE_NOT_SETTLED",
                severity="WARNING",
                stage="FINANCING",
                scope_type="ENGINE",
                scope_id=episode.episode_id,
                message=(
                    "Ujemne saldo trwa do końca dostępnych danych. Odsetki mogą być naliczane dalej, "
                    "a rozliczenie tego epizodu jest niepełne."
                ),
                details={
                    "currency": episode.currency,
                    "opened_on": episode.opened_on.date().isoformat(),
                    "last_charged_on": episode.last_charged_on.date().isoformat(),
                    "charged_days": episode.charged_days,
                },
                blocking=False,
                policy_decision="financing_episode_requires_later_statement",
            )
        )
    return issues


def summarize_financing_ledger(
    episodes: list[FinancingEpisode],
    *,
    tax_year: int | None = None,
) -> dict[str, Any]:
    """Zestawienie epizodow, gotowe do raportu i do warstwy analitycznej."""
    selected = [
        (episode, [charge for charge in episode.charges if tax_year is None or charge.charge_date.year == tax_year])
        for episode in episodes
    ]
    selected = [(episode, charges) for episode, charges in selected if charges]

    by_currency: dict[str, dict[str, Any]] = {}
    for episode, charges in selected:
        bucket = by_currency.setdefault(
            episode.currency,
            {"episodes": 0, "charged_days": 0, "total_interest": Decimal("0"), "peak_principal": None},
        )
        bucket["episodes"] += 1
        bucket["charged_days"] += len(charges)
        bucket["total_interest"] += sum((charge.amount for charge in charges), Decimal("0"))
        if episode.peak_principal is not None:
            current_peak = bucket["peak_principal"]
            if current_peak is None or episode.peak_principal > current_peak:
                bucket["peak_principal"] = episode.peak_principal

    selected_charges = [charge for _, charges in selected for charge in charges]
    total_pln_parts = [charge.amount_pln for charge in selected_charges if charge.amount_pln is not None]
    return {
        "schema_version": "financing_ledger.v1",
        "tax_year": tax_year,
        "episode_count": len(selected),
        "charged_days": len(selected_charges),
        "open_episode_count": sum(1 for episode, _ in selected if episode.is_open),
        "total_interest_pln": (
            sum(total_pln_parts, Decimal("0")) if len(total_pln_parts) == len(selected_charges) and selected_charges else None
        ),
        "by_currency": {
            currency: {
                "episodes": bucket["episodes"],
                "charged_days": bucket["charged_days"],
                "total_interest": str(bucket["total_interest"]),
                "peak_principal": (
                    str(bucket["peak_principal"]) if bucket["peak_principal"] is not None else None
                ),
            }
            for currency, bucket in sorted(by_currency.items())
        },
        "episodes": [
            {
                "episode_id": episode.episode_id,
                "currency": episode.currency,
                "opened_on": episode.opened_on.date().isoformat(),
                "last_charged_on": episode.last_charged_on.date().isoformat(),
                "settled_on": episode.settled_on.date().isoformat() if episode.settled_on is not None else None,
                "is_open": episode.is_open,
                "charged_days": len(charges),
                "total_interest": str(sum((charge.amount for charge in charges), Decimal("0"))),
                "total_interest_pln": (
                    str(sum((charge.amount_pln for charge in charges), Decimal("0")))
                    if all(charge.amount_pln is not None for charge in charges) else None
                ),
                "period_total_interest": str(episode.total_interest),
                "period_total_interest_pln": (
                    str(episode.total_interest_pln) if episode.total_interest_pln is not None else None
                ),
                "daily_rate_used": str(episode.daily_rate_used) if episode.daily_rate_used is not None else None,
                "peak_principal": (
                    str(episode.peak_principal) if episode.peak_principal is not None else None
                ),
                "average_principal": (
                    str(episode.average_principal) if episode.average_principal is not None else None
                ),
                "principal_source": episode.principal_source,
            }
            for episode, charges in selected
        ],
    }


__all__ = [
    "DEFAULT_DAILY_MARGIN_RATE",
    "read_reported_daily_rate",
    "read_reported_balance",
    "MAX_GAP_DAYS_WITHIN_EPISODE",
    "FinancingCharge",
    "FinancingEpisode",
    "build_financing_ledger",
    "mark_open_episodes",
    "summarize_financing_ledger",
]
