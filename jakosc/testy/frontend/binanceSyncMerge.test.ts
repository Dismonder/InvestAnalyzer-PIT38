import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeBinanceSyncedTransactions } from '../../../aplikacje/web/src/portfel/services/binanceSyncMerge.ts';
import type { Transaction } from '../../../aplikacje/web/src/portfel/types.ts';

function trade(accountId: string, id: string, pair: string, tradeId: number): Transaction {
  return {
    id,
    accountId,
    ticker: pair.startsWith('BTC') ? 'BTC' : 'ETH',
    name: 'Crypto',
    category: 'CRYPTO',
    type: 'BUY',
    date: '2026-01-01',
    quantity: 1,
    pricePerUnit: 100,
    currency: pair.endsWith('PLN') ? 'PLN' : 'USDT',
    commission: 0,
    notes: `Auto-Sync Binance API (Trade #${tradeId}, Para ${pair})`,
  } as Transaction;
}

test('częściowy odczyt zachowuje nieudaną parę i nie dubluje jej starego ID po odczycie pełnej pary', () => {
  const oldBtcTrade = trade('konto', 'bin_1_501', 'BTCUSDT', 1);
  const oldEthTrade = trade('konto', 'bin_2_502', 'ETHUSDT', 2);
  const otherAccount = trade('inne-konto', 'bin_1_501', 'BTCUSDT', 1);
  const newBtcTrade = trade('konto', 'bin_BTCUSDT_1_501', 'BTCUSDT', 1);

  const merged = mergeBinanceSyncedTransactions(
    [oldBtcTrade, oldEthTrade, otherAccount],
    'konto',
    [newBtcTrade],
    ['BTCUSDT'],
  );

  assert.deepEqual(merged, [newBtcTrade, oldEthTrade, otherAccount]);
  assert.equal(merged.filter((tx) => tx.accountId === 'konto' && tx.notes?.includes('Trade #1,')).length, 1);
});

test('kompletnie odczytana para zastępuje się także pustą historią', () => {
  const oldTrade = trade('konto', 'bin_1_501', 'BTCUSDT', 1);
  const merged = mergeBinanceSyncedTransactions([oldTrade], 'konto', [], ['BTCUSDT']);
  assert.deepEqual(merged, []);
});
