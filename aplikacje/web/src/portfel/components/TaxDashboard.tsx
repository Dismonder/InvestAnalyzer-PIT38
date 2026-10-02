import React, { useState, useEffect } from 'react';
import {
  FileDown,
  FileSpreadsheet,
  RefreshCw,
  Building2,
  Calendar,
  Layers,
  HelpCircle,
  Sparkles,
  ArrowRight,
  BookOpen,
  PlusCircle,
  UploadCloud,
  Coins,
  Calculator,
  Info,
  ExternalLink,
  Receipt,
  FileText,
  FileCode2,
  PieChart,
  CheckCircle2,
  AlertCircle,
  ListOrdered,
} from 'lucide-react';
import {
  TaxYearSummary,
  TaxRealizedGain,
  DividendTaxItem,
  BrokerAccount,
  Language,
} from '../types';
import { getTranslation } from '../i18n/translations';
import { formatCurrency } from '../services/nbpService';
import { exportTaxReportPDF, exportAnnualSummaryPDF } from '../services/pdfExporter';
import { exportRealizedGainsCSV } from '../services/csvExporter';
import { adnotacjaNiegotowego, powodBlokadyKopiowania, powodBlokadyXml, rozliczenieGotowe } from '../services/gotowoscRozliczenia';
import { exportPit38XML, ostrzezenieOWzorzePit38 } from '../services/xmlExporter';
import { TaxpayerConfigModal } from './TaxpayerConfigModal';
import { TaxKpiCards } from './tax/TaxKpiCards';
import { EpitFieldsGrid } from './tax/EpitFieldsGrid';
import { DividendsPitZgSection } from './tax/DividendsPitZgSection';
import { LossCalculatorPanel } from './tax/LossCalculatorPanel';
import { obliczObrotRoku } from '../services/obrotRoczny';
import { odmienLiczebnik } from '../services/odmianaLiczebnika';
import type { Transaction } from '../types';

interface TaxDashboardProps {
  resultStale?: boolean;
  canExport?: boolean;
  gotoweDoZlozenia?: boolean | null;
  yearSummaries: Map<number, TaxYearSummary>;
  selectedYear: number;
  setSelectedYear: (year: number) => void;
  realizedGains: TaxRealizedGain[];
  dividends: DividendTaxItem[];
  accounts: BrokerAccount[];
  /** Transakcje widoczne w aplikacji (z przebiegu silnika i ręczne) - podstawa obrotu roku. */
  transactions?: Transaction[];
  language: Language;
  onSyncAllApis: () => Promise<void>;
  isSyncing: boolean;
  onOpenFifoDetails: () => void;
  onQuickAddTransaction?: () => void;
  onQuickImport?: () => void;
  onNavigateToTab?: (tab: string) => void;
}

export const TaxDashboard: React.FC<TaxDashboardProps> = ({
  resultStale = false,
  canExport = true,
  gotoweDoZlozenia,
  yearSummaries,
  selectedYear,
  transactions,
  setSelectedYear,
  realizedGains,
  dividends,
  accounts,
  language,
  onSyncAllApis,
  isSyncing,
  onOpenFifoDetails,
  onQuickAddTransaction,
  onQuickImport,
  onNavigateToTab,
}) => {
  const t = getTranslation(language);
  // Lata do wyboru biora sie wylacznie z danych. Wczesniej przy pustym wyniku
  // dopisywane byly na sztywno 2024 i 2023 - aplikacja proponowala przelaczenie
  // na lata, ktorych w danych nie ma, a same liczby starzaly sie z kazdym
  // kolejnym rokiem. Gdy nie ma czego wybierac, zostaje sam rok biezacego
  // rozliczenia.
  const availableYears = Array.from(yearSummaries.keys()).map(Number).sort((a: number, b: number) => b - a);
  if (availableYears.length === 0) {
    availableYears.push(selectedYear);
  }

  // Dopoki silnik nie odda wyniku dla wybranego roku, panel nie udaje gotowego
  // rozliczenia: karty pokazuja kreske zamiast zer.
  const currentSummary = yearSummaries.get(selectedYear) || {
    year: selectedYear,
    nieobliczony: true,
    revenuePLN: 0,
    costsPLN: 0,
    incomePLN: 0,
    lossPLN: 0,
    taxDuePLN: 0,
    dividendGrossPLN: 0,
    dividendForeignTaxPLN: 0,
    dividendPolishTaxDuePLN: 0,
    dividendTaxToPayPLN: 0,
    totalTaxToPayPLN: 0,
    transactionCount: 0,
    brokerBreakdowns: [],
  };
  const exportBlocked = !canExport || currentSummary.nieobliczony;
  // Wiersz "koszty nieprzypisane do rachunku" uzgadnia sumy, ale nie jest rachunkiem.
  const liczbaRachunkow = currentSummary.brokerBreakdowns.filter((pozycja) => pozycja.accountId !== 'unassigned').length;
  const exportTitle = exportBlocked ? 'Wynik NIEAKTUALNY lub nieobliczony — przelicz ponownie przed eksportem.' : undefined;
  // XML tylko przy potwierdzonej gotowosci: false to blokady, null/undefined to brak potwierdzenia.
  const xmlBlocked = exportBlocked || !rozliczenieGotowe(gotoweDoZlozenia);
  const xmlTitle = powodBlokadyXml(exportBlocked, gotoweDoZlozenia, exportTitle);
  // PDF i CSV wolno pobrac takze przy blokadach, ale plik ma to mowic wprost.
  const adnotacjaPliku = adnotacjaNiegotowego(gotoweDoZlozenia);

  const yearGains = realizedGains.filter((g) => g.taxYear === selectedYear);
  const yearDividends = dividends.filter((d) => d.taxYear === selectedYear);

  // Active view inside PIT-38
  const [activePitSection, setActivePitSection] = useState<'SUMMARY' | 'EPIT' | 'DIVIDENDS' | 'BROKERS' | 'LOSS_CALC'>(() => {
    return (localStorage.getItem('pit38_active_pit_section') as 'SUMMARY' | 'EPIT' | 'DIVIDENDS' | 'BROKERS' | 'LOSS_CALC') || 'SUMMARY';
  });

  // Copy to clipboard helper state
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [priorYearsLoss, setPriorYearsLoss] = useState<number>(() => {
    const saved = localStorage.getItem('pit38_prior_years_loss');
    return saved ? Number(saved) : 0;
  });
  const [showGuide, setShowGuide] = useState<boolean>(false);

  useEffect(() => {
    localStorage.setItem('pit38_active_pit_section', activePitSection);
  }, [activePitSection]);

  useEffect(() => {
    localStorage.setItem('pit38_prior_years_loss', priorYearsLoss.toString());
  }, [priorYearsLoss]);

  // Pola deklaracji kopiuje sie tylko przy potwierdzonej gotowosci i swiezym wyniku.
  const kopiowanieZablokowane = powodBlokadyKopiowania(Boolean(currentSummary.nieobliczony || resultStale), gotoweDoZlozenia);

  const handleCopy = (fieldKey: string, value: number) => {
    // Nie ma co przepisywac do deklaracji liczby, ktorej silnik nie policzyl.
    if (kopiowanieZablokowane) return;
    const formatted = value.toFixed(2);
    // `navigator.clipboard` istnieje tylko w bezpiecznym kontekscie. Pod adresem
    // po zwyklym http (aplikacja otwarta z innego urzadzenia w sieci domowej)
    // jest niezdefiniowany, a samo klikniecie "Kopiuj" konczylo sie bledem
    // i zgaszeniem calego ekranu przez granice bledu.
    const zapasowaKopia = (): boolean => {
      const pole = document.createElement('textarea');
      pole.value = formatted;
      pole.setAttribute('readonly', '');
      pole.style.position = 'fixed';
      pole.style.opacity = '0';
      document.body.appendChild(pole);
      pole.select();
      let udane = false;
      try {
        udane = document.execCommand('copy');
      } catch {
        console.warn('Przeglądarka nie pozwoliła skopiować wartości do schowka.');
      }
      document.body.removeChild(pole);
      return udane;
    };
    // "Skopiowano!" zapalalo sie bezwarunkowo, takze gdy schowek odmowil -
    // uzytkownik wklejal do zeznania to, co mial w schowku wczesniej.
    const potwierdz = (udane: boolean) => {
      if (!udane) return;
      setCopiedField(fieldKey);
      setTimeout(() => {
        setCopiedField(null);
      }, 2000);
    };
    try {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard
          .writeText(formatted)
          .then(() => potwierdz(true))
          .catch(() => potwierdz(zapasowaKopia()));
      } else {
        potwierdz(zapasowaKopia());
      }
    } catch {
      potwierdz(zapasowaKopia());
    }
  };

  /**
   * Kwota z rozliczenia albo myslnik. Pola podsumowania sa opcjonalne, wiec
   * `kwota(x ?? 0)` pokazywalo "0,00 zl" dla pozycji, ktorej silnik w ogole
   * nie policzyl - i tak samo wygladala prawdziwa zerowa kwota.
   */
  /** Kwoty części C i poz. 33 w XML mają dwa miejsca po przecinku. */
  const kwotaDoDeklaracji = (wartosc: number | null | undefined): string =>
    currentSummary.nieobliczony || wartosc === null || wartosc === undefined
      ? '—'
      : formatCurrency(wartosc);

  const kwota = (wartosc: number | null | undefined): string =>
    currentSummary.nieobliczony || wartosc === null || wartosc === undefined
      ? '—'
      : formatCurrency(wartosc);

  // Skad wzialy sie kwoty poz. 20 i 21. Z otrzymanej informacji PIT-8C - to ja
  // urzad porownuje z zeznaniem. Z transakcji - to tylko wynik wlasnego
  // rachunku i trzeba go zestawic z informacja przed wyslaniem.
  const pit8cZInformacji = currentSummary.pit8cZrodlo === 'informacja';
  const pit8cZnacznik = pit8cZInformacji ? 'z informacji PIT-8C' : 'z transakcji · sprawdź z PIT-8C';
  /** Rozjazd między wpisaną informacją a rachunkiem aplikacji, z groszami. */
  const pit8cRozjazd = (wpisana?: number, wyliczona?: number): number | null => {
    if (!pit8cZInformacji || wpisana === undefined || wyliczona === undefined) return null;
    const roznica = Math.round((wpisana - wyliczona) * 100) / 100;
    return roznica === 0 ? null : roznica;
  };
  const pit8cRozjazdPrzychodu = pit8cRozjazd(
    currentSummary.pit8cRevenuePLN,
    currentSummary.pit8cWyliczonyPrzychodPLN
  );
  const pit8cRozjazdKosztow = pit8cRozjazd(
    currentSummary.pit8cCostsPLN,
    currentSummary.pit8cWyliczoneKosztyPLN
  );

  // Symulacja odliczenia straty z lat ubieglych, wylacznie na potrzeby
  // kalkulatora ponizej (art. 9 ust. 3 pkt 1 i 2 ustawy o PIT: jednorazowo do
  // 5 mln PLN albo do 50% rocznie).
  //
  // Te liczby NIE moga wchodzic do kart rozliczenia. Straty z lat ubieglych
  // wpisuje sie w panelu optymalizacji, skad trafiaja do silnika - a silnik
  // zwraca podatek juz po ich odliczeniu (`prior_year_loss_used_pln`).
  // Wczesniej to samo odliczenie szlo jeszcze raz tutaj i wartosc wpisana w obu
  // miejscach zanizala podatek dwukrotnie.
  const maxDeductibleLoss = Math.min(
    currentSummary.incomePLN,
    priorYearsLoss <= 5000000 ? priorYearsLoss : Math.max(5000000, priorYearsLoss * 0.5)
  );
  const adjustedIncomePLN = Math.max(0, currentSummary.incomePLN - maxDeductibleLoss);
  // Szacunek formularza: podstawa do pełnych zł, 19% z groszami, podatek do zł.
  const adjustedStockTaxPLN = Math.round(Math.round(adjustedIncomePLN) * 0.19);
  const adjustedTotalTaxPLN = adjustedStockTaxPLN + currentSummary.dividendTaxToPayPLN;

  const [isXmlModalOpen, setIsXmlModalOpen] = useState<boolean>(false);

  const getTaxpayerName = () => {
    const fName = localStorage.getItem('pit38_taxpayer_firstName') || '';
    const lName = localStorage.getItem('pit38_taxpayer_lastName') || '';
    if (fName || lName) return `${fName} ${lName}`.trim();
    return 'Inwestor Indywidualny';
  };

  // Generator PDF doladowuje sie na zadanie, wiec obie akcje sa asynchroniczne.
  const handleExportPDF = () => {
    if (exportBlocked) return;
    void exportTaxReportPDF(currentSummary, yearGains, yearDividends, accounts, getTaxpayerName(), adnotacjaPliku).catch(
      (blad: unknown) => {
        console.error('Nie udało się wygenerować raportu PDF', blad);
      }
    );
  };

  const handleExportAnnualSummaryPDF = () => {
    if (exportBlocked) return;
    void exportAnnualSummaryPDF(selectedYear, yearSummaries, accounts, getTaxpayerName(), adnotacjaPliku).catch(
      (blad: unknown) => {
        console.error('Nie udało się wygenerować podsumowania PDF', blad);
      }
    );
  };

  const handleExportCSV = () => {
    if (exportBlocked) return;
    exportRealizedGainsCSV(yearGains, currentSummary, accounts, `PIT38_${selectedYear}_Zestawienie.csv`, { adnotacja: adnotacjaPliku });
  };

  const handleExportXML = () => {
    if (xmlBlocked) return;
    const ostrzezenieWzoru = ostrzezenieOWzorzePit38(selectedYear);
    if (ostrzezenieWzoru && !window.confirm(`${ostrzezenieWzoru}\n\nCzy mimo to przygotować plik XML?`)) return;
    setIsXmlModalOpen(true);
  };

  return (
    <div id="tax-dashboard" className="space-y-6 animate-in fade-in duration-200">
      {/* TOP HEADER: YEAR SELECTOR, REFRESH & EXPORTS */}
      <div className="flex flex-col gap-5 bg-white dark:bg-slate-900 p-5 sm:p-6 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs">
        <div className="flex items-start sm:items-center gap-3">
          <div className="shrink-0 p-3 rounded-xl bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400">
            <Receipt className="w-6 h-6" />
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-white">
                Rozliczenie Podatkowe PIT-38
              </h1>
              <span className="px-2.5 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-950/80 text-emerald-700 dark:text-emerald-300 text-xs font-semibold">
                Stawka 19% (Zryczałtowany)
              </span>
            </div>
            <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400 mt-1">
              Automatyczne wyliczanie przychodów, kosztów FIFO, dywidend (część G) oraz kursów średnich NBP T-1
            </p>
          </div>
        </div>

        {/* Year Pills & Quick Actions */}
        {/* Telefon: siatka 2 kolumny zamiast pieciu przyciskow jeden pod drugim. */}
        <div className="grid grid-cols-2 sm:flex sm:items-center gap-2 sm:flex-wrap border-t border-slate-100 dark:border-slate-800 pt-4">
          {/* Year Buttons */}
          <div className="col-span-2 sm:col-span-1 w-fit inline-flex p-1 rounded-xl bg-slate-100 dark:bg-slate-800/90 border border-slate-200/80 dark:border-slate-700/80">
            {availableYears.map((yr) => (
              <button
                key={yr}
                onClick={() => setSelectedYear(yr)}
                className={`px-3 py-1.5 text-xs font-bold font-mono rounded-lg transition-all cursor-pointer ${
                  selectedYear === yr
                    ? 'bg-blue-600 text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200/60 dark:hover:bg-slate-700/60'
                }`}
              >
                Rok {yr}
              </button>
            ))}
          </div>

          <button
            id="btn-sync-apis"
            onClick={onSyncAllApis}
            disabled={isSyncing}
            className="flex items-center justify-center sm:justify-start gap-1.5 px-3 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 transition-all disabled:opacity-50 cursor-pointer"
            title="Synchronizuj rachunki maklerskie przez API i odśwież notowania. Kursy NBP do rozliczenia pobiera silnik przy przeliczeniu."
          >
            <RefreshCw className={`w-3.5 h-3.5 text-blue-500 ${isSyncing ? 'animate-spin' : ''}`} />
            <span>{isSyncing ? 'Synchronizacja...' : 'Synchronizuj brokerów'}</span>
          </button>

          <button
            id="btn-export-annual-summary-pdf"
            disabled={exportBlocked}
            title={exportTitle}
            onClick={handleExportAnnualSummaryPDF}
            className="flex items-center justify-center sm:justify-start gap-1.5 px-3.5 py-2 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-xs font-semibold text-white shadow-xs transition-all cursor-pointer"
          >
            <FileDown className="w-3.5 h-3.5" />
            <span>Podsumowanie Roczne (PDF)</span>
          </button>

          <button
            id="btn-export-pdf"
            disabled={exportBlocked}
            title={exportTitle}
            onClick={handleExportPDF}
            className="flex items-center justify-center sm:justify-start gap-1.5 px-3 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-xs font-semibold text-white shadow-xs transition-all cursor-pointer"
          >
            <FileText className="w-3.5 h-3.5" />
            <span>Szczegóły FIFO (PDF)</span>
          </button>

          <button
            id="btn-export-xml"
            disabled={xmlBlocked}
            title={xmlTitle}
            onClick={handleExportXML}
            className="flex items-center justify-center sm:justify-start gap-1.5 px-3 py-2 rounded-xl bg-amber-700 hover:bg-amber-800 text-xs font-semibold text-white shadow-xs transition-all cursor-pointer"
          >
            <FileCode2 className="w-3.5 h-3.5" />
            <span>e-Deklaracje XML</span>
          </button>
          <button
            id="btn-export-csv"
            disabled={exportBlocked}
            title={exportTitle}
            onClick={handleExportCSV}
            className="flex items-center justify-center sm:justify-start gap-1.5 px-3 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-xs font-semibold text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 transition-colors cursor-pointer"
          >
            <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-500" />
            <span>CSV</span>
          </button>
          {ostrzezenieOWzorzePit38(selectedYear) && (
            <p role="alert" className="col-span-2 basis-full mt-1 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
              {ostrzezenieOWzorzePit38(selectedYear)}
            </p>
          )}
        </div>
      </div>

      {/* INTUITIVE STEP-BY-STEP PROGRESS BAR BANNER */}
      <div className="bg-gradient-to-r from-blue-50 via-white to-indigo-50 dark:from-blue-950/80 dark:via-slate-900 dark:to-indigo-950/80 border border-blue-200 dark:border-blue-800/40 rounded-2xl p-5 shadow-sm text-slate-900 dark:text-slate-100">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3.5 border-b border-slate-200 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <span className="p-1 rounded-md bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-300">
              <Sparkles className="w-4 h-4" />
            </span>
            <span className="text-sm font-bold text-slate-900 dark:text-white">
              Szybka Ścieżka Rozliczenia PIT-38 (Rok {selectedYear})
            </span>
          </div>
          <button
            onClick={() => setShowGuide(!showGuide)}
            className="flex items-center gap-1.5 text-xs text-blue-700 hover:text-blue-900 dark:text-blue-300 dark:hover:text-white underline cursor-pointer self-start sm:self-auto"
          >
            <BookOpen className="w-3.5 h-3.5" />
            <span>{showGuide ? 'Schowaj instrukcję Twój e-PIT' : 'Jak przepisać do Twój e-PIT?'}</span>
          </button>
        </div>

        {/* 3 Steps visually connected */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5 mt-3.5">
          {/* Step 1 */}
          <div className="p-3 rounded-xl bg-white/90 dark:bg-slate-900/90 border border-slate-200 dark:border-slate-800/90 flex items-start gap-3">
            <div className="w-7 h-7 rounded-lg bg-blue-100 dark:bg-blue-600/30 border border-blue-200 dark:border-blue-500/40 text-blue-700 dark:text-blue-300 flex items-center justify-center font-bold text-xs shrink-0 mt-0.5">
              1
            </div>
            <div className="space-y-1 min-w-0">
              <div className="text-xs font-bold text-slate-900 dark:text-white">Transakcje i Kursy NBP</div>
              <div className="text-[11px] text-slate-600 dark:text-slate-400 leading-snug">
                {liczbaRachunkow} {odmienLiczebnik(liczbaRachunkow, 'rachunek', 'rachunki', 'rachunków')} • {yearGains.length} {odmienLiczebnik(yearGains.length, 'zbycie', 'zbycia', 'zbyć')} • {yearDividends.length} {odmienLiczebnik(yearDividends.length, 'dywidenda', 'dywidendy', 'dywidend')}
              </div>
              <div className="pt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                <button
                  onClick={onQuickImport}
                  className="text-[11px] text-blue-700 dark:text-blue-400 hover:underline flex items-center whitespace-nowrap gap-1 font-medium cursor-pointer"
                >
                  <UploadCloud className="w-3 h-3" />
                  <span>Import CSV</span>
                </button>
                <span className="text-slate-400 dark:text-slate-500">•</span>
                <button
                  onClick={onQuickAddTransaction}
                  className="text-[11px] text-emerald-700 dark:text-emerald-400 hover:underline flex items-center whitespace-nowrap gap-1 font-medium cursor-pointer"
                >
                  <PlusCircle className="w-3 h-3" />
                  <span>Dodaj ręcznie</span>
                </button>
              </div>
            </div>
          </div>

          {/* Step 2 */}
          <div className="p-3 rounded-xl bg-white/90 dark:bg-slate-900/90 border border-slate-200 dark:border-slate-800/90 flex items-start gap-3">
            <div className="w-7 h-7 rounded-lg bg-indigo-100 dark:bg-indigo-600/30 border border-indigo-200 dark:border-indigo-500/40 text-indigo-700 dark:text-indigo-300 flex items-center justify-center font-bold text-xs shrink-0 mt-0.5">
              2
            </div>
            <div className="space-y-1 min-w-0">
              <div className="text-xs font-bold text-slate-900 dark:text-white">Weryfikacja Pól PIT-38</div>
              <div className="text-[11px] text-slate-600 dark:text-slate-400 leading-snug">
                Część C (akcje), E (krypto), G (dywidendy zagraniczne) i PIT/ZG (zbycie za granicą)
              </div>
              <div className="pt-1">
                <button
                  onClick={() => setActivePitSection('EPIT')}
                  className="text-[11px] text-indigo-700 dark:text-indigo-400 hover:underline flex items-center gap-1 font-medium cursor-pointer"
                >
                  <span>Zobacz kafelki z 1-klik kopiowaniem →</span>
                </button>
              </div>
            </div>
          </div>

          {/* Step 3 */}
          <div className="p-3 rounded-xl bg-white/90 dark:bg-slate-900/90 border border-slate-200 dark:border-slate-800/90 flex items-start gap-3">
            <div className="w-7 h-7 rounded-lg bg-emerald-100 dark:bg-emerald-600/30 border border-emerald-200 dark:border-emerald-500/40 text-emerald-700 dark:text-emerald-300 flex items-center justify-center font-bold text-xs shrink-0 mt-0.5">
              3
            </div>
            <div className="space-y-1 min-w-0">
              <div className="text-xs font-bold text-slate-900 dark:text-white">Podatek i Złożenie</div>
              <div className="text-[11px] text-slate-600 dark:text-slate-400 leading-snug">
                Należny podatek: <strong className="text-emerald-700 dark:text-emerald-400 font-mono">{kwota(currentSummary.totalTaxToPayPLN)}</strong>
                {resultStale && <strong role="status" className="ml-2 text-amber-700 dark:text-amber-300">NIEAKTUALNE — przelicz ponownie</strong>}
                {!currentSummary.nieobliczony && (
                  <span className="block text-[10px] text-slate-500 dark:text-slate-400">
                    z silnika: sprzedaż {kwota(currentSummary.taxDuePLN)} + dywidendy {kwota(currentSummary.dividendTaxToPayPLN)}
                    {currentSummary.cryptoTaxDuePLN !== undefined ? <> + krypto {kwota(currentSummary.cryptoTaxDuePLN)}</> : null}
                  </span>
                )}
              </div>
              <div className="pt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                <a
                  href="https://urzadskarbowy.gov.pl"
                  target="_blank"
                  rel="noreferrer"
                  className="text-[11px] text-emerald-700 dark:text-emerald-400 hover:underline flex items-center whitespace-nowrap gap-1 font-medium cursor-pointer"
                >
                  <ExternalLink className="w-3 h-3" />
                  <span>Otwórz podatki.gov.pl</span>
                </a>
              </div>
            </div>
          </div>
        </div>

        {/* Detailed Expandable Guide */}
        {showGuide && (
          <div className="mt-4 pt-4 border-t border-slate-200 dark:border-slate-800 animate-in fade-in duration-200 bg-white/80 dark:bg-slate-900/70 p-4 rounded-xl text-xs space-y-2.5">
            <h4 className="font-bold text-slate-900 dark:text-white flex items-center gap-1.5 text-sm">
              <CheckCircle2 className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
              Instrukcja krok po kroku: Jak przepisać dane do usługi "Twój e-PIT"
            </h4>
            <ol className="list-decimal list-inside space-y-2 text-slate-600 dark:text-slate-300 leading-relaxed pl-1">
              <li>Zaloguj się na portalu <strong className="text-blue-700 dark:text-blue-300">podatki.gov.pl (Twój e-PIT)</strong> przez Profil Zaufany, aplikację mObywatel lub bank.</li>
              <li>Otwórz przygotowane przez urząd zeznanie <strong className="text-slate-900 dark:text-white">PIT-38 za rok {selectedYear}</strong>.</li>
              <li>W <strong>części C</strong> uzupełnij wiersz odpowiadający źródłu przychodu.
                Wiersz 1 (poz. 20 i 21) wypełnia się kwotami z otrzymanej informacji PIT-8C,
                a wiersz 2 (poz. 22 i 23) — przychodami bez PIT-8C, w tym zagranicznymi.
                Poz. 26–29 wyliczy się same:
                <div className="mt-1 ml-4 p-2 rounded-lg bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700/80 font-mono text-[11px] space-y-1 text-slate-700 dark:text-slate-200">
                  <div>• <strong>Poz. 20 / 21 (z PIT-8C)</strong>: {kwota(currentSummary.pit8cRevenuePLN)} / {kwota(currentSummary.pit8cCostsPLN)}</div>
                  <div>• <strong>Poz. 22 / 23 (bez PIT-8C)</strong>: {kwota(currentSummary.foreignRevenuePLN ?? (pit8cZInformacji ? undefined : currentSummary.revenuePLN))} / {kwota(currentSummary.foreignCostsPLN ?? (pit8cZInformacji ? undefined : currentSummary.costsPLN))}</div>
                  <div>• <strong>Razem (poz. 26 / 27)</strong>: {kwota(currentSummary.revenuePLN)} / {kwota(currentSummary.costsPLN)}</div>
                </div>
              </li>
              <li>Dywidendy zagraniczne (np. spółki USA z podatkiem u źródła 15%) rozliczasz w <strong>części G</strong> zeznania (poz. 47–49) — bez załącznika PIT/ZG. <strong>Załącznik PIT/ZG</strong> (po jednym na państwo) dotyczy dochodu ze zbycia papierów za granicą; eksport XML przygotowuje go z wyliczeń silnika.</li>
              <li>Sprawdź zgodność wyliczonego podatku należnego z kwotą w kalkulatorze i kliknij <strong>Akceptuj i wyślij</strong>.</li>
            </ol>
          </div>
        )}
      </div>

      {/* OBRÓT ROKU */}
      {(() => {
        const obrot = obliczObrotRoku(transactions ?? [], selectedYear);
        const kwota = (wartosc: number, waluta: string) =>
          `${wartosc.toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${waluta}`;
        return (
          <div id="card-turnover" className="p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xs">
            <div className="flex items-center justify-between text-slate-500 dark:text-slate-400 text-xs font-medium">
              <span className="font-semibold">Obrót w roku {selectedYear}</span>
              <span>kupno + sprzedaż (ilość × cena), bez prowizji</span>
            </div>
            {obrot.waluty.length === 0 ? (
              <p className="mt-2 text-2xl font-bold text-slate-400">—</p>
            ) : (
              <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {obrot.waluty.map((w) => (
                  <div key={w.waluta}>
                    <p className="text-2xl font-bold text-slate-900 dark:text-white">{kwota(w.razem, w.waluta)}</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      kupno {kwota(w.kupno, w.waluta)} ({w.liczbaKupna}) • sprzedaż {kwota(w.sprzedaz, w.waluta)} ({w.liczbaSprzedazy})
                    </p>
                  </div>
                ))}
              </div>
            )}
            {obrot.pominiete > 0 && (
              <p className="mt-2 text-xs text-amber-600">
                Nie wliczono {obrot.pominiete} transakcji bez ilości, ceny albo waluty.
              </p>
            )}
          </div>
        );
      })()}

      {/* 4 PRIMARY METRIC CARDS */}
      <TaxKpiCards currentSummary={currentSummary} transactionCount={yearGains.length} resultStale={resultStale}
        kwota={kwota} copiedField={copiedField} handleCopy={handleCopy} kopiowanieZablokowane={kopiowanieZablokowane}
        onOpenLossCalc={() => setActivePitSection('LOSS_CALC')} />

      {/* INTUITIVE SUB-NAVIGATION TABS FOR PIT-38 */}
      <div className="flex items-center gap-2 border-b border-slate-200 dark:border-slate-800 pb-2 overflow-x-auto">
        <button
          onClick={() => setActivePitSection('SUMMARY')}
          className={`px-3.5 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-2 whitespace-nowrap ${
            activePitSection === 'SUMMARY'
              ? 'bg-blue-600 text-white shadow-xs'
              : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-800'
          }`}
        >
          <FileText className="w-3.5 h-3.5" />
          <span>Podsumowanie i Kafelki Twój e-PIT</span>
        </button>

        <button
          onClick={() => setActivePitSection('DIVIDENDS')}
          className={`px-3.5 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-2 whitespace-nowrap ${
            activePitSection === 'DIVIDENDS'
              ? 'bg-blue-600 text-white shadow-xs'
              : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-800'
          }`}
        >
          <Coins className="w-3.5 h-3.5" />
          <span>Dywidendy zagraniczne (część G)</span>
          <span className="px-1.5 py-0.2 rounded-full bg-slate-200 dark:bg-slate-700 text-[10px]">
            {yearDividends.length}
          </span>
        </button>

        <button
          onClick={() => setActivePitSection('BROKERS')}
          className={`px-3.5 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-2 whitespace-nowrap ${
            activePitSection === 'BROKERS'
              ? 'bg-blue-600 text-white shadow-xs'
              : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-800'
          }`}
        >
          <Building2 className="w-3.5 h-3.5" />
          <span>Podział wg Kont Brokerskich</span>
          <span className="px-1.5 py-0.2 rounded-full bg-slate-200 dark:bg-slate-700 text-[10px]">
            {liczbaRachunkow}
          </span>
        </button>

        <button
          onClick={() => setActivePitSection('LOSS_CALC')}
          className={`px-3.5 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-2 whitespace-nowrap ${
            activePitSection === 'LOSS_CALC'
              ? 'bg-blue-600 text-white shadow-xs'
              : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-800'
          }`}
        >
          <Calculator className="w-3.5 h-3.5" />
          <span>Kalkulator Odliczenia Straty</span>
        </button>
      </div>

      {/* SUB-SECTION 1: SUMMARY & OFFICIAL EPIT TILES */}
      {(activePitSection === 'SUMMARY' || activePitSection === 'EPIT') && (
        <EpitFieldsGrid currentSummary={currentSummary} transactionCount={yearGains.length}
          kwota={kwota} kwotaDoDeklaracji={kwotaDoDeklaracji}
          pit8cZInformacji={pit8cZInformacji} pit8cZnacznik={pit8cZnacznik}
          pit8cRozjazdPrzychodu={pit8cRozjazdPrzychodu} pit8cRozjazdKosztow={pit8cRozjazdKosztow}
          onOpenFifoDetails={onOpenFifoDetails} copiedField={copiedField} handleCopy={handleCopy}
          kopiowanieZablokowane={kopiowanieZablokowane} />
      )}

      {/* SUB-SECTION 2: FOREIGN DIVIDENDS & PIT/ZG */}
      {activePitSection === 'DIVIDENDS' && (
        <DividendsPitZgSection currentSummary={currentSummary} yearDividends={yearDividends}
          selectedYear={selectedYear} accounts={accounts} kwota={kwota} />
      )}

      {/* SUB-SECTION 3: BROKER BREAKDOWN */}
      {activePitSection === 'BROKERS' && (
        <div className="bg-white dark:bg-slate-900 p-5 sm:p-6 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs space-y-4 animate-in fade-in duration-150">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-slate-100 dark:border-slate-800 gap-2">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base sm:text-lg font-bold text-slate-900 dark:text-white">
                  Wynik Podatkowy wg Kont Brokerskich (Rok {selectedYear})
                </h2>
                <span className="text-xs px-2.5 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 font-semibold font-mono">
                          {liczbaRachunkow} {odmienLiczebnik(liczbaRachunkow, 'rachunek', 'rachunki', 'rachunków')}
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Zestawienie przychodów i kosztów z podziałem na poszczególne biura maklerskie
              </p>
            </div>
          </div>

          {/* Pusta lista rozbic znaczyla "brak zrealizowanych transakcji" takze
              wtedy, gdy silnik roku jeszcze nie policzyl - a to dwie rozne
              rzeczy. Druga uzytkownik moze odczytac jako brak obowiazku. */}
          {currentSummary.brokerBreakdowns.length === 0 ? (
            <div className="py-8 text-center text-xs text-slate-400">
              {currentSummary.nieobliczony
                ? `Rok ${selectedYear} nie został jeszcze policzony przez silnik — to nie znaczy, że nie było sprzedaży.`
                : `Brak zrealizowanych transakcji w roku ${selectedYear}`}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="text-slate-500 dark:text-slate-400 border-b border-slate-100 dark:border-slate-800">
                  <tr>
                    <th className="py-2.5">Rachunek Maklerski</th>
                    <th className="py-2.5">Typ brokera</th>
                    <th className="py-2.5 text-right">Przychód (PLN)</th>
                    <th className="py-2.5 text-right">Koszty KUP (PLN)</th>
                    <th className="py-2.5 text-right">Dochód / Strata (PLN)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {currentSummary.brokerBreakdowns.map((b) => (
                    <tr key={b.accountId} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                      <td className="py-3 font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                        <Building2 className="w-3.5 h-3.5 text-blue-500" />
                        <span>{b.accountName}</span>
                      </td>
                      <td className="py-3">
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 font-mono">
                          {b.brokerType}
                        </span>
                      </td>
                      <td className="py-3 text-right font-mono font-medium text-slate-800 dark:text-slate-200">
                        {formatCurrency(b.revenuePLN)}
                      </td>
                      <td className="py-3 text-right font-mono text-slate-500">
                        {formatCurrency(b.costsPLN)}
                      </td>
                      <td
                        className={`py-3 text-right font-mono font-bold ${
                          b.incomePLN > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'
                        }`}
                      >
                        {b.incomePLN > 0 ? `+${formatCurrency(b.incomePLN)}` : `-${formatCurrency(b.lossPLN)}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* SUB-SECTION 4: LOSS DEDUCTION CALCULATOR */}
      {activePitSection === 'LOSS_CALC' && (
        <LossCalculatorPanel selectedYear={selectedYear} priorYearsLoss={priorYearsLoss}
          setPriorYearsLoss={setPriorYearsLoss} maxDeductibleLoss={maxDeductibleLoss}
          adjustedTotalTaxPLN={adjustedTotalTaxPLN} kwota={kwota} />
      )}

      {/* Taxpayer Data Modal for e-Deklaracje XML export */}
      <TaxpayerConfigModal
        isOpen={isXmlModalOpen && !xmlBlocked}
        onClose={() => setIsXmlModalOpen(false)}
        summary={currentSummary}
        realizedGains={yearGains}
        dividends={yearDividends}
      />
    </div>
  );
};
