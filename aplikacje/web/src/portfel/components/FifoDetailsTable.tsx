import React, { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { odmienLiczebnik } from '../services/odmianaLiczebnika';
import {
  TaxRealizedGain,
  BrokerAccount,
  Language,
} from '../types';
import { getTranslation } from '../i18n/translations';
import { formatCurrency, formatPolishDate, formatLiczba } from '../services/nbpService';
import { Search, ChevronDown, ChevronUp, CheckCircle2, AlertTriangle, ArrowRight } from 'lucide-react';

interface FifoDetailsTableProps {
  realizedGains: TaxRealizedGain[];
  selectedYear: number;
  accounts: BrokerAccount[];
  language: Language;
  onClose?: () => void;
}

/** Ile kart sprzedazy renderowac naraz; kolejne porcje na zadanie. */
const PORCJA_KART = 100;

export const FifoDetailsTable: React.FC<FifoDetailsTableProps> = ({
  realizedGains,
  selectedYear,
  accounts,
  language,
}) => {
  const t = getTranslation(language);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedGainId, setExpandedGainId] = useState<string | null>(null);

  // Filtr przelicza sie w tle, a widok renderuje karty porcjami - przy
  // setkach sprzedazy w roku kazdy znak w polu filtra przebudowywal cala liste.
  const odroczoneZapytanie = useDeferredValue(searchQuery);
  const filteredGains = useMemo(() => {
    const zapytanie = odroczoneZapytanie.toLowerCase();
    return realizedGains.filter(
      (g) =>
        g.taxYear === selectedYear &&
        (g.ticker.toLowerCase().includes(zapytanie) || g.name.toLowerCase().includes(zapytanie))
    );
  }, [realizedGains, selectedYear, odroczoneZapytanie]);
  const [limitKart, setLimitKart] = useState(PORCJA_KART);
  useEffect(() => setLimitKart(PORCJA_KART), [filteredGains]);
  const widoczneGains = useMemo(() => filteredGains.slice(0, limitKart), [filteredGains, limitKart]);

  const toggleExpand = (id: string) => {
    setExpandedGainId(expandedGainId === id ? null : id);
  };

  return (
    <div id="fifo-details-container" className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 sm:p-6 shadow-sm space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-200 dark:border-slate-800">
        <div>
          <h2 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <span>Rejestr Rozliczeń FIFO - Rok {selectedYear}</span>
            <span className="text-xs px-2.5 py-0.5 rounded-full bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-300 font-semibold">
              {filteredGains.length} {odmienLiczebnik(filteredGains.length, 'transakcja', 'transakcje', 'transakcji')} zbycia
            </span>
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Szczegółowe dopasowanie partii kupna (FIFO), kursów NBP T-1 i prowizji dla każdej sprzedaży
          </p>
        </div>

        {/* Search Input */}
        <div className="relative w-full sm:w-64">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Filtruj ticker..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 text-xs rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      {filteredGains.length === 0 ? (
        <div className="text-center py-10 text-slate-400 text-xs">
          Brak transakcji sprzedaży dla roku {selectedYear} spełniających kryteria.
        </div>
      ) : (
        <div className="space-y-3">
          {widoczneGains.map((gain) => {
            const acc = accounts.find((a) => a.id === gain.accountId);
            const isExpanded = expandedGainId === gain.id;
            const isProfit = gain.profitPLN >= 0;

            return (
              <div
                key={gain.id}
                className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 overflow-hidden transition-all"
              >
                {/* Header Row */}
                <div
                  role="button"
                  tabIndex={0}
                  aria-expanded={isExpanded}
                  onClick={() => toggleExpand(gain.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      toggleExpand(gain.id);
                    }
                  }}
                  className="p-4 flex flex-col md:flex-row md:items-center justify-between gap-3 cursor-pointer hover:bg-slate-100/70 dark:hover:bg-slate-800/70 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-blue-100 dark:bg-blue-950/60 flex items-center justify-center font-bold text-xs text-blue-700 dark:text-blue-300 shrink-0">
                      {gain.ticker}
                    </div>
                    <div>
                      <div className="font-bold text-sm text-slate-900 dark:text-white flex items-center gap-2">
                        <span>{gain.name}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300">
                          {acc?.name || 'Główne'}
                        </span>
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-2 mt-0.5">
                        <span>Sprzedaż: {formatPolishDate(gain.sellDate)}</span>
                        <span>•</span>
                        <span>
                          {gain.sellQuantity} szt. @ {gain.sellPricePerUnit} {gain.sellCurrency}
                        </span>
                        <span>•</span>
                        <span className="text-blue-600 dark:text-blue-400 font-mono">
                          NBP: {formatLiczba(gain.sellExchangeRate, 4)} PLN ({gain.sellExchangeDate})
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Financial figures */}
                  <div className="flex items-center justify-between md:justify-end gap-6 text-xs">
                    <div>
                      <div className="text-[10px] text-slate-400">Przychód (PLN)</div>
                      <div className="font-mono font-semibold text-slate-800 dark:text-slate-200">
                        {formatCurrency(gain.revenuePLN)}
                      </div>
                    </div>

                    <div>
                      <div className="text-[10px] text-slate-400">Koszt KUP (PLN)</div>
                      <div className="font-mono font-semibold text-slate-800 dark:text-slate-200">
                        {formatCurrency(gain.costPLN)}
                      </div>
                    </div>

                    <div className="text-right">
                      <div className="text-[10px] text-slate-400">Zysk / Strata</div>
                      <div
                        className={`font-mono font-bold text-sm ${
                          isProfit ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'
                        }`}
                      >
                        {isProfit ? '+' : ''}
                        {formatCurrency(gain.profitPLN)}
                      </div>
                    </div>

                    <div className="text-slate-400">
                      {isExpanded ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
                    </div>
                  </div>
                </div>

                {/* Expanded FIFO Matched Buy Lots Schedule */}
                {isExpanded && (
                  <div className="p-4 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 text-xs space-y-3">
                    <div className="font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                      <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                      <span>Dopasowane partie zakupu metodą FIFO dla tej sprzedaży:</span>
                    </div>

                    {gain.matchedBuyLots.length === 0 ? (
                      <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300 flex items-center gap-2">
                        <AlertTriangle className="w-4 h-4 shrink-0" />
                        <span>Uwaga: Brak wcześniejszego zapisu kupna dla tego wolumenu (możliwe otwarcie pozycji przed okresem rozliczenia).</span>
                      </div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead className="bg-slate-50 dark:bg-slate-800/80 text-slate-500 dark:text-slate-400 text-left">
                            <tr>
                              <th className="p-2">Data Zakupu</th>
                              <th className="p-2">Użyty Wolumen</th>
                              <th className="p-2">Cena Zakupu</th>
                              <th className="p-2">Kurs NBP (T-1)</th>
                              <th className="p-2 text-right">Koszt Akcji (PLN)</th>
                              <th className="p-2 text-right">Prowizja (PLN)</th>
                              <th className="p-2 text-right">Łączny Koszt KUP (PLN)</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                            {gain.matchedBuyLots.map((lot, lIdx) => (
                              <tr key={lIdx} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                                <td className="p-2 font-mono">{formatPolishDate(lot.buyDate)}</td>
                                <td className="p-2 font-bold">{lot.buyQuantity} szt.</td>
                                <td className="p-2">
                                  {lot.buyPricePerUnit} {lot.buyCurrency}
                                </td>
                                <td className="p-2 font-mono text-blue-600 dark:text-blue-400">
                                  {formatLiczba(lot.buyExchangeRate, 4)} ({lot.buyExchangeDate})
                                </td>
                                <td className="p-2 text-right font-mono">{formatCurrency(lot.buyCostPLN)}</td>
                                <td className="p-2 text-right font-mono text-slate-400">{formatCurrency(lot.buyCommissionPLN)}</td>
                                <td className="p-2 text-right font-mono font-bold text-slate-800 dark:text-slate-200">
                                  {formatCurrency(lot.totalCostPLN)}
                                </td>
                              </tr>
                            ))}
                            {/* Sell commission row */}
                            {gain.sellCommissionPLN > 0 && (
                              <tr className="bg-slate-50/50 dark:bg-slate-800/20 text-slate-500">
                                <td colSpan={5} className="p-2 italic">
                                  Prowizja maklerska od sprzedaży (zwiększa koszty KUP)
                                </td>
                                <td className="p-2 text-right font-mono text-slate-400">
                                  {formatCurrency(gain.sellCommissionPLN)}
                                </td>
                                <td className="p-2 text-right font-mono font-semibold">
                                  {formatCurrency(gain.sellCommissionPLN)}
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {filteredGains.length > limitKart && (
            <div className="text-center">
              <button
                type="button"
                onClick={() => setLimitKart((obecny) => obecny + PORCJA_KART)}
                className="rounded-lg border border-slate-200 dark:border-slate-700 px-4 py-2 text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
              >
                Pokaż kolejne sprzedaże ({widoczneGains.length} z {filteredGains.length})
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
