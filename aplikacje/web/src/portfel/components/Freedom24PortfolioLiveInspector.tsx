import React, { useState, useEffect } from 'react';
import { klikalny } from '../../shared/klikalny';
import { sumaRachunkuBrokera } from '../services/sumaRachunkuBrokera';
import { getNBPRateForDate, formatLiczba } from '../services/nbpService';
import { dzisiajLokalnie } from '../services/formularzTransakcji';
import type { CurrencyCode } from '../types';
import {
  Wallet,
  TrendingUp,
  TrendingDown,
  DollarSign,
  Coins,
  ShieldCheck,
  RefreshCw,
  Zap,
  Globe,
  CheckCircle2,
  Lock,
  FileText,
} from 'lucide-react';
import {
  freedom24LivePortfolioService,
  Freedom24PortfolioLiveResponse,
  Freedom24AccountBalance,
  Freedom24LivePosition,
} from '../services/freedom24LivePortfolioService';
import { Freedom24CpsModal } from './Freedom24CpsModal';

interface Freedom24PortfolioLiveInspectorProps {
  apiKey?: string;
  apiSecret?: string;
  onSelectTicker?: (ticker: string) => void;
}

export const Freedom24PortfolioLiveInspector: React.FC<Freedom24PortfolioLiveInspectorProps> = ({
  onSelectTicker,
}) => {
  const [portfolioData, setPortfolioData] = useState<Freedom24PortfolioLiveResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [kursyPLN, setKursyPLN] = useState<Record<string, number | null>>({});
  const [showCpsModal, setShowCpsModal] = useState(false);

  useEffect(() => {
    setIsLoading(true);
    const unsub = freedom24LivePortfolioService.subscribeLivePortfolio(
      (data) => {
        setPortfolioData(data);
        setIsLoading(false);
      }
    );
    return () => unsub();
  }, []);

  const handleManualRefresh = async () => {
    setIsLoading(true);
    const data = await freedom24LivePortfolioService.fetchLivePortfolio();
    setPortfolioData(data);
    setIsLoading(false);
  };

  const balances = portfolioData?.acc || [];
  const positions = portfolioData?.pos || [];

  const walutyRachunku = [...new Set([...balances.map((b) => b.curr), ...positions.map((p) => p.curr)].filter(Boolean))].sort().join(',');
  useEffect(() => {
    let aktualne = true;
    const dzis = dzisiajLokalnie();
    Promise.all(
      walutyRachunku
        .split(',')
        .filter((waluta) => waluta && waluta !== 'PLN')
        .map(async (waluta) => [waluta, (await getNBPRateForDate(waluta as CurrencyCode, dzis))?.mid ?? null] as const),
    ).then((pary) => {
      if (aktualne) setKursyPLN(Object.fromEntries(pary));
    });
    return () => {
      aktualne = false;
    };
  }, [walutyRachunku]);
  const suma = sumaRachunkuBrokera(
    [
      ...balances.map((b) => ({ waluta: b.curr, kwota: b.s })),
      ...positions.map((p) => ({ waluta: p.curr, kwota: typeof p.market_value === 'number' ? p.market_value : null })),
    ],
    kursyPLN,
  );

  if (!portfolioData || (balances.length === 0 && positions.length === 0)) {
    // Brak danych pokazujemy wprost. Wczesniej w to miejsce wchodzil zaszyty
    // portfel demonstracyjny na 44 168 USD - liczby, ktorych uzytkownik nigdy
    // nie mial, wygladajace jak jego stan rachunku.
    if (!portfolioData?.message) {
      return null;
    }
    return (
      <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <div className="p-2.5 rounded-xl bg-slate-500/10 text-slate-500 border border-slate-500/20">
            <Zap className="w-5 h-5" />
          </div>
          <div>
            <h3 className="font-bold text-sm text-slate-900 dark:text-white">
              Portfel na żywo z Freedom24
            </h3>
            <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">{portfolioData.message}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs overflow-hidden">
      {/* Header */}
      <div className="p-4 sm:p-5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between gap-3 flex-wrap bg-slate-50/50 dark:bg-slate-900/50">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
            <Zap className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-bold text-sm sm:text-base text-slate-900 dark:text-white">
                Portfel & Saldo Walutowe na Żywo (getPositionJson)
              </h3>
              {/* Plakietka mowila "Live WebSocket", choc gniazdo usunieto i dane
                  przychodza z odpytywania HTTP co 30 sekund
                  (freedom24LivePortfolioService.ts: ODSTEP_ODSWIEZANIA_MS). */}
              <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 font-semibold border border-slate-200 dark:border-slate-700 font-mono">
                Odświeżane co 30 s
              </span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Rzeczywisty stan konta, salda walut USD/EUR/PLN oraz wycena pozycji w strukturze Tradernet
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowCpsModal(true)}
            className="px-3 py-1.5 rounded-xl bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-800 hover:bg-blue-100 dark:hover:bg-blue-900/80 text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer shadow-xs"
            title="Otwórz historię dyspozycji CPS i pobieraj pliki PDF"
          >
            <FileText className="w-3.5 h-3.5" />
            <span>Dyspozycje & PDF</span>
          </button>

          <button
            onClick={handleManualRefresh}
            disabled={isLoading}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
            title="Odśwież stan portfela"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Currency Cash Balances Grid */}
      <div className="p-4 sm:p-5 border-b border-slate-100 dark:border-slate-800 bg-slate-50/30 dark:bg-slate-950/20">
        <div className="text-xs font-bold text-slate-700 dark:text-slate-300 mb-2.5 flex items-center gap-1.5">
          <Coins className="w-4 h-4 text-amber-500" />
          <span>Dostępne Salda Walutowe (Rachunek Inwestycyjny):</span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {balances.map((b) => (
            <div
              key={b.curr}
              className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xs"
            >
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span className="font-bold font-mono text-slate-900 dark:text-white">{b.curr}</span>
                {/* Bez "Kurs: 84.20": `currval` to wewnetrzny kurs brokera do jego
                    waluty bazowej (nie PLN i nie kurs NBP). Przy saldzie w USD
                    wygladal jak kurs dolara, a nic dla uzytkownika nie znaczy. */}
              </div>
              <div className="mt-1 text-base font-bold font-mono text-slate-900 dark:text-white">
                {typeof b.s === 'number'
                  ? `${b.s.toLocaleString('pl-PL', { minimumFractionDigits: 2 })} ${b.curr}`
                  : `kwota nieznana (${b.curr})`}
              </div>
              {(b.forecast_in > 0 || b.forecast_out > 0) && (
                <div className="text-[9px] text-slate-400 mt-1 font-mono">
                  T+2: +{b.forecast_in} / -{b.forecast_out}
                </div>
              )}
            </div>
          ))}

          {/* Suma wg oficjalnych kursow NBP - kurs brokera (`currval`) ma nieznana walute bazowa. */}
          <div className="p-3 rounded-xl border border-blue-200 dark:border-blue-800/80 bg-blue-50/50 dark:bg-blue-950/30">
            <div className="text-xs text-blue-600 dark:text-blue-300 font-semibold">Wartość rachunku (gotówka + pozycje)</div>
            <div className="mt-1 text-lg font-bold font-mono text-blue-900 dark:text-blue-100">
              {suma.sumaPLN !== null ? `${suma.sumaPLN.toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} PLN` : '—'}
            </div>
            <div className="text-[10px] text-blue-900/80 dark:text-blue-100/80">
              {suma.sumaUSD !== null && `≈ ${suma.sumaUSD.toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD · `}
              wg kursów średnich NBP
              {suma.bezKursu.length > 0 && ` · bez ${suma.bezKursu.join(', ')} (brak kursu NBP)`}
              {suma.bezKwoty > 0 && ` · ${suma.bezKwoty} składn. bez kwoty od brokera`}
            </div>
          </div>
        </div>
      </div>

      {/* Open Positions Table */}
      <div className="p-4 sm:p-5">
        <div className="text-xs font-bold text-slate-700 dark:text-slate-300 mb-3 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Wallet className="w-4 h-4 text-blue-500" />
            <span>Otwarte Pozycje w Freedom24 (Tradernet Live Feed):</span>
          </div>
          <span className="text-[11px] font-mono text-slate-400 font-normal">
            {positions.length} otwartych pozycji
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs font-mono">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] text-slate-400 bg-slate-50/60 dark:bg-slate-950/40">
                <th className="py-2.5 px-3">INSTRUMENT / ISIN</th>
                <th className="py-2.5 px-3 text-right">ILOŚĆ</th>
                <th className="py-2.5 px-3 text-right">CENA ZAKUPU (ŚR.)</th>
                <th className="py-2.5 px-3 text-right">KURS LIVE</th>
                <th className="py-2.5 px-3 text-right">WARTOŚĆ POZYCJI</th>
                <th className="py-2.5 px-3 text-right">ZYSK / STRATA</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
              {positions.map((p) => {
                // Brak liczby od brokera to nie jest zysk 0 USD i nie jest
                // wzrost - tabela pokazywala wtedy zielone "+$0.00 +0.00%".
                const zysk = p.profit_close;
                const isPos = zysk !== null && zysk >= 0;
                const profitPct =
                  zysk !== null && p.open_bal !== null && p.open_bal > 0
                    ? (zysk / p.open_bal) * 100
                    : null;
                const kwota = (wartosc: number | null): string =>
                  wartosc === null ? '—' : `${formatLiczba(wartosc)} ${p.curr || '—'}`;
                const cleanTicker = p.i.replace(/\.(US|PL|EU)$/, '');

                return (
                  <tr
                    key={p.acc_pos_id || p.i}
                    {...klikalny(() => onSelectTicker?.(cleanTicker), { wiersz: true })}
                    className="hover:bg-blue-50/30 dark:hover:bg-blue-950/20 transition-colors cursor-pointer"
                  >
                    <td className="py-3 px-3">
                      <div className="font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                        <span>{p.i}</span>
                        <span className="text-[9px] px-1 py-0.2 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 font-normal">
                          #{p.acc_pos_id}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-500 font-sans truncate max-w-[200px]">
                        {p.name}
                      </div>
                    </td>

                    <td className="py-3 px-3 text-right font-bold text-slate-800 dark:text-slate-200">
                      {p.q === null ? 'ilość nieznana' : `${p.q} szt.`}
                    </td>

                    <td className="py-3 px-3 text-right text-slate-600 dark:text-slate-300">
                      {kwota(p.bal_price_a)}
                    </td>

                    <td className="py-3 px-3 text-right font-bold text-slate-900 dark:text-white">
                      {kwota(p.mkt_price)}
                    </td>

                    <td className="py-3 px-3 text-right font-bold text-slate-900 dark:text-white">
                      {p.market_value === null
                        ? '—'
                        : `${p.market_value.toLocaleString('pl-PL', { minimumFractionDigits: 2 })} ${p.curr || '—'}`}
                    </td>

                    <td className="py-3 px-3 text-right">
                      <div
                        className={`font-bold ${
                          zysk === null
                            ? 'text-slate-400'
                            : isPos
                              ? 'text-emerald-700 dark:text-emerald-400'
                              : 'text-rose-700 dark:text-rose-400'
                        }`}
                      >
                        {zysk === null ? 'brak danych' : `${isPos ? '+' : ''}${formatLiczba(zysk)} ${p.curr || '—'}`}
                      </div>
                      <div
                        className={`text-[10px] ${
                          profitPct === null
                            ? 'text-slate-400'
                            : isPos
                              ? 'text-emerald-500'
                              : 'text-rose-500'
                        }`}
                      >
                        {profitPct === null ? '—' : `${isPos ? '+' : ''}${formatLiczba(profitPct)}%`}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Freedom24 CPS History & PDF Documents Modal */}
      <Freedom24CpsModal isOpen={showCpsModal} onClose={() => setShowCpsModal(false)} />
    </div>
  );
};
