from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal
from itertools import product

import pandas as pd

from ..models.core import CanonicalEvent
from .fifo_engine import normalizuj_rachunek
from .policies import stawka_umowna_dywidend


WITHHOLDING_MATCH_WINDOW_DAYS = 14
MAX_PAIRING_GROUP_SIZE = 6


def _event_date(event: CanonicalEvent) -> pd.Timestamp | None:
    candidate = event.tax_event_date or event.effective_at
    if candidate is None:
        return None
    return pd.Timestamp(candidate).normalize()


def _podatek_w_pln(dividend: CanonicalEvent, tax: CanonicalEvent) -> Decimal:
    """Podatek u zrodla po kursie dywidendy, od ktorej go pobrano.

    Podatek jest potracany w dniu wyplaty dywidendy; broker ksieguje go czasem dzien
    pozniej. Kurs z dnia ksiegowania dawal inna kwote podatku niz przychodu (art. 11a):
    dywidenda 100 USD po 4,00 i podatek 15 USD po 3,80 to 57 zl zamiast 60 zl w poz. 48.

    Zwrot czesci podatku idzie tym samym kursem - swiadomie. Odliczeniu (art. 30a ust. 9)
    podlega podatek faktycznie zaplacony za granica, czyli potracenie pomniejszone o zwrot,
    ustalone w walucie dywidendy; zaplacono go w dniu potracenia, a zwrot nie jest nowa
    zaplata, tylko koryguje tamta.
    """
    if (
        dividend.fx_rate is not None
        and tax.currency
        and dividend.currency
        and str(tax.currency).upper() == str(dividend.currency).upper()
    ):
        return (tax.amount * dividend.fx_rate).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return tax.amount_pln or Decimal("0.00")


def _same_instrument(dividend: CanonicalEvent, tax: CanonicalEvent) -> bool:
    # Kraj porownujemy tylko, gdy znany po obu stronach: ISIN (a z nim kraj) bywa
    # w jednym wierszu, a w drugim nie, i brak kraju nie moze blokowac parowania.
    if tax.country and dividend.country and tax.country != dividend.country:
        return False
    return tax.symbol == dividend.symbol


def _distance_in_days(dividend: CanonicalEvent, tax: CanonicalEvent) -> int | None:
    """Odleglosc w dniach albo None, gdy ktorakolwiek data jest nieznana."""
    dividend_date = _event_date(dividend)
    tax_date = _event_date(tax)
    if dividend_date is None or tax_date is None:
        return None
    return abs((tax_date - dividend_date).days)


def _source_refs(event: CanonicalEvent) -> set[str]:
    refs = {str(event.linked_trade_id)} if event.linked_trade_id else set()
    for link in event.source_links:
        for key in ("source_record_id", "related_event_id", "reference", "ref"):
            if link.get(key):
                refs.add(str(link[key]))
    return refs


def _pairing_candidates(
    tax: CanonicalEvent, dividends: list[CanonicalEvent], window_days: int
) -> list[CanonicalEvent]:
    candidates, _ = _linked_candidates(tax, dividends)
    dated = [(distance, dividend) for dividend in candidates
             if (distance := _distance_in_days(dividend, tax)) is not None
             and distance <= window_days]
    if not dated:
        return []
    shortest = min(distance for distance, _ in dated)
    nearest = [dividend for distance, dividend in dated if distance == shortest]
    return sorted(nearest, key=lambda dividend: dividend.event_id)


def _odliczenie_dywidendy(dividend: CanonicalEvent, paid: Decimal) -> Decimal:
    if str(dividend.country or "").upper() == "PL":
        return Decimal("0")
    gross = dividend.amount_pln or Decimal("0")
    treaty = (gross * stawka_umowna_dywidend(dividend.country)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    polish = (gross * Decimal("0.19")).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return min(max(paid, Decimal("0")), treaty, polish)


def _credit_for_pairing(
    assignments: tuple[CanonicalEvent, ...], taxes: list[CanonicalEvent],
    credit_dividend_ids: set[str] | None = None,
) -> Decimal:
    paid_by_dividend: dict[str, Decimal] = {}
    for dividend, tax in zip(assignments, taxes):
        if credit_dividend_ids is not None and dividend.event_id not in credit_dividend_ids:
            continue
        paid_by_dividend[dividend.event_id] = paid_by_dividend.get(dividend.event_id, Decimal("0")) - _podatek_w_pln(dividend, tax)
    dividend_by_id = {dividend.event_id: dividend for dividend in assignments}
    return sum((_odliczenie_dywidendy(dividend_by_id[event_id], paid)
                for event_id, paid in paid_by_dividend.items()), Decimal("0"))


def _linked_candidates(tax: CanonicalEvent, candidates: list[CanonicalEvent]) -> tuple[list[CanonicalEvent], bool]:
    """Powiazanie i rachunek zawezaja wybor przed odlegloscia dat.

    Zwraca (kandydaci, czy_jawne_powiazanie).
    """
    refs = _source_refs(tax)
    resolved = {
        ref: {dividend.event_id for dividend in candidates
              if dividend.event_id == ref or dividend.source_record_id == ref
              or ref in _source_refs(dividend)}
        for ref in refs
    }
    required = {str(link["related_event_id"]) for link in tax.source_links if link.get("related_event_id")}
    if any(not resolved.get(ref) for ref in required):
        return [], True
    known_targets = [targets for targets in resolved.values() if targets]
    explicit_link = bool(known_targets)
    if known_targets:
        common = set.intersection(*known_targets)
        candidates = [dividend for dividend in candidates if dividend.event_id in common]
    candidates = [dividend for dividend in candidates if _same_instrument(dividend, tax)]
    account = normalizuj_rachunek(tax.account_id)
    if account:
        same = [dividend for dividend in candidates if normalizuj_rachunek(dividend.account_id) == account]
        candidates = same or [dividend for dividend in candidates if not normalizuj_rachunek(dividend.account_id)]
    return candidates, explicit_link


def _match_withholding_taxes(
    dividends: list[CanonicalEvent],
    tax_events: list[CanonicalEvent],
    *,
    window_days: int = WITHHOLDING_MATCH_WINDOW_DAYS,
    credit_dividend_ids: set[str] | None = None,
) -> tuple[dict[str, list[CanonicalEvent]], set[str]]:
    """Porownuje koncowe odliczenie wszystkich przypisan w powiazanej grupie.

    Grupa obejmuje potracenia z roznych dni i zwroty: rownowaznosc przed
    pozniejszym zwrotem nie dowodzi rownowaznosci koncowego podatku (art. 30a ust. 9).
    Rozlaczne wyplaty nie zwiekszaja rozmiaru przeszukiwania.
    """
    matches: dict[str, list[CanonicalEvent]] = {dividend.event_id: [] for dividend in dividends}
    ambiguous: set[str] = set()
    deductions: list[tuple[CanonicalEvent, list[CanonicalEvent]]] = []
    explicit_refunds: set[str] = set()

    for tax in tax_events:
        if tax.amount >= 0:
            continue
        tax_date = _event_date(tax)
        if tax_date is None:
            candidates, explicit_link = _linked_candidates(tax, dividends)
            if explicit_link and not candidates:
                ambiguous.add(tax.event_id)
            if len(candidates) != 1:
                continue
        else:
            candidates = _pairing_candidates(tax, dividends, window_days)
            if not candidates and any(
                _same_instrument(dividend, tax)
                and (distance := _distance_in_days(dividend, tax)) is not None
                and distance <= window_days for dividend in dividends
            ):
                ambiguous.add(tax.event_id)
        if candidates:
            deductions.append((tax, candidates))

    active = list(deductions)
    for tax in tax_events:
        if tax.amount <= 0 or (tax_date := _event_date(tax)) is None:
            continue
        candidates, explicit_link = _linked_candidates(tax, dividends)
        if not candidates:
            if explicit_link or any(_same_instrument(dividend, tax) for dividend in dividends):
                ambiguous.add(tax.event_id)
            continue
        eligible = []
        for dividend in sorted(candidates, key=lambda item: item.event_id):
            dividend_date = _event_date(dividend)
            if dividend_date is None or dividend_date > tax_date:
                continue
            possible_paid = sum((
                -_podatek_w_pln(dividend, deduction)
                for deduction, choices in deductions
                if any(choice.event_id == dividend.event_id for choice in choices)
                and (_event_date(deduction) is None or _event_date(deduction) <= tax_date)
            ), Decimal("0"))
            if explicit_link or possible_paid >= _podatek_w_pln(dividend, tax):
                eligible.append(dividend)
        if eligible:
            active.append((tax, eligible))
            if explicit_link:
                explicit_refunds.add(tax.event_id)

    # Laczymy tylko podatki, ktore moga dotyczyc tej samej dywidendy.
    groups: list[list[tuple[CanonicalEvent, list[CanonicalEvent]]]] = []
    for tax, candidates in active:
        ids = {dividend.event_id for dividend in candidates}
        connected = [(index, group) for index, group in enumerate(groups)
                     if ids & {dividend.event_id for _, choices in group for dividend in choices}]
        group = [(tax, candidates)]
        for index, previous in reversed(connected):
            group.extend(previous)
            groups.pop(index)
        groups.append(group)

    for group in groups:
        group.sort(key=lambda entry: (
            _event_date(entry[0]) or pd.Timestamp.min, entry[0].amount > 0, entry[0].event_id,
        ))
        taxes = [tax for tax, _ in group]
        choices = [candidates for _, candidates in group]
        combinations = 1
        for candidates in choices:
            combinations *= len(candidates)
        if combinations > MAX_PAIRING_GROUP_SIZE ** MAX_PAIRING_GROUP_SIZE:
            ambiguous.update(tax.event_id for tax in taxes)
            continue
        first_assignment: tuple[CanonicalEvent, ...] | None = None
        expected_credit: Decimal | None = None
        different_credit = False
        for assignment in product(*choices):
            paid: dict[str, Decimal] = {}
            valid = True
            for dividend, tax in zip(assignment, taxes):
                amount = _podatek_w_pln(dividend, tax)
                previous_paid = paid.get(dividend.event_id, Decimal("0"))
                if tax.amount > 0 and tax.event_id not in explicit_refunds and previous_paid < amount:
                    valid = False
                    break
                paid[dividend.event_id] = previous_paid - amount
            if not valid:
                continue
            credit = _credit_for_pairing(assignment, taxes, credit_dividend_ids)
            if first_assignment is None:
                first_assignment, expected_credit = assignment, credit
            elif credit != expected_credit:
                different_credit = True
                break
        if different_credit or first_assignment is None:
            ambiguous.update(tax.event_id for tax in taxes)
        else:
            for dividend, tax in zip(first_assignment, taxes):
                matches[dividend.event_id].append(tax)

    return matches, ambiguous


def build_dividend_views(
    events: list[CanonicalEvent], *, reference_events: list[CanonicalEvent] | None = None,
) -> tuple[list[dict], list[dict]]:
    dividends_view: list[dict] = []
    foreign_tax_view: list[dict] = []

    dividends = [event for event in events if event.event_kind == "DIVIDEND"]
    tax_events = [event for event in events if event.event_kind == "TAX"]
    current_ids = {event.event_id for event in dividends}
    reference_dividends = [event for event in (reference_events if reference_events is not None else events)
                           if event.event_kind == "DIVIDEND"]
    invalid_refs = set()
    for tax in tax_events:
        linked, explicit_link = _linked_candidates(tax, reference_dividends)
        tax_date = _event_date(tax)
        if explicit_link:
            valid_dates = [dividend for dividend in linked
                           if tax.amount < 0 and (tax_date is None or
                               (distance := _distance_in_days(dividend, tax)) is not None
                               and distance <= WITHHOLDING_MATCH_WINDOW_DAYS)
                           or tax.amount > 0 and tax_date is not None
                           and _event_date(dividend) is not None and _event_date(dividend) <= tax_date]
            if not valid_dates or any(dividend.event_id not in current_ids for dividend in linked):
                invalid_refs.add(tax.event_id)
    # Dla zwrotu bez referencji uwzgledniamy tez salda starszych wyplat.
    # Ta sama ocena pelnych przypisan sprawdza wplyw tylko na wybrany rok.
    if reference_events is not None and any(tax.amount > 0 for tax in tax_events):
        current_dates = [_event_date(event) for event in events if _event_date(event) is not None]
        selected_year = max((date.year for date in current_dates), default=None)
        context = [event for event in reference_events
                   if _event_date(event) is None or selected_year is None or _event_date(event).year <= selected_year]
        context_dividends = [event for event in context if event.event_kind == "DIVIDEND"]
        context_taxes = [event for event in context if event.event_kind == "TAX" and event.event_id not in invalid_refs]
        context_matches, context_ambiguous = _match_withholding_taxes(
            context_dividends, context_taxes, credit_dividend_ids=current_ids,
        )
        outside_taxes = {tax.event_id for dividend_id, taxes in context_matches.items()
                         if dividend_id not in current_ids for tax in taxes}
        invalid_refs.update(tax.event_id for tax in tax_events if tax.amount > 0
                            and (tax.event_id in context_ambiguous or tax.event_id in outside_taxes))
    # Sprzeczna referencja lub inny rok nie uprawnia do wyboru innej wyplaty.
    matches, ambiguous = _match_withholding_taxes(
        dividends, [tax for tax in tax_events if tax.event_id not in invalid_refs],
    )
    ambiguous.update(invalid_refs)
    matched_dividend_by_tax = {
        tax.event_id: dividend_id
        for dividend_id, linked in matches.items()
        for tax in linked
    }

    podatek_pln_po_kursie_dywidendy: dict[str, Decimal] = {}
    for event in dividends:
        linked_taxes = matches.get(event.event_id, [])
        for item in linked_taxes:
            podatek_pln_po_kursie_dywidendy[item.event_id] = _podatek_w_pln(event, item)
        # Potracenie TAX ma znak ujemny, zwrot dodatni. Odliczeniu podlega
        # jedynie kwota netto faktycznie zaplacona, nigdy kwota ujemna.
        withholding_tax_foreign = max(-sum((item.amount for item in linked_taxes), Decimal("0.00")), Decimal("0.00"))
        withholding_tax_pln = max(
            -sum((podatek_pln_po_kursie_dywidendy[item.event_id] for item in linked_taxes), Decimal("0.00")),
            Decimal("0.00"),
        )

        dividends_view.append(
            {
                "event_id": event.event_id,
                "date": str(event.tax_event_date.date()) if event.tax_event_date is not None else None,
                "symbol": event.symbol,
                "country": event.country,
                "gross_dividend_foreign": str(event.amount),
                "currency": event.currency,
                "gross_dividend_pln": str(event.amount_pln or Decimal("0.00")),
                "withholding_tax_foreign": str(withholding_tax_foreign),
                "withholding_tax_pln": str(withholding_tax_pln),
                "withholding_tax_event_ids": [item.event_id for item in linked_taxes],
            }
        )

    for event in tax_events:
        foreign_tax_view.append(
            {
                "event_id": event.event_id,
                "date": str(event.tax_event_date.date()) if event.tax_event_date is not None else None,
                "symbol": event.symbol,
                "country": event.country,
                "currency": event.currency,
                "source_tax_foreign": str(-event.amount),
                "source_tax_pln": str(-podatek_pln_po_kursie_dywidendy.get(event.event_id, event.amount_pln or Decimal("0.00"))),
                "matched_dividend_event_id": matched_dividend_by_tax.get(event.event_id),
                "pairing_ambiguous": event.event_id in ambiguous,
            }
        )

    return dividends_view, foreign_tax_view
