from __future__ import annotations

import json
import re
from collections import defaultdict, deque
from dataclasses import asdict, is_dataclass
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

from .policies import DOMYSLNA_STAWKA_UMOWNA, czy_stawka_umowna_znana, stawka_umowna_dywidend
from hashlib import sha256
from typing import Any, Mapping

import pandas as pd

from ..models.core import (
    CanonicalEvent,
    EngineConfig,
    Issue,
    MergeResult,
    PrivateCashFxRow,
    RealizedTaxRow,
    ScenarioResult,
)
from .dividends_engine import build_dividend_views


Q0 = Decimal("1")
Q2 = Decimal("0.01")

# Tylko parsery eksportow, ktore resolver jednoznacznie przypisuje Freedom24.
FOREIGN_BROKER_PARSERS = frozenset({
    "local_broker_history_json", "legacy_broker_history_json",
    "broker_report_json", "depositary_report_json", "broker_transactions_xlsx",
    "cash_flows_xlsx", "traders_xlsx",
})
FOREIGN_BROKER_SOURCES = frozenset({
    "API_JSON_FULL", "TRADES_V1", "TRADES_LEGACY", "TRADERNET_TABLE",
    "BROKER_JSON", "BROKER_XML", "BROKER_REPORT_JSON",
})
# Eksporty Freedom24 rozpoznawane po nazwie. Zrzut API bywa obiektem, nie lista,
# i resolver daje mu wtedy ogolny typ "json" - na prawdziwym magazynie blokada
# PIT-8C pytala o pochodzenie wlasnego zrzutu Freedom24 (cli.py czyta go jako
# API_JSON_FULL). Pozostale nazwy zapisuje "Pobierz komplet" (freedom24Komplet.ts).
FOREIGN_BROKER_FILES = frozenset({
    "pelny_zrzut_api_transakcje.json", "historia_transakcji.json",
    "freedom24_komplet.json", "broker_raport_api.json", "dezpozytariusz_raport_api.json",
})


def q2(value: Decimal) -> Decimal:
    return value.quantize(Q2, rounding=ROUND_HALF_UP)


def q0(value: Decimal) -> Decimal:
    return value.quantize(Q0, rounding=ROUND_HALF_UP)


def event_occurs_in_year(event: CanonicalEvent, tax_year: int) -> bool:
    event_date = event.tax_event_date or event.effective_at
    return event_date is not None and event_date.year == tax_year


def build_private_cash_fx_view(merge_result: MergeResult, tax_year: int | None = None) -> list[PrivateCashFxRow]:
    deposit_lots: dict[str, deque[dict[str, Decimal | str | pd.Timestamp | None]]] = defaultdict(deque)
    rows: list[PrivateCashFxRow] = []
    row_counter = 1

    # Kolejka zasilen jest uporzadkowana chronologicznie, wiec zapis bez daty nie
    # da sie w niej umiescic. Pomijamy go zamiast wywracac przebieg na porownaniu
    # None z Timestamp - brak daty jest zglaszany osobno przy budowie wejscia.
    positive_cash_events = sorted(
        [
            event
            for event in merge_result.ledger.events_by_id.values()
            if event.logical_world == "private_cash_fx"
            and event.event_kind in {"BANK_TRANSFER", "DEPOSIT"}
            and event.amount > 0
            and (event.tax_event_date or event.effective_at) is not None
        ],
        key=lambda event: (event.tax_event_date or event.effective_at, event.event_id),
    )

    for event in positive_cash_events:
        deposit_lots[event.currency].append(
            {
                "event_id": event.event_id,
                "remaining": event.amount,
                "fx_rate": event.fx_rate or Decimal("1.00"),
                "source_date": event.tax_event_date or event.effective_at,
            }
        )

    uses: list[tuple[pd.Timestamp | None, str, str, Decimal, Decimal, str]] = []
    for event in merge_result.ledger.events_by_id.values():
        if (
            event.logical_world == "private_cash_fx"
            and event.event_kind in {"BANK_TRANSFER", "WITHDRAWAL"}
            and event.amount < 0
        ):
            uses.append(
                (
                    event.tax_event_date or event.effective_at,
                    event.event_id,
                    event.currency,
                    abs(event.amount),
                    event.fx_rate or Decimal("1.00"),
                    "withdrawal",
                )
            )

    for trade in merge_result.ledger.trades_by_id.values():
        if trade.side == "BUY" and trade.logical_world == "equity_tax":
            total_usage = trade.gross_amount + trade.commission
            uses.append(
                (
                    trade.tax_event_date,
                    trade.trade_id,
                    trade.trade_currency,
                    total_usage,
                    trade.gross_fx_rate or Decimal("1.00"),
                    "buy",
                )
            )

    uses.sort(key=lambda item: (item[0] or pd.Timestamp.max, item[1]))

    for use_date, use_reference, currency, amount, use_fx_rate, note in uses:
        remaining = amount
        lots = deposit_lots[currency]
        while remaining > 0 and lots:
            lot = lots[0]
            matched = min(remaining, lot["remaining"])  # type: ignore[arg-type]
            source_fx_rate = Decimal(str(lot["fx_rate"]))
            pnl_pln = q2((use_fx_rate - source_fx_rate) * matched)
            rows.append(
                PrivateCashFxRow(
                    row_id=f"PCFX-{row_counter}",
                    source_event_id=str(lot["event_id"]),
                    use_reference=use_reference,
                    currency=currency,
                    quantity=matched,
                    source_fx_rate=source_fx_rate,
                    use_fx_rate=use_fx_rate,
                    pnl_pln=pnl_pln,
                    source_date=lot["source_date"] if isinstance(lot["source_date"], pd.Timestamp) else None,
                    use_date=use_date,
                    note=note,
                )
            )
            row_counter += 1
            remaining -= matched
            lot["remaining"] = Decimal(str(lot["remaining"])) - matched  # type: ignore[index]
            if Decimal(str(lot["remaining"])) <= 0:
                lots.popleft()

    if tax_year is not None:
        return [
            row
            for row in rows
            if row.use_date is not None and row.use_date.year == tax_year
        ]
    return rows


# Art. 9 ust. 3 w zwiazku z ust. 6 ustawy o PIT, dla zrodla "kapitaly pieniezne":
# strate odlicza sie w pieciu kolejnych latach po roku jej poniesienia, wylacznie
# od dochodu z tego samego zrodla, a odliczenie w jednym roku nie moze przekroczyc
# polowy kwoty straty. Alternatywnie mozna odliczyc jednorazowo do 5 000 000 zl;
# nadwyzka ponad te kwote wraca do reguly polowy w pozostalych latach.
PRIOR_LOSS_CARRY_FORWARD_YEARS = 5
PRIOR_LOSS_ANNUAL_SHARE = Decimal("0.5")
PRIOR_LOSS_ONE_TIME_CAP_PLN = Decimal("5000000.00")


def prior_loss_annual_limit(loss_amount: Decimal) -> Decimal:
    """Ile z danej straty wolno odliczyc w jednym roku.

    Regula polowy, a dla strat duzych wariant jednorazowy - obowiazuje ten
    z nich, ktory pozwala odliczyc wiecej, bo ustawa daje podatnikowi wybor.
    """
    if loss_amount <= 0:
        return Decimal("0.00")
    half = q2(loss_amount * PRIOR_LOSS_ANNUAL_SHARE)
    one_time = min(loss_amount, PRIOR_LOSS_ONE_TIME_CAP_PLN)
    return max(half, one_time)


def _is_within_carry_forward_window(loss_year: int, selected_year: int) -> bool:
    """Czy strata z danego roku jest jeszcze odliczalna w roku rozliczanym."""
    return 0 < selected_year - loss_year <= PRIOR_LOSS_CARRY_FORWARD_YEARS


# Hash przebiegu liczyl sie w dwoch miejscach z osobna - tu i w
# `engine._refresh_annual_payload_hash`, ktory nadpisuje ten wynik po
# doliczeniu decyzji kosztowych. Zestawy kluczy zdazyly sie rozjechac:
# druga wersja pomijala `prior_year_loss_ledger`, wiec zmiana rozstrzygniec o
# stratach z lat ubieglych nie ruszala odcisku pakietu dowodowego. Jedna
# funkcja i jedna lista kluczy nie moga sie rozjechac.
AUDIT_HASH_KEYS = (
    "summary",
    "scenario_results",
    "dividends_view",
    "foreign_tax_view",
    "private_cash_fx_view",
    "financing_comparison",
    "prior_year_loss_ledger",
)


def _hashable(value):
    """Struktury danych sprowadzone do postaci porownywalnej przez JSON."""
    if is_dataclass(value) and not isinstance(value, type):
        return asdict(value)
    if isinstance(value, dict):
        return {key: _hashable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_hashable(item) for item in value]
    return value


def compute_audit_hash(annual_payload: Mapping[str, Any]) -> str:
    payload = {key: _hashable(annual_payload.get(key)) for key in AUDIT_HASH_KEYS}
    return sha256(json.dumps(payload, sort_keys=True, default=str).encode("utf-8")).hexdigest()[:16]


def _build_prior_year_loss_ledger(
    fifo_rows: list[RealizedTaxRow],
    config: EngineConfig,
    selected_year: int | None,
) -> list[dict[str, str | int]]:
    if selected_year is None:
        return []

    ledger: list[dict[str, str | int]] = []
    override_years: set[int] = set()
    year_counts: dict[int, int] = defaultdict(int)
    for loss in config.user_overrides.prior_year_losses:
        # Wpis odrzucony przez uzytkownika nie jest druga kwota straty za ten rok.
        if loss.accepted and _is_within_carry_forward_window(loss.tax_year, selected_year):
            year_counts[loss.tax_year] += 1
    for loss in config.user_overrides.prior_year_losses:
        if not _is_within_carry_forward_window(loss.tax_year, selected_year):
            continue
        override_years.add(loss.tax_year)
        if not loss.accepted:
            continue
        ledger.append(
            {
                "tax_year": loss.tax_year,
                "loss_pln": str(q2(loss.amount_pln)),
                "remaining_pln": str(q2(loss.remaining_pln)),
                "used_in_year": "0.00",
                "source": "USER_OVERRIDE",
                "status": (
                    "DUPLICATE_YEAR" if year_counts[loss.tax_year] > 1
                    else "REMAINING_UNCONFIRMED"
                    if selected_year - loss.tax_year > 1 and not loss.remaining_confirmed
                    else "ACCEPTED"
                ),
            }
        )

    # Strata roku to nadwyzka kosztow nad przychodami ZE ZRODLA za caly ten rok
    # (art. 9 ust. 2), a nie suma pojedynczych stratnych pozycji. Sumowanie
    # samych minusow dawalo "strate" nawet w roku zakonczonym dochodem: za 2025
    # wychodzilo 7453,73 zl do odliczenia przy realnym dochodzie 1533 zl.
    auto_result_by_year: dict[int, Decimal] = defaultdict(lambda: Decimal("0.00"))
    for row in fifo_rows:
        loss_year = row.sell_tax_date.year
        if not _is_within_carry_forward_window(loss_year, selected_year) or loss_year in override_years:
            continue
        auto_result_by_year[loss_year] += q2(
            row.gross_revenue_pln - row.cost_pln - row.sell_commission_alloc_pln
        )

    for tax_year, year_result in sorted(auto_result_by_year.items()):
        loss_amount = q2(-year_result)
        if loss_amount <= 0:
            continue
        ledger.append(
            {
                "tax_year": tax_year,
                "loss_pln": str(loss_amount),
                "remaining_pln": str(loss_amount),
                "used_in_year": "0.00",
                "source": "AUTO_FROM_REALIZED_FIFO",
                # Odliczenie wymaga, zeby strata byla wykazana w PIT-38 za rok
                # jej poniesienia (art. 9 ust. 3). Silnik tego nie wie, wiec
                # wyliczenie z danych jest propozycja do potwierdzenia, a nie
                # faktem - uzytkownik moze je nadpisac wlasnym wpisem.
                "status": "AUTO_NEEDS_CONFIRMATION",
            }
        )

    return sorted(ledger, key=lambda item: int(item["tax_year"]))


def _apply_prior_loss_usage(
    ledger: list[dict[str, str | int]],
    amount_to_use: Decimal,
) -> list[dict[str, str | int]]:
    remaining_to_use = q2(amount_to_use)
    year_available = _prior_loss_year_available(ledger)
    updated: list[dict[str, str | int]] = []
    for entry in ledger:
        year = int(entry["tax_year"])
        available = Decimal(str(entry["remaining_pln"])) if entry.get("status") == "ACCEPTED" else Decimal("0.00")
        used = min(available, year_available.get(year, Decimal("0.00")), remaining_to_use)
        year_available[year] = year_available.get(year, Decimal("0.00")) - used
        remaining_to_use -= used
        updated.append({**entry, "used_in_year": str(q2(used))})
    return updated


def _prior_loss_year_available(ledger: list[dict[str, str | int]]) -> dict[int, Decimal]:
    totals: dict[int, dict[str, Decimal]] = defaultdict(
        lambda: {"loss": Decimal("0.00"), "remaining": Decimal("0.00")}
    )
    for entry in ledger:
        if entry.get("status") != "ACCEPTED":
            continue
        year = int(entry["tax_year"])
        totals[year]["loss"] += Decimal(str(entry["loss_pln"]))
        totals[year]["remaining"] += Decimal(str(entry["remaining_pln"]))
    return {
        year: min(amounts["remaining"], prior_loss_annual_limit(amounts["loss"]))
        for year, amounts in totals.items()
    }


def build_pit38_views(
    merge_result: MergeResult,
    fifo_rows: list[RealizedTaxRow],
    config: EngineConfig,
    plan_cost_totals: dict[str, Decimal] | None = None,
) -> dict:
    selected_year = config.tax_year
    plan_cost_totals = plan_cost_totals or {}
    fifo_rows_for_year = [
        row
        for row in fifo_rows
        if selected_year is None or row.sell_tax_date.year == selected_year
    ]
    events_for_year = [
        event
        for event in merge_result.ledger.events_by_id.values()
        if selected_year is None or event_occurs_in_year(event, selected_year)
    ]

    total_revenue = sum((row.gross_revenue_pln for row in fifo_rows_for_year), Decimal("0.00"))
    total_cost = sum(
        (row.cost_pln + row.sell_commission_alloc_pln for row in fifo_rows_for_year),
        Decimal("0.00"),
    )
    total_pnl = q2(total_revenue - total_cost)

    polish_sell_ids = set(config.tax_plan.pit8c_sell_trade_ids)
    pit8c_entries = config.tax_plan.pit8c_entries
    if pit8c_entries:
        parser_by_file: dict[str, set[str]] = defaultdict(set)
        canonical_input = merge_result.ledger.metadata.get("canonical_tax_input") or {}
        records = canonical_input.get("records", []) if isinstance(canonical_input, dict) else []
        if isinstance(records, list):
            for record in records:
                source = record.get("source", {}) if isinstance(record, dict) else {}
                if not isinstance(source, dict):
                    continue
                filename = str(source.get("relative_path") or source.get("filename") or "")
                if filename:
                    parser_by_file[filename].add(str(source.get("parser") or ""))

        review_sources: dict[str, list[RealizedTaxRow]] = defaultdict(list)
        for row in fifo_rows_for_year:
            trade = merge_result.ledger.trades_by_id.get(row.sell_trade_id)
            if row.sell_trade_id in polish_sell_ids or row.sell_trade_id in config.tax_plan.pit8c_no_sell_trade_ids:
                continue
            source_name = trade.source_name if trade else ""
            source_file = trade.source_file if trade else ""
            parsers = parser_by_file.get(source_file, set())
            if (
                source_name in FOREIGN_BROKER_SOURCES
                or (parsers and parsers <= FOREIGN_BROKER_PARSERS)
                or source_file.replace("\\", "/").rsplit("/", 1)[-1].lower() in FOREIGN_BROKER_FILES
            ):
                continue
            manual_id = trade.manual_record_id if trade else None
            key = f"pit8c_record:{manual_id or row.sell_trade_id}" if source_name == "USER_OVERRIDE" or not trade else f"pit8c_source:{source_file or row.sell_trade_id}"
            decision = config.tax_plan.pit8c_source_decisions.get(key)
            review_sources[key].append(row)
            if decision == "pit8c_account":
                polish_sell_ids.add(row.sell_trade_id)

        runtime = merge_result.ledger.metadata.setdefault("canonical_tax_input_consumption_runtime", {})
        queue = runtime.setdefault("reviewQueue", [])
        for key, rows in sorted(review_sources.items()):
            trade = merge_result.ledger.trades_by_id.get(rows[0].sell_trade_id)
            source_file = trade.source_file if trade else ""
            revenue = q2(sum((row.gross_revenue_pln for row in rows), Decimal("0")))
            cost = q2(sum((row.cost_pln + row.sell_commission_alloc_pln for row in rows), Decimal("0")))
            label = (source_file or key.removeprefix("pit8c_source:")) if trade and trade.source_name != "USER_OVERRIDE" else key.removeprefix("pit8c_record:")
            queue.append({
                "decision_key": key, "kind": "pit8c_source", "date": None,
                "symbol": None, "quantity": None, "amount": str(revenue),
                "currency": "PLN", "comment": f"Zrodlo: {label}; przychod {revenue} PLN, koszt {cost} PLN.",
                "blocks_filing": True, "decision": config.tax_plan.pit8c_source_decisions.get(key), "source_files": [label],
                "occurrences": len(rows),
            })
            if config.tax_plan.pit8c_source_decisions.get(key) in {"pit8c_account", "no_pit8c_account"}:
                continue
            merge_result.ledger.issues.append(Issue(
                code="PIT8C_SOURCE_UNCONFIRMED", severity="ERROR", stage="TAX",
                scope_type="SOURCE", scope_id=key,
                message=f"Potwierdź rachunek dla {label}: przychód {revenue} PLN, koszt {cost} PLN. Wybierz PIT-8C albo brak PIT-8C w decyzjach przeglądu.",
                details={"source": label, "revenue_pln": str(revenue), "cost_pln": str(cost),
                         "sell_trade_ids": sorted({row.sell_trade_id for row in rows})},
                blocking=True,
            ))
    polish_rows = [row for row in fifo_rows_for_year if row.sell_trade_id in polish_sell_ids]
    polish_revenue = q2(sum((row.gross_revenue_pln for row in polish_rows), Decimal("0.00")))
    polish_cost = q2(sum(
        (row.cost_pln + row.sell_commission_alloc_pln for row in polish_rows), Decimal("0.00")
    ))
    pit8c_revenue = polish_revenue
    pit8c_cost = polish_cost
    valid_entries: list[tuple[Decimal, Decimal]] = []
    if pit8c_entries:
        for index, entry in enumerate(pit8c_entries, 1):
            amounts: list[Decimal] = []
            errors: list[str] = []
            if not isinstance(entry, Mapping):
                errors.append("wpis nie jest obiektem")
            else:
                if entry.get("_input_error"):
                    errors.append(str(entry["_input_error"]))
                for key in ("revenuePln", "costsPln"):
                    raw = entry.get(key)
                    try:
                        if raw is None or isinstance(raw, bool) or str(raw).strip() == "":
                            raise ValueError("brak kwoty")
                        amount = Decimal(str(raw))
                        if not amount.is_finite():
                            raise ValueError("kwota nie jest skonczona")
                        if amount < 0:
                            raise ValueError("kwota ujemna")
                        if amount.as_tuple().exponent < -2:
                            raise ValueError("wiecej niz 2 miejsca po przecinku")
                        if not re.fullmatch(r"[0-9]+(?:\.[0-9]{1,2})?", str(raw).strip()):
                            raise ValueError("nieobslugiwany zapis kwoty")
                        if len(amount.as_tuple().digits) + max(amount.as_tuple().exponent, 0) > 24:
                            raise ValueError("kwota przekracza zakres obliczen")
                        amounts.append(amount)
                    except InvalidOperation:
                        errors.append(f"{key}: tekst nie jest liczba ({raw!r})")
                    except ValueError as exc:
                        errors.append(f"{key}: {exc} ({raw!r})")
            if errors:
                merge_result.ledger.issues.append(Issue(
                    code="PIT8C_INPUT_INVALID", severity="ERROR", stage="TAX",
                    scope_type="PIT8C_ENTRY", scope_id=str(index),
                    message=f"Wpis PIT-8C {index} nie został użyty: {', '.join(errors)}",
                    details={"entry_index": index, "errors": errors}, blocking=True,
                ))
            else:
                valid_entries.append((amounts[0], amounts[1]))
        # Gdy zaden wpis nie nadaje sie do uzycia, poz. 20/21 zostaja z wlasnego
        # rachunku czesci polskiej. Zero z pustej sumy wycinaloby polski dochod
        # z formularza - blokada i tak wstrzymuje zlozenie, ale kwoty na ekranie
        # nie moga wtedy zanizac dochodu.
        if valid_entries:
            pit8c_revenue = q2(sum((amount[0] for amount in valid_entries), Decimal("0.00")))
            pit8c_cost = q2(sum((amount[1] for amount in valid_entries), Decimal("0.00")))

    dividends_view, foreign_tax_view = build_dividend_views(
        events_for_year, reference_events=list(merge_result.ledger.events_by_id.values()),
    )
    niejednoznaczne_podatki = [row["event_id"] for row in foreign_tax_view if row.get("pairing_ambiguous")]
    if niejednoznaczne_podatki:
        merge_result.ledger.issues.append(
            Issue(
                code="DIVIDEND_TAX_PAIRING_AMBIGUOUS",
                severity="ERROR",
                stage="TAX",
                scope_type="ENGINE",
                scope_id="art30a",
                message="Nie można jednoznacznie przypisać podatku u źródła do dywidendy: "
                        + ", ".join(sorted(niejednoznaczne_podatki)),
                blocking=True,
            )
        )

    # Dywidenda albo podatek u zrodla bez przeliczenia na zlote wchodzil do
    # zestawienia jako 0,00 PLN (`event.amount_pln or Decimal("0.00")`):
    # przychod z czesci G znikal, odliczenie malalo, a nic tego nie zglaszalo.
    # Transakcje maja na to swoje bramki (BUY_WITHOUT_PLN_COST,
    # SELL_WITHOUT_PLN_REVENUE) - dywidendy nie mialy zadnej.
    zdarzenia_bez_kwoty_pln = [
        event
        for event in events_for_year
        if event.event_kind in {"DIVIDEND", "TAX"} and event.amount_pln is None
    ]
    if zdarzenia_bez_kwoty_pln:
        identyfikatory = sorted(str(event.event_id) for event in zdarzenia_bez_kwoty_pln)
        merge_result.ledger.issues.append(
            Issue(
                code="DIVIDEND_WITHOUT_PLN_AMOUNT",
                severity="ERROR",
                stage="TAX",
                scope_type="ENGINE",
                scope_id="art30a",
                message=(
                    f"{len(identyfikatory)} wypłatom dywidendy albo podatku u źródła brakuje kwoty "
                    "w złotych — brakuje kursu NBP z dnia roboczego poprzedzającego wypłatę. "
                    "Bez niego przychód i odliczenie zostałyby obliczone jako zero. Zdarzenia: "
                    + ", ".join(identyfikatory[:10])
                    + ("..." if len(identyfikatory) > 10 else "")
                ),
                blocking=True,
            )
        )
    private_cash_fx_view = build_private_cash_fx_view(merge_result, selected_year)
    private_cash_fx_investment_loss_total = (
        q2(
            sum(
                (
                    abs(row.pnl_pln)
                    for row in private_cash_fx_view
                    if row.note == "buy" and row.pnl_pln < 0
                ),
                Decimal("0.00"),
            )
        )
        if config.tax_plan.include_fx_conversion_costs
        else Decimal("0.00")
    )

    financing_events = [
        event
        for event in events_for_year
        if event.logical_world == "financing_costs"
    ]
    daily_charge_total = sum(
        (
            abs(event.amount_pln or Decimal("0.00"))
            for event in financing_events
            if event.cost_bucket == "NEGATIVE_BALANCE_INTEREST"
        ),
        Decimal("0.00"),
    )
    transfer_fee_total = sum(
        (
            abs(event.amount_pln or Decimal("0.00"))
            for event in financing_events
            if event.cost_bucket == "FUNDING_TRANSFER_FEE"
        ),
        Decimal("0.00"),
    )
    annual_adjustment_total = sum(
        (
            abs(event.amount_pln or Decimal("0.00"))
            for event in financing_events
            if event.cost_bucket == "ANNUAL_ADJUSTMENT"
        ),
        Decimal("0.00"),
    )
    taxes_from_dane = sum(
        (
            -(event.amount_pln or Decimal("0.00"))
            for event in events_for_year
            if event.cost_bucket == "SOURCE_TAX"
        ),
        Decimal("0.00"),
    )
    taxes_from_dane = max(taxes_from_dane, Decimal("0.00"))

    prior_year_loss_ledger = _build_prior_year_loss_ledger(fifo_rows, config, selected_year)
    loss_year_counts: dict[int, int] = defaultdict(int)
    if selected_year is not None:
        for loss in config.user_overrides.prior_year_losses:
            if loss.accepted and _is_within_carry_forward_window(loss.tax_year, selected_year):
                loss_year_counts[loss.tax_year] += 1
    for year, count in loss_year_counts.items():
        if count > 1:
            merge_result.ledger.issues.append(Issue(
                code="DUPLICATE_PRIOR_YEAR_LOSS", severity="ERROR", stage="TAX",
                scope_type="ENGINE", scope_id=str(year),
                message=f"Dwa wpisy straty za {year}. Pozostaw jedną kwotę z PIT-38 za ten rok.", blocking=True,
            ))
    for loss in prior_year_loss_ledger:
        if loss.get("status") == "REMAINING_UNCONFIRMED":
            year = int(loss["tax_year"])
            merge_result.ledger.issues.append(Issue(
                code="PRIOR_YEAR_LOSS_REMAINING_UNCONFIRMED", severity="ERROR", stage="TAX",
                scope_type="ENGINE", scope_id=str(year),
                message=f"Potwierdź pozostałą do odliczenia kwotę straty za {year} po wcześniejszych zeznaniach.",
                blocking=True,
            ))
    # Odliczyc mozna nie wiecej, niz zostalo z danej straty, i nie wiecej, niz
    # dopuszcza limit roczny liczony od jej pelnej kwoty.
    #
    # Licza sie wylacznie straty potwierdzone przez uzytkownika. Odliczenie
    # wymaga, zeby strata byla wykazana w PIT-38 za rok jej poniesienia
    # (art. 9 ust. 3), a tego silnik nie wie - zna tylko wgrane pliki. Wyliczenie
    # z danych jest wiec propozycja do potwierdzenia. Silnik nie pamieta tez, ile
    # z danej straty odliczono w poprzednich latach, wiec sam by ja oferowal w
    # calosci rok po roku; ile zostalo, podaje uzytkownik w polu remaining_pln.
    prior_losses_available = sum(_prior_loss_year_available(prior_year_loss_ledger).values(), Decimal("0.00"))

    balanced_extra = q2(plan_cost_totals.get("balanced_user", Decimal("0.00")))
    aggressive_extra = q2(plan_cost_totals.get("aggressive_user", Decimal("0.00")))
    conservative_extra = q2(plan_cost_totals.get("conservative_user", Decimal("0.00")))

    scenario_inputs = {
        "conservative": {
            "additional_cost": conservative_extra,
            "risk_level": "low",
            "additional_costs": ["STANDARD_ONLY"] if conservative_extra > 0 else [],
        },
        "defensible": {
            "additional_cost": balanced_extra,
            "risk_level": "medium",
            "additional_costs": [
                name
                for name, amount in {
                    "NEGATIVE_BALANCE_INTEREST": daily_charge_total,
                    "ANNUAL_ADJUSTMENT": annual_adjustment_total,
                }.items()
                if amount > 0 or balanced_extra > 0
            ],
        },
        "aggressive_user": {
            "additional_cost": aggressive_extra,
            "risk_level": "high",
            "additional_costs": [
                name
                for name, amount in {
                    "NEGATIVE_BALANCE_INTEREST": daily_charge_total,
                    "ANNUAL_ADJUSTMENT": annual_adjustment_total,
                    "FUNDING_TRANSFER_FEE": transfer_fee_total,
                    "PRIVATE_CASH_FX_INVESTMENT_LOSS": private_cash_fx_investment_loss_total,
                    "FX_CONVERSION_SPREAD_COST": max(
                        aggressive_extra
                        - q2(
                            daily_charge_total
                            + annual_adjustment_total
                            + transfer_fee_total
                            + private_cash_fx_investment_loss_total
                        ),
                        Decimal("0.00"),
                    ),
                }.items()
                if amount > 0
            ],
        },
    }

    scenario_results: dict[str, ScenarioResult] = {}
    for scenario_name, scenario_input in scenario_inputs.items():
        total_cost_for_scenario = q2(total_cost + scenario_input["additional_cost"] - polish_cost + pit8c_cost)
        form_revenue = q2(total_revenue - polish_revenue + pit8c_revenue)
        gross_result = q2(form_revenue - total_cost_for_scenario)
        prior_loss_used = min(max(gross_result, Decimal("0.00")), prior_losses_available)
        taxable_base = q2(max(gross_result - prior_loss_used, Decimal("0.00")))
        tax_19 = q2(taxable_base * Decimal("0.19"))
        net = q2(gross_result - tax_19 - taxes_from_dane)
        notes = []
        if prior_loss_used > 0:
            notes.append(f"Applied prior losses: {prior_loss_used}")

        scenario_results[scenario_name] = ScenarioResult(
            scenario_name=scenario_name,
            risk_level=str(scenario_input["risk_level"]),
            gross_result_pln=gross_result,
            taxable_base_pln=taxable_base,
            tax_19_pln=tax_19,
            taxes_from_dane_pln=q2(taxes_from_dane),
            net_pln=net,
            total_revenue_pln=form_revenue,
            total_cost_pln=total_cost_for_scenario,
            additional_costs=list(scenario_input["additional_costs"]),
            notes=notes,
        )

    defensible_net = scenario_results["defensible"].net_pln
    for scenario in scenario_results.values():
        scenario.delta_vs_defensible_pln = q2(scenario.net_pln - defensible_net)

    plan_to_scenario = {
        "aggressive_user": "aggressive_user",
        "balanced_user": "defensible",
        "conservative_user": "conservative",
    }
    selected_plan = config.tax_plan.selected_plan
    primary = scenario_results[plan_to_scenario.get(selected_plan, config.default_scenario)]
    primary_gross_result = max(primary.gross_result_pln, Decimal("0.00"))
    primary_prior_loss_used = min(primary_gross_result, prior_losses_available)
    prior_year_loss_ledger = _apply_prior_loss_usage(prior_year_loss_ledger, primary_prior_loss_used)
    pit38_revenue = q0(primary.total_revenue_pln)
    pit38_cost = q0(primary.total_cost_pln)
    pit38_income = q0(primary.taxable_base_pln)
    pit38_loss = q0(abs(primary.gross_result_pln)) if primary.gross_result_pln < 0 else Decimal("0")
    # Pola formularza zachowuja grosze przed odliczeniem strat. Podstawa
    # i podatek nalezny maja osobne zaokraglenie dopiero na koncu.
    pit38_form_income = max(primary.gross_result_pln, Decimal("0.00"))
    pit38_form_loss = max(-primary.gross_result_pln, Decimal("0.00"))
    pit38_form_base = q0(primary.taxable_base_pln)
    pit38_form_tax = q2(pit38_form_base * Decimal("0.19"))
    pit38_form_tax_due = q0(pit38_form_tax)
    foreign_dividends = [row for row in dividends_view if str(row.get("country") or "").upper() != "PL"]
    domestic_dividends = [row for row in dividends_view if str(row.get("country") or "").upper() == "PL"]
    if domestic_dividends:
        domestic_amount = sum((Decimal(row["gross_dividend_pln"]) for row in domestic_dividends), Decimal("0.00"))
        domestic_symbols = sorted({str(row.get("symbol") or "?") for row in domestic_dividends})
        merge_result.ledger.issues.append(
            Issue(
                code="DOMESTIC_DIVIDEND_EXCLUDED",
                severity="WARNING",
                stage="TAX",
                scope_type="ENGINE",
                scope_id="art30a",
                message=(
                    f"Dywidendy ze źródeł polskich ({q2(domestic_amount)} PLN; symbole: "
                    f"{', '.join(domestic_symbols)}) rozlicza płatnik; jeśli płatnik nie pobrał "
                    "podatku, wykaż go w poz. 46 PIT-38."
                ),
                blocking=False,
            )
        )
    gross_dividends_pln = sum((Decimal(row["gross_dividend_pln"]) for row in foreign_dividends), Decimal("0.00"))
    foreign_withholding_pln = sum(
        (Decimal(row["withholding_tax_pln"]) for row in foreign_dividends),
        Decimal("0.00"),
    ) + sum(
        (
            Decimal(row["source_tax_pln"])
            for row in foreign_tax_view
            if not row.get("matched_dividend_event_id")
            and str(row.get("country") or "").upper() != "PL"
            and Decimal(row["source_tax_pln"]) > 0
        ),
        Decimal("0.00"),
    )

    # Limit stawki umownej. Odliczyc w Polsce mozna nie wiecej, niz wynika
    # z umowy o unikaniu podwojnego opodatkowania z krajem zrodla - dla USA 15%.
    # Gdy platnik pobral wiecej (30% przy braku formularza W-8BEN), nadwyzka nie
    # zmniejsza polskiego podatku; odzyskuje sie ja od zagranicznego urzedu.
    # Bez tego limitu rozliczenie zanizalo podatek nalezny w Polsce.
    foreign_withholding_creditable_pln = Decimal("0.00")
    # Panstwa, dla ktorych stawki umownej nie ma w tabeli - limit odliczenia
    # policzony jest wtedy z zalozenia, a nie z umowy.
    panstwa_bez_stawki: set[str] = set()
    for row in dividends_view:
        if str(row.get("country") or "").upper() == "PL":
            row["polish_tax_due_pln"] = "0.00"
            row["creditable_tax_pln"] = "0.00"
            row["tax_to_pay_pln"] = "0.00"
            continue
        brutto_dywidendy = Decimal(row.get("gross_dividend_pln") or "0.00")
        pobrany_podatek = Decimal(row.get("withholding_tax_pln") or "0.00")
        kraj_dywidendy = row.get("country")
        if brutto_dywidendy > 0 and not czy_stawka_umowna_znana(kraj_dywidendy):
            panstwa_bez_stawki.add(str(kraj_dywidendy or "nieustalone"))
        limit_umowny = q2(brutto_dywidendy * stawka_umowna_dywidend(kraj_dywidendy))
        odliczenie_wiersza = min(pobrany_podatek, limit_umowny)
        podatek_wiersza = q2(brutto_dywidendy * Decimal("0.19"))
        odliczenie_wiersza = min(odliczenie_wiersza, podatek_wiersza)
        foreign_withholding_creditable_pln += odliczenie_wiersza
        row["polish_tax_due_pln"] = str(podatek_wiersza)
        row["creditable_tax_pln"] = str(odliczenie_wiersza)
        row["tax_to_pay_pln"] = str(q2(podatek_wiersza - odliczenie_wiersza))

    if panstwa_bez_stawki:
        procent = (DOMYSLNA_STAWKA_UMOWNA * 100).quantize(Decimal("1"))
        merge_result.ledger.issues.append(
            Issue(
                code="TREATY_RATE_ASSUMED",
                severity="WARNING",
                stage="TAX",
                scope_type="ENGINE",
                scope_id="art30a",
                message=(
                    f"Stawki umownej nie ma w tabeli dla: {', '.join(sorted(panstwa_bez_stawki))}. "
                    f"Limit odliczenia obliczono przy założonej stawce {procent}% — sprawdź umowę "
                    "o unikaniu podwójnego opodatkowania z tym państwem. Niższa stawka umowna "
                    "oznacza, że odliczono za dużo i podatek jest zaniżony."
                ),
                blocking=False,
            )
        )

    # Podatek, ktorego silnik nie powiazal z zadna dywidenda (np. wyplata spoza
    # zakresu wgranych plikow), nie ma wlasnej podstawy do limitu umownego.
    # Bez powiazania z konkretna wyplata nie mozna odliczyc go od podatku
    # naleznego od innych dywidend. Zachowujemy kwote w audycie.
    podatek_bez_dopasowania = sum(
        (
            Decimal(row.get("source_tax_pln") or "0.00")
            for row in foreign_tax_view
            if not row.get("matched_dividend_event_id") and str(row.get("country") or "").upper() != "PL"
            and Decimal(row.get("source_tax_pln") or "0.00") > 0
        ),
        Decimal("0.00"),
    )
    if podatek_bez_dopasowania > 0:
        merge_result.ledger.issues.append(
            Issue(
                code="FOREIGN_TAX_WITHOUT_DIVIDEND",
                severity="WARNING",
                stage="TAX",
                scope_type="ENGINE",
                scope_id="art30a",
                message=(
                    f"{q2(podatek_bez_dopasowania)} PLN podatku pobranego za granicą nie ma "
                    "powiązanej wypłaty dywidendy w danych, więc limitu stawki umownej nie da "
                    "się do niego zastosować (art. 30a ust. 9). Kwota nie wchodzi do "
                    "odliczenia; wymaga powiazania z wyplata dywidendy."
                ),
                blocking=False,
            )
        )

    zwrot_bez_dopasowania = sum(
        (
            -Decimal(row.get("source_tax_pln") or "0.00")
            for row in foreign_tax_view
            if not row.get("matched_dividend_event_id") and str(row.get("country") or "").upper() != "PL"
            and Decimal(row.get("source_tax_pln") or "0.00") < 0
        ),
        Decimal("0.00"),
    )
    if zwrot_bez_dopasowania > 0:
        merge_result.ledger.issues.append(
            Issue(
                code="FOREIGN_TAX_WITHOUT_DIVIDEND",
                severity="WARNING",
                stage="TAX",
                scope_type="ENGINE",
                scope_id="art30a",
                message=(
                    f"Zwrot podatku u źródła {q2(zwrot_bez_dopasowania)} PLN nie ma "
                    "powiązanej dywidendy w tym roku; nie zwiększa odliczenia w poz. 48."
                ),
                blocking=False,
            )
        )

    foreign_tax_not_creditable_pln = max(
        foreign_withholding_pln - foreign_withholding_creditable_pln, Decimal("0.00")
    )

    # Podatek od dywidend liczy silnik, a nie interfejs.
    #
    # Zryczaltowany podatek to 19% przychodu (art. 30a ust. 1 pkt 4), a odliczyc
    # mozna wylacznie kwote miesczaca sie w limicie stawki umownej - i nie wiecej
    # niz sam polski podatek (art. 30a ust. 9). Interfejs liczyl to wczesniej po
    # swojemu i odejmowal CALY podatek pobrany za granica, wiec u kogos bez
    # formularza W-8BEN (30% zamiast 15%) zanizal kwote nalezna w Polsce.
    dividend_polish_tax_pln = q2(gross_dividends_pln * Decimal("0.19"))
    dividend_credit_used_pln = min(foreign_withholding_creditable_pln, dividend_polish_tax_pln)
    dividend_tax_to_pay_pln = q2(dividend_polish_tax_pln - dividend_credit_used_pln)

    financing_comparison = {
        "DAILY_CHARGE": {"total_pln": str(q2(daily_charge_total)), "included_in_scenarios": ["defensible", "aggressive_user"]},
        "POSITION_ALLOCATED": {"total_pln": "0.00", "included_in_scenarios": []},
        "FUNDING_TRANSFER_FEE": {"total_pln": str(q2(transfer_fee_total)), "included_in_scenarios": ["aggressive_user"]},
    }

    art30b = {
        "tax_year": str(selected_year) if selected_year is not None else "ALL",
        "total_revenue_pln": str(q2(total_revenue)),
        "total_cost_pln": str(q2(total_cost)),
        "total_pnl_pln": str(total_pnl),
        "pit38_rounded_revenue_pln": str(pit38_revenue),
        "pit38_rounded_cost_pln": str(pit38_cost),
        "pit38_income": str(pit38_income),
        "pit38_loss": str(pit38_loss),
        "pit38_form_revenue_pln": str(q2(primary.total_revenue_pln)),
        "pit38_form_cost_pln": str(q2(primary.total_cost_pln)),
        "pit38_form_income_pln": str(pit38_form_income),
        "pit38_form_loss_pln": str(pit38_form_loss),
        "pit38_form_base_pln": str(pit38_form_base),
        "pit38_form_tax_pln": str(pit38_form_tax),
        "pit38_form_tax_due_pln": str(pit38_form_tax_due),
        "tax_19_pln": str(primary.tax_19_pln),
        "net_pln": str(primary.net_pln),
        "prior_year_losses_available_pln": str(q2(prior_losses_available)),
        "prior_year_loss_used_pln": str(q2(primary_prior_loss_used)),
    }
    if pit8c_entries or polish_sell_ids:
        art30b.update({
            "pit8c_sell_trade_ids": sorted(polish_sell_ids),
            "pit8c_revenue_pln": str(pit8c_revenue),
            "pit8c_cost_pln": str(pit8c_cost),
            "pit8c_calculated_revenue_pln": str(polish_revenue),
            "pit8c_calculated_cost_pln": str(polish_cost),
            "pit8c_revenue_difference_pln": str(q2(pit8c_revenue - polish_revenue)),
            "pit8c_cost_difference_pln": str(q2(pit8c_cost - polish_cost)),
            "pit8c_source": "informacja" if valid_entries else "transakcje",
        })
    # Odsetki otrzymane od wolnych srodkow to przychod z art. 30a ust. 1 pkt 3,
    # a nie dywidenda z pkt 4. Roznica nie jest kosmetyczna: zryczaltowany
    # podatek od pkt 1-3 zaokragla sie do pelnych groszy w gore (art. 63
    # par. 1a Ordynacji), a nie do pelnych zlotych jak reszta czesci G.
    credit_interest_events = [
        event for event in events_for_year if event.event_kind == "CREDIT_INTEREST"
    ]
    gross_credit_interest_pln = sum(
        (abs(event.amount_pln or Decimal("0.00")) for event in credit_interest_events),
        Decimal("0.00"),
    )
    art30a = {
        "tax_year": str(selected_year) if selected_year is not None else "ALL",
        "gross_dividends_pln": str(q2(gross_dividends_pln)),
        "foreign_withholding_tax_pln": str(q2(foreign_withholding_pln)),
        # Kwota odliczalna od powiazanych dywidend po limicie umownym oraz
        # kwota bez prawa do automatycznego odliczenia (w tym niedopasowana).
        "foreign_withholding_creditable_pln": str(q2(foreign_withholding_creditable_pln)),
        "foreign_tax_not_creditable_pln": str(q2(foreign_tax_not_creditable_pln)),
        # Zryczaltowany podatek 19% i kwota po odliczeniu tego, co faktycznie
        # wolno odliczyc. Interfejs ma je tylko pokazac.
        "polish_tax_19_pln": str(dividend_polish_tax_pln),
        "credit_used_pln": str(q2(dividend_credit_used_pln)),
        "tax_to_pay_pln": str(dividend_tax_to_pay_pln),
        "gross_credit_interest_pln": str(q2(gross_credit_interest_pln)),
        "credit_interest_row_count": len(credit_interest_events),
        "dividend_row_count": len(foreign_dividends),
        "foreign_tax_row_count": len(foreign_tax_view),
    }

    summary = {
        "primary_scenario": plan_to_scenario.get(selected_plan, config.default_scenario),
        "total_revenue_pln": str(q2(total_revenue)),
        "total_cost_pln": str(q2(total_cost)),
        "total_pnl_pln": str(total_pnl),
        "pit38_rounded_revenue_pln": str(pit38_revenue),
        "pit38_rounded_cost_pln": str(pit38_cost),
        "pit38_income": str(pit38_income),
        "pit38_loss": str(pit38_loss),
        "pit38_form_revenue_pln": str(q2(primary.total_revenue_pln)),
        "pit38_form_cost_pln": str(q2(primary.total_cost_pln)),
        "pit38_form_income_pln": str(pit38_form_income),
        "pit38_form_loss_pln": str(pit38_form_loss),
        "pit38_form_base_pln": str(pit38_form_base),
        "pit38_form_tax_pln": str(pit38_form_tax),
        "pit38_form_tax_due_pln": str(pit38_form_tax_due),
        "tax_19_pln": str(primary.tax_19_pln),
        "taxes_from_dane_pln": str(primary.taxes_from_dane_pln),
        "net_pln": str(primary.net_pln),
        "private_cash_fx_investment_loss_pln": str(private_cash_fx_investment_loss_total),
        "prior_year_losses_available_pln": str(q2(prior_losses_available)),
        "prior_year_loss_used_pln": str(q2(primary_prior_loss_used)),
        "tax_year": str(selected_year) if selected_year is not None else "ALL",
        "plan_used": selected_plan,
        "plan_label": selected_plan.replace("_user", "").replace("_", " ").title(),
        "include_fx_conversion_costs": "tak" if aggressive_extra > balanced_extra else "nie",
        "include_interest_costs": "tak" if balanced_extra > conservative_extra else "nie",
        "include_account_costs": "tak" if aggressive_extra > Decimal("0.00") or balanced_extra > Decimal("0.00") else "nie",
        "aggressive_only_items": "1" if aggressive_extra > balanced_extra else "0",
        "art30b": art30b,
        "art30a": art30a,
    }

    annual_payload = {
        "summary": summary,
        "scenario_results": scenario_results,
        "dividends_view": dividends_view,
        "foreign_tax_view": foreign_tax_view,
        "private_cash_fx_view": private_cash_fx_view,
        "financing_comparison": financing_comparison,
        "prior_year_loss_ledger": prior_year_loss_ledger,
    }
    annual_payload["audit_hash"] = compute_audit_hash(annual_payload)
    return annual_payload
