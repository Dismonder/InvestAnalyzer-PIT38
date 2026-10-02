import test from "node:test";
import assert from "node:assert/strict";

import {
  applyOverrideOperation,
  createEmptyOverrideSession,
  createOverrideOperation,
  createOverrideSnapshot,
  describeOverrideOperation,
  redoOverrideOperation,
  restoreOverrideSnapshot,
  shouldCreateTimedSnapshot,
  undoOverrideOperation,
  type PinnedTransactionLink,
  type HistoriaOperacjiOverride,
} from "../../../aplikacje/web/src/invest_analyzer/services/overrideHistory.ts";
import type { NadpisanieTransakcji } from "../../../aplikacje/web/src/invest_analyzer/services/transactionOverrides.ts";

function buildOverride(overrides: Partial<NadpisanieTransakcji> = {}): NadpisanieTransakcji {
  return {
    overrideId: "override-manual-1",
    mode: "override",
    recordType: "TRADE",
    baseRecordId: "trade-1",
    manualRecordId: "manual-1",
    deleted: false,
    values: {
      symbol: "NBIS.US",
      quantity: "10",
      commission: "1.20",
    },
    createdAt: "2026-04-23T09:00:00.000Z",
    updatedAt: "2026-04-23T09:00:00.000Z",
    sourceLabel: "Ręczna korekta użytkownika",
    ...overrides,
  };
}

function buildOperation(params: Partial<HistoriaOperacjiOverride> = {}): HistoriaOperacjiOverride {
  return createOverrideOperation({
    kind: "save",
    recordKey: "manual-1",
    description: "Zapisano zmianę ręczną",
    beforeOverrides: [],
    afterOverrides: [buildOverride()],
    createdAt: "2026-04-23T09:05:00.000Z",
    ...params,
  });
}

function buildPinLink(overrides: Partial<PinnedTransactionLink> = {}): PinnedTransactionLink {
  return {
    pinId: "pin-1",
    childRowId: "child-1",
    parentRowId: "parent-1",
    createdAt: "2026-04-23T09:00:00.000Z",
    updatedAt: "2026-04-23T09:00:00.000Z",
    source: "drag_drop",
    ...overrides,
  };
}

test("applyOverrideOperation zapisuje nowy stan, czyści redo i odkłada operację na stos cofania", () => {
  const state = createEmptyOverrideSession();
  const op = buildOperation();

  const next = applyOverrideOperation(state, op);

  assert.equal(next.transactionOverrides.length, 1);
  assert.equal(next.undoStack.length, 1);
  assert.equal(next.redoStack.length, 0);
  assert.equal(next.operationHistory.at(-1)?.description, "Zapisano zmianę ręczną");
});

test("undoOverrideOperation przywraca poprzedni stan i pozwala na ponowienie", () => {
  const saved = applyOverrideOperation(createEmptyOverrideSession(), buildOperation());

  const undone = undoOverrideOperation(saved, "2026-04-23T09:06:00.000Z");

  assert.equal(undone.session.transactionOverrides.length, 0);
  assert.equal(undone.session.undoStack.length, 0);
  assert.equal(undone.session.redoStack.length, 1);
  assert.equal(undone.historyEntry?.kind, "undo");

  const redone = redoOverrideOperation(undone.session, "2026-04-23T09:07:00.000Z");

  assert.equal(redone.session.transactionOverrides.length, 1);
  assert.equal(redone.session.undoStack.length, 1);
  assert.equal(redone.session.redoStack.length, 0);
  assert.equal(redone.historyEntry?.kind, "redo");
});

test("restoreOverrideSnapshot przywraca zapisany snapshot i zostawia ślad do cofnięcia", () => {
  const first = applyOverrideOperation(createEmptyOverrideSession(), buildOperation());
  const snapshot = createOverrideSnapshot(first, "save", "2026-04-23T09:05:30.000Z");
  const second = applyOverrideOperation(
    first,
    buildOperation({
      afterOverrides: [
        buildOverride({
          values: {
            symbol: "NBIS.US",
            quantity: "12",
            commission: "2.50",
          },
          updatedAt: "2026-04-23T09:10:00.000Z",
        }),
      ],
      createdAt: "2026-04-23T09:10:00.000Z",
    }),
  );

  const restored = restoreOverrideSnapshot(second, snapshot, "2026-04-23T09:11:00.000Z");

  assert.equal(restored.session.transactionOverrides[0]?.values.quantity, "10");
  assert.equal(restored.session.undoStack.at(-1)?.kind, "restore_snapshot");
  assert.equal(restored.historyEntry?.description, "Przywrócono kopię zapasową");
});

test("cofnięcie przywrócenia migawki zachowuje bieżącą historię korekt", () => {
  const first = applyOverrideOperation(createEmptyOverrideSession(), buildOperation());
  const snapshot = createOverrideSnapshot(first, "save", "2026-04-23T09:05:30.000Z");
  const second = applyOverrideOperation(
    first,
    buildOperation({
      beforeOverrides: first.transactionOverrides,
      afterOverrides: [buildOverride({ values: { symbol: "NBIS.US", quantity: "12", commission: "2.50" } })],
      createdAt: "2026-04-23T09:10:00.000Z",
    }),
  );

  const restored = restoreOverrideSnapshot(second, snapshot, "2026-04-23T09:11:00.000Z").session;
  const undoRestore = undoOverrideOperation(restored, "2026-04-23T09:12:00.000Z").session;
  assert.equal(undoRestore.transactionOverrides[0]?.values.quantity, "12");

  const undoSecond = undoOverrideOperation(undoRestore, "2026-04-23T09:13:00.000Z").session;
  assert.equal(undoSecond.transactionOverrides[0]?.values.quantity, "10");
});

test("operacje przypięcia są zapisywane i przywracane razem z warstwą override", () => {
  const initial = createEmptyOverrideSession();
  const pinned = buildPinLink();
  const op = createOverrideOperation({
    kind: "pin",
    recordKey: pinned.childRowId,
    description: "Przypięto transakcję",
    beforeOverrides: [],
    afterOverrides: [],
    beforePinnedTransactionLinks: [],
    afterPinnedTransactionLinks: [pinned],
  });

  const applied = applyOverrideOperation(initial, op);
  assert.equal(applied.pinnedTransactionLinks.length, 1);
  assert.equal(applied.pinnedTransactionLinks[0]?.childRowId, "child-1");

  const undone = undoOverrideOperation(applied, "2026-04-23T09:01:00.000Z");
  assert.equal(undone.session.pinnedTransactionLinks.length, 0);

  const redone = redoOverrideOperation(undone.session, "2026-04-23T09:02:00.000Z");
  assert.equal(redone.session.pinnedTransactionLinks.length, 1);
  assert.equal(redone.session.pinnedTransactionLinks[0]?.parentRowId, "parent-1");

  const snapshot = createOverrideSnapshot(redone.session, "pin", "2026-04-23T09:03:00.000Z");
  assert.equal(snapshot.pinnedTransactionLinks.length, 1);

  const restored = restoreOverrideSnapshot(redone.session, snapshot, "2026-04-23T09:04:00.000Z");
  assert.equal(restored.session.pinnedTransactionLinks.length, 1);
});

test("shouldCreateTimedSnapshot tworzy automatyczny backup tylko po zmianach i po upływie interwału", () => {
  const base = createEmptyOverrideSession();
  assert.equal(shouldCreateTimedSnapshot(base, "2026-04-23T09:05:00.000Z"), false);

  const changed = applyOverrideOperation(base, buildOperation());
  assert.equal(shouldCreateTimedSnapshot(changed, "2026-04-23T09:08:00.000Z"), false);
  assert.equal(shouldCreateTimedSnapshot(changed, "2026-04-23T09:11:00.000Z"), true);
});

test("describeOverrideOperation zwraca polskie etykiety operacji dla panelu historii", () => {
  assert.equal(describeOverrideOperation("save"), "Zapisano zmianę ręczną");
  assert.equal(describeOverrideOperation("delete"), "Oznaczono transakcję jako usuniętą");
  assert.equal(describeOverrideOperation("restore_snapshot"), "Przywrócono kopię zapasową");
  assert.equal(describeOverrideOperation("pin"), "Przypięto transakcję");
  assert.equal(describeOverrideOperation("unpin"), "Odpięto przypięcie transakcji");
});

