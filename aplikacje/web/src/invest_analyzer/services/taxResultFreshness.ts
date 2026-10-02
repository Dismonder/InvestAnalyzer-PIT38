export interface TaxResultFreshnessInput {
  selectedYear: number;
  resultYear: number | null;
  currentKey: string | null;
  resultKey: string | null;
  failed: boolean;
  loading: boolean;
}

export function taxResultFreshness(input: TaxResultFreshnessInput) {
  const sameYear = input.resultYear === input.selectedYear;
  const stale = sameYear && (input.failed || input.loading || !input.currentKey || input.currentKey !== input.resultKey);
  return {
    sameYear,
    stale,
    canExport: sameYear && !stale,
    message: stale ? 'NIEAKTUALNE — przelicz ponownie przed eksportem lub zamknięciem roku.' : null,
  };
}
