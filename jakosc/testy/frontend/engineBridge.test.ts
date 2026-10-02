/**
 * engineBridge.test.ts — testy konwersji portfel → silnik podatkowy.
 *
 * Testy pilnują DOKŁADNYCH nazw pól, bo silnik czyta tylko swoje aliasy
 * (normalize/trades.py i normalize/events.py). Zmiana nazwy pola nie wywołuje
 * błędu — silnik po prostu przestaje widzieć dane i zwraca 0,00 zł albo gubi
 * całą kategorię zdarzeń. Format poniżej został sprawdzony na uruchomionym
 * silniku: przychód 7747,72 zł, koszt 5950,11 zł, dywidenda 98,42 zł.
 *
 * Najważniejsze pułapki:
 * - transakcja bez pola "Kwota" → przychód i koszt wychodzą 0,00 zł,
 * - zdarzenie z polem "kind" zamiast "type" → silnik go nie klasyfikuje,
 * - dywidenda bez słowa "dividend" w komentarzu i bez członu "dywid"
 *   w rodzaju → znika z PIT/ZG, a bramka jakości blokuje całe rozliczenie.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mapRealizedGains,
  mapOpenPositions,
  pozycjeNaRachunku,
  KONTO_MAGAZYNU_SILNIKA,
  RACHUNEK_NIEUSTALONY,
  transactionsToEngineInput,
  _STORAGE_FILENAME,
} from '../../../aplikacje/web/src/portfel/services/engineBridge.ts';
import { iloscZlecenia } from '../../../aplikacje/web/src/portfel/services/iloscZlecenia.ts';

test('wiersze FIFO pokazuja przychod brutto i koszt z prowizja sprzedazy', () => {
  const response = {
    fifo_rows: [
      {
        row_id: 'RR-1', sell_trade_id: 'SELL-1', buy_trade_id: 'BUY-1', symbol: 'ABC.US',
        quantity: '1', sell_tax_date: '2025-02-01', buy_tax_date: '2025-01-01',
        gross_revenue_pln: '33.33', sell_commission_alloc_pln: '0.01',
        net_revenue_pln: '33.32', cost_pln: '10.00', pnl_pln: '23.32',
      },
      {
        row_id: 'RR-2', sell_trade_id: 'SELL-1', buy_trade_id: 'BUY-2', symbol: 'ABC.US',
        quantity: '2', sell_tax_date: '2025-02-01', buy_tax_date: '2025-01-02',
        gross_revenue_pln: '66.67', sell_commission_alloc_pln: '0.02',
        net_revenue_pln: '66.65', cost_pln: '20.00', pnl_pln: '46.65',
      },
    ],
  } as Parameters<typeof mapRealizedGains>[0];

  const [gain] = mapRealizedGains(response, []);

  assert.equal(gain.revenuePLN, 100);
  assert.ok(Math.abs(gain.costPLN - 30.03) < 1e-9);
  assert.ok(Math.abs(gain.sellCommissionPLN - 0.03) < 1e-9);
  assert.ok(Math.abs(gain.profitPLN - 69.97) < 1e-9);
});

import type {
  Transaction,
  BrokerAccount,
} from '../../../aplikacje/web/src/portfel/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let nextId = 1;

function makeAccount(overrides?: Partial<BrokerAccount>): BrokerAccount {
  const id = `acc-${nextId++}`;
  return {
    id,
    name: 'Test Account',
    brokerType: 'XTB',
    currency: 'PLN',
    color: '#3B82F6',
    ...overrides,
  };
}

function makeBuy(overrides?: Partial<Transaction>): Transaction {
  return {
    id: `tx-${nextId++}`,
    date: '2024-03-15',
    type: 'BUY',
    ticker: 'AAPL.US',
    name: 'Apple Inc',
    category: 'STOCK_FOREIGN',
    quantity: 10,
    pricePerUnit: 170.0,
    currency: 'USD',
    commission: 5.0,
    commissionCurrency: 'USD',
    accountId: 'acc-1',
    ...overrides,
  };
}

function makeSell(overrides?: Partial<Transaction>): Transaction {
  return {
    id: `tx-${nextId++}`,
    date: '2024-06-20',
    type: 'SELL',
    ticker: 'AAPL.US',
    name: 'Apple Inc',
    category: 'STOCK_FOREIGN',
    quantity: 5,
    pricePerUnit: 195.0,
    currency: 'USD',
    commission: 5.0,
    commissionCurrency: 'USD',
    accountId: 'acc-1',
    ...overrides,
  };
}

function makeDividend(overrides?: Partial<Transaction>): Transaction {
  return {
    id: `tx-${nextId++}`,
    date: '2024-05-15',
    type: 'DIVIDEND',
    ticker: 'AAPL.US',
    name: 'Apple Inc',
    category: 'STOCK_FOREIGN',
    quantity: 10,
    pricePerUnit: 0.96,
    currency: 'USD',
    commission: 0,
    commissionCurrency: 'USD',
    accountId: 'acc-1',
    foreignTaxRate: 15,
    foreignTaxAmount: 1.44,
    ...overrides,
  };
}

test('otwarte partie tego samego waloru zachowują rachunek nabycia i ilość zlecenia', () => {
  const transactions = [
    makeBuy({ id: 'buy-a', ticker: 'XYZ', quantity: 3, accountId: 'account-a' }),
    makeBuy({ id: 'silnik:buy-b', ticker: 'XYZ', quantity: 7, accountId: 'account-b' }),
  ];
  const positions = mapOpenPositions({
    open_lots: [
      { origin_trade_id: 'buy-a', symbol: 'XYZ', quantity_open: 3, quantity_remaining: 3, cost_remaining_pln: 30, currency: 'USD' },
      { buy_trade_id: 'buy-b', symbol: 'XYZ', quantity_open: 7, quantity_remaining: 7, cost_remaining_pln: 70, currency: 'USD' },
    ],
  } as Parameters<typeof mapOpenPositions>[0], transactions);

  assert.deepEqual(positions.map(({ accountIds, totalQuantity }) => [accountIds[0], totalQuantity]).sort(), [
    ['account-a', 3],
    ['account-b', 7],
  ]);
  const accountB = pozycjeNaRachunku(positions, 'account-b');
  assert.equal(accountB.length, 1);
  assert.equal(iloscZlecenia(String(accountB[0].totalQuantity)), 7);
  assert.deepEqual(pozycjeNaRachunku(positions, RACHUNEK_NIEUSTALONY), []);
});

test('partia ręcznej transakcji portfela (ID z silnika: portfel-<id>) zostaje na jej rachunku', () => {
  const transactions = [makeBuy({ id: 'buy-a', ticker: 'XYZ', quantity: 3, accountId: 'account-a' })];
  const positions = mapOpenPositions({
    open_lots: [
      { origin_trade_id: 'portfel-buy-a', symbol: 'XYZ', quantity_open: 3, quantity_remaining: 3, cost_remaining_pln: 30, currency: 'USD' },
    ],
  } as Parameters<typeof mapOpenPositions>[0], transactions);

  assert.deepEqual(positions.map((pozycja) => pozycja.accountIds), [['account-a']]);
  // Nie jest dokumentem magazynu, wiec nie zasila zlecenia na innym rachunku brokera.
  assert.deepEqual(pozycjeNaRachunku(positions, 'account-b'), []);
  assert.equal(pozycjeNaRachunku(positions, 'account-a').length, 1);
});

test('partia bez identyfikatora transakcji trafia do pozycji nieustalonej i nie jest dostępna do zleceń', () => {
  const position = mapOpenPositions({
    open_lots: [
      { symbol: 'XYZ', quantity_open: 2, quantity_remaining: 2, cost_remaining_pln: 20, currency: 'USD' },
    ],
  } as Parameters<typeof mapOpenPositions>[0], []);

  assert.equal(position[0].accountIds[0], RACHUNEK_NIEUSTALONY);
  assert.equal(position[0].lots[0].accountId, RACHUNEK_NIEUSTALONY);
  assert.deepEqual(pozycjeNaRachunku(position, 'account-a'), []);
  assert.deepEqual(pozycjeNaRachunku(position, RACHUNEK_NIEUSTALONY), []);
});

test('partia z wyciągów w magazynie należy do dokumentów silnika i można z niej złożyć zlecenie', () => {
  // Transakcje z wyciągów mają ID silnika, a w portfelu występują jako `silnik:<wiersz>`.
  // Oznaczenie ich jako „rachunek nieustalony” wyłączało ze zleceń jedyną pozycję
  // użytkownika (NBIS z wyciągów Freedom24).
  const position = mapOpenPositions({
    open_lots: [
      { origin_trade_id: 'broker-buy-1', symbol: 'XYZ', quantity_open: 2, quantity_remaining: 2, cost_remaining_pln: 20, currency: 'USD' },
    ],
  } as Parameters<typeof mapOpenPositions>[0], []);

  assert.deepEqual(position[0].accountIds, [KONTO_MAGAZYNU_SILNIKA]);
  assert.deepEqual(pozycjeNaRachunku(position, 'account-a'), position);
});

test('jawny rachunek partii ma pierwszeństwo, gdy silnik go zwraca', () => {
  const [position] = mapOpenPositions({
    open_lots: [
      { origin_trade_id: 'missing-buy', account: 'account-c', symbol: 'XYZ', quantity_open: 1, quantity_remaining: 1, cost_remaining_pln: 10, currency: 'USD' },
    ],
  } as Parameters<typeof mapOpenPositions>[0], []);

  assert.deepEqual(position.accountIds, ['account-c']);
});

function makeFee(overrides?: Partial<Transaction>): Transaction {
  return {
    id: `tx-${nextId++}`,
    date: '2024-01-31',
    type: 'FEE',
    ticker: '',
    name: 'Opłata za prowadzenie rachunku',
    category: 'STOCK_FOREIGN',
    quantity: 0,
    pricePerUnit: 10,
    currency: 'PLN',
    commission: 10,
    commissionCurrency: 'PLN',
    accountId: 'acc-1',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Testy konwersji wejścia
// ---------------------------------------------------------------------------

test('pusta lista transakcji → puste trades i cash_flows', () => {
  const wynik = transactionsToEngineInput([], []);
  assert.deepEqual(wynik.trades, []);
  assert.deepEqual(wynik.cash_flows, []);
});

test('kupno trafia do trades z nazwami pól, które czyta silnik', () => {
  const konto = makeAccount({ brokerType: 'IBKR' });
  const tx = makeBuy({ accountId: konto.id });
  const { trades } = transactionsToEngineInput([tx], [konto]);

  assert.equal(trades.length, 1);
  const wiersz = trades[0];
  assert.equal(wiersz.Symbol, 'AAPL.US');
  assert.equal(wiersz.Side, 'BUY');
  assert.equal(wiersz.Quantity, 10);
  assert.equal(wiersz.Cena, 170);
  // Bez kwoty brutto silnik liczy przychod i koszt jako 0,00 zl.
  assert.equal(wiersz.Kwota, 1700);
  assert.equal(wiersz.Currency, 'USD');
  assert.equal(wiersz.Commission, 5);
  assert.equal(wiersz['Commission Currency'], 'USD');
  assert.ok(wiersz.account, 'rachunek musi byc podany, bo po nim FIFO rozdziela brokerow');
});

test('mostek wysyla jawna klase kazdego instrumentu', () => {
  const konto = makeAccount();
  for (const [category, expected] of [
    ['STOCK_FOREIGN', 'STOCK'], ['STOCK_PL', 'STOCK'], ['ETF', 'ETF'],
    ['BOND', 'BOND'], ['CRYPTO', 'CRYPTO'],
  ] as const) {
    const { trades } = transactionsToEngineInput(
      [makeBuy({ accountId: konto.id, ticker: 'FET', category })], [konto],
    );
    assert.equal(trades[0].instr_type_c, expected);
  }
});

test('sprzedaż trafia do trades ze stroną SELL', () => {
  const konto = makeAccount();
  const tx = makeBuy({ type: 'SELL', accountId: konto.id });
  const { trades } = transactionsToEngineInput([tx], [konto]);
  assert.equal(trades[0].Side, 'SELL');
});

test('dywidenda daje dwa zdarzenia rozpoznawane przez klasyfikator', () => {
  const konto = makeAccount();
  const tx = makeBuy({
    type: 'DIVIDEND',
    accountId: konto.id,
    quantity: 1,
    pricePerUnit: 25,
    foreignTaxAmount: 3.75,
    foreignTaxRate: 15,
  });
  const { cash_flows: zdarzenia } = transactionsToEngineInput([tx], [konto]);

  assert.equal(zdarzenia.length, 2);
  const dywidenda = zdarzenia[0];
  const podatek = zdarzenia[1];

  // classify.py: "dywid" w rodzaju ALBO "dividend" w komentarzu.
  assert.ok(/dywid/i.test(dywidenda.type), 'rodzaj musi zawierac czlon "dywid"');
  assert.ok(/dividend/i.test(dywidenda.comment), 'komentarz musi zawierac slowo "dividend"');
  // Kraj do PIT/ZG silnik wyciaga z symbolu w komentarzu.
  assert.ok(dywidenda.comment.includes('AAPL.US'), 'komentarz musi zawierac ticker');
  assert.equal(dywidenda.amount, 25);

  // classify.py: "podatk" w rodzaju ALBO "withholding" w komentarzu.
  assert.ok(/podatk/i.test(podatek.type), 'rodzaj podatku musi zawierac czlon "podatk"');
  assert.ok(/withholding/i.test(podatek.comment), 'komentarz podatku musi zawierac "withholding"');
  assert.equal(podatek.amount, -3.75, 'podatek u zrodla jest kwota ujemna');
});

test('dywidenda bez kwoty podatku wylicza go ze stawki', () => {
  const konto = makeAccount();
  const tx = makeBuy({
    type: 'DIVIDEND',
    accountId: konto.id,
    quantity: 1,
    pricePerUnit: 100,
    foreignTaxRate: 15,
    foreignTaxAmount: undefined,
  });
  const { cash_flows: zdarzenia } = transactionsToEngineInput([tx], [konto]);
  assert.equal(zdarzenia.length, 2);
  assert.equal(zdarzenia[1].amount, -15);
});

test('zadne zdarzenie nie uzywa pola "kind" - silnik go nie czyta', () => {
  const konto = makeAccount();
  const tx = makeBuy({ type: 'DIVIDEND', accountId: konto.id, quantity: 1, pricePerUnit: 10, foreignTaxAmount: 1 });
  const { cash_flows: zdarzenia } = transactionsToEngineInput([tx], [konto]);
  for (const zdarzenie of zdarzenia) {
    assert.ok(!('kind' in zdarzenie), 'pole "kind" jest ignorowane przez normalize/events.py');
    assert.ok('type' in zdarzenie, 'rodzaj zdarzenia musi byc w polu "type"');
  }
});

test('ten sam ticker na dwoch rachunkach dostaje rozne wartosci account', () => {
  const pierwsze = makeAccount({ brokerType: 'IBKR', name: 'IBKR' });
  const drugie = makeAccount({ brokerType: 'XTB', name: 'XTB' });
  const { trades } = transactionsToEngineInput(
    [makeBuy({ accountId: pierwsze.id }), makeBuy({ accountId: drugie.id })],
    [pierwsze, drugie],
  );
  assert.equal(trades.length, 2);
  assert.notEqual(trades[0].account, trades[1].account, 'FIFO nie moze mieszac partii miedzy brokerami');
});

test('data zachowuje godzine - silnik sam ja normalizuje', () => {
  const konto = makeAccount();
  const tx = makeBuy({ accountId: konto.id, date: '2024-03-15T14:30:00' });
  const { trades } = transactionsToEngineInput([tx], [konto]);
  assert.equal(trades[0].date, '2024-03-15T14:30:00');
});

test('wynik ma sekcje trades i cash_flows (format broker_report_json)', () => {
  const wynik = transactionsToEngineInput([], []);
  assert.ok('trades' in wynik);
  assert.ok('cash_flows' in wynik);
});

test('nazwa pliku w magazynie konczy sie na .json', () => {
  assert.ok(_STORAGE_FILENAME.endsWith('.json'));
});
