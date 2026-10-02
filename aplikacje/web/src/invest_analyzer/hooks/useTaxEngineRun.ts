import { useCallback, useEffect, useRef, useState } from 'react';
import type { TaxPackageRequestOptions } from '../services/taxEngineConfig';
import { przygotujZadanieSilnika } from '../services/taxEngineRequestFactory';
import { opublikujWynikSilnika } from '../services/ostatniWynikSilnika';
import { getErrorMessage } from '../services/errorMessage';
import { runtimeApi } from '../services/runtimeApi';
import type { TaxEngineJobStatus } from '../services/runtimeApi.types';
export { parseTaxEngineResponseText } from '../services/taxEngineResponse';
import { taxResultFreshness } from '../services/taxResultFreshness';

export interface EngineIssue {
  code: string;
  severity: string;
  stage: string;
  scope_type: string;
  scope_id: string;
  message: string;
  blocking: boolean;
  details?: Record<string, unknown>;
}

export interface TaxFormField {
  section: string;
  position: string;
  label: string;
  value?: string | null;
  value_type?: 'money' | 'percent' | 'text' | string;
  note?: string | null;
  manual_entry?: boolean;
}

export interface TaxScenarioProjection {
  scenario_name: string;
  revenue_pln: string;
  cost_pln: string;
  income_pln: string;
  rounded_base_pln: string;
  silnik_tax_pln: string;
  rounded_tax_from_base_pln: string;
  tax_due_pln: string;
  gross_dividend_pln: string;
  foreign_dividend_tax_pln: string;
  foreign_tax_credit_pln: string;
  form_fields: TaxFormField[];
}

export type DefenseStatus = 'complete' | 'needs_user_evidence' | 'missing_link' | 'high_risk_review';

export interface DefenseActionItem {
  costId: string;
  kind?: string;
  amountPln?: string;
  sourceRecordId?: string | null;
  defenseStatus: DefenseStatus;
  riskLevel?: 'low' | 'medium' | 'high' | string;
  userActionLabel: string;
  missingEvidence?: string[];
}

export interface DefenseReadinessSummary {
  score: number;
  totalAggressiveItems: number;
  completeItems: number;
  missingEvidenceItems: number;
  highRiskItems: number;
  blockingWarnings: string[];
  status_counts?: Record<string, number>;
  kind_totals_pln?: Record<string, string>;
  duplicate_cost_ids?: string[];
  actionItems?: DefenseActionItem[];
}

export interface AggressiveCostDefenseEntry {
  cost_id: string;
  kind: string;
  amount_pln?: string | null;
  source_id?: string | null;
  source_record_id?: string | null;
  allocation_target?: string | null;
  tax_event_date?: string | null;
  currency?: string | null;
  defense_status: DefenseStatus;
  defense_status_label_pl: string;
  missing_evidence?: string[];
  risk_level?: string;
  risk_level_key?: 'low' | 'medium' | 'high' | string;
  evidence_id?: string;
  user_action_label?: string;
  linked_trade_id?: string | null;
  linked_trade_date?: string | null;
  linked_trade_symbol?: string | null;
  tax_argument_pl?: string;
  amount_reconciliation?: Record<string, string | null>;
  defense_status_source?: string;
  user_note?: string | null;
  evidence_confirmed?: boolean;
  checked_at?: string | null;
  included_in_filing_package?: boolean;
}

export interface DefenseEvidenceGroup {
  group_id: string;
  kind?: string | null;
  label_pl: string;
  amount_pln?: string | null;
  cost_ids: string[];
  source_record_ids: string[];
  missing_evidence: string[];
  context_label?: string | null;
  context_ids?: string[];
  item_count: number;
  date_from?: string | null;
  date_to?: string | null;
  defense_status: DefenseStatus | string;
  defense_status_label_pl: string;
  risk_level?: 'low' | 'medium' | 'high' | string;
  items?: Array<Record<string, unknown>>;
}

export interface DefenseEvidenceLink {
  evidenceId: string;
  costId: string;
  sourceRecordId: string;
  sourceFile?: string | null;
  rawRowRef?: string | null;
  linkedTradeIds: string[];
  amountPln: string;
  defenseStatus: DefenseStatus;
  missingEvidence: string[];
  userActionLabel: string;
  riskLevel: 'low' | 'medium' | 'high' | string;
  taxImpact?: string;
  amountReconciliation?: Record<string, string | null>;
  defenseStatusSource?: string;
  userNote?: string | null;
  evidenceConfirmed?: boolean;
  checkedAt?: string | null;
  includedInFilingPackage?: boolean;
}

export interface TaxCalculationLedgerRow {
  line_id: string;
  section?: string;
  label?: string;
  amount_pln?: string | null;
  source?: string;
  tax_effect?: string;
  formula?: string;
  inputs?: Record<string, unknown>;
  notes?: string[];
}

export interface TaxCalculationLedger {
  version?: number;
  tax_year?: number | string;
  plan_used?: string;
  primary_scenario?: string;
  rows: TaxCalculationLedgerRow[];
  metadata?: Record<string, unknown>;
}

export interface ResultDeltaReportRow {
  line_id: string;
  label?: string;
  change_type: 'added' | 'removed' | 'changed' | string;
  previous_amount_pln?: string | null;
  current_amount_pln?: string | null;
  delta_pln?: string | null;
  reason?: string;
}

export interface ResultDeltaReport {
  status: 'NO_BASELINE' | 'UNCHANGED' | 'CHANGED' | string;
  summary: string;
  rows: ResultDeltaReportRow[];
}

export interface DefenseGapSummary {
  total_gaps: number;
  by_status?: Record<string, number>;
  by_kind?: Record<string, number>;
  gaps?: Array<Record<string, unknown>>;
  action_items?: DefenseActionItem[];
}

export type PitSubmissionVerdict = 'READY' | 'READY_WITH_RISK' | 'NEEDS_EVIDENCE' | 'BLOCKED';
export type PitSubmissionChecklistSeverity = 'blocking' | 'evidence' | 'risk' | 'info';
export type PitSubmissionChecklistCategory = 'nbp' | 'dane_quality' | 'defense' | 'calculation' | 'reconciliation';

export interface PitSubmissionChecklistItem {
  id: string;
  severity: PitSubmissionChecklistSeverity;
  category: PitSubmissionChecklistCategory;
  label: string;
  userAction: string;
  linkedCostId?: string;
  linkedRowId?: string;
  sourceId?: string;
}

export interface PitSubmissionReadiness {
  verdict: PitSubmissionVerdict;
  score: number;
  recommendedAction: PitSubmissionChecklistItem | null;
  checklist: PitSubmissionChecklistItem[];
  generatedAt: string;
  counts?: Record<PitSubmissionChecklistSeverity, number>;
}

export type TaxTraceKind =
  | 'revenue'
  | 'base_cost'
  | 'aggressive_cost'
  | 'prior_year_loss'
  | 'tax_paid'
  | 'rounding'
  | 'checklist'
  | 'delta';

export interface TaxTraceEntry {
  trace_id: string;
  kind: TaxTraceKind | string;
  label: string;
  amount_pln: string | number | null;
  ledger_row_ids: string[];
  evidence_ids: string[];
  checklist_item_ids: string[];
  source_record_ids: string[];
  tax_impact_kind?: string | null;
  risk_level?: 'low' | 'medium' | 'high' | string | null;
  explanation_pl: string;
}

export interface PitCaseFile {
  case_file_id: string;
  generated_at: string;
  tax_year: string;
  plan_used?: string;
  filing_profile?: string;
  primary_scenario?: string;
  audit_hash?: string;
  status?: string;
  filing_ready?: boolean;
  reproducible: boolean;
  reproducibility_status: string;
  input_fingerprint: string;
  calculation_fingerprint: string;
  package_sections?: Record<string, number>;
  included_artifacts?: string[];
  replay_instructions_pl?: string[];
  warnings?: string[];
}

export interface BrokerFileSourceManifest {
  sourceId: string;
  filename?: string | null;
  relativePath?: string | null;
  hash?: string | null;
  detectedType?: string | null;
  sections?: string[];
  recordCounts?: Record<string, number>;
  dateRange?: { from?: string | null; to?: string | null };
  contributesToCanonicalInput?: boolean;
  contributesToTax?: boolean;
  fileRole?: string | null;
  warnings?: string[];
  errors?: string[];
  sourceResolutionRole?: string | null;
  sourceResolutionReason?: string | null;
  sourceResolutionScore?: number | null;
}

export interface BrokerStorageResolvedSource {
  sourceId: string;
  filename: string;
  relativePath?: string | null;
  hash?: string | null;
  detectedType?: string | null;
  role: string;
  dateRange?: { from?: string | null; to?: string | null };
  score?: number;
  reason?: string;
  sections?: string[];
  recordCounts?: Record<string, number>;
}

export interface SourceResolutionReport {
  storageDir?: string;
  sources?: BrokerStorageResolvedSource[];
  selected?: {
    primaryTax?: string | null;
    reconciliation?: string | null;
  };
  winners?: BrokerStorageResolvedSource[];
  fallbacks?: BrokerStorageResolvedSource[];
}

export interface SourceResolutionPreview {
  storageDir?: string;
  mode?: string;
  activePolicy?: string;
  summary?: {
    sourceCount?: number;
    reportSourceCount?: number;
    storedSourceCount?: number;
    evidenceSourceCount?: number;
  };
  sources?: BrokerStorageResolvedSource[];
  recommendedActions?: string[];
}

export interface CandidateSourceRun {
  source_id: string;
  filename: string;
  detected_type: string;
  status: string;
  reason: string;
  record_count?: number;
  trade_row_count?: number;
  buy_count?: number;
  sell_count?: number;
  date_range?: { from?: string | null; to?: string | null };
  taxReadinessStatus?: string;
  taxReadinessReasons?: string[];
  candidateTaxPreview?: CandidateTaxPreview;
}

export interface CandidateTaxPreview {
  revenuePln?: string | null;
  costPln?: string | null;
  sellRows?: number;
  buyRows?: number;
  historyRows?: number;
  blockingIssues?: number;
  previewStatus?: string;
  note?: string;
}

export interface CandidateTransactionPreviewRow {
  previewRowId: string;
  candidateSourceId: string;
  filename: string;
  displayDate?: string | null;
  side?: string | null;
  ticker?: string | null;
  amount?: string | null;
  currency?: string | null;
  previewStatus?: string;
  doesAffectPit: false;
  message?: string | null;
}

export interface ResultHealthCheck {
  status: 'ok' | 'needs_review' | 'blocked';
  headline: string;
  reasons: string[];
  activeTaxSourceIds: string[];
  activeTaxSourceLabels: string[];
  recognizedStorageFileCount: number;
  taxHistoryRowCount: number;
  sellRowCount: number;
  revenuePln: string;
  costPln: string;
  suspicious_zero_result?: boolean;
  checks?: Array<{
    check_id: string;
    status: 'pass' | 'warn' | 'fail' | string;
    severity: 'info' | 'warning' | 'blocking' | string;
    message_pl: string;
  }>;
  review_reasons?: string[];
  warnings?: string[];
}

export type SourceUsageStatus =
  | 'transaction_source'
  | 'transaction_report'
  | 'source_evidence'
  | 'nbp_rates'
  | 'position_reconciliation'
  | 'data_context'
  | 'duplicate_source'
  | 'technical_source'
  | 'source_review';

export interface SourceTrustItem {
  source_id: string;
  file_name: string;
  file_path?: string | null;
  file_hash: string;
  file_type: 'json' | 'xlsx' | 'xls' | 'csv' | 'pdf' | 'xml' | 'unknown' | string;
  detected_role: string;
  usage_status: SourceUsageStatus | string;
  tax_years_detected?: number[];
  broker?: string | null;
  account_id_hint?: string | null;
  record_counts?: Record<string, number>;
  quality?: {
    parse_ok?: boolean;
    has_required_columns?: boolean | null;
    has_dates?: boolean;
    has_amounts?: boolean;
    has_currencies?: boolean | null;
    has_transaction_ids?: boolean | null;
    nbp_coverage_ok?: boolean;
    ledger_consistency_ok?: boolean;
    duplicate_risk?: 'none' | 'low' | 'medium' | 'high' | string;
    confidence?: 'low' | 'medium' | 'high' | string;
  };
  review_reasons?: string[];
  warnings?: string[];
  lineage?: Record<string, string | number | null | undefined>;
}

export interface SourceTrustSummary {
  contract_version?: string;
  generated_at?: string;
  tax_year?: number | string | null;
  items?: SourceTrustItem[];
  summary?: {
    source_count?: number;
    transaction_source_count?: number;
    report_source_count?: number;
    review_needed_source_count?: number;
    status_counts?: Record<string, number>;
  };
  source_ids?: string[];
  review_reasons?: string[];
}

export interface StorageSmokeReport {
  generated_at?: string;
  storage_loaded?: boolean;
  active_tax_years?: number[];
  checks?: Record<string, boolean | null | undefined>;
  status?: 'pass' | 'warn' | 'fail' | string;
  warnings?: string[];
  errors?: string[];
}

export interface NbpCoverageReport {
  tax_year?: number | string | null;
  required_rates?: number;
  found_rates?: number;
  missing_rates?: number;
  missing?: Array<{
    date: string;
    currency: string;
    linked_record_ids?: string[];
    severity?: 'blocking' | 'warning' | string;
    reason?: string;
  }>;
  status?: 'pass' | 'warn' | 'fail' | string;
}

export interface TaxAdvisorBrief {
  generated_at?: string;
  summary?: Record<string, string | number | null | undefined>;
  result_health_check?: ResultHealthCheck;
  active_tax_sources?: Array<Record<string, unknown>>;
  source_files?: Array<Record<string, unknown>>;
  aggressive_costs?: Array<Record<string, unknown>>;
  defense_readiness?: DefenseReadinessSummary;
  evidence_to_keep?: Array<Record<string, unknown>>;
  risks?: Array<Record<string, unknown>>;
  advisor_questions?: string[];
  markdown?: string;
  legal_notice?: string;
}

export interface SourceReconciliationComparedSource {
  sourceId: string;
  filename: string;
  role: string;
  matchedCount: number;
  primaryOnlyCount: number;
  supplementalOnlyCount: number;
  duplicateCount: number;
  dateRangeGap: boolean;
  confidenceScore: number;
  status: 'matched' | 'partial' | 'duplicate' | 'fallback_only' | 'needs_review' | string;
  message: string;
  supplementalOnlyBreakdown?: Array<{
    kind: string;
    label: string;
    count: number;
  }>;
}

export interface SourceReconciliationReport {
  primarySourceId?: string | null;
  comparedSources?: SourceReconciliationComparedSource[];
  summary?: {
    confidenceScore?: number;
    matchedSources?: number;
    needsReviewSources?: number;
    duplicateSources?: number;
    supplementalOnlyRecords?: number;
  };
  recommendedActions?: string[];
}

export interface ImportIntelligenceReport {
  sources?: BrokerFileSourceManifest[];
  duplicates?: Array<Record<string, unknown>>;
  conflicts?: Array<Record<string, unknown>>;
  missingExpectedSections?: string[];
  recommendedActions?: string[];
}

export interface NoOverpayCandidateCost {
  costId: string;
  kind?: string;
  labelPl?: string;
  amountPln?: string | null;
  sourceId?: string | null;
  taxEventDate?: string | null;
  currency?: string | null;
  included?: boolean;
  status?: string;
  reason?: string;
  evidenceLevel?: string | null;
  allocationTarget?: string | null;
  derivedCost?: boolean;
  notes?: string[];
}

export interface NoOverpayAudit {
  candidateCosts?: NoOverpayCandidateCost[];
  excludedCosts?: NoOverpayCandidateCost[];
  duplicateRisks?: Array<Record<string, unknown>>;
  technicalRows?: Array<Record<string, unknown>>;
  missingEvidence?: Array<Record<string, unknown>>;
  recommendedActions?: string[];
  confidenceScore?: number;
  summary?: {
    candidateCostCount?: number;
    excludedCostCount?: number;
    duplicateRiskCount?: number;
    technicalRowCount?: number;
    missingEvidenceCount?: number;
    plan?: string;
  };
}

export interface DefenseCaseFile {
  summary?: {
    source_count?: number;
    candidate_cost_count?: number;
    excluded_cost_count?: number;
    duplicate_risk_count?: number;
    missing_evidence_count?: number;
    defense_group_count?: number;
  };
  sourceManifests?: BrokerFileSourceManifest[];
  importIntelligence?: {
    missingExpectedSections?: string[];
    recommendedActions?: string[];
  };
  costEvidenceLinks?: DefenseEvidenceLink[];
  defenseGroups?: DefenseEvidenceGroup[];
  noOverpaySummary?: NoOverpayAudit['summary'];
  recommendedActions?: string[];
}

export interface CoverageMatrixEntry {
  area: string;
  label: string;
  status: 'complete' | 'partial' | 'missing' | 'conflict' | 'not_applicable' | string;
  recordCount?: number;
  issueCount?: number;
  sourceIds?: string[];
  recommendation?: string;
}

export interface BrokerFileControlTower {
  summary?: {
    source_count?: number;
    canonical_source_count?: number;
    context_source_count?: number;
    duplicate_count?: number;
    conflict_count?: number;
    missing_coverage_count?: number;
    candidate_cost_count?: number;
  };
  sections?: {
    what_was_imported?: BrokerFileSourceManifest[];
    canonical_sources?: BrokerFileSourceManifest[];
    context_sources?: BrokerFileSourceManifest[];
    missing?: CoverageMatrixEntry[];
  };
  recommendedActions?: string[];
}

export interface BrokerFileActionQueueItem {
  action_id: string;
  severity: 'blocking' | 'warning' | 'info' | string;
  area: string;
  label: string;
  user_action: string;
  source_ids?: string[];
  cost_ids?: string[];
  history_search_term?: string | null;
  default_status: 'open' | string;
  reason: string;
  user_status?: 'open' | 'resolved' | 'ignored' | string;
  user_note?: string | null;
  linked_row_id?: string | null;
  status_source?: string;
  supplemental_only_breakdown?: Array<{
    kind: string;
    label: string;
    count: number;
  }>;
  supplemental_only_breakdown_label?: string | null;
}

export interface NoOverpayAuditV2 {
  summary?: NoOverpayAudit['summary'] & {
    potentiallyMissedCount?: number;
    confidenceScore?: number;
  };
  candidateCosts?: NoOverpayCandidateCost[];
  potentiallyMissedCosts?: Array<NoOverpayCandidateCost & {
    overpayRisk?: string;
    userAction?: string;
  }>;
  duplicateRisks?: Array<Record<string, unknown>>;
  technicalRows?: Array<Record<string, unknown>>;
  missingEvidence?: Array<Record<string, unknown>>;
  coverageMatrix?: CoverageMatrixEntry[];
  statusSummary?: Record<string, number>;
  recommendedActions?: string[];
}

export interface NoOverpayAuditV3 {
  tax_year?: number | string | null;
  generated_at?: string;
  summary?: {
    counted_total_pln?: string | number;
    candidate_total_pln?: string | number;
    requires_evidence_total_pln?: string | number;
    duplicate_risk_total_pln?: string | number;
    excluded_total_pln?: string | number;
  };
  sections?: Array<{
    section_id: string;
    title_pl: string;
    items: Array<{
      item_id: string;
      linked_record_ids?: string[];
      amount_original?: number | null;
      currency_original?: string | null;
      amount_pln?: string | number | null;
      decision: 'counted' | 'not_counted_technical' | 'candidate' | 'requires_evidence' | 'duplicate_risk' | 'excluded_by_policy' | 'advisor_review' | string;
      confidence?: 'low' | 'medium' | 'high' | string;
      reason_pl?: string;
      evidence_status?: 'not_needed' | 'missing' | 'partial' | 'available' | 'advisor_required' | string;
      duplicate_risk?: Record<string, unknown> | null;
      advisor_question_pl?: string | null;
    }>;
  }>;
}

export interface DefenseVaultSummary {
  contract_version?: string;
  generated_at?: string;
  items?: Array<{
    evidence_id: string;
    title: string;
    description?: string | null;
    evidence_type?: string;
    file_ref?: {
      path?: string | null;
      file_name?: string | null;
      file_hash?: string | null;
      last_seen_at?: string | null;
    };
    status?: 'missing' | 'to_collect' | 'available' | 'partial' | 'not_needed' | 'advisor_review' | string;
    linked_record_ids?: string[];
    linked_source_ids?: string[];
    linked_no_overpay_item_ids?: string[];
    user_note?: string | null;
    checklist?: Array<{ item_id: string; label_pl: string; done: boolean }>;
    created_at?: string;
    updated_at?: string;
  }>;
  summary?: Record<string, number | Record<string, number> | undefined>;
}

export interface AdvisorReviewPack {
  tax_year?: number | string | null;
  generated_at?: string;
  result?: Record<string, string | number | null | undefined>;
  health?: ResultHealthCheck;
  active_sources?: SourceTrustItem[];
  candidate_sources?: Array<Record<string, unknown>>;
  no_overpay_summary?: NoOverpayAuditV3['summary'];
  risk_summary?: {
    blocking_issues?: string[];
    warnings?: string[];
    advisor_questions?: string[];
  };
  evidence_summary?: Record<string, number | undefined>;
  files?: Array<{
    source_id?: string;
    file_name?: string;
    usage_status?: string;
    file_hash?: string;
  }>;
  audit?: Record<string, string | number | null | undefined>;
}

export interface DefenseCaseFileV2 {
  summary?: {
    defense_chain_count?: number;
    high_risk_count?: number;
    missing_evidence_count?: number;
    legal_basis_count?: number;
    [key: string]: unknown;
  };
  defenseChains?: Array<Record<string, unknown>>;
  groupedEvidence?: DefenseEvidenceGroup[];
  sourceManifests?: BrokerFileSourceManifest[];
  recommendedActions?: string[];
}

export interface LegalBasisEntry {
  basisId: string;
  label: string;
  source?: string;
  url?: string;
  scope?: string;
  riskNote?: string;
}

export interface AutoFileRecognitionReport {
  sources?: Array<BrokerFileSourceManifest & {
    fileRole?: string;
    reason?: string | null;
  }>;
  summary?: {
    recognizedSourceCount?: number;
    transactionSourceCount?: number;
    transactionReportCount?: number;
    evidenceSourceCount?: number;
    reconciliationSourceCount?: number;
    analyticsSourceCount?: number;
    nbpRateSourceCount?: number;
    rawDataSourceCount?: number;
    roleCounts?: Record<string, number>;
    detectedTypeCounts?: Record<string, number>;
  };
}

export interface AggressiveCostCoverageAudit {
  categories?: Array<{
    kind: string;
    labelPl?: string;
    status?: "included" | "recognized_not_counted" | "not_present_in_dane" | string;
    candidateCount?: number;
    includedCount?: number;
    candidateAmountPln?: string | null;
    includedAmountPln?: string | null;
    costIds?: string[];
    defenseStatuses?: string[];
    riskLevels?: string[];
    missingEvidence?: string[];
    userAction?: string;
  }>;
  summary?: {
    plan?: string;
    categoryCount?: number;
    includedCategoryCount?: number;
    recognizedNotCountedCategoryCount?: number;
    missingCategoryCount?: number;
    blocksFiling?: boolean;
  };
}

export interface TaxFilingPackageAuditAppendix {
  issues?: Array<Record<string, unknown>>;
  cost_decisions?: Array<Record<string, unknown>>;
  aggressive_cost_defense?: AggressiveCostDefenseEntry[];
  defense_evidence_groups?: DefenseEvidenceGroup[];
  defense_evidence_links?: DefenseEvidenceLink[];
  defense_readiness?: DefenseReadinessSummary;
  tax_calculation_ledger?: TaxCalculationLedger;
  result_delta_report?: ResultDeltaReport;
  defense_gap_summary?: DefenseGapSummary;
  pit_submission_readiness?: PitSubmissionReadiness;
  tax_trace_index?: TaxTraceEntry[];
  pit_case_file?: PitCaseFile;
  source_resolution_report?: SourceResolutionReport | null;
  source_resolution_preview?: SourceResolutionPreview | null;
  candidate_source_runs?: CandidateSourceRun[];
  candidate_transaction_preview_rows?: CandidateTransactionPreviewRow[];
  canonical_storage_history_rows?: EngineHistoryRow[];
  storage_lineage_index?: Record<string, unknown>;
  canonical_storage_history_summary?: Record<string, unknown>;
  source_registry?: Array<Record<string, unknown>>;
  normalized_storage_manifest?: Array<Record<string, unknown>>;
  normalized_events?: Array<Record<string, unknown>>;
  canonical_tax_input?: Record<string, unknown>;
  canonical_tax_input_summary?: Record<string, unknown>;
  tax_input_build_report?: Record<string, unknown>;
  canonical_tax_input_path?: string;
  canonical_tax_input_consumption?: Record<string, unknown>;
  canonical_tax_input_consumption_runtime?: Record<string, unknown>;
  ai_document_classification?: Array<Record<string, unknown>>;
  ai_column_mappings?: Array<Record<string, unknown>>;
  transaction_dossiers?: Array<Record<string, unknown>>;
  transaction_dossier_summary?: Record<string, unknown>;
  transaction_conflicts?: Array<Record<string, unknown>>;
  field_source_map?: Record<string, unknown>;
  evidence_index?: Array<Record<string, unknown>>;
  ai_extracted_context?: Array<Record<string, unknown>>;
  ai_validation_report?: Record<string, unknown>;
  result_health_check?: ResultHealthCheck;
  source_trust_summary?: SourceTrustSummary;
  storage_smoke_report?: StorageSmokeReport;
  nbp_coverage_report?: NbpCoverageReport;
  source_reconciliation_report?: SourceReconciliationReport | null;
  source_manifest_v2?: BrokerFileSourceManifest[];
  auto_file_recognition_report?: AutoFileRecognitionReport;
  import_intelligence_report?: ImportIntelligenceReport;
  no_overpay_audit?: NoOverpayAudit;
  aggressive_cost_coverage_audit?: AggressiveCostCoverageAudit;
  defense_case_file?: DefenseCaseFile;
  broker_file_control_tower?: BrokerFileControlTower;
  broker_file_action_queue?: BrokerFileActionQueueItem[];
  coverage_matrix?: CoverageMatrixEntry[];
  no_overpay_audit_v2?: NoOverpayAuditV2;
  no_overpay_audit_v3?: NoOverpayAuditV3;
  defense_vault_summary?: DefenseVaultSummary;
  defense_case_file_v2?: DefenseCaseFileV2;
  legal_basis_registry?: LegalBasisEntry[];
  memorandum_aggressive_user?: string;
  aggressive_user_memorandum?: string;
  tax_advisor_brief?: TaxAdvisorBrief;
  advisor_review_pack?: AdvisorReviewPack;
  legal_safety_notice?: string;
}

export interface EngineHistoryRow {
  row_id: string;
  parent_row_id: string | null;
  row_kind: string;
  display_date?: string | null;
  base_record_id?: string | null;
  manual_record_id?: string | null;
  transaction_id?: string | null;
  ticker?: string | null;
  side?: string | null;
  quantity?: string | null;
  amount?: string | null;
  currency?: string | null;
  amount_pln?: string | null;
  comment?: string | null;
  message?: string | null;
  source_name?: string | null;
  source_manifest_id?: string | null;
  conflict_count?: number | null;
  tax_impact_label?: string | null;
  tax_impact_kind?: string | null;
  is_technical_only?: boolean | null;
  tax_impact_label_pl?: string | null;
  display_category?: string | null;
  display_category_label_pl?: string | null;
  display_category_label_en?: string | null;
  lineage_summary?: string | null;
  dedupe_status?: string | null;
  defense_status?: DefenseStatus | string | null;
  evidence_count?: number | null;
  missing_evidence_count?: number | null;
  source_refs?: string[];
  provenance?: Array<Record<string, unknown>>;
  logical_world?: string;
  acquisition_mode?: string | null;
  grant_tax_status?: string | null;
  grant_value_pln?: string | null;
  pit_result_pln?: string | null;
  economic_result_pln?: string | null;
  deposit_id?: string | null;
  deposit_amount?: string | null;
  allocation_ratio?: string | null;
  allocation_method?: string | null;
  overlay_status?: string;
  is_modified?: boolean;
  is_new?: boolean;
  modified_fields?: string[];
  original_snapshot?: Record<string, unknown>;
  current_snapshot?: Record<string, unknown>;
  read_only?: boolean;
  details?: Record<string, unknown>;
}

export interface PrivateCashFxViewRow {
  row_id: string;
  source_event_id: string;
  use_reference: string;
  currency: string;
  quantity: string;
  source_fx_rate: string;
  use_fx_rate: string;
  pnl_pln: string;
  source_date?: string | null;
  use_date?: string | null;
  note?: string | null;
}

export interface EngineEditableRecord {
  base_record_id: string | null;
  manual_record_id: string;
  record_type: string;
  overlay_status: string;
  deleted: boolean;
  original_values: Record<string, string | null>;
  current_values: Record<string, string | null>;
  modified_fields: string[];
  validation_state: {
    is_valid: boolean;
    status: string;
    errors: string[];
    warnings: string[];
  };
  diffs: Array<{
    field_name: string;
    original_value: string | null;
    current_value: string | null;
  }>;
  title?: string | null;
  ticker?: string | null;
  display_date?: string | null;
  source_name?: string | null;
}

export interface ScenarioResult {
  scenario_name: string;
  risk_level: string;
  gross_result_pln: string;
  taxable_base_pln: string;
  tax_19_pln: string;
  taxes_from_dane_pln: string;
  net_pln: string;
  total_revenue_pln: string;
  total_cost_pln: string;
  delta_vs_defensible_pln: string;
  additional_costs: string[];
  notes: string[];
}

/**
 * Rejestr finansowania ujemnego salda.
 *
 * Epizod to nieprzerwany okres, w ktorym konto pozostawalo na minusie:
 * od dnia powstania dlugu do dnia jego uregulowania, z odsetkami naliczanymi
 * za kazdy dzien kalendarzowy.
 */
export interface FinancingEpisode {
  episode_id: string;
  currency: string;
  opened_on: string;
  last_charged_on: string;
  settled_on: string | null;
  is_open: boolean;
  charged_days: number;
  total_interest: string;
  total_interest_pln: string | null;
  daily_rate_used: string | null;
  /** Kapital obciazony danym naliczeniem. */
  peak_principal: string | null;
  average_principal: string | null;
  /** "broker_comment" gdy saldo pochodzi z zapisu brokera, "derived_from_rate" gdy oszacowane. */
  principal_source: string | null;
}

export interface FinancingLedger {
  schema_version: string;
  tax_year: number | null;
  episode_count: number;
  charged_days: number;
  open_episode_count: number;
  total_interest_pln: string | null;
  by_currency: Record<string, {
    episodes: number;
    charged_days: number;
    total_interest: string;
    peak_principal: string | null;
  }>;
  episodes: FinancingEpisode[];
}

export interface TaxEngineResponse {
  success?: boolean;
  status?: string;
  filing_ready?: boolean;
  plan_used?: string;
  filing_profile?: string;
  primary_scenario?: string;
  active_tax_years?: number[];
  tax_years_detected?: number[];
  annual_summary?: Record<string, string>;
  scenario_results?: Record<string, ScenarioResult>;
  funding_fee_allocations?: Array<Record<string, string>>;
  tax_filing_package?: {
    draft?: {
      tax_year?: number;
      form_type?: string;
      filing_mode?: string;
      package_scope?: string;
      plan_used?: string;
      filing_ready?: boolean;
      main_fields?: Record<string, string>;
      form_fields?: TaxFormField[];
      scenario_projections?: Record<string, TaxScenarioProjection>;
    };
    calculation?: { sections?: Array<Record<string, unknown>> } | null;
    justification?: { summary?: string } | null;
    audit_appendix?: TaxFilingPackageAuditAppendix | null;
  } | null;
  audit_hash?: string;
  issue_count?: number;
  informational_issue_count?: number;
  issues?: EngineIssue[];
  actionable_issues?: EngineIssue[];
  informational_issues?: EngineIssue[];
  transaction_history_rows?: EngineHistoryRow[];
  private_cash_fx_view?: PrivateCashFxViewRow[];
  editable_records?: EngineEditableRecord[];
  exported_files?: string[];
  // Silnik zwraca tu pelny raport bramek jakosci. Typ deklarowal tylko metryki,
  // wiec odczyt list niespojnosci nie byl sprawdzany - a bez @types/react cala
  // warstwa Reacta i tak nie przechodzila kontroli typow.
  quality_report?: {
    filing_ready?: boolean;
    final_status?: string;
    blocking_issues?: EngineIssue[];
    warning_issues?: EngineIssue[];
    informational_issues?: EngineIssue[];
    metrics?: Record<string, number>;
  };
  tax_readiness?: {
    year: number;
    score: number;
    blockingIssues: number;
    warnings: number;
    nbpGaps: number;
    sourceConflicts: number;
    unclassifiedEvents: number;
  };
  fx_coverage_gaps?: Array<Record<string, string>>;
  depo_reconciliation?: Array<Record<string, string | boolean>>;
  financing_ledger?: FinancingLedger;
  source_resolution_preview?: SourceResolutionPreview | null;
  candidate_source_runs?: CandidateSourceRun[];
  candidate_transaction_preview_rows?: CandidateTransactionPreviewRow[];
  canonical_storage_history_rows?: EngineHistoryRow[];
  storage_lineage_index?: Record<string, unknown>;
  canonical_storage_history_summary?: Record<string, unknown>;
  source_registry?: Array<Record<string, unknown>>;
  normalized_storage_manifest?: Array<Record<string, unknown>>;
  normalized_events?: Array<Record<string, unknown>>;
  canonical_tax_input?: Record<string, unknown>;
  canonical_tax_input_summary?: Record<string, unknown>;
  tax_input_build_report?: Record<string, unknown>;
  canonical_tax_input_path?: string;
  canonical_tax_input_consumption?: Record<string, unknown>;
  canonical_tax_input_consumption_runtime?: Record<string, unknown>;
  ai_document_classification?: Array<Record<string, unknown>>;
  ai_column_mappings?: Array<Record<string, unknown>>;
  transaction_dossiers?: Array<Record<string, unknown>>;
  transaction_dossier_summary?: Record<string, unknown>;
  transaction_conflicts?: Array<Record<string, unknown>>;
  field_source_map?: Record<string, unknown>;
  evidence_index?: Array<Record<string, unknown>>;
  ai_extracted_context?: Array<Record<string, unknown>>;
  ai_validation_report?: Record<string, unknown>;
  error?: string;
}

export function useTaxEngineRun(selectedYear: number, enabled: boolean, dependencyKey: string) {
  const [engineLoading, setEngineLoading] = useState(false);
  const [packageLoading, setPackageLoading] = useState(false);
  const [silnikJobStatus, setEngineJobStatus] = useState<TaxEngineJobStatus | null>(null);
  const [engineResult, setEngineResult] = useState<TaxEngineResponse | null>(null);
  const [resultYear, setResultYear] = useState<number | null>(null);
  const [resultKey, setResultKey] = useState<string | null>(null);
  const [resultDependencyKey, setResultDependencyKey] = useState<string | null>(null);
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  const [lastRunFailed, setLastRunFailed] = useState(false);
  const latestRequestId = useRef(0);
  const activeJobIdRef = useRef<string | null>(null);

  const runPythonEngine = useCallback(async (packageRequest?: string | TaxPackageRequestOptions, forceRecalculate = false) => {
    const requestId = latestRequestId.current + 1;
    latestRequestId.current = requestId;
    setCurrentKey(null);
    setLastRunFailed(false);
    const packageScope = typeof packageRequest === 'string' ? packageRequest : packageRequest?.packageScope;
    if (packageScope) {
      setPackageLoading(true);
    } else {
      setEngineLoading(true);
    }
    let shouldStopOllamaAfterRun = false;
    try {
      if (activeJobIdRef.current) {
        runtimeApi.cancelTaxEngineJob(activeJobIdRef.current).catch(() => undefined);
        activeJobIdRef.current = null;
      }
      // Zadanie sklada wspolna fabryka - ta sama, z ktorej korzysta portfel,
      // wiec obie polowy aplikacji licza z identycznego wejscia.
      const przygotowane = await przygotujZadanieSilnika(selectedYear, { packageRequest });
      if (latestRequestId.current !== requestId) {
        return { success: false, error: 'Przebieg silnika został zastąpiony nowszym przebiegiem.' } as TaxEngineResponse;
      }
      const request = przygotowane.request;
      setCurrentKey(przygotowane.klucz);
      if (forceRecalculate) request.forceRecalculate = true;
      shouldStopOllamaAfterRun = przygotowane.zatrzymajOllamePoPrzebiegu;
      const { jobId } = await runtimeApi.startTaxEngineJob(request);
      if (latestRequestId.current !== requestId) {
        await runtimeApi.cancelTaxEngineJob(jobId).catch(() => undefined);
        return { success: false, error: 'Przebieg silnika został zastąpiony nowszym przebiegiem.' } as TaxEngineResponse;
      }
      activeJobIdRef.current = jobId;
      while (true) {
        const status = await runtimeApi.getTaxEngineJobStatus(jobId);
        if (latestRequestId.current !== requestId) {
          await runtimeApi.cancelTaxEngineJob(jobId).catch(() => undefined);
          return { success: false, error: 'Przebieg silnika został zastąpiony nowszym przebiegiem.' } as TaxEngineResponse;
        }
        setEngineJobStatus(status);
        if (status.state === 'done') {
          const dane = await runtimeApi.getTaxEngineJobResult(jobId);
          if (latestRequestId.current !== requestId) {
            await runtimeApi.cancelTaxEngineJob(jobId).catch(() => undefined);
            return { success: false, error: 'Przebieg silnika został zastąpiony nowszym przebiegiem.' } as TaxEngineResponse;
          }
          setEngineResult(dane);
          setResultYear(selectedYear);
          setResultKey(przygotowane.klucz);
          setResultDependencyKey(dependencyKey);
          setLastRunFailed(dane.success === false || dane.status === 'FAILED');
          // Wynik zwyklego przebiegu (nie budowy pakietu) zasila tez zakladki
          // Portfel, PIT-38 i Transakcje - jedno zrodlo prawdy.
          if (!packageScope) {
            opublikujWynikSilnika(selectedYear, przygotowane.klucz, dane as TaxEngineResponse);
          }
          return dane as TaxEngineResponse;
        }
        if (status.state === 'failed' || status.state === 'cancelled') {
          throw new Error(status.message || `Silnik zakończył job statusem ${status.state}.`);
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } catch (error: unknown) {
      const failedResult = { success: false, error: getErrorMessage(error, 'Nie udało się uruchomić silnika.') };
      if (latestRequestId.current === requestId) {
        setEngineResult(failedResult);
        setResultYear(selectedYear);
        setResultKey(null);
        setResultDependencyKey(dependencyKey);
        setLastRunFailed(true);
        setEngineJobStatus(null);
      }
      return failedResult;
    } finally {
      if (shouldStopOllamaAfterRun && latestRequestId.current === requestId) {
        await runtimeApi.stopOllama().catch(() => undefined);
      }
      if (latestRequestId.current === requestId) {
        setEngineLoading(false);
        setPackageLoading(false);
        activeJobIdRef.current = null;
      }
    }
  }, [selectedYear, dependencyKey]);

  useEffect(() => {
    if (enabled) {
      runPythonEngine();
    } else {
      latestRequestId.current += 1;
      setEngineResult(null);
      setResultYear(null);
      setResultKey(null);
      setResultDependencyKey(null);
      setCurrentKey(null);
      setEngineLoading(false);
      setPackageLoading(false);
      setEngineJobStatus(null);
      if (activeJobIdRef.current) {
        runtimeApi.cancelTaxEngineJob(activeJobIdRef.current).catch(() => undefined);
        activeJobIdRef.current = null;
      }
    }
  }, [enabled, runPythonEngine]);

  useEffect(() => {
    if (!enabled) return;
    // Wynik jest nieaktualny od pierwszej zmiany (eksport i zamkniecie roku od
    // razu zablokowane), ale silnik rusza dopiero po chwili spokoju - wpisanie
    // kwoty to kilka zapisow, a kazdy przebieg trwa kilkanascie sekund.
    let odlozony: ReturnType<typeof setTimeout> | undefined;
    const handler = () => {
      setCurrentKey(null);
      if (odlozony) clearTimeout(odlozony);
      odlozony = setTimeout(() => { void runPythonEngine(); }, 800);
    };
    window.addEventListener('tax-input-changed', handler);
    return () => {
      window.removeEventListener('tax-input-changed', handler);
      if (odlozony) clearTimeout(odlozony);
    };
  }, [enabled, runPythonEngine]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const handler = () => {
      runPythonEngine();
    };
    window.addEventListener('tax-plan-changed', handler);
    return () => window.removeEventListener('tax-plan-changed', handler);
  }, [enabled, runPythonEngine]);

  const freshness = taxResultFreshness({ selectedYear, resultYear, currentKey: resultDependencyKey === dependencyKey ? currentKey : null, resultKey, failed: lastRunFailed, loading: engineLoading || packageLoading });
  return {
    engineLoading,
    packageLoading,
    silnikJobStatus,
    engineResult: freshness.canExport ? engineResult : null,
    staleEngineResult: freshness.sameYear ? engineResult : null,
    engineStale: freshness.stale,
    canUseEngineResult: freshness.canExport,
    runPythonEngine,
  };
}
