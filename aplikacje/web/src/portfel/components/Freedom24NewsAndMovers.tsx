import React, { useState, useEffect } from 'react';
import { formatLiczba } from '../services/nbpService';
import { klikalny } from '../../shared/klikalny';
import { Newspaper, TrendingUp, TrendingDown, RefreshCw, ExternalLink, Flame, Sparkles } from 'lucide-react';
import { freedom24ExtendedService, ostatnieDanePogladowe, Freedom24NewsItem, Freedom24TopSecurity } from '../services/freedom24ExtendedService';

interface Freedom24NewsAndMoversProps {
  onSelectTicker?: (ticker: string) => void;
  /** Tickery otwartych pozycji - dla nich pobierane sa osobne depesze. */
  heldTickers?: string[];
}

export const Freedom24NewsAndMovers: React.FC<Freedom24NewsAndMoversProps> = ({ onSelectTicker, heldTickers = [] }) => {
  const [news, setNews] = useState<Freedom24NewsItem[]>([]);
  const [movers, setMovers] = useState<Freedom24TopSecurity[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'MOVERS' | 'NEWS' | 'MINE'>('NEWS');
  const [newsByTicker, setNewsByTicker] = useState<Record<string, Freedom24NewsItem[]>>({});
  const kluczTickerow = [...heldTickers].sort().join(',');

  const [powodDanychPogladowych, setPowodDanychPogladowych] = useState<string | null>(null);

  const loadData = async () => {
    setIsLoading(true);
    const [newsData, moversData] = await Promise.all([
      freedom24ExtendedService.fetchNewsFeed(12, heldTickers),
      freedom24ExtendedService.fetchTopSecurities('gainers'),
    ]);
    setNews(newsData.news);
    setNewsByTicker(newsData.newsByTicker);
    setMovers(moversData);
    // Zaszyta lista wygladala jak biezacy ranking sesji i biezace depesze.
    // Podpisujemy ja, zamiast liczyc na to, ze uzytkownik sie domysli.
    setPowodDanychPogladowych(
      newsData.problem || ostatnieDanePogladowe.topSecurities || null
    );
    setIsLoading(false);
  };

  useEffect(() => {
    loadData();
    // Nowa pozycja w portfelu = nowe depesze do pobrania.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kluczTickerow]);

  // "Moje spółki": depesze wszystkich posiadanych walorow, bez powtorzen, od najnowszej.
  const depeszeMoichSpolek = [...new Map(Object.values(newsByTicker).flat().map((d) => [d.id, d])).values()].sort((a, b) =>
    b.date.localeCompare(a.date),
  );
  const widoczneDepesze = activeTab === 'MINE' ? depeszeMoichSpolek : news;

  return (
    <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs overflow-hidden">
      {powodDanychPogladowych && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-[11px] font-semibold text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          {powodDanychPogladowych}
        </div>
      )}
      {/* Header */}
      <div className="p-4 sm:p-5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between gap-3 flex-wrap bg-slate-50/50 dark:bg-slate-900/50">
        <div className="flex items-center gap-2">
          <div className="p-2 rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
            <Flame className="w-4 h-4" />
          </div>
          <div>
            <h3 className="font-bold text-sm text-slate-900 dark:text-white flex items-center gap-2">
              <span>Rynek & Informacje Freedom24 (Tradernet API)</span>
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Najnowsze wiadomości, wiadomości o spółkach z Twojego portfela i liderzy sesji USA
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Tab buttons */}
          <div className="inline-flex p-1 rounded-xl bg-slate-100 dark:bg-slate-800 border border-slate-200/80 dark:border-slate-700/80">
            {([
              ['NEWS', 'Najnowsze'],
              ['MINE', `Moje spółki${heldTickers.length > 0 ? ` (${heldTickers.length})` : ''}`],
              ['MOVERS', 'Liderzy wzrostów'],
            ] as const).map(([klucz, etykieta]) => (
              <button
                key={klucz}
                onClick={() => setActiveTab(klucz)}
                className={`px-3 py-1 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
                  activeTab === klucz
                    ? 'bg-blue-600 text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                {etykieta}
              </button>
            ))}
          </div>

          <button
            onClick={loadData}
            disabled={isLoading}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
            title="Odśwież dane z Tradernet API"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="p-4 sm:p-5">
        {!isLoading && (activeTab === 'MOVERS' ? movers.length === 0 : widoczneDepesze.length === 0) ? (
          <div className="rounded-xl border border-dashed border-slate-300 px-4 py-6 text-center text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">
            {activeTab === 'MINE' && heldTickers.length === 0
              ? 'Nie masz otwartych pozycji, więc nie ma spółek, o których pobrać wiadomości.'
              : activeTab === 'MOVERS'
                ? 'Freedom24 nie zwróciło rankingu sesji albo żadna spółka z rankingu nie ma notowania.'
                : 'Freedom24 nie zwróciło wiadomości dla tego widoku.'}
          </div>
        ) : activeTab === 'MOVERS' ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
            {movers.map((m) => {
              const isPos = m.changePercent >= 0;
              return (
                <div
                  key={m.ticker}
                  {...klikalny(() => onSelectTicker?.(m.ticker))}
                  className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/40 hover:border-blue-400 dark:hover:border-blue-700 cursor-pointer transition-all group"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-xs font-mono text-slate-900 dark:text-white group-hover:text-blue-600 dark:group-hover:text-blue-400">
                      {m.ticker}
                    </span>
                    <span className="text-[9px] px-1 py-0.2 rounded bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400 font-mono">
                      {m.currency}
                    </span>
                  </div>

                  <div className="mt-1 text-sm font-bold font-mono text-slate-900 dark:text-white">
                    {formatLiczba(m.price)}
                  </div>

                  <div
                    className={`mt-1 text-[11px] font-semibold flex items-center gap-0.5 ${
                      isPos ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'
                    }`}
                  >
                    {isPos ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                    <span>
                      {isPos ? '+' : ''}
                      {formatLiczba(m.changePercent)}%
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="space-y-3">
            {widoczneDepesze.map((item) => (
              <div
                key={`${activeTab}:${item.id}`}
                className="p-3 rounded-xl border border-slate-200/80 dark:border-slate-800 bg-slate-50/40 dark:bg-slate-950/30 flex flex-col sm:flex-row sm:items-center justify-between gap-2"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-300 font-mono">
                      {item.source}
                    </span>
                    <span className="text-[11px] text-slate-400">
                      {item.date ? new Date(item.date.replace(' ', 'T')).toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}
                    </span>
                    {item.tickers.map((t) => (
                      <button
                        key={t}
                        onClick={() => onSelectTicker && onSelectTicker(t)}
                        className="text-[10px] font-bold font-mono px-1.5 py-0.2 rounded bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-300 hover:underline cursor-pointer"
                      >
                        ${t}
                      </button>
                    ))}
                  </div>
                  <h4 className="font-bold text-xs sm:text-sm text-slate-900 dark:text-white">
                    {item.url ? (
                      <a href={item.url} target="_blank" rel="noopener noreferrer" className="hover:underline">
                        {item.title}
                      </a>
                    ) : (
                      item.title
                    )}
                  </h4>
                  {item.summary && <p className="text-xs text-slate-500 dark:text-slate-400">{item.summary}</p>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
