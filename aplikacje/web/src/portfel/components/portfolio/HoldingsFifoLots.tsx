import React from 'react';
import { Layers, MinusCircle } from 'lucide-react';
import { formatCurrency, formatPolishDate, formatLiczba } from '../../services/nbpService';

export function HoldingsFifoLots({ isExpanded, pos, accounts, handleClosePosition }: any) {
  return (
    <>
                      {/* Expanded Lots Details Drawer */}
                      {isExpanded && (
                        <tr className="bg-slate-50/90 dark:bg-slate-950/60">
                          <td colSpan={8} className="p-4 sm:p-5 border-y border-slate-200 dark:border-slate-800">
                            <div className="space-y-3">
                              <div className="flex items-center justify-between flex-wrap gap-2">
                                <div className="flex items-center gap-2">
                                  <Layers className="w-4 h-4 text-blue-500" />
                                  <h4 className="font-bold text-xs text-slate-900 dark:text-white uppercase tracking-wider">
                                    Szczegóły otwartych transz (Metoda FIFO) dla {pos.ticker}
                                  </h4>
                                </div>
                                <div className="flex items-center gap-3 flex-wrap">
                                  <span className="text-[11px] text-slate-500">
                                    Łączny koszt zakupu: <strong>{formatCurrency(pos.totalCostPLN, 'PLN')}</strong>
                                  </span>
                                  <button
                                    onClick={() => handleClosePosition(pos)}
                                    className="px-2.5 py-1 rounded-lg bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-800 hover:bg-rose-100 text-xs font-semibold flex items-center gap-1 transition-all cursor-pointer shadow-xs"
                                    title={`Zarejestruj transakcję zamknięcia (sprzedaż lub wykup) dla ${pos.ticker}`}
                                  >
                                    <MinusCircle className="w-3.5 h-3.5" />
                                    <span>Zamknij pozycję (Sprzedaż / Wykup)</span>
                                  </button>
                                </div>
                              </div>

                              <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
                                <table className="w-full text-left text-xs">
                                  <thead className="bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 font-semibold">
                                    <tr>
                                      <th className="py-2.5 px-3">Data Nabycia</th>
                                      <th className="py-2.5 px-3">Rachunek Maklerski</th>
                                      <th className="py-2.5 px-3 text-right">Pozostała Ilość</th>
                                      <th className="py-2.5 px-3 text-right">Cena Zakupu</th>
                                      <th className="py-2.5 px-3 text-right">Kurs Średni NBP (T-1)</th>
                                      <th className="py-2.5 px-3 text-right">Koszt w PLN</th>
                                      <th className="py-2.5 px-3 text-right">Prowizja PLN</th>
                                      <th className="py-2.5 px-3 text-right">Wycena Bieżąca (PLN)</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                                    {pos.lots.map((lot, idx) => {
                                      const acc = accounts.find((a) => a.id === lot.accountId);
                                      const lotCurrentVal = lot.remainingQty * pos.currentPricePLN;
                                      const lotCost = lot.costPLN + lot.commissionPLN;
                                      const lotPnL = lotCurrentVal - lotCost;

                                      const lotValOrig = lot.remainingQty * pos.currentPriceOrig;
                                      const lotCostOrig = lot.remainingQty * lot.pricePerUnit + (lot.commissionOrig ?? 0);
                                      const lotPnLOrig = lotValOrig - lotCostOrig;
                                      const prowizjaWInnejWalucie = lot.commissionOrig !== undefined && lot.commissionCurrency !== lot.currency;

                                      return (
                                        <tr key={idx} className="hover:bg-slate-50/90 dark:hover:bg-slate-800/60 hover:scale-[1.003] transition-all duration-150 origin-left">
                                          <td className="py-2 px-3 font-mono text-slate-700 dark:text-slate-300">
                                            {formatPolishDate(lot.buyDate)}
                                          </td>
                                          <td className="py-2 px-3">
                                            <span className="font-semibold text-slate-800 dark:text-slate-200">
                                              {acc?.name || lot.accountId}
                                            </span>
                                          </td>
                                          <td className="py-2 px-3 text-right font-mono font-semibold">
                                            {lot.remainingQty.toLocaleString('pl-PL', { maximumFractionDigits: 6 })} / {lot.initialQty.toLocaleString('pl-PL', { maximumFractionDigits: 6 })}
                                          </td>
                                          <td className="py-2 px-3 text-right font-mono">
                                            {formatLiczba(lot.pricePerUnit)} {lot.currency}
                                          </td>
                                          <td className="py-2 px-3 text-right font-mono text-slate-600 dark:text-slate-400">
                                            {formatLiczba(lot.exchangeRate, 4)} PLN
                                            <span className="block text-[9px] text-slate-400">
                                              {lot.exchangeTable} ({lot.exchangeDate})
                                            </span>
                                          </td>
                                          <td className="py-2 px-3 text-right font-mono font-semibold">
                                            {formatCurrency(lot.costPLN, 'PLN')}
                                          </td>
                                          <td className="py-2 px-3 text-right font-mono text-slate-500">
                                            {formatLiczba(lot.commissionPLN)} PLN
                                          </td>
                                          <td className="py-2 px-3 text-right font-mono">
                                            {lot.currency !== 'PLN' && prowizjaWInnejWalucie ? (
                                              <span className="text-slate-400">—</span>
                                            ) : lot.currency !== 'PLN' ? (
                                              <>
                                                <div
                                                  className={`font-semibold ${
                                                    lotPnLOrig >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'
                                                  }`}
                                                >
                                                  {lotPnLOrig >= 0 ? '+' : ''}{formatCurrency(lotPnLOrig, lot.currency)}
                                                </div>
                                                <div
                                                  className={`text-[10px] ${
                                                    lotPnL >= 0 ? 'text-emerald-500/80' : 'text-rose-500/80'
                                                  }`}
                                                >
                                                  ≈ {lotPnL >= 0 ? '+' : ''}{formatCurrency(lotPnL, 'PLN')} (PLN)
                                                </div>
                                              </>
                                            ) : (
                                              <div
                                                className={`font-semibold ${
                                                  lotPnL >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'
                                                }`}
                                              >
                                                {lotPnL >= 0 ? '+' : ''}{formatCurrency(lotPnL, 'PLN')}
                                              </div>
                                            )}
                                          </td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
    </>
  );
}
