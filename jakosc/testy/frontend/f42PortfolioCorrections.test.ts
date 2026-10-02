import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mapOpenPositions,
  mapRealizedGains,
  mapYearSummaries,
} from '../../../aplikacje/web/src/portfel/services/engineBridge.ts';
import { buildAssetAllocationData } from '../../../aplikacje/web/src/portfel/services/allocationData.ts';
import { wycenPozycje } from '../../../aplikacje/web/src/portfel/services/wycenaPozycji.ts';
import type { BrokerAccount, Transaction } from '../../../aplikacje/web/src/portfel/types.ts';

const rachunki: BrokerAccount[] = [
  { id: 'A', name: 'Rachunek A', brokerType: 'XTB', currency: 'PLN', color: '#f00' },
  { id: 'B', name: 'Rachunek B', brokerType: 'IBKR', currency: 'PLN', color: '#00f' },
  { id: 'C', name: 'Rachunek C', brokerType: 'CUSTOM', currency: 'PLN', color: '#0f0' },
];

function transakcja(nadpisania: Partial<Transaction>): Transaction {
  return {
    id: 'tx', date: '2025-01-01', type: 'BUY', ticker: 'ABC.US', name: 'ABC',
    category: 'STOCK_FOREIGN', quantity: 1, pricePerUnit: 100, currency: 'USD',
    commission: 0, commissionCurrency: 'USD', accountId: 'A', ...nadpisania,
  };
}

test('wiersze FIFO sprzedaży przypisują rachunek po sell_trade_id, także dla ID silnik:<id>', () => {
  const transactions = [
    transakcja({ id: 'sprzedaz-A', type: 'SELL', accountId: 'A' }),
    transakcja({ id: 'silnik:sprzedaz-B', type: 'SELL', accountId: 'B' }),
    transakcja({ id: 'sprzedaz-C', type: 'SELL', accountId: 'C' }),
  ];
  const gains = mapRealizedGains({ fifo_rows: [
    { sell_trade_id: 'sprzedaz-A', buy_trade_id: 'buy-A', symbol: 'ABC.US', quantity: 1, sell_tax_date: '2025-02-01', gross_revenue_pln: 120, cost_pln: 100, pnl_pln: 20 },
    { sell_trade_id: 'sprzedaz-B', buy_trade_id: 'buy-B', symbol: 'ABC.US', quantity: 1, sell_tax_date: '2025-02-02', gross_revenue_pln: 80, cost_pln: 70, pnl_pln: 10 },
    { sell_trade_id: 'portfel-sprzedaz-C', buy_trade_id: 'buy-C', symbol: 'ABC.US', quantity: 1, sell_tax_date: '2025-02-03', gross_revenue_pln: 60, cost_pln: 50, pnl_pln: 10 },
  ] } as never, transactions);

  assert.deepEqual(gains.map(({ accountId }) => accountId), ['A', 'B', 'C']);
});

test('rozbicie roczne dodaje 5 PLN kosztów silnika nieprzypisanych do rachunku', () => {
  const gains = mapRealizedGains({ fifo_rows: [
    { sell_trade_id: 'sale-A', symbol: 'ABC.US', quantity: 1, sell_tax_date: '2025-02-01', gross_revenue_pln: 120, cost_pln: 100, pnl_pln: 20 },
    { sell_trade_id: 'sale-B', symbol: 'XYZ.US', quantity: 1, sell_tax_date: '2025-02-02', gross_revenue_pln: 120, cost_pln: 100, pnl_pln: 20 },
  ] } as never, [
    transakcja({ id: 'sale-A', ticker: 'ABC.US', type: 'SELL', accountId: 'A' }),
    transakcja({ id: 'sale-B', ticker: 'XYZ.US', type: 'SELL', accountId: 'B' }),
  ]);
  const year = mapYearSummaries({ annual_summary: { tax_year: 2025 }, art30b: { pit38_form_revenue_pln: 240, pit38_form_cost_pln: 205 } } as never, 2025, gains, [], rachunki).get(2025)!;

  assert.equal(year.costsPLN, 205);
  assert.deepEqual(year.brokerBreakdowns.map(({ costsPLN }) => costsPLN), [100, 100, 5]);
  assert.equal(year.brokerBreakdowns.reduce((sum, row) => sum + row.costsPLN, 0), year.costsPLN);
  assert.equal(year.brokerBreakdowns.at(-1)?.accountName, 'Nieprzypisane do rachunku');
});

test('wynik walutowy uwzględnia prowizję zakupu w tej samej walucie', () => {
  const buy = transakcja({ id: 'buy-usd', commission: 2.5, commissionCurrency: 'USD' });
  const [position] = mapOpenPositions({ open_lots: [{ buy_trade_id: 'buy-usd', symbol: 'ABC.US', quantity_open: 1, quantity_remaining: 1, cost_remaining_pln: 410, price: 100, currency: 'USD', open_date: '2025-01-01' }] } as never, [buy]);
  const [value] = wycenPozycje([position], { 'ABC.US': { ticker: 'ABC.US', name: 'ABC', category: 'STOCK_FOREIGN', price: 110, currency: 'USD' } as never }, { USD: 4 });

  assert.equal(value.costOrig, 102.5);
  assert.equal(value.unrealizedOrig, 7.5);
  assert.equal(value.fxImpactPLN, 0);
});

test('nieprzeliczalna prowizja w innej walucie ukrywa pozornie dokładny wynik walutowy i FX', () => {
  const buy = transakcja({ id: 'buy-usd', commission: 2.5, commissionCurrency: 'EUR' });
  const [position] = mapOpenPositions({ open_lots: [{ buy_trade_id: 'buy-usd', symbol: 'ABC.US', quantity_open: 1, quantity_remaining: 1, cost_remaining_pln: 410, price: 100, currency: 'USD', open_date: '2025-01-01' }] } as never, [buy]);
  const [value] = wycenPozycje([position], { 'ABC.US': { ticker: 'ABC.US', name: 'ABC', category: 'STOCK_FOREIGN', price: 110, currency: 'USD' } as never }, { USD: 4 });

  assert.equal(value.unrealizedOrig, null);
  assert.equal(value.fxImpactPLN, null);
});

test('alokacja aktywów jest pusta po zamknięciu pozycji, niezależnie od obrotu zrealizowanego', () => {
  const dawnaSprzedaż = { revenuePLN: 120, costPLN: 100 };
  assert.equal(dawnaSprzedaż.revenuePLN + dawnaSprzedaż.costPLN, 220);
  assert.deepEqual(buildAssetAllocationData([], 0, {}), []);
});

test('rozbicie roczne uzgadnia także przychód sprzedaży bez rachunku (R15)', () => {
  const gains = mapRealizedGains({ fifo_rows: [
    { sell_trade_id: 'sale-A', symbol: 'ABC.US', quantity: 1, sell_tax_date: '2025-02-01', gross_revenue_pln: 120, cost_pln: 100, pnl_pln: 20 },
    { sell_trade_id: 'nieznana', symbol: 'QQQ.US', quantity: 1, sell_tax_date: '2025-02-03', gross_revenue_pln: 80, cost_pln: 50, pnl_pln: 30 },
  ] } as never, [transakcja({ id: 'sale-A', ticker: 'ABC.US', type: 'SELL', accountId: 'A' })]);
  const year = mapYearSummaries({ annual_summary: { tax_year: 2025 }, art30b: { pit38_form_revenue_pln: 200, pit38_form_cost_pln: 150 } } as never, 2025, gains, [], rachunki).get(2025)!;
  const nieprzypisane = year.brokerBreakdowns.find((wiersz) => wiersz.accountId === 'unassigned');
  assert.equal(nieprzypisane?.revenuePLN, 80);
  assert.equal(nieprzypisane?.costsPLN, 50);
  assert.equal(year.brokerBreakdowns.reduce((sum, row) => sum + row.revenuePLN, 0), year.revenuePLN);
  assert.equal(year.brokerBreakdowns.reduce((sum, row) => sum + row.costsPLN, 0), year.costsPLN);
});
