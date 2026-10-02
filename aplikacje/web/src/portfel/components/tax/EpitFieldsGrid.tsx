import React from 'react';
import { odmienLiczebnik } from '../../services/odmianaLiczebnika';
import { ChevronRight, Copy, Check } from 'lucide-react';
import { formatCurrency } from '../../services/nbpService';
import type { TaxYearSummary } from '../../types';

interface EpitFieldsGridProps {
  currentSummary: TaxYearSummary;
  transactionCount: number;
  kwota: (value: number | null | undefined) => string;
  kwotaDoDeklaracji: (value: number | null | undefined) => string;
  pit8cZInformacji: boolean;
  pit8cZnacznik: string;
  pit8cRozjazdPrzychodu: number | null;
  pit8cRozjazdKosztow: number | null;
  onOpenFifoDetails: () => void;
  copiedField: string | null;
  handleCopy: (fieldKey: string, value: number) => void;
  /** Powod blokady kopiowania pol deklaracji (rozliczenie niegotowe); brak = kopiowanie dozwolone. */
  kopiowanieZablokowane?: string;
}

export const wartoscDoSkopiowania = (wartosc: number | null | undefined): number | null =>
  typeof wartosc === 'number' && Number.isFinite(wartosc) ? wartosc : null;

export const EpitFieldsGrid: React.FC<EpitFieldsGridProps> = ({
  currentSummary,
  transactionCount,
  kwota,
  kwotaDoDeklaracji,
  pit8cZInformacji,
  pit8cZnacznik,
  pit8cRozjazdPrzychodu,
  pit8cRozjazdKosztow,
  onOpenFifoDetails,
  copiedField,
  handleCopy,
  kopiowanieZablokowane,
}) => (
    <div className="space-y-6 animate-in fade-in duration-150">
      {/* OFFICIAL POLISH PIT-38 SECTION C MAPPING BOX */}
      <div className="bg-white dark:bg-slate-900 p-5 sm:p-6 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-slate-100 dark:border-slate-800 gap-2">
          <div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h2 className="text-base sm:text-lg font-bold text-slate-900 dark:text-white">
                Pola Formularza PIT-38 (Część C i Część D)
              </h2>
              <span className="text-[11px] px-2.5 py-0.5 rounded-full bg-blue-50 dark:bg-blue-950/80 text-blue-600 dark:text-blue-400 font-mono font-semibold border border-blue-200/80 dark:border-blue-800/60">
                {kopiowanieZablokowane ? 'Wartości robocze — rozliczenie niegotowe' : 'Twój e-PIT Gotowe do Skopiowania'}
              </span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              {kopiowanieZablokowane
                ? 'Kopiowanie jest wyłączone, dopóki silnik zgłasza blokady rozliczenia albo wynik jest nieaktualny.'
                : 'Kliknij przycisk „Kopiuj” pod wybranym polem, aby wkleić wartość bezpośrednio do formularza na podatki.gov.pl'}
            </p>
          </div>

          <button
            onClick={onOpenFifoDetails}
            className="flex items-center gap-1.5 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline cursor-pointer self-start sm:self-auto"
          >
            <span>Szczegóły dopasowań FIFO ({transactionCount} {odmienLiczebnik(transactionCount, 'transakcja', 'transakcje', 'transakcji')})</span>
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        {/* High-Contrast Value Tiles for PIT-38 Part C (Foreign & Domestic) */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
          {/* Poz. 22 - Foreign Broker Revenue (Freedom24, IBKR, Revolut) */}
          <div className="p-3.5 rounded-xl bg-blue-50/50 dark:bg-blue-950/30 border border-blue-200/80 dark:border-blue-800/80 flex flex-col justify-between space-y-2">
            <div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
                <span className="text-[11px] font-bold whitespace-nowrap text-blue-600 dark:text-blue-400">POZ. 22</span>
                <span className="text-[9px] text-blue-700 dark:text-blue-400 font-mono">Zagranica / Inne</span>
              </div>
              <div className="text-[11px] font-medium text-slate-700 dark:text-slate-300 mt-1">Przychód (Freedom24/IBKR)</div>
              <div className="mt-1 text-base font-bold text-slate-900 dark:text-white font-mono">
                {kwotaDoDeklaracji(currentSummary.foreignRevenuePLN ?? (pit8cZInformacji ? undefined : currentSummary.revenuePLN))}
              </div>
            </div>
            <button
              onClick={() => { if (currentSummary.foreignRevenuePLN !== undefined || !pit8cZInformacji) handleCopy('pole22', currentSummary.foreignRevenuePLN ?? currentSummary.revenuePLN); }}
              disabled={(pit8cZInformacji && currentSummary.foreignRevenuePLN === undefined) || Boolean(kopiowanieZablokowane)}
              title={kopiowanieZablokowane}
              className="w-full py-1.5 px-2 rounded-lg bg-white dark:bg-slate-800 border border-blue-200 dark:border-blue-700 text-xs font-semibold text-blue-700 dark:text-blue-300 hover:bg-blue-50 flex items-center justify-center gap-1 cursor-pointer transition-colors shadow-2xs disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {copiedField === 'pole22' ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
              <span>{copiedField === 'pole22' ? 'Skopiowano!' : 'Kopiuj poz. 22'}</span>
            </button>
          </div>

          {/* Poz. 23 - Foreign Broker Costs (Freedom24, IBKR, Revolut) */}
          <div className="p-3.5 rounded-xl bg-amber-50/50 dark:bg-amber-950/30 border border-amber-200/80 dark:border-amber-800/80 flex flex-col justify-between space-y-2">
            <div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
                <span className="text-[11px] font-bold whitespace-nowrap text-amber-700 dark:text-amber-400">POZ. 23</span>
                <span className="text-[9px] text-amber-700 dark:text-amber-400 font-mono">Zagranica / Inne</span>
              </div>
              <div className="text-[11px] font-medium text-slate-700 dark:text-slate-300 mt-1">Koszty KUP (Freedom24/IBKR)</div>
              <div className="mt-1 text-base font-bold text-slate-900 dark:text-white font-mono">
                {kwotaDoDeklaracji(currentSummary.foreignCostsPLN ?? (pit8cZInformacji ? undefined : currentSummary.costsPLN))}
              </div>
            </div>
            <button
              onClick={() => { if (currentSummary.foreignCostsPLN !== undefined || !pit8cZInformacji) handleCopy('pole23', currentSummary.foreignCostsPLN ?? currentSummary.costsPLN); }}
              disabled={(pit8cZInformacji && currentSummary.foreignCostsPLN === undefined) || Boolean(kopiowanieZablokowane)}
              title={kopiowanieZablokowane}
              className="w-full py-1.5 px-2 rounded-lg bg-white dark:bg-slate-800 border border-amber-200 dark:border-amber-700 text-xs font-semibold text-amber-700 dark:text-amber-300 hover:bg-amber-50 flex items-center justify-center gap-1 cursor-pointer transition-colors shadow-2xs disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {copiedField === 'pole23' ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
              <span>{copiedField === 'pole23' ? 'Skopiowano!' : 'Kopiuj poz. 23'}</span>
            </button>
          </div>

          {/* Poz. 20 - Domestic Broker Revenue (PIT-8C) */}
          <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/80 flex flex-col justify-between space-y-2">
            <div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
                <span className="text-[11px] font-bold whitespace-nowrap text-slate-600 dark:text-slate-400">POZ. 20</span>
                <span
                  className="text-[9px] text-slate-400 font-mono"
                  title={pit8cZInformacji
                    ? 'Kwota przepisana z poz. 35 otrzymanej informacji PIT-8C.'
                    : 'Kwota policzona z transakcji na rachunkach polskich brokerów. Do zeznania wpisuje się kwotę z poz. 35 otrzymanej informacji PIT-8C — wpisz ją w panelu optymalizacji.'}
                >
                  {pit8cZnacznik}
                </span>
              </div>
              <div className="text-[11px] font-medium text-slate-700 dark:text-slate-300 mt-1">Przychód (XTB/mBank)</div>
              <div className="mt-1 text-base font-bold text-slate-900 dark:text-white font-mono">
                {kwotaDoDeklaracji(currentSummary.pit8cRevenuePLN)}
              </div>
              {pit8cRozjazdPrzychodu !== null && (
                <div className="mt-1 text-[10px] leading-snug text-amber-700 dark:text-amber-400">
                  PIT-8C a własny rachunek polski: z transakcji wychodzi {kwota(currentSummary.pit8cWyliczonyPrzychodPLN)} — różnica{' '}
                  {formatCurrency(Math.abs(pit8cRozjazdPrzychodu))}. Urząd porówna tę informację z zeznaniem; sprawdź transakcje.
                </div>
              )}
            </div>
            <button
              onClick={() => { const wartosc = wartoscDoSkopiowania(currentSummary.pit8cRevenuePLN); if (wartosc !== null) handleCopy('pole20', wartosc); }}
              disabled={(wartoscDoSkopiowania(currentSummary.pit8cRevenuePLN) === null) || Boolean(kopiowanieZablokowane)}
              title={kopiowanieZablokowane ?? (wartoscDoSkopiowania(currentSummary.pit8cRevenuePLN) === null ? 'Kwota PIT-8C nie jest ustalona — nie można jej skopiować.' : undefined)}
              className="w-full py-1.5 px-2 rounded-lg bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 flex items-center justify-center gap-1 cursor-pointer transition-colors shadow-2xs disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {copiedField === 'pole20' ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
              <span>{copiedField === 'pole20' ? 'Skopiowano!' : 'Kopiuj poz. 20'}</span>
            </button>
          </div>

          {/* Poz. 21 - Domestic Broker Costs (PIT-8C) */}
          <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/80 flex flex-col justify-between space-y-2">
            <div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
                <span className="text-[11px] font-bold whitespace-nowrap text-slate-600 dark:text-slate-400">POZ. 21</span>
                <span
                  className="text-[9px] text-slate-400 font-mono"
                  title={pit8cZInformacji
                    ? 'Kwota przepisana z poz. 36 otrzymanej informacji PIT-8C.'
                    : 'Kwota policzona z transakcji na rachunkach polskich brokerów. Do zeznania wpisuje się kwotę z poz. 36 otrzymanej informacji PIT-8C — wpisz ją w panelu optymalizacji.'}
                >
                  {pit8cZnacznik}
                </span>
              </div>
              <div className="text-[11px] font-medium text-slate-700 dark:text-slate-300 mt-1">Koszty (XTB/mBank)</div>
              <div className="mt-1 text-base font-bold text-slate-900 dark:text-white font-mono">
                {kwotaDoDeklaracji(currentSummary.pit8cCostsPLN)}
              </div>
              {pit8cRozjazdKosztow !== null && (
                <div className="mt-1 text-[10px] leading-snug text-amber-700 dark:text-amber-400">
                  PIT-8C a własny rachunek polski: z transakcji wychodzi {kwota(currentSummary.pit8cWyliczoneKosztyPLN)} — różnica{' '}
                  {formatCurrency(Math.abs(pit8cRozjazdKosztow))}. Urząd porówna tę informację z zeznaniem; sprawdź koszty.
                </div>
              )}
            </div>
            <button
              onClick={() => { const wartosc = wartoscDoSkopiowania(currentSummary.pit8cCostsPLN); if (wartosc !== null) handleCopy('pole21', wartosc); }}
              disabled={(wartoscDoSkopiowania(currentSummary.pit8cCostsPLN) === null) || Boolean(kopiowanieZablokowane)}
              title={kopiowanieZablokowane ?? (wartoscDoSkopiowania(currentSummary.pit8cCostsPLN) === null ? 'Kwota PIT-8C nie jest ustalona — nie można jej skopiować.' : undefined)}
              className="w-full py-1.5 px-2 rounded-lg bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 flex items-center justify-center gap-1 cursor-pointer transition-colors shadow-2xs disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {copiedField === 'pole21' ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
              <span>{copiedField === 'pole21' ? 'Skopiowano!' : 'Kopiuj poz. 21'}</span>
            </button>
          </div>

          {/* Poz. 28 - dochód razem */}
          <div className="p-3.5 rounded-xl bg-emerald-50/50 dark:bg-emerald-950/30 border border-emerald-200/80 dark:border-emerald-800/80 flex flex-col justify-between space-y-2">
            <div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
                <span className="text-[11px] font-bold whitespace-nowrap text-emerald-700 dark:text-emerald-400">POZ. 28</span>
                <span className="text-[9px] text-emerald-700 dark:text-emerald-400 font-mono">Dochód (Razem)</span>
              </div>
              <div className="text-[11px] font-medium text-slate-700 dark:text-slate-300 mt-1">Łączny Dochód PIT-38</div>
              <div className="mt-1 text-base font-bold text-emerald-700 dark:text-emerald-400 font-mono">
                {kwotaDoDeklaracji(currentSummary.incomePLN)}
              </div>
            </div>
            <button
              onClick={() => handleCopy('poz28kafelek', currentSummary.incomePLN)}
              disabled={Boolean(kopiowanieZablokowane)}
              title={kopiowanieZablokowane}
              className="w-full py-1.5 px-2 rounded-lg bg-white dark:bg-slate-800 border border-emerald-200 dark:border-emerald-700 text-xs font-semibold text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 flex items-center justify-center gap-1 cursor-pointer transition-colors shadow-2xs disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {copiedField === 'poz28kafelek' ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
              <span>{copiedField === 'poz28kafelek' ? 'Skopiowano!' : 'Kopiuj poz. 28'}</span>
            </button>
          </div>

          {/* Poz. 33 - Podatek 19% z papierów */}
          <div className="p-3.5 rounded-xl bg-indigo-50/50 dark:bg-indigo-950/30 border border-indigo-200/80 dark:border-indigo-800/80 flex flex-col justify-between space-y-2">
            <div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
                <span className="text-[11px] font-bold whitespace-nowrap text-indigo-700 dark:text-indigo-300">POZ. 33</span>
                <span className="text-[9px] text-indigo-700 dark:text-indigo-300 font-mono">Podatek 19%</span>
              </div>
              <div className="text-[11px] font-medium text-slate-700 dark:text-slate-300 mt-1">Podatek od dochodu z poz. 31</div>
              <div className="mt-1 text-base font-bold text-indigo-800 dark:text-indigo-300 font-mono">
                {kwotaDoDeklaracji(currentSummary.taxBeforeCreditPLN ?? currentSummary.taxDuePLN)}
              </div>
            </div>
            <button
              onClick={() => handleCopy('pole33', currentSummary.taxBeforeCreditPLN ?? currentSummary.taxDuePLN)}
              disabled={Boolean(kopiowanieZablokowane)}
              title={kopiowanieZablokowane}
              className="w-full py-1.5 px-2 rounded-lg bg-white dark:bg-slate-800 border border-indigo-200 dark:border-indigo-700 text-xs font-semibold text-indigo-700 dark:text-indigo-300 hover:bg-indigo-50 flex items-center justify-center gap-1 cursor-pointer transition-colors shadow-2xs disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {copiedField === 'pole33' ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
              <span>{copiedField === 'pole33' ? 'Skopiowano!' : 'Kopiuj poz. 33'}</span>
            </button>
          </div>
        </div>
      </div>

      {/* CZĘŚĆ E: waluty wirtualne. Pokazujemy ją tylko wtedy, gdy silnik
          faktycznie policzył ten rok — pusta sekcja z zerami sugerowałaby,
          że krypto rozliczono, a w danych go po prostu nie ma. */}
      {currentSummary.cryptoRevenuePLN !== undefined && (
        <div className="mt-5 pt-5 border-t border-slate-200 dark:border-slate-800 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <h3 className="font-bold text-sm text-slate-900 dark:text-white">
                Część E — waluty wirtualne
              </h3>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                Koszt nabycia liczy się w roku poniesienia, bez kolejki FIFO. Wymiana krypto na
                krypto (także na stablecoina) nie jest przychodem.
              </p>
            </div>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-violet-50 dark:bg-violet-950 text-violet-600 dark:text-violet-400 font-semibold font-mono self-start">
              Art. 22 ust. 14–16, art. 30b ust. 1a
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="p-3.5 rounded-xl bg-violet-50/50 dark:bg-violet-950/30 border border-violet-200/80 dark:border-violet-800/80">
              <div className="text-[11px] font-bold text-violet-700 dark:text-violet-300">POZ. 36</div>
              <div className="text-[11px] text-slate-700 dark:text-slate-300 mt-1">Przychód</div>
              <div className="mt-1 text-base font-bold text-violet-800 dark:text-violet-300 font-mono">
                {kwota(currentSummary.cryptoRevenuePLN)}
              </div>
            </div>

            <div className="p-3.5 rounded-xl bg-violet-50/50 dark:bg-violet-950/30 border border-violet-200/80 dark:border-violet-800/80">
              <div className="text-[11px] font-bold text-violet-700 dark:text-violet-300">POZ. 37 + 38</div>
              <div className="text-[11px] text-slate-700 dark:text-slate-300 mt-1">Koszty razem</div>
              <div className="mt-1 text-base font-bold text-violet-800 dark:text-violet-300 font-mono">
                {kwota(currentSummary.cryptoCostsPLN)}
              </div>
            </div>

            <div className="p-3.5 rounded-xl bg-violet-50/50 dark:bg-violet-950/30 border border-violet-200/80 dark:border-violet-800/80">
              <div className="text-[11px] font-bold text-violet-700 dark:text-violet-300">POZ. 39</div>
              <div className="text-[11px] text-slate-700 dark:text-slate-300 mt-1">Dochód</div>
              <div className="mt-1 text-base font-bold text-violet-800 dark:text-violet-300 font-mono">
                {kwota(currentSummary.cryptoIncomePLN)}
              </div>
            </div>

            <div className="p-3.5 rounded-xl bg-violet-100/70 dark:bg-violet-900/40 border border-violet-300 dark:border-violet-700">
              <div className="text-[11px] font-bold text-violet-800 dark:text-violet-200">POZ. 43 / 45</div>
              <div className="text-[11px] text-slate-700 dark:text-slate-300 mt-1">Podatek 19% z części F</div>
              <div className="mt-1 text-base font-bold text-violet-900 dark:text-violet-100 font-mono">
                {kwota(currentSummary.cryptoTaxDuePLN)}
              </div>
            </div>
          </div>

          {(currentSummary.cryptoLossPLN ?? 0) > 0 && (
            <div className="p-3 rounded-xl border border-amber-200 dark:border-amber-900/60 bg-amber-50/80 dark:bg-amber-950/30 text-[11px] text-amber-900 dark:text-amber-200 leading-relaxed">
              Koszty przewyższają przychód o{' '}
              <strong className="font-mono">{kwota(currentSummary.cryptoLossPLN)}</strong>. Ta
              nadwyżka nie jest stratą do odliczenia od dochodów z akcji — przechodzi na przyszły
              rok w ramach części E. Wpisz ją w panelu optymalizacji przy rozliczeniu za kolejny rok.
            </div>
          )}
        </div>
      )}
    </div>
);
