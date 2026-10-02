import {
  getBrowserTaxSettingsStorage,
  type KeyValueStorageSource,
} from "./taxEngineConfig";
import { mergeStoredLists } from "./mergeStoredLists";

export const DEFENSE_EVIDENCE_OVERRIDES_KEY = "defenseEvidenceOverrides:v1";

export type DefenseEvidenceOverrideStatus =
  | "complete"
  | "needs_user_evidence"
  | "missing_link"
  | "high_risk_review";

export interface DefenseEvidenceOverride {
  evidenceId: string;
  defenseStatus: DefenseEvidenceOverrideStatus;
  linkedTradeIds: string[];
  linkedRowId?: string;
  updatedAt: string;
  userNote?: string;
  evidenceConfirmed?: boolean;
  checkedAt?: string;
  includedInFilingPackage?: boolean;
}

function normalizeOverride(entry: unknown): DefenseEvidenceOverride | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const record = entry as Partial<DefenseEvidenceOverride>;
  const evidenceId = String(record.evidenceId || "").trim();
  const defenseStatus = String(record.defenseStatus || "") as DefenseEvidenceOverrideStatus;
  if (!evidenceId || !["complete", "needs_user_evidence", "missing_link", "high_risk_review"].includes(defenseStatus)) {
    return null;
  }
  return {
    evidenceId,
    defenseStatus,
    linkedTradeIds: Array.isArray(record.linkedTradeIds) ? record.linkedTradeIds.map(String) : [],
    linkedRowId: record.linkedRowId ? String(record.linkedRowId) : undefined,
    updatedAt: String(record.updatedAt || new Date().toISOString()),
    userNote: record.userNote ? String(record.userNote) : undefined,
    evidenceConfirmed: typeof record.evidenceConfirmed === "boolean" ? record.evidenceConfirmed : undefined,
    checkedAt: record.checkedAt ? String(record.checkedAt) : undefined,
    includedInFilingPackage: typeof record.includedInFilingPackage === "boolean" ? record.includedInFilingPackage : undefined,
  };
}

export function readDefenseEvidenceOverrides(
  storage: KeyValueStorageSource = getBrowserTaxSettingsStorage(),
): DefenseEvidenceOverride[] {
  const raw = storage.getItem(DEFENSE_EVIDENCE_OVERRIDES_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map(normalizeOverride)
      .filter((entry): entry is DefenseEvidenceOverride => Boolean(entry));
  } catch {
    return [];
  }
}

export function saveDefenseEvidenceOverrides(
  storage: KeyValueStorageSource,
  overrides: DefenseEvidenceOverride[],
): void {
  const normalized = overrides
    .map(normalizeOverride)
    .filter((entry): entry is DefenseEvidenceOverride => Boolean(entry));
  storage.setItem(DEFENSE_EVIDENCE_OVERRIDES_KEY, JSON.stringify(normalized));
}

export function mergeAndSaveDefenseEvidenceOverrides(
  storage: KeyValueStorageSource,
  base: DefenseEvidenceOverride[],
  local: DefenseEvidenceOverride[],
): DefenseEvidenceOverride[] {
  const merged = mergeStoredLists(base, local, readDefenseEvidenceOverrides(storage), (entry) => entry.evidenceId);
  saveDefenseEvidenceOverrides(storage, merged);
  return merged;
}

export function upsertDefenseEvidenceOverride(
  storage: KeyValueStorageSource,
  override: DefenseEvidenceOverride,
): void {
  const normalized = normalizeOverride(override);
  if (!normalized) {
    return;
  }
  const existing = readDefenseEvidenceOverrides(storage).filter(
    (entry) => entry.evidenceId !== normalized.evidenceId,
  );
  saveDefenseEvidenceOverrides(storage, [...existing, normalized]);
}
