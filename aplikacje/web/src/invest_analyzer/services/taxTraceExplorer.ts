import type {
  DefenseEvidenceLink,
  PitSubmissionChecklistItem,
  ResultDeltaReportRow,
  TaxCalculationLedgerRow,
  TaxFilingPackageAuditAppendix,
  TaxTraceEntry,
  TaxTraceKind,
} from '../hooks/useTaxEngineRun';

export interface TaxTraceViewModel {
  entry: TaxTraceEntry;
  ledgerRows: TaxCalculationLedgerRow[];
  evidenceLinks: DefenseEvidenceLink[];
  checklistItems: PitSubmissionChecklistItem[];
  deltaRows: ResultDeltaReportRow[];
}

export interface HistoryNavigationTarget {
  searchTerm: string;
  rowId: string | null;
}

const TRACE_KIND_LABELS: Record<string, string> = {
  revenue: 'Przychody',
  base_cost: 'Koszty bazowe',
  aggressive_cost: 'Koszt aggressive_user',
  prior_year_loss: 'Straty z lat ubiegłych',
  tax_paid: 'Podatki z danych',
  rounding: 'Zaokrąglenia i wynik',
  checklist: 'Checklista PIT',
  delta: 'Zmiana wyniku',
};

const TRACE_RISK_LABELS: Record<string, string> = {
  low: 'Niskie',
  medium: 'Średnie',
  high: 'Wysokie',
};

function asArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function inferTraceKindFromLedgerLine(lineId: string): TaxTraceKind {
  if (lineId === 'REVENUE_TOTAL') return 'revenue';
  if (lineId === 'COST_TOTAL') return 'base_cost';
  if (lineId === 'AGGRESSIVE_COST_TOTAL' || lineId.startsWith('AGG_COST_')) return 'aggressive_cost';
  if (lineId === 'PRIOR_YEAR_LOSSES_USED') return 'prior_year_loss';
  if (lineId === 'TAXES_FROM_DATA') return 'tax_paid';
  if (lineId === 'TAX_19' || lineId === 'TAXABLE_BASE') return 'rounding';
  return 'delta';
}

function buildFallbackTraceIndex(auditAppendix: TaxFilingPackageAuditAppendix | null | undefined): TaxTraceEntry[] {
  const ledgerRows = asArray(auditAppendix?.tax_calculation_ledger?.rows);
  return ledgerRows.map((row) => {
    const kind = inferTraceKindFromLedgerLine(row.line_id);
    return {
      trace_id: `trace:${kind}:${row.line_id}`,
      kind,
      label: row.label || row.line_id,
      amount_pln: row.amount_pln ?? null,
      ledger_row_ids: [row.line_id],
      evidence_ids: [],
      checklist_item_ids: [],
      source_record_ids: [],
      tax_impact_kind: row.tax_effect || null,
      risk_level: null,
      explanation_pl: row.formula || row.tax_effect || 'Pozycja ledgeru podatkowego wygenerowana przez silnik.',
    };
  });
}

export function getTraceKindLabel(kind: string | TaxTraceKind | null | undefined): string {
  return TRACE_KIND_LABELS[String(kind || '')] || String(kind || 'Ścieżka kwoty');
}

export function getTraceRiskLabel(riskLevel: string | null | undefined): string {
  if (!riskLevel) return 'Brak specjalnego ryzyka';
  return TRACE_RISK_LABELS[riskLevel.toLowerCase()] || riskLevel;
}

export function formatTraceAmount(amount: string | number | null | undefined): string {
  if (amount == null || amount === '') return '—';
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return String(amount);
  return new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' }).format(numeric);
}

export function buildTaxTraceViewModels(
  auditAppendix: TaxFilingPackageAuditAppendix | null | undefined,
): TaxTraceViewModel[] {
  const traceIndex = asArray(auditAppendix?.tax_trace_index).length > 0
    ? asArray(auditAppendix?.tax_trace_index)
    : buildFallbackTraceIndex(auditAppendix);
  const ledgerRows = asArray(auditAppendix?.tax_calculation_ledger?.rows);
  const evidenceLinks = asArray(auditAppendix?.defense_evidence_links);
  const checklistItems = asArray(auditAppendix?.pit_submission_readiness?.checklist);
  const deltaRows = asArray(auditAppendix?.result_delta_report?.rows);

  return traceIndex.map((entry) => ({
    entry,
    ledgerRows: ledgerRows.filter((row) => entry.ledger_row_ids.includes(row.line_id)),
    evidenceLinks: evidenceLinks.filter((link) => entry.evidence_ids.includes(link.evidenceId)),
    checklistItems: checklistItems.filter((item) => entry.checklist_item_ids.includes(item.id)),
    deltaRows: deltaRows.filter((row) => entry.ledger_row_ids.includes(row.line_id)),
  }));
}

export function findTraceForLedgerLine(
  auditAppendix: TaxFilingPackageAuditAppendix | null | undefined,
  ledgerLineId: string,
): TaxTraceViewModel | null {
  return buildTaxTraceViewModels(auditAppendix)
    .find((trace) => trace.entry.ledger_row_ids.includes(ledgerLineId)) || null;
}

export function buildHistorySearchQueryFromTrace(trace: TaxTraceEntry | TaxTraceViewModel | null | undefined): string {
  return buildHistoryNavigationTargetFromTrace(trace).searchTerm;
}

export function buildHistoryNavigationTargetFromTrace(
  trace: TaxTraceEntry | TaxTraceViewModel | null | undefined,
): HistoryNavigationTarget {
  if (!trace) {
    return { searchTerm: '', rowId: null };
  }
  const entry = 'entry' in trace ? trace.entry : trace;
  const searchTerm = (
    entry.source_record_ids.find(Boolean)
    || entry.evidence_ids.find(Boolean)
    || entry.ledger_row_ids.find(Boolean)
    || entry.trace_id
    || ''
  );
  return {
    searchTerm,
    rowId: entry.source_record_ids.find(Boolean) || null,
  };
}
