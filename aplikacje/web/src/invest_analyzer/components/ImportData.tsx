import React, { useDeferredValue, useEffect, useMemo, useState, useRef } from 'react';
import { odmienLiczebnik } from '../../portfel/services/odmianaLiczebnika';
import { motion } from 'motion/react';
import { FileInfo, LogEntry } from '../types';
import { Upload, FileSpreadsheet, AlertCircle, CheckCircle2, Loader2, FileText, Bot, RefreshCw, ShieldCheck, MapPinned } from 'lucide-react';
import type { TaxFilingPackageAuditAppendix } from '../hooks/useTaxEngineRun';
import { buildBrokerFileIntakeSummary, type BrokerFileIntakeActionRow } from '../services/brokerFileIntake';
import type { BrokerFileActionOverride } from '../services/brokerFileActionOverrides';
import type { UiComplexityMode } from '../services/uiPreferences';
import { getErrorMessage } from '../services/errorMessage';
import { buildPitTrustViewModel } from '../services/pitTrustView';
import { InsightDrawer, type OpenInsightDrawer } from './cockpit/CockpitUi';
import { useUiMotion } from './cockpit/uiMotion';
import { useI18n } from '../services/i18n';
import { runtimeApi } from '../services/runtimeApi';
import { normalizeImportFile, safeImportFileName } from '../services/importFileName';
import type { OllamaRuntimeStatus } from '../services/runtimeApi.types';
import { buildImportIntelligenceView, type ImportSourceCard } from '../services/importIntelligenceView';
import { ENGINE_TIMEOUT_MS } from '../constants';

interface ImportDataProps {
  onImportComplete: (files: FileInfo[], logs: LogEntry[]) => void;
  auditAppendix?: TaxFilingPackageAuditAppendix | null;
  files?: FileInfo[];
  processedStorageFiles?: string[];
  brokerFileActionOverrides?: BrokerFileActionOverride[];
  onResolveBrokerFileAction?: (action: BrokerFileIntakeActionRow, note?: string) => void;
  onIgnoreBrokerFileAction?: (action: BrokerFileIntakeActionRow, note: string) => void;
  onOpenHistorySearch?: (query: string, linkedRowId?: string | null) => void;
  onOpenCandidateTransactions?: (sourceId?: string | null) => void;
  onOpenStorageHistory?: () => void;
  uiComplexityMode?: UiComplexityMode;
  onOpenInsight?: OpenInsightDrawer;
  selectedYear?: number;
}

type SourceFilter = 'all' | 'tax' | 'evidence' | 'problems' | 'new_storage';
type ActionFilter = 'open' | 'review' | 'warning' | 'resolved' | 'ignored';
type ImportInsight =
  | { type: 'source'; sourceId: string }
  | { type: 'action'; actionId: string };

type ImportFileResult = {
  fileInfo: FileInfo;
  logs: LogEntry[];
};

type SupplementalImportDisposition = {
  recordType: string;
  message: string;
  status: 'success' | 'warning';
};

const STATUS_LABELS: Record<string, string> = {
  complete: 'kompletne',
  partial: 'częściowe',
  missing: 'brak',
  conflict: 'konflikt',
  not_applicable: 'nie dotyczy',
};

const SOURCE_FILTERS: Array<{ id: SourceFilter; label: string }> = [
  { id: 'all', label: 'Wszystkie' },
  { id: 'tax', label: 'Transakcyjne' },
  { id: 'evidence', label: 'Tylko dowody' },
  { id: 'problems', label: 'Z problemami' },
  { id: 'new_storage', label: 'Nowe w storage' },
];

const ACTION_SEVERITY_LABELS: Record<string, string> = {
  review: 'kontrola danych',
  warning: 'ostrzeżenie',
  info: 'informacja',
};

const ACTION_FILTERS: Array<{ id: ActionFilter; label: string }> = [
  { id: 'open', label: 'Otwarte' },
  { id: 'review', label: 'Kontrola danych' },
  { id: 'warning', label: 'Ostrzeżenia' },
  { id: 'resolved', label: 'Rozwiązane' },
  { id: 'ignored', label: 'Zignorowane' },
];

const RECONCILIATION_STATUS_LABELS: Record<string, string> = {
  matched: 'zgodne z głównym źródłem',
  partial: 'wymaga kontroli',
  duplicate: 'duplikat',
  fallback_only: 'tylko w fallbacku',
  needs_review: 'wymaga kontroli',
};

const isReviewSeverity = (severity: string): boolean => !['warning', 'info'].includes(String(severity || '').toLowerCase());
const actionSeverityLabel = (severity: string): string => (
  isReviewSeverity(severity)
    ? ACTION_SEVERITY_LABELS.review
    : ACTION_SEVERITY_LABELS[severity] || severity
);

const SOURCE_PROMOTION_DECISION_LABELS: Record<string, string> = {
  approved: 'zatwierdzony',
  revoked: 'cofnięty',
  rejected: 'nieuwzględniony',
  needs_review: 'do kontroli',
};

type SourceManagerRow = ImportSourceCard;
type CanonicalRecordGroupId = 'ready' | 'incomplete' | 'informational' | 'unrecognized';
type CanonicalRecordFilter = CanonicalRecordGroupId | 'all';

type CanonicalInspectionEvent = {
  key: string;
  group: CanonicalRecordGroupId;
  groupLabel: string;
  groupTone: 'green' | 'yellow' | 'gray' | 'red';
  eventId: string;
  eventKind: string;
  sourceFile: string;
  sourceRef: string;
  dateLabel: string;
  operationLabel: string;
  tickerLabel: string;
  validationErrors: string[];
  warnings: string[];
  rawPayload: unknown;
  rawPayloadText: string;
  searchText: string;
};

const CANONICAL_RECORD_GROUPS: Array<{
  id: CanonicalRecordGroupId;
  label: string;
  shortLabel: string;
  description: string;
  tone: CanonicalInspectionEvent['groupTone'];
}> = [
  {
    id: 'ready',
    label: 'Gotowe rekordy',
    shortLabel: 'Gotowe',
    description: 'Rekordy kompletne technicznie, które adapter może przekazać do obliczeń.',
    tone: 'green',
  },
  {
    id: 'incomplete',
    label: 'Niepełne rekordy',
    shortLabel: 'Niepełne',
    description: 'Dane zachowane z diagnostyką braków lub błędów mapowania.',
    tone: 'yellow',
  },
  {
    id: 'informational',
    label: 'Informacyjne',
    shortLabel: 'Info',
    description: 'Zdarzenia pomocnicze, dowody, cash flow i kontekst.',
    tone: 'gray',
  },
  {
    id: 'unrecognized',
    label: 'Nierozpoznane rekordy',
    shortLabel: 'Raw',
    description: 'Dane zachowane bez mapowania, żeby nic nie zginęło.',
    tone: 'red',
  },
];

const asPlainRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

const asSourceNumber = (value: unknown): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : 0
);

const asUnknownArray = (value: unknown): unknown[] => (
  Array.isArray(value) ? value : []
);

const firstText = (...values: unknown[]): string => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
};

const stringList = (...values: unknown[]): string[] => values.flatMap((value) => {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry)))
      .filter((entry) => entry && entry !== 'null' && entry !== 'undefined');
  }
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
});

const safeJsonText = (value: unknown, maxLength = 16000): string => {
  try {
    const text = JSON.stringify(value ?? null, null, 2);
    return text.length > maxLength ? `${text.slice(0, maxLength)}\n... [ucięto podgląd]` : text;
  } catch {
    return String(value ?? '');
  }
};

const getCanonicalRecordStream = (canonicalTaxInput: Record<string, unknown>): unknown[] => {
  const records = canonicalTaxInput.records;
  if (Array.isArray(records)) return records;
  const legacyRecords = asPlainRecord(records);
  return [
    ...asUnknownArray(legacyRecords[['tax', 'active', 'events'].join('_')]).map((event) => ({ ...(asPlainRecord(event)), canonical_record_status: 'ready' })),
    ...asUnknownArray(legacyRecords[['needs', 'review', 'events'].join('_')]).map((event) => ({ ...(asPlainRecord(event)), canonical_record_status: 'incomplete' })),
    ...asUnknownArray(legacyRecords[['info', 'only', 'events'].join('_')]).map((event) => ({ ...(asPlainRecord(event)), canonical_record_status: 'informational' })),
    ...asUnknownArray(legacyRecords[['unrecognized', 'rows'].join('_')]).map((event) => ({ ...(asPlainRecord(event)), canonical_record_status: 'unrecognized' })),
  ];
};

const toCanonicalInspectionEvent = (
  rawEvent: unknown,
  groupMeta: (typeof CANONICAL_RECORD_GROUPS)[number],
  index: number,
): CanonicalInspectionEvent => {
  const event = asPlainRecord(rawEvent);
  const source = asPlainRecord(event.source);
  const identity = asPlainRecord(event.identity);
  const date = asPlainRecord(event.date);
  const instrument = asPlainRecord(event.instrument);
  const amounts = asPlainRecord(event.amounts);
  const status = asPlainRecord(event.status);
  const raw = asPlainRecord(event.raw);
  const coreTrade = asPlainRecord(event.core_trade);
  const rawPayload = raw.raw_payload ?? event.raw_payload ?? rawEvent;
  const validationErrors = stringList(
    event.validation_errors,
    status.validation_errors,
    event.errors,
    raw.error,
  );
  const warnings = stringList(event.warnings, status.warnings, raw.warnings);
  const sourceFile = firstText(
    source.filename,
    source.relative_path,
    source.file_name,
    event.source_filename,
    event.original_filename,
    'canonical_tax_input.json',
  );
  const sourceRef = [
    firstText(source.sheet, event.source_sheet),
    firstText(source.row, event.source_row_ref),
    firstText(source.json_path),
  ].filter(Boolean).join(' · ');
  const eventId = firstText(
    event.event_id,
    event.candidate_id,
    identity.trade_id,
    identity.order_id,
    identity.transaction_id,
    `${groupMeta.id}-${index + 1}`,
  );
  const eventKind = firstText(event.event_kind, event.record_kind, event.kind, 'unknown');
  const operationLabel = firstText(
    coreTrade.operation,
    event.operation,
    event.operation_type,
    event.type,
    eventKind,
  );
  const tickerLabel = firstText(
    instrument.ticker,
    instrument.isin,
    instrument.name,
    event.ticker,
    event.isin,
    event.instrument_name,
    'brak instrumentu',
  );
  const dateLabel = firstText(
    date.datetime,
    date.trade_date,
    date.settlement_date,
    date.pay_date,
    event.date,
    event.trade_date,
    'brak daty',
  );
  const currencyLabel = firstText(amounts.currency, amounts.commission_currency, event.currency);
  const rawPayloadText = safeJsonText(rawPayload);
  const searchText = [
    groupMeta.label,
    eventId,
    eventKind,
    sourceFile,
    sourceRef,
    dateLabel,
    operationLabel,
    tickerLabel,
    currencyLabel,
    validationErrors.join(' '),
    warnings.join(' '),
    rawPayloadText.slice(0, 4000),
  ].join(' ').toLowerCase();

  return {
    key: `${groupMeta.id}:${eventId}:${index}`,
    group: groupMeta.id,
    groupLabel: groupMeta.label,
    groupTone: groupMeta.tone,
    eventId,
    eventKind,
    sourceFile,
    sourceRef,
    dateLabel,
    operationLabel,
    tickerLabel,
    validationErrors,
    warnings,
    rawPayload,
    rawPayloadText,
    searchText,
  };
};

const groupToneClasses = (tone: CanonicalInspectionEvent['groupTone'], selected = false) => {
  const classes = {
    green: selected
      ? 'border-emerald-400 bg-emerald-50 text-emerald-950 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-100'
      : 'border-emerald-100 bg-white text-gray-900 hover:border-emerald-300 hover:bg-emerald-50 dark:border-emerald-900/50 dark:bg-gray-900 dark:text-white dark:hover:bg-emerald-950/30',
    yellow: selected
      ? 'border-amber-400 bg-amber-50 text-amber-950 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100'
      : 'border-amber-100 bg-white text-gray-900 hover:border-amber-300 hover:bg-amber-50 dark:border-amber-900/50 dark:bg-gray-900 dark:text-white dark:hover:bg-amber-950/30',
    gray: selected
      ? 'border-slate-400 bg-slate-100 text-slate-950 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100'
      : 'border-slate-100 bg-white text-gray-900 hover:border-slate-300 hover:bg-slate-50 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:hover:bg-slate-800',
    red: selected
      ? 'border-rose-400 bg-rose-50 text-rose-950 dark:border-rose-700 dark:bg-rose-950/40 dark:text-rose-100'
      : 'border-rose-100 bg-white text-gray-900 hover:border-rose-300 hover:bg-rose-50 dark:border-rose-900/50 dark:bg-gray-900 dark:text-white dark:hover:bg-rose-950/30',
  };
  return classes[tone];
};

export function ImportData({
  onImportComplete,
  auditAppendix = null,
  files = [],
  processedStorageFiles = [],
  brokerFileActionOverrides = [],
  onResolveBrokerFileAction,
  onIgnoreBrokerFileAction,
  onOpenHistorySearch,
  onOpenCandidateTransactions,
  onOpenStorageHistory,
  uiComplexityMode = 'simple',
  onOpenInsight,
  selectedYear,
}: ImportDataProps) {
  const { language, t } = useI18n();
  const isExpertMode = uiComplexityMode === 'expert';
  const uiMotion = useUiMotion();
  const [isDragging, setIsDragging] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [importProgressMessage, setImportProgressMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [ollamaStatus, setOllamaStatus] = useState<OllamaRuntimeStatus | null>(null);
  const [ollamaBusy, setOllamaBusy] = useState(false);
  const [ollamaError, setOllamaError] = useState<string | null>(null);
  const [legacyParserStatus, setLegacyParserStatus] = useState<string | null>(null);
  const [recognitionJobMessage, setRecognitionJobMessage] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [actionFilter, setActionFilter] = useState<ActionFilter>('open');
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [activeInsight, setActiveInsight] = useState<ImportInsight | null>(null);
  const [showAllCoverage, setShowAllCoverage] = useState(false);
  const [actionNoteTarget, setActionNoteTarget] = useState<{
    actionId: string;
    mode: 'resolved' | 'ignored';
  } | null>(null);
  const [actionNoteDraft, setActionNoteDraft] = useState('');
  const [canonicalRecordFilter, setCanonicalRecordFilter] = useState<CanonicalRecordFilter>('all');
  const [canonicalSourceFilter, setCanonicalSourceFilter] = useState('all');
  const [canonicalSearch, setCanonicalSearch] = useState('');
  const [selectedCanonicalEventKey, setSelectedCanonicalEventKey] = useState<string | null>(null);
  const deferredCanonicalSearch = useDeferredValue(canonicalSearch);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const brokerFileSummary = buildBrokerFileIntakeSummary(auditAppendix, files, processedStorageFiles, brokerFileActionOverrides);
  const pitTrustView = useMemo(() => buildPitTrustViewModel(auditAppendix), [auditAppendix]);
  const importIntelligenceView = useMemo(() => buildImportIntelligenceView({
    auditAppendix,
    brokerSourceRows: brokerFileSummary.sourceRows,
    ollamaStatus,
    language,
  }), [auditAppendix, brokerFileSummary.sourceRows, language, ollamaStatus]);
  const sourceManagerRows = importIntelligenceView.sources;
  const transactionSourceCount = importIntelligenceView.summary.transactionSourceCount;
  const fullInventoryCount = importIntelligenceView.summary.totalFiles || pitTrustView.recognizedFileCount || brokerFileSummary.sourceMap?.totalFiles || brokerFileSummary.totalSources;
  const candidatePreviewRowCount = auditAppendix?.candidate_transaction_preview_rows?.length || 0;
  const canonicalStorageRowCount = importIntelligenceView.summary.canonicalStorageRowCount;
  const canonicalRawRowCount = importIntelligenceView.summary.canonicalRawRowCount;
  const canonicalDeduplicatedRowCount = importIntelligenceView.summary.canonicalDeduplicatedRowCount;
  const transactionDossierCount = importIntelligenceView.summary.transactionDossierCount;
  const transactionConflictCount = importIntelligenceView.attention.conflictCount;
  const transactionDossierNeedsReviewCount = importIntelligenceView.attention.dossierReviewCount;
  const aiValidationReport = asPlainRecord(auditAppendix?.ai_validation_report);
  const aiDocumentValidation = asPlainRecord(aiValidationReport.document_classification);
  const aiColumnValidation = asPlainRecord(aiValidationReport.column_mapping);
  const aiContextValidation = asPlainRecord(aiValidationReport.extracted_context);
  const aiSafePolicy = asPlainRecord(aiValidationReport.safe_tax_policy);
  const canonicalTaxInputSummary = asPlainRecord(auditAppendix?.canonical_tax_input_summary);
  const canonicalTaxAiCandidateCount = asSourceNumber(canonicalTaxInputSummary.aiCandidateCount);
  const canonicalTaxInput = asPlainRecord(auditAppendix?.canonical_tax_input);
  const canonicalInspectionEvents = useMemo(() => {
    const groupById = new Map(CANONICAL_RECORD_GROUPS.map((group) => [group.id, group]));
    return getCanonicalRecordStream(canonicalTaxInput).map((event, index) => {
      const record = asPlainRecord(event);
      const status = firstText(
        record.canonical_record_status,
        asPlainRecord(record.status).status,
        'informational',
      ) as CanonicalRecordGroupId;
      const groupMeta = groupById.get(status) || groupById.get('informational') || CANONICAL_RECORD_GROUPS[2];
      return toCanonicalInspectionEvent(event, groupMeta, index);
    });
  }, [canonicalTaxInput]);
  const canonicalRecordCounts = useMemo(() => {
    const counts = new Map<CanonicalRecordGroupId, number>();
    for (const group of CANONICAL_RECORD_GROUPS) counts.set(group.id, 0);
    for (const event of canonicalInspectionEvents) {
      counts.set(event.group, (counts.get(event.group) || 0) + 1);
    }
    return counts;
  }, [canonicalInspectionEvents]);
  const canonicalReadyRecordCount = canonicalRecordCounts.get('ready') || asSourceNumber(canonicalTaxInputSummary.engineReadyRecordCount);
  const canonicalIncompleteRecordCount = canonicalRecordCounts.get('incomplete') || asSourceNumber(canonicalTaxInputSummary.incompleteRecordCount);
  const canonicalInformationalRecordCount = canonicalRecordCounts.get('informational') || asSourceNumber(canonicalTaxInputSummary.informationalRecordCount);
  const canonicalUnrecognizedRecordCount = canonicalRecordCounts.get('unrecognized') || asSourceNumber(canonicalTaxInputSummary.unrecognizedRecordCount);
  const canonicalHealthDenominator = canonicalReadyRecordCount + canonicalIncompleteRecordCount;
  const canonicalHealthScore = canonicalHealthDenominator > 0
    ? Math.round((canonicalReadyRecordCount / canonicalHealthDenominator) * 100)
    : (canonicalInspectionEvents.length > 0 ? 100 : 0);
  const canonicalSourceOptions = useMemo(() => (
    Array.from(new Set<string>(
      canonicalInspectionEvents.reduce<string[]>((sources, event) => {
        if (event.sourceFile && event.sourceFile !== 'canonical_tax_input.json') {
          sources.push(event.sourceFile);
        }
        return sources;
      }, [])
    )).sort((a, b) => a.localeCompare(b, 'pl'))
  ), [canonicalInspectionEvents]);
  const filteredCanonicalEvents = useMemo(() => {
    const query = deferredCanonicalSearch.trim().toLowerCase();
    return canonicalInspectionEvents.filter((event) => {
      if (canonicalRecordFilter !== 'all' && event.group !== canonicalRecordFilter) return false;
      if (canonicalSourceFilter !== 'all' && event.sourceFile !== canonicalSourceFilter) return false;
      if (query && !event.searchText.includes(query)) return false;
      return true;
    });
  }, [canonicalRecordFilter, canonicalInspectionEvents, canonicalSourceFilter, deferredCanonicalSearch]);
  const visibleCanonicalEvents = filteredCanonicalEvents.slice(0, 120);
  const selectedCanonicalEvent = (
    selectedCanonicalEventKey
      ? filteredCanonicalEvents.find((event) => event.key === selectedCanonicalEventKey)
      : null
  ) || filteredCanonicalEvents[0] || null;
  const canRunAiRepair = Boolean(
    ollamaStatus?.gpuConfirmed &&
    ollamaStatus.computeBackend === 'gpu' &&
    canonicalIncompleteRecordCount > 0
  );
  const ollamaConsoleLines = useMemo(() => {
    const lines = [
      `runtime=${ollamaStatus?.serverRunning ? 'online' : 'offline'}`,
      `gpuConfirmed=${ollamaStatus?.gpuConfirmed ? 'true' : 'false'}`,
      `backend=${ollamaStatus?.computeBackend || 'unknown'}:${ollamaStatus?.gpuBackend || 'unknown'}`,
      `model=${ollamaStatus?.model || 'not-selected'}`,
    ];
    if (ollamaStatus?.gpuFailureReason) lines.push(`gpuFailure=${ollamaStatus.gpuFailureReason}`);
    if (ollamaError) lines.push(`error=${ollamaError}`);
    if (recognitionJobMessage) lines.push(`recognition=${recognitionJobMessage}`);
    for (const evidence of ollamaStatus?.logEvidence || []) {
      lines.push(evidence);
    }
    return lines;
  }, [ollamaError, ollamaStatus, recognitionJobMessage]);
  const filesNeedingReview = importIntelligenceView.attention.filesNeedingReviewCount;
  const importWizardSteps = [
    {
      id: 'upload',
      title: language === 'en' ? 'Upload' : 'Wgraj pliki',
      description: language === 'en'
        ? 'Drag many broker, NBP, PDF and XLSX files at once.'
        : 'Przeciągnij wiele plików brokera, NBP, PDF i XLSX naraz.',
      value: files.length || fullInventoryCount,
      icon: Upload,
    },
    {
      id: 'recognition',
      title: language === 'en' ? 'Recognition' : 'Rozpoznanie',
      description: language === 'en'
        ? 'The engine classifies parser, Ollama and storage status.'
        : 'Silnik klasyfikuje parser, Ollamę i status storage.',
      value: sourceManagerRows.length,
      icon: Bot,
    },
    {
      id: 'source-map',
      title: language === 'en' ? 'Source map' : 'Mapa źródeł',
      description: language === 'en'
        ? 'Files become one canonical record stream with source metadata.'
        : 'Pliki tworzą jeden kanoniczny strumień rekordów z metadanymi źródeł.',
      value: brokerFileSummary.sourceMap?.totalFiles || brokerFileSummary.totalSources,
      icon: MapPinned,
    },
    {
      id: 'review',
      title: language === 'en' ? 'Review queue' : 'Co wymaga uwagi',
      description: language === 'en'
        ? 'Conflicts, missing NBP and AI candidates stay visible.'
        : 'Konflikty, braki NBP i kandydaci AI zostają widoczni.',
      value: importIntelligenceView.attention.total,
      icon: ShieldCheck,
    },
  ];
  const aiDocumentClassificationCount = asSourceNumber(aiDocumentValidation.total);
  const aiColumnMappingCount = asSourceNumber(aiColumnValidation.total);
  const aiExtractedContextCount = asSourceNumber(aiContextValidation.total);
  const sourceMapGroupLabel = (groupId: string, fallback: string) => {
    const labelByGroup: Record<string, string> = {
      active_tax: 'Źródła transakcyjne',
      candidate_tax: 'Raporty transakcyjne',
      evidence: 'Dowody i kontekst',
      nbp_rates: 'NBP',
      reconciliation: 'Kontrola pozycji',
      fallback: 'Pozostałe pliki',
    };
    return labelByGroup[groupId] || fallback;
  };
  const effectiveSelectedSourceId = selectedSourceId || brokerFileSummary.sourceRows[0]?.sourceId || null;
  const selectedSourceDetails = brokerFileSummary.sourceDetails.find((details) => details.source.sourceId === effectiveSelectedSourceId) || null;
  const insightSourceDetails = activeInsight?.type === 'source'
    ? brokerFileSummary.sourceDetails.find((details) => details.source.sourceId === activeInsight.sourceId) || null
    : null;
  const insightAction = activeInsight?.type === 'action'
    ? brokerFileSummary.actionRows.find((action) => action.actionId === activeInsight.actionId) || null
    : null;
  const openSourceInsight = (sourceId: string) => {
    const details = brokerFileSummary.sourceDetails.find((entry) => entry.source.sourceId === sourceId) || null;
    if (!onOpenInsight || !details) {
      setActiveInsight({ type: 'source', sourceId });
      return;
    }
    onOpenInsight({
      type: 'source',
      id: sourceId,
      title: `Źródło: ${details.source.filename}`,
      subtitle: details.source.roleLabel,
      sections: [
        {
          title: 'Co to znaczy',
          content: `Ten plik ma rolę: ${details.source.roleLabel}. Każdy plik jest źródłem danych dla canonical_tax_input.json; dowody, kontrola pozycji i analityka zostają zachowane jako kontekst.`,
        },
        {
          title: 'Wpływ na canonical input',
          content: details.source.role === 'transaction_source' || details.source.role === 'transaction_report' || details.source.role === 'primary_tax' || details.source.role === 'baseline_tax' || details.source.role === 'tax'
            ? 'To źródło dostarcza rekordy transakcyjne.'
            : 'Ten plik dostarcza dane źródłowe, dowody, kontrolę albo kontekst.',
        },
        {
          title: 'Co zrobić',
          content: details.relatedActions.length > 0
            ? details.relatedActions[0].userAction
            : 'Nie trzeba nic robić, jeśli status źródła jest prawidłowy.',
        },
        {
          title: 'Źródła / szczegóły',
          content: (
            <dl className="space-y-2 text-xs">
              <div><dt className="font-semibold uppercase tracking-wide text-gray-500">Ścieżka</dt><dd className="break-all">{details.source.pathLabel}</dd></div>
              {isExpertMode && <div><dt className="font-semibold uppercase tracking-wide text-gray-500">Hash</dt><dd className="break-all">{details.source.hashShort || 'brak'}</dd></div>}
              <div><dt className="font-semibold uppercase tracking-wide text-gray-500">Sekcje</dt><dd>{details.source.sectionsLabel}</dd></div>
              <div>
                <dt className="font-semibold uppercase tracking-wide text-gray-500">Liczniki</dt>
                <dd>{Object.entries(details.source.recordCounts || {}).map(([key, value]) => `${key}: ${value}`).join(', ') || 'brak liczników'}</dd>
              </div>
            </dl>
          ),
        },
        {
          title: 'Powiązane sprawy',
          content: details.relatedActions.length > 0
            ? details.relatedActions.slice(0, 8).map((action) => `${action.label} (${action.statusLabel})`).join(' · ')
            : 'Brak powiązanych spraw dla tego źródła.',
        },
      ],
      actions: details.source.role === 'transaction_report'
        ? [
            {
              label: 'Pokaż transakcje z tego pliku',
              variant: 'primary',
              onClick: () => onOpenCandidateTransactions?.(sourceId),
            },
          ]
        : undefined,
    });
  };
  const openActionInsight = (actionId: string) => {
    const action = brokerFileSummary.actionRows.find((entry) => entry.actionId === actionId) || null;
    if (!onOpenInsight || !action) {
      setActiveInsight({ type: 'action', actionId });
      return;
    }
    onOpenInsight({
      type: 'source',
      id: actionId,
      title: `Sprawa importu: ${action.label}`,
      subtitle: action.statusLabel,
      sections: [
        { title: 'Co to znaczy', content: action.reason || action.label },
        { title: 'Wpływ na canonical input', content: isReviewSeverity(action.severity) ? 'Plik jest przyjęty. Ta sprawa zostaje diagnostyką rekordu.' : 'Ta sprawa jest kontrolą workflow i nie zmienia danych automatycznie.' },
        { title: 'Co zrobić', content: action.userAction },
        {
          title: 'Źródła / szczegóły',
          content: `Priorytet: ${actionSeverityLabel(action.severity)}. Obszar: ${action.area}. Źródła: ${action.sourceIds.join(', ') || 'brak'}. Koszty: ${action.relatedCostIds.join(', ') || 'brak'}.`,
        },
      ],
      children: action.historySearchTerm ? (
        <button
          type="button"
          onClick={() => onOpenHistorySearch?.(action.historySearchTerm || '', action.linkedRowId)}
          className="w-full rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
        >
          Przejdź do historii
        </button>
      ) : undefined,
    });
  };
  const visibleSourceRows = brokerFileSummary.sourceRows.filter((source) => {
    if (sourceFilter === 'tax') return source.role === 'transaction_source' || source.role === 'transaction_report' || source.role === 'primary_tax' || source.role === 'tax';
    if (sourceFilter === 'evidence') return ['evidence', 'reconciliation', 'supplemental', 'fallback', 'duplicate'].includes(source.role);
    if (sourceFilter === 'problems') return source.hasProblems;
    if (sourceFilter === 'new_storage') {
      return source.sourceId.startsWith('file:') && !brokerFileSummary.processedStorageFiles.includes(source.filename);
    }
    return true;
  });
  const visibleActionRows = useMemo(() => brokerFileSummary.actionRows.filter((action) => {
    if (actionFilter === 'resolved') return action.status === 'resolved';
    if (actionFilter === 'ignored') return action.status === 'ignored';
    if (action.status !== 'open') return false;
    if (actionFilter === 'review') return isReviewSeverity(action.severity);
    if (actionFilter === 'warning') return action.severity === 'warning';
    return true;
  }), [actionFilter, brokerFileSummary.actionRows]);
  const visibleCoverageRows = showAllCoverage ? brokerFileSummary.coverageRows : brokerFileSummary.coverageRows.slice(0, 8);
  const sourceSelfCheckStatus = pitTrustView.overallStatus === 'needs_review'
    ? 'Wymaga kontroli danych'
    : brokerFileSummary.actionProgress.warnings > 0
      ? 'Źródła do kontroli danych'
      : brokerFileSummary.openActionCount > 0 || brokerFileSummary.missingAreas.length > 0 || brokerFileSummary.conflictCount > 0
        ? 'Wymaga kontroli źródeł'
        : brokerFileSummary.totalSources > 0
          ? 'Pliki kompletne'
          : 'Brak rozpoznanych źródeł';
  const sourceSelfCheckMessage = fullInventoryCount > 0
    ? `${language === 'en' ? 'Transaction sources' : 'Źródła transakcji'}: ${transactionSourceCount}. ${t('import.fullInventory')}: ${fullInventoryCount}. ${language === 'en' ? 'Preview rows' : 'Podgląd rekordów'}: ${candidatePreviewRowCount}.`
    : 'Wgraj pliki brokera albo uruchom silnik, aby zobaczyć role źródeł.';
  const visibleSourceMapGroups = (brokerFileSummary.sourceMap?.groups || []).filter((group) => (
    group.count > 0 || group.id === 'active_tax' || group.id === 'candidate_tax'
  ));

  const refreshOllamaStatus = async () => {
    try {
      setOllamaBusy(true);
      setOllamaError(null);
      setOllamaStatus(await runtimeApi.testOllamaGpu());
    } catch (err: unknown) {
      setOllamaError(getErrorMessage(err, 'Nie udało się sprawdzić statusu Ollama.'));
    } finally {
      setOllamaBusy(false);
    }
  };

  const ensureOllama = async () => {
    try {
      setOllamaBusy(true);
      setOllamaError(null);
      const result = await runtimeApi.ensureOllamaRunning({
        requireGpu: true,
        restartIfGpuUnconfirmed: true,
      });
      setOllamaStatus(result.status);
      setSuccess(result.message);
    } catch (err: unknown) {
      setOllamaError(getErrorMessage(err, 'Nie udało się uruchomić Ollama.'));
    } finally {
      setOllamaBusy(false);
    }
  };

  const checkLegacySpreadsheetParser = async () => {
    setLegacyParserStatus('Ładuję stary parser XLSX jako debug fallback...');
    try {
      const spreadsheetModule = await import('xlsx') as { version?: string };
      setLegacyParserStatus(`Parser XLSX dostępny w trybie expert/debug${spreadsheetModule.version ? ` (SheetJS ${spreadsheetModule.version})` : ''}. Główny import nadal idzie przez storage i Transaction Intelligence.`);
    } catch (parserError) {
      setLegacyParserStatus(`Nie udało się załadować debug parsera XLSX: ${getErrorMessage(parserError)}`);
    }
  };

  useEffect(() => {
    void refreshOllamaStatus();
  }, []);

  const openActionNote = (action: BrokerFileIntakeActionRow, mode: 'resolved' | 'ignored') => {
    setActionNoteTarget({ actionId: action.actionId, mode });
    setActionNoteDraft(action.userNote || '');
  };

  const closeActionNote = () => {
    setActionNoteTarget(null);
    setActionNoteDraft('');
  };

  const saveActionNote = (action: BrokerFileIntakeActionRow) => {
    const note = actionNoteDraft.trim();
    if (actionNoteTarget?.mode === 'ignored') {
      if (!note) {
        return;
      }
      onIgnoreBrokerFileAction?.(action, note);
      closeActionNote();
      return;
    }
    onResolveBrokerFileAction?.(action, note || undefined);
    closeActionNote();
  };

  const createLog = (level: LogEntry['level'], stage: LogEntry['stage'], message: string, details?: unknown): LogEntry => ({
    id: Math.random().toString(36).substring(7),
    timestamp: new Date().toISOString(),
    level,
    stage,
    message,
    details
  });

  const getSupplementalImportDisposition = (file: File): SupplementalImportDisposition | null => {
    const name = file.name.toLowerCase();
    if (name.endsWith('.pdf')) {
      return {
        recordType: 'evidence',
        message: 'Rozpoznano dokument dowodowy. Plik trafia do storage jako dane źródłowe.',
        status: 'success',
      };
    }
    if (name.includes('traderzy')) {
      return {
        recordType: 'analytics',
        message: 'Rozpoznano plik analityczny Traderzy. Plik nie jest zwykłą historią transakcji, ale będzie widoczny jako analityka/dowód.',
        status: 'success',
      };
    }
    if (name.includes('dezpozytariusz') || name.includes('depozytariusz')) {
      return {
        recordType: 'position_reconciliation',
        message: 'Rozpoznano raport depozytariusza. To kontrola pozycji, nie źródło zwykłych transakcji BUY/SELL.',
        status: 'success',
      };
    }
    if (name.startsWith('broker_raport') && name.endsWith('.json')) {
      return {
        recordType: 'transaction_source',
        message: 'Rozpoznano raport brokera. Plik trafi do jednego strumienia canonical_tax_input.json.',
        status: 'success',
      };
    }
    if (name.startsWith('archiwum_tab_a_')) {
      return {
        recordType: 'nbp_rates',
        message: 'Rozpoznano archiwum kursów NBP. Plik trafił do storage i zostanie użyty przez silnik przy przypisaniu kursów.',
        status: 'success',
      };
    }
    if (name.includes('ruchy_got') || name.includes('tradernet_table')) {
      return {
        recordType: 'cash_context',
        message: 'Rozpoznano ruchy gotówki/cash flow. Plik wzbogaca karty transakcji o opłaty, FX, odsetki i komentarze bez tworzenia fałszywych BUY/SELL.',
        status: 'success',
      };
    }
    if (
      name.includes('transakcje') ||
      name.startsWith('trades') ||
      name.includes('historia_transakcji') ||
      name.includes('pelny_zrzut_api_transakcje')
    ) {
      return {
        recordType: 'transaction_source',
        message: 'Rozpoznano źródło transakcyjne. Plik trafił do storage i zostanie znormalizowany przez Transaction Intelligence.',
        status: 'success',
      };
    }
    return null;
  };

  const fileToBase64 = async (file: File): Promise<string> => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }
    return btoa(binary);
  };

  const copyFilesToRuntimeStorage = async (filesToImport: File[], logs: LogEntry[]) => {
    const failedNames = new Set<string>();
    try {
      const payload = await Promise.all(filesToImport.map(async (file) => {
        const fileName = safeImportFileName(file);
        return {
          relativePath: fileName,
          fileName,
          base64: await fileToBase64(file),
        };
      }));
      const result = await runtimeApi.importFilesToStorage(payload);
      if (result.imported.length > 0) {
        logs.push(createLog('info', 'LOAD FILE', `Skopiowano do storage aplikacji: ${result.imported.length} ${odmienLiczebnik(result.imported.length, 'plik', 'pliki', 'plików')}.`));
      }
      if (result.skipped.length > 0) {
        logs.push(createLog('info', 'LOAD FILE', `Pominięto identyczne pliki w storage: ${result.skipped.length}.`));
      }
      for (const failure of result.failed || []) {
        failedNames.add(failure.fileName);
        logs.push(createLog('warn', 'LOAD FILE', `Nie skopiowano pliku ${failure.fileName}: ${failure.message}`, failure));
      }
      for (const warning of result.warnings || []) {
        logs.push(createLog('warn', 'LOAD FILE', warning));
      }
    } catch (err: unknown) {
      const message = getErrorMessage(err, 'Nie udało się skopiować plików do storage aplikacji.');
      // Import UI niczego nie parsuje - bez kopii w storage silnik tych danych
      // nie zobaczy. Wczesniej lista nieudanych zostawala pusta i ekran konczyl
      // komunikatem "N plikow przyjeto", chociaz nie przyjeto zadnego.
      for (const file of filesToImport) {
        failedNames.add(safeImportFileName(file));
      }
      logs.push(createLog('error', 'LOAD FILE', `Nie skopiowano żadnego pliku do storage: ${message}`, err));
    }
    return failedNames;
  };

  const runStorageRecognitionJob = async (
    useAi: boolean,
    logs: LogEntry[],
  ): Promise<{ stan: 'gotowe' | 'blad' | 'trwa'; komunikat: string }> => {
    setRecognitionJobMessage('Buduję canonical_tax_input.json...');
    logs.push(createLog('info', 'PARSE DATA', 'Uruchamiam Transaction Intelligence: normalized events, dossier i canonical_tax_input.json.'));
    try {
      const { jobId } = await runtimeApi.startStorageRecognitionJob({
        useAi,
        forceReprocess: true,
        year: selectedYear,
      });
      // Czekamy tyle, ile silnik ma na przebieg. Wczesniej bylo to 120 prob co
      // pol sekundy, czyli minuta - przy limicie silnika wynoszacym dziesiec
      // minut. Rozpoznanie duzego zbioru z AI mieszcilo sie w limicie silnika,
      // ale ekran przestawal je sledzic i konczyl komunikatem "nadal trwa".
      const deadline = Date.now() + ENGINE_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const status = await runtimeApi.getStorageRecognitionJobStatus(jobId);
        setRecognitionJobMessage(`${status.message || status.stage} (${status.progress || 0}%)`);
        if (status.state === 'done') {
          await runtimeApi.getStorageRecognitionJobResult(jobId);
          logs.push(createLog('info', 'END PROCESS', 'Zbudowano canonical_tax_input.json jako jeden wymagany strumień wejściowy.'));
          setRecognitionJobMessage('canonical_tax_input.json gotowy');
          return { stan: 'gotowe', komunikat: 'canonical_tax_input.json gotowy' };
        }
        if (status.state === 'failed' || status.state === 'cancelled') {
          logs.push(createLog('warn', 'END PROCESS', status.message || 'Rozpoznanie storage wymaga kontroli.'));
          setRecognitionJobMessage(status.message || 'Rozpoznanie storage wymaga kontroli.');
          return { stan: 'blad', komunikat: status.message || 'Rozpoznanie storage wymaga kontroli.' };
        }
        // Na poczatku pytamy czesto, zeby postep byl widoczny od razu; przy
        // dlugim przebiegu rzadziej, zeby nie odpytywac backendu bez potrzeby.
        const elapsedMs = ENGINE_TIMEOUT_MS - (deadline - Date.now());
        await new Promise((resolve) => setTimeout(resolve, elapsedMs < 30_000 ? 500 : 2_000));
      }
      logs.push(createLog('warn', 'END PROCESS', 'Rozpoznanie storage nadal trwa. Odśwież raport lub import, aby zobaczyć najnowszy status.'));
      setRecognitionJobMessage('Rozpoznanie storage nadal trwa.');
      return { stan: 'trwa', komunikat: 'Rozpoznanie storage nadal trwa.' };
    } catch (err: unknown) {
      const message = getErrorMessage(err, 'Nie udało się uruchomić rozpoznania storage.');
      logs.push(createLog('warn', 'END PROCESS', message, err));
      setRecognitionJobMessage(message);
      return { stan: 'blad', komunikat: message };
    } finally {
      if (useAi) {
        const stopResult = await runtimeApi.stopOllama().catch(() => null);
        if (stopResult?.stopped) {
          logs.push(createLog('info', 'END PROCESS', 'Ollama zatrzymana po zakończeniu analizy AI.'));
        }
      }
    }
  };

  const runAiDiagnosticsAndRepair = async () => {
    const logs: LogEntry[] = [];
    try {
      setOllamaBusy(true);
      setOllamaError(null);
      logs.push(createLog('info', 'PARSE DATA', 'Uruchamiam autodiagnostykę AI dla rekordów wymagających weryfikacji.'));
      const result = await runtimeApi.ensureOllamaRunning({
        requireGpu: true,
        restartIfGpuUnconfirmed: true,
      });
      setOllamaStatus(result.status);
      logs.push(createLog('info', 'PARSE DATA', result.message));
      if (!result.status.gpuConfirmed || result.status.computeBackend !== 'gpu') {
        const message = result.status.gpuFailureReason || 'GPU niepotwierdzone. AI nie zostanie uruchomiona.';
        setOllamaError(message);
        logs.push(createLog('warn', 'PARSE DATA', message));
        onImportComplete([], logs);
        return;
      }
      const rozpoznanie = await runStorageRecognitionJob(true, logs);
      if (rozpoznanie.stan === 'gotowe') {
        setSuccess('Autodiagnostyka AI zakończona. Odświeżono canonical_tax_input.json jako jeden strumień rekordów.');
      } else {
        setOllamaError(
          `Autodiagnostyka AI nie odświeżyła canonical_tax_input.json: ${rozpoznanie.komunikat}`,
        );
      }
      onImportComplete([], logs);
    } catch (err: unknown) {
      const message = getErrorMessage(err, 'Nie udało się uruchomić autodiagnostyki AI.');
      setOllamaError(message);
      logs.push(createLog('warn', 'PARSE DATA', message, err));
      onImportComplete([], logs);
    } finally {
      setOllamaBusy(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await processFiles(Array.from(e.dataTransfer.files));
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      await processFiles(Array.from(e.target.files));
    }
  };

  const processFiles = async (filesToImport: File[]) => {
    if (filesToImport.length === 0) {
      return;
    }
    setIsImporting(true);
    setImportProgressMessage(null);
    setRecognitionJobMessage(null);
    setError(null);
    setSuccess(null);

    const allLogs: LogEntry[] = [];
    const fileInfos: FileInfo[] = [];
    const normalizedFiles = filesToImport.map(normalizeImportFile);

    try {
      const ollama = await runtimeApi.testOllamaGpu().catch(() => null);
      if (!ollama?.gpuConfirmed) {
        allLogs.push(createLog('info', 'PARSE DATA', `Ollama GPU niepotwierdzona — import działa deterministycznie, bez CPU fallbacku. ${ollama?.gpuFailureReason || ''}`));
      } else {
        allLogs.push(createLog('info', 'PARSE DATA', `Ollama gotowa: ${ollama.model || 'model nieustalony'}. AI pomaga mapować dane do canonical_tax_input.json.`));
      }
      const failedStorageNames = await copyFilesToRuntimeStorage(normalizedFiles, allLogs);
      for (let index = 0; index < normalizedFiles.length; index += 1) {
        const file = normalizedFiles[index];
        setImportProgressMessage(`Przetwarzanie ${index + 1}/${filesToImport.length}: ${file.name}`);
        if (failedStorageNames.has(safeImportFileName(file))) {
          fileInfos.push({
            name: file.name,
            type: 'technical_error',
            size: file.size,
            loadedAt: new Date().toISOString(),
            recordCount: 0,
            status: 'error',
            isEnabled: false,
          });
          allLogs.push(createLog('warn', 'END PROCESS', `Plik ${file.name} nie został dodany do storage z powodu błędu technicznego.`));
          continue;
        }
        const result = await processSingleFile(file);
        fileInfos.push(result.fileInfo);
        allLogs.push(...result.logs);
      }
      const rozpoznanie = await runStorageRecognitionJob(Boolean(ollama?.gpuConfirmed && ollama.computeBackend === 'gpu'), allLogs);

      const successful = fileInfos.filter((fileInfo) => fileInfo.status === 'success').length;
      const warnings = fileInfos.filter((fileInfo) => fileInfo.status === 'warning').length;
      const errors = fileInfos.filter((fileInfo) => fileInfo.status === 'error').length;
      const ogonRozpoznania =
        rozpoznanie.stan === 'gotowe'
          ? 'Transaction Intelligence zbudował canonical_tax_input.json.'
          : `Transaction Intelligence nie zbudował canonical_tax_input.json: ${rozpoznanie.komunikat}`;
      if (errors > 0 || rozpoznanie.stan !== 'gotowe') {
        setError(`Zakończono import z problemami: ${errors} ${odmienLiczebnik(errors, 'plik wymaga', 'pliki wymagają', 'plików wymaga')} kontroli, ${successful + warnings} przyjęto. ${ogonRozpoznania}`);
      } else {
        setSuccess(`Zakończono import: ${successful} ${odmienLiczebnik(successful, 'plik przyjęto', 'pliki przyjęto', 'plików przyjęto')}${warnings ? `, ${warnings} z ostrzeżeniami` : ''}. ${ogonRozpoznania}`);
      }
      onImportComplete(fileInfos, allLogs);
    } finally {
      setIsImporting(false);
      setImportProgressMessage(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const processSingleFile = async (file: File): Promise<ImportFileResult> => {
    const logs: LogEntry[] = [];
    logs.push(createLog('info', 'LOAD FILE', `Rozpoczęto wczytywanie pliku: ${file.name} (${(file.size / 1024).toFixed(2)} KB)`));

    const disposition = getSupplementalImportDisposition(file) || {
      recordType: 'needs_mapping',
      message: 'Plik został przyjęty do storage. Nie uruchamiam starego parsera przeglądarkowego; silnik storage/Ollama spróbuje go rozpoznać przy przebiegu Transaction Intelligence.',
      status: 'warning' as const,
    };

    logs.push(createLog('info', 'PARSE DATA', disposition.message));
    logs.push(createLog('info', 'CLASSIFY TRANSACTION', 'Rozpoznanie szczegółowych rekordów wykona silnik storage; import UI nie tworzy lokalnej bazy transakcji ani kursów.'));
    logs.push(createLog('info', 'END PROCESS', 'Plik przyjęty jako dane wejściowe bez uruchamiania obliczeń.'));

    return {
      fileInfo: {
        name: file.name,
        type: disposition.recordType,
        size: file.size,
        loadedAt: new Date().toISOString(),
        recordCount: 0,
        status: disposition.status,
        isEnabled: false,
      },
      logs,
    };
  };

  return (
    <motion.div data-motion="import-page" className="space-y-6 max-w-6xl mx-auto" {...uiMotion.fadeUp()}>
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{t('nav.importData')}</h1>

      <motion.section
        data-motion="import-ai-wizard"
        className="overflow-hidden rounded-2xl border border-blue-100 bg-gradient-to-br from-blue-50 via-white to-emerald-50 p-5 shadow-sm dark:border-blue-900/50 dark:from-blue-950/30 dark:via-gray-900 dark:to-emerald-950/20"
        {...uiMotion.fadeUp(0.02)}
      >
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-3xl">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-700 dark:text-blue-300">
              Transaction Intelligence Layer
            </p>
            <h2 className="mt-2 text-2xl font-bold text-gray-950 dark:text-white">
              {language === 'en' ? 'Import with AI recognition and source map' : 'Import z rozpoznaniem AI i mapą źródeł'}
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
              {language === 'en'
                ? 'Drop all broker, NBP, PDF and XLSX files at once. The app copies them to storage, stays on this page and lets the engine build normalized events, dossiers and conflicts.'
                : 'Wrzuć wszystkie pliki brokera, NBP, PDF i XLSX naraz. Aplikacja kopiuje je do storage, zostaje na tej stronie i pozwala silnikowi zbudować normalized events, karty transakcji oraz konflikty.'}
            </p>
          </div>
          <div className="rounded-xl bg-white/80 p-3 text-xs text-gray-700 ring-1 ring-blue-100 dark:bg-gray-950/60 dark:text-gray-200 dark:ring-blue-900/60">
            <p className="font-semibold text-gray-950 dark:text-white">
              {language === 'en' ? 'Data flow' : 'Przepływ danych'}
            </p>
            <p className="mt-1">
              {language === 'en'
                ? 'AI and import build one canonical input stream. Calculations run only after this file exists.'
                : 'AI i import budują jeden kanoniczny strumień wejściowy. Obliczenia ruszają dopiero po utworzeniu tego pliku.'}
            </p>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-4">
          {importWizardSteps.map((step, index) => {
            const Icon = step.icon;
            return (
              <div key={step.id} className="rounded-xl bg-white p-4 ring-1 ring-blue-100 dark:bg-gray-900 dark:ring-blue-900/60">
                <div className="flex items-center justify-between gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white">
                    {index + 1}
                  </span>
                  <Icon className="h-5 w-5 text-blue-600 dark:text-blue-300" />
                </div>
                <p className="mt-3 text-sm font-bold text-gray-950 dark:text-white">{step.title}</p>
                <p className="mt-1 min-h-[42px] text-xs leading-relaxed text-gray-500 dark:text-gray-400">{step.description}</p>
                <p className="mt-3 text-2xl font-bold text-blue-700 dark:text-blue-300">{step.value}</p>
              </div>
            );
          })}
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
          <span className="rounded-xl bg-white px-3 py-2 font-semibold text-blue-900 ring-1 ring-blue-100 dark:bg-gray-900 dark:text-blue-100 dark:ring-blue-900/60">
            {language === 'en' ? 'Dossiers for review' : 'Karty do kontroli'}: {transactionDossierNeedsReviewCount}
          </span>
          <span className="rounded-xl bg-white px-3 py-2 font-semibold text-blue-900 ring-1 ring-blue-100 dark:bg-gray-900 dark:text-blue-100 dark:ring-blue-900/60">
            {language === 'en' ? 'Conflicts' : 'Konflikty'}: {transactionConflictCount}
          </span>
          <span className="rounded-xl bg-white px-3 py-2 font-semibold text-blue-900 ring-1 ring-blue-100 dark:bg-gray-900 dark:text-blue-100 dark:ring-blue-900/60">
            {language === 'en' ? 'Missing NBP' : 'Braki NBP'}: {importIntelligenceView.attention.missingNbpCount}
          </span>
          <span className="rounded-xl bg-white px-3 py-2 font-semibold text-blue-900 ring-1 ring-blue-100 dark:bg-gray-900 dark:text-blue-100 dark:ring-blue-900/60">
            {language === 'en' ? 'AI review' : 'AI do sprawdzenia'}: {importIntelligenceView.attention.aiReviewCount}
          </span>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_0.9fr]">
          <motion.div
            data-motion="import-dropzone"
            whileHover={uiMotion.hoverLift}
            whileTap={uiMotion.tapPress}
            className={`cursor-pointer rounded-2xl border-2 border-dashed p-8 text-center transition-colors ${
              isDragging
                ? 'border-blue-500 bg-blue-100/70 dark:bg-blue-950/50'
                : 'border-blue-200 bg-white/80 hover:border-blue-400 hover:bg-white dark:border-blue-900/70 dark:bg-gray-950/40 dark:hover:border-blue-500'
            }`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              type="file"
              ref={fileInputRef}
              className="hidden"
              accept=".xlsx,.xls,.csv,.xml,.json,.pdf"
              multiple
              onChange={handleFileSelect}
            />

            {isImporting ? (
              <div className="flex flex-col items-center">
                <Loader2 className="mb-4 h-12 w-12 animate-spin text-blue-500" />
                <p className="text-lg font-semibold text-gray-950 dark:text-white">
                  {language === 'en' ? 'Copying files to storage...' : 'Kopiuję pliki do storage...'}
                </p>
                <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                  {recognitionJobMessage || importProgressMessage || (language === 'en' ? 'The page will stay open.' : 'Strona zostaje bez przełączania widoku.')}
                </p>
              </div>
            ) : (
              <div className="flex flex-col items-center">
                <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-blue-600 text-white shadow-lg shadow-blue-500/20">
                  <Upload size={32} />
                </div>
                <p className="text-lg font-semibold text-gray-950 dark:text-white">
                  {language === 'en' ? 'Click or drop many files here' : 'Kliknij albo przeciągnij wiele plików tutaj'}
                </p>
                <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                  XLSX, XLS, CSV, XML, JSON, PDF · {language === 'en' ? 'copy-only import, no page jump' : 'import przez kopiowanie, bez przeskoku strony'}
                </p>
              </div>
            )}
          </motion.div>

          <div className="rounded-2xl bg-white p-4 ring-1 ring-blue-100 dark:bg-gray-900 dark:ring-blue-900/60">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300">
                  Ollama AI Normalizer
                </p>
                <h3 className="mt-1 text-base font-bold text-gray-950 dark:text-white">
                  {importIntelligenceView.aiRunStatus.runtimeLabel}
                </h3>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {importIntelligenceView.aiRunStatus.lastRunLabel}
                </p>
              </div>
              <span className={`rounded-full px-2 py-1 text-[11px] font-bold ${
                ollamaStatus?.gpuConfirmed
                  ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100 dark:bg-emerald-950/30 dark:text-emerald-200 dark:ring-emerald-900/60'
                  : 'bg-amber-50 text-amber-700 ring-1 ring-amber-100 dark:bg-amber-950/30 dark:text-amber-200 dark:ring-amber-900/60'
              }`}>
                {ollamaStatus?.gpuConfirmed ? 'GPU OK' : 'AI off'}
              </span>
            </div>
            <dl className="mt-3 space-y-2 text-xs text-gray-600 dark:text-gray-300">
              <div className="flex justify-between gap-3">
                <dt>Model</dt>
                <dd className="truncate font-semibold">{importIntelligenceView.aiRunStatus.modelLabel}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt>Endpoint</dt>
                <dd className="truncate font-semibold">{ollamaStatus?.baseUrl || 'http://127.0.0.1:11434'}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt>GPU</dt>
                <dd className="truncate font-semibold">
                  {ollamaStatus?.gpuMode || 'gpu'}
                  {' '}· {ollamaStatus?.gpuBackend || 'vulkan'}
                  {' '}· limit {typeof ollamaStatus?.gpuLoadLimitPercent === 'number' ? ollamaStatus.gpuLoadLimitPercent : 85}%
                  {' '}· batch {typeof ollamaStatus?.numBatch === 'number' ? ollamaStatus.numBatch : 128}
                  {' '}· równoległość {typeof ollamaStatus?.maxParallel === 'number' ? ollamaStatus.maxParallel : 1}
                  {' '}· num_gpu {typeof ollamaStatus?.numGpu === 'number' ? ollamaStatus.numGpu : -1}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt>EXE</dt>
                <dd className="truncate font-semibold">{ollamaStatus?.exePath || (language === 'en' ? 'not detected' : 'nie wykryto')}</dd>
              </div>
            </dl>
            {ollamaStatus?.serverRunning && !ollamaStatus.gpuConfirmed && (
              <p className="mt-3 rounded-lg bg-amber-50 p-2 text-xs text-amber-800 ring-1 ring-amber-100 dark:bg-amber-950/30 dark:text-amber-200 dark:ring-amber-900/60">
                Ollama działa, ale GPU nie jest potwierdzone. AI jest wyłączona bez CPU fallbacku. Kliknij „Uruchom Ollama”, aby aplikacja zamknęła znany proces Ollama i uruchomiła go w trybie GPU-only. {ollamaStatus.gpuFailureReason || ''}
              </p>
            )}
            {ollamaError && (
              <p className="mt-3 rounded-lg bg-amber-50 p-2 text-xs text-amber-800 ring-1 ring-amber-100 dark:bg-amber-950/30 dark:text-amber-200 dark:ring-amber-900/60">
                {ollamaError}
              </p>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={ensureOllama}
                disabled={ollamaBusy}
                className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-bold text-white transition hover:bg-blue-700 disabled:opacity-60"
              >
                {ollamaBusy ? (language === 'en' ? 'Working...' : 'Pracuję...') : (language === 'en' ? 'Start Ollama' : 'Uruchom Ollama')}
              </button>
              <button
                type="button"
                onClick={refreshOllamaStatus}
                disabled={ollamaBusy}
                className="inline-flex items-center gap-1 rounded-lg bg-white px-3 py-2 text-xs font-bold text-blue-700 ring-1 ring-blue-100 transition hover:bg-blue-50 disabled:opacity-60 dark:bg-gray-950 dark:text-blue-200 dark:ring-blue-900/60"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${ollamaBusy ? 'animate-spin' : ''}`} />
                {language === 'en' ? 'Refresh' : 'Odśwież'}
              </button>
            </div>
          </div>
        </div>

        {error && (
          <motion.div data-motion="import-status-card" className="mt-5 flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-900/50 dark:bg-red-900/30" {...uiMotion.fadeUp()}>
            <AlertCircle className="mt-0.5 shrink-0 text-red-500 dark:text-red-400" size={20} />
            <div>
              <h3 className="text-sm font-medium text-red-800 dark:text-red-300">{language === 'en' ? 'Import needs attention' : 'Import wymaga uwagi'}</h3>
              <p className="mt-1 text-sm text-red-700 dark:text-red-400">{error}</p>
            </div>
          </motion.div>
        )}

        {success && (
          <motion.div data-motion="import-status-card" className="mt-5 flex items-start gap-3 rounded-xl border border-green-200 bg-green-50 p-4 dark:border-green-900/50 dark:bg-green-900/30" {...uiMotion.fadeUp()}>
            <CheckCircle2 className="mt-0.5 shrink-0 text-green-500 dark:text-green-400" size={20} />
            <div>
              <h3 className="text-sm font-medium text-green-800 dark:text-green-300">{language === 'en' ? 'Accepted' : 'Przyjęto'}</h3>
              <p className="mt-1 text-sm text-green-700 dark:text-green-400">{success}</p>
            </div>
          </motion.div>
        )}
        {recognitionJobMessage && !isImporting && (
          <motion.div data-motion="import-recognition-card" className="mt-5 rounded-xl border border-cyan-200 bg-cyan-50 p-4 text-sm text-cyan-900 dark:border-cyan-900/50 dark:bg-cyan-950/30 dark:text-cyan-200" {...uiMotion.fadeUp()}>
            <span className="font-semibold">canonical_tax_input.json: </span>
            {recognitionJobMessage}
          </motion.div>
        )}
      </motion.section>

      <motion.section
        data-motion="canonical-tax-input-dashboard"
        className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900"
        {...uiMotion.fadeUp(0.03)}
      >
        <div className="border-b border-slate-100 bg-gradient-to-br from-slate-950 via-slate-900 to-emerald-950 p-5 text-white dark:border-gray-800">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-emerald-200">
                Transaction Intelligence Dashboard
              </p>
              <h2 className="mt-2 text-2xl font-bold">Centrum Weryfikacji Danych</h2>
              <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-200">
                Widok pokazuje jeden strumień <span className="font-semibold text-white">canonical_tax_input.json</span>. Adapter silnika wybiera z niego wyłącznie kompletne rekordy BUY/SELL, a reszta zostaje zachowana jako diagnostyka i raw payload.
              </p>
            </div>
            <div className="min-w-[220px] rounded-2xl bg-white/10 p-4 ring-1 ring-white/15">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <p className="text-xs uppercase tracking-wide text-slate-300">Health Score</p>
                  <p className="mt-1 text-4xl font-black text-white">{canonicalHealthScore}%</p>
                </div>
                <ShieldCheck className="h-10 w-10 text-emerald-300" />
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/15">
                <div
                  className={`h-full rounded-full ${
                    canonicalHealthScore >= 80 ? 'bg-emerald-400' : canonicalHealthScore >= 50 ? 'bg-amber-300' : 'bg-rose-400'
                  }`}
                  style={{ width: `${Math.max(0, Math.min(100, canonicalHealthScore))}%` }}
                />
              </div>
              <p className="mt-2 text-xs text-slate-300">
                Liczone jako gotowe / (gotowe + niepełne). Niepełne rekordy zostają w diagnostyce.
              </p>
            </div>
          </div>

          <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {CANONICAL_RECORD_GROUPS.map((group) => {
              const count = group.id === 'ready'
                ? canonicalReadyRecordCount
                : group.id === 'incomplete'
                  ? canonicalIncompleteRecordCount
                  : group.id === 'informational'
                    ? canonicalInformationalRecordCount
                    : canonicalUnrecognizedRecordCount;
              return (
                <button
                  key={group.id}
                  type="button"
                  onClick={() => setCanonicalRecordFilter((current) => current === group.id ? 'all' : group.id)}
                  className={`rounded-2xl border p-4 text-left transition ${
                    canonicalRecordFilter === group.id
                      ? 'border-white bg-white text-slate-950 shadow-xl shadow-black/20'
                      : 'border-white/15 bg-white/10 text-white hover:bg-white/15'
                  }`}
                >
                  <p className={`text-xs font-bold uppercase tracking-wide ${
                    canonicalRecordFilter === group.id ? 'text-slate-500' : 'text-slate-300'
                  }`}>
                    {group.shortLabel}
                  </p>
                  <p className="mt-1 text-3xl font-black">{count}</p>
                  <p className={`mt-2 text-xs leading-relaxed ${
                    canonicalRecordFilter === group.id ? 'text-slate-600' : 'text-slate-300'
                  }`}>
                    {group.label}
                  </p>
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-0 xl:grid-cols-[minmax(0,1fr)_390px]">
          <div className="p-5">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <h3 className="text-base font-bold text-gray-950 dark:text-white">Rekordy canonical_tax_input</h3>
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                  {filteredCanonicalEvents.length} {odmienLiczebnik(filteredCanonicalEvents.length, 'rekord', 'rekordy', 'rekordów')} po filtrach · pokazuję maksymalnie 120 naraz.
                </p>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:min-w-[620px]">
                <label className="text-xs font-semibold text-gray-600 dark:text-gray-300">
                  Grupa rekordów
                  <select
                    value={canonicalRecordFilter}
                    onChange={(event) => setCanonicalRecordFilter(event.target.value as CanonicalRecordFilter)}
                    className="mt-1 w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                  >
                    <option value="all">Wszystkie rekordy</option>
                    {CANONICAL_RECORD_GROUPS.map((group) => (
                      <option key={group.id} value={group.id}>{group.label}</option>
                    ))}
                  </select>
                </label>
                <label className="text-xs font-semibold text-gray-600 dark:text-gray-300">
                  Plik źródłowy
                  <select
                    value={canonicalSourceFilter}
                    onChange={(event) => setCanonicalSourceFilter(event.target.value)}
                    className="mt-1 w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                  >
                    <option value="all">Wszystkie pliki</option>
                    {canonicalSourceOptions.map((sourceFile) => (
                      <option key={sourceFile} value={sourceFile}>{sourceFile}</option>
                    ))}
                  </select>
                </label>
                <label className="text-xs font-semibold text-gray-600 dark:text-gray-300">
                  Szukaj
                  <input
                    value={canonicalSearch}
                    onChange={(event) => setCanonicalSearch(event.target.value)}
                    placeholder="ticker, typ, błąd..."
                    className="mt-1 w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                  />
                </label>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
              {visibleCanonicalEvents.map((event) => (
                <button
                  key={event.key}
                  type="button"
                  onClick={() => setSelectedCanonicalEventKey(event.key)}
                  className={`rounded-2xl border p-4 text-left shadow-sm transition ${groupToneClasses(event.groupTone, selectedCanonicalEvent?.key === event.key)}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold">{event.operationLabel} · {event.tickerLabel}</p>
                      <p className="mt-1 truncate text-xs opacity-70">{event.sourceFile}</p>
                    </div>
                    <span className="shrink-0 rounded-full bg-white/70 px-2 py-0.5 text-[11px] font-bold text-gray-700 ring-1 ring-black/5 dark:bg-gray-950/60 dark:text-gray-200 dark:ring-white/10">
                      {event.groupLabel}
                    </span>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs opacity-80">
                    <span>Data: {event.dateLabel}</span>
                    <span>Typ: {event.eventKind}</span>
                    <span>ID: {event.eventId}</span>
                    <span>Błędy: {event.validationErrors.length}</span>
                  </div>
                  {event.validationErrors.length > 0 && (
                    <p className="mt-2 line-clamp-2 text-xs font-semibold text-amber-700 dark:text-amber-200">
                      {event.validationErrors.join(', ')}
                    </p>
                  )}
                </button>
              ))}
              {visibleCanonicalEvents.length === 0 && (
                <div className="rounded-2xl border border-dashed border-gray-200 p-8 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400 lg:col-span-2">
                  Brak rekordów w canonical_tax_input.json dla wybranych filtrów. Po imporcie uruchom Transaction Intelligence, aby zbudować strumień danych.
                </div>
              )}
            </div>
          </div>

          <aside className="border-t border-slate-100 bg-slate-50 p-5 dark:border-gray-800 dark:bg-gray-950 xl:border-l xl:border-t-0">
            <div className="sticky top-4 space-y-4">
              <div className="rounded-2xl bg-white p-4 ring-1 ring-slate-200 dark:bg-gray-900 dark:ring-gray-700">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">Inspektor szczegółów</p>
                    <h3 className="mt-1 text-base font-black text-gray-950 dark:text-white">
                      {selectedCanonicalEvent ? `${selectedCanonicalEvent.operationLabel} · ${selectedCanonicalEvent.tickerLabel}` : 'Wybierz rekord'}
                    </h3>
                  </div>
                  {selectedCanonicalEvent && (
                    <span className={`rounded-full px-2 py-1 text-[11px] font-bold ${
                      selectedCanonicalEvent.groupTone === 'green'
                        ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100 dark:bg-emerald-950/30 dark:text-emerald-200 dark:ring-emerald-900/60'
                        : selectedCanonicalEvent.groupTone === 'yellow'
                          ? 'bg-amber-50 text-amber-700 ring-1 ring-amber-100 dark:bg-amber-950/30 dark:text-amber-200 dark:ring-amber-900/60'
                          : selectedCanonicalEvent.groupTone === 'red'
                            ? 'bg-rose-50 text-rose-700 ring-1 ring-rose-100 dark:bg-rose-950/30 dark:text-rose-200 dark:ring-rose-900/60'
                            : 'bg-slate-100 text-slate-700 ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700'
                    }`}>
                      {selectedCanonicalEvent.groupLabel}
                    </span>
                  )}
                </div>

                {selectedCanonicalEvent ? (
                  <div className="mt-4 space-y-3 text-sm">
                    <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2 xl:grid-cols-1">
                      <div className="rounded-xl bg-slate-50 p-3 dark:bg-gray-800">
                        <dt className="font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">Plik źródłowy</dt>
                        <dd className="mt-1 break-all text-gray-900 dark:text-white">{selectedCanonicalEvent.sourceFile}</dd>
                        {selectedCanonicalEvent.sourceRef && (
                          <dd className="mt-1 break-all text-gray-500 dark:text-gray-400">{selectedCanonicalEvent.sourceRef}</dd>
                        )}
                      </div>
                      <div className="rounded-xl bg-slate-50 p-3 dark:bg-gray-800">
                        <dt className="font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">Data i typ</dt>
                        <dd className="mt-1 text-gray-900 dark:text-white">{selectedCanonicalEvent.dateLabel}</dd>
                        <dd className="mt-1 text-gray-500 dark:text-gray-400">{selectedCanonicalEvent.eventKind} · {selectedCanonicalEvent.eventId}</dd>
                      </div>
                    </dl>

                    <div className="rounded-xl bg-amber-50 p-3 ring-1 ring-amber-100 dark:bg-amber-950/20 dark:ring-amber-900/60">
                      <p className="text-xs font-bold uppercase tracking-wide text-amber-700 dark:text-amber-200">Błędy walidacji</p>
                      {selectedCanonicalEvent.validationErrors.length > 0 ? (
                        <ul className="mt-2 space-y-1 text-xs text-amber-900 dark:text-amber-100">
                          {selectedCanonicalEvent.validationErrors.map((validationError) => (
                            <li key={validationError}>• {validationError}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="mt-2 text-xs text-amber-900 dark:text-amber-100">Brak błędów walidacji dla tego rekordu.</p>
                      )}
                      {selectedCanonicalEvent.warnings.length > 0 && (
                        <p className="mt-2 text-xs text-amber-800 dark:text-amber-200">
                          Ostrzeżenia: {selectedCanonicalEvent.warnings.join(', ')}
                        </p>
                      )}
                    </div>

                    <div className="rounded-xl bg-slate-950 p-3 text-slate-100">
                      <p className="text-xs font-bold uppercase tracking-wide text-slate-400">raw_payload</p>
                      <pre className="mt-2 max-h-[360px] overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed">
                        {selectedCanonicalEvent.rawPayloadText}
                      </pre>
                    </div>
                  </div>
                ) : (
                  <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
                    Brak danych do inspekcji. Wgraj pliki i uruchom rozpoznanie, aby zobaczyć rekordy.
                  </p>
                )}
              </div>

              <div className="rounded-2xl bg-white p-4 ring-1 ring-blue-100 dark:bg-gray-900 dark:ring-blue-900/60">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-wide text-blue-700 dark:text-blue-300">Panel Kontrolny AI</p>
                    <h3 className="mt-1 text-base font-black text-gray-950 dark:text-white">Ollama GPU</h3>
                  </div>
                  <span className={`rounded-full px-2 py-1 text-[11px] font-bold ${
                    ollamaStatus?.gpuConfirmed
                      ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100 dark:bg-emerald-950/30 dark:text-emerald-200 dark:ring-emerald-900/60'
                      : 'bg-amber-50 text-amber-700 ring-1 ring-amber-100 dark:bg-amber-950/30 dark:text-amber-200 dark:ring-amber-900/60'
                  }`}>
                    {ollamaStatus?.gpuConfirmed ? 'GPU potwierdzona' : 'AI wyłączona'}
                  </span>
                </div>
                <dl className="mt-3 space-y-2 text-xs text-gray-600 dark:text-gray-300">
                  <div className="flex justify-between gap-3">
                    <dt>Backend</dt>
                    <dd className="truncate font-semibold">{ollamaStatus?.computeBackend || 'unknown'} · {ollamaStatus?.gpuBackend || 'vulkan'}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt>Model</dt>
                    <dd className="truncate font-semibold">{ollamaStatus?.model || importIntelligenceView.aiRunStatus.modelLabel}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt>Niepełne</dt>
                    <dd className="font-semibold">{canonicalIncompleteRecordCount}</dd>
                  </div>
                </dl>
                <button
                  type="button"
                  onClick={runAiDiagnosticsAndRepair}
                  disabled={!canRunAiRepair || ollamaBusy}
                  className="mt-4 w-full rounded-xl bg-blue-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300 disabled:text-gray-600 dark:disabled:bg-gray-700 dark:disabled:text-gray-400"
                >
                  {ollamaBusy ? 'AI pracuje...' : 'Uruchom autodiagnostykę i naprawę AI'}
                </button>
                {!canRunAiRepair && (
                  <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                    Przycisk aktywuje się tylko przy potwierdzonej GPU i rekordach w wiadrze review.
                  </p>
                )}
                <div className="mt-4 rounded-xl bg-slate-950 p-3 text-slate-100">
                  <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Konsola Ollama</p>
                  <pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed">
                    {ollamaConsoleLines.join('\n')}
                  </pre>
                </div>
              </div>

              <div className="rounded-2xl bg-emerald-50 p-4 text-sm text-emerald-950 ring-1 ring-emerald-100 dark:bg-emerald-950/20 dark:text-emerald-100 dark:ring-emerald-900/60">
                <p className="font-bold">Przejście do obliczeń</p>
                <p className="mt-1 text-xs leading-relaxed">
                  Adapter obliczeń otrzyma jeden strumień danych i wybierze <span className="font-bold">{canonicalReadyRecordCount}</span> kompletnych rekordów. Rekordy niepełne, informacyjne i raw zostają w diagnostyce.
                </p>
              </div>
            </div>
          </aside>
        </div>
      </motion.section>

      {sourceManagerRows.length > 0 && (
        <motion.section
          data-motion="import-source-manager-clean"
          className="rounded-2xl border border-emerald-100 bg-emerald-50 p-5 shadow-sm dark:border-emerald-900/50 dark:bg-emerald-950/20"
          {...uiMotion.fadeUp(0.035)}
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-700 dark:text-emerald-300">
                Source Registry
              </p>
              <h2 className="mt-1 text-xl font-black text-emerald-950 dark:text-emerald-100">
                Źródła danych przyjęte do canonical_tax_input
              </h2>
              <p className="mt-1 max-w-3xl text-sm text-emerald-900 dark:text-emerald-200">
                Każdy plik jest widoczny jako źródło danych. Szczegóły rekordów i raw payload są w jednym strumieniu canonical_tax_input.json.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
              <span className="rounded-xl bg-white px-3 py-2 font-bold text-emerald-900 ring-1 ring-emerald-100 dark:bg-gray-900 dark:text-emerald-100 dark:ring-emerald-900/60">
                Pliki: {sourceManagerRows.length}
              </span>
              <span className="rounded-xl bg-white px-3 py-2 font-bold text-emerald-900 ring-1 ring-emerald-100 dark:bg-gray-900 dark:text-emerald-100 dark:ring-emerald-900/60">
                Gotowe: {canonicalReadyRecordCount}
              </span>
              <span className="rounded-xl bg-white px-3 py-2 font-bold text-emerald-900 ring-1 ring-emerald-100 dark:bg-gray-900 dark:text-emerald-100 dark:ring-emerald-900/60">
                Niepełne: {canonicalIncompleteRecordCount}
              </span>
              <span className="rounded-xl bg-white px-3 py-2 font-bold text-emerald-900 ring-1 ring-emerald-100 dark:bg-gray-900 dark:text-emerald-100 dark:ring-emerald-900/60">
                Info/raw: {canonicalInformationalRecordCount + canonicalUnrecognizedRecordCount}
              </span>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
            {sourceManagerRows.map((source) => (
              <div key={source.id} className="rounded-2xl bg-white p-4 text-sm ring-1 ring-emerald-100 dark:bg-gray-900 dark:ring-emerald-900/60">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-bold text-gray-950 dark:text-white">{source.filename}</p>
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      {source.roleLabel} · {source.detectedType}
                    </p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2 py-1 text-[11px] font-bold ${
                    source.needsReviewCount > 0 || source.warningCount > 0
                      ? 'bg-amber-50 text-amber-700 ring-1 ring-amber-100 dark:bg-amber-950/30 dark:text-amber-200 dark:ring-amber-900/60'
                      : 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100 dark:bg-emerald-950/30 dark:text-emerald-200 dark:ring-emerald-900/60'
                  }`}>
                    {source.importStatusLabel}
                  </span>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-gray-700 dark:text-gray-300 sm:grid-cols-4">
                  <span className="rounded-lg bg-gray-50 px-2 py-1 dark:bg-gray-800">Parser: {source.parser}</span>
                  <span className="rounded-lg bg-gray-50 px-2 py-1 dark:bg-gray-800">AI: {source.aiStatusLabel}</span>
                  <span className="rounded-lg bg-gray-50 px-2 py-1 dark:bg-gray-800">Rozpoznanie: {source.recognitionStatusLabel}</span>
                  <span className="rounded-lg bg-gray-50 px-2 py-1 dark:bg-gray-800">Karty: {source.enrichedDossierCount}</span>
                </div>
                <p className="mt-2 text-xs text-gray-600 dark:text-gray-300">
                  Rekordy: {source.recordCount} · użyte: {source.usedRecordCount} · kontekst: {source.contextRecordCount} · review: {source.needsReviewCount}
                </p>
              </div>
            ))}
          </div>
        </motion.section>
      )}


      <InsightDrawer
        open={Boolean(activeInsight) && !onOpenInsight}
        title={
          insightSourceDetails
            ? `Źródło: ${insightSourceDetails.source.filename}`
            : insightAction
              ? `Sprawa importu: ${insightAction.label}`
              : 'Szczegóły importu'
        }
        subtitle={
          insightSourceDetails
            ? insightSourceDetails.source.roleLabel
            : insightAction
              ? insightAction.statusLabel
              : undefined
        }
        onClose={() => setActiveInsight(null)}
      >
        {insightSourceDetails && (
          <>
            <section>
              <h4 className="text-sm font-semibold text-gray-950 dark:text-white">Co to znaczy</h4>
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
                Ten plik ma rolę: {insightSourceDetails.source.roleLabel}. Każdy plik jest źródłem rekordów, komentarzy
                albo diagnostyki dla canonical_tax_input.json.
              </p>
            </section>
            <section>
              <h4 className="text-sm font-semibold text-gray-950 dark:text-white">Wpływ na canonical input</h4>
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
                Rekordy z tego pliku są zachowane jako dane wejściowe. Adapter obliczeń wybiera technicznie kompletne rekordy,
                a niekompletne zostają w diagnostyce bez blokowania importu.
              </p>
            </section>
            <section>
              <h4 className="text-sm font-semibold text-gray-950 dark:text-white">Co zrobić</h4>
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
                {insightSourceDetails.relatedActions[0]?.userAction || 'Nie trzeba nic robić, jeśli status źródła jest prawidłowy.'}
              </p>
            </section>
            <section className="rounded-xl border border-gray-200 bg-gray-50 p-3 text-sm dark:border-gray-700 dark:bg-gray-900/70">
              <h4 className="font-semibold text-gray-950 dark:text-white">Źródła / szczegóły</h4>
              <dl className="mt-2 space-y-2 text-xs text-gray-600 dark:text-gray-300">
                <div>
                  <dt className="font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Ścieżka</dt>
                  <dd className="break-all">{insightSourceDetails.source.pathLabel}</dd>
                </div>
                {isExpertMode && (
                  <div>
                    <dt className="font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Hash</dt>
                    <dd className="break-all">{insightSourceDetails.source.hashShort || 'brak'}</dd>
                  </div>
                )}
                <div>
                  <dt className="font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Sekcje</dt>
                  <dd>{insightSourceDetails.source.sectionsLabel}</dd>
                </div>
                <div>
                  <dt className="font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Liczniki</dt>
                  <dd>
                    {Object.entries(insightSourceDetails.source.recordCounts || {})
                      .map(([key, value]) => `${key}: ${value}`)
                      .join(', ') || 'brak liczników'}
                  </dd>
                </div>
              </dl>
            </section>
            {(insightSourceDetails.source.warnings?.length || insightSourceDetails.source.errors?.length) ? (
              <section className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-200">
                <h4 className="font-semibold">Co wymaga uwagi</h4>
                <p className="mt-2 text-xs">
                  {[...(insightSourceDetails.source.errors || []), ...(insightSourceDetails.source.warnings || [])].join(' · ')}
                </p>
              </section>
            ) : null}
            {insightSourceDetails.relatedActions.length > 0 && (
              <section>
                <h4 className="text-sm font-semibold text-gray-950 dark:text-white">Powiązane sprawy</h4>
                <ul className="mt-2 space-y-2 text-sm text-gray-600 dark:text-gray-300">
                  {insightSourceDetails.relatedActions.slice(0, 8).map((action) => (
                    <li key={action.actionId} className="rounded-lg border border-gray-200 bg-white p-2 dark:border-gray-700 dark:bg-gray-900">
                      <span className="font-semibold">{action.label}</span>
                      <span className="ml-2 text-xs text-gray-500">{action.statusLabel}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
        {insightAction && (
          <>
            <section>
              <h4 className="text-sm font-semibold text-gray-950 dark:text-white">Co to znaczy</h4>
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">{insightAction.reason || insightAction.label}</p>
            </section>
            <section>
              <h4 className="text-sm font-semibold text-gray-950 dark:text-white">Wpływ na canonical input</h4>
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
                {isReviewSeverity(insightAction.severity)
                  ? 'Ta sprawa wymaga kontroli przed podatkowym użyciem danych. Import pliku pozostaje przyjęty.'
                  : 'Ta sprawa jest kontrolą workflow i nie zmienia kwoty automatycznie.'}
              </p>
            </section>
            <section>
              <h4 className="text-sm font-semibold text-gray-950 dark:text-white">Co zrobić</h4>
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">{insightAction.userAction}</p>
            </section>
            <section className="rounded-xl border border-gray-200 bg-gray-50 p-3 text-xs text-gray-600 dark:border-gray-700 dark:bg-gray-900/70 dark:text-gray-300">
              <p><span className="font-semibold">Priorytet:</span> {actionSeverityLabel(insightAction.severity)}</p>
              <p><span className="font-semibold">Obszar:</span> {insightAction.area}</p>
              <p><span className="font-semibold">Źródła:</span> {insightAction.sourceIds.join(', ') || 'brak'}</p>
              <p><span className="font-semibold">Koszty:</span> {insightAction.relatedCostIds.join(', ') || 'brak'}</p>
            </section>
            {insightAction.historySearchTerm && (
              <button
                type="button"
                onClick={() => onOpenHistorySearch?.(insightAction.historySearchTerm || '', insightAction.linkedRowId)}
                className="w-full rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
              >
                Przejdź do historii
              </button>
            )}
          </>
        )}
      </InsightDrawer>
    </motion.div>
  );
}
