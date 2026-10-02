import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TaxKpiCards } from '../../../aplikacje/web/src/portfel/components/tax/TaxKpiCards.tsx';
import { EpitFieldsGrid, wartoscDoSkopiowania } from '../../../aplikacje/web/src/portfel/components/tax/EpitFieldsGrid.tsx';
import { TaxDashboard } from '../../../aplikacje/web/src/portfel/components/TaxDashboard.tsx';
import { DividendsPitZgSection } from '../../../aplikacje/web/src/portfel/components/tax/DividendsPitZgSection.tsx';
import { LossCalculatorPanel } from '../../../aplikacje/web/src/portfel/components/tax/LossCalculatorPanel.tsx';
import { formatCurrency } from '../../../aplikacje/web/src/portfel/services/nbpService.ts';
import type { TaxYearSummary } from '../../../aplikacje/web/src/portfel/types.ts';

const summary = {
  year: 2025,
  revenuePLN: 123.45,
  costsPLN: 11.10,
  incomePLN: 112.35,
  lossPLN: 0,
  taxDuePLN: 20.33,
  taxBeforeCreditPLN: 23.47,
  pit8cRevenuePLN: 12.34,
  pit8cCostsPLN: null,
  foreignRevenuePLN: 111.11,
  foreignCostsPLN: undefined,
  dividendGrossPLN: 80.12,
  dividendForeignTaxPLN: 12.02,
  dividendPolishTaxDuePLN: 15.22,
  dividendTaxToPayPLN: 3.20,
  totalTaxToPayPLN: null,
  transactionCount: 2,
  brokerBreakdowns: [],
} as unknown as TaxYearSummary;

const kwota = (value: number | null | undefined) => value == null ? '—' : formatCurrency(value);
const handleCopy = () => undefined;

test('karty podatkowe zachowują grosze i pokazują brak wyniku jako kreskę', () => {
  const markup = renderToStaticMarkup(<TaxKpiCards currentSummary={summary} transactionCount={2}
    kwota={kwota} copiedField={null} handleCopy={handleCopy} onOpenLossCalc={() => undefined} />);
  assert.match(markup, /123,45 PLN/);
  assert.match(markup, /112,35 PLN/);
  assert.match(markup, /Kopiuj poz. 26/);
  assert.match(markup, /Łączny Podatek PIT-38/);
  assert.match(markup, /—/);
});

test('rok bez wyniku silnika nie wygląda jak strata: karta wyniku jest neutralna', () => {
  const bezWyniku = { ...summary, nieobliczony: true, incomePLN: 0, lossPLN: 0 } as TaxYearSummary;
  const markup = renderToStaticMarkup(<TaxKpiCards currentSummary={bezWyniku} transactionCount={0}
    kwota={() => '—'} copiedField={null} handleCopy={handleCopy} kopiowanieZablokowane="brak wyniku"
    onOpenLossCalc={() => undefined} />);
  const karta = /<div id="card-income-loss"[\s\S]*?<div id="card-tax-due"/.exec(markup)?.[0] ?? '';
  assert.match(karta, /Dochód \/ strata \(poz\. 28 \/ 29\)/);
  assert.doesNotMatch(karta, /Strata \(poz\. 29\)/, 'brak wyniku to nie strata');
  assert.doesNotMatch(karta, /Możliwość odliczenia w 5 latach/);
  assert.doesNotMatch(karta, /rose-/, 'bez czerwonego wyróżnienia straty');
  // Policzona strata nadal jest stratą.
  const strata = renderToStaticMarkup(<TaxKpiCards currentSummary={{ ...summary, incomePLN: 0, lossPLN: 50 } as TaxYearSummary}
    transactionCount={1} kwota={kwota} copiedField={null} handleCopy={handleCopy} onOpenLossCalc={() => undefined} />);
  assert.match(strata, /Strata \(poz\. 29\)/);
  assert.match(strata, /Kopiuj Stratę/);
  // Policzony rok bez zbyć (same dywidendy) też nie jest stratą.
  const zero = renderToStaticMarkup(<TaxKpiCards currentSummary={{ ...summary, incomePLN: 0, lossPLN: 0 } as TaxYearSummary}
    transactionCount={0} kwota={kwota} copiedField={null} handleCopy={handleCopy} onOpenLossCalc={() => undefined} />);
  assert.match(zero, /Bez dochodu i bez straty ze zbycia/);
  assert.doesNotMatch(zero, /Strata \(poz\. 29\)/);
});

test('pola e-PIT renderują kwoty z silnika, nieznane pole i poprawny podpis poz. 33', () => {
  const markup = renderToStaticMarkup(<EpitFieldsGrid currentSummary={summary} transactionCount={2}
    kwota={kwota} kwotaDoDeklaracji={kwota} pit8cZInformacji={false}
    pit8cZnacznik="z transakcji · sprawdź z PIT-8C"
    pit8cRozjazdPrzychodu={null} pit8cRozjazdKosztow={null}
    onOpenFifoDetails={() => undefined} copiedField={null} handleCopy={handleCopy} />);
  assert.match(markup, /12,34 PLN/);
  assert.match(markup, /111,11 PLN/);
  assert.match(markup, /23,47 PLN/);
  assert.match(markup, /Podatek od dochodu z poz. 31/);
  assert.match(markup, /—/);
  assert.match(markup, /Kopiuj poz. 33/);
});

test('brak kwoty PIT-8C blokuje kopiowanie poz. 20 i 21, a zero pozostaje dostępne', () => {
  const markup = renderToStaticMarkup(<EpitFieldsGrid currentSummary={{ ...summary, pit8cRevenuePLN: undefined, pit8cCostsPLN: null } as TaxYearSummary}
    transactionCount={2} kwota={kwota} kwotaDoDeklaracji={kwota} pit8cZInformacji={false}
    pit8cZnacznik="z transakcji" pit8cRozjazdPrzychodu={null} pit8cRozjazdKosztow={null}
    onOpenFifoDetails={() => undefined} copiedField={null} handleCopy={handleCopy} />);
  const przycisk = (html: string, pole: number) => [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)]
    .find(([button]) => button.includes(`Kopiuj poz. ${pole}`))?.[0] ?? '';
  assert.match(przycisk(markup, 20), /disabled=""/);
  assert.match(przycisk(markup, 21), /disabled=""/);
  assert.match(markup, /Kwota PIT-8C nie jest ustalona/);
  assert.equal(wartoscDoSkopiowania(undefined), null);
  assert.equal(wartoscDoSkopiowania(null), null);
  assert.equal(wartoscDoSkopiowania(Number.NaN), null, "NaN nie trafia do schowka jako tekst NaN");
  assert.equal(wartoscDoSkopiowania(0), 0);
  const zero = renderToStaticMarkup(<EpitFieldsGrid currentSummary={{ ...summary, pit8cRevenuePLN: 0, pit8cCostsPLN: 0 } as TaxYearSummary}
    transactionCount={2} kwota={kwota} kwotaDoDeklaracji={kwota} pit8cZInformacji={false}
    pit8cZnacznik="z transakcji" pit8cRozjazdPrzychodu={null} pit8cRozjazdKosztow={null}
    onOpenFifoDetails={() => undefined} copiedField={null} handleCopy={handleCopy} />);
  assert.doesNotMatch(zero, /Kwota PIT-8C nie jest ustalona/);
  assert.doesNotMatch(przycisk(zero, 20), /disabled=""/);
  assert.doesNotMatch(przycisk(zero, 21), /disabled=""/);
});

test('blokada silnika wyłącza XML, pozostawiając dokumenty robocze', () => {
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } });
  try {
    const markup = renderToStaticMarkup(<TaxDashboard yearSummaries={new Map([[2025, summary]])} selectedYear={2025}
      setSelectedYear={() => undefined} realizedGains={[]} dividends={[]} accounts={[]} language="pl"
      onSyncAllApis={async () => undefined} isSyncing={false} onOpenFifoDetails={() => undefined}
      gotoweDoZlozenia={false} />);
    assert.match(markup, /id="btn-export-xml" disabled="" title="Silnik zgłasza blokady rozliczenia/);
    assert.doesNotMatch(markup, /id="btn-export-pdf" disabled=""/);
    assert.doesNotMatch(markup, /id="btn-export-csv" disabled=""/);
    const bezInformacji = renderToStaticMarkup(<TaxDashboard yearSummaries={new Map([[2025, summary]])} selectedYear={2025}
      setSelectedYear={() => undefined} realizedGains={[]} dividends={[]} accounts={[]} language="pl"
      onSyncAllApis={async () => undefined} isSyncing={false} onOpenFifoDetails={() => undefined} />);
    // Brak potwierdzenia gotowosci z silnika (undefined) tez blokuje XML.
    assert.match(bezInformacji, /id="btn-export-xml" disabled="" title="Brak potwierdzenia gotowości/);
  } finally {
    if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('dywidendy PIT\/ZG i kalkulator straty renderują grosze oraz nieznane pola', () => {
  const dividendSummary = { ...summary, dividendGrossPLN: null } as unknown as TaxYearSummary;
  const dividends = renderToStaticMarkup(<DividendsPitZgSection currentSummary={dividendSummary}
    yearDividends={[]} selectedYear={2025} accounts={[]} kwota={kwota} />);
  assert.match(dividends, /12,02 PLN/);
  assert.match(dividends, /3,20 PLN/);
  assert.match(dividends, /—/);

  const loss = renderToStaticMarkup(<LossCalculatorPanel selectedYear={2025} priorYearsLoss={0}
    setPriorYearsLoss={() => undefined} maxDeductibleLoss={null as unknown as number}
    adjustedTotalTaxPLN={10.25} kwota={kwota} />);
  assert.match(loss, /10,25 PLN/);
  assert.match(loss, /—/);
});

test('rok niepoliczony nie przedstawia zer jako gotowego rozliczenia', () => {
  const uncalculated = { ...summary, nieobliczony: true, revenuePLN: 0 };
  const unknownAmount = () => '—';
  const markup = renderToStaticMarkup(<TaxKpiCards currentSummary={uncalculated} transactionCount={0}
    kwota={unknownAmount} copiedField={null} handleCopy={handleCopy} onOpenLossCalc={() => undefined} />);
  assert.doesNotMatch(markup, /0,00 PLN/);
  assert.match(markup, /—/);
});

test('kalkulator straty: bez błędnej etykiety 50% i z właściwą pozycją formularza', () => {
  const markup = renderToStaticMarkup(<LossCalculatorPanel selectedYear={2025} priorYearsLoss={1000}
    setPriorYearsLoss={() => undefined} maxDeductibleLoss={1000} adjustedTotalTaxPLN={0} kwota={kwota} />);
  assert.doesNotMatch(markup, /\(50%\)/);
  assert.match(markup, /poz\. 30 \(część D\)/);
  assert.doesNotMatch(markup, /Części E/);
  assert.match(markup, /50% straty z danego roku/);
  assert.match(markup, /jednorazowo/);
  assert.match(markup, /5 mln zł/);
});

function renderujPulpit(gotowe: boolean | null | undefined) {
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } });
  try {
    return renderToStaticMarkup(<TaxDashboard yearSummaries={new Map([[2025, summary]])} selectedYear={2025}
      setSelectedYear={() => undefined} realizedGains={[]} dividends={[]} accounts={[]} language="pl"
      onSyncAllApis={async () => undefined} isSyncing={false} onOpenFifoDetails={() => undefined}
      gotoweDoZlozenia={gotowe} />);
  } finally {
    if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
}

test('kopiowanie pól deklaracji i nagłówek "Gotowe do Skopiowania" zależą od gotowości rozliczenia', () => {
  for (const niegotowe of [false, null, undefined]) {
    const markup = renderujPulpit(niegotowe);
    assert.doesNotMatch(markup, /Gotowe do Skopiowania/);
    // Każdy przycisk Kopiuj jest wyłączony i ma powód w title.
    const przyciski = markup.match(/<button[^>]*>(?:(?!<\/button>).)*?Kopiuj[^<]*<\/span>/g) ?? [];
    assert.ok(przyciski.length >= 6, `przyciski Kopiuj: ${przyciski.length}`);
    for (const przycisk of przyciski) {
      assert.match(przycisk, /disabled=""/);
      assert.match(przycisk, /title="[^"]*(blokady|potwierdzenia)/);
    }
  }
  const gotowe = renderujPulpit(true);
  assert.match(gotowe, /Gotowe do Skopiowania/);
  assert.doesNotMatch(gotowe, /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*?Kopiuj poz\. 33/);
});
