import React, { useState, useEffect, useMemo } from 'react';
import { formatLiczba } from '../services/nbpService';
import {
  Search,
  Star,
  TrendingUp,
  TrendingDown,
  Building2,
  Globe2,
  Coins,
  Briefcase,
  SlidersHorizontal,
  ExternalLink,
  Plus,
  Check,
  RefreshCw,
  Sparkles,
  ArrowRight,
  ShieldCheck,
  Layers,
  LineChart,
  Filter,
  CheckCircle2,
  Compass,
  Clock,
  ChevronDown,
  ChevronUp,
  Flame,
  Trash2,
} from 'lucide-react';
import type { BrokerSupportedAsset } from '../data/brokerAssetsDatabase';
import { marketDataService } from '../services/marketDataService';
import { LiveMarketQuote, AssetCategory } from '../types';
import { formatujProcentZmiany, zmianaLubNull } from '../services/formatNotowania';

interface StockSearchCatalogProps {
  quotes: Record<string, LiveMarketQuote>;
  favorites: string[];
  onToggleFavorite: (ticker: string) => void;
  onSelectTickerForChart?: (ticker: string) => void;
  onQuickAddTransaction?: (prefill?: { ticker?: string; category?: AssetCategory }) => void;
  className?: string;
  initialCategory?: string;
  compact?: boolean;
}

const STORAGE_RECENT_KEY = 'kalkulator_pit38_recent_tickers';

const CATEGORY_TABS = [
  { id: 'ALL', label: 'Wszystkie rynki', icon: Layers },
  { id: 'STOCK_FOREIGN', label: 'Akcje USA & Global', icon: Globe2 },
  { id: 'STOCK_PL', label: 'GPW Warszawa', icon: Building2 },
  { id: 'ETF', label: 'Fundusze ETF', icon: Briefcase },
  { id: 'CRYPTO', label: 'Kryptowaluty', icon: Coins },
  { id: 'BOND', label: 'Obligacje & Noty', icon: ShieldCheck },
  { id: 'FAVORITES', label: 'Obserwowane (Watchlist)', icon: Star },
];

const POPULAR_QUICK_TAGS = [
  { label: 'WIG20', query: 'PL' },
  { label: 'Big Tech', query: 'NVDA' },
  { label: 'S&P 500 ETF', query: 'CSPX' },
  { label: 'All-World ETF', query: 'VWCE' },
  { label: 'Krypto', query: 'BTC' },
  { label: 'Banki PL', query: 'PKO' },
];

const BROKER_FILTERS = [
  { id: 'ALL', label: 'Wszyscy brokerzy' },
  { id: 'XTB', label: 'XTB' },
  { id: 'IBKR', label: 'Interactive Brokers' },
  { id: 'FREEDOM24', label: 'Freedom24' },
  { id: 'REVOLUT', label: 'Revolut' },
  { id: 'EMAKLER', label: 'mBank eMakler' },
  { id: 'DEGIRO', label: 'DEGIRO' },
  { id: 'BINANCE', label: 'Binance' },
];

// Curated representative benchmarks for spotlight section
const CURATED_SPOTLIGHT_TICKERS = ['NVDA', 'CDR', 'CSPX', 'VWCE', 'BTC', 'PKN', 'AAPL', 'PKO'];

export const StockSearchCatalog: React.FC<StockSearchCatalogProps> = ({
  quotes,
  favorites,
  onToggleFavorite,
  onSelectTickerForChart,
  onQuickAddTransaction,
  className = '',
  initialCategory = 'ALL',
  compact = false,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>(initialCategory);
  const [selectedBroker, setSelectedBroker] = useState<string>('ALL');
  const [searchResults, setSearchResults] = useState<BrokerSupportedAsset[]>([]);
  const [isSearchingLive, setIsSearchingLive] = useState(true);
  const [customTickerMsg, setCustomTickerMsg] = useState<{ text: string; isError?: boolean } | null>(null);
  const [showFullCatalog, setShowFullCatalog] = useState(false);
  const [showFiltersDrawer, setShowFiltersDrawer] = useState(false);

  const hasActiveBrokerFilter = selectedBroker !== 'ALL';
  const hasActiveFilters = hasActiveBrokerFilter || selectedCategory !== 'ALL' || searchTerm.trim() !== '';

  // Recently viewed tickers with localStorage persistence
  const [recentTickers, setRecentTickers] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_RECENT_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {
      // ignore
    }
    return ['NVDA', 'CDR', 'VWCE', 'BTC'];
  });

  const recordRecentTicker = (ticker: string) => {
    const upper = ticker.trim().toUpperCase();
    if (!upper) return;
    setRecentTickers((prev) => {
      const filtered = prev.filter((t) => t !== upper);
      const next = [upper, ...filtered].slice(0, 8);
      try {
        localStorage.setItem(STORAGE_RECENT_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  };

  const clearRecentTickers = () => {
    setRecentTickers([]);
    try {
      localStorage.removeItem(STORAGE_RECENT_KEY);
    } catch {
      // ignore
    }
  };

  // Live search debounce
  useEffect(() => {
    let active = true;
    const query = searchTerm.trim();

    setIsSearchingLive(true);
    // Pusty tekst tez pobiera katalog, ale dopiero po otwarciu widoku.
    const szukaj = async () => {
      try {
        const results = await marketDataService.searchTickers(query);
        if (active) setSearchResults(results);
      } catch {
        if (active) setSearchResults([]);
      } finally {
        if (active) setIsSearchingLive(false);
      }
    };
    const timer = query ? setTimeout(() => { void szukaj(); }, 200) : undefined;
    if (!query) void szukaj();

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [searchTerm]);

  // Combine search items with active quotes & favorites
  const mergedAssets = useMemo(() => {
    const map = new Map<string, BrokerSupportedAsset>();

    for (const item of searchResults) {
      map.set(item.ticker.toUpperCase(), item);
    }

    // Add any favorite, quote, or recent tickers that might not be in initial list
    const extraTickers = [...new Set([...favorites, ...recentTickers, ...CURATED_SPOTLIGHT_TICKERS])];
    for (const rawTicker of extraTickers) {
      const upper = rawTicker.toUpperCase();
      if (!map.has(upper)) {
        const q = quotes[upper];
        map.set(upper, {
          ticker: upper,
          name: q?.name || upper,
          category: q?.category || 'STOCK_FOREIGN',
          currency: q?.currency || 'USD',
          exchange: q?.source || 'MARKET',
          // Wpisu z wyszukiwarki nie ma w wykazie instrumentow, wiec nie
          // wiadomo, ktory broker go oferuje. Wczesniej kazdy taki walor
          // dostawal plakietki XTB, IBKR, FREEDOM24 i REVOLUT.
          brokers: [],
        });
      }
    }

    return Array.from(map.values());
  }, [searchResults, favorites, quotes, recentTickers]);

  // Filter by category and broker
  const filteredAssets = useMemo(() => {
    return mergedAssets.filter((asset) => {
      const isFav = favorites.includes(asset.ticker.toUpperCase());

      // Category filter
      if (selectedCategory === 'FAVORITES' && !isFav) return false;
      if (selectedCategory === 'STOCK_FOREIGN' && asset.category !== 'STOCK_FOREIGN') return false;
      if (selectedCategory === 'STOCK_PL' && asset.category !== 'STOCK_PL') return false;
      if (selectedCategory === 'ETF' && asset.category !== 'ETF') return false;
      if (selectedCategory === 'CRYPTO' && asset.category !== 'CRYPTO') return false;

      // Broker filter - pusta lista znaczy "nie wiadomo", a nie "u zadnego".
      if (selectedBroker !== 'ALL') {
        const brokers = asset.brokers || [];
        if (brokers.length > 0 && !brokers.includes(selectedBroker as any)) {
          return false;
        }
      }

      return true;
    });
  }, [mergedAssets, selectedCategory, selectedBroker, favorites]);

  // Handle direct custom add from search bar
  const handleQuickAddCustom = async (ticker: string) => {
    const upper = ticker.trim().toUpperCase();
    if (!upper) return;

    setCustomTickerMsg({ text: `Pobieranie aktualnych notowań dla ${upper}...` });
    try {
      const quote = await marketDataService.fetchSingleTicker(upper, true);
      if (quote) {
        recordRecentTicker(upper);
        if (!favorites.includes(upper)) {
          onToggleFavorite(upper);
        }
        setCustomTickerMsg({ text: `Dodano ${upper} (${quote.name}) do listy obserwowanych!` });
        setTimeout(() => setCustomTickerMsg(null), 3500);
      } else {
        setCustomTickerMsg({
          text: `Nie udało się pobrać wyceny dla "${upper}". Upewnij się, że symbol giełdowy jest poprawny.`,
          isError: true,
        });
        setTimeout(() => setCustomTickerMsg(null), 4000);
      }
    } catch {
      setCustomTickerMsg({ text: `Błąd połączenia z giełdą dla ${upper}.`, isError: true });
      setTimeout(() => setCustomTickerMsg(null), 4000);
    }
  };

  const handleSelectChart = (ticker: string) => {
    recordRecentTicker(ticker);
    onSelectTickerForChart?.(ticker);
  };

  const handleQuickAdd = (prefill: { ticker: string; category: AssetCategory }) => {
    recordRecentTicker(prefill.ticker);
    onQuickAddTransaction?.(prefill);
  };

  // Helper to render individual asset card
  const renderAssetCard = (asset: BrokerSupportedAsset) => {
    const upperTicker = asset.ticker.toUpperCase();
    const isFav = favorites.includes(upperTicker);
    const quote = quotes[upperTicker];
    const hasQuote = quote && quote.price > 0;
    const isPos = quote ? (zmianaLubNull(quote.changePercent24h) ?? 0) >= 0 : true;

    return (
      <div
        key={asset.ticker}
        className={`p-3.5 rounded-2xl border transition-all flex flex-col justify-between group ${
          isFav
            ? 'bg-amber-50/40 dark:bg-amber-950/20 border-amber-300 dark:border-amber-700/80 shadow-xs'
            : 'bg-white dark:bg-slate-800/80 border-slate-200 dark:border-slate-700 hover:border-blue-300 dark:hover:border-blue-600 hover:shadow-xs'
        }`}
      >
        {/* Top line: Ticker, Name & Star toggle */}
        <div>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="font-bold text-xs sm:text-sm text-slate-900 dark:text-white font-mono tracking-tight">
                  {asset.ticker}
                </span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 font-medium uppercase font-mono">
                  {asset.exchange}
                </span>
                {asset.category === 'STOCK_PL' && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-50 dark:bg-rose-950/60 text-rose-700 dark:text-rose-300 font-bold border border-rose-200 dark:border-rose-800">
                    GPW
                  </span>
                )}
                {asset.category === 'ETF' && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 font-bold border border-indigo-200 dark:border-indigo-800">
                    ETF
                  </span>
                )}
              </div>
              <h4
                className="text-xs text-slate-700 dark:text-slate-200 font-medium truncate mt-1"
                title={asset.name}
              >
                {asset.name}
              </h4>
            </div>

            {/* Watchlist Toggle Button */}
            <button
              type="button"
              onClick={() => {
                recordRecentTicker(asset.ticker);
                onToggleFavorite(asset.ticker);
              }}
              className={`p-1.5 rounded-xl transition-all shrink-0 cursor-pointer ${
                isFav
                  ? 'text-amber-500 bg-amber-100 dark:bg-amber-900/50 shadow-xs'
                  : 'text-slate-400 dark:text-slate-500 hover:text-amber-500 hover:bg-slate-100 dark:hover:bg-slate-700'
              }`}
              title={isFav ? 'Usuń z listy obserwowanych' : 'Dodaj do listy obserwowanych'}
            >
              <Star className={`w-4 h-4 ${isFav ? 'fill-amber-500' : ''}`} />
            </button>
          </div>

          {/* Broker availability micro tags */}
          {asset.brokers && asset.brokers.length > 0 && !compact && (
            <div className="flex items-center gap-1 flex-wrap mt-2.5">
              {asset.brokers.slice(0, 3).map((b) => (
                <span
                  key={b}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 font-medium"
                >
                  {b}
                </span>
              ))}
              {asset.brokers.length > 3 && (
                <span className="text-[10px] text-slate-400 dark:text-slate-500 font-medium">
                  +{asset.brokers.length - 3}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Price & Action Row */}
        <div className="mt-3.5 pt-2.5 border-t border-slate-100 dark:border-slate-700/80 flex items-center justify-between gap-2">
          {/* Live Quote Price */}
          <div>
            {hasQuote ? (
              <div>
                <div className="font-bold text-xs sm:text-sm font-mono text-slate-900 dark:text-white">
                  {formatLiczba(quote.price)} {quote.currency}
                </div>
                <div
                  className={`text-[11px] font-semibold font-mono flex items-center gap-1 mt-0.5 ${
                    isPos ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'
                  }`}
                >
                  {isPos ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                  <span>
                    {formatujProcentZmiany(quote.changePercent24h)}
                  </span>
                </div>
              </div>
            ) : (
              <div className="text-xs font-mono text-slate-500 dark:text-slate-400 font-medium">
                Waluta: <span className="font-bold text-slate-700 dark:text-slate-200">{asset.currency}</span>
              </div>
            )}
          </div>

          {/* Quick action buttons */}
          <div className="flex items-center gap-1.5">
            {onSelectTickerForChart && (
              <button
                type="button"
                onClick={() => handleSelectChart(asset.ticker)}
                className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg bg-blue-50 dark:bg-blue-950/60 hover:bg-blue-100 dark:hover:bg-blue-900/60 text-blue-600 dark:text-blue-400 transition-colors cursor-pointer border border-blue-200 dark:border-blue-800 shadow-xs"
                title="Pokaż wykres świecowy/liniowy na żywo"
              >
                <LineChart className="w-3.5 h-3.5" />
                <span>Wykres</span>
              </button>
            )}

            {onQuickAddTransaction && (
              <button
                type="button"
                onClick={() => handleQuickAdd({ ticker: asset.ticker, category: asset.category })}
                className="p-1.5 rounded-lg text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white bg-slate-50 hover:bg-slate-100 dark:bg-slate-800 dark:hover:bg-slate-700 transition-colors cursor-pointer border border-slate-200 dark:border-slate-700 shadow-xs"
                title="Dodaj transakcję kupna/sprzedaży do portfela"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };

  // Curated lists for structured default view
  const isSearchActive = Boolean(searchTerm.trim());
  const isCategorySelected = selectedCategory !== 'ALL';

  // Grouped slices
  const recentAssetItems = useMemo(() => {
    return recentTickers
      .map((ticker) => mergedAssets.find((a) => a.ticker.toUpperCase() === ticker.toUpperCase()))
      .filter((a): a is BrokerSupportedAsset => Boolean(a));
  }, [recentTickers, mergedAssets]);

  const favoriteAssetItems = useMemo(() => {
    return favorites
      .map((ticker) => mergedAssets.find((a) => a.ticker.toUpperCase() === ticker.toUpperCase()))
      .filter((a): a is BrokerSupportedAsset => Boolean(a));
  }, [favorites, mergedAssets]);

  const spotlightAssetItems = useMemo(() => {
    // Pick recommended benchmarks that are not already heavily duplicated
    return CURATED_SPOTLIGHT_TICKERS
      .map((ticker) => mergedAssets.find((a) => a.ticker.toUpperCase() === ticker.toUpperCase()))
      .filter((a): a is BrokerSupportedAsset => Boolean(a))
      .slice(0, 6);
  }, [mergedAssets]);

  return (
    <div className={`bg-white dark:bg-slate-900 overflow-hidden flex flex-col ${className}`}>
      {/* Top Filter & Search Controls */}
      <div className="p-3.5 sm:p-4 border-b border-slate-200/80 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/40 space-y-3">
        {/* Main Controls Row: Search Input + Category Pills + Filter Toggle */}
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-2.5">
          {/* Left: Search Input */}
          <div className="relative flex-1 min-w-[240px]">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Szukaj: nazwa, ticker lub giełda (np. Apple, CDR, Orlen, NVDA, SXR8)..."
              className="w-full pl-9 pr-9 py-2 text-xs sm:text-sm rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all font-medium shadow-xs"
            />
            {isSearchingLive ? (
              <RefreshCw className="w-3.5 h-3.5 text-blue-500 animate-spin absolute right-3 top-1/2 -translate-y-1/2" />
            ) : searchTerm ? (
              <button
                type="button"
                onClick={() => setSearchTerm('')}
                className="p-1 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 text-xs absolute right-2.5 top-1/2 -translate-y-1/2 cursor-pointer"
                title="Wyczyść wyszukiwanie"
              >
                ✕
              </button>
            ) : null}
          </div>

          {/* Right: Category Segmented Bar + Filter Toggle & Counter */}
          <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none shrink-0 py-0.5">
            {/* Category Segmented Controls */}
            <div className="flex items-center p-1 rounded-xl bg-slate-200/60 dark:bg-slate-800/80 gap-0.5">
              {CATEGORY_TABS.map((tab) => {
                const isActive = selectedCategory === tab.id;
                const Icon = tab.icon;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setSelectedCategory(tab.id)}
                    className={`px-2.5 py-1 rounded-lg font-semibold whitespace-nowrap transition-all cursor-pointer flex items-center gap-1.5 text-xs ${
                      isActive
                        ? 'bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 shadow-xs'
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                    }`}
                  >
                    <Icon className={`w-3.5 h-3.5 ${isActive ? 'text-blue-600 dark:text-blue-400' : 'text-slate-400'}`} />
                    <span className="hidden sm:inline">{tab.label}</span>
                    <span className="sm:hidden">{tab.id === 'FAVORITES' ? '⭐' : tab.label.split(' ')[0]}</span>
                  </button>
                );
              })}
            </div>

            {/* Advanced Filters Drawer Toggle */}
            <button
              type="button"
              onClick={() => setShowFiltersDrawer(!showFiltersDrawer)}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-semibold transition-all cursor-pointer border shadow-xs ${
                showFiltersDrawer || hasActiveBrokerFilter
                  ? 'bg-blue-50 dark:bg-blue-950/60 border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300'
                  : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700'
              }`}
              title="Więcej filtrów (Brokerzy, szybkie tagi)"
            >
              <SlidersHorizontal className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
              <span className="hidden md:inline">Filtry</span>
              {hasActiveBrokerFilter && (
                <span className="w-2 h-2 rounded-full bg-blue-600 animate-pulse" />
              )}
            </button>

            {/* Count Badge */}
            <span className="hidden xl:inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-[11px] font-semibold text-slate-600 dark:text-slate-300 font-mono shadow-xs">
              {filteredAssets.length}
            </span>
          </div>
        </div>

        {/* Expandable Advanced Filters (Brokers & Quick Tags) */}
        {showFiltersDrawer && (
          <div className="p-3 rounded-xl bg-white dark:bg-slate-800/90 border border-slate-200/80 dark:border-slate-700 shadow-xs space-y-2.5 animate-fadeIn">
            {/* Broker filter pills */}
            <div className="flex items-center gap-1.5 flex-wrap text-xs">
              <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 mr-1 shrink-0">
                Broker:
              </span>
              {BROKER_FILTERS.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => setSelectedBroker(b.id)}
                  className={`px-2.5 py-0.5 rounded-md text-[11px] font-medium whitespace-nowrap transition-all cursor-pointer border ${
                    selectedBroker === b.id
                      ? 'bg-blue-600 text-white border-blue-600 shadow-xs font-semibold'
                      : 'bg-slate-50 dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800'
                  }`}
                >
                  {b.label}
                </button>
              ))}
            </div>

            {/* Quick tags pills */}
            <div className="flex items-center gap-1.5 flex-wrap text-xs pt-1.5 border-t border-slate-100 dark:border-slate-700/60">
              <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 mr-1 shrink-0">
                Popularne:
              </span>
              {POPULAR_QUICK_TAGS.map((tag) => (
                <button
                  key={tag.label}
                  type="button"
                  onClick={() => setSearchTerm(tag.query)}
                  className="px-2 py-0.5 rounded-md text-[11px] font-medium bg-slate-50 dark:bg-slate-900 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:border-blue-400 hover:text-blue-600 dark:hover:text-blue-400 transition-all cursor-pointer"
                >
                  {tag.label}
                </button>
              ))}
              {hasActiveFilters && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchTerm('');
                    setSelectedBroker('ALL');
                    setSelectedCategory('ALL');
                  }}
                  className="ml-auto text-[11px] font-semibold text-rose-600 dark:text-rose-400 hover:underline cursor-pointer"
                >
                  Wyczyść wszystkie filtry
                </button>
              )}
            </div>
          </div>
        )}

        {/* Feedback / Notification Banner */}
        {customTickerMsg && (
          <div
            className={`text-xs px-3.5 py-2 rounded-xl flex items-center justify-between gap-2 shadow-xs transition-all ${
              customTickerMsg.isError
                ? 'bg-rose-50 dark:bg-rose-950/50 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-800'
                : 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-800 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800'
            }`}
          >
            <div className="flex items-center gap-2">
              <Sparkles className="w-3.5 h-3.5 shrink-0" />
              <span className="font-medium">{customTickerMsg.text}</span>
            </div>
            <button
              type="button"
              onClick={() => setCustomTickerMsg(null)}
              className="text-xs opacity-70 hover:opacity-100 cursor-pointer font-bold"
            >
              ✕
            </button>
          </div>
        )}
      </div>

      {/* Main Catalog Viewport */}
      <div className={`p-4 sm:p-5 overflow-y-auto custom-scrollbar ${compact ? 'max-h-[380px]' : 'max-h-[580px]'}`}>
        {/* CASE A: Active Search query or specific category is selected */}
        {isSearchActive || isCategorySelected || showFullCatalog ? (
          <div>
            {/* Context Header for search / filtered mode */}
            <div className="flex items-center justify-between gap-2 mb-3.5">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-slate-900 dark:text-white uppercase tracking-wider">
                  {isSearchActive
                    ? `Wyniki wyszukiwania dla "${searchTerm}"`
                    : selectedCategory === 'FAVORITES'
                    ? 'Twoje ulubione i obserwowane'
                    : showFullCatalog
                    ? 'Pełny katalog instrumentów'
                    : 'Wybrana kategoria'}
                </span>
                <span className="text-[11px] font-semibold font-mono px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
                  {filteredAssets.length}
                </span>
              </div>

              {showFullCatalog && !isSearchActive && selectedCategory === 'ALL' && (
                <button
                  type="button"
                  onClick={() => setShowFullCatalog(false)}
                  className="flex items-center gap-1 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
                >
                  <ChevronUp className="w-3.5 h-3.5" />
                  <span>Zwiń do widoku skróconego</span>
                </button>
              )}
            </div>

            {filteredAssets.length === 0 && isSearchingLive ? (
              <div role="status" className="py-14 text-center text-sm text-slate-500">Wczytywanie katalogu...</div>
            ) : filteredAssets.length === 0 ? (
              <div className="py-14 text-center space-y-3 max-w-md mx-auto">
                <div className="p-3 rounded-2xl bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 w-12 h-12 mx-auto flex items-center justify-center border border-blue-200 dark:border-blue-800">
                  <Search className="w-6 h-6" />
                </div>
                <h4 className="text-sm font-bold text-slate-900 dark:text-white">
                  Nie znaleziono w lokalnym katalogu dla &quot;{searchTerm}&quot;
                </h4>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Możesz pobrać ten symbol bezpośrednio z globalnej giełdy i dodać go do listy obserwowanych.
                </p>
                {searchTerm.trim().length >= 2 && (
                  <button
                    type="button"
                    onClick={() => handleQuickAddCustom(searchTerm)}
                    className="inline-flex items-center gap-2 px-4 py-2 text-xs font-bold rounded-xl bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white shadow-xs transition-all cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Pobierz kurs dla &quot;{searchTerm.toUpperCase()}&quot;</span>
                  </button>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3 gap-3">
                {filteredAssets.map((asset) => renderAssetCard(asset))}
              </div>
            )}
          </div>
        ) : (
          /* CASE B: Default clean dashboard view (Recently viewed, Favorites, Curated Recommendations, Rest hidden) */
          <div className="space-y-6">
            {/* Section 1: Ostatnio oglądane (Recently Viewed) */}
            {recentAssetItems.length > 0 && (
              <div>
                <div className="flex items-center justify-between gap-2 mb-3">
                  <div className="flex items-center gap-2">
                    <Clock className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                    <h3 className="text-xs sm:text-sm font-bold text-slate-900 dark:text-white uppercase tracking-wider">
                      Ostatnio oglądane
                    </h3>
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 font-mono">
                      {recentAssetItems.length}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={clearRecentTickers}
                    className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-rose-500 dark:hover:text-rose-400 transition-colors cursor-pointer"
                    title="Wyczyść historię oglądanych"
                  >
                    <Trash2 className="w-3 h-3" />
                    <span>Wyczyść historię</span>
                  </button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3 gap-3">
                  {recentAssetItems.slice(0, 3).map((asset) => renderAssetCard(asset))}
                </div>
              </div>
            )}

            {/* Section 2: Ulubione i Obserwowane (Favorites / Watchlist) */}
            <div>
              <div className="flex items-center justify-between gap-2 mb-3">
                <div className="flex items-center gap-2">
                  <Star className="w-4 h-4 text-amber-500 fill-amber-500" />
                  <h3 className="text-xs sm:text-sm font-bold text-slate-900 dark:text-white uppercase tracking-wider">
                    Ulubione & Obserwowane
                  </h3>
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 font-mono">
                    {favoriteAssetItems.length}
                  </span>
                </div>
              </div>

              {favoriteAssetItems.length === 0 ? (
                <div className="p-4 rounded-2xl bg-amber-50/40 dark:bg-amber-950/20 border border-amber-200/80 dark:border-amber-800/60 flex items-center justify-between gap-3 text-xs">
                  <div className="flex items-center gap-2.5 text-amber-800 dark:text-amber-300">
                    <Star className="w-4 h-4 shrink-0 text-amber-500" />
                    <span>Brak ulubionych instrumentów. Kliknij gwiazdkę przy dowolnej spółce, aby mieć ją zawsze pod ręką.</span>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3 gap-3">
                  {favoriteAssetItems.map((asset) => renderAssetCard(asset))}
                </div>
              )}
            </div>

            {/* Section 3: Polecane & Podobne (Curated Benchmark Spotlight) */}
            <div>
              <div className="flex items-center justify-between gap-2 mb-3">
                <div className="flex items-center gap-2">
                  <Flame className="w-4 h-4 text-rose-500" />
                  <h3 className="text-xs sm:text-sm font-bold text-slate-900 dark:text-white uppercase tracking-wider">
                    Polecane & Popularne rynki
                  </h3>
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-rose-50 dark:bg-rose-950/60 text-rose-700 dark:text-rose-400 font-mono">
                    Top {spotlightAssetItems.length}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3 gap-3">
                {spotlightAssetItems.map((asset) => renderAssetCard(asset))}
              </div>
            </div>

            {/* Section 4: Reszta schowana – Zwijany / rozwijany panel */}
            <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
              <div className="p-4 rounded-2xl bg-slate-50/80 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-700/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                    <span className="text-xs font-bold text-slate-900 dark:text-white">
                      Reszta katalogu ({filteredAssets.length} spółek, funduszy ETF i krypto) jest schowana
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    Wpisz nazwę lub ticker w wyszukiwarce powyżej, albo rozwiń pełny katalog poniższym przyciskiem.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => setShowFullCatalog(true)}
                  className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-bold rounded-xl bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 border border-slate-200 dark:border-slate-700 shadow-xs transition-all cursor-pointer shrink-0"
                >
                  <ChevronDown className="w-3.5 h-3.5" />
                  <span>Pokaż pełną listę ({filteredAssets.length})</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
