import { odmienLiczebnik } from '../../portfel/services/odmianaLiczebnika';
import type {
  BrokerFileActionQueueItem,
  BrokerStorageResolvedSource,
  BrokerFileSourceManifest,
  CoverageMatrixEntry,
  SourceTrustItem,
  TaxFilingPackageAuditAppendix,
} from '../hooks/useTaxEngineRun';
import type { BrokerFileActionOverride, BrokerFileActionOverrideStatus } from './brokerFileActionOverrides';
import type { FileInfo } from '../types';
import { getStorageFileDisposition, isBrokerReportFile } from './storageImportDisposition';

export type BrokerFileCoverageStatus = 'complete' | 'partial' | 'missing' | 'conflict' | 'not_applicable';
export type BrokerFileSourceRole =
  | 'transaction_source'
  | 'transaction_report'
  | 'data_context'
  | 'primary_tax'
  | 'baseline_tax'
  | 'baseline_support'
  | 'candidate_tax'
  | 'tax'
  | 'supplemental'
  | 'reconciliation'
  | 'evidence'
  | 'analytics'
  | 'nbp_rates'
  | 'fallback'
  | 'duplicate'
  | 'unknown';
export type BrokerFileActionSeverity = 'blocking' | 'warning' | 'info';

export interface BrokerFileIntakeCoverageRow {
  area: string;
  label: string;
  status: BrokerFileCoverageStatus;
  message: string;
}

export interface BrokerFileIntakeSourceRow {
  sourceId: string;
  filename: string;
  pathLabel: string;
  detectedType: string;
  role: BrokerFileSourceRole;
  roleLabel: string;
  shortStatusLabel?: string;
  shortReason?: string;
  hashShort: string;
  dateRangeLabel: string;
  recordCountLabel: string;
  sectionsLabel: string;
  warningCount: number;
  errorCount: number;
  hasProblems: boolean;
  sections?: string[];
  recordCounts?: Record<string, number>;
  warnings?: string[];
  errors?: string[];
  reconciliationStatus?: string;
  reconciliationMessage?: string;
  confidenceScore?: number;
  reconciliationBreakdownLabel?: string;
}

export type SourceMapGroupId =
  | 'active_tax'
  | 'candidate_tax'
  | 'evidence'
  | 'nbp_rates'
  | 'reconciliation'
  | 'fallback';

export interface SourceMapGroup {
  id: SourceMapGroupId;
  label: string;
  description: string;
  count: number;
  rows: BrokerFileIntakeSourceRow[];
}

export interface SourceMapViewModel {
  headline: string;
  summary: string;
  totalFiles: number;
  activeTaxCount: number;
  candidateCount: number;
  evidenceCount: number;
  nbpCount: number;
  reconciliationCount: number;
  fallbackCount: number;
  groups: SourceMapGroup[];
}

export interface BrokerFileIntakeActionRow {
  id: string;
  actionId: string;
  severity: BrokerFileActionSeverity;
  area: string;
  label: string;
  userAction: string;
  sourceIds: string[];
  relatedSourceIds: string[];
  relatedCostIds: string[];
  historySearchTerm?: string | null;
  status: BrokerFileActionOverrideStatus;
  statusLabel: string;
  userNote?: string;
  linkedRowId?: string | null;
  reason?: string;
  statusSource?: string;
  supplementalOnlyBreakdownLabel?: string;
}

export interface BrokerFileActionProgress {
  total: number;
  open: number;
  resolved: number;
  ignored: number;
  blocking: number;
  warnings: number;
}

export interface BrokerFileSourceDetails {
  source: BrokerFileIntakeSourceRow;
  relatedActions: BrokerFileIntakeActionRow[];
}

export interface BrokerFileIntakeSummary {
  totalSources: number;
  taxSources: number;
  evidenceOnlySources: number;
  missingAreas: string[];
  conflictCount: number;
  recommendedAction: string;
  coverageRows: BrokerFileIntakeCoverageRow[];
  sourceRows: BrokerFileIntakeSourceRow[];
  actionRows: BrokerFileIntakeActionRow[];
  actionProgress: BrokerFileActionProgress;
  openActionCount: number;
  resolvedActionCount: number;
  ignoredActionCount: number;
  sourceDetails: BrokerFileSourceDetails[];
  processedStorageFiles: string[];
  sourceReconciliation?: NonNullable<TaxFilingPackageAuditAppendix['source_reconciliation_report']>;
  sourceReconciliationBreakdownLabel?: string;
  sourceMap?: SourceMapViewModel;
}

export interface StorageFileDisplayState {
  filename: string;
  processed: boolean;
  statusLabel: 'Przetworzony' | 'Nowy plik';
  auditRoleLabel: string;
  auditRole: BrokerFileSourceRole | 'needs_run';
  requiresEngineRun: boolean;
  canImportToLocalBase: boolean;
  nonImportableReason?: string;
}

const DEFAULT_ACTION = 'Wgraj pliki brokera albo przelicz raport, aby zobaczyć kompletność danych.';

function normalizeStoragePathKey(path: string | undefined | null): string {
  return String(path || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .toLowerCase();
}

function storageBasenameKey(path: string | undefined | null): string {
  const normalized = normalizeStoragePathKey(path);
  return normalized.split('/').filter(Boolean).pop() || normalized;
}

function normalizeStatus(status: string | undefined): BrokerFileCoverageStatus {
  if (status === 'complete' || status === 'partial' || status === 'missing' || status === 'conflict' || status === 'not_applicable') {
    return status;
  }
  return 'partial';
}

function sourceContributesToTax(source: BrokerFileSourceManifest): boolean {
  return source.contributesToTax === true;
}

function countFromSources(sources: BrokerFileSourceManifest[], predicate: (source: BrokerFileSourceManifest) => boolean): number {
  return sources.filter(predicate).length;
}

function sourceIdentity(source: Pick<BrokerFileSourceManifest, 'sourceId' | 'filename'>): string {
  return source.sourceId || source.filename || 'source:unknown';
}

function sourceLookupKeys(source: Pick<BrokerFileSourceManifest, 'sourceId' | 'filename'>): string[] {
  return [source.sourceId, source.filename?.toLowerCase()].filter(Boolean) as string[];
}

function buildSourceSet(sources: BrokerFileSourceManifest[] | undefined): Set<string> {
  const set = new Set<string>();
  for (const source of sources || []) {
    for (const key of sourceLookupKeys(source)) {
      set.add(key);
    }
  }
  return set;
}

function sourceMergeKey(source: BrokerFileSourceManifest): string {
  const pathKey = normalizeStoragePathKey(source.relativePath || source.filename || null);
  return pathKey || sourceIdentity(source);
}

function mergeSources(sources: BrokerFileSourceManifest[]): BrokerFileSourceManifest[] {
  const merged = new Map<string, BrokerFileSourceManifest>();
  const recordTotal = (counts?: Record<string, number>) => Object.values(counts || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
  for (const source of sources) {
    const key = sourceMergeKey(source);
    const previous = merged.get(key);
    const previousRole = previous?.sourceResolutionRole && previous.sourceResolutionRole !== 'unknown'
      ? previous.sourceResolutionRole
      : undefined;
    const previousFileRole = previous?.fileRole && previous.fileRole !== 'unknown'
      ? previous.fileRole
      : undefined;
    merged.set(key, {
      ...previous,
      ...source,
      sourceId: previous?.sourceId || source.sourceId || key,
      relativePath: source.relativePath || previous?.relativePath,
      filename: source.filename || previous?.filename,
      contributesToTax: source.contributesToTax ?? previous?.contributesToTax,
      sourceResolutionRole: previousRole || source.sourceResolutionRole || previous?.sourceResolutionRole,
      sourceResolutionReason: previous?.sourceResolutionReason || source.sourceResolutionReason,
      sourceResolutionScore: source.sourceResolutionScore ?? previous?.sourceResolutionScore,
      fileRole: previousFileRole || source.fileRole || previous?.fileRole,
      sections: previous?.sections || source.sections,
      recordCounts: recordTotal(source.recordCounts) > recordTotal(previous?.recordCounts)
        ? source.recordCounts
        : previous?.recordCounts || source.recordCounts,
      warnings: previous?.warnings || source.warnings,
      errors: previous?.errors || source.errors,
    });
  }
  return Array.from(merged.values());
}

function sourceRole(source: BrokerFileSourceManifest, taxSourceKeys: Set<string>, evidenceSourceKeys: Set<string>): BrokerFileSourceRole {
  const fileRole = source.fileRole;
  if (
    fileRole === 'primary_tax'
    || fileRole === 'baseline_tax'
    || fileRole === 'baseline_support'
    || fileRole === 'candidate_tax'
    || fileRole === 'transaction_source'
    || fileRole === 'transaction_report'
    || fileRole === 'data_context'
    || fileRole === 'supplemental'
    || fileRole === 'reconciliation'
    || fileRole === 'evidence'
    || fileRole === 'analytics'
    || fileRole === 'nbp_rates'
    || fileRole === 'fallback'
    || fileRole === 'duplicate'
  ) {
    return fileRole;
  }
  const keys = sourceLookupKeys(source);
  if (keys.some((key) => taxSourceKeys.has(key))) return 'tax';
  if (keys.some((key) => evidenceSourceKeys.has(key))) return 'evidence';
  const resolvedRole = source.sourceResolutionRole;
  if (
    resolvedRole === 'primary_tax'
    || resolvedRole === 'baseline_tax'
    || resolvedRole === 'baseline_support'
    || resolvedRole === 'candidate_tax'
    || resolvedRole === 'transaction_source'
    || resolvedRole === 'transaction_report'
    || resolvedRole === 'data_context'
    || resolvedRole === 'supplemental'
    || resolvedRole === 'reconciliation'
    || resolvedRole === 'evidence'
    || resolvedRole === 'analytics'
    || resolvedRole === 'nbp_rates'
    || resolvedRole === 'fallback'
    || resolvedRole === 'duplicate'
  ) {
    return resolvedRole;
  }
  if (source.contributesToTax === true) return 'tax';
  if (source.contributesToTax === false) return 'evidence';
  return 'unknown';
}

function roleLabel(role: BrokerFileSourceRole): string {
  if (role === 'transaction_source') return 'Źródło transakcyjne';
  if (role === 'transaction_report') return 'Raport transakcyjny';
  if (role === 'data_context') return 'Kontekst danych';
  if (role === 'primary_tax') return 'Źródło transakcyjne';
  if (role === 'baseline_tax') return 'Źródło transakcyjne';
  if (role === 'baseline_support') return 'Źródło pomocnicze';
  if (role === 'candidate_tax') return 'Raport transakcyjny';
  if (role === 'tax') return 'Źródło transakcyjne';
  if (role === 'supplemental') return 'Źródło pomocnicze';
  if (role === 'reconciliation') return 'Kontrola pozycji';
  if (role === 'evidence') return 'Dowód źródłowy';
  if (role === 'analytics') return 'Analityka / dowód';
  if (role === 'nbp_rates') return 'Kursy NBP';
  if (role === 'fallback') return 'Pominięty fallback';
  if (role === 'duplicate') return 'Pominięty duplikat';
  return 'Nieustalone';
}

function sourceShortStatus(role: BrokerFileSourceRole, source: BrokerFileSourceManifest): Pick<BrokerFileIntakeSourceRow, 'shortStatusLabel' | 'shortReason'> {
  const reason = source.sourceResolutionReason || source.warnings?.[0] || '';
  if (role === 'transaction_source' || role === 'transaction_report' || role === 'primary_tax' || role === 'baseline_tax' || role === 'baseline_support' || role === 'tax') {
    return {
      shortStatusLabel: 'rozpoznany',
      shortReason: reason || 'Ten plik wnosi rekordy do canonical_tax_input.json.',
    };
  }
  if (role === 'candidate_tax') {
    return {
      shortStatusLabel: 'rozpoznany',
      shortReason: reason || 'Raport wnosi rekordy do wspólnego strumienia canonical_tax_input.json.',
    };
  }
  if (role === 'nbp_rates') {
    return {
      shortStatusLabel: 'kursy',
      shortReason: reason || 'Plik dostarcza kursy NBP używane do przeliczeń walutowych.',
    };
  }
  if (role === 'reconciliation') {
    return {
      shortStatusLabel: 'kontrola',
      shortReason: reason || 'Plik służy do kontroli pozycji i diagnostyki rekordów.',
    };
  }
  if (role === 'data_context' || role === 'evidence' || role === 'analytics' || role === 'supplemental') {
    return {
      shortStatusLabel: 'kontekst',
      shortReason: reason || 'Plik jest dowodem, analityką albo źródłem pomocniczym w strumieniu danych.',
    };
  }
  if (role === 'fallback' || role === 'duplicate') {
    return {
      shortStatusLabel: 'zachowany',
      shortReason: reason || 'Plik pozostaje w inwentarzu i nie jest usuwany z procesu.',
    };
  }
  return {
    shortStatusLabel: 'do rozpoznania',
    shortReason: reason || 'Rola pliku nie jest jeszcze jednoznaczna; przelicz raport albo sprawdź szczegóły źródła.',
  };
}

function sourceMapGroupForRole(role: BrokerFileSourceRole): SourceMapGroupId {
  if (role === 'transaction_source') return 'active_tax';
  if (role === 'transaction_report') return 'candidate_tax';
  if (role === 'data_context') return 'fallback';
  if (role === 'primary_tax' || role === 'baseline_tax' || role === 'baseline_support' || role === 'tax') return 'active_tax';
  if (role === 'candidate_tax') return 'candidate_tax';
  if (role === 'nbp_rates') return 'nbp_rates';
  if (role === 'reconciliation') return 'reconciliation';
  if (role === 'fallback' || role === 'duplicate' || role === 'unknown') return 'fallback';
  return 'evidence';
}

const SOURCE_MAP_GROUP_META: Record<SourceMapGroupId, { label: string; description: string }> = {
  active_tax: {
    label: 'Źródła transakcyjne',
    description: 'Pliki, które wnoszą transakcje do wspólnego strumienia danych.',
  },
  candidate_tax: {
    label: 'Raporty transakcyjne',
    description: 'Raporty rozpoznane jako dodatkowe źródła transakcji.',
  },
  evidence: {
    label: 'Dowody i kontekst',
    description: 'Dowody, analityka i pliki pomocnicze zachowane jako dane źródłowe.',
  },
  nbp_rates: {
    label: 'NBP',
    description: 'Archiwa kursów do przeliczeń walutowych.',
  },
  reconciliation: {
    label: 'Kontrola pozycji',
    description: 'Raporty depozytariusza i źródła do sprawdzania pozycji.',
  },
  fallback: {
    label: 'Pozostałe pliki',
    description: 'Starsze, zdublowane albo nierozstrzygnięte pliki zachowane w inwentarzu.',
  },
};

function buildSourceMap(sourceRows: BrokerFileIntakeSourceRow[]): SourceMapViewModel {
  const grouped = new Map<SourceMapGroupId, BrokerFileIntakeSourceRow[]>();
  for (const row of sourceRows) {
    const groupId = sourceMapGroupForRole(row.role);
    grouped.set(groupId, [...(grouped.get(groupId) || []), row]);
  }
  const order: SourceMapGroupId[] = ['active_tax', 'candidate_tax', 'evidence', 'nbp_rates', 'reconciliation', 'fallback'];
  const groups = order.map((id) => {
    const rows = grouped.get(id) || [];
    return {
      id,
      label: SOURCE_MAP_GROUP_META[id].label,
      description: SOURCE_MAP_GROUP_META[id].description,
      count: rows.length,
      rows,
    };
  });
  const activeTaxCount = groups.find((group) => group.id === 'active_tax')?.count || 0;
  const candidateCount = groups.find((group) => group.id === 'candidate_tax')?.count || 0;
  const evidenceCount = groups.find((group) => group.id === 'evidence')?.count || 0;
  const nbpCount = groups.find((group) => group.id === 'nbp_rates')?.count || 0;
  const reconciliationCount = groups.find((group) => group.id === 'reconciliation')?.count || 0;
  const fallbackCount = groups.find((group) => group.id === 'fallback')?.count || 0;
  return {
    headline: sourceRows.length > 0 ? 'Program ma rozpoznane źródła danych' : 'Brak źródeł w inwentarzu',
    summary: `${activeTaxCount + candidateCount} transakcyjne, ${evidenceCount + nbpCount + reconciliationCount + fallbackCount} kontekstowe lub techniczne.`,
    totalFiles: sourceRows.length,
    activeTaxCount,
    candidateCount,
    evidenceCount,
    nbpCount,
    reconciliationCount,
    fallbackCount,
    groups,
  };
}

function isReconciliationStorageFilename(filename: string): boolean {
  const lowerFilename = filename.toLowerCase();
  return (
    lowerFilename.includes('depositary') ||
    lowerFilename.includes('depozytariusz') ||
    lowerFilename.includes('dezpozytariusz') ||
    lowerFilename.includes('depozyt') ||
    lowerFilename.includes('depoz')
  );
}

function detectedTypeLabel(source: BrokerFileSourceManifest): string {
  return source.detectedType || 'nieustalony typ';
}

function hashShort(hash: string | null | undefined): string {
  return hash ? hash.slice(0, 12) : '-';
}

function dateRangeLabel(source: BrokerFileSourceManifest): string {
  const from = source.dateRange?.from || null;
  const to = source.dateRange?.to || null;
  if (from && to) return `${from} - ${to}`;
  if (from) return `od ${from}`;
  if (to) return `do ${to}`;
  return 'brak zakresu';
}

function recordCountLabel(source: BrokerFileSourceManifest): string {
  const total = Object.values(source.recordCounts || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
  return total > 0 ? `${total} ${odmienLiczebnik(total, 'rekord', 'rekordy', 'rekordów')}` : 'brak liczników';
}

function sectionsLabel(source: BrokerFileSourceManifest): string {
  return source.sections?.length ? source.sections.join(', ') : 'brak sekcji';
}

function reconciliationBreakdownLabel(
  breakdown: NonNullable<TaxFilingPackageAuditAppendix['source_reconciliation_report']>['comparedSources'][number]['supplementalOnlyBreakdown'] | undefined,
): string {
  return (breakdown || [])
    .filter((item) => Number(item.count || 0) > 0)
    .map((item) => `${item.label || item.kind}: ${item.count}`)
    .join(', ');
}

function aggregateReconciliationBreakdownLabel(
  comparedSources: NonNullable<TaxFilingPackageAuditAppendix['source_reconciliation_report']>['comparedSources'] | undefined,
): string {
  const totals = new Map<string, { label: string; count: number }>();
  for (const source of comparedSources || []) {
    for (const item of source.supplementalOnlyBreakdown || []) {
      const key = item.kind || item.label;
      if (!key) continue;
      const current = totals.get(key) || { label: item.label || item.kind || key, count: 0 };
      current.count += Number(item.count || 0);
      totals.set(key, current);
    }
  }
  return Array.from(totals.values())
    .filter((item) => item.count > 0)
    .map((item) => `${item.label}: ${item.count}`)
    .join(', ');
}

function fileInfoToSource(file: FileInfo): BrokerFileSourceManifest {
  return {
    sourceId: `file:${file.name}`,
    filename: file.name,
    detectedType: file.type,
    contributesToTax: file.type === 'nbp_a' ? false : undefined,
    recordCounts: file.recordCount ? { records: file.recordCount } : undefined,
    warnings: file.status === 'warning' ? ['Import zakończony z ostrzeżeniem.'] : undefined,
    errors: file.status === 'error' ? ['Import zakończony błędem.'] : undefined,
  };
}

function previewSourceToManifest(source: BrokerStorageResolvedSource): BrokerFileSourceManifest {
  return {
    sourceId: source.sourceId,
    filename: source.filename,
    relativePath: source.relativePath || source.filename,
    hash: source.hash || null,
    detectedType: source.detectedType || null,
    sections: source.sections || [],
    recordCounts: source.recordCounts || {},
    dateRange: source.dateRange,
    contributesToCanonicalInput: true,
    contributesToTax: false,
    sourceResolutionRole: source.role,
    sourceResolutionReason: source.reason,
    sourceResolutionScore: source.score,
    warnings: source.role === 'candidate_tax' ? [source.reason || 'Raport brokera został zachowany jako źródło rekordów.'] : undefined,
  };
}

function sourceTrustItemToManifest(source: SourceTrustItem): BrokerFileSourceManifest {
  const usageStatus = String(source.usage_status || '');
  const sourceWarnings = [
    ...(source.warnings || []),
    ...(source.review_reasons || []),
  ];
  const roleByUsageStatus: Record<string, BrokerFileSourceRole> = {
    transaction_source: 'transaction_source',
    transaction_report: 'transaction_report',
    source_evidence: 'evidence',
    nbp_rates: 'nbp_rates',
    position_reconciliation: 'reconciliation',
    data_context: 'fallback',
    duplicate_source: 'duplicate',
    technical_source: 'evidence',
    source_review: 'unknown',
  };
  return {
    sourceId: source.source_id,
    filename: source.file_name,
    relativePath: source.file_path || source.file_name,
    hash: source.file_hash || null,
    detectedType: source.detected_role || source.file_type,
    recordCounts: source.record_counts || {},
    contributesToTax: usageStatus === 'transaction_source',
    sourceResolutionRole: roleByUsageStatus[usageStatus] || 'evidence',
    sourceResolutionReason: sourceWarnings[0] || undefined,
    warnings: sourceWarnings,
    errors: [],
  };
}

function registryRoleToManifestRole(role: string, pitImpact = ''): BrokerFileSourceRole {
  const normalizedRole = role.trim().toLowerCase();
  const normalizedImpact = pitImpact.trim().toLowerCase();
  if (normalizedRole === 'transaction_source' || normalizedRole === 'pit_active' || normalizedImpact === 'active') return 'transaction_source';
  if (normalizedRole === 'transaction_report' || normalizedRole === 'pit_candidate' || normalizedImpact === 'candidate') return 'transaction_report';
  if (normalizedRole === 'baseline_support') return 'data_context';
  if (normalizedRole === 'nbp_rates') return 'nbp_rates';
  if (normalizedRole === 'cash_context' || normalizedRole === 'context_only' || normalizedRole === 'data_context') return 'data_context';
  if (normalizedRole === 'position_reconciliation') return 'reconciliation';
  if (normalizedRole === 'analytics') return 'analytics';
  if (normalizedRole === 'evidence') return 'evidence';
  return 'unknown';
}

function sourceRegistryItemToManifest(source: Record<string, unknown>): BrokerFileSourceManifest {
  const sourceId = String(source.source_id || source.sourceId || source.file_sha256 || '').trim();
  const filename = String(source.filename || source.original_filename || source.stored_path || sourceId || 'nieznane źródło');
  const role = registryRoleToManifestRole(String(source.source_role || source.final_role || ''), String(source.pit_impact || ''));
  const recordCounts: Record<string, number> = {};
  const records = Number(source.record_count || source.used_record_count || 0);
  if (Number.isFinite(records) && records > 0) recordCounts.records = records;
  return {
    sourceId: sourceId || `storage:${filename}`,
    filename,
    relativePath: String(source.relative_path || source.stored_path || filename),
    hash: typeof source.file_sha256 === 'string' ? source.file_sha256 : null,
    detectedType: String(source.detected_type || source.mime_type || source.source_role || source.final_role || 'unknown'),
    recordCounts,
    contributesToCanonicalInput: true,
    contributesToTax: false,
    sourceResolutionRole: role,
    sourceResolutionReason: typeof source.reason === 'string' ? source.reason : undefined,
    warnings: Array.isArray(source.warnings) ? source.warnings.map(String) : [],
    errors: Array.isArray(source.errors) ? source.errors.map(String) : [],
  };
}

function normalizedStorageManifestItemToManifest(source: Record<string, unknown>): BrokerFileSourceManifest {
  const parser = typeof source.deterministic_parser === 'object' && source.deterministic_parser
    ? source.deterministic_parser as Record<string, unknown>
    : {};
  return sourceRegistryItemToManifest({
    source_id: `storage:${String(source.file_sha256 || source.original_filename || '').slice(0, 12)}`,
    filename: source.original_filename,
    relative_path: source.stored_path,
    file_sha256: source.file_sha256,
    detected_type: source.mime_type || source.final_role,
    source_role: source.final_role,
    pit_impact: source.pit_impact,
    record_count: parser.records_count,
    reason: source.reason,
    warnings: parser.warnings,
    errors: parser.errors,
  });
}

function buildSourceRows(
  auditAppendix: TaxFilingPackageAuditAppendix | null | undefined,
  files: FileInfo[],
): BrokerFileIntakeSourceRow[] {
  const controlTower = auditAppendix?.broker_file_control_tower;
  const taxSourceKeys = buildSourceSet(controlTower?.sections?.canonical_sources);
  const evidenceSourceKeys = buildSourceSet(controlTower?.sections?.context_sources);
  const sourceRegistryRows = auditAppendix?.source_registry || [];
  const normalizedStorageManifestRows = sourceRegistryRows.length > 0
    ? []
    : (auditAppendix?.normalized_storage_manifest || []);
  const sources = mergeSources([
    ...(auditAppendix?.source_manifest_v2 || []),
    ...(controlTower?.sections?.what_was_imported || []),
    ...(controlTower?.sections?.canonical_sources || []),
    ...(controlTower?.sections?.context_sources || []),
    ...(auditAppendix?.import_intelligence_report?.sources || []),
    ...files.map(fileInfoToSource),
    ...(auditAppendix?.auto_file_recognition_report?.sources || []),
    ...(auditAppendix?.source_resolution_preview?.sources || []).map(previewSourceToManifest),
    ...(auditAppendix?.source_trust_summary?.items || []).map(sourceTrustItemToManifest),
    ...sourceRegistryRows.map(sourceRegistryItemToManifest),
    ...normalizedStorageManifestRows.map(normalizedStorageManifestItemToManifest),
  ]);
  const reconciliationBySource = new Map(
    (auditAppendix?.source_reconciliation_report?.comparedSources || []).map((entry) => [entry.sourceId, entry]),
  );

  return sources.map((source) => {
    const role = sourceRole(source, taxSourceKeys, evidenceSourceKeys);
    const identity = sourceIdentity(source);
    const reconciliation = reconciliationBySource.get(identity) || (
      auditAppendix?.source_reconciliation_report?.primarySourceId === identity
        ? {
            sourceId: identity,
            filename: source.filename || identity,
            role: 'primary_tax',
            matchedCount: 0,
            primaryOnlyCount: 0,
            supplementalOnlyCount: 0,
            duplicateCount: 0,
            dateRangeGap: false,
            confidenceScore: auditAppendix.source_reconciliation_report.summary?.confidenceScore ?? 100,
            status: 'matched',
            message: 'Główne źródło PIT użyte jako punkt odniesienia kontroli zgodności.',
          }
        : undefined
    );
    const warningCount = source.warnings?.length || 0;
    const errorCount = source.errors?.length || 0;
    const reconciliationNeedsReview = reconciliation
      ? ['partial', 'needs_review'].includes(String(reconciliation.status)) || Number(reconciliation.supplementalOnlyCount || 0) > 0
      : false;
    const breakdownLabel = reconciliationBreakdownLabel(reconciliation?.supplementalOnlyBreakdown);
    return {
      sourceId: identity,
      filename: source.filename || source.sourceId || 'nieznane źródło',
      pathLabel: source.relativePath || source.filename || source.sourceId || 'nieznane źródło',
      detectedType: detectedTypeLabel(source),
      role,
      roleLabel: roleLabel(role),
      ...sourceShortStatus(role, source),
      hashShort: hashShort(source.hash),
      dateRangeLabel: dateRangeLabel(source),
      recordCountLabel: recordCountLabel(source),
      sectionsLabel: sectionsLabel(source),
      warningCount: warningCount + (reconciliationNeedsReview ? 1 : 0),
      errorCount,
      hasProblems: warningCount > 0 || errorCount > 0 || reconciliationNeedsReview,
      sections: source.sections || [],
      recordCounts: source.recordCounts || {},
      warnings: [
        ...(source.sourceResolutionReason ? [source.sourceResolutionReason] : []),
        ...(reconciliation?.message ? [reconciliation.message] : []),
        ...(breakdownLabel ? [`Rekordy tylko pomocnicze: ${breakdownLabel}.`] : []),
        ...(source.warnings || []),
      ],
      errors: source.errors || [],
      reconciliationStatus: reconciliation?.status,
      reconciliationMessage: reconciliation?.message,
      confidenceScore: reconciliation?.confidenceScore,
      reconciliationBreakdownLabel: breakdownLabel || undefined,
    };
  });
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number') return String(value);
  return '';
}

function recordField(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = stringifyUnknown(record[key]);
    if (value) return value;
  }
  return '';
}

function statusLabel(status: BrokerFileActionOverrideStatus): string {
  if (status === 'resolved') return 'Rozwiązane';
  if (status === 'ignored') return 'Zignorowane';
  return 'Otwarte';
}

function applyActionOverrides(
  row: Omit<BrokerFileIntakeActionRow, 'status' | 'statusLabel' | 'userNote' | 'linkedRowId'> & {
    userStatus?: string;
    userNote?: string | null;
    linkedRowId?: string | null;
    statusSource?: string;
    supplementalOnlyBreakdownLabel?: string;
  },
  overrideById: Map<string, BrokerFileActionOverride>,
): BrokerFileIntakeActionRow {
  const override = overrideById.get(row.actionId);
  const engineStatus = row.userStatus === 'resolved' || row.userStatus === 'ignored' || row.userStatus === 'open' ? row.userStatus : 'open';
  const status = override?.status || engineStatus;
  return {
    ...row,
    status,
    statusLabel: statusLabel(status),
    userNote: override?.userNote || row.userNote || undefined,
    linkedRowId: override?.linkedRowId ?? row.linkedRowId ?? null,
    statusSource: override ? 'local_user' : row.statusSource,
    supplementalOnlyBreakdownLabel: row.supplementalOnlyBreakdownLabel,
  };
}

function buildQueueActionRows(
  auditAppendix: TaxFilingPackageAuditAppendix | null | undefined,
  overrideById: Map<string, BrokerFileActionOverride>,
): BrokerFileIntakeActionRow[] {
  const queue = auditAppendix?.broker_file_action_queue || [];
  return queue.map((item: BrokerFileActionQueueItem) => {
    const actionId = item.action_id;
    return applyActionOverrides(
      {
        id: actionId,
        actionId,
        severity: item.severity === 'info' ? 'info' : 'warning',
        area: item.area || 'Import',
        label: item.label || 'Sprawa importowa',
        userAction: item.user_action || 'Zweryfikuj sprawę importową.',
        sourceIds: item.source_ids || [],
        relatedSourceIds: item.source_ids || [],
        relatedCostIds: item.cost_ids || [],
        historySearchTerm: item.history_search_term || null,
        reason: item.reason,
        userStatus: item.user_status,
        userNote: item.user_note,
        linkedRowId: item.linked_row_id,
        statusSource: item.status_source || 'silnik',
        supplementalOnlyBreakdownLabel: item.supplemental_only_breakdown_label || reconciliationBreakdownLabel(item.supplemental_only_breakdown),
      },
      overrideById,
    );
  }).sort(sortActions);
}

function sortActions(a: BrokerFileIntakeActionRow, b: BrokerFileIntakeActionRow): number {
  const order: Record<BrokerFileActionSeverity, number> = { blocking: 0, warning: 1, info: 2 };
  const statusOrder: Record<BrokerFileActionOverrideStatus, number> = { open: 0, resolved: 1, ignored: 2 };
  return statusOrder[a.status] - statusOrder[b.status] || order[a.severity] - order[b.severity] || a.label.localeCompare(b.label);
}

function buildActionRows(
  auditAppendix: TaxFilingPackageAuditAppendix | null | undefined,
  overrideById: Map<string, BrokerFileActionOverride>,
): BrokerFileIntakeActionRow[] {
  const queueRows = buildQueueActionRows(auditAppendix, overrideById);
  if (queueRows.length > 0) {
    return queueRows;
  }
  const rows: BrokerFileIntakeActionRow[] = [];
  const seen = new Set<string>();
  const add = (row: Omit<BrokerFileIntakeActionRow, 'actionId' | 'status' | 'statusLabel' | 'relatedSourceIds'>) => {
    const key = `${row.severity}:${row.area}:${row.label}:${row.userAction}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(applyActionOverrides({
      ...row,
      actionId: row.id,
      relatedSourceIds: row.sourceIds,
    }, overrideById));
  };

  for (const row of auditAppendix?.coverage_matrix || []) {
    const status = normalizeStatus(row.status);
    if (status !== 'missing' && status !== 'partial' && status !== 'conflict') continue;
    const severity: BrokerFileActionSeverity = 'warning';
    add({
      id: `coverage:${row.area}:${status}`,
      severity,
      area: row.label || row.area,
      label: `${row.label || row.area}: ${STATUS_TEXT[status] || status}`,
      userAction: row.recommendation || 'Uzupełnij albo zweryfikuj ten obszar danych brokera.',
      sourceIds: row.sourceIds || [],
      relatedCostIds: [],
    });
  }

  (auditAppendix?.broker_file_control_tower?.recommendedActions || []).forEach((action, index) => {
    add({
      id: `control-action:${index}`,
      severity: 'warning',
      area: 'Kontrola plików',
      label: 'Rekomendowana akcja importu',
      userAction: action,
      sourceIds: [],
      relatedCostIds: [],
    });
  });

  (auditAppendix?.import_intelligence_report?.missingExpectedSections || []).forEach((section, index) => {
    add({
      id: `missing-section:${index}:${section}`,
      severity: 'warning',
      area: 'Brakująca sekcja',
      label: `Brak oczekiwanej sekcji: ${section}`,
      userAction: `Dodaj plik zawierający sekcję "${section}" albo potwierdź, że nie dotyczy tego roku.`,
      sourceIds: [],
      relatedCostIds: [],
    });
  });

  (auditAppendix?.import_intelligence_report?.duplicates || []).forEach((duplicate, index) => {
    const sourceId = recordField(duplicate, ['sourceId', 'source_id', 'source']);
    const recordKey = recordField(duplicate, ['recordKey', 'record_key', 'key', 'id']);
    add({
      id: `duplicate:${index}:${sourceId}:${recordKey}`,
      severity: 'warning',
      area: 'Duplikaty',
      label: `Duplikat źródła lub rekordu${recordKey ? `: ${recordKey}` : ''}`,
      userAction: 'Sprawdź, czy ten sam rekord nie został wgrany z dwóch plików brokera.',
      sourceIds: sourceId ? [sourceId] : [],
      relatedCostIds: [],
    });
  });

  (auditAppendix?.import_intelligence_report?.conflicts || []).forEach((conflict, index) => {
    const sourceId = recordField(conflict, ['sourceId', 'source_id', 'source']);
    const field = recordField(conflict, ['field', 'column']);
    add({
      id: `conflict:${index}:${sourceId}:${field}`,
      severity: 'warning',
      area: 'Konflikty',
      label: `Konflikt danych${field ? `: ${field}` : ''}`,
      userAction: 'Zweryfikuj, który plik brokera jest autorytatywny dla tego pola.',
      sourceIds: sourceId ? [sourceId] : [],
      relatedCostIds: [],
    });
  });

  (auditAppendix?.import_intelligence_report?.recommendedActions || []).forEach((action, index) => {
    add({
      id: `import-action:${index}`,
      severity: 'warning',
      area: 'Import intelligence',
      label: 'Rekomendacja importu',
      userAction: action,
      sourceIds: [],
      relatedCostIds: [],
    });
  });

  (auditAppendix?.no_overpay_audit_v2?.potentiallyMissedCosts || []).forEach((cost, index) => {
    add({
      id: `missed-cost:${cost.costId || index}`,
      severity: 'warning',
      area: 'No Overpay Guard',
      label: cost.labelPl || cost.kind || cost.costId || 'Potencjalnie pominięty koszt',
      userAction: cost.userAction || cost.reason || 'Sprawdź, czy ten koszt powinien obniżyć podatek i czy ma dowód.',
      sourceIds: cost.sourceId ? [cost.sourceId] : [],
      relatedCostIds: cost.costId ? [cost.costId] : [],
    });
  });

  (auditAppendix?.no_overpay_audit_v2?.recommendedActions || []).forEach((action, index) => {
    add({
      id: `no-overpay-action:${index}`,
      severity: 'warning',
      area: 'No Overpay Guard',
      label: 'Rekomendacja kosztowa',
      userAction: action,
      sourceIds: [],
      relatedCostIds: [],
    });
  });

  return rows.sort(sortActions);
}

const STATUS_TEXT: Record<BrokerFileCoverageStatus, string> = {
  complete: 'kompletne',
  partial: 'częściowe',
  missing: 'brak',
  conflict: 'konflikt',
  not_applicable: 'nie dotyczy',
};

export function buildBrokerFileIntakeSummary(
  auditAppendix: TaxFilingPackageAuditAppendix | null | undefined,
  files: FileInfo[] = [],
  processedStorageFiles: string[] = [],
  brokerFileActionOverrides: BrokerFileActionOverride[] = [],
): BrokerFileIntakeSummary {
  const controlTower = auditAppendix?.broker_file_control_tower;
  const sources = auditAppendix?.source_manifest_v2 || [];
  const conflictCount = controlTower?.summary?.conflict_count ?? 0;
  const coverageRows = (auditAppendix?.coverage_matrix || []).map((row: CoverageMatrixEntry) => ({
    area: row.area,
    label: row.label || row.area,
    status: normalizeStatus(row.status),
    message: row.recommendation || `${row.label || row.area}: ${row.status || 'status nieznany'}`,
  }));
  const sourceRows = buildSourceRows(auditAppendix, files);
  const sourceMap = buildSourceMap(sourceRows);
  const taxRowRoles = new Set<BrokerFileSourceRole>(['transaction_source', 'transaction_report', 'primary_tax', 'baseline_tax', 'baseline_support', 'tax']);
  const totalSources = controlTower?.summary?.source_count ?? (sources.length > 0 ? sources.length : sourceRows.length || files.length);
  const taxSources = controlTower?.summary?.canonical_source_count ?? (
    sources.length > 0
      ? countFromSources(sources, sourceContributesToTax)
      : sourceRows.filter((source) => taxRowRoles.has(source.role)).length
  );
  const evidenceOnlySources = controlTower?.summary?.context_source_count ?? (
    sources.length > 0
      ? countFromSources(sources, (source) => source.contributesToTax === false)
      : sourceRows.filter((source) => !taxRowRoles.has(source.role)).length
  );
  const sourceReconciliationBreakdownLabel = aggregateReconciliationBreakdownLabel(
    auditAppendix?.source_reconciliation_report?.comparedSources,
  );
  const overrideById = new Map(brokerFileActionOverrides.map((override) => [override.actionId, override]));
  const actionRows = buildActionRows(auditAppendix, overrideById);
  const openActionCount = actionRows.filter((row) => row.status === 'open').length;
  const resolvedActionCount = actionRows.filter((row) => row.status === 'resolved').length;
  const ignoredActionCount = actionRows.filter((row) => row.status === 'ignored').length;
  const actionProgress: BrokerFileActionProgress = {
    total: actionRows.length,
    open: openActionCount,
    resolved: resolvedActionCount,
    ignored: ignoredActionCount,
    blocking: actionRows.filter((row) => row.status === 'open' && row.severity === 'blocking').length,
    warnings: actionRows.filter((row) => row.status === 'open' && row.severity === 'warning').length,
  };
  const sourceDetails = sourceRows.map((source) => ({
    source,
    relatedActions: actionRows.filter((action) => action.relatedSourceIds.includes(source.sourceId) || action.sourceIds.includes(source.sourceId) || action.sourceIds.includes(source.filename)),
  }));
  const missingAreas = coverageRows
    .filter((row) => row.status === 'missing' || row.status === 'partial' || row.status === 'conflict')
    .map((row) => row.label);
  const recommendedAction = controlTower?.recommendedActions?.[0]
    || auditAppendix?.source_reconciliation_report?.recommendedActions?.[0]
    || auditAppendix?.import_intelligence_report?.recommendedActions?.[0]
    || DEFAULT_ACTION;

  return {
    totalSources,
    taxSources,
    evidenceOnlySources,
    missingAreas,
    conflictCount,
    recommendedAction,
    coverageRows,
    sourceRows,
    actionRows,
    actionProgress,
    openActionCount,
    resolvedActionCount,
    ignoredActionCount,
    sourceDetails,
    processedStorageFiles: Array.from(new Set(processedStorageFiles.map(String))),
    sourceReconciliation: auditAppendix?.source_reconciliation_report || undefined,
    sourceReconciliationBreakdownLabel: sourceReconciliationBreakdownLabel || undefined,
    sourceMap,
  };
}

export function getStorageFileDisplayState(
  files: string[],
  processedStorageFiles: string[],
  sourceRows: BrokerFileIntakeSourceRow[] = [],
): StorageFileDisplayState[] {
  const storageBasenameCounts = new Map<string, number>();
  for (const filename of files) {
    const basenameKey = storageBasenameKey(filename);
    storageBasenameCounts.set(basenameKey, (storageBasenameCounts.get(basenameKey) || 0) + 1);
  }
  const processedExact = new Set<string>();
  const processedUniqueBasename = new Set<string>();
  for (const processedFile of processedStorageFiles) {
    processedExact.add(normalizeStoragePathKey(processedFile));
    const basenameKey = storageBasenameKey(processedFile);
    if ((storageBasenameCounts.get(basenameKey) || 0) <= 1) {
      processedUniqueBasename.add(basenameKey);
    }
  }
  const sourceByPathOrFilename = new Map<string, BrokerFileIntakeSourceRow>();
  const sourceByUniqueBasename = new Map<string, BrokerFileIntakeSourceRow | null>();
  for (const source of sourceRows) {
    sourceByPathOrFilename.set(normalizeStoragePathKey(source.filename), source);
    sourceByPathOrFilename.set(normalizeStoragePathKey(source.pathLabel), source);
    for (const basenameKey of new Set([storageBasenameKey(source.filename), storageBasenameKey(source.pathLabel)])) {
      if (!basenameKey) continue;
      sourceByUniqueBasename.set(
        basenameKey,
        sourceByUniqueBasename.has(basenameKey) ? null : source,
      );
    }
  }
  return files.map((filename) => {
    const filenameKey = normalizeStoragePathKey(filename);
    const filenameBasenameKey = storageBasenameKey(filename);
    const fileProcessed = processedExact.has(filenameKey) || processedUniqueBasename.has(filenameBasenameKey);
    const roleState = (() => {
      const source = sourceByPathOrFilename.get(filenameKey) || sourceByUniqueBasename.get(filenameBasenameKey);
      if (source) {
        return {
          auditRoleLabel: source.roleLabel,
          auditRole: source.role,
          requiresEngineRun: false,
        };
      }
      return {
        auditRoleLabel: fileProcessed ? 'Rola nieustalona' : 'Wymaga ponownego przebiegu',
        auditRole: fileProcessed ? 'unknown' as const : 'needs_run' as const,
        requiresEngineRun: !fileProcessed,
      };
    })();
    const importability = getStorageFileImportability(filename, roleState.auditRole);

    return {
      filename,
      processed: fileProcessed,
      statusLabel: fileProcessed ? 'Przetworzony' : 'Nowy plik',
      ...roleState,
      ...importability,
    };
  });
}

function getStorageFileImportability(
  filename: string,
  auditRole: BrokerFileSourceRole | 'needs_run',
): Pick<StorageFileDisplayState, 'canImportToLocalBase' | 'nonImportableReason'> {
  const extension = filename.split('.').pop()?.toLowerCase() || '';
  const disposition = getStorageFileDisposition(filename);
  if (isBrokerReportFile(filename)) {
    return {
      canImportToLocalBase: false,
      nonImportableReason: 'Nowy raport brokera jest źródłem danych. Wpływ na PIT wynika dopiero z canonical_tax_input.json.',
    };
  }
  if (isReconciliationStorageFilename(filename)) {
    return {
      canImportToLocalBase: false,
      nonImportableReason: 'Plik służy do kontroli pozycji i nie powinien tworzyć transakcji.',
    };
  }
  if (disposition === 'analytics') {
    return {
      canImportToLocalBase: false,
      nonImportableReason: 'Plik podsumowujący brokera służy jako dowód/analityka i nie tworzy transakcji.',
    };
  }
  if (extension === 'pdf') {
    return {
      canImportToLocalBase: false,
      nonImportableReason: 'Plik jest dowodem audytowym i nie tworzy transakcji w lokalnej bazie.',
    };
  }
  if (auditRole === 'evidence') {
    return {
      canImportToLocalBase: false,
      nonImportableReason: 'Plik jest dowodem audytowym i nie tworzy transakcji w lokalnej bazie.',
    };
  }
  if (auditRole === 'reconciliation') {
    return {
      canImportToLocalBase: false,
      nonImportableReason: 'Plik służy do kontroli pozycji i nie powinien tworzyć transakcji.',
    };
  }
  if (auditRole === 'analytics') {
    return {
      canImportToLocalBase: false,
      nonImportableReason: 'Plik analityczny brokera jest dowodem/podsumowaniem i nie tworzy transakcji.',
    };
  }
  if (auditRole === 'candidate_tax') {
    return {
      canImportToLocalBase: false,
      nonImportableReason: 'Nowy raport jest źródłem danych. Silnik użyje tylko rekordów zakwalifikowanych w canonical_tax_input.json.',
    };
  }
  if (auditRole === 'fallback' || auditRole === 'duplicate') {
    return {
      canImportToLocalBase: false,
      nonImportableReason: 'Plik jest fallbackiem albo duplikatem i nie powinien dublować danych.',
    };
  }
  return { canImportToLocalBase: true };
}
