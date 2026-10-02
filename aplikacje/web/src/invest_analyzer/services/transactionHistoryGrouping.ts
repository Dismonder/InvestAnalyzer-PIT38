import type { EngineHistoryRow } from '../hooks/useTaxEngineRun';

export type TransactionHistoryFilterId =
  | 'all'
  | 'trade'
  | 'transfer'
  | 'fx'
  | 'fx_cost'
  | 'long_term'
  | 'cash_movement'
  | 'cost'
  | 'dividend'
  | 'tax'
  | 'bonus'
  | 'other';

export interface TransactionHistoryFilterOption {
  id: TransactionHistoryFilterId;
  label: string;
}

export interface TransactionHistoryPresentation {
  group: TransactionHistoryFilterId;
  label: string;
  badgeClassName: string;
}

export const TRANSACTION_HISTORY_FILTER_OPTIONS: TransactionHistoryFilterOption[] = [
  { id: 'all', label: 'Wszystkie' },
  { id: 'trade', label: 'Transakcje' },
  { id: 'transfer', label: 'Transfery' },
  { id: 'fx', label: 'Przewalutowania' },
  { id: 'fx_cost', label: 'Koszty przewalutowania' },
  { id: 'long_term', label: 'Długoterminowe' },
  { id: 'cash_movement', label: 'Ruchy gotówkowe' },
  { id: 'cost', label: 'Koszty' },
  { id: 'dividend', label: 'Dywidendy' },
  { id: 'tax', label: 'Podatki' },
  { id: 'bonus', label: 'Akcje bonusowe' },
  { id: 'other', label: 'Pozostałe' },
];

type TransactionHistoryRowLike = Pick<
  EngineHistoryRow,
  'row_kind' | 'side' | 'logical_world' | 'details' | 'ticker' | 'transaction_id' | 'comment' | 'message'
>;
type TransactionHistoryRowFilterCounts = Record<TransactionHistoryFilterId, number>;

const FX_COST_MARKERS = ['FX_CONVERSION', 'CONVERSION_SPREAD', 'FX_SPREAD', 'SPREAD_COST'];
const COST_MARKERS = ['FEE', 'COMMISSION', 'COST', 'INTEREST', 'CHARGE', 'REBATE', 'FUNDING', 'TRANSFER_FEE'];
const TRANSFER_MARKERS = ['TRANSFER', 'DEPOSIT', 'WITHDRAWAL', 'SEPA', 'SWIFT', 'CASHOUT', 'CARD', 'PAYMENT'];
const LONG_TERM_MARKERS = ['STRUCTURED', 'MATURITY', 'DGT', 'LONG_TERM'];
const CASH_MOVEMENT_MARKERS = [
  'BLOCK',
  'UNBLOCK',
  'RESERVE',
  'RELEASE',
  'HOLD',
  'CASH_RESERVE',
  'LOCK',
  'UNLOCK',
  'T+2',
  'T2',
  'DEBT_REPAYMENT',
  'FINANCING_REPAYMENT',
];

function normalizeRowKind(rowKind?: string | null): string {
  return (rowKind || '').trim().toUpperCase();
}

function normalizeCorpus(value?: string | null): string {
  return (value || '').trim().toUpperCase();
}

function buildRowCorpus(row: TransactionHistoryRowLike): string {
  const detailsCorpus = row.details ? JSON.stringify(row.details).toUpperCase() : '';
  return [
    normalizeRowKind(row.row_kind),
    normalizeCorpus(row.logical_world),
    normalizeCorpus(row.ticker),
    normalizeCorpus(row.transaction_id),
    normalizeCorpus(row.comment),
    normalizeCorpus(row.message),
    detailsCorpus,
  ]
    .filter(Boolean)
    .join(' ');
}

function hasAnyMarker(corpus: string, markers: string[]): boolean {
  return markers.some((marker) => corpus.includes(marker));
}

function isFxRow(rowKind: string): boolean {
  return rowKind === 'PRIVATE_CASH_FX';
}

function isFxCostRow(rowKind: string, corpus: string): boolean {
  return rowKind.includes('FX_CONVERSION') || hasAnyMarker(corpus, FX_COST_MARKERS);
}

function isCostRow(rowKind: string, corpus: string): boolean {
  return rowKind === 'ALLOCATED_COST' || rowKind === 'TAX_AGENT' || hasAnyMarker(corpus, COST_MARKERS);
}

function isDividendRow(corpus: string): boolean {
  return corpus.includes('DIVIDEND');
}

function isTransferRow(rowKind: string, corpus: string): boolean {
  return (
    rowKind === 'BANK_TRANSFER' ||
    rowKind === 'INTERNAL_TRANSFER' ||
    rowKind === 'DEPOSIT' ||
    rowKind === 'WITHDRAWAL' ||
    rowKind === 'CASHOUT' ||
    (hasAnyMarker(corpus, TRANSFER_MARKERS) && !hasAnyMarker(corpus, COST_MARKERS))
  );
}

function isCashMovementRow(rowKind: string, corpus: string): boolean {
  return rowKind === 'BLOCK' || rowKind === 'UNBLOCK' || hasAnyMarker(corpus, CASH_MOVEMENT_MARKERS);
}

function isLongTermRow(rowKind: string, corpus: string): boolean {
  return rowKind.includes('MATURITY') || hasAnyMarker(corpus, LONG_TERM_MARKERS) || /\b[A-Z]{2,}\d{3,}\.[A-Z]{3}\d{2}\b/.test(corpus);
}

function isTaxRow(rowKind: string, corpus: string, isCostLinked: boolean): boolean {
  return (rowKind.includes('TAX') || corpus.includes('WITHHOLD')) && rowKind !== 'TAX_AGENT' && !isCostLinked;
}

function getTradeLabel(row: Pick<EngineHistoryRow, 'side'>): string {
  if (row.side === 'BUY') {
    return 'Kupno';
  }
  if (row.side === 'SELL') {
    return 'Sprzedaż';
  }
  return 'Transakcja';
}

function getCostLabel(rowKind: string, corpus: string): string {
  if (rowKind === 'ALLOCATED_COST') {
    return 'Koszt alokowany';
  }
  if (rowKind === 'TAX_AGENT') {
    return 'Honorarium podatkowe';
  }
  if (corpus.includes('NEGATIVE_BALANCE_INTEREST') || corpus.includes('NEGATIVE_CASH_INTEREST') || corpus.includes('INTEREST')) {
    return 'Odsetki';
  }
  if (corpus.includes('COMMISSION')) {
    return 'Prowizja';
  }
  if (corpus.includes('REBATE')) {
    return 'Zwrot kosztu';
  }
  if (corpus.includes('FUNDING')) {
    return 'Prowizja za zasilenie';
  }
  if (corpus.includes('TRANSFER_FEE')) {
    return 'Prowizja za transfer';
  }
  if (corpus.includes('CHARGE') || corpus.includes('FEE') || corpus.includes('COST')) {
    return 'Opłata';
  }
  return 'Koszt';
}

function getDividendLabel(corpus: string): string {
  if (corpus.includes('COMPENSATION')) {
    return 'Rekompensata dywidendy';
  }
  if (corpus.includes('STOCK')) {
    return 'Dywidenda w papierach';
  }
  return 'Dywidenda';
}

function getTaxLabel(rowKind: string, corpus: string): string {
  if (corpus.includes('FOREIGN') || corpus.includes('WITHHOLD')) {
    return 'Podatek zagraniczny';
  }
  return 'Podatek';
}

function getTransferLabel(rowKind: string, corpus: string): string | null {
  if (rowKind === 'DEPOSIT' || corpus.includes('DEPOSIT') || corpus.includes('WPŁATA') || corpus.includes('WPLATA') || corpus.includes('ZASILENIE')) {
    return 'Wpłata';
  }
  if (rowKind === 'WITHDRAWAL' || rowKind === 'CASHOUT' || corpus.includes('WITHDRAWAL') || corpus.includes('CASHOUT') || corpus.includes('WYPŁATA') || corpus.includes('WYPLATA')) {
    return 'Wypłata';
  }
  if (rowKind === 'INTERNAL_TRANSFER' || corpus.includes('INTERNAL_TRANSFER')) {
    return 'Transfer wewnętrzny';
  }
  if (corpus.includes('SEPA')) {
    return 'Przelew SEPA';
  }
  if (corpus.includes('SWIFT')) {
    return 'Przelew SWIFT';
  }
  if (corpus.includes('CARD')) {
    return 'Płatność kartą';
  }
  if (corpus.includes('PAYMENT')) {
    return 'Płatność';
  }
  if (rowKind === 'BANK_TRANSFER' || corpus.includes('BANK_TRANSFER')) {
    return 'Przelew bankowy';
  }
  if (hasAnyMarker(corpus, TRANSFER_MARKERS) || rowKind.includes('TRANSFER') || corpus.includes('TRANSFER')) {
    return 'Transfer';
  }
  return null;
}

function getCashMovementLabel(rowKind: string, corpus: string): string {
  if (rowKind.includes('DEBT_REPAYMENT') || corpus.includes('DEBT_REPAYMENT') || corpus.includes('FINANCING_REPAYMENT')) {
    return 'Spłata zadłużenia';
  }
  if (rowKind.includes('UNBLOCK') || corpus.includes('UNBLOCK') || corpus.includes('ODBLOCK')) {
    return 'Odblokowanie środków';
  }
  if (rowKind.includes('BLOCK') || corpus.includes('BLOCK') || corpus.includes('BLOKADA')) {
    return 'Blokada środków';
  }
  if (corpus.includes('RESERVE') || corpus.includes('REZERW')) {
    return 'Rezerwacja środków';
  }
  if (corpus.includes('RELEASE') || corpus.includes('ZWOLNIEN')) {
    return 'Zwolnienie środków';
  }
  if (corpus.includes('T+2') || corpus.includes('T2')) {
    return 'Rozliczenie T+2';
  }
  return 'Ruch gotówkowy';
}

function getOtherLabel(rowKind: string, corpus: string): string {
  const transferLabel = getTransferLabel(rowKind, corpus);
  if (transferLabel) {
    return transferLabel;
  }
  if (rowKind.includes('SYSTEM')) {
    return 'Systemowe';
  }
  if (rowKind.includes('BLOCK')) {
    return rowKind.includes('UNBLOCK') ? 'Odblokowanie' : 'Blokada';
  }
  if (rowKind.includes('MATURITY')) {
    return 'Wykup';
  }
  return 'Pozostałe';
}

export function classifyTransactionHistoryGroup(row: TransactionHistoryRowLike): TransactionHistoryFilterId {
  const rowKind = normalizeRowKind(row.row_kind);
  const corpus = buildRowCorpus(row);
  if (rowKind === 'TRADE') {
    return 'trade';
  }
  if (rowKind === 'BONUS_CONTEST_SHARE') {
    return 'bonus';
  }
  if (rowKind === 'ALLOCATED_COST') {
    return 'cost';
  }
  if (isFxRow(rowKind)) {
    return 'fx';
  }
  if (isFxCostRow(rowKind, corpus)) {
    return 'fx_cost';
  }
  if (isLongTermRow(rowKind, corpus)) {
    return 'long_term';
  }
  if (isCashMovementRow(rowKind, corpus)) {
    return 'cash_movement';
  }
  if (isTransferRow(rowKind, corpus)) {
    return 'transfer';
  }
  if (isCostRow(rowKind, corpus)) {
    return 'cost';
  }
  if (isDividendRow(corpus)) {
    return 'dividend';
  }
  if (isTaxRow(rowKind, corpus, isCostRow(rowKind, corpus))) {
    return 'tax';
  }
  return 'other';
}

export function getTransactionHistoryPresentation(row: TransactionHistoryRowLike): TransactionHistoryPresentation {
  const rowKind = normalizeRowKind(row.row_kind);
  const corpus = buildRowCorpus(row);
  const group = classifyTransactionHistoryGroup(row);

  switch (group) {
    case 'trade':
      return {
        group,
        label: getTradeLabel(row),
        badgeClassName:
          row.side === 'BUY'
            ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300'
            : 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
      };
    case 'transfer':
      return {
        group,
        label: getOtherLabel(rowKind, corpus),
        badgeClassName: 'bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300',
      };
    case 'fx':
      return {
        group,
        label: 'Przewalutowanie',
        badgeClassName: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300',
      };
    case 'fx_cost':
      return {
        group,
        label: 'Koszt przewalutowania',
        badgeClassName: 'bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300',
      };
    case 'long_term':
      return {
        group,
        label: rowKind.includes('MATURITY') || corpus.includes('MATURITY') ? 'Wykup długoterminowy' : 'Instrument długoterminowy',
        badgeClassName: 'bg-lime-100 text-lime-800 dark:bg-lime-900/30 dark:text-lime-300',
      };
    case 'cash_movement':
      return {
        group,
        label: getCashMovementLabel(rowKind, corpus),
        badgeClassName: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
      };
    case 'cost':
      return {
        group,
        label: getCostLabel(rowKind, corpus),
        badgeClassName: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
      };
    case 'dividend':
      return {
        group,
        label: getDividendLabel(corpus),
        badgeClassName: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300',
      };
    case 'tax':
      return {
        group,
        label: getTaxLabel(rowKind, corpus),
        badgeClassName: 'bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-300',
      };
    case 'bonus':
      return {
        group,
        label: 'Akcja bonusowa',
        badgeClassName: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300',
      };
    case 'other':
    default:
      return {
        group,
        label: getOtherLabel(rowKind, corpus),
        badgeClassName: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300',
      };
  }
}

export function countTransactionHistoryGroups(
  rows: TransactionHistoryRowLike[],
): TransactionHistoryRowFilterCounts {
  const counts: TransactionHistoryRowFilterCounts = {
    all: rows.length,
    trade: 0,
    transfer: 0,
    fx: 0,
    fx_cost: 0,
    long_term: 0,
    cash_movement: 0,
    cost: 0,
    dividend: 0,
    tax: 0,
    bonus: 0,
    other: 0,
  };

  for (const row of rows) {
    const group = classifyTransactionHistoryGroup(row);
    counts[group] += 1;
  }

  return counts;
}

export function getVisibleTransactionHistoryFilterOptions(
  rows: TransactionHistoryRowLike[],
): TransactionHistoryFilterOption[] {
  const counts = countTransactionHistoryGroups(rows);
  return TRANSACTION_HISTORY_FILTER_OPTIONS.filter((option) => option.id === 'all' || counts[option.id] > 0);
}

export function matchesTransactionHistoryFilter(
  row: TransactionHistoryRowLike,
  filter: TransactionHistoryFilterId,
): boolean {
  return filter === 'all' || classifyTransactionHistoryGroup(row) === filter;
}
