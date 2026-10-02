/**
 * Pulpit warsztatu (tryb eksperta) pokazuje przychód i koszty PIT-38.
 *
 * Poz. 26 i 27 mają grosze. Pola pit38_rounded_* to pełne złote - kafelki
 * pokazywały 11 170 938,00 i 11 083 922,00, choć ich różnica nie dawała
 * dochodu 87 015,66 z tego samego przebiegu.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { Dashboard } from '../../../aplikacje/web/src/invest_analyzer/components/Dashboard.tsx';
import type { TaxEngineResponse } from '../../../aplikacje/web/src/invest_analyzer/hooks/useTaxEngineRun.ts';

test('pulpit pokazuje przychód i koszty z groszami jak poz. 26 i 27', () => {
  const markup = renderToStaticMarkup(
    <Dashboard
      selectedYear={2025}
      engineLoading={false}
      engineResult={{
        success: true,
        status: 'SUCCESS',
        annual_summary: {
          tax_year: '2025',
          pit38_rounded_revenue_pln: '11170938',
          pit38_rounded_cost_pln: '11083922',
          pit38_form_revenue_pln: '11170937.84',
          pit38_form_cost_pln: '11083922.18',
          tax_19_pln: '16532.98',
          taxes_from_dane_pln: '0.11',
          net_pln: '70482.57',
        },
      } as TaxEngineResponse}
    />,
  );
  assert.match(markup, /11[\s ]170[\s ]937,84/);
  assert.match(markup, /11[\s ]083[\s ]922,18/);
  assert.doesNotMatch(markup, /11[\s ]170[\s ]938,00/);
  assert.match(markup, /Podatek 19% scenariusza/);
});

test('pulpit bez annual_summary pokazuje kreski zamiast zer podatkowych', () => {
  const markup = renderToStaticMarkup(
    <Dashboard selectedYear={2025} engineLoading={false} engineResult={{ success: true, status: 'SUCCESS' } as TaxEngineResponse} />,
  );
  assert.match(markup, /Podatek 19% scenariusza<\/span><p[^>]*>–<\/p>/);
  assert.match(markup, /Podatki z danych<\/span><p[^>]*>–<\/p>/);
});
