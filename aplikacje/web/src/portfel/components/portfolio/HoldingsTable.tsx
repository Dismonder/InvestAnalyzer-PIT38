import React from 'react';
import { odmienLiczebnik } from '../../services/odmianaLiczebnika';
import { Wallet, Layers, ArrowUpRight, ArrowDownRight, PlusCircle, Search, ChevronDown, ChevronUp, Bell, Activity, ShieldCheck, X, Split, MinusCircle } from 'lucide-react';
import { formatCurrency, formatLiczba, formatPolishDate } from '../../services/nbpService';
import { udzialWPortfelu } from '../../services/wycenaPozycji';
import { HoldingsFifoLots } from './HoldingsFifoLots';
import { Input } from '../../../components/ui/Input';
import { RACHUNEK_NIEUSTALONY } from '../../services/pozycjaRachunku';

export function HoldingsTable({ searchTerm, setSearchTerm, selectedCategory, setSelectedCategory, selectedBroker, setSelectedBroker, accounts, filteredPositions, enrichedPositions, expandedPosition, setExpandedPosition, onQuickAddTransaction, totalValuePLN, onOpenPriceAlert, onSelectTickerForChart, onNavigateToTab, setOptionsModalTicker, setShowOptionsModal, handleClosePosition, CATEGORY_LABELS }: any) {
  return (
    <>
      {/* Main Table: Open Positions (Aktywa w Portfelu) */}
      <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm hover:shadow-md transition-all duration-300 overflow-hidden">
        {/* Table Filters & Search Bar */}
        <div className="p-4 sm:p-5 border-b border-slate-200 dark:border-slate-800 space-y-3">
          <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="font-bold text-base text-slate-900 dark:text-white flex flex-wrap items-center gap-x-2 gap-y-1">
                <span>Aktywa w Portfelu (Otwarte Pozycje)</span>
                <span className="shrink-0 whitespace-nowrap text-xs px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 font-mono font-semibold">
                  {filteredPositions.length} / {enrichedPositions.length} pozycji
                </span>
              </h2>
            </div>

            <div className="flex min-w-0 flex-wrap items-center gap-2.5 md:flex-1 md:justify-end">
              {/* Search Input */}
              {/* Ikona idzie przez prefixIcon: osobna ikona przed polem chowala sie pod jego tlem. */}
              <div className="flex-1 min-w-[10rem] sm:max-w-64">
                <Input
                  variant="search"
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Szukaj ticker (NVDA, VWCE)..."
                  prefixIcon={<Search className="w-4 h-4" />}
                />
              </div>

              {/* Category Filter */}
              <select
                aria-label="Filtruj według kategorii"
                value={selectedCategory}
                onChange={(e) => setSelectedCategory(e.target.value)}
                className="w-full sm:w-auto py-1.5 px-3 rounded-xl text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
              >
                <option value="ALL">Wszystkie kategorie</option>
                <option value="STOCK_FOREIGN">Akcje Zagraniczne</option>
                <option value="STOCK_PL">Akcje GPW (Polska)</option>
                <option value="ETF">Fundusze ETF</option>
                <option value="CRYPTO">Kryptowaluty</option>
                <option value="BOND">Obligacje</option>
              </select>

              {/* Broker Filter */}
              {/* Szerokosc ograniczona: lista rozciaga sie do najdluzszej nazwy rachunku i sciskala
                  tytul oraz wyszukiwarke. */}
              <select
                aria-label="Filtruj według brokera"
                value={selectedBroker}
                onChange={(e) => setSelectedBroker(e.target.value)}
                className="w-full sm:w-auto min-w-0 max-w-full sm:max-w-56 py-1.5 px-3 rounded-xl text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
              >
                <option value="ALL">Wszyscy brokerzy</option>
                {accounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    {acc.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Active Filter Badges Bar */}
          {(selectedCategory !== 'ALL' || selectedBroker !== 'ALL' || searchTerm.trim() !== '') && (
            <div className="flex items-center flex-wrap gap-2 pt-1">
              <span className="text-[11px] font-semibold text-slate-400">Aktywne filtry:</span>
              {selectedCategory !== 'ALL' && (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-100 dark:bg-blue-900/60 text-blue-800 dark:text-blue-200 border border-blue-200 dark:border-blue-800">
                  <span>Kategoria: {CATEGORY_LABELS[selectedCategory]?.label || selectedCategory}</span>
                  <button
                    type="button"
                    onClick={() => setSelectedCategory('ALL')}
                    className="hover:text-blue-950 dark:hover:text-white cursor-pointer"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              )}
              {selectedBroker !== 'ALL' && (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-indigo-100 dark:bg-indigo-900/60 text-indigo-800 dark:text-indigo-200 border border-indigo-200 dark:border-indigo-800">
                  <span>Broker: {accounts.find((a) => a.id === selectedBroker)?.name || selectedBroker}</span>
                  <button
                    type="button"
                    onClick={() => setSelectedBroker('ALL')}
                    className="hover:text-indigo-950 dark:hover:text-white cursor-pointer"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              )}
              {searchTerm.trim() !== '' && (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-200 dark:bg-slate-700 text-slate-800 dark:text-slate-200">
                  <span>Szukaj: "{searchTerm}"</span>
                  <button
                    type="button"
                    onClick={() => setSearchTerm('')}
                    className="hover:text-slate-900 dark:hover:text-white cursor-pointer"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              )}
              <button
                type="button"
                onClick={() => {
                  setSelectedCategory('ALL');
                  setSelectedBroker('ALL');
                  setSearchTerm('');
                }}
                className="text-[11px] font-bold text-rose-600 dark:text-rose-400 hover:underline ml-1 cursor-pointer"
              >
                Wyczyść wszystkie
              </button>
            </div>
          )}
        </div>

        {/* Table Content */}
        {filteredPositions.length === 0 ? (
          // Poza przewijana tabela: w szerokiej tabeli na telefonie komunikat
          // i przycisk byly wysrodkowane w polowie poza ekranem.
          <div className="py-12 px-4 text-center text-slate-400 flex flex-col items-center justify-center gap-2">
            <Wallet className="w-8 h-8 text-slate-300 dark:text-slate-600" />
            <p className="font-semibold text-sm">Brak otwartych pozycji spełniających kryteria</p>
            <p className="text-xs text-slate-500">Dodaj pierwszą transakcję kupna lub zaimportuj wyciąg z konta.</p>
            <button
              onClick={() => onQuickAddTransaction()}
              className="mt-2 px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 cursor-pointer"
            >
              + Dodaj transakcję kupna
            </button>
          </div>
        ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 font-semibold">
                <th className="py-3.5 px-4">Instrument / Spółka</th>
                <th className="py-3.5 px-4 text-right">Ilość</th>
                <th className="py-3.5 px-4 text-right">Śr. Cena Zakupu</th>
                <th className="py-3.5 px-4 text-right">Kurs Bieżący (Live)</th>
                <th className="py-3.5 px-4 text-right">Wycena (PLN)</th>
                <th className="py-3.5 px-4 text-right">Niezrealizowany Wynik</th>
                <th className="py-3.5 px-4 text-right">Zmiana 24h</th>
                <th className="py-3.5 px-4 text-center">Akcje</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
              {filteredPositions.map((pos) => {
                  const accountId = pos.lots?.[0]?.accountId || pos.accountIds?.[0];
                  const canUseAccount = Boolean(accountId) && accountId !== RACHUNEK_NIEUSTALONY;
                  const positionKey = `${pos.ticker}|${accountId || RACHUNEK_NIEUSTALONY}`;
                  const isExpanded = expandedPosition === positionKey || expandedPosition === pos.ticker;
                  const isProfit = pos.unrealizedPLN >= 0;
                  const catConfig = CATEGORY_LABELS[pos.category] || CATEGORY_LABELS.STOCK_FOREIGN;
                  const shareOfPortfolio = udzialWPortfelu(pos.maWycene, pos.currentValuePLN, totalValuePLN);

                  return (
                    <React.Fragment key={positionKey}>
                      <tr
                        className={`hover:bg-slate-50/90 dark:hover:bg-slate-800/60 hover:scale-[1.004] transition-all duration-150 origin-left ${
                          isExpanded ? 'bg-blue-50/30 dark:bg-blue-950/20' : ''
                        }`}
                      >
                        {/* Ticker & Name & Broker Breakdown Badges */}
                        <td className="py-3.5 px-4">
                          <div className="flex items-center gap-3">
                            <button
                              onClick={() => setExpandedPosition(isExpanded ? null : positionKey)}
                              className="p-1 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors cursor-pointer"
                              title={isExpanded ? 'Zwiń szczegóły transz' : 'Rozwiń szczegóły transz FIFO'}
                            >
                              {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                            </button>
                            <div>
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="font-bold text-sm text-slate-900 dark:text-white font-mono">
                                  {pos.ticker}
                                </span>
                                <span
                                  className={`text-[10px] px-1.5 py-0.5 rounded-md font-semibold border ${catConfig.bg}`}
                                >
                                  {catConfig.label}
                                </span>
                                {pos.accountsCount > 1 ? (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded-md font-bold bg-indigo-50 dark:bg-indigo-950/80 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 flex items-center gap-1">
                                    <Split className="w-2.5 h-2.5" />
                                    {pos.accountsCount} brokerów
                                  </span>
                                ) : (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded-md font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
                                    {pos.primaryAccountName}
                                  </span>
                                )}
                              </div>
                              <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate max-w-[220px] mt-0.5">
                                {pos.name}
                              </p>
                            </div>
                          </div>
                        </td>

                        {/* Quantity */}
                        <td className="py-3.5 px-4 text-right font-mono font-semibold text-slate-800 dark:text-slate-200">
                          {pos.totalQuantity.toLocaleString('pl-PL', { maximumFractionDigits: 6 })}
                          <div className="text-[10px] text-slate-400 font-normal">
                            {pos.openLotsCount} {odmienLiczebnik(pos.openLotsCount, 'transza', 'transze', 'transz')}
                          </div>
                        </td>

                        {/* Avg Buy Price */}
                        <td className="py-3.5 px-4 text-right font-mono">
                          <div className="font-semibold text-slate-800 dark:text-slate-200">
                            {formatLiczba(pos.avgBuyPrice)} {pos.currency}
                          </div>
                          <div className="text-[10px] text-slate-400">
                            ≈ {formatLiczba(pos.avgBuyPricePLN)} PLN/szt.
                          </div>
                        </td>

                        {/* Current Live Price */}
                        <td className="py-3.5 px-4 text-right font-mono">
                          {/* Bez notowania `currentPriceOrig` rownal sie cenie nabycia,
                              a obok pulsowala zielona kropka "na zywo" - historyczny
                              koszt wygladal jak dzisiejszy kurs z gieldy. */}
                          {pos.maNotowanie ? (
                            <>
                              <div className="font-semibold text-slate-900 dark:text-white flex items-center justify-end gap-1.5">
                                <span className="relative flex h-2 w-2">
                                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                                </span>
                                <span>{formatLiczba(pos.currentPriceOrig)} {pos.walutaCeny ?? pos.currency}</span>
                              </div>
                              {pos.zrodloCeny === 'BROKER' && (
                                <div
                                  className="text-[10px] font-semibold text-blue-600 dark:text-blue-300"
                                  title="Dostawca notowań nie zna tego instrumentu. Cena pochodzi z rachunku Freedom24 (tylko odczyt)."
                                >
                                  cena z rachunku Freedom24
                                </div>
                              )}
                              <div className="text-[10px] text-slate-400">
                                {pos.maWycene
                                  ? `≈ ${formatLiczba(pos.currentPricePLN)} PLN`
                                  : 'brak kursu NBP'}
                              </div>
                            </>
                          ) : (
                            <div
                              className="text-xs text-amber-600 dark:text-amber-400 font-semibold"
                              title="Nie pobrano notowania tego instrumentu — pokazanie ceny nabycia w tej kolumnie byłoby myślące."
                            >
                              brak notowania
                            </div>
                          )}
                        </td>

                        {/* Position Value */}
                        <td className="py-3.5 px-4 text-right font-mono">
                          <div className="font-bold text-slate-900 dark:text-white">
                            {pos.maWycene ? formatCurrency(pos.currentValuePLN, 'PLN') : '—'}
                          </div>
                          <div className="text-[10px] text-slate-400">
                            {shareOfPortfolio === null ? '— (brak wyceny)' : `${shareOfPortfolio}% portfela`}
                          </div>
                        </td>

                        {/* Unrealized P&L (Asset Performance & Currency FX) */}
                        <td className="py-3.5 px-4 text-right font-mono">
                          {/* Bez wyceny `unrealized*` rownaly sie zeru, wiec komorka
                              pokazywala zielone "+0,00" ze strzalka wzrostu - wynik
                              idealnie na zero zamiast informacji o braku danych. */}
                          {!pos.maWycene ? (
                            <span className="text-xs text-slate-400">nie wyceniono</span>
                          ) : pos.currency !== 'PLN' ? (
                            <>
                              {/* Primary: Asset P&L in original currency */}
                              {pos.unrealizedOrig === null ? (
                                <div className="text-xs text-slate-400">— ({pos.currency})</div>
                              ) : (
                                <>
                              <div
                                className={`font-bold flex items-center justify-end gap-1 ${
                                  pos.unrealizedOrig >= 0
                                    ? 'text-emerald-600 dark:text-emerald-400'
                                    : 'text-rose-600 dark:text-rose-400'
                                }`}
                              >
                                {pos.unrealizedOrig >= 0 ? (
                                  <ArrowUpRight className="w-3.5 h-3.5" />
                                ) : (
                                  <ArrowDownRight className="w-3.5 h-3.5" />
                                )}
                                <span>
                                  {pos.unrealizedOrig >= 0 ? '+' : ''}
                                  {formatCurrency(pos.unrealizedOrig, pos.currency)}
                                </span>
                              </div>
                              <div
                                className={`text-[11px] font-semibold ${
                                  pos.unrealizedOrig >= 0
                                    ? 'text-emerald-600 dark:text-emerald-400'
                                    : 'text-rose-600 dark:text-rose-400'
                                }`}
                              >
                                {pos.unrealizedPctOrig !== null && pos.unrealizedPctOrig >= 0 ? '+' : ''}
                                {pos.unrealizedPctOrig == null ? '—' : formatLiczba(pos.unrealizedPctOrig)}% ({pos.currency})
                              </div>
                                </>
                              )}
                              {/* Secondary: Total PLN with FX effect */}
                              <div
                                className={`text-[10px] font-medium mt-0.5 ${
                                  pos.unrealizedPLN >= 0 ? 'text-emerald-600/80 dark:text-emerald-400/80' : 'text-rose-600/80 dark:text-rose-400/80'
                                }`}
                                title={`Wycena w PLN z uwzględnieniem kursu NBP (Efekt walutowy FX: ${pos.fxImpactPLN === null ? '—' : `${pos.fxImpactPLN >= 0 ? '+' : ''}${formatLiczba(pos.fxImpactPLN)} PLN`})`}
                              >
                                ≈ {pos.unrealizedPLN >= 0 ? '+' : ''}{formatCurrency(pos.unrealizedPLN, 'PLN')} ({pos.unrealizedPct >= 0 ? '+' : ''}{formatLiczba(pos.unrealizedPct)}% PLN)
                              </div>
                            </>
                          ) : (
                            <>
                              <div
                                className={`font-bold flex items-center justify-end gap-1 ${
                                  isProfit
                                    ? 'text-emerald-600 dark:text-emerald-400'
                                    : 'text-rose-600 dark:text-rose-400'
                                }`}
                              >
                                {isProfit ? (
                                  <ArrowUpRight className="w-3.5 h-3.5" />
                                ) : (
                                  <ArrowDownRight className="w-3.5 h-3.5" />
                                )}
                                <span>
                                  {isProfit ? '+' : ''}
                                  {formatCurrency(pos.unrealizedPLN, 'PLN')}
                                </span>
                              </div>
                              <div
                                className={`text-[11px] font-semibold ${
                                  isProfit
                                    ? 'text-emerald-600 dark:text-emerald-400'
                                    : 'text-rose-600 dark:text-rose-400'
                                }`}
                              >
                                {pos.unrealizedPct >= 0 ? '+' : ''}
                                {formatLiczba(pos.unrealizedPct)}%
                              </div>
                            </>
                          )}
                        </td>

                        {/* 24h Change */}
                        <td className="py-3.5 px-4 text-right font-mono">
                          {/* Brak notowania dawal change24h = 0, czyli zielona
                              plakietke "+0.00%" - kurs stoi w miejscu zamiast
                              "nie udalo sie go pobrac". Cena z rachunku brokera
                              nie niesie zmiany dziennej - wtedy tez "—". */}
                          {pos.change24h !== null ? (
                            <span
                              className={`inline-block px-1.5 py-0.5 rounded text-[11px] font-bold ${
                                pos.change24h >= 0
                                  ? 'bg-emerald-100 dark:bg-emerald-950/80 text-emerald-700 dark:text-emerald-400'
                                  : 'bg-rose-100 dark:bg-rose-950/80 text-rose-700 dark:text-rose-400'
                              }`}
                            >
                              {pos.change24h >= 0 ? '+' : ''}{formatLiczba(pos.change24h)}%
                            </span>
                          ) : (
                            <span className="text-[11px] text-slate-400">—</span>
                          )}
                        </td>

                        {/* Action Buttons */}
                        <td className="py-3.5 px-4 text-center">
                          <div className="flex items-center justify-center gap-1">
                            {/* Quick Buy More */}
                            <button
                              disabled={!canUseAccount}
                              onClick={() =>
                                onQuickAddTransaction({
                                  ticker: pos.ticker,
                                  type: 'BUY',
                                  category: pos.category,
                                  accountId,
                                })
                              }
                              className="p-1.5 rounded-lg bg-slate-100 hover:bg-emerald-100 dark:bg-slate-800 dark:hover:bg-emerald-950 text-slate-600 hover:text-emerald-600 dark:text-slate-300 dark:hover:text-emerald-400 transition-colors cursor-pointer"
                              title={`Dokup akcje ${pos.ticker}`}
                            >
                              <PlusCircle className="w-3.5 h-3.5" />
                            </button>

                            {/* Quick Sell */}
                            <button
                              disabled={!canUseAccount}
                              onClick={() =>
                                onQuickAddTransaction({
                                  ticker: pos.ticker,
                                  type: 'SELL',
                                  quantity: pos.totalQuantity,
                                  category: pos.category,
                                  accountId,
                                })
                              }
                              className="p-1.5 rounded-lg bg-slate-100 hover:bg-rose-100 dark:bg-slate-800 dark:hover:bg-rose-950 text-slate-600 hover:text-rose-600 dark:text-slate-300 dark:hover:text-rose-400 transition-colors cursor-pointer"
                              title={`Sprzedaj pozycję ${pos.ticker}`}
                            >
                              <ArrowDownRight className="w-3.5 h-3.5" />
                            </button>

                            {/* Protective Orders SL/TP */}
                              <button
                                disabled={!canUseAccount}
                                onClick={() =>
                                onOpenPriceAlert(pos.ticker, accountId)
                              }
                              className="p-1.5 rounded-lg bg-slate-100 hover:bg-emerald-100 dark:bg-slate-800 dark:hover:bg-emerald-950 text-slate-600 hover:text-emerald-600 dark:text-slate-300 dark:hover:text-emerald-400 transition-colors cursor-pointer"
                              title={`Uzbrój zlecenia ochronne Stop-Loss / Take-Profit dla ${pos.ticker}`}
                            >
                              <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
                            </button>

                            {/* View Chart */}
                            <button
                              onClick={() => {
                                onSelectTickerForChart(pos.ticker);
                                onNavigateToTab('charts');
                              }}
                              className="p-1.5 rounded-lg bg-slate-100 hover:bg-blue-100 dark:bg-slate-800 dark:hover:bg-blue-950 text-slate-600 hover:text-blue-600 dark:text-slate-300 dark:hover:text-blue-400 transition-colors cursor-pointer"
                              title={`Zobacz wykres live dla ${pos.ticker}`}
                            >
                              <Activity className="w-3.5 h-3.5" />
                            </button>

                            {/* Options Chain */}
                            <button
                              onClick={() => {
                                setOptionsModalTicker(pos.ticker);
                                setShowOptionsModal(true);
                              }}
                              className="p-1.5 rounded-lg bg-slate-100 hover:bg-blue-100 dark:bg-slate-800 dark:hover:bg-blue-950 text-slate-600 hover:text-blue-600 dark:text-slate-300 dark:hover:text-blue-400 transition-colors cursor-pointer"
                              title={`Pokaż łańcuch opcji dla ${pos.ticker}`}
                            >
                              <Layers className="w-3.5 h-3.5" />
                            </button>

                            {/* Price Alert */}
                              <button
                                disabled={!canUseAccount}
                                onClick={() =>
                                onOpenPriceAlert(pos.ticker, accountId)
                              }
                              className="p-1.5 rounded-lg bg-slate-100 hover:bg-amber-100 dark:bg-slate-800 dark:hover:bg-amber-950 text-slate-600 hover:text-amber-600 dark:text-slate-300 dark:hover:text-amber-400 transition-colors cursor-pointer"
                              title={`Ustaw alert cenowy dla ${pos.ticker}`}
                            >
                              <Bell className="w-3.5 h-3.5" />
                            </button>

                            {/* Close / Sell / Redeem Position */}
                            <button disabled={!canUseAccount}
                              onClick={() => handleClosePosition(pos)}
                              className="px-2 py-1 rounded-lg bg-rose-50 hover:bg-rose-100 dark:bg-rose-950/60 dark:hover:bg-rose-900/80 text-rose-600 dark:text-rose-300 border border-rose-200 dark:border-rose-800 text-[11px] font-bold flex items-center gap-1 transition-all cursor-pointer shadow-xs whitespace-nowrap"
                              title={`Zamknij pozycję / Zarejestruj sprzedaż lub wykup dla ${pos.ticker}`}
                            >
                              <MinusCircle className="w-3.5 h-3.5 text-rose-500" />
                              <span className="hidden xl:inline">Zamknij</span>
                            </button>
                          </div>
                        </td>
                      </tr>

                      <HoldingsFifoLots isExpanded={isExpanded} pos={pos} accounts={accounts} handleClosePosition={handleClosePosition} />
                    </React.Fragment>
                  );
                })}
            </tbody>
          </table>
        </div>
        )}
      </div>
    </>
  );
}
