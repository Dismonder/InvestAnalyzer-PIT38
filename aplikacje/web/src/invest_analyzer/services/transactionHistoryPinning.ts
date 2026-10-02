import type { EngineHistoryRow } from '../hooks/useTaxEngineRun';
import type { PinnedTransactionLink } from './overrideHistory';

export interface TransactionHistoryTreeNode {
  row: EngineHistoryRow;
  relationKind: 'root' | 'silnik' | 'pinned';
  effectiveParentRowId: string | null;
  pinnedLink: PinnedTransactionLink | null;
  children: TransactionHistoryTreeNode[];
}

type SortKey = 'display_date' | 'amount_pln';
type SortDirection = 'asc' | 'desc';

function safeNumber(value?: string | null): number {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function safeDate(value?: string | null): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareRows(
  a: EngineHistoryRow,
  b: EngineHistoryRow,
  key: SortKey,
  direction: SortDirection,
): number {
  const multiplier = direction === 'asc' ? 1 : -1;
  if (key === 'amount_pln') {
    return (safeNumber(a.amount_pln) - safeNumber(b.amount_pln)) * multiplier;
  }
  return (safeDate(a.display_date) - safeDate(b.display_date)) * multiplier;
}

function normalizeCreatedAt(value?: string | null): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isPinEligibleRow(row: EngineHistoryRow): boolean {
  return row.parent_row_id == null && row.row_kind !== 'PRIVATE_CASH_FX' && row.row_kind !== 'ALLOCATED_COST';
}

function buildPinnedLinkMap(pinnedTransactionLinks: PinnedTransactionLink[]): Map<string, PinnedTransactionLink> {
  const next = new Map<string, PinnedTransactionLink>();
  const sorted = [...pinnedTransactionLinks].sort((a, b) => {
    const created = normalizeCreatedAt(a.updatedAt) - normalizeCreatedAt(b.updatedAt);
    if (created !== 0) {
      return created;
    }
    return a.childRowId.localeCompare(b.childRowId);
  });

  for (const link of sorted) {
    next.set(link.childRowId, link);
  }

  return next;
}

function buildEffectiveParentMap(
  rows: EngineHistoryRow[],
  pinnedTransactionLinks: PinnedTransactionLink[],
): Map<string, string | null> {
  const rowById = new Map(rows.map((row) => [row.row_id, row] as const));
  const pinnedByChild = buildPinnedLinkMap(pinnedTransactionLinks);
  const effectiveParentByRow = new Map<string, string | null>();

  for (const row of rows) {
    const pinnedLink = pinnedByChild.get(row.row_id) || null;
    const nextParent = pinnedLink?.parentRowId ?? row.parent_row_id ?? null;
    effectiveParentByRow.set(row.row_id, nextParent && rowById.has(nextParent) ? nextParent : null);
  }

  return effectiveParentByRow;
}

function wouldCreateCycle(
  childRowId: string,
  parentRowId: string,
  effectiveParentByRow: Map<string, string | null>,
): boolean {
  let cursor: string | null = parentRowId;
  const visited = new Set<string>();
  while (cursor) {
    if (cursor === childRowId) {
      return true;
    }
    if (visited.has(cursor)) {
      return true;
    }
    visited.add(cursor);
    cursor = effectiveParentByRow.get(cursor) || null;
  }
  return false;
}

export function createPinnedTransactionLink(params: {
  childRowId: string;
  parentRowId: string;
  createdAt?: string;
  updatedAt?: string;
  source?: 'drag_drop' | 'manual';
  note?: string | null;
}): PinnedTransactionLink {
  const createdAt = params.createdAt || new Date().toISOString();
  const updatedAt = params.updatedAt || createdAt;
  return {
    pinId: `pin-${params.childRowId}-${createdAt.replace(/[^0-9]/g, '').slice(0, 14) || Date.now().toString()}`,
    childRowId: params.childRowId,
    parentRowId: params.parentRowId,
    createdAt,
    updatedAt,
    source: params.source || 'drag_drop',
    note: params.note || null,
  };
}

export function upsertPinnedTransactionLink(
  pinnedTransactionLinks: PinnedTransactionLink[],
  params: {
    childRowId: string;
    parentRowId: string;
    source?: 'drag_drop' | 'manual';
    note?: string | null;
    nowIso?: string;
  },
): PinnedTransactionLink[] {
  const nowIso = params.nowIso || new Date().toISOString();
  const existing = pinnedTransactionLinks.find((link) => link.childRowId === params.childRowId);
  if (existing && existing.parentRowId === params.parentRowId) {
    return pinnedTransactionLinks;
  }

  const nextLink = createPinnedTransactionLink({
    childRowId: params.childRowId,
    parentRowId: params.parentRowId,
    createdAt: existing?.createdAt || nowIso,
    updatedAt: nowIso,
    source: params.source,
    note: params.note,
  });

  return [
    ...pinnedTransactionLinks.filter((link) => link.childRowId !== params.childRowId),
    nextLink,
  ];
}

export function removePinnedTransactionLink(
  pinnedTransactionLinks: PinnedTransactionLink[],
  childRowId: string,
): PinnedTransactionLink[] {
  return pinnedTransactionLinks.filter((link) => link.childRowId !== childRowId);
}

export function getPinnedTransactionLink(
  pinnedTransactionLinks: PinnedTransactionLink[],
  childRowId: string,
): PinnedTransactionLink | null {
  return pinnedTransactionLinks.find((link) => link.childRowId === childRowId) || null;
}

export function canPinTransaction(
  rows: EngineHistoryRow[],
  pinnedTransactionLinks: PinnedTransactionLink[],
  childRowId: string,
  parentRowId: string,
): { allowed: boolean; reason: string | null } {
  if (!childRowId || !parentRowId) {
    return { allowed: false, reason: 'Brak identyfikatora transakcji.' };
  }
  if (childRowId === parentRowId) {
    return { allowed: false, reason: 'Nie można przypiąć transakcji do samej siebie.' };
  }

  const rowById = new Map(rows.map((row) => [row.row_id, row] as const));
  const childRow = rowById.get(childRowId);
  const parentRow = rowById.get(parentRowId);
  if (!childRow || !parentRow) {
    return { allowed: false, reason: 'Nie znaleziono transakcji źródłowej lub docelowej.' };
  }
  if (!isPinEligibleRow(childRow) || !isPinEligibleRow(parentRow)) {
    return { allowed: false, reason: 'Można przypinać tylko główne wiersze historii.' };
  }

  const effectiveParentByRow = buildEffectiveParentMap(rows, pinnedTransactionLinks);
  let cursor: string | null | undefined = parentRowId;
  const visited = new Set<string>();
  while (cursor) {
    if (cursor === childRowId) {
      return { allowed: false, reason: 'Przypięcie utworzyłoby pętlę w hierarchii.' };
    }
    if (visited.has(cursor)) {
      return { allowed: false, reason: 'Hierarchia przypięć jest niespójna.' };
    }
    visited.add(cursor);
    cursor = effectiveParentByRow.get(cursor) ?? rowById.get(cursor)?.parent_row_id ?? null;
  }

  return { allowed: true, reason: null };
}

export function buildTransactionHistoryTree(
  rows: EngineHistoryRow[],
  pinnedTransactionLinks: PinnedTransactionLink[],
): TransactionHistoryTreeNode[] {
  const rowById = new Map(rows.map((row) => [row.row_id, row] as const));
  const pinnedByChild = buildPinnedLinkMap(pinnedTransactionLinks);
  const effectiveParentByRow = buildEffectiveParentMap(rows, pinnedTransactionLinks);
  const nodeByRowId = new Map<string, TransactionHistoryTreeNode>();
  const roots: TransactionHistoryTreeNode[] = [];

  for (const row of rows) {
    const pinnedLink = pinnedByChild.get(row.row_id) || null;
    const relationKind = pinnedLink ? 'pinned' : row.parent_row_id ? 'silnik' : 'root';
    nodeByRowId.set(row.row_id, {
      row,
      relationKind,
      effectiveParentRowId: effectiveParentByRow.get(row.row_id) || null,
      pinnedLink,
      children: [],
    });
  }

  for (const node of nodeByRowId.values()) {
    const parentRowId = node.effectiveParentRowId;
    if (parentRowId && rowById.has(parentRowId) && !wouldCreateCycle(node.row.row_id, parentRowId, effectiveParentByRow)) {
      nodeByRowId.get(parentRowId)?.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

export function sortTransactionHistoryTree(
  nodes: TransactionHistoryTreeNode[],
  sortConfig: { key: SortKey; direction: SortDirection },
): TransactionHistoryTreeNode[] {
  const sorted = [...nodes].sort((a, b) => compareRows(a.row, b.row, sortConfig.key, sortConfig.direction));
  return sorted.map((node) => ({
    ...node,
    children: sortTransactionHistoryTree(node.children, sortConfig),
  }));
}

export function flattenTransactionHistoryTree(nodes: TransactionHistoryTreeNode[]): EngineHistoryRow[] {
  const output: EngineHistoryRow[] = [];
  const walk = (node: TransactionHistoryTreeNode) => {
    output.push(node.row);
    node.children.forEach(walk);
  };
  nodes.forEach(walk);
  return output;
}

export function filterTransactionHistoryTree(
  nodes: TransactionHistoryTreeNode[],
  options: {
    searchTerm: string;
    typeFilter: string;
    matchesFilter: (row: EngineHistoryRow, typeFilter: string) => boolean;
  },
): TransactionHistoryTreeNode[] {
  const query = options.searchTerm.trim().toLowerCase();

  const matchesSearch = (row: EngineHistoryRow): boolean => {
    if (!query) {
      return true;
    }
    const corpus = [
      row.ticker,
      row.transaction_id,
      row.manual_record_id,
      row.base_record_id,
      row.comment,
      row.message,
      row.source_name,
      row.row_kind,
      row.logical_world,
      typeof row.details?.search_text === 'string' ? row.details.search_text : '',
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return corpus.includes(query);
  };

  const walk = (node: TransactionHistoryTreeNode): TransactionHistoryTreeNode | null => {
    const filteredChildren = node.children
      .map((child) => walk(child))
      .filter((child): child is TransactionHistoryTreeNode => Boolean(child));
    const selfMatches =
      matchesSearch(node.row) && options.matchesFilter(node.row, options.typeFilter);
    if (selfMatches || filteredChildren.length > 0) {
      return {
        ...node,
        children: filteredChildren,
      };
    }
    return null;
  };

  return nodes.map((node) => walk(node)).filter((node): node is TransactionHistoryTreeNode => Boolean(node));
}
