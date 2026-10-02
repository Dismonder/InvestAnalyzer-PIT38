from __future__ import annotations

import json
from copy import deepcopy
from decimal import Decimal
from pathlib import Path

import pandas as pd
import pytest

from zestaw_wejsciowy import zestaw_wejsciowy

from investment_tax_engine.merge.merge_engine import merge_dataset, upsert_trade
from investment_tax_engine.models.core import CanonicalDataset, CanonicalTrade, Ledger
from investment_tax_engine.normalize.events import normalize_tradernet_event
from investment_tax_engine.normalize.trades import normalize_api_trade

API_FIXTURE = zestaw_wejsciowy().api_json


def load_api_fixture() -> list[dict]:
    return json.loads(API_FIXTURE.read_text(encoding="utf-8"))["trades"]["trade"]


def test_normalize_api_trade_classifies_repo_fx_and_structured_product():
    """Kod klasy instrumentu z API rozstrzyga o swiecie logicznym transakcji.

    Test wybieral wiersze po walorach z portfela uzytkownika, wiec na kazdym
    innym zestawie wysypywal sie na `KeyError`. Regula silnika nie dotyczy
    jednak konkretnych spolek, tylko pola `instr_type_c`.
    """
    by_type = {}
    for row in load_api_fixture():
        code = str(row.get("instr_type_c") or "").strip()
        if code:
            by_type.setdefault(code, row)

    assert {"18", "6", "19"} <= set(by_type), "zestaw musi miec repo, przewalutowanie i produkt strukturyzowany"

    repo_trade = normalize_api_trade(by_type["18"], source_name="API_JSON_FULL")
    fx_trade = normalize_api_trade(by_type["6"], source_name="API_JSON_FULL")
    structured_trade = normalize_api_trade(by_type["19"], source_name="API_JSON_FULL")

    assert repo_trade.instrument_class == "REPO"
    assert repo_trade.logical_world == "diagnostic_only"
    assert repo_trade.acquisition_mode == "REPO"

    assert fx_trade.instrument_class == "FX"
    assert fx_trade.logical_world == "private_cash_fx"

    assert structured_trade.instrument_class == "STRUCTURED_PRODUCT"
    assert structured_trade.logical_world == "equity_tax"
    assert structured_trade.acquisition_mode == "STRUCTURED_PRODUCT"


@pytest.mark.parametrize(
    ("symbol", "oczekiwana_klasa"),
    [
        ("FRHC.US", "REPO"),
        ("DGT4016.JUN26", "STRUCTURED_PRODUCT"),
        ("EUR/USD", "FX"),
        ("NVDA.US", "EQUITY"),
    ],
)
def test_normalize_api_trade_classifies_by_symbol_when_type_code_is_absent(symbol, oczekiwana_klasa):
    """Starsze wyciagi nie maja `instr_type_c` - zostaje ksztalt waloru.

    Te reguly zapasowe zniknely z pokrycia, gdy test klasyfikacji przeszedl na
    kod klasy; bez nich transakcja repo ze starego pliku liczylaby sie jak akcja.
    """
    row = {
        "trade_id": 1,
        "date": "2025-05-05 10:00:00",
        "instr_nm": symbol,
        "operation": "buy",
        "p": 10,
        "q": 1,
        "summ": 10,
        "curr_c": "USD",
    }

    assert normalize_api_trade(row, source_name="API_JSON_FULL").instrument_class == oczekiwana_klasa


def test_normalize_tradernet_event_classifies_fee_dividend_and_source_tax():
    fee_row = {
        "Operacja №": 1,
        "Data": pd.Timestamp("2026-04-17 15:20:08"),
        "Rodzaj zlecenia": " Prowizja za transakcje ",
        "Komentarz": "(Trade 642118338 buy NBIS.US ) Market: usa, security type: stocks",
        "Kwota": -2.6,
        "waluta": "USD",
    }
    dividend_row = {
        "Operacja №": 2,
        "Data": pd.Timestamp("2026-04-03 12:14:19"),
        "Rodzaj zlecenia": "Dywidendy",
        "Komentarz": "Dividends on security (Nvidia Corporation (NVDA.US)), record date 2026-03-11.",
        "Kwota": 0.2,
        "waluta": "USD",
    }
    tax_row = {
        "Operacja №": 3,
        "Data": pd.Timestamp("2026-04-03 12:14:19"),
        "Rodzaj zlecenia": "Podatki",
        "Komentarz": "Corporate action tax on security ( NVDA.US ), record date 2026-03-11 .",
        "Kwota": -0.03,
        "waluta": "USD",
    }

    fee_event = normalize_tradernet_event(fee_row)
    dividend_event = normalize_tradernet_event(dividend_row)
    tax_event = normalize_tradernet_event(tax_row)

    assert fee_event.event_kind == "TRADE_FEE"
    assert fee_event.cost_bucket == "RECONSTRUCTED_COMMISSION"
    assert fee_event.cost_class == "CERTAIN"
    assert fee_event.linked_trade_id == "642118338"

    assert dividend_event.event_kind == "DIVIDEND"
    assert dividend_event.logical_world == "equity_tax"

    assert tax_event.event_kind == "TAX"
    assert tax_event.cost_bucket == "SOURCE_TAX"
    assert tax_event.cost_class == "CERTAIN"


def test_normalize_tradernet_event_keeps_commission_blocks_technical():
    block_row = {
        "Operacja №": 10,
        "Data": pd.Timestamp("2026-04-17 15:20:08"),
        "Rodzaj zlecenia": "Blokowanie prowizji",
        "Komentarz": "Technical commission hold",
        "Kwota": -2.6,
        "waluta": "USD",
    }
    unblock_row = {
        "Operacja №": 11,
        "Data": pd.Timestamp("2026-04-18 15:20:08"),
        "Rodzaj zlecenia": "Odblokowanie prowizję",
        "Komentarz": "Technical commission release",
        "Kwota": 2.6,
        "waluta": "USD",
    }

    block_event = normalize_tradernet_event(block_row)
    unblock_event = normalize_tradernet_event(unblock_row)

    assert block_event.event_kind == "BLOCK"
    assert block_event.logical_world == "diagnostic_only"
    assert block_event.cost_bucket is None

    assert unblock_event.event_kind == "UNBLOCK"
    assert unblock_event.logical_world == "diagnostic_only"
    assert unblock_event.cost_bucket is None


def test_normalize_tradernet_event_generates_stable_unique_fallback_id_without_operation_number():
    first = normalize_tradernet_event(
        {
            "Data": pd.Timestamp("2025-01-21"),
            "Rodzaj zlecenia": "Top up",
            "Komentarz": "Top up account through a bank transfer",
            "Kwota": 10527.68,
            "waluta": "USD",
        },
        source_file="Ruchy_gotówki.xlsx",
        source_sheet="Arkusz1",
    )
    second = normalize_tradernet_event(
        {
            "Data": pd.Timestamp("2025-01-22"),
            "Rodzaj zlecenia": "Inny ruch",
            "Komentarz": "Different cash movement without broker operation number",
            "Kwota": 12,
            "waluta": "USD",
        },
        source_file="Ruchy_gotówki.xlsx",
        source_sheet="Arkusz1",
    )

    assert first.event_id != "UNKNOWN"
    assert second.event_id != "UNKNOWN"
    assert first.event_id != second.event_id
    assert first.source_record_id == first.event_id


def test_normalize_api_trade_unknown_currency_requires_review_instead_of_usd_fallback():
    trade = normalize_api_trade(
        {
            "id": "NO-CURRENCY-1",
            "instr_nm": "UNKNOWN_SYMBOL",
            "type": "1",
            "q": "1",
            "p": "10",
            "v": "10",
            "date": "2026-04-17 10:00:00",
        },
        source_name="BROKER_JSON",
    )

    assert trade.trade_currency == "UNKNOWN"
    assert trade.certainty_status == "REVIEW_REQUIRED"
    assert trade.review_status == "UNREVIEWED"


def test_normalize_api_trade_uses_operation_sell_as_sell_side():
    trade = normalize_api_trade(
        {
            "id": "BROKER-SELL-1",
            "instr_nm": "NBIS.US",
            "operation": "sell",
            "q": "2",
            "p": "10",
            "v": "20",
            "curr": "USD",
            "date": "2025-06-17 10:00:00",
        },
        source_name="BROKER_JSON",
    )

    assert trade.side == "SELL"
    assert trade.symbol == "NBIS.US"


def test_merge_prefers_highest_priority_trade_and_logs_conflict():
    base_trade = CanonicalTrade(
        trade_id="T-1",
        order_id="O-1",
        trade_number="N-1",
        symbol="NBIS.US",
        isin=None,
        side="BUY",
        instrument_type_code="1",
        instrument_class="EQUITY",
        market_id="30000000001",
        quantity=Decimal("10"),
        price=Decimal("100"),
        gross_amount=Decimal("1000"),
        trade_currency="USD",
        commission=Decimal("2.50"),
        commission_currency="USD",
        broker_reported_profit=Decimal("0"),
        executed_at=pd.Timestamp("2026-04-17 10:00:00"),
        exchange_time=pd.Timestamp("2026-04-17 10:00:00"),
        settlement_date=pd.Timestamp("2026-04-19 00:00:00"),
        confirm_time=None,
        otc=False,
        repo_close=None,
        base_contract_code=None,
        current_position_qty_after_trade=Decimal("0"),
        source_name="API_JSON_FULL",
        source_priority=110,
        source_record_id="488585388",
        sources=["API_JSON_FULL"],
    )
    weaker_trade = deepcopy(base_trade)
    weaker_trade.source_name = "TRADES_V1"
    weaker_trade.source_priority = 100
    weaker_trade.price = Decimal("101")
    weaker_trade.source_record_id = "sheet-2-row-5"

    ledger = Ledger()
    upsert_trade(ledger, base_trade)
    upsert_trade(ledger, weaker_trade)

    merged = ledger.trades_by_id["T-1"]

    assert merged.price == Decimal("100")
    assert any(issue.code == "FIELD_CONFLICT" for issue in ledger.issues)
    assert any(link["field"] == "price" and link["winner"] == "API_JSON_FULL" for link in merged.source_links)


def test_merge_suppresses_api_metadata_conflicts_from_lower_priority_fallbacks():
    base_trade = CanonicalTrade(
        trade_id="488585388",
        order_id="O-1",
        trade_number="N-1",
        symbol="TSLA.US",
        isin=None,
        side="BUY",
        instrument_type_code="1",
        instrument_class="EQUITY",
        market_id="30000000001",
        quantity=Decimal("1"),
        price=Decimal("250"),
        gross_amount=Decimal("250"),
        trade_currency="USD",
        commission=Decimal("1.00"),
        commission_currency="EUR",
        broker_reported_profit=Decimal("0"),
        executed_at=pd.Timestamp("2025-01-10 15:30:00"),
        exchange_time=pd.Timestamp("2025-01-10 15:30:05"),
        settlement_date=pd.Timestamp("2025-01-14 00:00:00"),
        confirm_time=None,
        otc=False,
        repo_close=None,
        base_contract_code=None,
        current_position_qty_after_trade=Decimal("12"),
        source_name="API_JSON_FULL",
        source_priority=110,
        source_record_id="488585388",
        certainty_status="CERTAIN",
        review_status="AUTO_REVIEWED",
        sources=["API_JSON_FULL"],
    )
    fallback_trade = deepcopy(base_trade)
    fallback_trade.source_name = "TRADES_V1"
    fallback_trade.source_priority = 100
    fallback_trade.source_record_id = "sheet-row-12"
    fallback_trade.executed_at = pd.Timestamp("2025-01-10 16:30:00")
    fallback_trade.exchange_time = pd.Timestamp("2025-01-10 16:30:00")
    fallback_trade.settlement_date = pd.Timestamp("2025-01-15 00:00:00")
    fallback_trade.otc = True
    fallback_trade.current_position_qty_after_trade = Decimal("11")
    fallback_trade.commission_currency = "USD"
    fallback_trade.certainty_status = "CONDITIONAL"
    fallback_trade.review_status = "UNREVIEWED"

    ledger = Ledger()
    upsert_trade(ledger, base_trade)
    upsert_trade(ledger, fallback_trade)

    conflict_fields = {
        issue.details.get("field")
        for issue in ledger.issues
        if issue.code == "FIELD_CONFLICT"
    }

    assert "executed_at" not in conflict_fields
    assert "exchange_time" not in conflict_fields
    assert "settlement_date" not in conflict_fields
    assert "otc" not in conflict_fields
    assert "current_position_qty_after_trade" not in conflict_fields
    assert "commission_currency" not in conflict_fields
    assert "certainty_status" not in conflict_fields
    assert "review_status" not in conflict_fields


def test_merge_suppresses_rounded_broker_profit_differences_from_fallback_sources():
    base_trade = CanonicalTrade(
        trade_id="497264060",
        order_id="O-1",
        trade_number="N-1",
        symbol="PTON.US",
        isin=None,
        side="SELL",
        instrument_type_code="1",
        instrument_class="EQUITY",
        market_id="30000000001",
        quantity=Decimal("1"),
        price=Decimal("8.57"),
        gross_amount=Decimal("8.57"),
        trade_currency="USD",
        commission=Decimal("0.10"),
        commission_currency="USD",
        broker_reported_profit=Decimal("8.57390000"),
        executed_at=pd.Timestamp("2025-02-10 10:00:00"),
        exchange_time=pd.Timestamp("2025-02-10 10:00:00"),
        settlement_date=pd.Timestamp("2025-02-12 00:00:00"),
        confirm_time=None,
        otc=False,
        repo_close=None,
        base_contract_code=None,
        current_position_qty_after_trade=Decimal("0"),
        source_name="API_JSON_FULL",
        source_priority=110,
        source_record_id="497264060",
        sources=["API_JSON_FULL"],
    )
    fallback_trade = deepcopy(base_trade)
    fallback_trade.source_name = "TRADES_V1"
    fallback_trade.source_priority = 100
    fallback_trade.source_record_id = "sheet-row-44"
    fallback_trade.broker_reported_profit = Decimal("8.57")

    ledger = Ledger()
    upsert_trade(ledger, base_trade)
    upsert_trade(ledger, fallback_trade)

    conflict_fields = {
        issue.details.get("field")
        for issue in ledger.issues
        if issue.code == "FIELD_CONFLICT"
    }

    assert "broker_reported_profit" not in conflict_fields


def _aggregated_depo_row(row_index: int, *, quantity: int, price: str) -> dict:
    """Wiersz z raportu depozytariusza dla pozycji scalonej przez brokera.

    Broker wpisuje literal "Zgrupowano" w date, pay_d oraz id, a faktyczna
    date zostawia w short_date.
    """
    return {
        "mkt_id": 30000000001,
        "short_date": "2025-01-21",
        "instr_nm": "FRHC.US",
        "isin": "US3563901046",
        "operation": "buy",
        "curr_c": "USD",
        "commission_currency": "USD",
        "q": quantity,
        "p": price,
        "summ": 9000,
        "commission": 0,
        "date": "Zgrupowano",
        "pay_d": "Zgrupowano",
        "id": "Zgrupowano",
        "source_row_index": row_index,
    }


def test_aggregated_trade_takes_date_from_short_date():
    trade = normalize_api_trade(_aggregated_depo_row(0, quantity=67, price="134.32835821"))

    assert trade.executed_at == pd.Timestamp("2025-01-21")


def test_aggregated_trade_leaves_settlement_date_empty():
    # Brak daty rozliczenia to informacja, a nie powod do podstawienia daty zawarcia.
    trade = normalize_api_trade(_aggregated_depo_row(0, quantity=67, price="134.32835821"))

    assert trade.settlement_date is None


def test_aggregated_trades_do_not_collapse_into_one_identifier():
    # Wszystkie scalone wiersze niosa ten sam literal w polu id. Przyjety jako
    # identyfikator sklejalby je w jedna transakcje i gubil reszte.
    first = normalize_api_trade(_aggregated_depo_row(0, quantity=67, price="134.32835821"))
    second = normalize_api_trade(_aggregated_depo_row(1, quantity=67, price="142.97238806"))

    assert first.trade_id != second.trade_id
    assert "zgrupowano" not in first.trade_id.lower()
    assert "zgrupowano" not in second.trade_id.lower()


def test_regular_trade_keeps_its_broker_identifier_and_date():
    row = {
        "instr_nm": "FRHC.US",
        "operation": "buy",
        "curr_c": "USD",
        "q": 10,
        "p": "100.00",
        "date": "2025-03-04",
        "short_date": "2025-03-01",
        "id": "TRADE-12345",
    }

    trade = normalize_api_trade(row)

    assert trade.trade_id == "TRADE-12345"
    # date ma pierwszenstwo przed short_date, gdy jest poprawna data.
    assert trade.executed_at == pd.Timestamp("2025-03-04")
