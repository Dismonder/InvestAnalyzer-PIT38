import React from 'react';
import { odmienLiczebnik } from '../../services/odmianaLiczebnika';
import { DollarSign, Percent, TrendingUp, TrendingDown, Scale, ShieldCheck, Calculator, Copy, Check } from 'lucide-react';
import type { TaxYearSummary } from '../../types';

/**
 * Wyglad karty wyniku. Rok bez wyniku silnika i rok bez dochodu ani straty nie sa strata:
 * czerwona karta "Strata (poz. 29)" z kreska pokazywala sie przy kazdym wejsciu, zanim
 * silnik skonczyl liczyc, a rok z samymi dywidendami wygladal jak rok ze strata.
 */
const WYGLAD_WYNIKU = {
  dochod: {
    karta: 'bg-emerald-50/40 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800/60',
    ikona: 'bg-emerald-100 dark:bg-emerald-900/60 text-emerald-600 dark:text-emerald-400',
    kwota: 'text-emerald-700 dark:text-emerald-400',
    tytul: 'Dochód (poz. 28)',
    opis: 'Dochód przed odliczeniem strat z lat ubiegłych',
    pozycja: 'poz. 28',
    kopiuj: 'Kopiuj Dochód',
  },
  strata: {
    karta: 'bg-rose-50/40 dark:bg-rose-950/20 border-rose-200 dark:border-rose-800/60',
    ikona: 'bg-rose-100 dark:bg-rose-900/60 text-rose-600 dark:text-rose-400',
    kwota: 'text-rose-700 dark:text-rose-400',
    tytul: 'Strata (poz. 29)',
    opis: 'Możliwość odliczenia w 5 latach',
    pozycja: 'poz. 29',
    kopiuj: 'Kopiuj Stratę',
  },
  neutralny: {
    karta: 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800',
    ikona: 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400',
    kwota: 'text-slate-900 dark:text-white',
    tytul: 'Dochód / strata (poz. 28 / 29)',
    opis: 'Bez dochodu i bez straty ze zbycia',
    pozycja: 'poz. 28 / 29',
    kopiuj: 'Kopiuj wynik',
  },
} as const;

interface TaxKpiCardsProps {
  resultStale?: boolean;
  currentSummary: TaxYearSummary;
  transactionCount: number;
  kwota: (value: number | null | undefined) => string;
  copiedField: string | null;
  handleCopy: (fieldKey: string, value: number) => void;
  /** Powod blokady kopiowania pol deklaracji (rozliczenie niegotowe); brak = kopiowanie dozwolone. */
  kopiowanieZablokowane?: string;
  onOpenLossCalc: () => void;
}

export const TaxKpiCards: React.FC<TaxKpiCardsProps> = ({
  resultStale = false,
  currentSummary,
  transactionCount,
  kwota,
  copiedField,
  handleCopy,
  kopiowanieZablokowane,
  onOpenLossCalc,
}) => {
  const brakWyniku = Boolean(currentSummary.nieobliczony);
  const jestDochod = !brakWyniku && currentSummary.incomePLN > 0;
  const jestStrata = !brakWyniku && !jestDochod && currentSummary.lossPLN > 0;
  const wynik = WYGLAD_WYNIKU[jestDochod ? 'dochod' : jestStrata ? 'strata' : 'neutralny'];
  const poleWyniku = jestDochod ? 'poz28' : 'poz29';
  const kwotaWyniku = jestDochod ? currentSummary.incomePLN : currentSummary.lossPLN;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
      {/* Przychód */}
      <div id="card-revenue" className="min-w-0 p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xs flex flex-col justify-between">
        <div>
          <div className="flex items-center justify-between text-slate-500 dark:text-slate-400 text-xs font-medium">
            <span className="font-semibold">Przychód razem (poz. 26)</span>
            <span className="p-1.5 rounded-lg bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400">
              <DollarSign className="w-4 h-4" />
            </span>
          </div>
          <div className="mt-3 text-2xl leading-tight tracking-tight tabular-nums [overflow-wrap:anywhere] font-bold text-slate-900 dark:text-white font-mono">
            {kwota(currentSummary.revenuePLN)}
          </div>
          <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
            Sprzedaż akcji, ETF, obligacji, krypto
          </div>
        </div>
        <div className="mt-3 pt-2.5 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between">
          <span className="text-[10px] text-slate-400 font-mono">{transactionCount} {odmienLiczebnik(transactionCount, 'transakcja', 'transakcje', 'transakcji')}</span>
          <button
            onClick={() => handleCopy('poz26', currentSummary.revenuePLN)}
            disabled={Boolean(kopiowanieZablokowane)}
            title={kopiowanieZablokowane}
            className="flex items-center gap-1 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
          >
            {copiedField === 'poz26' ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-500" />
                <span className="text-emerald-500 font-bold">Skopiowano!</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                <span>Kopiuj poz. 26</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Koszty KUP */}
      <div id="card-costs" className="min-w-0 p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xs flex flex-col justify-between">
        <div>
          <div className="flex items-center justify-between text-slate-500 dark:text-slate-400 text-xs font-medium">
            <span className="font-semibold">Koszty razem (poz. 27)</span>
            <span className="p-1.5 rounded-lg bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400">
              <Percent className="w-4 h-4" />
            </span>
          </div>
          <div className="mt-3 text-2xl leading-tight tracking-tight tabular-nums [overflow-wrap:anywhere] font-bold text-slate-900 dark:text-white font-mono">
            {kwota(currentSummary.costsPLN)}
          </div>
          <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
            Nabycie metodą FIFO + prowizje brokerskie
          </div>
        </div>
        <div className="mt-3 pt-2.5 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between">
          <span className="text-[10px] text-slate-400 font-mono">Kursy NBP T-1</span>
          <button
            onClick={() => handleCopy('poz27', currentSummary.costsPLN)}
            disabled={Boolean(kopiowanieZablokowane)}
            title={kopiowanieZablokowane}
            className="flex items-center gap-1 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
          >
            {copiedField === 'poz27' ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-500" />
                <span className="text-emerald-500 font-bold">Skopiowano!</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                <span>Kopiuj poz. 27</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Wynik: Dochód / Strata */}
      <div
        id="card-income-loss"
        className={`min-w-0 p-5 rounded-2xl border shadow-xs flex flex-col justify-between ${wynik.karta}`}
      >
        <div>
          <div className="flex items-center justify-between text-xs font-medium text-slate-600 dark:text-slate-300">
            <span className="font-semibold">{wynik.tytul}</span>
            <span className={`p-1.5 rounded-lg ${wynik.ikona}`}>
              {jestDochod ? <TrendingUp className="w-4 h-4" /> : jestStrata ? <TrendingDown className="w-4 h-4" /> : <Scale className="w-4 h-4" />}
            </span>
          </div>
          <div className={`mt-3 text-2xl leading-tight tracking-tight tabular-nums [overflow-wrap:anywhere] font-bold font-mono ${wynik.kwota}`}>
            {kwota(kwotaWyniku)}
          </div>
          <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
            {brakWyniku ? 'Wynik pojawi się po przeliczeniu rozliczenia' : wynik.opis}
          </div>
        </div>
        <div className="mt-3 pt-2.5 border-t border-slate-200/60 dark:border-slate-800/60 flex items-center justify-between">
          <span className="text-[10px] text-slate-400 font-mono">{wynik.pozycja}</span>
          <button
            onClick={() => handleCopy(poleWyniku, kwotaWyniku)}
            disabled={Boolean(kopiowanieZablokowane) || brakWyniku}
            title={kopiowanieZablokowane}
            className="flex items-center gap-1 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
          >
            {copiedField === poleWyniku ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-500" />
                <span className="text-emerald-500 font-bold">Skopiowano!</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                <span>{wynik.kopiuj}</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Łączny Podatek do Zapłaty */}
      <div
        id="card-tax-due"
        className="min-w-0 p-5 rounded-2xl bg-gradient-to-br from-blue-50 via-indigo-50 to-white dark:from-blue-950 dark:via-indigo-950 dark:to-slate-900 text-slate-900 dark:text-white shadow-xs border border-blue-200 dark:border-blue-800/80 flex flex-col justify-between"
      >
        <div>
          <div className="flex items-center justify-between text-blue-800 dark:text-blue-200 text-xs font-medium">
            <span className="font-semibold">Łączny Podatek PIT-38</span>
            <span className="p-1.5 rounded-lg bg-blue-100 dark:bg-blue-800/70 text-blue-700 dark:text-blue-200">
              <ShieldCheck className="w-4 h-4" />
            </span>
          </div>
          <div className="mt-3 text-2xl leading-tight tracking-tight tabular-nums [overflow-wrap:anywhere] font-bold text-blue-900 dark:text-blue-100 font-mono">
            {kwota(currentSummary.totalTaxToPayPLN)}
          </div>
          {resultStale && <div role="status" className="mt-1 text-xs font-bold text-amber-800 dark:text-amber-300">NIEAKTUALNE — przelicz ponownie</div>}
          <div className="mt-1 text-[11px] text-blue-800 dark:text-blue-200 leading-relaxed">
            Kapitały: <strong>{kwota(currentSummary.taxDuePLN)}</strong> • Dywidendy: <strong>{kwota(currentSummary.dividendTaxToPayPLN)}</strong>
          </div>
        </div>
        <div className="mt-3 pt-2.5 border-t border-blue-200 dark:border-blue-800/80 flex flex-wrap gap-2 items-center justify-between">
          <button
            onClick={() => onOpenLossCalc()}
            className="text-[11px] text-blue-700 dark:text-blue-300 hover:text-blue-900 dark:hover:text-white underline cursor-pointer flex items-center gap-1"
          >
            <Calculator className="w-3 h-3" />
            <span>Odlicz stratę</span>
          </button>
          <button
            onClick={() => handleCopy('totalTax', currentSummary.totalTaxToPayPLN)}
            disabled={Boolean(kopiowanieZablokowane)}
            title={kopiowanieZablokowane}
            className="flex items-center gap-1 text-xs font-bold text-blue-700 dark:text-blue-300 hover:text-blue-900 dark:hover:text-blue-200 cursor-pointer"
          >
            {copiedField === 'totalTax' ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-300" />
                <span>Skopiowano!</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                <span>Kopiuj Podatek</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
