import React, { useMemo } from 'react';
import { odmienLiczebnik } from '../../portfel/services/odmianaLiczebnika';
import { downsampleDailyBalancesForChart } from '../services/chartData';
import { buildDepositBalanceSeries, selectExternalCashMovements } from '../services/dashboardData';
import { XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area } from 'recharts';
import { format, parseISO } from 'date-fns';
import { ArrowDownRight, DollarSign, Activity, Loader2, AlertCircle } from 'lucide-react';
import { motion } from 'motion/react';
import type { TaxEngineResponse } from '../hooks/useTaxEngineRun';

interface DashboardProps {
  selectedYear: number;
  engineLoading: boolean;
  engineResult: TaxEngineResponse | null;
  /** Wynik sprzed zmiany wejscia: pokazywany z etykieta, zamiast zer na czas przeliczenia. */
  engineStale?: boolean;
}

export function Dashboard({
  selectedYear,
  engineLoading,
  engineResult,
  engineStale = false,
}: DashboardProps) {
  const depositBalances = useMemo(
    () => buildDepositBalanceSeries(engineResult?.transaction_history_rows, selectedYear),
    [engineResult?.transaction_history_rows, selectedYear],
  );
  const chartBalances = useMemo(() => downsampleDailyBalancesForChart(depositBalances), [depositBalances]);

  // Kafelek i wykres pod nim licza z tego samego zbioru wierszy. Wczesniej
  // kazde mialo wlasny filtr: kafelek pokazywal 62 721,59 zl, a wykres konczyl
  // sie na 34 986,57 zl - dwie rozne liczby o tych samych wplatach na jednym
  // ekranie. Kafelek sumuje wplaty, wykres pokazuje saldo po wyplatach.
  const externalCashMovements = useMemo(
    () => selectExternalCashMovements(engineResult?.transaction_history_rows, selectedYear),
    [engineResult?.transaction_history_rows, selectedYear],
  );
  const depositMovements = externalCashMovements.filter((movement) => movement.amountPln > 0);
  const withdrawnPln = externalCashMovements
    .filter((movement) => movement.amountPln < 0)
    .reduce((sum, movement) => sum + Math.abs(movement.amountPln), 0);
  const silnikDepositRows = depositMovements;
  const investedCapitalPln = depositMovements.reduce((sum, movement) => sum + movement.amountPln, 0);

  const formatCurrency = (value: number, currency: string = 'USD') => {
    return new Intl.NumberFormat('pl-PL', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
  };
  const formatPln = (value?: string) => value === undefined || value === null || value === '' ? '–' : formatCurrency(Number(value), 'PLN');
  // Kwota odejmowana od wyniku: minus tylko przy liczbie. Przy braku kwoty
  // kafelek pokazywal "-–" (minus doklejony do kreski braku danych).
  const ujemnaPln = (value?: string) => value === undefined || value === null || value === '' ? '–' : `-${formatPln(value)}`;
  const formatPlanName = (plan?: string) => (
    (plan || 'aggressive_user')
      .replace('aggressive_user', 'agresywny')
      .replace('defensible', 'zrównoważony')
      .replace('conservative', 'konserwatywny')
      .replace('_user', '')
      .replace('_', ' ')
  );

  const summary = engineResult?.annual_summary || {};
  // Poz. 26 i 27 maja grosze. pit38_rounded_* to pelne zlote: kafelki pokazywaly
  // 11 170 938,00 i 11 083 922,00, choc ich roznica nie dawala dochodu 87 015,66.
  const przychodFormularza = summary.pit38_form_revenue_pln ?? summary.pit38_rounded_revenue_pln;
  const kosztyFormularza = summary.pit38_form_cost_pln ?? summary.pit38_rounded_cost_pln;
  const scenarios = engineResult?.scenario_results || {};
  const primaryScenario = scenarios[engineResult?.primary_scenario || 'defensible'];
  const conservativeScenario = scenarios['conservative'];
  const aggressiveScenario = scenarios['aggressive_user'];
  const filingReady = engineResult?.filing_ready === true;
  const qualityMetrics = engineResult?.quality_report?.metrics || {};
  return (
    <div className="space-y-6">
      <h2 className="text-lg font-bold text-gray-900 dark:text-white">Wyniki i saldo</h2>
      {engineStale && engineResult && (
        <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-bold text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          NIEAKTUALNE — liczby sprzed ostatniej zmiany danych; trwa przeliczenie.
        </p>
      )}
      
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-2xl shadow-sm overflow-hidden flex flex-col">
        {/* Top Key Metrics Row */}
        <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-gray-100 dark:divide-gray-700/60">
          {[
            {
              title: 'Zainwestowane środki własne',
              icon: <ArrowDownRight size={20} />,
              iconColor: 'text-indigo-600 dark:text-indigo-400',
              value: formatCurrency(investedCapitalPln, 'PLN'),
              subValue: silnikDepositRows.length > 0
                ? (withdrawnPln > 0
                  ? `${silnikDepositRows.length} wpłat własnych; wypłacono ${formatCurrency(withdrawnPln, 'PLN')}`
                  : `${silnikDepositRows.length} wpłat własnych z historii silnika`)
                : 'Suma dodatnich wpłat własnych z zaimportowanych danych'
            },
            {
              title: 'Wynik podatkowy brutto',
              icon: <DollarSign size={20} />,
              iconColor: Number(summary.total_pnl_pln || 0) >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400',
              value: `${Number(summary.total_pnl_pln || 0) >= 0 ? '+' : ''}${formatPln(summary.total_pnl_pln)}`,
              valueColor: Number(summary.total_pnl_pln || 0) >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400',
              subValue: primaryScenario ? `~ ${formatPln(primaryScenario.net_pln)} netto (${formatPlanName(engineResult?.primary_scenario || 'defensible')})` : "Silnik Python wczytuje wynik"
            },
            {
              title: 'Status silnika',
              icon: <Activity size={20} />,
              iconColor: 'text-purple-600 dark:text-purple-400',
              value: engineLoading ? 'Przeliczanie…' : (filingReady ? 'Gotowe do rozliczenia' : (engineResult?.status || 'Oczekiwanie')),
              subValue: engineResult?.error ? engineResult.error : `${qualityMetrics.blocking_count || 0} ${odmienLiczebnik(qualityMetrics.blocking_count || 0, 'kontrola', 'kontrole', 'kontroli')} PIT / ${engineResult?.issue_count || 0} ${odmienLiczebnik(engineResult?.issue_count || 0, 'problem', 'problemy', 'problemów')} w przebiegu ${selectedYear}`
            }
          ].map((card, idx) => (
            <div key={idx} className="p-6 relative group bg-white dark:bg-transparent hover:bg-gray-50/50 dark:hover:bg-white/[0.02] transition-colors">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">{card.title}</h3>
                <div className={`${card.iconColor} opacity-90`}>
                  {card.icon}
                </div>
              </div>
              <p className={`text-2xl font-bold tracking-tight ${card.valueColor || 'text-gray-900 dark:text-white'}`}>{card.value}</p>
              <p className="text-sm font-medium text-gray-400 dark:text-gray-400 mt-1">{card.subValue}</p>
            </div>
          ))}
        </div>

        {/* Bottom Section: Yearly Summary */}
        {(engineLoading || engineResult) && (
          <div className="border-t border-gray-100 dark:border-gray-700/60 p-6 bg-gray-50/30 dark:bg-gray-800/30">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
                Podsumowanie Roku ({selectedYear})
              </h3>
            </div>

            {engineLoading ? (
              <div className="flex items-center gap-3 text-gray-600 dark:text-gray-300">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="text-sm">Silnik Python buduje roczny wynik podatkowy…</span>
              </div>
            ) : engineResult?.error ? (
              <div className="flex items-center gap-3 text-rose-600 dark:text-rose-400">
                <AlertCircle className="w-4 h-4" />
                <span className="text-sm">{engineResult.error}</span>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-6">
                  <div className="p-4 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700/60 rounded-xl shadow-sm">
                    <span className="text-xs font-medium text-gray-500 block mb-1.5">Przychód PIT-38</span>
                    <p className="text-base font-semibold text-gray-900 dark:text-white">{formatPln(przychodFormularza)}</p>
                  </div>
                  <div className="p-4 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700/60 rounded-xl shadow-sm">
                    <span className="text-xs font-medium text-gray-500 block mb-1.5">Koszt PIT-38</span>
                    <p className="text-base font-semibold text-gray-900 dark:text-white">{formatPln(kosztyFormularza)}</p>
                  </div>
                  <div className="p-4 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700/60 rounded-xl shadow-sm">
                    <span className="text-xs font-medium text-gray-500 block mb-1.5">Podatek 19% scenariusza</span>
                    <p className="text-base font-semibold text-rose-600 dark:text-rose-400">{ujemnaPln(summary.tax_19_pln)}</p>
                  </div>
                  <div className="p-4 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700/60 rounded-xl shadow-sm">
                    <span className="text-xs font-medium text-gray-500 block mb-1.5">Podatki z danych</span>
                    <p className="text-base font-semibold text-rose-600 dark:text-rose-400">{ujemnaPln(summary.taxes_from_dane_pln)}</p>
                  </div>
                  <div className="p-4 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700/60 rounded-xl shadow-sm">
                    <span className="text-xs font-medium text-gray-500 block mb-1.5">Plan liczenia</span>
                    <p className="text-base font-semibold text-gray-900 dark:text-white">{formatPlanName(engineResult?.plan_used)}</p>
                  </div>
                  <div className={`p-4 rounded-xl shadow-sm border ${Number(summary.net_pln || 0) >= 0 ? 'bg-emerald-50 dark:bg-emerald-500/10 border-emerald-100 dark:border-emerald-500/20' : 'bg-rose-50 dark:bg-rose-500/10 border-rose-100 dark:border-rose-500/20'}`}>
                    <span className={`text-xs font-semibold uppercase tracking-wider block mb-1.5 ${Number(summary.net_pln || 0) >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'}`}>Netto po scenariuszu głównym</span>
                    <p className={`text-base font-bold ${Number(summary.net_pln || 0) >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'}`}>
                      {Number(summary.net_pln || 0) >= 0 ? '+' : ''}{formatPln(summary.net_pln)}
                    </p>
                  </div>
                </div>

                {!filingReady && (
                  <div className="mb-6 p-4 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 rounded-xl">
                    <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                      Wynik nie jest gotowy do rozliczenia. Kontrole jakości nadal wymagają sprawdzenia przed statusem gotowym do złożenia.
                    </p>
                  </div>
                )}
                
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="flex justify-between items-center px-5 py-3 bg-white dark:bg-gray-800 rounded-lg border border-gray-100 dark:border-gray-700/60 shadow-sm">
                    <span className="text-xs font-semibold text-gray-500 uppercase">Konserwatywny vs zrównoważony</span>
                    <span className={`text-sm font-bold ${Number(conservativeScenario?.delta_vs_defensible_pln || 0) >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                      {Number(conservativeScenario?.delta_vs_defensible_pln || 0) >= 0 ? '+' : ''}{formatPln(conservativeScenario?.delta_vs_defensible_pln)}
                    </span>
                  </div>
                  <div className="flex justify-between items-center px-5 py-3 bg-white dark:bg-gray-800 rounded-lg border border-gray-100 dark:border-gray-700/60 shadow-sm">
                    <span className="text-xs font-semibold text-gray-500 uppercase">Brutto w planie zrównoważonym</span>
                    <span className={`text-sm font-bold ${Number(primaryScenario?.gross_result_pln || 0) >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                      {Number(primaryScenario?.gross_result_pln || 0) >= 0 ? '+' : ''}{formatPln(primaryScenario?.gross_result_pln)}
                    </span>
                  </div>
                  <div className="flex justify-between items-center px-5 py-3 bg-white dark:bg-gray-800 rounded-lg border border-gray-100 dark:border-gray-700/60 shadow-sm">
                    <span className="text-xs font-semibold text-gray-500 uppercase">Agresywny vs zrównoważony</span>
                    <span className={`text-sm font-bold ${Number(aggressiveScenario?.delta_vs_defensible_pln || 0) >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                      {Number(aggressiveScenario?.delta_vs_defensible_pln || 0) >= 0 ? '+' : ''}{formatPln(aggressiveScenario?.delta_vs_defensible_pln)}
                    </span>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.6, duration: 0.5 }}
        className="bg-white dark:bg-gray-800 p-6 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 flex flex-col"
      >
        <div className="flex items-center justify-between mb-8">
          <h3 className="text-base font-semibold text-gray-800 dark:text-gray-200">Wykres zmian salda wpłat</h3>
          <span className="text-xs font-bold text-gray-500 bg-gray-100 dark:bg-gray-700/50 border border-gray-200 dark:border-gray-600 px-3 py-1.5 rounded-md">PLN</span>
        </div>
        {chartBalances && chartBalances.length > 0 ? (
          <div className="h-80 w-full min-w-0 min-h-[320px] text-gray-400 dark:text-gray-400">
            <ResponsiveContainer width="100%" height={320} minWidth={1}>
              <AreaChart data={chartBalances} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorBalance" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#6366f1" stopOpacity={0.2}/>
                    <stop offset="95%" stopColor="#6366f1" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="currentColor" className="text-gray-100 dark:text-gray-700/60 transition-colors" />
                <XAxis 
                  dataKey="date" 
                  tickFormatter={(val) => {
                    try {
                      return format(parseISO(val), 'dd.MM');
                    } catch (e) {
                      return val;
                    }
                  }}
                  stroke="currentColor"
                  tick={{ fill: 'currentColor' }}
                  className="text-[11px] font-medium transition-colors"
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis 
                  tickFormatter={(val) => new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 0 }).format(val)}
                  stroke="currentColor"
                  tick={{ fill: 'currentColor' }}
                  className="text-[11px] font-medium transition-colors"
                  tickLine={false}
                  axisLine={false}
                  width={80}
                />
                <Tooltip 
                  content={({ active, payload, label }) => {
                    if (active && payload && payload.length) {
                      let formattedDate = label;
                      try {
                        formattedDate = format(parseISO(label as string), 'dd.MM.yyyy');
                      } catch (e) {}

                      return (
                        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 px-4 py-3 rounded-xl shadow-lg">
                          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">{formattedDate}</p>
                          <p className="text-sm font-bold text-indigo-600 dark:text-indigo-400">
                            {formatCurrency(payload[0].value as number, 'PLN')}
                          </p>
                        </div>
                      );
                    }
                    return null;
                  }}
                />
                <Area type="monotone" dataKey="balancePln" stroke="#6366f1" strokeWidth={3} fillOpacity={1} fill="url(#colorBalance)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="flex h-64 items-center justify-center rounded-xl border border-dashed border-gray-200 text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
            Wykres pojawi się po imporcie aktywnych danych.
          </div>
        )}
      </motion.div>
    </div>
  );
}
