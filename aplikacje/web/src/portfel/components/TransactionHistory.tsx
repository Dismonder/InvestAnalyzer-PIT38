import React, { useState, useMemo, useEffect, useDeferredValue } from 'react';
import { odmienLiczebnik } from '../services/odmianaLiczebnika';
import { useZamknijEscape } from '../../shared/useZamknijEscape';
import {
  Transaction,
  BrokerAccount,
  AssetCategory,
  TransactionType,
  Language,
} from '../types';
import { getTranslation } from '../i18n/translations';
import { formatCurrency, formatLiczba, formatPolishDate } from '../services/nbpService';
import { exportTransactionsCSV } from '../services/csvExporter';
import { dzisiajLokalnie } from '../services/formularzTransakcji';
import {
  Search,
  Plus,
  FileSpreadsheet,
  Upload,
  Filter,
  Trash2,
  Edit2,
  ArrowDownLeft,
  ArrowUpRight,
  DollarSign,
  Coins,
  LayoutGrid,
  List,
  Calendar,
  Building2,
} from 'lucide-react';

interface TransactionHistoryProps {
  transactions: Transaction[];
  accounts: BrokerAccount[];
  language: Language;
  onAddTransaction: () => void;
  onImportTransactions: () => void;
  onDeleteTransaction: (id: string) => void;
  onEditTransaction: (tx: Transaction) => void;
  onClearAllTransactions?: () => void;
}

/** Ile wierszy historii renderowac naraz; kolejne porcje na zadanie. */
const PORCJA_WIERSZY = 200;

export const TransactionHistory: React.FC<TransactionHistoryProps> = ({
  transactions,
  accounts,
  language,
  onAddTransaction,
  onImportTransactions,
  onDeleteTransaction,
  onEditTransaction,
  onClearAllTransactions,
}) => {
  const t = getTranslation(language);
  const liczbaWpisowRecznych = transactions.filter((tx) => !tx.tylkoOdczyt).length;

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>(() => {
    return localStorage.getItem('pit38_tx_filter_category') || 'ALL';
  });
  const [selectedBroker, setSelectedBroker] = useState<string>(() => {
    return localStorage.getItem('pit38_tx_filter_broker') || 'ALL';
  });
  const [selectedType, setSelectedType] = useState<string>(() => {
    return localStorage.getItem('pit38_tx_filter_type') || 'ALL';
  });
  const [selectedYear, setSelectedYear] = useState<string>(() => {
    return localStorage.getItem('pit38_tx_filter_year') || 'ALL';
  });
  const [viewMode, setViewMode] = useState<'TABLE' | 'CARDS'>(() => {
    const zapisany = localStorage.getItem('pit38_tx_view_mode') as 'TABLE' | 'CARDS' | null;
    if (zapisany === 'TABLE' || zapisany === 'CARDS') return zapisany;
    // Telefon: tabela miesci na 360 px tylko dwie kolumny i wymaga przewijania
    // w bok - kafelki pokazuja cala transakcje. Wybor uzytkownika ma pierwszenstwo.
    return typeof window !== 'undefined' && window.matchMedia?.('(max-width: 639px)').matches ? 'CARDS' : 'TABLE';
  });
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const refOknaCzyszczenia = useZamknijEscape(showClearConfirm, () => setShowClearConfirm(false));

  useEffect(() => {
    localStorage.setItem('pit38_tx_filter_category', selectedCategory);
  }, [selectedCategory]);

  useEffect(() => {
    localStorage.setItem('pit38_tx_filter_broker', selectedBroker);
  }, [selectedBroker]);

  useEffect(() => {
    localStorage.setItem('pit38_tx_filter_type', selectedType);
  }, [selectedType]);

  useEffect(() => {
    localStorage.setItem('pit38_tx_filter_year', selectedYear);
  }, [selectedYear]);

  useEffect(() => {
    localStorage.setItem('pit38_tx_view_mode', viewMode);
  }, [viewMode]);

  // Extract available years from transactions
  const years = useMemo(() => {
    const set = new Set<string>();
    transactions.forEach((tx) => set.add(tx.date.slice(0, 4)));
    return Array.from(set).sort().reverse();
  }, [transactions]);

  // Filtered transactions
  // Wyszukiwanie przelicza liste w tle, zeby wpisywanie nie czekalo na render.
  const odroczoneZapytanie = useDeferredValue(searchQuery);
  const filteredTransactions = useMemo(() => {
    return transactions.filter((tx) => {
      if (selectedCategory !== 'ALL' && tx.category !== selectedCategory) return false;
      if (selectedBroker !== 'ALL' && tx.accountId !== selectedBroker) return false;
      if (selectedType !== 'ALL' && tx.type !== selectedType) return false;
      if (selectedYear !== 'ALL' && !tx.date.startsWith(selectedYear)) return false;

      if (odroczoneZapytanie.trim() !== '') {
        const query = odroczoneZapytanie.toLowerCase();
        const matchTicker = tx.ticker.toLowerCase().includes(query);
        const matchName = tx.name.toLowerCase().includes(query);
        const matchNotes = tx.notes ? tx.notes.toLowerCase().includes(query) : false;
        if (!matchTicker && !matchName && !matchNotes) return false;
      }

      return true;
    });
  }, [transactions, selectedCategory, selectedBroker, selectedType, selectedYear, odroczoneZapytanie]);

  // Tysiace wierszy naraz blokowaly interfejs: przy 5000 transakcji jeden znak
  // w wyszukiwarce kosztowal ok. 0,6 s. Widok pokazuje porcje, a filtry i
  // eksport CSV nadal dzialaja na calej liscie.
  const [limitWierszy, setLimitWierszy] = useState(PORCJA_WIERSZY);
  useEffect(() => setLimitWierszy(PORCJA_WIERSZY), [filteredTransactions]);
  const widoczneTransakcje = useMemo(
    () => filteredTransactions.slice(0, limitWierszy),
    [filteredTransactions, limitWierszy],
  );
  const pokazWiecej = filteredTransactions.length > limitWierszy ? (
    <button
      type="button"
      onClick={() => setLimitWierszy((obecny) => obecny + PORCJA_WIERSZY)}
      className="rounded-lg border border-slate-200 dark:border-slate-700 px-4 py-2 text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
    >
      Pokaż kolejne transakcje ({widoczneTransakcje.length} z {filteredTransactions.length})
    </button>
  ) : null;

  const handleExportCSV = () => {
    exportTransactionsCSV(filteredTransactions, accounts, `Transakcje_Eksport_${dzisiajLokalnie()}.csv`);
  };

  const getCategoryBadge = (cat: AssetCategory) => {
    switch (cat) {
      case 'STOCK_PL':
        return <span className="px-2 py-0.5 rounded bg-red-100 dark:bg-red-950/60 text-red-700 dark:text-red-300 font-semibold text-[10px]">GPW</span>;
      case 'STOCK_FOREIGN':
        return <span className="px-2 py-0.5 rounded bg-blue-100 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 font-semibold text-[10px]">USA/Global</span>;
      case 'ETF':
        return <span className="px-2 py-0.5 rounded bg-purple-100 dark:bg-purple-950/60 text-purple-700 dark:text-purple-300 font-semibold text-[10px]">ETF</span>;
      case 'CRYPTO':
        return <span className="px-2 py-0.5 rounded bg-amber-100 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 font-semibold text-[10px]">Krypto</span>;
      case 'BOND':
        return <span className="px-2 py-0.5 rounded bg-violet-100 dark:bg-violet-950/60 text-violet-700 dark:text-violet-300 font-semibold text-[10px]">Obligacje/Noty</span>;
      default:
        return <span className="px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 text-[10px]">Inne</span>;
    }
  };

  const getTypeBadge = (type: TransactionType) => {
    switch (type) {
      case 'BUY':
        return (
          <span className="flex items-center gap-1 font-semibold text-emerald-700 dark:text-emerald-400">
            <ArrowDownLeft className="w-3.5 h-3.5" />
            <span>Kupno</span>
          </span>
        );
      case 'SELL':
        return (
          <span className="flex items-center gap-1 font-semibold text-rose-700 dark:text-rose-400">
            <ArrowUpRight className="w-3.5 h-3.5" />
            <span>Sprzedaż</span>
          </span>
        );
      case 'DIVIDEND':
        return (
          <span className="flex items-center gap-1 font-semibold text-blue-600 dark:text-blue-400">
            <DollarSign className="w-3.5 h-3.5" />
            <span>Dywidenda</span>
          </span>
        );
      default:
        return <span className="font-semibold text-slate-500">Opłata</span>;
    }
  };

  return (
    <div id="transaction-history-container" className="space-y-6">
      {/* Header with Title & Action Buttons */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white dark:bg-slate-900 p-5 sm:p-6 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <span>{t.navTransactions}</span>
            <span className="text-xs px-2.5 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/60 text-blue-700 dark:text-blue-300 font-semibold">
              {filteredTransactions.length} z {transactions.length}
            </span>
          </h1>
          <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 mt-1">
            Zarządzaj operacjami kupna, sprzedaży i dywidend ze wszystkich rachunków maklerskich
          </p>
        </div>

        {/* Od 1280 px przyciski trzymaja jeden wiersz, a zawija sie opis: wczesniej "Dodaj
            transakcje" spadal samotnie do drugiego wiersza mimo wolnego miejsca. */}
        {/* Telefon: siatka 2 kolumny, zeby cztery przyciski nie staly jeden pod drugim. */}
        <div className="grid grid-cols-2 sm:flex sm:flex-wrap sm:items-center gap-2.5 xl:flex-nowrap xl:shrink-0">
          {onClearAllTransactions && liczbaWpisowRecznych > 0 && (
            <button
              onClick={() => setShowClearConfirm(true)}
              className="flex items-center justify-center sm:justify-start gap-1.5 px-3 py-2 text-xs font-semibold rounded-xl bg-rose-50 hover:bg-rose-100 dark:bg-rose-950/40 dark:hover:bg-rose-900/60 text-rose-700 dark:text-rose-400 border border-rose-200/60 dark:border-rose-800/60 transition-all cursor-pointer"
              title="Wyczyść całą historię transakcji"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Wyczyść Historię</span>
            </button>
          )}

          <button
            id="btn-import-statement"
            onClick={onImportTransactions}
            className="flex items-center justify-center sm:justify-start gap-1.5 px-3 py-2 text-xs font-semibold rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 border border-slate-200 dark:border-slate-700 transition-all cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>{t.importFile}</span>
          </button>

          <button
            id="btn-export-tx-csv"
            onClick={handleExportCSV}
            className="flex items-center justify-center sm:justify-start gap-1.5 px-3 py-2 text-xs font-semibold rounded-xl bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 hover:bg-emerald-100 dark:hover:bg-emerald-900/60 transition-all cursor-pointer"
          >
            <FileSpreadsheet className="w-3.5 h-3.5" />
            <span>Eksportuj CSV</span>
          </button>

          <button
            id="btn-add-tx"
            onClick={onAddTransaction}
            className="flex items-center justify-center sm:justify-start gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-xl bg-blue-600 hover:bg-blue-700 text-white shadow-sm shadow-blue-500/20 transition-all cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>{t.addTransaction}</span>
          </button>
        </div>
      </div>

      {/* Clear Confirmation Modal */}
      {showClearConfirm && (
        <div ref={refOknaCzyszczenia} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Wyczyść historię transakcji" className="outline-none fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 max-w-sm w-full space-y-4 shadow-2xl">
            <h3 className="text-base font-bold text-slate-900 dark:text-white">
              Wyczyścić historię transakcji?
            </h3>
            <p className="text-xs text-slate-600 dark:text-slate-400">
              Spowoduje to usunięcie wpisów dodanych ręcznie w tej przeglądarce ({liczbaWpisowRecznych} {odmienLiczebnik(liczbaWpisowRecznych, 'pozycja', 'pozycje', 'pozycji')}). Transakcje z dokumentów brokera zostają w magazynie silnika.
            </p>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                onClick={() => setShowClearConfirm(false)}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200"
              >
                Anuluj
              </button>
              <button
                onClick={() => {
                  onClearAllTransactions?.();
                  setShowClearConfirm(false);
                }}
                className="px-3 py-1.5 text-xs font-bold rounded-lg bg-rose-600 hover:bg-rose-500 text-white"
              >
                Wyczyść Transakcje
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Advanced Filters Bar */}
      <div className="bg-white dark:bg-slate-900 p-4 sm:p-5 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm hover:shadow-md transition-all duration-300 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-xs font-bold text-slate-700 dark:text-slate-300">
            <Filter className="w-4 h-4 text-blue-600" />
            <span>Filtrowanie i przeszukiwanie rejestru transakcji</span>
          </div>

          {/* View Mode Toggle */}
          <div className="inline-flex p-1 rounded-xl bg-slate-100 dark:bg-slate-800 border border-slate-200/80 dark:border-slate-700/80">
            <button
              onClick={() => setViewMode('TABLE')}
              className={`flex items-center gap-1.5 px-2.5 py-1 min-h-8 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
                viewMode === 'TABLE'
                  ? 'bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 shadow-xs'
                  : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
              }`}
              title="Widok tabeli"
            >
              <List className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Tabela</span>
            </button>
            <button
              onClick={() => setViewMode('CARDS')}
              className={`flex items-center gap-1.5 px-2.5 py-1 min-h-8 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
                viewMode === 'CARDS'
                  ? 'bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 shadow-xs'
                  : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
              }`}
              title="Widok kafelków"
            >
              <LayoutGrid className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Kafelki</span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          {/* Search box */}
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              id="input-search-transactions"
              type="text"
              placeholder={t.searchPlaceholder}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-xs rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Category filter */}
          <div>
            <select
              id="filter-category-select"
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-200 focus:outline-none cursor-pointer"
            >
              <option value="ALL">{t.allCategories}</option>
              <option value="STOCK_PL">{t.stockPl}</option>
              <option value="STOCK_FOREIGN">{t.stockForeign}</option>
              <option value="ETF">{t.etf}</option>
              <option value="CRYPTO">{t.crypto}</option>
              <option value="BOND">Obligacje / Noty Strukturyzowane</option>
            </select>
          </div>

          {/* Broker filter */}
          <div>
            <select
              id="filter-broker-select"
              value={selectedBroker}
              onChange={(e) => setSelectedBroker(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-200 focus:outline-none cursor-pointer"
            >
              <option value="ALL">{t.allBrokers}</option>
              {accounts.map((acc) => (
                <option key={acc.id} value={acc.id}>
                  {acc.name} ({acc.brokerType})
                </option>
              ))}
            </select>
          </div>

          {/* Operation Type filter */}
          <div>
            <select
              id="filter-type-select"
              value={selectedType}
              onChange={(e) => setSelectedType(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-200 focus:outline-none cursor-pointer"
            >
              <option value="ALL">{t.allTypes}</option>
              <option value="BUY">{t.buy}</option>
              <option value="SELL">{t.sell}</option>
              <option value="DIVIDEND">{t.dividend}</option>
            </select>
          </div>

          {/* Year filter */}
          <div>
            <select
              id="filter-year-select"
              value={selectedYear}
              onChange={(e) => setSelectedYear(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-200 focus:outline-none cursor-pointer"
            >
              <option value="ALL">{t.allYears}</option>
              {years.map((yr) => (
                <option key={yr} value={yr}>
                  Rok {yr}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Transactions Cards Grid View */}
      {viewMode === 'CARDS' && (
        <div className="space-y-4">
          {filteredTransactions.length === 0 ? (
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-12 text-center text-slate-400 text-xs">
              Brak transakcji spełniających wybrane kryteria filtrowania.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {widoczneTransakcje.map((tx) => {
                const acc = accounts.find((a) => a.id === tx.accountId);
                const totalVal = tx.quantity * tx.pricePerUnit;

                return (
                  <div
                    key={tx.id}
                    className="group min-w-0 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-4 shadow-xs hover:shadow-md hover:border-slate-300 dark:hover:border-slate-700 transition-colors duration-200 flex flex-col justify-between"
                  >
                    <div>
                      {/* Top Header of Card */}
                      <div className="flex items-start justify-between gap-2 pb-3 border-b border-slate-100 dark:border-slate-800">
                        <div className="flex items-center gap-2.5">
                          <div className="w-10 h-10 rounded-xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center font-bold text-xs text-slate-800 dark:text-slate-200 group-hover:bg-blue-50 dark:group-hover:bg-blue-950/60 group-hover:text-blue-600 transition-colors">
                            {tx.ticker.slice(0, 4)}
                          </div>
                          <div>
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="font-bold text-sm text-slate-900 dark:text-white font-mono">
                                {tx.ticker}
                              </span>
                              {getCategoryBadge(tx.category)}
                            </div>
                            <div className="text-[11px] text-slate-500 truncate max-w-[150px]">
                              {tx.name}
                            </div>
                          </div>
                        </div>

                        <div className={tx.tylkoOdczyt ? 'hidden' : 'flex items-center gap-1'}>
                          <button
                            onClick={() => onEditTransaction(tx)}
                            className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
                            title="Edytuj"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => onDeleteTransaction(tx.id)}
                            className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
                            title="Usuń"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>

                      {/* Operation details */}
                      <div className="grid grid-cols-2 gap-2.5 py-3 text-xs">
                        <div>
                          <span className="text-[10px] text-slate-400 block font-medium">Typ zlecenia</span>
                          <div className="mt-0.5">{getTypeBadge(tx.type)}</div>
                        </div>
                        <div>
                          <span className="text-[10px] text-slate-400 block font-medium">Data transakcji</span>
                          <span className="font-mono text-slate-700 dark:text-slate-300 text-[11px]">
                            {formatPolishDate(tx.date)}
                          </span>
                        </div>
                        <div>
                          <span className="text-[10px] text-slate-400 block font-medium">Ilość & Cena</span>
                          <span className="font-mono text-slate-800 dark:text-slate-200">
                            {tx.quantity} szt. @ {formatLiczba(tx.pricePerUnit)} {tx.currency}
                          </span>
                        </div>
                        <div>
                          <span className="text-[10px] text-slate-400 block font-medium">Prowizja</span>
                          <span className="font-mono text-slate-500">
                            {tx.commission > 0 ? formatCurrency(tx.commission, tx.commissionCurrency) : '0,00'}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Card Footer */}
                    <div className="pt-2.5 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between text-xs">
                      <div className="flex items-center gap-1 text-[11px] text-slate-500">
                        <Building2 className="w-3 h-3 text-slate-400" />
                        <span>{acc?.name || tx.accountId}</span>
                      </div>
                      <div className="text-right">
                        <span className="text-[10px] text-slate-400 mr-1">Wartość:</span>
                        <strong className="font-mono font-bold text-slate-900 dark:text-white">
                          {formatCurrency(totalVal, tx.currency)}
                        </strong>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {pokazWiecej && <div className="text-center">{pokazWiecej}</div>}
        </div>
      )}

      {/* Transactions Table View */}
      {viewMode === 'TABLE' && (
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm hover:shadow-md transition-all duration-300 overflow-hidden">
          {filteredTransactions.length === 0 ? (
            // Poza przewijana tabela: w szerokiej tabeli na telefonie komunikat
            // byl wysrodkowany poza ekranem.
            <div className="py-12 px-4 text-center text-xs text-slate-400">
              Brak transakcji spełniających wybrane kryteria filtrowania.
            </div>
          ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead className="bg-slate-50 dark:bg-slate-800/80 text-slate-500 dark:text-slate-400 font-semibold border-b border-slate-200 dark:border-slate-800">
                <tr>
                  <th className="py-3 px-4">{t.colDate}</th>
                  <th className="py-3 px-4">{t.colAsset}</th>
                  <th className="py-3 px-4">Konto Maklerskie</th>
                  <th className="py-3 px-4">{t.colType}</th>
                  <th className="py-3 px-4 text-right">{t.colQty}</th>
                  <th className="py-3 px-4 text-right">{t.colPrice}</th>
                  <th className="py-3 px-4 text-right">{t.colCommission}</th>
                  <th className="py-3 px-4 text-right">{t.colTotalVal}</th>
                  <th className="py-3 px-4 text-center">{t.colActions}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {widoczneTransakcje.map((tx) => {
                    const acc = accounts.find((a) => a.id === tx.accountId);
                    const totalVal = tx.quantity * tx.pricePerUnit;

                    return (
                      <tr
                        key={tx.id}
                        className="hover:bg-slate-50/90 dark:hover:bg-slate-800/60 hover:scale-[1.004] transition-all duration-150 origin-left"
                      >
                        <td className="py-3 px-4 font-mono text-slate-700 dark:text-slate-300">
                          {formatPolishDate(tx.date)}
                        </td>
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-slate-900 dark:text-white">{tx.ticker}</span>
                            {getCategoryBadge(tx.category)}
                          </div>
                          <div className="text-[11px] text-slate-500 truncate max-w-[160px]">{tx.name}</div>
                        </td>
                        <td className="py-3 px-4 text-slate-700 dark:text-slate-300">
                          <div className="font-medium">{acc?.name || tx.accountId}</div>
                          <div className="text-[10px] text-slate-400 font-mono">{acc?.brokerType}</div>
                        </td>
                        <td className="py-3 px-4">{getTypeBadge(tx.type)}</td>
                        <td className="py-3 px-4 text-right font-mono font-medium text-slate-800 dark:text-slate-200">
                          {tx.quantity}
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-slate-700 dark:text-slate-300">
                          {formatCurrency(tx.pricePerUnit, tx.currency)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-slate-500">
                          {tx.commission > 0 ? formatCurrency(tx.commission, tx.commissionCurrency) : '0,00'}
                        </td>
                        <td className="py-3 px-4 text-right font-mono font-bold text-slate-900 dark:text-white">
                          {formatCurrency(totalVal, tx.currency)}
                        </td>
                        <td className="py-3 px-4 text-center">
                          {tx.tylkoOdczyt && (
                            <span
                              className="text-[10px] font-semibold text-slate-400"
                              title="Wiersz z dokumentu brokera. Korekty wprowadza się w zakładce „Dokumenty i silnik” → Historia transakcji."
                            >
                              z dokumentów
                            </span>
                          )}
                          <div className={tx.tylkoOdczyt ? 'hidden' : 'flex items-center justify-center gap-1.5'}>
                            <button
                              onClick={() => onEditTransaction(tx)}
                              className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
                              title="Edytuj"
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => onDeleteTransaction(tx.id)}
                              className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
                              title="Usuń"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
          )}
          {pokazWiecej && (
            <div className="py-4 text-center border-t border-slate-100 dark:border-slate-800">{pokazWiecej}</div>
          )}
        </div>
      )}
    </div>
  );
};
