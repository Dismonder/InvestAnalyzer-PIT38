import {
  getBrowserTaxSettingsStorage,
  type KeyValueStorageSource,
} from './taxEngineConfig';

export const SOURCE_TRUST_DECISIONS_KEY = 'source_trust_decisions:v1';
export const PIT_TRUST_STORAGE_VERSION_KEY = 'storage_version';
export const PIT_TRUST_STORAGE_VERSION = 'v2_pit_trust_os';

export type SourceTrustDecisionStatus = 'accepted' | 'rejected' | 'needs_review';

export interface SourceTrustDecision {
  sourceId: string;
  status: SourceTrustDecisionStatus;
  userNote?: string;
  updatedAt: string;
}

function normalizeDecision(value: unknown): SourceTrustDecision | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Partial<SourceTrustDecision>;
  const sourceId = String(record.sourceId || '').trim();
  const status = String(record.status || '') as SourceTrustDecisionStatus;
  if (!sourceId || !['accepted', 'rejected', 'needs_review'].includes(status)) {
    return null;
  }
  return {
    sourceId,
    status,
    userNote: record.userNote ? String(record.userNote) : undefined,
    updatedAt: String(record.updatedAt || new Date().toISOString()),
  };
}

export function readSourceTrustDecisions(
  storage: KeyValueStorageSource = getBrowserTaxSettingsStorage(),
): SourceTrustDecision[] {
  const raw = storage.getItem(SOURCE_TRUST_DECISIONS_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map(normalizeDecision)
      .filter((entry): entry is SourceTrustDecision => Boolean(entry));
  } catch {
    return [];
  }
}

export function saveSourceTrustDecisions(
  storage: KeyValueStorageSource,
  decisions: SourceTrustDecision[],
): void {
  const normalized = decisions
    .map(normalizeDecision)
    .filter((entry): entry is SourceTrustDecision => Boolean(entry));
  storage.setItem(SOURCE_TRUST_DECISIONS_KEY, JSON.stringify(normalized));
  storage.setItem(PIT_TRUST_STORAGE_VERSION_KEY, PIT_TRUST_STORAGE_VERSION);
}
