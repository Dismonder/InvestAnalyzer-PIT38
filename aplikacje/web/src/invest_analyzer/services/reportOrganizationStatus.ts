export type TaxReportOrganizationState = 'draft' | 'ready' | 'downloaded' | 'paid' | 'submitted';

export interface TaxReportOrganizationStatus {
  year: number;
  status: TaxReportOrganizationState;
  updatedAt: string;
}

export const TAX_REPORT_ORGANIZATION_STATUS_KEY = 'taxReportOrganizationStatus';

export const TAX_REPORT_ORGANIZATION_LABELS: Record<TaxReportOrganizationState, string> = {
  draft: 'Nieprzygotowany',
  ready: 'Gotowy',
  downloaded: 'Pobrany',
  paid: 'Opłacony',
  submitted: 'Wysłany',
};

type StoredStatuses = Record<string, TaxReportOrganizationStatus>;

function readAll(storage: Storage): StoredStatuses {
  const raw = storage.getItem(TAX_REPORT_ORGANIZATION_STATUS_KEY);
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeAll(storage: Storage, statuses: StoredStatuses): void {
  storage.setItem(TAX_REPORT_ORGANIZATION_STATUS_KEY, JSON.stringify(statuses));
}

export function getDefaultTaxReportOrganizationStatus(year: number): TaxReportOrganizationStatus {
  return {
    year,
    status: 'draft',
    updatedAt: new Date().toISOString(),
  };
}

export function readTaxReportOrganizationStatus(storage: Storage, year: number): TaxReportOrganizationStatus {
  const statuses = readAll(storage);
  const stored = statuses[String(year)];
  if (stored && stored.year === year && stored.status in TAX_REPORT_ORGANIZATION_LABELS) {
    return stored;
  }
  return getDefaultTaxReportOrganizationStatus(year);
}

export function saveTaxReportOrganizationStatus(storage: Storage, status: TaxReportOrganizationStatus): void {
  const statuses = readAll(storage);
  statuses[String(status.year)] = status;
  writeAll(storage, statuses);
}

export function markTaxReportOrganizationStatus(
  storage: Storage,
  year: number,
  status: TaxReportOrganizationState,
): TaxReportOrganizationStatus {
  const next = {
    year,
    status,
    updatedAt: new Date().toISOString(),
  };
  saveTaxReportOrganizationStatus(storage, next);
  return next;
}
