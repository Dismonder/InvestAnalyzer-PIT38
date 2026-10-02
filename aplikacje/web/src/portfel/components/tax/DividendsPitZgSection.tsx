import React from 'react';
import { formatCurrency, formatPolishDate, formatLiczba } from '../../services/nbpService';
import type { TaxYearSummary, DividendTaxItem, BrokerAccount } from '../../types';
import { etykietaRachunkuDywidendy } from '../../services/engineBridge';

interface DividendsPitZgSectionProps {
  currentSummary: TaxYearSummary;
  yearDividends: DividendTaxItem[];
  selectedYear: number;
  accounts: BrokerAccount[];
  kwota: (value: number | null | undefined) => string;
}

export const DividendsPitZgSection: React.FC<DividendsPitZgSectionProps> = ({
  currentSummary,
  yearDividends,
  selectedYear,
  accounts,
  kwota,
}) => (
    <div className="bg-white dark:bg-slate-900 p-5 sm:p-6 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs space-y-4 animate-in fade-in duration-150">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-slate-100 dark:border-slate-800 gap-2">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base sm:text-lg font-bold text-slate-900 dark:text-white">
              Dywidendy zagraniczne (część G PIT-38)
            </h2>
            <span className="text-xs px-2.5 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 font-semibold font-mono">
              {yearDividends.length} wypłat
            </span>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Rozliczenie zryczałtowanego podatku 19% z uwzględnieniem podatku potrąconego u źródła (np. USA WHT 15%)
          </p>
        </div>
      </div>

      {/* Dividend Summary Metric Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700/80">
          <span className="text-xs text-slate-500 dark:text-slate-400 font-medium">Przychód brutto (PLN):</span>
          <div className="text-lg font-bold text-slate-900 dark:text-white font-mono mt-1">
            {kwota(currentSummary.dividendGrossPLN)}
          </div>
          <span className="text-[10px] text-slate-400">Przeliczone kursem NBP T-1</span>
        </div>

        <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700/80">
          <span className="text-xs text-slate-500 dark:text-slate-400 font-medium">Podatek u źródła (np. 15%):</span>
          <div className="text-lg font-bold text-amber-600 dark:text-amber-400 font-mono mt-1">
            {kwota(currentSummary.dividendForeignTaxPLN)}
          </div>
          <span className="text-[10px] text-slate-400">Zapłacony za granicą</span>
        </div>

        <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700/80">
          <span className="text-xs text-slate-500 dark:text-slate-400 font-medium">Podatek w Polsce (19%):</span>
          <div className="text-lg font-bold text-slate-800 dark:text-slate-200 font-mono mt-1">
            {kwota(currentSummary.dividendPolishTaxDuePLN)}
          </div>
          <span className="text-[10px] text-slate-400">Stawka zryczałtowana</span>
        </div>

        <div className="p-4 rounded-xl bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800">
          <span className="text-xs text-blue-600 dark:text-blue-400 font-medium">Dopłata do podatku w PIT-38:</span>
          <div className="text-lg font-bold text-blue-700 dark:text-blue-300 font-mono mt-1">
            {kwota(currentSummary.dividendTaxToPayPLN)}
          </div>
          <span className="text-[10px] text-blue-500">Np. 4% różnicy (19% - 15%)</span>
        </div>
      </div>

      {/* List of individual dividends */}
      {/* Pusta lista dywidend znaczyla "brak wyplat" takze wtedy, gdy silnik
          roku jeszcze nie policzyl - tak samo jak przy rozbiciach brokerskich. */}
      {yearDividends.length === 0 ? (
        <div className="py-8 text-center text-xs text-slate-400">
          {currentSummary.nieobliczony
            ? `Rok ${selectedYear} nie został jeszcze policzony przez silnik — to nie znaczy, że nie było wypłat.`
            : `Brak zarejestrowanych dywidend w roku ${selectedYear}`}
        </div>
      ) : (
        <div className="overflow-x-auto mt-2">
          <table className="w-full text-xs text-left">
            <thead className="text-slate-500 dark:text-slate-400 border-b border-slate-100 dark:border-slate-800">
              <tr>
                <th className="py-2.5">Data wypłaty</th>
                <th className="py-2.5">Walor / Ticker</th>
                <th className="py-2.5">Konto Maklerskie</th>
                <th className="py-2.5 text-right">Kurs NBP (T-1)</th>
                <th className="py-2.5 text-right">Brutto (PLN)</th>
                <th className="py-2.5 text-right">Podatek Zagr.</th>
                <th className="py-2.5 text-right" title="Kwota dopłaty przepisana z wyniku silnika.">
                  Dopłata PIT
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {yearDividends.map((d) => {
                return (
                  <tr key={d.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td className="py-2.5 font-mono text-slate-600 dark:text-slate-300">{formatPolishDate(d.date)}</td>
                    <td className="py-2.5 font-bold text-slate-900 dark:text-white">
                      {d.ticker}
                      <span className="ml-1 text-[10px] text-slate-400 font-normal">{d.name}</span>
                    </td>
                    <td className="py-2.5 text-slate-600 dark:text-slate-400">{etykietaRachunkuDywidendy(d.accountId, accounts)}</td>
                    <td className="py-2.5 text-right font-mono text-slate-500">{formatLiczba(d.exchangeRate, 4)}</td>
                    <td className="py-2.5 text-right font-mono font-semibold text-slate-900 dark:text-white">{formatCurrency(d.grossPLN)}</td>
                    <td className="py-2.5 text-right font-mono text-amber-600 dark:text-amber-400">{formatCurrency(d.foreignTaxPLN)}</td>
                    <td className="py-2.5 text-right font-mono font-bold text-blue-600 dark:text-blue-400">{d.taxToPayInPolandPLN === undefined ? '–' : formatCurrency(d.taxToPayInPolandPLN)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
);
