import React from 'react';
import { odmienLiczebnik } from '../../portfel/services/odmianaLiczebnika';
import { AlertCircle, CheckCircle2, Clock3, ShieldAlert } from 'lucide-react';
import { motion } from 'motion/react';
import type { TaxEngineResponse } from '../hooks/useTaxEngineRun';
import type { FileInfo, LogEntry } from '../types';
import {
  buildWorkspaceReadiness,
  type WorkspaceStageStatus,
  type WorkspaceTargetView,
} from '../services/workspaceReadiness';
import {
  TAX_REPORT_ORGANIZATION_LABELS,
  type TaxReportOrganizationStatus,
} from '../services/reportOrganizationStatus';
import { buildPitRepairConsole } from '../services/pitRepairConsole';
import type { DefenseEvidenceOverride } from '../services/defenseEvidenceOverrides';
import type { BrokerFileActionOverride } from '../services/brokerFileActionOverrides';
import { buildDefenseWorkbench, type DefenseWorkbenchItem } from '../services/defenseWorkbench';
import { buildPitCaseFileBaselineStatus, readPitCaseFileBaseline } from '../services/pitCaseFile';
import { buildYearClosureStatus, readTaxYearClosure, type TaxYearClosure } from '../services/yearClosure';
import { browserLocalStorage } from '../services/browserStorage';
import { buildBrokerFileIntakeSummary } from '../services/brokerFileIntake';
import { buildDisplayLogEntries } from '../services/displayLogs';
import { buildAutoCheckGuide, type AutoCheckItem, type AutoCheckItemKind, type AutoCheckVerdict } from '../services/autoCheckGuide';
import type { AutoCheckActionOverride } from '../services/autoCheckActionOverrides';
import type { UiComplexityMode } from '../services/uiPreferences';
import {
  CockpitStatusHero,
  DisclosureSection,
  InsightDrawer,
  ProgressStepRail,
  RecommendedActionCard,
  type OpenInsightDrawer,
} from './cockpit/CockpitUi';
import { useUiMotion } from './cockpit/uiMotion';

function readPitCaseBaselineFromBrowser(year: number) {
  try {
    return readPitCaseFileBaseline(browserLocalStorage, year);
  } catch {
    return null;
  }
}

function readTaxYearClosureFromBrowser(year: number): TaxYearClosure | null {
  try {
    return readTaxYearClosure(browserLocalStorage, year);
  } catch {
    return null;
  }
}

function coverageStatusLabel(status?: string): string {
  const labels: Record<string, string> = {
    complete: 'kompletne',
    partial: 'częściowe',
    missing: 'brak',
    conflict: 'konflikt',
    not_applicable: 'nie dotyczy',
  };
  return labels[status || ''] || status || 'brak danych';
}

function coverageStatusClasses(status?: string): string {
  if (status === 'complete') {
    return 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300';
  }
  if (status === 'partial') {
    return 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300';
  }
  if (status === 'missing' || status === 'conflict') {
    return 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-300';
  }
  return 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300';
}

function fileCountLabel(count: number): string {
  return `${count} ${odmienLiczebnik(count, 'plik', 'pliki', 'plików')}`;
}

function autoCheckVerdictClasses(verdict: AutoCheckVerdict): string {
  if (verdict === 'blocked') {
    return 'border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-200';
  }
  if (verdict === 'ready_with_evidence') {
    return 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200';
  }
  if (verdict === 'needs_review') {
    return 'border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-200';
  }
  if (verdict === 'ready') {
    return 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-200';
  }
  return 'border-slate-200 bg-slate-50 text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200';
}

function autoCheckVerdictTone(verdict: AutoCheckVerdict): 'ready' | 'evidence' | 'review' | 'blocked' | 'info' {
  if (verdict === 'ready') return 'ready';
  if (verdict === 'ready_with_evidence') return 'evidence';
  if (verdict === 'needs_review') return 'review';
  if (verdict === 'blocked' || verdict === 'not_ready') return 'blocked';
  return 'info';
}

function autoCheckVerdictLabel(verdict: AutoCheckVerdict): string {
  const labels: Record<AutoCheckVerdict, string> = {
    ready: 'Gotowe',
    ready_with_evidence: 'Gotowe, zachowaj dowody',
    needs_review: 'Wymaga kontroli',
    blocked: 'Do kontroli PIT',
    not_ready: 'Wymaga danych',
  };
  return labels[verdict];
}

function autoCheckStepStatus(status: AutoCheckVerdict): 'ready' | 'evidence' | 'review' | 'blocked' | 'not_ready' | 'info' {
  if (status === 'ready') return 'ready';
  if (status === 'ready_with_evidence') return 'evidence';
  if (status === 'needs_review') return 'review';
  if (status === 'blocked') return 'blocked';
  if (status === 'not_ready') return 'not_ready';
  return 'info';
}

function autoCheckItemKindLabel(kind: AutoCheckItemKind): string {
  const labels: Record<AutoCheckItemKind, string> = {
    blocking: 'Kontrole PIT',
    action: 'Działania',
    evidence: 'Dowody',
    review: 'Kontrola',
    info: 'Informacje',
  };
  return labels[kind];
}

interface WorkspaceCenterProps {
  selectedYear: number;
  engineLoading: boolean;
  engineResult: TaxEngineResponse | null;
  files: FileInfo[];
  logs: LogEntry[];
  overrideCount: number;
  reportOrganizationStatus: TaxReportOrganizationStatus;
  onNavigate: (view: WorkspaceTargetView) => void;
  onOpenHistorySearch?: (query: string, focusRowId?: string | null) => void;
  defenseEvidenceOverrides?: DefenseEvidenceOverride[];
  brokerFileActionOverrides?: BrokerFileActionOverride[];
  autoCheckActionOverrides?: AutoCheckActionOverride[];
  onConfirmEvidence?: (item: DefenseWorkbenchItem) => void;
  onAddEvidenceNote?: (item: DefenseWorkbenchItem) => void;
  onLinkEvidenceRow?: (item: DefenseWorkbenchItem) => void;
  onMarkAutoCheckDone?: (item: AutoCheckItem) => void;
  onHideAutoCheckItem?: (item: AutoCheckItem) => void;
  uiComplexityMode?: UiComplexityMode;
  onOpenInsight?: OpenInsightDrawer;
}

/**
 * Licznik z audytu silnika albo myslnik. `?? 0` pokazywalo zero konfliktow
 * i zero brakow takze wtedy, gdy silnik nie zwrocil raportu wiezy kontrolnej -
 * brak sprawdzenia wygladal jak sprawdzenie bez zastrzezen.
 */
function licznikSilnika(wartosc: number | undefined | null): string {
  return wartosc === undefined || wartosc === null ? '—' : String(wartosc);
}

export function WorkspaceCenter({
  selectedYear,
  engineLoading,
  engineResult,
  files,
  logs,
  overrideCount,
  reportOrganizationStatus,
  onNavigate,
  onOpenHistorySearch,
  defenseEvidenceOverrides = [],
  brokerFileActionOverrides = [],
  autoCheckActionOverrides = [],
  onConfirmEvidence,
  onAddEvidenceNote,
  onLinkEvidenceRow,
  onMarkAutoCheckDone,
  onHideAutoCheckItem,
  uiComplexityMode = 'simple',
  onOpenInsight,
}: WorkspaceCenterProps) {
  const isExpertMode = uiComplexityMode === 'expert';
  const uiMotion = useUiMotion();
  const [selectedDefenseTraceId, setSelectedDefenseTraceId] = React.useState<string | null>(null);
  const [pitCaseFileBaseline, setPitCaseFileBaseline] = React.useState<ReturnType<typeof readPitCaseFileBaseline>>(
    () => readPitCaseBaselineFromBrowser(selectedYear),
  );
  const [taxYearClosure, setTaxYearClosure] = React.useState<TaxYearClosure | null>(
    () => readTaxYearClosureFromBrowser(selectedYear),
  );
  const [showAllAttentionItems, setShowAllAttentionItems] = React.useState(false);
  const [showAutoCheckDetails, setShowAutoCheckDetails] = React.useState(false);
  const [activeAutoCheckInsight, setActiveAutoCheckInsight] = React.useState<AutoCheckItem | null>(null);
  const auditAppendix = engineResult?.tax_filing_package?.audit_appendix || null;
  const brokerFileControlTower = auditAppendix?.broker_file_control_tower || null;
  const coverageMatrix = auditAppendix?.coverage_matrix || [];
  const noOverpayAuditV2 = auditAppendix?.no_overpay_audit_v2 || null;
  const controlTowerSummary = brokerFileControlTower?.summary || {};
  const noOverpaySummary = noOverpayAuditV2?.summary || {};
  const controlTowerActions = [
    ...(brokerFileControlTower?.recommendedActions || []),
    ...(noOverpayAuditV2?.recommendedActions || []),
  ].filter(Boolean);
  const hasControlTower = Boolean(brokerFileControlTower || coverageMatrix.length || noOverpayAuditV2);
  const pitCaseFileBaselineStatus = buildPitCaseFileBaselineStatus(auditAppendix?.pit_case_file || null, pitCaseFileBaseline);
  const taxYearClosureStatus = buildYearClosureStatus(auditAppendix?.pit_case_file || null, taxYearClosure);
  const isYearReadOnly = taxYearClosureStatus.isReadOnly;

  React.useEffect(() => {
    setPitCaseFileBaseline(readPitCaseBaselineFromBrowser(selectedYear));
    setTaxYearClosure(readTaxYearClosureFromBrowser(selectedYear));
  }, [selectedYear]);

  const readiness = buildWorkspaceReadiness({
    selectedYear,
    // Rekordy wejsciowe pochodza z silnika. Lokalna kopia transakcji w
    // przegladarce nie istnieje od czasu przebudowy - kafelek pokazywal zero
    // przy kilkuset wczytanych rekordach.
    transactionCount: engineResult?.editable_records?.length || 0,
    fileCount: files.length,
    enabledFileCount: files.filter((file) => file.isEnabled !== false).length,
    overrideCount,
    engineLoading,
    engineResult,
    logs,
    reportStatus: reportOrganizationStatus,
    pitCaseFileBaselineStatus,
    taxYearClosureStatus,
    brokerFileActionOverrides,
  });

  const stageStatusLabel: Record<WorkspaceStageStatus, string> = {
    ready: 'Gotowe',
    needs_attention: 'Wymaga uwagi',
    blocked: 'Do kontroli PIT',
    not_started: 'Nie rozpoczęte',
  };

  const stageStatusClasses: Record<WorkspaceStageStatus, string> = {
    ready: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300',
    needs_attention: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300',
    blocked: 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-300',
    not_started: 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300',
  };

  const stageIcon = (status: WorkspaceStageStatus) => {
    if (status === 'ready') return <CheckCircle2 className="h-5 w-5" />;
    if (status === 'blocked') return <ShieldAlert className="h-5 w-5" />;
    if (status === 'needs_attention') return <AlertCircle className="h-5 w-5" />;
    return <Clock3 className="h-5 w-5" />;
  };

  const pitReadiness = auditAppendix?.pit_submission_readiness || null;
  const repairConsole = buildPitRepairConsole(auditAppendix);
  const pitVerdictLabel: Record<string, string> = {
    READY: 'Gotowe',
    READY_WITH_RISK: 'Gotowe z ryzykiem',
    NEEDS_EVIDENCE: 'Wymaga dowodów',
    BLOCKED: 'Do kontroli PIT',
  };
  const pitVerdictClasses: Record<string, string> = {
    READY: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300',
    READY_WITH_RISK: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300',
    NEEDS_EVIDENCE: 'border-orange-200 bg-orange-50 text-orange-800 dark:border-orange-500/20 dark:bg-orange-500/10 dark:text-orange-300',
    BLOCKED: 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-300',
  };
  const pitChecklist = pitReadiness?.checklist || [];
  const defenseWorkbench = buildDefenseWorkbench(auditAppendix, defenseEvidenceOverrides);
  const brokerFileSummary = React.useMemo(
    () => buildBrokerFileIntakeSummary(auditAppendix, files, [], brokerFileActionOverrides),
    [auditAppendix, files, brokerFileActionOverrides],
  );
  const displayLogs = React.useMemo(() => buildDisplayLogEntries(logs), [logs]);
  const autoCheckGuide = React.useMemo(
    () => buildAutoCheckGuide({
      workspaceReadiness: readiness,
      auditAppendix,
      brokerFileSummary,
      defenseItems: defenseWorkbench.items,
      displayLogs,
      autoCheckActionOverrides,
    }),
    [readiness, auditAppendix, brokerFileSummary, defenseWorkbench.items, displayLogs, autoCheckActionOverrides],
  );
  const autoCheckMetrics = [
    { label: 'Kontrole PIT', value: autoCheckGuide.groups.blocking.length, tone: autoCheckGuide.groups.blocking.length > 0 ? 'blocked' as const : 'ready' as const },
    { label: 'Dowody', value: autoCheckGuide.groups.evidence.length, tone: autoCheckGuide.groups.evidence.length > 0 ? 'evidence' as const : 'ready' as const },
    { label: 'Kontrole', value: autoCheckGuide.groups.review.length, tone: autoCheckGuide.groups.review.length > 0 ? 'review' as const : 'ready' as const },
  ];
  const openAutoCheckInsight = React.useCallback((item: AutoCheckItem | null | undefined) => {
    if (!item) {
      return;
    }
    if (!onOpenInsight) {
      setActiveAutoCheckInsight(item);
      return;
    }
    onOpenInsight({
      type: item.kind === 'evidence' ? 'evidence' : item.kind === 'info' ? 'technical' : 'source',
      id: item.id,
      title: item.title,
      subtitle: autoCheckItemKindLabel(item.kind),
      sections: [
        { title: 'Co to znaczy', content: item.whatItMeans },
        { title: 'Wpływ na PIT', content: item.kind === 'blocking' ? 'Ta sprawa wymaga kontroli przed podatkowym użyciem danych.' : 'Ta sprawa prowadzi workflow i nie zmienia kwoty automatycznie.' },
        { title: 'Co zrobić', content: item.howToFix },
        {
          title: 'Źródła',
          content: item.sourceIds.length > 0
            ? item.sourceIds.join(', ')
            : 'Brak powiązanych źródeł w modelu Samocheck.',
        },
      ],
      children: (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onNavigate(item.targetView)}
            className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-blue-700"
          >
            Przejdź
          </button>
          {item.searchTerm && (
            <button
              type="button"
              onClick={() => onOpenHistorySearch?.(item.searchTerm || '')}
              className="rounded-lg border border-blue-200 px-3 py-2 text-xs font-semibold text-blue-700 transition hover:bg-blue-50 dark:border-blue-800 dark:text-blue-200 dark:hover:bg-blue-950/30"
            >
              Pokaż w historii
            </button>
          )}
        </div>
      ),
    });
  }, [onNavigate, onOpenHistorySearch, onOpenInsight]);
  const selectedDefenseTrace = auditAppendix?.tax_trace_index?.find((trace) => trace.trace_id === selectedDefenseTraceId) || null;
  const pitAssistantSteps = [
    {
      label: 'Dane i kontrole PIT',
      count: pitChecklist.filter((item) => item.severity === 'blocking' && item.category !== 'nbp' && item.category !== 'calculation').length,
    },
    {
      label: 'Kursy NBP i spójność obliczeń',
      count: pitChecklist.filter((item) => item.category === 'nbp' || item.category === 'calculation').length,
    },
    {
      label: 'Koszty agresywne i dowody',
      count: pitChecklist.filter((item) => item.category === 'defense' && item.severity === 'evidence').length,
    },
    {
      label: 'Ryzyka planu agresywnego',
      count: pitChecklist.filter((item) => item.severity === 'risk').length,
    },
    {
      label: 'Podsumowanie i eksport',
      // `pitReadiness ? 1 : 0` dawalo "1 pozycji do przejrzenia" za samo
      // istnienie pakietu, takze przy werdykcie READY i zerze problemow.
      count: pitChecklist.filter((item) => item.severity === 'blocking').length,
    },
  ];
  const attentionGroups = React.useMemo(() => {
    const groups = [
      {
        id: 'blocking',
        label: 'Kontrole PIT',
        emptyMessage: 'Brak kontroli PIT wymagających działania.',
        items: readiness.attentionItems.filter((item) => item.kind === 'blocking_error'),
      },
      {
        id: 'evidence',
        label: 'Dowody do zachowania',
        emptyMessage: 'Brak dowodów wymagających uzupełnienia.',
        items: readiness.attentionItems.filter((item) => item.kind === 'evidence_needed'),
      },
      {
        id: 'review',
        label: 'Kontrola plików',
        emptyMessage: 'Brak pomocniczych kontroli plików.',
        items: readiness.attentionItems.filter((item) => item.kind === 'optional_review' || item.kind === 'action_required'),
      },
      {
        id: 'info',
        label: 'Informacje',
        emptyMessage: 'Informacje techniczne są dostępne w ustawieniach systemowych.',
        items: readiness.attentionItems.filter((item) => item.kind === 'technical_info'),
      },
    ];
    return groups;
  }, [readiness.attentionItems]);
  const primaryAttentionItem = readiness.attentionItems[0] || null;

  return (
    <div className="space-y-6">
      {isExpertMode && (
      <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-blue-600 dark:text-blue-400">Centrum pracy</p>
            <h1 className="mt-1 text-2xl font-bold text-gray-950 dark:text-white">InvestAnalyzer {selectedYear}</h1>
            <p className="mt-2 max-w-3xl text-sm text-gray-600 dark:text-gray-400">
              Jedno miejsce do przejścia od importu lokalnych plików do historii, korekt, raportu PIT-38 i pakietu podatkowego.
            </p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm dark:border-gray-700 dark:bg-gray-900">
            <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Status raportu</p>
            <p className="mt-1 font-semibold text-gray-900 dark:text-white">
              {TAX_REPORT_ORGANIZATION_LABELS[reportOrganizationStatus.status]}
            </p>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-6">
          {readiness.metrics.map((metric) => (
            <div key={metric.label} className="rounded-xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/70">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{metric.label}</p>
              <p className="mt-2 text-base font-bold text-gray-950 dark:text-white">{metric.value}</p>
              {metric.detail && <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{metric.detail}</p>}
            </div>
          ))}
        </div>

        <div className={`mt-5 rounded-xl border p-4 ${
          readiness.settlementStatus.kind === 'blocked'
            ? 'border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-200'
            : readiness.settlementStatus.kind === 'ready_with_evidence' || readiness.settlementStatus.kind === 'needs_review'
              ? 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200'
              : readiness.settlementStatus.kind === 'ready'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-200'
                : 'border-slate-200 bg-slate-50 text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200'
        }`}>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide opacity-75">Stan rozliczenia</p>
              <h2 className="mt-1 text-lg font-bold">{readiness.settlementStatus.label}</h2>
              <p className="mt-1 text-sm opacity-90">{readiness.settlementStatus.message}</p>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center text-xs">
              <div className="rounded-lg bg-white/70 px-3 py-2 dark:bg-gray-950/30">
                <p className="font-bold">{readiness.settlementStatus.blockingCount}</p>
                <p className="opacity-75">kontrole PIT</p>
              </div>
              <div className="rounded-lg bg-white/70 px-3 py-2 dark:bg-gray-950/30">
                <p className="font-bold">{readiness.settlementStatus.evidenceCount}</p>
                <p className="opacity-75">dowody</p>
              </div>
              <div className="rounded-lg bg-white/70 px-3 py-2 dark:bg-gray-950/30">
                <p className="font-bold">{readiness.settlementStatus.reviewCount}</p>
                <p className="opacity-75">kontrole</p>
              </div>
            </div>
          </div>
        </div>
      </section>
      )}

      <motion.div data-motion="workspace-cockpit" {...uiMotion.fadeUp()}>
        <CockpitStatusHero
          eyebrow={`Samocheck PIT · ${autoCheckVerdictLabel(autoCheckGuide.verdict)}`}
          title={autoCheckGuide.headline}
          summary={autoCheckGuide.summary}
          tone={autoCheckVerdictTone(autoCheckGuide.verdict)}
          metrics={autoCheckMetrics}
          action={autoCheckGuide.recommendedItem ? (
            <RecommendedActionCard
              title={autoCheckGuide.recommendedItem.title}
              description={autoCheckGuide.recommendedItem.howToFix}
              ctaLabel="Przejdź"
              onClick={() => onNavigate(autoCheckGuide.recommendedItem?.targetView || 'centrum_pracy')}
              secondaryAction={(
                <button
                  type="button"
                  onClick={() => openAutoCheckInsight(autoCheckGuide.recommendedItem)}
                  className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-semibold text-gray-700 transition hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
                >
                  Otwórz panel szczegółów
                </button>
              )}
            />
          ) : (
            <RecommendedActionCard
              title="Brak aktywnych akcji"
              description="Raport nie wymaga teraz działania. Możesz przejść do pakietu PIT albo sprawdzić szczegóły audytu."
              ctaLabel="Przejdź do raportu"
              onClick={() => onNavigate('raport_roczny')}
            />
          )}
        />
      </motion.div>

      <motion.div data-motion="workspace-step-rail" {...uiMotion.fadeUp(0.08)}>
        <ProgressStepRail
          steps={autoCheckGuide.steps.map((step) => ({
            id: step.id,
            label: step.label,
            status: autoCheckStepStatus(step.status),
            count: step.count,
            onClick: () => {
              const stepTargetView: Record<string, WorkspaceTargetView> = {
                dane: 'import_danych',
                broker_sources: 'import_danych',
                nbp: 'import_danych',
                history: 'historia_transakcji',
                evidence: 'centrum_pracy',
                package: 'raport_roczny',
              };
              const firstItemForStep = [
                ...autoCheckGuide.groups.blocking,
                ...autoCheckGuide.groups.action,
                ...autoCheckGuide.groups.evidence,
                ...autoCheckGuide.groups.review,
                ...autoCheckGuide.groups.info,
              ].find((item) => item.targetView === stepTargetView[step.id]) || autoCheckGuide.recommendedItem;
              if (firstItemForStep) {
                openAutoCheckInsight(firstItemForStep);
              }
            },
          }))}
        />
      </motion.div>

      <InsightDrawer
        open={Boolean(activeAutoCheckInsight) && !onOpenInsight}
        title={activeAutoCheckInsight?.title || 'Szczegóły Samocheck'}
        subtitle={activeAutoCheckInsight ? autoCheckItemKindLabel(activeAutoCheckInsight.kind) : undefined}
        onClose={() => setActiveAutoCheckInsight(null)}
        sections={activeAutoCheckInsight ? [
          { title: 'Co to znaczy', content: activeAutoCheckInsight.whatItMeans },
          { title: 'Wpływ na PIT', content: activeAutoCheckInsight.kind === 'blocking' ? 'Ta sprawa wymaga kontroli przed podatkowym użyciem danych.' : 'Ta sprawa prowadzi workflow i nie zmienia kwoty automatycznie.' },
          { title: 'Co zrobić', content: activeAutoCheckInsight.howToFix },
          { title: 'Źródła / szczegóły', content: activeAutoCheckInsight.sourceIds.length > 0 ? activeAutoCheckInsight.sourceIds.join(', ') : 'Brak powiązanych źródeł w modelu Samocheck.' },
        ] : []}
      >
        {activeAutoCheckInsight && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onNavigate(activeAutoCheckInsight.targetView)}
              className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-blue-700"
            >
              Przejdź
            </button>
            {activeAutoCheckInsight.searchTerm && (
              <button
                type="button"
                onClick={() => onOpenHistorySearch?.(activeAutoCheckInsight.searchTerm || '')}
                className="rounded-lg border border-blue-200 px-3 py-2 text-xs font-semibold text-blue-700 transition hover:bg-blue-50 dark:border-blue-800 dark:text-blue-200 dark:hover:bg-blue-950/30"
              >
                Pokaż w historii
              </button>
            )}
          </div>
        )}
      </InsightDrawer>

      {isExpertMode && showAutoCheckDetails && (
      <section className={`rounded-2xl border p-6 shadow-sm ${autoCheckVerdictClasses(autoCheckGuide.verdict)}`}>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide opacity-75">Samocheck PIT</p>
            <h2 className="mt-1 text-2xl font-bold">{autoCheckGuide.headline}</h2>
            <p className="mt-2 max-w-3xl text-sm opacity-90">{autoCheckGuide.summary}</p>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center text-xs">
            <div className="rounded-lg bg-white/70 px-3 py-2 dark:bg-gray-950/30">
              <p className="font-bold">{autoCheckGuide.groups.blocking.length}</p>
              <p className="opacity-75">kontrole PIT</p>
            </div>
            <div className="rounded-lg bg-white/70 px-3 py-2 dark:bg-gray-950/30">
              <p className="font-bold">{autoCheckGuide.groups.evidence.length}</p>
              <p className="opacity-75">dowody</p>
            </div>
            <div className="rounded-lg bg-white/70 px-3 py-2 dark:bg-gray-950/30">
              <p className="font-bold">{autoCheckGuide.groups.review.length}</p>
              <p className="opacity-75">kontrole</p>
            </div>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-2 md:grid-cols-6">
          {autoCheckGuide.steps.map((step) => (
            <div key={step.id} className="rounded-xl bg-white/70 p-3 text-sm shadow-sm ring-1 ring-black/5 dark:bg-gray-950/30 dark:ring-white/10">
              <p className="font-semibold">{step.label}</p>
              <p className="mt-1 text-xs opacity-75">
                {step.status === 'ready' ? 'OK' : step.status === 'ready_with_evidence' ? 'dowody' : step.status === 'blocked' ? 'kontrola PIT' : step.status === 'needs_review' ? 'kontrola' : 'brak danych'}
                {step.count > 0 ? ` · ${step.count}` : ''}
              </p>
            </div>
          ))}
        </div>

        {autoCheckGuide.recommendedItem ? (
          <div className="mt-5 rounded-xl bg-white/80 p-4 shadow-sm ring-1 ring-black/5 dark:bg-gray-950/30 dark:ring-white/10">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide opacity-70">Najważniejsza akcja</p>
                <h3 className="mt-1 text-lg font-bold">{autoCheckGuide.recommendedItem.title}</h3>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide opacity-70">Co to znaczy</p>
                    <p className="mt-1 text-sm opacity-90">{autoCheckGuide.recommendedItem.whatItMeans}</p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide opacity-70">Co zrobić</p>
                    <p className="mt-1 text-sm opacity-90">{autoCheckGuide.recommendedItem.howToFix}</p>
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 xl:justify-end">
                <button
                  type="button"
                  onClick={() => onNavigate(autoCheckGuide.recommendedItem?.targetView || 'centrum_pracy')}
                  className="inline-flex items-center justify-center rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-700"
                >
                  Przejdź
                </button>
                {autoCheckGuide.recommendedItem.canMarkDone && (
                  <button
                    type="button"
                    onClick={() => onMarkAutoCheckDone?.(autoCheckGuide.recommendedItem as AutoCheckItem)}
                    className="inline-flex items-center justify-center rounded-lg border border-gray-300 bg-white/70 px-3 py-2 text-xs font-semibold transition hover:bg-white disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900/60 dark:hover:bg-gray-900"
                    disabled={!onMarkAutoCheckDone}
                  >
                    Oznacz jako sprawdzone
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onHideAutoCheckItem?.(autoCheckGuide.recommendedItem as AutoCheckItem)}
                  className="inline-flex items-center justify-center rounded-lg border border-gray-300 bg-white/70 px-3 py-2 text-xs font-semibold transition hover:bg-white disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900/60 dark:hover:bg-gray-900"
                  disabled={!onHideAutoCheckItem}
                >
                  Ukryj informację
                </button>
              </div>
            </div>
          </div>
        ) : (
          <p className="mt-5 rounded-xl bg-white/70 p-4 text-sm opacity-90 dark:bg-gray-950/30">
            Brak aktywnych akcji. Jeżeli chcesz, przejdź do raportu i wygeneruj pakiet PIT.
          </p>
        )}

        <div className="mt-4">
          <button
            type="button"
            onClick={() => setShowAutoCheckDetails((value) => !value)}
            className="text-sm font-semibold underline-offset-4 hover:underline"
          >
            {showAutoCheckDetails ? 'Ukryj szczegóły' : 'Pokaż szczegóły'}
          </button>
          {showAutoCheckDetails && (
            <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
              {(Object.keys(autoCheckGuide.groups) as AutoCheckItemKind[]).map((kind) => (
                <div key={kind} className="rounded-xl bg-white/70 p-4 text-sm shadow-sm ring-1 ring-black/5 dark:bg-gray-950/30 dark:ring-white/10">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-semibold">{autoCheckItemKindLabel(kind)}</p>
                    <span className="rounded-full bg-white px-2 py-1 text-xs font-semibold dark:bg-gray-900">
                      {autoCheckGuide.groups[kind].length}
                    </span>
                  </div>
                  {autoCheckGuide.groups[kind].length === 0 ? (
                    <p className="mt-2 text-xs opacity-70">Brak aktywnych pozycji.</p>
                  ) : (
                    <ul className="mt-3 space-y-2">
                      {autoCheckGuide.groups[kind].slice(0, 4).map((item) => (
                        <li key={item.id} className="rounded-lg bg-white/70 p-3 dark:bg-gray-900/60">
                          <p className="font-semibold">{item.title}</p>
                          <p className="mt-1 text-xs opacity-80">{item.howToFix}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
      )}

      {isExpertMode && hasControlTower && (
        <section className="rounded-2xl border border-blue-200 bg-white p-6 shadow-sm dark:border-blue-500/20 dark:bg-gray-800">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-sm font-semibold uppercase tracking-wide text-blue-600 dark:text-blue-400">
                Kontrola plików brokera
              </p>
              <h2 className="mt-1 text-xl font-bold text-gray-950 dark:text-white">
                Co wgrałeś, co liczy PIT i czego brakuje
              </h2>
              <p className="mt-2 max-w-3xl text-sm text-gray-600 dark:text-gray-400">
                Ten panel zbiera manifest importu, macierz kompletności i strażnik nadpłaty podatku. Pokazuje status
                danych wejściowych bez przeliczania podatku lokalnie w UI.
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('import_danych')}
              className="inline-flex items-center justify-center rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-700"
            >
              Przejdź do importu
            </button>
          </div>

          <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/70">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Źródła brokera</p>
              <p className="mt-2 text-lg font-bold text-gray-950 dark:text-white">
                {/* Liczba plikow w przegladarce nie jest liczba zrodel widzianych
                    przez silnik - `?? files.length` podstawialo jedno za drugie. */}
                {controlTowerSummary.source_count === undefined
                  ? '—'
                  : fileCountLabel(controlTowerSummary.source_count)}
              </p>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {licznikSilnika(controlTowerSummary.context_source_count)} kontekstowe
              </p>
            </div>
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-500/20 dark:bg-emerald-500/10">
              <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">W canonical input</p>
              <p className="mt-2 text-lg font-bold text-emerald-950 dark:text-emerald-100">
                {licznikSilnika(controlTowerSummary.canonical_source_count)} źródeł
              </p>
              <p className="mt-1 text-xs text-emerald-700 dark:text-emerald-300">źródła użyte do strumienia danych</p>
            </div>
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-500/20 dark:bg-amber-500/10">
              <p className="text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">Braki i konflikty</p>
              <p className="mt-2 text-lg font-bold text-amber-950 dark:text-amber-100">
                {/* "0 brakow i konfliktow" bez raportu silnika czytalo sie jak
                    wynik sprawdzenia, a znaczylo brak sprawdzenia. */}
                {controlTowerSummary.missing_coverage_count === undefined &&
                controlTowerSummary.conflict_count === undefined
                  ? '—'
                  : (controlTowerSummary.missing_coverage_count ?? 0) +
                    (controlTowerSummary.conflict_count ?? 0)}
              </p>
              <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                {licznikSilnika(controlTowerSummary.duplicate_count)} ryzyk duplikacji
              </p>
            </div>
            <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4 dark:border-indigo-500/20 dark:bg-indigo-500/10">
              <p className="text-xs font-semibold uppercase tracking-wide text-indigo-700 dark:text-indigo-300">No Overpay Guard</p>
              <p className="mt-2 text-lg font-bold text-indigo-950 dark:text-indigo-100">
                {licznikSilnika(noOverpaySummary.candidateCostCount ?? controlTowerSummary.candidate_cost_count)} kandydatów
              </p>
              <p className="mt-1 text-xs text-indigo-700 dark:text-indigo-300">
                {licznikSilnika(noOverpaySummary.potentiallyMissedCount)} potencjalnie pominiętych
              </p>
            </div>
          </div>

          {coverageMatrix.length > 0 && (
            <div className="mt-6">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-300">
                  Macierz kompletności danych
                </h3>
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {coverageMatrix.length} obszarów kontroli
                </span>
              </div>
              <div className="mt-3 grid grid-cols-1 gap-3 xl:grid-cols-2">
                {coverageMatrix.slice(0, 8).map((entry) => (
                  <div
                    key={`${entry.area}:${entry.label}`}
                    className="rounded-xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/60"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="font-semibold text-gray-950 dark:text-white">{entry.label}</p>
                        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                          {entry.recordCount ?? 0} {odmienLiczebnik(entry.recordCount ?? 0, 'rekord', 'rekordy', 'rekordów')} · {entry.issueCount ?? 0} {odmienLiczebnik(entry.issueCount ?? 0, 'sprawa', 'sprawy', 'spraw')}
                        </p>
                      </div>
                      <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${coverageStatusClasses(entry.status)}`}>
                        {coverageStatusLabel(entry.status)}
                      </span>
                    </div>
                    {entry.recommendation && (
                      <p className="mt-3 text-sm text-gray-600 dark:text-gray-400">{entry.recommendation}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {controlTowerActions.length > 0 && (
            <div className="mt-6 rounded-xl border border-blue-100 bg-blue-50 p-4 dark:border-blue-500/20 dark:bg-blue-500/10">
              <p className="text-sm font-semibold text-blue-950 dark:text-blue-100">Co zrobić teraz</p>
              <ul className="mt-2 space-y-1 text-sm text-blue-900 dark:text-blue-100">
                {controlTowerActions.slice(0, 5).map((action, index) => (
                  <li key={`${index}:${action}`}>{action}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {isExpertMode && (
      <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">
              Zamknięcie roku PIT
            </p>
            <h2 className="mt-1 text-xl font-bold text-gray-950 dark:text-white">{taxYearClosureStatus.label}</h2>
            <p className="mt-2 max-w-3xl text-sm text-gray-600 dark:text-gray-400">
              Ten status porównuje bieżący case file z lokalnym snapshotem zamknięcia roku. Jest kontrolą procesu, nie zmianą obliczeń podatkowych.
            </p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm dark:border-gray-700 dark:bg-gray-900">
            <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Tryb pracy</p>
            <p className="mt-1 font-semibold text-gray-900 dark:text-white">
              {taxYearClosureStatus.isReadOnly ? 'Tryb tylko do odczytu' : 'Rok nie jest już zamrożony'}
            </p>
          </div>
        </div>
        {isYearReadOnly && (
          <p className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800 dark:border-emerald-800/50 dark:bg-emerald-900/20 dark:text-emerald-200">
            Dowody są tylko do odczytu, bo rok jest zamknięty. Szczegóły i akcje edycji są dostępne w panelu audytu po ponownym otwarciu roku.
          </p>
        )}
        {taxYearClosureStatus.changedFields.length > 0 && (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-900/20 dark:text-red-200">
            <p className="font-semibold">Zmienione po zamknięciu: {taxYearClosureStatus.changedFields.join(', ')}</p>
            <p className="mt-1">
              Dane lub kalkulacja zmieniły się po zamknięciu roku. W raporcie rocznym wygeneruj nowy pakiet i zamknij rok ponownie.
            </p>
            {taxYearClosureStatus.changedDetails.length > 0 && (
              <div className="mt-3 overflow-hidden rounded-lg border border-red-200 bg-white/70 dark:border-red-900/60 dark:bg-gray-950/40">
                <div className="grid grid-cols-1 divide-y divide-red-100 text-xs dark:divide-red-900/60">
                  {taxYearClosureStatus.changedDetails.map((detail) => (
                    <div key={detail.field} className="grid gap-1 p-2 md:grid-cols-[160px_1fr_1fr] md:items-center">
                      <span className="font-semibold">{detail.label}</span>
                      <span className="break-all text-red-700 dark:text-red-200">
                        Zamknięcie: <code>{detail.previousValue || 'brak'}</code>
                      </span>
                      <span className="break-all text-red-700 dark:text-red-200">
                        Bieżące: <code>{detail.currentValue || 'brak'}</code>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </section>
      )}

      {isExpertMode && (
      <DisclosureSection
        title="Szczegóły audytu, dowodów i naprawy"
        summary="Zaawansowane panele są schowane domyślnie. Otwórz je, gdy chcesz przejrzeć dowody, checklistę PIT albo konkretne rekordy do naprawy."
        defaultOpen={false}
      >
      <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-300">
              Panel dowodów PIT
            </p>
            <h2 className="mt-1 text-xl font-bold text-gray-950 dark:text-white">
              Dowody, notatki i linki do historii w jednym miejscu
            </h2>
            <p className="mt-2 max-w-3xl text-sm text-gray-600 dark:text-gray-400">
              Akcje w tym panelu są lokalne i dowodowe. Zmieniają checklistę oraz eksport pakietu, ale nie zmieniają
              przychodów, kosztów, FIFO, kursów NBP ani kwoty PIT.
            </p>
            {isYearReadOnly && (
              <p className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800 dark:border-emerald-800/50 dark:bg-emerald-900/20 dark:text-emerald-200">
                Dowody są tylko do odczytu, bo rok jest zamknięty. Otwórz rok ponownie w raporcie rocznym, aby zmieniać statusy dowodów, notatki albo linki do historii.
              </p>
            )}
          </div>
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm dark:border-emerald-500/20 dark:bg-emerald-500/10">
            <p className="text-xs uppercase tracking-wide text-emerald-700 dark:text-emerald-300">Postęp dowodów</p>
            <p className="mt-1 font-semibold text-emerald-950 dark:text-emerald-100">
              {defenseWorkbench.progress.confirmedEvidenceItems}/{defenseWorkbench.progress.totalEvidenceItems} dowodów potwierdzonych
            </p>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-4">
          {defenseWorkbench.groups.map((group) => (
            <div key={group.id} className="rounded-xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/70">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold text-gray-950 dark:text-white">{group.label}</p>
                <span className="rounded-full bg-white px-2 py-1 text-xs font-semibold text-gray-700 dark:bg-gray-800 dark:text-gray-200">
                  {group.count}
                </span>
              </div>
              <p className="mt-2 text-xs leading-5 text-gray-500 dark:text-gray-400">{group.description}</p>
            </div>
          ))}
        </div>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-gray-200 bg-gray-50 p-3 text-sm dark:border-gray-700 dark:bg-gray-900/70">
            <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Wysokie ryzyko</p>
            <p className="mt-1 font-semibold text-gray-900 dark:text-white">{defenseWorkbench.progress.highRiskItems}</p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-gray-50 p-3 text-sm dark:border-gray-700 dark:bg-gray-900/70">
            <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Brak linku</p>
            <p className="mt-1 font-semibold text-gray-900 dark:text-white">{defenseWorkbench.progress.missingLinkItems}</p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-gray-50 p-3 text-sm dark:border-gray-700 dark:bg-gray-900/70">
            <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Brak notatki</p>
            <p className="mt-1 font-semibold text-gray-900 dark:text-white">{defenseWorkbench.progress.missingUserNoteItems}</p>
          </div>
        </div>

        {selectedDefenseTrace && (
          <div className="mt-5 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm dark:border-blue-900 dark:bg-blue-900/20">
            <p className="text-xs font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300">Ścieżka kwoty</p>
            <p className="mt-1 font-semibold text-gray-950 dark:text-white">{selectedDefenseTrace.label}</p>
            <p className="mt-1 text-gray-600 dark:text-gray-300">{selectedDefenseTrace.explanation_pl}</p>
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              Ledger: {selectedDefenseTrace.ledger_row_ids.join(', ') || '—'} · Dowody: {selectedDefenseTrace.evidence_ids.join(', ') || '—'} · Źródła: {selectedDefenseTrace.source_record_ids.join(', ') || '—'}
            </p>
          </div>
        )}

        {defenseWorkbench.items.length === 0 ? (
          <p className="mt-5 rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600 dark:border-gray-700 dark:bg-gray-900/70 dark:text-gray-400">
            Brak aktywnych pozycji dowodowych. Wygeneruj pakiet podatkowy, aby zobaczyć pełny graf dowodowy.
          </p>
        ) : (
          <div className="mt-5 space-y-3">
            {defenseWorkbench.items.slice(0, 10).map((item) => (
              <div key={item.id} className="rounded-xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/70">
                <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold text-gray-950 dark:text-white">{item.label}</p>
                      <span className="rounded-full bg-white px-2 py-1 text-xs font-semibold text-gray-700 dark:bg-gray-800 dark:text-gray-200">
                        {item.defenseStatusLabel}
                      </span>
                      {item.evidenceConfirmed && (
                        <span className="rounded-full bg-emerald-100 px-2 py-1 text-xs font-semibold text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">
                          Dowód potwierdzony lokalnie
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{item.details || item.userAction}</p>
                    {item.localNote && (
                      <p className="mt-2 rounded-lg bg-white px-3 py-2 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                        Notatka: {item.localNote}
                      </p>
                    )}
                    <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                      {item.linkedCostId || item.evidenceId || item.checklistId || item.id}
                      {item.amountPln ? ` · ${item.amountPln} PLN` : ''}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2 xl:justify-end">
                    <button
                      type="button"
                      disabled={isYearReadOnly || !onConfirmEvidence || !item.evidenceId}
                      onClick={() => onConfirmEvidence?.(item)}
                      className="inline-flex items-center justify-center rounded-lg border border-emerald-200 px-3 py-2 text-xs font-semibold text-emerald-700 transition-colors hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-900/20"
                    >
                      Oznacz dowód jako zebrany
                    </button>
                    <button
                      type="button"
                      disabled={isYearReadOnly || !onAddEvidenceNote || !item.evidenceId}
                      onClick={() => onAddEvidenceNote?.(item)}
                      className="inline-flex items-center justify-center rounded-lg border border-gray-200 px-3 py-2 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                    >
                      Dodaj notatkę
                    </button>
                    <button
                      type="button"
                      disabled={isYearReadOnly || !onLinkEvidenceRow || !item.evidenceId}
                      onClick={() => onLinkEvidenceRow?.(item)}
                      className="inline-flex items-center justify-center rounded-lg border border-gray-200 px-3 py-2 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                    >
                      Podłącz rekord historii
                    </button>
                    <button
                      type="button"
                      disabled={!item.historyTarget.searchTerm || !onOpenHistorySearch}
                      onClick={() => onOpenHistorySearch?.(item.historyTarget.searchTerm, item.historyTarget.rowId)}
                      className="inline-flex items-center justify-center rounded-lg border border-blue-200 px-3 py-2 text-xs font-semibold text-blue-700 transition-colors hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-blue-800 dark:text-blue-300 dark:hover:bg-blue-900/20"
                    >
                      Przejdź do historii
                    </button>
                    <button
                      type="button"
                      disabled={!item.traceId}
                      onClick={() => setSelectedDefenseTraceId(item.traceId || null)}
                      className="inline-flex items-center justify-center rounded-lg border border-blue-200 px-3 py-2 text-xs font-semibold text-blue-700 transition-colors hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-blue-800 dark:text-blue-300 dark:hover:bg-blue-900/20"
                    >
                      Pokaż ścieżkę kwoty
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-blue-600 dark:text-blue-400">
              Asystent PIT przed złożeniem
            </p>
            <h2 className="mt-1 text-xl font-bold text-gray-950 dark:text-white">
              Przejście przez kontrole PIT, dowody, ryzyka i eksport pakietu
            </h2>
            <p className="mt-2 max-w-3xl text-sm text-gray-600 dark:text-gray-400">
              Asystent korzysta z wyniku silnika i checklisty audytowej. Lokalne potwierdzenia dowodów zmieniają tylko status
              przygotowania, nie kwoty PIT, FIFO ani kursy NBP.
            </p>
          </div>
          <div className={`rounded-xl border px-4 py-3 text-sm font-semibold ${pitVerdictClasses[pitReadiness?.verdict || ''] || stageStatusClasses.not_started}`}>
            {pitReadiness ? pitVerdictLabel[pitReadiness.verdict] || pitReadiness.verdict : 'Brak pakietu'}
            {pitReadiness && <span className="ml-2 text-xs font-medium opacity-80">{pitReadiness.score}/100</span>}
          </div>
        </div>
        <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-5">
          {pitAssistantSteps.map((step, index) => (
            <div key={step.label} className="rounded-xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/70">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-blue-600 text-xs font-bold text-white">
                {index + 1}
              </span>
              <p className="mt-3 text-sm font-semibold text-gray-950 dark:text-white">{step.label}</p>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {step.count > 0 ? `${step.count} ${odmienLiczebnik(step.count, 'pozycja', 'pozycje', 'pozycji')} do przejrzenia` : 'Brak aktywnych problemów'}
              </p>
            </div>
          ))}
        </div>
        {pitReadiness?.recommendedAction ? (
          <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-500/20 dark:bg-amber-500/10">
            <p className="text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">Rekomendowany krok</p>
            <p className="mt-1 font-semibold text-amber-950 dark:text-amber-100">{pitReadiness.recommendedAction.label}</p>
            <p className="mt-1 text-sm text-amber-800 dark:text-amber-200">{pitReadiness.recommendedAction.userAction}</p>
          </div>
        ) : (
          <p className="mt-5 rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600 dark:border-gray-700 dark:bg-gray-900/70 dark:text-gray-400">
            Wygeneruj pakiet podatkowy w raporcie rocznym, aby zobaczyć pełną checklistę przed złożeniem PIT.
          </p>
        )}
      </section>

      <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-rose-600 dark:text-rose-300">
              Konsola naprawy PIT
            </p>
            <h2 className="mt-1 text-xl font-bold text-gray-950 dark:text-white">
              Konkretne pozycje do poprawy, udokumentowania albo sprawdzenia
            </h2>
            <p className="mt-2 max-w-3xl text-sm text-gray-600 dark:text-gray-400">
              Lista jest zbudowana z checklisty silnika, grafu dowodowego i ścieżek kwot. Przejście do rekordu otwiera historię z filtrem i podświetleniem źródła.
            </p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm dark:border-gray-700 dark:bg-gray-900">
            <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Pozycje aktywne</p>
            <p className="mt-1 font-semibold text-gray-900 dark:text-white">{repairConsole.items.length}</p>
          </div>
        </div>
        <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-4">
          {repairConsole.groups.map((group) => (
            <div key={group.id} className="rounded-xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/70">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold text-gray-950 dark:text-white">{group.label}</p>
                <span className="rounded-full bg-white px-2 py-1 text-xs font-semibold text-gray-700 dark:bg-gray-800 dark:text-gray-200">
                  {group.count}
                </span>
              </div>
              <p className="mt-2 text-xs leading-5 text-gray-500 dark:text-gray-400">{group.description}</p>
            </div>
          ))}
        </div>
        {repairConsole.items.length === 0 ? (
          <p className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300">
            Brak aktywnych pozycji naprawczych. Jeżeli chcesz pełną checklistę, wygeneruj pakiet podatkowy w raporcie rocznym.
          </p>
        ) : (
          <div className="mt-5 space-y-3">
            {repairConsole.items.slice(0, 8).map((item) => (
              <div key={item.id} className="rounded-xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/70">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <p className="text-sm font-semibold text-gray-950 dark:text-white">{item.label}</p>
                    <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{item.details || item.userAction}</p>
                    <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                      {item.category} · {item.severity}{item.linkedCostId ? ` · ${item.linkedCostId}` : ''}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={!item.historyTarget.searchTerm || !onOpenHistorySearch}
                    onClick={() => onOpenHistorySearch?.(item.historyTarget.searchTerm, item.historyTarget.rowId)}
                    className="inline-flex items-center justify-center rounded-lg border border-blue-200 px-3 py-2 text-sm font-semibold text-blue-700 transition-colors hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-blue-800 dark:text-blue-300 dark:hover:bg-blue-900/20"
                  >
                    Przejdź do rekordu
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
      </DisclosureSection>
      )}

      {isExpertMode && (
      <section className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_380px]">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          <motion.article
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-2xl border border-blue-200 bg-blue-50 p-5 shadow-sm dark:border-blue-500/20 dark:bg-blue-500/10 md:col-span-2 xl:col-span-3"
          >
            <p className="text-xs font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300">Co zrobić teraz</p>
            <div className="mt-2 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <h3 className="text-lg font-bold text-blue-950 dark:text-blue-100">{readiness.recommendedAction.label}</h3>
                <p className="mt-1 text-sm text-blue-800 dark:text-blue-200">{readiness.recommendedAction.message}</p>
              </div>
              <button
                type="button"
                onClick={() => onNavigate(readiness.recommendedAction.targetView)}
                className="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-700"
              >
                {readiness.recommendedAction.label}
              </button>
            </div>
          </motion.article>
          {readiness.stages.map((stage) => (
            <motion.article
              key={stage.id}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-bold text-gray-950 dark:text-white">{stage.label}</h3>
                  <p className="mt-2 min-h-[40px] text-sm leading-5 text-gray-600 dark:text-gray-400">{stage.message}</p>
                </div>
                <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold ${stageStatusClasses[stage.status]}`}>
                  {stageIcon(stage.status)}
                  {stageStatusLabel[stage.status]}
                </span>
              </div>
              <div className="mt-5 flex items-center justify-between gap-3">
                <span className="text-sm text-gray-500 dark:text-gray-400">
                  Licznik: <strong className="text-gray-900 dark:text-white">{stage.count ?? 0}</strong>
                </span>
                <button
                  type="button"
                  onClick={() => onNavigate(stage.targetView)}
                  className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-700"
                >
                  {stage.primaryActionLabel}
                </button>
              </div>
            </motion.article>
          ))}
        </div>

        <aside className="space-y-4">
          <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-bold text-gray-950 dark:text-white">Co wymaga uwagi</h3>
              <span className="rounded-full bg-gray-100 px-2 py-1 text-xs font-semibold text-gray-700 dark:bg-gray-700 dark:text-gray-200">
                {readiness.attentionItems.length}
              </span>
            </div>
            {readiness.attentionItems.length === 0 ? (
              <p className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300">
                Brak spraw wymagających działania. Informacyjne logi techniczne są w ustawieniach systemowych.
              </p>
            ) : (
              <div className="mt-4 space-y-3">
                {primaryAttentionItem && !showAllAttentionItems && (
                  <button
                    type="button"
                    onClick={() => onNavigate(primaryAttentionItem.targetView)}
                    className="w-full rounded-xl border border-amber-200 bg-amber-50 p-3 text-left transition-colors hover:bg-amber-100 dark:border-amber-500/20 dark:bg-amber-500/10 dark:hover:bg-amber-500/20"
                  >
                    <p className="text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                      Najważniejsza akcja
                    </p>
                    <p className="mt-1 text-sm font-semibold text-amber-900 dark:text-amber-200">{primaryAttentionItem.label}</p>
                    <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">{primaryAttentionItem.message}</p>
                  </button>
                )}
                {attentionGroups.map((group) => (
                  <div key={group.id} className="rounded-xl border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900/70">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-semibold text-gray-950 dark:text-white">{group.label}</p>
                      <span className="rounded-full bg-white px-2 py-1 text-xs font-semibold text-gray-700 dark:bg-gray-800 dark:text-gray-200">
                        {group.items.length}
                      </span>
                    </div>
                    {group.items.length === 0 ? (
                      <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{group.emptyMessage}</p>
                    ) : !showAllAttentionItems ? (
                      <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                        {`${group.items.length} ${odmienLiczebnik(group.items.length, 'pozycja', 'pozycje', 'pozycji')} w szczegółach.`}
                      </p>
                    ) : (
                      <div className="mt-2 space-y-2">
                        {group.items.map((item) => (
                          <button
                            key={`${item.code}:${item.message}`}
                            type="button"
                            onClick={() => onNavigate(item.targetView)}
                            className="w-full rounded-lg border border-white bg-white p-2 text-left text-xs transition-colors hover:bg-blue-50 dark:border-gray-800 dark:bg-gray-800 dark:hover:bg-gray-700"
                          >
                            <p className="font-semibold text-gray-900 dark:text-white">{item.label}</p>
                            <p className="mt-1 text-gray-600 dark:text-gray-400">{item.message}</p>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                {readiness.attentionItems.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setShowAllAttentionItems((value) => !value)}
                    className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
                  >
                    {showAllAttentionItems
                      ? 'Pokaż tylko najważniejszą akcję'
                      : `Pokaż szczegóły (${readiness.attentionItems.length - 1})`}
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
            <h3 className="font-bold text-gray-950 dark:text-white">Źródła danych</h3>
            <p className="mt-3 text-sm text-gray-600 dark:text-gray-400">
              Aktywnym źródłem są lokalne pliki zaimportowane do pamięci aplikacji oraz ręczne korekty w warstwie override.
              Program nie pobiera danych online i nie uruchamia automatycznej synchronizacji.
            </p>
          </div>
        </aside>
      </section>
      )}
    </div>
  );
}
