import type { LogEntry } from '../types';
import { storageDispositionMessage } from './storageImportDisposition';

export type UserFacingLogKind =
  | 'blocking_error'
  | 'action_required'
  | 'evidence_needed'
  | 'optional_review'
  | 'technical_info';

export interface DisplayLogEntry extends LogEntry {
  userFacingKind: UserFacingLogKind;
  displayLevel: 'error' | 'warn' | 'info';
  displayMessage: string;
}

function logText(log: LogEntry): string {
  const details = typeof log.details === 'string' ? log.details : log.details ? JSON.stringify(log.details) : '';
  return `${log.message} ${details}`.toLowerCase();
}

function extractImportedFilename(message: string): string | null {
  const match = message.match(/Błąd importu pliku\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function isTraderSummaryFalseError(log: LogEntry): boolean {
  const filename = extractImportedFilename(log.message);
  return (
    log.stage === 'AUTO_IMPORT' &&
    log.level === 'error' &&
    Boolean(filename) &&
    /(^|[\\/])traderzy\.xlsx$/i.test(filename || '')
  );
}

export function buildDisplayLogEntry(log: LogEntry): DisplayLogEntry {
  const text = logText(log);

  if (isTraderSummaryFalseError(log)) {
    const filename = extractImportedFilename(log.message) || 'Traderzy.xlsx';
    return {
      ...log,
      displayLevel: 'info',
      userFacingKind: 'technical_info',
      displayMessage: storageDispositionMessage(filename, 'analytics'),
    };
  }

  if (/plik podsumowujący brokera|dow[oó]d\/analityka|nie tworzy transakcji/.test(text)) {
    return {
      ...log,
      displayLevel: 'info',
      userFacingKind: 'technical_info',
      displayMessage: log.message,
    };
  }

  if (/tylko dowodem|plik dowodowy|dow[oó]d taryf|dowody? do zachowania/.test(text)) {
    return {
      ...log,
      displayLevel: 'info',
      userFacingKind: 'technical_info',
      displayMessage: log.message,
    };
  }

  if (/kontroli pozycji|reconciliation|depozytariusz|dezpozytariusz/.test(text)) {
    return {
      ...log,
      displayLevel: 'info',
      userFacingKind: 'optional_review',
      displayMessage: log.message,
    };
  }

  if (/nieprawidłowy json|uszkodzony|błąd importu pliku|nie rozpoznano formatu/.test(text)) {
    return {
      ...log,
      displayLevel: 'error',
      userFacingKind: 'blocking_error',
      displayMessage: log.message,
    };
  }

  if (log.level === 'error') {
    return {
      ...log,
      displayLevel: 'error',
      userFacingKind: 'blocking_error',
      displayMessage: log.message,
    };
  }

  if (log.level === 'warn') {
    return {
      ...log,
      displayLevel: 'warn',
      userFacingKind: 'action_required',
      displayMessage: log.message,
    };
  }

  return {
    ...log,
    displayLevel: 'info',
    userFacingKind: 'technical_info',
    displayMessage: log.message,
  };
}

export function buildDisplayLogEntries(logs: LogEntry[]): DisplayLogEntry[] {
  return logs.map(buildDisplayLogEntry);
}

export function countBlockingDisplayLogs(logs: Array<Pick<DisplayLogEntry, 'userFacingKind' | 'displayLevel'>>): number {
  return logs.filter((log) => log.userFacingKind === 'blocking_error' && log.displayLevel === 'error').length;
}

export function userFacingLogKindLabel(kind: UserFacingLogKind): string {
  const labels: Record<UserFacingLogKind, string> = {
    blocking_error: 'kontrola PIT',
    action_required: 'wymaga działania',
    evidence_needed: 'dowód do zachowania',
    optional_review: 'kontrola pomocnicza',
    technical_info: 'informacja techniczna',
  };
  return labels[kind];
}
