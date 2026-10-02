import { odmienLiczebnik } from '../services/odmianaLiczebnika';
import { formatLiczba } from '../services/nbpService';
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { klikalny } from '../../shared/klikalny';
import {
  X,
  Star,
  Search,
  Plus,
  TrendingUp,
  TrendingDown,
  Check,
  RefreshCw,
  Layers,
  ShieldCheck,
  Building2,
  Globe2,
  Coins,
  Briefcase,
  SlidersHorizontal,
} from 'lucide-react';
import { AssetCategory, LiveMarketQuote } from '../types';
import type { BrokerSupportedAsset } from '../data/brokerAssetsDatabase';
import { DEFAULT_FAVORITE_TICKERS, marketDataService } from '../services/marketDataService';
import {
  freedom24StockListsService,
  Freedom24StockList,
} from '../services/freedom24StockListsService';
import { useZamknijEscape } from '../../shared/useZamknijEscape';
import { wykonajJednokrotnie } from '../services/jednokrotneZadanie';

interface ManageFavoritesModalProps {
  isOpen: boolean;
  onClose: () => void;
  favorites: string[];
  quotes: Record<string, LiveMarketQuote>;
  onToggleFavorite: (ticker: string) => void;
  onSetFavorites: (tickers: string[]) => void;
}

const BROKER_OPTIONS: Array<{ id: string; label: string; color: string }> = [
  { id: 'ALL', label: 'Wszyscy brokerzy', color: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200' },
  { id: 'XTB', label: 'XTB', color: 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300' },
  { id: 'IBKR', label: 'Interactive Brokers', color: 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300' },
  { id: 'FREEDOM24', label: 'Freedom24', color: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300' },
  { id: 'REVOLUT', label: 'Revolut', color: 'bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300' },
  { id: 'EMAKLER', label: 'mBank eMakler', color: 'bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-300' },
  { id: 'DEGIRO', label: 'DEGIRO', color: 'bg-teal-100 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300' },
  { id: 'BINANCE', label: 'Binance', color: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-950/50 dark:text-yellow-300' },
];

// Zamkniete okno odmontowuje tresc zamiast wracac z niej przed hookami.
// Powrot przed hookami gubil sprzatanie efektow (nasluch Escape, fokus),
// a odmontowanie zachowuje dotychczasowy reset stanu przy kazdym otwarciu.
export const ManageFavoritesModal: React.FC<ManageFavoritesModalProps> = (props) =>
  props.isOpen ? <ManageFavoritesModalTresc {...props} /> : null;

const ManageFavoritesModalTresc: React.FC<ManageFavoritesModalProps> = ({
  onClose,
  favorites,
  quotes,
  onToggleFavorite,
  onSetFavorites,
}) => {
  const refOkna = useZamknijEscape(true, onClose);

  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');
  const [selectedBroker, setSelectedBroker] = useState<string>('ALL');
  const [customTickerInput, setCustomTickerInput] = useState('');
  const [isSearchingCustom, setIsSearchingCustom] = useState(false);
  const [customError, setCustomError] = useState<string | null>(null);
  const [customSuccess, setCustomSuccess] = useState<string | null>(null);
  const customTickerSubmitInFlight = useRef(false);
  const latestFavorites = useRef(favorites);
  latestFavorites.current = favorites;

  // Freedom24 Stock Lists state
  const [freedomLists, setFreedomLists] = useState<Freedom24StockList[]>(() => {
    return freedom24StockListsService.getCachedLists().userStockLists;
  });
  const [selectedFreedomListId, setSelectedFreedomListId] = useState<number>(() => {
    return freedom24StockListsService.getCachedLists().selectedId || 1;
  });
  const [newListName, setNewListName] = useState('');
  const [newTickerForList, setNewTickerForList] = useState('');
  const [isCreatingList, setIsCreatingList] = useState(false);

  // Dynamic search results for live discovery
  const [searchResults, setSearchResults] = useState<BrokerSupportedAsset[]>([]);
  const [isSearchingLive, setIsSearchingLive] = useState(true);

  // When search term changes, perform fast live search
  useEffect(() => {
    let active = true;
    const query = searchTerm.trim();

    setIsSearchingLive(true);
    // Pusty tekst tez pobiera katalog po otwarciu okna.
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
    const handler = query ? setTimeout(() => { void szukaj(); }, 200) : undefined;
    if (!query) void szukaj();

    return () => {
      active = false;
      if (handler) clearTimeout(handler);
    };
  }, [searchTerm]);

  // Combine search results and known quotes/favorites
  const mergedAssetMap = useMemo(() => {
    const map = new Map<string, BrokerSupportedAsset>();

    // 1. Base results from search/catalog
    for (const item of searchResults) {
      map.set(item.ticker.toUpperCase(), item);
    }

    // 2. Favorites and active quotes
    for (const fav of favorites) {
      const upper = fav.toUpperCase();
      if (!map.has(upper)) {
        const quote = quotes[upper];
        map.set(upper, {
          ticker: upper,
          name: quote?.name || upper,
          category: quote?.category || 'STOCK_FOREIGN',
          currency: quote?.currency || 'USD',
          exchange: quote?.source || 'MARKET',
          brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT'],
        });
      }
    }

    return map;
  }, [searchResults, favorites, quotes]);

  const assetList = useMemo(() => {
    const values: BrokerSupportedAsset[] = Array.from(mergedAssetMap.values());
    return values.map((asset: BrokerSupportedAsset) => {
      const quote = quotes[asset.ticker.toUpperCase()];
      return {
        ...asset,
        price: quote?.price,
        changePercent24h: quote?.changePercent24h,
        isFav: favorites.includes(asset.ticker.toUpperCase()),
      };
    });
  }, [mergedAssetMap, quotes, favorites]);

  // Filtered assets by category and broker
  const filteredAssets = useMemo(() => {
    return assetList.filter((asset) => {
      // Category filter
      if (selectedCategory === 'FAVORITES' && !asset.isFav) return false;
      if (selectedCategory === 'STOCK_FOREIGN' && asset.category !== 'STOCK_FOREIGN') return false;
      if (selectedCategory === 'STOCK_PL' && asset.category !== 'STOCK_PL') return false;
      if (selectedCategory === 'ETF' && asset.category !== 'ETF') return false;
      if (selectedCategory === 'CRYPTO' && asset.category !== 'CRYPTO') return false;

      // Broker filter
      if (selectedBroker !== 'ALL') {
        const brokers = asset.brokers || [];
        if (!brokers.includes(selectedBroker as any)) {
          return false;
        }
      }

      return true;
    });
  }, [assetList, selectedCategory, selectedBroker]);

  const handleAddCustomTicker = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = customTickerInput.trim().toUpperCase();
    if (!clean) return;

    await wykonajJednokrotnie(customTickerSubmitInFlight, async () => {
      setIsSearchingCustom(true);
      setCustomError(null);
      setCustomSuccess(null);

      try {
        const quote = await marketDataService.fetchSingleTicker(clean, true);
        if (quote) {
          if (!latestFavorites.current.includes(clean)) {
            onToggleFavorite(clean);
          }
          setCustomSuccess(`Pomyślnie dodano ${clean} (${quote.name}) do ulubionych z kursem ${formatLiczba(quote.price)} ${quote.currency}!`);
          setCustomTickerInput('');
          setTimeout(() => setCustomSuccess(null), 4000);
        } else {
          setCustomError(`Nie znaleziono wycen dla symbolu "${clean}". Wpisz dokładny symbol (np. AAPL, NVDA, CDR, PKN, BTC, VWCE, BABA, TSM).`);
        }
      } catch {
        setCustomError(`Błąd pobierania danych dla "${clean}".`);
      } finally {
        setIsSearchingCustom(false);
      }
    });
  };

  const handleSelectDefaults = () => {
    onSetFavorites(DEFAULT_FAVORITE_TICKERS);
  };

  const handleClearAll = () => {
    onSetFavorites([]);
  };

  const handleCreateFreedomList = async () => {
    if (!newListName.trim()) return;
    const res = await freedom24StockListsService.addList(newListName.trim(), []);
    setFreedomLists(res.userStockLists);
    setSelectedFreedomListId(res.selectedId);
    setNewListName('');
    setIsCreatingList(false);
  };

  const handleDeleteFreedomList = async (id: number) => {
    const res = await freedom24StockListsService.deleteList(id);
    setFreedomLists(res.userStockLists);
    setSelectedFreedomListId(res.selectedId);
  };

  const handleAddTickerToActiveList = async () => {
    if (!newTickerForList.trim()) return;
    const res = await freedom24StockListsService.addTicker(selectedFreedomListId, newTickerForList.trim());
    setFreedomLists(res.userStockLists);
    setNewTickerForList('');
  };

  const handleDeleteTickerFromActiveList = async (ticker: string) => {
    const res = await freedom24StockListsService.deleteTicker(selectedFreedomListId, ticker);
    setFreedomLists(res.userStockLists);
  };

  const handleApplyFreedomListToFavorites = (list: Freedom24StockList) => {
    const combined = Array.from(new Set([...favorites, ...list.tickers.map((t) => t.toUpperCase())]));
    onSetFavorites(combined);
    setCustomSuccess(`Zaimportowano ${list.tickers.length} ${odmienLiczebnik(list.tickers.length, 'ticker', 'tickery', 'tickerów')} z listy "${list.name}" do paska ulubionych!`);
    setTimeout(() => setCustomSuccess(null), 4000);
  };

  const activeFreedomList = freedomLists.find((l) => l.id === selectedFreedomListId) || freedomLists[0];

  return (
    <div ref={refOkna} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Katalog Spółek i Tickerów Maklerskich" className="outline-none fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/70 backdrop-blur-xs animate-in fade-in duration-200">
      <div
        id="manage-favorites-modal"
        className="relative w-full max-w-3xl max-h-[92vh] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col"
      >
        {/* Header */}
        <div className="p-4 sm:p-5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50/70 dark:bg-slate-900/70">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-amber-500/10 text-amber-500 border border-amber-500/20">
              <Star className="w-5 h-5 fill-amber-500" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base sm:text-lg font-bold text-slate-900 dark:text-white">
                  Katalog Spółek i Tickerów Maklerskich
                </h2>
                <span className="text-xs px-2.5 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 font-semibold font-mono">
                  {favorites.length} śledzonych
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Baza instrumentów obsługiwanych przez XTB, Interactive Brokers, Freedom24, Revolut, eMakler i Binance.
              </p>
            </div>
          </div>

          <button
            aria-label="Zamknij"
            onClick={onClose}
            className="p-2 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Custom Ticker Input Bar */}
        <div className="px-4 sm:px-6 pt-3 pb-2 border-b border-slate-100 dark:border-slate-800">
          <form onSubmit={handleAddCustomTicker} className="flex gap-2">
            <div className="relative flex-1">
              <input
                type="text"
                value={customTickerInput}
                onChange={(e) => setCustomTickerInput(e.target.value.toUpperCase())}
                placeholder="Wyszukaj lub dodaj dowolny ticker (np. BABA, TSM, ARM, COIN, PLTR, PKN, CDR, BTC)..."
                className="w-full pl-3 pr-10 py-2 text-xs sm:text-sm rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-500 uppercase font-mono"
              />
            </div>
            <button
              type="submit"
              disabled={isSearchingCustom || !customTickerInput.trim()}
              className="px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-amber-950 text-xs font-semibold flex items-center gap-1.5 transition-all shadow-xs cursor-pointer shrink-0"
            >
              {isSearchingCustom ? (
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Plus className="w-3.5 h-3.5" />
              )}
              <span>Dodaj do paska</span>
            </button>
          </form>

          {customSuccess && (
            <div className="mt-2 text-xs text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 p-2 rounded-lg flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5 shrink-0" />
              <span>{customSuccess}</span>
            </div>
          )}

          {customError && (
            <div className="mt-2 text-xs text-rose-700 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 p-2 rounded-lg">
              {customError}
            </div>
          )}
        </div>

        {/* Filter Controls & Search */}
        <div className="px-4 sm:px-6 py-3 border-b border-slate-100 dark:border-slate-800 space-y-2.5 bg-slate-50/40 dark:bg-slate-900/40">
          <div className="flex flex-col sm:flex-row gap-2 justify-between">
            {/* Search Input */}
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Szukaj po nazwie, tickerze, ISIN lub giełdzie..."
                className="w-full pl-9 pr-8 py-1.5 text-xs rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-amber-500"
              />
              {isSearchingLive && (
                <RefreshCw className="w-3.5 h-3.5 text-amber-500 animate-spin absolute right-3 top-1/2 -translate-y-1/2" />
              )}
            </div>

            {/* Quick Presets */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleSelectDefaults}
                className="px-2.5 py-1.5 text-[11px] font-medium rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 transition-colors cursor-pointer"
              >
                Zestaw domyślny
              </button>
              <button
                type="button"
                onClick={handleClearAll}
                className="px-2.5 py-1.5 text-[11px] font-medium rounded-lg text-slate-500 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition-colors cursor-pointer"
              >
                Odznacz wszystkie
              </button>
            </div>
          </div>

          {/* Category Tabs */}
          <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none pb-1 text-xs">
            {[
              { id: 'ALL', label: 'Wszystkie rynki' },
              { id: 'FAVORITES', label: `⭐ Ulubione (${favorites.length})` },
              { id: 'FREEDOM_LISTS', label: '📑 Listy Freedom24 (lokalne zmiany)' },
              { id: 'STOCK_FOREIGN', label: '🇺🇸 Akcje USA / Global' },
              { id: 'STOCK_PL', label: '🇵🇱 GPW Warszawa' },
              { id: 'ETF', label: '🇪🇺 Fundusze ETF UCITS' },
              { id: 'CRYPTO', label: '🪙 Kryptowaluty' },
            ].map((cat) => (
              <button
                key={cat.id}
                onClick={() => setSelectedCategory(cat.id)}
                className={`px-3 py-1 rounded-lg font-medium whitespace-nowrap transition-all cursor-pointer ${
                  selectedCategory === cat.id
                    ? 'bg-amber-500 text-amber-950 shadow-xs'
                    : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700'
                }`}
              >
                {cat.label}
              </button>
            ))}
          </div>

          {/* Broker Filter Badges (only when not in Freedom lists view) */}
          {selectedCategory !== 'FREEDOM_LISTS' && (
            <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none text-[11px] pt-0.5">
              <span className="text-slate-400 text-[10px] font-medium shrink-0 flex items-center gap-1">
                <Briefcase className="w-3 h-3" />
                <span>Broker:</span>
              </span>
              {BROKER_OPTIONS.map((b) => (
                <button
                  key={b.id}
                  onClick={() => setSelectedBroker(b.id)}
                  className={`px-2 py-0.5 rounded-md font-medium whitespace-nowrap transition-all cursor-pointer text-[11px] border ${
                    selectedBroker === b.id
                      ? 'bg-blue-600 text-white border-blue-600 shadow-xs'
                      : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-750'
                  }`}
                >
                  {b.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Content Area: Freedom24 Stock Lists View vs Standard Assets List */}
        {selectedCategory === 'FREEDOM_LISTS' ? (
          <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4">
            {/* Header / Info */}
            <div className="p-3.5 rounded-xl bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 flex items-center justify-between">
              <div>
                <h3 className="font-bold text-xs sm:text-sm text-blue-900 dark:text-blue-100 flex items-center gap-2">
                   <span>Listy papierów Freedom24</span>
                  <span className="text-[10px] px-2 py-0.5 rounded bg-blue-200/80 dark:bg-blue-900 text-blue-800 dark:text-blue-200 font-mono">
                    {freedomLists.length} list
                  </span>
                </h3>
                <p className="text-[11px] text-blue-700 dark:text-blue-300 mt-0.5">
                   Listy można odczytać z konta Freedom24. Dodawanie i usuwanie list oraz tickerów zapisuje zmiany tylko w tej przeglądarce — nie na koncie brokera.
                </p>
              </div>

              <button
                type="button"
                onClick={() => setIsCreatingList(!isCreatingList)}
                className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold flex items-center gap-1 cursor-pointer transition-all shadow-xs shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Nowa lista</span>
              </button>
            </div>

            {/* Create new list form */}
            {isCreatingList && (
              <div className="p-3.5 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shadow-sm space-y-2 animate-in fade-in">
                <div className="text-xs font-bold text-slate-800 dark:text-slate-200">
                  Utwórz nową listę papierów wartościowych
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newListName}
                    onChange={(e) => setNewListName(e.target.value)}
                    placeholder="Nazwa listy (np. AI & Semi, Dywidendy USA, IPO 2026)..."
                    className="flex-1 px-3 py-1.5 text-xs rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                  <button
                    type="button"
                    onClick={handleCreateFreedomList}
                    disabled={!newListName.trim()}
                    className="px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white text-xs font-semibold cursor-pointer"
                  >
                    Zapisz
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsCreatingList(false)}
                    className="px-2.5 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 text-xs cursor-pointer"
                  >
                    Anuluj
                  </button>
                </div>
              </div>
            )}

            {/* Stock Lists Tabs / Pills */}
            <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-none">
              {freedomLists.map((list) => {
                const isSelected = list.id === selectedFreedomListId;
                return (
                  <div
                    key={list.id}
                    {...klikalny(() => setSelectedFreedomListId(list.id), { wybrany: isSelected })}
                    className={`px-3 py-2 rounded-xl border flex items-center gap-2 cursor-pointer transition-all shrink-0 ${
                      isSelected
                        ? 'bg-blue-600 text-white border-blue-600 shadow-xs'
                        : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-750'
                    }`}
                  >
                    <span>{list.picture || '📁'}</span>
                    <span className="font-semibold text-xs">{list.name}</span>
                    <span
                      className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono font-bold ${
                        isSelected
                          ? 'bg-blue-700 text-white'
                          : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      {list.tickers.length}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Selected List Details & Tickers Table */}
            {activeFreedomList && (
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-800/80 p-4 space-y-3 shadow-xs">
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 border-b border-slate-100 dark:border-slate-700 pb-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-base">{activeFreedomList.picture || '📁'}</span>
                      <h4 className="font-bold text-sm text-slate-900 dark:text-white">
                        {activeFreedomList.name}
                      </h4>
                      <span className="text-xs text-slate-400 font-mono">
                        (ID #{activeFreedomList.id})
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-500 mt-0.5">
                      Zawiera {activeFreedomList.tickers.length} {odmienLiczebnik(activeFreedomList.tickers.length, 'instrument', 'instrumenty', 'instrumentów')}.
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleApplyFreedomListToFavorites(activeFreedomList)}
                      className="px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-amber-950 text-xs font-semibold flex items-center gap-1.5 cursor-pointer shadow-xs transition-all"
                    >
                      <Star className="w-3.5 h-3.5 fill-white" />
                      <span>Zaimportuj do Ulubionych</span>
                    </button>
                    {freedomLists.length > 1 && (
                      <button
                        type="button"
                        onClick={() => handleDeleteFreedomList(activeFreedomList.id)}
                        className="p-1.5 rounded-lg text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors cursor-pointer"
                        title="Usuń listę"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>

                {/* Add ticker to active list bar */}
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newTickerForList}
                    onChange={(e) => setNewTickerForList(e.target.value.toUpperCase())}
                    placeholder="Wpisz ticker do dodania (np. AAPL, NVDA, INTC.US, TSLA)..."
                    className="flex-1 px-3 py-1.5 text-xs rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white uppercase font-mono focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                  <button
                    type="button"
                    onClick={handleAddTickerToActiveList}
                    disabled={!newTickerForList.trim()}
                    className="px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-semibold flex items-center gap-1 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Dodaj Ticker</span>
                  </button>
                </div>

                {/* Tickers Grid in Active List */}
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 pt-1">
                  {activeFreedomList.tickers.map((ticker) => {
                    const clean = ticker.replace('.US', '').replace('.EU', '').replace('.WA', '');
                    const quote = quotes[clean];
                    const livePrice = quote?.price;
                    const change = quote?.changePercent24h || 0;
                    const isFav = favorites.includes(clean);

                    return (
                      <div
                        key={ticker}
                        className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 flex items-center justify-between group"
                      >
                        <div>
                          <div className="flex items-center gap-1.5">
                            <span className="font-bold text-xs font-mono text-slate-900 dark:text-white">
                              {ticker}
                            </span>
                            {isFav && (
                              <Star className="w-2.5 h-2.5 fill-amber-500 text-amber-500" />
                            )}
                          </div>
                           {typeof livePrice === 'number' && Number.isFinite(livePrice) ? (
                            <div className="text-[10px] font-mono text-slate-500">
                               {formatLiczba(livePrice)} {quote.currency}{' '}
                              <span className={change >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'}>
                                ({change >= 0 ? '+' : ''}{formatLiczba(change, 1)}%)
                              </span>
                            </div>
                          ) : (
                            <div className="text-[9px] text-slate-400">Notowany Freedom24</div>
                          )}
                        </div>

                        <button
                          type="button"
                          onClick={() => handleDeleteTickerFromActiveList(ticker)}
                          className="text-slate-300 hover:text-rose-500 transition-colors p-1 cursor-pointer"
                          title={`Usuń ${ticker} z listy`}
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        ) : (
          /* Assets List */
          <div className="flex-1 overflow-y-auto p-4 sm:p-5 divide-y divide-slate-100 dark:divide-slate-800/80">
            {filteredAssets.length === 0 && isSearchingLive ? (
              <div role="status" className="py-12 text-center text-slate-400 text-xs">Wczytywanie katalogu...</div>
            ) : filteredAssets.length === 0 ? (
              <div className="py-12 text-center text-slate-400 text-xs">
                Brak wyników dla podanych filtrów. Wpisz dowolny symbol w górnym polu, aby pobrać go na żywo!
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {filteredAssets.map((asset) => {
                  const isPos = (asset.changePercent24h || 0) >= 0;
                  return (
                    <div
                      key={asset.ticker}
                      onClick={() => onToggleFavorite(asset.ticker)}
                      className={`p-3 rounded-xl border flex items-center justify-between cursor-pointer transition-all ${
                        asset.isFav
                          ? 'bg-amber-50/60 dark:bg-amber-950/25 border-amber-300 dark:border-amber-700/60 shadow-xs ring-1 ring-amber-400/30'
                          : 'bg-white dark:bg-slate-800/60 border-slate-200 dark:border-slate-700/80 hover:border-slate-300 dark:hover:border-slate-600'
                      }`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0 pr-2">
                        <button
                          type="button"
                          aria-label={asset.isFav ? `Usuń ${asset.ticker} z ulubionych` : `Dodaj ${asset.ticker} do ulubionych`}
                          aria-pressed={asset.isFav}
                          className={`p-1.5 rounded-lg transition-transform shrink-0 ${
                            asset.isFav
                              ? 'text-amber-500 scale-110'
                              : 'text-slate-300 dark:text-slate-600 hover:text-amber-400'
                          }`}
                        >
                          <Star className={`w-4 h-4 ${asset.isFav ? 'fill-amber-500' : ''}`} />
                        </button>

                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-bold text-xs sm:text-sm text-slate-900 dark:text-white font-mono">
                              {asset.ticker}
                            </span>
                            <span className="text-[9px] px-1.5 py-0.2 rounded bg-slate-100 dark:bg-slate-700 text-slate-500 font-medium">
                              {asset.exchange}
                            </span>
                          </div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate max-w-[170px] sm:max-w-[200px]" title={asset.name}>
                            {asset.name}
                          </div>
                          {/* Broker Support Badges */}
                          {asset.brokers && asset.brokers.length > 0 && (
                            <div className="flex items-center gap-1 mt-1 flex-wrap">
                              {asset.brokers.slice(0, 3).map((brk) => (
                                <span key={brk} className="text-[8px] font-semibold px-1 py-0.2 rounded bg-slate-100 dark:bg-slate-750 text-slate-500 dark:text-slate-400 font-mono">
                                  {brk}
                                </span>
                              ))}
                              {asset.brokers.length > 3 && (
                                <span className="text-[8px] text-slate-400">+{asset.brokers.length - 3}</span>
                              )}
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="text-right shrink-0">
                        {asset.price !== undefined ? (
                          <>
                            <div className="font-bold text-xs sm:text-sm font-mono text-slate-900 dark:text-white">
                              {formatLiczba(asset.price)} {asset.currency}
                            </div>
                            <div
                              className={`text-[11px] font-semibold flex items-center justify-end gap-0.5 ${
                                isPos ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'
                              }`}
                            >
                              {isPos ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                              <span>
                                {isPos ? '+' : ''}
                                {asset.changePercent24h == null ? '—' : formatLiczba(asset.changePercent24h)}%
                              </span>
                            </div>
                          </>
                        ) : (
                          <div className="text-[10px] text-slate-400 font-mono">
                            {asset.currency}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="p-3 sm:p-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-900/80 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <ShieldCheck className="w-4 h-4 text-emerald-500 shrink-0" />
            <span className="hidden sm:inline">Prawdziwe notowania giełdowe z GPW, NASDAQ, NYSE, Xetra i Binance.</span>
            <span className="sm:hidden font-mono text-[11px]">{filteredAssets.length} {odmienLiczebnik(filteredAssets.length, 'instrument', 'instrumenty', 'instrumentów')}</span>
          </div>

          <button
            onClick={onClose}
            className="px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs sm:text-sm font-semibold transition-all shadow-sm cursor-pointer"
          >
            Zatwierdź ({favorites.length})
          </button>
        </div>
      </div>
    </div>
  );
};
