from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path
from typing import Any

import pandas as pd

from investment_tax_engine.models.core import CanonicalEvent, CanonicalTrade, Issue, Ledger
from investment_tax_engine.normalize.classify import (
    infer_country,
    infer_instrument_class,
    infer_logical_world_for_trade,
)
from investment_tax_engine.normalize.trades import parse_amount
from investment_tax_engine.tax.fifo_engine import open_lots_by_symbol


DEPO_SOURCE_NAME = "DEPO_JSON"
DEPO_SOURCE_PRIORITY = 80


def _clean(value: Any) -> str:
    return " ".join(str(value or "").split()).strip()


def _decimal(value: Any, default: str = "0") -> Decimal:
    """Kwota z raportu depozytariusza.

    Wspolny parser obsluguje separatory tysiecy, przecinek dziesietny i zapis
    ksiegowy - wczesniej kazdy z tych formatow dawal tu wartosc domyslna.
    """
    parsed = parse_amount(value)
    return Decimal(default) if parsed is None else parsed


def _timestamp(value: Any) -> pd.Timestamp | None:
    if value in {None, "", "Zgrupowano"}:
        return None
    try:
        ts = pd.Timestamp(value)
        return None if pd.isna(ts) else ts
    except Exception:
        return None


def load_depo_payload(path: Path | None) -> dict[str, Any] | None:
    if path is None or not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def _find_security_flow(payload: dict[str, Any], ticker: str) -> dict[str, Any] | None:
    for row in payload.get("securities_flows_json", []):
        if _clean(row.get("ticker")).upper() == ticker.upper():
            return row
    return None


def build_supplemental_depo_records(
    payload: dict[str, Any],
    *,
    source_file: str = "",
) -> tuple[list[CanonicalTrade], list[CanonicalEvent]]:
    trades: list[CanonicalTrade] = []
    events: list[CanonicalEvent] = []

    for row in payload.get("securities_in_outs", []):
        event_type = _clean(row.get("type")).lower()
        ticker = _clean(row.get("ticker")).upper()
        if not ticker:
            continue

        quantity = abs(_decimal(row.get("quantity")))
        effective_at = _timestamp(row.get("pay_d")) or _timestamp(row.get("datetime"))
        market_value = abs(_decimal(row.get("market_value")))
        cost = abs(_decimal(row.get("cost")))
        # Waluta wyznacza kurs NBP. Podstawiony dolar przeliczal pozycje
        # w euro albo w zlotych po kursie USD; brak waluty ma zatrzymac
        # rozliczenie na bramce kursowej, a nie przejsc jako dolar.
        currency = _clean(row.get("balance_currency") or row.get("commission_currency") or "").upper()
        flow_row = _find_security_flow(payload, ticker)
        instrument_type_code = _clean((flow_row or {}).get("instr_type")) or None
        market_id = _clean((flow_row or {}).get("mkt_id")) or None
        instrument_class = infer_instrument_class(
            ticker,
            instrument_type_code,
            otc=False,
            repo_close=None,
            base_contract_code=None,
        )
        logical_world = infer_logical_world_for_trade(instrument_class)
        common_refs = [f"{DEPO_SOURCE_NAME}:{row.get('id')}"]
        country = infer_country(ticker, _clean(row.get("isin") or (flow_row or {}).get("isin")) or None)

        if event_type == "stock_award":
            completeness_status = (
                "INCOMPLETE_BONUS_CONTEST_SHARE"
                if effective_at is None or market_value <= 0 or quantity <= 0
                else "COMPLETE"
            )
            grant_tax_status = (
                "INCOMPLETE_BONUS_CONTEST_SHARE"
                if completeness_status != "COMPLETE"
                else "REVIEW_REQUIRED"
            )
            events.append(
                CanonicalEvent(
                    event_id=f"DEPO-AWARD-{row['id']}",
                    event_kind="BONUS_CONTEST_SHARE",
                    symbol=ticker,
                    linked_trade_id=None,
                    amount=market_value if market_value > 0 else cost,
                    currency=currency,
                    effective_at=effective_at,
                    comment=_clean(row.get("comment")) or _clean(row.get("comment1")) or "Broker gift share" or None,
                    source_name=DEPO_SOURCE_NAME,
                    source_priority=DEPO_SOURCE_PRIORITY,
                    source_record_id=str(row["id"]),
                    source_file=source_file,
                    source_sheet="securities_in_outs",
                    source_row_id=str(row["id"]),
                    certainty_status="CERTAIN" if completeness_status == "COMPLETE" else "CONDITIONAL",
                    review_status="AUTO_REVIEWED" if completeness_status == "COMPLETE" else "REVIEW_REQUIRED",
                    logical_world="equity_tax",
                    cost_bucket=None,
                    cost_class="CERTAIN" if completeness_status == "COMPLETE" else "CONDITIONAL",
                    country=country,
                    original_amount=market_value if market_value > 0 else cost,
                    original_currency=currency,
                    original_event_date=effective_at,
                    quantity=quantity,
                    grant_tax_status=grant_tax_status,
                    grant_market_value=market_value if market_value > 0 else None,
                    grant_value_pln=None,
                    promotion_basis=None,
                    completeness_status=completeness_status,
                    acquisition_mode="BONUS_CONTEST_SHARE",
                    economic_cost_pln=None,
                    evidence_refs=common_refs,
                    decision_trace_refs=[f"{DEPO_SOURCE_NAME}:{row['id']}:bonus_contest_share"],
                    sources=[DEPO_SOURCE_NAME],
                )
            )
            continue

        if event_type == "maturity":
            event_id = f"DEPO-MATURITY-{row['id']}"
            revenue_amount = market_value if market_value > 0 else cost
            if revenue_amount > 0 and quantity > 0:
                trades.append(
                    CanonicalTrade(
                        trade_id=event_id,
                        order_id=None,
                        trade_number=_clean(row.get("transaction_id")) or None,
                        symbol=ticker,
                        isin=None,
                        side="SELL",
                        instrument_type_code=instrument_type_code,
                        instrument_class=instrument_class,
                        market_id=market_id,
                        quantity=quantity,
                        price=(revenue_amount / quantity) if quantity else Decimal("0.00"),
                        gross_amount=revenue_amount,
                        trade_currency=currency,
                        commission=Decimal("0.00"),
                        commission_currency=currency,
                        broker_reported_profit=None,
                        executed_at=effective_at,
                        exchange_time=effective_at,
                        settlement_date=effective_at,
                        confirm_time=effective_at,
                        otc=False,
                        repo_close=None,
                        base_contract_code=None,
                        current_position_qty_after_trade=None,
                        source_name=DEPO_SOURCE_NAME,
                        source_priority=DEPO_SOURCE_PRIORITY,
                        source_record_id=str(row["id"]),
                        account_id=_clean(payload.get("plainAccountInfoData", {}).get("client_code")) or None,
                        source_file=source_file,
                        source_sheet="securities_in_outs",
                        source_row_id=str(row["id"]),
                        certainty_status="CERTAIN",
                        review_status="AUTO_REVIEWED",
                        acquisition_mode="CORPORATE_ACTION",
                        tax_cost_policy="STANDARD",
                        logical_world=logical_world,
                        cost_bucket="ANNUAL_ADJUSTMENT",
                        cost_class="CERTAIN",
                        country=country,
                        original_amount=revenue_amount,
                        original_currency=currency,
                        original_event_date=effective_at,
                        evidence_refs=common_refs,
                        decision_trace_refs=[f"{DEPO_SOURCE_NAME}:{row['id']}:maturity_sell"],
                        sources=[DEPO_SOURCE_NAME],
                    )
                )

            events.append(
                CanonicalEvent(
                    event_id=event_id,
                    event_kind="MATURITY",
                    symbol=ticker,
                    linked_trade_id=event_id,
                    amount=revenue_amount,
                    currency=currency,
                    effective_at=effective_at,
                    comment=_clean(row.get("comment")) or None,
                    source_name=DEPO_SOURCE_NAME,
                    source_priority=DEPO_SOURCE_PRIORITY,
                    source_record_id=str(row["id"]),
                    source_file=source_file,
                    source_sheet="securities_in_outs",
                    source_row_id=str(row["id"]),
                    certainty_status="CERTAIN",
                    review_status="AUTO_REVIEWED",
                    logical_world=logical_world,
                    cost_bucket=None,
                    cost_class="CERTAIN",
                    country=country,
                    original_amount=revenue_amount,
                    original_currency=currency,
                    original_event_date=effective_at,
                    evidence_refs=common_refs,
                    decision_trace_refs=[f"{DEPO_SOURCE_NAME}:{row['id']}:maturity_event"],
                    sources=[DEPO_SOURCE_NAME],
                )
            )

    return trades, events


def _expected_positions_from_payload(payload: dict[str, Any]) -> dict[str, Decimal]:
    expected: dict[str, Decimal] = {}
    if payload.get("securities_flows_json"):
        for row in payload["securities_flows_json"]:
            ticker = _clean(row.get("ticker")).upper()
            if not ticker:
                continue
            expected[ticker] = _decimal(row.get("quantity_at_end"))
        return expected

    for row in payload.get("account_at_end", {}).get("account", {}).get("positions_from_ts", {}).get("ps", {}).get("pos", []):
        ticker = _clean(row.get("base_contract_code") or row.get("i")).upper()
        if not ticker:
            continue
        expected[ticker] = _decimal(row.get("q"))
    return expected


def reconcile_fifo_lots_vs_depo(
    ledger: Ledger,
    payload: dict[str, Any],
    config: Any = None,
    *,
    aggregate_tolerance: Decimal = Decimal("0.00000001"),
) -> list[dict[str, Any]]:
    """Porownuje partie pozostale w rejestrze FIFO ze stanem raportowanym przez brokera.

    `reconcile_positions_vs_depo` liczy stan wprost z transakcji: kupno minus
    sprzedaz. To inne zrodlo niz podstawa kosztowa, wiec oba moga byc zgodne
    ze soba i jednoczesnie rozjechane z rejestrem partii - a to wlasnie rejestr
    decyduje o koszcie w rozliczeniu. Zna akcje przyznane, wykupy, zdarzenia
    korporacyjne i sprzedaze bez pokrycia; suma kupna i sprzedazy nie zna.

    Wzorzec z niemieckiego silnika podatkowego: raport brokera jest stanem
    faktycznym, a odtworzony rejestr - hipoteza. Rozjazd znaczy, ze koszt
    uzyty w rozliczeniu dotyczy innego stanu posiadania niz rzeczywisty.
    """
    expected_positions = _expected_positions_from_payload(payload)
    tax_relevant = [
        trade
        for trade in ledger.trades_by_id.values()
        if trade.logical_world == "equity_tax"
        and trade.instrument_class in {"EQUITY", "STRUCTURED_PRODUCT"}
    ]
    open_lots = open_lots_by_symbol(tax_relevant, config)

    rows: list[dict[str, Any]] = []
    for symbol in sorted(set(expected_positions) | set(open_lots)):
        expected_qty = expected_positions.get(symbol, Decimal("0"))
        lot_qty = open_lots.get(symbol, Decimal("0"))
        difference = lot_qty - expected_qty
        matches = abs(difference) <= aggregate_tolerance
        row = {
            "symbol": symbol,
            "depo_qty": str(expected_qty),
            "fifo_open_qty": str(lot_qty),
            "difference": str(difference),
            "matches": matches,
        }
        rows.append(row)
        if matches:
            continue
        ledger.issues.append(
            Issue(
                code="FIFO_LEDGER_POSITION_MISMATCH",
                severity="ERROR",
                stage="FIFO",
                scope_type="SYMBOL",
                scope_id=symbol,
                message=(
                    "Partie pozostale w rejestrze FIFO nie zgadzaja sie ze stanem u brokera. "
                    "Podstawa kosztowa uzyta w rozliczeniu dotyczy innego stanu posiadania."
                ),
                details=row,
                blocking=False,
                source_refs=[{"source": DEPO_SOURCE_NAME, "section": "securities_flows_json", "symbol": symbol}],
                policy_decision="broker_report_is_ground_truth_for_positions",
            )
        )

    return rows


def reconcile_positions_vs_depo(
    ledger: Ledger,
    payload: dict[str, Any],
    *,
    aggregate_tolerance: Decimal = Decimal("0.00000001"),
) -> list[dict[str, Any]]:
    expected_positions = _expected_positions_from_payload(payload)
    rebuilt: dict[str, Decimal] = {}
    rows: list[dict[str, Any]] = []

    for trade in ledger.trades_by_id.values():
        if trade.logical_world != "equity_tax":
            continue
        if trade.instrument_class not in {"EQUITY", "STRUCTURED_PRODUCT"}:
            continue
        sign = Decimal("1") if trade.side == "BUY" else Decimal("-1")
        rebuilt[trade.symbol] = rebuilt.get(trade.symbol, Decimal("0")) + sign * trade.quantity

    for symbol in sorted(set(expected_positions) | set(rebuilt)):
        expected_qty = expected_positions.get(symbol, Decimal("0"))
        actual_qty = rebuilt.get(symbol, Decimal("0"))
        difference = actual_qty - expected_qty
        matches = abs(difference) <= aggregate_tolerance
        row = {
            "symbol": symbol,
            "depo_qty": str(expected_qty),
            "rebuilt_qty": str(actual_qty),
            "difference": str(difference),
            "matches": matches,
        }
        rows.append(row)
        if matches:
            continue
        ledger.issues.append(
            Issue(
                code="DEPO_POSITION_MISMATCH",
                severity="CRITICAL",
                stage="RECONCILE",
                scope_type="SYMBOL",
                scope_id=symbol,
                message="Stan końcowy z raportu depozytariusza różni się od odtworzonego rejestru. Sprawdź raport w Dokumenty i silnik oraz historię transakcji.",
                details=row,
                blocking=False,
                source_refs=[{"source": DEPO_SOURCE_NAME, "section": "securities_flows_json", "symbol": symbol}],
                policy_decision="depo_control_layer_blocks_filing_ready",
            )
        )

    return rows
