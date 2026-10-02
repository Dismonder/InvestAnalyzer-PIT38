import React, { useState, useEffect } from 'react';
import { Globe, Clock, ChevronDown, ChevronUp, RefreshCw, ShieldCheck, Activity } from 'lucide-react';
import { Freedom24MarketInfo, marketStatusService } from '../services/marketStatusService';

interface MarketStatusBarProps {
  apiKey?: string;
  apiSecret?: string;
}

export const MarketStatusBar: React.FC<MarketStatusBarProps> = ({ apiKey, apiSecret }) => {
  const [markets, setMarkets] = useState<Freedom24MarketInfo[]>(() => {
    return marketStatusService.getCachedStatus().markets;
  });
  const [zrodlo, setZrodlo] = useState<'freedom24' | 'zegar-lokalny' | undefined>(
    () => marketStatusService.getCachedStatus().zrodlo
  );
  const [isExpanded, setIsExpanded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string>('');
  const [nieaktualne, setNieaktualne] = useState(true);

  const refreshStatus = async () => {
    setIsLoading(true);
    const data = await marketStatusService.fetchMarketStatuses(apiKey, apiSecret);
    if (data && data.markets) {
      setMarkets(data.markets);
      setZrodlo(data.zrodlo);
      setNieaktualne(Boolean(data.nieaktualne));
      setLastUpdated(data.odczytanoO ? new Date(data.odczytanoO).toLocaleTimeString('pl-PL') : '');
    }
    setIsLoading(false);
  };

  useEffect(() => {
    // Odswiezanie co minute tylko przy widocznej karcie: w tle kazdy tik byl
    // zapytaniem do API brokera, ktorego wyniku nikt nie ogladal. Po powrocie
    // na karte status jest pobierany od razu, jesli minela juz minuta.
    const OKRES_MS = 60000;
    let ostatnieOdswiezenie = 0;
    const odswiez = () => {
      ostatnieOdswiezenie = Date.now();
      void refreshStatus();
    };
    const ukryta = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
    odswiez();
    const interval = setInterval(() => {
      if (!ukryta()) odswiez();
    }, OKRES_MS);
    const poPowrocie = () => {
      if (!ukryta() && Date.now() - ostatnieOdswiezenie >= OKRES_MS) odswiez();
    };
    document.addEventListener('visibilitychange', poPowrocie);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', poPowrocie);
    };
  }, [apiKey, apiSecret]);

  const getStatusBadge = (status: Freedom24MarketInfo['s']) => {
    // Brak statusu wpadal wczesniej w galaz `default` i byl pokazywany jako
    // "ZAMKNIĘTE" - twierdzenie o rynku, ktorego nikt nie sprawdzil.
    if (!status) {
      return {
        label: 'NIEZNANE',
        bg: 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20',
        dot: 'bg-slate-400',
      };
    }
    switch (status) {
      case 'OPEN':
        return {
          label: 'OTWARTE',
          bg: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20',
          dot: 'bg-emerald-500 animate-pulse',
        };
      case 'PRE_MARKET':
        return {
          label: 'PRE-MARKET',
          bg: 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20',
          dot: 'bg-amber-500',
        };
      case 'AFTER_HOURS':
        return {
          label: 'AFTER-HOURS',
          bg: 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-400 border-indigo-500/20',
          dot: 'bg-indigo-500',
        };
      case 'WEEKEND':
        return {
          label: 'WEEKEND',
          bg: 'bg-purple-500/10 text-purple-700 dark:text-purple-400 border-purple-500/20',
          dot: 'bg-purple-400',
        };
      case 'CLOSE':
      default:
        return {
          label: 'ZAMKNIĘTE',
          bg: 'bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/20',
          dot: 'bg-rose-400',
        };
    }
  };

  // Primary highlight markets for collapsed bar
  const highlightMarkets = markets.filter((m) =>
    ['FIX', 'WSE', 'EU', 'CRPT'].includes(m.n2)
  );

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white/70 dark:bg-slate-900/70 backdrop-blur-xs shadow-2xs overflow-hidden transition-all">
      {/* Top compact ticker bar */}
      <div className="px-3 sm:px-4 py-2 flex items-center justify-between gap-2 flex-wrap">
        {/* min-w-0 + truncate: na 360 px dlugi tytul wypychal przycisk rozwijania do drugiego wiersza. */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="p-1 rounded-md bg-blue-100 dark:bg-blue-950 text-blue-600 dark:text-blue-400 shrink-0">
            <Globe className="w-3.5 h-3.5" />
          </span>
          <span className="font-bold text-[11px] sm:text-xs text-slate-800 dark:text-slate-200 truncate">
            Sesje Giełdowe {nieaktualne ? '— status nieaktualny / nieznany' : 'Live'}
          </span>
          {/* Napis "Freedom24 / Tradernet API" wisial tu takze wtedy, gdy statusy
              byly policzone z zegara tej maszyny i wpisanych w kod godzin sesji. */}
          <span
            className="text-[10px] text-slate-400 hidden md:inline font-mono"
            title={
              nieaktualne ? 'Ostatni odczyt z pamięci; bieżący stan rynku nie jest znany.' : zrodlo === 'freedom24'
                ? 'Statusy odczytane z Freedom24 / Tradernet.'
                : 'Statusy wyliczone lokalnie z godzin sesji wpisanych w aplikację — Freedom24 ich nie potwierdziło.'
            }
          >
            {nieaktualne ? '(nieaktualne)' : zrodlo === 'freedom24'
              ? '(Freedom24 / Tradernet API)'
              : '(wyliczone lokalnie, nie z API brokera)'}
          </span>
        </div>

        {/* Highlight Pills */}
        <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
          {highlightMarkets.map((m) => {
            const badge = getStatusBadge(nieaktualne ? undefined : m.s);
            return (
              <div
                key={m.n2}
                className={`px-2 py-0.5 rounded-lg text-[10px] sm:text-[11px] font-semibold border flex items-center gap-1.5 ${badge.bg}`}
              >
                <span>{m.flag}</span>
                <span className="font-mono">{m.n2}</span>
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${badge.dot}`} />
                <span className="font-mono text-[9px] uppercase tracking-wide">{badge.label}</span>
              </div>
            );
          })}

          <button
            type="button"
            onClick={() => setIsExpanded(!isExpanded)}
            className="min-h-9 min-w-9 justify-center px-1 text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer flex items-center gap-0.5"
            title="Rozwiń pełną listę rynków"
            aria-label={isExpanded ? 'Zwiń listę rynków' : 'Rozwiń pełną listę rynków'}
          >
            <span className="text-[10px] hidden sm:inline font-medium">
              {isExpanded ? 'Zwiń' : 'Wszystkie rynki'}
            </span>
            {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* Expanded grid of all global markets */}
      {isExpanded && (
        <div className="p-3 sm:p-4 border-t border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/40 space-y-3 animate-in fade-in">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <div className="flex items-center gap-1.5 font-medium">
              <Clock className="w-3.5 h-3.5 text-blue-500" />
              <span>Harmonogram i status operacyjny giełd światowych</span>
            </div>
            <button
              type="button"
              onClick={refreshStatus}
              disabled={isLoading}
              className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1 cursor-pointer"
            >
              <RefreshCw className={`w-3 h-3 ${isLoading ? 'animate-spin' : ''}`} />
              <span>Odśwież {lastUpdated && `(odczyt ${lastUpdated})`}</span>
            </button>
          </div>

          {markets.length === 0 && (
            <div className="p-2.5 rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/50 text-amber-800 dark:text-amber-200 text-[11px]">
              Brak danych o sesjach giełdowych — serwer aplikacji nie odpowiedział, a nic nie
              zostało wcześniej zapamiętane. Naciśnij „Odśwież".
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {markets.map((m) => {
              const badge = getStatusBadge(nieaktualne ? undefined : m.s);
              return (
                <div
                  key={m.n2}
                  className="p-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex items-center justify-between"
                >
                  <div className="min-w-0 pr-2">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm">{m.flag || '🏛️'}</span>
                      <span className="font-bold text-xs text-slate-900 dark:text-white font-mono">
                        {m.n2}
                      </span>
                      <span className="text-[10px] text-slate-400 truncate max-w-[120px]" title={m.n}>
                        {m.n}
                      </span>
                    </div>
                    <div className="text-[10px] text-slate-500 mt-0.5 flex items-center gap-2 font-mono">
                      <span>Godziny: {m.o && m.c ? `${m.o} - ${m.c}` : 'nieznane'}</span>
                    </div>
                  </div>

                  <div className={`px-2 py-0.5 rounded-md text-[10px] font-bold border flex items-center gap-1 shrink-0 ${badge.bg}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${badge.dot}`} />
                    <span>{badge.label}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
