from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP

import pandas as pd

from investment_tax_engine.interfaces.fx import FxProvider
from investment_tax_engine.models.core import (
    CalculationTrace,
    CanonicalDataset,
    CanonicalEvent,
    CanonicalTrade,
    EngineConfig,
    Issue,
    MergeResult,
)
from investment_tax_engine.tax.crypto_engine import czy_prowizja_w_walucie_wirtualnej, czy_wymiana_krypto_na_krypto


Q2 = Decimal("0.01")


def q2(value: Decimal) -> Decimal:
    return value.quantize(Q2, rounding=ROUND_HALF_UP)


class BrakKursuNbp(KeyError):
    """Brak kursu NBP z waluta i dniem zdarzenia.

    Sam tekst bledu nie mowil, ktorej waluty zabraklo, wiec bramka traktowala
    brak jak brak we wszystkich walutach, a raport pokrycia kursow go nie widzial.
    """

    def __init__(self, waluta: str, dzien: pd.Timestamp, przyczyna: str) -> None:
        super().__init__(przyczyna)
        self.waluta = waluta
        self.dzien = dzien
        self.przyczyna = przyczyna

    def __str__(self) -> str:
        return self.przyczyna


def _kurs(fx_provider: FxProvider, waluta: str, dzien: pd.Timestamp):
    try:
        return fx_provider.get_rate(waluta, dzien)
    except KeyError as exc:
        przyczyna = exc.args[0] if exc.args and isinstance(exc.args[0], str) else str(exc)
        raise BrakKursuNbp(str(waluta or "").upper(), dzien, przyczyna) from exc


def _szczegoly_braku(exc: Exception) -> dict[str, str]:
    if isinstance(exc, BrakKursuNbp):
        return {"currency": exc.waluta, "date": str(pd.Timestamp(exc.dzien).date())}
    return {}


def resolve_trade_tax_event_date(trade: CanonicalTrade, config: EngineConfig) -> pd.Timestamp:
    if config.trade_tax_date_policy == "EXECUTION_DATE_FIRST":
        for candidate in (trade.exchange_time, trade.executed_at, trade.settlement_date):
            if candidate is not None:
                return candidate.normalize()
    if config.trade_tax_date_policy == "BOOK_DATE_FIRST":
        for candidate in (trade.executed_at, trade.exchange_time, trade.settlement_date):
            if candidate is not None:
                return candidate.normalize()
    if config.trade_tax_date_policy == "SETTLEMENT_DATE" and trade.settlement_date is not None:
        return trade.settlement_date.normalize()
    raise ValueError(f"No tax event date for trade {trade.trade_id}")


def resolve_event_tax_event_date(event: CanonicalEvent, config: EngineConfig) -> pd.Timestamp:
    if config.event_tax_date_policy == "EFFECTIVE_DATE" and event.effective_at is not None:
        return event.effective_at.normalize()
    if event.effective_at is not None:
        return event.effective_at.normalize()
    raise ValueError(f"No tax event date for event {event.event_id}")


def apply_nbp_fx_to_trade(trade: CanonicalTrade, fx_provider: FxProvider, config: EngineConfig) -> None:
    if trade.side == "UNKNOWN":
        try:
            trade.tax_event_date = resolve_trade_tax_event_date(trade, config)
        except ValueError:
            trade.tax_event_date = None
        trade.status = "FX_NOT_REQUIRED"
        trade.traces.append(
            CalculationTrace(
                result_field="trade_pln_projection",
                formula="FX pominięty do czasu rozstrzygnięcia nierozpoznanej operacji",
                inputs=[{"trade_id": trade.trade_id}, {"operation_side": trade.side}],
                output_value="UNKNOWN",
                notes=["transakcja nie może wejść do FIFO ani wymagać kursu przed decyzją użytkownika"],
            )
        )
        return

    tax_event_date = resolve_trade_tax_event_date(trade, config)
    trade.tax_event_date = tax_event_date

    crypto_swap = czy_wymiana_krypto_na_krypto(trade)
    gross_lookup = None
    if crypto_swap:
        # Art. 17 ust. 1f: żadna z krypto-nóg wymiany nie wymaga kursu NBP.
        trade.gross_fx_date = None
        trade.gross_fx_rate = None
        trade.gross_amount_pln = Decimal("0.00")
    else:
        gross_lookup = _kurs(fx_provider, trade.trade_currency, tax_event_date)
        trade.gross_fx_date = gross_lookup.fx_date
        trade.gross_fx_rate = gross_lookup.rate
        trade.gross_amount_pln = q2(trade.gross_amount * gross_lookup.rate)

    commission_lookup = None
    commission_amount = trade.commission or Decimal("0")
    if czy_prowizja_w_walucie_wirtualnej(trade) or (crypto_swap and commission_amount == 0):
        # Prowizja krypto pozostaje niewyceniona jak dotychczas; prowizja fiat
        # nadal wymaga kursu NBP i może wejść do kosztów części E.
        trade.commission_fx_date = None
        trade.commission_fx_rate = None
        trade.commission_pln = Decimal("0.00")
    else:
        commission_lookup = _kurs(fx_provider, trade.commission_currency, tax_event_date)
        trade.commission_fx_date = commission_lookup.fx_date
        trade.commission_fx_rate = commission_lookup.rate
        trade.commission_pln = q2(commission_amount * commission_lookup.rate)

    if crypto_swap:
        trade.buy_total_cost_pln = Decimal("0.00")
        trade.sell_gross_revenue_pln = Decimal("0.00")
        trade.sell_net_revenue_pln = Decimal("0.00")
    elif trade.side == "BUY":
        trade.buy_total_cost_pln = Decimal("0.00") if trade.tax_cost_policy == "ZERO_COST" else q2(trade.gross_amount_pln + trade.commission_pln)
    elif trade.side == "SELL":
        trade.sell_gross_revenue_pln = trade.gross_amount_pln
        trade.sell_net_revenue_pln = q2(trade.gross_amount_pln - trade.commission_pln)

    trade.amount_pln = Decimal("0.00") if crypto_swap else (trade.buy_total_cost_pln if trade.side == "BUY" else trade.sell_net_revenue_pln)
    trade.nbp_rate = trade.gross_fx_rate
    trade.nbp_rate_date = trade.gross_fx_date
    trade.status = "FX_ENRICHED"
    trade.traces.append(
        CalculationTrace(
            result_field="trade_pln_projection",
            formula=(
                "krypto-krypto: bez kursu dla wymienianych walut; NBP tylko dla prowizji fiat"
                if crypto_swap else "NBP(D-1) applied separately to gross and commission"
            ),
            inputs=[
                {"trade_id": trade.trade_id},
                {"trade_currency": trade.trade_currency},
                {"commission_currency": trade.commission_currency},
                {"tax_event_date": str(tax_event_date.date())},
                {"gross_fx_rate": str(trade.gross_fx_rate)},
                {"commission_fx_rate": str(trade.commission_fx_rate)},
            ],
            output_value=str(trade.amount_pln),
            notes=(
                ([f"commission_source={commission_lookup.source}"] if commission_lookup else [])
                + ([f"source={gross_lookup.source}"] if gross_lookup else [])
            ),
        )
    )


def apply_nbp_fx_to_event(event: CanonicalEvent, fx_provider: FxProvider, config: EngineConfig) -> None:
    tax_event_date = resolve_event_tax_event_date(event, config)
    # Zdarzenie bez kwoty i bez waluty (noga papierowa wykupu noty, przydzial
    # akcji bez wyceny) nie ma czego przeliczac. Szukanie kursu dla pustej waluty
    # konczylo sie blokujacym NBP_RATE_NOT_FOUND ("rate missing for  before ..."),
    # ktory zatrzymywal rozliczenie nawet po decyzji uzytkownika. Wartosc przydzialu
    # (grant_value_pln) zostaje pusta - nieznana wycena to nie zero.
    if not str(event.currency or "").strip() and (event.amount is None or event.amount == 0):
        event.tax_event_date = tax_event_date
        event.amount_pln = Decimal("0.00")
        event.status = "FX_NOT_REQUIRED"
        event.traces.append(
            CalculationTrace(
                result_field="event_pln_projection",
                formula="brak kwoty i waluty - nic do przeliczenia kursem NBP",
                inputs=[{"event_id": event.event_id}, {"tax_event_date": str(tax_event_date.date())}],
                output_value="0.00",
                notes=[],
            )
        )
        return
    lookup = _kurs(fx_provider, event.currency, tax_event_date)
    event.tax_event_date = tax_event_date
    event.fx_date = lookup.fx_date
    event.fx_rate = lookup.rate
    event.amount_pln = q2(event.amount * lookup.rate)
    event.nbp_rate = lookup.rate
    event.nbp_rate_date = lookup.fx_date
    if event.event_kind == "BONUS_CONTEST_SHARE":
        event.grant_value_pln = event.amount_pln
        event.economic_cost_pln = event.amount_pln
    event.status = "FX_ENRICHED"
    event.traces.append(
        CalculationTrace(
            result_field="event_pln_projection",
            formula="NBP(D-1) applied to event amount",
            inputs=[
                {"event_id": event.event_id},
                {"currency": event.currency},
                {"tax_event_date": str(tax_event_date.date())},
                {"fx_rate": str(lookup.rate)},
            ],
            output_value=str(event.amount_pln),
            notes=[f"source={lookup.source}"],
        )
    )


def enrich_merge_result_with_fx(merge_result: MergeResult, fx_provider: FxProvider, config: EngineConfig) -> MergeResult:
    ledger = merge_result.ledger
    for trade in ledger.trades_by_id.values():
        try:
            apply_nbp_fx_to_trade(trade, fx_provider, config)
        except Exception as exc:
            ledger.issues.append(
                Issue(
                    code="NBP_RATE_NOT_FOUND",
                    severity="CRITICAL",
                    stage="TAX_FX",
                    scope_type="TRADE",
                    scope_id=trade.trade_id,
                    message=str(exc),
                    details=_szczegoly_braku(exc),
                    blocking=False,
                )
            )

    for event in ledger.events_by_id.values():
        try:
            apply_nbp_fx_to_event(event, fx_provider, config)
        except Exception as exc:
            ledger.issues.append(
                Issue(
                    code="NBP_RATE_NOT_FOUND",
                    severity="CRITICAL",
                    stage="TAX_FX",
                    scope_type="EVENT",
                    scope_id=event.event_id,
                    message=str(exc),
                    details=_szczegoly_braku(exc),
                    blocking=False,
                )
            )

    merge_result.canonical_dataset = CanonicalDataset(
        trades=tuple(ledger.trades_by_id.values()),
        events=tuple(ledger.events_by_id.values()),
        issues=tuple(ledger.issues),
        metadata={**merge_result.canonical_dataset.metadata, "fx_stage_completed": True},
    )
    return merge_result
