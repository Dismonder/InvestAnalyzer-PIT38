import {
  getBrowserTaxSettingsStorage,
  type KeyValueStorageSource,
} from './taxEngineConfig';

export const DEFENSE_VAULT_KEY = 'defenseVault:v1';

export type DefenseVaultStatus =
  | 'missing'
  | 'to_collect'
  | 'available'
  | 'partial'
  | 'not_needed'
  | 'advisor_review';

export interface DefenseVaultItem {
  evidenceId: string;
  title: string;
  status: DefenseVaultStatus;
  evidenceType?: string;
  fileName?: string;
  filePath?: string;
  fileHash?: string;
  linkedRecordIds: string[];
  linkedSourceIds: string[];
  linkedNoOverpayItemIds: string[];
  userNote?: string;
  updatedAt: string;
}

function normalizeDefenseVaultItem(value: unknown): DefenseVaultItem | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Partial<DefenseVaultItem>;
  const evidenceId = String(record.evidenceId || '').trim();
  const title = String(record.title || '').trim();
  const status = String(record.status || '') as DefenseVaultStatus;
  const allowedStatuses: DefenseVaultStatus[] = ['missing', 'to_collect', 'available', 'partial', 'not_needed', 'advisor_review'];
  if (!evidenceId || !title || !allowedStatuses.includes(status)) {
    return null;
  }
  return {
    evidenceId,
    title,
    status,
    evidenceType: record.evidenceType ? String(record.evidenceType) : undefined,
    fileName: record.fileName ? String(record.fileName) : undefined,
    filePath: record.filePath ? String(record.filePath) : undefined,
    fileHash: record.fileHash ? String(record.fileHash) : undefined,
    linkedRecordIds: Array.isArray(record.linkedRecordIds) ? record.linkedRecordIds.map(String) : [],
    linkedSourceIds: Array.isArray(record.linkedSourceIds) ? record.linkedSourceIds.map(String) : [],
    linkedNoOverpayItemIds: Array.isArray(record.linkedNoOverpayItemIds) ? record.linkedNoOverpayItemIds.map(String) : [],
    userNote: record.userNote ? String(record.userNote) : undefined,
    updatedAt: String(record.updatedAt || new Date().toISOString()),
  };
}

export function readDefenseVaultItems(
  storage: KeyValueStorageSource = getBrowserTaxSettingsStorage(),
): DefenseVaultItem[] {
  const raw = storage.getItem(DEFENSE_VAULT_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map(normalizeDefenseVaultItem)
      .filter((entry): entry is DefenseVaultItem => Boolean(entry));
  } catch {
    return [];
  }
}

export function saveDefenseVaultItems(
  storage: KeyValueStorageSource,
  items: DefenseVaultItem[],
): void {
  const normalized = items
    .map(normalizeDefenseVaultItem)
    .filter((entry): entry is DefenseVaultItem => Boolean(entry));
  storage.setItem(DEFENSE_VAULT_KEY, JSON.stringify(normalized));
}

export function upsertDefenseVaultItem(
  storage: KeyValueStorageSource,
  item: DefenseVaultItem,
): void {
  const normalized = normalizeDefenseVaultItem(item);
  if (!normalized) {
    return;
  }
  const existing = readDefenseVaultItems(storage).filter((entry) => entry.evidenceId !== normalized.evidenceId);
  saveDefenseVaultItems(storage, [...existing, normalized]);
}
