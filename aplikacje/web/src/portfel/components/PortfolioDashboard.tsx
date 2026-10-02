import { PortfolioKpiCards } from './portfolio/PortfolioKpiCards';
import { PortfolioTaxSummaryBanner } from './portfolio/PortfolioTaxSummaryBanner';
import { AllocationCharts } from './portfolio/AllocationCharts';
import { HoldingsTable } from './portfolio/HoldingsTable';
import { useKursyNbp } from '../services/kursyNbp';
import { opiszBrakiWyceny, podsumujWycene, sumaWWalucie, wycenPozycje, type CenaBrokera } from '../services/wycenaPozycji';
import React, { useState, useMemo, useEffect, Suspense } from 'react';
import { leniwyZPonowieniem } from '../../shared/leniwyZPonowieniem';
import { Wallet, Search, ChevronDown, ChevronUp } from 'lucide-react';
import {
  OpenPosition,
  LiveMarketQuote,
  BrokerAccount,
  Language,
  TaxYearSummary,
  AssetCategory,
  CurrencyCode,
} from '../types';
import { marketDataService } from '../services/marketDataService';
import { StockSearchCatalog } from './StockSearchCatalog';
import { Freedom24NewsAndMovers } from './Freedom24NewsAndMovers';
import { Freedom24PortfolioLiveInspector } from './Freedom24PortfolioLiveInspector';
import { KONTO_MAGAZYNU_SILNIKA, RACHUNEK_NIEUSTALONY } from '../services/pozycjaRachunku';
import { czyTrybHostowany } from '../../shared/trybHostingu';

// Okno opcji otwiera sie rzadko - jego kod pobierany dopiero przy otwarciu.
const Freedom24OptionsModal = leniwyZPonowieniem(() => import('./Freedom24OptionsModal'), (modul) => modul.Freedom24OptionsModal);

/** Dokumenty z magazynu to znane zrodlo, nie "nieprzypisany" rachunek. */
function nazwaRachunkuBezKonta(id: string): string {
  if (id === RACHUNEK_NIEUSTALONY) return 'Rachunek nieustalony';
  return id === KONTO_MAGAZYNU_SILNIKA ? KONTO_MAGAZYNU_SILNIKA : `Nieprzypisany rachunek (${id})`;
}

interface PortfolioDashboardProps {
  openPositions: OpenPosition[];
  /** Ceny pozycji z rachunku brokera - zapasowe zrodlo wyceny. */
  cenyBrokera?: readonly CenaBrokera[];
  danePozycjiNieznane?: boolean;
  quotes: Record<string, LiveMarketQuote>;
  accounts: BrokerAccount[];
  yearSummaries: Map<number, TaxYearSummary>;
  selectedYear: number;
  onSelectYear?: (year: number) => void;
  language: Language;
  onRefreshQuotes: () => void;
  isRefreshingQuotes?: boolean;
  onQuickAddTransaction: (prefill?: {
    ticker?: string;
    type?: 'BUY' | 'SELL';
    quantity?: number;
    category?: AssetCategory;
    pricePerUnit?: number;
    currency?: CurrencyCode;
    accountId?: string;
    name?: string;
  }) => void;
  onInstantClosePosition?: (pos: OpenPosition) => void;
  onQuickImport: () => void;
  onOpenPriceAlert: (ticker?: string, accountId?: string) => void;
  onNavigateToTab: (tab: string) => void;
  onSelectTickerForChart: (ticker: string) => void;
  favorites?: string[];
  onToggleFavorite?: (ticker: string) => void;
}

const CATEGORY_LABELS: Record<string, { label: string; color: string; bg: string }> = {
  STOCK_FOREIGN: { label: 'Akcje Zagraniczne', color: '#3B82F6', bg: 'bg-blue-500/10 text-blue-500 border-blue-500/30' },
  STOCK_PL: { label: 'Akcje GPW (Polska)', color: '#EF4444', bg: 'bg-rose-500/10 text-rose-500 border-rose-500/30' },
  ETF: { label: 'Fundusze ETF', color: '#10B981', bg: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30' },
  CRYPTO: { label: 'Kryptowaluty', color: '#F59E0B', bg: 'bg-amber-500/10 text-amber-500 border-amber-500/30' },
  BOND: { label: 'Obligacje', color: '#8B5CF6', bg: 'bg-violet-500/10 text-violet-500 border-violet-500/30' },
};

const CHART_COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#06B6D4', '#6366F1'];

export const PortfolioDashboard: React.FC<PortfolioDashboardProps> = ({
  openPositions,
  cenyBrokera,
  danePozycjiNieznane = false,
  quotes,
  accounts,
  yearSummaries,
  selectedYear,
  onSelectYear,
  language,
  onRefreshQuotes,
  isRefreshingQuotes = false,
  onQuickAddTransaction,
  onInstantClosePosition,
  onQuickImport,
  onOpenPriceAlert,
  onNavigateToTab,
  onSelectTickerForChart,
  favorites = marketDataService.getFavorites(),
  onToggleFavorite = (ticker) => marketDataService.toggleFavorite(ticker),
}) => {
  // Tryb hostowany (telefon): panele brokera nie maja serwera - nie montujemy ich wcale.
  const trybHostowany = czyTrybHostowany();
  const [searchTerm, setSearchTerm] = useState('');
  const [showCatalogSection, setShowCatalogSection] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<string>(() => {
    return localStorage.getItem('pit38_portfolio_category') || 'ALL';
  });
  const [selectedBroker, setSelectedBroker] = useState<string>(() => {
    return localStorage.getItem('pit38_portfolio_broker') || 'ALL';
  });
  const [expandedPosition, setExpandedPosition] = useState<string | null>(null);
  const [showOptionsModal, setShowOptionsModal] = useState(false);
  const [optionsModalTicker, setOptionsModalTicker] = useState('AAPL');

  const handleClosePosition = (pos: any) => {
    const accountId = pos.lots?.[0]?.accountId || pos.accountIds?.[0];
    if (!accountId || accountId === RACHUNEK_NIEUSTALONY) return;
    if (onInstantClosePosition) {
      onInstantClosePosition(pos);
    } else {
      onQuickAddTransaction({
        ticker: pos.ticker,
        name: pos.name,
        type: 'SELL',
        quantity: pos.totalQuantity,
        category: pos.category,
        pricePerUnit: pos.currentPrice || pos.avgBuyPrice,
        currency: pos.currency,
        accountId,
      });
    }
  };

  useEffect(() => {
    localStorage.setItem('pit38_portfolio_category', selectedCategory);
  }, [selectedCategory]);

  useEffect(() => {
    localStorage.setItem('pit38_portfolio_broker', selectedBroker);
  }, [selectedBroker]);

  // Kursy wyceny pochodza z tabeli NBP. Wczesniej stalo tu odczytanie notowan
  // `USD/PLN` i `EUR/PLN`, ktorych zrodlo notowan nigdy nie dostarcza, wiec
  // zawsze wchodzily wpisane obok stale 3.95 i 4.25.
  const kursyNbp = useKursyNbp();
  const usdPlnRate = kursyNbp.USD ?? null;
  const eurPlnRate = kursyNbp.EUR ?? null;

  // Wycena pozycji: jedna regula dla dashboardu i dla wykresow, w
  // services/wycenaPozycji.ts. Wczesniej ten sam rachunek stal w obu
  // komponentach osobno i rozjezdzal sie przy brakach danych.
  const enrichedPositions = useMemo(() => {
    return wycenPozycje(openPositions, quotes, kursyNbp, cenyBrokera).map((pozycja) => {
      const accIds = pozycja.accountIds && pozycja.accountIds.length > 0 ? pozycja.accountIds : ['acc_default'];
      const accNames = accIds.map((id) => {
        const found = accounts.find((a) => a.id === id);
        // Nieprzypisane identyfikatory nie są tym samym „Rachunkiem Głównym”.
        // Dwa takie fallbacki tworzyły dwie pozycje o identycznej nazwie,
        // a legenda kluczowana nazwą zgłaszała błąd Reacta.
        return found ? found.name : nazwaRachunkuBezKonta(id);
      });
      return {
        ...pozycja,
        accountsCount: accIds.length,
        accountNames: accNames,
        primaryAccountName: accNames[0] || 'Nieprzypisany rachunek',
      };
    });
  }, [openPositions, quotes, kursyNbp, accounts, cenyBrokera]);

  // Sumy obejmuja wylacznie pozycje z wycena; brakujace sa policzone osobno
  // i opisane pod kwota.
  const podsumowanieWyceny = useMemo(() => podsumujWycene(enrichedPositions), [enrichedPositions]);
  const wycenionePozycje = podsumowanieWyceny.wycenione;
  const liczbaBezWyceny = podsumowanieWyceny.liczbaBezWyceny;
  const komunikatBrakow = opiszBrakiWyceny(podsumowanieWyceny);
  const totalValuePLN = podsumowanieWyceny.wartoscPLN;
  const sumaUSD = sumaWWalucie(totalValuePLN, usdPlnRate);
  const sumaEUR = sumaWWalucie(totalValuePLN, eurPlnRate);
  const totalCostBasisPLN = podsumowanieWyceny.kosztPLN;
  // Sumy sa `null`, gdy zadna pozycja nie ma wyceny. Projekt nie ma wlaczonego
  // `strictNullChecks`, wiec kompilator tego nie przypilnuje - stad jawne
  // sprawdzenia przy kazdym uzyciu i myslnik zamiast liczby.
  const totalUnrealizedPLN = podsumowanieWyceny.wynikPLN;
  const totalUnrealizedPct = podsumowanieWyceny.wynikProcent;
  const totalDailyChangePLN = podsumowanieWyceny.zmianaDziennaPLN;
  const totalDailyChangePct = podsumowanieWyceny.zmianaDziennaProcent;
  const liczbaZeZnanaZmiana = podsumowanieWyceny.wycenione.filter((p) => p.dailyPnLPLN !== null).length;
  const wynikZnany = totalUnrealizedPLN !== null && totalUnrealizedPLN !== undefined;
  const zmianaZnana = totalDailyChangePLN !== null && totalDailyChangePLN !== undefined;
  const wynikNaPlus = wynikZnany && (totalUnrealizedPLN as number) >= 0;
  const zmianaNaPlus = zmianaZnana && (totalDailyChangePLN as number) >= 0;
  /** Kolor neutralny, gdy liczby nie znamy - zielen nad brakiem danych klamie. */
  const klasaWyniku = (znany: boolean, naPlus: boolean, zielen: string, czerwien: string, szarosc: string) =>
    !znany ? szarosc : naPlus ? zielen : czerwien;

  // Selected Tax Year stats
  const availableTaxYears = useMemo(() => {
    const years = Array.from(yearSummaries.keys()).map(Number).sort((a, b) => b - a);
    return years.length > 0 ? years : [new Date().getFullYear()];
  }, [yearSummaries]);

  const activeYear = selectedYear || availableTaxYears[0] || new Date().getFullYear();
  const currentYearSummary = yearSummaries.get(activeYear) || {
    year: activeYear,
    revenuePLN: 0,
    costsPLN: 0,
    incomePLN: 0,
    lossPLN: 0,
    taxDuePLN: 0,
    dividendGrossPLN: 0,
    dividendForeignTaxPLN: 0,
    dividendPolishTaxDuePLN: 0,
    dividendTaxToPayPLN: 0,
    totalTaxToPayPLN: 0,
    transactionCount: 0,
    brokerBreakdowns: [],
    // Bez tego znacznika baner PIT-38 pokazywal "Dochod: +0,00 zl" i
    // "Podatek (19%): 0,00 zl" dla roku, ktorego silnik jeszcze nie policzyl -
    // czyli pewnosc, ze nie ma czego placic. TaxDashboard juz to rozroznia.
    nieobliczony: true,
  };

  // Filter positions
  const filteredPositions = useMemo(() => {
    return enrichedPositions.filter((pos) => {
      const matchesSearch =
        pos.ticker.toLowerCase().includes(searchTerm.toLowerCase()) ||
        pos.name.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesCategory =
        selectedCategory === 'ALL' || pos.category === selectedCategory;
      const matchesBroker =
        selectedBroker === 'ALL' ||
        (pos.accountIds && pos.accountIds.includes(selectedBroker)) ||
        pos.lots.some((l) => l.accountId === selectedBroker);
      return matchesSearch && matchesCategory && matchesBroker;
    });
  }, [enrichedPositions, searchTerm, selectedCategory, selectedBroker]);

  // Asset Class Allocation Chart Data
  const categoryAllocationData = useMemo(() => {
    const map: Record<string, { value: number; count: number; rawCategory: string }> = {};
    enrichedPositions.forEach((p) => {
      // Pozycja bez wyceny nie ma znanej wartosci - koszt nabycia jej nie zastapi,
      // inaczej udzialy przekraczaja 100% sumy, ktora tej pozycji nie obejmuje.
      if (!p.maWycene) return;
      if (!map[p.category]) {
        map[p.category] = { value: 0, count: 0, rawCategory: p.category };
      }
      map[p.category].value += p.currentValuePLN;
      map[p.category].count += 1;
    });
    return Object.entries(map)
      .map(([cat, data]) => ({
        name: CATEGORY_LABELS[cat]?.label || cat,
        rawCategory: data.rawCategory,
        count: data.count,
        value: Number(data.value.toFixed(2)),
        percentage: totalValuePLN > 0 ? ((data.value / totalValuePLN) * 100).toFixed(1) : '0',
        color: CATEGORY_LABELS[cat]?.color || '#94A3B8',
      }))
      .sort((a, b) => b.value - a.value);
  }, [enrichedPositions, totalValuePLN]);

  // Broker Accounts Allocation Data - Exact lot-by-lot weighted valuation
  const brokerAllocationData = useMemo(() => {
    const map: Record<string, { value: number; count: number; accountId: string; customColor?: string; name: string }> = {};
    
    enrichedPositions.forEach((p) => {
      // Pozycja bez wyceny nie ma znanej wartosci - koszt nabycia jej nie zastapi,
      // inaczej udzialy przekraczaja 100% sumy, ktora tej pozycji nie obejmuje.
      if (!p.maWycene) return;
      // Aggregate by lot's actual account
      const posBrokerMap: Record<string, number> = {};
      if (p.lots && p.lots.length > 0) {
        p.lots.forEach((lot) => {
          const accId = lot.accountId || 'acc_default';
          const lotVal = lot.remainingQty * p.currentPricePLN;
          posBrokerMap[accId] = (posBrokerMap[accId] || 0) + lotVal;
        });
      } else {
        const accId = (p.accountIds && p.accountIds[0]) || 'acc_default';
        posBrokerMap[accId] = p.currentValuePLN;
      }

      Object.entries(posBrokerMap).forEach(([accId, val]) => {
        const acc = accounts.find((a) => a.id === accId);
        const name = acc ? acc.name : nazwaRachunkuBezKonta(accId);
        if (!map[accId]) {
          map[accId] = {
            value: 0,
            count: 0,
            accountId: accId,
            name: name,
            customColor: acc?.color,
          };
        }
        map[accId].value += val;
        map[accId].count += 1;
      });
    });

    return Object.values(map)
      .map((data, idx) => ({
        name: data.name,
        accountId: data.accountId,
        count: data.count,
        value: Number(data.value.toFixed(2)),
        percentage: totalValuePLN > 0 ? ((data.value / totalValuePLN) * 100).toFixed(1) : '0',
        color: data.customColor || CHART_COLORS[idx % CHART_COLORS.length],
      }))
      .sort((a, b) => b.value - a.value);
  }, [enrichedPositions, accounts, totalValuePLN]);

  // Currency Allocation Data
  const currencyAllocationData = useMemo(() => {
    const map: Record<string, { value: number; count: number }> = {};
    enrichedPositions.forEach((p) => {
      // Pozycja bez wyceny nie ma znanej wartosci - koszt nabycia jej nie zastapi,
      // inaczej udzialy przekraczaja 100% sumy, ktora tej pozycji nie obejmuje.
      if (!p.maWycene) return;
      if (!p.walutaCeny) return;
      const curr = p.walutaCeny.toUpperCase();
      if (!map[curr]) map[curr] = { value: 0, count: 0 };
      map[curr].value += p.currentValuePLN;
      map[curr].count += 1;
    });
    const currencyColors: Record<string, string> = {
      PLN: '#EF4444',
      USD: '#10B981',
      EUR: '#3B82F6',
      GBP: '#8B5CF6',
      CHF: '#F59E0B',
    };
    return Object.entries(map)
      .map(([curr, data], idx) => ({
        name: curr,
        count: data.count,
        value: Number(data.value.toFixed(2)),
        percentage: totalValuePLN > 0 ? ((data.value / totalValuePLN) * 100).toFixed(1) : '0',
        color: currencyColors[curr] || CHART_COLORS[idx % CHART_COLORS.length],
      }))
      .sort((a, b) => b.value - a.value);
  }, [enrichedPositions, totalValuePLN]);

  // Allocation view tab state: 'DUAL' | 'ASSETS' | 'BROKERS' | 'CURRENCIES' | 'DEPENDENCIES'
  const [allocationView, setAllocationView] = useState<'DUAL' | 'ASSETS' | 'BROKERS' | 'CURRENCIES' | 'DEPENDENCIES'>(() => {
    return (localStorage.getItem('pit38_portfolio_allocation_view') as 'DUAL' | 'ASSETS' | 'BROKERS' | 'CURRENCIES' | 'DEPENDENCIES') || 'DUAL';
  });
  const [hoveredAssetIndex, setHoveredAssetIndex] = useState<number | null>(null);
  const [hoveredBrokerIndex, setHoveredBrokerIndex] = useState<number | null>(null);
  const [hoveredCurrencyIndex, setHoveredCurrencyIndex] = useState<number | null>(null);
  const [selectedCorrelationBroker, setSelectedCorrelationBroker] = useState<string | null>(null);

  // Asset x Broker Correlation Matrix & Multi-Broker Dependency Analysis
  const brokerDependencyMatrix = useMemo(() => {
    const matrix: Array<{
      ticker: string;
      name: string;
      category: string;
      totalValuePLN: number;
      totalQty: number;
      currency: string;
      unrealizedPLN: number;
      unrealizedPct: number;
      brokerBreakdown: Array<{
        accountId: string;
        accountName: string;
        brokerType: string;
        color: string;
        qty: number;
        valuePLN: number;
        shareOfAssetPct: number;
        shareOfPortfolioPct: number;
        costPLN: number;
        unrealizedPLN: number;
      }>;
    }> = [];

    enrichedPositions.forEach((pos) => {
      const brokerMap: Record<string, { qty: number; costPLN: number; valuePLN: number }> = {};
      pos.lots.forEach((lot) => {
        const accId = lot.accountId || 'acc_default';
        if (!brokerMap[accId]) {
          brokerMap[accId] = { qty: 0, costPLN: 0, valuePLN: 0 };
        }
        brokerMap[accId].qty += lot.remainingQty;
        brokerMap[accId].costPLN += lot.costPLN + lot.commissionPLN;
        brokerMap[accId].valuePLN += lot.remainingQty * pos.currentPricePLN;
      });

      const breakdown = Object.entries(brokerMap).map(([accId, data]) => {
        const acc = accounts.find((a) => a.id === accId);
        const unrealized = data.valuePLN - data.costPLN;
        return {
          accountId: accId,
          accountName: acc?.name || 'Konto domyślne',
          brokerType: acc?.brokerType || 'MANUAL',
          color: acc?.color || '#3B82F6',
          qty: data.qty,
          valuePLN: data.valuePLN,
          shareOfAssetPct: pos.currentValuePLN > 0 ? (data.valuePLN / pos.currentValuePLN) * 100 : 0,
          shareOfPortfolioPct: totalValuePLN > 0 ? (data.valuePLN / totalValuePLN) * 100 : 0,
          costPLN: data.costPLN,
          unrealizedPLN: unrealized,
        };
      }).sort((a, b) => b.valuePLN - a.valuePLN);

      matrix.push({
        ticker: pos.ticker,
        name: pos.name,
        category: pos.category,
        totalValuePLN: pos.currentValuePLN,
        totalQty: pos.totalQuantity,
        currency: pos.currency,
        unrealizedPLN: pos.unrealizedPLN,
        unrealizedPct: pos.unrealizedPct,
        brokerBreakdown: breakdown,
      });
    });

    return matrix.sort((a, b) => b.totalValuePLN - a.totalValuePLN);
  }, [enrichedPositions, accounts, totalValuePLN]);

  // Concentration risk index (Herfindahl-Hirschman Index / HHI) for broker dependencies
  const brokerHHI = useMemo(() => {
    if (brokerAllocationData.length === 0 || totalValuePLN === 0) return 0;
    return brokerAllocationData.reduce((acc, curr) => {
      const pct = Number(curr.percentage);
      return acc + (pct * pct);
    }, 0);
  }, [brokerAllocationData, totalValuePLN]);

  useEffect(() => {
    localStorage.setItem('pit38_portfolio_allocation_view', allocationView);
  }, [allocationView]);

  return (
    <div id="portfolio-dashboard-view" className="space-y-6 animate-in fade-in duration-200">
      {/* Top Header Banner - Compact & Sleek */}
      <div className="relative overflow-hidden rounded-xl bg-white dark:bg-slate-900 text-slate-900 dark:text-white border border-slate-200 dark:border-slate-800 shadow-sm p-3.5 sm:p-4 transition-colors">
        <div className="flex items-center justify-between gap-3">
          {/* Header Title */}
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-blue-50 dark:bg-blue-950/50 border border-blue-200 dark:border-blue-900/70 text-blue-600 dark:text-blue-400">
              <Wallet className="w-4 h-4" />
            </div>
            <h1 className="text-lg sm:text-xl font-bold tracking-tight text-slate-900 dark:text-white">
              Portfel Inwestycyjny
            </h1>
          </div>
        </div>
      </div>

      <PortfolioKpiCards totalValuePLN={totalValuePLN} liczbaBezWyceny={liczbaBezWyceny} komunikatBrakow={komunikatBrakow} sumaUSD={sumaUSD} sumaEUR={sumaEUR} wynikZnany={wynikZnany} wynikNaPlus={wynikNaPlus} totalUnrealizedPLN={totalUnrealizedPLN} totalUnrealizedPct={totalUnrealizedPct} totalCostBasisPLN={totalCostBasisPLN} danePozycjiNieznane={danePozycjiNieznane} zmianaZnana={zmianaZnana} zmianaNaPlus={zmianaNaPlus} totalDailyChangePLN={totalDailyChangePLN} totalDailyChangePct={totalDailyChangePct} liczbaZeZnanaZmiana={liczbaZeZnanaZmiana} liczbaWycenionychPozycji={podsumowanieWyceny.wycenione.length} klasaWyniku={klasaWyniku} />
      <PortfolioTaxSummaryBanner currentYearSummary={currentYearSummary} availableTaxYears={availableTaxYears} onSelectYear={onSelectYear} onNavigateToTab={onNavigateToTab} />

      <AllocationCharts enrichedPositions={enrichedPositions} totalValuePLN={totalValuePLN} accounts={accounts} categoryAllocationData={categoryAllocationData} brokerAllocationData={brokerAllocationData} currencyAllocationData={currencyAllocationData} brokerDependencyMatrix={brokerDependencyMatrix} brokerHHI={brokerHHI} allocationView={allocationView} setAllocationView={setAllocationView} hoveredAssetIndex={hoveredAssetIndex} setHoveredAssetIndex={setHoveredAssetIndex} hoveredBrokerIndex={hoveredBrokerIndex} setHoveredBrokerIndex={setHoveredBrokerIndex} hoveredCurrencyIndex={hoveredCurrencyIndex} setHoveredCurrencyIndex={setHoveredCurrencyIndex} selectedCorrelationBroker={selectedCorrelationBroker} setSelectedCorrelationBroker={setSelectedCorrelationBroker} selectedCategory={selectedCategory} setSelectedCategory={setSelectedCategory} selectedBroker={selectedBroker} setSelectedBroker={setSelectedBroker} onNavigateToTab={onNavigateToTab} />

      {/* Freedom24 Live Portfolio & Balance Inspector - wymaga serwera z kluczami brokera; w hostingu (telefon) panel znika. */}
      {!trybHostowany && <Freedom24PortfolioLiveInspector onSelectTicker={onSelectTickerForChart} />}

      <HoldingsTable searchTerm={searchTerm} setSearchTerm={setSearchTerm} selectedCategory={selectedCategory} setSelectedCategory={setSelectedCategory} selectedBroker={selectedBroker} setSelectedBroker={setSelectedBroker} accounts={accounts} filteredPositions={filteredPositions} enrichedPositions={enrichedPositions} expandedPosition={expandedPosition} setExpandedPosition={setExpandedPosition} onQuickAddTransaction={onQuickAddTransaction} totalValuePLN={totalValuePLN} onOpenPriceAlert={onOpenPriceAlert} onSelectTickerForChart={onSelectTickerForChart} onNavigateToTab={onNavigateToTab} setOptionsModalTicker={setOptionsModalTicker} setShowOptionsModal={setShowOptionsModal} handleClosePosition={handleClosePosition} CATEGORY_LABELS={CATEGORY_LABELS} />

      {/* Freedom24 Market News & Top Movers - jak wyzej, tylko z serwerem. */}
      {!trybHostowany && (
        <Freedom24NewsAndMovers
          onSelectTicker={onSelectTickerForChart}
          heldTickers={enrichedPositions.map((pozycja) => pozycja.ticker)}
        />
      )}

      {/* Built-in Stock Search & Catalog Explorer */}
      <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden transition-all">
        <div className="p-4 sm:p-5 border-b border-slate-200 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-50/80 dark:bg-slate-800/40">
          <div className="flex items-center gap-3">
            <div className="shrink-0 p-2.5 rounded-xl bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-800 shadow-xs">
              <Search className="w-4 h-4" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <h3 className="text-sm sm:text-base font-bold text-slate-900 dark:text-white tracking-tight">
                  Katalog Rynkowy & Wyszukiwarka Instrumentów
                </h3>
                {/* Plakietka "Baza Live" z pulsujaca kropka wisiala nad lista
                    spolek wpisana w kod aplikacji. */}
                <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11px] px-2.5 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 font-semibold border border-slate-200 dark:border-slate-700">
                  Wykaz w aplikacji
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Przeglądaj akcje GPW, USA, ETF-y UCITS oraz kryptowaluty i dodawaj jednym kliknięciem do portfela lub listy obserwowanych.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setShowCatalogSection(!showCatalogSection)}
            className="self-start sm:self-auto shrink-0 flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold text-slate-700 dark:text-slate-200 bg-white hover:bg-slate-100 dark:bg-slate-800 dark:hover:bg-slate-700 transition-all cursor-pointer border border-slate-200 dark:border-slate-700 shadow-xs shrink-0"
          >
            <span>{showCatalogSection ? 'Zwiń katalog' : 'Rozwiń katalog'}</span>
            {showCatalogSection ? (
              <ChevronUp className="w-4 h-4 text-slate-500" />
            ) : (
              <ChevronDown className="w-4 h-4 text-slate-500" />
            )}
          </button>
        </div>

        {showCatalogSection && (
          <div className="p-0">
            <StockSearchCatalog
              quotes={quotes}
              favorites={favorites}
              onToggleFavorite={onToggleFavorite}
              onSelectTickerForChart={onSelectTickerForChart}
              onQuickAddTransaction={onQuickAddTransaction}
              className="border-0 rounded-none shadow-none"
            />
          </div>
        )}
      </div>

      {showOptionsModal && (
        <Suspense fallback={null}>
          <Freedom24OptionsModal
            isOpen={showOptionsModal}
            onClose={() => setShowOptionsModal(false)}
            initialTicker={optionsModalTicker}
            cenaBazowa={
              typeof quotes[optionsModalTicker]?.price === 'number' &&
              quotes[optionsModalTicker].price > 0
                ? quotes[optionsModalTicker].price
                : null
            }
          />
        </Suspense>
      )}
    </div>
  );
};
