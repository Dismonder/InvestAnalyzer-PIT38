import type { KeyValueStorageSource } from './taxEngineConfig';
import { mergeStoredLists } from './mergeStoredLists';

export type AutoCheckActionOverrideStatus = 'open' | 'done' | 'hidden';

export interface AutoCheckActionOverride {
  itemId: string;
  status: AutoCheckActionOverrideStatus;
  userNote?: string;
  updatedAt: string;
}

export const AUTO_CHECK_ACTION_OVERRIDES_KEY = 'autoCheckActionOverrides:v1';

function normalizeStatus(value: unknown): AutoCheckActionOverrideStatus | null {
  if (value === 'open' || value === 'done' || value === 'hidden') {
    return value;
  }
  return null;
}

function normalizeOverride(value: unknown): AutoCheckActionOverride | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const itemId = String(record.itemId || record.item_id || '').trim();
  const status = normalizeStatus(record.status);
  if (!itemId || !status) {
    return null;
  }
  const userNote = record.userNote || record.user_note;
  return {
    itemId,
    status,
    userNote: typeof userNote === 'string' && userNote.trim() ? userNote.trim() : undefined,
    updatedAt: String(record.updatedAt || record.updated_at || new Date(0).toISOString()),
  };
}

export function readAutoCheckActionOverrides(storage: KeyValueStorageSource): AutoCheckActionOverride[] {
  const raw = storage.getItem(AUTO_CHECK_ACTION_OVERRIDES_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.map(normalizeOverride).filter(Boolean) as AutoCheckActionOverride[];
  } catch {
    return [];
  }
}

export function saveAutoCheckActionOverrides(
  storage: KeyValueStorageSource,
  overrides: AutoCheckActionOverride[],
): void {
  const normalized = overrides.map(normalizeOverride).filter(Boolean) as AutoCheckActionOverride[];
  storage.setItem(AUTO_CHECK_ACTION_OVERRIDES_KEY, JSON.stringify(normalized));
}

export function mergeAndSaveAutoCheckActionOverrides(
  storage: KeyValueStorageSource,
  base: AutoCheckActionOverride[],
  local: AutoCheckActionOverride[],
): AutoCheckActionOverride[] {
  const merged = mergeStoredLists(base, local, readAutoCheckActionOverrides(storage), (entry) => entry.itemId);
  saveAutoCheckActionOverrides(storage, merged);
  return merged;
}

export function upsertAutoCheckActionOverride(
  overrides: AutoCheckActionOverride[],
  next: AutoCheckActionOverride,
): AutoCheckActionOverride[] {
  const normalized = normalizeOverride(next);
  if (!normalized) {
    return overrides;
  }
  const byId = new Map(overrides.map((override) => [override.itemId, override]));
  byId.set(normalized.itemId, normalized);
  return Array.from(byId.values()).sort((a, b) => a.itemId.localeCompare(b.itemId));
}
