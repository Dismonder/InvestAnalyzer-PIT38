import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Eye, GripVertical, Info, Paperclip, PencilLine, X } from 'lucide-react';
import { motion } from 'motion/react';
import type { EngineHistoryRow } from '../hooks/useTaxEngineRun';
import type { BrokerActionWorkbenchItem } from '../services/brokerActionWorkbench';
import type { DefenseEvidenceOverride } from '../services/defenseEvidenceOverrides';
import type { DefenseWorkbenchItem } from '../services/defenseWorkbench';
import {
  getTransactionHistoryPresentation,
  matchesTransactionHistoryFilter,
  type TransactionHistoryFilterId,
} from '../services/transactionHistoryGrouping';
import {
  buildTransactionHistoryTree,
  canPinTransaction,
  filterTransactionHistoryTree,
  flattenTransactionHistoryTree,
  sortTransactionHistoryTree,
  type TransactionHistoryTreeNode,
} from '../services/transactionHistoryPinning';
import type { PinnedTransactionLink } from '../services/overrideHistory';
import {
  formatDisplayDateTime,
  formatMoney,
  formatQuantity,
  getDisplayedHistoryRowPresentation,
  getHistoryInstrumentDisplay,
  isCandidatePreviewHistoryRow,
  isPinnableHistoryRow,
  matchesHistoryDefenseStatusFilter,
  matchesHistoryTaxImpactFilter,
  matchesHistoryViewMode,
  type HistoryDefenseStatusFilterId,
  type HistoryTaxImpactFilterId,
  type HistoryTaxImpactKind,
  type HistoryViewModeId,
} from '../services/displayedTransactionHistory';
import type { ActionButtonLabelMode, UiComplexityMode } from '../services/uiPreferences';
import { InsightDrawer, type OpenInsightDrawer } from './cockpit/CockpitUi';
import { useUiMotion } from './cockpit/uiMotion';
import { useI18n } from '../services/i18n';

interface EngineTransactionHistoryProps {
  rows: EngineHistoryRow[];
  searchTerm: string;
  typeFilter: TransactionHistoryFilterId;
  historyViewMode?: HistoryViewModeId;
  taxImpactFilter?: HistoryTaxImpactFilterId;
  defenseStatusFilter?: HistoryDefenseStatusFilterId;
  focusRowId?: string | null;
  pinnedTransactionLinks: PinnedTransactionLink[];
  defenseWorkbenchItems?: DefenseWorkbenchItem[];
  defenseEvidenceOverrides?: DefenseEvidenceOverride[];
  brokerActionItems?: BrokerActionWorkbenchItem[];
  transactionDossiers?: Array<Record<string, unknown>>;
  transactionDossierSummary?: Record<string, unknown>;
  fieldSourceMap?: Record<string, unknown>;
  transactionConflicts?: Array<Record<string, unknown>>;
  aiExtractedContext?: Array<Record<string, unknown>>;
  actionButtonMode?: ActionButtonLabelMode;
  uiComplexityMode?: UiComplexityMode;
  showTechnicalRows?: boolean;
  isReadOnly?: boolean;
  readOnlyReason?: string;
  onOpenEditor: (recordKey?: string | null) => void;
  onPinTransaction: (childRowId: string, parentRowId: string) => Promise<void> | void;
  onUnpinTransaction: (childRowId: string) => Promise<void> | void;
  onConfirmEvidence?: (item: DefenseWorkbenchItem) => void;
  onAddEvidenceNote?: (item: DefenseWorkbenchItem) => void;
  onOpenInsight?: OpenInsightDrawer;
}

const etykietaNakladki = (row: EngineHistoryRow) => {
  if (row.overlay_status === 'NEW') {
    return {
      label: 'Nowa',
      className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300',
    };
  }
  if (row.overlay_status === 'MODIFIED') {
    return {
      label: 'Zmieniona',
      className: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
    };
  }
  return null;
};

function tekstWartosci(value: unknown): string {
  if (value === undefined || value === null || value === '') {
    return '—';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nestedRecord(value: unknown, key: string): Record<string, unknown> {
  return asRecord(asRecord(value)[key]);
}

function nestedArray(value: unknown, key: string): unknown[] {
  const entry = asRecord(value)[key];
  return Array.isArray(entry) ? entry : [];
}

function hasSharedValue(left: unknown[], right: unknown[]): boolean {
  const normalized = new Set(left.map((value) => String(value || '').toLowerCase()).filter(Boolean));
  return right.some((value) => normalized.has(String(value || '').toLowerCase()));
}

function findTransactionDossier(row: EngineHistoryRow, dossiers: Array<Record<string, unknown>>): Record<string, unknown> | null {
  const rowTokens = [
    row.transaction_id,
    row.base_record_id,
    row.manual_record_id,
    row.details?.source_record_id,
    ...(row.source_refs || []),
  ].filter(Boolean);
  const rowTicker = String(row.ticker || row.details?.ticker || '').toLowerCase();
  for (const dossier of dossiers) {
    const identity = nestedRecord(dossier, 'identity');
    const coreTrade = nestedRecord(dossier, 'core_trade');
    const identityTokens = [
      identity.primary_trade_id,
      identity.broker_trade_id,
      identity.order_id,
      identity.transaction_id,
      identity.trade_nb,
      ...(Array.isArray(identity.source_ids) ? identity.source_ids : []),
    ];
    if (hasSharedValue(rowTokens, identityTokens)) {
      return dossier;
    }
    const dossierTicker = String(coreTrade.ticker || '').toLowerCase();
    if (rowTicker && dossierTicker && rowTicker === dossierTicker && row.display_date && String(coreTrade.trade_date || coreTrade.date_time || '').startsWith(String(row.display_date).slice(0, 10))) {
      return dossier;
    }
  }
  return null;
}

export function getTransactionDossierAiContexts(
  dossier: Record<string, unknown> | null | undefined,
  aiContexts: Array<Record<string, unknown>> = [],
): Array<Record<string, unknown>> {
  if (!dossier || aiContexts.length === 0) {
    return [];
  }
  const lineage = nestedRecord(dossier, 'lineage');
  const rawRecords = nestedArray(lineage, 'raw_records').map(asRecord);
  const eventIds = new Set(
    rawRecords
      .map((record) => String(record.event_id || record.source_event_id || ''))
      .filter(Boolean),
  );
  if (eventIds.size === 0) {
    return [];
  }
  return aiContexts.filter((context) => eventIds.has(String(context.source_event_id || '')));
}

function TransactionDossierPanel({
  dossier,
  aiContexts,
  t,
}: {
  dossier: Record<string, unknown>;
  aiContexts?: Array<Record<string, unknown>>;
  t: (key: string) => string;
}) {
  const coreTrade = nestedRecord(dossier, 'core_trade');
  const fees = nestedRecord(dossier, 'fees_and_costs');
  const brokerCommission = nestedRecord(fees, 'broker_commission');
  const cashContext = nestedRecord(dossier, 'cash_context');
  const fxContext = nestedRecord(dossier, 'fx_context');
  const lineage = nestedRecord(dossier, 'lineage');
  const review = nestedRecord(dossier, 'review');
  const fieldSources = nestedRecord(lineage, 'field_sources');
  const conflicts = nestedArray(lineage, 'conflicts');
  const sourceFiles = nestedArray(lineage, 'source_files');
  const dossierAiContexts = getTransactionDossierAiContexts(dossier, aiContexts || []);

  return (
    <section className="rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm dark:border-blue-900/60 dark:bg-blue-950/20">
      <h4 className="text-sm font-semibold text-blue-950 dark:text-blue-100">{t('transactionDossier.title')}</h4>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300">{t('transactionDossier.coreTrade')}</p>
          <dl className="mt-2 space-y-1 text-xs text-blue-950 dark:text-blue-100">
            <div className="grid grid-cols-[110px,1fr] gap-2"><dt>Operacja</dt><dd>{tekstWartosci(coreTrade.operation)}</dd></div>
            <div className="grid grid-cols-[110px,1fr] gap-2"><dt>Data</dt><dd>{tekstWartosci(coreTrade.trade_date || coreTrade.date_time)}</dd></div>
            <div className="grid grid-cols-[110px,1fr] gap-2"><dt>Instrument</dt><dd>{tekstWartosci(coreTrade.ticker || coreTrade.instrument_name)}</dd></div>
            <div className="grid grid-cols-[110px,1fr] gap-2"><dt>Ilość</dt><dd>{tekstWartosci(coreTrade.quantity)}</dd></div>
            <div className="grid grid-cols-[110px,1fr] gap-2"><dt>Cena</dt><dd>{tekstWartosci(coreTrade.price)}</dd></div>
            <div className="grid grid-cols-[110px,1fr] gap-2"><dt>Kwota</dt><dd>{tekstWartosci(coreTrade.gross_amount || coreTrade.net_amount)} {tekstWartosci(coreTrade.trade_currency)}</dd></div>
          </dl>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300">{t('transactionDossier.fees')}</p>
          <dl className="mt-2 space-y-1 text-xs text-blue-950 dark:text-blue-100">
            <div className="grid grid-cols-[150px,1fr] gap-2"><dt>Prowizja</dt><dd>{tekstWartosci(brokerCommission.amount)} {tekstWartosci(brokerCommission.currency)}</dd></div>
            <div className="grid grid-cols-[150px,1fr] gap-2"><dt>Ruchy kosztowe</dt><dd>{nestedArray(fees, 'cash_movement_fees').length}</dd></div>
            <div className="grid grid-cols-[150px,1fr] gap-2"><dt>Ujemne saldo</dt><dd>{nestedArray(fees, 'negative_balance_interest').length}</dd></div>
          </dl>
          <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300">{t('transactionDossier.cashContext')}</p>
          <p className="mt-1 text-xs text-blue-950 dark:text-blue-100">
            {nestedArray(cashContext, 'related_cash_movements').length} powiązanych ruchów gotówki, margin: {cashContext.margin_or_negative_balance_detected ? 'tak' : 'nie'}.
          </p>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300">{t('transactionDossier.fxNbp')}</p>
          <p className="mt-1 text-xs text-blue-950 dark:text-blue-100">
            Waluta transakcji: {tekstWartosci(fxContext.trade_currency)}. Waluta prowizji: {tekstWartosci(fxContext.commission_currency)}.
          </p>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300">{t('transactionDossier.review')}</p>
          <p className="mt-1 text-xs text-blue-950 dark:text-blue-100">
            Safe for tax engine: {review.safe_for_tax_engine ? 'tak' : 'nie'}. Review: {review.needs_user_review ? 'tak' : 'nie'}.
          </p>
          {nestedArray(review, 'review_reasons').length > 0 && (
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-200">{nestedArray(review, 'review_reasons').map(String).join(' · ')}</p>
          )}
        </div>
      </div>
      <div className="mt-3 rounded-lg bg-white/70 p-2 text-xs text-blue-950 dark:bg-blue-950/40 dark:text-blue-100">
        <p className="font-semibold">{t('transactionDossier.sources')}</p>
        <p className="mt-1 break-words">{sourceFiles.map(String).join(', ') || '—'}</p>
        <p className="mt-2">Pola ze źródłami: {Object.keys(fieldSources).length}. Konflikty: {conflicts.length}.</p>
      </div>
      <div className="mt-3 rounded-lg bg-white/70 p-2 text-xs text-blue-950 dark:bg-blue-950/40 dark:text-blue-100">
        <p className="font-semibold">{t('transactionDossier.aiContext')}</p>
        {dossierAiContexts.length > 0 ? (
          <div className="mt-2 space-y-2">
            {dossierAiContexts.slice(0, 4).map((context, index) => (
              <div key={`${String(context.source_event_id || 'ai')}-${index}`} className="rounded-md border border-blue-100 bg-blue-50/70 p-2 dark:border-blue-900/60 dark:bg-blue-950/30">
                <div className="flex flex-wrap gap-2">
                  <span className="font-semibold">{tekstWartosci(context.detected_context_type)}</span>
                  <span>{t('transactionDossier.aiContextStatus')}: {tekstWartosci(context.validation_status || context.status)}</span>
                  <span>{t('transactionDossier.aiContextConfidence')}: {tekstWartosci(context.confidence)}</span>
                </div>
                <p className="mt-1">{tekstWartosci(context.summary_pl || context.summary || context.reason)}</p>
                {(context.related_trade_id || context.related_ticker) && (
                  <p className="mt-1 text-blue-700 dark:text-blue-200">
                    {tekstWartosci(context.related_trade_id)} {tekstWartosci(context.related_ticker)}
                  </p>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-1 text-blue-700 dark:text-blue-200">{t('transactionDossier.aiContextEmpty')}</p>
        )}
      </div>
    </section>
  );
}

function renderRowBadge(row: EngineHistoryRow, relationKind: TransactionHistoryTreeNode['relationKind']) {
  const presentation = getTransactionHistoryPresentation(row);
  const overlayBadge = etykietaNakladki(row);
  const isPinned = relationKind === 'pinned';
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${presentation.badgeClassName}`}>
        {presentation.label}
      </span>
      {overlayBadge && (
        <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${overlayBadge.className}`}>
          {overlayBadge.label}
        </span>
      )}
      {isPinned && (
        <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-200">
          <Paperclip size={12} />
          Przypięte
        </span>
      )}
    </div>
  );
}

function statusClassName(kind: HistoryTaxImpactKind): string {
  return {
    PIT_COUNTED: 'text-emerald-700 dark:text-emerald-300',
    SCENARIO_COST: 'text-amber-700 dark:text-amber-300',
    TECHNICAL_ONLY: 'text-slate-600 dark:text-slate-300',
    REVIEW_REQUIRED: 'text-rose-700 dark:text-rose-300',
    ANALYTICAL_ONLY: 'text-cyan-700 dark:text-cyan-300',
  }[kind];
}

function brokerActionStatusLabel(status?: string): string {
  return {
    open: 'Otwarte',
    resolved: 'Rozwiązane',
    ignored: 'Zignorowane',
  }[status || ''] || status || '—';
}

function brokerActionSeverityLabel(severity?: string): string {
  return {
    blocking: 'Kontrola PIT',
    warning: 'Ostrzeżenie',
    info: 'Informacja',
  }[severity || ''] || severity || '—';
}

function brokerActionPanelClassName(severity?: string, status?: string): string {
  if (status === 'resolved') {
    return 'border-emerald-200 bg-emerald-50 dark:border-emerald-900/60 dark:bg-emerald-900/20';
  }
  if (status === 'ignored') {
    return 'border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-900/40';
  }
  if (severity === 'blocking') {
    return 'border-red-200 bg-red-50 dark:border-red-900/60 dark:bg-red-900/20';
  }
  if (severity === 'warning') {
    return 'border-amber-200 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-900/20';
  }
  return 'border-blue-200 bg-blue-50 dark:border-blue-900/60 dark:bg-blue-900/20';
}

function getHistoryRowEvidenceLookupKeys(row: EngineHistoryRow): string[] {
  const keys = [
    row.row_id,
    row.transaction_id,
    row.manual_record_id,
    row.base_record_id,
    row.details?.source_record_id,
    row.details?.edit_record_id,
    ...(row.source_refs || []),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  return Array.from(new Set(keys));
}

function normalizeLookupToken(value?: string | null): string {
  return (value || '').trim().toLowerCase();
}

function buildBrokerActionLookupText(row: EngineHistoryRow): string {
  return [
    row.row_id,
    row.transaction_id,
    row.manual_record_id,
    row.base_record_id,
    row.ticker,
    row.comment,
    row.message,
    row.source_name,
    row.source_manifest_id,
    ...(row.source_refs || []),
    row.details?.source_record_id,
    row.details?.source_manifest_id,
    row.details?.edit_record_id,
    row.details?.search_text,
    row.details ? JSON.stringify(row.details) : '',
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function matchesBrokerActionItem(row: EngineHistoryRow, item: BrokerActionWorkbenchItem): boolean {
  if (item.linkedRowId && item.linkedRowId === row.row_id) {
    return true;
  }
  const lookupText = buildBrokerActionLookupText(row);
  const tokens = [
    item.historySearchTerm,
    ...item.costIds,
    ...item.sourceIds,
  ]
    .map((value) => normalizeLookupToken(value || null))
    .filter(Boolean);
  return tokens.some((token) => lookupText.includes(token));
}

function matchesBrokerActionItems(row: EngineHistoryRow, items: BrokerActionWorkbenchItem[]): boolean {
  return items.some((item) => matchesBrokerActionItem(row, item));
}

interface HistoryEvidencePanelProps {
  items: DefenseWorkbenchItem[];
  evidenceOverrideForItem: (item: DefenseWorkbenchItem) => DefenseEvidenceOverride | null;
  onConfirmEvidence?: (item: DefenseWorkbenchItem) => void;
  onAddEvidenceNote?: (item: DefenseWorkbenchItem) => void;
}

const HistoryEvidencePanel = React.memo(function HistoryEvidencePanel({
  items,
  evidenceOverrideForItem,
  onConfirmEvidence,
  onAddEvidenceNote,
}: HistoryEvidencePanelProps) {
  const confirmedCount = items.filter((item) => (
    item.evidenceConfirmed || evidenceOverrideForItem(item)?.evidenceConfirmed
  )).length;

  return (
    <div
      className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-900/60 dark:bg-amber-900/20"
      data-history-evidence-panel="true"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="font-semibold text-amber-950 dark:text-amber-100">Dowody i PIT</p>
          <p className="text-amber-800 dark:text-amber-200">
            Pozycje checklisty lub ścieżki kwoty powiązane z tym rekordem. Potwierdzenia są lokalne i nie zmieniają kwot PIT.
          </p>
        </div>
        <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-amber-800 dark:bg-gray-900 dark:text-amber-200">
          {confirmedCount}/{items.length} potw.
        </span>
      </div>
      <div className="mt-3 space-y-2">
        {items.map((item) => {
          const localOverride = evidenceOverrideForItem(item);
          const isConfirmed = Boolean(item.evidenceConfirmed || localOverride?.evidenceConfirmed || localOverride?.defenseStatus === 'complete');
          const note = localOverride?.userNote || item.localNote;
          return (
            <div key={item.id} className="rounded-lg border border-amber-200 bg-white p-3 dark:border-amber-900/60 dark:bg-gray-900/50">
              <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-gray-900 dark:text-gray-100">{item.label}</span>
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                      {item.defenseStatusLabel}
                    </span>
                    {isConfirmed && (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">
                        Dowód potwierdzony lokalnie
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-gray-600 dark:text-gray-300">{item.userAction}</p>
                  {item.missingEvidence.length > 0 && (
                    <p className="mt-1 text-xs text-amber-700 dark:text-amber-200">
                      Braki: {item.missingEvidence.join(' · ')}
                    </p>
                  )}
                  {note && (
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Notatka: {note}</p>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {onConfirmEvidence && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onConfirmEvidence(item);
                      }}
                      className="rounded-lg border border-emerald-200 px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-900/20"
                    >
                      Oznacz dowód jako zebrany
                    </button>
                  )}
                  {onAddEvidenceNote && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onAddEvidenceNote(item);
                      }}
                      className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                    >
                      Dodaj notatkę
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});

const HistoryBrokerActionPanel = React.memo(function HistoryBrokerActionPanel({
  items,
}: {
  items: BrokerActionWorkbenchItem[];
}) {
  const openCount = items.filter((item) => item.status === 'open').length;

  return (
    <div
      className="mb-4 rounded-xl border border-indigo-200 bg-indigo-50 p-3 text-sm dark:border-indigo-900/60 dark:bg-indigo-900/20"
      data-history-broker-action-panel="true"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="font-semibold text-indigo-950 dark:text-indigo-100">Sprawy importu</p>
          <p className="text-indigo-800 dark:text-indigo-200">
            Akcje z audytu importu powiązane z tym rekordem. Statusy są lokalne i nie zmieniają kwot PIT.
          </p>
        </div>
        <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-indigo-800 dark:bg-gray-900 dark:text-indigo-200">
          {openCount}/{items.length} otw.
        </span>
      </div>
      <div className="mt-3 space-y-2">
        {items.map((item) => (
          <div key={item.actionId} className={`rounded-lg border p-3 ${brokerActionPanelClassName(item.severity, item.status)}`}>
            <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-gray-900 dark:text-gray-100">{item.label}</span>
                  <span className="rounded-full bg-white px-2 py-0.5 text-xs font-semibold text-gray-700 dark:bg-gray-900 dark:text-gray-200">
                    {brokerActionStatusLabel(item.status)}
                  </span>
                  <span className="rounded-full bg-white px-2 py-0.5 text-xs font-semibold text-gray-700 dark:bg-gray-900 dark:text-gray-200">
                    {brokerActionSeverityLabel(item.severity)}
                  </span>
                </div>
                <p className="mt-1 text-gray-600 dark:text-gray-300">{item.userAction}</p>
                {item.supplementalOnlyBreakdownLabel && (
                  <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-300">
                    Typy rekordów tylko pomocniczych: {item.supplementalOnlyBreakdownLabel}
                  </p>
                )}
                {(item.costIds.length > 0 || item.sourceIds.length > 0) && (
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {item.costIds.length > 0 ? `Koszty: ${item.costIds.join(', ')}` : ''}
                    {item.costIds.length > 0 && item.sourceIds.length > 0 ? ' · ' : ''}
                    {item.sourceIds.length > 0 ? `Źródła: ${item.sourceIds.join(', ')}` : ''}
                  </p>
                )}
                {item.userNote && (
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Notatka: {item.userNote}</p>
                )}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                {item.actionId}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
});

const INITIAL_HISTORY_NODE_LIMIT = 80;
const HISTORY_NODE_PAGE_SIZE = 80;

/**
 * Liczba z silnika albo myslnik. `?? Number(x || 0)` pokazywalo "0 dow. /
 * 0 brak." takze wtedy, gdy silnik tych licznikow w ogole nie policzyl -
 * pewnosc stanu zerowego brala sie z braku danych.
 */
function liczbaLubBrak(wartosc: unknown): string {
  if (wartosc === null || wartosc === undefined || wartosc === '') return '—';
  const liczba = Number(wartosc);
  return Number.isFinite(liczba) ? String(liczba) : '—';
}

export function EngineTransactionHistory({
  rows,
  searchTerm,
  typeFilter,
  historyViewMode = 'all',
  taxImpactFilter = 'all',
  defenseStatusFilter = 'all',
  focusRowId = null,
  pinnedTransactionLinks,
  defenseWorkbenchItems = [],
  defenseEvidenceOverrides = [],
  brokerActionItems = [],
  transactionDossiers = [],
  transactionDossierSummary = {},
  fieldSourceMap = {},
  transactionConflicts = [],
  aiExtractedContext = [],
  actionButtonMode = 'full',
  uiComplexityMode = 'simple',
  showTechnicalRows = false,
  isReadOnly = false,
  readOnlyReason = 'Historia jest w trybie tylko do odczytu.',
  onOpenEditor,
  onPinTransaction,
  onUnpinTransaction,
  onConfirmEvidence,
  onAddEvidenceNote,
  onOpenInsight,
}: EngineTransactionHistoryProps) {
  const { t } = useI18n();
  const [expandedRowId, setExpandedRowId] = useState<string | null>(() => focusRowId || null);
  const [detailDrawerRowId, setDetailDrawerRowId] = useState<string | null>(null);
  const [highlightedRowId, setHighlightedRowId] = useState<string | null>(() => focusRowId || null);
  const rowRefs = useRef(new Map<string, HTMLTableRowElement | null>());
  const [sortConfig, setSortConfig] = useState<{ key: 'display_date' | 'amount_pln'; direction: 'asc' | 'desc' }>({
    key: 'display_date',
    direction: 'desc',
  });
  const [draggingRowId, setDraggingRowId] = useState<string | null>(null);
  const [dropTargetRowId, setDropTargetRowId] = useState<string | null>(null);
  const [selectedPinSourceRowId, setSelectedPinSourceRowId] = useState<string | null>(null);
  const showActionText = actionButtonMode !== 'icon';
  const isExpertMode = uiComplexityMode === 'expert';
  const uiMotion = useUiMotion();

  React.useEffect(() => {
    if (!selectedPinSourceRowId) {
      return;
    }
    const selectedRow = rows.find((row) => row.row_id === selectedPinSourceRowId);
    if (!selectedRow || !isPinnableHistoryRow(selectedRow)) {
      setSelectedPinSourceRowId(null);
      setDraggingRowId(null);
      setDropTargetRowId(null);
    }
  }, [rows, selectedPinSourceRowId]);

  useEffect(() => {
    if (!focusRowId) {
      return;
    }
    const rowExists = rows.some((row) => row.row_id === focusRowId);
    if (!rowExists) {
      return;
    }
    setExpandedRowId(focusRowId);
    setHighlightedRowId(focusRowId);
    if (typeof window !== 'undefined') {
      window.setTimeout(() => {
        rowRefs.current.get(focusRowId)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 0);
    }
  }, [focusRowId, rows]);

  const sortedTree = useMemo(() => {
    return sortTransactionHistoryTree(buildTransactionHistoryTree(rows, pinnedTransactionLinks), sortConfig);
  }, [pinnedTransactionLinks, rows, sortConfig]);

  const filteredTree = useMemo(() => {
    return filterTransactionHistoryTree(sortedTree, {
      searchTerm,
      typeFilter,
      matchesFilter: (row, activeTypeFilter) => (
        (
          historyViewMode === 'candidate'
            ? isCandidatePreviewHistoryRow(row)
            : (
              showTechnicalRows ||
              historyViewMode === 'technical' ||
              historyViewMode === 'import_actions' ||
              historyViewMode === 'all' ||
              getDisplayedHistoryRowPresentation(row).taxImpactKind !== 'TECHNICAL_ONLY'
            )
        ) &&
        (historyViewMode === 'import_actions'
          ? matchesBrokerActionItems(row, brokerActionItems)
          : matchesHistoryViewMode(row, historyViewMode)) &&
        matchesTransactionHistoryFilter(row, activeTypeFilter as TransactionHistoryFilterId) &&
        matchesHistoryTaxImpactFilter(row, taxImpactFilter) &&
        matchesHistoryDefenseStatusFilter(row, defenseStatusFilter)
      ),
    });
  }, [brokerActionItems, defenseStatusFilter, historyViewMode, searchTerm, showTechnicalRows, sortedTree, taxImpactFilter, typeFilter]);

  const flattenedRows = useMemo(() => flattenTransactionHistoryTree(filteredTree), [filteredTree]);
  const [visibleNodeLimit, setVisibleNodeLimit] = useState(INITIAL_HISTORY_NODE_LIMIT);
  const visibleTree = useMemo(
    () => filteredTree.slice(0, visibleNodeLimit),
    [filteredTree, visibleNodeLimit],
  );
  const visibleRows = useMemo(() => flattenTransactionHistoryTree(visibleTree), [visibleTree]);

  useEffect(() => {
    setVisibleNodeLimit(INITIAL_HISTORY_NODE_LIMIT);
  }, [brokerActionItems, defenseStatusFilter, historyViewMode, searchTerm, showTechnicalRows, sortConfig, taxImpactFilter, typeFilter]);

  useEffect(() => {
    if (!focusRowId) {
      return;
    }
    if (flattenedRows.some((row) => row.row_id === focusRowId)) {
      setVisibleNodeLimit(filteredTree.length || INITIAL_HISTORY_NODE_LIMIT);
    }
  }, [filteredTree.length, flattenedRows, focusRowId]);

  const handleHistoryScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    if (target.scrollHeight - target.scrollTop - target.clientHeight > 360) {
      return;
    }
    setVisibleNodeLimit((current) => Math.min(filteredTree.length, current + HISTORY_NODE_PAGE_SIZE));
  }, [filteredTree.length]);

  const toggleSort = (key: 'display_date' | 'amount_pln') => {
    setSortConfig((current) => ({
      key,
      direction: current.key === key && current.direction === 'desc' ? 'asc' : 'desc',
    }));
  };

  const clearPinSelection = () => {
    setSelectedPinSourceRowId(null);
  };

  const toggleRowDetails = (rowId: string) => {
    setExpandedRowId((current) => (current === rowId ? null : rowId));
  };

  const evidenceItemsByLookupKey = useMemo(() => {
    const index = new Map<string, DefenseWorkbenchItem[]>();
    const addToIndex = (key: string | null | undefined, item: DefenseWorkbenchItem) => {
      if (!key) {
        return;
      }
      const existing = index.get(key);
      if (existing) {
        existing.push(item);
      } else {
        index.set(key, [item]);
      }
    };

    for (const item of defenseWorkbenchItems) {
      addToIndex(item.linkedRowId, item);
      addToIndex(item.historyTarget?.rowId, item);
      addToIndex(item.historyTarget?.searchTerm, item);
      addToIndex(item.sourceRecordId, item);
      addToIndex(item.linkedCostId, item);
      addToIndex(item.evidenceId, item);
      addToIndex(item.checklistId, item);
      for (const linkedTradeId of item.linkedTradeIds || []) {
        addToIndex(linkedTradeId, item);
      }
    }

    return index;
  }, [defenseWorkbenchItems]);

  const evidenceOverrideById = useMemo(() => {
    const index = new Map<string, DefenseEvidenceOverride>();
    for (const override of defenseEvidenceOverrides) {
      if (override.evidenceId) {
        index.set(override.evidenceId, override);
      }
    }
    return index;
  }, [defenseEvidenceOverrides]);

  const evidenceItemsByRowId = useMemo(() => {
    const index = new Map<string, DefenseWorkbenchItem[]>();
    for (const row of rows) {
      const matchedItems: DefenseWorkbenchItem[] = [];
      const seenItemIds = new Set<string>();
      for (const rowId of getHistoryRowEvidenceLookupKeys(row)) {
        for (const item of evidenceItemsByLookupKey.get(rowId) || []) {
          if (seenItemIds.has(item.id)) {
            continue;
          }
          seenItemIds.add(item.id);
          matchedItems.push(item);
        }
      }
      if (matchedItems.length > 0) {
        index.set(row.row_id, matchedItems);
      }
    }
    return index;
  }, [evidenceItemsByLookupKey, rows]);

  const brokerActionItemsByRowId = useMemo(() => {
    const index = new Map<string, BrokerActionWorkbenchItem[]>();
    if (brokerActionItems.length === 0) {
      return index;
    }
    for (const row of rows) {
      const matchedItems = brokerActionItems.filter((item) => matchesBrokerActionItem(row, item));
      if (matchedItems.length > 0) {
        index.set(row.row_id, matchedItems);
      }
    }
    return index;
  }, [brokerActionItems, rows]);

  const evidenceOverrideForItem = useCallback((item: DefenseWorkbenchItem): DefenseEvidenceOverride | null => (
    (item.evidenceId ? evidenceOverrideById.get(item.evidenceId) : undefined) ||
    (item.linkedCostId ? evidenceOverrideById.get(item.linkedCostId) : undefined) ||
    (item.checklistId ? evidenceOverrideById.get(item.checklistId) : undefined) ||
    item.localOverride ||
    null
  ), [evidenceOverrideById]);
  const detailDrawerRow = useMemo(
    () => rows.find((row) => row.row_id === detailDrawerRowId) || null,
    [detailDrawerRowId, rows],
  );
  const detailDrawerPresentation = detailDrawerRow ? getDisplayedHistoryRowPresentation(detailDrawerRow) : null;
  const detailDrawerEvidenceItems = detailDrawerRow ? evidenceItemsByRowId.get(detailDrawerRow.row_id) || [] : [];
  const detailDrawerBrokerActions = detailDrawerRow ? brokerActionItemsByRowId.get(detailDrawerRow.row_id) || [] : [];
  const detailDrawerDossier = detailDrawerRow ? findTransactionDossier(detailDrawerRow, transactionDossiers) : null;
  const openHistoryRowDetails = useCallback((row: EngineHistoryRow) => {
    if (!onOpenInsight) {
      setDetailDrawerRowId(row.row_id);
      return;
    }
    const presentation = getDisplayedHistoryRowPresentation(row);
    const instrument = getHistoryInstrumentDisplay(row);
    const rowEvidenceItems = evidenceItemsByRowId.get(row.row_id) || [];
    const rowBrokerActionItems = brokerActionItemsByRowId.get(row.row_id) || [];
    const rowDossier = findTransactionDossier(row, transactionDossiers);
    onOpenInsight({
      type: 'history_row',
      id: row.row_id,
      title: `Rekord: ${instrument.primary}`,
      subtitle: presentation.statusLabel,
      sections: [
        {
          title: 'Co to znaczy',
          content: `Ten wiersz ma wpływ: ${presentation.statusLabel}. Edytowalność i dane techniczne są oddzielone od wpływu na PIT.`,
        },
        {
          title: 'Wpływ na PIT',
          content: row.tax_impact_label || String(row.details?.tax_impact_label || presentation.statusLabel),
        },
        {
          title: 'Co zrobić',
          content: rowEvidenceItems.length > 0 || rowBrokerActionItems.length > 0
            ? 'Sprawdź poniższe dowody lub sprawy importu powiązane z tym rekordem.'
            : 'Nie ma aktywnej akcji dla tego rekordu. Pełne dane techniczne są niżej.',
        },
        {
          title: 'Źródła / szczegóły',
          content: (
            <dl className="space-y-2 text-xs text-gray-600 dark:text-gray-300">
              <div>
                <dt className="font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Data</dt>
                <dd>{formatDisplayDateTime(row.display_date)}</dd>
              </div>
              <div>
                <dt className="font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Źródło</dt>
                <dd>{row.source_name || '—'}</dd>
              </div>
              <div>
                <dt className="font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Kategoria</dt>
                <dd>{row.display_category_label_pl || String(row.details?.display_category_label_pl || row.details?.display_category || '—')}</dd>
              </div>
              <div>
                <dt className="font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Scalenie</dt>
                <dd>
                  {row.dedupe_status === 'merged_from_sources' || row.details?.dedupe_status === 'merged_from_sources'
                    ? 'Rekord scalony z wielu plików'
                    : 'Pojedyncze źródło'}
                </dd>
              </div>
              <div>
                <dt className="font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Lineage</dt>
                <dd>{row.lineage_summary || String(row.details?.lineage_summary || row.source_refs?.join(', ') || '—')}</dd>
              </div>
              <div>
                <dt className="font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Raw ID</dt>
                <dd className="break-all">
                  {String(row.details?.source_record_id || row.transaction_id || row.source_refs?.join(', ') || '—')}
                </dd>
              </div>
              <div>
                <dt className="font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Świat logiczny</dt>
                <dd>{row.logical_world || '—'}</dd>
              </div>
              <div>
                <dt className="font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Komentarz</dt>
                <dd>{row.comment || row.message || '—'}</dd>
              </div>
            </dl>
          ),
        },
      ],
      children: (
        <>
          {rowDossier && (
            <TransactionDossierPanel dossier={rowDossier} aiContexts={aiExtractedContext} t={t} />
          )}
          {rowEvidenceItems.length > 0 && (
            <HistoryEvidencePanel
              items={rowEvidenceItems}
              evidenceOverrideForItem={evidenceOverrideForItem}
              onConfirmEvidence={onConfirmEvidence}
              onAddEvidenceNote={onAddEvidenceNote}
            />
          )}
          {rowBrokerActionItems.length > 0 && (
            <HistoryBrokerActionPanel items={rowBrokerActionItems} />
          )}
          <section>
            <h4 className="text-sm font-semibold text-gray-950 dark:text-white">Pełne dane techniczne</h4>
            <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-gray-900 p-3 text-xs text-gray-100">
              {JSON.stringify(row.details || {}, null, 2)}
            </pre>
          </section>
        </>
      ),
    });
  }, [
    brokerActionItemsByRowId,
    evidenceItemsByRowId,
    evidenceOverrideForItem,
    onAddEvidenceNote,
    onConfirmEvidence,
    onOpenInsight,
    t,
    aiExtractedContext,
    transactionDossiers,
  ]);

  const handleDragStart = (row: EngineHistoryRow) => (event: React.DragEvent<HTMLTableRowElement>) => {
    if (isReadOnly || !isPinnableHistoryRow(row)) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', row.row_id);
    setDraggingRowId(row.row_id);
    setDropTargetRowId(null);
  };

  const handleDragEnd = () => {
    setDraggingRowId(null);
    setDropTargetRowId(null);
  };

  const tryPin = async (childRowId: string, parentRowId: string) => {
    if (isReadOnly) {
      clearPinSelection();
      return;
    }
    if (childRowId === parentRowId) {
      return;
    }
    await onPinTransaction(childRowId, parentRowId);
    if (selectedPinSourceRowId === childRowId) {
      clearPinSelection();
    }
  };

  const renderNode = (node: TransactionHistoryTreeNode, depth: number): React.ReactNode => {
    const row = node.row;
    const presentation = getTransactionHistoryPresentation(row);
    const impactPresentation = getDisplayedHistoryRowPresentation(row);
    const editableKey = typeof row.details?.edit_record_id === 'string'
      ? row.details.edit_record_id
      : row.manual_record_id || row.base_record_id || null;
    const hasDiffs = Boolean(row.is_modified || row.is_new || (row.modified_fields && row.modified_fields.length > 0));
    const canPinSource = isExpertMode && !isReadOnly && isPinnableHistoryRow(row);
    const canEditRow = isExpertMode && !isReadOnly && Boolean(editableKey && row.details?.can_edit === true && row.read_only !== true);
    const uiStatus = impactPresentation.statusLabel;
    const editabilityLabel = impactPresentation.editabilityLabel;
    const isMutedImpact =
      impactPresentation.taxImpactKind === 'TECHNICAL_ONLY' ||
      impactPresentation.taxImpactKind === 'ANALYTICAL_ONLY';
    const canPinTarget =
      canPinSource &&
      selectedPinSourceRowId !== null &&
      selectedPinSourceRowId !== row.row_id &&
      canPinTransaction(rows, pinnedTransactionLinks, selectedPinSourceRowId, row.row_id).allowed;
    const canReceiveDrag =
      draggingRowId !== null &&
      draggingRowId !== row.row_id &&
      canPinSource &&
      canPinTransaction(rows, pinnedTransactionLinks, draggingRowId, row.row_id).allowed;
    const isDragging = draggingRowId === row.row_id;
    const isDropTarget = dropTargetRowId === row.row_id && canReceiveDrag;
    const highlightClassName = highlightedRowId === row.row_id
      ? 'ring-2 ring-blue-400 ring-inset'
      : '';
    const rowClassName =
      depth === 0
        ? `align-top cursor-pointer transition-colors hover:bg-gray-50 dark:hover:bg-gray-700/40 ${
            isDragging ? 'opacity-60' : ''
          } ${isDropTarget ? 'bg-blue-50/80 dark:bg-blue-900/20' : ''} ${
            isMutedImpact ? 'bg-slate-50/50 text-slate-600 dark:bg-slate-900/20 dark:text-slate-300' : ''
          } ${highlightClassName}`
        : `align-top cursor-pointer transition-colors bg-amber-50/60 dark:bg-amber-900/10 ${
            isDragging ? 'opacity-60' : ''
          } ${isDropTarget ? 'bg-blue-50/80 dark:bg-blue-900/20' : ''} ${highlightClassName}`;
    const paddingLeft = `${24 + depth * 22}px`;
    const pinLink = isExpertMode && !isReadOnly ? node.pinnedLink : null;
    const instrumentDisplay = getHistoryInstrumentDisplay(row);
    const rowEvidenceItems = evidenceItemsByRowId.get(row.row_id) || [];
    const rowBrokerActionItems = brokerActionItemsByRowId.get(row.row_id) || [];

    return (
      <React.Fragment key={row.row_id}>
        <motion.tr
          data-motion="history-row"
          {...uiMotion.fadeUp(Math.min(depth, 3) * 0.015)}
          ref={(nodeElement) => {
            if (nodeElement) {
              rowRefs.current.set(row.row_id, nodeElement as HTMLTableRowElement);
            } else {
              rowRefs.current.delete(row.row_id);
            }
          }}
          className={rowClassName}
          draggable={canPinSource}
          onClick={() => {
            if (isExpertMode) {
              toggleRowDetails(row.row_id);
              return;
            }
            openHistoryRowDetails(row);
          }}
          onDragStartCapture={handleDragStart(row)}
          onDragEndCapture={handleDragEnd}
          onDragOver={(event) => {
            if (!canReceiveDrag) {
              return;
            }
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            if (dropTargetRowId !== row.row_id) {
              setDropTargetRowId(row.row_id);
            }
          }}
          onDragLeave={() => {
            if (dropTargetRowId === row.row_id) {
              setDropTargetRowId(null);
            }
          }}
          onDrop={async (event) => {
            if (!canReceiveDrag) {
              return;
            }
            event.preventDefault();
            const sourceRowId = draggingRowId || event.dataTransfer.getData('text/plain');
            if (!sourceRowId || sourceRowId === row.row_id) {
              return;
            }
            await tryPin(sourceRowId, row.row_id);
            setDraggingRowId(null);
            setDropTargetRowId(null);
          }}
        >
          <td
            className="whitespace-nowrap px-6 py-4 text-sm text-gray-900 dark:text-gray-200"
            style={{ paddingLeft }}
          >
            <div className="flex items-center gap-2">
              {depth > 0 && <span className="text-gray-400 dark:text-gray-400">↳</span>}
              <span>{formatDisplayDateTime(row.display_date)}</span>
              {canPinSource && (
                <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:bg-gray-900 dark:text-gray-400">
                  <GripVertical size={12} />
                </span>
              )}
            </div>
          </td>
          <td className="px-6 py-4 whitespace-nowrap">
            {renderRowBadge(row, node.relationKind)}
          </td>
          <td className="px-6 py-4 text-sm font-medium text-gray-900 dark:text-gray-100">
            <div>{instrumentDisplay.primary}</div>
            <div className="text-xs text-gray-500 dark:text-gray-400">{instrumentDisplay.secondary || row.manual_record_id || '-'}</div>
          </td>
          {isExpertMode && (
            <td className="px-6 py-4 whitespace-nowrap text-right text-sm text-gray-900 dark:text-gray-200">
              {formatQuantity(row.quantity)}
            </td>
          )}
          {isExpertMode && (
            <td className="px-6 py-4 whitespace-nowrap text-right text-sm text-gray-900 dark:text-gray-200">
              {formatMoney(row.amount, row.currency || '?')}
            </td>
          )}
          <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium text-gray-900 dark:text-gray-100">
            {formatMoney(row.amount_pln, 'PLN')}
          </td>
          <td className="px-6 py-4 text-sm">
            <div className="flex flex-col items-start gap-1">
              <span className={`font-medium ${statusClassName(impactPresentation.taxImpactKind)}`}>
                {uiStatus}
              </span>
              {isExpertMode ? (
                <span className="text-xs text-gray-500 dark:text-gray-400">{editabilityLabel}</span>
              ) : (
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {row.defense_status || String(row.details?.defense_status || 'Szczegóły w panelu')}
                </span>
              )}
              {isExpertMode && row.row_kind === 'ALLOCATED_COST' && (
                <span className="text-xs text-amber-700 dark:text-amber-300">
                  {row.allocation_ratio ? `Udział: ${formatQuantity(row.allocation_ratio)}` : 'Przypisany przez silnik'}
                </span>
              )}
              {isExpertMode && row.row_kind === 'PRIVATE_CASH_FX' && (
                <span className="text-xs text-cyan-700 dark:text-cyan-300">Przewalutowanie z widoku FX</span>
              )}
              {isExpertMode && node.relationKind === 'pinned' && (
                <span className="text-xs text-slate-500 dark:text-slate-400">Przypięte lokalnie</span>
              )}
            </div>
          </td>
          <td className="px-6 py-4 text-right text-sm">
            <div className="flex flex-wrap justify-end gap-2">
              {isReadOnly && depth === 0 && (
                <span
                  title={readOnlyReason}
                  className="inline-flex items-center rounded-lg border border-emerald-200 px-3 py-1.5 text-xs font-semibold text-emerald-700 dark:border-emerald-800 dark:text-emerald-300"
                >
                  Tylko odczyt
                </span>
              )}
              {canEditRow && (
                <button
                  type="button"
                  title="Edytuj"
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenEditor(editableKey);
                  }}
                  className="inline-flex items-center gap-1 rounded-lg border border-blue-200 px-3 py-1.5 text-xs font-semibold text-blue-700 transition-colors hover:bg-blue-50 dark:border-blue-800 dark:text-blue-300 dark:hover:bg-blue-900/20"
                >
                  <PencilLine size={14} />
                  <span className={showActionText ? '' : 'sr-only'}>Edytuj</span>
                </button>
              )}
              {canPinSource && selectedPinSourceRowId !== row.row_id && (
                <button
                  type="button"
                  title="Przypnij"
                  onClick={(event) => {
                    event.stopPropagation();
                    setSelectedPinSourceRowId(row.row_id);
                  }}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  <Paperclip size={14} />
                  <span className={showActionText ? '' : 'sr-only'}>Przypnij</span>
                </button>
              )}
              {selectedPinSourceRowId === row.row_id && (
                <button
                  type="button"
                  title="Anuluj"
                  onClick={(event) => {
                    event.stopPropagation();
                    clearPinSelection();
                  }}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  <X size={14} />
                  <span className={showActionText ? '' : 'sr-only'}>Anuluj</span>
                </button>
              )}
              {selectedPinSourceRowId && selectedPinSourceRowId !== row.row_id && canPinTarget && (
                <button
                  type="button"
                  title="Przypnij tutaj"
                  onClick={(event) => {
                    event.stopPropagation();
                    tryPin(selectedPinSourceRowId, row.row_id);
                  }}
                  className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 px-3 py-1.5 text-xs font-semibold text-emerald-700 transition-colors hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-900/20"
                >
                  <GripVertical size={14} />
                  <span className={showActionText ? '' : 'sr-only'}>Przypnij tutaj</span>
                </button>
              )}
              {pinLink && (
                <button
                  type="button"
                  title="Odepnij"
                  onClick={(event) => {
                    event.stopPropagation();
                    onUnpinTransaction(row.row_id);
                  }}
                  className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900"
                >
                  <X size={14} />
                  <span className={showActionText ? '' : 'sr-only'}>Odepnij</span>
                </button>
              )}
              <button
                type="button"
                title={hasDiffs ? 'Pokaż różnice i szczegóły' : 'Pokaż szczegóły'}
                onClick={(event) => {
                  event.stopPropagation();
                  openHistoryRowDetails(row);
                }}
                className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900"
              >
                <Eye size={14} />
                <span className={isExpertMode ? (showActionText ? '' : 'sr-only') : ''}>
                  {hasDiffs ? 'Różnice' : 'Szczegóły'}
                </span>
              </button>
            </div>
          </td>
        </motion.tr>
        {isExpertMode && expandedRowId === row.row_id && (
          <tr className="bg-blue-50/50 dark:bg-blue-900/10">
            <td colSpan={8} className="px-6 py-4">
              <div className="mb-4 rounded-xl border border-blue-200 bg-white p-3 text-sm dark:border-blue-800/50 dark:bg-gray-900/60">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="font-semibold text-gray-900 dark:text-gray-100">Szybki podgląd rekordu</p>
                    <p className="text-gray-500 dark:text-gray-400">
                      Źródło, komentarz, surowe identyfikatory, status edycji oraz dane pomocnicze z silnika.
                    </p>
                  </div>
                  <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                    {impactPresentation.statusLabel}
                  </span>
                </div>
              </div>
              {rowEvidenceItems.length > 0 && (
                <HistoryEvidencePanel
                  items={rowEvidenceItems}
                  evidenceOverrideForItem={evidenceOverrideForItem}
                  onConfirmEvidence={onConfirmEvidence}
                  onAddEvidenceNote={onAddEvidenceNote}
                />
              )}
              {rowBrokerActionItems.length > 0 && (
                <HistoryBrokerActionPanel items={rowBrokerActionItems} />
              )}
              <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
                <div>
                  <h4 className="mb-2 text-sm font-semibold text-gray-900 dark:text-gray-100">Dane z silnika</h4>
                  <dl className="grid grid-cols-1 gap-y-2 text-sm">
                    <div className="grid grid-cols-[140px,1fr] gap-3">
                      <dt className="text-gray-500 dark:text-gray-400">Komentarz</dt>
                      <dd className="font-medium text-gray-900 dark:text-gray-200">{row.comment || '—'}</dd>
                    </div>
                    <div className="grid grid-cols-[140px,1fr] gap-3">
                      <dt className="text-gray-500 dark:text-gray-400">Wiadomość</dt>
                      <dd className="font-medium text-gray-900 dark:text-gray-200">{row.message || '—'}</dd>
                    </div>
                    <div className="grid grid-cols-[140px,1fr] gap-3">
                      <dt className="text-gray-500 dark:text-gray-400">Źródło</dt>
                      <dd className="font-medium text-gray-900 dark:text-gray-200">{row.source_name || '—'}</dd>
                    </div>
                    <div className="grid grid-cols-[140px,1fr] gap-3">
                      <dt className="text-gray-500 dark:text-gray-400">Manifest źródła</dt>
                      <dd className="font-medium text-gray-900 dark:text-gray-200">
                        {row.source_manifest_id || String(row.details?.source_manifest_id || '—')}
                      </dd>
                    </div>
                    <div className="grid grid-cols-[140px,1fr] gap-3">
                      <dt className="text-gray-500 dark:text-gray-400">Konflikty źródeł</dt>
                      <dd className="font-medium text-gray-900 dark:text-gray-200">
                        {liczbaLubBrak(row.conflict_count ?? row.details?.conflict_count)}
                      </dd>
                    </div>
                    <div className="grid grid-cols-[140px,1fr] gap-3">
                      <dt className="text-gray-500 dark:text-gray-400">Wpływ na PIT</dt>
                      <dd className="font-medium text-gray-900 dark:text-gray-200">
                        {impactPresentation.statusLabel}
                      </dd>
                    </div>
                    <div className="grid grid-cols-[140px,1fr] gap-3">
                      <dt className="text-gray-500 dark:text-gray-400">Typ wpływu</dt>
                      <dd className="font-medium text-gray-900 dark:text-gray-200">{impactPresentation.taxImpactKind}</dd>
                    </div>
                    <div className="grid grid-cols-[140px,1fr] gap-3">
                      <dt className="text-gray-500 dark:text-gray-400">Status dowodowy</dt>
                      <dd className="font-medium text-gray-900 dark:text-gray-200">
                        {row.defense_status || String(row.details?.defense_status || '—')}
                      </dd>
                    </div>
                    <div className="grid grid-cols-[140px,1fr] gap-3">
                      <dt className="text-gray-500 dark:text-gray-400">Dowody / braki</dt>
                      <dd className="font-medium text-gray-900 dark:text-gray-200">
                        {liczbaLubBrak(row.evidence_count ?? row.details?.evidence_count)} dow. /{' '}
                        {liczbaLubBrak(row.missing_evidence_count ?? row.details?.missing_evidence_count)} brak.
                      </dd>
                    </div>
                    <div className="grid grid-cols-[140px,1fr] gap-3">
                      <dt className="text-gray-500 dark:text-gray-400">Dlaczego</dt>
                      <dd className="font-medium text-gray-900 dark:text-gray-200">
                        {row.tax_impact_label || String(row.details?.tax_impact_label || impactPresentation.statusLabel)}
                      </dd>
                    </div>
                    <div className="grid grid-cols-[140px,1fr] gap-3">
                      <dt className="text-gray-500 dark:text-gray-400">Świat logiczny</dt>
                      <dd className="font-medium text-gray-900 dark:text-gray-200">{row.logical_world || '—'}</dd>
                    </div>
                    <div className="grid grid-cols-[140px,1fr] gap-3">
                      <dt className="text-gray-500 dark:text-gray-400">Raw ID</dt>
                      <dd className="font-medium text-gray-900 dark:text-gray-200">
                        {String(row.details?.source_record_id || row.transaction_id || row.source_refs?.join(', ') || '—')}
                      </dd>
                    </div>
                    <div className="grid grid-cols-[140px,1fr] gap-3">
                      <dt className="text-gray-500 dark:text-gray-400">Id warstwy B</dt>
                      <dd className="font-medium text-gray-900 dark:text-gray-200">{row.manual_record_id || '—'}</dd>
                    </div>
                    <div className="grid grid-cols-[140px,1fr] gap-3">
                      <dt className="text-gray-500 dark:text-gray-400">Id bazowe</dt>
                      <dd className="font-medium text-gray-900 dark:text-gray-200">{row.base_record_id || '—'}</dd>
                    </div>
                  </dl>
                </div>
                <div>
                  <h4 className="mb-2 text-sm font-semibold text-gray-900 dark:text-gray-100">Różnice i alokacje</h4>
                  {row.modified_fields && row.modified_fields.length > 0 ? (
                    <div className="space-y-2">
                      {row.modified_fields.map((fieldName) => (
                        <div key={fieldName} className="rounded-xl border border-gray-200 bg-white p-3 text-sm dark:border-gray-700 dark:bg-gray-900/40">
                          <p className="font-semibold text-gray-900 dark:text-gray-100">{fieldName}</p>
                          <div className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
                            <div>
                              <p className="mb-1 font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Wersja z silnika</p>
                              <div className="rounded-lg bg-gray-50 px-2 py-1.5 text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                                {tekstWartosci(row.original_snapshot?.[fieldName])}
                              </div>
                            </div>
                            <div>
                              <p className="mb-1 font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Wersja po zmianie</p>
                              <div className="rounded-lg bg-blue-50 px-2 py-1.5 text-blue-700 dark:bg-blue-900/20 dark:text-blue-300">
                                {tekstWartosci(row.current_snapshot?.[fieldName])}
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-gray-500 dark:text-gray-400">Ten rekord nie ma ręcznych różnic do pokazania.</p>
                  )}
                  {row.row_kind === 'ALLOCATED_COST' && (
                    <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800/50 dark:bg-amber-900/20 dark:text-amber-200">
                      <p className="font-semibold">Koszt przypisany przez silnik</p>
                      <dl className="mt-2 grid gap-2">
                        <div className="grid grid-cols-[170px,1fr] gap-3">
                          <dt>Źródło kosztu</dt>
                          <dd className="font-medium">{row.transaction_id || row.source_refs?.join(', ') || '—'}</dd>
                        </div>
                        <div className="grid grid-cols-[170px,1fr] gap-3">
                          <dt>Kwota źródłowa</dt>
                          <dd className="font-medium">{formatMoney(row.amount, row.currency || '?')}</dd>
                        </div>
                        <div className="grid grid-cols-[170px,1fr] gap-3">
                          <dt>Część alokowana PLN</dt>
                          <dd className="font-medium">{formatMoney(row.amount_pln, 'PLN')}</dd>
                        </div>
                        <div className="grid grid-cols-[170px,1fr] gap-3">
                          <dt>Udział alokacji</dt>
                          <dd className="font-medium">{row.allocation_ratio ? formatQuantity(row.allocation_ratio) : '—'}</dd>
                        </div>
                        <div className="grid grid-cols-[170px,1fr] gap-3">
                          <dt>Metoda</dt>
                          <dd className="font-medium">{row.allocation_method || '—'}</dd>
                        </div>
                      </dl>
                    </div>
                  )}
                </div>
                <div>
                  <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
                    <Info size={14} />
                    Wynik i proveniencja
                  </h4>
                  <dl className="grid grid-cols-1 gap-y-2 text-sm">
                    <div className="grid grid-cols-[160px,1fr] gap-3">
                      <dt className="text-gray-500 dark:text-gray-400">Wynik PIT</dt>
                      <dd className="font-medium text-gray-900 dark:text-gray-200">{formatMoney(row.pit_result_pln, 'PLN')}</dd>
                    </div>
                    <div className="grid grid-cols-[160px,1fr] gap-3">
                      <dt className="text-gray-500 dark:text-gray-400">Wynik ekonomiczny</dt>
                      <dd className="font-medium text-gray-900 dark:text-gray-200">{formatMoney(row.economic_result_pln, 'PLN')}</dd>
                    </div>
                    <div className="grid grid-cols-[160px,1fr] gap-3">
                      <dt className="text-gray-500 dark:text-gray-400">Wartość przyznania PLN</dt>
                      <dd className="font-medium text-gray-900 dark:text-gray-200">{formatMoney(row.grant_value_pln, 'PLN')}</dd>
                    </div>
                    <div className="grid grid-cols-[160px,1fr] gap-3">
                      <dt className="text-gray-500 dark:text-gray-400">Referencje źródłowe</dt>
                      <dd className="font-medium text-gray-900 dark:text-gray-200">{row.source_refs?.join(', ') || '—'}</dd>
                    </div>
                  </dl>
                  <pre className="mt-3 overflow-x-auto rounded-lg bg-gray-900 p-3 text-xs text-gray-100">{JSON.stringify(row.details || {}, null, 2)}</pre>
                </div>
              </div>
            </td>
          </tr>
        )}
        {node.children.map((child) => renderNode(child, depth + 1))}
      </React.Fragment>
    );
  };

  return (
    <>
    <div
      className="ia-history-scroll custom-scrollbar max-h-[78vh] w-full overflow-auto"
      onScroll={handleHistoryScroll}
      data-rendered-rows={visibleRows.length}
      data-total-rows={flattenedRows.length}
    >
      {isReadOnly && (
        <div className="border-b border-emerald-100 bg-emerald-50 px-6 py-3 text-sm text-emerald-800 dark:border-emerald-900/40 dark:bg-emerald-900/10 dark:text-emerald-200">
          <span className="font-semibold">Tryb tylko do odczytu.</span> {readOnlyReason}
        </div>
      )}
      {selectedPinSourceRowId && (
        <div className="border-b border-blue-100 bg-blue-50 px-6 py-3 text-sm text-blue-800 dark:border-blue-900/40 dark:bg-blue-900/10 dark:text-blue-200">
          Tryb przypinania aktywny. Przeciągnij wybraną transakcję na inny wiersz albo użyj przycisku „Przypnij tutaj”.
        </div>
      )}
      <table className="min-w-full w-full divide-y divide-gray-200 dark:divide-gray-700">
        <thead className="sticky top-0 z-10 bg-gray-50 dark:bg-gray-900/95">
          <tr>
            <th
              className="cursor-pointer px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400"
              onClick={() => toggleSort('display_date')}
            >
              <div className="flex items-center gap-1">
                Data
                {sortConfig.key === 'display_date' && (sortConfig.direction === 'asc' ? <ArrowUp size={14} /> : <ArrowDown size={14} />)}
              </div>
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Typ</th>
            <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Instrument</th>
            {isExpertMode && <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Ilość</th>}
            {isExpertMode && <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Kwota</th>}
            <th
              className="cursor-pointer px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400"
              onClick={() => toggleSort('amount_pln')}
            >
              <div className="flex items-center justify-end gap-1">
                Kwota
                {sortConfig.key === 'amount_pln' && (sortConfig.direction === 'asc' ? <ArrowUp size={14} /> : <ArrowDown size={14} />)}
              </div>
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">{t('history.pitImpact')} / {t('history.status').toLowerCase()}</th>
            <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">{t('history.details')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200 bg-white dark:divide-gray-700 dark:bg-gray-800">
          {flattenedRows.length > 0 && visibleTree.map((node) => renderNode(node, 0))}
        </tbody>
      </table>
      {/* Pod tabela, a nie w jej wierszu: tabela jest szersza od telefonu, a blok
          w kontenerze przewijania ma szerokosc widocznego obszaru, wiec
          wysrodkowany tekst i przycisk nie uciekaja poza ekran. */}
      {flattenedRows.length > 0 && visibleNodeLimit < filteredTree.length && (
        <div className="px-6 py-4 text-center text-sm text-gray-500 dark:text-gray-400 border-t border-gray-200 dark:border-gray-700">
          <button
            type="button"
            onClick={() => setVisibleNodeLimit((current) => Math.min(filteredTree.length, current + HISTORY_NODE_PAGE_SIZE))}
            className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-900"
          >
            Pokaż kolejne wiersze ({visibleRows.length}/{flattenedRows.length})
          </button>
        </div>
      )}
      {flattenedRows.length === 0 && (
        <div className="px-6 py-10 text-center text-sm text-gray-500 dark:text-gray-400 bg-white dark:bg-gray-800">
          Brak wierszy historii z autorytatywnego silnika Python dla wybranego roku i filtrów.
        </div>
      )}
    </div>
    <InsightDrawer
      open={Boolean(detailDrawerRow) && !onOpenInsight}
      title={detailDrawerRow ? `Rekord: ${getHistoryInstrumentDisplay(detailDrawerRow).primary}` : t('history.details')}
      subtitle={detailDrawerPresentation?.statusLabel}
      onClose={() => setDetailDrawerRowId(null)}
    >
      {detailDrawerRow && detailDrawerPresentation && (
        <>
          <section>
            <h4 className="text-sm font-semibold text-gray-950 dark:text-white">{t('drawer.whatItMeans')}</h4>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
              Ten wiersz ma wpływ: {detailDrawerPresentation.statusLabel}. Edytowalność i dane techniczne są oddzielone od wpływu na PIT.
            </p>
          </section>
          {detailDrawerDossier && (
            <TransactionDossierPanel dossier={detailDrawerDossier} aiContexts={aiExtractedContext} t={t} />
          )}
          <section className="rounded-xl border border-gray-200 bg-gray-50 p-3 text-sm dark:border-gray-700 dark:bg-gray-900/70">
            <h4 className="font-semibold text-gray-950 dark:text-white">Dane z silnika</h4>
            <dl className="mt-2 space-y-2 text-xs text-gray-600 dark:text-gray-300">
              <div>
                <dt className="font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Data</dt>
                <dd>{formatDisplayDateTime(detailDrawerRow.display_date)}</dd>
              </div>
                <div>
                  <dt className="font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Źródło</dt>
                  <dd>{detailDrawerRow.source_name || '—'}</dd>
                </div>
                <div>
                  <dt className="font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Kategoria</dt>
                  <dd>{detailDrawerRow.display_category_label_pl || String(detailDrawerRow.details?.display_category_label_pl || detailDrawerRow.details?.display_category || '—')}</dd>
                </div>
                <div>
                  <dt className="font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Scalenie</dt>
                  <dd>
                    {detailDrawerRow.dedupe_status === 'merged_from_sources' || detailDrawerRow.details?.dedupe_status === 'merged_from_sources'
                      ? 'Rekord scalony z wielu plików'
                      : 'Pojedyncze źródło'}
                  </dd>
                </div>
                <div>
                  <dt className="font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Lineage</dt>
                  <dd>{detailDrawerRow.lineage_summary || String(detailDrawerRow.details?.lineage_summary || detailDrawerRow.source_refs?.join(', ') || '—')}</dd>
                </div>
                <div>
                  <dt className="font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Raw ID</dt>
                <dd className="break-all">
                  {String(detailDrawerRow.details?.source_record_id || detailDrawerRow.transaction_id || detailDrawerRow.source_refs?.join(', ') || '—')}
                </dd>
              </div>
              <div>
                <dt className="font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Świat logiczny</dt>
                <dd>{detailDrawerRow.logical_world || '—'}</dd>
              </div>
              <div>
                <dt className="font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Komentarz</dt>
                <dd>{detailDrawerRow.comment || detailDrawerRow.message || '—'}</dd>
              </div>
            </dl>
          </section>
          {detailDrawerEvidenceItems.length > 0 && (
            <HistoryEvidencePanel
              items={detailDrawerEvidenceItems}
              evidenceOverrideForItem={evidenceOverrideForItem}
              onConfirmEvidence={onConfirmEvidence}
              onAddEvidenceNote={onAddEvidenceNote}
            />
          )}
          {detailDrawerBrokerActions.length > 0 && (
            <HistoryBrokerActionPanel items={detailDrawerBrokerActions} />
          )}
          <section>
            <h4 className="text-sm font-semibold text-gray-950 dark:text-white">Pełne dane techniczne</h4>
            <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-gray-900 p-3 text-xs text-gray-100">
              {JSON.stringify(detailDrawerRow.details || {}, null, 2)}
            </pre>
          </section>
        </>
      )}
    </InsightDrawer>
    </>
  );
}
