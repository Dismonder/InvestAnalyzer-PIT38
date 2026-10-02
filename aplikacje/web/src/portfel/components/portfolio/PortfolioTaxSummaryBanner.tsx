import React from 'react';
import { Calculator, ExternalLink } from 'lucide-react';
import { formatCurrency } from '../../services/nbpService';

export function PortfolioTaxSummaryBanner({ currentYearSummary, availableTaxYears, onSelectYear, onNavigateToTab }: any) {
  return (
    <>
      {/* Tax Shortcut Notification Card */}
      {currentYearSummary && (
        <div className="px-3.5 py-2.5 sm:px-4 sm:py-3 rounded-xl bg-gradient-to-r from-blue-50/80 via-indigo-50/30 to-white dark:from-slate-900 dark:via-blue-950/20 dark:to-slate-900 border border-blue-200/70 dark:border-blue-800/50 shadow-2xs hover:shadow-md hover:border-blue-300 dark:hover:border-blue-700/60 transition-colors duration-200 flex flex-col md:flex-row items-start md:items-center justify-between gap-2.5 md:gap-4">
          <div className="flex items-center gap-3 min-w-0 flex-1 flex-wrap sm:flex-nowrap">
            <div className="p-2 rounded-lg bg-gradient-to-br from-blue-600 to-indigo-600 text-white shadow-2xs shrink-0">
              <Calculator className="w-4 h-4" />
            </div>
            <div className="flex items-center gap-x-3 gap-y-1 min-w-0 flex-wrap">
              <div className="flex items-center gap-1.5">
                <span className="font-bold text-xs sm:text-sm text-slate-900 dark:text-white whitespace-nowrap">
                  PIT-38
                </span>
                {availableTaxYears.length > 1 && onSelectYear ? (
                  <select
                    value={currentYearSummary.year}
                    onChange={(e) => onSelectYear(Number(e.target.value))}
                    className="bg-blue-100/80 dark:bg-blue-900/60 text-blue-800 dark:text-blue-200 text-xs font-bold font-mono px-2 py-0.5 rounded-md border-0 focus:ring-1 focus:ring-blue-500 cursor-pointer outline-none"
                    aria-label="Wybierz rok podatkowy"
                  >
                    {availableTaxYears.map((yr) => (
                      <option key={yr} value={yr} className="bg-white dark:bg-slate-900 text-slate-900 dark:text-white">
                        {yr}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="font-bold text-xs sm:text-sm text-slate-900 dark:text-white whitespace-nowrap">
                    ({currentYearSummary.year})
                  </span>
                )}
              </div>
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 font-mono shrink-0">
                {currentYearSummary.transactionCount} poz.
              </span>
              <div className="flex items-center gap-3 text-xs text-slate-600 dark:text-slate-300 flex-wrap">
                <div className="flex items-center gap-1.5">
                  <span className="text-slate-400 text-[11px]">Dochód:</span>
                  <strong
                    className={`font-mono font-bold text-xs ${
                      currentYearSummary.nieobliczony
                        ? 'text-slate-400'
                        : currentYearSummary.incomePLN >= 0
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-rose-600 dark:text-rose-400'
                    }`}
                  >
                    {currentYearSummary.nieobliczony
                      ? '—'
                      : `${currentYearSummary.incomePLN >= 0 ? '+' : ''}${formatCurrency(currentYearSummary.incomePLN, 'PLN')}`}
                  </strong>
                </div>
                <span className="text-slate-300 dark:text-slate-700 hidden sm:inline">•</span>
                <div className="flex items-center gap-1.5">
                  <span className="text-slate-400 text-[11px]">Podatek (19%):</span>
                  <strong
                    className={`font-mono font-bold text-xs ${
                      currentYearSummary.nieobliczony ? 'text-slate-400' : 'text-slate-900 dark:text-white'
                    }`}
                    title={
                      currentYearSummary.nieobliczony
                        ? 'Silnik nie policzył jeszcze tego roku — to nie znaczy, że podatek wynosi zero.'
                        : undefined
                    }
                  >
                    {currentYearSummary.nieobliczony
                      ? 'nie policzono'
                      : formatCurrency(currentYearSummary.totalTaxToPayPLN, 'PLN')}
                  </strong>
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0 self-end md:self-center">
            <button
              onClick={() => onNavigateToTab('tax')}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold transition-all shadow-2xs cursor-pointer whitespace-nowrap"
            >
              <span>Raport PIT-38</span>
              <ExternalLink className="w-3 h-3" />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
