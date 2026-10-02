import type { KeyValueStorageSource } from './taxEngineConfig';
import { mergeStoredLists } from './mergeStoredLists';

export type BrokerFileActionOverrideStatus = 'open' | 'resolved' | 'ignored';

export interface BrokerFileActionOverride {
  actionId: string;
  status: BrokerFileActionOverrideStatus;
  userNote?: string;
  linkedRowId?: string | null;
  updatedAt: string;
}

export const BROKER_FILE_ACTION_OVERRIDES_KEY = 'brokerFileActionOverrides:v1';

function normalizeStatus(value: unknown): BrokerFileActionOverrideStatus | null {
  if (value === 'open' || value === 'resolved' || value === 'ignored') {
    return value;
  }
  return null;
}

function normalizeOverride(value: unknown): BrokerFileActionOverride | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const actionId = String(record.actionId || record.action_id || '').trim();
  const status = normalizeStatus(record.status);
  if (!actionId || !status) {
    return null;
  }
  const userNote = record.userNote || record.user_note;
  return {
    actionId,
    status,
    userNote: typeof userNote === 'string' && userNote.trim() ? userNote.trim() : undefined,
    linkedRowId: record.linkedRowId || record.linked_row_id ? String(record.linkedRowId || record.linked_row_id) : null,
    updatedAt: String(record.updatedAt || record.updated_at || new Date(0).toISOString()),
  };
}

export function readBrokerFileActionOverrides(storage: KeyValueStorageSource): BrokerFileActionOverride[] {
  const raw = storage.getItem(BROKER_FILE_ACTION_OVERRIDES_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.map(normalizeOverride).filter(Boolean) as BrokerFileActionOverride[];
  } catch {
    return [];
  }
}

export function saveBrokerFileActionOverrides(
  storage: KeyValueStorageSource,
  overrides: BrokerFileActionOverride[],
): void {
  const normalized = overrides.map(normalizeOverride).filter(Boolean) as BrokerFileActionOverride[];
  storage.setItem(BROKER_FILE_ACTION_OVERRIDES_KEY, JSON.stringify(normalized));
}

export function mergeAndSaveBrokerFileActionOverrides(
  storage: KeyValueStorageSource,
  base: BrokerFileActionOverride[],
  local: BrokerFileActionOverride[],
): BrokerFileActionOverride[] {
  const merged = mergeStoredLists(base, local, readBrokerFileActionOverrides(storage), (entry) => entry.actionId);
  saveBrokerFileActionOverrides(storage, merged);
  return merged;
}

export function upsertBrokerFileActionOverride(
  overrides: BrokerFileActionOverride[],
  next: BrokerFileActionOverride,
): BrokerFileActionOverride[] {
  const normalized = normalizeOverride(next);
  if (!normalized) {
    return overrides;
  }
  const byId = new Map(overrides.map((override) => [override.actionId, override]));
  byId.set(normalized.actionId, normalized);
  return Array.from(byId.values()).sort((a, b) => a.actionId.localeCompare(b.actionId));
}
