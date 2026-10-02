import test from 'node:test';
import assert from 'node:assert/strict';

import {
  binanceOrderKey,
  getPendingBinanceOrder,
  PENDING_BINANCE_ORDERS_STORAGE_KEY,
  reserveBinanceOrder,
  type BinanceOrderStorage,
} from '../../../aplikacje/web/src/portfel/services/binanceOrderRetry.ts';

class MemoryStorage implements BinanceOrderStorage {
  constructor(private readonly backing: Map<string, string>) {}

  getItem(key: string): string | null {
    return this.backing.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.backing.set(key, value);
  }
}

const parameters = { quantity: 2, stopPrice: 106.49, limitPrice: 105.43, currency: 'USDT', expiresAt: '2026-09-28T10:00:00Z' };

test('rejestr niepewnego Binance przetrwa odświeżenie jako nowa instancja z tym samym storage', () => {
  const backing = new Map<string, string>();
  const firstTabStorage = new MemoryStorage(backing);
  const first = reserveBinanceOrder('konto', 'btcusdt', parameters, firstTabStorage);

  const refreshedTabStorage = new MemoryStorage(backing);
  const restored = getPendingBinanceOrder('konto', 'BTCUSDT', refreshedTabStorage);

  assert.equal(restored?.clientOrderId, first.clientOrderId);
  assert.deepEqual(restored?.parameters, parameters);
  assert.equal(restored?.createdAt, first.createdAt);
});
test('druga karta odczytuje wspólny wpis localStorage', () => {
  const backing = new Map<string, string>();
  const firstTab = new MemoryStorage(backing);
  const secondTab = new MemoryStorage(backing);
  const first = reserveBinanceOrder('konto', 'BTCUSDT', parameters, firstTab);

  assert.equal(getPendingBinanceOrder('konto', 'BTCUSDT', secondTab)?.clientOrderId, first.clientOrderId);
});

test('zmiana ilości ani ceny nie omija blokady dla tego samego rachunku i waloru', () => {
  const storage = new MemoryStorage(new Map<string, string>());
  const first = reserveBinanceOrder('konto', 'BTCUSDT', parameters, storage);
  const changedParameters = { ...parameters, quantity: 5, stopPrice: 99 };
  const second = reserveBinanceOrder('konto', 'btcusdt', changedParameters, storage);

  assert.equal(binanceOrderKey('konto', 'btcusdt'), binanceOrderKey('konto', 'BTCUSDT'));
  assert.equal(second.clientOrderId, first.clientOrderId);
  assert.deepEqual(second.parameters, parameters);
});

test('rejestr obejmuje parametry zlecenia i nie zapisuje kluczy API', () => {
  const storage = new MemoryStorage(new Map<string, string>());
  reserveBinanceOrder('konto', 'BTCUSDT', parameters, storage);
  const saved = storage.getItem(PENDING_BINANCE_ORDERS_STORAGE_KEY) || '';

  assert.match(saved, /"quantity":2/);
  assert.match(saved, /"stopPrice":106.49/);
  assert.doesNotMatch(saved, /apiKey|apiSecret|test-key|test-secret/i);
});
