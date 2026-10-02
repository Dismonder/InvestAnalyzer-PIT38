import React, { useState, useEffect } from 'react';
import { X, Layers, Calendar, ShieldCheck, RefreshCw } from 'lucide-react';
import { freedom24ExtendedService } from '../services/freedom24ExtendedService';
import { useZamknijEscape } from '../../shared/useZamknijEscape';
import { strikeAtm } from '../services/strikeAtm';
import { formatLiczba } from '../services/nbpService';

// Freedom24 podaje w lancuchu opcji tylko kontrakty (strike, termin, typ) - bez premii
// i wspolczynnikow. Brak liczby to "—", a nie wyjatek na .toFixed() ani "null%".
const znana = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
// Polski zapis jak w reszcie aplikacji ("150,00", "25,5%"), nie "$150.00".
const cenaOpcji = (v: number | null | undefined) => (znana(v) ? formatLiczba(v) : '—');
const procentOpcji = (v: number | null | undefined) =>
  znana(v) ? `${v.toLocaleString('pl-PL', { maximumFractionDigits: 2 })}%` : '—';
const deltaOpcji = (v: number | null | undefined) =>
  znana(v) ? `${v > 0 ? '+' : ''}${v.toLocaleString('pl-PL', { maximumFractionDigits: 3 })}` : '—';

interface Freedom24OptionsModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialTicker?: string;
  /** Notowanie znane ekranowi - jedyne zrodlo ceny bazowej poza brokerem. */
  cenaBazowa?: number | null;
}

export const Freedom24OptionsModal: React.FC<Freedom24OptionsModalProps> = ({
  isOpen,
  onClose,
  initialTicker = 'AAPL',
  cenaBazowa = null,
}) => {
  const [ticker, setTicker] = useState(initialTicker);
  const [selectedExp, setSelectedExp] = useState<string>('');
  const [optionsData, setOptionsData] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (initialTicker) {
      setTicker(initialTicker);
    }
  }, [initialTicker]);

  const loadOptions = async (t: string, exp?: string) => {
    setIsLoading(true);
    // Cena bazowa dotyczy wylacznie instrumentu, z ktorego otwarto modal.
    // Po przelaczeniu tickera wewnatrz modala nie wolno jej przeniesc - inaczej
    // SPY dostaje cene NVDA i lancuch strike'ow wokol cudzej wartosci.
    const data = await freedom24ExtendedService.fetchOptionsChain(
      t,
      exp,
      undefined,
      undefined,
      t === initialTicker ? cenaBazowa : null
    );
    if (data) {
      setOptionsData(data);
      if (!exp && data.expirationDates?.length > 0) {
        setSelectedExp(data.selectedExpiration || data.expirationDates[0]);
      }
    }
    setIsLoading(false);
  };

  useEffect(() => {
    if (isOpen) {
      loadOptions(ticker, selectedExp || undefined);
    }
  }, [ticker, selectedExp, isOpen, cenaBazowa]);

  const refOkna = useZamknijEscape(isOpen, onClose);
  if (!isOpen) return null;

  // Bez odpowiedzi nie ma ceny instrumentu bazowego. Wpisane tu 150,00 USD
  // wygladalo jak notowanie i szlo do wykresu wraz z premiami liczonymi od
  // tej wartosci.
  const underlyingPrice = optionsData?.underlyingPrice ?? null;
  const danePogladowe = Boolean(optionsData?.demoData);
  const powodPogladowych = optionsData?.demoReason as string | undefined;
  const contracts = optionsData?.contracts || [];
  const atm = strikeAtm(contracts.map((c: any) => c.strike), underlyingPrice);
  const expDates = optionsData?.expirationDates || [];

  return (
    <div ref={refOkna} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Łańcuch Opcji Giełdowych (Freedom24 Options Chain)" className="outline-none fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/70 backdrop-blur-xs animate-in fade-in duration-200">
      <div className="relative w-full max-w-5xl max-h-[92vh] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-4 sm:p-5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50/70 dark:bg-slate-900/70">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-purple-500/10 text-purple-500 border border-purple-500/20">
              <Layers className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base sm:text-lg font-bold text-slate-900 dark:text-white">
                  Łańcuch Opcji Giełdowych (Freedom24 Options Chain)
                </h2>
                <span className="text-xs px-2.5 py-0.5 rounded-full bg-purple-100 dark:bg-purple-950 text-purple-700 dark:text-purple-300 font-semibold font-mono">
                  {ticker} •{' '}
                  {underlyingPrice !== null
                    ? `${formatLiczba(underlyingPrice)} USD${danePogladowe ? ' (przyjęta)' : ''}`
                    : 'brak ceny'}
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Notowania kontraktów CALL & PUT, zmienność implikowana (IV), greka Delta i punkty Break-Even
              </p>
              {danePogladowe && (
                // Bez tej informacji lancuch policzony ze wzoru wygladal
                // identycznie jak notowania z arkusza zlecen.
                <p className="text-xs text-amber-600 dark:text-amber-400 mt-1 font-semibold">
                  {powodPogladowych || 'Dane poglądowe, nie z giełdy.'}
                </p>
              )}
            </div>
          </div>

          <button
            aria-label="Zamknij"
            onClick={onClose}
            className="p-2 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Controls: Ticker Selector & Expiration Pills */}
        <div className="px-4 sm:px-6 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between gap-3 flex-wrap bg-slate-50/40 dark:bg-slate-900/40">
          {/* Quick ticker buttons */}
          <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none">
            <span className="text-xs text-slate-400 font-medium mr-1">Spółka:</span>
            {['AAPL', 'NVDA', 'TSLA', 'MSFT', 'SPY', 'QQQ', 'PLTR', 'FRHC'].map((sym) => (
              <button
                key={sym}
                onClick={() => setTicker(sym)}
                className={`px-2.5 py-1 text-xs font-mono font-bold rounded-lg transition-all cursor-pointer ${
                  ticker === sym
                    ? 'bg-purple-600 text-white shadow-xs'
                    : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-750'
                }`}
              >
                {sym}
              </button>
            ))}
          </div>

          {/* Expiration date pills */}
          <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none">
            <span className="text-xs text-slate-400 font-medium mr-1 flex items-center gap-1">
              <Calendar className="w-3.5 h-3.5" />
              <span>Wygasanie:</span>
            </span>
            {expDates.map((d: string) => (
              <button
                key={d}
                onClick={() => setSelectedExp(d)}
                className={`px-2.5 py-1 text-xs font-mono rounded-lg transition-all cursor-pointer ${
                  selectedExp === d
                    ? 'bg-blue-600 text-white font-bold shadow-xs'
                    : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-750'
                }`}
              >
                {d}
              </button>
            ))}
          </div>
        </div>

        {/* Options Chain Table (CALLS | STRIKE | PUTS) */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5">
          {isLoading ? (
            <div className="py-16 text-center text-slate-400 text-xs flex flex-col items-center justify-center gap-2">
              <RefreshCw className="w-5 h-5 text-purple-500 animate-spin" />
              <span>Ładowanie łańcucha opcji z Tradernet API...</span>
            </div>
          ) : contracts.length === 0 ? (
            // Serwer odmawia zbudowania lancucha, gdy nie zna ceny instrumentu
            // bazowego. Wczesniej podstawial 150 USD i tabela powstawala mimo to.
            <div className="py-16 px-6 text-center text-sm text-amber-700 dark:text-amber-300">
              {optionsData?.message ||
                'Nie udało się pobrać łańcucha opcji dla tego instrumentu.'}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs font-mono">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-700 text-slate-500">
                    <th colSpan={4} className="py-2 px-3 text-center bg-emerald-50/50 dark:bg-emerald-950/20 text-emerald-700 dark:text-emerald-300 font-bold border-r border-slate-200 dark:border-slate-700">
                      OPCJE CALL (Wzrostowe)
                    </th>
                    <th className="py-2 px-4 text-center bg-slate-100 dark:bg-slate-800 font-bold text-slate-900 dark:text-white">
                      STRIKE
                    </th>
                    <th colSpan={4} className="py-2 px-3 text-center bg-rose-50/50 dark:bg-rose-950/20 text-rose-700 dark:text-rose-300 font-bold border-l border-slate-200 dark:border-slate-700">
                      OPCJE PUT (Spadkowe / Zabezpieczające)
                    </th>
                  </tr>
                  <tr className="border-b border-slate-200 dark:border-slate-800 text-[10px] text-slate-400 bg-slate-50/60 dark:bg-slate-950/40">
                    <th className="py-1.5 px-2 text-right">BID (USD)</th>
                    <th className="py-1.5 px-2 text-right">ASK (USD)</th>
                    <th className="py-1.5 px-2 text-right">IV (%)</th>
                    <th className="py-1.5 px-2 text-right border-r border-slate-200 dark:border-slate-700">DELTA</th>
                    <th className="py-1.5 px-4 text-center">CENA WYKONANIA (USD)</th>
                    <th className="py-1.5 px-2 text-left border-l border-slate-200 dark:border-slate-700">DELTA</th>
                    <th className="py-1.5 px-2 text-left">IV (%)</th>
                    <th className="py-1.5 px-2 text-left">BID (USD)</th>
                    <th className="py-1.5 px-2 text-left">ASK (USD)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                  {contracts.map((c: any) => {
                    // Bez ceny instrumentu bazowego nie da sie powiedziec,
                    // ktory kontrakt jest w pieniadzu.
                    const isCallITM = underlyingPrice !== null && underlyingPrice >= c.strike;
                    const isPutITM = underlyingPrice !== null && underlyingPrice <= c.strike;
                    const isATM = atm !== null && c.strike === atm;

                    return (
                      <tr
                        key={c.strike}
                        className={`hover:bg-blue-50/30 dark:hover:bg-blue-950/20 transition-colors ${
                          isATM ? 'bg-amber-50/30 dark:bg-amber-950/20 font-bold' : ''
                        }`}
                      >
                        {/* CALL side */}
                        <td className={`py-2 px-2 text-right ${isCallITM ? 'bg-emerald-50/30 dark:bg-emerald-950/10 text-emerald-600 dark:text-emerald-400 font-bold' : 'text-slate-600 dark:text-slate-400'}`}>
                          {cenaOpcji(c.callBid)}
                        </td>
                        <td className={`py-2 px-2 text-right ${isCallITM ? 'bg-emerald-50/30 dark:bg-emerald-950/10 text-emerald-700 dark:text-emerald-300 font-bold' : 'text-slate-700 dark:text-slate-300'}`}>
                          {cenaOpcji(c.callAsk)}
                        </td>
                        <td className="py-2 px-2 text-right text-slate-400 text-[10px]">
                          {procentOpcji(c.callIV)}
                        </td>
                        <td className="py-2 px-2 text-right text-slate-500 border-r border-slate-200 dark:border-slate-700">
                          {deltaOpcji(c.callDelta)}
                        </td>

                        {/* Strike Center Column */}
                        <td className="py-2 px-4 text-center font-bold text-slate-900 dark:text-white bg-slate-50/80 dark:bg-slate-800/80">
                          <span className={isATM ? 'px-2 py-0.5 rounded bg-amber-100 dark:bg-amber-900 text-amber-800 dark:text-amber-200' : ''}>
                            {formatLiczba(c.strike)}
                          </span>
                        </td>

                        {/* PUT side */}
                        <td className="py-2 px-2 text-left text-slate-500 border-l border-slate-200 dark:border-slate-700">
                          {deltaOpcji(c.putDelta)}
                        </td>
                        <td className="py-2 px-2 text-left text-slate-400 text-[10px]">
                          {procentOpcji(c.putIV)}
                        </td>
                        <td className={`py-2 px-2 text-left ${isPutITM ? 'bg-rose-50/30 dark:bg-rose-950/10 text-rose-600 dark:text-rose-400 font-bold' : 'text-slate-600 dark:text-slate-400'}`}>
                          {cenaOpcji(c.putBid)}
                        </td>
                        <td className={`py-2 px-2 text-left ${isPutITM ? 'bg-rose-50/30 dark:bg-rose-950/10 text-rose-700 dark:text-rose-300 font-bold' : 'text-slate-700 dark:text-slate-300'}`}>
                          {cenaOpcji(c.putAsk)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-3 sm:p-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-900/80 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <ShieldCheck className="w-4 h-4 text-emerald-500 shrink-0" />
            {/* Stopka mowila "zintegrowane z protokolem Freedom24" takze wtedy,
                gdy lancuch byl policzony na miejscu - obok czerwonego
                ostrzezenia, ze jest pogladowy. */}
            <span>
              {contracts.length === 0
                ? 'Brak łańcucha do pokazania.'
                : danePogladowe
                ? 'Łańcuch wyliczony lokalnie — Freedom24 nie oddał danych opcyjnych.'
                : 'Dane łańcucha opcji z protokołu Freedom24 / Tradernet API.'}
            </span>
          </div>

          <button
            onClick={onClose}
            className="px-5 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs sm:text-sm font-semibold transition-all shadow-sm cursor-pointer"
          >
            Zamknij
          </button>
        </div>
      </div>
    </div>
  );
};
