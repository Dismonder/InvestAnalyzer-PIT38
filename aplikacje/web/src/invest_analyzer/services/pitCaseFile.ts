import type { PitCaseFile, TaxFilingPackageAuditAppendix } from '../hooks/useTaxEngineRun';
import { odmienLiczebnik } from '../../portfel/services/odmianaLiczebnika';

export interface PitCaseFileSummary {
  available: boolean;
  reproducible: boolean;
  statusLabel: string;
  caseFileId: string | null;
  taxYear: string | null;
  inputFingerprint: string | null;
  calculationFingerprint: string | null;
  sectionCountLabel: string;
  warnings: string[];
}

export type PitCaseFileBaselineStatusId = 'NO_BASELINE' | 'MATCH' | 'CHANGED';

export interface PitCaseFileBaselineStatus {
  status: PitCaseFileBaselineStatusId;
  label: string;
  changedFields: string[];
  baselineGeneratedAt: string | null;
  currentGeneratedAt: string | null;
}

export interface PitCaseFileBaselineStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const PIT_CASE_FILE_BASELINE_KEY_PREFIX = 'pitCaseFileBaseline:v1:';

const shortHash = (value?: string | null) => (value ? value.slice(0, 12) : null);

export const getPitCaseFileBaselineStorageKey = (year: number | string) =>
  `${PIT_CASE_FILE_BASELINE_KEY_PREFIX}${String(year)}`;

export function buildPitCaseFileBaselineStatus(
  current?: PitCaseFile | null,
  baseline?: PitCaseFile | null,
): PitCaseFileBaselineStatus {
  if (!current) {
    return {
      status: 'NO_BASELINE',
      label: 'Brak bieżącego case file',
      changedFields: [],
      baselineGeneratedAt: baseline?.generated_at || null,
      currentGeneratedAt: null,
    };
  }

  if (!baseline) {
    return {
      status: 'NO_BASELINE',
      label: 'Brak poprzedniego pakietu do porównania',
      changedFields: [],
      baselineGeneratedAt: null,
      currentGeneratedAt: current.generated_at || null,
    };
  }

  const changedFields: string[] = [];
  if (baseline.input_fingerprint !== current.input_fingerprint) {
    changedFields.push('fingerprint danych');
  }
  if (baseline.calculation_fingerprint !== current.calculation_fingerprint) {
    changedFields.push('fingerprint kalkulacji');
  }
  if ((baseline.plan_used || '') !== (current.plan_used || '')) {
    changedFields.push('plan podatkowy');
  }

  if (changedFields.length === 0) {
    return {
      status: 'MATCH',
      label: 'Zgodny z ostatnim pakietem',
      changedFields,
      baselineGeneratedAt: baseline.generated_at || null,
      currentGeneratedAt: current.generated_at || null,
    };
  }

  return {
    status: 'CHANGED',
    label: 'Dane lub kalkulacja zmieniły się od ostatniego pakietu',
    changedFields,
    baselineGeneratedAt: baseline.generated_at || null,
    currentGeneratedAt: current.generated_at || null,
  };
}

export function readPitCaseFileBaseline(
  storage: PitCaseFileBaselineStorage | null | undefined,
  year: number | string,
): PitCaseFile | null {
  if (!storage) {
    return null;
  }
  try {
    const raw = storage.getItem(getPitCaseFileBaselineStorageKey(year));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.case_file_id !== 'string') {
      return null;
    }
    return parsed as PitCaseFile;
  } catch {
    return null;
  }
}

export function writePitCaseFileBaseline(
  storage: PitCaseFileBaselineStorage | null | undefined,
  caseFile?: PitCaseFile | null,
): boolean {
  if (!storage || !caseFile?.tax_year) {
    return false;
  }
  try {
    storage.setItem(getPitCaseFileBaselineStorageKey(caseFile.tax_year), JSON.stringify(caseFile));
    return true;
  } catch {
    return false;
  }
}

export function buildPitCaseFileSummary(auditAppendix?: TaxFilingPackageAuditAppendix | null): PitCaseFileSummary {
  const caseFile = auditAppendix?.pit_case_file;
  if (!caseFile) {
    return {
      available: false,
      reproducible: false,
      statusLabel: 'Brak case file',
      caseFileId: null,
      taxYear: null,
      inputFingerprint: null,
      calculationFingerprint: null,
      sectionCountLabel: 'Brak pełnego pakietu audytowego',
      warnings: ['Wygeneruj pełny pakiet podatkowy, żeby zapisać odtwarzalny case file.'],
    };
  }

  const ledgerRows = caseFile.package_sections?.tax_calculation_ledger_rows ?? 0;
  const traceEntries = caseFile.package_sections?.tax_trace_entries ?? 0;
  const warnings = Array.isArray(caseFile.warnings) ? caseFile.warnings : [];

  return {
    available: true,
    reproducible: Boolean(caseFile.reproducible),
    statusLabel: caseFile.reproducible ? 'Odtwarzalny' : 'Niekompletny',
    caseFileId: caseFile.case_file_id,
    taxYear: caseFile.tax_year,
    inputFingerprint: shortHash(caseFile.input_fingerprint),
    calculationFingerprint: shortHash(caseFile.calculation_fingerprint),
    sectionCountLabel: `${ledgerRows} ${odmienLiczebnik(ledgerRows, 'wiersz', 'wiersze', 'wierszy')} ledgeru / ${traceEntries} ${odmienLiczebnik(traceEntries, 'ścieżka', 'ścieżki', 'ścieżek')} kwot`,
    warnings,
  };
}
