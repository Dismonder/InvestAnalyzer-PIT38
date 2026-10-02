import type {
  DefenseEvidenceLink,
  PitSubmissionChecklistItem,
  PitSubmissionReadiness,
  TaxFilingPackageAuditAppendix,
  TaxTraceEntry,
} from "../hooks/useTaxEngineRun";
import type { DefenseEvidenceOverride, DefenseEvidenceOverrideStatus } from "./defenseEvidenceOverrides";
import { buildHistoryNavigationTargetFromTrace, type HistoryNavigationTarget } from "./taxTraceExplorer";

export type DefenseWorkbenchGroupId = "blocking" | "evidence" | "risk" | "review";

export interface DefenseWorkbenchItem {
  id: string;
  groupId: DefenseWorkbenchGroupId;
  checklistId: string | null;
  evidenceId: string | null;
  traceId: string | null;
  label: string;
  userAction: string;
  details: string;
  severity: string;
  category: string;
  sourceRecordId: string | null;
  linkedCostId: string | null;
  linkedTradeIds: string[];
  linkedRowId: string | null;
  amountPln: string | number | null;
  riskLevel: string | null;
  defenseStatus: DefenseEvidenceOverrideStatus | string;
  defenseStatusLabel: string;
  missingEvidence: string[];
  localOverride: DefenseEvidenceOverride | null;
  localNote: string;
  evidenceConfirmed: boolean;
  includedInFilingPackage: boolean;
  historyTarget: HistoryNavigationTarget;
}

export interface DefenseWorkbenchGroup {
  id: DefenseWorkbenchGroupId;
  label: string;
  description: string;
  count: number;
}

export interface DefenseWorkbenchProgress {
  totalEvidenceItems: number;
  confirmedEvidenceItems: number;
  highRiskItems: number;
  missingLinkItems: number;
  missingUserNoteItems: number;
  completionPercent: number;
}

export interface DefenseWorkbenchState {
  verdict: PitSubmissionReadiness["verdict"] | null;
  score: number | null;
  items: DefenseWorkbenchItem[];
  groups: DefenseWorkbenchGroup[];
  progress: DefenseWorkbenchProgress;
  recommendedItem: DefenseWorkbenchItem | null;
}

const GROUP_META: Record<DefenseWorkbenchGroupId, Omit<DefenseWorkbenchGroup, "count">> = {
  blocking: {
    id: "blocking",
    label: "Kontrole PIT",
    description: "Pozycje wymagające kontroli przed bezpiecznym złożeniem PIT: dane, NBP albo spójność obliczeń.",
  },
  evidence: {
    id: "evidence",
    label: "Dowody",
    description: "Koszty i ścieżki kwot wymagające potwierdzeń, notatek albo linków do historii.",
  },
  risk: {
    id: "risk",
    label: "Ryzyka",
    description: "Pozycje wysokiego ryzyka w planie agresywnym, które wymagają świadomej decyzji.",
  },
  review: {
    id: "review",
    label: "Do sprawdzenia",
    description: "Pozostałe pozycje audytowe wymagające ręcznego przejrzenia.",
  },
};

const DEFENSE_STATUS_LABELS: Record<string, string> = {
  complete: "Dowód kompletny",
  needs_user_evidence: "Wymaga dowodu",
  missing_link: "Brak linku",
  high_risk_review: "Wysokie ryzyko",
};

function asArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function groupIdForChecklist(item: PitSubmissionChecklistItem): DefenseWorkbenchGroupId {
  if (item.severity === "blocking") return "blocking";
  if (item.severity === "risk") return "risk";
  if (item.severity === "evidence") return "evidence";
  return "review";
}

function groupIdForEvidence(evidence: DefenseEvidenceLink): DefenseWorkbenchGroupId {
  if (evidence.riskLevel === "high" && evidence.defenseStatus === "high_risk_review") {
    return "risk";
  }
  if (evidence.defenseStatus === "complete") {
    return "review";
  }
  return "evidence";
}

function findEvidenceForChecklist(
  item: PitSubmissionChecklistItem,
  evidenceLinks: DefenseEvidenceLink[],
): DefenseEvidenceLink | null {
  return evidenceLinks.find((link) => (
    (item.linkedCostId && link.costId === item.linkedCostId) ||
    (item.sourceId && link.sourceRecordId === item.sourceId)
  )) || null;
}

function findTrace(
  item: PitSubmissionChecklistItem | null,
  evidence: DefenseEvidenceLink | null,
  traceIndex: TaxTraceEntry[],
): TaxTraceEntry | null {
  return traceIndex.find((trace) => (
    (item?.id ? trace.checklist_item_ids.includes(item.id) : false) ||
    (evidence?.evidenceId ? trace.evidence_ids.includes(evidence.evidenceId) : false) ||
    (item?.sourceId ? trace.source_record_ids.includes(item.sourceId) : false) ||
    (evidence?.sourceRecordId ? trace.source_record_ids.includes(evidence.sourceRecordId) : false) ||
    (evidence?.linkedTradeIds || []).some((id) => trace.source_record_ids.includes(id))
  )) || null;
}

function findOverride(
  evidence: DefenseEvidenceLink | null,
  item: PitSubmissionChecklistItem | null,
  overrides: DefenseEvidenceOverride[],
): DefenseEvidenceOverride | null {
  return overrides.find((entry) => (
    (evidence?.evidenceId && entry.evidenceId === evidence.evidenceId) ||
    (evidence?.costId && entry.evidenceId === evidence.costId) ||
    (item?.linkedCostId && entry.evidenceId === item.linkedCostId) ||
    (item?.id && entry.evidenceId === item.id)
  )) || null;
}

function buildDetails(
  item: PitSubmissionChecklistItem | null,
  evidence: DefenseEvidenceLink | null,
  localOverride: DefenseEvidenceOverride | null,
): string {
  const missingEvidence = asArray(evidence?.missingEvidence).filter(Boolean);
  return [
    item?.userAction || evidence?.userActionLabel || "",
    missingEvidence.length > 0 ? `Braki: ${missingEvidence.join(", ")}` : "",
    evidence?.sourceRecordId ? `Źródło: ${evidence.sourceRecordId}` : item?.sourceId ? `Źródło: ${item.sourceId}` : "",
    localOverride?.userNote ? `Notatka: ${localOverride.userNote}` : "",
  ].filter(Boolean).join(" ");
}

function buildHistoryTarget(
  item: PitSubmissionChecklistItem | null,
  evidence: DefenseEvidenceLink | null,
  trace: TaxTraceEntry | null,
  localOverride: DefenseEvidenceOverride | null,
): HistoryNavigationTarget {
  const traceTarget = buildHistoryNavigationTargetFromTrace(trace);
  const linkedRowId = localOverride?.linkedRowId || item?.linkedRowId || traceTarget.rowId || null;
  const searchTerm =
    linkedRowId ||
    traceTarget.searchTerm ||
    item?.sourceId ||
    evidence?.sourceRecordId ||
    evidence?.linkedTradeIds?.find(Boolean) ||
    item?.linkedCostId ||
    evidence?.costId ||
    evidence?.evidenceId ||
    item?.id ||
    "";
  return {
    searchTerm,
    rowId: linkedRowId || item?.sourceId || evidence?.sourceRecordId || null,
  };
}

function buildItem(params: {
  item: PitSubmissionChecklistItem | null;
  evidence: DefenseEvidenceLink | null;
  trace: TaxTraceEntry | null;
  localOverride: DefenseEvidenceOverride | null;
  fallbackGroupId?: DefenseWorkbenchGroupId;
}): DefenseWorkbenchItem {
  const { item, evidence, trace, localOverride, fallbackGroupId } = params;
  const evidenceStatus = localOverride?.defenseStatus || evidence?.defenseStatus || "needs_user_evidence";
  const groupId = item ? groupIdForChecklist(item) : fallbackGroupId || groupIdForEvidence(evidence as DefenseEvidenceLink);
  const linkedTradeIds = localOverride?.linkedTradeIds?.length
    ? localOverride.linkedTradeIds
    : asArray(evidence?.linkedTradeIds).map(String);
  const historyTarget = buildHistoryTarget(item, evidence, trace, localOverride);
  return {
    id: item?.id || evidence?.evidenceId || evidence?.costId || trace?.trace_id || "defense-workbench-item",
    groupId,
    checklistId: item?.id || null,
    evidenceId: evidence?.evidenceId || null,
    traceId: trace?.trace_id || null,
    label: item?.label || evidence?.costId || trace?.label || "Pozycja dowodowa",
    userAction: item?.userAction || evidence?.userActionLabel || "Zweryfikuj pozycję i uzupełnij dowód.",
    details: buildDetails(item, evidence, localOverride),
    severity: item?.severity || (groupId === "risk" ? "risk" : "evidence"),
    category: item?.category || "defense",
    sourceRecordId: evidence?.sourceRecordId || item?.sourceId || null,
    linkedCostId: item?.linkedCostId || evidence?.costId || null,
    linkedTradeIds,
    linkedRowId: localOverride?.linkedRowId || item?.linkedRowId || historyTarget.rowId || null,
    amountPln: evidence?.amountPln || trace?.amount_pln || null,
    riskLevel: evidence?.riskLevel || trace?.risk_level || (groupId === "risk" ? "high" : null),
    defenseStatus: evidenceStatus,
    defenseStatusLabel: DEFENSE_STATUS_LABELS[evidenceStatus] || evidenceStatus,
    missingEvidence: asArray(evidence?.missingEvidence).filter(Boolean),
    localOverride,
    localNote: localOverride?.userNote || "",
    evidenceConfirmed: Boolean(localOverride?.evidenceConfirmed || localOverride?.defenseStatus === "complete" || evidence?.evidenceConfirmed),
    includedInFilingPackage: Boolean(localOverride?.includedInFilingPackage || evidence?.includedInFilingPackage),
    historyTarget,
  };
}

export function buildDefenseWorkbench(
  auditAppendix: TaxFilingPackageAuditAppendix | null | undefined,
  overrides: DefenseEvidenceOverride[] = [],
): DefenseWorkbenchState {
  const readiness = auditAppendix?.pit_submission_readiness || null;
  const checklist = asArray(readiness?.checklist).filter((item) => item.severity !== "info");
  const evidenceLinks = asArray(auditAppendix?.defense_evidence_links);
  const traceIndex = asArray(auditAppendix?.tax_trace_index);
  const usedEvidenceIds = new Set<string>();

  const checklistItems = checklist.map((item) => {
    const evidence = findEvidenceForChecklist(item, evidenceLinks);
    if (evidence?.evidenceId) {
      usedEvidenceIds.add(evidence.evidenceId);
    }
    const trace = findTrace(item, evidence, traceIndex);
    return buildItem({
      item,
      evidence,
      trace,
      localOverride: findOverride(evidence, item, overrides),
    });
  });

  const orphanEvidenceItems = evidenceLinks
    .filter((evidence) => !usedEvidenceIds.has(evidence.evidenceId))
    .map((evidence) => buildItem({
      item: null,
      evidence,
      trace: findTrace(null, evidence, traceIndex),
      localOverride: findOverride(evidence, null, overrides),
    }));

  const items = [...checklistItems, ...orphanEvidenceItems];
  const groups = (Object.keys(GROUP_META) as DefenseWorkbenchGroupId[]).map((id) => ({
    ...GROUP_META[id],
    count: items.filter((item) => item.groupId === id).length,
  }));
  const evidenceItems = items.filter((item) => item.groupId === "evidence" || item.groupId === "risk");
  const confirmedEvidenceItems = evidenceItems.filter((item) => item.evidenceConfirmed).length;
  const totalEvidenceItems = evidenceItems.length;
  const progress: DefenseWorkbenchProgress = {
    totalEvidenceItems,
    confirmedEvidenceItems,
    highRiskItems: items.filter((item) => item.groupId === "risk" || item.riskLevel === "high").length,
    missingLinkItems: items.filter((item) => item.defenseStatus === "missing_link" && !item.evidenceConfirmed).length,
    missingUserNoteItems: evidenceItems.filter((item) => !item.localNote).length,
    completionPercent: totalEvidenceItems > 0 ? Math.round((confirmedEvidenceItems / totalEvidenceItems) * 100) : 100,
  };

  return {
    verdict: readiness?.verdict || null,
    score: readiness?.score ?? null,
    items,
    groups,
    progress,
    recommendedItem:
      items.find((item) => item.checklistId === readiness?.recommendedAction?.id) ||
      items.find((item) => item.groupId === "blocking") ||
      items.find((item) => item.groupId === "evidence") ||
      items.find((item) => item.groupId === "risk") ||
      items[0] ||
      null,
  };
}
