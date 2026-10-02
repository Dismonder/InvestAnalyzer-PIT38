import type { TaxFilingPackageAuditAppendix } from '../hooks/useTaxEngineRun';
import {
  buildBrokerFileIntakeSummary,
  type BrokerFileIntakeActionRow,
  type BrokerFileActionSeverity,
} from './brokerFileIntake';
import type { BrokerFileActionOverride, BrokerFileActionOverrideStatus } from './brokerFileActionOverrides';

export interface BrokerActionWorkbenchItem {
  actionId: string;
  severity: BrokerFileActionSeverity;
  status: BrokerFileActionOverrideStatus;
  label: string;
  userAction: string;
  sourceIds: string[];
  costIds: string[];
  historySearchTerm: string | null;
  userNote?: string;
  linkedRowId?: string | null;
  area?: string;
  reason?: string;
  supplementalOnlyBreakdownLabel?: string;
}

export interface BrokerActionWorkbench {
  total: number;
  open: number;
  resolved: number;
  ignored: number;
  blockingOpen: number;
  warningOpen: number;
  recommendedItem: BrokerActionWorkbenchItem | null;
  items: BrokerActionWorkbenchItem[];
  groups: {
    blocking: BrokerActionWorkbenchItem[];
    warning: BrokerActionWorkbenchItem[];
    info: BrokerActionWorkbenchItem[];
    resolved: BrokerActionWorkbenchItem[];
    ignored: BrokerActionWorkbenchItem[];
  };
}

const emptyWorkbench = (): BrokerActionWorkbench => ({
  total: 0,
  open: 0,
  resolved: 0,
  ignored: 0,
  blockingOpen: 0,
  warningOpen: 0,
  recommendedItem: null,
  items: [],
  groups: {
    blocking: [],
    warning: [],
    info: [],
    resolved: [],
    ignored: [],
  },
});

function toWorkbenchItem(row: BrokerFileIntakeActionRow): BrokerActionWorkbenchItem {
  return {
    actionId: row.actionId,
    severity: row.severity,
    status: row.status,
    label: row.label,
    userAction: row.userAction,
    sourceIds: row.relatedSourceIds.length > 0 ? row.relatedSourceIds : row.sourceIds,
    costIds: row.relatedCostIds,
    historySearchTerm: row.historySearchTerm || null,
    userNote: row.userNote,
    linkedRowId: row.linkedRowId || null,
    area: row.area,
    reason: row.reason,
    supplementalOnlyBreakdownLabel: row.supplementalOnlyBreakdownLabel,
  };
}

function isOpen(item: BrokerActionWorkbenchItem): boolean {
  return item.status === 'open';
}

function priorityValue(item: BrokerActionWorkbenchItem): number {
  if (!isOpen(item)) {
    return 9;
  }
  if (item.severity === 'blocking') {
    return 0;
  }
  if (item.severity === 'warning') {
    return 1;
  }
  return 2;
}

export function buildBrokerActionWorkbench(
  auditAppendix?: TaxFilingPackageAuditAppendix | null,
  brokerFileActionOverrides: BrokerFileActionOverride[] = [],
): BrokerActionWorkbench {
  if (!auditAppendix) {
    return emptyWorkbench();
  }

  const summary = buildBrokerFileIntakeSummary(auditAppendix, [], [], brokerFileActionOverrides);
  const items = summary.actionRows.map(toWorkbenchItem);
  const groups = emptyWorkbench().groups;

  for (const item of items) {
    if (item.status === 'resolved') {
      groups.resolved.push(item);
    } else if (item.status === 'ignored') {
      groups.ignored.push(item);
    } else if (item.severity === 'blocking') {
      groups.blocking.push(item);
    } else if (item.severity === 'warning') {
      groups.warning.push(item);
    } else {
      groups.info.push(item);
    }
  }

  const openItems = items.filter(isOpen);
  const recommendedItem = [...openItems].sort((left, right) => priorityValue(left) - priorityValue(right))[0] || null;

  return {
    total: items.length,
    open: openItems.length,
    resolved: items.filter((item) => item.status === 'resolved').length,
    ignored: items.filter((item) => item.status === 'ignored').length,
    blockingOpen: openItems.filter((item) => item.severity === 'blocking').length,
    warningOpen: openItems.filter((item) => item.severity === 'warning').length,
    recommendedItem,
    items,
    groups,
  };
}
