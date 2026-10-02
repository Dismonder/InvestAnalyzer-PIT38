import { useKursyNbp } from '../services/kursyNbp';
import { odmienLiczebnik } from '../services/odmianaLiczebnika';
import { klikalny } from '../../shared/klikalny';
import { formatujProcentZmiany, zmianaLubNull } from '../services/formatNotowania';
import { podsumujWycene, wycenPozycje, type CenaBrokera } from '../services/wycenaPozycji';
import { buildAssetAllocationData } from '../services/allocationData';
import React, { useState, useEffect, useMemo, useRef, Suspense } from 'react';
import { leniwyZPonowieniem } from '../../shared/leniwyZPonowieniem';
import {
  LiveMarketQuote,
  TaxRealizedGain,
  BrokerAccount,
  Language,
  OpenPosition,
  AssetCategory,
} from '../types';
import { getTranslation } from '../i18n/translations';
import { marketDataService, STREAM_SPEED_OPTIONS } from '../services/marketDataService';
import { formatCurrency, formatLiczba } from '../services/nbpService';
import {
  AreaChart,
  Area,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Brush,
  CartesianGrid,
  ReferenceArea,
} from 'recharts';
import { wyznaczStrefySesji } from '../services/strefySesji';
import { sekundyZakresu, type PunktWykresu } from '../services/daneWykresuGieldowego';

const WykresGieldowy = leniwyZPonowieniem(() => import('./WykresGieldowy'));
import {
  TrendingUp,
  TrendingDown,
  RefreshCw,
  Pause,
  Play,
  PieChart as PieIcon,
  BarChart3,
  Bell,
  Activity,
  Star,
  SlidersHorizontal,
  ShieldCheck,
  Zap,
  Clock,
  Calendar,
  Maximize2,
  Search,
  Briefcase,
  Layers,
  Coins,
  Wallet,
  ZoomIn,
  ZoomOut,
  ChevronLeft,
  ChevronRight,
  MoveHorizontal,
  RotateCcw,
  LayoutGrid,
  List,
  Flame,
  Filter,
  AlertTriangle,
} from 'lucide-react';
import { StockSearchCatalog } from './StockSearchCatalog';
// Okno opcji otwiera sie rzadko - jego kod pobierany dopiero przy otwarciu.
const Freedom24OptionsModal = leniwyZPonowieniem(() => import('./Freedom24OptionsModal'), (modul) => modul.Freedom24OptionsModal);

interface RealTimeChartsProps {
  quotes: Record<string, LiveMarketQuote>;
  realizedGains: TaxRealizedGain[];
  openPositions?: OpenPosition[];
  cenyBrokera?: readonly CenaBrokera[];
  accounts: BrokerAccount[];
  language: Language;
  onSetAlertForTicker: (ticker: string) => void;
  favorites?: string[];
  onToggleFavorite?: (ticker: string) => void;
  onOpenManageFavorites?: () => void;
  selectedTickerProp?: string;
}

const ALLOCATION_COLORS = ['#3B82F6', '#10B981', '#8B5CF6', '#F59E0B', '#EF4444', '#06B6D4', '#EC4899', '#6366F1'];

const CATEGORY_META: Record<string, { label: string; color: string }> = {
  STOCK_FOREIGN: { label: 'Akcje Zagraniczne', color: '#3B82F6' },
  STOCK_PL: { label: 'Akcje GPW (Polska)', color: '#EF4444' },
  ETF: { label: 'Fundusze ETF', color: '#10B981' },
  CRYPTO: { label: 'Kryptowaluty', color: '#F59E0B' },
  BOND: { label: 'Obligacje', color: '#8B5CF6' },
};

export type ChartInterval = '1m' | '15m' | '1h' | '1d';
export type ChartRange = '1d' | '5d' | '1mo' | '6mo' | '1y';
export type ChartType = 'AREA' | 'LINE' | 'BAR';
export type QuotesViewMode = 'RIBBON' | 'GRID' | 'TABLE';

interface HistoryPoint {
  timestamp: number;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export const RealTimeCharts: React.FC<RealTimeChartsProps> = ({
  quotes,
  realizedGains,
  openPositions = [],
  cenyBrokera,
  accounts,
  language,
  onSetAlertForTicker,
  favorites = [],
  onToggleFavorite,
  onOpenManageFavorites,
  selectedTickerProp,
}) => {
  const t = getTranslation(language);
  const quotesScrollRef = useRef<HTMLDivElement>(null);
  const kartaWaloruRef = useRef<HTMLDivElement>(null);

  const [streamActive, setStreamActive] = useState(marketDataService.getIsStreaming());
  const [currentInterval, setCurrentInterval] = useState(marketDataService.getStreamingInterval());
  const [isFetchingState, setIsFetchingState] = useState(marketDataService.getIsFetching());
  const [lastFetchedTime, setLastFetchedTime] = useState<string | null>(marketDataService.getLastFetchedAt());
  const [selectedTicker, setSelectedTicker] = useState<string>(selectedTickerProp || '');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showOptionsModal, setShowOptionsModal] = useState(false);

  const [quotesViewMode, setQuotesViewMode] = useState<QuotesViewMode>(() => {
    return (localStorage.getItem('pit38_charts_quotes_view_mode') as QuotesViewMode) || 'RIBBON';
  });
  const [quotesCategoryFilter, setQuotesCategoryFilter] = useState<string>('ALL');
  const [quotesSearchQuery, setQuotesSearchQuery] = useState<string>('');

  // Allocation chart view mode & hover states
  const [allocationMode, setAllocationMode] = useState<'ASSETS' | 'BROKERS' | 'CURRENCIES'>(() => {
    return (localStorage.getItem('pit38_charts_allocation_mode') as 'ASSETS' | 'BROKERS' | 'CURRENCIES') || 'ASSETS';
  });
  const [hoveredSliceIndex, setHoveredSliceIndex] = useState<number | null>(null);

  // Timeframe and Range state for detailed price chart
  const [chartRange, setChartRange] = useState<ChartRange>(() => {
    return (localStorage.getItem('pit38_charts_range') as ChartRange) || '1d';
  });
  const [chartInterval, setChartInterval] = useState<ChartInterval>(() => {
    const savedRange = (localStorage.getItem('pit38_charts_range') as ChartRange) || '1d';
    const savedIntv = (localStorage.getItem('pit38_charts_interval') as ChartInterval);
    if (savedRange !== '1d') return '1d';
    return savedIntv || '15m';
  });
  const [chartType, setChartType] = useState<ChartType>(() => {
    return (localStorage.getItem('pit38_charts_type') as ChartType) || 'AREA';
  });
  const [showVolume, setShowVolume] = useState<boolean>(() => {
    return localStorage.getItem('pit38_charts_show_volume') === 'true';
  });
  const [historicalData, setHistoricalData] = useState<HistoryPoint[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState<boolean>(false);
  const [showCatalog, setShowCatalog] = useState<boolean>(false);

  useEffect(() => {
    localStorage.setItem('pit38_charts_quotes_view_mode', quotesViewMode);
  }, [quotesViewMode]);

  useEffect(() => {
    localStorage.setItem('pit38_charts_allocation_mode', allocationMode);
  }, [allocationMode]);

  useEffect(() => {
    localStorage.setItem('pit38_charts_interval', chartInterval);
  }, [chartInterval]);

  useEffect(() => {
    localStorage.setItem('pit38_charts_range', chartRange);
  }, [chartRange]);

  useEffect(() => {
    localStorage.setItem('pit38_charts_type', chartType);
  }, [chartType]);

  useEffect(() => {
    localStorage.setItem('pit38_charts_show_volume', showVolume ? 'true' : 'false');
  }, [showVolume]);

  // Pan & Zoom Window State (indexes into activeChartPoints)
  const [zoomLevel, setZoomLevel] = useState<number>(100); // 100 = 100% visible, 50 = zoomed in
  const [panOffset, setPanOffset] = useState<number>(0); // pan shift

  useEffect(() => {
    const unsub = marketDataService.subscribeState((state) => {
      setStreamActive(state.isStreaming);
      setCurrentInterval(state.intervalMs);
      setIsFetchingState(state.isFetching);
      setLastFetchedTime(state.lastFetchedAt);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (selectedTickerProp) {
      setSelectedTicker(selectedTickerProp);
    }
  }, [selectedTickerProp]);

  // Fetch real candles when ticker, interval or range changes
  const [powodDanychPogladowych, setPowodDanychPogladowych] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedTicker) return;
    let isCancelled = false;

    async function loadCandles() {
      setIsLoadingHistory(true);
      // Stare swiece (inny walor albo interwal) nie moga posluzyc do ustawienia okna nowego wykresu.
      setHistoricalData([]);
      const res = await marketDataService.fetchHistoricalCandles(selectedTicker, 'max', chartInterval);
      if (!isCancelled) {
        if (res && res.points && res.points.length > 0) {
          setHistoricalData(res.points);
        } else {
          setHistoricalData([]);
        }
        // Przebieg wyliczony z ostatniej znanej ceny wyglada jak prawdziwy,
        // wiec musi byc podpisany - inaczej nie da sie odroznic awarii zrodla
        // od spokojnej sesji, a na takim wykresie nie wolno opierac decyzji.
        setPowodDanychPogladowych(
          (res as { synthetic?: boolean; syntheticReason?: string })?.synthetic
            ? (res as { syntheticReason?: string }).syntheticReason || 'Wykres jest poglądowy.'
            : null
        );
        setIsLoadingHistory(false);
        // Reset zoom & pan on ticker/range change
        setZoomLevel(100);
        setPanOffset(0);
      }
    }

    loadCandles();

    return () => {
      isCancelled = true;
    };
  }, [selectedTicker, chartInterval]);

  const quoteList: LiveMarketQuote[] = Object.values(quotes);

  // Filter quotes list by category & search
  const filteredQuoteList = useMemo(() => {
    return quoteList.filter((q) => {
      if (quotesCategoryFilter === 'FAVORITES') {
        if (!favorites.includes(q.ticker)) return false;
      } else if (quotesCategoryFilter === 'STOCK_PL') {
        if (q.category !== 'STOCK_PL' && !q.ticker.includes('WIG') && !q.ticker.includes('CDR') && !q.ticker.includes('PKO') && !q.ticker.includes('PKN')) return false;
      } else if (quotesCategoryFilter === 'STOCK_FOREIGN') {
        if (q.category !== 'STOCK_FOREIGN' && !['NVDA', 'AAPL', 'MSFT', 'TSLA', 'AMZN', 'GOOGL', 'META'].includes(q.ticker)) return false;
      } else if (quotesCategoryFilter === 'ETF') {
        if (q.category !== 'ETF' && !['CSPX', 'VWCE', 'SPY', 'QQQ', 'VUSA'].includes(q.ticker)) return false;
      } else if (quotesCategoryFilter === 'CRYPTO') {
        if (q.category !== 'CRYPTO' && !['BTC', 'ETH', 'SOL', 'BNB', 'XRP'].includes(q.ticker)) return false;
      }

      if (quotesSearchQuery.trim()) {
        const query = quotesSearchQuery.toLowerCase().trim();
        return q.ticker.toLowerCase().includes(query) || q.name.toLowerCase().includes(query);
      }
      return true;
    });
  }, [quoteList, quotesCategoryFilter, quotesSearchQuery, favorites]);

  const activeQuote = quotes[selectedTicker] || quoteList[0];

  // Naglowek, swiece i opis musza dotyczyc TEGO SAMEGO waloru. Gdy wybrany ticker nie ma
  // notowania (np. zapamietany dawno temu), wykres przechodzi na pierwszy walor z notowan -
  // inaczej pod nazwa jednej spolki rysowaly sie swiece innej.
  useEffect(() => {
    if (!quotes[selectedTicker] && quoteList[0]?.ticker && quoteList[0].ticker !== selectedTicker) {
      setSelectedTicker(quoteList[0].ticker);
    }
  }, [quotes, quoteList, selectedTicker]);

  // Handlers for synchronized interval and range switching
  // Zakres i interwal sa niezalezne: wykres trzyma cala historie interwalu,
  // a zakres ustawia tylko okno startowe. Wczesniej zakres > 1D wymuszal swiece
  // dzienne, wiec nie dalo sie obejrzec poprzednich dni w 1m/15m/1h.
  const handleSelectRange = (newRange: ChartRange) => {
    setChartRange(newRange);
  };

  const handleSelectInterval = (newInterval: ChartInterval) => {
    setChartInterval(newInterval);
  };

  const handleToggleStream = () => {
    const next = !streamActive;
    setStreamActive(next);
    marketDataService.setStreaming(next);
  };

  const handleChangeSpeed = (speedMs: number) => {
    setCurrentInterval(speedMs);
    marketDataService.setStreamingInterval(speedMs);
  };

  const handleManualRefresh = async () => {
    setIsRefreshing(true);
    await Promise.all([
      marketDataService.fetchRealQuotes(undefined, true),
      marketDataService.fetchHistoricalCandles(selectedTicker, 'max', chartInterval).then((res) => {
        if (res && res.points) setHistoricalData(res.points);
        setPowodDanychPogladowych(
          (res as { synthetic?: boolean; syntheticReason?: string })?.synthetic
            ? (res as { syntheticReason?: string }).syntheticReason || 'Wykres jest poglądowy.'
            : null
        );
      }),
    ]);
    setIsRefreshing(false);
  };

  // Quotes Ribbon Horizontal Scroll Handlers
  const handleScrollQuotes = (direction: 'left' | 'right') => {
    if (quotesScrollRef.current) {
      const scrollAmount = 300;
      quotesScrollRef.current.scrollBy({
        left: direction === 'left' ? -scrollAmount : scrollAmount,
        behavior: 'smooth',
      });
    }
  };

  // Prepare chronological cumulative profit chart data
  const chronologicalGains = [...realizedGains].sort(
    (a, b) => new Date(a.sellDate).getTime() - new Date(b.sellDate).getTime()
  );

  let cumProfit = 0;
  const pnlChartData = chronologicalGains.map((g) => {
    cumProfit += g.profitPLN;
    return {
      date: g.sellDate,
      ticker: g.ticker,
      profit: g.profitPLN,
      cumProfit: Number(cumProfit.toFixed(2)),
    };
  });

  // Kursy z tabeli NBP zamiast stalych wpisanych w kod - patrz kursyNbp.ts.
  const kursyNbp = useKursyNbp();

  // Ta sama wycena co na dashboardzie - services/wycenaPozycji.ts.
  const enrichedPositions = useMemo(
    () => wycenPozycje(openPositions, quotes, kursyNbp, cenyBrokera),
    [openPositions, quotes, kursyNbp, cenyBrokera]
  );

  // Wykresy udzialow licza sie wylacznie z pozycji, ktore maja wycene.
  const podsumowanieWyceny = useMemo(() => podsumujWycene(enrichedPositions), [enrichedPositions]);
  const wycenionePozycje = podsumowanieWyceny.wycenione;
  const liczbaBezWyceny = podsumowanieWyceny.liczbaBezWyceny;
  const totalPositionsValuePLN = podsumowanieWyceny.wartoscPLN;

  const assetAllocationData = useMemo(
    () => buildAssetAllocationData(wycenionePozycje, totalPositionsValuePLN, CATEGORY_META),
    [wycenionePozycje, totalPositionsValuePLN]
  );

  const brokerAllocationData = useMemo(() => {
    if (wycenionePozycje.length > 0) {
      const map: Record<string, { id: string; name: string; value: number; count: number; color: string }> = {};
      wycenionePozycje.forEach((p) => {
        const sharePerAcc = p.currentValuePLN / (p.accountIds.length || 1);
        p.accountIds.forEach((accId) => {
          const acc = accounts.find((a) => a.id === accId);
          const name = acc ? acc.name : 'Inny Rachunek';
          const color = acc?.color || ALLOCATION_COLORS[Object.keys(map).length % ALLOCATION_COLORS.length];
          if (!map[accId]) {
            map[accId] = { id: accId, name, value: 0, count: 0, color };
          }
          map[accId].value += sharePerAcc;
          map[accId].count += 1;
        });
      });
      return Object.values(map)
        .map((item) => ({
          id: item.id,
          name: item.name,
          value: totalPositionsValuePLN > 0 ? Number(((item.value / totalPositionsValuePLN) * 100).toFixed(1)) : 0,
          amountPLN: item.value,
          count: item.count,
          color: item.color,
        }))
        .sort((a, b) => b.amountPLN - a.amountPLN);
    }
    return [];
  }, [wycenionePozycje, totalPositionsValuePLN, accounts]);

  const currencyAllocationData = useMemo(() => {
    const map: Record<string, { name: string; value: number; count: number; color: string }> = {};
    const currColors: Record<string, string> = {
      PLN: '#EF4444',
      USD: '#3B82F6',
      EUR: '#10B981',
      GBP: '#8B5CF6',
      CHF: '#F59E0B',
    };
    if (wycenionePozycje.length > 0) {
      wycenionePozycje.forEach((p) => {
        const curr = p.currency || 'PLN';
        if (!map[curr]) {
          map[curr] = {
            name: curr,
            value: 0,
            count: 0,
            color: currColors[curr] || ALLOCATION_COLORS[Object.keys(map).length % ALLOCATION_COLORS.length],
          };
        }
        map[curr].value += p.currentValuePLN;
        map[curr].count += 1;
      });
      return Object.values(map)
        .map((item) => ({
          name: item.name,
          value: totalPositionsValuePLN > 0 ? Number(((item.value / totalPositionsValuePLN) * 100).toFixed(1)) : 0,
          amountPLN: item.value,
          count: item.count,
          color: item.color,
        }))
        .sort((a, b) => b.amountPLN - a.amountPLN);
    }
    return [];
  }, [wycenionePozycje, totalPositionsValuePLN]);

  const activeAllocationList = useMemo(() => {
    if (allocationMode === 'ASSETS') return assetAllocationData;
    if (allocationMode === 'BROKERS') return brokerAllocationData;
    if (allocationMode === 'CURRENCIES') return currencyAllocationData.length > 0 ? currencyAllocationData : assetAllocationData;
    return assetAllocationData;
  }, [allocationMode, assetAllocationData, brokerAllocationData, currencyAllocationData]);

  const activeTotalValuePLN = useMemo(
    () => activeAllocationList.reduce((s, x) => s + x.amountPLN, 0),
    [activeAllocationList]
  );

  // Full Candle/Sparkline points
  const rawChartPoints = useMemo(() => {
    if (historicalData.length > 0) {
      return historicalData.map((pt, idx) => ({
        index: idx,
        date: pt.date,
        price: pt.close,
        open: pt.open,
        high: pt.high,
        low: pt.low,
        volume: pt.volume,
        session: (pt as { session?: 'PRE' | 'REGULAR' | 'POST' | 'OVERNIGHT' | null }).session ?? null,
      }));
    }
    // Sparkline to najwyzej kilka punktow z ostatnich sesji. Rysowanie z nich
    // swiec (open = high = low = close) z etykietami "T-5" pod zakresem 1M albo
    // 1Y dawalo pelny wykres gieldowy z danych, ktorych nie ma.
    return [];
  }, [historicalData, activeQuote]);

  // Window slicing based on zoom & pan
  const activeChartPoints = useMemo(() => {
    const total = rawChartPoints.length;
    if (total === 0) return [];
    if (zoomLevel >= 100 && panOffset === 0) return rawChartPoints;

    const visibleCount = Math.max(5, Math.round((total * zoomLevel) / 100));
    const maxOffset = total - visibleCount;
    const clampedOffset = Math.min(Math.max(0, panOffset), maxOffset);

    return rawChartPoints.slice(clampedOffset, clampedOffset + visibleCount);
  }, [rawChartPoints, zoomLevel, panOffset]);

  const strefySesji = useMemo(() => wyznaczStrefySesji(activeChartPoints), [activeChartPoints]);
  const cieniowanieSesji = strefySesji.map((strefa) => (
    <ReferenceArea
      key={`${strefa.sesja}:${strefa.od}`}
      x1={strefa.od}
      x2={strefa.do}
      fill={strefa.sesja === 'PRE' ? '#F59E0B' : strefa.sesja === 'POST' ? '#8B5CF6' : '#0EA5E9'}
      fillOpacity={0.12}
      ifOverflow="hidden"
    />
  ));

  // Zoom / Pan actions
  const handleZoomIn = () => {
    setZoomLevel((prev) => Math.max(20, prev - 20));
  };

  const handleZoomOut = () => {
    setZoomLevel((prev) => Math.min(100, prev + 20));
  };

  const handleResetZoom = () => {
    setZoomLevel(100);
    setPanOffset(0);
  };

  const handlePanLeft = () => {
    setPanOffset((prev) => Math.max(0, prev - Math.round(rawChartPoints.length * 0.15)));
  };

  const handlePanRight = () => {
    const total = rawChartPoints.length;
    const visibleCount = Math.max(5, Math.round((total * zoomLevel) / 100));
    const maxOffset = Math.max(0, total - visibleCount);
    setPanOffset((prev) => Math.min(maxOffset, prev + Math.round(total * 0.15)));
  };

  const isFavorite = activeQuote ? favorites.includes(activeQuote.ticker) : false;
  const isPosTrend = activeQuote ? (zmianaLubNull(activeQuote.changePercent24h) ?? 0) >= 0 : true;

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 bg-white dark:bg-slate-900 p-5 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs">
        <div className="min-w-0">
          <h1 className="text-lg sm:text-xl font-bold tracking-tight text-slate-900 dark:text-white flex items-center gap-2">
            <Activity className="shrink-0 w-5 h-5 text-blue-600 dark:text-blue-400" />
            <span>Wykresy Giełdowe & Notowania Live</span>
          </h1>
          <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400 mt-1">
            Interaktywne przewijanie świec, nawigacja po historii i rzeczywiste kursy giełdowe
          </p>
        </div>

        <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
          {/* Live Speed / Frequency Selector */}
          <div className="flex items-center gap-1 px-2 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs shadow-xs">
            <span className="relative flex h-2 w-2">
              {streamActive && (
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              )}
              <span
                className={`relative inline-flex rounded-full h-2 w-2 ${
                  streamActive ? (isFetchingState ? 'bg-amber-400' : 'bg-emerald-500') : 'bg-slate-400'
                }`}
              ></span>
            </span>
            <span className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 font-mono">
              {streamActive ? `${(currentInterval / 1000).toFixed(0)}s` : 'Pauza'}
            </span>
            <select
              aria-label="Częstotliwość odświeżania notowań"
              value={currentInterval}
              onChange={(e) => handleChangeSpeed(parseInt(e.target.value, 10))}
              className="text-[11px] font-medium bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-none rounded px-1.5 py-0.5 cursor-pointer focus:ring-1 focus:ring-blue-500 outline-none"
              title="Częstotliwość odświeżania wycen giełdowych"
            >
              {STREAM_SPEED_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.shortLabel}
                </option>
              ))}
            </select>
          </div>

          {onOpenManageFavorites && (
            <button
              onClick={onOpenManageFavorites}
              className="flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-lg bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800/60 hover:bg-amber-100 dark:hover:bg-amber-900/50 transition-all cursor-pointer shadow-xs"
              title="Zarządzaj ulubionymi instrumentami"
            >
              <Star className="w-3.5 h-3.5 fill-amber-500 text-amber-500" />
              <span className="hidden sm:inline">Ulubione</span>
              <span className="font-mono">({favorites.length})</span>
            </button>
          )}

          <button
            onClick={() => setShowCatalog(!showCatalog)}
            className={`flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-lg border transition-all cursor-pointer shadow-xs ${
              showCatalog
                ? 'bg-blue-600 text-white border-blue-600 shadow-blue-500/20'
                : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800'
            }`}
          >
            <Search className="w-3.5 h-3.5" />
            <span>Katalog Spółek</span>
          </button>

          <button
            onClick={handleManualRefresh}
            disabled={isRefreshing || isFetchingState}
            className="flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-200 dark:hover:bg-slate-700 transition-all cursor-pointer disabled:opacity-50"
            title="Wymuś natychmiastowe pobranie świeżych danych z giełd"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing || isFetchingState ? 'animate-spin text-blue-500' : ''}`} />
            <span className="hidden sm:inline">Odśwież</span>
          </button>

          <button
            id="btn-toggle-stream"
            onClick={handleToggleStream}
            className={`flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-lg border transition-all cursor-pointer ${
              streamActive
                ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800'
                : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700'
            }`}
          >
            {streamActive ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            <span className="hidden sm:inline">{streamActive ? 'Live' : 'Pauza'}</span>
          </button>
        </div>
      </div>

      {/* Expandable Stock Search & Catalog */}
      {showCatalog && (
        <div className="animate-in fade-in slide-in-from-top-4 duration-300">
          <StockSearchCatalog
            quotes={quotes}
            favorites={favorites}
            onToggleFavorite={onToggleFavorite || (() => {})}
            onSelectTickerForChart={(ticker) => {
              setSelectedTicker(ticker);
              // Widok przewija sie w <main>, nie w oknie: window.scrollTo nic tu nie robil
              // i po wyborze spolki z katalogu wykres zostawal poza ekranem.
              requestAnimationFrame(() => kartaWaloruRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
            }}
          />
        </div>
      )}

      {/* Interactive Quotes Section: Navigation Toolbar + Scrollable Carousel / Grid Switcher */}
      <div className="bg-white dark:bg-slate-900 p-4 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs space-y-3">
        {/* Filter Tabs & Scroll Controls */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
          {/* Category Filter Chips */}
          <div className="min-w-0 flex items-center gap-1 overflow-x-auto pb-1 sm:pb-0 scrollbar-none text-xs">
            {[
              { id: 'ALL', label: 'Wszystkie' },
              { id: 'STOCK_FOREIGN', label: 'USA & Global' },
              { id: 'STOCK_PL', label: 'GPW Polska' },
              { id: 'ETF', label: 'ETF' },
              { id: 'CRYPTO', label: 'Krypto' },
              { id: 'FAVORITES', label: '⭐ Ulubione' },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setQuotesCategoryFilter(tab.id)}
                className={`px-2.5 py-1 rounded-lg font-medium whitespace-nowrap transition-all cursor-pointer ${
                  quotesCategoryFilter === tab.id
                    ? 'bg-blue-600 text-white font-semibold shadow-xs'
                    : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Search + View Mode Switcher + Scroll Arrows */}
          <div className="min-w-0 w-full sm:w-auto flex items-center gap-1.5 sm:shrink-0">
            {/* Quick Search */}
            <div className="relative min-w-0 flex-1 sm:flex-none sm:w-40">
              <input
                type="text"
                placeholder="Szukaj notowania..."
                value={quotesSearchQuery}
                onChange={(e) => setQuotesSearchQuery(e.target.value)}
                className="w-full pl-7 pr-2.5 py-1 text-xs rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-200 transition-colors outline-none focus:ring-1 focus:ring-blue-500"
              />
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2 top-2 pointer-events-none" />
            </div>

            {/* View Mode Switcher */}
            <div className="shrink-0 inline-flex p-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
              <button
                onClick={() => setQuotesViewMode('RIBBON')}
                className={`p-1 rounded-md transition-all cursor-pointer ${
                  quotesViewMode === 'RIBBON' ? 'bg-white dark:bg-slate-900 text-blue-600 shadow-xs' : 'text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
                }`}
                title="Wstęga pozioma z przewijaniem"
              >
                <MoveHorizontal className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setQuotesViewMode('GRID')}
                className={`p-1 rounded-md transition-all cursor-pointer ${
                  quotesViewMode === 'GRID' ? 'bg-white dark:bg-slate-900 text-blue-600 shadow-xs' : 'text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
                }`}
                title="Siatka kafelków"
              >
                <LayoutGrid className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Horizontal Scroll Arrows (Active in Ribbon mode) */}
            {quotesViewMode === 'RIBBON' && (
              <div className="shrink-0 flex items-center gap-1">
                <button
                  onClick={() => handleScrollQuotes('left')}
                  className="p-1 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-blue-50 dark:hover:bg-blue-950/60 hover:text-blue-600 transition-all cursor-pointer"
                  title="Przewiń w lewo"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button
                  onClick={() => handleScrollQuotes('right')}
                  className="p-1 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-blue-50 dark:hover:bg-blue-950/60 hover:text-blue-600 transition-all cursor-pointer"
                  title="Przewiń w prawo"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Quotes Display (Horizontal Scrollable Ribbon vs Grid) */}
        {/* Bez notowan pod filtrami zostawal pusty pasek bez slowa wyjasnienia. */}
        {filteredQuoteList.length === 0 ? (
          <p role="status" className="py-3 text-center text-xs text-slate-500 dark:text-slate-400">
            {quoteList.length > 0
              ? 'Żadne notowanie nie pasuje do wybranego filtra.'
              : isFetchingState
                ? 'Pobieranie notowań…'
                : 'Brak notowań. Dodaj instrument do ulubionych albo wybierz go w Katalogu Spółek.'}
          </p>
        ) : quotesViewMode === 'RIBBON' ? (
          <div
            ref={quotesScrollRef}
            className="flex items-center gap-3 overflow-x-auto pb-2 pt-1 scroll-smooth scrollbar-thin scrollbar-thumb-slate-300 dark:scrollbar-thumb-slate-700"
          >
            {filteredQuoteList.map((q) => {
              const isSelected = selectedTicker === q.ticker;
              const isPos = (zmianaLubNull(q.changePercent24h) ?? 0) >= 0;
              const isFav = favorites.includes(q.ticker);

              return (
                <div
                  key={q.ticker}
                  {...klikalny(() => setSelectedTicker(q.ticker), { wybrany: isSelected })}
                  className={`min-w-[160px] max-w-[180px] shrink-0 p-3 rounded-xl border cursor-pointer transition-all ${
                    isSelected
                      ? 'bg-blue-50/90 dark:bg-blue-950/50 border-blue-400 dark:border-blue-700 shadow-md ring-2 ring-blue-500/20'
                      : 'bg-slate-50/70 dark:bg-slate-800/60 border-slate-200 dark:border-slate-700/80 hover:border-slate-300 dark:hover:border-slate-600'
                  }`}
                >
                  {/* Kafelek wstegi ma stala szerokosc: dlugi symbol (np. opcja Freedom24) jest
                      skracany z podpowiedzia, zamiast nachodzic na zrodlo i wychodzic poza kafelek. */}
                  <div className="flex items-center justify-between gap-1 text-xs">
                    <span className="min-w-0 font-bold text-slate-900 dark:text-white font-mono flex items-center gap-1">
                      {isFav && <Star className="shrink-0 w-3 h-3 fill-amber-400 text-amber-400" />}
                      <span className="min-w-0 truncate" title={q.ticker}>{q.ticker}</span>
                    </span>
                    <span className="shrink-0 text-[9px] text-slate-400 font-mono px-1 py-0.2 rounded bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
                      {q.source}
                    </span>
                  </div>
                  <div className="mt-1 text-sm font-bold font-mono text-slate-900 dark:text-white truncate">
                    {formatLiczba(q.price)} {q.currency}
                  </div>
                  <div
                    className={`mt-1 text-[11px] font-semibold flex items-center gap-0.5 ${
                      isPos ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'
                    }`}
                  >
                    {isPos ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                    <span>
                      {formatujProcentZmiany(q.changePercent24h)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 pt-1">
            {filteredQuoteList.map((q) => {
              const isSelected = selectedTicker === q.ticker;
              const isPos = (zmianaLubNull(q.changePercent24h) ?? 0) >= 0;
              const isFav = favorites.includes(q.ticker);

              return (
                <div
                  key={q.ticker}
                  {...klikalny(() => setSelectedTicker(q.ticker), { wybrany: isSelected })}
                  className={`min-w-0 p-3.5 rounded-2xl border cursor-pointer transition-all ${
                    isSelected
                      ? 'bg-blue-50/80 dark:bg-blue-950/40 border-blue-400 dark:border-blue-700 shadow-md ring-2 ring-blue-500/20'
                      : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-1 text-xs">
                    <span className="min-w-0 font-bold text-slate-900 dark:text-white font-mono flex items-center gap-1">
                      {isFav && <Star className="shrink-0 w-3 h-3 fill-amber-400 text-amber-400" />}
                      <span className="min-w-0 break-all">{q.ticker}</span>
                    </span>
                    <span className="max-w-full break-all text-[9px] text-slate-400 font-mono px-1 py-0.2 rounded bg-slate-100 dark:bg-slate-800">
                      {q.source}
                    </span>
                  </div>
                  <div className="mt-1 text-sm font-bold font-mono tabular-nums [overflow-wrap:anywhere] text-slate-900 dark:text-white">
                    {formatLiczba(q.price)} {q.currency}
                  </div>
                  <div
                    className={`mt-1 text-[11px] font-semibold flex items-center gap-0.5 ${
                      isPos ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'
                    }`}
                  >
                    {isPos ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                    <span>
                      {formatujProcentZmiany(q.changePercent24h)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Active Ticker Detailed Card with Interactive Candle Navigator */}
      {activeQuote && (
        <div ref={kartaWaloruRef} className="bg-white dark:bg-slate-900 p-5 sm:p-6 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm">
          {/* Header Row: Title, Ticker Badge, Source & Action Controls */}
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-slate-100 dark:border-slate-800">
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-xl font-bold text-slate-900 dark:text-white">{activeQuote.name}</h2>
                <span className="font-mono text-xs px-2 py-0.5 rounded bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 font-bold">
                  {activeQuote.ticker}
                </span>
                {isFavorite && (
                  <span
                    className="p-1 rounded-md bg-amber-100 dark:bg-amber-950 text-amber-500 border border-amber-300 dark:border-amber-800 inline-flex items-center justify-center"
                    title="Obserwowane (Ulubione)"
                  >
                    <Star className="w-3.5 h-3.5 fill-amber-500" />
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-500 mt-1 flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
                {/* "Rzeczywiste zrodlo" pokazywalo pole `source`, ktore mowi
                    o rynku notowan, a nie o tym, kto oddal te cene. */}
                <span>
                  Notowanie:{' '}
                  <strong>
                    {activeQuote.dostawcaDanych === 'YAHOO_FINANCE'
                      ? 'Yahoo Finance'
                      : activeQuote.dostawcaDanych || 'źródło nieoznaczone'}
                  </strong>{' '}
                  •{' '}
                  {new Date(activeQuote.lastUpdated).toLocaleTimeString('pl-PL')}
                </span>
              </p>

            </div>

            <div className="flex items-center gap-3 flex-wrap">
              <div className="text-right">
                <div className="text-2xl font-bold font-mono text-slate-900 dark:text-white">
                  {formatLiczba(activeQuote.price)} {activeQuote.currency}
                </div>
                <div
                  className={`text-xs font-semibold ${
                    activeQuote.changePercent24h >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'
                  }`}
                >
                  {zmianaLubNull(activeQuote.change24h) === null || zmianaLubNull(activeQuote.changePercent24h) === null
                    ? 'Zmiana 24h: brak danych'
                    : `${activeQuote.changePercent24h >= 0 ? '+' : ''}${formatLiczba(activeQuote.change24h)} (${formatLiczba(activeQuote.changePercent24h)}%) 24h`}
                </div>
              </div>

              {onToggleFavorite && (
                <button
                  onClick={() => onToggleFavorite(activeQuote.ticker)}
                  className={`p-2 rounded-xl border text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer ${
                    isFavorite
                      ? 'bg-amber-50 dark:bg-amber-950/50 text-amber-600 dark:text-amber-300 border-amber-300 dark:border-amber-700'
                      : 'bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:text-amber-500'
                  }`}
                  title={isFavorite ? 'Usuń z paska ulubionych' : 'Dodaj do górnego paska ulubionych'}
                >
                  <Star className={`w-4 h-4 ${isFavorite ? 'fill-amber-500 text-amber-500' : ''}`} />
                  <span className="hidden sm:inline">{isFavorite ? 'W ulubionych' : 'Dodaj do paska'}</span>
                </button>
              )}

              <button
                onClick={() => onSetAlertForTicker(activeQuote.ticker)}
                className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-xl bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-800 hover:bg-blue-100 dark:hover:bg-blue-900/60 transition-all cursor-pointer shadow-xs"
              >
                <Bell className="w-3.5 h-3.5" />
                <span>Ustaw Alert</span>
              </button>

              <button
                onClick={() => setShowOptionsModal(true)}
                className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-xl bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-800 hover:bg-blue-100 dark:hover:bg-blue-900/60 transition-all cursor-pointer shadow-xs"
                title={`Pokaż łańcuch opcji dla ${activeQuote.ticker}`}
              >
                <Layers className="w-3.5 h-3.5" />
                <span>Łańcuch Opcji</span>
              </button>
            </div>
          </div>

          {/* Timeframe & Range Bar Controls: 1m / 15m / 1h / 1d + Centered Percentage Changes */}
          <div className="mt-3 pt-3 flex flex-col lg:flex-row lg:items-center justify-between gap-3 border-b border-slate-100 dark:border-slate-800 pb-3">
            {/* Interval Selector (1m, 15m, 1h, 1d) */}
            <div className="flex items-center gap-1.5">
              <div className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400 font-medium mr-1.5">
                <Clock className="w-3.5 h-3.5 text-blue-500" />
                <span>Interwał:</span>
              </div>
              <div className="inline-flex p-1 rounded-xl bg-slate-100 dark:bg-slate-800/80 border border-slate-200/80 dark:border-slate-700/80">
                {(['1m', '15m', '1h', '1d'] as ChartInterval[]).map((intv) => {
                  const isActive = chartInterval === intv;
                  return (
                    <button
                      key={intv}
                      onClick={() => handleSelectInterval(intv)}
                      className={`px-2.5 py-1 text-xs font-bold font-mono rounded-lg transition-all cursor-pointer ${
                        isActive
                          ? 'bg-blue-600 text-white shadow-xs'
                          : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200/60 dark:hover:bg-slate-700/60'
                      }`}
                      title={`Ustaw interwał świecy na ${intv}`}
                    >
                      {intv}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Multi-Period Performance Breakdown (Dzień, Tydzień, Miesiąc, Rok) */}
            <div className="flex items-center justify-center gap-1.5 sm:gap-2 flex-wrap py-1 px-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/60 dark:border-slate-700/60">
              <div className="flex items-center gap-1 text-xs font-mono">
                <span className="text-[10px] text-slate-500 dark:text-slate-400 font-sans">Dzień:</span>
                <span
                  className={`font-bold px-1.5 py-0.5 rounded text-[11px] ${
                    activeQuote.changePercent24h >= 0
                      ? 'text-emerald-700 bg-emerald-100 dark:text-emerald-300 dark:bg-emerald-950/60'
                      : 'text-rose-700 bg-rose-100 dark:text-rose-300 dark:bg-rose-950/60'
                  }`}
                >
                  {formatujProcentZmiany(activeQuote.changePercent24h)}
                </span>
              </div>
              <div className="flex items-center gap-1 text-xs font-mono">
                <span className="text-[10px] text-slate-500 dark:text-slate-400 font-sans">Tydzień:</span>
                {(() => {
                  // Bez szeregu cen nie ma stopy tygodniowej. Wczesniej
                  // wchodzila tu zmiana dzienna pomnozona przez 1,85.
                  const weekPct =
                    activeQuote.sparkline && activeQuote.sparkline.length > 2 && activeQuote.sparkline[0] > 0
                      ? ((activeQuote.sparkline[activeQuote.sparkline.length - 1] - activeQuote.sparkline[0]) /
                          activeQuote.sparkline[0]) *
                        100
                      : null;
                  return (
                    <span
                      className={`font-bold px-1.5 py-0.5 rounded text-[11px] ${
                        weekPct === null
                          ? 'text-slate-500 bg-slate-100 dark:text-slate-400 dark:bg-slate-800/60'
                          : weekPct >= 0
                            ? 'text-emerald-700 bg-emerald-100 dark:text-emerald-300 dark:bg-emerald-950/60'
                            : 'text-rose-700 bg-rose-100 dark:text-rose-300 dark:bg-rose-950/60'
                      }`}
                      title={weekPct === null ? 'Brak szeregu notowań dla tego waloru.' : undefined}
                    >
                      {weekPct === null ? '—' : `${weekPct >= 0 ? '+' : ''}${formatLiczba(weekPct)}%`}
                    </span>
                  );
                })()}
              </div>
              <div className="flex items-center gap-1 text-xs font-mono">
                <span className="text-[10px] text-slate-500 dark:text-slate-400 font-sans">Miesiąc:</span>
                {(() => {
                  // Stopa miesieczna powstawala ze zmiany dziennej razy 3,2
                  // plus reszta z kodu pierwszej litery tickera. Aplikacja nie
                  // pobiera notowan miesiecznych, wiec pokazuje myslnik.
                  return (
                    <span
                      className="font-bold px-1.5 py-0.5 rounded text-[11px] text-slate-500 bg-slate-100 dark:text-slate-400 dark:bg-slate-800/60"
                      title="Aplikacja nie pobiera notowań miesięcznych dla tego waloru."
                    >
                      —
                    </span>
                  );
                })()}
              </div>
              <div className="flex items-center gap-1 text-xs font-mono">
                <span className="text-[10px] text-slate-500 dark:text-slate-400 font-sans">Rok:</span>
                {(() => {
                  // Stopa roczna powstawala ze zmiany dziennej razy 7,5 plus
                  // reszta z kodu drugiej litery tickera.
                  return (
                    <span
                      className="font-bold px-1.5 py-0.5 rounded text-[11px] text-slate-500 bg-slate-100 dark:text-slate-400 dark:bg-slate-800/60"
                      title="Aplikacja nie pobiera notowań rocznych dla tego waloru."
                    >
                      —
                    </span>
                  );
                })()}
              </div>
            </div>

            {/* Range Selector (1D, 5D, 1M, 6M, 1Y) */}
            <div className="flex items-center gap-1.5">
              <div className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400 font-medium mr-1.5">
                <Calendar className="w-3.5 h-3.5 text-indigo-500" />
                <span>Zakres:</span>
              </div>
              <div className="inline-flex p-1 rounded-xl bg-slate-100 dark:bg-slate-800/80 border border-slate-200/80 dark:border-slate-700/80">
                {[
                  { label: '1D', value: '1d' },
                  { label: '5D', value: '5d' },
                  { label: '1M', value: '1mo' },
                  { label: '6M', value: '6mo' },
                  { label: '1Y', value: '1y' },
                ].map((rng) => {
                  const isActive = chartRange === rng.value;
                  return (
                    <button
                      key={rng.value}
                      onClick={() => handleSelectRange(rng.value as ChartRange)}
                      className={`px-2.5 py-1 text-xs font-bold font-mono rounded-lg transition-all cursor-pointer ${
                        isActive
                          ? 'bg-indigo-600 text-white shadow-xs'
                          : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200/60 dark:hover:bg-slate-700/60'
                      }`}
                      title={`Pokaż zakres: ${rng.label}`}
                    >
                      {rng.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Interactive Chart Navigation & Toolbar: Zoom In / Out / Pan / Type Toggle */}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs bg-slate-50 dark:bg-slate-800/50 p-2.5 rounded-xl border border-slate-200/70 dark:border-slate-700/70">
            {/* Chart Type Selector */}
            <div className="flex items-center gap-1">
              <span className="text-slate-500 dark:text-slate-400 font-medium mr-1">Typ wykresu:</span>
              <div className="inline-flex p-0.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
                <button
                  onClick={() => setChartType('AREA')}
                  className={`px-2 py-0.5 rounded text-[11px] font-semibold transition-all cursor-pointer ${
                    chartType === 'AREA' ? 'bg-blue-600 text-white' : 'text-slate-600 dark:text-slate-300'
                  }`}
                >
                  Obszarowy
                </button>
                <button
                  onClick={() => setChartType('LINE')}
                  className={`px-2 py-0.5 rounded text-[11px] font-semibold transition-all cursor-pointer ${
                    chartType === 'LINE' ? 'bg-blue-600 text-white' : 'text-slate-600 dark:text-slate-300'
                  }`}
                >
                  Liniowy
                </button>
                <button
                  onClick={() => setChartType('BAR')}
                  className={`px-2 py-0.5 rounded text-[11px] font-semibold transition-all cursor-pointer ${
                    chartType === 'BAR' ? 'bg-blue-600 text-white' : 'text-slate-600 dark:text-slate-300'
                  }`}
                >
                  Świece
                </button>
              </div>
            </div>

          </div>

          {/* Interactive Chart with Recharts & Drag Slider Brush */}
          {powodDanychPogladowych && (
            <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                <strong>Dane poglądowe, nie notowania giełdowe.</strong> {powodDanychPogladowych} Nie
                podejmuj na tym wykresie decyzji inwestycyjnych ani podatkowych.
              </span>
            </div>
          )}

          {activeChartPoints.some((punkt) => punkt.session) && (
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400">
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block w-3 h-3 rounded-sm" style={{ backgroundColor: 'rgba(245,158,11,0.35)' }} />
                Pre-market
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block w-3 h-3 rounded-sm border border-slate-300 dark:border-slate-600" />
                Sesja regularna
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block w-3 h-3 rounded-sm" style={{ backgroundColor: 'rgba(139,92,246,0.35)' }} />
                After-hours
              </span>
              <span
                className="inline-flex items-center gap-1.5 cursor-help"
                title="Świece overnight składa serwer aplikacji z próbek zbieranych co minutę, gdy jest włączony w nocy — dla walorów, których wykres był otwierany. Bez wolumenu; historii sprzed uruchomienia nie ma."
              >
                <span className="inline-block w-3 h-3 rounded-sm" style={{ backgroundColor: 'rgba(14,165,233,0.35)' }} />
                Overnight
              </span>

            </div>
          )}
          <div className="mt-4 w-full relative">
            {isLoadingHistory && (
              <div className="absolute inset-0 bg-white/60 dark:bg-slate-900/60 backdrop-blur-[1px] flex items-center justify-center z-10 rounded-xl">
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-900/90 text-white text-xs font-medium shadow-lg">
                  <RefreshCw className="w-3.5 h-3.5 animate-spin text-blue-400" />
                  <span>Ładowanie świec ({chartInterval}, {chartRange.toUpperCase()})...</span>
                </div>
              </div>
            )}

            {historicalData.length > 0 ? (
              <React.Suspense fallback={<div className="h-[420px] flex items-center justify-center text-xs text-slate-400">Ładowanie wykresu…</div>}>
                <WykresGieldowy
                  punkty={historicalData as unknown as PunktWykresu[]}
                  typ={chartType === 'BAR' ? 'SWIECE' : chartType === 'LINE' ? 'LINIA' : 'OBSZAR'}
                  widoczneSekundy={sekundyZakresu(chartRange)}
                  kluczWidoku={`${selectedTicker}|${chartInterval}|${chartRange}`}
                  ciemny={typeof document !== 'undefined' && document.documentElement.classList.contains('dark')}
                />
              </React.Suspense>
            ) : (
              !isLoadingHistory && (
                <div className="h-[420px] flex items-center justify-center text-xs text-slate-400">
                  Brak notowań dla tego instrumentu i interwału.
                </div>
              )
            )}
          </div>
        </div>
      )}

      {/* Two Grid Charts: Cumulative Realized P&L + Asset Allocation */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Cumulative Realized P&L Chart */}
        <div className="bg-white dark:bg-slate-900 p-5 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm">
          <h3 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-blue-600" />
            <span>{t.gainLossChart}</span>
          </h3>
          <p className="text-xs text-slate-400 mt-0.5">
            Zrealizowany narastający zysk podatkowy ze wszystkich sprzedaży
          </p>

          <div className="mt-4 h-64 w-full">
            {pnlChartData.length === 0 ? (
              <div className="flex items-center justify-center h-full text-slate-400 text-xs">
                Brak zrealizowanych transakcji do wyrysowania wykresu
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={pnlChartData}>
                  <defs>
                    <linearGradient id="pnlGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10B981" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="#10B981" stopOpacity={0.0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} stroke="#94a3b8" />
                  <YAxis tick={{ fontSize: 10 }} stroke="#94a3b8" />
                  <Tooltip
                    content={({ active, payload, label }) => {
                      if (active && payload && payload.length) {
                        const val = Number(payload[0].value);
                        const isPos = val >= 0;
                        return (
                          <div className="bg-slate-900/95 border border-slate-700/90 rounded-xl p-3 shadow-2xl backdrop-blur-md text-xs space-y-1.5 min-w-[180px]">
                            <div className="font-bold text-slate-200 font-mono text-[11px]">Data: {label}</div>
                            <div className="pt-1.5 flex items-center justify-between gap-2 border-t border-slate-800">
                              <span className="text-slate-400 font-medium">Skumulowany zysk:</span>
                              <span className={`font-bold font-mono text-sm ${isPos ? 'text-emerald-400' : 'text-rose-400'}`}>
                                {formatCurrency(val, 'PLN')}
                              </span>
                            </div>
                          </div>
                        );
                      }
                      return null;
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="cumProfit"
                    stroke="#10B981"
                    strokeWidth={2.5}
                    fillOpacity={1}
                    fill="url(#pnlGradient)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* Asset & Broker Allocation Donut Chart */}
        <div className="bg-white dark:bg-slate-900 p-5 sm:p-6 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col justify-between">
          <div>
            {/* Header & Mode Switcher */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3.5 border-b border-slate-100 dark:border-slate-800">
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <span className="p-1 rounded-md bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400">
                    <PieIcon className="w-4 h-4" />
                  </span>
                  <h3 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base">
                    {allocationMode === 'ASSETS' && 'Klasy Aktywów'}
                    {allocationMode === 'BROKERS' && 'Rachunki Maklerskie'}
                    {allocationMode === 'CURRENCIES' && 'Ekspozycja Walutowa'}
                  </h3>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {allocationMode === 'ASSETS' && 'Dywersyfikacja kapitału pomiędzy klasy instrumentów'}
                  {allocationMode === 'BROKERS' && 'Podział kapitału na konta i platformy maklerskie'}
                  {allocationMode === 'CURRENCIES' && 'Struktura portfela według walut bazowych aktywów'}
                  {liczbaBezWyceny > 0 && (
                    // Udzialy licza sie z wycenionych pozycji. Bez tej informacji
                    // wykres wygladalby na pelny obraz portfela.
                    <span className="block mt-1 text-amber-600 dark:text-amber-400">
                      Pominięto {liczbaBezWyceny}{' '}
                      {odmienLiczebnik(liczbaBezWyceny, 'pozycję', 'pozycje', 'pozycji')} bez notowania albo kursu NBP.
                    </span>
                  )}
                </p>
              </div>

              {/* View Switcher Pills */}
              <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-100 dark:bg-slate-800/80 self-start sm:self-auto text-xs">
                <button
                  type="button"
                  onClick={() => {
                    setAllocationMode('ASSETS');
                    setHoveredSliceIndex(null);
                  }}
                  className={`px-2.5 py-1 rounded-lg font-medium transition-all cursor-pointer ${
                    allocationMode === 'ASSETS'
                      ? 'bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 shadow-xs font-semibold'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                  }`}
                >
                  Klasy
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAllocationMode('BROKERS');
                    setHoveredSliceIndex(null);
                  }}
                  className={`px-2.5 py-1 rounded-lg font-medium transition-all cursor-pointer ${
                    allocationMode === 'BROKERS'
                      ? 'bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 shadow-xs font-semibold'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                  }`}
                >
                  Brokerzy
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAllocationMode('CURRENCIES');
                    setHoveredSliceIndex(null);
                  }}
                  className={`px-2.5 py-1 rounded-lg font-medium transition-all cursor-pointer ${
                    allocationMode === 'CURRENCIES'
                      ? 'bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 shadow-xs font-semibold'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                  }`}
                >
                  Waluty
                </button>
              </div>
            </div>

            {/* Chart + Dynamic Legend Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-12 items-center gap-6 mt-4">
              {/* Donut Chart Canvas with Center Display */}
              <div className="sm:col-span-5 h-56 w-full flex items-center justify-center relative">
                {activeAllocationList.length > 0 ? (
                  <>
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={activeAllocationList}
                          cx="50%"
                          cy="50%"
                          innerRadius={58}
                          outerRadius={82}
                          paddingAngle={2}
                          dataKey="value"
                          nameKey="name"
                          onMouseEnter={(_, index) => setHoveredSliceIndex(index)}
                          onMouseLeave={() => setHoveredSliceIndex(null)}
                        >
                          {activeAllocationList.map((entry, index) => (
                            <Cell
                              key={`cell-alloc-${index}`}
                              fill={entry.color}
                              stroke={hoveredSliceIndex === index ? '#FFFFFF' : 'transparent'}
                              strokeWidth={hoveredSliceIndex === index ? 2 : 0}
                              className="transition-all duration-200 cursor-pointer"
                            />
                          ))}
                        </Pie>
                      </PieChart>
                    </ResponsiveContainer>

                    {/* Interactive Center Metric */}
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none text-center">
                      {hoveredSliceIndex !== null && activeAllocationList[hoveredSliceIndex] ? (
                        <div className="flex flex-col items-center justify-center max-w-[100px] px-1 text-center animate-in fade-in zoom-in-95 duration-150">
                          <span className="text-[9px] uppercase font-bold text-slate-500 dark:text-slate-400 tracking-wider truncate w-full">
                            {activeAllocationList[hoveredSliceIndex].name}
                          </span>
                          <span className="text-sm font-bold font-mono text-slate-900 dark:text-white leading-tight my-0.5">
                            {activeAllocationList[hoveredSliceIndex].value}%
                          </span>
                          <span className="text-[10px] text-slate-500 dark:text-slate-400 font-mono truncate w-full">
                            {formatCurrency(activeAllocationList[hoveredSliceIndex].amountPLN, 'PLN')}
                          </span>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center justify-center max-w-[100px] px-1 text-center">
                          <span className="text-[9px] uppercase font-bold text-slate-500 dark:text-slate-400 tracking-wider">
                            Łącznie
                          </span>
                          <span className="text-xs sm:text-sm font-bold font-mono text-slate-900 dark:text-white leading-tight my-0.5 truncate w-full">
                            {formatCurrency(activeTotalValuePLN, 'PLN')}
                          </span>
                          <span className="text-[9px] text-emerald-600 dark:text-emerald-400 font-semibold">
                            100%
                          </span>
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="text-center py-8">
                    <Wallet className="w-8 h-8 text-slate-300 dark:text-slate-600 mx-auto mb-2" />
                    <p className="text-xs text-slate-400">Brak danych alokacji</p>
                  </div>
                )}
              </div>

              {/* Modern Interactive Legend with Progress Bars */}
              <div className="sm:col-span-7 space-y-2 max-h-56 overflow-y-auto pr-1">
                {activeAllocationList.map((item, idx) => {
                  const isHovered = hoveredSliceIndex === idx;
                  return (
                    <div
                      key={`${allocationMode}:${'id' in item ? item.id : item.name}:${idx}`}
                      onMouseEnter={() => setHoveredSliceIndex(idx)}
                      onMouseLeave={() => setHoveredSliceIndex(null)}
                      className={`p-2 rounded-xl transition-all cursor-pointer border ${
                        isHovered
                          ? 'bg-blue-50/80 dark:bg-blue-950/40 border-blue-200/90 dark:border-blue-800/60 shadow-xs'
                          : 'bg-slate-50/80 dark:bg-slate-800/40 border-slate-200/60 dark:border-slate-800/50 hover:bg-slate-100/80 dark:hover:bg-slate-800/70'
                      }`}
                    >
                      <div className="flex items-center justify-between text-xs mb-1.5 gap-2">
                        <div className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
                          <span
                            className="w-2.5 h-2.5 rounded-full shrink-0 ring-2 ring-white dark:ring-slate-900"
                            style={{ backgroundColor: item.color }}
                          />
                          <span className="font-semibold text-slate-800 dark:text-slate-200 truncate" title={item.name}>
                            {item.name}
                          </span>
                          {item.count > 0 && (
                            <span className="text-[10px] text-slate-400 dark:text-slate-500 font-mono shrink-0">
                              ({item.count})
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 font-mono shrink-0 text-right">
                          <span className="font-bold text-slate-900 dark:text-white">
                            {item.value}%
                          </span>
                          <span className="text-slate-500 dark:text-slate-400 text-[11px]">
                            {formatCurrency(item.amountPLN, 'PLN')}
                          </span>
                        </div>
                      </div>

                      {/* Mini Progress Bar */}
                      <div className="w-full h-1 rounded-full bg-slate-200/80 dark:bg-slate-700/60 overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all duration-300"
                          style={{
                            width: `${item.value}%`,
                            backgroundColor: item.color,
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>

      {showOptionsModal && (
        <Suspense fallback={null}>
          <Freedom24OptionsModal
            isOpen={showOptionsModal}
            onClose={() => setShowOptionsModal(false)}
            initialTicker={activeQuote?.ticker || selectedTicker}
            cenaBazowa={
              typeof activeQuote?.price === 'number' && activeQuote.price > 0
                ? activeQuote.price
                : null
            }
          />
        </Suspense>
      )}
    </div>
  );
};
