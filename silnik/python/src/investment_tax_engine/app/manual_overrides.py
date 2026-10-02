from __future__ import annotations

import copy
from decimal import Decimal, InvalidOperation
from typing import Any

import pandas as pd

from investment_tax_engine.merge.merge_engine import merge_dataset
from investment_tax_engine.normalize.classify import classify_event_fields
from investment_tax_engine.models.core import (
    CanonicalDataset,
    CanonicalEvent,
    CanonicalTrade,
    EditableRecordDiff,
    EditableRecordProjection,
    EditableRecordValidationState,
    EngineConfig,
    Issue,
    MergeResult,
    TransactionOverride,
)


TRADE_FIELDS = {
    "date",
    "symbol",
    "isin",
    "side",
    "quantity",
    "price",
    "gross_amount",
    "trade_currency",
    "commission",
    "commission_currency",
    "settlement_date",
    "comment",
    "message",
    "instrument_class",
    "instrument_type_code",
    "market_id",
    "country",
}

EVENT_FIELDS = {
    "date",
    "event_kind",
    "symbol",
    "amount",
    "currency",
    "quantity",
    "comment",
    "message",
    "country",
}

BONUS_FIELDS = {
    "date",
    "symbol",
    "quantity",
    "grant_market_value",
    "currency",
    "promotion_basis",
    "comment",
    "message",
    "country",
}


def _manual_event_tax_attributes(
    event_kind: str,
    comment: str | None,
    amount: Decimal | None,
) -> tuple[str, str | None, str]:
    """Nadaje ręcznemu zdarzeniu te same skutki podatkowe co importowi.

    Ręczny EVENT był dotąd zawsze `diagnostic_only`, dlatego ręcznie wpisana
    dywidenda, opłata albo podatek u źródła znikały przed silnikiem podatkowym.
    Nie zgadujemy typu: używamy jawnego rodzaju wpisanego przez użytkownika i
    wspólnego klasyfikatora wyłącznie dla jego konsekwencji podatkowych.
    """
    normalized_kind = event_kind.strip().upper()
    explicit = {
        "DIVIDEND": ("equity_tax", None, "CERTAIN"),
        "TAX": ("equity_tax", "SOURCE_TAX", "CERTAIN"),
        "TRADE_FEE": ("equity_tax", "RECONSTRUCTED_COMMISSION", "CERTAIN"),
        "ACCOUNT_FEE": ("equity_tax", "ACCOUNT_FEE", "CONDITIONAL"),
        # Koszyki musza byc tymi, ktore zna polityka kosztow: "CUSTODY_FEE" i "TRANSFER_FEE"
        # jako koszyki nie istnialy, wiec recznie wpisana oplata cicho wypadala z kosztow.
        "CUSTODY_FEE": ("equity_tax", "ACCOUNT_FEE", "CONDITIONAL"),
        "TRANSFER_FEE": ("equity_tax", "FUNDING_TRANSFER_FEE", "CONDITIONAL"),
        "FX_CONVERSION_FEE": ("equity_tax", "FX_CONVERSION_FEE", "CONDITIONAL"),
        "MARGIN_INTEREST": ("financing_costs", "MARGIN_INTEREST", "CONDITIONAL"),
        "LOAN_INTEREST": ("financing_costs", "LOAN_INTEREST", "CONDITIONAL"),
    }.get(normalized_kind)
    if explicit is not None:
        return explicit
    classified = classify_event_fields(event_kind, comment or "", amount or Decimal("0"))
    return (
        str(classified["logical_world"]),
        classified["cost_bucket"],
        str(classified["cost_class"]),
    )


def _stringify(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    return str(value)


def _normalize_values(values: dict[str, Any]) -> dict[str, str | None]:
    return {key: _stringify(value) for key, value in values.items()}


def _same_tax_year(value: pd.Timestamp | None, tax_year: int | None) -> bool:
    if tax_year is None:
        return True
    if value is None:
        return False
    return pd.Timestamp(value).year == tax_year


def _odrzucona_korekta_blokuje(
    record_type: str,
    tax_year: int | None,
    symbole_sprzedazy_roku: set[str],
    *wartosci: dict[str, str | None],
) -> bool:
    """Czy odrzucona korekta dotyczy rozliczanego roku.

    Wtedy zeznanie nie moze powstac z pierwotnego rekordu, ktory uzytkownik sam
    poprawil. Rekord z tego roku zmienia wynik wprost, a zakup sprzed roku - jako
    partia FIFO, ale tylko wtedy, gdy ten walor jest sprzedawany w rozliczanym roku
    (zakup z 2025 sprzedany w calosci w 2025 nie zmienia PIT za 2026). Rekord bez
    czytelnej daty albo symbolu tez blokuje: nie wiadomo, czego dotyczy.
    """
    if tax_year is None:
        return True
    for values in wartosci:
        data = _parse_timestamp(values.get("date"))
        if data is None or data.year == tax_year:
            return True
        strona = (values.get("side") or "").strip().upper()
        symbol = (values.get("symbol") or "").strip().upper()
        if record_type == "TRADE" and data.year < tax_year and strona in {"BUY", ""}:
            if not symbol or symbol in symbole_sprzedazy_roku:
                return True
    return False


def _symbole_sprzedazy_roku(
    original_trades: dict[str, CanonicalTrade],
    override_by_trade_id: dict[str | None, TransactionOverride],
    overrides: list[TransactionOverride],
    tax_year: int | None,
) -> set[str]:
    """Walory sprzedawane w rozliczanym roku - po zastosowaniu waznych korekt.

    Korekta, ktora usuwa albo przenosi jedyna tegoroczna sprzedaz, zmienia te liste;
    liczona z pierwotnych transakcji blokowalaby odrzucona korekte dawnego zakupu,
    choc ten zakup nie zasila juz zadnej sprzedazy roku.
    """
    symbole: set[str] = set()
    for trade_id, trade in original_trades.items():
        override = override_by_trade_id.get(trade_id)
        if override is not None and override.deleted:
            continue
        values = _project_trade_values(trade)
        skorygowana = False
        if override is not None:
            po_korekcie = _overlay_values(values, override.values)
            if validate_editable_values("TRADE", po_korekcie).is_valid:
                values = po_korekcie
                skorygowana = True
        w_roku = _same_tax_year(_parse_timestamp(values.get("date")), tax_year)
        # Data wyswietlana (gielda) i data podatkowa potrafia wypasc w roznych latach
        # na przelomie roku - bez korekty liczy sie kazda z nich.
        if not w_roku and not skorygowana:
            w_roku = _same_tax_year(trade.tax_event_date, tax_year)
        if (values.get("side") or "").strip().upper() == "SELL" and w_roku:
            symbole.add((values.get("symbol") or "").strip().upper())
    for override in overrides:
        if override.mode != "new" or override.record_type != "TRADE" or override.deleted:
            continue
        values = _normalize_values(dict(override.values))
        if not validate_editable_values("TRADE", values).is_valid:
            continue
        if (values.get("side") or "").strip().upper() == "SELL" and _same_tax_year(
            _parse_timestamp(values.get("date")), tax_year
        ):
            symbole.add((values.get("symbol") or "").strip().upper())
    return symbole


def _opis_rekordu(values: dict[str, str | None]) -> str:
    """Walor i data rekordu na poczatek komunikatu - zeby dalo sie go znalezc."""
    czesci = [str(values.get(klucz) or "").strip() for klucz in ("symbol", "date")]
    czesci = [czesc[:10] if i == 1 else czesc for i, czesc in enumerate(czesci) if czesc]
    return f"{', '.join(czesci)}: " if czesci else ""


def _parse_decimal(value: str | None) -> Decimal | None:
    if value is None or value == "":
        return None
    normalized = str(value).strip().replace("\u00a0", "").replace(" ", "")
    if "," in normalized and "." in normalized:
        if normalized.rfind(",") > normalized.rfind("."):
            normalized = normalized.replace(".", "").replace(",", ".")
        else:
            normalized = normalized.replace(",", "")
    else:
        normalized = normalized.replace(",", ".")
    try:
        return Decimal(normalized)
    except InvalidOperation:
        return None


def _parse_timestamp(value: str | None) -> pd.Timestamp | None:
    if value is None or value == "":
        return None
    try:
        return pd.Timestamp(value)
    except Exception:
        return None


def _parse_bool(value: str | None, default: bool = False) -> bool:
    if value is None or value == "":
        return default
    return str(value).strip().lower() in {"1", "true", "tak", "yes"}


def collect_modified_fields(
    original_values: dict[str, str | None],
    current_values: dict[str, str | None],
) -> list[str]:
    return sorted(
        key
        for key in set(original_values.keys()).union(current_values.keys())
        if (original_values.get(key) or None) != (current_values.get(key) or None)
    )


def validate_editable_values(record_type: str, values: dict[str, str | None]) -> EditableRecordValidationState:
    errors: list[str] = []
    warnings: list[str] = []
    date_value = values.get("date")
    currency_value = values.get("trade_currency") if record_type == "TRADE" else values.get("currency")

    if not date_value:
        errors.append("Data jest wymagana.")
    elif _parse_timestamp(date_value) is None:
        errors.append("Data ma nieprawidłowy format.")

    if not currency_value:
        errors.append("Waluta jest wymagana.")

    if record_type == "TRADE":
        quantity = _parse_decimal(values.get("quantity"))
        price = _parse_decimal(values.get("price"))
        gross_amount = _parse_decimal(values.get("gross_amount"))
        commission = _parse_decimal(values.get("commission"))
        side = (values.get("side") or "").upper()

        if side not in {"BUY", "SELL"}:
            errors.append("Strona transakcji musi być ustawiona na BUY albo SELL.")
        if quantity is None:
            errors.append("Ilość musi być prawidłową liczbą.")
        elif quantity <= 0:
            errors.append("Ilość dla transakcji kupna lub sprzedaży musi być większa od zera.")
        if price is None:
            errors.append("Cena musi być prawidłową liczbą.")
        elif price < 0:
            errors.append("Cena nie może być ujemna.")
        if gross_amount is None:
            errors.append("Kwota brutto musi być prawidłową liczbą.")
        if commission is None:
            errors.append("Prowizja musi być prawidłową liczbą.")
        elif commission < 0:
            errors.append("Prowizja nie może być ujemna.")
        if not values.get("symbol"):
            errors.append("Instrument jest wymagany.")
    elif record_type == "EVENT":
        amount = _parse_decimal(values.get("amount"))
        if not values.get("event_kind"):
            errors.append("Typ zdarzenia jest wymagany.")
        if amount is None:
            errors.append("Kwota zdarzenia musi być prawidłową liczbą.")
    elif record_type == "BONUS_CONTEST_SHARE":
        quantity = _parse_decimal(values.get("quantity"))
        grant_market_value = _parse_decimal(values.get("grant_market_value"))
        if not values.get("symbol"):
            errors.append("Instrument jest wymagany.")
        if quantity is None or quantity <= 0:
            errors.append("Ilość akcji bonusowej musi być większa od zera.")
        if grant_market_value is None or grant_market_value < 0:
            errors.append("Wartość rynkowa z dnia przyznania musi być prawidłową liczbą nieujemną.")
        if not values.get("promotion_basis"):
            warnings.append("Brak podstawy promocji. Akcja bonusowa zostanie oznaczona do przeglądu.")
    else:
        warnings.append("Nieznany typ rekordu edycyjnego. Rekord zostanie oznaczony do ręcznej kontroli.")

    return EditableRecordValidationState(
        is_valid=not errors,
        status="VALID" if not errors else "INVALID",
        errors=errors,
        warnings=warnings,
    )


def _project_trade_values(trade: CanonicalTrade) -> dict[str, str | None]:
    display_date = trade.exchange_time or trade.executed_at or trade.tax_event_date
    return _normalize_values(
        {
            "date": display_date,
            "symbol": trade.symbol,
            "isin": trade.isin,
            "side": trade.side,
            "quantity": trade.quantity,
            "price": trade.price,
            "gross_amount": trade.gross_amount,
            "trade_currency": trade.trade_currency,
            "commission": trade.commission,
            "commission_currency": trade.commission_currency,
            "settlement_date": trade.settlement_date,
            "comment": trade.comment,
            "message": trade.message,
            "instrument_class": trade.instrument_class,
            "instrument_type_code": trade.instrument_type_code,
            "market_id": trade.market_id,
            "country": trade.country,
        }
    )


def _project_event_values(event: CanonicalEvent) -> dict[str, str | None]:
    values = {
        "date": event.effective_at or event.tax_event_date,
        "event_kind": event.event_kind,
        "symbol": event.symbol,
        "amount": event.amount,
        "currency": event.currency,
        "quantity": event.quantity,
        "comment": event.comment,
        "message": event.comment,
        "country": event.country,
    }
    if event.event_kind == "BONUS_CONTEST_SHARE":
        values.update(
            {
                "grant_market_value": event.grant_market_value,
                "promotion_basis": event.promotion_basis,
            }
        )
    return _normalize_values(values)


def _overlay_values(original_values: dict[str, str | None], override_values: dict[str, str | None]) -> dict[str, str | None]:
    current = dict(original_values)
    for key, value in override_values.items():
        current[key] = None if value is None or value == "" else str(value)
    return current


def _make_diffs(original_values: dict[str, str | None], current_values: dict[str, str | None]) -> list[EditableRecordDiff]:
    return [
        EditableRecordDiff(
            field_name=field_name,
            original_value=original_values.get(field_name),
            current_value=current_values.get(field_name),
        )
        for field_name in collect_modified_fields(original_values, current_values)
    ]


def _set_trade_overlay_metadata(
    trade: CanonicalTrade,
    *,
    override: TransactionOverride,
    original_values: dict[str, str | None],
    current_values: dict[str, str | None],
) -> None:
    modified_fields = collect_modified_fields(original_values, current_values)
    trade.overlay_status = "MODIFIED"
    trade.manual_record_id = override.manual_record_id
    trade.is_modified = True
    trade.is_new = False
    trade.modified_fields = modified_fields
    trade.original_snapshot = dict(original_values)
    trade.current_snapshot = dict(current_values)


def _set_event_overlay_metadata(
    event: CanonicalEvent,
    *,
    override: TransactionOverride,
    original_values: dict[str, str | None],
    current_values: dict[str, str | None],
) -> None:
    modified_fields = collect_modified_fields(original_values, current_values)
    event.overlay_status = "MODIFIED"
    event.manual_record_id = override.manual_record_id
    event.is_modified = True
    event.is_new = False
    event.modified_fields = modified_fields
    event.original_snapshot = dict(original_values)
    event.current_snapshot = dict(current_values)


def _apply_trade_values(trade: CanonicalTrade, values: dict[str, str | None]) -> None:
    trade.symbol = values.get("symbol") or trade.symbol
    trade.isin = values.get("isin") or None
    trade.side = (values.get("side") or trade.side).upper()
    quantity = _parse_decimal(values.get("quantity"))
    price = _parse_decimal(values.get("price"))
    gross_amount = _parse_decimal(values.get("gross_amount"))
    commission = _parse_decimal(values.get("commission"))
    if quantity is not None:
        trade.quantity = quantity
    if price is not None:
        trade.price = price
    if gross_amount is not None:
        trade.gross_amount = gross_amount
    trade.trade_currency = values.get("trade_currency") or trade.trade_currency
    if commission is not None:
        trade.commission = commission
    trade.commission_currency = values.get("commission_currency") or trade.commission_currency or trade.trade_currency
    trade.instrument_class = values.get("instrument_class") or trade.instrument_class
    trade.instrument_type_code = values.get("instrument_type_code") or trade.instrument_type_code
    trade.market_id = values.get("market_id") or trade.market_id
    trade.country = values.get("country") or trade.country
    trade.user_country = (values.get("country") or "").strip().upper() or None
    trade.comment = values.get("comment") or None
    trade.message = values.get("message") or None
    trade.executed_at = _parse_timestamp(values.get("date")) or trade.executed_at
    trade.exchange_time = _parse_timestamp(values.get("date")) or trade.exchange_time
    trade.settlement_date = _parse_timestamp(values.get("settlement_date")) or None
    trade.original_amount = trade.gross_amount
    trade.original_currency = trade.trade_currency
    trade.original_event_date = trade.exchange_time or trade.executed_at
    trade.tax_event_date = None
    trade.gross_fx_date = None
    trade.gross_fx_rate = None
    trade.commission_fx_date = None
    trade.commission_fx_rate = None
    trade.gross_amount_pln = None
    trade.commission_pln = None
    trade.buy_total_cost_pln = None
    trade.sell_gross_revenue_pln = None
    trade.sell_net_revenue_pln = None


def _apply_event_values(event: CanonicalEvent, values: dict[str, str | None]) -> None:
    event.event_kind = values.get("event_kind") or event.event_kind
    event.symbol = values.get("symbol") or event.symbol
    amount = _parse_decimal(values.get("amount"))
    if amount is not None:
        event.amount = amount
    event.currency = values.get("currency") or event.currency
    event.quantity = _parse_decimal(values.get("quantity")) if values.get("quantity") not in {None, ""} else event.quantity
    event.comment = values.get("comment") or None
    event.country = values.get("country") or event.country
    event.effective_at = _parse_timestamp(values.get("date")) or event.effective_at
    event.original_amount = event.amount
    event.original_currency = event.currency
    event.original_event_date = event.effective_at
    event.tax_event_date = None
    event.fx_date = None
    event.fx_rate = None
    event.amount_pln = None
    event.logical_world, event.cost_bucket, event.cost_class = _manual_event_tax_attributes(
        event.event_kind,
        values.get("comment") or values.get("message"),
        event.amount,
    )
    if event.event_kind == "BONUS_CONTEST_SHARE":
        grant_market_value = _parse_decimal(values.get("grant_market_value"))
        if grant_market_value is not None:
            event.grant_market_value = grant_market_value
        event.promotion_basis = values.get("promotion_basis") or None
        event.grant_tax_status = "REVIEW_REQUIRED"
        if not values.get("date") or not values.get("promotion_basis") or event.grant_market_value is None:
            event.completeness_status = "INCOMPLETE_BONUS_CONTEST_SHARE"
        else:
            event.completeness_status = "COMPLETE"


def _build_trade_from_override(override: TransactionOverride, values: dict[str, str | None]) -> CanonicalTrade:
    gross_amount = _parse_decimal(values.get("gross_amount"))
    quantity = _parse_decimal(values.get("quantity"))
    price = _parse_decimal(values.get("price"))
    computed_gross = gross_amount
    if computed_gross is None and quantity is not None and price is not None:
        computed_gross = quantity * price
    trade = CanonicalTrade(
        trade_id=override.manual_record_id,
        order_id=None,
        trade_number=None,
        symbol=values.get("symbol") or "MANUAL",
        isin=values.get("isin") or None,
        side=(values.get("side") or "BUY").upper(),
        instrument_type_code=values.get("instrument_type_code") or None,
        instrument_class=values.get("instrument_class") or "EQUITY",
        market_id=values.get("market_id") or None,
        quantity=quantity or Decimal("0"),
        price=price or Decimal("0"),
        gross_amount=computed_gross or Decimal("0"),
        trade_currency=values.get("trade_currency") or "USD",
        commission=_parse_decimal(values.get("commission")) or Decimal("0"),
        commission_currency=values.get("commission_currency") or values.get("trade_currency") or "USD",
        broker_reported_profit=None,
        executed_at=_parse_timestamp(values.get("date")),
        exchange_time=_parse_timestamp(values.get("date")),
        settlement_date=_parse_timestamp(values.get("settlement_date")),
        confirm_time=None,
        otc=_parse_bool(values.get("otc"), default=False),
        repo_close=None,
        base_contract_code=None,
        current_position_qty_after_trade=None,
        source_name="USER_OVERRIDE",
        source_priority=1000,
        source_record_id=override.manual_record_id,
        source_file="USER_OVERRIDE",
        source_sheet="manual",
        source_row_id=override.manual_record_id,
        certainty_status="USER_OVERRIDE",
        review_status="USER_EDITED",
        logical_world="equity_tax",
        original_amount=computed_gross or Decimal("0"),
        original_currency=values.get("trade_currency") or "USD",
        original_event_date=_parse_timestamp(values.get("date")),
        comment=values.get("comment") or override.comment,
        message=values.get("message") or override.comment,
        country=values.get("country") or None,
        # Jak przy korekcie istniejacej sprzedazy: PIT/ZG czyta kraj uzytkownika z
        # user_country - samo `country` zostawialo nowa sprzedaz bez ISIN jako XX.
        user_country=(values.get("country") or "").strip().upper() or None,
        evidence_refs=[f"USER_OVERRIDE:{override.manual_record_id}"],
        overlay_status="NEW",
        manual_record_id=override.manual_record_id,
        is_new=True,
        current_snapshot=dict(values),
    )
    return trade


def _build_event_from_override(override: TransactionOverride, values: dict[str, str | None]) -> CanonicalEvent:
    event_kind = "BONUS_CONTEST_SHARE" if override.record_type == "BONUS_CONTEST_SHARE" else (values.get("event_kind") or "OTHER")
    amount = _parse_decimal(values.get("amount"))
    grant_market_value = _parse_decimal(values.get("grant_market_value"))
    resolved_amount = grant_market_value if event_kind == "BONUS_CONTEST_SHARE" else amount
    completeness_status = None
    grant_tax_status = None
    if event_kind == "BONUS_CONTEST_SHARE":
        grant_tax_status = "REVIEW_REQUIRED"
        completeness_status = "COMPLETE"
        if not values.get("date") or not values.get("promotion_basis") or grant_market_value is None:
            completeness_status = "INCOMPLETE_BONUS_CONTEST_SHARE"

    logical_world, cost_bucket, cost_class = _manual_event_tax_attributes(
        event_kind,
        values.get("comment") or values.get("message") or override.comment,
        resolved_amount,
    )

    event = CanonicalEvent(
        event_id=override.manual_record_id,
        event_kind=event_kind,
        symbol=values.get("symbol") or None,
        linked_trade_id=None,
        amount=resolved_amount or Decimal("0"),
        currency=values.get("currency") or "USD",
        effective_at=_parse_timestamp(values.get("date")),
        comment=values.get("comment") or override.comment,
        source_name="USER_OVERRIDE",
        source_priority=1000,
        source_record_id=override.manual_record_id,
        source_file="USER_OVERRIDE",
        source_sheet="manual",
        source_row_id=override.manual_record_id,
        certainty_status="USER_OVERRIDE",
        review_status="USER_EDITED",
        logical_world=logical_world,
        cost_bucket=cost_bucket,
        cost_class=cost_class,
        original_amount=resolved_amount or Decimal("0"),
        original_currency=values.get("currency") or "USD",
        original_event_date=_parse_timestamp(values.get("date")),
        quantity=_parse_decimal(values.get("quantity")),
        grant_tax_status=grant_tax_status,
        grant_market_value=grant_market_value,
        promotion_basis=values.get("promotion_basis") or None,
        completeness_status=completeness_status,
        acquisition_mode="BONUS_CONTEST_SHARE" if event_kind == "BONUS_CONTEST_SHARE" else None,
        evidence_refs=[f"USER_OVERRIDE:{override.manual_record_id}"],
        overlay_status="NEW",
        manual_record_id=override.manual_record_id,
        is_new=True,
        current_snapshot=dict(values),
    )
    return event


def _build_editable_projection(
    *,
    base_record_id: str | None,
    manual_record_id: str,
    record_type: str,
    overlay_status: str,
    deleted: bool,
    original_values: dict[str, str | None],
    current_values: dict[str, str | None],
    validation_state: EditableRecordValidationState,
    source_name: str | None = None,
) -> EditableRecordProjection:
    ticker = current_values.get("symbol") or original_values.get("symbol")
    display_date = _parse_timestamp(current_values.get("date") or original_values.get("date"))
    title_bits = [ticker or record_type]
    if record_type == "TRADE" and (current_values.get("side") or original_values.get("side")):
        title_bits.append(current_values.get("side") or original_values.get("side") or "")
    if record_type == "EVENT" and (current_values.get("event_kind") or original_values.get("event_kind")):
        title_bits.append(current_values.get("event_kind") or original_values.get("event_kind") or "")
    if record_type == "BONUS_CONTEST_SHARE":
        title_bits.append("Akcja bonusowa")
    return EditableRecordProjection(
        base_record_id=base_record_id,
        manual_record_id=manual_record_id,
        record_type=record_type,
        overlay_status=overlay_status,
        deleted=deleted,
        original_values=original_values,
        current_values=current_values,
        modified_fields=collect_modified_fields(original_values, current_values),
        validation_state=validation_state,
        diffs=_make_diffs(original_values, current_values),
        title=" - ".join(part for part in title_bits if part),
        ticker=ticker,
        display_date=display_date,
        source_name=source_name,
    )


def apply_manual_overrides(
    merge_result: MergeResult,
    overrides: list[TransactionOverride],
    config: EngineConfig,
) -> tuple[MergeResult, list[EditableRecordProjection]]:
    original_trades = {
        trade_id: copy.deepcopy(trade)
        for trade_id, trade in merge_result.ledger.trades_by_id.items()
    }
    original_events = {
        event_id: copy.deepcopy(event)
        for event_id, event in merge_result.ledger.events_by_id.items()
    }
    current_trades = {trade_id: copy.deepcopy(trade) for trade_id, trade in original_trades.items()}
    current_events = {event_id: copy.deepcopy(event) for event_id, event in original_events.items()}
    overlay_issues: list[Issue] = []
    editable_records: list[EditableRecordProjection] = []

    # Walory sprzedawane w rozliczanym roku - tylko ich dawne zakupy moga zasilic FIFO roku.
    override_by_trade_id = {
        override.base_record_id: override
        for override in overrides
        if override.mode == "override" and override.base_record_id and override.record_type == "TRADE"
    }
    symbole_sprzedazy_roku = _symbole_sprzedazy_roku(original_trades, override_by_trade_id, overrides, config.tax_year)
    override_by_event_id = {
        override.base_record_id: override
        for override in overrides
        if override.mode == "override"
        and override.base_record_id
        and override.record_type in {"EVENT", "BONUS_CONTEST_SHARE"}
    }

    for trade_id, trade in original_trades.items():
        original_values = _project_trade_values(trade)
        override = override_by_trade_id.get(trade_id)
        if override is None:
            current_values = dict(original_values)
            if _same_tax_year(_parse_timestamp(current_values.get("date")), config.tax_year):
                editable_records.append(
                    _build_editable_projection(
                        base_record_id=trade_id,
                        manual_record_id=trade.manual_record_id or trade_id,
                        record_type="TRADE",
                        overlay_status="ORIGINAL",
                        deleted=False,
                        original_values=original_values,
                        current_values=current_values,
                        validation_state=EditableRecordValidationState(),
                        source_name=trade.source_name,
                    )
                )
            continue

        current_values = _overlay_values(original_values, override.values)
        validation_state = validate_editable_values("TRADE", current_values)
        if override.deleted:
            current_trades.pop(trade_id, None)
        elif validation_state.is_valid:
            current_trade = current_trades[trade_id]
            _apply_trade_values(current_trade, current_values)
            _set_trade_overlay_metadata(
                current_trade,
                override=override,
                original_values=original_values,
                current_values=current_values,
            )
        else:
            overlay_issues.append(
                Issue(
                    code="MANUAL_OVERRIDE_VALIDATION_ERROR",
                    severity="ERROR",
                    stage="OVERLAY",
                    scope_type="TRADE",
                    scope_id=trade_id,
                    message=_opis_rekordu(current_values) + "Nie zastosowano ręcznej korekty transakcji z powodu błędów walidacji; rozliczenie nadal liczy pierwotny rekord. Popraw dane w Historii transakcji. Błędy: " + "; ".join(str(error) for error in validation_state.errors if len(str(error)) <= 160),
                    details={"errors": list(validation_state.errors)},
                    blocking=_odrzucona_korekta_blokuje("TRADE", config.tax_year, symbole_sprzedazy_roku, original_values, current_values),
                )
            )

        if _same_tax_year(_parse_timestamp(current_values.get("date") or original_values.get("date")), config.tax_year):
            editable_records.append(
                _build_editable_projection(
                    base_record_id=trade_id,
                    manual_record_id=override.manual_record_id,
                    record_type="TRADE",
                    overlay_status="MODIFIED",
                    deleted=override.deleted,
                    original_values=original_values,
                    current_values=current_values,
                    validation_state=validation_state,
                    source_name=trade.source_name,
                )
            )

    for event_id, event in original_events.items():
        record_type = "BONUS_CONTEST_SHARE" if event.event_kind == "BONUS_CONTEST_SHARE" else "EVENT"
        original_values = _project_event_values(event)
        override = override_by_event_id.get(event_id)
        if override is None:
            current_values = dict(original_values)
            if _same_tax_year(_parse_timestamp(current_values.get("date")), config.tax_year):
                editable_records.append(
                    _build_editable_projection(
                        base_record_id=event_id,
                        manual_record_id=event.manual_record_id or event_id,
                        record_type=record_type,
                        overlay_status="ORIGINAL",
                        deleted=False,
                        original_values=original_values,
                        current_values=current_values,
                        validation_state=EditableRecordValidationState(),
                        source_name=event.source_name,
                    )
                )
            continue

        current_values = _overlay_values(original_values, override.values)
        validation_state = validate_editable_values(record_type, current_values)
        if override.deleted:
            current_events.pop(event_id, None)
        elif validation_state.is_valid:
            current_event = current_events[event_id]
            _apply_event_values(current_event, current_values)
            _set_event_overlay_metadata(
                current_event,
                override=override,
                original_values=original_values,
                current_values=current_values,
            )
        else:
            overlay_issues.append(
                Issue(
                    code="MANUAL_OVERRIDE_VALIDATION_ERROR",
                    severity="ERROR",
                    stage="OVERLAY",
                    scope_type="EVENT",
                    scope_id=event_id,
                    message=_opis_rekordu(current_values) + "Nie zastosowano ręcznej korekty zdarzenia z powodu błędów walidacji; rozliczenie nadal liczy pierwotny rekord. Popraw dane w Historii transakcji. Błędy: " + "; ".join(str(error) for error in validation_state.errors if len(str(error)) <= 160),
                    details={"errors": list(validation_state.errors)},
                    blocking=_odrzucona_korekta_blokuje("EVENT", config.tax_year, symbole_sprzedazy_roku, original_values, current_values),
                )
            )

        if _same_tax_year(_parse_timestamp(current_values.get("date") or original_values.get("date")), config.tax_year):
            editable_records.append(
                _build_editable_projection(
                    base_record_id=event_id,
                    manual_record_id=override.manual_record_id,
                    record_type=record_type,
                    overlay_status="MODIFIED",
                    deleted=override.deleted,
                    original_values=original_values,
                    current_values=current_values,
                    validation_state=validation_state,
                    source_name=event.source_name,
                )
            )

    for override in overrides:
        if override.mode != "new":
            if override.base_record_id and override.base_record_id not in original_trades and override.base_record_id not in original_events:
                validation_state = EditableRecordValidationState(
                    is_valid=False,
                    status="ORPHAN",
                    errors=["Powiązany rekord źródłowy nie istnieje w aktualnym przebiegu silnika."],
                )
                current_values = _normalize_values(override.values)
                overlay_issues.append(
                    Issue(
                        code="ORPHAN_TRANSACTION_OVERRIDE",
                        severity="WARNING",
                        stage="OVERLAY",
                        scope_type=override.record_type,
                        scope_id=override.base_record_id,
                        message="Ręczna korekta wskazuje rekord źródłowy, którego nie ma w bieżącym przebiegu silnika. Sprawdź powiązanie w Historii transakcji.",
                        details={"manual_record_id": override.manual_record_id},
                        blocking=False,
                    )
                )
                editable_records.append(
                    _build_editable_projection(
                        base_record_id=override.base_record_id,
                        manual_record_id=override.manual_record_id,
                        record_type=override.record_type,
                        overlay_status="MODIFIED",
                        deleted=override.deleted,
                        original_values={},
                        current_values=current_values,
                        validation_state=validation_state,
                        source_name=override.source_label or "Ręczna korekta użytkownika",
                    )
                )
            continue

        current_values = _normalize_values(override.values)
        validation_state = validate_editable_values(override.record_type, current_values)
        if validation_state.is_valid and not override.deleted:
            if override.record_type == "TRADE":
                current_trade = _build_trade_from_override(override, current_values)
                current_trades[current_trade.trade_id] = current_trade
            else:
                current_event = _build_event_from_override(override, current_values)
                current_events[current_event.event_id] = current_event
        elif not validation_state.is_valid:
            overlay_issues.append(
                Issue(
                    code="MANUAL_OVERRIDE_VALIDATION_ERROR",
                    severity="ERROR",
                    stage="OVERLAY",
                    scope_type=override.record_type,
                    scope_id=override.manual_record_id,
                    message=_opis_rekordu(current_values) + "Nie zastosowano nowego ręcznego rekordu z powodu błędów walidacji, więc nie został uwzględniony w rozliczeniu. Popraw dane w Historii transakcji. Błędy: " + "; ".join(str(error) for error in validation_state.errors if len(str(error)) <= 160),
                    details={"errors": list(validation_state.errors)},
                    blocking=_odrzucona_korekta_blokuje(override.record_type, config.tax_year, symbole_sprzedazy_roku, current_values),
                )
            )

        if _same_tax_year(_parse_timestamp(current_values.get("date")), config.tax_year):
            editable_records.append(
                _build_editable_projection(
                    base_record_id=None,
                    manual_record_id=override.manual_record_id,
                    record_type=override.record_type,
                    overlay_status="NEW",
                    deleted=override.deleted,
                    original_values={},
                    current_values=current_values,
                    validation_state=validation_state,
                    source_name=override.source_label or "Ręczna korekta użytkownika",
                )
            )

    merged = merge_dataset(
        CanonicalDataset(
            trades=tuple(current_trades.values()),
            events=tuple(current_events.values()),
            issues=tuple([*merge_result.ledger.issues, *overlay_issues]),
            metadata={
                **merge_result.canonical_dataset.metadata,
                "manual_override_count": len(overrides),
            },
        ),
        config,
    )
    merged.unmatched_trades = list(merge_result.unmatched_trades)
    merged.unmatched_events = list(merge_result.unmatched_events)
    merged.reconciliation_summary = {
        **merge_result.reconciliation_summary,
        "manual_override_count": len(overrides),
        "editable_record_count": len(editable_records),
    }

    editable_records.sort(
        key=lambda record: (
            record.display_date or pd.Timestamp.min,
            record.record_type,
            record.manual_record_id,
        )
    )
    return merged, editable_records
