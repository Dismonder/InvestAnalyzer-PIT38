import type {
  DefenseEvidenceLink,
  PitSubmissionChecklistItem,
  PitSubmissionReadiness,
  TaxFilingPackageAuditAppendix,
  TaxTraceEntry,
} from "../hooks/useTaxEngineRun";
import { buildHistoryNavigationTargetFromTrace, type HistoryNavigationTarget } from "./taxTraceExplorer";

export type PitRepairGroupId = "blocking" | "evidence" | "risk" | "review";

export interface PitRepairConsoleItem {
  id: string;
  groupId: PitRepairGroupId;
  label: string;
  userAction: string;
  details: string;
  severity: string;
  category: string;
  traceId: string | null;
  linkedCostId: string | null;
  historyTarget: HistoryNavigationTarget;
}

export interface PitRepairConsoleGroup {
  id: PitRepairGroupId;
  label: string;
  description: string;
  count: number;
}

export interface PitRepairConsoleState {
  verdict: PitSubmissionReadiness["verdict"] | null;
  score: number | null;
  items: PitRepairConsoleItem[];
  groups: PitRepairConsoleGroup[];
  recommendedItem: PitRepairConsoleItem | null;
}

const GROUP_META: Record<PitRepairGroupId, Omit<PitRepairConsoleGroup, "count">> = {
  blocking: {
    id: "blocking",
    label: "Kontrole PIT",
    description: "Braki danych, NBP albo niespójności, które trzeba sprawdzić przed bezpiecznym złożeniem.",
  },
  evidence: {
    id: "evidence",
    label: "Dowody do zebrania",
    description: "Koszty i pozycje wymagające potwierdzeń, notatek albo linków do transakcji.",
  },
  risk: {
    id: "risk",
    label: "Ryzyka agresywne",
    description: "Pozycje możliwe do obrony, ale wymagające świadomej decyzji i dokumentacji.",
  },
  review: {
    id: "review",
    label: "Do sprawdzenia",
    description: "Pozostałe pozycje wymagające ręcznej kontroli albo wyjaśnienia.",
  },
};

function asArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function groupIdForChecklistItem(item: PitSubmissionChecklistItem): PitRepairGroupId {
  if (item.severity === "blocking") return "blocking";
  if (item.severity === "evidence") return "evidence";
  if (item.severity === "risk") return "risk";
  return "review";
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

function findTraceForChecklist(
  item: PitSubmissionChecklistItem,
  evidence: DefenseEvidenceLink | null,
  traceIndex: TaxTraceEntry[],
): TaxTraceEntry | null {
  return traceIndex.find((trace) => (
    trace.checklist_item_ids.includes(item.id) ||
    (evidence?.evidenceId ? trace.evidence_ids.includes(evidence.evidenceId) : false) ||
    (item.sourceId ? trace.source_record_ids.includes(item.sourceId) : false) ||
    (evidence?.sourceRecordId ? trace.source_record_ids.includes(evidence.sourceRecordId) : false)
  )) || null;
}

function buildDetails(item: PitSubmissionChecklistItem, evidence: DefenseEvidenceLink | null): string {
  const missingEvidence = asArray(evidence?.missingEvidence).filter(Boolean);
  const linkedTrades = asArray(evidence?.linkedTradeIds).filter(Boolean);
  return [
    item.userAction,
    missingEvidence.length > 0 ? `Braki: ${missingEvidence.join(", ")}` : "",
    evidence?.sourceRecordId ? `Źródło: ${evidence.sourceRecordId}` : item.sourceId ? `Źródło: ${item.sourceId}` : "",
    linkedTrades.length > 0 ? `Powiązane transakcje: ${linkedTrades.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function historyTargetForChecklist(
  item: PitSubmissionChecklistItem,
  evidence: DefenseEvidenceLink | null,
  trace: TaxTraceEntry | null,
): HistoryNavigationTarget {
  const traceTarget = buildHistoryNavigationTargetFromTrace(trace);
  const searchTerm =
    traceTarget.searchTerm ||
    item.linkedRowId ||
    item.sourceId ||
    evidence?.sourceRecordId ||
    evidence?.linkedTradeIds?.find(Boolean) ||
    item.linkedCostId ||
    item.id;
  return {
    searchTerm,
    rowId: item.linkedRowId || traceTarget.rowId || item.sourceId || evidence?.sourceRecordId || null,
  };
}

export function buildPitRepairConsole(
  auditAppendix: TaxFilingPackageAuditAppendix | null | undefined,
): PitRepairConsoleState {
  const readiness = auditAppendix?.pit_submission_readiness || null;
  const checklist = asArray(readiness?.checklist)
    .filter((item) => item.severity !== "info");
  const evidenceLinks = asArray(auditAppendix?.defense_evidence_links);
  const traceIndex = asArray(auditAppendix?.tax_trace_index);

  const items = checklist.map((item): PitRepairConsoleItem => {
    const evidence = findEvidenceForChecklist(item, evidenceLinks);
    const trace = findTraceForChecklist(item, evidence, traceIndex);
    return {
      id: item.id,
      groupId: groupIdForChecklistItem(item),
      label: item.label,
      userAction: item.userAction,
      details: buildDetails(item, evidence),
      severity: item.severity,
      category: item.category,
      traceId: trace?.trace_id || null,
      linkedCostId: item.linkedCostId || evidence?.costId || null,
      historyTarget: historyTargetForChecklist(item, evidence, trace),
    };
  });

  const groups = (Object.keys(GROUP_META) as PitRepairGroupId[]).map((id) => ({
    ...GROUP_META[id],
    count: items.filter((item) => item.groupId === id).length,
  }));

  return {
    verdict: readiness?.verdict || null,
    score: readiness?.score ?? null,
    items,
    groups,
    recommendedItem:
      items.find((item) => item.id === readiness?.recommendedAction?.id) ||
      items.find((item) => item.groupId === "blocking") ||
      items.find((item) => item.groupId === "evidence") ||
      items[0] ||
      null,
  };
}
