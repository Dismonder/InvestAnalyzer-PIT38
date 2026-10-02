from __future__ import annotations

import re
from collections import defaultdict, deque
from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Callable

import pandas as pd

from investment_tax_engine.models.core import CanonicalEvent, CanonicalTrade, EngineConfig, Issue, RealizedTaxRow, TaxLot


Q2 = Decimal("0.01")
Q8 = Decimal("0.00000001")

# Klucz kolejki FIFO: walor i rachunek ("" - jedna kolejka dla waloru).
KluczKolejki = tuple[str, str]


def q2(value: Decimal) -> Decimal:
    return value.quantize(Q2, rounding=ROUND_HALF_UP)


def q8(value: Decimal) -> Decimal:
    return value.quantize(Q8, rounding=ROUND_HALF_UP)


def has_future_buy(
    trades: list[CanonicalTrade],
    target: CanonicalTrade,
    klucz: Callable[[CanonicalTrade], Any] | None = None,
) -> bool:
    for trade in trades:
        if trade.symbol != target.symbol or trade.side != "BUY":
            continue
        if klucz is not None and klucz(trade) != klucz(target):
            continue
        if trade.tax_event_date is None or target.tax_event_date is None:
            continue
        if trade.tax_event_date > target.tax_event_date:
            return True
    return False


def normalizuj_rachunek(wartosc: Any) -> str | None:
    """Rachunek w postaci porownywalnej; spacje i myslniki nie rozrozniaja rachunkow."""
    tekst = re.sub(r"[\s-]+", "", str(wartosc or "")).upper()
    return tekst or None


def _rachunek(trade: CanonicalTrade) -> str | None:
    """Rachunek papierow wartosciowych transakcji; spacje i myslniki nie rozrozniaja rachunkow."""
    return normalizuj_rachunek(trade.account_id)


def _koncowka_rachunku(rachunek: str) -> str:
    """Rachunek w komunikacie tylko z czterema ostatnimi znakami."""
    return f"…{rachunek[-4:]}"


def _symbole_dzielone_na_rachunki(
    trades: list[CanonicalTrade],
    grants: list[CanonicalEvent],
    wpisy: list[tuple[str, Any, str, Any]],
) -> tuple[set[str], list[Issue]]:
    """Walory, dla ktorych FIFO biegnie osobno na kazdym rachunku.

    Art. 24 ust. 10 ustawy o PIT kaze stosowac FIFO odrebnie dla kazdego
    rachunku papierow wartosciowych, a wspolna kolejka brala do sprzedazy na
    rachunku B najstarsza partie z rachunku A. Podzial wymaga jednak pewnosci:
    transakcja bez rachunku (reczna, z wyciagu bez tego pola) albo akcje
    przyznane nie daja sie przypisac do kolejki. Wtedy walor zostaje we
    wspolnej kolejce, jak dotad, a ostrzezenie mowi o tym wprost - zgadywanie
    rachunku zmienialoby koszt po cichu.

    Podzial musi sie tez domykac: sprzedaz bez partii na swoim rachunku, gdy
    inny rachunek je ma, to zwykle ten sam rachunek zapisany w dwoch zrodlach
    inaczej albo przeniesienie papierow miedzy rachunkami. Kolejka rachunku
    dawala wtedy sprzedaz z zerowym kosztem i blokade, ktorej nie da sie
    usunac - uzytkownik nie ma jak zmienic rachunku transakcji.
    """
    rachunki: dict[str, set[str]] = defaultdict(set)
    bez_rachunku: dict[str, int] = defaultdict(int)
    for trade in trades:
        rachunek = _rachunek(trade)
        if rachunek is None:
            bez_rachunku[trade.symbol] += 1
        else:
            rachunki[trade.symbol].add(rachunek)
    for grant in grants:
        bez_rachunku[grant.symbol] += 1

    kandydaci: set[str] = set()
    issues: list[Issue] = []
    for symbol in sorted(rachunki):
        if len(rachunki[symbol]) < 2:
            continue
        if bez_rachunku.get(symbol):
            issues.append(
                Issue(
                    code="FIFO_ACCOUNT_UNRESOLVED",
                    severity="WARNING",
                    stage="FIFO",
                    scope_type="SYMBOL",
                    scope_id=symbol,
                    message=(
                        f"Walor {symbol} występuje na {len(rachunki[symbol])} rachunkach, ale "
                        f"{bez_rachunku[symbol]} zapisów nie ma wskazanego rachunku. FIFO liczy się osobno "
                        "dla każdego rachunku (art. 24 ust. 10 ustawy o PIT), a tych zapisów nie da się "
                        "przypisać, więc partie tego waloru rozliczono we wspólnej kolejce. Jeśli walor "
                        "leżał na kilku rachunkach naraz, sprawdź koszt jego sprzedaży."
                    ),
                    details={
                        "symbol": symbol,
                        "accounts": str(len(rachunki[symbol])),
                        "records_without_account": str(bez_rachunku[symbol]),
                    },
                    blocking=False,
                    policy_decision="single_fifo_queue_when_account_unknown",
                )
            )
            continue
        kandydaci.add(symbol)

    # Te same warunki pominiecia co w glownej petli FIFO, wiec symulacja ilosci
    # widzi dokladnie te partie, ktore potem powstana.
    stan: dict[tuple[str, str], Decimal] = defaultdict(Decimal)
    niedomkniete: dict[str, CanonicalTrade] = {}
    for rodzaj, _, _, trade in wpisy:
        if rodzaj != "TRADE" or trade.symbol not in kandydaci or trade.symbol in niedomkniete:
            continue
        klucz = (trade.symbol, _rachunek(trade) or "")
        if trade.side == "BUY":
            if trade.buy_total_cost_pln is not None and trade.quantity > 0:
                stan[klucz] += trade.quantity
            continue
        if trade.sell_net_revenue_pln is None or trade.quantity <= 0:
            continue
        if trade.quantity > stan[klucz] and any(
            ilosc > 0 for (symbol, rachunek), ilosc in stan.items() if symbol == trade.symbol and rachunek != klucz[1]
        ):
            niedomkniete[trade.symbol] = trade
            continue
        stan[klucz] = max(stan[klucz] - trade.quantity, Decimal("0"))

    dzielone: set[str] = set()
    for symbol in sorted(kandydaci):
        sprzedaz = niedomkniete.get(symbol)
        if sprzedaz is not None:
            issues.append(
                Issue(
                    code="FIFO_ACCOUNT_UNRESOLVED",
                    severity="WARNING",
                    stage="FIFO",
                    scope_type="SYMBOL",
                    scope_id=symbol,
                    message=(
                        f"Sprzedaż {sprzedaz.trade_id} waloru {symbol} nie ma pokrycia w partiach swojego "
                        "rachunku, choć inny rachunek ma partie tego waloru. To zwykle ten sam rachunek zapisany "
                        "w wyciągach inaczej albo przeniesienie papierów między rachunkami, więc partie tego "
                        "waloru rozliczono we wspólnej kolejce. Jeśli to różne rachunki, sprawdź zakupy na "
                        "rachunku tej sprzedaży."
                    ),
                    details={
                        "symbol": symbol,
                        "accounts": str(len(rachunki[symbol])),
                        "sell_trade_id": sprzedaz.trade_id,
                    },
                    blocking=False,
                    policy_decision="single_fifo_queue_when_account_split_inconsistent",
                )
            )
            continue
        dzielone.add(symbol)
        issues.append(
            Issue(
                code="FIFO_SPLIT_BY_ACCOUNT",
                severity="INFO",
                stage="FIFO",
                scope_type="SYMBOL",
                scope_id=symbol,
                message=(
                    f"FIFO dla {symbol} liczone osobno dla {len(rachunki[symbol])} rachunków (art. 24 ust. 10 "
                    "ustawy o PIT): " + ", ".join(_koncowka_rachunku(r) for r in sorted(rachunki[symbol])) + "."
                ),
                details={"symbol": symbol, "accounts": str(len(rachunki[symbol]))},
                blocking=False,
                policy_decision="fifo_per_securities_account",
            )
        )
    return dzielone, issues


def _chwila_zawarcia(trade: CanonicalTrade, config: EngineConfig) -> pd.Timestamp | None:
    """Czas zawarcia z tego samego pola, z ktorego pochodzi data podatkowa.

    Sama data (polnoc) to brak godziny, a nie transakcja o polnocy - takiej
    partii nie wolno przestawiac wzgledem innych z tego samego dnia.
    """
    if config.trade_tax_date_policy == "BOOK_DATE_FIRST":
        kandydaci = (trade.executed_at, trade.exchange_time)
    else:
        kandydaci = (trade.exchange_time, trade.executed_at)
    for kandydat in kandydaci:
        if kandydat is None:
            continue
        chwila = pd.Timestamp(kandydat)
        return None if chwila == chwila.normalize() else chwila
    return None


def _dodaj_partie(
    kolejka: deque[TaxLot],
    partia: TaxLot,
    chwila: pd.Timestamp | None,
    chwile_partii: dict[str, pd.Timestamp | None],
) -> None:
    """Dopisuje partie do kolejki; zakupy z jednego dnia ustawia wedlug godziny.

    Kolejnosc wejscia do FIFO wyznacza data i identyfikator transakcji, a
    identyfikator nie mowi nic o czasie: zakup z 10:00 o "mniejszym" numerze
    stawal przed zakupem z 9:00 i to jego koszt szedl do sprzedazy. Przestawiamy
    tylko wzgledem partii z tego samego dnia i ze znana godzina - partia bez
    godziny albo z akcji przyznanych zostaje tam, gdzie byla. Partie z tego dnia
    nie sa jeszcze naruszone, bo sprzedaze danego dnia wchodza po zakupach.
    """
    chwile_partii[partia.lot_id] = chwila
    pozycja = len(kolejka)
    if chwila is not None:
        while pozycja > 0:
            poprzednia = kolejka[pozycja - 1]
            chwila_poprzedniej = chwile_partii.get(poprzednia.lot_id)
            if (
                poprzednia.open_date != partia.open_date
                or chwila_poprzedniej is None
                or (chwila_poprzedniej.tzinfo is None) != (chwila.tzinfo is None)
                or chwila_poprzedniej <= chwila
            ):
                break
            pozycja -= 1
    kolejka.insert(pozycja, partia)


def _eligible_bonus_grants(events: list[CanonicalEvent] | None) -> list[CanonicalEvent]:
    if not events:
        return []
    return [
        event
        for event in events
        if event.event_kind == "BONUS_CONTEST_SHARE"
        and event.symbol
        and event.quantity is not None
        and event.quantity > 0
        and event.tax_event_date is not None
    ]


def _uncovered_sale_row(
    *,
    trade: CanonicalTrade,
    quantity: Decimal,
    gross_revenue_pln: Decimal,
    sell_commission_alloc_pln: Decimal,
    counter: int,
    acquisition_mode: str,
) -> RealizedTaxRow:
    """Wiersz dla ilosci sprzedanej bez znanego nabycia.

    Przychod jest realny i musi zostac wykazany; podstawa kosztowa wynosi zero,
    bo nabycia nie znamy. To zalozenie najostrozniejsze wobec urzedu i zarazem
    widoczne: rozliczenie jest w tym stanie zatrzymane przez bramke FIFO,
    a uzytkownik widzi pelna kwote razem z powodem zatrzymania.
    """
    net_revenue_pln = gross_revenue_pln - sell_commission_alloc_pln
    return RealizedTaxRow(
        row_id=f"RR-{trade.trade_id}-UNCOVERED-{counter:04d}",
        symbol=trade.symbol,
        sell_trade_id=trade.trade_id,
        buy_trade_id=None,
        quantity=quantity,
        sell_tax_date=trade.tax_event_date,
        buy_tax_date=None,
        sell_fx_date=trade.gross_fx_date or trade.tax_event_date,
        buy_fx_date=None,
        gross_revenue_pln=gross_revenue_pln,
        sell_commission_alloc_pln=sell_commission_alloc_pln,
        net_revenue_pln=net_revenue_pln,
        cost_pln=Decimal("0.00"),
        pnl_pln=net_revenue_pln,
        acquisition_mode=acquisition_mode,
        buy_reference_kind="UNCOVERED",
        sell_price=trade.price,
        sell_currency=trade.trade_currency,
        sell_fx_rate=trade.gross_fx_rate,
        economic_cost_pln=Decimal("0.00"),
        economic_result_pln=net_revenue_pln,
        grant_value_pln=None,
    )


def open_lots_by_symbol(
    trades: list[CanonicalTrade],
    config: EngineConfig | None = None,
    *,
    bonus_grants: list[CanonicalEvent] | None = None,
) -> dict[str, Decimal]:
    """Ilosci pozostajace w partiach FIFO po rozliczeniu wszystkich sprzedazy.

    Uzgodnienie stanu posiadania liczylo sie dotad wprost z transakcji
    (kupno minus sprzedaz), a wiec z innego zrodla niz podstawa kosztowa.
    Rejestr partii wie wiecej: zna akcje przyznane, zdarzenia korporacyjne i
    sprzedaze bez pokrycia. Rozjazd miedzy nim a raportem brokera znaczy, ze
    koszt uzyty w rozliczeniu dotyczy innego stanu niz rzeczywisty - i tego
    porownanie oparte na samych transakcjach nie widzi.
    """
    _, _, remaining, _ = _build_fifo(trades, config, bonus_grants=bonus_grants)
    return {symbol: quantity for symbol, quantity in remaining.items() if quantity != 0}


def open_lots_detail(
    trades: list[CanonicalTrade],
    config: EngineConfig | None = None,
    *,
    bonus_grants: list[CanonicalEvent] | None = None,
) -> list[dict[str, Any]]:
    """Partie FIFO, ktore po wszystkich sprzedazach nadal sa otwarte.

    Interfejs odtwarzal stan portfela z wierszy historii, a te obejmuja tylko
    rok rozliczenia: zakup z roku wczesniejszego, nadal trzymany, znikal z
    tabeli aktywow. Rejestr partii zna caly horyzont, wiec stan posiadania
    pochodzi z tego samego FIFO co koszt w PIT-38, a nie z drugiego rachunku.
    Cena i waluta sa przepisane z transakcji nabycia; partia z akcji
    przyznanych nie ma transakcji, wiec te pola zostaja puste.
    """
    _, _, _, lots = _build_fifo(trades, config, bonus_grants=bonus_grants)
    trades_by_id = {trade.trade_id: trade for trade in trades}
    rows: list[dict[str, Any]] = []
    for lot, remaining, cost_remaining in lots:
        if remaining <= 0:
            continue
        origin = trades_by_id.get(lot.origin_trade_id) if lot.origin_reference_kind == "TRADE" else None
        rows.append(
            {
                "lot_id": lot.lot_id,
                "symbol": lot.symbol,
                "origin_trade_id": lot.origin_trade_id,
                "origin_reference_kind": lot.origin_reference_kind,
                "open_date": lot.open_date.isoformat() if lot.open_date is not None else None,
                "acquisition_mode": lot.acquisition_mode,
                "logical_world": lot.logical_world,
                "quantity_open": str(lot.quantity_open),
                "quantity_remaining": str(remaining),
                "unit_cost_pln": str(lot.unit_cost_pln),
                "cost_remaining_pln": str(cost_remaining),
                "price": str(origin.price) if origin is not None and origin.price is not None else None,
                "currency": origin.trade_currency if origin is not None else None,
            }
        )
    rows.sort(key=lambda row: (row["symbol"], row["open_date"] or "", row["lot_id"]))
    return rows


def build_fifo_tax_rows(
    trades: list[CanonicalTrade],
    config: EngineConfig | None = None,
    *,
    bonus_grants: list[CanonicalEvent] | None = None,
) -> tuple[list[RealizedTaxRow], list[Issue]]:
    realized, issues, _, _ = _build_fifo(trades, config, bonus_grants=bonus_grants)
    return realized, issues


def _build_fifo(
    trades: list[CanonicalTrade],
    config: EngineConfig | None = None,
    *,
    bonus_grants: list[CanonicalEvent] | None = None,
) -> tuple[list[RealizedTaxRow], list[Issue], dict[str, Decimal], list[tuple[TaxLot, Decimal, Decimal]]]:
    config = config or EngineConfig()
    issues: list[Issue] = []
    fifo: dict[KluczKolejki, deque[TaxLot]] = defaultdict(deque)
    chwile_partii: dict[str, pd.Timestamp | None] = {}
    lot_remaining: dict[str, Decimal] = {}
    lot_cost_remaining: dict[str, Decimal] = {}
    lot_economic_cost_remaining: dict[str, Decimal] = {}
    realized: list[RealizedTaxRow] = []
    realized_counter = 0

    eligible_trades = [
        trade
        for trade in trades
        if trade.instrument_class in {"EQUITY", "STRUCTURED_PRODUCT"}
        and trade.side in {"BUY", "SELL"}
        and trade.tax_event_date is not None
    ]
    eligible_grants = _eligible_bonus_grants(bonus_grants)
    combined_entries = [
        ("GRANT", event.tax_event_date, event.event_id, event)
        for event in eligible_grants
    ] + [
        ("TRADE", trade.tax_event_date, trade.trade_id, trade)
        for trade in eligible_trades
    ]
    combined_entries.sort(
        key=lambda item: (
            item[1],
            0 if item[0] == "GRANT" else (1 if getattr(item[3], "side", "BUY") == "BUY" else 2),
            item[2],
        )
    )
    dzielone, issues_rachunkow = _symbole_dzielone_na_rachunki(eligible_trades, eligible_grants, combined_entries)
    issues.extend(issues_rachunkow)

    def klucz_kolejki(trade: CanonicalTrade) -> KluczKolejki:
        if trade.symbol in dzielone:
            return (trade.symbol, _rachunek(trade) or "")
        return (trade.symbol, "")

    for entry_kind, _, _, item in combined_entries:
        if entry_kind == "GRANT":
            grant = item
            economic_unit_cost = Decimal("0.00")
            if grant.grant_value_pln is not None and grant.quantity:
                economic_unit_cost = q8(grant.grant_value_pln / grant.quantity)
            lot_id = f"LOT-{grant.event_id}"
            _dodaj_partie(
                fifo[(grant.symbol, "")],
                TaxLot(
                    lot_id=lot_id,
                    symbol=grant.symbol,
                    origin_trade_id=grant.event_id,
                    open_date=grant.tax_event_date,
                    acquisition_mode="BONUS_CONTEST_SHARE",
                    quantity_open=grant.quantity,
                    quantity_remaining=grant.quantity,
                    unit_cost_pln=Decimal("0.00"),
                    fx_date=grant.fx_date or grant.tax_event_date,
                    logical_world=grant.logical_world,
                    origin_reference_kind="BONUS_GRANT",
                    economic_unit_cost_pln=economic_unit_cost,
                ),
                None,
                chwile_partii,
            )
            lot_remaining[lot_id] = grant.quantity
            lot_cost_remaining[lot_id] = Decimal("0.00")
            lot_economic_cost_remaining[lot_id] = q2(grant.grant_value_pln or Decimal("0"))
            continue

        trade = item
        if trade.side == "BUY":
            if trade.buy_total_cost_pln is None:
                issues.append(
                    Issue(
                        code="BUY_WITHOUT_PLN_COST",
                        severity="CRITICAL",
                        stage="FIFO",
                        scope_type="TRADE",
                        scope_id=trade.trade_id,
                        message="Transakcja kupna trafiła do FIFO bez kosztu w PLN. Uzupełnij kwotę lub kurs w Historii transakcji.",
                        blocking=False,
                    )
                )
                continue

            if trade.quantity <= 0:
                issues.append(
                    Issue(
                        code="INVALID_BUY_QUANTITY",
                        severity="CRITICAL",
                        stage="FIFO",
                        scope_type="TRADE",
                        scope_id=trade.trade_id,
                        message="Ilość w transakcji kupna musi być dodatnia. Popraw ją w Historii transakcji.",
                        blocking=False,
                    )
                )
                continue

            unit_cost = Decimal("0") if trade.tax_cost_policy == "ZERO_COST" else q8(trade.buy_total_cost_pln / trade.quantity)
            lot_id = f"LOT-{trade.trade_id}"
            _dodaj_partie(
                fifo[klucz_kolejki(trade)],
                TaxLot(
                    lot_id=lot_id,
                    symbol=trade.symbol,
                    origin_trade_id=trade.trade_id,
                    open_date=trade.tax_event_date,
                    acquisition_mode=trade.acquisition_mode,
                    quantity_open=trade.quantity,
                    quantity_remaining=trade.quantity,
                    unit_cost_pln=unit_cost,
                    fx_date=trade.gross_fx_date or trade.tax_event_date,
                    logical_world=trade.logical_world,
                    origin_reference_kind="TRADE",
                    economic_unit_cost_pln=unit_cost,
                ),
                _chwila_zawarcia(trade, config),
                chwile_partii,
            )
            lot_remaining[lot_id] = trade.quantity
            lot_cost_remaining[lot_id] = Decimal("0.00") if trade.tax_cost_policy == "ZERO_COST" else q2(trade.buy_total_cost_pln)
            lot_economic_cost_remaining[lot_id] = q2(trade.buy_total_cost_pln)
            continue

        if trade.sell_net_revenue_pln is None:
            issues.append(
                Issue(
                    code="SELL_WITHOUT_PLN_REVENUE",
                    severity="CRITICAL",
                    stage="FIFO",
                    scope_type="TRADE",
                    scope_id=trade.trade_id,
                    message="Transakcja sprzedaży trafiła do FIFO bez przychodu w PLN. Uzupełnij kwotę lub kurs w Historii transakcji.",
                    blocking=False,
                )
            )
            continue

        sell_gross_revenue_pln = (
            trade.sell_gross_revenue_pln
            if trade.sell_gross_revenue_pln is not None
            else trade.sell_net_revenue_pln
        )

        if trade.quantity <= 0:
            issues.append(
                Issue(
                    code="INVALID_SELL_QUANTITY",
                    severity="CRITICAL",
                    stage="FIFO",
                    scope_type="TRADE",
                    scope_id=trade.trade_id,
                    message="Ilość w transakcji sprzedaży musi być dodatnia. Popraw ją w Historii transakcji.",
                    blocking=False,
                )
            )
            continue

        remaining_qty = trade.quantity
        unit_gross = q8(sell_gross_revenue_pln / trade.quantity)
        unit_commission = q8((sell_gross_revenue_pln - trade.sell_net_revenue_pln) / trade.quantity)
        sale_gross_remaining = q2(sell_gross_revenue_pln)
        sale_commission_remaining = q2(sell_gross_revenue_pln - trade.sell_net_revenue_pln)

        kolejka = fifo[klucz_kolejki(trade)]
        while remaining_qty > 0:
            if not kolejka:
                if has_future_buy(eligible_trades, trade, klucz_kolejki):
                    issues.append(
                        Issue(
                            code="SHORT_SALE_UNSUPPORTED_CASE",
                            severity="ERROR",
                            stage="FIFO",
                            scope_type="TRADE",
                            scope_id=trade.trade_id,
                            message="Sprzedaż poprzedza późniejszy zakup tego samego instrumentu. Sprawdź kolejność transakcji w Historii transakcji; wymaga to obsługi krótkiej sprzedaży.",
                            details={"symbol": trade.symbol, "missing_qty": str(remaining_qty)},
                            blocking=False,
                            policy_decision="reject_short_sale_in_plain_fifo",
                        )
                    )
                    # Czesc sprzedazy pokryta partiami dala juz wlasne wiersze;
                    # reszta ginela razem z przychodem. Sprzedaz, ktora czesciowo
                    # zamyka pozycje, a czesciowo ja odwraca, musi rozpasc sie na
                    # dwie czesci - prowizja dzieli sie miedzy nie proporcjonalnie
                    # do ilosci, tak jak przy zwyklym dopasowaniu.
                    realized_counter += 1
                    realized.append(
                        _uncovered_sale_row(
                            trade=trade,
                            quantity=remaining_qty,
                            gross_revenue_pln=sale_gross_remaining,
                            sell_commission_alloc_pln=sale_commission_remaining,
                            counter=realized_counter,
                            acquisition_mode="SHORT_SALE_UNRESOLVED",
                        )
                    )
                    break
                elif config.award_policy == "REQUIRE_EXPLICIT":
                    issues.append(
                        Issue(
                            code="AWARD_POLICY_UNRESOLVED",
                            severity="ERROR",
                            stage="FIFO",
                            scope_type="TRADE",
                            scope_id=trade.trade_id,
                            message="Brak wcześniejszych partii FIFO dla sprzedaży i nie podano nabycia z nagrody ani zdarzenia korporacyjnego. Sprawdź historię i dodaj brakujące nabycie.",
                            details={"symbol": trade.symbol, "missing_qty": str(remaining_qty)},
                            blocking=False,
                            policy_decision="require_explicit_award_classification",
                        )
                    )
                    # Przychod ze sprzedazy istnieje niezaleznie od tego, czy znamy
                    # nabycie. Pominiecie go zanizaloby podatek i ukrylo problem,
                    # wiec ilosc bez pokrycia wchodzi z zerowa podstawa kosztowa.
                    # Rozliczenie i tak jest zatrzymane przez bramke FIFO, wiec
                    # uzytkownik zobaczy pelna kwote i powod, zamiast cichej luki.
                    realized_counter += 1
                    realized.append(
                        _uncovered_sale_row(
                            trade=trade,
                            quantity=remaining_qty,
                            gross_revenue_pln=sale_gross_remaining,
                            sell_commission_alloc_pln=sale_commission_remaining,
                            counter=realized_counter,
                            acquisition_mode="UNRESOLVED_AWARD",
                        )
                    )
                    break
                else:
                    issues.append(
                        Issue(
                            code="SELL_EXCEEDS_FIFO_LOTS",
                            severity="CRITICAL",
                            stage="FIFO",
                            scope_type="TRADE",
                            scope_id=trade.trade_id,
                            message="Ilość sprzedana przekracza dostępne partie FIFO. Sprawdź zakupy i sprzedaże w Historii transakcji.",
                            details={"symbol": trade.symbol, "missing_qty": str(remaining_qty)},
                            blocking=False,
                        )
                    )
                    realized_counter += 1
                    realized.append(
                        _uncovered_sale_row(
                            trade=trade,
                            quantity=remaining_qty,
                            gross_revenue_pln=sale_gross_remaining,
                            sell_commission_alloc_pln=sale_commission_remaining,
                            counter=realized_counter,
                            acquisition_mode="EXCEEDS_AVAILABLE_LOTS",
                        )
                    )
                    break

            lot = kolejka[0]
            available_qty = lot_remaining.get(lot.lot_id, lot.quantity_remaining)
            matched_qty = min(remaining_qty, available_qty)

            ostatni_fragment_sprzedazy = matched_qty == remaining_qty
            gross_revenue_pln = (
                sale_gross_remaining if ostatni_fragment_sprzedazy
                else min(q2(unit_gross * matched_qty), sale_gross_remaining)
            )
            sell_commission_alloc_pln = (
                sale_commission_remaining if ostatni_fragment_sprzedazy
                else min(q2(unit_commission * matched_qty), sale_commission_remaining)
            )
            net_revenue_pln = gross_revenue_pln - sell_commission_alloc_pln
            ostatni_rozchod_partii = matched_qty == available_qty
            cost_pln = (
                lot_cost_remaining[lot.lot_id] if ostatni_rozchod_partii
                else min(q2(lot.unit_cost_pln * matched_qty), lot_cost_remaining[lot.lot_id])
            )
            pnl_pln = q2(net_revenue_pln - cost_pln)
            economic_cost_pln = (
                lot_economic_cost_remaining[lot.lot_id] if ostatni_rozchod_partii
                else min(q2(lot.economic_unit_cost_pln * matched_qty), lot_economic_cost_remaining[lot.lot_id])
            )
            economic_result_pln = q2(net_revenue_pln - economic_cost_pln)

            realized_counter += 1
            realized.append(
                RealizedTaxRow(
                    row_id=f"RR-{trade.trade_id}-{lot.origin_trade_id}-{realized_counter:04d}",
                    symbol=trade.symbol,
                    sell_trade_id=trade.trade_id,
                    buy_trade_id=lot.origin_trade_id,
                    quantity=matched_qty,
                    sell_tax_date=trade.tax_event_date,
                    buy_tax_date=lot.open_date,
                    sell_fx_date=trade.gross_fx_date or trade.tax_event_date,
                    buy_fx_date=lot.fx_date,
                    gross_revenue_pln=gross_revenue_pln,
                    sell_commission_alloc_pln=sell_commission_alloc_pln,
                    net_revenue_pln=net_revenue_pln,
                    cost_pln=cost_pln,
                    pnl_pln=pnl_pln,
                    acquisition_mode=lot.acquisition_mode,
                    buy_reference_kind=lot.origin_reference_kind,
                    sell_price=trade.price,
                    sell_currency=trade.trade_currency,
                    sell_fx_rate=trade.gross_fx_rate,
                    economic_cost_pln=economic_cost_pln,
                    economic_result_pln=economic_result_pln,
                    grant_value_pln=economic_cost_pln if lot.origin_reference_kind == "BONUS_GRANT" else None,
                )
            )

            remaining_qty -= matched_qty
            sale_gross_remaining -= gross_revenue_pln
            sale_commission_remaining -= sell_commission_alloc_pln
            lot_remaining[lot.lot_id] = available_qty - matched_qty
            lot_cost_remaining[lot.lot_id] -= cost_pln
            lot_economic_cost_remaining[lot.lot_id] -= economic_cost_pln
            if lot_remaining[lot.lot_id] == 0:
                kolejka.popleft()

    pozostale: dict[str, Decimal] = {}
    for (symbol, _), lots in fifo.items():
        pozostale[symbol] = pozostale.get(symbol, Decimal("0")) + sum(
            (lot_remaining.get(lot.lot_id, lot.quantity_remaining) for lot in lots), Decimal("0")
        )
    otwarte_partie = [
        (lot, lot_remaining.get(lot.lot_id, lot.quantity_remaining), lot_cost_remaining[lot.lot_id])
        for lots in fifo.values()
        for lot in lots
    ]
    return realized, issues, pozostale, otwarte_partie
