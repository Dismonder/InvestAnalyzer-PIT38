import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { PortfolioKpiCards } from '../../../aplikacje/web/src/portfel/components/portfolio/PortfolioKpiCards.tsx';
import { PortfolioTaxSummaryBanner } from '../../../aplikacje/web/src/portfel/components/portfolio/PortfolioTaxSummaryBanner.tsx';
import { HoldingsTable } from '../../../aplikacje/web/src/portfel/components/portfolio/HoldingsTable.tsx';
import { HoldingsFifoLots } from '../../../aplikacje/web/src/portfel/components/portfolio/HoldingsFifoLots.tsx';
import { AllocationCharts } from '../../../aplikacje/web/src/portfel/components/portfolio/AllocationCharts.tsx';

const position = {
  ticker: 'TEST', name: 'Przykładowa spółka', category: 'STOCK_FOREIGN', currency: 'USD',
  walutaCeny: 'USD', accountIds: ['konto'], accountsCount: 1, primaryAccountName: 'Rachunek',
  totalQuantity: 2, openLotsCount: 1, avgBuyPrice: 10, avgBuyPricePLN: 40,
  currentPriceOrig: 12, currentPricePLN: 48, currentValuePLN: 96, totalCostPLN: 80,
  maNotowanie: false, maWycene: true, zrodloCeny: 'BROKER', change24h: null,
  dailyPnLPLN: null, unrealizedPLN: 16, unrealizedPct: 20,
  unrealizedOrig: 4, unrealizedPctOrig: 20, fxImpactPLN: 0,
  lots: [{ accountId: 'konto', buyDate: '2026-09-21', initialQty: 2, remainingQty: 2,
    pricePerUnit: 10, currency: 'USD', exchangeRate: 4, exchangeTable: 'A',
    exchangeDate: '2026-09-20', costPLN: 80, commissionPLN: 0 }],
};

test('karty KPI renderują brak danych dziennych bez wyjątku i bez fałszywego zera', () => {
  const markup = renderToStaticMarkup(<PortfolioKpiCards
    totalValuePLN={96} liczbaBezWyceny={0} komunikatBrakow="" sumaUSD={24} sumaEUR={22}
    wynikZnany wynikNaPlus totalUnrealizedPLN={16} totalUnrealizedPct={20}
    totalCostBasisPLN={80} danePozycjiNieznane={false}
    zmianaZnana={false} zmianaNaPlus={false} totalDailyChangePLN={null}
    totalDailyChangePct={null} liczbaZeZnanaZmiana={0} liczbaWycenionychPozycji={1}
    klasaWyniku={(known: boolean, positive: boolean, up: string, down: string, unknown: string) => known ? positive ? up : down : unknown}
  />);
  assert.match(markup, /Dzienna Zmiana \(24h\)/);
  assert.match(markup, /brak wyceny/);
  assert.match(markup, /brak danych o zmianie/);
  assert.doesNotMatch(markup, /\+0\.00%/);
});

test('tabela i transze FIFO renderują pozycję z change24h oraz dailyPnLPLN równymi null', () => {
  const markup = renderToStaticMarkup(<HoldingsTable
    searchTerm="" setSearchTerm={() => undefined} selectedCategory="ALL" setSelectedCategory={() => undefined}
    selectedBroker="ALL" setSelectedBroker={() => undefined}
    accounts={[{ id: 'konto', name: 'Rachunek' }]} filteredPositions={[position]}
    enrichedPositions={[position]} expandedPosition="TEST" setExpandedPosition={() => undefined}
    onQuickAddTransaction={() => undefined} totalValuePLN={96} onOpenPriceAlert={() => undefined}
    onSelectTickerForChart={() => undefined} onNavigateToTab={() => undefined}
    setOptionsModalTicker={() => undefined} setShowOptionsModal={() => undefined}
    handleClosePosition={() => undefined}
    CATEGORY_LABELS={{ STOCK_FOREIGN: { label: 'Akcje Zagraniczne', bg: 'bg-blue-500/10 text-blue-500 border-blue-500/30' } }}
  />);
  assert.match(markup, /Przykładowa spółka/);
  assert.match(markup, /Szczegóły otwartych transz/);
  assert.doesNotMatch(markup, /\+0\.00%/);

  const lots = renderToStaticMarkup(<HoldingsFifoLots
    isExpanded pos={position} accounts={[{ id: 'konto', name: 'Rachunek' }]}
    handleClosePosition={() => undefined}
  />);
  assert.match(lots, /Rachunek/);
});

test('wykres alokacji i baner podatkowy renderują bieżące dane', () => {
  const charts = renderToStaticMarkup(<AllocationCharts
    enrichedPositions={[position]} totalValuePLN={96} accounts={[{ id: 'konto', name: 'Rachunek' }]}
    categoryAllocationData={[]} brokerAllocationData={[]}
    currencyAllocationData={[{ name: 'USD', count: 1, value: 96, percentage: '100', color: '#10B981' }]}
    brokerDependencyMatrix={[]} brokerHHI={0} allocationView="CURRENCIES"
    setAllocationView={() => undefined} hoveredAssetIndex={null} setHoveredAssetIndex={() => undefined}
    hoveredBrokerIndex={null} setHoveredBrokerIndex={() => undefined}
    hoveredCurrencyIndex={null} setHoveredCurrencyIndex={() => undefined}
    selectedCorrelationBroker={null} setSelectedCorrelationBroker={() => undefined}
    selectedCategory="ALL" setSelectedCategory={() => undefined}
    selectedBroker="ALL" setSelectedBroker={() => undefined} onNavigateToTab={() => undefined}
  />);
  assert.match(charts, /Struktura Portfela i Alokacja Kapitału/);
  assert.match(charts, /USD/);

  const banner = renderToStaticMarkup(<PortfolioTaxSummaryBanner
    currentYearSummary={{ year: 2026, transactionCount: 1, incomePLN: 16, totalTaxToPayPLN: 3 }}
    availableTaxYears={[2026]} onNavigateToTab={() => undefined}
  />);
  assert.match(banner, /Raport PIT-38/);
});

test('wyszukiwarka pozycji rysuje lupę nad polem, a lista rachunków ma ograniczoną szerokość', () => {
  const markup = renderToStaticMarkup(<HoldingsTable
    searchTerm="" setSearchTerm={() => undefined} selectedCategory="ALL" setSelectedCategory={() => undefined}
    selectedBroker="ALL" setSelectedBroker={() => undefined}
    accounts={[{ id: 'konto', name: 'Rachunek o bardzo długiej nazwie, która rozciągała listę i ściskała wyszukiwarkę' }]}
    filteredPositions={[]} enrichedPositions={[]} expandedPosition={null} setExpandedPosition={() => undefined}
    onQuickAddTransaction={() => undefined} totalValuePLN={0} onOpenPriceAlert={() => undefined}
    onSelectTickerForChart={() => undefined} onNavigateToTab={() => undefined}
    setOptionsModalTicker={() => undefined} setShowOptionsModal={() => undefined}
    handleClosePosition={() => undefined} CATEGORY_LABELS={{}}
  />);
  // Ikona w otoczce pola (pozycjonowana nad nim). Osobna ikona przed polem znikała pod jego tłem.
  assert.match(markup, /pointer-events-none"><svg[^>]*lucide-search/);
  const listaRachunkow = /<select aria-label="Filtruj według brokera"[^>]*>/.exec(markup)?.[0] ?? '';
  assert.match(listaRachunkow, /sm:max-w-56/);
  assert.match(listaRachunkow, /min-w-0/);
});
