from __future__ import annotations

from investment_tax_engine.app.engine import InvestmentTaxEngine
from investment_tax_engine.models.core import EngineConfig


def test_broker_report_maturity_is_a_sell_with_report_date_and_currency():
    engine = InvestmentTaxEngine(EngineConfig(run_mode="SAFE", tax_year=2026))
    dataset = engine.normalize([
        {
            "source": "BROKER_REPORT_JSON",
            "source_file": "broker_raport.json",
            "source_sheet": "corporate_actions",
            "rows": [{
                "broker_report_section": "corporate_actions",
                "broker_report_row_type": "FRESH_BROKER_REPORT_REVIEW",
                "type": "Termin zapadalności",
                "corporate_action_id": "maturity-1",
                "ticker": "DGT4016.JUN26",
                "q_on_ex_date": "3",
                "amount_per_one": "100",
                "amount": "300",
                "currency": "USD",
                "date": "2026-06-15",
            }],
        }
    ])

    assert len(dataset.trades) == 1
    trade = dataset.trades[0]
    assert trade.side == "SELL"
    assert str(trade.quantity) == "3"
    assert str(trade.gross_amount) == "300"
    assert trade.trade_currency == "USD"
    assert str(trade.exchange_time.date()) == "2026-06-15"
