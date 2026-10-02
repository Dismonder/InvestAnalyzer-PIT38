import type { Transaction } from '../types';
import type { EngineHistoryRow } from '../hooks/useTaxEngineRun';

export function isManualLocalTransaction(transaction: Transaction): boolean {
  return transaction.fileId === 'MANUAL_LOCAL' || transaction.ticker === 'MANUAL';
}

export function selectRawTransactionsForFallback(
  transactions: Transaction[],
  engineHistoryRows: EngineHistoryRow[],
): Transaction[] {
  if (engineHistoryRows.length > 0) {
    return transactions.filter(isManualLocalTransaction);
  }
  return transactions;
}
