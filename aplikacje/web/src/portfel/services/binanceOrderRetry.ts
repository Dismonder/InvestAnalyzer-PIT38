export interface BinanceOrderParameters {
  quantity: number;
  stopPrice: number;
  limitPrice?: number;
  currency: string;
  expiresAt?: string;
}

export interface PendingBinanceOrder {
  accountId: string;
  ticker: string;
  clientOrderId: string;
  parameters: BinanceOrderParameters;
  createdAt: string;
}

export interface BinanceOrderStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = 'pit38_pending_binance_orders_v1';

export function binanceOrderKey(accountId: string, ticker: string): string {
  return JSON.stringify([accountId, ticker.trim().toUpperCase()]);
}

function storageOrDefault(storage?: BinanceOrderStorage): BinanceOrderStorage {
  if (storage) return storage;
  if (typeof globalThis.localStorage === 'undefined') throw new Error('Trwały rejestr zleceń Binance jest niedostępny.');
  return globalThis.localStorage;
}

function readAll(storage?: BinanceOrderStorage): Record<string, PendingBinanceOrder> {
  const raw = storageOrDefault(storage).getItem(STORAGE_KEY);
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed as Record<string, PendingBinanceOrder>;
}

export function getPendingBinanceOrder(
  accountId: string,
  ticker: string,
  storage?: BinanceOrderStorage,
): PendingBinanceOrder | undefined {
  return readAll(storage)[binanceOrderKey(accountId, ticker)];
}

export function getPendingBinanceOrders(storage?: BinanceOrderStorage): PendingBinanceOrder[] {
  return Object.values(readAll(storage));
}

export function reserveBinanceOrder(
  accountId: string,
  ticker: string,
  parameters: BinanceOrderParameters,
  storage?: BinanceOrderStorage,
): PendingBinanceOrder {
  const target = storageOrDefault(storage);
  const orders = readAll(target);
  const key = binanceOrderKey(accountId, ticker);
  const existing = orders[key];
  if (existing) return existing;

  const order: PendingBinanceOrder = {
    accountId,
    ticker: ticker.trim().toUpperCase(),
    clientOrderId: globalThis.crypto.randomUUID().replaceAll('-', ''),
    parameters: { ...parameters },
    createdAt: new Date().toISOString(),
  };
  orders[key] = order;
  target.setItem(STORAGE_KEY, JSON.stringify(orders));
  return order;
}

export function removePendingBinanceOrder(
  accountId: string,
  ticker: string,
  storage?: BinanceOrderStorage,
): void {
  const target = storageOrDefault(storage);
  const orders = readAll(target);
  delete orders[binanceOrderKey(accountId, ticker)];
  target.setItem(STORAGE_KEY, JSON.stringify(orders));
}

export const PENDING_BINANCE_ORDERS_STORAGE_KEY = STORAGE_KEY;
