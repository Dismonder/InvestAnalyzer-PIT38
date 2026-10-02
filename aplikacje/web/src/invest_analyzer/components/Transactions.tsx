import React, { startTransition, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { odmienLiczebnik } from '../../portfel/services/odmianaLiczebnika';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronDown, FileSearch, History, PencilLine, Plus, Redo2, Search, SlidersHorizontal, Undo2 } from 'lucide-react';
import { EngineTransactionHistory } from './EngineTransactionHistory';
import { OverrideHistoryPanel } from './OverrideHistoryPanel';
import {
  TransactionEditorPanel,
  type TransactionEditorActionPayload,
  type TransactionEditorContext,
} from './TransactionEditorPanel';
import type { CandidateTransactionPreviewRow, EngineEditableRecord, EngineHistoryRow, PrivateCashFxViewRow } from '../hooks/useTaxEngineRun';
import { StorageService } from '../services/storage';
import type { DefenseEvidenceOverride } from '../services/defenseEvidenceOverrides';
import type { DefenseWorkbenchItem } from '../services/defenseWorkbench';
import {
  getVisibleTransactionHistoryFilterOptions,
  type TransactionHistoryFilterId,
} from '../services/transactionHistoryGrouping';
import {
  createTransactionOverride,
  type NadpisanieTransakcji,
  type RekordEdycyjny,
  type TypRekorduEdycji,
} from '../services/transactionOverrides';
import { mapujRekordEdycyjnySilnika } from '../services/transactionEditor';
import {
  canPinTransaction,
  getPinnedTransactionLink,
  buildTransactionHistoryTree,
  flattenTransactionHistoryTree,
  removePinnedTransactionLink,
  upsertPinnedTransactionLink,
} from '../services/transactionHistoryPinning';
import {
  appendOverrideSnapshot,
  applyOverrideOperation,
  createEmptyOverrideSession,
  createOverrideOperation,
  createOverrideSnapshot,
  describeOverrideOperation,
  redoOverrideOperation,
  restoreOverrideSnapshot,
  shouldCreateTimedSnapshot,
  undoOverrideOperation,
  type HistoriaOperacjiOverride,
  type StanSesjiOverride,
} from '../services/overrideHistory';
import {
  buildDisplayedHistoryDiagnostics,
  buildDisplayedTransactionHistoryRows,
  HISTORY_VIEW_MODE_OPTIONS,
  getDisplayedHistoryRowPresentation,
  getVisibleHistoryDefenseStatusFilterOptions,
  getVisibleHistoryTaxImpactFilterOptions,
  getVisibleHistoryViewModeOptions,
  matchesHistoryViewMode,
  type HistoryDefenseStatusFilterId,
  type HistoryTaxImpactFilterId,
  type HistoryViewModeId,
} from '../services/displayedTransactionHistory';
import type { BrokerActionWorkbench } from '../services/brokerActionWorkbench';
import type { OpenInsightDrawer } from './cockpit/CockpitUi';
import {
  getActionButtonLabelMode,
  getHistoryShowTechnicalRows,
  saveHistoryShowTechnicalRows,
  UI_PREFERENCES_CHANGED_EVENT,
  type ActionButtonLabelMode,
  type UiComplexityMode,
} from '../services/uiPreferences';
import { getBrowserTaxSettingsStorage } from '../services/taxEngineConfig';
import type { LogEntry } from '../types';
import { useI18n } from '../services/i18n';

interface TransactionsProps {
  selectedYear: number;
  engineHistoryRows?: EngineHistoryRow[];
  privateCashFxViewRows?: PrivateCashFxViewRow[];
  editableRecords?: EngineEditableRecord[];
  initialSearchTerm?: string | null;
  initialFocusRowId?: string | null;
  initialHistoryViewMode?: HistoryViewModeId | null;
  candidateTransactionPreviewRows?: CandidateTransactionPreviewRow[];
  canonicalStorageHistoryRows?: EngineHistoryRow[];
  canonicalStorageHistorySummary?: Record<string, unknown>;
  transactionDossiers?: Array<Record<string, unknown>>;
  transactionDossierSummary?: Record<string, unknown>;
  fieldSourceMap?: Record<string, unknown>;
  transactionConflicts?: Array<Record<string, unknown>>;
  aiExtractedContext?: Array<Record<string, unknown>>;
  onInitialSearchConsumed?: () => void;
  onRefreshEngine: () => Promise<unknown> | unknown;
  onAddLog: (level: LogEntry['level'], message: string, details?: unknown) => void;
  defenseWorkbenchItems?: DefenseWorkbenchItem[];
  defenseEvidenceOverrides?: DefenseEvidenceOverride[];
  brokerActionWorkbench?: BrokerActionWorkbench;
  onConfirmEvidence?: (item: DefenseWorkbenchItem) => void;
  onAddEvidenceNote?: (item: DefenseWorkbenchItem) => void;
  isTaxYearReadOnly?: boolean;
  taxYearReadOnlyMessage?: string;
  uiComplexityMode?: UiComplexityMode;
  onOpenInsight?: OpenInsightDrawer;
}

function buildManualRecordId(recordType: TypRekorduEdycji): string {
  return `manual-${recordType.toLowerCase()}-${Date.now()}`;
}

function upsertOverride(
  overrides: NadpisanieTransakcji[],
  nextOverride: ReturnType<typeof createTransactionOverride>,
): NadpisanieTransakcji[] {
  const filtered = overrides.filter((entry: { manualRecordId: string }) => entry.manualRecordId !== nextOverride.manualRecordId);
  filtered.push(nextOverride);
  return filtered;
}

function removeOverrideById(
  overrides: NadpisanieTransakcji[],
  manualRecordId: string,
): NadpisanieTransakcji[] {
  return overrides.filter((entry: { manualRecordId: string }) => entry.manualRecordId !== manualRecordId);
}

function hasOverride(overrides: NadpisanieTransakcji[], manualRecordId: string): boolean {
  return overrides.some((entry) => entry.manualRecordId === manualRecordId);
}

function haveOverrideChanges(operation: HistoriaOperacjiOverride | null | undefined): boolean {
  if (!operation) {
    return false;
  }
  return JSON.stringify(operation.beforeOverrides) !== JSON.stringify(operation.afterOverrides);
}

function isDevRuntime(): boolean {
  return Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV);
}

function simpleHistoryModeLabel(
  id: HistoryViewModeId,
  fallback: string,
  t: (key: string) => string,
  language: 'pl' | 'en',
): string {
  if (id === 'all') {
    return t('history.all');
  }
  if (id === 'investment') {
    return t('history.investment');
  }
  if (id === 'costs') {
    return t('history.costs');
  }
  if (id === 'cash_fx') {
    return t('history.cashFx');
  }
  if (id === 'position_check') {
    return t('history.positionCheck');
  }
  if (id === 'evidence') {
    return t('history.evidenceAnalytics');
  }
  if (id === 'tax') {
    return t('history.tax');
  }
  if (id === 'candidate') {
    return language === 'en' ? 'New files' : 'Nowe pliki';
  }
  if (id === 'supplemental') {
    return language === 'en' ? 'Supporting' : 'Pomocnicze';
  }
  if (id === 'reconciliation') {
    return language === 'en' ? 'Checks' : 'Kontrola';
  }
  if (id === 'technical') {
    return t('history.technical');
  }
  if (id === 'fix') {
    return t('history.fix');
  }
  return fallback;
}

function mapCandidatePreviewRows(rows: CandidateTransactionPreviewRow[]): EngineHistoryRow[] {
  return rows.map((row) => ({
    row_id: row.previewRowId,
    parent_row_id: null,
    row_kind: 'CANDIDATE_PREVIEW',
    display_date: row.displayDate || null,
    base_record_id: row.previewRowId,
    manual_record_id: row.previewRowId,
    transaction_id: row.previewRowId,
    ticker: row.ticker || null,
    side: row.side || null,
    quantity: null,
    amount: row.amount || null,
    currency: row.currency || null,
    amount_pln: null,
    comment: row.message || 'Podgląd - nie liczy PIT',
    message: row.message || 'Podgląd - nie liczy PIT',
    source_name: row.filename,
    source_manifest_id: row.candidateSourceId,
    conflict_count: 0,
    tax_impact_label: 'Podgląd - nie liczy PIT',
    tax_impact_kind: 'ANALYTICAL_ONLY',
    is_technical_only: false,
    tax_impact_label_pl: 'Podgląd - nie liczy PIT',
    display_category: 'investment',
    display_category_label_pl: 'Inwestycyjne',
    display_category_label_en: 'Investment',
    lineage_summary: row.filename,
    dedupe_status: 'single_source',
    defense_status: null,
    evidence_count: 0,
    missing_evidence_count: 0,
    source_refs: [row.candidateSourceId],
    provenance: [],
    logical_world: 'candidate_preview',
    overlay_status: 'ORIGINAL',
    is_modified: false,
    is_new: false,
    modified_fields: [],
    original_snapshot: {},
    current_snapshot: {},
    read_only: true,
    details: {
      candidate_preview: true,
      candidate_source_id: row.candidateSourceId,
      preview_status: row.previewStatus,
      does_affect_pit: false,
      display_category: 'investment',
      display_category_label_pl: 'Inwestycyjne',
      display_category_label_en: 'Investment',
      lineage_summary: row.filename,
      dedupe_status: 'single_source',
      read_only_reason: 'Podgląd nowego pliku. Nie wpływa na PIT przed ręczną promocją źródła.',
    },
  }));
}

export function Transactions({
  selectedYear,
  engineHistoryRows = [],
  privateCashFxViewRows = [],
  editableRecords = [],
  initialSearchTerm = null,
  initialFocusRowId = null,
  initialHistoryViewMode = null,
  candidateTransactionPreviewRows = [],
  canonicalStorageHistoryRows = [],
  canonicalStorageHistorySummary = {},
  transactionDossiers = [],
  transactionDossierSummary = {},
  fieldSourceMap = {},
  transactionConflicts = [],
  aiExtractedContext = [],
  onInitialSearchConsumed,
  onRefreshEngine,
  onAddLog,
  defenseWorkbenchItems = [],
  defenseEvidenceOverrides = [],
  brokerActionWorkbench,
  onConfirmEvidence,
  onAddEvidenceNote,
  isTaxYearReadOnly = false,
  taxYearReadOnlyMessage,
  uiComplexityMode = 'simple',
  onOpenInsight,
}: TransactionsProps) {
  const { language, t } = useI18n();
  const isExpertMode = uiComplexityMode === 'expert';
  const [searchTerm, setSearchTerm] = useState('');
  const [focusedHistoryRowId, setFocusedHistoryRowId] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<TransactionHistoryFilterId>('all');
  const [historyViewMode, setHistoryViewMode] = useState<HistoryViewModeId>('investment');
  const [taxImpactFilter, setTaxImpactFilter] = useState<HistoryTaxImpactFilterId>('all');
  const [defenseStatusFilter, setDefenseStatusFilter] = useState<HistoryDefenseStatusFilterId>('all');
  const [isHistoryPanelOpen, setIsHistoryPanelOpen] = useState(false);
  const [isFilterPanelOpen, setIsFilterPanelOpen] = useState(false);
  const [overrideSession, setOverrideSession] = useState<StanSesjiOverride>(createEmptyOverrideSession());
  const [actionButtonMode, setActionButtonMode] = useState<ActionButtonLabelMode>(() => (
    getActionButtonLabelMode()
  ));
  const [showTechnicalRows, setShowTechnicalRows] = useState<boolean>(() => (
    getHistoryShowTechnicalRows()
  ));
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [editorContext, setEditorContext] = useState<TransactionEditorContext | null>(null);
  const sessionRef = useRef<StanSesjiOverride>(createEmptyOverrideSession());
  const deferredSearchTerm = useDeferredValue(searchTerm);
  const readOnlyMessage =
    taxYearReadOnlyMessage ||
    `Rok ${selectedYear} jest zamknięty. Otwórz rok ponownie, aby zmieniać historię lub korekty.`;
  const notifyReadOnly = () => {
    onAddLog('warn', readOnlyMessage, { selectedYear });
  };

  useEffect(() => {
    sessionRef.current = overrideSession;
  }, [overrideSession]);

  useEffect(() => {
    const normalizedSearch = initialSearchTerm?.trim();
    const normalizedFocusRowId = initialFocusRowId?.trim();
    if (!normalizedSearch && !normalizedFocusRowId && !initialHistoryViewMode) {
      return;
    }
    if (initialHistoryViewMode) {
      setHistoryViewMode(initialHistoryViewMode);
    }
    if (normalizedSearch) {
      setSearchTerm(normalizedSearch);
    }
    setFocusedHistoryRowId(normalizedFocusRowId || null);
    onInitialSearchConsumed?.();
  }, [initialFocusRowId, initialHistoryViewMode, initialSearchTerm, onInitialSearchConsumed]);

  useEffect(() => {
    let isMounted = true;
    StorageService.getTransactionOverrideSession().then((session) => {
      if (!isMounted) {
        return;
      }
      setOverrideSession(session);
      setSessionLoaded(true);
    });
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    const refreshPreference = () => {
      setActionButtonMode(getActionButtonLabelMode(getBrowserTaxSettingsStorage()));
      setShowTechnicalRows(getHistoryShowTechnicalRows(getBrowserTaxSettingsStorage()));
    };
    window.addEventListener(UI_PREFERENCES_CHANGED_EVENT, refreshPreference);
    window.addEventListener('storage', refreshPreference);
    return () => {
      window.removeEventListener(UI_PREFERENCES_CHANGED_EVENT, refreshPreference);
      window.removeEventListener('storage', refreshPreference);
    };
  }, []);

  useEffect(() => {
    if (!sessionLoaded) {
      return;
    }
    const timeout = window.setTimeout(() => {
      StorageService.saveTransactionEditorDraft(overrideSession.editorDraft).catch(() => undefined);
    }, 150);
    return () => window.clearTimeout(timeout);
  }, [overrideSession.editorDraft, sessionLoaded]);

  useEffect(() => {
    if (!sessionLoaded) {
      return;
    }
    const interval = window.setInterval(async () => {
      const current = sessionRef.current;
      const now = new Date().toISOString();
      if (!shouldCreateTimedSnapshot(current, now)) {
        return;
      }
      const snapshot = createOverrideSnapshot(current, 'autosave_timer', now);
      const next = appendOverrideSnapshot(current, snapshot);
      setOverrideSession(next);
      try {
        await StorageService.saveTransactionOverrideSession(next);
      } catch (error) {
        // Callback timera nie ma kto obsluzyc - odrzucenie wisialo jako unhandledrejection.
        onAddLog('warn', 'Nie udało się zapisać automatycznej kopii warstwy override.', {
          snapshotId: snapshot.snapshotId,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      onAddLog('info', 'Utworzono automatyczną kopię zapasową warstwy override.', {
        snapshotId: snapshot.snapshotId,
        reason: snapshot.reason,
      });
    }, 5 * 60 * 1000);
    return () => window.clearInterval(interval);
  }, [onAddLog, sessionLoaded]);

  const mappedRecords = useMemo(
    () => editableRecords.map((record) => mapujRekordEdycyjnySilnika(record)),
    [editableRecords],
  );

  const baseHistoryRows = canonicalStorageHistoryRows.length > 0 ? canonicalStorageHistoryRows : engineHistoryRows;
  const displayedHistoryRows = useMemo(
    () => [
      ...buildDisplayedTransactionHistoryRows({
        engineHistoryRows: baseHistoryRows,
        privateCashFxViewRows,
        editableRecords,
      }),
      ...mapCandidatePreviewRows(candidateTransactionPreviewRows),
    ],
    [baseHistoryRows, candidateTransactionPreviewRows, editableRecords, privateCashFxViewRows],
  );

  const visibleFilterOptions = useMemo(
    () => getVisibleTransactionHistoryFilterOptions(displayedHistoryRows),
    [displayedHistoryRows],
  );
  const visibleTaxImpactFilterOptions = useMemo(
    () => getVisibleHistoryTaxImpactFilterOptions(displayedHistoryRows),
    [displayedHistoryRows],
  );
  const visibleHistoryViewModeOptions = useMemo(
    () => {
      const baseOptions = getVisibleHistoryViewModeOptions(displayedHistoryRows);
      if (!brokerActionWorkbench?.items.length || baseOptions.some((option) => option.id === 'import_actions')) {
        return baseOptions;
      }
      const importActionOption = HISTORY_VIEW_MODE_OPTIONS.find((option) => option.id === 'import_actions');
      return importActionOption ? [...baseOptions, importActionOption] : baseOptions;
    },
    [brokerActionWorkbench?.items.length, displayedHistoryRows],
  );
  const displayedHistoryViewModeOptions = useMemo(() => {
    if (isExpertMode) {
      return visibleHistoryViewModeOptions;
    }
    const simpleModeIds = new Set<HistoryViewModeId>([
      'investment',
      'costs',
      'cash_fx',
      'position_check',
      'evidence',
      'technical',
      'all',
    ]);
    return visibleHistoryViewModeOptions.filter((option) => simpleModeIds.has(option.id));
  }, [isExpertMode, visibleHistoryViewModeOptions]);
  const visibleDefenseStatusFilterOptions = useMemo(
    () => getVisibleHistoryDefenseStatusFilterOptions(displayedHistoryRows),
    [displayedHistoryRows],
  );

  const hasAdditionalFilters =
    displayedHistoryViewModeOptions.length > 1 ||
    (isExpertMode && (
      visibleFilterOptions.length > 1 ||
      visibleTaxImpactFilterOptions.length > 1 ||
      visibleDefenseStatusFilterOptions.length > 1
    ));

  useEffect(() => {
    if (!isDevRuntime()) {
      return;
    }
    const warnings = buildDisplayedHistoryDiagnostics({
      displayedRows: displayedHistoryRows,
      privateCashFxViewRows,
      editableRecords,
      pinnedChildRowIds: overrideSession.pinnedTransactionLinks.map((link) => link.childRowId),
    });
    warnings.forEach((message) => {
      console.warn(`[Historia transakcji] ${message}`);
    });
  }, [displayedHistoryRows, editableRecords, overrideSession.pinnedTransactionLinks, privateCashFxViewRows]);

  const recordMap = useMemo(() => {
    const map = new Map<string, RekordEdycyjny>();
    for (const record of mappedRecords) {
      map.set(record.manualRecordId, record);
      if (record.baseRecordId) {
        map.set(record.baseRecordId, record);
      }
    }
    return map;
  }, [mappedRecords]);

  const currentDraft = useMemo(() => {
    if (!editorContext || !overrideSession.editorDraft) {
      return null;
    }
    const expectedKey = editorContext.mode === 'edit' ? editorContext.record.manualRecordId : editorContext.manualRecordId;
    return overrideSession.editorDraft.recordKey === expectedKey ? overrideSession.editorDraft : null;
  }, [editorContext, overrideSession.editorDraft]);

  const statystyki = useMemo(() => {
    const displayTree = buildTransactionHistoryTree(displayedHistoryRows, overrideSession.pinnedTransactionLinks);
    const visibleRows = flattenTransactionHistoryTree(displayTree);
    return {
      wszystkie: displayTree.length,
      zmienione: visibleRows.filter((row) => row.overlay_status === 'MODIFIED').length,
      nowe: visibleRows.filter((row) => row.overlay_status === 'NEW').length,
    };
  }, [displayedHistoryRows, overrideSession.pinnedTransactionLinks]);

  const simpleHistorySummary = useMemo(() => {
    const investmentRows = displayedHistoryRows.filter((row) => matchesHistoryViewMode(row, 'investment')).length;
    const supportingRows = displayedHistoryRows.filter((row) => (
      matchesHistoryViewMode(row, 'costs') ||
      matchesHistoryViewMode(row, 'cash_fx')
    )).length;
    const controlRows = displayedHistoryRows.filter((row) => matchesHistoryViewMode(row, 'position_check')).length;
    const evidenceRows = displayedHistoryRows.filter((row) => matchesHistoryViewMode(row, 'evidence')).length;
    const technicalRows = displayedHistoryRows.filter((row) => matchesHistoryViewMode(row, 'technical')).length;
    const candidateRows = candidateTransactionPreviewRows.length;
    const fixRows = displayedHistoryRows.filter((row) => matchesHistoryViewMode(row, 'fix')).length;
    return {
      pitRows: investmentRows,
      supportingRows,
      controlRows,
      evidenceRows,
      // Kafelek "Techniczne" pokazywal `showTechnicalRows ? 0 : technicalRows`,
      // wiec po wlaczeniu filtra wyswietlal 0 pod podpisem "Rekordy techniczne
      // dostepne przez filtr" - czytalo sie to jako "nie ma zadnych", a znaczylo
      // "zadne nie sa teraz ukryte".
      technicalRows,
      technicalRowsWidoczne: showTechnicalRows,
      candidateRows,
      fixRows,
    };
  }, [candidateTransactionPreviewRows.length, displayedHistoryRows, showTechnicalRows]);

  const canonicalHistorySummary = useMemo(() => {
    const numberFromSummary = (key: string, fallback: number | null): number | null => {
      const value = canonicalStorageHistorySummary[key];
      return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    };
    // Brak liczby w odpowiedzi silnika to nie jest zero ani liczba z sasiedniego
    // kafelka. `rawRowCount` podstawiany dlugoscia historii dawal dwa kafelki
    // z ta sama wartoscia, a `mergedRecordCount` podstawiany zerem czytalo sie
    // jako "nic nie scalono".
    return {
      storageRows: canonicalStorageHistoryRows.length,
      rawRows: numberFromSummary('rawRowCount', null),
      deduplicatedRows: numberFromSummary('deduplicatedRowCount', null),
      mergedRows: numberFromSummary('mergedRecordCount', null),
    };
  }, [canonicalStorageHistoryRows.length, canonicalStorageHistorySummary]);

  useEffect(() => {
    if (visibleFilterOptions.some((option) => option.id === typeFilter)) {
      return;
    }
    setTypeFilter('all');
  }, [typeFilter, visibleFilterOptions]);

  useEffect(() => {
    if (isExpertMode) {
      return;
    }
    setTypeFilter('all');
    setTaxImpactFilter('all');
    setDefenseStatusFilter('all');
  }, [isExpertMode]);

  useEffect(() => {
    if (displayedHistoryViewModeOptions.some((option) => option.id === historyViewMode)) {
      return;
    }
    setHistoryViewMode(displayedHistoryViewModeOptions.some((option) => option.id === 'investment') ? 'investment' : (displayedHistoryViewModeOptions[0]?.id || 'all'));
  }, [displayedHistoryViewModeOptions, historyViewMode]);

  useEffect(() => {
    if (visibleTaxImpactFilterOptions.some((option) => option.id === taxImpactFilter)) {
      return;
    }
    setTaxImpactFilter('all');
  }, [taxImpactFilter, visibleTaxImpactFilterOptions]);

  useEffect(() => {
    if (visibleDefenseStatusFilterOptions.some((option) => option.id === defenseStatusFilter)) {
      return;
    }
    setDefenseStatusFilter('all');
  }, [defenseStatusFilter, visibleDefenseStatusFilterOptions]);

  useEffect(() => {
    if (hasAdditionalFilters) {
      return;
    }
    setIsFilterPanelOpen(false);
  }, [hasAdditionalFilters]);

  const persistSession = async (nextSession: StanSesjiOverride, refreshEngine = false) => {
    setOverrideSession(nextSession);
    await StorageService.saveTransactionOverrideSession(nextSession);
    if (refreshEngine) {
      await onRefreshEngine();
    }
  };

  const closeEditor = () => {
    setEditorContext(null);
  };

  const openExistingEditor = (recordKey?: string | null) => {
    if (isTaxYearReadOnly) {
      notifyReadOnly();
      return;
    }
    if (!recordKey) {
      return;
    }
    const record = recordMap.get(recordKey);
    if (!record) {
      onAddLog('error', 'Nie udało się otworzyć wybranej transakcji do edycji.', { recordKey });
      return;
    }
    setEditorContext({ mode: 'edit', record });
  };

  const openNewEditor = (recordType: TypRekorduEdycji = 'TRADE') => {
    if (isTaxYearReadOnly) {
      notifyReadOnly();
      return;
    }
    setEditorContext({
      mode: 'new',
      recordType,
      manualRecordId: buildManualRecordId(recordType),
    });
  };

  const saveSnapshotAfterAction = (
    nextSession: StanSesjiOverride,
    reason: 'save' | 'delete' | 'reset' | 'restore' | 'pin' | 'unpin',
  ) => {
    const snapshot = createOverrideSnapshot(nextSession, reason);
    return {
      session: appendOverrideSnapshot(nextSession, snapshot),
      snapshot,
    };
  };

  const commitSessionChange = async (params: {
    nextSession: StanSesjiOverride;
    logLevel: LogEntry['level'];
    message: string;
    details?: unknown;
    refreshEngine?: boolean;
  }) => {
    await persistSession(params.nextSession, params.refreshEngine !== false);
    onAddLog(params.logLevel, params.message, params.details);
    closeEditor();
  };

  const handleSave = async (payload: TransactionEditorActionPayload) => {
    if (isTaxYearReadOnly) {
      notifyReadOnly();
      closeEditor();
      return;
    }
    const current = sessionRef.current;
    const override = createTransactionOverride({
      recordType: payload.recordType,
      baseRecordId: payload.baseRecordId,
      manualRecordId: payload.manualRecordId,
      mode: payload.baseRecordId ? 'override' : 'new',
      values: payload.values,
      deleted: false,
      comment: payload.values.comment || undefined,
      sourceLabel: 'Ręczna korekta użytkownika',
    });
    const afterOverrides = upsertOverride(current.transactionOverrides, override);
    const operation = createOverrideOperation({
      kind: payload.baseRecordId ? 'save' : 'new',
      recordKey: payload.manualRecordId,
      description: describeOverrideOperation(payload.baseRecordId ? 'save' : 'new'),
      beforeOverrides: current.transactionOverrides,
      afterOverrides,
    });
    const next = applyOverrideOperation(current, operation);
    const { session: withSnapshot, snapshot } = saveSnapshotAfterAction(next, 'save');
    await commitSessionChange({
      nextSession: { ...withSnapshot, editorDraft: null },
      logLevel: 'info',
      message: operation.description,
      details: { operationId: operation.operationId, snapshotId: snapshot.snapshotId, recordKey: payload.manualRecordId },
      refreshEngine: true,
    });
    onAddLog('info', 'Utworzono kopię zapasową warstwy override.', { snapshotId: snapshot.snapshotId, reason: snapshot.reason });
  };

  const handleDelete = async (payload: TransactionEditorActionPayload) => {
    if (isTaxYearReadOnly) {
      notifyReadOnly();
      closeEditor();
      return;
    }
    const current = sessionRef.current;
    if (!payload.baseRecordId && !hasOverride(current.transactionOverrides, payload.manualRecordId)) {
      const nextSession = { ...current, editorDraft: null };
      setOverrideSession(nextSession);
      await StorageService.saveTransactionOverrideSession(nextSession);
      onAddLog('info', 'Usunięto roboczy szkic nowej transakcji.', { recordKey: payload.manualRecordId });
      closeEditor();
      return;
    }
    const afterOverrides = payload.baseRecordId
      ? upsertOverride(
          current.transactionOverrides,
          createTransactionOverride({
            recordType: payload.recordType,
            baseRecordId: payload.baseRecordId,
            manualRecordId: payload.manualRecordId,
            mode: 'override',
            values: payload.values,
            deleted: true,
            comment: payload.values.comment || undefined,
            sourceLabel: 'Ręczna korekta użytkownika',
          }),
        )
      : removeOverrideById(current.transactionOverrides, payload.manualRecordId);
    const operation = createOverrideOperation({
      kind: 'delete',
      recordKey: payload.manualRecordId,
      description: describeOverrideOperation('delete'),
      beforeOverrides: current.transactionOverrides,
      afterOverrides,
    });
    const next = applyOverrideOperation(current, operation);
    const { session: withSnapshot, snapshot } = saveSnapshotAfterAction(next, 'delete');
    await commitSessionChange({
      nextSession: { ...withSnapshot, editorDraft: null },
      logLevel: 'warn',
      message: operation.description,
      details: { operationId: operation.operationId, snapshotId: snapshot.snapshotId, recordKey: payload.manualRecordId },
      refreshEngine: true,
    });
    onAddLog('info', 'Utworzono kopię zapasową warstwy override.', { snapshotId: snapshot.snapshotId, reason: snapshot.reason });
  };

  const handleReset = async (payload: TransactionEditorActionPayload) => {
    if (isTaxYearReadOnly) {
      notifyReadOnly();
      closeEditor();
      return;
    }
    const current = sessionRef.current;
    if (!hasOverride(current.transactionOverrides, payload.manualRecordId)) {
      const nextSession = { ...current, editorDraft: null };
      setOverrideSession(nextSession);
      await StorageService.saveTransactionOverrideSession(nextSession);
      onAddLog('info', 'Porzucono niezapisane zmiany w formularzu edycji.', { recordKey: payload.manualRecordId });
      closeEditor();
      return;
    }
    const afterOverrides = removeOverrideById(current.transactionOverrides, payload.manualRecordId);
    const operation = createOverrideOperation({
      kind: 'reset',
      recordKey: payload.manualRecordId,
      description: describeOverrideOperation('reset'),
      beforeOverrides: current.transactionOverrides,
      afterOverrides,
    });
    const next = applyOverrideOperation(current, operation);
    const { session: withSnapshot, snapshot } = saveSnapshotAfterAction(next, 'reset');
    await commitSessionChange({
      nextSession: { ...withSnapshot, editorDraft: null },
      logLevel: 'info',
      message: operation.description,
      details: { operationId: operation.operationId, snapshotId: snapshot.snapshotId, recordKey: payload.manualRecordId },
      refreshEngine: true,
    });
    onAddLog('info', 'Utworzono kopię zapasową warstwy override.', { snapshotId: snapshot.snapshotId, reason: snapshot.reason });
  };

  const handleRestore = async (payload: TransactionEditorActionPayload) => {
    if (isTaxYearReadOnly) {
      notifyReadOnly();
      closeEditor();
      return;
    }
    const current = sessionRef.current;
    const override = createTransactionOverride({
      recordType: payload.recordType,
      baseRecordId: payload.baseRecordId,
      manualRecordId: payload.manualRecordId,
      mode: payload.baseRecordId ? 'override' : 'new',
      values: payload.values,
      deleted: false,
      comment: payload.values.comment || undefined,
      sourceLabel: 'Ręczna korekta użytkownika',
    });
    const afterOverrides = upsertOverride(current.transactionOverrides, override);
    const operation = createOverrideOperation({
      kind: 'restore',
      recordKey: payload.manualRecordId,
      description: describeOverrideOperation('restore'),
      beforeOverrides: current.transactionOverrides,
      afterOverrides,
    });
    const next = applyOverrideOperation(current, operation);
    const { session: withSnapshot, snapshot } = saveSnapshotAfterAction(next, 'restore');
    await commitSessionChange({
      nextSession: { ...withSnapshot, editorDraft: null },
      logLevel: 'info',
      message: operation.description,
      details: { operationId: operation.operationId, snapshotId: snapshot.snapshotId, recordKey: payload.manualRecordId },
      refreshEngine: true,
    });
    onAddLog('info', 'Utworzono kopię zapasową warstwy override.', { snapshotId: snapshot.snapshotId, reason: snapshot.reason });
  };

  const handlePinTransaction = async (childRowId: string, parentRowId: string) => {
    if (isTaxYearReadOnly) {
      notifyReadOnly();
      return;
    }
    const current = sessionRef.current;
    const validation = canPinTransaction(displayedHistoryRows, current.pinnedTransactionLinks, childRowId, parentRowId);
    if (!validation.allowed) {
      onAddLog('warn', validation.reason || 'Nie można przypiąć transakcji.', {
        childRowId,
        parentRowId,
      });
      return;
    }

    const existing = getPinnedTransactionLink(current.pinnedTransactionLinks, childRowId);
    const nextPinnedLinks = upsertPinnedTransactionLink(current.pinnedTransactionLinks, {
      childRowId,
      parentRowId,
      source: 'drag_drop',
    });
    if (JSON.stringify(nextPinnedLinks) === JSON.stringify(current.pinnedTransactionLinks)) {
      return;
    }

    const operation = createOverrideOperation({
      kind: existing ? 'move_pin' : 'pin',
      recordKey: childRowId,
      description: describeOverrideOperation(existing ? 'move_pin' : 'pin'),
      beforeOverrides: current.transactionOverrides,
      afterOverrides: current.transactionOverrides,
      beforePinnedTransactionLinks: current.pinnedTransactionLinks,
      afterPinnedTransactionLinks: nextPinnedLinks,
    });
    const next = applyOverrideOperation(current, operation);
    const { session: withSnapshot, snapshot } = saveSnapshotAfterAction(next, 'pin');
    await commitSessionChange({
      nextSession: { ...withSnapshot, editorDraft: null },
      logLevel: 'info',
      message: operation.description,
      details: {
        operationId: operation.operationId,
        snapshotId: snapshot.snapshotId,
        childRowId,
        parentRowId,
      },
      refreshEngine: false,
    });
    onAddLog('info', 'Utworzono kopię zapasową warstwy override.', {
      snapshotId: snapshot.snapshotId,
      reason: snapshot.reason,
    });
  };

  const handleUnpinTransaction = async (childRowId: string) => {
    if (isTaxYearReadOnly) {
      notifyReadOnly();
      return;
    }
    const current = sessionRef.current;
    const existing = getPinnedTransactionLink(current.pinnedTransactionLinks, childRowId);
    if (!existing) {
      return;
    }

    const nextPinnedLinks = removePinnedTransactionLink(current.pinnedTransactionLinks, childRowId);
    const operation = createOverrideOperation({
      kind: 'unpin',
      recordKey: childRowId,
      description: describeOverrideOperation('unpin'),
      beforeOverrides: current.transactionOverrides,
      afterOverrides: current.transactionOverrides,
      beforePinnedTransactionLinks: current.pinnedTransactionLinks,
      afterPinnedTransactionLinks: nextPinnedLinks,
    });
    const next = applyOverrideOperation(current, operation);
    const { session: withSnapshot, snapshot } = saveSnapshotAfterAction(next, 'unpin');
    await commitSessionChange({
      nextSession: { ...withSnapshot, editorDraft: null },
      logLevel: 'info',
      message: operation.description,
      details: {
        operationId: operation.operationId,
        snapshotId: snapshot.snapshotId,
        childRowId,
        parentRowId: existing.parentRowId,
      },
      refreshEngine: false,
    });
    onAddLog('info', 'Utworzono kopię zapasową warstwy override.', {
      snapshotId: snapshot.snapshotId,
      reason: snapshot.reason,
    });
  };

  const handleUndo = async () => {
    if (isTaxYearReadOnly) {
      notifyReadOnly();
      return;
    }
    const result = undoOverrideOperation(sessionRef.current);
    if (!result.historyEntry) {
      return;
    }
    await persistSession({ ...result.session, editorDraft: null }, haveOverrideChanges(result.historyEntry));
    onAddLog('info', result.historyEntry.description, { operationId: result.historyEntry.operationId });
    closeEditor();
  };

  const handleRedo = async () => {
    if (isTaxYearReadOnly) {
      notifyReadOnly();
      return;
    }
    const result = redoOverrideOperation(sessionRef.current);
    if (!result.historyEntry) {
      return;
    }
    await persistSession({ ...result.session, editorDraft: null }, haveOverrideChanges(result.historyEntry));
    onAddLog('info', result.historyEntry.description, { operationId: result.historyEntry.operationId });
    closeEditor();
  };

  const handleRestoreSnapshot = async (snapshotId: string) => {
    if (isTaxYearReadOnly) {
      notifyReadOnly();
      return;
    }
    const snapshot = sessionRef.current.snapshots.find((entry) => entry.snapshotId === snapshotId);
    if (!snapshot) {
      return;
    }
    const snapshotOperationIds = new Set(snapshot.undoStack.map((operation) => operation.operationId));
    const correctionKinds = new Set(['save', 'delete', 'reset', 'restore', 'new', 'pin', 'unpin', 'move_pin', 'restore_snapshot']);
    const newerCorrections = sessionRef.current.undoStack.filter(
      (operation) => correctionKinds.has(operation.kind) && !snapshotOperationIds.has(operation.operationId),
    ).length;
    if (
      newerCorrections > 0 &&
      !window.confirm(`Przywrócenie migawki usunie co najmniej ${newerCorrections} ${odmienLiczebnik(newerCorrections, 'nowszą korektę', 'nowsze korekty', 'nowszych korekt')} (liczone z historii „Cofnij”). Czy kontynuować?`)
    ) {
      return;
    }
    const restored = restoreOverrideSnapshot(sessionRef.current, snapshot);
    const { session: withSnapshot, snapshot: restoreSnapshot } = saveSnapshotAfterAction(restored.session, 'restore');
    await persistSession({ ...withSnapshot, editorDraft: null }, haveOverrideChanges(restored.historyEntry));
    onAddLog('info', restored.historyEntry.description, {
      operationId: restored.historyEntry.operationId,
      snapshotId: snapshot.snapshotId,
      restoreSnapshotId: restoreSnapshot.snapshotId,
    });
    onAddLog('info', 'Utworzono kopię zapasową warstwy override.', { snapshotId: restoreSnapshot.snapshotId, reason: restoreSnapshot.reason });
    closeEditor();
  };

  return (
    <div className="w-full max-w-none space-y-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div className="space-y-2">
          <motion.h1
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-2xl font-bold text-gray-900 dark:text-white"
          >
            {t('history.title')}
          </motion.h1>
          <p className="max-w-3xl text-sm text-gray-600 dark:text-gray-400">
            {isExpertMode
              ? 'Kliknij dowolny wiersz, aby rozwinąć szybki podgląd szczegółów. Zmiany ręczne zapisane w edytorze wpływają na kolejne przeliczenie silnika.'
              : `${t('history.title')}: ${t('history.pitImpact')}. ${t('history.details')} otwierają pełny kontekst.`}
          </p>
        </div>
        {isExpertMode && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleUndo}
            disabled={isTaxYearReadOnly || overrideSession.undoStack.length === 0}
            className="inline-flex items-center gap-2 rounded-2xl border border-gray-200 px-4 py-2.5 text-sm font-semibold text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            <Undo2 size={18} />
            Cofnij
          </button>
          <button
            type="button"
            onClick={handleRedo}
            disabled={isTaxYearReadOnly || overrideSession.redoStack.length === 0}
            className="inline-flex items-center gap-2 rounded-2xl border border-gray-200 px-4 py-2.5 text-sm font-semibold text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            <Redo2 size={18} />
            Ponów
          </button>
          <button
            type="button"
            onClick={() => openNewEditor('TRADE')}
            disabled={isTaxYearReadOnly}
            className="inline-flex items-center gap-2 rounded-2xl border border-blue-200 px-4 py-2.5 text-sm font-semibold text-blue-700 transition hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-blue-800 dark:text-blue-300 dark:hover:bg-blue-900/20"
          >
            <Plus size={18} />
            Dodaj transakcję
          </button>
          <button
            type="button"
            onClick={() => setIsHistoryPanelOpen((current) => !current)}
            className="inline-flex items-center gap-2 rounded-2xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-700"
          >
            <History size={18} />
            Historia zmian i kopie
          </button>
        </div>
        )}
      </div>

      {isTaxYearReadOnly && (
        <div className="rounded-3xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800 shadow-sm dark:border-emerald-800/50 dark:bg-emerald-900/20 dark:text-emerald-200">
          <p className="font-semibold">Rok zamknięty - tryb tylko do odczytu</p>
          <p className="mt-1">{readOnlyMessage}</p>
        </div>
      )}

      {isExpertMode && (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="rounded-3xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Wiersze główne</p>
          <p className="mt-2 text-2xl font-bold text-gray-900 dark:text-white">{statystyki.wszystkie}</p>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Rok widoku: {selectedYear}</p>
        </div>
        <div className="rounded-3xl border border-amber-200 bg-amber-50 p-4 shadow-sm dark:border-amber-800/50 dark:bg-amber-900/20">
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">Zmodyfikowane</p>
          <p className="mt-2 text-2xl font-bold text-amber-900 dark:text-amber-200">{statystyki.zmienione}</p>
          <p className="mt-1 text-sm text-amber-700 dark:text-amber-300">Rekordy z ręczną korektą użytkownika.</p>
        </div>
        <div className="rounded-3xl border border-emerald-200 bg-emerald-50 p-4 shadow-sm dark:border-emerald-800/50 dark:bg-emerald-900/20">
          <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">Nowe</p>
          <p className="mt-2 text-2xl font-bold text-emerald-900 dark:text-emerald-200">{statystyki.nowe}</p>
          <p className="mt-1 text-sm text-emerald-700 dark:text-emerald-300">Pozycje dodane ręcznie do warstwy override.</p>
        </div>
      </div>
      )}

      {!isExpertMode && (
        <div className="rounded-3xl border border-blue-100 bg-blue-50/70 p-4 shadow-sm dark:border-blue-900/40 dark:bg-blue-950/20">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-sm font-semibold text-blue-950 dark:text-blue-100">{t('history.storageBasedTitle')}</p>
              <p className="mt-1 text-sm text-blue-800 dark:text-blue-200">{t('history.storageBasedDescription')}</p>
              {/* Rzad ponizej liczy wiersze WIDOCZNE na ekranie (razem z podgladami
                  plikow i korektami roboczymi), a kafelki obok - to, co policzyl
                  silnik na calym magazynie. Dwie rozne rzeczy staly obok siebie
                  bez slowa wyjasnienia, wiec nie sumowaly sie i wygladalo to jak
                  brakujace wiersze. */}
              <p className="mt-1 text-xs text-blue-700/80 dark:text-blue-300/80">
                {t('history.storageVsViewNote')}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
              <div className="rounded-2xl bg-white/80 px-3 py-2 text-blue-950 shadow-sm dark:bg-blue-950/50 dark:text-blue-100">
                <p className="text-[10px] font-semibold uppercase tracking-wide opacity-70">{t('history.storageRows')}</p>
                <p className="text-lg font-bold">{canonicalHistorySummary.storageRows}</p>
              </div>
              <div className="rounded-2xl bg-white/80 px-3 py-2 text-blue-950 shadow-sm dark:bg-blue-950/50 dark:text-blue-100">
                <p className="text-[10px] font-semibold uppercase tracking-wide opacity-70">{t('history.rawRows')}</p>
                <p className="text-lg font-bold">
                  {canonicalHistorySummary.rawRows ?? '—'}
                </p>
              </div>
              <div className="rounded-2xl bg-white/80 px-3 py-2 text-blue-950 shadow-sm dark:bg-blue-950/50 dark:text-blue-100">
                <p className="text-[10px] font-semibold uppercase tracking-wide opacity-70">{t('history.deduplicatedRows')}</p>
                <p className="text-lg font-bold">
                  {canonicalHistorySummary.deduplicatedRows ?? '—'}
                </p>
              </div>
              <div className="rounded-2xl bg-white/80 px-3 py-2 text-blue-950 shadow-sm dark:bg-blue-950/50 dark:text-blue-100">
                <p className="text-[10px] font-semibold uppercase tracking-wide opacity-70">{t('history.mergedRows')}</p>
                <p className="text-lg font-bold">
                  {canonicalHistorySummary.mergedRows ?? '—'}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {!isExpertMode && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
          <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{t('history.summaryPitRows')}</p>
            <p className="mt-2 text-2xl font-bold text-gray-900 dark:text-white">{simpleHistorySummary.pitRows}</p>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t('history.summaryPitRowsDescription')}</p>
          </div>
          <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{t('history.supportingRows')}</p>
            <p className="mt-2 text-2xl font-bold text-gray-900 dark:text-white">{simpleHistorySummary.supportingRows}</p>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t('history.supportingRowsDescription')}</p>
          </div>
          <div className="rounded-2xl border border-indigo-100 bg-indigo-50 p-4 shadow-sm dark:border-indigo-900/50 dark:bg-indigo-950/20">
            <p className="text-xs font-semibold uppercase tracking-wide text-indigo-700 dark:text-indigo-300">
              {t('history.controlEvidenceRows')}
            </p>
            <p className="mt-2 text-2xl font-bold text-indigo-950 dark:text-indigo-100">
              {simpleHistorySummary.controlRows + simpleHistorySummary.evidenceRows}
            </p>
            <p className="mt-1 text-sm text-indigo-800 dark:text-indigo-200">
              {t('history.controlEvidenceRowsDescription')}
            </p>
          </div>
          <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{t('history.hiddenTechnical')}</p>
            <p className="mt-2 text-2xl font-bold text-gray-900 dark:text-white">{simpleHistorySummary.technicalRows}</p>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {simpleHistorySummary.technicalRowsWidoczne
                ? t('history.technicalShown')
                : t('history.hiddenTechnicalDescription')}
            </p>
          </div>
        </div>
      )}

      <div className={`grid grid-cols-1 gap-6 ${isExpertMode && isHistoryPanelOpen ? 'xl:grid-cols-[minmax(0,1fr),360px]' : ''}`}>
        <div className="space-y-6">
          <div className="rounded-3xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                <div className="relative w-full xl:max-w-sm">
                  <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                    <Search size={16} className="text-gray-400" />
                  </div>
                  <input
                    type="text"
                    placeholder={t('history.searchPlaceholder')}
                    className="w-full rounded-2xl border border-gray-200 bg-white py-2.5 pl-10 pr-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
                    value={searchTerm}
                    onChange={(event) => setSearchTerm(event.target.value)}
                  />
                  {deferredSearchTerm !== searchTerm && (
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-semibold uppercase tracking-wide text-blue-500">
                      filtruję
                    </span>
                  )}
                </div>
                {isExpertMode && hasAdditionalFilters && (
                  <button
                    type="button"
                    onClick={() => setIsFilterPanelOpen((current) => !current)}
                    className="inline-flex items-center justify-center gap-2 self-start rounded-2xl border border-gray-200 px-4 py-2.5 text-sm font-semibold text-gray-700 transition hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900 xl:self-auto"
                  >
                    <SlidersHorizontal size={16} />
                    Filtry historii
                    <ChevronDown
                      size={16}
                      className={`transition-transform ${isFilterPanelOpen ? 'rotate-180' : ''}`}
                    />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    const next = !showTechnicalRows;
                    setShowTechnicalRows(next);
                    saveHistoryShowTechnicalRows(next, getBrowserTaxSettingsStorage());
                  }}
                  className={`inline-flex items-center justify-center gap-2 self-start rounded-2xl border px-4 py-2.5 text-sm font-semibold transition xl:self-auto ${
                    showTechnicalRows
                      ? 'border-slate-300 bg-slate-900 text-white hover:bg-slate-800 dark:border-slate-600 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white'
                      : 'border-gray-200 text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900'
                  }`}
                  title="Techniczne ruchy gotówki i blokady środków są widoczne w trybie Techniczne; ten przełącznik pokazuje je także w zwykłej historii."
                >
                  {showTechnicalRows ? t('history.hideTechnical') : t('history.showTechnical')}
                </button>
              </div>
              {!isExpertMode && displayedHistoryViewModeOptions.length > 1 && (
                <div className="flex flex-wrap gap-2">
                  {displayedHistoryViewModeOptions.map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      title={tab.description}
                      onClick={() => startTransition(() => setHistoryViewMode(tab.id))}
                      className={`rounded-2xl px-3 py-2 text-sm font-medium transition-colors ${
                        historyViewMode === tab.id
                          ? 'bg-blue-600 text-white'
                          : 'bg-gray-50 text-gray-700 hover:bg-blue-50 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800'
                      }`}
                    >
                      {simpleHistoryModeLabel(tab.id, tab.label, t, language)}
                    </button>
                  ))}
                </div>
              )}
              <AnimatePresence initial={false}>
                {isExpertMode && hasAdditionalFilters && isFilterPanelOpen && (
                  <motion.div
                    initial={{ opacity: 0, height: 0, y: -8 }}
                    animate={{ opacity: 1, height: 'auto', y: 0 }}
                    exit={{ opacity: 0, height: 0, y: -8 }}
                    transition={{ duration: 0.2, ease: 'easeOut' }}
                    className="overflow-hidden"
                  >
                    <div className="space-y-4 rounded-2xl border border-blue-100 bg-gradient-to-r from-blue-50 to-cyan-50 p-3 dark:border-blue-900/40 dark:from-blue-950/30 dark:to-cyan-950/20">
                      <div>
                        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                          Tryb historii
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {displayedHistoryViewModeOptions.map((tab) => (
                            <button
                              key={tab.id}
                              type="button"
                              title={tab.description}
                              onClick={() => startTransition(() => setHistoryViewMode(tab.id))}
                              className={`rounded-2xl px-3 py-2 text-sm font-medium transition-colors ${
                                historyViewMode === tab.id
                                  ? 'bg-blue-600 text-white'
                                  : 'bg-white text-gray-700 hover:bg-blue-100 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800'
                              }`}
                            >
                              {tab.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      {isExpertMode && (
                      <div>
                        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                          Typ wiersza
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {visibleFilterOptions.map((tab) => (
                            <button
                              key={tab.id}
                              type="button"
                              onClick={() => startTransition(() => setTypeFilter(tab.id))}
                              className={`rounded-2xl px-3 py-2 text-sm font-medium transition-colors ${
                                typeFilter === tab.id
                                  ? 'bg-blue-600 text-white'
                                  : 'bg-white text-gray-700 hover:bg-blue-100 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800'
                              }`}
                            >
                              {tab.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      )}
                      {isExpertMode && (
                      <div>
                        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                          Wpływ na PIT
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {visibleTaxImpactFilterOptions.map((tab) => (
                            <button
                              key={tab.id}
                              type="button"
                              onClick={() => startTransition(() => setTaxImpactFilter(tab.id))}
                              className={`rounded-2xl px-3 py-2 text-sm font-medium transition-colors ${
                                taxImpactFilter === tab.id
                                  ? 'bg-blue-600 text-white'
                                  : 'bg-white text-gray-700 hover:bg-blue-100 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800'
                              }`}
                            >
                              {tab.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      )}
                      {isExpertMode && (
                      <div>
                        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                          Status dowodowy
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {visibleDefenseStatusFilterOptions.map((tab) => (
                            <button
                              key={tab.id}
                              type="button"
                              onClick={() => startTransition(() => setDefenseStatusFilter(tab.id))}
                              className={`rounded-2xl px-3 py-2 text-sm font-medium transition-colors ${
                                defenseStatusFilter === tab.id
                                  ? 'bg-blue-600 text-white'
                                  : 'bg-white text-gray-700 hover:bg-blue-100 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800'
                              }`}
                            >
                              {tab.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          <div className="rounded-3xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
            {displayedHistoryRows.length > 0 ? (
              <EngineTransactionHistory
                rows={displayedHistoryRows}
                searchTerm={deferredSearchTerm}
                typeFilter={typeFilter}
                historyViewMode={historyViewMode}
                taxImpactFilter={taxImpactFilter}
                defenseStatusFilter={defenseStatusFilter}
                focusRowId={focusedHistoryRowId}
                pinnedTransactionLinks={overrideSession.pinnedTransactionLinks}
                defenseWorkbenchItems={defenseWorkbenchItems}
                defenseEvidenceOverrides={defenseEvidenceOverrides}
                brokerActionItems={brokerActionWorkbench?.items || []}
                transactionDossiers={transactionDossiers}
                transactionDossierSummary={transactionDossierSummary}
                fieldSourceMap={fieldSourceMap}
                transactionConflicts={transactionConflicts}
                aiExtractedContext={aiExtractedContext}
                actionButtonMode={actionButtonMode}
                uiComplexityMode={uiComplexityMode}
                showTechnicalRows={showTechnicalRows}
                isReadOnly={isTaxYearReadOnly}
                readOnlyReason={readOnlyMessage}
                onOpenEditor={openExistingEditor}
                onPinTransaction={handlePinTransaction}
                onUnpinTransaction={handleUnpinTransaction}
                onConfirmEvidence={onConfirmEvidence}
                onAddEvidenceNote={onAddEvidenceNote}
                onOpenInsight={onOpenInsight}
              />
            ) : (
              <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
                <div className="rounded-full bg-blue-50 p-4 text-blue-600 dark:bg-blue-900/20 dark:text-blue-400">
                  <FileSearch size={28} />
                </div>
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                  Brak historii z silnika dla wybranego roku
                </h2>
                <p className="max-w-xl text-sm text-gray-500 dark:text-gray-400">
                  Zaimportuj dane albo dodaj nową pozycję. Po zapisaniu pojawi się tutaj w końcowym widoku historii.
                </p>
                <button
                  type="button"
                  onClick={() => openNewEditor('TRADE')}
                  disabled={isTaxYearReadOnly}
                  className="inline-flex items-center gap-2 rounded-2xl border border-blue-200 px-4 py-2.5 text-sm font-semibold text-blue-700 transition hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-blue-800 dark:text-blue-300 dark:hover:bg-blue-900/20"
                >
                  <PencilLine size={18} />
                  Dodaj transakcję
                </button>
              </div>
            )}
          </div>
        </div>

        {isExpertMode && (
        <OverrideHistoryPanel
          isOpen={isHistoryPanelOpen}
          operationHistory={overrideSession.operationHistory}
          snapshots={overrideSession.snapshots}
          undoCount={overrideSession.undoStack.length}
          redoCount={overrideSession.redoStack.length}
          onClose={() => setIsHistoryPanelOpen(false)}
          onUndo={handleUndo}
          onRedo={handleRedo}
          onRestoreSnapshot={handleRestoreSnapshot}
        />
        )}
      </div>

      {isExpertMode && (
      <TransactionEditorPanel
        isOpen={editorContext !== null}
        context={editorContext}
        draft={currentDraft}
        onClose={closeEditor}
        onDraftChange={(draft) => {
          setOverrideSession((current) => ({
            ...current,
            editorDraft: draft,
          }));
        }}
        onSave={handleSave}
        onDelete={handleDelete}
        onReset={handleReset}
        onRestore={handleRestore}
      />
      )}
    </div>
  );
}
