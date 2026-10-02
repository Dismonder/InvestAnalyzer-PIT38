import type { TaxFilingPackageAuditAppendix } from '../hooks/useTaxEngineRun';
import type { OllamaRuntimeStatus } from './runtimeApi.types';
import type { BrokerFileIntakeSourceRow } from './brokerFileIntake';

export type ImportSourceRoleKind =
  | 'transaction_source'
  | 'transaction_report'
  | 'nbp_rates'
  | 'context'
  | 'position_check'
  | 'evidence'
  | 'analytics'
  | 'fallback'
  | 'unknown';

export interface ImportSourceCard {
  id: string;
  filename: string;
  detectedType: string;
  sourceRole: string;
  roleKind: ImportSourceRoleKind;
  roleLabel: string;
  parser: string;
  parserStatus: string;
  aiStatus: string;
  aiStatusLabel: string;
  inputImpact: string;
  inputImpactLabel: string;
  importStatus: string;
  importStatusLabel: string;
  recognitionStatus: string;
  recognitionStatusLabel: string;
  inputStatus: string;
  inputStatusLabel: string;
  finalStatus: string;
  finalStatusLabel: string;
  recordCount: number;
  usedRecordCount: number;
  contextRecordCount: number;
  needsReviewCount: number;
  enrichedDossierCount: number;
  warningCount: number;
  errorCount: number;
  reason: string;
  recognizedByEngine: boolean;
}

export interface ImportAttentionSummary {
  dossierReviewCount: number;
  conflictCount: number;
  missingNbpCount: number;
  aiReviewCount: number;
  filesNeedingReviewCount: number;
  total: number;
}

export interface ImportAiRunStatus {
  runtimeOnline: boolean;
  runtimeLabel: string;
  lastRunStatus: 'used' | 'not_used' | 'unavailable' | 'unknown';
  lastRunLabel: string;
  modelLabel: string;
}

export interface ImportIntelligenceView {
  sources: ImportSourceCard[];
  summary: {
    totalFiles: number;
    transactionSourceCount: number;
    transactionReportCount: number;
    contextSourceCount: number;
    nbpSourceCount: number;
    positionCheckSourceCount: number;
    evidenceSourceCount: number;
    analyticsSourceCount: number;
    transactionDossierCount: number;
    canonicalStorageRowCount: number;
    canonicalRawRowCount: number;
    canonicalDeduplicatedRowCount: number;
  };
  attention: ImportAttentionSummary;
  aiRunStatus: ImportAiRunStatus;
}

type Language = 'pl' | 'en';

function asPlainRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}

function asText(value: unknown, fallback = ''): string {
  return value === undefined || value === null || value === '' ? fallback : String(value);
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function roleKindFor(sourceRole: string, detectedType: string, inputImpact: string): ImportSourceRoleKind {
  const role = sourceRole.toLowerCase();
  const type = detectedType.toLowerCase();
  const impact = inputImpact.toLowerCase();

  if (type.includes('nbp') || role === 'nbp_rates') return 'nbp_rates';
  if (role === 'transaction_source') return 'transaction_source';
  if (role === 'transaction_report') return 'transaction_report';
  if (role === 'data_context') return 'context';
  if (role === 'candidate_tax' || impact === 'candidate') return 'transaction_report';
  if (type.includes('deposit') || type.includes('depo') || role === 'reconciliation') return 'position_check';
  if (type.includes('fee_schedule') || type.includes('pdf') || role === 'evidence') return 'evidence';
  if (type.includes('traders') || role === 'analytics') return 'analytics';
  if (role === 'fallback' || role === 'duplicate') return 'fallback';
  if (
    (role === 'baseline_tax' || role === 'primary_tax' || role === 'tax')
    && (type.includes('broker_report') || type.includes('broker_history') || type.includes('transaction') || type.includes('trade'))
  ) {
    return 'transaction_source';
  }
  if (impact === 'context_only' || role === 'baseline_support' || role === 'supplemental') return 'context';
  return 'unknown';
}

function roleLabelFor(kind: ImportSourceRoleKind, language: Language): string {
  const labels: Record<ImportSourceRoleKind, { pl: string; en: string }> = {
    transaction_source: { pl: 'źródło transakcji', en: 'transaction source' },
    transaction_report: { pl: 'raport transakcyjny', en: 'transaction report' },
    nbp_rates: { pl: 'kursy NBP', en: 'NBP rates' },
    context: { pl: 'kontekst', en: 'context' },
    position_check: { pl: 'kontrola pozycji', en: 'position check' },
    evidence: { pl: 'dowód', en: 'evidence' },
    analytics: { pl: 'analityka', en: 'analytics' },
    fallback: { pl: 'fallback / duplikat', en: 'fallback / duplicate' },
    unknown: { pl: 'nierozpoznane', en: 'unknown' },
  };
  return labels[kind][language];
}

function inputImpactLabelFor(kind: ImportSourceRoleKind, language: Language): string {
  const labels: Record<ImportSourceRoleKind, { pl: string; en: string }> = {
    transaction_source: { pl: 'rekordy transakcyjne', en: 'transaction records' },
    transaction_report: { pl: 'raport do scalenia', en: 'report to merge' },
    nbp_rates: { pl: 'kursy NBP', en: 'NBP rates' },
    context: { pl: 'kontekst danych', en: 'data context' },
    position_check: { pl: 'kontrola pozycji', en: 'position reconciliation' },
    evidence: { pl: 'dowód źródłowy', en: 'source evidence' },
    analytics: { pl: 'analityka', en: 'analytics' },
    fallback: { pl: 'pominięty fallback', en: 'ignored fallback' },
    unknown: { pl: 'wymaga mapowania', en: 'requires mapping' },
  };
  return labels[kind][language];
}

function inputStatusLabel(status: string, language: Language): string {
  const labels: Record<string, { pl: string; en: string }> = {
    complete_records: { pl: 'kompletne rekordy', en: 'complete records' },
    records_to_merge: { pl: 'rekordy do scalenia', en: 'records to merge' },
    data_context: { pl: 'kontekst danych', en: 'data context' },
    source_evidence: { pl: 'dowód źródłowy', en: 'source evidence' },
    analytics: { pl: 'analityka', en: 'analytics' },
    needs_review: { pl: 'wymaga diagnostyki', en: 'needs diagnostics' },
  };
  return labels[status]?.[language] || status || (language === 'en' ? 'unknown' : 'nieznane');
}

function importStatusLabel(status: string, language: Language): string {
  const labels: Record<string, { pl: string; en: string }> = {
    accepted: { pl: 'przyjęty', en: 'accepted' },
    accepted_with_notes: { pl: 'przyjęty z uwagami', en: 'accepted with notes' },
    unreadable: { pl: 'nie można odczytać', en: 'unreadable' },
    unsafe_rejected: { pl: 'odrzucony technicznie', en: 'unsafe rejected' },
  };
  return labels[status]?.[language] || status || (language === 'en' ? 'unknown' : 'nieznane');
}

function recognitionStatusLabel(status: string, language: Language): string {
  const labels: Record<string, { pl: string; en: string }> = {
    recognized: { pl: 'rozpoznany', en: 'recognized' },
    partially_recognized: { pl: 'częściowo rozpoznany', en: 'partially recognized' },
    needs_mapping: { pl: 'wymaga mapowania', en: 'needs mapping' },
    unknown: { pl: 'nierozpoznany', en: 'unknown' },
  };
  return labels[status]?.[language] || status || (language === 'en' ? 'unknown' : 'nieznane');
}

function inferredInputStatus(kind: ImportSourceRoleKind): string {
  if (kind === 'transaction_source') return 'complete_records';
  if (kind === 'transaction_report') return 'records_to_merge';
  if (kind === 'evidence') return 'source_evidence';
  if (kind === 'analytics') return 'analytics';
  if (kind === 'unknown') return 'needs_review';
  return 'data_context';
}

function aiStatusLabel(status: string, runtimeOnline: boolean, language: Language): string {
  const normalized = status.toLowerCase();
  if (normalized === 'used') return language === 'en' ? 'used' : 'użyta';
  if (normalized === 'unavailable') return language === 'en' ? 'unavailable' : 'niedostępna';
  if (normalized === 'failed') return language === 'en' ? 'failed' : 'błąd';
  if (normalized === 'not_needed') return language === 'en' ? 'not needed' : 'niepotrzebna';
  if (normalized === 'disabled') {
    if (runtimeOnline) {
      return language === 'en' ? 'not used in last run' : 'nie użyto w tym przebiegu';
    }
    return language === 'en' ? 'disabled in run' : 'wyłączona w przebiegu';
  }
  return status || (language === 'en' ? 'unknown' : 'nieznane');
}

function finalStatusLabel(status: string, language: Language): string {
  const labels: Record<string, { pl: string; en: string }> = {
    accepted: { pl: 'przyjęto i rozpoznano', en: 'accepted and recognized' },
    accepted_with_notes: { pl: 'przyjęto z uwagami', en: 'accepted with notes' },
    accepted_with_warnings: { pl: 'przyjęto z uwagami', en: 'accepted with notes' },
    needs_review: { pl: 'przyjęto, wymaga kontroli', en: 'accepted, needs review' },
    rejected: { pl: 'przyjęto do kontroli', en: 'accepted for review' },
    technical_error: { pl: 'błąd techniczny', en: 'technical error' },
    unreadable: { pl: 'nie można odczytać', en: 'unreadable' },
    unsafe_rejected: { pl: 'odrzucony technicznie', en: 'unsafe rejected' },
  };
  return labels[status]?.[language] || status || (language === 'en' ? 'unknown' : 'nieznane');
}

export function buildImportIntelligenceView(input: {
  auditAppendix?: TaxFilingPackageAuditAppendix | null;
  brokerSourceRows?: BrokerFileIntakeSourceRow[];
  ollamaStatus?: OllamaRuntimeStatus | null;
  language?: Language;
}): ImportIntelligenceView {
  const language = input.language || 'pl';
  const auditAppendix = input.auditAppendix || {};
  const runtimeOnline = Boolean(input.ollamaStatus?.serverRunning);
  const gpuConfirmed = Boolean(input.ollamaStatus?.gpuConfirmed);
  const manifestByHash = new Map(
    (auditAppendix.normalized_storage_manifest || []).map((entry) => {
      const record = asPlainRecord(entry);
      return [asText(record.file_sha256), record] as const;
    }),
  );
  const brokerByFilename = new Map((input.brokerSourceRows || []).map((source) => [source.filename.toLowerCase(), source]));

  const sources = (auditAppendix.source_registry || []).map((entry): ImportSourceCard => {
    const source = asPlainRecord(entry);
    const hash = asText(source.file_sha256);
    const manifest = manifestByHash.get(hash) || {};
    const deterministicParser = asPlainRecord(manifest.deterministic_parser);
    const aiNormalizer = asPlainRecord(manifest.ai_normalizer);
    const enrichedDossierIds = asStringArray(source.enriched_dossier_ids);
    const warnings = [
      ...asStringArray(source.warnings),
      ...asStringArray(deterministicParser.warnings),
      ...asStringArray(aiNormalizer.warnings),
    ];
    const errors = [
      ...asStringArray(source.errors),
      ...asStringArray(deterministicParser.errors),
      ...asStringArray(aiNormalizer.errors),
    ];
    const filename = asText(source.filename || source.original_filename, asText(manifest.original_filename, 'plik'));
    const detectedType = asText(source.detected_type, asText(manifest.mime_type, 'unknown'));
    const sourceRole = asText(source.source_role, asText(manifest.final_role, brokerByFilename.get(filename.toLowerCase())?.role || 'unknown'));
    const inputImpact = asText(
      source.input_impact,
      asText(source.pit_impact, asText(manifest.input_impact, asText(manifest.pit_impact, 'none'))),
    );
    const roleKind = roleKindFor(sourceRole, detectedType, inputImpact);
    const importStatus = asText(source.import_status, asText(manifest.import_status, errors.length > 0 ? 'accepted_with_notes' : 'accepted'));
    const recognitionStatus = asText(source.recognition_status, asText(manifest.recognition_status, warnings.length > 0 ? 'partially_recognized' : 'recognized'));
    const inputStatus = asText(
      source.input_status,
      asText(manifest.input_status, inferredInputStatus(roleKind)),
    );
    const finalStatus = asText(manifest.final_status, importStatus === 'accepted' && recognitionStatus === 'recognized' ? 'accepted' : importStatus);
    const rawAiStatus = asText(aiNormalizer.status, asText(source.ollama_used ? 'used' : 'not_needed'));

    return {
      id: asText(source.source_id, hash || filename),
      filename,
      detectedType,
      sourceRole,
      roleKind,
      roleLabel: roleLabelFor(roleKind, language),
      parser: asText(source.parser, asText(deterministicParser.parser_name, 'unknown')),
      parserStatus: asText(deterministicParser.status, source.record_count ? 'parsed' : 'unknown'),
      aiStatus: rawAiStatus,
      aiStatusLabel: aiStatusLabel(rawAiStatus, runtimeOnline, language),
      inputImpact,
      inputImpactLabel: inputImpactLabelFor(roleKind, language),
      importStatus,
      importStatusLabel: importStatusLabel(importStatus, language),
      recognitionStatus,
      recognitionStatusLabel: recognitionStatusLabel(recognitionStatus, language),
      inputStatus,
      inputStatusLabel: inputStatusLabel(inputStatus, language),
      finalStatus,
      finalStatusLabel: finalStatusLabel(finalStatus, language),
      recordCount: asNumber(source.record_count),
      usedRecordCount: asNumber(source.used_record_count),
      contextRecordCount: asNumber(source.context_record_count),
      needsReviewCount: asNumber(source.needs_review_count),
      enrichedDossierCount: enrichedDossierIds.length,
      warningCount: warnings.filter(Boolean).length,
      errorCount: errors.filter(Boolean).length,
      reason: asText(source.reason, asText(manifest.reason)),
      recognizedByEngine: true,
    };
  }).sort((left, right) => {
    const priority = (row: ImportSourceCard) => {
      if (row.roleKind === 'transaction_source') return 0;
      if (row.roleKind === 'transaction_report') return 1;
      if (row.needsReviewCount || row.warningCount || row.errorCount) return 2;
      return 3;
    };
    return priority(left) - priority(right) || left.filename.localeCompare(right.filename);
  });

  const canonicalStorageSummary = auditAppendix.canonical_storage_history_summary || {};
  const transactionDossierSummary = auditAppendix.transaction_dossier_summary || {};
  const transactionDossierCount = asNumber(transactionDossierSummary.dossierCount) || (auditAppendix.transaction_dossiers || []).length;
  const conflictCount = asNumber(transactionDossierSummary.conflictCount) || (auditAppendix.transaction_conflicts || []).length;
  const dossierReviewCount = asNumber(transactionDossierSummary.needsReviewCount)
    || (auditAppendix.transaction_dossiers || []).filter((dossier) => asPlainRecord(asPlainRecord(dossier).review).needs_user_review === true).length
    || sources.reduce((sum, source) => sum + source.needsReviewCount, 0);
  const aiValidationReport = asPlainRecord(auditAppendix.ai_validation_report);
  const aiDocumentValidation = asPlainRecord(aiValidationReport.document_classification);
  const aiColumnValidation = asPlainRecord(aiValidationReport.column_mapping);
  const aiContextValidation = asPlainRecord(aiValidationReport.extracted_context);
  const aiReviewCount = asNumber(aiDocumentValidation.needs_user_review)
    + asNumber(aiColumnValidation.needs_user_review)
    + asNumber(aiContextValidation.needs_user_review)
    + asNumber(aiContextValidation.rejected_or_unavailable);
  const missingNbpCount = asNumber(auditAppendix.nbp_coverage_report?.missing_rates);
  const filesNeedingReviewCount = sources.filter((source) => (
    source.importStatus === 'unreadable' ||
    source.importStatus === 'unsafe_rejected' ||
    source.inputStatus === 'needs_review' ||
    source.finalStatus === 'needs_review' ||
    source.finalStatus === 'technical_error' ||
    source.needsReviewCount > 0 ||
    source.warningCount > 0 ||
    source.errorCount > 0
  )).length;

  const anyAiUsed = sources.some((source) => source.aiStatus === 'used') || asNumber(aiContextValidation.ai_used) > 0;
  const aiRunStatus: ImportAiRunStatus = {
    runtimeOnline,
    runtimeLabel: gpuConfirmed
      ? (language === 'en' ? 'Ollama GPU confirmed' : 'Ollama GPU potwierdzona')
      : runtimeOnline
        ? (language === 'en' ? 'Ollama running, GPU not confirmed' : 'Ollama działa, GPU niepotwierdzone')
        : (language === 'en' ? 'Ollama runtime: offline' : 'Ollama runtime: offline'),
    lastRunStatus: anyAiUsed ? 'used' : gpuConfirmed ? 'not_used' : 'unavailable',
    lastRunLabel: anyAiUsed
      ? (language === 'en' ? 'AI used in last run' : 'AI użyta w ostatnim przebiegu')
      : gpuConfirmed
        ? (language === 'en' ? 'AI will be used in next run' : 'AI zostanie użyta przy następnym przebiegu')
        : (language === 'en' ? 'AI disabled: GPU not confirmed' : 'AI wyłączona: GPU niepotwierdzone'),
    modelLabel: input.ollamaStatus?.model || 'qwen3:14b',
  };

  return {
    sources,
    summary: {
      totalFiles: sources.length,
      transactionSourceCount: sources.filter((source) => source.inputStatus === 'complete_records').length,
      transactionReportCount: sources.filter((source) => source.roleKind === 'transaction_report').length,
      contextSourceCount: sources.filter((source) => source.roleKind === 'context' || source.roleKind === 'fallback').length,
      nbpSourceCount: sources.filter((source) => source.roleKind === 'nbp_rates').length,
      positionCheckSourceCount: sources.filter((source) => source.roleKind === 'position_check').length,
      evidenceSourceCount: sources.filter((source) => source.roleKind === 'evidence').length,
      analyticsSourceCount: sources.filter((source) => source.roleKind === 'analytics').length,
      transactionDossierCount,
      canonicalStorageRowCount: (auditAppendix.canonical_storage_history_rows || []).length,
      canonicalRawRowCount: asNumber(canonicalStorageSummary.rawRowCount) || (auditAppendix.canonical_storage_history_rows || []).length,
      canonicalDeduplicatedRowCount: asNumber(canonicalStorageSummary.deduplicatedRowCount) || (auditAppendix.canonical_storage_history_rows || []).length,
    },
    attention: {
      dossierReviewCount,
      conflictCount,
      missingNbpCount,
      aiReviewCount,
      filesNeedingReviewCount,
      total: dossierReviewCount + conflictCount + missingNbpCount + aiReviewCount,
    },
    aiRunStatus,
  };
}
