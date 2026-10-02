import React from 'react';
import { Wallet, TrendingUp, TrendingDown, DollarSign, Activity, ShieldCheck } from 'lucide-react';
import { formatCurrency, formatLiczba } from '../../services/nbpService';

export function PortfolioKpiCards({ totalValuePLN, liczbaBezWyceny, komunikatBrakow, sumaUSD, sumaEUR, wynikZnany, wynikNaPlus, totalUnrealizedPLN, totalUnrealizedPct, totalCostBasisPLN, danePozycjiNieznane, zmianaZnana, zmianaNaPlus, totalDailyChangePLN, totalDailyChangePct, liczbaZeZnanaZmiana, liczbaWycenionychPozycji, klasaWyniku }: any) {
  return (
    <>
      {/* Main KPI Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {/* Total Value */}
        <div className="min-w-0 p-4 sm:p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm hover:shadow-md hover:border-slate-300 dark:hover:border-slate-700 transition-colors duration-200 relative overflow-hidden group">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
              Wartość Całkowita Portfela
            </span>
            <div className="shrink-0 p-2 rounded-xl bg-blue-50 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400">
              <Wallet className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-3 min-w-0 break-words font-mono font-bold text-xl sm:text-2xl leading-tight tracking-tight tabular-nums text-slate-900 dark:text-white">
            {/* Zero znaczy "portfel wart zero". Gdy zadna pozycja nie ma
                notowania, prawdziwa odpowiedz brzmi "nie wiem". */}
            {totalValuePLN === null || totalValuePLN === undefined
              ? '—'
              : formatCurrency(totalValuePLN, 'PLN')}
          </div>
          {liczbaBezWyceny > 0 && (
            // Suma pomija pozycje bez kursu NBP. Milczenie o tym zanizaloby
            // wartosc portfela bez zadnego sladu na ekranie.
            <div className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">{komunikatBrakow}</div>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
            {/* Bez wyceny nie ma czego przeliczac: "≈ $0 USD" znaczyloby portfel wart zero. */}
            <span>≈ {sumaUSD === null ? '— USD' : formatCurrency(sumaUSD, 'USD', 0)}</span>
            <span>•</span>
            <span>≈ {sumaEUR === null ? '— EUR' : formatCurrency(sumaEUR, 'EUR', 0)}</span>
          </div>
        </div>

        {/* Unrealized Profit/Loss */}
        <div className="min-w-0 p-4 sm:p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm hover:shadow-md hover:border-slate-300 dark:hover:border-slate-700 transition-colors duration-200 group">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
              Niezrealizowany Wynik (P&L)
            </span>
            <div
              className={`shrink-0 p-2 rounded-xl ${klasaWyniku(
                wynikZnany,
                wynikNaPlus,
                'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-600 dark:text-emerald-400',
                'bg-rose-50 dark:bg-rose-950/50 text-rose-600 dark:text-rose-400',
                'bg-slate-100 dark:bg-slate-800 text-slate-500'
              )}`}
            >
              {!wynikZnany || wynikNaPlus ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
            </div>
          </div>
          <div
            className={`mt-3 min-w-0 break-words font-mono font-bold text-xl sm:text-2xl leading-tight tracking-tight tabular-nums flex items-center gap-2 ${klasaWyniku(
              wynikZnany,
              wynikNaPlus,
              'text-emerald-600 dark:text-emerald-400',
              'text-rose-600 dark:text-rose-400',
              'text-slate-500 dark:text-slate-400'
            )}`}
          >
            <span className="min-w-0 break-words">
              {!wynikZnany
                ? '—'
                : `${wynikNaPlus ? '+' : ''}${formatCurrency(totalUnrealizedPLN as number, 'PLN')}`}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span
              className={`text-xs font-bold font-mono px-2 py-0.5 rounded-md whitespace-nowrap ${klasaWyniku(
                wynikZnany,
                wynikNaPlus,
                'bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300',
                'bg-rose-100 dark:bg-rose-950 text-rose-700 dark:text-rose-300',
                'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400'
              )}`}
            >
              {totalUnrealizedPct === null || totalUnrealizedPct === undefined
                ? 'brak danych o zmianie'
                : `${totalUnrealizedPct >= 0 ? '+' : ''}${formatLiczba(totalUnrealizedPct)}% zwrotu`}
            </span>
            <span className="text-[11px] text-slate-500">z kapitału bazowego</span>
          </div>
        </div>

        {/* Cost Basis (KUP) */}
        <div className="min-w-0 p-4 sm:p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm hover:shadow-md hover:border-slate-300 dark:hover:border-slate-700 transition-colors duration-200 group">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
              Zainwestowany Kapitał (KUP)
            </span>
            <div className="shrink-0 p-2 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
              <DollarSign className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-3 min-w-0 break-words font-mono font-bold text-xl sm:text-2xl leading-tight tracking-tight tabular-nums text-slate-900 dark:text-white">
            {danePozycjiNieznane ? '—' : formatCurrency(totalCostBasisPLN, 'PLN')}
          </div>
          <div className="mt-2 flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
            <ShieldCheck className="w-3.5 h-3.5 text-blue-500" />
            <span>Wg kursów NBP T-1 + prowizje</span>
          </div>
        </div>

        {/* Daily 24h Change */}
        <div className="min-w-0 p-4 sm:p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm hover:shadow-md hover:border-slate-300 dark:hover:border-slate-700 transition-colors duration-200 group">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
              Dzienna Zmiana (24h)
            </span>
            <div
              className={`shrink-0 p-2 rounded-xl ${klasaWyniku(
                zmianaZnana,
                zmianaNaPlus,
                'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-600 dark:text-emerald-400',
                'bg-rose-50 dark:bg-rose-950/50 text-rose-600 dark:text-rose-400',
                'bg-slate-100 dark:bg-slate-800 text-slate-500'
              )}`}
            >
              <Activity className="w-4 h-4" />
            </div>
          </div>
          <div
            className={`mt-3 min-w-0 break-words font-mono font-bold text-xl sm:text-2xl leading-tight tracking-tight tabular-nums ${klasaWyniku(
              zmianaZnana,
              zmianaNaPlus,
              'text-emerald-600 dark:text-emerald-400',
              'text-rose-600 dark:text-rose-400',
              'text-slate-500 dark:text-slate-400'
            )}`}
          >
            {!zmianaZnana
              ? '—'
              : `${zmianaNaPlus ? '+' : ''}${formatCurrency(totalDailyChangePLN as number, 'PLN')}`}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span
              className={`text-xs font-bold font-mono px-2 py-0.5 rounded-md whitespace-nowrap ${klasaWyniku(
                zmianaZnana,
                zmianaNaPlus,
                'bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300',
                'bg-rose-100 dark:bg-rose-950 text-rose-700 dark:text-rose-300',
                'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400'
              )}`}
            >
              {totalDailyChangePct === null || totalDailyChangePct === undefined
                ? 'brak wyceny'
                : `${totalDailyChangePct >= 0 ? '+' : ''}${formatLiczba(totalDailyChangePct)}% dzisiaj`}
            </span>
            {/* "Live feed" nad brakiem wyceny mowilo, ze liczba jest swieza. */}
            <span className="text-[11px] text-slate-500">{zmianaZnana ? liczbaZeZnanaZmiana < liczbaWycenionychPozycji ? `Zmiana dla ${liczbaZeZnanaZmiana} z ${liczbaWycenionychPozycji} pozycji` : 'Live feed' : 'brak danych o zmianie'}</span>
          </div>
        </div>
      </div>
    </>
  );
}
