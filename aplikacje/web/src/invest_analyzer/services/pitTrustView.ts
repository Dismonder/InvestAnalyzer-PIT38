import type { TaxFilingPackageAuditAppendix } from '../hooks/useTaxEngineRun';

type TrustStatus = 'ok' | 'needs_review' | 'blocked' | 'unknown';

export interface PitTrustViewModel {
  /**
   * Liczniki zrodel z audytu; `null`, gdy audyt ich nie podal.
   * `asNumber(undefined)` dawalo tu zero, wiec ekran pisal "Zrodla transakcji: 0"
   * przy rozliczeniu policzonym z trzech plikow brokera - zero wygladalo jak
   * wynik sprawdzenia, a znaczylo brak sekcji w audycie.
   */
  sourceCount: number | null;
  activeSourceCount: number | null;
  candidateSourceCount: number | null;
  evidenceSourceCount: number | null;
  blockedSourceCount: number | null;
  recognizedFileCount: number | null;
  storageSmokeStatus: TrustStatus;
  nbpStatus: TrustStatus;
  resultHealthStatus: TrustStatus;
  defenseAvailableCount: number;
  defenseToCollectCount: number;
  defenseAdvisorReviewCount: number;
  noOverpayCountedPln: string;
  noOverpayCandidatePln: string;
  noOverpayRequiresEvidencePln: string;
  advisorPackReady: boolean;
  overallStatus: TrustStatus;
  headline: string;
  sourceSummary: string;
  evidenceSummary: string;
  packageSummary: string;
}

/** Liczba z audytu albo `null`, gdy pola nie ma. */
function liczbaAlboBrak(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Licznik do tekstu podsumowania. */
function tekstLicznika(value: number | null): string {
  return value === null ? 'nie policzono' : String(value);
}

function asNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function asStatus(value: unknown): TrustStatus {
  if (value === 'ok' || value === 'pass') return 'ok';
  if (value === 'needs_review' || value === 'warn' || value === 'warning') return 'needs_review';
  if (value === 'blocked' || value === 'fail') return 'blocked';
  return 'unknown';
}

function statusPriority(status: TrustStatus): number {
  if (status === 'blocked') return 3;
  if (status === 'needs_review') return 2;
  if (status === 'ok') return 1;
  return 0;
}

function worstStatus(...statuses: TrustStatus[]): TrustStatus {
  return statuses.reduce<TrustStatus>((current, next) => (
    statusPriority(next) > statusPriority(current) ? next : current
  ), 'unknown');
}

function summaryCount(summary: Record<string, unknown> | undefined, key: string): number {
  return asNumber(summary?.[key]);
}

export function buildPitTrustViewModel(
  auditAppendix?: TaxFilingPackageAuditAppendix | null,
): PitTrustViewModel {
  if (!auditAppendix) {
    return {
      sourceCount: null,
      activeSourceCount: null,
      candidateSourceCount: null,
      evidenceSourceCount: null,
      blockedSourceCount: null,
      recognizedFileCount: null,
      storageSmokeStatus: 'unknown',
      nbpStatus: 'unknown',
      resultHealthStatus: 'unknown',
      defenseAvailableCount: 0,
      defenseToCollectCount: 0,
      defenseAdvisorReviewCount: 0,
      noOverpayCountedPln: '0',
      noOverpayCandidatePln: '0',
      noOverpayRequiresEvidencePln: '0',
      advisorPackReady: false,
      overallStatus: 'unknown',
      headline: 'Brak danych audytu zaufania dla bieżącego widoku.',
      sourceSummary: 'Źródła transakcji: nie policzono. Raporty do scalenia: nie policzono. Rozpoznane pliki: nie policzono.',
      evidenceSummary: 'Dowody dostępne: 0. Do zebrania: 0. Do doradcy: 0.',
      packageSummary: 'Pakiet doradcy pojawi się po wygenerowaniu pełnego pakietu podatkowego.',
    };
  }
  const sourceSummary = auditAppendix?.source_trust_summary?.summary;
  const statusCounts = sourceSummary?.status_counts || {};
  const health = auditAppendix?.result_health_check;
  const defenseSummary = auditAppendix?.defense_vault_summary?.summary as Record<string, unknown> | undefined;
  const noOverpaySummary = auditAppendix?.no_overpay_audit_v3?.summary;

  const sourceCount = liczbaAlboBrak(sourceSummary?.source_count ?? auditAppendix?.source_trust_summary?.items?.length);
  // Zwykly przebieg (bez pakietu) nie ma podsumowania zaufania, ale ma manifest
  // zrodel zbudowany z rejestru silnika - liczniki biora sie wtedy z niego.
  const manifest = auditAppendix?.source_manifest_v2;
  const zManifestu = (rola: string, tylkoDoPodatku: boolean): number | undefined =>
    Array.isArray(manifest) && manifest.length > 0
      ? manifest.filter(
          (zrodlo) => zrodlo.sourceResolutionRole === rola && (!tylkoDoPodatku || zrodlo.contributesToTax === true),
        ).length
      : undefined;
  const activeSourceCount = liczbaAlboBrak(
    sourceSummary?.transaction_source_count ??
      statusCounts.transaction_source ??
      health?.activeTaxSourceIds?.length ??
      zManifestu('transaction_source', true),
  );
  const candidateSourceCount = liczbaAlboBrak(
    sourceSummary?.report_source_count ?? statusCounts.transaction_report ?? zManifestu('transaction_report', false),
  );
  const evidenceSourceCount = liczbaAlboBrak(statusCounts.source_evidence);
  const reviewSourceCount = asNumber(sourceSummary?.review_needed_source_count ?? statusCounts.source_review);
  const blockedSourceCount = sourceSummary?.review_needed_source_count === undefined
    && statusCounts.source_review === undefined
    ? null
    : reviewSourceCount;
  const recognizedFileCount = liczbaAlboBrak(
    health?.recognizedStorageFileCount
    ?? auditAppendix?.auto_file_recognition_report?.summary?.recognizedSourceCount
    ?? sourceCount,
  );
  const storageSmokeStatus = asStatus(auditAppendix?.storage_smoke_report?.status);
  const nbpStatus = asStatus(auditAppendix?.nbp_coverage_report?.status);
  const resultHealthStatus = asStatus(health?.status);
  const overallStatus = worstStatus(
    resultHealthStatus,
    storageSmokeStatus,
    nbpStatus,
    reviewSourceCount > 0 ? 'needs_review' : 'ok',
  );

  const defenseAvailableCount = summaryCount(defenseSummary, 'available');
  const defenseToCollectCount = summaryCount(defenseSummary, 'to_collect') + summaryCount(defenseSummary, 'missing');
  const defenseAdvisorReviewCount = summaryCount(defenseSummary, 'advisor_review');
  const noOverpayCountedPln = String(noOverpaySummary?.counted_total_pln ?? '0');
  const noOverpayCandidatePln = String(noOverpaySummary?.candidate_total_pln ?? '0');
  const noOverpayRequiresEvidencePln = String(noOverpaySummary?.requires_evidence_total_pln ?? '0');
  const advisorPackReady = Boolean(auditAppendix?.advisor_review_pack);

  return {
    sourceCount,
    activeSourceCount,
    candidateSourceCount,
    evidenceSourceCount,
    blockedSourceCount,
    recognizedFileCount,
    storageSmokeStatus,
    nbpStatus,
    resultHealthStatus,
    defenseAvailableCount,
    defenseToCollectCount,
    defenseAdvisorReviewCount,
    noOverpayCountedPln,
    noOverpayCandidatePln,
    noOverpayRequiresEvidencePln,
    advisorPackReady,
    overallStatus,
    headline: overallStatus === 'blocked'
        ? 'Przebieg jest zablokowany przez brak wymaganych danych.'
        : overallStatus === 'needs_review'
          ? 'Wynik jest policzony, ale wymaga kontroli danych.'
          : 'Wynik ma kompletny skrót zaufania.',
    sourceSummary: `Źródła transakcji: ${tekstLicznika(activeSourceCount)}. Raporty do scalenia: ${tekstLicznika(candidateSourceCount)}. Rozpoznane pliki: ${tekstLicznika(recognizedFileCount)}.`,
    evidenceSummary: `Dowody dostępne: ${defenseAvailableCount}. Do zebrania: ${defenseToCollectCount}. Do doradcy: ${defenseAdvisorReviewCount}.`,
    packageSummary: advisorPackReady
      ? 'Pakiet doradcy jest dostępny w audycie tego przebiegu.'
      : 'Pakiet doradcy pojawi się po wygenerowaniu pełnego pakietu podatkowego.',
  };
}
