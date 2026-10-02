import type { Transaction } from '../types';

interface BinancowaTransakcja {
  symbol: string;
  tradeId: string;
}

function binanceReference(transaction: Transaction): BinancowaTransakcja | undefined {
  const notes = transaction.notes || '';
  const fromNotes = notes.match(/Trade\s*#(\d+),\s*Para\s+([A-Z0-9]+)/i);
  const newId = transaction.id.match(/^bin_([A-Z0-9]+)_(\d+)_/i);
  const legacyId = transaction.id.match(/^bin_(\d+)_\d+$/i);
  if (!fromNotes && !newId && !legacyId) return undefined;

  const symbol = (fromNotes?.[2] || newId?.[1] || `${transaction.ticker}${transaction.currency}`).toUpperCase();
  const tradeId = fromNotes?.[1] || newId?.[2] || legacyId?.[1];
  return tradeId ? { symbol, tradeId } : undefined;
}

/** Replaces only fully-read Binance pairs, retaining transactions for incomplete pairs. */
export function mergeBinanceSyncedTransactions(
  previous: Transaction[],
  accountId: string,
  synced: Transaction[],
  completeSymbols: string[],
): Transaction[] {
  const complete = new Set(completeSymbols.map((symbol) => symbol.toUpperCase()));
  const fresh = synced.filter((transaction) => {
    if (transaction.accountId !== accountId) return true;
    const reference = binanceReference(transaction);
    return !reference || complete.has(reference.symbol);
  });
  const retained = previous.filter((transaction) => {
    if (transaction.accountId !== accountId) return true;
    const reference = binanceReference(transaction);
    return !reference || !complete.has(reference.symbol);
  });

  const seenIds = new Set<string>();
  const seenTrades = new Set<string>();
  const merged: Transaction[] = [];
  for (const transaction of [...fresh, ...retained]) {
    const reference = binanceReference(transaction);
    const tradeKey = reference && `${transaction.accountId}\u0000${reference.symbol}\u0000${reference.tradeId}`;
    if (seenIds.has(transaction.id) || (tradeKey && seenTrades.has(tradeKey))) continue;
    seenIds.add(transaction.id);
    if (tradeKey) seenTrades.add(tradeKey);
    merged.push(transaction);
  }
  return merged;
}
