import React from 'react';
import { PieChartIcon, Wallet, Briefcase, ExternalLink, Coins, Network, Scale, ShieldAlert, Split } from 'lucide-react';
import { ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { formatCurrency, formatLiczba } from '../../services/nbpService';
import { odmienLiczebnik } from '../../services/odmianaLiczebnika';
import { Card } from '../../../components/ui/Card';

export function AllocationCharts({ enrichedPositions, totalValuePLN, accounts, categoryAllocationData, brokerAllocationData, currencyAllocationData, brokerDependencyMatrix, brokerHHI, allocationView, setAllocationView, hoveredAssetIndex, setHoveredAssetIndex, hoveredBrokerIndex, setHoveredBrokerIndex, hoveredCurrencyIndex, setHoveredCurrencyIndex, selectedCorrelationBroker, setSelectedCorrelationBroker, selectedCategory, setSelectedCategory, selectedBroker, setSelectedBroker, onNavigateToTab }: any) {
  return (
    <>
      {/* Comprehensive Allocation Charts & Portfolio Structure Module */}
      <Card noPadding className="p-5 sm:p-6 space-y-6">
        {/* Module Header & View Tabs */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-100 dark:border-slate-800">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <span className="p-1.5 rounded-lg bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400">
                <PieChartIcon className="w-4 h-4" />
              </span>
              <h3 className="font-bold text-base text-slate-900 dark:text-white">
                Struktura Portfela i Alokacja Kapitału
              </h3>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Wizualizacja podziału aktywów (akcje, obligacje, krypto, ETF) oraz ekspozycji na poszczególne konta maklerskie.
            </p>
          </div>

          {/* Allocation View Switcher */}
          {/* Od 1280 px zakladki trzymaja jeden wiersz, a zawija sie opis obok tytulu. */}
          <div className="flex items-center flex-nowrap sm:flex-wrap overflow-x-auto sm:overflow-visible max-w-full scrollbar-none gap-1 p-1 rounded-xl bg-slate-100 dark:bg-slate-800 self-start sm:self-auto text-xs xl:flex-nowrap xl:shrink-0">
            <button
              onClick={() => setAllocationView('DUAL')}
              className={`shrink-0 whitespace-nowrap px-3 py-1.5 rounded-lg font-medium transition-all cursor-pointer ${
                allocationView === 'DUAL'
                  ? 'bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 shadow-xs font-semibold'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              Widok Łączony
            </button>
            <button
              onClick={() => setAllocationView('ASSETS')}
              className={`shrink-0 whitespace-nowrap px-3 py-1.5 rounded-lg font-medium transition-all cursor-pointer ${
                allocationView === 'ASSETS'
                  ? 'bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 shadow-xs font-semibold'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              Klasy Aktywów
            </button>
            <button
              onClick={() => setAllocationView('BROKERS')}
              className={`shrink-0 whitespace-nowrap px-3 py-1.5 rounded-lg font-medium transition-all cursor-pointer ${
                allocationView === 'BROKERS'
                  ? 'bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 shadow-xs font-semibold'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              Brokerzy
            </button>
            <button
              onClick={() => setAllocationView('CURRENCIES')}
              className={`shrink-0 whitespace-nowrap px-3 py-1.5 rounded-lg font-medium transition-all cursor-pointer ${
                allocationView === 'CURRENCIES'
                  ? 'bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 shadow-xs font-semibold'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              Waluty
            </button>
            <button
              onClick={() => setAllocationView('DEPENDENCIES')}
              className={`shrink-0 whitespace-nowrap flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition-all cursor-pointer ${
                allocationView === 'DEPENDENCIES'
                  ? 'bg-white dark:bg-slate-900 text-indigo-600 dark:text-indigo-400 shadow-xs font-semibold'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <Network className="w-3.5 h-3.5" />
              <span>Zależności & Ryzyko</span>
              <span className="text-[10px] px-1 rounded-sm bg-indigo-100 dark:bg-indigo-950/80 text-indigo-700 dark:text-indigo-300 font-mono font-bold">
                PRO
              </span>
            </button>
          </div>
        </div>

        {/* Quick Insights Bar */}
        {enrichedPositions.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200/80 dark:border-slate-800 text-xs">
            <div>
              <span className="text-[11px] text-slate-400 block font-medium">Główna klasa aktywów</span>
              <strong className="text-slate-800 dark:text-slate-200 font-semibold truncate block mt-0.5">
                {categoryAllocationData[0] ? `${categoryAllocationData[0].name} (${formatLiczba(Number(categoryAllocationData[0].percentage), 1)}%)` : '—'}
              </strong>
            </div>
            <div>
              <span className="text-[11px] text-slate-400 block font-medium">Główny broker</span>
              <strong className="text-slate-800 dark:text-slate-200 font-semibold truncate block mt-0.5">
                {brokerAllocationData[0] ? `${brokerAllocationData[0].name} (${formatLiczba(Number(brokerAllocationData[0].percentage), 1)}%)` : '—'}
              </strong>
            </div>
            <div>
              <span className="text-[11px] text-slate-400 block font-medium">Dywersyfikacja</span>
              <strong className="text-emerald-600 dark:text-emerald-400 font-semibold block mt-0.5">
                {categoryAllocationData.length >= 3 ? 'Wysoka (Zrównoważona)' : categoryAllocationData.length === 2 ? 'Średnia' : 'Skoncentrowana'}
              </strong>
            </div>
            <div>
              <span className="text-[11px] text-slate-400 block font-medium">Liczba instrumentów</span>
              <strong className="text-slate-800 dark:text-slate-200 font-semibold block mt-0.5">
              {enrichedPositions.length} {odmienLiczebnik(enrichedPositions.length, 'pozycja', 'pozycje', 'pozycji')} / {brokerAllocationData.length} {odmienLiczebnik(brokerAllocationData.length, 'rachunek', 'rachunki', 'rachunków')}
              </strong>
            </div>
          </div>
        )}

        {/* Charts Grid */}
        <div
          className={`grid gap-6 ${
            allocationView === 'DUAL'
              ? 'grid-cols-1 lg:grid-cols-2'
              : 'grid-cols-1'
          }`}
        >
          {/* 1. Asset Class Allocation Donut Chart */}
          {(allocationView === 'DUAL' || allocationView === 'ASSETS') && (
            <div className="p-4 sm:p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xs hover:shadow-md hover:border-slate-300 dark:hover:border-slate-700 transition-all duration-300 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
                  <div className="flex items-center gap-2">
                    <span className="p-1 rounded-md bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400">
                      <PieChartIcon className="w-3.5 h-3.5" />
                    </span>
                    <h4 className="font-bold text-sm text-slate-900 dark:text-white">
                      Klasy Aktywów (Akcje, Obligacje, Krypto, ETF)
                    </h4>
                  </div>
                  <span className="text-xs font-mono text-slate-500 dark:text-slate-400 whitespace-nowrap shrink-0">
                    {categoryAllocationData.length} {odmienLiczebnik(categoryAllocationData.length, 'kategoria', 'kategorie', 'kategorii')}
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-12 items-center gap-6 mt-4">
                  {/* Donut Chart Canvas */}
                  <div className="sm:col-span-5 h-56 w-full flex items-center justify-center relative">
                    {categoryAllocationData.length > 0 ? (
                      <>
                        <ResponsiveContainer width="100%" height="100%">
                          <PieChart>
                            <Pie
                              data={categoryAllocationData}
                              cx="50%"
                              cy="50%"
                              innerRadius={62}
                              outerRadius={88}
                              paddingAngle={2}
                              dataKey="value"
                              nameKey="name"
                              onMouseEnter={(_, index) => setHoveredAssetIndex(index)}
                              onMouseLeave={() => setHoveredAssetIndex(null)}
                            >
                              {categoryAllocationData.map((entry, index) => (
                                <Cell
                                  key={`cell-cat-${index}`}
                                  fill={entry.color}
                                  stroke={hoveredAssetIndex === index ? '#FFFFFF' : 'transparent'}
                                  strokeWidth={hoveredAssetIndex === index ? 2 : 0}
                                  className="transition-all duration-200 cursor-pointer"
                                />
                              ))}
                            </Pie>
                          </PieChart>
                        </ResponsiveContainer>

                        {/* Center Metric */}
                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none text-center">
                          {hoveredAssetIndex !== null && categoryAllocationData[hoveredAssetIndex] ? (
                            <div className="flex flex-col items-center justify-center max-w-[105px] px-1 text-center">
                              <span className="text-[9px] uppercase font-bold text-slate-500 dark:text-slate-400 tracking-wider truncate w-full">
                                {categoryAllocationData[hoveredAssetIndex].name}
                              </span>
                              <span className="text-sm font-bold font-mono text-slate-900 dark:text-white leading-tight my-0.5">
                                {formatLiczba(Number(categoryAllocationData[hoveredAssetIndex].percentage), 1)}%
                              </span>
                              <span className="text-[10px] text-slate-500 dark:text-slate-400 font-mono truncate w-full">
                                {formatCurrency(categoryAllocationData[hoveredAssetIndex].value, 'PLN')}
                              </span>
                            </div>
                          ) : (
                            <div className="flex flex-col items-center justify-center max-w-[105px] px-1 text-center">
                              <span className="text-[9px] uppercase font-bold text-slate-500 dark:text-slate-400 tracking-wider">
                                Portfel
                              </span>
                              <span className="text-xs sm:text-sm font-bold font-mono text-slate-900 dark:text-white leading-tight my-0.5 truncate w-full">
                                {formatCurrency(totalValuePLN, 'PLN')}
                              </span>
                              <span className="text-[9px] text-emerald-600 dark:text-emerald-400 font-semibold">
                                100%
                              </span>
                            </div>
                          )}
                        </div>
                      </>
                    ) : (
                      <div className="text-center py-8">
                        <Wallet className="w-8 h-8 text-slate-300 dark:text-slate-600 mx-auto mb-2" />
                        <p className="text-xs text-slate-400">Brak otwartych pozycji</p>
                      </div>
                    )}
                  </div>

                  {/* Interactive Legend with Percentage Progress Bars */}
                  <div className="sm:col-span-7 space-y-2">
                    {categoryAllocationData.map((item, idx) => {
                      const isHovered = hoveredAssetIndex === idx;
                      const isFilterActive = selectedCategory === item.rawCategory;
                      return (
                        <div
                          key={item.rawCategory}
                          onMouseEnter={() => setHoveredAssetIndex(idx)}
                          onMouseLeave={() => setHoveredAssetIndex(null)}
                          onClick={() => {
                            setSelectedCategory(isFilterActive ? 'ALL' : item.rawCategory);
                          }}
                          className={`p-2.5 rounded-xl transition-all cursor-pointer border ${
                            isHovered || isFilterActive
                              ? 'bg-blue-50/80 dark:bg-blue-950/40 border-blue-200/90 dark:border-blue-800/60 shadow-xs'
                              : 'bg-slate-50/80 dark:bg-slate-800/40 border-slate-200/60 dark:border-slate-800/50 hover:bg-slate-100/80 dark:hover:bg-slate-800/70'
                          }`}
                          title={`Kliknij, aby filtrować tabelę do: ${item.name}`}
                        >
                          <div className="flex items-center justify-between text-xs mb-1.5 gap-2">
                            <div className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
                              <span
                                className="w-2.5 h-2.5 rounded-full shrink-0 ring-2 ring-white dark:ring-slate-900"
                                style={{ backgroundColor: item.color }}
                              />
                              <span className="font-semibold text-slate-800 dark:text-slate-200 truncate">
                                {item.name}
                              </span>
                              <span className="text-[10px] text-slate-500 dark:text-slate-400 font-mono shrink-0">
                                ({item.count} poz.)
                              </span>
                            </div>
                            <div className="flex items-center gap-2 font-mono shrink-0 text-right">
                              <span className="font-bold text-slate-900 dark:text-white">
                                {formatLiczba(Number(item.percentage), 1)}%
                              </span>
                              <span className="text-slate-500 dark:text-slate-400 text-[11px]">
                                {formatCurrency(item.value, 'PLN')}
                              </span>
                            </div>
                          </div>

                          {/* Progress Bar */}
                          <div className="w-full h-1.5 rounded-full bg-slate-200/80 dark:bg-slate-700/60 overflow-hidden">
                            <div
                              className="h-full rounded-full transition-all duration-300"
                              style={{
                                width: `${item.percentage}%`,
                                backgroundColor: item.color,
                              }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 2. Broker Accounts Allocation Donut Chart */}
          {(allocationView === 'DUAL' || allocationView === 'BROKERS') && (
            <div className="p-4 sm:p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xs hover:shadow-md hover:border-slate-300 dark:hover:border-slate-700 transition-all duration-300 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
                  <div className="flex items-center gap-2">
                    <span className="p-1 rounded-md bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400">
                      <Briefcase className="w-3.5 h-3.5" />
                    </span>
                    <h4 className="font-bold text-sm text-slate-900 dark:text-white">
                      Udział Poszczególnych Brokerów w Aktywach
                    </h4>
                  </div>
                  <button
                    onClick={() => onNavigateToTab('brokers')}
                    className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer flex items-center gap-1 font-medium"
                  >
                    <span>Konta ({accounts.length})</span>
                    <ExternalLink className="w-3 h-3" />
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-12 items-center gap-6 mt-4">
                  {/* Donut Chart Canvas */}
                  <div className="sm:col-span-5 h-56 w-full flex items-center justify-center relative">
                    {brokerAllocationData.length > 0 ? (
                      <>
                        <ResponsiveContainer width="100%" height="100%">
                          <PieChart>
                            <Pie
                              data={brokerAllocationData}
                              cx="50%"
                              cy="50%"
                              innerRadius={62}
                              outerRadius={88}
                              paddingAngle={2}
                              dataKey="value"
                              nameKey="name"
                              onMouseEnter={(_, index) => setHoveredBrokerIndex(index)}
                              onMouseLeave={() => setHoveredBrokerIndex(null)}
                            >
                              {brokerAllocationData.map((entry, index) => (
                                <Cell
                                  key={`cell-broker-${index}`}
                                  fill={entry.color}
                                  stroke={hoveredBrokerIndex === index ? '#FFFFFF' : 'transparent'}
                                  strokeWidth={hoveredBrokerIndex === index ? 2 : 0}
                                  className="transition-all duration-200 cursor-pointer"
                                />
                              ))}
                            </Pie>
                          </PieChart>
                        </ResponsiveContainer>

                        {/* Center Metric */}
                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none text-center">
                          {hoveredBrokerIndex !== null && brokerAllocationData[hoveredBrokerIndex] ? (
                            <div className="flex flex-col items-center justify-center max-w-[105px] px-1 text-center">
                              <span className="text-[9px] uppercase font-bold text-slate-500 dark:text-slate-400 tracking-wider truncate w-full">
                                {brokerAllocationData[hoveredBrokerIndex].name}
                              </span>
                              <span className="text-sm font-bold font-mono text-slate-900 dark:text-white leading-tight my-0.5">
                                {formatLiczba(Number(brokerAllocationData[hoveredBrokerIndex].percentage), 1)}%
                              </span>
                              <span className="text-[10px] text-slate-500 dark:text-slate-400 font-mono truncate w-full">
                                {formatCurrency(brokerAllocationData[hoveredBrokerIndex].value, 'PLN')}
                              </span>
                            </div>
                          ) : (
                            <div className="flex flex-col items-center justify-center max-w-[105px] px-1 text-center">
                              <span className="text-[9px] uppercase font-bold text-slate-500 dark:text-slate-400 tracking-wider">
                                Wszyscy Brokerzy
                              </span>
                              <span className="text-xs sm:text-sm font-bold font-mono text-slate-900 dark:text-white leading-tight my-0.5 truncate w-full">
                                {formatCurrency(totalValuePLN, 'PLN')}
                              </span>
                              <span className="text-[9px] text-indigo-600 dark:text-indigo-400 font-semibold">
                                {accounts.length} kont
                              </span>
                            </div>
                          )}
                        </div>
                      </>
                    ) : (
                      <div className="text-center py-8">
                        <Briefcase className="w-8 h-8 text-slate-300 dark:text-slate-600 mx-auto mb-2" />
                        <p className="text-xs text-slate-400">Brak powiązanych kont maklerskich</p>
                      </div>
                    )}
                  </div>

                  {/* Interactive Legend with Percentage Progress Bars */}
                  <div className="sm:col-span-7 space-y-2">
                    {brokerAllocationData.map((item, idx) => {
                      const isHovered = hoveredBrokerIndex === idx;
                      const isFilterActive = selectedBroker === item.accountId;
                      return (
                        <div
                          key={item.accountId}
                          onMouseEnter={() => setHoveredBrokerIndex(idx)}
                          onMouseLeave={() => setHoveredBrokerIndex(null)}
                          onClick={() => {
                            if (item.accountId) {
                              setSelectedBroker(isFilterActive ? 'ALL' : item.accountId);
                            }
                          }}
                          className={`p-2.5 rounded-xl transition-all cursor-pointer border hover:scale-[1.01] ${
                            isHovered || isFilterActive
                              ? 'bg-indigo-50/80 dark:bg-indigo-950/40 border-indigo-200/90 dark:border-indigo-800/60 shadow-xs'
                              : 'bg-slate-50/80 dark:bg-slate-800/40 border-slate-200/60 dark:border-slate-800/50 hover:bg-slate-100/80 dark:hover:bg-slate-800/70 hover:shadow-xs'
                          }`}
                          title={`Kliknij, aby filtrować tabelę pozycji do brokera: ${item.name}`}
                        >
                          <div className="flex items-center justify-between text-xs mb-1.5 gap-2">
                            <div className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
                              <span
                                className="w-2.5 h-2.5 rounded-full shrink-0 ring-2 ring-white dark:ring-slate-900"
                                style={{ backgroundColor: item.color }}
                              />
                              <span className="font-semibold text-slate-800 dark:text-slate-200 truncate">
                                {item.name}
                              </span>
                              <span className="text-[10px] text-slate-500 dark:text-slate-400 font-mono shrink-0">
                                ({item.count} poz.)
                              </span>
                            </div>
                            <div className="flex items-center gap-2 font-mono shrink-0 text-right">
                              <span className="font-bold text-slate-900 dark:text-white">
                                {formatLiczba(Number(item.percentage), 1)}%
                              </span>
                              <span className="text-slate-500 dark:text-slate-400 text-[11px]">
                                {formatCurrency(item.value, 'PLN')}
                              </span>
                            </div>
                          </div>

                          {/* Progress Bar */}
                          <div className="w-full h-1.5 rounded-full bg-slate-200/80 dark:bg-slate-700/60 overflow-hidden">
                            <div
                              className="h-full rounded-full transition-all duration-300"
                              style={{
                                width: `${item.percentage}%`,
                                backgroundColor: item.color,
                              }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 3. Currency Exposure Donut Chart */}
          {allocationView === 'CURRENCIES' && (
            <div className="p-4 sm:p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xs hover:shadow-md hover:border-slate-300 dark:hover:border-slate-700 transition-all duration-300 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
                  <div className="flex items-center gap-2">
                    <span className="p-1 rounded-md bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400">
                      <Coins className="w-3.5 h-3.5" />
                    </span>
                    <h4 className="font-bold text-sm text-slate-900 dark:text-white">
                      Ekspozycja Walutowa Portfela (PLN, USD, EUR)
                    </h4>
                  </div>
                  <span className="text-xs font-mono text-slate-500 dark:text-slate-400">
                    {currencyAllocationData.length} waluty
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-12 items-center gap-6 mt-4">
                  <div className="sm:col-span-5 h-56 w-full flex items-center justify-center relative">
                    {currencyAllocationData.length > 0 ? (
                      <>
                        <ResponsiveContainer width="100%" height="100%">
                          <PieChart>
                            <Pie
                              data={currencyAllocationData}
                              cx="50%"
                              cy="50%"
                              innerRadius={62}
                              outerRadius={88}
                              paddingAngle={3}
                              dataKey="value"
                              nameKey="name"
                              onMouseEnter={(_, index) => setHoveredCurrencyIndex(index)}
                              onMouseLeave={() => setHoveredCurrencyIndex(null)}
                            >
                              {currencyAllocationData.map((entry, index) => (
                                <Cell
                                  key={`cell-curr-${index}`}
                                  fill={entry.color}
                                  stroke={hoveredCurrencyIndex === index ? '#FFFFFF' : 'transparent'}
                                  strokeWidth={hoveredCurrencyIndex === index ? 2 : 0}
                                  className="transition-all duration-200 cursor-pointer"
                                />
                              ))}
                            </Pie>
                          </PieChart>
                        </ResponsiveContainer>

                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none text-center">
                          {hoveredCurrencyIndex !== null && currencyAllocationData[hoveredCurrencyIndex] ? (
                            <div className="flex flex-col items-center justify-center max-w-[105px] px-1 text-center">
                              <span className="text-[9px] uppercase font-bold text-slate-400 tracking-wider truncate w-full">
                                {currencyAllocationData[hoveredCurrencyIndex].name}
                              </span>
                              <span className="text-sm font-bold font-mono text-slate-900 dark:text-white leading-tight my-0.5">
                                {formatLiczba(Number(currencyAllocationData[hoveredCurrencyIndex].percentage), 1)}%
                              </span>
                            </div>
                          ) : (
                            <div className="flex flex-col items-center justify-center max-w-[105px] px-1 text-center">
                              <span className="text-[9px] uppercase font-bold text-slate-400 tracking-wider">
                                Waluty Bazowe
                              </span>
                              <span className="text-xs font-bold font-mono text-slate-900 dark:text-white leading-tight my-0.5">
                                {currencyAllocationData.length} {odmienLiczebnik(currencyAllocationData.length, 'waluta', 'waluty', 'walut')}
                              </span>
                            </div>
                          )}
                        </div>
                      </>
                    ) : (
                      <p className="text-xs text-slate-400">Brak pozycji</p>
                    )}
                  </div>

                  <div className="sm:col-span-7 space-y-2.5">
                    {currencyAllocationData.map((item, idx) => (
                      <div
                        key={item.name}
                        onMouseEnter={() => setHoveredCurrencyIndex(idx)}
                        onMouseLeave={() => setHoveredCurrencyIndex(null)}
                        className="p-2 rounded-xl bg-white dark:bg-slate-800/80 border border-slate-200/80 dark:border-slate-700/60 hover:scale-[1.01] transition-all duration-200 hover:shadow-xs"
                      >
                        <div className="flex items-center justify-between text-xs mb-1 gap-2">
                          <div className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
                            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: item.color }} />
                            <span className="font-bold text-slate-800 dark:text-slate-200 truncate">
                              {item.name}
                            </span>
                            <span className="text-[10px] text-slate-400 shrink-0">
                              ({item.count} {odmienLiczebnik(item.count, 'pozycja', 'pozycje', 'pozycji')})
                            </span>
                          </div>
                          <div className="flex items-center gap-2 font-mono shrink-0 text-right">
                            <span className="font-bold text-slate-900 dark:text-white">{formatLiczba(Number(item.percentage), 1)}%</span>
                            <span className="text-slate-400 text-[11px]">({formatCurrency(item.value, 'PLN')})</span>
                          </div>
                        </div>
                        <div className="w-full h-1.5 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all duration-300"
                            style={{ width: `${item.percentage}%`, backgroundColor: item.color }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 4. Institutional Broker Dependencies & Correlation Matrix View */}
          {allocationView === 'DEPENDENCIES' && (
            <div className="p-4 sm:p-6 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xs space-y-6">
              {/* Header & Risk Score Summary */}
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-slate-100 dark:border-slate-800">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="p-1.5 rounded-lg bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400">
                      <Network className="w-4 h-4" />
                    </span>
                    <h4 className="font-bold text-base text-slate-900 dark:text-white">
                      Macierz Zależności Aktywów i Ekspozycji Brokerskich
                    </h4>
                    <span className="text-[10px] px-2 py-0.5 rounded-md bg-indigo-100 dark:bg-indigo-900/60 text-indigo-700 dark:text-indigo-300 font-bold font-mono">
                      INSTITUTIONAL GRADE
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 max-w-2xl">
                    Identyfikacja punktów koncentracji ryzyka, wielopoziomowy podział posiadanych walorów na poszczególne domy maklerskie oraz symulacja niezależności depozytowej.
                  </p>
                </div>

                {/* Risk Indicators Pills */}
                <div className="flex flex-wrap items-center gap-2.5">
                  <div className="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 text-xs flex items-center gap-2.5">
                    <Scale className="w-4 h-4 text-indigo-500" />
                    <div>
                      <span className="text-[10px] text-slate-400 block font-medium">Wskaźnik Koncentracji HHI</span>
                      <div className="font-mono font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                        <span>{formatLiczba(brokerHHI, 0)} pkt</span>
                        <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-bold ${
                          brokerHHI < 2500
                            ? 'bg-emerald-100 dark:bg-emerald-950 text-emerald-600 dark:text-emerald-400'
                            : brokerHHI < 5000
                            ? 'bg-amber-100 dark:bg-amber-950 text-amber-600 dark:text-amber-400'
                            : 'bg-rose-100 dark:bg-rose-950 text-rose-600 dark:text-rose-400'
                        }`}>
                          {brokerHHI < 2500 ? 'Zrównoważony' : brokerHHI < 5000 ? 'Umiarkowany' : 'Wysoka zależność'}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 text-xs flex items-center gap-2.5">
                    <ShieldAlert className="w-4 h-4 text-emerald-500" />
                    <div>
                      {/* Byl tu napis "Ochrona KNF / CySEC / SEC" nad liczba
                          rachunkow wpisanych recznie - razem z portfelami krypto
                          i kontami z pliku CSV, ktorych zaden z tych nadzorow
                          nie obejmuje. Aplikacja nie sprawdza zadnego rejestru. */}
                      <span className="text-[10px] text-slate-400 block font-medium">
                        Rachunki wpisane w aplikacji
                      </span>
                      <div className="font-mono font-bold text-slate-900 dark:text-white">
                        {accounts.length}{' '}
                  {odmienLiczebnik(accounts.length, 'rachunek', 'rachunki', 'rachunków')}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Interactive Broker Filter Strip */}
              <div className="flex items-center flex-wrap gap-2 pt-1">
                <span className="text-xs font-semibold text-slate-500 dark:text-slate-400 mr-1">
                  Filtruj wg brokera źródłowego:
                </span>
                <button
                  type="button"
                  onClick={() => setSelectedCorrelationBroker(null)}
                  className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer border ${
                    selectedCorrelationBroker === null
                      ? 'bg-indigo-600 text-white border-indigo-600 shadow-2xs'
                      : 'bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-slate-100'
                  }`}
                >
                  Wszyscy ({accounts.length})
                </button>
                {accounts.map((acc) => {
                  const isSelected = selectedCorrelationBroker === acc.id;
                  return (
                    <button
                      key={acc.id}
                      type="button"
                      onClick={() => setSelectedCorrelationBroker(isSelected ? null : acc.id)}
                      className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer border ${
                        isSelected
                          ? 'bg-indigo-600 text-white border-indigo-600 shadow-2xs'
                          : 'bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700'
                      }`}
                    >
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: acc.color }} />
                      <span>{acc.name}</span>
                      <span className="text-[10px] font-mono opacity-80">({acc.brokerType})</span>
                    </button>
                  );
                })}
              </div>

              {/* Matrix Cards Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {brokerDependencyMatrix
                  .filter((item) => {
                    if (!selectedCorrelationBroker) return true;
                    return item.brokerBreakdown.some((b) => b.accountId === selectedCorrelationBroker);
                  })
                  .map((item) => {
                    const isMultiBroker = item.brokerBreakdown.length > 1;
                    return (
                      <div
                        key={item.ticker}
                        className="p-4 rounded-xl bg-slate-50/80 dark:bg-slate-800/40 border border-slate-200/80 dark:border-slate-700/60 hover:shadow-md hover:border-slate-300 dark:hover:border-slate-600 transition-all duration-200 space-y-3"
                      >
                        {/* Ticker & Share Header */}
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-bold font-mono text-sm text-slate-900 dark:text-white">
                                {item.ticker}
                              </span>
                              {isMultiBroker ? (
                                <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.2 rounded font-bold bg-indigo-100 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800">
                                  <Split className="w-2.5 h-2.5" />
                                  Multi-Broker ({item.brokerBreakdown.length})
                                </span>
                              ) : (
                                <span className="text-[10px] px-1.5 py-0.2 rounded font-medium bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300">
                                  Pojedynczy Broker
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate max-w-[180px] mt-0.5">
                              {item.name}
                            </p>
                          </div>
                          <div className="text-right font-mono">
                            <div className="font-bold text-xs text-slate-900 dark:text-white">
                              {formatCurrency(item.totalValuePLN, 'PLN')}
                            </div>
                            <div className="text-[10px] text-slate-400">
                              {item.totalQty.toLocaleString('pl-PL', { maximumFractionDigits: 6 })} {item.currency}
                            </div>
                          </div>
                        </div>

                        {/* Multi-segment Broker Bar */}
                        <div className="space-y-1">
                          <div className="w-full h-2 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden flex">
                            {item.brokerBreakdown.map((b, bIdx) => (
                              <div
                                key={bIdx}
                                style={{ width: `${b.shareOfAssetPct}%`, backgroundColor: b.color }}
                                className="h-full first:rounded-l-full last:rounded-r-full transition-all duration-300"
                                title={`${b.accountName}: ${formatLiczba(b.shareOfAssetPct, 1)}% (${formatCurrency(b.valuePLN, 'PLN')})`}
                              />
                            ))}
                          </div>
                          <div className="flex items-center justify-between text-[10px] text-slate-400 font-mono">
                            <span>Alokacja depozytu</span>
                            <span>{item.brokerBreakdown.length} kont</span>
                          </div>
                        </div>

                        {/* Broker Breakdown Rows */}
                        <div className="space-y-1.5 pt-1 border-t border-slate-200/60 dark:border-slate-700/50 text-xs">
                          {item.brokerBreakdown.map((b) => {
                            const isProfit = b.unrealizedPLN >= 0;
                            return (
                              <div
                                key={b.accountId}
                                className="p-2 rounded-lg bg-white dark:bg-slate-800 border border-slate-200/70 dark:border-slate-700/60 flex items-center justify-between gap-2"
                              >
                                <div className="flex items-center gap-2 min-w-0 flex-1">
                                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: b.color }} />
                                  <div className="truncate">
                                    <span className="font-semibold text-slate-800 dark:text-slate-200 block truncate text-[11px]">
                                      {b.accountName}
                                    </span>
                                    <span className="text-[10px] text-slate-400 font-mono">
                                      {b.qty.toLocaleString('pl-PL', { maximumFractionDigits: 6 })} szt. ({b.shareOfAssetPct.toFixed(0)}%)
                                    </span>
                                  </div>
                                </div>

                                <div className="text-right font-mono shrink-0">
                                  <span className="font-bold text-slate-900 dark:text-white text-[11px] block">
                                    {formatCurrency(b.valuePLN, 'PLN')}
                                  </span>
                                  <span className={`text-[10px] font-semibold ${isProfit ? 'text-emerald-500' : 'text-rose-500'}`}>
                                    {isProfit ? '+' : ''}{formatCurrency(b.unrealizedPLN, 'PLN')}
                                  </span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}
        </div>
      </Card>
    </>
  );
}
