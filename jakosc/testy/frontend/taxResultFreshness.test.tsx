import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { taxResultFreshness } from '../../../aplikacje/web/src/invest_analyzer/services/taxResultFreshness.ts';
import { YearlyReport } from '../../../aplikacje/web/src/invest_analyzer/components/YearlyReport.tsx';
import type { TaxEngineResponse } from '../../../aplikacje/web/src/invest_analyzer/hooks/useTaxEngineRun.ts';
import { Dashboard } from '../../../aplikacje/web/src/invest_analyzer/components/Dashboard.tsx';
import { TaxDashboard } from '../../../aplikacje/web/src/portfel/components/TaxDashboard.tsx';
import type { TaxYearSummary } from '../../../aplikacje/web/src/portfel/types.ts';

const result: TaxEngineResponse = {
  success: true,
  status: 'SUCCESS',
  filing_ready: true,
  annual_summary: { tax_year: '2025', net_pln: '100' },
  exported_files: ['tax_report.xlsx'],
  tax_filing_package: { audit_appendix: { pit_case_file: {
    case_file_id: 'case-2025', generated_at: '2026-04-01T00:00:00Z', tax_year: '2025',
    plan_used: 'aggressive_user', audit_hash: 'audit', reproducible: true,
    reproducibility_status: 'complete', input_fingerprint: 'input-a', calculation_fingerprint: 'calc-a',
  } } },
};

function renderReport(engineStale: boolean, canUseEngineResult: boolean) {
  return renderToStaticMarkup(<YearlyReport
    selectedYear={2025} engineLoading={false} packageLoading={false} engineResult={result}
    engineStale={engineStale} canUseEngineResult={canUseEngineResult}
    runPythonEngine={async () => result}
    reportOrganizationStatus={{ year: 2025, status: 'draft', updatedAt: '2026-04-01T00:00:00Z' }}
    onReportOrganizationStatusChange={() => undefined} uiComplexityMode="expert"
  />);
}

function buttonWith(markup: string, label: string) {
  return Array.from(markup.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g), ([match]) => match)
    .find((button) => button.includes(label)) ?? '';
}

test('zmiana roku ukrywa wynik innego roku i blokuje eksport', () => {
  const freshness = taxResultFreshness({ selectedYear: 2026, resultYear: 2025, currentKey: null, resultKey: 'a', failed: false, loading: true });
  assert.equal(freshness.sameYear, false);
  assert.equal(freshness.canExport, false);
  const markup = renderToStaticMarkup(<YearlyReport
    selectedYear={2026} engineLoading={true} packageLoading={false} engineResult={null}
    canUseEngineResult={false} runPythonEngine={async () => result}
    reportOrganizationStatus={{ year: 2026, status: 'draft', updatedAt: '2026-04-01T00:00:00Z' }}
    onReportOrganizationStatusChange={() => undefined}
  />);
  assert.doesNotMatch(markup, /tax_report\.xlsx/);
});

test('edycja straty zmienia odcisk, oznacza raport i blokuje pakiet, artefakt i zamknięcie', () => {
  const freshness = taxResultFreshness({ selectedYear: 2025, resultYear: 2025, currentKey: 'loss-edited', resultKey: 'original', failed: false, loading: false });
  assert.equal(freshness.stale, true);
  assert.equal(freshness.canExport, false);
  const markup = renderReport(freshness.stale, freshness.canExport);
  assert.match(markup, /NIEAKTUALNE — przelicz ponownie przed eksportem lub zamknięciem roku/);
  for (const label of ['Zamknij rok 2025', 'Pobierz workbook XLSX', 'pakiet podatkowy']) {
    const button = buttonWith(markup, label);
    assert.ok(button, `Brak przycisku ${label}`);
    assert.match(button, /disabled=""/);
  }
});

test('błąd ostatniego przebiegu oznacza poprzednią kwotę i blokuje XML/PDF w portfelu', () => {
  const freshness = taxResultFreshness({ selectedYear: 2025, resultYear: 2025, currentKey: 'same', resultKey: 'same', failed: true, loading: false });
  assert.equal(freshness.stale, true);
  const summary = { year: 2025, revenuePLN: 1000, costsPLN: 100, incomePLN: 900, lossPLN: 0,
    taxDuePLN: 171, dividendGrossPLN: 0, dividendForeignTaxPLN: 0, dividendPolishTaxDuePLN: 0,
    dividendTaxToPayPLN: 0, totalTaxToPayPLN: 171, transactionCount: 1, brokerBreakdowns: [],
  } as TaxYearSummary;
  const previousStorage = (globalThis as typeof globalThis & { localStorage?: unknown }).localStorage;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: () => null, setItem: () => undefined,
  } });
  let markup: string;
  try {
    markup = renderToStaticMarkup(<TaxDashboard
      yearSummaries={new Map([[2025, summary]])} selectedYear={2025} setSelectedYear={() => undefined}
      realizedGains={[]} dividends={[]} accounts={[]} transactions={[]} language="pl"
      onSyncAllApis={async () => undefined} isSyncing={false} onOpenFifoDetails={() => undefined}
      resultStale={freshness.stale} canExport={freshness.canExport}
    />);
  } finally {
    if (previousStorage === undefined) Reflect.deleteProperty(globalThis, 'localStorage');
    else Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previousStorage });
  }
  assert.match(markup, /Należny podatek:[\s\S]*NIEAKTUALNE — przelicz ponownie/);
  for (const id of ['btn-export-xml', 'btn-export-pdf', 'btn-export-annual-summary-pdf']) {
    assert.match(buttonWith(markup, `id="${id}"`), /disabled=""/);
  }
});

test('pulpit na czas przeliczenia pokazuje poprzednie liczby z etykietą, a nie zera', () => {
  const markup = renderToStaticMarkup(<Dashboard selectedYear={2025} engineLoading={true} engineResult={result} engineStale={true} />);
  assert.match(markup, /NIEAKTUALNE — liczby sprzed ostatniej zmiany danych/);
  const aktualny = renderToStaticMarkup(<Dashboard selectedYear={2025} engineLoading={false} engineResult={result} />);
  assert.doesNotMatch(aktualny, /NIEAKTUALNE/);
});
