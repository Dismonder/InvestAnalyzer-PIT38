from __future__ import annotations

from dataclasses import replace
from collections import defaultdict
from decimal import Decimal
from typing import Any

from investment_tax_engine.interfaces.fx import FxProvider
from investment_tax_engine.merge.trade_links import resolve_linked_trade_id
from investment_tax_engine.models.core import CostDecision, CostItem, EngineConfig, FundingFeeAllocation, Issue, MergeResult

from .fx_conversion_cost_engine import extract_fx_conversion_costs
from .funding_cost_allocator import allocate_funding_costs, confirmed_deposit
from .pit38_engine import build_private_cash_fx_view
from .policies import TAX_PLANS


EVENT_COST_MAP = {
    "TRADE_COMMISSION": ("TRADE_COMMISSION", {"conservative_user", "balanced_user", "aggressive_user"}, False),
    "RECONSTRUCTED_COMMISSION": ("TRADE_COMMISSION", {"conservative_user", "balanced_user", "aggressive_user"}, False),
    "NEGATIVE_BALANCE_INTEREST": ("INVESTMENT_INTEREST", {"balanced_user", "aggressive_user"}, False),
    # Odsetki od kredytu albo pozyczki zaciagnietej pod zakup papierow. Zwiazek
    # z przychodem jest posredni, wiec pozycja jest warunkowa i wymaga dowodu.
    "MARGIN_INTEREST": ("INVESTMENT_INTEREST", {"balanced_user", "aggressive_user"}, False),
    # Odsetki od kredytu albo pozyczki spoza rachunku maklerskiego (np. z wyciagu bankowego):
    # zaden plan ich nie dolicza - dopiero wskazanie przez podatnika, ze kredyt sfinansowal
    # zakup papierow, wlacza je do planu agresywnego.
    "LOAN_INTEREST": ("BANK_FUNDING_FEE", set(), True),
    # Oplaty za prowadzenie i przechowywanie - koszt utrzymania inwestycji.
    "ACCOUNT_FEE": ("ACCOUNT_FEE", {"balanced_user", "aggressive_user"}, False),
    # Koszt przewalutowania. Najbardziej sporna pozycja, wiec tylko plan
    # agresywny i z oznaczeniem, ze to decyzja podatnika.
    "FX_CONVERSION_FEE": ("FX_CONVERSION_COST", {"aggressive_user"}, True),
    "ANNUAL_ADJUSTMENT": ("OTHER_INVESTMENT_COST", {"balanced_user", "aggressive_user"}, False),
    "FUNDING_TRANSFER_FEE": ("TRANSFER_FEE", {"aggressive_user"}, True),
}

# Przelacznik uzytkownika dla kazdej kategorii kosztu. Bez tej mapy pola
# include_* w konfiguracji byly zapisywane i nigdy nieczytane - przelaczniki
# w interfejsie nie robily nic, liczyla sie wylacznie nazwa planu.
KATEGORIA_DO_PRZELACZNIKA = {
    "INVESTMENT_INTEREST": "include_interest_costs",
    "ACCOUNT_FEE": "include_account_fees",
    # Oplaty za przelewy i wyplaty to oplaty rachunku, a nie koszt pozyskania
    # srodkow - stad wspolny przelacznik z oplatami za prowadzenie.
    "TRANSFER_FEE": "include_account_fees",
    "FX_CONVERSION_COST": "include_fx_conversion_costs",
    "FX_CONVERSION_SPREAD_COST": "include_fx_conversion_costs",
    "PRIVATE_CASH_FX_INVESTMENT_LOSS": "include_fx_conversion_costs",
    # Koszt pozyskania srodkow na zakup papierow: odsetki i prowizje od kredytu
    # albo pozyczki wpisane przez podatnika. To wlasnie tego dotyczy
    # przelacznik "koszty finansowania zakupu".
    "BANK_FUNDING_FEE": "include_bank_funding_fees",
    "OTHER_INVESTMENT_COST": "include_misc_investment_costs",
    # TRADE_COMMISSION celowo poza mapa: prowizja maklerska to zwykly koszt
    # nabycia, a nie pozycja uznaniowa - nie podlega wylaczeniu.
}

TRADE_COMMISSION_BUCKETS = {"TRADE_COMMISSION", "RECONSTRUCTED_COMMISSION"}


def _matches_selected_tax_year(value, config: EngineConfig) -> bool:
    if config.tax_year is None or value is None:
        return True
    try:
        return int(value.year) == int(config.tax_year)
    except (AttributeError, TypeError, ValueError):
        return True


COMMISSION_MATCH_TOLERANCE_DAYS = 1


def _trade_has_commission(trade) -> bool:
    return abs(trade.commission or Decimal("0")) > 0 or abs(trade.commission_pln or Decimal("0")) > 0


def _commission_content_key(symbol, currency, amount: Decimal | None) -> tuple[str, str, Decimal] | None:
    """Klucz tresci prowizji: instrument, waluta, kwota bez znaku."""
    if amount is None:
        return None
    absolute = abs(Decimal(amount))
    if absolute == 0:
        return None
    ticker = str(symbol or "").strip().upper()
    code = str(currency or "").strip().upper()
    if not ticker or not code:
        return None
    return (ticker, code, absolute)


def _commission_pln_key(symbol, commission_pln: Decimal | None) -> tuple[str, Decimal] | None:
    """Klucz w zlotych - dla transakcji, ktore maja tylko przeliczona prowizje."""
    if commission_pln is None:
        return None
    absolute = abs(Decimal(commission_pln))
    if absolute == 0:
        return None
    ticker = str(symbol or "").strip().upper()
    return (ticker, absolute) if ticker else None


def _event_date(event):
    return getattr(event, "tax_event_date", None) or getattr(event, "effective_at", None)


def _trade_date(trade):
    for field_name in ("tax_event_date", "executed_at", "exchange_time", "settlement_date", "confirm_time"):
        value = getattr(trade, field_name, None)
        if value is not None:
            return value
    return None


def _dates_are_close(left, right) -> bool:
    """Broker ksieguje prowizje w dniu transakcji albo nastepnego dnia.

    Brak ktorejkolwiek daty konczy dopasowanie niepowodzeniem. Wczesniej znaczyl
    zgode: zdarzenie bez daty - a takie powstaja z wierszy zbiorczych brokera -
    dopasowywalo sie do transakcji z dowolnego roku.
    """
    if left is None or right is None:
        return False
    try:
        return abs((left.date() - right.date()).days) <= COMMISSION_MATCH_TOLERANCE_DAYS
    except (AttributeError, TypeError):
        return False


class TradeCommissionIndex:
    """Rozpoznaje prowizje, ktora jest juz zapisana w samej transakcji.

    `linked_trade_id` powstaje z dopasowania wyrazeniem regularnym do opisu
    brokera. Inny szyk zdania w kolejnym wyciagu zrywa to powiazanie i ta sama
    prowizja trafia do kosztow dwa razy - raz w transakcji, raz jako osobne
    zdarzenie. Gdy identyfikatora brak, indeks dopasowuje po tresci: instrument,
    waluta, kwota bez znaku i data z tolerancja jednego dnia.

    Kazda transakcja moze pokryc tylko jedno zdarzenie, wiec dwie prowizje o tej
    samej kwocie tego samego dnia nadal licza sie osobno.
    """

    def __init__(self, merge_result: MergeResult) -> None:
        self._trades = merge_result.ledger.trades_by_id
        self._by_content: dict[tuple[str, str, Decimal], list[str]] = defaultdict(list)
        self._available: set[str] = set()
        # Prowizja bywa zapisana tylko w przeliczeniu na zlote. Indeks liczony
        # wylacznie z `commission` pomijal takie transakcje, wiec ich duplikat
        # wchodzil do kosztow drugi raz.
        self._by_pln: dict[tuple[str, Decimal], list[str]] = defaultdict(list)
        for trade_id, trade in self._trades.items():
            if not _trade_has_commission(trade):
                continue
            self._available.add(str(trade_id))
            key = _commission_content_key(trade.symbol, trade.commission_currency, trade.commission)
            if key is not None:
                self._by_content[key].append(str(trade_id))
            pln_key = _commission_pln_key(trade.symbol, trade.commission_pln)
            if pln_key is not None:
                self._by_pln[pln_key].append(str(trade_id))

    def claim_linked_trades(self, events) -> None:
        """Transakcje wskazane wprost sa zajete, zanim ruszy dopasowanie po tresci."""
        for event in events:
            if event.cost_bucket not in TRADE_COMMISSION_BUCKETS:
                continue
            self._resolve_linked(event)

    def _resolve_linked(self, event) -> str | None:
        linked_trade_id = getattr(event, "linked_trade_id", None)
        if not linked_trade_id:
            return None
        resolved_trade_id = resolve_linked_trade_id(self._trades, linked_trade_id)
        if not resolved_trade_id:
            return None
        trade = self._trades.get(resolved_trade_id)
        if trade is None or not _trade_has_commission(trade):
            return None
        self._available.discard(str(resolved_trade_id))
        return str(resolved_trade_id)

    def _match_by_content(self, event) -> str | None:
        event_date = _event_date(event)
        if event_date is None:
            # Bez daty nie da sie odroznic duplikatu od osobnej oplaty.
            return None

        candidates: list[str] = []
        key = _commission_content_key(event.symbol, event.currency, getattr(event, "amount", None))
        if key is not None:
            candidates.extend(self._by_content.get(key, []))
        pln_key = _commission_pln_key(event.symbol, getattr(event, "amount_pln", None))
        if pln_key is not None:
            candidates.extend(self._by_pln.get(pln_key, []))

        for trade_id in candidates:
            if trade_id not in self._available:
                continue
            if not _dates_are_close(event_date, _trade_date(self._trades[trade_id])):
                continue
            self._available.discard(trade_id)
            return trade_id
        return None

    def duplicate_of(self, event) -> tuple[str, str] | None:
        """Zwraca (id transakcji, sposob dopasowania) albo None.

        Wskazanie transakcji wprost jest rozstrzygajace. Gdy zdarzenie wskazuje
        istniejaca transakcje, ktora nie ma wlasnej prowizji, jest to oplata
        osobna - i tak ma zostac policzona. Wczesniej trafiala wtedy do
        dopasowania po tresci, ktore zabieralo inna transakcje o tej samej
        kwocie, a prawdziwy koszt przepadal.
        """
        if event.cost_bucket not in TRADE_COMMISSION_BUCKETS:
            return None

        raw_link = getattr(event, "linked_trade_id", None)
        if raw_link:
            resolved = resolve_linked_trade_id(self._trades, raw_link)
            if resolved and resolved in self._trades:
                if _trade_has_commission(self._trades[resolved]):
                    self._available.discard(str(resolved))
                    return (str(resolved), "linked_trade_id")
                return None

        matched_trade_id = self._match_by_content(event)
        if matched_trade_id is not None:
            return (matched_trade_id, "content")
        return None


def _normalize_funding_event_to_pln(funding_event, fx_provider: FxProvider):
    if funding_event.currency.upper() == "PLN":
        return replace(
            funding_event,
            amount_pln=funding_event.amount,
            deposit_amount_pln=funding_event.deposit_amount,
        )
    lookup = fx_provider.get_rate(funding_event.currency, funding_event.date)
    deposit_amount = funding_event.deposit_amount * lookup.rate if funding_event.deposit_amount is not None else None
    return replace(
        funding_event,
        amount_pln=(funding_event.amount * lookup.rate).quantize(Decimal("0.01")),
        deposit_amount_pln=deposit_amount.quantize(Decimal("0.01")) if deposit_amount is not None else None,
    )


def _ten_sam_rok(pierwsza, druga) -> bool:
    # Bez daty nie wiadomo, z ktorego roku jest obciazenie albo zwrot - przy rozliczeniu
    # wszystkich lat para moglaby polaczyc zdarzenia z roznych lat.
    if pierwsza is None or druga is None:
        return False
    return pierwsza.year == druga.year


def _opis_kosztu(event) -> str:
    return " ".join(str(getattr(event, "comment", None) or "").split()).lower() if event is not None else ""


def _cost_allocation_target(event, resolved_linked_trade_id: str | None, linked_trade_id: str | None) -> str:
    if resolved_linked_trade_id:
        return resolved_linked_trade_id
    if linked_trade_id:
        return linked_trade_id
    if event.cost_bucket == "NEGATIVE_BALANCE_INTEREST":
        tax_event_date = event.tax_event_date or event.effective_at
        date_text = tax_event_date.date().isoformat() if tax_event_date is not None else event.event_id
        return f"negative_cash_balance:{event.currency}:{date_text}"
    return event.symbol or event.event_id


def extract_cost_items(
    merge_result: MergeResult,
    config: EngineConfig,
    fx_provider: FxProvider,
) -> tuple[list[CostItem], list[FundingFeeAllocation], list[Issue]]:
    items: list[CostItem] = []
    funding_allocations: list[FundingFeeAllocation] = []
    issues: list[Issue] = []

    all_events = list(merge_result.ledger.events_by_id.values())
    commission_index = TradeCommissionIndex(merge_result)
    commission_index.claim_linked_trades(all_events)
    # Obciazenie ma znak ujemny; kwota dodatnia w kategorii kosztu to zwrot albo
    # storno. abs() robil z niej drugi koszt: oplata -25,61 zl i jej storno +25,61 zl
    # dawaly 51,22 zl kosztow zamiast zera (art. 22 ust. 1 - koszt faktycznie poniesiony).
    zwroty: list[tuple[Any, str, Any]] = []
    # Koszt wskazany recznie przezywa wylaczenie kategorii przelacznikiem - apply_tax_plan
    # dolacza go do planu agresywnego; odciecie juz tutaj gubilo go bez sladu.
    wskazane = {str(cost_id) for cost_id in config.user_overrides.conditional_cost_ids}

    for event in all_events:
        if event.cost_bucket not in EVENT_COST_MAP:
            continue
        duplicate = commission_index.duplicate_of(event)
        if duplicate is not None:
            trade_id, match_kind = duplicate
            if match_kind == "content":
                issues.append(
                    Issue(
                        code="COMMISSION_MATCHED_BY_CONTENT",
                        severity="INFO",
                        stage="COST_POLICY",
                        scope_type="EVENT",
                        scope_id=str(event.event_id),
                        message=(
                            "Prowizja bez identyfikatora transakcji została rozpoznana po treści "
                            f"(instrument, waluta, kwota, data) jako ta sama, którą zapisano już w transakcji {trade_id}. "
                            "Nie jest liczona ponownie."
                        ),
                        details={
                            "matched_trade_id": trade_id,
                            "symbol": event.symbol,
                            "currency": event.currency,
                            "amount": str(event.amount),
                            "event_date": str(_event_date(event) or ""),
                        },
                    )
                )
            continue
        kind, plans, aggressive_only = EVENT_COST_MAP[event.cost_bucket]
        tax_event_date = event.tax_event_date or event.effective_at
        if not _matches_selected_tax_year(tax_event_date, config):
            continue
        wskazany = f"COST-{event.event_id}" in wskazane
        if kind == "INVESTMENT_INTEREST" and not config.tax_plan.include_interest_costs and not wskazany:
            continue
        if kind in {"TRANSFER_FEE"} and not config.tax_plan.include_account_fees and not wskazany:
            continue
        if kind == "OTHER_INVESTMENT_COST" and not config.tax_plan.include_misc_investment_costs and not wskazany:
            continue
        kwota_pln = event.amount_pln or Decimal("0.00")
        if kwota_pln == 0:
            continue
        if kwota_pln > 0:
            zwroty.append((event, kind, tax_event_date))
            continue
        amount_pln = -kwota_pln
        linked_trade_id = getattr(event, "linked_trade_id", None)
        resolved_linked_trade_id = resolve_linked_trade_id(merge_result.ledger.trades_by_id, linked_trade_id)
        items.append(
            CostItem(
                cost_id=f"COST-{event.event_id}",
                kind=kind,
                amount_foreign=abs(event.amount),
                currency=event.currency,
                tax_event_date=tax_event_date,
                amount_pln=amount_pln,
                source_id=event.event_id,
                policy_tags={"standard"} if not aggressive_only else {"aggressive_only"},
                evidence_level="DIRECT",
                allocation_target=_cost_allocation_target(event, resolved_linked_trade_id, linked_trade_id),
                included_in_plan=set(plans),
                is_aggressive_only=aggressive_only,
                derived_cost=False,
                notes=[
                    f"source_cost_bucket={event.cost_bucket}",
                    *([f"linked_trade_id={linked_trade_id}"] if linked_trade_id else []),
                    *(
                        [f"resolved_linked_trade_id={resolved_linked_trade_id}"]
                        if resolved_linked_trade_id and resolved_linked_trade_id != linked_trade_id
                        else []
                    ),
                ],
            )
        )

    odsetki_kredytu = [
        item
        for item in items
        if "source_cost_bucket=LOAN_INTEREST" in item.notes and item.cost_id not in wskazane
    ]
    if odsetki_kredytu:
        suma = sum((item.amount_pln for item in odsetki_kredytu), Decimal("0.00"))
        issues.append(
            Issue(
                code="LOAN_INTEREST_NOT_INCLUDED",
                severity="WARNING",
                stage="COST_POLICY",
                scope_type="ENGINE",
                scope_id="loan_interest",
                message=(
                    f"Odsetki od kredytu lub pożyczki ({len(odsetki_kredytu)} poz., {suma} zł) nie są doliczane do "
                    "kosztów automatycznie - mogą pochodzić z kredytu niezwiązanego z inwestycjami. Jeśli kredyt "
                    "sfinansował zakup papierów, wskaż te koszty w planie agresywnym."
                ),
                details={"cost_ids": [item.cost_id for item in odsetki_kredytu], "amount_pln": str(suma)},
                blocking=False,
            )
        )

    sparowane: set[str] = set()
    zdarzenia_po_id = {str(event.event_id): event for event in all_events}
    for event, kind, tax_event_date in zwroty:
        kwota_zwrotu = abs(event.amount)
        powiazana = getattr(event, "linked_trade_id", None)
        cel_zwrotu = _cost_allocation_target(
            event, resolve_linked_trade_id(merge_result.ledger.trades_by_id, powiazana), powiazana
        )
        opis_zwrotu = _opis_kosztu(event)
        kandydaci = [
            item
            for item in items
            if item.cost_id not in sparowane
            and not item.derived_cost
            and item.kind == kind
            and item.currency == event.currency
            and item.amount_foreign == kwota_zwrotu
            and _ten_sam_rok(item.tax_event_date, tax_event_date)
        ]
        # Kilka rownych obciazen: najpierw to samo powiazanie (sprzedaz, dzien salda),
        # potem ten sam opis (np. numer zlecenia wyplaty), na koncu najblizsza data -
        # zwrot przejmuje allocation_target pary, wiec zla para przesuwalaby koszt
        # miedzy poz. 21 i 23.
        para = min(
            kandydaci,
            key=lambda item: (
                item.allocation_target != cel_zwrotu,
                _opis_kosztu(zdarzenia_po_id.get(str(item.source_id))) != opis_zwrotu,
                abs((item.tax_event_date - tax_event_date).days),
            ),
            default=None,
        )
        if para is None:
            issues.append(
                Issue(
                    code="COST_REFUND_UNMATCHED",
                    severity="WARNING",
                    stage="COST_POLICY",
                    scope_type="EVENT",
                    scope_id=str(event.event_id),
                    message=(
                        f"Dodatnia kwota {kwota_zwrotu} {event.currency} w kategorii kosztu ({event.cost_bucket}) "
                        "nie ma w tym roku pasującego obciążenia, więc nie jest liczona jako koszt. Jeśli to zwykła "
                        "opłata zapisana ze znakiem plus, popraw znak w Historii transakcji."
                    ),
                    details={
                        "cost_bucket": str(event.cost_bucket),
                        "amount": str(event.amount),
                        "currency": str(event.currency),
                        "event_date": str(tax_event_date or ""),
                    },
                    blocking=False,
                )
            )
            continue
        sparowane.add(para.cost_id)
        items.append(
            CostItem(
                cost_id=f"COST-{event.event_id}",
                kind=kind,
                amount_foreign=-kwota_zwrotu,
                currency=event.currency,
                tax_event_date=tax_event_date,
                amount_pln=-(event.amount_pln or Decimal("0.00")),
                source_id=event.event_id,
                policy_tags=set(para.policy_tags),
                evidence_level="DIRECT",
                allocation_target=para.allocation_target,
                included_in_plan=set(para.included_in_plan),
                is_aggressive_only=para.is_aggressive_only,
                derived_cost=False,
                notes=[f"source_cost_bucket={event.cost_bucket}", f"zwrot_kosztu={para.cost_id}"],
            )
        )

    if config.tax_plan.include_fx_conversion_costs:
        fx_items, fx_issues = extract_fx_conversion_costs(merge_result, fx_provider)
        items.extend([item for item in fx_items if _matches_selected_tax_year(item.tax_event_date, config)])
        issues.extend(fx_issues)

        for row in build_private_cash_fx_view(merge_result, config.tax_year):
            if row.note != "buy" or row.pnl_pln >= 0:
                continue
            items.append(
                CostItem(
                    cost_id=f"PCFX-LOSS-{row.row_id}-{row.source_event_id}-{row.use_reference}",
                    kind="PRIVATE_CASH_FX_INVESTMENT_LOSS",
                    amount_foreign=row.quantity,
                    currency=row.currency,
                    tax_event_date=row.use_date,
                    amount_pln=abs(row.pnl_pln),
                    source_id=row.source_event_id,
                    policy_tags={"aggressive_only", "private_cash_fx"},
                    evidence_level="DIRECT",
                    allocation_target=row.use_reference,
                    included_in_plan={"aggressive_user"},
                    is_aggressive_only=True,
                    derived_cost=True,
                    notes=[
                        "private_cash_fx_loss_between_funding_and_investment_buy",
                        f"source_fx_rate={row.source_fx_rate}",
                        f"use_fx_rate={row.use_fx_rate}",
                        f"use_reference={row.use_reference}",
                    ],
                )
            )

    if config.tax_plan.include_bank_funding_fees and config.user_overrides.funding_cost_events:
        normalized_funding_events = []
        for funding_event in config.user_overrides.funding_cost_events:
            if not funding_event.linked_deposit_id:
                issues.append(
                    Issue(
                        code="FUNDING_FEE_WITHOUT_DEPOSIT_LINK",
                        severity="ERROR",
                        stage="COST_POLICY",
                        scope_type="EVENT",
                        scope_id=funding_event.funding_event_id,
                        message="Ręcznie wpisana opłata finansowania nie wskazuje powiązanego depozytu. Sprawdź ją w Dokumenty i silnik.",
                        blocking=False,
                    )
                )
            try:
                normalized_funding_events.append(_normalize_funding_event_to_pln(funding_event, fx_provider))
            except Exception as exc:
                issues.append(
                    Issue(
                        code="NBP_RATE_NOT_FOUND",
                        severity="CRITICAL",
                        stage="COST_POLICY",
                        scope_type="EVENT",
                        scope_id=funding_event.funding_event_id,
                        message=f"Nie udało się przeliczyć waluty ręcznie wpisanej opłaty finansowania: {exc}. Sprawdź kursy w Dokumenty i silnik.",
                        blocking=False,
                    )
                )
        funding_allocations = allocate_funding_costs(
            normalized_funding_events,
            list(merge_result.ledger.trades_by_id.values()),
            deposit_events=list(merge_result.ledger.events_by_id.values()),
            allocation_mode=config.tax_plan.funding_fee_allocation_mode,
        )
        allocated_ids = {allocation.funding_event_id for allocation in funding_allocations}
        for funding_event in normalized_funding_events:
            if not confirmed_deposit(funding_event, list(merge_result.ledger.events_by_id.values())):
                issues.append(
                    Issue(
                        code="FUNDING_FEE_DEPOSIT_UNCONFIRMED",
                        severity="ERROR",
                        stage="COST_POLICY",
                        scope_type="EVENT",
                        scope_id=funding_event.funding_event_id,
                        message="Dla powiązania opłaty finansowania nie znaleziono depozytu o zgodnej walucie i dacie; opłata nie weszła do planów automatycznych. Sprawdź dane w Dokumenty i silnik.",
                        blocking=False,
                    )
                )
                continue
            if funding_event.funding_event_id not in allocated_ids:
                issues.append(
                    Issue(
                        code="FUNDING_FEE_WITHOUT_INVESTMENT_USAGE",
                        severity="ERROR",
                        stage="COST_POLICY",
                        scope_type="EVENT",
                        scope_id=funding_event.funding_event_id,
                        message="Nie udało się przypisać opłaty finansowania do zakupu sfinansowanego z inwestycji. Sprawdź powiązanie w Dokumenty i silnik.",
                        blocking=False,
                    )
                )
        for allocation in funding_allocations:
            # Data transakcji z jednej funkcji. Wczesniej bylo tu wlasne
            # `tax_event_date or exchange_time or executed_at`, czyli inna
            # kolejnosc niz w `_trade_date` - dla transakcji na przelomie roku
            # oplata trafiala do innego roku niz sama transakcja.
            allocation_date = next(
                (
                    _trade_date(trade)
                    for trade in merge_result.ledger.trades_by_id.values()
                    if trade.trade_id == allocation.trade_id
                ),
                None,
            )
            if not _matches_selected_tax_year(allocation_date, config):
                # Oplata finansowania to nadpisanie wpisane recznie przez
                # uzytkownika. Gdy alokator dopasowal ja do zakupu z innego roku,
                # samo `continue` kasowalo ja bez sladu:
                # FUNDING_FEE_WITHOUT_INVESTMENT_USAGE zglasza sie tylko przy
                # braku alokacji, wiec uzytkownik widzial wpisana kwote i pustke
                # w kosztach, bez zdania wyjasnienia.
                issues.append(
                    Issue(
                        code="FUNDING_FEE_OUTSIDE_TAX_YEAR",
                        severity="INFO",
                        stage="COST_POLICY",
                        scope_type="EVENT",
                        scope_id=allocation.funding_event_id,
                        message=(
                            "Opłatę finansowania przypisano do zakupu "
                            f"{allocation.trade_id} from "
                            f"{allocation_date.year if allocation_date is not None else 'unknown year'}, "
                            f"poza rozliczanym rokiem {config.tax_year}; nie wchodzi ona do kosztów tego roku."
                        ),
                        blocking=False,
                    )
                )
                continue
            items.append(
                CostItem(
                    cost_id=f"FUNDING-{allocation.allocation_id}",
                    kind="BANK_FUNDING_FEE",
                    amount_foreign=allocation.allocated_amount_pln,
                    currency="PLN",
                    tax_event_date=allocation_date,
                    amount_pln=allocation.allocated_amount_pln,
                    source_id=allocation.funding_event_id,
                    policy_tags={"aggressive_only"},
                    evidence_level="DIRECT" if allocation.deposit_id else "WEAK",
                    allocation_target=allocation.trade_id,
                    included_in_plan={"aggressive_user"},
                    is_aggressive_only=True,
                    derived_cost=False,
                    notes=[f"funding_fee_allocation={allocation.method}", f"trade_id={allocation.trade_id}"],
                )
            )

    return items, funding_allocations, issues


def apply_tax_plan(costs: list[CostItem], config: EngineConfig) -> tuple[list[CostDecision], dict[str, Decimal]]:
    selected = config.tax_plan.selected_plan
    decisions: list[CostDecision] = []
    totals: dict[str, Decimal] = defaultdict(lambda: Decimal("0.00"))

    # Koszty, ktore uzytkownik swiadomie wskazal do ujecia mimo domyslnej polityki.
    # Decyzja jest zapisana w audycie z wlasnym powodem, wiec w pakiecie dowodowym
    # widac, ze to wybor podatnika, a nie wynik reguly silnika.
    conditional_cost_ids = {str(cost_id) for cost_id in config.user_overrides.conditional_cost_ids}

    for cost in costs:
        # Zwrot idzie za obciazeniem: jesli uzytkownik wskazal oplate, jej storno tez.
        para = next((note.split("=", 1)[1] for note in cost.notes if str(note).startswith("zwrot_kosztu=")), None)
        user_selected = cost.cost_id in conditional_cost_ids or (para is not None and para in conditional_cost_ids)
        for plan_name in TAX_PLANS:
            included = plan_name in cost.included_in_plan
            reason = "included_by_policy" if included else "excluded_by_policy"

            if cost.evidence_level == "WEAK" and config.tax_plan.block_weak_cost_links_in_strict_mode and config.run_mode == "STRICT":
                included = False
                reason = "weak_link_recorded_for_review"
            if cost.is_aggressive_only and plan_name != "aggressive_user":
                included = False
                reason = "aggressive_only_cost"
            # Wylaczenie kategorii przez uzytkownika dziala jak zawezenie planu:
            # moze koszt odrzucic, nigdy go nie dodaje wbrew polityce.
            przelacznik = KATEGORIA_DO_PRZELACZNIKA.get(cost.kind)
            if included and przelacznik and not getattr(config.tax_plan, przelacznik, True):
                included = False
                reason = "excluded_by_user_setting"
            # Plan agresywny to ten, w ktorym podatnik bierze na siebie obrone
            # kosztu. Wskazanie recznie nie zmienia wiec planow ostrozniejszych.
            if user_selected and plan_name == "aggressive_user" and not included:
                included = True
                reason = "included_by_user_decision"

            decisions.append(
                CostDecision(
                    cost_id=cost.cost_id,
                    plan_name=plan_name,
                    included=included,
                    reason=reason,
                    evidence_level=cost.evidence_level,
                    amount_pln=cost.amount_pln,
                    kind=cost.kind,
                    aggressive_only=cost.is_aggressive_only,
                    included_in_plans={plan_name} if included else set(),
                    policy_level="AGGRESSIVE_ONLY" if cost.is_aggressive_only else "STANDARD",
                    blocking_issue=cost.evidence_level == "WEAK" and config.run_mode == "STRICT",
                )
            )
            if included:
                totals[plan_name] += cost.amount_pln

    totals.setdefault(selected, Decimal("0.00"))
    return decisions, totals
