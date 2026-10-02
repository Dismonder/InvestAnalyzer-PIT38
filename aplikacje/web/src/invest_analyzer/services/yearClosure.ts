import type { PitCaseFile } from '../hooks/useTaxEngineRun';

export type TaxYearClosureState = 'working' | 'ready_to_review' | 'closed' | 'submitted' | 'reopened';
export type TaxYearClosureStatusId = 'not_closed' | 'closed_match' | 'changed_after_close' | 'reopened';
export type TaxYearClosureDecisionKind = 'close_year' | 'reopen_year' | 'mark_submitted' | 'manual_note';

export interface TaxYearClosureSnapshot {
  taxYear: number;
  caseFileId: string;
  generatedAt: string;
  planUsed: string | null;
  auditHash: string | null;
  inputFingerprint: string;
  calculationFingerprint: string;
  packageSections: Record<string, number>;
  includedArtifacts: string[];
  closureHash: string;
}

export interface TaxYearClosureDecision {
  id: string;
  kind: TaxYearClosureDecisionKind;
  createdAt: string;
  note: string;
  snapshotHash?: string;
}

export interface TaxYearClosure {
  taxYear: number;
  status: TaxYearClosureState;
  closedAt: string | null;
  updatedAt: string;
  snapshot: TaxYearClosureSnapshot;
  decisions: TaxYearClosureDecision[];
}

export interface TaxYearClosureChangedDetail {
  field: string;
  label: string;
  previousValue: string | null;
  currentValue: string | null;
}

export interface TaxYearClosureStatus {
  status: TaxYearClosureStatusId;
  label: string;
  changedFields: string[];
  changedDetails: TaxYearClosureChangedDetail[];
  isReadOnly: boolean;
  snapshotHash: string | null;
  closedAt: string | null;
}

export interface TaxYearClosureStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const TAX_YEAR_CLOSURE_KEY_PREFIX = 'taxYearClosure:v1:';
// Historia decyzji roku jest dopisywana przy kazdym zamknieciu i otwarciu - bez limitu rosla bez konca
// w localStorage. Najstarsze wpisy odpadaja dopiero powyzej tej liczby.
const LIMIT_DECYZJI_ROKU = 100;

export const getTaxYearClosureStorageKey = (year: number | string) =>
  `${TAX_YEAR_CLOSURE_KEY_PREFIX}${String(year)}`;

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function nowIso(): string {
  return new Date().toISOString();
}

function decisionId(kind: TaxYearClosureDecisionKind, createdAt: string, note: string): string {
  return `${kind}:${hashText(`${createdAt}:${note}`)}`;
}

export function buildTaxYearClosureSnapshot(caseFile: PitCaseFile): TaxYearClosureSnapshot {
  const taxYear = Number(caseFile.tax_year);
  const packageSections = caseFile.package_sections || {};
  const includedArtifacts = caseFile.included_artifacts || [];
  const hashPayload = {
    taxYear,
    caseFileId: caseFile.case_file_id,
    auditHash: caseFile.audit_hash || null,
    inputFingerprint: caseFile.input_fingerprint,
    calculationFingerprint: caseFile.calculation_fingerprint,
    planUsed: caseFile.plan_used || null,
    packageSections,
    includedArtifacts,
  };

  return {
    taxYear,
    caseFileId: caseFile.case_file_id,
    generatedAt: caseFile.generated_at,
    planUsed: caseFile.plan_used || null,
    auditHash: caseFile.audit_hash || null,
    inputFingerprint: caseFile.input_fingerprint,
    calculationFingerprint: caseFile.calculation_fingerprint,
    packageSections,
    includedArtifacts,
    closureHash: hashText(stableStringify(hashPayload)),
  };
}

export function readTaxYearClosure(
  storage: TaxYearClosureStorage | null | undefined,
  year: number | string,
): TaxYearClosure | null {
  if (!storage) {
    return null;
  }
  try {
    const raw = storage.getItem(getTaxYearClosureStorageKey(year));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.snapshot || !parsed.taxYear) {
      return null;
    }
    return parsed as TaxYearClosure;
  } catch {
    return null;
  }
}

export function saveTaxYearClosure(
  storage: TaxYearClosureStorage | null | undefined,
  closure: TaxYearClosure,
): boolean {
  if (!storage) {
    return false;
  }
  try {
    storage.setItem(getTaxYearClosureStorageKey(closure.taxYear), JSON.stringify(closure));
    return true;
  } catch {
    return false;
  }
}

export function closeTaxYear(
  storage: TaxYearClosureStorage,
  caseFile: PitCaseFile,
  options: { decisionNote?: string; artifacts?: string[] } = {},
): TaxYearClosure | null {
  const createdAt = nowIso();
  const snapshot = buildTaxYearClosureSnapshot({
    ...caseFile,
    included_artifacts: options.artifacts?.length ? options.artifacts : caseFile.included_artifacts,
  });
  const existing = readTaxYearClosure(storage, snapshot.taxYear);
  const closure: TaxYearClosure = {
    taxYear: snapshot.taxYear,
    status: 'closed',
    closedAt: createdAt,
    updatedAt: createdAt,
    snapshot,
    decisions: [
      ...(existing?.decisions || []),
      {
        id: decisionId('close_year', createdAt, options.decisionNote || ''),
        kind: 'close_year' as const,
        createdAt,
        note: options.decisionNote || 'Rok zamknięty na podstawie bieżącego case file.',
        snapshotHash: snapshot.closureHash,
      },
    ].slice(-LIMIT_DECYZJI_ROKU),
  };
  return saveTaxYearClosure(storage, closure) ? closure : null;
}

export function reopenTaxYear(
  storage: TaxYearClosureStorage,
  year: number,
  note = 'Rok otwarty ponownie do pracy.',
): TaxYearClosure | null {
  const existing = readTaxYearClosure(storage, year);
  if (!existing) {
    return null;
  }
  const createdAt = nowIso();
  const next: TaxYearClosure = {
    ...existing,
    status: 'reopened',
    updatedAt: createdAt,
    decisions: [
      ...existing.decisions,
      {
        id: decisionId('reopen_year', createdAt, note),
        kind: 'reopen_year' as const,
        createdAt,
        note,
        snapshotHash: existing.snapshot.closureHash,
      },
    ].slice(-LIMIT_DECYZJI_ROKU),
  };
  return saveTaxYearClosure(storage, next) ? next : null;
}

export function buildYearClosureStatus(
  currentCaseFile?: PitCaseFile | null,
  closure?: TaxYearClosure | null,
): TaxYearClosureStatus {
  if (!closure) {
    return {
      status: 'not_closed',
      label: 'Rok roboczy',
      changedFields: [],
      changedDetails: [],
      isReadOnly: false,
      snapshotHash: null,
      closedAt: null,
    };
  }

  if (closure.status === 'reopened') {
    return {
      status: 'reopened',
      label: 'Rok otwarty ponownie',
      changedFields: [],
      changedDetails: [],
      isReadOnly: false,
      snapshotHash: closure.snapshot.closureHash,
      closedAt: closure.closedAt,
    };
  }

  if (!currentCaseFile) {
    return {
      status: 'closed_match',
      label: 'Rok zamknięty',
      changedFields: [],
      changedDetails: [],
      isReadOnly: true,
      snapshotHash: closure.snapshot.closureHash,
      closedAt: closure.closedAt,
    };
  }

  const currentSnapshot = buildTaxYearClosureSnapshot(currentCaseFile);
  const changedFields: string[] = [];
  const changedDetails: TaxYearClosureChangedDetail[] = [];
  const addChange = (
    field: string,
    label: string,
    previousValue: string | null | undefined,
    currentValue: string | null | undefined,
  ) => {
    changedFields.push(label);
    changedDetails.push({
      field,
      label,
      previousValue: previousValue || null,
      currentValue: currentValue || null,
    });
  };
  if (currentSnapshot.inputFingerprint !== closure.snapshot.inputFingerprint) {
    addChange('inputFingerprint', 'fingerprint danych', closure.snapshot.inputFingerprint, currentSnapshot.inputFingerprint);
  }
  if (currentSnapshot.calculationFingerprint !== closure.snapshot.calculationFingerprint) {
    addChange(
      'calculationFingerprint',
      'fingerprint kalkulacji',
      closure.snapshot.calculationFingerprint,
      currentSnapshot.calculationFingerprint,
    );
  }
  if ((currentSnapshot.planUsed || '') !== (closure.snapshot.planUsed || '')) {
    addChange('planUsed', 'plan podatkowy', closure.snapshot.planUsed, currentSnapshot.planUsed);
  }
  if ((currentSnapshot.auditHash || '') !== (closure.snapshot.auditHash || '')) {
    addChange('auditHash', 'hash audytu', closure.snapshot.auditHash, currentSnapshot.auditHash);
  }

  if (changedFields.length > 0) {
    return {
      status: 'changed_after_close',
      label: 'Dane lub kalkulacja zmieniły się po zamknięciu roku',
      changedFields,
      changedDetails,
      isReadOnly: false,
      snapshotHash: closure.snapshot.closureHash,
      closedAt: closure.closedAt,
    };
  }

  return {
    status: 'closed_match',
    label: closure.status === 'submitted' ? 'Rok wysłany' : 'Rok zamknięty',
    changedFields,
    changedDetails,
    isReadOnly: true,
    snapshotHash: closure.snapshot.closureHash,
    closedAt: closure.closedAt,
  };
}
