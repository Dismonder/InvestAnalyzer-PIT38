/**
 * Audyt zrodel zwyklego przebiegu silnika.
 *
 * Silnik zwraca rejestr zrodel, podglad rozstrzygniecia i historie magazynu w
 * kazdym przebiegu, nie tylko przy budowie pakietu. Raport roczny skladal
 * wlasna, ubozsza wersje zalacznika i pisal "Audyt zrodel niedostepny /
 * Historia: 0" nad wynikiem, ktory te dane mial. Jedna funkcja dla calego
 * warsztatu.
 */

import type {
  BrokerFileSourceManifest,
  TaxEngineResponse,
  TaxFilingPackageAuditAppendix,
} from '../hooks/useTaxEngineRun';

export function sourceRegistryToSourceManifest(source: Record<string, unknown>): BrokerFileSourceManifest {
  const sourceId = String(source.source_id || source.sourceId || source.file_sha256 || '').trim();
  const filename = String(source.filename || source.original_filename || source.stored_path || sourceId || 'nieznane źródło');
  const role = String(source.source_role || source.final_role || '').trim();
  const pitImpact = String(source.pit_impact || '').trim();
  const roleMap: Record<string, string> = {
    pit_active: 'transaction_source',
    baseline_tax: 'transaction_source',
    baseline_support: 'data_context',
    pit_candidate: 'transaction_report',
    cash_context: 'data_context',
    position_reconciliation: 'reconciliation',
    evidence: 'evidence',
    analytics: 'analytics',
    nbp_rates: 'nbp_rates',
  };
  // Nowszy silnik podaje role juz w docelowym slowniku ("transaction_source").
  const roleDocelowe = new Set(Object.values(roleMap));
  const sourceResolutionRole = roleMap[role] || (roleDocelowe.has(role) ? role : null) || (pitImpact === 'active' ? 'transaction_source' : pitImpact === 'candidate' ? 'transaction_report' : 'unknown');
  // Zrodlo liczy sie do podatku, gdy silnik nadal mu role zrodla transakcji
  // i faktycznie uzyl z niego rekordow. Flaga wpisana na sztywno jako `false`
  // dawala "Zrodla transakcji: 0" nad policzonym podatkiem.
  const uzyteRekordy = Number(source.used_record_count);
  const wchodziDoPodatku =
    sourceResolutionRole === 'transaction_source' && Number.isFinite(uzyteRekordy) && uzyteRekordy > 0;
  return {
    sourceId: sourceId || `storage:${filename}`,
    filename,
    relativePath: String(source.relative_path || source.stored_path || filename),
    hash: typeof source.file_sha256 === 'string' ? source.file_sha256 : null,
    detectedType: String(source.detected_type || source.mime_type || role || 'unknown'),
    recordCounts: { records: Number(source.record_count || source.used_record_count || 0) },
    contributesToCanonicalInput: true,
    contributesToTax: wchodziDoPodatku,
    fileRole: role || null,
    warnings: Array.isArray(source.warnings) ? source.warnings.map(String) : [],
    errors: Array.isArray(source.errors) ? source.errors.map(String) : [],
    sourceResolutionRole,
    sourceResolutionReason: typeof source.reason === 'string' ? source.reason : null,
  };
}

export function buildRunAuditAppendix(
  engineResult: TaxEngineResponse | null | undefined,
): TaxFilingPackageAuditAppendix | null {
    const packageAppendix = engineResult?.tax_filing_package?.audit_appendix || null;
    if (!engineResult) {
      return null;
    }
    const hasTopLevelSourceAudit = Boolean(
      engineResult.source_resolution_preview ||
      engineResult.candidate_source_runs ||
      engineResult.canonical_storage_history_rows,
    );
    if (!hasTopLevelSourceAudit) {
      return packageAppendix;
    }
    const topLevelSourceRegistry = engineResult.source_registry ?? packageAppendix?.source_registry ?? [];
    const sourceManifestV2 = packageAppendix?.source_manifest_v2?.length
      ? packageAppendix.source_manifest_v2
      : topLevelSourceRegistry.map(sourceRegistryToSourceManifest);
    return {
      ...(packageAppendix || {}),
      source_manifest_v2: sourceManifestV2,
      source_resolution_preview:
        engineResult.source_resolution_preview ?? packageAppendix?.source_resolution_preview ?? null,
      candidate_source_runs:
        engineResult.candidate_source_runs ?? packageAppendix?.candidate_source_runs ?? [],
      candidate_transaction_preview_rows:
        engineResult.candidate_transaction_preview_rows ?? packageAppendix?.candidate_transaction_preview_rows ?? [],
      canonical_storage_history_rows:
        engineResult.canonical_storage_history_rows ?? packageAppendix?.canonical_storage_history_rows ?? [],
      storage_lineage_index:
        engineResult.storage_lineage_index ?? packageAppendix?.storage_lineage_index ?? {},
      canonical_storage_history_summary:
        engineResult.canonical_storage_history_summary ?? packageAppendix?.canonical_storage_history_summary ?? {},
      source_registry:
        topLevelSourceRegistry,
      normalized_storage_manifest:
        engineResult.normalized_storage_manifest ?? packageAppendix?.normalized_storage_manifest ?? [],
      normalized_events:
        engineResult.normalized_events ?? packageAppendix?.normalized_events ?? [],
      canonical_tax_input:
        engineResult.canonical_tax_input ?? packageAppendix?.canonical_tax_input ?? {},
      canonical_tax_input_summary:
        engineResult.canonical_tax_input_summary ?? packageAppendix?.canonical_tax_input_summary ?? {},
      tax_input_build_report:
        engineResult.tax_input_build_report ?? packageAppendix?.tax_input_build_report ?? {},
      canonical_tax_input_consumption_runtime:
        engineResult.canonical_tax_input_consumption_runtime ?? packageAppendix?.canonical_tax_input_consumption_runtime ?? {},
      transaction_dossiers:
        engineResult.transaction_dossiers ?? packageAppendix?.transaction_dossiers ?? [],
      transaction_dossier_summary:
        engineResult.transaction_dossier_summary ?? packageAppendix?.transaction_dossier_summary ?? {},
      transaction_conflicts:
        engineResult.transaction_conflicts ?? packageAppendix?.transaction_conflicts ?? [],
      field_source_map:
        engineResult.field_source_map ?? packageAppendix?.field_source_map ?? {},
      evidence_index:
        engineResult.evidence_index ?? packageAppendix?.evidence_index ?? [],
      ai_extracted_context:
        engineResult.ai_extracted_context ?? packageAppendix?.ai_extracted_context ?? [],
      ai_validation_report:
        packageAppendix?.ai_validation_report ?? engineResult.ai_validation_report ?? {},
    };
}
