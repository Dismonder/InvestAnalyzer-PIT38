import React from 'react';
import { odmienLiczebnik } from '../../portfel/services/odmianaLiczebnika';
import { motion, useReducedMotion } from 'motion/react';
import { AlertTriangle, ChevronDown, Download, FileSearch, Loader2, RefreshCw } from 'lucide-react';
import type { AggressiveCostDefenseEntry, DefenseActionItem, PitCaseFile, SourceReconciliationReport, TaxEngineResponse, TaxFilingPackageAuditAppendix, TaxFormField, TaxScenarioProjection } from '../hooks/useTaxEngineRun';
import type { DefenseEvidenceOverride } from '../services/defenseEvidenceOverrides';
import type { DefenseWorkbenchItem } from '../services/defenseWorkbench';
import type { BrokerFileActionOverride } from '../services/brokerFileActionOverrides';
import type { UiComplexityMode } from '../services/uiPreferences';
import {
  buildBrokerActionWorkbench,
  type BrokerActionWorkbench,
  type BrokerActionWorkbenchItem,
} from '../services/brokerActionWorkbench';
import {
  getBrowserTaxSettingsStorage,
  firstUnusedPriorLossYear,
  isPriorLossYearAvailable,
  readLegacyCryptoCosts,
  readPriorYearLossEntries,
  mergeAndSavePriorYearLossEntries,
  type PriorYearLossEntry,
  type TaxPackageRequestOptions,
} from '../services/taxEngineConfig';
import {
  buildHistoryNavigationTargetFromTrace,
  buildHistorySearchQueryFromTrace,
  buildTaxTraceViewModels,
  findTraceForLedgerLine,
  formatTraceAmount,
  getTraceKindLabel,
  getTraceRiskLabel,
} from '../services/taxTraceExplorer';
import { InsightDrawer, type OpenInsightDrawer } from './cockpit/CockpitUi';
import {
  TAX_REPORT_ORGANIZATION_LABELS,
  type TaxReportOrganizationState,
  type TaxReportOrganizationStatus,
} from '../services/reportOrganizationStatus';
import {
  downloadTaxEngineArtifact,
  getPackageScopeOptions,
  getTaxArtifactLabel,
  isDownloadableTaxArtifact,
  selectPrimaryPackageArtifact,
  type TaxPackageScope,
} from '../services/taxFilingPackage';
import {
  buildPitCaseFileBaselineStatus,
  buildPitCaseFileSummary,
  readPitCaseFileBaseline,
  writePitCaseFileBaseline,
} from '../services/pitCaseFile';
import {
  buildYearClosureStatus,
  closeTaxYear,
  readTaxYearClosure,
  reopenTaxYear,
  type TaxYearClosure,
  type TaxYearClosureStorage,
} from '../services/yearClosure';
import {
  buildTaxYearClosureAuditExport,
  downloadTaxYearClosureAuditExport,
} from '../services/yearClosureExport';
import { browserLocalStorage } from '../services/browserStorage';
import { getErrorMessage } from '../services/errorMessage';
import { buildResultTrustModel } from '../services/resultTrust';
import { buildRunAuditAppendix } from '../services/runAuditAppendix';
import { readReviewQueue } from '../services/reviewDecisions';
import { ReviewDecisionsPanel } from './ReviewDecisionsPanel';
import { KrajZrodlaPanel } from './KrajZrodlaPanel';
import { buildPitTrustViewModel } from '../services/pitTrustView';
import { useI18n } from '../services/i18n';

const DEFAULT_REOPEN_TAX_YEAR_NOTE = 'Aktualizacja danych, dowodów lub pakietu PIT.';
type SimpleReportInsight = 'calculation' | 'source' | 'evidence' | 'package';

interface YearlyReportProps {
  selectedYear: number;
  engineLoading: boolean;
  packageLoading: boolean;
  engineResult: TaxEngineResponse | null;
  engineStale?: boolean;
  canUseEngineResult?: boolean;
  runPythonEngine: (packageRequest?: string | TaxPackageRequestOptions, forceRecalculate?: boolean) => Promise<TaxEngineResponse | null>;
  reportOrganizationStatus: TaxReportOrganizationStatus;
  onReportOrganizationStatusChange: (status: TaxReportOrganizationState) => void;
  onOpenHistorySearch?: (query: string, focusRowId?: string | null) => void;
  onOpenCandidateTransactions?: (sourceId?: string | null) => void;
  onOpenStorageHistory?: () => void;
  defenseEvidenceOverrides?: DefenseEvidenceOverride[];
  defenseWorkbenchItems?: DefenseWorkbenchItem[];
  brokerFileActionOverrides?: BrokerFileActionOverride[];
  brokerActionWorkbench?: BrokerActionWorkbench;
  onOpenDefenseWorkbench?: () => void;
  onOpenImport?: () => void;
  uiComplexityMode?: UiComplexityMode;
  onOpenInsight?: OpenInsightDrawer;
  onRequestExpertMode?: () => void;
}

const formatPln = (value?: string) => {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) {
    return value || '—';
  }
  return new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' }).format(numeric);
};

const parseAmount = (value?: string | null) => {
  const numeric = Number(String(value ?? '0').replace(',', '.'));
  return Number.isFinite(numeric) ? numeric : 0;
};

const formatTaxFormFieldValue = (field: TaxFormField) => {
  if (field.manual_entry) {
    return 'Uzupełnij ręcznie';
  }
  const value = field.value ?? '';
  if (field.value_type === 'percent') {
    if (!value) {
      return '—';
    }
    return String(value).includes('%') ? String(value) : `${value}%`;
  }
  if (field.value_type === 'text') {
    return value || '—';
  }
  return formatPln(value);
};

const formatCaseFileDateTime = (value?: string | null) => {
  if (!value) {
    return '—';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat('pl-PL', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
};

const planLabel = (plan?: string) => {
  const mapping: Record<string, string> = {
    conservative: 'Konserwatywny',
    conservative_user: 'Konserwatywny',
    defensible: 'Zrównoważony',
    balanced_user: 'Zrównoważony',
    aggressive_user: 'Agresywny',
    aggressive: 'Agresywny',
  };
  return mapping[plan || ''] || (plan || 'Agresywny').replace(/_/g, ' ');
};

const riskLabel = (risk?: string) => {
  const mapping: Record<string, string> = {
    low: 'niski',
    medium: 'średni',
    high: 'wysoki',
  };
  return mapping[(risk || '').toLowerCase()] || risk || '—';
};

const statusLabel = (status?: string) => {
  const mapping: Record<string, string> = {
    SUCCESS: 'SUKCES',
    FAILED: 'BŁĄD',
    WARNING: 'OSTRZEŻENIE',
    ERROR: 'BŁĄD',
    CRITICAL: 'KRYTYCZNE',
    FILING_READY: 'GOTOWE DO ROZLICZENIA',
    NOT_FILING_READY: 'NIEGOTOWE',
  };
  return mapping[status || ''] || status || '—';
};

const brokerActionStatusLabel = (status?: string) => {
  const mapping: Record<string, string> = {
    open: 'Otwarte',
    resolved: 'Rozwiązane',
    ignored: 'Zignorowane',
  };
  return mapping[status || ''] || status || '—';
};

const brokerActionSeverityLabel = (severity?: string) => {
  const mapping: Record<string, string> = {
    blocking: 'Kontrola PIT',
    warning: 'Ostrzeżenie',
    info: 'Informacja',
  };
  return mapping[severity || ''] || severity || '—';
};

const brokerActionSeverityClass = (severity?: string, status?: string) => {
  if (status === 'resolved') {
    return 'border-emerald-200 bg-emerald-50 dark:border-emerald-900/50 dark:bg-emerald-950/20';
  }
  if (status === 'ignored') {
    return 'border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-900/40';
  }
  if (severity === 'blocking') {
    return 'border-red-200 bg-red-50 dark:border-red-900/50 dark:bg-red-950/20';
  }
  if (severity === 'warning') {
    return 'border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/20';
  }
  return 'border-blue-200 bg-blue-50 dark:border-blue-900/50 dark:bg-blue-950/20';
};

const sourceTypeLabel = (type?: string | null) => {
  const mapping: Record<string, string> = {
    local_broker_report_json: 'Raport brokera JSON',
    broker_report_json: 'Nowy raport brokera JSON',
    depositary_report_json: 'Raport depozytariusza JSON',
    legacy_broker_history_json: 'Stabilna historia JSON',
    local_broker_report_xml: 'Raport brokera XML',
    local_broker_history_json: 'Lokalna historia JSON',
    broker_transactions_xlsx: 'Transakcje brokera XLSX',
    cash_flows_xlsx: 'Ruchy gotówki XLSX',
    traders_xlsx: 'Analityka brokera XLSX',
    nbp_archive: 'Archiwum NBP',
    fee_schedule_pdf: 'Taryfa/prowizje PDF',
    broker_trades_excel: 'Transakcje brokera XLSX',
    broker_cashflow_excel: 'Cash flow brokera XLSX',
    local_csv: 'Plik CSV',
    unknown: 'Nierozpoznany plik',
  };
  return mapping[type || ''] || (type || 'Nieznany typ').replace(/_/g, ' ');
};

const noOverpayStatusLabel = (status?: string) => {
  const mapping: Record<string, string> = {
    liczone: 'Liczone',
    pominięte: 'Pominięte',
    do_dowodu: 'Do dowodu',
    do_decyzji: 'Do decyzji',
  };
  return mapping[status || ''] || status || '—';
};

const coverageStatusLabel = (status?: string) => {
  const mapping: Record<string, string> = {
    complete: 'kompletne',
    partial: 'częściowe',
    missing: 'brak',
    conflict: 'konflikt',
    not_applicable: 'nie dotyczy',
  };
  return mapping[status || ''] || status || '—';
};

const coverageStatusClass = (status?: string) => {
  if (status === 'complete') {
    return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200';
  }
  if (status === 'missing' || status === 'conflict') {
    return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-200';
  }
  if (status === 'partial') {
    return 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200';
  }
  return 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200';
};

const formatRecordCounts = (recordCounts?: Record<string, number>) => {
  const entries = Object.entries(recordCounts || {});
  if (entries.length === 0) {
    return '—';
  }
  return entries.map(([key, value]) => `${key}: ${value}`).join(' · ');
};

const sourceReconciliationBreakdownLabel = (report?: SourceReconciliationReport | null): string => {
  const totals = new Map<string, { label: string; count: number }>();
  for (const source of report?.comparedSources || []) {
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
};

const costTagLabel = (tag: string) => {
  const mapping: Record<string, string> = {
    NEGATIVE_BALANCE_INTEREST: 'Odsetki od salda ujemnego',
    INVESTMENT_INTEREST: 'Odsetki od salda ujemnego',
    NEGATIVE_CASH_INTEREST: 'Odsetki od salda ujemnego',
    ANNUAL_ADJUSTMENT: 'Korekta roczna',
    PRIVATE_CASH_FX_INVESTMENT_LOSS: 'Strata FX środków inwestycyjnych',
    BANK_FUNDING_FEE: 'Prowizja bankowa za zasilenie',
    FUNDING_TRANSFER_FEE: 'Prowizja za zasilenie',
    FX_CONVERSION_SPREAD_COST: 'Koszt spreadu przewalutowania',
    FX_CONVERSION_FEE: 'Opłata za przewalutowanie',
    TRADE_COMMISSION: 'Prowizja maklerska',
    TRADE_FEE: 'Prowizja maklerska',
    ALLOCATED_COST: 'Koszt alokowany',
    ACCOUNT_FEE: 'Opłata za rachunek',
    TRANSFER_FEE: 'Opłata transferowa',
    CUSTODY_FEE: 'Opłata depozytowa',
  };
  return mapping[tag] || tag.replace(/_/g, ' ').toLowerCase();
};

const defenseStatusLabel = (status?: string) => {
  const mapping: Record<string, string> = {
    complete: 'Kompletne',
    needs_user_evidence: 'Wymaga dowodu',
    missing_link: 'Brak powiązania',
    high_risk_review: 'Wysokie ryzyko',
  };
  return mapping[status || ''] || status || '—';
};

const defenseStatusSourceLabel = (source?: string) => {
  const mapping: Record<string, string> = {
    silnik: 'z silnika',
    local_override: 'potwierdzone lokalnie przez użytkownika',
    user_override: 'potwierdzone lokalnie przez użytkownika',
  };
  return mapping[source || ''] || source || 'z silnika';
};

const DeferredBrowserSection = ({
  children,
  fallbackLabel,
}: {
  children: React.ReactNode;
  fallbackLabel: string;
}) => {
  const shouldRenderImmediately = typeof window === 'undefined' || typeof document === 'undefined';
  const [isReady, setIsReady] = React.useState(shouldRenderImmediately);

  React.useEffect(() => {
    if (isReady) {
      return undefined;
    }
    const win = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    if (typeof win.requestIdleCallback === 'function') {
      const handle = win.requestIdleCallback(() => setIsReady(true), { timeout: 400 });
      return () => win.cancelIdleCallback?.(handle);
    }
    const handle = window.setTimeout(() => setIsReady(true), 80);
    return () => window.clearTimeout(handle);
  }, [isReady]);

  if (isReady) {
    return <>{children}</>;
  }

  return (
    <div className="ia-content-visibility rounded-lg border border-dashed border-gray-200 bg-white p-4 text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
      Ładowanie sekcji: {fallbackLabel}
    </div>
  );
};

const BrokerActionReportSection = React.memo(function BrokerActionReportSection({
  workbench,
  onOpenImport,
  onOpenHistorySearch,
}: {
  workbench: BrokerActionWorkbench;
  onOpenImport?: () => void;
  onOpenHistorySearch?: (query: string, focusRowId?: string | null) => void;
}) {
  if (workbench.total === 0) {
    return null;
  }

  const visibleItems: BrokerActionWorkbenchItem[] = [
    ...workbench.groups.blocking,
    ...workbench.groups.warning,
    ...workbench.groups.info,
    ...workbench.groups.resolved,
    ...workbench.groups.ignored,
  ].slice(0, 8);

  const openHistory = (item: BrokerActionWorkbenchItem) => {
    const query = item.historySearchTerm || item.linkedRowId || item.costIds[0] || item.sourceIds[0] || item.actionId;
    if (!query) {
      return;
    }
    onOpenHistorySearch?.(query, item.linkedRowId || null);
  };

  return (
    <div className="mt-4 rounded-lg border border-indigo-100 bg-indigo-50 p-3 dark:border-indigo-900/50 dark:bg-indigo-950/20">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-indigo-700 dark:text-indigo-300">Sprawy importu w pakiecie PIT</p>
          <h4 className="mt-1 font-bold text-gray-900 dark:text-white">{workbench.open} otwarte / {workbench.total} razem</h4>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            Te statusy są lokalnym workflow importu i audytu. Nie zmieniają ledgeru, scenariuszy ani kwot PIT.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
          <div className="rounded-md bg-white p-2 dark:bg-gray-900">
            <p className="text-xs text-slate-500 dark:text-slate-400">Kontrole PIT</p>
            <p className="font-bold text-gray-900 dark:text-white">{workbench.blockingOpen}</p>
          </div>
          <div className="rounded-md bg-white p-2 dark:bg-gray-900">
            <p className="text-xs text-slate-500 dark:text-slate-400">Ostrzeżenia</p>
            <p className="font-bold text-gray-900 dark:text-white">{workbench.warningOpen}</p>
          </div>
          <div className="rounded-md bg-white p-2 dark:bg-gray-900">
            <p className="text-xs text-slate-500 dark:text-slate-400">Rozwiązane</p>
            <p className="font-bold text-gray-900 dark:text-white">{workbench.resolved}</p>
          </div>
          <div className="rounded-md bg-white p-2 dark:bg-gray-900">
            <p className="text-xs text-slate-500 dark:text-slate-400">Zignorowane</p>
            <p className="font-bold text-gray-900 dark:text-white">{workbench.ignored}</p>
          </div>
        </div>
      </div>

      {workbench.recommendedItem && (
        <div className="mt-3 rounded-md border border-indigo-200 bg-white p-3 text-sm dark:border-indigo-900/60 dark:bg-gray-900">
          <p className="font-semibold text-gray-900 dark:text-white">Najważniejsza akcja: {workbench.recommendedItem.userAction}</p>
          <p className="mt-1 text-slate-600 dark:text-slate-300">{workbench.recommendedItem.label}</p>
        </div>
      )}

      <div className="mt-3 space-y-2">
        {visibleItems.map((item) => (
          <div key={item.actionId} className={`rounded-md border p-3 text-sm ${brokerActionSeverityClass(item.severity, item.status)}`}>
            <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-white px-2 py-1 text-xs font-semibold text-slate-700 dark:bg-gray-900 dark:text-slate-200">
                    {brokerActionStatusLabel(item.status)}
                  </span>
                  <span className="rounded-full bg-white px-2 py-1 text-xs font-semibold text-slate-700 dark:bg-gray-900 dark:text-slate-200">
                    {brokerActionSeverityLabel(item.severity)}
                  </span>
                  {item.costIds.length > 0 && <span className="text-xs text-slate-500 dark:text-slate-400">Koszty: {item.costIds.join(', ')}</span>}
                  {item.sourceIds.length > 0 && <span className="text-xs text-slate-500 dark:text-slate-400">Źródła: {item.sourceIds.join(', ')}</span>}
                </div>
                <p className="mt-2 font-semibold text-gray-900 dark:text-white">{item.label}</p>
                <p className="mt-1 text-slate-600 dark:text-slate-300">{item.userAction}</p>
                {item.supplementalOnlyBreakdownLabel && (
                  <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-300">
                    Typy rekordów tylko pomocniczych: {item.supplementalOnlyBreakdownLabel}
                  </p>
                )}
                {item.userNote && <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Notatka: {item.userNote}</p>}
              </div>
              <div className="flex flex-wrap gap-2">
                {onOpenImport && (
                  <button
                    type="button"
                    onClick={onOpenImport}
                    className="rounded-lg border border-indigo-200 bg-white px-3 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-50 dark:border-indigo-800 dark:bg-gray-900 dark:text-indigo-300"
                  >
                    Przejdź do importu
                  </button>
                )}
                {onOpenHistorySearch && (
                  <button
                    type="button"
                    onClick={() => openHistory(item)}
                    className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-gray-900 dark:text-slate-300"
                  >
                    Przejdź do historii
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
});

const TaxScenarioProjectionSummary = React.memo(function TaxScenarioProjectionSummary({
  projection,
}: {
  projection: TaxScenarioProjection;
}) {
  return (
    <div className="rounded-lg border border-indigo-200 bg-indigo-50/70 p-4 dark:border-indigo-800 dark:bg-indigo-900/20">
      <h5 className="font-semibold text-indigo-900 dark:text-indigo-200 mb-3">
        Wynik scenariusza {planLabel(projection.scenario_name)}
      </h5>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 text-sm">
        <div><span className="text-gray-500">Przychód</span><div className="font-semibold text-gray-900 dark:text-white">{formatPln(projection.revenue_pln)}</div></div>
        <div><span className="text-gray-500">Koszty</span><div className="font-semibold text-gray-900 dark:text-white">{formatPln(projection.cost_pln)}</div></div>
        <div><span className="text-gray-500">Dochód</span><div className="font-semibold text-gray-900 dark:text-white">{formatPln(projection.income_pln)}</div></div>
        <div><span className="text-gray-500">Podstawa po zaokrągleniu</span><div className="font-semibold text-gray-900 dark:text-white">{formatPln(projection.rounded_base_pln)}</div></div>
        <div><span className="text-gray-500">Podatek 19% liczony przez silnik</span><div className="font-semibold text-gray-900 dark:text-white">{formatPln(projection.silnik_tax_pln)}</div></div>
        <div><span className="text-gray-500">Podatek 19% od zaokrąglonej podstawy</span><div className="font-semibold text-gray-900 dark:text-white">{formatPln(projection.rounded_tax_from_base_pln)}</div></div>
        <div><span className="text-gray-500">Podatek należny po zaokrągleniu</span><div className="font-semibold text-gray-900 dark:text-white">{formatPln(projection.tax_due_pln)}</div></div>
        <div><span className="text-gray-500">Dywidenda zagraniczna brutto</span><div className="font-semibold text-gray-900 dark:text-white">{formatPln(projection.gross_dividend_pln)}</div></div>
        <div><span className="text-gray-500">Podatek 19% od dywidendy</span><div className="font-semibold text-gray-900 dark:text-white">{formatPln(projection.foreign_dividend_tax_pln)}</div></div>
        <div><span className="text-gray-500">Podatek zapłacony za granicą</span><div className="font-semibold text-gray-900 dark:text-white">{formatPln(projection.foreign_tax_credit_pln)}</div></div>
      </div>
    </div>
  );
});

const TaxFormFieldsTable = React.memo(function TaxFormFieldsTable({
  fields,
}: {
  fields: TaxFormField[];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 dark:border-gray-700 text-left">
            <th className="py-2 pr-3">Sekcja</th>
            <th className="py-2 pr-3">Poz.</th>
            <th className="py-2 pr-3">Nazwa</th>
            <th className="py-2 pr-3">Wartość</th>
            <th className="py-2">Uwagi</th>
          </tr>
        </thead>
        <tbody>
          {fields.map((field) => (
            <tr key={`${field.section}-${field.position}`} className="border-b border-gray-100 dark:border-gray-800 align-top">
              <td className="py-2 pr-3 font-medium text-gray-700 dark:text-gray-300">{field.section}</td>
              <td className="py-2 pr-3 font-mono text-gray-700 dark:text-gray-300">{field.position}</td>
              <td className="py-2 pr-3 text-gray-700 dark:text-gray-300">{field.label}</td>
              <td className="py-2 pr-3 font-semibold text-gray-900 dark:text-white">
                {formatTaxFormFieldValue(field)}
              </td>
              <td className="py-2 text-xs text-gray-500">{field.note || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});

const parseFinancingContext = (value?: string | null) => {
  if (!value) {
    return null;
  }
  const normalized = value.replace(/_/g, '-');
  const colonMatch = value.match(/negative_cash_balance:([A-Z]{3}):(\d{4}-\d{2}-\d{2})/i);
  const dashMatch = normalized.match(/saldo-ujemne-([A-Z]{3})-(\d{4}-\d{2}-\d{2})/i);
  const match = colonMatch || dashMatch;
  if (!match) {
    return null;
  }
  return {
    currency: match[1].toUpperCase(),
    date: match[2],
  };
};

const buildDefenseEntryContext = (entry: AggressiveCostDefenseEntry) => {
  const contextId = entry.linked_trade_id || entry.allocation_target || entry.source_id || entry.source_record_id || null;
  const financing = parseFinancingContext(contextId);
  const isFinancingCost = ['INVESTMENT_INTEREST', 'NEGATIVE_BALANCE_INTEREST'].includes((entry.kind || '').toUpperCase());

  if (financing || isFinancingCost) {
    const detailParts = [
      financing?.currency ? `waluta ${financing.currency}` : null,
      financing?.date ? `dzień ${financing.date}` : entry.tax_event_date ? `dzień ${entry.tax_event_date}` : null,
    ].filter(Boolean);
    return {
      title: 'Kontekst finansowania',
      id: contextId,
      detail: detailParts.length > 0
        ? detailParts.join(' · ')
        : 'saldo ujemne i finansowanie inwestycji wymagają opisu/dowodu',
      warning: !contextId,
    };
  }

  if (entry.linked_trade_id) {
    return {
      title: 'Transakcja inwestycyjna',
      id: entry.linked_trade_id,
      detail: `${entry.linked_trade_symbol || '—'} · ${entry.linked_trade_date || 'brak daty'}`,
      warning: false,
    };
  }

  return {
    title: 'Wymaga dopięcia',
    id: contextId,
    detail: 'silnik nie znalazł jednoznacznego kontekstu kosztu',
    warning: true,
  };
};

const defenseStatusClass = (status?: string) => {
  const mapping: Record<string, string> = {
    complete: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-900/20 dark:text-emerald-200',
    needs_user_evidence: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-900/20 dark:text-amber-200',
    missing_link: 'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-900/20 dark:text-red-200',
    high_risk_review: 'border-orange-200 bg-orange-50 text-orange-800 dark:border-orange-900 dark:bg-orange-900/20 dark:text-orange-200',
  };
  return mapping[status || ''] || mapping.needs_user_evidence;
};

const pitVerdictLabel = (verdict?: string) => {
  const mapping: Record<string, string> = {
    READY: 'Gotowe',
    READY_WITH_RISK: 'Gotowe z ryzykiem',
    NEEDS_EVIDENCE: 'Wymaga dowodów',
    BLOCKED: 'Do kontroli PIT',
  };
  return mapping[verdict || ''] || verdict || 'brak';
};

const pitVerdictClass = (verdict?: string) => {
  const mapping: Record<string, string> = {
    READY: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-900/20 dark:text-emerald-200',
    READY_WITH_RISK: 'border-orange-200 bg-orange-50 text-orange-800 dark:border-orange-900 dark:bg-orange-900/20 dark:text-orange-200',
    NEEDS_EVIDENCE: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-900/20 dark:text-amber-200',
    BLOCKED: 'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-900/20 dark:text-red-200',
  };
  return mapping[verdict || ''] || mapping.NEEDS_EVIDENCE;
};

const pitSeverityLabel = (severity?: string) => {
  const mapping: Record<string, string> = {
    blocking: 'kontrola PIT',
    evidence: 'dowód',
    risk: 'ryzyko',
    info: 'info',
  };
  return mapping[severity || ''] || severity || 'info';
};

const pitCategoryLabel = (category?: string) => {
  const mapping: Record<string, string> = {
    nbp: 'NBP',
    dane_quality: 'jakość danych',
    defense: 'obrona kosztu',
    calculation: 'kalkulacja',
    reconciliation: 'rekonsyliacja',
  };
  return mapping[category || ''] || category || 'inne';
};

const allocationModeLabel = (mode?: string) => {
  const mapping: Record<string, string> = {
    proportional_first_batch: 'proporcjonalnie do pierwszego batcha',
    first_trade_only: 'tylko pierwsza transakcja',
    full_deposit_batch: 'cały batch zasilenia',
    account_level_year_cost: 'koszt roczny rachunku',
  };
  return mapping[mode || ''] || mode || 'brak';
};

function readPitCaseBaselineFromStorage(year: number): PitCaseFile | null {
  try {
    return readPitCaseFileBaseline(browserLocalStorage, year);
  } catch {
    return null;
  }
}

function writePitCaseBaselineToStorage(caseFile: PitCaseFile): boolean {
  try {
    return writePitCaseFileBaseline(browserLocalStorage, caseFile);
  } catch {
    return false;
  }
}

function readTaxYearClosureFromStorage(year: number): TaxYearClosure | null {
  try {
    return readTaxYearClosure(browserLocalStorage, year);
  } catch {
    return null;
  }
}

function closeTaxYearInStorage(caseFile: PitCaseFile): TaxYearClosure | null {
  return closeTaxYear(browserLocalStorage as TaxYearClosureStorage, caseFile, {
    decisionNote: 'Rok zamknięty lokalnie po sprawdzeniu pakietu PIT.',
  });
}

function reopenTaxYearInStorage(year: number, note: string): TaxYearClosure | null {
  return reopenTaxYear(browserLocalStorage as TaxYearClosureStorage, year, note);
}

const issueStageLabel = (stage?: string) => {
  const mapping: Record<string, string> = {
    QUALITY: 'Jakość danych',
    RECONCILE: 'Rekonsyliacja',
    ENGINE: 'Silnik',
    FX: 'Kursy walut',
    FIFO: 'FIFO',
    EXPORT: 'Eksport',
  };
  return mapping[stage || ''] || stage || '—';
};

const issueScopeLabel = (scope?: string) => {
  const mapping: Record<string, string> = {
    silnik: 'silnik',
    broker_xml: 'XML brokera',
    depo_json: 'DePo',
    aggressive_user: 'plan agresywny',
  };
  return mapping[scope || ''] || scope || '—';
};

export function YearlyReport({
  selectedYear,
  engineLoading,
  packageLoading,
  engineResult,
  engineStale = false,
  canUseEngineResult = true,
  runPythonEngine,
  reportOrganizationStatus,
  onReportOrganizationStatusChange,
  onOpenHistorySearch,
  onOpenCandidateTransactions,
  onOpenStorageHistory,
  defenseEvidenceOverrides = [],
  defenseWorkbenchItems = [],
  brokerFileActionOverrides = [],
  brokerActionWorkbench: brokerActionWorkbenchProp,
  onOpenDefenseWorkbench,
  onOpenImport,
  uiComplexityMode = 'simple',
  onOpenInsight,
  onRequestExpertMode,
}: YearlyReportProps) {
  const { language, t, formatMoney } = useI18n();
  const isExpertMode = uiComplexityMode === 'expert';
  const prefersReducedMotion = Boolean(useReducedMotion());
  const simpleMotionInitial = prefersReducedMotion ? false : { opacity: 0, y: 14 };
  const simpleMotionTransition = (delay = 0) => (
    prefersReducedMotion ? { duration: 0 } : { duration: 0.28, delay }
  );
  const simpleHoverLift = prefersReducedMotion ? undefined : { y: -2 };
  const simpleTapPress = prefersReducedMotion ? undefined : { scale: 0.99 };
  const [selectedPackageScope, setSelectedPackageScope] = React.useState<TaxPackageScope>('full');
  const [selectedFilingMode, setSelectedFilingMode] = React.useState<'ORIGINAL' | 'CORRECTION'>('ORIGINAL');
  const [selectedProjectionPlan, setSelectedProjectionPlan] = React.useState<'conservative' | 'defensible' | 'aggressive_user'>('aggressive_user');
  const [packageDownloadError, setPackageDownloadError] = React.useState<string | null>(null);
  const [auditExpanded, setAuditExpanded] = React.useState(false);
  const [issueExpanded, setIssueExpanded] = React.useState(false);
  const [calculationExpanded, setCalculationExpanded] = React.useState(false);
  const [simpleInsightDrawer, setSimpleInsightDrawer] = React.useState<SimpleReportInsight | null>(null);
  const [selectedTraceId, setSelectedTraceId] = React.useState<string | null>(null);
  const [reopenTaxYearNote, setReopenTaxYearNote] = React.useState(DEFAULT_REOPEN_TAX_YEAR_NOTE);
  const [pitCaseFileBaseline, setPitCaseFileBaseline] = React.useState<PitCaseFile | null>(
    () => readPitCaseBaselineFromStorage(selectedYear),
  );
  const [taxYearClosure, setTaxYearClosure] = React.useState<TaxYearClosure | null>(
    () => readTaxYearClosureFromStorage(selectedYear),
  );
  const [taxYearClosureError, setTaxYearClosureError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setPitCaseFileBaseline(readPitCaseBaselineFromStorage(selectedYear));
    setTaxYearClosure(readTaxYearClosureFromStorage(selectedYear));
  }, [selectedYear]);

  // Raport pokazuje wynik silnika, a nie lokalna kopie transakcji w przegladarce.
  // Wczesniej bramka sprawdzala te kopie, ktorej po przebudowie nic juz nie
  // zapisuje - raport nie pojawial sie nigdy, mimo policzonego wyniku.
  if (!engineLoading && !engineResult) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center">
        <h2 className="text-2xl font-semibold text-gray-800 dark:text-gray-200 mb-2">{t('report.noDataTitle')}</h2>
        <p className="text-gray-500 dark:text-gray-400">{t('report.noDataDescription')}</p>
      </div>
    );
  }

  const summary = engineResult?.annual_summary || {};
  const scenarios = Object.values(engineResult?.scenario_results || {});
  const activeScenario = (
    engineResult?.scenario_results?.[engineResult.primary_scenario || ''] ||
    engineResult?.scenario_results?.[engineResult.plan_used || ''] ||
    engineResult?.scenario_results?.aggressive_user ||
    scenarios[0]
  );
  const historyRows = engineResult?.transaction_history_rows || [];
  const investmentBuyRows = historyRows.filter((row) => (
    row.row_kind === 'TRADE' &&
    row.side === 'BUY' &&
    row.logical_world === 'equity_tax' &&
    row.tax_impact_kind === 'PIT_COUNTED'
  ));
  const investmentSellRows = historyRows.filter((row) => (
    row.row_kind === 'TRADE' &&
    row.side === 'SELL' &&
    row.logical_world === 'equity_tax' &&
    row.tax_impact_kind === 'PIT_COUNTED'
  ));
  const scenarioRevenueAndTaxBaseIsZero = scenarios.length > 0 && scenarios.every((scenario) => (
    Math.abs(parseAmount(scenario.total_revenue_pln)) < 0.005 &&
    Math.abs(parseAmount(scenario.total_cost_pln)) < 0.005 &&
    Math.abs(parseAmount(scenario.taxable_base_pln)) < 0.005 &&
    Math.abs(parseAmount(scenario.tax_19_pln)) < 0.005
  ));
  const showBuyOnlyTaxExplanation = investmentBuyRows.length > 0 && investmentSellRows.length === 0 && scenarioRevenueAndTaxBaseIsZero;
  const issues = engineResult?.actionable_issues || [];
  const blokadyRozliczenia = issues.filter((issue) => issue.blocking);
  // Symbole sprzedaży bez państwa źródła (blokada PIT/ZG) - kraj można wpisać od razu w panelu.
  const symboleBezKraju = [...new Set(blokadyRozliczenia
    .filter((issue) => issue.code === 'PIT_ZG_COUNTRY_UNKNOWN')
    .flatMap((issue) => (Array.isArray(issue.details?.symbols) ? issue.details.symbols : []) as string[]))];
  const exportedFiles = engineResult?.exported_files || [];
  const filingReady = canUseEngineResult && engineResult?.filing_ready === true;
  const pendingDecisionIssue = issues.find((issue) => issue.code === 'RECORDS_AWAITING_USER_DECISION')
    || engineResult?.issues?.find((issue) => issue.code === 'RECORDS_AWAITING_USER_DECISION');
  const pendingDecisionCount = Number(pendingDecisionIssue?.details?.blocking_count || 0);
  const reviewQueue = React.useMemo(() => readReviewQueue(engineResult), [engineResult]);
  const qualityMetrics = engineResult?.quality_report?.metrics || {};
  const coverageGaps = engineResult?.fx_coverage_gaps || [];
  const depoRows = engineResult?.depo_reconciliation || [];
  const [priorLosses, setPriorLosses] = React.useState<PriorYearLossEntry[]>(() =>
    readPriorYearLossEntries(getBrowserTaxSettingsStorage()),
  );
  const priorLossesBase = React.useRef<PriorYearLossEntry[]>(priorLosses);

  const persistPriorLosses = React.useCallback((entries: PriorYearLossEntry[]) => {
    const closure = readTaxYearClosureFromStorage(selectedYear);
    if (closure?.status === 'closed' || closure?.status === 'submitted') return;
    const merged = mergeAndSavePriorYearLossEntries(getBrowserTaxSettingsStorage(), priorLossesBase.current, entries);
    priorLossesBase.current = merged;
    setPriorLosses(merged);
  }, [selectedYear]);

  const financingLedger = engineResult?.financing_ledger;
  const financingEpisodes = financingLedger?.episodes || [];
  const fundingFeeAllocations = engineResult?.funding_fee_allocations || [];
  const packageDraft = engineResult?.tax_filing_package?.draft;
  // Ten sam zalacznik audytu, z ktorego korzysta reszta warsztatu: zwykly
  // przebieg niesie rejestr zrodel i historie magazynu, wiec je pokazujemy.
  const auditAppendix = React.useMemo<TaxFilingPackageAuditAppendix | null>(
    () => buildRunAuditAppendix(engineResult),
    [engineResult],
  );
  const pitCaseFile = auditAppendix?.pit_case_file || null;
  const pitCaseFileSummary = buildPitCaseFileSummary(auditAppendix);
  const pitCaseFileBaselineStatus = buildPitCaseFileBaselineStatus(pitCaseFile, pitCaseFileBaseline);
  const taxYearClosureStatus = buildYearClosureStatus(pitCaseFile, taxYearClosure);
  const isYearClosureReadOnly = taxYearClosureStatus.isReadOnly;
  const priorLossesReadOnly = taxYearClosure?.status === 'closed' || taxYearClosure?.status === 'submitted';
  const legacyCryptoCost = readLegacyCryptoCosts(getBrowserTaxSettingsStorage());
  const nextPriorLossYear = firstUnusedPriorLossYear(priorLosses, selectedYear);
  const yearClosureReadOnlyMessage = 'Otwórz rok ponownie, aby przeliczyć raport albo wygenerować nowy pakiet.';
  const defenseReadiness = auditAppendix?.defense_readiness;
  const aggressiveDefenseEntries = auditAppendix?.aggressive_cost_defense || [];
  const defenseEvidenceGroups = auditAppendix?.defense_evidence_groups || [];
  const defenseEvidenceLinks = auditAppendix?.defense_evidence_links || [];
  const taxCalculationLedger = auditAppendix?.tax_calculation_ledger;
  const taxCalculationLedgerRows = taxCalculationLedger?.rows || [];
  const resultDeltaReport = auditAppendix?.result_delta_report;
  const resultDeltaRows = resultDeltaReport?.rows || [];
  const defenseGapSummary = auditAppendix?.defense_gap_summary;
  const pitSubmissionReadiness = auditAppendix?.pit_submission_readiness;
  const pitSubmissionChecklist = pitSubmissionReadiness?.checklist || [];
  const pitSubmissionCounts: Record<string, number> = pitSubmissionReadiness?.counts || {};
  const sourceManifestV2 = auditAppendix?.source_manifest_v2 || [];
  const sourceReconciliationReport = auditAppendix?.source_reconciliation_report || null;
  const importIntelligenceReport = auditAppendix?.import_intelligence_report || null;
  const noOverpayAudit = auditAppendix?.no_overpay_audit || null;
  const defenseCaseFile = auditAppendix?.defense_case_file || null;
  const brokerFileControlTower = auditAppendix?.broker_file_control_tower || null;
  const coverageMatrix = auditAppendix?.coverage_matrix || [];
  const noOverpayAuditV2 = auditAppendix?.no_overpay_audit_v2 || null;
  const defenseCaseFileV2 = auditAppendix?.defense_case_file_v2 || null;
  const legalBasisRegistry = auditAppendix?.legal_basis_registry || [];
  const sourceReconciliationBreakdown = sourceReconciliationBreakdownLabel(sourceReconciliationReport);
  const resultTrust = React.useMemo(
    () => buildResultTrustModel(engineResult, auditAppendix, engineLoading),
    [auditAppendix, engineLoading, engineResult],
  );
  const inputPreviewRowCount = auditAppendix?.candidate_transaction_preview_rows?.length || 0;
  const canonicalStorageSummary = auditAppendix?.canonical_storage_history_summary || {};
  const canonicalStorageRowCount = auditAppendix?.canonical_storage_history_rows?.length || 0;
  const canonicalRawRowCount = typeof canonicalStorageSummary.rawRowCount === 'number'
    ? canonicalStorageSummary.rawRowCount
    : canonicalStorageRowCount;
  const canonicalDeduplicatedRowCount = typeof canonicalStorageSummary.deduplicatedRowCount === 'number'
    ? canonicalStorageSummary.deduplicatedRowCount
    : canonicalStorageRowCount;
  const pitTrustView = React.useMemo(
    () => buildPitTrustViewModel(auditAppendix),
    [auditAppendix],
  );
  const formatTrustStatus = (status: typeof pitTrustView.overallStatus, missingLabel = t('pitTrust.blocked')) => {
    if (status === 'ok') return t('pitTrust.ok');
    if (status === 'blocked') return missingLabel;
    return t('pitTrust.review');
  };
  /** Licznik z audytu albo myslnik - `null` znaczy "audyt tego nie podal". */
  const licznikAudytu = (wartosc: number | null): string => (wartosc === null ? '—' : String(wartosc));
  const pitTrustSourceSummary = t('pitTrust.sourceSummary', {
    active: licznikAudytu(pitTrustView.activeSourceCount),
    candidates: licznikAudytu(pitTrustView.candidateSourceCount),
    files: licznikAudytu(pitTrustView.recognizedFileCount),
  });
  const pitTrustEvidenceSummary = t('pitTrust.evidenceSummary', {
    available: pitTrustView.defenseAvailableCount,
    toCollect: pitTrustView.defenseToCollectCount,
    advisorReview: pitTrustView.defenseAdvisorReviewCount,
  });
  const pitTrustPackageSummary = pitTrustView.advisorPackReady ? t('pitTrust.packageReady') : t('pitTrust.packagePending');
  const sourceTrustItems = auditAppendix?.source_trust_summary?.items || [];
  const sourceTrustGroups = React.useMemo(() => {
    const groupDefinitions = [
      { id: 'active', title: 'Źródła transakcyjne', statuses: ['transaction_source'], empty: 'Brak rozpoznanych źródeł transakcyjnych.' },
      { id: 'candidate', title: 'Raporty do scalenia', statuses: ['transaction_report'], empty: 'Brak raportów do scalenia.' },
      { id: 'evidence', title: 'Dowody i kontekst', statuses: ['source_evidence'], empty: 'Brak plików dowodowych w audycie.' },
      { id: 'nbp', title: t('import.nbp'), statuses: ['nbp_rates'], empty: 'Brak osobnych plików NBP w mapie źródeł.' },
      { id: 'reconciliation', title: t('import.positionControl'), statuses: ['position_reconciliation'], empty: 'Brak plików kontroli pozycji.' },
      { id: 'fallback', title: 'Techniczne / pozostałe', statuses: ['data_context', 'duplicate_source', 'technical_source', 'source_review', 'fallback_source', 'ignored_no_impact', 'needs_review_source'], empty: 'Brak pozostałych plików.' },
    ];
    return groupDefinitions.map((group) => ({
      ...group,
      items: sourceTrustItems.filter((item) => group.statuses.includes(String(item.usage_status))),
    }));
  }, [sourceTrustItems, t]);
  const noOverpayV3Summary = auditAppendix?.no_overpay_audit_v3?.summary || {};
  const noOverpayV3Sections = auditAppendix?.no_overpay_audit_v3?.sections || [];
  const noOverpayV3DecisionCounts = React.useMemo(() => {
    const counts: Record<string, number> = {};
    for (const section of noOverpayV3Sections) {
      for (const item of section.items || []) {
        counts[item.decision] = (counts[item.decision] || 0) + 1;
      }
    }
    return counts;
  }, [noOverpayV3Sections]);
  const defenseVaultItems = auditAppendix?.defense_vault_summary?.items || [];
  const defenseVaultTopItems = defenseVaultItems
    .filter((item) => ['missing', 'to_collect', 'partial', 'advisor_review'].includes(String(item.status || '')))
    .slice(0, 5);
  const simpleReportStatus = (() => {
    const blockingCount = pitSubmissionChecklist.filter((item) => item.severity === 'blocking').length + Number(qualityMetrics.blocking_count || 0);
    const evidenceCount = pitSubmissionChecklist.filter((item) => item.severity === 'evidence').length;
    const sourceLabel = resultTrust.status !== 'ok'
      ? resultTrust.label
      : 'Canonical input zbudowany z lokalnych źródeł';
    return {
      sourceLabel,
      blockingLabel: blockingCount > 0 ? `${blockingCount} ${odmienLiczebnik(blockingCount, 'kontrola', 'kontrole', 'kontroli')} PIT` : 'Brak kontroli PIT',
      evidenceLabel: evidenceCount > 0 ? `Pozostały dowody: ${evidenceCount}` : 'Dowody bez braków',
    };
  })();
  const brokerActionWorkbench = React.useMemo(
    () => brokerActionWorkbenchProp || buildBrokerActionWorkbench(auditAppendix, brokerFileActionOverrides),
    [auditAppendix, brokerActionWorkbenchProp, brokerFileActionOverrides],
  );
  const noOverpaySummary = noOverpayAudit?.summary || {};
  const noOverpayCandidateCosts = noOverpayAudit?.candidateCosts || [];
  const noOverpayV2CandidateCosts = noOverpayAuditV2?.candidateCosts || noOverpayCandidateCosts;
  const potentiallyMissedCosts = noOverpayAuditV2?.potentiallyMissedCosts || [];
  const noOverpayExcludedCosts = noOverpayAudit?.excludedCosts || [];
  const noOverpayDuplicateRisks = noOverpayAudit?.duplicateRisks || [];
  const noOverpayTechnicalRows = noOverpayAudit?.technicalRows || [];
  const noOverpayMissingEvidence = noOverpayAudit?.missingEvidence || [];
  const defenseChainsV2 = defenseCaseFileV2?.defenseChains || [];
  const canonicalInputSources = sourceManifestV2.filter((source) => (
    source.contributesToCanonicalInput ?? source.contributesToTax
  ));
  const sourceIssueCount = sourceManifestV2.reduce(
    (sum, source) => sum + (source.warnings?.length || 0) + (source.errors?.length || 0),
    0,
  );
  const sourceRecommendedActions = Array.from(new Set([
    ...(brokerFileControlTower?.recommendedActions || []),
    ...(importIntelligenceReport?.recommendedActions || []),
    ...(noOverpayAuditV2?.recommendedActions || []),
    ...(noOverpayAudit?.recommendedActions || []),
    ...(defenseCaseFileV2?.recommendedActions || []),
    ...(defenseCaseFile?.recommendedActions || []),
  ].filter(Boolean)));
  const taxTraceViewModels = buildTaxTraceViewModels(auditAppendix);
  const selectedTrace = taxTraceViewModels.find((trace) => trace.entry.trace_id === selectedTraceId) || null;
  const selectedTraceEvidenceIds = new Set(selectedTrace?.entry.evidence_ids || []);
  const selectedTraceWorkbenchItems = selectedTrace
    ? defenseWorkbenchItems.filter((item) => (
        (item.traceId && item.traceId === selectedTrace.entry.trace_id) ||
        (item.evidenceId ? selectedTraceEvidenceIds.has(item.evidenceId) : false) ||
        (item.checklistId ? selectedTrace.entry.checklist_item_ids.includes(item.checklistId) : false)
      ))
    : [];
  const selectedTraceOverrides = selectedTrace
    ? defenseEvidenceOverrides.filter((override) => selectedTraceEvidenceIds.has(override.evidenceId))
    : [];
  const selectedTraceConfirmedCount = selectedTraceWorkbenchItems.filter((item) => item.evidenceConfirmed).length
    + selectedTraceOverrides.filter((override) => override.evidenceConfirmed || override.defenseStatus === 'complete').length;
  const selectedTraceNotes = [
    ...selectedTraceWorkbenchItems.map((item) => item.localNote),
    ...selectedTraceOverrides.map((override) => override.userNote || ''),
  ].filter(Boolean);
  const defenseActionItems: DefenseActionItem[] =
    defenseReadiness?.actionItems && defenseReadiness.actionItems.length > 0
      ? defenseReadiness.actionItems
      : defenseEvidenceLinks
          .filter((link) => link.defenseStatus !== 'complete')
          .map((link) => ({
            costId: link.costId,
            amountPln: link.amountPln,
            sourceRecordId: link.sourceRecordId,
            defenseStatus: link.defenseStatus,
            riskLevel: link.riskLevel,
            userActionLabel: link.userActionLabel,
            missingEvidence: link.missingEvidence,
          }));
  const calculationSections = (engineResult?.tax_filing_package?.calculation?.sections || []) as Array<{
    title?: string;
    values?: Record<string, unknown>;
    explanation?: string;
  }>;
  const taxBreakdownSection = calculationSections.find((section) => section.title === 'Jak policzono podatek');
  const taxBreakdownValues = (taxBreakdownSection?.values || {}) as Record<string, unknown>;
  const taxBreakdownRows: Array<{ label: string; value: unknown; lineId: string }> = [
    { label: 'Przychód PIT-38', value: taxBreakdownValues.revenue_pln, lineId: 'REVENUE_TOTAL' },
    { label: 'Koszty PIT-38', value: taxBreakdownValues.cost_pln, lineId: 'COST_TOTAL' },
    { label: 'Dochód / strata', value: taxBreakdownValues.income_pln, lineId: 'TAXABLE_BASE' },
    { label: 'Koszty aggressive_user', value: taxBreakdownValues.aggressive_costs_pln, lineId: 'AGGRESSIVE_COST_TOTAL' },
    { label: 'Straty z lat ubiegłych', value: taxBreakdownValues.prior_year_losses_pln, lineId: 'PRIOR_YEAR_LOSSES_USED' },
    { label: 'Podatki z danych', value: taxBreakdownValues.taxes_from_dane_pln, lineId: 'TAXES_FROM_DATA' },
    { label: 'Podatek 19%', value: taxBreakdownValues.tax_19_pln, lineId: 'TAX_19' },
  ];
  const visibleDefenseEntries = aggressiveDefenseEntries.slice(0, 8);
  const visibleDefenseGroups = defenseEvidenceGroups.slice(0, 8);
  const scenarioProjections = packageDraft?.scenario_projections || {};
  const selectedScenarioProjection = scenarioProjections[selectedProjectionPlan] || scenarioProjections.aggressive_user;
  const formFields = selectedScenarioProjection?.form_fields || packageDraft?.form_fields || [];
  const activeFormFields = packageDraft?.form_fields || scenarioProjections[activeScenario?.scenario_name || '']?.form_fields || [];
  const formValue = (position: string) => activeFormFields.find((field) => field.position === position)?.value ?? null;
  const packageScopeOptions = getPackageScopeOptions();
  const downloadableArtifacts = exportedFiles.filter(isDownloadableTaxArtifact);
  const packageButtonLabel = pitCaseFileBaselineStatus.status === 'CHANGED'
    ? 'Wygeneruj nowy pakiet podatkowy'
    : t('report.generatePackage');
  // Brak kwoty z silnika to nie jest zero. Dopoki scenariusz sie nie policzyl,
  // kafelki pokazywaly "0,00 zl" obok paska postepu "Silnik PIT liczy wynik" -
  // czyli pewnosc, ze nie ma czego placic, w trakcie liczenia.
  // Poz. 26 i 27 PIT-38 maja grosze (TKwota2Nieujemna w schemacie). Pola
  // pit38_rounded_* to kwoty w pelnych zlotych: kafelek pokazywal
  // "11 170 938,00 zl", a zakladka PIT-38 dla tego samego przebiegu 11 170 937,84.
  const bankRevenuePln = formValue('26') ?? summary.pit38_form_revenue_pln
    ?? summary.pit38_rounded_revenue_pln ?? activeScenario?.total_revenue_pln ?? null;
  const bankCostPln = formValue('27') ?? summary.pit38_form_cost_pln
    ?? summary.pit38_rounded_cost_pln ?? activeScenario?.total_cost_pln ?? null;
  const bankBasePln = formValue('31') ?? summary.pit38_form_base_pln ?? null;
  const bankTaxPln = formValue('51') ?? summary.pit38_form_total_tax_to_pay_pln ?? null;
  const bankNetPln = summary.net_pln ?? activeScenario?.net_pln ?? null;
  /** Kwota z silnika albo myslnik - nigdy podstawione zero. */
  const kwotaAlboBrak = (wartosc: unknown): string =>
    wartosc === null || wartosc === undefined ? '—' : formatMoney(String(wartosc));
  const pelneZloteZFormularza = (wartosc: unknown): string => {
    if (wartosc === null || wartosc === undefined) return '—';
    const kwota = Number(wartosc);
    return Number.isInteger(kwota) ? `${kwota.toLocaleString('pl-PL')} zł` : kwotaAlboBrak(wartosc);
  };
  const bankNetNumeric = parseAmount(String(bankNetPln));
  const bankNetTone = bankNetNumeric >= 0
    ? 'text-emerald-700 dark:text-emerald-300'
    : 'text-rose-700 dark:text-rose-300';
  const bankStatus = (() => {
    if (!filingReady || engineResult?.status === 'FAILED') {
      return {
        label: t('report.blocked'),
        description: 'Najpierw sprawdź dane albo otwartą kontrolę PIT z przebiegu.',
        badgeClassName: 'bg-red-50 text-red-700 ring-red-200 dark:bg-red-950/40 dark:text-red-200 dark:ring-red-900/60',
        actionLabel: 'Sprawdź kontrolę PIT',
        insight: 'calculation' as SimpleReportInsight,
      };
    }
    if (resultTrust.status === 'blocked') {
      return {
        label: t('report.blocked'),
        description: resultTrust.summary,
        badgeClassName: 'bg-red-50 text-red-700 ring-red-200 dark:bg-red-950/40 dark:text-red-200 dark:ring-red-900/60',
        actionLabel: 'Sprawdź źródła',
        insight: 'source' as SimpleReportInsight,
      };
    }
    if (resultTrust.status === 'needs_review') {
      return {
        label: t('report.daneReviewRequired'),
        description: resultTrust.summary,
        badgeClassName: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900/60',
        actionLabel: 'Sprawdź źródła',
        insight: 'source' as SimpleReportInsight,
      };
    }
    if (
      pitSubmissionReadiness?.verdict === 'NEEDS_EVIDENCE' ||
      pitSubmissionReadiness?.verdict === 'READY_WITH_RISK' ||
      Number(pitSubmissionCounts.evidence || 0) > 0 ||
      Number(pitSubmissionCounts.risk || 0) > 0
    ) {
      return {
        label: t('report.keepEvidence'),
        description: 'Raport jest policzony. Zachowaj wskazane dowody do obrony rozliczenia.',
        badgeClassName: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900/60',
        actionLabel: t('report.keepEvidence'),
        insight: 'evidence' as SimpleReportInsight,
      };
    }
    return {
      label: t('report.ready'),
      description: 'Brak otwartych kontroli podatkowych w aktualnym przebiegu.',
      badgeClassName: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-200 dark:ring-emerald-900/60',
      actionLabel: t('report.generatePackageShort'),
      insight: 'package' as SimpleReportInsight,
    };
  })();
  const buildCalculationInsightSections = (): Array<{ title: string; content: React.ReactNode }> => [
    {
      title: t('drawer.whatItMeans'),
      content: 'Poz. 31 i 51 pochodzą z projekcji formularza silnika. Netto scenariusza uwzględnia także podatki z danych wejściowych.',
    },
    {
      title: t('drawer.pitImpact'),
      content: (
        <div className="space-y-3">
          <div className="rounded-xl border border-blue-100 bg-blue-50 p-3 text-sm text-blue-950 dark:border-blue-900/60 dark:bg-blue-950/20 dark:text-blue-100">
            <p className="font-semibold">Prosta formuła</p>
            <p className="mt-1">Dochód przed stratami to poz. 28, podstawa po odliczeniu strat i zaokrągleniu to poz. 31. Kwota do zapłaty pochodzi z poz. 51. Netto scenariusza dodatkowo odejmuje podatki z danych.</p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {(taxBreakdownSection ? taxBreakdownRows : [
              { label: t('report.revenue'), value: bankRevenuePln },
              { label: t('report.costs'), value: bankCostPln },
              { label: `${t('report.taxBase')} (poz. 31)`, value: bankBasePln },
              { label: t('report.pitTaxToPay'), value: bankTaxPln },
              { label: t('report.scenarioNet'), value: bankNetPln },
            ]).map((row) => (
              <div key={row.label} className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
                <p className="text-xs text-gray-500">{row.label}</p>
                <p className="mt-1 font-semibold text-gray-900 dark:text-white">{row.value === null || row.value === undefined ? '—' : formatPln(String(row.value))}</p>
              </div>
            ))}
          </div>
        </div>
      ),
    },
    {
      title: t('drawer.whatToDo'),
      // Przycisk "Sprawdź kontrolę PIT" prowadzi tutaj - panel musi powiedzieć,
      // CO blokuje, a nie tylko odesłać do kontroli, których w trybie prostym nie widać.
      content: filingReady
        ? 'Jeśli chcesz pełną ścieżkę źródeł, przełącz tryb eksperta albo wygeneruj pakiet podatkowy.'
        : blokadyRozliczenia.length > 0
          ? (
            <div>
              <ul className="list-disc space-y-1 pl-5" data-testid="blokady-rozliczenia">
                {blokadyRozliczenia.slice(0, 6).map((issue, index) => (
                  <li key={`${issue.code}-${index}`}>{issue.message}</li>
                ))}
              </ul>
              <KrajZrodlaPanel
                symbols={symboleBezKraju}
                records={engineResult?.editable_records || []}
                disabled={engineLoading || packageLoading || isYearClosureReadOnly}
                onRecalculate={() => { runPythonEngine(); }}
              />
            </div>
          )
          : 'Sprawdź kontrole danych albo przelicz raport po poprawieniu importu.',
    },
    {
      title: t('drawer.sourcesDetails'),
      content: 'Pełny rozkład kwot, źródła, ścieżki audytu i techniczne identyfikatory są dostępne w trybie eksperta oraz w pakiecie podatkowym.',
    },
  ];
  const buildSimpleDrawerActions = (insight: SimpleReportInsight) => {
    const actions = [];
    if (insight === 'package') {
      actions.push({
        label: packageLoading ? t('report.generating') : t('report.generatePackageShort'),
        variant: 'primary' as const,
        disabled: engineLoading || packageLoading || isYearClosureReadOnly,
        title: isYearClosureReadOnly ? yearClosureReadOnlyMessage : undefined,
        onClick: () => {
          handleGeneratePackage();
        },
      });
    } else if (insight === 'calculation' || insight === 'evidence') {
      actions.push({
        label: t('nav.transactionHistory'),
        variant: 'primary' as const,
        onClick: () => {
          onOpenHistorySearch?.('');
        },
      });
    } else if (insight === 'source' && onOpenImport) {
      actions.push({
        label: t('report.sources'),
        variant: 'primary' as const,
        onClick: () => {
          onRequestExpertMode?.();
          onOpenImport();
        },
      });
      if (onOpenStorageHistory) {
        actions.push({
          label: t('history.showFullStorage'),
          variant: 'secondary' as const,
          onClick: () => {
            onOpenStorageHistory();
          },
        });
      }
    }
    actions.push({
      label: t('header.expertMode'),
      variant: 'secondary' as const,
      onClick: () => {
        onRequestExpertMode?.();
      },
    });
    actions.push({ label: t('app.cancel'), variant: 'secondary' as const });
    return actions;
  };
  const renderSourceComparisonSummary = () => {
    return (
      <div className="space-y-3">
        <div className="rounded-xl border border-blue-100 bg-blue-50 p-3 text-sm text-blue-950 dark:border-blue-900/60 dark:bg-blue-950/20 dark:text-blue-100">
          <p className="font-semibold">Mapa źródeł</p>
          <p className="mt-1">{pitTrustSourceSummary}</p>
          <p className="mt-1">
            {t('pitTrust.storageSmoke')}: {formatTrustStatus(pitTrustView.storageSmokeStatus)}.
            {' '}{t('pitTrust.nbp')}: {formatTrustStatus(pitTrustView.nbpStatus, t('pitTrust.missingRate'))}.
          </p>
        </div>
        <p>
          Wszystkie rozpoznane pliki są scalane do jednego strumienia `canonical_tax_input.json`. Raport nie wybiera
          już osobnego baseline ani kandydata źródła; diagnostyka pokazuje kompletność rekordów i źródła danych.
        </p>
      </div>
    );
  };
  const buildSimpleReportInsight = (insight: SimpleReportInsight) => {
    if (insight === 'calculation') {
      return {
        type: 'calculation' as const,
        title: t('report.calculationTitle'),
        subtitle: 'Skrót kwot z silnika. Pełny audyt pozostaje w trybie eksperta.',
        sections: buildCalculationInsightSections(),
        actions: buildSimpleDrawerActions(insight),
      };
    }
    if (insight === 'source') {
      return {
        type: 'source' as const,
        title: t('report.daneSources'),
        subtitle: 'Canonical input i źródła lokalnych rekordów.',
        actions: buildSimpleDrawerActions(insight),
        sections: [
          { title: t('drawer.whatItMeans'), content: `${resultTrust.label}. ${resultTrust.summary}` },
          {
            title: t('drawer.pitImpact'),
            content: resultTrust.activeTaxSources.length > 0
              ? `Rekordy wejściowe pochodzą z: ${resultTrust.activeTaxSources.slice(0, 8).join(', ')}.`
              : canonicalInputSources.length > 0
                ? `Canonical input korzysta z: ${canonicalInputSources
                  .slice(0, 8)
                  .map((source) => source.filename || source.relativePath || source.sourceId)
                  .join(', ')}.`
                : 'Brak listy źródeł w bieżącym audycie.',
          },
          {
            title: t('drawer.whatToDo'),
            content: resultTrust.status === 'ok'
              ? `Canonical input jest zbudowany. Podgląd nowych rekordów: ${inputPreviewRowCount}.`
              : resultTrust.recommendedAction,
          },
          {
            title: t('drawer.sourcesDetails'),
            content: (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                  {[
                    ['Źródła transakcji', pitTrustView.activeSourceCount],
                    ['Raporty do scalenia', pitTrustView.candidateSourceCount],
                    ['Dowody', pitTrustView.evidenceSourceCount],
                    ['Do diagnostyki', pitTrustView.blockedSourceCount],
                  ].map(([label, value]) => (
                    <div key={String(label)} className="rounded-lg border border-gray-200 bg-white p-2 dark:border-gray-700 dark:bg-gray-900">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{label}</p>
                      <p className="mt-1 text-base font-bold text-gray-950 dark:text-white">
                        {typeof value === 'number' ? value : '—'}
                      </p>
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2" data-testid="source-trust-map-groups">
                  {sourceTrustGroups.map((group) => (
                    <div key={group.id} className="rounded-xl border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400">{group.title}</p>
                        <span className="rounded-full bg-gray-50 px-2 py-0.5 text-[11px] font-semibold text-gray-700 ring-1 ring-gray-200 dark:bg-gray-800 dark:text-gray-200 dark:ring-gray-700">
                          {group.items.length}
                        </span>
                      </div>
                      {group.items.length > 0 ? (
                        <div className="mt-2 space-y-1">
                          {group.items.slice(0, 4).map((item) => (
                            <div key={item.source_id} className="space-y-1 text-xs">
                              <div className="flex items-start justify-between gap-2">
                                <span className="min-w-0 truncate font-semibold text-gray-900 dark:text-white">{item.file_name}</span>
                                <span className="shrink-0 text-gray-500 dark:text-gray-400">
                                  {item.quality?.parse_ok === false ? 'diagnostyka pliku' : item.warnings?.[0] || item.detected_role}
                                </span>
                              </div>
                              {item.usage_status === 'transaction_report' && onOpenCandidateTransactions ? (
                                <button
                                  type="button"
                                  onClick={() => onOpenCandidateTransactions(item.source_id)}
                                  className="rounded-lg bg-indigo-50 px-2 py-1 text-[11px] font-semibold text-indigo-700 ring-1 ring-indigo-100 transition hover:bg-indigo-100 dark:bg-indigo-950/30 dark:text-indigo-200 dark:ring-indigo-900/60"
                                >
                                  Pokaż transakcje z tego pliku
                                </button>
                              ) : null}
                            </div>
                          ))}
                          {group.items.length > 4 ? (
                            <p className="text-[11px] text-gray-500 dark:text-gray-400">+{group.items.length - 4} więcej w trybie eksperta.</p>
                          ) : null}
                        </div>
                      ) : (
                        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{group.empty}</p>
                      )}
                    </div>
                  ))}
                </div>
                <p>Rozpoznane pliki w storage: {resultTrust.recognizedFileCount}. Pełny inwentarz plików i dowody są dostępne w trybie eksperta.</p>
                {renderSourceComparisonSummary()}
              </div>
            ),
          },
        ],
      };
    }
    if (insight === 'evidence') {
      return {
        type: 'evidence' as const,
        title: t('report.evidence'),
        subtitle: 'Dowody i ryzyka nie zmieniają kwoty automatycznie.',
        actions: buildSimpleDrawerActions(insight),
        sections: [
          { title: t('drawer.whatItMeans'), content: simpleReportStatus.evidenceLabel },
          {
            title: t('drawer.pitImpact'),
            content: 'Dowody służą do obrony kosztu w razie kontroli. Ich lokalne potwierdzenie nie zmienia matematyki PIT.',
          },
          {
            title: t('drawer.whatToDo'),
            content: (
              <div className="space-y-2">
                <p>
                  {defenseActionItems.length > 0
                    ? defenseActionItems.slice(0, 6).map((item) => `${item.costId}: ${item.userActionLabel}`).join(' · ')
                    : 'Brak aktywnych braków dowodowych w skrócie raportu.'}
                </p>
                <p className="text-xs text-gray-600 dark:text-gray-300">{pitTrustEvidenceSummary}</p>
                {auditAppendix?.defense_vault_summary?.summary ? (
                  <p className="text-xs text-gray-600 dark:text-gray-300">
                    Defense Vault: dostępne {Number(auditAppendix.defense_vault_summary.summary.available || 0)}, do zebrania {Number(auditAppendix.defense_vault_summary.summary.to_collect || 0)}, do doradcy {Number(auditAppendix.defense_vault_summary.summary.advisor_review || 0)}.
                  </p>
                ) : null}
              </div>
            ),
          },
          {
            title: t('drawer.sourcesDetails'),
            content: (
              <div className="space-y-2">
                <p>Pełna obrona kosztów i lista dowodów są dostępne w trybie eksperta.</p>
                <p className="text-xs text-gray-600 dark:text-gray-300">
                  Liczone koszty: {pitTrustView.noOverpayCountedPln} PLN. Kandydaci: {pitTrustView.noOverpayCandidatePln} PLN.
                  Wymaga dowodu: {pitTrustView.noOverpayRequiresEvidencePln} PLN.
                </p>
                <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
                  {[
                    [t('noOverpay.counted'), noOverpayV3DecisionCounts.counted || 0],
                    [t('noOverpay.candidate'), noOverpayV3DecisionCounts.candidate || 0],
                    [t('noOverpay.requiresEvidence'), noOverpayV3DecisionCounts.requires_evidence || 0],
                    ['Duplikaty', noOverpayV3DecisionCounts.duplicate_risk || 0],
                    ['Wyłączone', noOverpayV3DecisionCounts.excluded_by_policy || 0],
                  ].map(([label, value]) => (
                    <div key={String(label)} className="rounded-lg border border-gray-200 bg-white p-2 dark:border-gray-700 dark:bg-gray-900">
                      <p className="text-[11px] font-semibold text-gray-500 dark:text-gray-400">{label}</p>
                      <p className="mt-1 font-bold text-gray-950 dark:text-white">{value}</p>
                    </div>
                  ))}
                </div>
                {defenseVaultTopItems.length > 0 ? (
                  <div className="space-y-1 text-xs">
                    <p className="font-semibold text-gray-900 dark:text-white">Najbliższe dowody do sprawdzenia:</p>
                    {defenseVaultTopItems.map((item) => (
                      <p key={item.evidence_id} className="text-gray-600 dark:text-gray-300">
                        {item.title} · {item.status || 'do sprawdzenia'}
                      </p>
                    ))}
                  </div>
                ) : null}
                {auditAppendix?.no_overpay_audit_v3?.summary ? (
                  <p className="text-xs text-gray-600 dark:text-gray-300">
                    No Overpay Guard: liczone {String(auditAppendix.no_overpay_audit_v3.summary.counted_total_pln || '0')} PLN,
                    kandydaci {String(auditAppendix.no_overpay_audit_v3.summary.candidate_total_pln || '0')} PLN,
                    wymaga dowodu {String(auditAppendix.no_overpay_audit_v3.summary.requires_evidence_total_pln || '0')} PLN.
                  </p>
                ) : null}
              </div>
            ),
          },
        ],
      };
    }
    return {
      type: 'technical' as const,
      title: t('report.package'),
      subtitle: 'Eksport plików do zachowania i przepisania.',
      actions: buildSimpleDrawerActions(insight),
      sections: [
        { title: t('drawer.whatItMeans'), content: pitCaseFileBaselineStatus.label },
        { title: t('drawer.pitImpact'), content: 'Wygenerowanie pakietu nie zmienia obliczeń. Zapisuje wynik, źródła i checklistę do plików.' },
        { title: t('drawer.whatToDo'), content: `${packageButtonLabel}. ${pitTrustPackageSummary}` },
        {
          title: t('drawer.sourcesDetails'),
          content: (
            <div className="space-y-2">
              <p>Pakiet zawiera workbook, JSON, brief dla doradcy i pliki audytowe generowane przez silnik Python.</p>
              <p className="text-xs text-gray-600 dark:text-gray-300">
                {t('pitTrust.resultHealth')}: {formatTrustStatus(pitTrustView.resultHealthStatus)}.
                {' '}{t('pitTrust.storageSmoke')}: {formatTrustStatus(pitTrustView.storageSmokeStatus)}.
                {' '}{t('pitTrust.nbp')}: {formatTrustStatus(pitTrustView.nbpStatus, t('pitTrust.missingRate'))}.
              </p>
            </div>
          ),
        },
      ],
    };
  };
  const openSimpleReportInsight = (insight: SimpleReportInsight) => {
    const drawer = buildSimpleReportInsight(insight);
    if (onOpenInsight) {
      onOpenInsight(drawer);
      return;
    }
    setSimpleInsightDrawer(insight);
  };
  const simpleReportSteps = [
    {
      id: 'result',
      label: t('report.result'),
      status: filingReady ? 'Gotowe' : engineLoading ? 'Liczenie' : 'Sprawdź',
      count: filingReady ? 0 : 1,
      actionLabel: t('report.calculationTitle'),
      description: bankRevenuePln === null || bankCostPln === null
        ? 'Przychód i koszty pojawią się po przebiegu silnika'
        : `${formatPln(String(bankRevenuePln))} przychodu · ${formatPln(String(bankCostPln))} kosztów`,
      insight: 'calculation' as SimpleReportInsight,
    },
    {
      id: 'sources',
      label: t('report.sources'),
      status: resultTrust.status === 'ok'
        ? 'OK'
        : resultTrust.status === 'blocked'
          ? 'Kontrola PIT'
          : 'Kontrola',
      count: resultTrust.status === 'ok' ? sourceIssueCount : Math.max(1, resultTrust.reasons.length),
      actionLabel: t('report.daneSources'),
      description: resultTrust.status === 'ok' ? simpleReportStatus.sourceLabel : resultTrust.summary,
      insight: 'source' as SimpleReportInsight,
    },
    {
      id: 'evidence',
      label: t('report.evidence'),
      status: simpleReportStatus.evidenceLabel,
      count: Number(pitSubmissionCounts.evidence || 0) + Number(pitSubmissionCounts.risk || 0),
      actionLabel: t('report.evidence'),
      description: pitSubmissionCounts.evidence ? `${pitSubmissionCounts.evidence} ${odmienLiczebnik(pitSubmissionCounts.evidence, 'pozycja', 'pozycje', 'pozycji')} do zachowania` : 'Brak aktywnych braków',
      insight: 'evidence' as SimpleReportInsight,
    },
    {
      id: 'package',
      label: t('report.package'),
      status: pitCaseFileBaselineStatus.status === 'MATCH' ? 'Gotowy' : 'Do pobrania',
      count: downloadableArtifacts.length,
      actionLabel: t('report.package'),
      description: packageButtonLabel,
      insight: 'package' as SimpleReportInsight,
    },
  ];
  const localSimpleDrawer = simpleInsightDrawer ? buildSimpleReportInsight(simpleInsightDrawer) : null;

  const handleCloseTaxYear = () => {
    if (!canUseEngineResult || !pitCaseFile) {
      setTaxYearClosureError('Wynik NIEAKTUALNY — przelicz ponownie przed zamknięciem roku.');
      return;
    }
    if (!filingReady) {
      setTaxYearClosureError('Rok można zamknąć dopiero przy zielonej gotowości rozliczenia.');
      return;
    }
    setTaxYearClosureError(null);
    const closure = closeTaxYearInStorage(pitCaseFile);
    if (closure) {
      setTaxYearClosure(closure);
    } else {
      setTaxYearClosureError('Nie udało się zapisać zamknięcia roku. Spróbuj ponownie.');
    }
  };

  const handleReopenTaxYear = () => {
    setTaxYearClosureError(null);
    const note = reopenTaxYearNote.trim() || 'Rok otwarty ponownie do pracy.';
    const closure = reopenTaxYearInStorage(selectedYear, note);
    if (closure) {
      setTaxYearClosure(closure);
      setReopenTaxYearNote(DEFAULT_REOPEN_TAX_YEAR_NOTE);
    } else {
      setTaxYearClosureError('Nie udało się zapisać ponownego otwarcia roku. Spróbuj ponownie.');
    }
  };

  const handleDownloadYearClosureAudit = () => {
    if (!taxYearClosure || !canUseEngineResult) {
      return;
    }
    downloadTaxYearClosureAuditExport(
      buildTaxYearClosureAuditExport({
        closure: taxYearClosure,
        currentCaseFile: pitCaseFile,
        status: taxYearClosureStatus,
      }),
    );
  };

  const handleGeneratePackage = async () => {
    setPackageDownloadError(null);
    if (!canUseEngineResult) {
      setPackageDownloadError('Wynik NIEAKTUALNY — przelicz ponownie przed eksportem.');
      return;
    }
    if (!filingReady) {
      setPackageDownloadError(
        pendingDecisionCount > 0
          ? `Pakiet jest zablokowany: ${pendingDecisionCount} ${odmienLiczebnik(pendingDecisionCount, 'nierozstrzygnięte zdarzenie może', 'nierozstrzygnięte zdarzenia mogą', 'nierozstrzygniętych zdarzeń może')} zmienić PIT. Rozstrzygnij je na liście „Co wymaga decyzji” w tym raporcie.`
          : 'Pakiet jest zablokowany, dopóki raport nie będzie gotowy do rozliczenia.',
      );
      return;
    }
    if (isYearClosureReadOnly) {
      setPackageDownloadError(yearClosureReadOnlyMessage);
      return;
    }
    try {
      const response = await runPythonEngine({
        packageScope: selectedPackageScope,
        filingMode: selectedFilingMode,
      });
      if (!response || response.success === false || response.status === 'FAILED') {
        setPackageDownloadError('Pakiet nie powstał. Popraw dane i przelicz ponownie.');
        return;
      }
      const generatedCaseFile = response.tax_filing_package?.audit_appendix?.pit_case_file;
      if (generatedCaseFile && writePitCaseBaselineToStorage(generatedCaseFile)) {
        setPitCaseFileBaseline(generatedCaseFile);
      }
      const preferredArtifact = selectPrimaryPackageArtifact(response?.exported_files || [], selectedPackageScope);
      if (preferredArtifact) {
        await downloadTaxEngineArtifact(preferredArtifact);
        onReportOrganizationStatusChange('downloaded');
      }
    } catch (error: unknown) {
      setPackageDownloadError(getErrorMessage(error, 'Nie udało się pobrać wygenerowanego pakietu.'));
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <motion.h1
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          className="text-2xl font-bold text-gray-900 dark:text-white"
        >
          {t('report.title', { year: selectedYear })}
        </motion.h1>

        {isExpertMode && (
        <div className="flex flex-wrap gap-2">
            <button
              onClick={() => {
                if (isYearClosureReadOnly) {
                  setPackageDownloadError(yearClosureReadOnlyMessage);
                  return;
                }
                runPythonEngine(undefined, true);
              }}
              disabled={engineLoading || packageLoading || isYearClosureReadOnly}
              title={isYearClosureReadOnly ? yearClosureReadOnlyMessage : undefined}
              className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 shadow-sm disabled:bg-indigo-400"
            >
              {engineLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              Przelicz raport w Python
            </button>
            <button
              onClick={handleGeneratePackage}
                disabled={engineLoading || packageLoading || isYearClosureReadOnly || !filingReady || !canUseEngineResult}
              title={isYearClosureReadOnly ? yearClosureReadOnlyMessage : !filingReady ? 'Pakiet wymaga najpierw zielonej gotowości rozliczenia.' : undefined}
              className="bg-emerald-700 hover:bg-emerald-800 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 shadow-sm disabled:bg-emerald-400"
            >
              {packageLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              {packageButtonLabel}
            </button>
        </div>
        )}
      </div>

      {isExpertMode && isYearClosureReadOnly && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800 shadow-sm dark:border-emerald-800/50 dark:bg-emerald-900/20 dark:text-emerald-200">
          <p className="font-semibold">Rok zamknięty - raport jest chroniony przed zmianą</p>
          <p className="mt-1">{yearClosureReadOnlyMessage}</p>
        </div>
      )}

      {!isExpertMode && (
        <motion.section
          data-motion="bank-report-shell"
          initial={simpleMotionInitial}
          animate={{ opacity: 1, y: 0 }}
          transition={simpleMotionTransition()}
          className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800"
        >
          <motion.div
            initial={simpleMotionInitial}
            animate={{ opacity: 1, y: 0 }}
            transition={simpleMotionTransition(0.03)}
            className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide ring-1 ${bankStatus.badgeClassName}`}>
                {bankStatus.label}
              </span>
              <span className="text-sm text-gray-600 dark:text-gray-300">{bankStatus.description}</span>
            </div>
            <motion.button
              type="button"
              onClick={() => {
                if (bankStatus.insight === 'package' && filingReady) {
                  handleGeneratePackage();
                  return;
                }
                openSimpleReportInsight(bankStatus.insight);
              }}
                disabled={bankStatus.insight === 'package' && (engineLoading || packageLoading || isYearClosureReadOnly || !filingReady || !canUseEngineResult)}
              title={bankStatus.insight === 'package' && isYearClosureReadOnly ? yearClosureReadOnlyMessage : bankStatus.insight === 'package' && !filingReady ? 'Pakiet wymaga najpierw zielonej gotowości rozliczenia.' : undefined}
              whileHover={simpleHoverLift}
              whileTap={simpleTapPress}
              className="inline-flex items-center justify-center rounded-xl bg-emerald-700 px-4 py-2 text-sm font-bold text-white shadow-sm transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-emerald-400"
            >
              {packageLoading && bankStatus.insight === 'package' ? t('report.generating') : bankStatus.actionLabel}
            </motion.button>
          </motion.div>

          {reviewQueue.length > 0 && (
            <div className="mb-4">
              <ReviewDecisionsPanel
                queue={reviewQueue}
                selectedYear={selectedYear}
                disabled={engineLoading || packageLoading || isYearClosureReadOnly}
                onRecalculate={() => { runPythonEngine(); }}
                onOpenHistorySearch={onOpenHistorySearch}
              />
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <motion.button
              type="button"
              data-motion="bank-primary-card"
              onClick={() => openSimpleReportInsight('calculation')}
              initial={simpleMotionInitial}
              animate={{ opacity: 1, y: 0 }}
              transition={simpleMotionTransition(0.07)}
              whileHover={simpleHoverLift}
              whileTap={simpleTapPress}
              className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-left transition hover:border-emerald-300 hover:bg-emerald-100/60 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:hover:bg-emerald-950/50"
            >
              <p className="text-xs font-bold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">{t('report.pitTaxToPay')}</p>
              <p className="mt-3 text-4xl font-black tracking-tight text-emerald-900 dark:text-emerald-100">{pelneZloteZFormularza(bankTaxPln)}</p>
              <p className="mt-3 text-sm text-emerald-800/80 dark:text-emerald-200/80">{t('report.taxToPayDescription')}</p>
            </motion.button>

            <motion.button
              type="button"
              data-motion="bank-secondary-card"
              onClick={() => openSimpleReportInsight('calculation')}
              initial={simpleMotionInitial}
              animate={{ opacity: 1, y: 0 }}
              transition={simpleMotionTransition(0.11)}
              whileHover={simpleHoverLift}
              whileTap={simpleTapPress}
              className="rounded-2xl border border-gray-200 bg-gray-50 p-5 text-left transition hover:border-blue-200 hover:bg-blue-50 dark:border-gray-700 dark:bg-gray-900/70 dark:hover:border-blue-900 dark:hover:bg-blue-950/20"
            >
              <p className="text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400">{t('report.scenarioNet')}</p>
              <p className={`mt-3 text-4xl font-black tracking-tight ${bankNetTone}`}>{kwotaAlboBrak(bankNetPln)}</p>
              <p className="mt-3 text-sm text-gray-600 dark:text-gray-300">Wynik ekonomiczny po kosztach scenariusza, podatku scenariusza i podatkach z danych.</p>
            </motion.button>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <motion.div
              data-motion="bank-metric-card"
              initial={simpleMotionInitial}
              animate={{ opacity: 1, y: 0 }}
              transition={simpleMotionTransition(0.14)}
              className="rounded-xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/70"
            >
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{t('report.revenue')}</p>
              <p className="mt-2 text-xl font-bold text-gray-950 dark:text-white">{kwotaAlboBrak(bankRevenuePln)}</p>
            </motion.div>
            <motion.div
              data-motion="bank-metric-card"
              initial={simpleMotionInitial}
              animate={{ opacity: 1, y: 0 }}
              transition={simpleMotionTransition(0.17)}
              className="rounded-xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/70"
            >
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{t('report.costs')}</p>
              <p className="mt-2 text-xl font-bold text-gray-950 dark:text-white">{kwotaAlboBrak(bankCostPln)}</p>
            </motion.div>
            <motion.button
              type="button"
              data-motion="bank-metric-card"
              onClick={() => openSimpleReportInsight('calculation')}
              initial={simpleMotionInitial}
              animate={{ opacity: 1, y: 0 }}
              transition={simpleMotionTransition(0.2)}
              whileHover={simpleHoverLift}
              whileTap={simpleTapPress}
              className="rounded-xl border border-gray-200 bg-gray-50 p-4 text-left transition hover:border-blue-200 hover:bg-blue-50 dark:border-gray-700 dark:bg-gray-900/70 dark:hover:border-blue-900 dark:hover:bg-blue-950/20"
            >
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{t('report.taxBase')} (poz. 31)</p>
              <p className="mt-2 text-xl font-bold text-gray-950 dark:text-white">{pelneZloteZFormularza(bankBasePln)}</p>
            </motion.button>
          </div>

          <motion.div
            initial={simpleMotionInitial}
            animate={{ opacity: 1, y: 0 }}
            transition={simpleMotionTransition(0.23)}
            className="mt-4 flex flex-wrap gap-2 text-xs font-semibold"
          >
            <span className="rounded-full bg-gray-50 px-3 py-1 text-gray-700 ring-1 ring-gray-200 dark:bg-gray-900 dark:text-gray-200 dark:ring-gray-700">{simpleReportStatus.sourceLabel}</span>
            <span className="rounded-full bg-gray-50 px-3 py-1 text-gray-700 ring-1 ring-gray-200 dark:bg-gray-900 dark:text-gray-200 dark:ring-gray-700">{simpleReportStatus.blockingLabel}</span>
            <span className="rounded-full bg-gray-50 px-3 py-1 text-gray-700 ring-1 ring-gray-200 dark:bg-gray-900 dark:text-gray-200 dark:ring-gray-700">{simpleReportStatus.evidenceLabel}</span>
          </motion.div>

          <motion.button
            type="button"
            data-motion="result-trust-card"
            onClick={() => openSimpleReportInsight('source')}
            initial={simpleMotionInitial}
            animate={{ opacity: 1, y: 0 }}
            transition={simpleMotionTransition(0.25)}
            whileHover={simpleHoverLift}
            whileTap={simpleTapPress}
            className="mt-4 flex w-full flex-col gap-2 rounded-xl border border-blue-100 bg-blue-50/70 p-4 text-left text-sm transition hover:border-blue-200 hover:bg-blue-50 dark:border-blue-900/50 dark:bg-blue-950/20 dark:hover:bg-blue-950/30 sm:flex-row sm:items-center sm:justify-between"
          >
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-blue-700 dark:text-blue-300">{t('report.daneTrustQuestion')}</p>
              <p className="mt-1 font-semibold text-blue-950 dark:text-blue-100">{resultTrust.label}</p>
              <p className="mt-1 text-blue-900/75 dark:text-blue-200/75">{resultTrust.summary}</p>
              <div className="mt-3 flex flex-wrap gap-2 text-[11px] font-semibold">
                <span className="rounded-full bg-white px-2.5 py-1 text-blue-800 ring-1 ring-blue-100 dark:bg-blue-950/40 dark:text-blue-100 dark:ring-blue-900">
                  Źródła transakcji: {licznikAudytu(pitTrustView.activeSourceCount)}
                </span>
                <span className="rounded-full bg-white px-2.5 py-1 text-blue-800 ring-1 ring-blue-100 dark:bg-blue-950/40 dark:text-blue-100 dark:ring-blue-900">
                  Raporty do scalenia: {licznikAudytu(pitTrustView.candidateSourceCount)}
                </span>
                <span className="rounded-full bg-white px-2.5 py-1 text-blue-800 ring-1 ring-blue-100 dark:bg-blue-950/40 dark:text-blue-100 dark:ring-blue-900">
                  {language === 'en' ? 'Input preview' : 'Podgląd wejścia'}: {inputPreviewRowCount}
                </span>
                <span className="rounded-full bg-white px-2.5 py-1 text-blue-800 ring-1 ring-blue-100 dark:bg-blue-950/40 dark:text-blue-100 dark:ring-blue-900">
                  {t('history.storageRows')}: {canonicalStorageRowCount}
                </span>
                <span className="rounded-full bg-white px-2.5 py-1 text-blue-800 ring-1 ring-blue-100 dark:bg-blue-950/40 dark:text-blue-100 dark:ring-blue-900">
                  {t('history.deduplicatedRows')}: {canonicalDeduplicatedRowCount}
                </span>
                <span className="rounded-full bg-white px-2.5 py-1 text-blue-800 ring-1 ring-blue-100 dark:bg-blue-950/40 dark:text-blue-100 dark:ring-blue-900">
                  {t('pitTrust.nbp')}: {formatTrustStatus(pitTrustView.nbpStatus, t('pitTrust.missingRate'))}
                </span>
              </div>
            </div>
            <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
              <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-blue-700 ring-1 ring-blue-100 dark:bg-blue-950/40 dark:text-blue-200 dark:ring-blue-900">
                {t('report.recognizedFiles', {
                  count: resultTrust.recognizedFileCount,
                  rozpoznanePl: odmienLiczebnik(resultTrust.recognizedFileCount, 'rozpoznany plik', 'rozpoznane pliki', 'rozpoznanych plików'),
                  filesEn: resultTrust.recognizedFileCount === 1 ? 'file' : 'files',
                })}
              </span>
              {onOpenStorageHistory ? (
                <span className="rounded-full bg-blue-600 px-3 py-1 text-xs font-semibold text-white shadow-sm">
                  {t('history.rawRows')}: {canonicalRawRowCount}
                </span>
              ) : null}
            </div>
          </motion.button>

          <motion.div
            data-motion="no-overpay-defense-card"
            initial={simpleMotionInitial}
            animate={{ opacity: 1, y: 0 }}
            transition={simpleMotionTransition(0.255)}
            className="mt-4 grid gap-3 lg:grid-cols-2"
          >
            <button
              type="button"
              onClick={() => openSimpleReportInsight('evidence')}
              className="rounded-xl border border-amber-100 bg-amber-50/80 p-4 text-left transition hover:border-amber-200 hover:bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/20 dark:hover:bg-amber-950/30"
            >
              <p className="text-xs font-bold uppercase tracking-wide text-amber-700 dark:text-amber-300">{t('noOverpay.title')}</p>
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                {[
                  [t('noOverpay.counted'), noOverpayV3Summary.counted_total_pln ?? pitTrustView.noOverpayCountedPln],
                  [t('noOverpay.candidate'), noOverpayV3Summary.candidate_total_pln ?? pitTrustView.noOverpayCandidatePln],
                  [t('noOverpay.requiresEvidence'), noOverpayV3Summary.requires_evidence_total_pln ?? pitTrustView.noOverpayRequiresEvidencePln],
                  ['Duplikaty / wyłączone', `${noOverpayV3Summary.duplicate_risk_total_pln ?? '0'} / ${noOverpayV3Summary.excluded_total_pln ?? '0'}`],
                ].map(([label, value]) => (
                  <div key={String(label)} className="rounded-lg bg-white px-3 py-2 ring-1 ring-amber-100 dark:bg-gray-900 dark:ring-amber-900/60">
                    <p className="text-[11px] font-semibold text-gray-500 dark:text-gray-400">{label}</p>
                    <p className="mt-1 font-bold text-gray-950 dark:text-white">{String(value)} PLN</p>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-xs text-amber-800 dark:text-amber-200">
                Kandydaci i pozycje wymagające dowodu nie zmieniają wyniku automatycznie.
              </p>
            </button>

            <button
              type="button"
              onClick={() => openSimpleReportInsight('evidence')}
              className="rounded-xl border border-blue-100 bg-blue-50/80 p-4 text-left transition hover:border-blue-200 hover:bg-blue-50 dark:border-blue-900/50 dark:bg-blue-950/20 dark:hover:bg-blue-950/30"
            >
              <p className="text-xs font-bold uppercase tracking-wide text-blue-700 dark:text-blue-300">{t('defenseVault.title')}</p>
              <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold">
                <span className="rounded-full bg-white px-2.5 py-1 text-blue-800 ring-1 ring-blue-100 dark:bg-blue-950/40 dark:text-blue-100 dark:ring-blue-900">
                  Dostępne: {pitTrustView.defenseAvailableCount}
                </span>
                <span className="rounded-full bg-white px-2.5 py-1 text-blue-800 ring-1 ring-blue-100 dark:bg-blue-950/40 dark:text-blue-100 dark:ring-blue-900">
                  Do zebrania: {pitTrustView.defenseToCollectCount}
                </span>
                <span className="rounded-full bg-white px-2.5 py-1 text-blue-800 ring-1 ring-blue-100 dark:bg-blue-950/40 dark:text-blue-100 dark:ring-blue-900">
                  Do doradcy: {pitTrustView.defenseAdvisorReviewCount}
                </span>
              </div>
              <div className="mt-3 space-y-1 text-xs text-blue-900/80 dark:text-blue-100/80">
                {defenseVaultTopItems.length > 0 ? defenseVaultTopItems.map((item) => (
                  <p key={item.evidence_id} className="truncate">• {item.title}</p>
                )) : (
                  <p>Brak pilnych braków dowodowych w sejfie.</p>
                )}
              </div>
            </button>
          </motion.div>

          <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4">
            {simpleReportSteps.map((step, index) => (
              <motion.button
                key={step.id}
                type="button"
                data-motion="bank-step-card"
                data-step-id={step.id}
                onClick={() => openSimpleReportInsight(step.insight)}
                initial={simpleMotionInitial}
                animate={{ opacity: 1, y: 0 }}
                transition={simpleMotionTransition(0.26 + index * 0.03)}
                whileHover={simpleHoverLift}
                whileTap={simpleTapPress}
                className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-left text-sm transition hover:border-blue-200 hover:bg-blue-50 dark:border-gray-700 dark:bg-gray-900 dark:hover:border-blue-900 dark:hover:bg-blue-950/20"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <span className="font-bold text-gray-950 dark:text-white">{step.label}</span>
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{step.actionLabel}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span className="rounded-full bg-gray-50 px-2 py-0.5 text-[11px] font-semibold text-blue-700 ring-1 ring-blue-100 dark:bg-gray-800 dark:text-blue-300 dark:ring-blue-900/60">
                      {step.status}
                    </span>
                    <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold text-gray-600 ring-1 ring-gray-200 dark:bg-gray-950 dark:text-gray-300 dark:ring-gray-700">
                      {step.count}
                    </span>
                  </div>
                </div>
              </motion.button>
            ))}
          </div>
        </motion.section>
      )}

      {isExpertMode && (
      <section className="ia-content-visibility rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h3 className="font-semibold text-gray-900 dark:text-white">Status organizacyjny raportu</h3>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Lokalny status pracy użytkownika. Nie zmienia obliczeń silnika, PIT, NBP ani eksportowanych liczb.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(TAX_REPORT_ORGANIZATION_LABELS) as TaxReportOrganizationState[]).map((status) => (
              <button
                key={status}
                type="button"
                onClick={() => onReportOrganizationStatusChange(status)}
                className={`rounded-lg border px-3 py-2 text-sm font-semibold transition-colors ${
                  reportOrganizationStatus.status === status
                    ? 'border-blue-600 bg-blue-600 text-white'
                    : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800'
                }`}
              >
                {TAX_REPORT_ORGANIZATION_LABELS[status]}
              </button>
            ))}
          </div>
        </div>
      </section>
      )}

      {isExpertMode && pitSubmissionReadiness && (
        <section className={`ia-content-visibility rounded-xl border p-4 shadow-sm ${pitVerdictClass(pitSubmissionReadiness.verdict)}`}>
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide opacity-75">Kontrola przed złożeniem PIT</p>
              <h3 className="mt-1 text-xl font-bold">{pitVerdictLabel(pitSubmissionReadiness.verdict)}</h3>
              <p className="mt-1 text-sm opacity-80">
                Jeden werdykt z ledgeru podatku, braków dowodowych, luk NBP i problemów jakości. Nie zmienia matematyki, tylko checklistę przed wysłaniem.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
              <div className="rounded-lg border border-current/10 bg-white/50 p-3 dark:bg-gray-950/20">
                <p className="text-xs uppercase opacity-70">Wynik</p>
                <p className="text-lg font-bold">{pitSubmissionReadiness.score}/100</p>
              </div>
              <div className="rounded-lg border border-current/10 bg-white/50 p-3 dark:bg-gray-950/20">
                <p className="text-xs uppercase opacity-70">Kontrole PIT</p>
                <p className="text-lg font-bold">{pitSubmissionCounts.blocking || 0}</p>
              </div>
              <div className="rounded-lg border border-current/10 bg-white/50 p-3 dark:bg-gray-950/20">
                <p className="text-xs uppercase opacity-70">Dowody</p>
                <p className="text-lg font-bold">{pitSubmissionCounts.evidence || 0}</p>
              </div>
              <div className="rounded-lg border border-current/10 bg-white/50 p-3 dark:bg-gray-950/20">
                <p className="text-xs uppercase opacity-70">Ryzyka</p>
                <p className="text-lg font-bold">{pitSubmissionCounts.risk || 0}</p>
              </div>
            </div>
          </div>
          {pitSubmissionReadiness.recommendedAction && (
            <div className="mt-4 rounded-lg border border-current/10 bg-white/60 p-3 text-sm dark:bg-gray-950/20">
              <p className="font-semibold">Najważniejsza akcja: {pitSubmissionReadiness.recommendedAction.userAction}</p>
              <p className="mt-1 opacity-80">{pitSubmissionReadiness.recommendedAction.label}</p>
            </div>
          )}
          {pitSubmissionChecklist.length > 0 && (
            <div className="mt-4 space-y-2">
              {pitSubmissionChecklist.slice(0, 6).map((item) => (
                <div key={item.id} className="rounded-lg border border-current/10 bg-white/50 p-3 text-sm dark:bg-gray-950/20">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-black/5 px-2 py-1 text-xs font-semibold dark:bg-white/10">{pitSeverityLabel(item.severity)}</span>
                    <span className="rounded-full bg-black/5 px-2 py-1 text-xs font-semibold dark:bg-white/10">{pitCategoryLabel(item.category)}</span>
                    {item.linkedCostId && <span className="text-xs opacity-70">Koszt: {item.linkedCostId}</span>}
                  </div>
                  <p className="mt-2 font-medium">{item.label}</p>
                  <p className="mt-1 opacity-80">{item.userAction}</p>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {isExpertMode && (sourceManifestV2.length > 0 || noOverpayAudit || defenseCaseFile || brokerActionWorkbench.total > 0) && (
        <section className="ia-content-visibility rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-gray-800">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Źródła danych i ochrona przed przepłaceniem</p>
              <h3 className="mt-1 text-lg font-bold text-gray-900 dark:text-white">Import Intelligence + analiza kosztów</h3>
              <p className="mt-1 max-w-3xl text-sm text-gray-600 dark:text-gray-300">
                Program pokazuje lokalne źródła, rekordy wejściowe, koszty i dowody. To warstwa audytu; nie zmienia matematyki silnika.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-gray-900">
                <p className="text-xs uppercase text-slate-500 dark:text-slate-400">Źródła</p>
                <p className="text-lg font-bold text-gray-900 dark:text-white">{sourceManifestV2.length}</p>
                <p className="text-xs text-slate-500 dark:text-slate-400">canonical: {canonicalInputSources.length}</p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-gray-900">
                <p className="text-xs uppercase text-slate-500 dark:text-slate-400">Koszty kandydaci</p>
                <p className="text-lg font-bold text-gray-900 dark:text-white">{noOverpaySummary.candidateCostCount ?? noOverpayCandidateCosts.length}</p>
                <p className="text-xs text-slate-500 dark:text-slate-400">pominięte: {noOverpaySummary.excludedCostCount ?? noOverpayExcludedCosts.length}</p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-gray-900">
                <p className="text-xs uppercase text-slate-500 dark:text-slate-400">Pewność audytu</p>
                <p className="text-lg font-bold text-gray-900 dark:text-white">{noOverpayAudit?.confidenceScore ?? '—'}/100</p>
                <p className="text-xs text-slate-500 dark:text-slate-400">duplikaty: {noOverpaySummary.duplicateRiskCount ?? noOverpayDuplicateRisks.length}</p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-gray-900">
                <p className="text-xs uppercase text-slate-500 dark:text-slate-400">Case file</p>
                <p className="text-lg font-bold text-gray-900 dark:text-white">{defenseCaseFile?.summary?.source_count ?? sourceManifestV2.length}</p>
                <p className="text-xs text-slate-500 dark:text-slate-400">braki: {defenseCaseFile?.summary?.missing_evidence_count ?? noOverpayMissingEvidence.length}</p>
              </div>
            </div>
          </div>

          <BrokerActionReportSection
            workbench={brokerActionWorkbench}
            onOpenImport={onOpenImport}
            onOpenHistorySearch={onOpenHistorySearch}
          />

          {(brokerFileControlTower || coverageMatrix.length > 0 || legalBasisRegistry.length > 0) && (
            <div className="mt-4 rounded-lg border border-blue-100 bg-blue-50 p-3 dark:border-blue-900/50 dark:bg-blue-950/20">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300">Broker File Control Tower</p>
                  <h4 className="mt-1 font-bold text-gray-900 dark:text-white">Co wgrałeś i jak zostało rozpoznane</h4>
                  <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                    Ten panel jest zbudowany przez silnik Python z lokalnych plików brokera. Frontend nie przelicza podatku, tylko pokazuje gotową diagnostykę źródeł.
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
                  <div className="rounded-md bg-white p-2 dark:bg-gray-900">
                    <p className="text-xs text-slate-500 dark:text-slate-400">Pliki</p>
                    <p className="font-bold text-gray-900 dark:text-white">{brokerFileControlTower?.summary?.source_count ?? sourceManifestV2.length}</p>
                  </div>
                  <div className="rounded-md bg-white p-2 dark:bg-gray-900">
                    <p className="text-xs text-slate-500 dark:text-slate-400">W canonical</p>
                    <p className="font-bold text-gray-900 dark:text-white">{brokerFileControlTower?.summary?.canonical_source_count ?? canonicalInputSources.length}</p>
                  </div>
                  <div className="rounded-md bg-white p-2 dark:bg-gray-900">
                    <p className="text-xs text-slate-500 dark:text-slate-400">Braki / konflikty</p>
                    <p className="font-bold text-gray-900 dark:text-white">{(brokerFileControlTower?.summary?.missing_coverage_count ?? 0) + (brokerFileControlTower?.summary?.conflict_count ?? 0)}</p>
                  </div>
                  <div className="rounded-md bg-white p-2 dark:bg-gray-900">
                    <p className="text-xs text-slate-500 dark:text-slate-400">Podstawy prawne</p>
                    <p className="font-bold text-gray-900 dark:text-white">{legalBasisRegistry.length}</p>
                  </div>
                </div>
              </div>

              {coverageMatrix.length > 0 && (
                <div className="mt-3">
                  <p className="font-semibold text-gray-900 dark:text-white">Macierz kompletności</p>
                  <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-3">
                    {coverageMatrix.slice(0, 9).map((entry) => (
                      <div key={entry.area} className="rounded-md border border-slate-200 bg-white p-2 text-sm dark:border-slate-700 dark:bg-gray-900">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <p className="font-semibold text-gray-900 dark:text-white">{entry.label}</p>
                            <p className="text-xs text-slate-500 dark:text-slate-400">rekordy: {entry.recordCount ?? 0} · problemy: {entry.issueCount ?? 0}</p>
                          </div>
                          <span className={`rounded-full px-2 py-1 text-xs font-semibold ${coverageStatusClass(entry.status)}`}>
                            {coverageStatusLabel(entry.status)}
                          </span>
                        </div>
                        {entry.recommendation && <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">{entry.recommendation}</p>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {sourceReconciliationReport && (
                <div className="mt-3 rounded-md border border-cyan-100 bg-white p-3 dark:border-cyan-900/60 dark:bg-gray-900">
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div>
                      <p className="font-semibold text-gray-900 dark:text-white">Kontrola zgodności źródeł</p>
                      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                        Źródła transakcyjne są porównane z plikami pomocniczymi i kontekstem. To audyt źródeł, bez zmiany kwot podatku.
                      </p>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
                      <div className="rounded bg-cyan-50 p-2 dark:bg-cyan-950/30">
                        <p className="text-slate-500 dark:text-slate-400">Pewność</p>
                        <p className="font-bold text-gray-900 dark:text-white">{sourceReconciliationReport.summary?.confidenceScore ?? '—'}/100</p>
                      </div>
                      <div className="rounded bg-cyan-50 p-2 dark:bg-cyan-950/30">
                        <p className="text-slate-500 dark:text-slate-400">Zgodne</p>
                        <p className="font-bold text-gray-900 dark:text-white">{sourceReconciliationReport.summary?.matchedSources ?? 0}</p>
                      </div>
                      <div className="rounded bg-cyan-50 p-2 dark:bg-cyan-950/30">
                        <p className="text-slate-500 dark:text-slate-400">Do kontroli</p>
                        <p className="font-bold text-amber-700 dark:text-amber-300">{sourceReconciliationReport.summary?.needsReviewSources ?? 0}</p>
                      </div>
                      <div className="rounded bg-cyan-50 p-2 dark:bg-cyan-950/30">
                        <p className="text-slate-500 dark:text-slate-400">Tylko pomocnicze</p>
                        <p className="font-bold text-gray-900 dark:text-white">{sourceReconciliationReport.summary?.supplementalOnlyRecords ?? 0}</p>
                      </div>
                    </div>
                  </div>
                  {sourceReconciliationBreakdown && (
                    <p className="mt-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                      Zbiorczo kontekstowe: {sourceReconciliationBreakdown}
                    </p>
                  )}
                  {(sourceReconciliationReport.recommendedActions || []).length > 0 ? (
                    <ul className="mt-2 space-y-1 text-xs text-amber-700 dark:text-amber-300">
                      {(sourceReconciliationReport.recommendedActions || []).slice(0, 3).map((action) => (
                        <li key={action}>{action}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-300">
                      Źródło transakcyjne zweryfikowane z plikami pomocniczymi.
                    </p>
                  )}
                </div>
              )}

              {(potentiallyMissedCosts.length > 0 || defenseChainsV2.length > 0 || legalBasisRegistry.length > 0) && (
                <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-3">
                  <div className="rounded-md border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-gray-900">
                    <p className="font-semibold text-gray-900 dark:text-white">Co może obniżyć podatek</p>
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      No Overpay Guard v2: kandydaci, pominięte koszty i ryzyka duplikacji.
                    </p>
                    <div className="mt-2 space-y-2">
                      {(potentiallyMissedCosts.length > 0 ? potentiallyMissedCosts : noOverpayV2CandidateCosts).slice(0, 4).map((cost) => (
                        <div key={cost.costId} className="rounded border border-slate-200 p-2 text-sm dark:border-slate-700">
                          <div className="flex justify-between gap-2">
                            <span className="font-medium text-gray-900 dark:text-white">{cost.labelPl || costTagLabel(cost.kind || '')}</span>
                            <span>{formatPln(cost.amountPln || '0')}</span>
                          </div>
                          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{cost.costId}</p>
                          {('userAction' in cost) && cost.userAction && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{String(cost.userAction)}</p>}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-md border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-gray-900">
                    <p className="font-semibold text-gray-900 dark:text-white">Dowody do zachowania</p>
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      Defense Case File v2 pokazuje łańcuch koszt → źródło → kontekst → dowód.
                    </p>
                    <div className="mt-2 space-y-2">
                      {defenseChainsV2.slice(0, 4).map((chain) => (
                        <div key={String(chain.costId || chain.label)} className="rounded border border-slate-200 p-2 text-sm dark:border-slate-700">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-medium text-gray-900 dark:text-white">{String(chain.label || chain.costId || 'Koszt')}</span>
                            <span className="rounded-full bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
                              {riskLabel(String(chain.riskLevel || 'medium'))}
                            </span>
                          </div>
                          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{String(chain.contextLabel || 'kontekst kosztu')}</p>
                          {chain.userAction && <p className="mt-1 text-xs text-slate-700 dark:text-slate-200">{String(chain.userAction)}</p>}
                        </div>
                      ))}
                      {defenseChainsV2.length === 0 && <p className="text-sm text-slate-500 dark:text-slate-400">Brak łańcuchów dowodowych v2 w bieżącym przebiegu.</p>}
                    </div>
                  </div>

                  <div className="rounded-md border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-gray-900">
                    <p className="font-semibold text-gray-900 dark:text-white">Podstawa prawna</p>
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      Lokalny rejestr referencji do oficjalnych źródeł. Nie zmienia wyniku, tylko opisuje podstawę audytu.
                    </p>
                    <div className="mt-2 space-y-2">
                      {legalBasisRegistry.slice(0, 4).map((basis) => (
                        <a
                          key={basis.basisId}
                          href={basis.url}
                          target="_blank"
                          rel="noreferrer"
                          className="block rounded border border-slate-200 p-2 text-sm hover:border-blue-300 dark:border-slate-700"
                        >
                          <span className="font-medium text-blue-700 dark:text-blue-300">{basis.label}</span>
                          <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">{basis.source} · {basis.scope}</span>
                        </a>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-3">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-gray-900/60">
              <p className="font-semibold text-gray-900 dark:text-white">Źródła danych</p>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Ostrzeżenia / błędy źródeł: {sourceIssueCount}
              </p>
              <div className="mt-3 space-y-2">
                {sourceManifestV2.slice(0, 5).map((source) => (
                  <div key={source.sourceId} className="rounded-md border border-slate-200 bg-white p-2 text-sm dark:border-slate-700 dark:bg-gray-800">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold text-gray-900 dark:text-white">{source.filename || source.sourceId}</span>
                      <span className={`rounded-full px-2 py-1 text-xs font-semibold ${
                        source.contributesToTax
                          ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200'
                          : source.sourceResolutionRole === 'candidate_tax'
                            ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200'
                            : 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200'
                      }`}>
                        {source.contributesToTax
                          ? 'wpływa na PIT'
                          : source.sourceResolutionRole === 'candidate_tax'
                            ? 'kandydat PIT'
                            : 'kontrolny / techniczny'}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{sourceTypeLabel(source.detectedType)}</div>
                    <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{formatRecordCounts(source.recordCounts)}</div>
                  </div>
                ))}
                {sourceManifestV2.length === 0 && (
                  <p className="text-sm text-slate-500 dark:text-slate-400">Brak manifestu źródeł w bieżącym przebiegu.</p>
                )}
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-gray-900/60">
              <p className="font-semibold text-gray-900 dark:text-white">Co może obniżyć podatek</p>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Kandydaci z FX, prowizji, odsetek, finansowania i kosztów inwestycyjnych.
              </p>
              <div className="mt-3 space-y-2">
                {noOverpayCandidateCosts.slice(0, 5).map((cost) => (
                  <div key={cost.costId} className="rounded-md border border-slate-200 bg-white p-2 text-sm dark:border-slate-700 dark:bg-gray-800">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold text-gray-900 dark:text-white">{cost.labelPl || costTagLabel(cost.kind || '')}</span>
                      <span className={`rounded-full px-2 py-1 text-xs font-semibold ${
                        cost.included
                          ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200'
                          : 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200'
                      }`}>
                        {noOverpayStatusLabel(cost.status)}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-2 text-xs text-slate-500 dark:text-slate-400">
                      <span className="font-mono">{cost.costId}</span>
                      <span>{formatPln(cost.amountPln || '0')}</span>
                    </div>
                    {cost.reason && <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">{cost.reason}</p>}
                  </div>
                ))}
                {noOverpayCandidateCosts.length === 0 && (
                  <p className="text-sm text-slate-500 dark:text-slate-400">Brak kandydatów kosztowych poza standardowym ledgerem.</p>
                )}
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-gray-900/60">
              <p className="font-semibold text-gray-900 dark:text-white">Do sprawdzenia</p>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Lista akcji z importu, No Overpay Guard i obrony kosztów.
              </p>
              <ul className="mt-3 space-y-2 text-sm text-slate-700 dark:text-slate-200">
                {sourceRecommendedActions.slice(0, 6).map((action) => (
                  <li key={action} className="rounded-md border border-slate-200 bg-white p-2 dark:border-slate-700 dark:bg-gray-800">
                    {action}
                  </li>
                ))}
                {sourceRecommendedActions.length === 0 && (
                  <li className="rounded-md border border-emerald-200 bg-emerald-50 p-2 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-900/20 dark:text-emerald-200">
                    Brak dodatkowych akcji z audytu źródeł i kosztów.
                  </li>
                )}
              </ul>
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-500 dark:text-slate-400">
                <span>Techniczne rekordy: {noOverpaySummary.technicalRowCount ?? noOverpayTechnicalRows.length}</span>
                <span>Braki dowodowe: {noOverpaySummary.missingEvidenceCount ?? noOverpayMissingEvidence.length}</span>
              </div>
            </div>
          </div>
        </section>
      )}

      {isExpertMode && (
      <section className="ia-content-visibility rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Odtwarzalność raportu</p>
            <h3 className="mt-1 text-lg font-bold text-gray-900 dark:text-white">{pitCaseFileSummary.statusLabel}</h3>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
              Case file spina hash audytu, fingerprint wejścia, ledger kalkulacji i ścieżki kwot. Służy do wyjaśnienia, dlaczego wynik wyszedł dokładnie tak.
            </p>
          </div>
          <div className="grid gap-2 text-sm md:grid-cols-3">
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900">
              <p className="text-xs uppercase text-gray-500 dark:text-gray-400">Case ID</p>
              <p className="mt-1 font-semibold text-gray-900 dark:text-white">{pitCaseFileSummary.caseFileId || '—'}</p>
            </div>
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900">
              <p className="text-xs uppercase text-gray-500 dark:text-gray-400">Fingerprint danych</p>
              <p className="mt-1 font-semibold text-gray-900 dark:text-white">{pitCaseFileSummary.inputFingerprint || '—'}</p>
            </div>
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900">
              <p className="text-xs uppercase text-gray-500 dark:text-gray-400">Fingerprint kalkulacji</p>
              <p className="mt-1 font-semibold text-gray-900 dark:text-white">{pitCaseFileSummary.calculationFingerprint || '—'}</p>
            </div>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <span className={`rounded-full px-2 py-1 font-semibold ${
            pitCaseFileSummary.reproducible
              ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200'
              : 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200'
          }`}>
            {pitCaseFileSummary.reproducible ? 'Pakiet odtwarzalny' : 'Wymaga pełnego pakietu'}
          </span>
          <span className={`rounded-full px-2 py-1 font-semibold ${
            pitCaseFileBaselineStatus.status === 'MATCH'
              ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200'
              : pitCaseFileBaselineStatus.status === 'CHANGED'
                ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-200'
                : 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200'
          }`}>
            {pitCaseFileBaselineStatus.label}
          </span>
          <span className="text-gray-600 dark:text-gray-300">{pitCaseFileSummary.sectionCountLabel}</span>
        </div>
        {pitCaseFileBaselineStatus.status !== 'NO_BASELINE' && (
          <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300">
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <span>Ostatni pakiet: {formatCaseFileDateTime(pitCaseFileBaselineStatus.baselineGeneratedAt)}</span>
              <span>Bieżący przebieg: {formatCaseFileDateTime(pitCaseFileBaselineStatus.currentGeneratedAt)}</span>
            </div>
            {pitCaseFileBaselineStatus.changedFields.length > 0 && (
              <p className="mt-2 text-red-700 dark:text-red-300">
                Zmienione elementy: {pitCaseFileBaselineStatus.changedFields.join(', ')}. Wygeneruj nowy pakiet przed złożeniem PIT.
              </p>
            )}
          </div>
        )}
        {pitCaseFileSummary.warnings.length > 0 && (
          <ul className="mt-3 space-y-1 text-sm text-amber-700 dark:text-amber-300">
            {pitCaseFileSummary.warnings.map((warning) => (
              <li key={warning}>• {warning}</li>
            ))}
          </ul>
        )}
      </section>
      )}

      {isExpertMode && (
      <section className="ia-content-visibility rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Zamknięcie roku PIT</p>
            <h3 className="mt-1 text-lg font-bold text-gray-900 dark:text-white">{taxYearClosureStatus.label}</h3>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
              Lokalny snapshot zamknięcia roku blokuje przypadkowe pomylenie starego pakietu z nowym przebiegiem. Nie zmienia matematyki PIT.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {taxYearClosure && (
              <button
                type="button"
                onClick={handleDownloadYearClosureAudit}
                disabled={!canUseEngineResult}
                title={!canUseEngineResult ? 'Wynik NIEAKTUALNY — przelicz ponownie.' : undefined}
                className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-800 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:hover:bg-gray-800"
              >
                Pobierz audyt zamknięcia
              </button>
            )}
            {taxYearClosureStatus.isReadOnly ? (
              <div className="w-full max-w-md space-y-2">
                <label className="block text-sm font-semibold text-gray-700 dark:text-gray-200">
                  Powód ponownego otwarcia
                  <textarea
                    value={reopenTaxYearNote}
                    onChange={(event) => setReopenTaxYearNote(event.target.value)}
                    rows={2}
                    className="mt-1 w-full rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm font-normal text-gray-800 shadow-sm focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-amber-800 dark:bg-gray-900 dark:text-gray-100"
                  />
                </label>
                <button
                  type="button"
                  onClick={handleReopenTaxYear}
                  className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800 transition-colors hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200"
                >
                  Otwórz rok ponownie
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleCloseTaxYear}
                disabled={!pitCaseFile || !canUseEngineResult || !filingReady}
                title={!canUseEngineResult
                  ? 'Wynik NIEAKTUALNY — przelicz ponownie.'
                  : !filingReady ? 'Rok można zamknąć dopiero przy zielonej gotowości rozliczenia.' : undefined}
                className="rounded-lg border border-blue-300 bg-blue-50 px-3 py-2 text-sm font-semibold text-blue-800 transition-colors hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-200"
              >
                {taxYearClosureStatus.status === 'changed_after_close' ? 'Zamknij ponownie na bieżących danych' : `Zamknij rok ${selectedYear}`}
              </button>
            )}
          </div>
        </div>

        {taxYearClosureError && (
          <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-900/20 dark:text-red-200">
            {taxYearClosureError}
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          {taxYearClosureStatus.isReadOnly && (
            <span className="rounded-full bg-emerald-100 px-2 py-1 font-semibold text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200">
              Tryb tylko do odczytu
            </span>
          )}
          {taxYearClosureStatus.status === 'changed_after_close' && (
            <span className="rounded-full bg-red-100 px-2 py-1 font-semibold text-red-800 dark:bg-red-900/30 dark:text-red-200">
              Rok nie jest już zamrożony
            </span>
          )}
          {taxYearClosureStatus.snapshotHash && (
            <span className="text-gray-600 dark:text-gray-300">Hash zamknięcia: {taxYearClosureStatus.snapshotHash}</span>
          )}
          {taxYearClosureStatus.closedAt && (
            <span className="text-gray-600 dark:text-gray-300">Zamknięto: {formatCaseFileDateTime(taxYearClosureStatus.closedAt)}</span>
          )}
        </div>

        {taxYearClosureStatus.changedFields.length > 0 && (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-900/20 dark:text-red-200">
            <p className="font-semibold">Zmienione po zamknięciu: {taxYearClosureStatus.changedFields.join(', ')}</p>
            <p className="mt-1">
              Wygeneruj nowy pakiet i zamknij rok ponownie, jeśli te dane mają być podstawą złożenia PIT.
            </p>
            {taxYearClosureStatus.changedDetails.length > 0 && (
              <div className="mt-3 overflow-hidden rounded-md border border-red-200 bg-white/70 dark:border-red-900/60 dark:bg-gray-950/40">
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

        {taxYearClosure?.decisions?.length ? (
          <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300">
            <p className="font-semibold text-gray-900 dark:text-white">Dziennik decyzji</p>
            <ul className="mt-2 space-y-1">
              {taxYearClosure.decisions.slice(-4).map((decision) => (
                <li key={decision.id}>
                  {formatCaseFileDateTime(decision.createdAt)} · {decision.note}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>
      )}

      {isExpertMode && (
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        className={`p-6 rounded-xl border ${
          filingReady
            ? 'bg-emerald-50 border-emerald-200 dark:bg-emerald-900/20 dark:border-emerald-800'
            : engineResult?.status === 'FAILED'
              ? 'bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-800'
              : 'bg-amber-50 border-amber-200 dark:bg-amber-900/20 dark:border-amber-800'
        }`}
      >
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4 mb-4">
          <div>
            <h3 className="font-bold text-lg text-indigo-900 dark:text-indigo-200">
              {isExpertMode ? 'Autorytatywny wynik silnika Python' : 'Status raportu'}
            </h3>
            {engineStale && <p role="status" className="mt-2 font-bold text-amber-800 dark:text-amber-300">NIEAKTUALNE — przelicz ponownie przed eksportem lub zamknięciem roku.</p>}
          </div>
          <div className="flex flex-wrap gap-2">
            {engineResult?.status && (
              <span className={`px-2 py-1 rounded text-xs font-bold ${engineResult.status === 'FAILED' ? 'bg-red-100 text-red-800' : engineResult.status === 'SUCCESS' ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'}`}>
                {statusLabel(engineResult.status)}
              </span>
            )}
            <span className={`px-2 py-1 rounded text-xs font-bold ${filingReady ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'}`}>
              {filingReady ? statusLabel('FILING_READY') : statusLabel('NOT_FILING_READY')}
            </span>
          </div>
        </div>

        <div className="mb-4 rounded-lg border border-blue-100 bg-white/80 p-4 dark:border-blue-900/60 dark:bg-gray-900/30">
          <p className="text-xs font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300">Status Samocheck</p>
          <div className="mt-2 flex flex-wrap gap-2 text-xs font-semibold">
            <span className="rounded-full bg-blue-50 px-2.5 py-1 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200">
              {simpleReportStatus.sourceLabel}
            </span>
            <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">
              {simpleReportStatus.blockingLabel}
            </span>
            <span className="rounded-full bg-amber-50 px-2.5 py-1 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
              {simpleReportStatus.evidenceLabel}
            </span>
          </div>
        </div>

        {engineLoading && (
          <div className="flex items-center gap-3 text-indigo-700 dark:text-indigo-300">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span>Silnik przelicza dane i buduje raport audytowy…</span>
          </div>
        )}

        {!engineLoading && engineResult?.error && (
          <div className="flex items-center gap-3 text-red-700 dark:text-red-300">
            <AlertTriangle className="w-5 h-5" />
            <span>{engineResult.error}</span>
          </div>
        )}

        {!engineLoading && engineResult && !engineResult.error && (
          <div className="space-y-6">
            {filingReady && (
              <div className="rounded-lg border border-emerald-200 bg-white/80 p-4 dark:border-emerald-700 dark:bg-gray-900/20">
                <p className="text-sm font-semibold text-emerald-800 dark:text-emerald-300">
                  Raport policzony. Brak otwartych kontroli podatkowych. Pozostałe pozycje to dowody lub ryzyka do świadomego zachowania.
                </p>
                <p className="mt-1 text-xs text-emerald-700 dark:text-emerald-400">
                  To nie zmienia kwoty automatycznie; służy do obrony kosztów i decyzji w razie kontroli.
                </p>
              </div>
            )}

            {!filingReady && (
              <div className="rounded-lg border border-amber-200 bg-white/80 dark:bg-gray-900/20 p-4">
                <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                  Wynik nie jest gotowy do rozliczenia. Silnik zwrócił wynik analityczny, ale kontrole jakości wymagają jeszcze sprawdzenia.
                </p>
                {reviewQueue.length > 0 && (
                  <ReviewDecisionsPanel
                    queue={reviewQueue}
                    selectedYear={selectedYear}
                    disabled={engineLoading || packageLoading || isYearClosureReadOnly}
                    onRecalculate={() => { runPythonEngine(); }}
                    onOpenHistorySearch={onOpenHistorySearch}
                  />
                )}
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
              <div className="ia-content-visibility bg-white dark:bg-gray-800 p-4 rounded-lg border border-gray-200 dark:border-gray-700">
                <p className="text-xs text-gray-500 uppercase">Plan liczenia podatku</p>
                <p className="text-lg font-bold text-gray-900 dark:text-white">{planLabel(engineResult.plan_used || 'aggressive_user')}</p>
              </div>
              <div className="bg-white dark:bg-gray-800 p-4 rounded-lg border border-gray-200 dark:border-gray-700">
                <p className="text-xs text-gray-500 uppercase">Przychód PIT-38</p>
                <p className="text-lg font-bold text-gray-900 dark:text-white">{kwotaAlboBrak(bankRevenuePln)}</p>
              </div>
              <div className="bg-white dark:bg-gray-800 p-4 rounded-lg border border-gray-200 dark:border-gray-700">
                <p className="text-xs text-gray-500 uppercase">Koszt PIT-38</p>
                <p className="text-lg font-bold text-gray-900 dark:text-white">{kwotaAlboBrak(bankCostPln)}</p>
              </div>
              <div className="bg-white dark:bg-gray-800 p-4 rounded-lg border border-gray-200 dark:border-gray-700">
                <p className="text-xs text-gray-500 uppercase">Netto po scenariuszu głównym</p>
                <p className="text-lg font-bold text-indigo-700 dark:text-indigo-300">{formatPln(summary.net_pln)}</p>
              </div>
            </div>

            {isExpertMode && (
            <>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
              <div className="bg-white dark:bg-gray-800 p-4 rounded-lg border border-gray-200 dark:border-gray-700">
                <p className="text-xs text-gray-500 uppercase">Koszt przewalutowania EUR→USD</p>
                <p className="text-base font-semibold text-gray-900 dark:text-white">{summary.include_fx_conversion_costs || 'nie'}</p>
              </div>
              <div className="bg-white dark:bg-gray-800 p-4 rounded-lg border border-gray-200 dark:border-gray-700">
                <p className="text-xs text-gray-500 uppercase">Odsetki inwestycyjne</p>
                <p className="text-base font-semibold text-gray-900 dark:text-white">{summary.include_interest_costs || 'nie'}</p>
              </div>
              <div className="bg-white dark:bg-gray-800 p-4 rounded-lg border border-gray-200 dark:border-gray-700">
                <p className="text-xs text-gray-500 uppercase">Koszty rachunku</p>
                <p className="text-base font-semibold text-gray-900 dark:text-white">{summary.include_account_costs || 'nie'}</p>
              </div>
              <div className="bg-white dark:bg-gray-800 p-4 rounded-lg border border-gray-200 dark:border-gray-700">
                <p className="text-xs text-gray-500 uppercase">Prowizja bankowa za zasilenie</p>
                <p className="text-base font-semibold text-gray-900 dark:text-white">{summary.include_bank_funding_fee || (fundingFeeAllocations.length > 0 ? 'tak' : 'nie')}</p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="bg-white dark:bg-gray-800 p-4 rounded-lg border border-gray-200 dark:border-gray-700">
                <p className="text-xs text-gray-500 uppercase">Kontrole PIT</p>
                <p className="text-lg font-bold text-gray-900 dark:text-white">{qualityMetrics.blocking_count || 0}</p>
              </div>
              <div className="bg-white dark:bg-gray-800 p-4 rounded-lg border border-gray-200 dark:border-gray-700">
                <p className="text-xs text-gray-500 uppercase">Kontrole uruchomienia</p>
                <p className="text-lg font-bold text-gray-900 dark:text-white">{qualityMetrics.runtime_blocking_count || 0}</p>
              </div>
              <div className="bg-white dark:bg-gray-800 p-4 rounded-lg border border-gray-200 dark:border-gray-700">
                <p className="text-xs text-gray-500 uppercase">Braki kursów FX</p>
                <p className="text-lg font-bold text-gray-900 dark:text-white">{coverageGaps.length}</p>
              </div>
              <div className="bg-white dark:bg-gray-800 p-4 rounded-lg border border-gray-200 dark:border-gray-700">
                <p className="text-xs text-gray-500 uppercase">Wiersze DePo</p>
                <p className="text-lg font-bold text-gray-900 dark:text-white">{depoRows.length}</p>
              </div>
              <div className="bg-white dark:bg-gray-800 p-4 rounded-lg border border-gray-200 dark:border-gray-700">
                <p className="text-xs text-gray-500 uppercase">Okresy finansowania</p>
                <p className="text-lg font-bold text-gray-900 dark:text-white">{financingLedger?.episode_count ?? 0}</p>
              </div>
            </div>

            {legacyCryptoCost && <p role="alert" className="text-sm text-amber-700 dark:text-amber-400">
              Dawny koszt krypto bez roku: {legacyCryptoCost} PLN. Nie jest używany w obliczeniach. Przypisz go do właściwego roku w Optymalizacji Podatkowej.
            </p>}
            <div className="bg-white dark:bg-gray-800 p-4 rounded-lg border border-gray-200 dark:border-gray-700">
              <div className="flex items-center justify-between mb-1">
                <h4 className="font-semibold text-gray-900 dark:text-white">Straty z lat ubiegłych</h4>
                <button
                  type="button"
                  disabled={priorLossesReadOnly || nextPriorLossYear === undefined}
                  onClick={() => {
                    if (nextPriorLossYear === undefined) return;
                    persistPriorLosses([
                      ...priorLosses,
                      {
                        id: `loss-${Date.now()}`,
                        taxYear: nextPriorLossYear,
                        amountPln: '',
                        accepted: true,
                      },
                    ]);
                  }}
                  className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700"
                >
                  Dodaj stratę
                </button>
              </div>
              {priorLossesReadOnly && <p className="text-xs text-amber-700 mb-2">Otwórz rok ponownie, aby zmienić straty z lat ubiegłych.</p>}
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
                Program nie zna Twoich rozliczeń sprzed wgranych plików, więc stratę przepisz z PIT-38 za rok,
                w którym ją poniosłeś. Odliczyć można ją przez pięć kolejnych lat, w jednym roku nie więcej niż
                połowę jej kwoty — albo jednorazowo do 5 000 000 zł. Limit nalicza silnik.
              </p>
              {priorLosses.length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Nie wprowadzono żadnej straty z lat ubiegłych.
                </p>
              ) : (
                <div className="space-y-2">
                  {priorLosses.map((entry, index) => (
                    <div key={entry.id} className="flex flex-wrap items-end gap-2">
                      <label className="text-xs text-gray-600 dark:text-gray-300">
                        <span className="block uppercase text-gray-500 mb-1">Rok straty</span>
                        <input
                          type="number"
                          value={entry.taxYear}
                          min={selectedYear - 5}
                          max={selectedYear - 1}
                          disabled={priorLossesReadOnly}
                          onChange={(event) => {
                            const year = Number(event.target.value);
                            if (!isPriorLossYearAvailable(priorLosses, year, index)) return;
                            const next = [...priorLosses];
                            next[index] = { ...entry, taxYear: year };
                            persistPriorLosses(next);
                          }}
                          className="w-24 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-950 px-2 py-1 text-sm"
                        />
                      </label>
                      <label className="text-xs text-gray-600 dark:text-gray-300">
                        <span className="block uppercase text-gray-500 mb-1">Kwota straty w PLN</span>
                        <input
                          inputMode="decimal"
                          value={entry.amountPln}
                          placeholder="0,00"
                          disabled={priorLossesReadOnly}
                          onChange={(event) => {
                            const next = [...priorLosses];
                            next[index] = { ...entry, amountPln: event.target.value };
                            persistPriorLosses(next);
                          }}
                          className="w-40 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-950 px-2 py-1 text-sm"
                        />
                      </label>
                      <label className="text-xs text-gray-600 dark:text-gray-300">
                        <span className="block uppercase text-gray-500 mb-1">Pozostało do odliczenia (po zeznaniach za lata poprzednie)</span>
                        <input
                          inputMode="decimal"
                          value={entry.remainingPln ?? ''}
                          placeholder={entry.taxYear === selectedYear - 1 ? 'Domyślnie pełna kwota' : 'Potwierdź saldo'}
                          disabled={priorLossesReadOnly}
                          onChange={(event) => {
                            const next = [...priorLosses];
                            next[index] = { ...entry, remainingPln: event.target.value };
                            persistPriorLosses(next);
                          }}
                          className="w-40 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-950 px-2 py-1 text-sm"
                        />
                      </label>
                      <button
                        type="button"
                        disabled={priorLossesReadOnly}
                        onClick={() => persistPriorLosses(priorLosses.filter((item) => item.id !== entry.id))}
                        className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700"
                      >
                        Usuń
                      </button>
                      {entry.taxYear >= selectedYear || entry.taxYear < selectedYear - 5 ? (
                        <span className="text-xs text-amber-700 dark:text-amber-400">
                          Poza pięcioletnim oknem odliczenia — silnik pominie tę pozycję.
                        </span>
                      ) : null}
                    </div>
                  ))}
                  <p className="text-xs text-gray-500 dark:text-gray-400 pt-1">
                    Zmiany są zapisywane od razu. Przelicz raport, żeby uwzględnić je w podatku.
                  </p>
                </div>
              )}
            </div>

            {financingEpisodes.length > 0 && (
              <div className="bg-white dark:bg-gray-800 p-4 rounded-lg border border-gray-200 dark:border-gray-700">
                <div className="flex items-center justify-between mb-1">
                  <h4 className="font-semibold text-gray-900 dark:text-white">Pieniądze pożyczone od brokera</h4>
                  <span className="text-xs text-gray-500">
                    {financingLedger?.charged_days ?? 0} {odmienLiczebnik(financingLedger?.charged_days ?? 0, 'dzień', 'dni', 'dni')} z odsetkami
                    {financingLedger?.total_interest_pln
                      ? ` · ${formatPln(financingLedger.total_interest_pln)}`
                      : ''}
                  </span>
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
                  Okresy, w których konto było na minusie. Odsetki naliczane są za każdy dzień kalendarzowy,
                  aż do uregulowania salda.
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs uppercase text-gray-500 border-b border-gray-200 dark:border-gray-700">
                        <th className="py-2 pr-3">Od</th>
                        <th className="py-2 pr-3">Uregulowane</th>
                        <th className="py-2 pr-3 text-right">Dni</th>
                        <th className="py-2 pr-3 text-right">Odsetki</th>
                        <th className="py-2 pr-3 text-right">Odsetki PLN</th>
                        <th className="py-2 text-right">Największa pożyczka</th>
                      </tr>
                    </thead>
                    <tbody>
                      {financingEpisodes.map((episode) => (
                        <tr
                          key={episode.episode_id}
                          className="border-b border-gray-100 dark:border-gray-800 last:border-0"
                        >
                          <td className="py-2 pr-3 whitespace-nowrap">{episode.opened_on}</td>
                          <td className="py-2 pr-3 whitespace-nowrap">
                            {episode.is_open ? (
                              <span className="text-amber-700 dark:text-amber-400">
                                nieuregulowane
                              </span>
                            ) : (
                              episode.settled_on
                            )}
                          </td>
                          <td className="py-2 pr-3 text-right">{episode.charged_days}</td>
                          <td className="py-2 pr-3 text-right whitespace-nowrap">
                            {episode.total_interest} {episode.currency}
                          </td>
                          <td className="py-2 pr-3 text-right whitespace-nowrap">
                            {episode.total_interest_pln ? formatPln(episode.total_interest_pln) : '—'}
                          </td>
                          <td className="py-2 text-right whitespace-nowrap">
                            {episode.peak_principal
                              ? `${Number(episode.peak_principal).toLocaleString('pl-PL', { maximumFractionDigits: 0 })} ${episode.currency}`
                              : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {(financingLedger?.open_episode_count ?? 0) > 0 && (
                  <p className="mt-3 text-xs text-amber-700 dark:text-amber-400">
                    Co najmniej jeden okres sięga końca wgranych danych. Brak dalszych naliczeń nie dowodzi spłaty —
                    dograj nowszy wyciąg, żeby domknąć rozliczenie.
                  </p>
                )}
                <p className="mt-2 text-xs text-gray-400 dark:text-gray-400">
                  {financingEpisodes[0]?.principal_source === 'broker_comment'
                    ? 'Kwoty pożyczki pochodzą wprost z opisu naliczeń brokera'
                    : 'Kwoty pożyczki są oszacowane z odsetek i stawki taryfowej'}
                  {financingEpisodes[0]?.daily_rate_used
                    ? ` (stawka ${(Number(financingEpisodes[0].daily_rate_used) * 100).toFixed(6)}% dziennie)`
                    : ''}
                  . Sama pożyczka nie jest kosztem — do rozliczenia wchodzą wyłącznie odsetki.
                </p>
              </div>
            )}

            <div className="bg-white dark:bg-gray-800 p-4 rounded-lg border border-gray-200 dark:border-gray-700">
              <div className="flex items-center justify-between mb-3">
                <h4 className="font-semibold text-gray-900 dark:text-white">Pakiet podatkowy na żądanie</h4>
                <span className="text-xs text-gray-500">{packageDraft ? 'Wygenerowany' : 'Niewygenerowany'}</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                <label className="text-sm text-gray-700 dark:text-gray-300">
                  <span className="block text-xs uppercase text-gray-500 mb-2">Rodzaj pakietu do wygenerowania</span>
                  <select
                    value={selectedPackageScope}
                    onChange={(event) => setSelectedPackageScope(event.target.value as TaxPackageScope)}
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2"
                  >
                    {packageScopeOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm text-gray-700 dark:text-gray-300">
                  <span className="block text-xs uppercase text-gray-500 mb-2">Tryb draftu</span>
                  <select
                    value={selectedFilingMode}
                    onChange={(event) => setSelectedFilingMode(event.target.value as 'ORIGINAL' | 'CORRECTION')}
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2"
                  >
                    <option value="ORIGINAL">Oryginał</option>
                    <option value="CORRECTION">Korekta</option>
                  </select>
                </label>
              </div>
              <p className="text-xs text-gray-500 mb-4">
                Wybierasz zakres pakietu i tryb draftu, a przycisk powyżej generuje pakiet w Pythonie i od razu pobiera główny artefakt.
              </p>
              {packageDownloadError && (
                <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  {packageDownloadError}
                </div>
              )}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                <div>
                  <p className="text-gray-500">Projekt PIT-38</p>
                  <p className="font-medium text-gray-900 dark:text-white">{packageDraft ? 'tak' : 'nie'}</p>
                </div>
                <div>
                  <p className="text-gray-500">Alokacje prowizji za zasilenie</p>
                  <p className="font-medium text-gray-900 dark:text-white">{fundingFeeAllocations.length}</p>
                </div>
                <div>
                  <p className="text-gray-500">Metoda alokacji zasilenia</p>
                  <p className="font-medium text-gray-900 dark:text-white">{allocationModeLabel(summary.funding_fee_allocation_mode || fundingFeeAllocations[0]?.method)}</p>
                </div>
              </div>
              {downloadableArtifacts.length > 0 && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {downloadableArtifacts.map((file) => (
                    <button
                      key={file}
                      disabled={!canUseEngineResult}
                      title={!canUseEngineResult ? 'Wynik NIEAKTUALNY — przelicz ponownie.' : undefined}
                      onClick={async () => {
                        if (!canUseEngineResult) return;
                        setPackageDownloadError(null);
                        try {
                          await downloadTaxEngineArtifact(file);
                        } catch (error: unknown) {
                          setPackageDownloadError(getErrorMessage(error, 'Nie udało się pobrać artefaktu silnika.'));
                        }
                      }}
                      className="inline-flex items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-700 transition-colors hover:bg-emerald-100"
                    >
                      <Download className="w-4 h-4" />
                      {getTaxArtifactLabel(file)}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="bg-white dark:bg-gray-800 p-4 rounded-lg border border-gray-200 dark:border-gray-700">
              <div className="flex items-center justify-between mb-3">
                <h4 className="font-semibold text-gray-900 dark:text-white">Pola C/D/G do przepisania</h4>
                <span className="text-xs text-gray-500">Domyślnie plan agresywny, bez sekcji E/F dla krypto</span>
              </div>
              {formFields.length === 0 ? (
                <p className="text-sm text-gray-500">Najpierw wygeneruj pakiet podatkowy, aby zobaczyć pola do wpisania.</p>
              ) : (
                <div className="space-y-3">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <label className="text-sm text-gray-700 dark:text-gray-300">
                      <span className="block text-xs uppercase text-gray-500 mb-2">Plan dla projekcji formularza</span>
                      <select
                        value={selectedProjectionPlan}
                        onChange={(event) => setSelectedProjectionPlan(event.target.value as 'conservative' | 'defensible' | 'aggressive_user')}
                        className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2"
                      >
                        <option value="aggressive_user">Agresywny</option>
                        <option value="defensible">Zrównoważony</option>
                        <option value="conservative">Konserwatywny</option>
                      </select>
                    </label>
                  </div>
                  {selectedScenarioProjection && (
                    <TaxScenarioProjectionSummary projection={selectedScenarioProjection} />
                  )}
                  <p className="text-sm text-gray-600 dark:text-gray-300">
                    Ta rozpiska pokazuje pola C/D/G pod wybrany plan scenariusza. Domyślnie aktywny jest plan agresywny, a wartości w tabeli są budowane z wyniku silnika pod ten wariant, żeby zgadzały się z projekcją PIT-38.
                  </p>
                  <TaxFormFieldsTable fields={formFields} />
                </div>
              )}
            </div>

            {taxBreakdownSection && (
              <div className="bg-white dark:bg-gray-800 p-4 rounded-lg border border-gray-200 dark:border-gray-700">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <h4 className="font-semibold text-gray-900 dark:text-white">Rozliczenie kwoty podatku</h4>
                    <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                      Pełny rozkład wyniku PIT: przychód, koszty, koszty agresywne, straty z lat ubiegłych, podatki z danych i wynik 19%.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setCalculationExpanded((value) => !value)}
                    className="inline-flex items-center justify-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-700"
                  >
                    Pokaż jak policzono podatek
                    <ChevronDown className={`h-4 w-4 transition-transform ${calculationExpanded ? 'rotate-180' : ''}`} />
                  </button>
                </div>
                {calculationExpanded && (
                  <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/40">
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
                      {taxBreakdownRows.map((row) => {
                        const trace = findTraceForLedgerLine(auditAppendix, row.lineId);
                        return (
                          <div key={row.label} className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
                            <p className="text-xs text-gray-500">{row.label}</p>
                            <p className="mt-1 font-semibold text-gray-900 dark:text-white">{row.value === null || row.value === undefined ? '—' : formatPln(String(row.value))}</p>
                            {trace && (
                              <button
                                type="button"
                                onClick={() => setSelectedTraceId(trace.entry.trace_id)}
                                className="mt-3 inline-flex items-center gap-1 rounded-md border border-blue-200 px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-50 dark:border-blue-800 dark:text-blue-300 dark:hover:bg-blue-900/20"
                              >
                                <FileSearch className="h-3 w-3" />
                                Pokaż źródła
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    {taxBreakdownSection.explanation && (
                      <p className="mt-3 text-sm text-gray-600 dark:text-gray-300">{taxBreakdownSection.explanation}</p>
                    )}
                    {taxCalculationLedgerRows.length > 0 && (
                      <div className="mt-4 overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
                        <div className="border-b border-gray-200 px-3 py-2 dark:border-gray-700">
                          <p className="font-semibold text-gray-900 dark:text-white">Ledger kalkulacji podatku</p>
                          <p className="text-xs text-gray-500 dark:text-gray-400">
                            Ślad kwot z silnika. Benchmark użytkownika jest tylko diagnostyką, nie regułą dopasowania wyniku.
                          </p>
                        </div>
                        <table className="min-w-full text-sm">
                          <thead>
                            <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500 dark:border-gray-700">
                              <th className="px-3 py-2">Pozycja</th>
                              <th className="px-3 py-2">Kwota PLN</th>
                              <th className="px-3 py-2">Wpływ</th>
                              <th className="px-3 py-2">Źródło</th>
                              <th className="px-3 py-2">Ścieżka</th>
                            </tr>
                          </thead>
                          <tbody>
                            {taxCalculationLedgerRows.slice(0, 14).map((row) => {
                              const trace = findTraceForLedgerLine(auditAppendix, row.line_id);
                              return (
                                <tr key={row.line_id} className="border-b border-gray-100 align-top dark:border-gray-700/60">
                                  <td className="px-3 py-2">
                                    <div className="font-medium text-gray-900 dark:text-white">{row.label || row.line_id}</div>
                                    <div className="font-mono text-xs text-gray-500">{row.line_id}</div>
                                    {row.formula && <div className="mt-1 text-xs text-gray-500">{row.formula}</div>}
                                  </td>
                                  <td className="px-3 py-2 font-semibold text-gray-900 dark:text-white">
                                    {formatPln(String(row.amount_pln ?? '0'))}
                                  </td>
                                  <td className="px-3 py-2 text-gray-700 dark:text-gray-300">{row.tax_effect || '—'}</td>
                                  <td className="px-3 py-2 text-gray-700 dark:text-gray-300">{row.source || row.section || '—'}</td>
                                  <td className="px-3 py-2">
                                    {trace ? (
                                      <button
                                        type="button"
                                        onClick={() => setSelectedTraceId(trace.entry.trace_id)}
                                        className="inline-flex items-center gap-1 rounded-md border border-blue-200 px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-50 dark:border-blue-800 dark:text-blue-300 dark:hover:bg-blue-900/20"
                                      >
                                        <FileSearch className="h-3 w-3" />
                                        Pokaż źródła
                                      </button>
                                    ) : (
                                      <span className="text-xs text-gray-400">—</span>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                    {selectedTrace && (
                      <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-900 dark:bg-blue-900/20">
                        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                          <div>
                            <p className="text-xs uppercase tracking-wide text-blue-700 dark:text-blue-300">Ścieżka kwoty</p>
                            <h5 className="mt-1 font-semibold text-gray-900 dark:text-white">{selectedTrace.entry.label}</h5>
                            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{selectedTrace.entry.explanation_pl}</p>
                          </div>
                          {onOpenHistorySearch && buildHistorySearchQueryFromTrace(selectedTrace) && (
                            <button
                              type="button"
                              onClick={() => {
                                const target = buildHistoryNavigationTargetFromTrace(selectedTrace);
                                onOpenHistorySearch(target.searchTerm, target.rowId);
                              }}
                              className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
                            >
                              Przejdź do historii
                            </button>
                          )}
                        </div>
                        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
                          <div className="rounded-lg border border-blue-100 bg-white p-3 dark:border-blue-900 dark:bg-gray-800">
                            <p className="text-xs text-gray-500">Typ ścieżki</p>
                            <p className="mt-1 font-semibold text-gray-900 dark:text-white">{getTraceKindLabel(selectedTrace.entry.kind)}</p>
                          </div>
                          <div className="rounded-lg border border-blue-100 bg-white p-3 dark:border-blue-900 dark:bg-gray-800">
                            <p className="text-xs text-gray-500">Kwota</p>
                            <p className="mt-1 font-semibold text-gray-900 dark:text-white">{formatTraceAmount(selectedTrace.entry.amount_pln)}</p>
                          </div>
                          <div className="rounded-lg border border-blue-100 bg-white p-3 dark:border-blue-900 dark:bg-gray-800">
                            <p className="text-xs text-gray-500">Ryzyko</p>
                            <p className="mt-1 font-semibold text-gray-900 dark:text-white">{getTraceRiskLabel(selectedTrace.entry.risk_level)}</p>
                          </div>
                        </div>
                        <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
                          <div className="rounded-lg border border-blue-100 bg-white p-3 dark:border-blue-900 dark:bg-gray-800">
                            <p className="font-medium text-gray-900 dark:text-white">Ledger i dowody</p>
                            <p className="mt-2 text-xs text-gray-500">Pozycje ledgeru: {selectedTrace.entry.ledger_row_ids.join(', ') || '—'}</p>
                            <p className="mt-1 text-xs text-gray-500">Dowody: {selectedTrace.entry.evidence_ids.join(', ') || '—'}</p>
                            <p className="mt-1 text-xs text-gray-500">
                              Potwierdzone lokalnie: {selectedTraceConfirmedCount}/{selectedTrace.entry.evidence_ids.length || selectedTraceWorkbenchItems.length || 0}
                            </p>
                            {selectedTraceNotes.length > 0 && (
                              <p className="mt-1 text-xs text-gray-500">
                                Notatka lokalna: {selectedTraceNotes[0]}
                              </p>
                            )}
                            <p className="mt-1 text-xs text-gray-500">Źródłowe ID: {selectedTrace.entry.source_record_ids.join(', ') || '—'}</p>
                            {onOpenDefenseWorkbench && (
                              <button
                                type="button"
                                onClick={onOpenDefenseWorkbench}
                                className="mt-3 inline-flex items-center gap-1 rounded-md border border-amber-200 px-2 py-1 text-xs font-medium text-amber-700 hover:bg-amber-50 dark:border-amber-800 dark:text-amber-300 dark:hover:bg-amber-900/20"
                              >
                                Edytuj status w Panelu dowodów PIT
                              </button>
                            )}
                          </div>
                          <div className="rounded-lg border border-blue-100 bg-white p-3 dark:border-blue-900 dark:bg-gray-800">
                            <p className="font-medium text-gray-900 dark:text-white">Checklisty i braki</p>
                            {selectedTrace.checklistItems.length > 0 ? (
                              <ul className="mt-2 space-y-1 text-xs text-gray-600 dark:text-gray-300">
                                {selectedTrace.checklistItems.slice(0, 5).map((item) => (
                                  <li key={item.id}>{item.label}: {item.userAction}</li>
                                ))}
                              </ul>
                            ) : (
                              <p className="mt-2 text-xs text-gray-500">Brak powiązanych pozycji checklisty.</p>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                    {resultDeltaReport && (
                      <div className="mt-4 rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-gray-800">
                        <p className="font-semibold text-gray-900 dark:text-white">Dlaczego wynik się zmienił</p>
                        <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{resultDeltaReport.summary}</p>
                        {resultDeltaRows.length > 0 && (
                          <div className="mt-3 overflow-x-auto">
                            <table className="min-w-full text-sm">
                              <thead>
                                <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500 dark:border-gray-700">
                                  <th className="py-2 pr-3">Pozycja</th>
                                  <th className="py-2 pr-3">Zmiana</th>
                                  <th className="py-2 pr-3">Było</th>
                                  <th className="py-2 pr-3">Jest</th>
                                  <th className="py-2">Różnica</th>
                                </tr>
                              </thead>
                              <tbody>
                                {resultDeltaRows.slice(0, 10).map((row) => (
                                  <tr key={`${row.line_id}-${row.change_type}`} className="border-b border-gray-100 dark:border-gray-700/60">
                                    <td className="py-2 pr-3">{row.label || row.line_id}</td>
                                    <td className="py-2 pr-3">{row.change_type}</td>
                                    <td className="py-2 pr-3">{row.previous_amount_pln == null ? '—' : formatPln(String(row.previous_amount_pln))}</td>
                                    <td className="py-2 pr-3">{row.current_amount_pln == null ? '—' : formatPln(String(row.current_amount_pln))}</td>
                                    <td className="py-2">{row.delta_pln == null ? '—' : formatPln(String(row.delta_pln))}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {defenseReadiness && (
              <DeferredBrowserSection fallbackLabel="Obrona planu agresywnego">
              <div className="ia-content-visibility bg-white dark:bg-gray-800 p-4 rounded-lg border border-gray-200 dark:border-gray-700">
                <div className="mb-4 flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                  <div>
                    <h4 className="font-semibold text-gray-900 dark:text-white">Obrona planu agresywnego</h4>
                    <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                      Materiał dowodowy do weryfikacji kosztów aggressive_user. To nie jest gwarancja akceptacji przez urząd, tylko audytowalna lista argumentów, ryzyk i brakujących dowodów.
                    </p>
                  </div>
                  <div className="rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-right dark:border-indigo-900 dark:bg-indigo-900/20">
                    <p className="text-xs uppercase text-indigo-700 dark:text-indigo-300">Gotowość obrony</p>
                    <p className="text-2xl font-bold text-indigo-900 dark:text-indigo-100">{defenseReadiness.score}/100</p>
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
                  <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
                    <p className="text-xs text-gray-500">Pozycje kosztowe</p>
                    <p className="text-lg font-semibold text-gray-900 dark:text-white">{defenseReadiness.totalAggressiveItems}</p>
                  </div>
                  <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
                    <p className="text-xs text-gray-500">Kompletne</p>
                    <p className="text-lg font-semibold text-emerald-700 dark:text-emerald-300">{defenseReadiness.completeItems}</p>
                  </div>
                  <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
                    <p className="text-xs text-gray-500">Braki dowodowe</p>
                    <p className="text-lg font-semibold text-amber-700 dark:text-amber-300">{defenseReadiness.missingEvidenceItems}</p>
                  </div>
                  <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
                    <p className="text-xs text-gray-500">Wysokie ryzyko</p>
                    <p className="text-lg font-semibold text-orange-700 dark:text-orange-300">{defenseReadiness.highRiskItems}</p>
                  </div>
                </div>
                {defenseGapSummary && (
                  <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm dark:border-slate-700 dark:bg-gray-900/40">
                    <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                      <div>
                        <p className="font-semibold text-gray-900 dark:text-white">Podsumowanie braków dowodowych</p>
                        <p className="text-gray-600 dark:text-gray-300">
                          Łącznie spraw do uzupełnienia: {defenseGapSummary.total_gaps}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {Object.entries(defenseGapSummary.by_status || {}).map(([status, count]) => (
                          <span key={status} className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-gray-700 dark:bg-gray-800 dark:text-gray-200">
                            {defenseStatusLabel(status)}: {count}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
                {visibleDefenseGroups.length > 0 && (
                  <div className="mt-4 rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900/30">
                    <div className="mb-3">
                      <p className="font-semibold text-gray-900 dark:text-white">Grupy dowodowe kosztów</p>
                      <p className="text-sm text-gray-600 dark:text-gray-300">
                        Powtarzalne koszty są scalone w grupy audytowe. Szczegółowe identyfikatory pozostają w danych grupy i pakiecie XLSX.
                      </p>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="min-w-full text-sm">
                        <thead>
                          <tr className="border-b border-gray-200 text-left dark:border-gray-700">
                            <th className="py-2 pr-3">Grupa</th>
                            <th className="py-2 pr-3">Suma</th>
                            <th className="py-2 pr-3">Status</th>
                            <th className="py-2 pr-3">Powiązanie / kontekst</th>
                            <th className="py-2">Pozycje źródłowe</th>
                          </tr>
                        </thead>
                        <tbody>
                          {visibleDefenseGroups.map((group) => (
                            <tr key={group.group_id} className="border-b border-gray-100 align-top dark:border-gray-800">
                              <td className="py-2 pr-3">
                                <div className="font-medium text-gray-900 dark:text-white">{group.label_pl || costTagLabel(group.kind || '')}</div>
                                <div className="text-xs text-gray-500">
                                  {[group.date_from, group.date_to].filter(Boolean).join(' - ') || 'brak zakresu dat'}
                                </div>
                              </td>
                              <td className="py-2 pr-3 font-semibold text-gray-900 dark:text-white">{formatPln(group.amount_pln || '0')}</td>
                              <td className="py-2 pr-3">
                                <span className={`inline-flex rounded-full border px-2 py-1 text-xs font-semibold ${defenseStatusClass(group.defense_status)}`}>
                                  {group.defense_status_label_pl || defenseStatusLabel(group.defense_status)}
                                </span>
                                <div className="mt-1 text-xs text-gray-500">Ryzyko: {riskLabel(group.risk_level)}</div>
                              </td>
                              <td className="py-2 pr-3 text-gray-700 dark:text-gray-300">
                                <div className="font-medium">{group.context_label || 'Kontekst kosztu'}</div>
                                {(group.context_ids || []).slice(0, 3).map((contextId) => (
                                  <div key={contextId} className="font-mono text-xs text-gray-500">{contextId}</div>
                                ))}
                              </td>
                              <td className="py-2 text-xs text-gray-600 dark:text-gray-300">
                                {group.item_count} {odmienLiczebnik(group.item_count, 'pozycja', 'pozycje', 'pozycji')} · {group.cost_ids.length} ID kosztów
                                {group.missing_evidence.length > 0 && (
                                  <div className="mt-1 text-amber-700 dark:text-amber-300">
                                    Braki: {group.missing_evidence.join(' · ')}
                                  </div>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
                {visibleDefenseEntries.length > 0 && (
                  <div className="mt-4 overflow-x-auto">
                    <table className="min-w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-200 text-left dark:border-gray-700">
                          <th className="py-2 pr-3">Koszt</th>
                          <th className="py-2 pr-3">Kwota</th>
                          <th className="py-2 pr-3">Status dowodowy</th>
                          <th className="py-2 pr-3">Powiązanie / kontekst</th>
                          <th className="py-2">Braki / dowody</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleDefenseEntries.map((entry) => {
                          const context = buildDefenseEntryContext(entry);
                          return (
                            <tr key={entry.cost_id} className="border-b border-gray-100 align-top dark:border-gray-800">
                              <td className="py-2 pr-3">
                                <div className="font-medium text-gray-900 dark:text-white">{costTagLabel(entry.kind)}</div>
                                <div className="font-mono text-xs text-gray-500">{entry.cost_id}</div>
                              </td>
                              <td className="py-2 pr-3 font-semibold text-gray-900 dark:text-white">{formatPln(entry.amount_pln || '0')}</td>
                              <td className="py-2 pr-3">
                                <span className={`inline-flex rounded-full border px-2 py-1 text-xs font-semibold ${defenseStatusClass(entry.defense_status)}`}>
                                  {entry.defense_status_label_pl || defenseStatusLabel(entry.defense_status)}
                                </span>
                                <div className="mt-1 text-xs text-gray-500">{defenseStatusSourceLabel(entry.defense_status_source)}</div>
                              </td>
                              <td className="py-2 pr-3 text-gray-700 dark:text-gray-300">
                                <div className={context.warning ? 'font-medium text-amber-700 dark:text-amber-300' : 'font-medium'}>
                                  {context.title}
                                </div>
                                {context.id && <div className="font-mono text-xs text-gray-500">{context.id}</div>}
                                <div className="text-xs text-gray-500">{context.detail}</div>
                              </td>
                              <td className="py-2 text-xs text-gray-600 dark:text-gray-300">
                                {(entry.missing_evidence || []).length > 0
                                  ? entry.missing_evidence?.join(' · ')
                                  : entry.user_action_label || 'Brak braków wykrytych przez silnik.'}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                {(defenseReadiness.blockingWarnings || []).length > 0 && (
                  <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-900/20 dark:text-amber-200">
                    <p className="font-semibold">Do sprawdzenia przed złożeniem:</p>
                    <ul className="mt-2 space-y-1">
                      {defenseReadiness.blockingWarnings.slice(0, 5).map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {defenseActionItems.length > 0 && (
                  <div className="mt-4 rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900 dark:border-sky-900 dark:bg-sky-900/20 dark:text-sky-100">
                    <p className="font-semibold">Co uzupełnić przed PIT</p>
                    <ul className="mt-2 space-y-2">
                      {defenseActionItems.slice(0, 8).map((item) => (
                        <li key={`${item.costId}-${item.userActionLabel}`}>
                          <span className="font-mono text-xs">{item.costId}</span>: {item.userActionLabel}
                          {(item.missingEvidence || []).length > 0 && (
                            <span className="block text-xs text-sky-700 dark:text-sky-200">
                              Braki: {item.missingEvidence?.join(' · ')}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
              </DeferredBrowserSection>
            )}

            <div className="bg-white dark:bg-gray-800 p-4 rounded-lg border border-gray-200 dark:border-gray-700">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="font-semibold text-gray-900 dark:text-white">Scenariusze podatkowe</h4>
                  <span className="text-xs text-gray-500">Domyślny plan: {planLabel(engineResult.plan_used || 'aggressive_user')}</span>
                </div>
              {showBuyOnlyTaxExplanation && (
                <div className="mb-4 rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900 dark:border-sky-900 dark:bg-sky-900/20 dark:text-sky-100">
                  <p className="font-semibold">To nie jest awaria silnika - w tym roku nie ma sprzedaży do rozliczenia.</p>
                  <p className="mt-1">
                    Silnik widzi zakupy inwestycyjne: {investmentBuyRows.length} i sprzedaże: 0. W PIT-38 przychód i koszt
                    z akcji pojawiają się dopiero przy sprzedaży, więc same zakupy zostają w lotach FIFO i przejdą do roku,
                    w którym pozycja zostanie sprzedana.
                  </p>
                </div>
              )}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                {scenarios.map((scenario) => (
                  <div key={scenario.scenario_name} className="rounded-lg border border-gray-200 dark:border-gray-700 p-4">
                    <div className="flex items-center justify-between mb-3">
                      <span className="font-semibold text-gray-900 dark:text-white">{planLabel(scenario.scenario_name)}</span>
                      <span className="text-xs px-2 py-1 rounded bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200">
                        {riskLabel(scenario.risk_level)}
                      </span>
                    </div>
                    <dl className="space-y-2 text-sm">
                      <div className="flex justify-between gap-3">
                        <dt className="text-gray-500">Wynik brutto</dt>
                        <dd className="font-medium text-gray-900 dark:text-white">{formatPln(scenario.gross_result_pln)}</dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt className="text-gray-500">Podstawa 19%</dt>
                        <dd className="font-medium text-gray-900 dark:text-white">{formatPln(scenario.taxable_base_pln)}</dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt className="text-gray-500">Podatek 19%</dt>
                        <dd className="font-medium text-gray-900 dark:text-white">{formatPln(scenario.tax_19_pln)}</dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt className="text-gray-500">Podatki z danych</dt>
                        <dd className="font-medium text-gray-900 dark:text-white">{formatPln(scenario.taxes_from_dane_pln)}</dd>
                      </div>
                      <div className="flex justify-between gap-3 pt-2 border-t border-gray-100 dark:border-gray-700">
                        <dt className="text-gray-500">Netto</dt>
                        <dd className="font-semibold text-indigo-700 dark:text-indigo-300">{formatPln(scenario.net_pln)}</dd>
                      </div>
                    </dl>
                    {scenario.additional_costs.length > 0 && (
                      <div className="mt-3">
                        <p className="text-xs uppercase tracking-wide text-gray-500 mb-1">Dodatkowo użyte koszty</p>
                        <div className="flex flex-wrap gap-2">
                          {scenario.additional_costs.map((cost) => (
                            <span key={cost} className="text-xs px-2 py-1 rounded bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
                              {costTagLabel(cost)}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="bg-white dark:bg-gray-800 p-4 rounded-lg border border-gray-200 dark:border-gray-700">
                <button
                  type="button"
                  onClick={() => setAuditExpanded((value) => !value)}
                  className="mb-3 flex w-full items-center justify-between gap-3 text-left"
                >
                  <span className="font-semibold text-gray-900 dark:text-white">Artefakty audytowe</span>
                  <span className="inline-flex items-center gap-2 text-xs text-gray-500">
                    {exportedFiles.length} {odmienLiczebnik(exportedFiles.length, 'plik', 'pliki', 'plików')}
                    <ChevronDown size={16} className={`transition-transform ${auditExpanded ? 'rotate-180' : ''}`} />
                  </span>
                </button>
                <p className="text-sm text-gray-500">
                  Hash przebiegu: <span className="font-mono text-gray-700 dark:text-gray-300">{engineResult.audit_hash || 'brak'}</span>
                </p>
                {auditExpanded && (
                  <div className="mt-3 space-y-2">
                    {exportedFiles.length > 0 ? exportedFiles.map((file) => (
                      <button
                        key={file}
                        disabled={!canUseEngineResult}
                        title={!canUseEngineResult ? 'Wynik NIEAKTUALNY — przelicz ponownie.' : undefined}
                        type="button"
                        onClick={async () => {
                          if (!canUseEngineResult) return;
                          setPackageDownloadError(null);
                          try {
                            await downloadTaxEngineArtifact(file);
                          } catch (error: unknown) {
                            setPackageDownloadError(getErrorMessage(error, 'Nie udało się pobrać artefaktu silnika.'));
                          }
                        }}
                        className="flex w-full items-center gap-2 text-left text-sm text-indigo-700 hover:text-indigo-800 dark:text-indigo-300 dark:hover:text-indigo-200"
                      >
                        <Download className="w-4 h-4 text-gray-400" />
                        <span className="break-all">{file}</span>
                      </button>
                    )) : (
                      <p className="text-sm text-gray-500">Brak wyeksportowanych plików.</p>
                    )}
                  </div>
                )}
              </div>

              <div className="bg-white dark:bg-gray-800 p-4 rounded-lg border border-gray-200 dark:border-gray-700">
                <button
                  type="button"
                  onClick={() => setIssueExpanded((value) => !value)}
                  className="mb-3 flex w-full items-center justify-between gap-3 text-left"
                >
                  <span className="font-semibold text-gray-900 dark:text-white">Log problemów silnika</span>
                  <span className="inline-flex items-center gap-2 text-xs text-gray-500">
                    {issues.length} wpisów
                    <ChevronDown size={16} className={`transition-transform ${issueExpanded ? 'rotate-180' : ''}`} />
                  </span>
                </button>
                {!issueExpanded ? (
                  <p className="text-sm text-gray-500">
                    {issues.length === 0 ? 'Brak problemów w bieżącym przebiegu.' : 'Rozwiń, aby zobaczyć szczegóły problemów.'}
                  </p>
                ) : issues.length === 0 ? (
                  <p className="text-sm text-gray-500">Brak problemów w bieżącym przebiegu.</p>
                ) : (
                  <div className="space-y-2 max-h-72 overflow-y-auto">
                    {issues.slice(0, 25).map((issue, index) => (
                      <div key={`${issue.code}-${index}`} className="rounded-lg border border-gray-200 dark:border-gray-700 p-3">
                        <div className="flex items-center justify-between gap-3">
                          <span className="font-mono text-xs text-gray-600 dark:text-gray-300">{issue.code}</span>
                          <span className={`text-xs px-2 py-1 rounded ${issue.severity === 'CRITICAL' ? 'bg-red-100 text-red-700' : issue.severity === 'ERROR' ? 'bg-orange-100 text-orange-700' : 'bg-yellow-100 text-yellow-700'}`}>
                            {statusLabel(issue.severity)}
                          </span>
                        </div>
                        <p className="text-sm text-gray-700 dark:text-gray-300 mt-2">{issue.message}</p>
                        <p className="text-xs text-gray-500 mt-1">
                          {issueStageLabel(issue.stage)} · {issueScopeLabel(issue.scope_type)} · {issueScopeLabel(issue.scope_id)}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            </>
            )}
          </div>
        )}
      </motion.div>
      )}
      {!isExpertMode && !onOpenInsight && localSimpleDrawer && (
        <InsightDrawer
          open={Boolean(simpleInsightDrawer)}
          title={localSimpleDrawer.title}
          subtitle={localSimpleDrawer.subtitle}
          onClose={() => setSimpleInsightDrawer(null)}
          sections={localSimpleDrawer.sections}
          actions={localSimpleDrawer.actions}
        />
      )}
    </div>
  );
}
