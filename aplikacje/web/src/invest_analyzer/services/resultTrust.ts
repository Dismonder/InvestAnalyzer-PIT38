import type { TaxEngineResponse, TaxFilingPackageAuditAppendix } from '../hooks/useTaxEngineRun';

export interface ResultTrustModel {
  status: 'ok' | 'needs_review' | 'blocked' | 'unknown' | 'calculating';
  label: string;
  summary: string;
  activeTaxSources: string[];
  recognizedFileCount: number;
  recommendedAction: string;
  reasons: string[];
}

function sourceLabel(source: { filename?: string | null; relativePath?: string | null; sourceId?: string | null }): string {
  return source.filename || source.relativePath || source.sourceId || 'źródło PIT';
}

export function buildResultTrustModel(
  engineResult: TaxEngineResponse | null,
  auditAppendix?: TaxFilingPackageAuditAppendix | null,
  isCalculating = false,
): ResultTrustModel {
  const health = auditAppendix?.result_health_check;
  const sourceManifest = auditAppendix?.source_manifest_v2 || [];
  const recognizedFileCount = health?.recognizedStorageFileCount
    ?? auditAppendix?.auto_file_recognition_report?.summary?.recognizedSourceCount
    ?? sourceManifest.length
    ?? 0;
  const activeTaxSources = health?.activeTaxSourceLabels?.length
    ? health.activeTaxSourceLabels
    : sourceManifest.filter((source) => source.contributesToTax).map(sourceLabel);

  // W trakcie przebiegu nie wolno wyciągać wniosku „brak plików” z jeszcze
  // nieobecnego wyniku. Metadane źródeł pojawią się dopiero z odpowiedzią.
  if (isCalculating) {
    return {
      status: 'calculating',
      label: 'Trwa liczenie rozliczenia',
      summary: 'Silnik analizuje źródła i oblicza PIT. Stan źródeł będzie dostępny po zakończeniu przebiegu.',
      activeTaxSources,
      recognizedFileCount,
      recommendedAction: 'Poczekaj na wynik silnika',
      reasons: [],
    };
  }

  if (health) {
    const status = health.status;
    return {
      status,
      label: status === 'blocked'
        ? 'Dane do kontroli PIT'
        : status === 'needs_review'
          ? 'Wymaga kontroli danych'
          : 'Dane czytane poprawnie',
      summary: health.reasons?.[0] || health.headline,
      activeTaxSources,
      recognizedFileCount,
      recommendedAction: status === 'ok' ? 'Źródła wyglądają spójnie' : 'Sprawdź źródła danych',
      reasons: health.reasons || [],
    };
  }

  const hasEngineError = Boolean(engineResult?.error || engineResult?.success === false || engineResult?.status === 'FAILED');
  if (hasEngineError) {
    return {
      status: 'blocked',
      label: 'Dane do kontroli PIT',
      summary: 'Silnik nie zakończył przebiegu, więc nie można potwierdzić źródeł wyniku.',
      activeTaxSources,
      recognizedFileCount,
      recommendedAction: 'Sprawdź błąd silnika',
      reasons: ['Silnik nie zakończył przebiegu.'],
    };
  }

  // Brak przebiegu silnika i zero plikow to nie jest "dane czytane poprawnie".
  // Funkcja spadala do ostatniego return i ekran pisal "Dane czytane
  // poprawnie - zrodla wygladaja spojnie" nad kompletem zer, zanim
  // cokolwiek wczytano.
  if (!engineResult && activeTaxSources.length === 0 && recognizedFileCount === 0) {
    return {
      status: 'needs_review',
      label: 'Brak wczytanych źródeł',
      summary: 'Nie wczytano żadnego pliku źródłowego, więc nie ma czego czytać ani potwierdzać.',
      activeTaxSources,
      recognizedFileCount,
      recommendedAction: 'Wczytaj wyciągi brokera',
      reasons: ['Brak rozpoznanych plików źródłowych.'],
    };
  }

  // Wynik jest, ale przebieg nie ma audytu zrodel - nie ma na czym oprzec
  // zdania "dane czytane poprawnie". Ekran pisal je nad licznikiem zrodel
  // rownym zeru, przy podatku policzonym z trzech plikow brokera.
  // Sam obiekt zalacznika nie wystarczy: gdy pakiet nie powstal, ekran dostaje
  // strukture z podgladem rozstrzygniecia zrodel i niczym wiecej.
  const brakAudytuZrodel =
    !auditAppendix ||
    (!auditAppendix.result_health_check &&
      !auditAppendix.source_trust_summary &&
      !(auditAppendix.source_manifest_v2 || []).length &&
      !auditAppendix.auto_file_recognition_report);
  if (brakAudytuZrodel) {
    return {
      status: 'unknown',
      label: 'Audyt źródeł niedostępny',
      summary:
        'Wynik jest policzony, ale ten przebieg nie ma audytu źródeł — wygeneruj pakiet, żeby zobaczyć, z czego liczono.',
      activeTaxSources,
      recognizedFileCount,
      recommendedAction: 'Wygeneruj pakiet',
      reasons: ['Brak audytu źródeł w tym przebiegu.'],
    };
  }

  if (activeTaxSources.length === 0 && recognizedFileCount > 0) {
    return {
      status: 'needs_review',
      label: 'Wymaga kontroli danych',
      summary: 'Program rozpoznał pliki, ale audyt nie wskazał aktywnego źródła PIT.',
      activeTaxSources,
      recognizedFileCount,
      recommendedAction: 'Sprawdź źródła danych',
      reasons: ['Brak aktywnego źródła PIT w audycie.'],
    };
  }

  return {
    status: 'ok',
    label: 'Dane czytane poprawnie',
    summary: activeTaxSources.length > 0
      ? `Liczę PIT z: ${activeTaxSources.slice(0, 3).join(', ')}.`
      : 'Brak dodatkowych ostrzeżeń źródłowych.',
    activeTaxSources,
    recognizedFileCount,
    recommendedAction: 'Źródła wyglądają spójnie',
    reasons: [],
  };
}
