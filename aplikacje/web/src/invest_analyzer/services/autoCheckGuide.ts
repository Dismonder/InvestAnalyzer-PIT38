import type { TaxFilingPackageAuditAppendix, PitSubmissionChecklistItem } from '../hooks/useTaxEngineRun';
import type { WorkspaceReadiness, WorkspaceTargetView, WorkspaceStageStatus, UserFacingIssueKind } from './workspaceReadiness';
import type { BrokerFileIntakeSummary, BrokerFileIntakeActionRow } from './brokerFileIntake';
import type { DefenseWorkbenchItem } from './defenseWorkbench';
import type { DisplayLogEntry } from './displayLogs';
import type { AutoCheckActionOverride } from './autoCheckActionOverrides';

export type AutoCheckVerdict =
  | 'ready'
  | 'ready_with_evidence'
  | 'needs_review'
  | 'blocked'
  | 'not_ready';

export type AutoCheckItemKind = 'blocking' | 'action' | 'evidence' | 'review' | 'info';

export interface AutoCheckItem {
  id: string;
  priority: number;
  kind: AutoCheckItemKind;
  title: string;
  whatItMeans: string;
  howToFix: string;
  targetView: WorkspaceTargetView;
  searchTerm?: string | null;
  sourceIds: string[];
  evidenceIds: string[];
  canMarkDone: boolean;
}

export interface AutoCheckStep {
  id: string;
  label: string;
  status: AutoCheckVerdict;
  count: number;
}

export interface AutoCheckGuide {
  verdict: AutoCheckVerdict;
  headline: string;
  summary: string;
  recommendedItem: AutoCheckItem | null;
  steps: AutoCheckStep[];
  groups: Record<AutoCheckItemKind, AutoCheckItem[]>;
}

export interface AutoCheckGuideInput {
  workspaceReadiness: WorkspaceReadiness;
  auditAppendix?: TaxFilingPackageAuditAppendix | null;
  brokerFileSummary?: BrokerFileIntakeSummary | null;
  defenseItems?: DefenseWorkbenchItem[];
  displayLogs?: DisplayLogEntry[];
  autoCheckActionOverrides?: AutoCheckActionOverride[];
}

const EMPTY_GROUPS: Record<AutoCheckItemKind, AutoCheckItem[]> = {
  blocking: [],
  action: [],
  evidence: [],
  review: [],
  info: [],
};

const KIND_PRIORITY: Record<AutoCheckItemKind, number> = {
  blocking: 0,
  evidence: 1,
  action: 2,
  review: 3,
  info: 4,
};

function asArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function kindFromWorkspaceIssue(kind: UserFacingIssueKind): AutoCheckItemKind {
  if (kind === 'blocking_error') return 'blocking';
  if (kind === 'evidence_needed') return 'evidence';
  if (kind === 'optional_review') return 'review';
  if (kind === 'technical_info') return 'info';
  return 'action';
}

function kindFromChecklist(item: PitSubmissionChecklistItem): AutoCheckItemKind {
  if (item.severity === 'blocking') return 'blocking';
  if (item.severity === 'evidence') return 'evidence';
  if (item.severity === 'risk') return 'review';
  return 'info';
}

function kindFromBrokerAction(action: BrokerFileIntakeActionRow): AutoCheckItemKind {
  if (action.severity === 'blocking') return 'blocking';
  if (action.severity === 'warning') return 'review';
  return 'info';
}

function verdictFromStage(status?: WorkspaceStageStatus): AutoCheckVerdict {
  if (status === 'blocked') return 'blocked';
  if (status === 'needs_attention') return 'needs_review';
  if (status === 'ready') return 'ready';
  return 'not_ready';
}

function headlineForVerdict(verdict: AutoCheckVerdict): string {
  const labels: Record<AutoCheckVerdict, string> = {
    ready: 'Gotowe do rozliczenia',
    ready_with_evidence: 'Gotowe, zachowaj dowody',
    needs_review: 'Wymaga kontroli',
    blocked: 'Do kontroli PIT',
    not_ready: 'Nie gotowe',
  };
  return labels[verdict];
}

function targetLabel(view: WorkspaceTargetView): string {
  const labels: Record<WorkspaceTargetView, string> = {
    pulpit: 'Pulpit',
    centrum_pracy: 'Centrum pracy',
    historia_transakcji: 'Historię transakcji',
    raport_roczny: 'Raport roczny',
    import_danych: 'Import danych',
  };
  return labels[view];
}

function itemKey(item: AutoCheckItem): string {
  return `${item.kind}:${item.id}:${item.title}`;
}

function dedupeItems(items: AutoCheckItem[]): AutoCheckItem[] {
  const byKey = new Map<string, AutoCheckItem>();
  for (const item of items) {
    const key = itemKey(item);
    const previous = byKey.get(key);
    if (!previous || item.priority < previous.priority) {
      byKey.set(key, item);
    }
  }
  return Array.from(byKey.values()).sort((a, b) => (
    (KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind]) ||
    (a.priority - b.priority) ||
    a.title.localeCompare(b.title)
  ));
}

function applyOverrides(items: AutoCheckItem[], overrides: AutoCheckActionOverride[]): AutoCheckItem[] {
  const byId = new Map(overrides.map((override) => [override.itemId, override]));
  return items.filter((item) => {
    const override = byId.get(item.id);
    return override?.status !== 'done' && override?.status !== 'hidden';
  });
}

function buildWorkspaceItems(readiness: WorkspaceReadiness): AutoCheckItem[] {
  return readiness.attentionItems.map((item, index) => {
    const kind = kindFromWorkspaceIssue(item.kind);
    return {
      id: `workspace:${item.code}`,
      priority: KIND_PRIORITY[kind] * 100 + index,
      kind,
      title: item.label,
      whatItMeans: item.message,
      howToFix: `Otwórz ${targetLabel(item.targetView)} i wykonaj wskazaną akcję. Jeśli to dowód, zachowaj potwierdzenie poza aplikacją.`,
      targetView: item.targetView,
      searchTerm: item.code,
      sourceIds: [],
      evidenceIds: item.code ? [item.code] : [],
      canMarkDone: kind !== 'blocking',
    };
  });
}

function buildChecklistItems(readiness?: TaxFilingPackageAuditAppendix['pit_submission_readiness']): AutoCheckItem[] {
  return asArray(readiness?.checklist)
    .filter((item) => item.severity !== 'info')
    .map((item, index) => {
      const kind = kindFromChecklist(item);
      return {
        id: `pit-checklist:${item.id}`,
        priority: KIND_PRIORITY[kind] * 100 + 20 + index,
        kind,
        title: item.label,
        whatItMeans: item.userAction || item.label,
        howToFix: item.severity === 'evidence'
          ? 'Zachowaj wskazany dokument, dopisz notatkę dowodową i przejdź do powiązanego rekordu, jeśli jest dostępny.'
          : 'Otwórz raport roczny i rozwiń szczegóły checklisty PIT.',
        targetView: 'raport_roczny',
        searchTerm: item.linkedRowId || item.sourceId || item.linkedCostId || item.id,
        sourceIds: [item.sourceId].filter(Boolean) as string[],
        evidenceIds: [item.linkedCostId, item.id].filter(Boolean) as string[],
        canMarkDone: item.severity !== 'blocking',
      };
    });
}

function buildBrokerActionItems(summary?: BrokerFileIntakeSummary | null): AutoCheckItem[] {
  return asArray(summary?.actionRows)
    .filter((action) => action.status === 'open')
    .map((action, index) => {
      const kind = kindFromBrokerAction(action);
      return {
        id: `broker-action:${action.actionId}`,
        priority: KIND_PRIORITY[kind] * 100 + 40 + index,
        kind,
        title: action.label,
        whatItMeans: action.reason || action.label,
        howToFix: action.userAction || 'Otwórz import danych i sprawdź szczegóły sprawy źródłowej.',
        targetView: 'import_danych',
        searchTerm: action.historySearchTerm || action.actionId,
        sourceIds: action.relatedSourceIds?.length ? action.relatedSourceIds : action.sourceIds,
        evidenceIds: action.relatedCostIds,
        canMarkDone: kind !== 'blocking',
      };
    });
}

function buildDefenseItems(items: DefenseWorkbenchItem[] = []): AutoCheckItem[] {
  return items
    .filter((item) => !item.evidenceConfirmed && item.groupId !== 'review')
    .map((item, index) => {
      const kind: AutoCheckItemKind = item.groupId === 'blocking'
        ? 'blocking'
        : item.groupId === 'risk'
          ? 'review'
          : 'evidence';
      return {
        id: `defense:${item.id}`,
        priority: KIND_PRIORITY[kind] * 100 + 60 + index,
        kind,
        title: item.label,
        whatItMeans: item.details || item.userAction,
        howToFix: item.userAction || 'Uzupełnij dowód albo notatkę w Panelu dowodów PIT.',
        targetView: 'centrum_pracy',
        searchTerm: item.historyTarget.searchTerm || item.linkedCostId || item.evidenceId || item.id,
        sourceIds: [item.sourceRecordId].filter(Boolean) as string[],
        evidenceIds: [item.evidenceId, item.linkedCostId].filter(Boolean) as string[],
        canMarkDone: Boolean(item.evidenceId || item.linkedCostId),
      };
    });
}

function buildLogItems(logs: DisplayLogEntry[] = []): AutoCheckItem[] {
  return logs
    .filter((log) => log.userFacingKind === 'blocking_error')
    .slice(-3)
    .map((log, index) => ({
      id: `log:${log.id || log.stage}:${index}`,
      priority: index,
      kind: 'blocking' as AutoCheckItemKind,
      title: log.stage,
      whatItMeans: log.displayMessage,
      howToFix: 'Otwórz ustawienia systemowe i sprawdź pełny wpis logu. Jeżeli dotyczy pliku źródłowego, wgraj poprawny plik.',
      targetView: 'centrum_pracy' as WorkspaceTargetView,
      searchTerm: log.stage,
      sourceIds: [],
      evidenceIds: [],
      canMarkDone: false,
    }));
}

function buildFallbackAction(readiness: WorkspaceReadiness): AutoCheckItem | null {
  const action = readiness.recommendedAction;
  if (!action?.label) {
    return null;
  }
  return {
    id: 'workspace-recommended-action',
    priority: 900,
    kind: readiness.settlementStatus.kind === 'ready' ? 'info' : 'action',
    title: action.label,
    whatItMeans: action.message,
    howToFix: `Przejdź do sekcji ${targetLabel(action.targetView)} i wykonaj tę akcję.`,
    targetView: action.targetView,
    searchTerm: null,
    sourceIds: [],
    evidenceIds: [],
    canMarkDone: false,
  };
}

function buildSteps(input: AutoCheckGuideInput, groups: Record<AutoCheckItemKind, AutoCheckItem[]>): AutoCheckStep[] {
  const stages = new Map(input.workspaceReadiness.stages.map((stage) => [stage.id, stage]));
  const nbpBlockingCount = input.workspaceReadiness.attentionItems.filter((item) => (
    /NBP|FX.*GAP|COVERAGE_GAP/i.test(`${item.code} ${item.label} ${item.message}`) &&
    item.kind === 'blocking_error'
  )).length;
  const brokerOpen = input.brokerFileSummary?.actionProgress.open || 0;
  const brokerBlocking = input.brokerFileSummary?.actionProgress.blocking || 0;
  const brokerWarnings = input.brokerFileSummary?.actionProgress.warnings || 0;
  const importReviewCount = groups.review.filter((item) => item.targetView === 'import_danych').length;
  const evidenceCount = groups.evidence.length;
  const reviewCount = groups.review.length;
  return [
    {
      id: 'dane',
      label: 'Dane',
      status: verdictFromStage(stages.get('dane_quality')?.status || stages.get('import')?.status),
      count: groups.blocking.length,
    },
    {
      id: 'broker_sources',
      label: 'Źródła brokera',
      status: brokerBlocking > 0 ? 'blocked' : brokerOpen > 0 || brokerWarnings > 0 || importReviewCount > 0 ? 'needs_review' : input.brokerFileSummary?.totalSources ? 'ready' : 'not_ready',
      count: brokerOpen || importReviewCount,
    },
    {
      id: 'nbp',
      label: 'Kursy NBP',
      status: nbpBlockingCount > 0 ? 'blocked' : 'ready',
      count: nbpBlockingCount,
    },
    {
      id: 'history',
      label: 'Historia',
      status: verdictFromStage(stages.get('transaction_history')?.status),
      count: stages.get('transaction_history')?.count || 0,
    },
    {
      id: 'evidence',
      label: 'Dowody',
      status: evidenceCount > 0 ? 'ready_with_evidence' : reviewCount > 0 ? 'needs_review' : 'ready',
      count: evidenceCount,
    },
    {
      id: 'package',
      label: 'Pakiet PIT',
      status: verdictFromStage(stages.get('tax_package')?.status || stages.get('tax_report')?.status),
      count: stages.get('tax_package')?.count || 0,
    },
  ];
}

function groupItems(items: AutoCheckItem[]): Record<AutoCheckItemKind, AutoCheckItem[]> {
  const groups: Record<AutoCheckItemKind, AutoCheckItem[]> = {
    blocking: [],
    action: [],
    evidence: [],
    review: [],
    info: [],
  };
  for (const item of items) {
    groups[item.kind].push(item);
  }
  return groups;
}

export function buildAutoCheckGuide(input: AutoCheckGuideInput): AutoCheckGuide {
  const fallbackAction = buildFallbackAction(input.workspaceReadiness);
  const rawItems = [
    ...buildWorkspaceItems(input.workspaceReadiness),
    ...buildChecklistItems(input.auditAppendix?.pit_submission_readiness),
    ...buildBrokerActionItems(input.brokerFileSummary),
    ...buildDefenseItems(input.defenseItems),
    ...buildLogItems(input.displayLogs),
    ...(fallbackAction ? [fallbackAction] : []),
  ];
  const items = applyOverrides(dedupeItems(rawItems), input.autoCheckActionOverrides || []);
  const groups = { ...EMPTY_GROUPS, ...groupItems(items) };
  const verdict = input.workspaceReadiness.settlementStatus.kind;
  const steps = buildSteps(input, groups);
  const recommendedItem = items.find((item) => item.kind !== 'info') || items[0] || null;

  return {
    verdict,
    headline: headlineForVerdict(verdict),
    summary: input.workspaceReadiness.settlementStatus.message,
    recommendedItem,
    steps,
    groups,
  };
}
