import type { NadpisanieTransakcji, TypRekorduEdycji } from "./transactionOverrides";

export type RodzajOperacjiOverride =
  | "save"
  | "delete"
  | "reset"
  | "restore"
  | "new"
  | "pin"
  | "unpin"
  | "move_pin"
  | "restore_snapshot"
  | "undo"
  | "redo";

export type PowodSnapshotuOverride = "save" | "delete" | "reset" | "restore" | "pin" | "unpin" | "autosave_timer";

export interface PinnedTransactionLink {
  pinId: string;
  childRowId: string;
  parentRowId: string;
  createdAt: string;
  updatedAt: string;
  source?: "drag_drop" | "manual";
  note?: string | null;
}

export interface HistoriaOperacjiOverride {
  operationId: string;
  createdAt: string;
  kind: RodzajOperacjiOverride;
  recordKey: string | null;
  description: string;
  beforeOverrides: NadpisanieTransakcji[];
  afterOverrides: NadpisanieTransakcji[];
  beforePinnedTransactionLinks?: PinnedTransactionLink[];
  afterPinnedTransactionLinks?: PinnedTransactionLink[];
  targetOperationId?: string | null;
}

export interface SnapshotOverride {
  snapshotId: string;
  createdAt: string;
  reason: PowodSnapshotuOverride;
  transactionOverrides: NadpisanieTransakcji[];
  pinnedTransactionLinks: PinnedTransactionLink[];
  undoStack: HistoriaOperacjiOverride[];
  redoStack: HistoriaOperacjiOverride[];
}

export interface SzkicEdytoraTransakcji {
  recordKey: string | null;
  mode: "edit" | "new";
  recordType: TypRekorduEdycji;
  values: Record<string, string | null>;
  updatedAt: string;
  /** Użytkownik wpisał własną kwotę brutto - po wczytaniu szkicu nie przeliczać jej z ilości i ceny. */
  bruttoReczne?: boolean;
}

export interface StanSesjiOverride {
  transactionOverrides: NadpisanieTransakcji[];
  pinnedTransactionLinks: PinnedTransactionLink[];
  undoStack: HistoriaOperacjiOverride[];
  redoStack: HistoriaOperacjiOverride[];
  operationHistory: HistoriaOperacjiOverride[];
  snapshots: SnapshotOverride[];
  editorDraft: SzkicEdytoraTransakcji | null;
  lastMutationAt: string | null;
}

const DOMYSLNY_LIMIT_UNDO = 100;
const DOMYSLNY_LIMIT_SNAPSHOTOW = 30;
const DOMYSLNY_LIMIT_HISTORII = 100;

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function capFromEnd<T>(values: T[], limit: number): T[] {
  if (values.length <= limit) {
    return values;
  }
  return values.slice(values.length - limit);
}

function capFromStart<T>(values: T[], limit: number): T[] {
  if (values.length <= limit) {
    return values;
  }
  return values.slice(0, limit);
}

function createId(prefix: string, createdAt: string): string {
  const normalized = createdAt.replace(/[^0-9]/g, "").slice(0, 14) || Date.now().toString();
  return `${prefix}-${normalized}-${Math.random().toString(36).slice(2, 8)}`;
}

export function describeOverrideOperation(kind: RodzajOperacjiOverride): string {
  switch (kind) {
    case "save":
      return "Zapisano zmianę ręczną";
    case "delete":
      return "Oznaczono transakcję jako usuniętą";
    case "reset":
      return "Zresetowano ręczne zmiany";
    case "restore":
      return "Przywrócono ukrytą transakcję";
    case "new":
      return "Dodano nową transakcję użytkownika";
    case "pin":
      return "Przypięto transakcję";
    case "unpin":
      return "Odpięto przypięcie transakcji";
    case "move_pin":
      return "Przeniesiono przypięcie transakcji";
    case "restore_snapshot":
      return "Przywrócono kopię zapasową";
    case "undo":
      return "Cofnięto operację";
    case "redo":
      return "Ponowiono operację";
    default:
      return "Zmieniono warstwę override";
  }
}

export function createEmptyOverrideSession(
  transactionOverrides: NadpisanieTransakcji[] = [],
  pinnedTransactionLinks: PinnedTransactionLink[] = [],
): StanSesjiOverride {
  return {
    transactionOverrides: deepClone(transactionOverrides),
    pinnedTransactionLinks: deepClone(pinnedTransactionLinks),
    undoStack: [],
    redoStack: [],
    operationHistory: [],
    snapshots: [],
    editorDraft: null,
    lastMutationAt: null,
  };
}

export function createOverrideOperation(params: {
  kind: RodzajOperacjiOverride;
  recordKey: string | null;
  description?: string;
  beforeOverrides: NadpisanieTransakcji[];
  afterOverrides: NadpisanieTransakcji[];
  beforePinnedTransactionLinks?: PinnedTransactionLink[];
  afterPinnedTransactionLinks?: PinnedTransactionLink[];
  createdAt?: string;
  targetOperationId?: string | null;
}): HistoriaOperacjiOverride {
  const createdAt = params.createdAt || new Date().toISOString();
  return {
    operationId: createId("override-op", createdAt),
    createdAt,
    kind: params.kind,
    recordKey: params.recordKey,
    description: params.description || describeOverrideOperation(params.kind),
    beforeOverrides: deepClone(params.beforeOverrides),
    afterOverrides: deepClone(params.afterOverrides),
    beforePinnedTransactionLinks:
      params.beforePinnedTransactionLinks !== undefined ? deepClone(params.beforePinnedTransactionLinks) : undefined,
    afterPinnedTransactionLinks:
      params.afterPinnedTransactionLinks !== undefined ? deepClone(params.afterPinnedTransactionLinks) : undefined,
    targetOperationId: params.targetOperationId || null,
  };
}

export function applyOverrideOperation(
  state: StanSesjiOverride,
  operation: HistoriaOperacjiOverride,
  limits = {
    undoLimit: DOMYSLNY_LIMIT_UNDO,
    historyLimit: DOMYSLNY_LIMIT_HISTORII,
  },
): StanSesjiOverride {
  const nextPinnedTransactionLinks =
    operation.afterPinnedTransactionLinks !== undefined ? deepClone(operation.afterPinnedTransactionLinks) : state.pinnedTransactionLinks;
  return {
    ...state,
    transactionOverrides: deepClone(operation.afterOverrides),
    pinnedTransactionLinks: deepClone(nextPinnedTransactionLinks),
    undoStack: capFromEnd([...state.undoStack, deepClone(operation)], limits.undoLimit),
    redoStack: [],
    operationHistory: capFromEnd([...state.operationHistory, deepClone(operation)], limits.historyLimit),
    lastMutationAt: operation.createdAt,
  };
}

export function undoOverrideOperation(
  state: StanSesjiOverride,
  createdAt = new Date().toISOString(),
  limits = {
    redoLimit: DOMYSLNY_LIMIT_UNDO,
    historyLimit: DOMYSLNY_LIMIT_HISTORII,
  },
): { session: StanSesjiOverride; historyEntry: HistoriaOperacjiOverride | null } {
  const target = state.undoStack.at(-1);
  if (!target) {
    return { session: state, historyEntry: null };
  }

  const historyEntry = createOverrideOperation({
    kind: "undo",
    recordKey: target.recordKey,
    description: describeOverrideOperation("undo"),
    beforeOverrides: state.transactionOverrides,
    afterOverrides: target.beforeOverrides,
    beforePinnedTransactionLinks: state.pinnedTransactionLinks,
    afterPinnedTransactionLinks:
      target.beforePinnedTransactionLinks !== undefined ? target.beforePinnedTransactionLinks : state.pinnedTransactionLinks,
    createdAt,
    targetOperationId: target.operationId,
  });

  return {
    historyEntry,
    session: {
      ...state,
      transactionOverrides: deepClone(target.beforeOverrides),
      pinnedTransactionLinks:
        target.beforePinnedTransactionLinks !== undefined
          ? deepClone(target.beforePinnedTransactionLinks)
          : state.pinnedTransactionLinks,
      undoStack: state.undoStack.slice(0, -1),
      redoStack: capFromEnd([...state.redoStack, deepClone(target)], limits.redoLimit),
      operationHistory: capFromEnd([...state.operationHistory, historyEntry], limits.historyLimit),
      lastMutationAt: createdAt,
    },
  };
}

export function redoOverrideOperation(
  state: StanSesjiOverride,
  createdAt = new Date().toISOString(),
  limits = {
    undoLimit: DOMYSLNY_LIMIT_UNDO,
    historyLimit: DOMYSLNY_LIMIT_HISTORII,
  },
): { session: StanSesjiOverride; historyEntry: HistoriaOperacjiOverride | null } {
  const target = state.redoStack.at(-1);
  if (!target) {
    return { session: state, historyEntry: null };
  }

  const historyEntry = createOverrideOperation({
    kind: "redo",
    recordKey: target.recordKey,
    description: describeOverrideOperation("redo"),
    beforeOverrides: state.transactionOverrides,
    afterOverrides: target.afterOverrides,
    beforePinnedTransactionLinks: state.pinnedTransactionLinks,
    afterPinnedTransactionLinks:
      target.afterPinnedTransactionLinks !== undefined ? target.afterPinnedTransactionLinks : state.pinnedTransactionLinks,
    createdAt,
    targetOperationId: target.operationId,
  });

  return {
    historyEntry,
    session: {
      ...state,
      transactionOverrides: deepClone(target.afterOverrides),
      pinnedTransactionLinks:
        target.afterPinnedTransactionLinks !== undefined
          ? deepClone(target.afterPinnedTransactionLinks)
          : state.pinnedTransactionLinks,
      undoStack: capFromEnd([...state.undoStack, deepClone(target)], limits.undoLimit),
      redoStack: state.redoStack.slice(0, -1),
      operationHistory: capFromEnd([...state.operationHistory, historyEntry], limits.historyLimit),
      lastMutationAt: createdAt,
    },
  };
}

export function createOverrideSnapshot(
  state: StanSesjiOverride,
  reason: PowodSnapshotuOverride,
  createdAt = new Date().toISOString(),
): SnapshotOverride {
  return {
    snapshotId: createId("override-snapshot", createdAt),
    createdAt,
    reason,
    transactionOverrides: deepClone(state.transactionOverrides),
    pinnedTransactionLinks: deepClone(state.pinnedTransactionLinks),
    undoStack: deepClone(state.undoStack),
    redoStack: deepClone(state.redoStack),
  };
}

export function appendOverrideSnapshot(
  state: StanSesjiOverride,
  snapshot: SnapshotOverride,
  snapshotLimit = DOMYSLNY_LIMIT_SNAPSHOTOW,
): StanSesjiOverride {
  return {
    ...state,
    snapshots: capFromStart([deepClone(snapshot), ...state.snapshots], snapshotLimit),
  };
}

export function restoreOverrideSnapshot(
  state: StanSesjiOverride,
  snapshot: SnapshotOverride,
  createdAt = new Date().toISOString(),
  limits = {
    undoLimit: DOMYSLNY_LIMIT_UNDO,
    historyLimit: DOMYSLNY_LIMIT_HISTORII,
  },
): { session: StanSesjiOverride; historyEntry: HistoriaOperacjiOverride } {
  const historyEntry = createOverrideOperation({
    kind: "restore_snapshot",
    recordKey: null,
    description: describeOverrideOperation("restore_snapshot"),
    beforeOverrides: state.transactionOverrides,
    afterOverrides: snapshot.transactionOverrides,
    beforePinnedTransactionLinks: state.pinnedTransactionLinks,
    afterPinnedTransactionLinks: snapshot.pinnedTransactionLinks,
    createdAt,
    targetOperationId: snapshot.snapshotId,
  });

  return {
    historyEntry,
    session: {
      ...state,
      transactionOverrides: deepClone(snapshot.transactionOverrides),
      pinnedTransactionLinks: deepClone(snapshot.pinnedTransactionLinks),
      undoStack: capFromEnd([...state.undoStack, historyEntry], limits.undoLimit),
      redoStack: [],
      operationHistory: capFromEnd([...state.operationHistory, historyEntry], limits.historyLimit),
      lastMutationAt: createdAt,
    },
  };
}

export function shouldCreateTimedSnapshot(
  state: StanSesjiOverride,
  nowIso = new Date().toISOString(),
  intervalMs = 5 * 60 * 1000,
): boolean {
  if (!state.lastMutationAt) {
    return false;
  }

  const lastMutationTs = Date.parse(state.lastMutationAt);
  const nowTs = Date.parse(nowIso);
  if (!Number.isFinite(lastMutationTs) || !Number.isFinite(nowTs) || nowTs - lastMutationTs < intervalMs) {
    return false;
  }

  const latestSnapshot = state.snapshots[0];
  if (!latestSnapshot) {
    return state.transactionOverrides.length > 0 || state.pinnedTransactionLinks.length > 0;
  }

  return (
    JSON.stringify(latestSnapshot.transactionOverrides) !== JSON.stringify(state.transactionOverrides) ||
    JSON.stringify(latestSnapshot.pinnedTransactionLinks || []) !== JSON.stringify(state.pinnedTransactionLinks)
  );
}
