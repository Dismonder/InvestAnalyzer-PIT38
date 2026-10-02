export type AutoImportDisposition =
  | 'transactions'
  | 'nbp'
  | 'evidence'
  | 'reconciliation'
  | 'analytics'
  | 'raw_data';

function storageBasename(filename: string): string {
  return filename
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .pop()
    ?.toLowerCase() || '';
}

export function isBrokerReportFile(filename: string): boolean {
  const base = storageBasename(filename);
  return base.startsWith('broker_raport') && base.endsWith('.json');
}

function isReconciliationStorageFile(lowerFilename: string): boolean {
  return (
    lowerFilename.includes('depositary') ||
    lowerFilename.includes('depozytariusz') ||
    lowerFilename.includes('dezpozytariusz') ||
    lowerFilename.includes('depozyt') ||
    lowerFilename.includes('depoz')
  );
}

function isTraderSummaryFile(filename: string): boolean {
  const base = storageBasename(filename);
  return (
    base === 'traderzy.xlsx' ||
    base === 'traderzy.xls' ||
    base.includes('traders_summary') ||
    base.includes('trader_summary')
  );
}

export function getStorageFileDisposition(filename: string): AutoImportDisposition {
  const lowerFilename = filename.toLowerCase();
  if (lowerFilename.endsWith('.pdf')) {
    return 'evidence';
  }
  if (isTraderSummaryFile(filename)) {
    return 'analytics';
  }
  if (isReconciliationStorageFile(lowerFilename)) {
    return 'reconciliation';
  }
  if (lowerFilename.includes('archiwum') || lowerFilename.includes('nbp')) {
    return 'nbp';
  }
  if (lowerFilename.endsWith('.json')) {
    return 'transactions';
  }
  if (
    lowerFilename.endsWith('.xlsx') ||
    lowerFilename.endsWith('.xls') ||
    lowerFilename.endsWith('.csv') ||
    lowerFilename.endsWith('.xml')
  ) {
    return 'transactions';
  }
  return 'raw_data';
}

export function storageDispositionMessage(filename: string, disposition: AutoImportDisposition): string {
  if (disposition === 'evidence') {
    return `Przyjęto plik ${filename} jako dowód źródłowy widoczny w mapie danych.`;
  }
  if (disposition === 'analytics') {
    return `Przyjęto plik ${filename} jako podsumowanie brokera/analitykę do kontekstu źródeł.`;
  }
  if (disposition === 'reconciliation') {
    return `Przyjęto plik ${filename} jako dane kontroli pozycji.`;
  }
  if (disposition === 'raw_data') {
    return `Przyjęto plik ${filename} jako surowe dane do canonical input.`;
  }
  return `Przyjęto plik ${filename} do strumienia canonical input.`;
}
