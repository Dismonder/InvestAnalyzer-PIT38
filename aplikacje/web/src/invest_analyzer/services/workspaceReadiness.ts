import type { TaxEngineResponse, EngineIssue, PitSubmissionReadiness } from '../hooks/useTaxEngineRun';
import type { LogEntry } from '../types';
import type { TaxReportOrganizationStatus } from './reportOrganizationStatus';
import type { PitCaseFileBaselineStatus } from './pitCaseFile';
import type { TaxYearClosureStatus } from './yearClosure';
import type { BrokerFileActionOverride } from './brokerFileActionOverrides';
import { buildDisplayLogEntries } from './displayLogs';
import { odmienLiczebnik } from '../../portfel/services/odmianaLiczebnika';

export type WorkspaceTargetView =
  | 'pulpit'
  | 'centrum_pracy'
  | 'historia_transakcji'
  | 'raport_roczny'
  | 'import_danych';

export type WorkspaceStageId =
  | 'import'
  | 'dane_quality'
  | 'transaction_history'
  | 'manual_overrides'
  | 'tax_report'
  | 'tax_package';

export type WorkspaceStageStatus = 'ready' | 'needs_attention' | 'blocked' | 'not_started';

export interface WorkspaceStageSummary {
  id: WorkspaceStageId;
  label: string;
  status: WorkspaceStageStatus;
  primaryActionLabel: string;
  targetView: WorkspaceTargetView;
  count?: number;
  message: string;
}

export interface WorkspaceAttentionItem {
  code: string;
  label: string;
  message: string;
  severity: string;
  targetView: WorkspaceTargetView;
  kind: UserFacingIssueKind;
}

export interface WorkspaceMetric {
  label: string;
  value: string;
  detail?: string;
}

export interface WorkspaceRecommendedAction {
  label: string;
  message: string;
  targetView: WorkspaceTargetView;
}

export type UserFacingIssueKind =
  | 'blocking_error'
  | 'action_required'
  | 'evidence_needed'
  | 'optional_review'
  | 'technical_info';

export interface WorkspaceSettlementStatus {
  label: string;
  message: string;
  kind: 'ready' | 'ready_with_evidence' | 'needs_review' | 'blocked' | 'not_ready';
  blockingCount: number;
  evidenceCount: number;
  reviewCount: number;
}

export interface TaxReadinessSummary {
  year: number;
  score: number;
  blockingIssues: number;
  warnings: number;
  nbpGaps: number;
  unclassifiedEvents: number;
}

export interface WorkspaceReadinessInput {
  selectedYear: number;
  transactionCount: number;
  fileCount: number;
  enabledFileCount: number;
  overrideCount: number;
  engineLoading: boolean;
  engineResult: TaxEngineResponse | null;
  logs: LogEntry[];
  reportStatus?: TaxReportOrganizationStatus | null;
  pitCaseFileBaselineStatus?: PitCaseFileBaselineStatus | null;
  taxYearClosureStatus?: TaxYearClosureStatus | null;
  brokerFileActionOverrides?: BrokerFileActionOverride[];
}

export interface WorkspaceReadiness {
  stages: WorkspaceStageSummary[];
  attentionItems: WorkspaceAttentionItem[];
  metrics: WorkspaceMetric[];
  overallStatus: WorkspaceStageStatus;
  recommendedAction: WorkspaceRecommendedAction;
  taxReadiness: TaxReadinessSummary;
  settlementStatus: WorkspaceSettlementStatus;
}

const statusRank: Record<WorkspaceStageStatus, number> = {
  blocked: 4,
  needs_attention: 3,
  not_started: 2,
  ready: 1,
};

function parseActionableIssues(engineResult: TaxEngineResponse | null): EngineIssue[] {
  if (!engineResult) {
    return [];
  }
  const explicit = engineResult.actionable_issues || [];
  if (explicit.length > 0) {
    return explicit.filter((issue) => issue.severity !== 'INFO' || issue.blocking);
  }
  return (engineResult.issues || []).filter((issue) => issue.severity !== 'INFO' || issue.blocking);
}

function issueBlocks(issue: EngineIssue): boolean {
  return issue.blocking || ['ERROR', 'CRITICAL'].includes((issue.severity || '').toUpperCase());
}

function engineBlockingCount(engineResult: TaxEngineResponse | null): number {
  const metric = engineResult?.quality_report?.metrics?.blocking_count;
  return Number.isFinite(metric) ? Number(metric) : 0;
}

function countNbpGaps(engineResult: TaxEngineResponse | null, actionableIssues: EngineIssue[]): number {
  const explicit = engineResult?.fx_coverage_gaps?.length || 0;
  if (explicit > 0) {
    return explicit;
  }
  return actionableIssues.filter((issue) => /NBP|FX.*GAP|COVERAGE_GAP/i.test(issue.code)).length;
}

function countUnclassifiedEvents(actionableIssues: EngineIssue[]): number {
  return actionableIssues.filter((issue) => /UNCLASSIFIED|REVIEW_REQUIRED|UNKNOWN/i.test(issue.code)).length;
}

function buildTaxReadinessSummary(input: {
  year: number;
  blockingIssues: number;
  warnings: number;
  nbpGaps: number;
  unclassifiedEvents: number;
}): TaxReadinessSummary {
  const penalty =
    input.blockingIssues * 25 +
    input.nbpGaps * 15 +
    input.unclassifiedEvents * 10 +
    input.warnings * 3;
  return {
    ...input,
    score: Math.max(0, Math.min(100, 100 - penalty)),
  };
}

function formatPlan(plan?: string): string {
  const mapping: Record<string, string> = {
    aggressive_user: 'Agresywny',
    aggressive: 'Agresywny',
    defensible: 'Zrównoważony',
    balanced_user: 'Zrównoważony',
    conservative: 'Konserwatywny',
    conservative_user: 'Konserwatywny',
  };
  return mapping[plan || ''] || (plan || 'brak').replace(/_/g, ' ');
}

function buildAttentionItems(actionableIssues: EngineIssue[], logs: LogEntry[]): WorkspaceAttentionItem[] {
  const issueItems = actionableIssues
    .filter((issue) => issue.severity !== 'INFO' || issue.blocking)
    .map((issue) => ({
      code: issue.code,
      label: issue.code.replace(/_/g, ' '),
      message: issue.message,
      severity: issue.severity,
      targetView: 'raport_roczny' as WorkspaceTargetView,
      kind: issueBlocks(issue) ? 'blocking_error' as UserFacingIssueKind : 'action_required' as UserFacingIssueKind,
    }));

  const logItems = buildDisplayLogEntries(logs)
    .filter((log) => log.displayLevel === 'error' && log.userFacingKind === 'blocking_error')
    .slice(-5)
    .map((log) => ({
      code: log.stage,
      label: log.stage,
      message: log.displayMessage,
      severity: 'ERROR',
      targetView: 'pulpit' as WorkspaceTargetView,
      kind: 'blocking_error' as UserFacingIssueKind,
    }));

  return [...issueItems, ...logItems];
}

function pitVerdictToStageStatus(readiness?: PitSubmissionReadiness | null): WorkspaceStageStatus | null {
  if (!readiness) {
    return null;
  }
  if (readiness.verdict === 'BLOCKED') {
    return 'blocked';
  }
  if (readiness.verdict === 'NEEDS_EVIDENCE' || readiness.verdict === 'READY_WITH_RISK') {
    return 'needs_attention';
  }
  if (readiness.verdict === 'READY') {
    return 'ready';
  }
  return null;
}

function pitVerdictLabel(readiness?: PitSubmissionReadiness | null): string {
  const mapping: Record<string, string> = {
    READY: 'Gotowe',
    READY_WITH_RISK: 'Gotowe z ryzykiem',
    NEEDS_EVIDENCE: 'Wymaga dowodów',
    BLOCKED: 'Do kontroli PIT',
  };
  return mapping[readiness?.verdict || ''] || 'brak';
}

function buildPitSubmissionAttentionItems(readiness?: PitSubmissionReadiness | null): WorkspaceAttentionItem[] {
  if (!readiness?.checklist?.length) {
    return [];
  }
  return readiness.checklist
    .filter((item) => item.severity !== 'info')
    .map((item) => ({
      code: item.id,
      label: item.userAction,
      message: item.label,
      severity: item.severity.toUpperCase(),
      targetView: 'raport_roczny' as WorkspaceTargetView,
      kind: item.severity === 'blocking'
        ? 'blocking_error' as UserFacingIssueKind
        : item.severity === 'evidence'
          ? 'evidence_needed' as UserFacingIssueKind
          : item.severity === 'risk'
            ? 'optional_review' as UserFacingIssueKind
            : 'action_required' as UserFacingIssueKind,
    }));
}

function collectBrokerFileActionState(
  engineResult: TaxEngineResponse | null,
  overrides: BrokerFileActionOverride[] = [],
) {
  const auditAppendix = engineResult?.tax_filing_package?.audit_appendix || null;
  const queue = [...(auditAppendix?.broker_file_action_queue || [])];
  const overrideById = new Map(overrides.map((override) => [override.actionId, override]));
  const items = queue.map((item) => {
    const override = overrideById.get(item.action_id);
    const status = override?.status || item.user_status || item.default_status || 'open';
    const rawSeverity = String(item.severity || 'info').toLowerCase();
    const severity = rawSeverity === 'info' ? 'info' : 'warning';
    return {
      ...item,
      status,
      severity,
      userNote: override?.userNote || item.user_note || '',
      linkedRowId: override?.linkedRowId || item.linked_row_id || null,
    };
  });
  const openItems = items.filter((item) => item.status === 'open');
  const openBlocking = openItems.filter((item) => item.severity === 'blocking').length;
  const openWarnings = openItems.filter((item) => item.severity === 'warning').length;
  return {
    total: items.length,
    openItems,
    openCount: openItems.length,
    openBlocking,
    openWarnings,
    resolvedCount: items.filter((item) => item.status === 'resolved').length,
    ignoredCount: items.filter((item) => item.status === 'ignored').length,
  };
}

function formatSupplementalBreakdown(
  breakdown?: Array<{ label?: string; count?: number }> | null,
): string {
  if (!Array.isArray(breakdown) || breakdown.length === 0) {
    return '';
  }
  return breakdown
    .map((entry) => {
      const label = String(entry.label || '').trim();
      const count = Number(entry.count || 0);
      return label ? `${label}: ${count}` : '';
    })
    .filter(Boolean)
    .join(', ');
}

function formatBrokerFileActionMessage(
  item: ReturnType<typeof collectBrokerFileActionState>['openItems'][number],
): string {
  const base = item.user_action || item.reason || item.label;
  const breakdown = item.supplemental_only_breakdown_label || formatSupplementalBreakdown(item.supplemental_only_breakdown);
  return breakdown ? `${base} Typy rekordów tylko pomocniczych: ${breakdown}.` : base;
}

function buildBrokerFileActionAttentionItems(
  brokerActions: ReturnType<typeof collectBrokerFileActionState>,
): WorkspaceAttentionItem[] {
  return brokerActions.openItems
    .filter((item) => item.severity !== 'info')
    .slice(0, 8)
    .map((item) => ({
      code: item.action_id,
      label: item.label,
      message: formatBrokerFileActionMessage(item),
      severity: item.severity.toUpperCase(),
      targetView: 'import_danych' as WorkspaceTargetView,
      kind: item.severity === 'blocking' ? 'blocking_error' as UserFacingIssueKind : 'optional_review' as UserFacingIssueKind,
    }));
}

function buildResultHealthAttentionItems(engineResult: TaxEngineResponse | null): WorkspaceAttentionItem[] {
  const health = engineResult?.tax_filing_package?.audit_appendix?.result_health_check;
  if (!health || health.status === 'ok') return [];
  return [{
    code: 'RESULT_HEALTH_CHECK',
    label: health.status === 'blocked' ? 'Wynik wymaga kontroli danych' : 'Sprawdź źródła danych',
    message: health.reasons?.[0] || health.headline || 'Kontrola wyniku wymaga sprawdzenia źródeł danych.',
    severity: health.status === 'blocked' ? 'ERROR' : 'WARNING',
    targetView: 'import_danych',
    kind: health.status === 'blocked' ? 'blocking_error' : 'action_required',
  }];
}

function sortWorkspaceAttentionItems(items: WorkspaceAttentionItem[]): WorkspaceAttentionItem[] {
  const rank: Record<UserFacingIssueKind, number> = {
    blocking_error: 0,
    action_required: 1,
    evidence_needed: 2,
    optional_review: 3,
    technical_info: 4,
  };
  return [...items].sort((a, b) => (rank[a.kind] ?? 99) - (rank[b.kind] ?? 99));
}

function buildWorkspaceSettlementStatus(input: {
  filingReady: boolean;
  hasEngineError: boolean;
  blockingIssues: number;
  brokerBlockingCount: number;
  pitSubmissionReadiness?: PitSubmissionReadiness | null;
  resultHealthStatus?: 'ok' | 'needs_review' | 'blocked' | null;
  dataAvailable: boolean;
}): WorkspaceSettlementStatus {
  const checklist = input.pitSubmissionReadiness?.checklist || [];
  const evidenceCount = checklist.filter((item) => item.severity === 'evidence').length;
  const reviewCount = input.brokerBlockingCount + checklist.filter((item) => ['risk', 'warning'].includes(String(item.severity))).length;
  const blockingCount = input.blockingIssues + input.brokerBlockingCount + checklist.filter((item) => item.severity === 'blocking').length;

  if (!input.dataAvailable) {
    return {
      label: 'Brak danych',
      message: 'Najpierw dodaj lokalne pliki brokera, żeby silnik mógł policzyć raport.',
      kind: 'not_ready',
      blockingCount,
      evidenceCount,
      reviewCount,
    };
  }
  if (input.hasEngineError || input.resultHealthStatus === 'blocked' || input.pitSubmissionReadiness?.verdict === 'BLOCKED' || blockingCount > 0) {
    return {
      label: 'Do kontroli PIT',
      message: 'Raport ma otwarte kontrole danych, kursów albo spójności. Najpierw sprawdź kwalifikację PIT.',
      kind: 'blocked',
      blockingCount,
      evidenceCount,
      reviewCount,
    };
  }
  if (input.filingReady && input.resultHealthStatus === 'needs_review') {
    return {
      label: 'Gotowe, wymaga kontroli danych',
      message: 'Raport jest policzony, ale źródła albo podejrzane zera wymagają sprawdzenia przed złożeniem.',
      kind: 'needs_review',
      blockingCount,
      evidenceCount,
      reviewCount,
    };
  }
  if (input.filingReady && evidenceCount > 0) {
    return {
      label: 'Gotowe, zachowaj dowody',
      message: 'Silnik policzył raport. Brak otwartych kontroli podatkowych. Pozostały dowody do zachowania na wypadek kontroli.',
      kind: 'ready_with_evidence',
      blockingCount,
      evidenceCount,
      reviewCount,
    };
  }
  if (input.filingReady && (input.pitSubmissionReadiness?.verdict === 'READY_WITH_RISK' || reviewCount > 0)) {
    return {
      label: 'Gotowe, wymaga kontroli',
      message: 'Raport jest policzony, ale są pozycje pomocnicze albo ryzyka do świadomego przeglądu.',
      kind: 'needs_review',
      blockingCount,
      evidenceCount,
      reviewCount,
    };
  }
  if (input.filingReady) {
    return {
      label: 'Gotowe do rozliczenia',
      message: 'Silnik policzył raport i nie wykrył otwartych kontroli wymagających działania.',
      kind: 'ready',
      blockingCount,
      evidenceCount,
      reviewCount,
    };
  }
  return {
    label: 'Wymaga przeliczenia',
    message: 'Dane są dostępne, ale raport nie jest jeszcze gotowy.',
    kind: 'not_ready',
    blockingCount,
    evidenceCount,
    reviewCount,
  };
}

function buildRecommendedAction(input: {
  blockingIssues: number;
  nbpGaps: number;
  filingReady: boolean;
  dataAvailable: boolean;
  packageStatus: string;
  pitSubmissionReadiness?: PitSubmissionReadiness | null;
  resultHealthStatus?: 'ok' | 'needs_review' | 'blocked' | null;
  resultHealthMessage?: string | null;
  pitCaseFileBaselineStatus?: PitCaseFileBaselineStatus | null;
  taxYearClosureStatus?: TaxYearClosureStatus | null;
  brokerFileActionState?: ReturnType<typeof collectBrokerFileActionState>;
}): WorkspaceRecommendedAction {
  if (!input.dataAvailable) {
    return {
      label: 'Dodaj dane',
      message: 'Najpierw zaimportuj lokalne pliki, żeby silnik miał wejście do obliczeń.',
      targetView: 'import_danych',
    };
  }
  const blockingBrokerAction = input.brokerFileActionState?.openItems.find((item) => item.severity === 'blocking');
  if (blockingBrokerAction) {
    return {
      label: 'Sprawdź kontrolę importu',
      message: formatBrokerFileActionMessage(blockingBrokerAction),
      targetView: 'import_danych',
    };
  }
  const pitAction = input.pitSubmissionReadiness?.recommendedAction;
  if (pitAction && input.pitSubmissionReadiness?.verdict !== 'READY') {
    return {
      label: pitAction.userAction,
      message: pitAction.label,
      targetView: 'raport_roczny',
    };
  }
  if (input.blockingIssues > 0) {
    return {
      label: 'Sprawdź kontrole PIT',
      message: 'Silnik wykrył sprawy podatkowe do kontroli. Bez ich sprawdzenia raport może być niegotowy.',
      targetView: 'raport_roczny',
    };
  }
  if (input.nbpGaps > 0) {
    return {
      label: 'Uzupełnij kursy NBP',
      message: 'Brakuje części kursów NBP albo zakres archiwum jest za krótki.',
      targetView: 'raport_roczny',
    };
  }
  if (input.resultHealthStatus === 'blocked' || input.resultHealthStatus === 'needs_review') {
    return {
      label: 'Sprawdź źródła danych',
      message: input.resultHealthMessage || 'Kontrola wyniku wymaga sprawdzenia aktywnych źródeł PIT.',
      targetView: 'import_danych',
    };
  }
  if (input.taxYearClosureStatus?.status === 'changed_after_close') {
    return {
      label: 'Zamknij rok ponownie',
      message: 'Bieżące dane lub kalkulacja zmieniły się po lokalnym zamknięciu roku PIT.',
      targetView: 'raport_roczny',
    };
  }
  if (!input.filingReady) {
    return {
      label: 'Przelicz raport',
      message: 'Dane są dostępne, ale raport PIT-38 nie jest jeszcze gotowy.',
      targetView: 'raport_roczny',
    };
  }
  const warningBrokerAction = input.brokerFileActionState?.openItems.find((item) => item.severity === 'warning');
  if (warningBrokerAction) {
    return {
      label: 'Przejrzyj akcje importu',
      message: formatBrokerFileActionMessage(warningBrokerAction),
      targetView: 'import_danych',
    };
  }
  if (input.pitCaseFileBaselineStatus?.status === 'CHANGED') {
    return {
      label: 'Wygeneruj nowy pakiet',
      message: 'Bieżące dane lub kalkulacja różnią się od ostatnio pobranego pakietu podatkowego.',
      targetView: 'raport_roczny',
    };
  }
  if (!['downloaded', 'paid', 'submitted'].includes(input.packageStatus)) {
    return {
      label: 'Wygeneruj pakiet',
      message: 'Raport jest gotowy. Następny krok to pobranie pakietu podatkowego.',
      targetView: 'raport_roczny',
    };
  }
  return {
    label: 'Sprawdź historię',
    message: 'Proces jest gotowy. Historia transakcji pokazuje końcowy widok z lokalnych danych i korekt.',
    targetView: 'historia_transakcji',
  };
}

export function buildWorkspaceReadiness(input: WorkspaceReadinessInput): WorkspaceReadiness {
  const {
    selectedYear,
    transactionCount,
    fileCount,
    enabledFileCount,
    overrideCount,
    engineLoading,
    engineResult,
    logs,
    reportStatus,
    pitCaseFileBaselineStatus,
    taxYearClosureStatus,
    brokerFileActionOverrides = [],
  } = input;

  const actionableIssues = parseActionableIssues(engineResult);
  // `quality_report` aggregates the same issues exposed in `actionable_issues`.
  // Take the larger count instead of presenting every gate twice as two tasks.
  const blockingIssues = Math.max(actionableIssues.filter(issueBlocks).length, engineBlockingCount(engineResult));
  const nbpGaps = countNbpGaps(engineResult, actionableIssues);
  const unclassifiedEvents = countUnclassifiedEvents(actionableIssues);
  const historyRows = engineResult?.transaction_history_rows?.length || 0;
  const filingReady = engineResult?.filing_ready === true;
  const hasEngineError = Boolean(engineResult?.error || engineResult?.success === false || engineResult?.status === 'FAILED');
  const dataAvailable = transactionCount > 0 || historyRows > 0;
  const activeFiles = enabledFileCount || fileCount;
  const packageStatus = reportStatus?.status || 'draft';
  const warnings = actionableIssues.filter((issue) => !issueBlocks(issue)).length;
  const pitSubmissionReadiness = engineResult?.tax_filing_package?.audit_appendix?.pit_submission_readiness || null;
  const resultHealthCheck = engineResult?.tax_filing_package?.audit_appendix?.result_health_check || null;
  const pitStageStatus = pitVerdictToStageStatus(pitSubmissionReadiness);
  const brokerFileActionState = collectBrokerFileActionState(engineResult, brokerFileActionOverrides);
  const settlementStatus = buildWorkspaceSettlementStatus({
    filingReady,
    hasEngineError,
    blockingIssues,
    brokerBlockingCount: brokerFileActionState.openBlocking,
    pitSubmissionReadiness,
    resultHealthStatus: resultHealthCheck?.status || null,
    dataAvailable,
  });
  const taxReadiness = buildTaxReadinessSummary({
    year: selectedYear,
    blockingIssues,
    warnings,
    nbpGaps,
    unclassifiedEvents,
  });

  const importStatus: WorkspaceStageStatus = dataAvailable
    ? brokerFileActionState.openBlocking > 0
      ? 'blocked'
      : brokerFileActionState.openCount > 0
        ? 'needs_attention'
        : 'ready'
    : activeFiles > 0
      ? 'needs_attention'
      : 'not_started';

  const daneQualityStatus: WorkspaceStageStatus = !dataAvailable
    ? 'not_started'
    : hasEngineError || blockingIssues > 0 || resultHealthCheck?.status === 'blocked'
      ? 'blocked'
      : actionableIssues.length > 0 || resultHealthCheck?.status === 'needs_review'
        ? 'needs_attention'
        : 'ready';

  const historyStatus: WorkspaceStageStatus = historyRows > 0
    ? 'ready'
    : dataAvailable
      ? 'needs_attention'
      : 'not_started';

  const baseReportStatusStage: WorkspaceStageStatus = !dataAvailable
    ? 'not_started'
    : hasEngineError || blockingIssues > 0 || resultHealthCheck?.status === 'blocked'
      ? 'blocked'
      : resultHealthCheck?.status === 'needs_review'
        ? 'needs_attention'
      : filingReady
        ? 'ready'
        : 'needs_attention';
  const reportStatusStage: WorkspaceStageStatus = pitStageStatus && baseReportStatusStage !== 'not_started'
    ? pitStageStatus
    : baseReportStatusStage;

  const taxPackageStatus: WorkspaceStageStatus = ['downloaded', 'paid', 'submitted'].includes(packageStatus)
    ? taxYearClosureStatus?.status === 'changed_after_close' || pitCaseFileBaselineStatus?.status === 'CHANGED'
      ? 'needs_attention'
      : 'ready'
    : filingReady
      ? 'needs_attention'
      : reportStatusStage === 'blocked'
        ? 'blocked'
        : 'not_started';

  const stages: WorkspaceStageSummary[] = [
    {
      id: 'import',
      label: 'Import',
      status: importStatus,
      targetView: 'import_danych',
      primaryActionLabel: !dataAvailable
        ? 'Dodaj dane'
        : brokerFileActionState.openBlocking > 0
          ? 'Sprawdź kontrole importu'
          : brokerFileActionState.openCount > 0
            ? 'Obsłuż akcje importu'
            : 'Przejdź do importu',
      count: transactionCount,
      message: dataAvailable
        ? brokerFileActionState.openCount > 0
          ? `${transactionCount} ${odmienLiczebnik(transactionCount, 'rekord wejściowy', 'rekordy wejściowe', 'rekordów wejściowych')}. Otwarte akcje importu: ${brokerFileActionState.openCount}.`
          : `${transactionCount} ${odmienLiczebnik(transactionCount, 'rekord wejściowy', 'rekordy wejściowe', 'rekordów wejściowych')} w wybranym obszarze pracy.`
        : 'Brak aktywnych lokalnych danych wejściowych do przeliczenia.',
    },
    {
      id: 'dane_quality',
      label: 'Jakość danych',
      status: daneQualityStatus,
      targetView: 'raport_roczny',
      primaryActionLabel: blockingIssues > 0 ? 'Sprawdź kontrole PIT' : 'Sprawdź jakość',
      count: actionableIssues.length,
      message: blockingIssues > 0
        ? `${blockingIssues} spraw podatkowych wymaga kontroli.`
        : actionableIssues.length > 0
          ? `${actionableIssues.length} spraw wymaga uwagi.`
          : 'Brak otwartych kontroli w głównym logu jakości.',
    },
    {
      id: 'transaction_history',
      label: 'Historia i korekty',
      status: historyStatus,
      targetView: 'historia_transakcji',
      primaryActionLabel: 'Sprawdź historię',
      count: historyRows,
      message: historyRows > 0
        ? `${historyRows} ${odmienLiczebnik(historyRows, 'wiersz', 'wiersze', 'wierszy')} końcowej historii z silnika.`
        : 'Historia z silnika nie została jeszcze zbudowana.',
    },
    {
      id: 'manual_overrides',
      label: 'Korekty ręczne',
      status: dataAvailable ? 'ready' : 'not_started',
      targetView: 'historia_transakcji',
      primaryActionLabel: overrideCount > 0 ? 'Popraw dane' : 'Dodaj korektę',
      count: overrideCount,
      message: overrideCount > 0
        ? `${overrideCount} korekt ręcznych wpływa na wejście do silnika.`
        : 'Brak ręcznych nadpisań dla danych wejściowych.',
    },
    {
      id: 'tax_report',
      label: 'Raport roczny',
      status: reportStatusStage,
      targetView: 'raport_roczny',
      primaryActionLabel: filingReady ? 'Otwórz raport' : 'Przelicz raport',
      count: engineResult?.issue_count || actionableIssues.length,
      message: filingReady
        ? `Raport za ${selectedYear} jest gotowy do pracy.`
        : engineLoading
          ? 'Silnik przelicza raport roczny.'
          : 'Raport wymaga przeliczenia albo poprawy danych.',
    },
    {
      id: 'tax_package',
      label: 'Pakiet podatkowy',
      status: taxPackageStatus,
      targetView: 'raport_roczny',
      primaryActionLabel: taxYearClosureStatus?.status === 'changed_after_close'
        ? 'Zamknij rok ponownie'
        : pitCaseFileBaselineStatus?.status === 'CHANGED' ? 'Wygeneruj nowy pakiet' : 'Wygeneruj pakiet',
      count: exportedCount(engineResult),
      message: taxYearClosureStatus?.status === 'changed_after_close'
        ? `Dane lub kalkulacja zmieniły się po zamknięciu roku: ${taxYearClosureStatus.changedFields.join(', ') || 'brak szczegółów'}.`
        : pitCaseFileBaselineStatus?.status === 'CHANGED'
        ? `Dane lub kalkulacja zmieniły się od ostatniego pakietu: ${pitCaseFileBaselineStatus.changedFields.join(', ') || 'brak szczegółów'}.`
        : ['downloaded', 'paid', 'submitted'].includes(packageStatus)
        ? `Pakiet ma status: ${packageStatusLabel(packageStatus)}.`
        : filingReady
          ? 'Można wygenerować pakiet podatkowy na żądanie.'
          : 'Pakiet będzie dostępny po gotowym raporcie.',
    },
  ];

  const attentionItems = sortWorkspaceAttentionItems([
    ...buildBrokerFileActionAttentionItems(brokerFileActionState),
    ...buildResultHealthAttentionItems(engineResult),
    ...buildAttentionItems(actionableIssues, logs),
    ...buildPitSubmissionAttentionItems(pitSubmissionReadiness),
    ...(pitCaseFileBaselineStatus?.status === 'CHANGED'
      ? [{
          code: 'PIT_CASE_FILE_CHANGED',
          label: 'Pakiet podatkowy jest nieaktualny',
          message: `Zmienione elementy: ${pitCaseFileBaselineStatus.changedFields.join(', ') || 'case file'}.`,
          severity: 'WARNING',
          targetView: 'raport_roczny' as WorkspaceTargetView,
          kind: 'optional_review' as UserFacingIssueKind,
        }]
      : []),
    ...(taxYearClosureStatus?.status === 'changed_after_close'
      ? [{
          code: 'TAX_YEAR_CHANGED_AFTER_CLOSE',
          label: 'Rok PIT zmienił się po zamknięciu',
          message: `Zmienione elementy: ${taxYearClosureStatus.changedFields.join(', ') || 'case file'}.`,
          severity: 'WARNING',
          targetView: 'raport_roczny' as WorkspaceTargetView,
          kind: 'optional_review' as UserFacingIssueKind,
        }]
      : []),
  ]);
  const worstStage = stages.reduce<WorkspaceStageStatus>((worst, stage) => (
    statusRank[stage.status] > statusRank[worst] ? stage.status : worst
  ), 'ready');

  return {
    stages,
    attentionItems,
    overallStatus: worstStage,
    recommendedAction: buildRecommendedAction({
      blockingIssues,
      nbpGaps,
      filingReady,
      dataAvailable,
      packageStatus,
      pitSubmissionReadiness,
      resultHealthStatus: resultHealthCheck?.status || null,
      resultHealthMessage: resultHealthCheck?.reasons?.[0] || resultHealthCheck?.headline || null,
      pitCaseFileBaselineStatus,
      taxYearClosureStatus,
      brokerFileActionState,
    }),
    taxReadiness,
    settlementStatus,
    metrics: [
      {
        label: 'Ostatni przebieg silnika',
        value: engineResult?.audit_hash ? engineResult.audit_hash.slice(0, 12) : engineLoading ? 'przeliczanie' : 'brak',
      },
      {
        label: 'Aktywny plan podatkowy',
        value: formatPlan(engineResult?.plan_used),
      },
      {
        label: 'Korekty ręczne',
        value: String(overrideCount),
      },
      {
        label: 'Sprawy do poprawy',
        value: String(attentionItems.length),
      },
      {
        label: 'Akcje importu',
        value: `${brokerFileActionState.openCount}/${brokerFileActionState.total}`,
        detail: brokerFileActionState.total > 0
          ? `${brokerFileActionState.openBlocking} kontroli PIT, ${brokerFileActionState.resolvedCount} rozwiązane, ${brokerFileActionState.ignoredCount} zignorowane`
          : 'brak kolejki importu',
      },
      {
        label: 'Status raportu',
        value: packageStatusLabel(packageStatus),
      },
      {
        label: 'Gotowość danych',
        value: `${taxReadiness.score}/100`,
        detail: `${taxReadiness.blockingIssues} kontroli PIT, ${taxReadiness.nbpGaps} luk NBP`,
      },
      {
        label: 'Kontrola PIT',
        value: pitVerdictLabel(pitSubmissionReadiness),
        detail: pitSubmissionReadiness ? `${pitSubmissionReadiness.score}/100` : 'brak pełnej checklisty',
      },
      {
        label: 'Zamknięcie roku',
        value: taxYearClosureStatus?.status === 'changed_after_close'
          ? 'Wymaga ponownego zamknięcia'
          : taxYearClosureStatus?.label || 'Rok roboczy',
        detail: taxYearClosureStatus?.changedFields?.length
          ? taxYearClosureStatus.changedFields.join(', ')
          : taxYearClosureStatus?.snapshotHash || 'brak snapshotu',
      },
    ],
  };
}

function exportedCount(engineResult: TaxEngineResponse | null): number {
  return engineResult?.exported_files?.length || 0;
}

function packageStatusLabel(status: string): string {
  const mapping: Record<string, string> = {
    draft: 'Nieprzygotowany',
    ready: 'Gotowy',
    downloaded: 'Pobrany',
    paid: 'Opłacony',
    submitted: 'Wysłany',
  };
  return mapping[status] || status;
}
