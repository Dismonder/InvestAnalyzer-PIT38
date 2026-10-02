from __future__ import annotations

from decimal import Decimal

import pandas as pd

from investment_tax_engine.app.manual_overrides import _apply_event_values, _apply_trade_values, apply_manual_overrides
from investment_tax_engine.merge.merge_engine import merge_dataset
from investment_tax_engine.models.core import (
    CanonicalDataset,
    CanonicalEvent,
    CanonicalTrade,
    EngineConfig,
    TransactionOverride,
)


def make_trade(trade_id: str, *, symbol: str = "NBIS.US") -> CanonicalTrade:
    return CanonicalTrade(
        trade_id=trade_id,
        order_id=f"ORD-{trade_id}",
        trade_number=f"NB-{trade_id}",
        symbol=symbol,
        isin="US0000000001",
        side="BUY",
        instrument_type_code="1",
        instrument_class="EQUITY",
        market_id="NASDAQ",
        quantity=Decimal("10"),
        price=Decimal("12.10"),
        gross_amount=Decimal("121.00"),
        trade_currency="USD",
        commission=Decimal("1.20"),
        commission_currency="USD",
        broker_reported_profit=None,
        executed_at=pd.Timestamp("2025-01-21T10:00:00"),
        exchange_time=pd.Timestamp("2025-01-21T10:00:00"),
        settlement_date=pd.Timestamp("2025-01-23"),
        confirm_time=None,
        otc=False,
        repo_close=None,
        base_contract_code=None,
        current_position_qty_after_trade=Decimal("10"),
        source_name="API_JSON_FULL",
        source_priority=110,
        source_record_id=trade_id,
        tax_event_date=pd.Timestamp("2025-01-21"),
        comment="oryginalny komentarz",
        message="oryginalna wiadomosc",
    )


def make_event(event_id: str) -> CanonicalEvent:
    return CanonicalEvent(
        event_id=event_id,
        event_kind="DIVIDEND",
        symbol="NBIS.US",
        linked_trade_id=None,
        amount=Decimal("5.00"),
        currency="USD",
        effective_at=pd.Timestamp("2025-01-25"),
        comment="oryginalne zdarzenie",
        source_name="BROKER_JSON",
        source_priority=70,
        source_record_id=event_id,
        tax_event_date=pd.Timestamp("2025-01-25"),
        amount_pln=Decimal("20.00"),
        logical_world="diagnostic_only",
    )


def test_numeric_override_distinguishes_zero_from_missing_value():
    trade = make_trade("T-ZERO")
    _apply_trade_values(trade, {"quantity": "0", "price": "0", "gross_amount": "0"})
    assert trade.quantity == Decimal("0")
    assert trade.price == Decimal("0")
    assert trade.gross_amount == Decimal("0")
    assert trade.commission == Decimal("1.20")

    _apply_trade_values(trade, {"commission": "0"})
    assert trade.commission == Decimal("0")
    assert trade.quantity == Decimal("0")

    event = make_event("E-ZERO")
    _apply_event_values(event, {"amount": "0"})
    assert event.amount == Decimal("0")
    _apply_event_values(event, {})
    assert event.amount == Decimal("0")


def test_apply_manual_overrides_updates_trade_and_builds_editable_projection():
    config = EngineConfig(run_mode="SAFE", tax_year=2025)
    merge_result = merge_dataset(CanonicalDataset(trades=(make_trade("T-1"),), events=()), config)
    overrides = [
        TransactionOverride(
            override_id="override-1",
            mode="override",
            record_type="TRADE",
            base_record_id="T-1",
            manual_record_id="manual-1",
            deleted=False,
            values={
                "quantity": "12",
                "commission": "2.50",
                "comment": "ręczna korekta",
            },
            updated_at="2026-04-23T12:00:00Z",
            created_at="2026-04-23T12:00:00Z",
            comment="Ręczna korekta użytkownika",
            source_label="Ręczna korekta użytkownika",
        )
    ]

    updated_result, editable_records = apply_manual_overrides(merge_result, overrides, config)

    updated_trade = updated_result.ledger.trades_by_id["T-1"]
    editable_trade = next(record for record in editable_records if record.base_record_id == "T-1")

    assert updated_trade.quantity == Decimal("12")
    assert updated_trade.commission == Decimal("2.50")
    assert updated_trade.overlay_status == "MODIFIED"
    assert updated_trade.is_modified is True
    assert set(updated_trade.modified_fields) == {"comment", "commission", "quantity"}
    assert editable_trade.deleted is False
    assert editable_trade.validation_state.is_valid is True
    assert editable_trade.original_values["quantity"] == "10"
    assert editable_trade.current_values["quantity"] == "12"


def test_apply_manual_overrides_hides_deleted_event_and_adds_new_trade():
    config = EngineConfig(run_mode="SAFE", tax_year=2025)
    merge_result = merge_dataset(
        CanonicalDataset(
            trades=(make_trade("T-1"),),
            events=(make_event("E-1"),),
        ),
        config,
    )
    overrides = [
        TransactionOverride(
            override_id="override-delete-event",
            mode="override",
            record_type="EVENT",
            base_record_id="E-1",
            manual_record_id="manual-delete-event",
            deleted=True,
            values={},
            updated_at="2026-04-23T12:00:00Z",
            created_at="2026-04-23T12:00:00Z",
        ),
        TransactionOverride(
            override_id="override-new-trade",
            mode="new",
            record_type="TRADE",
            base_record_id=None,
            manual_record_id="manual-new-trade",
            deleted=False,
            values={
                "date": "2025-02-03",
                "symbol": "XYZ.US",
                "isin": "US9999999999",
                "side": "BUY",
                "quantity": "3",
                "price": "20.00",
                "gross_amount": "60.00",
                "trade_currency": "USD",
                "commission": "1.00",
                "commission_currency": "USD",
                "settlement_date": "2025-02-05",
                "comment": "nowa transakcja",
                "message": "dodana recznie",
            },
            updated_at="2026-04-23T12:00:00Z",
            created_at="2026-04-23T12:00:00Z",
        ),
    ]

    updated_result, editable_records = apply_manual_overrides(merge_result, overrides, config)

    assert "E-1" not in updated_result.ledger.events_by_id
    assert any(trade.symbol == "XYZ.US" and trade.overlay_status == "NEW" for trade in updated_result.ledger.trades_by_id.values())
    deleted_record = next(record for record in editable_records if record.base_record_id == "E-1")
    new_record = next(record for record in editable_records if record.manual_record_id == "manual-new-trade")
    assert deleted_record.deleted is True
    assert new_record.overlay_status == "NEW"
    assert new_record.current_values["symbol"] == "XYZ.US"


def test_apply_manual_overrides_marks_orphan_override_without_guessing_mapping():
    config = EngineConfig(run_mode="SAFE", tax_year=2025)
    merge_result = merge_dataset(CanonicalDataset(trades=(make_trade("T-1"),), events=()), config)
    overrides = [
        TransactionOverride(
            override_id="override-orphan",
            mode="override",
            record_type="TRADE",
            base_record_id="MISSING-TRADE",
            manual_record_id="manual-orphan",
            deleted=False,
            values={"quantity": "5"},
            updated_at="2026-04-23T12:00:00Z",
            created_at="2026-04-23T12:00:00Z",
        )
    ]

    updated_result, editable_records = apply_manual_overrides(merge_result, overrides, config)

    assert any(issue.code == "ORPHAN_TRANSACTION_OVERRIDE" for issue in updated_result.ledger.issues)
    orphan_record = next(record for record in editable_records if record.manual_record_id == "manual-orphan")
    assert orphan_record.validation_state.status == "ORPHAN"
    assert orphan_record.validation_state.is_valid is False


def test_new_manual_dividend_and_account_fee_keep_tax_effects():
    config = EngineConfig(run_mode="SAFE", tax_year=2025)
    merge_result = merge_dataset(CanonicalDataset(trades=(), events=()), config)
    overrides = [
        TransactionOverride(
            override_id="manual-dividend", mode="new", record_type="EVENT", base_record_id=None,
            manual_record_id="manual-dividend", deleted=False,
            values={"date": "2025-01-21", "event_kind": "DIVIDEND", "symbol": "PTON.US", "amount": "5", "currency": "USD"},
            updated_at="2026-01-01T00:00:00Z", created_at="2026-01-01T00:00:00Z",
        ),
        TransactionOverride(
            override_id="manual-fee", mode="new", record_type="EVENT", base_record_id=None,
            manual_record_id="manual-fee", deleted=False,
            values={"date": "2025-01-21", "event_kind": "ACCOUNT_FEE", "amount": "2", "currency": "USD"},
            updated_at="2026-01-01T00:00:00Z", created_at="2026-01-01T00:00:00Z",
        ),
    ]

    updated, _ = apply_manual_overrides(merge_result, overrides, config)

    dividend = updated.ledger.events_by_id["manual-dividend"]
    fee = updated.ledger.events_by_id["manual-fee"]
    assert dividend.logical_world == "equity_tax"
    assert fee.logical_world == "equity_tax"
    assert fee.cost_bucket == "ACCOUNT_FEE"


def _korekta(base_id, values, *, mode="override", manual_id=None, record_type="TRADE"):
    return TransactionOverride(
        override_id=f"override-{manual_id or base_id}",
        mode=mode,
        record_type=record_type,
        base_record_id=base_id,
        manual_record_id=manual_id or f"edit-{base_id}",
        deleted=False,
        values=values,
        updated_at="2026-09-28T10:00:00Z",
        created_at="2026-09-28T10:00:00Z",
    )


def test_odrzucona_korekta_blokuje_tylko_gdy_zmienia_rozliczany_rok():
    config = EngineConfig(run_mode="SAFE", tax_year=2026)
    zakup_2025 = make_trade("T-BUY")
    sprzedaz_2025 = make_trade("T-SELL")
    sprzedaz_2025.side = "SELL"
    # NBIS.US jest sprzedawany w 2026 - dawny zakup moze zasilic FIFO roku.
    sprzedaz_2026 = make_trade("T-SELL-2026")
    sprzedaz_2026.side = "SELL"
    sprzedaz_2026.tax_event_date = pd.Timestamp("2026-05-04")
    sprzedaz_2026.executed_at = pd.Timestamp("2026-05-04T10:00:00")
    sprzedaz_2026.exchange_time = pd.Timestamp("2026-05-04T10:00:00")
    # XYZ.US kupiony i sprzedany w calosci w 2025 - nie zmienia PIT za 2026 (R12).
    zakup_xyz = make_trade("T-BUY-XYZ", symbol="XYZ.US")
    merge_result = merge_dataset(
        CanonicalDataset(trades=(zakup_2025, sprzedaz_2025, sprzedaz_2026, zakup_xyz), events=()), config
    )
    zla_ilosc = {"quantity": "abc"}

    wynik, _ = apply_manual_overrides(
        merge_result,
        [
            _korekta("T-BUY", zla_ilosc),
            _korekta("T-SELL", zla_ilosc),
            _korekta("T-BUY-XYZ", zla_ilosc),
            _korekta(None, {"date": "2027-03-01", "symbol": "XYZ.US", "side": "BUY", "quantity": "x",
                            "price": "1", "gross_amount": "1", "commission": "0", "trade_currency": "USD"},
                     mode="new", manual_id="nowa-2027"),
            _korekta(None, {"date": "2026-03-01", "symbol": "XYZ.US", "side": "BUY", "quantity": "x",
                            "price": "1", "gross_amount": "1", "commission": "0", "trade_currency": "USD"},
                     mode="new", manual_id="nowa-2026"),
        ],
        config,
    )

    bledy = {issue.scope_id: issue for issue in wynik.ledger.issues if issue.code == "MANUAL_OVERRIDE_VALIDATION_ERROR"}
    # Zakup sprzed roku to partia FIFO - odrzucona korekta moze zmienic koszt tegorocznej sprzedazy.
    assert bledy["T-BUY"].blocking is True
    # Sprzedaz z 2025 i nowy rekord z 2027 nie zmieniaja PIT za 2026.
    assert bledy["T-SELL"].blocking is False
    # Zakup waloru bez sprzedazy w rozliczanym roku nie blokuje.
    assert bledy["T-BUY-XYZ"].blocking is False
    assert bledy["nowa-2027"].blocking is False
    assert bledy["nowa-2026"].blocking is True
    # Komunikat mowi, ktorego rekordu dotyczy.
    assert bledy["T-BUY"].message.startswith("NBIS.US, 2025-01-21: ")


def test_nowa_reczna_sprzedaz_z_krajem_ma_kraj_dla_pit_zg():
    from investment_tax_engine.tax.pit_zg import _country_of_trade

    config = EngineConfig(run_mode="SAFE", tax_year=2026)
    merge_result = merge_dataset(CanonicalDataset(trades=(), events=()), config)
    wynik, _ = apply_manual_overrides(
        merge_result,
        [_korekta(None, {"date": "2026-06-11", "symbol": "NOTA.X", "side": "SELL", "quantity": "3",
                         "price": "320.45", "gross_amount": "961.35", "commission": "0",
                         "trade_currency": "USD", "country": " cy "},
                  mode="new", manual_id="nowa-nota")],
        config,
    )
    nowa = next(trade for trade in wynik.ledger.trades_by_id.values() if trade.symbol == "NOTA.X")
    assert nowa.user_country == "CY"
    assert _country_of_trade(nowa) == "CY"


def test_usunieta_sprzedaz_roku_nie_utrzymuje_blokady_dawnego_zakupu():
    # R13: wazna korekta usuwa jedyna tegoroczna sprzedaz - dawny zakup nie zasila
    # juz zadnej sprzedazy roku, wiec jego odrzucona korekta nie blokuje.
    config = EngineConfig(run_mode="SAFE", tax_year=2026)
    zakup_2025 = make_trade("T-BUY")
    sprzedaz_2026 = make_trade("T-SELL-2026")
    sprzedaz_2026.side = "SELL"
    sprzedaz_2026.tax_event_date = pd.Timestamp("2026-05-04")
    sprzedaz_2026.executed_at = pd.Timestamp("2026-05-04T10:00:00")
    sprzedaz_2026.exchange_time = pd.Timestamp("2026-05-04T10:00:00")
    merge_result = merge_dataset(CanonicalDataset(trades=(zakup_2025, sprzedaz_2026), events=()), config)
    usun = TransactionOverride(
        override_id="override-usun", mode="override", record_type="TRADE", base_record_id="T-SELL-2026",
        manual_record_id="usun-sprzedaz", deleted=True, values={},
        updated_at="2026-09-28T10:00:00Z", created_at="2026-09-28T10:00:00Z",
    )
    wynik, _ = apply_manual_overrides(merge_result, [usun, _korekta("T-BUY", {"quantity": "abc"})], config)
    blad = next(issue for issue in wynik.ledger.issues if issue.code == "MANUAL_OVERRIDE_VALIDATION_ERROR")
    assert blad.scope_id == "T-BUY"
    assert blad.blocking is False
