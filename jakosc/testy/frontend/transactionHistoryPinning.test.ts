import test from 'node:test';
import assert from 'node:assert/strict';

import type { EngineHistoryRow } from '../../../aplikacje/web/src/invest_analyzer/hooks/useTaxEngineRun.ts';
import {
  buildTransactionHistoryTree,
  canPinTransaction,
  flattenTransactionHistoryTree,
  removePinnedTransactionLink,
  upsertPinnedTransactionLink,
} from '../../../aplikacje/web/src/invest_analyzer/services/transactionHistoryPinning.ts';

function row(
  row_id: string,
  row_kind: string,
  parent_row_id: string | null = null,
  overrides: Partial<EngineHistoryRow> = {},
): EngineHistoryRow {
  return {
    row_id,
    parent_row_id,
    row_kind,
    display_date: '2026-04-23T10:00:00.000Z',
    read_only: false,
    ...overrides,
  } as EngineHistoryRow;
}

test('przypięty wiersz staje się dzieckiem rodzica i znika z listy głównej', () => {
  const rows = [
    row('root-a', 'TRADE'),
    row('root-b', 'TRADE'),
    row('child-a', 'ALLOCATED_COST', 'root-a', { read_only: true }),
    row('nested-b', 'ALLOCATED_COST', 'root-b', { read_only: true }),
  ];
  const pinned = upsertPinnedTransactionLink([], {
    childRowId: 'root-b',
    parentRowId: 'root-a',
    source: 'manual',
    nowIso: '2026-04-23T10:05:00.000Z',
  });

  const tree = buildTransactionHistoryTree(rows, pinned);
  assert.equal(tree.length, 1);
  assert.equal(tree[0]?.row.row_id, 'root-a');
  assert.equal(tree[0]?.children.some((node) => node.row.row_id === 'root-b'), true);
  assert.equal(tree[0]?.children.some((node) => node.row.row_id === 'child-a'), true);
  assert.equal(tree[0]?.children.find((node) => node.row.row_id === 'root-b')?.children.some((node) => node.row.row_id === 'nested-b'), true);

  const flattened = flattenTransactionHistoryTree(tree);
  assert.deepEqual(
    flattened.map((entry) => entry.row_id),
    ['root-a', 'root-b', 'nested-b', 'child-a'],
  );
});

test('nowy rodzic zastępuje poprzednie przypięcie, a pętla jest blokowana', () => {
  const rows = [
    row('root-a', 'TRADE'),
    row('root-b', 'TRADE'),
    row('root-c', 'TRADE'),
  ];

  const first = upsertPinnedTransactionLink([], {
    childRowId: 'root-b',
    parentRowId: 'root-a',
    source: 'drag_drop',
    nowIso: '2026-04-23T10:05:00.000Z',
  });
  const second = upsertPinnedTransactionLink(first, {
    childRowId: 'root-b',
    parentRowId: 'root-c',
    source: 'drag_drop',
    nowIso: '2026-04-23T10:06:00.000Z',
  });

  assert.equal(second.length, 1);
  assert.equal(second[0]?.parentRowId, 'root-c');
  assert.equal(canPinTransaction(rows, second, 'root-c', 'root-b').allowed, false);
  assert.equal(canPinTransaction(rows, second, 'root-a', 'root-a').allowed, false);
  assert.equal(canPinTransaction(rows, second, 'root-a', 'root-c').allowed, true);

  const removed = removePinnedTransactionLink(second, 'root-b');
  assert.equal(removed.length, 0);
});

