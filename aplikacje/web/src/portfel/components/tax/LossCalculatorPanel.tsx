import React from 'react';
import type { TaxYearSummary } from '../../types';

interface LossCalculatorPanelProps {
  selectedYear: number;
  priorYearsLoss: number;
  setPriorYearsLoss: (value: number) => void;
  maxDeductibleLoss: number;
  adjustedTotalTaxPLN: number;
  kwota: (value: number | null | undefined) => string;
}

export const LossCalculatorPanel: React.FC<LossCalculatorPanelProps> = ({
  selectedYear,
  priorYearsLoss,
  setPriorYearsLoss,
  maxDeductibleLoss,
  adjustedTotalTaxPLN,
  kwota,
}) => (
    <div className="bg-white dark:bg-slate-900 p-5 sm:p-6 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs space-y-4 animate-in fade-in duration-150">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-slate-100 dark:border-slate-800 gap-2">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base sm:text-lg font-bold text-slate-900 dark:text-white">
              Kalkulator Odliczenia Straty z Lat Ubiegłych
            </h2>
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400 font-semibold font-mono">
              Art. 9 ust. 3-3a ustawy o PIT
            </span>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Możesz obniżyć tegoroczny dochód o nie więcej niż 50% straty z danego roku — albo jednorazowo, w jednym z 5 kolejnych lat, o kwotę do 5 mln zł
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-end pt-2">
        <div>
          <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
            Suma nierozliczonych strat z lat {selectedYear - 5}–{selectedYear - 1} (PLN):
          </label>
          <input
            aria-label={`Suma nierozliczonych strat z lat ${selectedYear - 5}–${selectedYear - 1} (PLN)`}
            type="number"
            min="0"
            step="100"
            value={priorYearsLoss || ''}
            onChange={(e) => setPriorYearsLoss(Math.max(0, parseFloat(e.target.value) || 0))}
            placeholder="np. 10000"
            className="w-full px-3.5 py-2.5 text-sm rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white font-mono focus:ring-2 focus:ring-blue-500 focus:outline-none"
          />
        </div>
        <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/70 text-xs space-y-1">
          <div className="text-slate-500 dark:text-slate-400">Maksymalne odliczenie w roku {selectedYear} (do wysokości dochodu):</div>
          <div className="text-lg font-bold text-emerald-600 dark:text-emerald-400 font-mono">
            - {kwota(maxDeductibleLoss)}
          </div>
        </div>
        <div className="p-3.5 rounded-xl bg-blue-50 dark:bg-blue-950/60 border border-blue-200 dark:border-blue-800 text-xs space-y-1">
          <div className="text-blue-600 dark:text-blue-300 font-semibold">Podatek po odliczeniu straty (podgląd):</div>
          <div className="text-lg font-bold text-blue-900 dark:text-white font-mono">
            {kwota(adjustedTotalTaxPLN)}
          </div>
        </div>
      </div>

      <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-200/80 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400 space-y-1">
        <div className="font-semibold text-slate-700 dark:text-slate-300">Ważne zasady podatkowe:</div>
        <div className="text-amber-700 dark:text-amber-300">
          • To wyliczenie jest podglądem i nie zmienia kwot na kartach rozliczenia. Stratę, która ma
          wejść do deklaracji, wpisz w panelu optymalizacji podatkowej — stamtąd trafia do silnika i
          zostaje odliczona w rachunku.
        </div>
        <div>• Stratę z kapitałów pieniężnych (PIT-38) można odliczać w najbliższych kolejno po sobie następujących 5 latach podatkowych.</div>
        <div>• Odliczenie zmniejsza podstawę opodatkowania — poz. 30 (część D) formularza PIT-38.</div>
      </div>
    </div>
);
