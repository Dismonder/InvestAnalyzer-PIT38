import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { leniwyZPonowieniem } from '../shared/leniwyZPonowieniem';
import { useZamknijEscape } from '../shared/useZamknijEscape';
import { odmienLiczebnik } from '../portfel/services/odmianaLiczebnika';
import { StorageService } from './services/storage';
import { collectBackupSnapshot } from './services/backup';
import { przygotujKopiePrzedCzyszczeniem } from './services/kopiaPrzedCzyszczeniem';
import { Transaction, ExchangeRate, FileInfo, LogEntry } from './types';
import { LayoutDashboard, ListOrdered, CalendarDays, Upload, Menu, X, AlertTriangle, ArrowLeft, BriefcaseBusiness, type LucideIcon } from 'lucide-react';
import { ErrorBoundary } from './components/ErrorBoundary';
import { SyncService } from './services/sync';
import { useTaxEngineRun } from './hooks/useTaxEngineRun';
import { buildRunAuditAppendix } from './services/runAuditAppendix';
import {
  getDefaultTaxReportOrganizationStatus,
  type TaxReportOrganizationStatus,
  type TaxReportOrganizationState,
} from './services/reportOrganizationStatus';
import type { WorkspaceTargetView } from './services/workspaceReadiness';
import {
  readDefenseEvidenceOverrides,
  mergeAndSaveDefenseEvidenceOverrides,
  type DefenseEvidenceOverride,
  type DefenseEvidenceOverrideStatus,
} from './services/defenseEvidenceOverrides';
import { buildDefenseWorkbench, type DefenseWorkbenchItem } from './services/defenseWorkbench';
import {
  getBrowserTaxSettingsStorage,
  readExcludedStorageFiles,
  mergeAndSaveExcludedStorageFiles,
} from './services/taxEngineConfig';
import {
  readBrokerFileActionOverrides,
  mergeAndSaveBrokerFileActionOverrides,
  upsertBrokerFileActionOverride,
  type BrokerFileActionOverride,
} from './services/brokerFileActionOverrides';
import {
  readAutoCheckActionOverrides,
  mergeAndSaveAutoCheckActionOverrides,
  upsertAutoCheckActionOverride,
  type AutoCheckActionOverride,
} from './services/autoCheckActionOverrides';
import type { AutoCheckItem } from './services/autoCheckGuide';
import type { BrokerFileIntakeActionRow } from './services/brokerFileIntake';
import { buildBrokerActionWorkbench } from './services/brokerActionWorkbench';
import { buildYearClosureStatus, readTaxYearClosure } from './services/yearClosure';
import { browserLocalStorage, browserSessionStorage } from './services/browserStorage';
import {
  getUiComplexityMode,
  getUiLanguage,
  saveUiLanguage,
  saveUiComplexityMode,
  UI_PREFERENCES_CHANGED_EVENT,
  type UiLanguage,
  type UiComplexityMode,
} from './services/uiPreferences';
import { getInitialWorkspaceView, WORKSPACE_VIEW_STORAGE_KEY } from './services/workspaceViewPreference';
import { InsightDrawer, type ActiveInsightDrawer } from './components/cockpit/CockpitUi';
import { I18nProvider, translate } from './services/i18n';
import type { TaxEngineJobStatus } from './services/runtimeApi.types';
import { runtimeApi } from './services/runtimeApi';

type View = WorkspaceTargetView;
const SELECTED_ANALYSIS_YEAR_STORAGE_KEY = 'selectedAnalysisYear:v1';

function parseYearValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1900 && value <= 2100) {
    return value;
  }
  if (typeof value === 'string') {
    const direct = Number(value);
    if (Number.isInteger(direct) && direct >= 1900 && direct <= 2100) {
      return direct;
    }
    const match = value.match(/\b(19\d{2}|20\d{2}|21\d{2})\b/);
    if (match) {
      const parsed = Number(match[1]);
      if (parsed >= 1900 && parsed <= 2100) {
        return parsed;
      }
    }
  }
  return null;
}

function addYearCandidate(target: Set<number>, value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => addYearCandidate(target, entry));
    return;
  }
  const parsed = parseYearValue(value);
  if (parsed !== null) {
    target.add(parsed);
  }
}

function addYearsFromRecord(target: Set<number>, record: unknown): void {
  if (!record || typeof record !== 'object') {
    return;
  }
  const item = record as Record<string, unknown>;
  for (const key of [
    'tax_year',
    'taxYear',
    'year',
    'display_date',
    'displayDate',
    'date',
    'trade_date',
    'tradeDate',
    'settlement_date',
    'settlementDate',
    'date_time',
    'dateTime',
  ]) {
    addYearCandidate(target, item[key]);
  }
  addYearCandidate(target, item.active_tax_years);
  addYearCandidate(target, item.tax_years_detected);
  for (const nestedKey of ['dateRange', 'date_range', 'core_trade', 'tax_context']) {
    addYearsFromRecord(target, item[nestedKey]);
  }
  addYearCandidate(target, item.from);
  addYearCandidate(target, item.to);
}

function readInitialSelectedYear(): number {
  const stored = parseYearValue(browserLocalStorage.getItem(SELECTED_ANALYSIS_YEAR_STORAGE_KEY));
  return stored ?? new Date().getFullYear();
}

const SIMPLE_NAV_VIEWS: View[] = ['raport_roczny', 'historia_transakcji'];

export async function applyTaxReportOrganizationStatusRead(
  year: number,
  isCurrent: () => boolean,
  readStatus: (year: number) => Promise<TaxReportOrganizationStatus | null>,
  setStatus: (status: TaxReportOrganizationStatus) => void,
): Promise<void> {
  const stored = await readStatus(year);
  if (isCurrent()) {
    setStatus(stored || getDefaultTaxReportOrganizationStatus(year));
  }
}

const Dashboard = leniwyZPonowieniem(() => import('./components/Dashboard'), (modul) => modul.Dashboard);
const WorkspaceCenter = leniwyZPonowieniem(() => import('./components/WorkspaceCenter'), (modul) => modul.WorkspaceCenter);
const Transactions = leniwyZPonowieniem(() => import('./components/Transactions'), (modul) => modul.Transactions);
const YearlyReport = leniwyZPonowieniem(() => import('./components/YearlyReport'), (modul) => modul.YearlyReport);
const ImportData = leniwyZPonowieniem(() => import('./components/ImportData'), (modul) => modul.ImportData);
const InvestSettingsPanel = leniwyZPonowieniem(() => import('./components/InvestSettingsPanel'), (modul) => modul.InvestSettingsPanel);

function parseOverrideYear(rawValue: string | null | undefined): number | null {
  if (!rawValue) {
    return null;
  }
  const date = new Date(rawValue);
  const year = date.getFullYear();
  return Number.isFinite(year) ? year : null;
}

function ViewLoadingFallback({ label = 'Ładowanie widoku...' }: { label?: string }) {
  return (
    <div className="flex min-h-[240px] items-center justify-center rounded-2xl border border-gray-200 bg-white/70 text-sm font-medium text-gray-500 shadow-sm dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-300">
      <div className="mr-3 h-5 w-5 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
      {label}
    </div>
  );
}

function EngineRunStatusBanner({
  status,
  isPackageRun,
  label,
}: {
  status: TaxEngineJobStatus | null;
  isPackageRun: boolean;
  label: (key: string, params?: Record<string, string | number | null | undefined>) => string;
}) {
  if (!status) return null;
  const progress = Math.max(0, Math.min(100, Number(status.progress || 0)));
  return (
    <div className="border-b border-blue-100 bg-blue-50/90 px-4 py-3 dark:border-blue-900/50 dark:bg-blue-950/30 md:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-2 text-sm text-blue-900 dark:text-blue-100 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
          <div className="min-w-0">
            <div className="font-semibold">
              {isPackageRun ? label('engineStatus.packageRun') : label('engineStatus.calculationRun')}
            </div>
            <div className="text-xs text-blue-700 dark:text-blue-200">
              {label('engineStatus.stage', { stage: status.stage })} · {status.message}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="h-2 w-32 overflow-hidden rounded-full bg-blue-100 dark:bg-blue-900">
            <div className="h-full rounded-full bg-blue-600 transition-all" style={{ width: `${progress}%` }} />
          </div>
          <span className="w-10 text-right text-xs font-bold">{progress}%</span>
        </div>
      </div>
    </div>
  );
}

export default function InvestAnalyzerApp({ onExit }: { onExit?: () => void }) {
  const [currentView, setCurrentView] = useState<View>(() => getInitialWorkspaceView(browserSessionStorage));
  const [isLoading, setIsLoading] = useState(true);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  // Menu boczne na telefonie zamyka sie tez Escape (bez przenoszenia fokusu).
  useZamknijEscape(isMobileMenuOpen, () => setIsMobileMenuOpen(false));
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const refOknaCzyszczenia = useZamknijEscape(showClearConfirm, () => setShowClearConfirm(false));
  const [silnikRefreshKey, setEngineRefreshKey] = useState(0);
  const [overrideCount, setOverrideCount] = useState(0);
  const [overrideYears, setOverrideYears] = useState<number[]>([]);
  const [historySearchSeed, setHistorySearchSeed] = useState<string | null>(null);
  const [historyFocusRowId, setHistoryFocusRowId] = useState<string | null>(null);
  const [historyInitialMode, setHistoryInitialMode] = useState<'all' | 'candidate' | null>(null);
  const [defenseEvidenceOverrides, setDefenseEvidenceOverrides] = useState<DefenseEvidenceOverride[]>(() => (
    readDefenseEvidenceOverrides(getBrowserTaxSettingsStorage())
  ));
  const [brokerFileActionOverrides, setBrokerFileActionOverrides] = useState<BrokerFileActionOverride[]>(() => (
    readBrokerFileActionOverrides(getBrowserTaxSettingsStorage())
  ));
  const [autoCheckActionOverrides, setAutoCheckActionOverrides] = useState<AutoCheckActionOverride[]>(() => (
    readAutoCheckActionOverrides(getBrowserTaxSettingsStorage())
  ));
  const defenseEvidenceBase = useRef(defenseEvidenceOverrides);
  const brokerFileActionBase = useRef(brokerFileActionOverrides);
  const autoCheckActionBase = useRef(autoCheckActionOverrides);
  const excludedStorageFilesBase = useRef(readExcludedStorageFiles(getBrowserTaxSettingsStorage()));
  const [uiComplexityMode, setUiComplexityMode] = useState<UiComplexityMode>(() => getUiComplexityMode());
  const [uiLanguage, setUiLanguage] = useState<UiLanguage>(() => getUiLanguage());
  const [activeInsightDrawer, setActiveInsightDrawer] = useState<ActiveInsightDrawer | null>(null);
  const [reportOrganizationStatus, setReportOrganizationStatus] = useState<TaxReportOrganizationStatus>(
    getDefaultTaxReportOrganizationStatus(new Date().getFullYear()),
  );

  // Debug Panel State
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [processedStorageFiles, setProcessedStorageFiles] = useState<string[]>([]);

  useEffect(() => {
    const syncUiPreferences = () => {
      setUiComplexityMode(getUiComplexityMode());
      setUiLanguage(getUiLanguage());
    };
    window.addEventListener(UI_PREFERENCES_CHANGED_EVENT, syncUiPreferences);
    return () => window.removeEventListener(UI_PREFERENCES_CHANGED_EVENT, syncUiPreferences);
  }, []);

  const t = (key: string, params?: Record<string, string | number | null | undefined>) => translate(uiLanguage, key, params);

  const handleUiComplexityModeChange = (mode: UiComplexityMode) => {
    saveUiComplexityMode(mode);
    setUiComplexityMode(mode);
    setActiveInsightDrawer(null);
    if (mode === 'simple' && !SIMPLE_NAV_VIEWS.includes(currentView)) {
      setCurrentView('raport_roczny');
    }
  };
  const handleUiLanguageChange = (language: UiLanguage) => {
    saveUiLanguage(language);
    setUiLanguage(language);
  };
  const silnikLogKeysRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    browserSessionStorage.setItem(WORKSPACE_VIEW_STORAGE_KEY, currentView);
  }, [currentView]);

  useEffect(() => {
    if (uiComplexityMode === 'simple' && !SIMPLE_NAV_VIEWS.includes(currentView)) {
      setCurrentView('raport_roczny');
    }
  }, [currentView, uiComplexityMode]);

  const addLog = (level: LogEntry['level'], stage: LogEntry['stage'], message: string, details?: unknown) => {
    setLogs(prev => [...prev, {
      id: Math.random().toString(36).substring(7),
      timestamp: new Date().toISOString(),
      level,
      stage,
      message,
      details
    }]);
  };

  const clearRetiredBrokerApiState = async () => {
    await StorageService.clearRetiredBrokerApiState();
    [
      'freedom24LastSyncAt',
      'freedom24AutoSyncEnabled',
      'freedom24AutoSyncIntervalMinutes',
      'freedom24LastSyncHash',
      'investAnalyzerFreedomWorkspaceTab',
      'f24_full_auto_synced',
      'tn_apiKey',
      'tn_apiSecret',
      'tn_api_secret',
      'tn_authLogin',
      'tn_login',
      'tn_sid',
      'tn_userId',
    ].forEach((key) => {
      browserLocalStorage.removeItem(key);
      browserSessionStorage.removeItem(key);
    });
  };

  const loadData = async () => {
    setIsLoading(true);
    addLog('info', 'LOAD FILE', 'Rozpoczęto ładowanie stanu aplikacji i canonical_tax_input.json');
    try {
      await clearRetiredBrokerApiState();

      const overrides = await StorageService.getTransactionOverrides();
      const processedFiles = await StorageService.getProcessedStorageFiles();
      setProcessedStorageFiles(processedFiles);
      setOverrideCount(overrides.length);
      setOverrideYears(
        Array.from(
          new Set(
            overrides
              .map((entry) => parseOverrideYear(entry.values.date))
              .filter((value): value is number => value !== null),
          ),
        ).sort((a, b) => b - a),
      );
      await SyncService.markStorageFilesProcessed(addLog);
      const refreshedProcessedFiles = await StorageService.getProcessedStorageFiles();
      setProcessedStorageFiles(refreshedProcessedFiles);
      const runtimeStorageFiles = await runtimeApi.listStorageFiles().catch(() => []);

      // Plik z magazynu wchodzi do rozliczenia, dopoki uzytkownik go nie
      // wylaczy. Wczesniej kazdy nowo wylistowany plik dostawal
      // `isEnabled: false`, wiec przelacznik pokazywal "wylaczony", a silnik
      // i tak liczyl ze wszystkich - widok przeczyl wynikowi.
      const excludedStorageFiles = new Set(readExcludedStorageFiles(getBrowserTaxSettingsStorage()));
      excludedStorageFilesBase.current = [...excludedStorageFiles];
      setFiles(prevFiles => {
         const allFileIds = runtimeStorageFiles
           .map((file) => file.relativePath)
           .filter((name) => name && name !== '.keep' && !name.startsWith('.'));

         const updatedFiles: FileInfo[] = allFileIds.map(name => {
           const existingFile = prevFiles.find(f => f.name === name);
           const storageFile = runtimeStorageFiles.find((file) => file.relativePath === name);
           const isEnabled = !excludedStorageFiles.has(name);
           return existingFile
             ? { ...existingFile, isEnabled }
             : {
                 name,
                 type: storageFile?.extension || 'storage',
                 size: storageFile?.sizeBytes || 0,
                 loadedAt: new Date().toISOString(),
                 recordCount: 0,
                 status: 'success',
                 isEnabled,
               };
         });

         return updatedFiles;
      });

      addLog('info', 'LOAD FILE', `Załadowano stan aplikacji; wynik PIT pochodzi z canonical_tax_input.json. Pliki w magazynie: ${runtimeStorageFiles.length}.`);
    } catch (error) {
      console.error("Failed to load dane", error);
      addLog('error', 'LOAD FILE', 'Błąd podczas ładowania danych', error);
    } finally {
      setIsLoading(false);
      setEngineRefreshKey((value) => value + 1);
    }
  };

  const [selectedYear, setSelectedYearState] = useState<number>(readInitialSelectedYear);
  const selectedYearRef = useRef(selectedYear);
  selectedYearRef.current = selectedYear;
  const setSelectedYear = (year: number) => {
    const normalized = parseYearValue(year) ?? new Date().getFullYear();
    browserLocalStorage.setItem(SELECTED_ANALYSIS_YEAR_STORAGE_KEY, String(normalized));
    setSelectedYearState(normalized);
  };
  const { engineLoading, packageLoading, silnikJobStatus, engineResult, staleEngineResult, engineStale, canUseEngineResult, runPythonEngine } = useTaxEngineRun(
    selectedYear,
    overrideCount > 0 || files.length > 0 || processedStorageFiles.length > 0,
    `${silnikRefreshKey}:${selectedYear}`,
  );
  const auditAppendix = useMemo(() => buildRunAuditAppendix(engineResult), [engineResult]);
  const taxYearClosureStatus = useMemo(() => {
    return buildYearClosureStatus(
      auditAppendix?.pit_case_file || null,
      readTaxYearClosure(browserLocalStorage, selectedYear),
    );
  }, [auditAppendix?.pit_case_file, currentView, selectedYear]);
  const taxYearReadOnlyMessage = `Rok ${selectedYear} jest zamknięty. Otwórz rok ponownie w raporcie rocznym, aby zmieniać historię, korekty lub dowody.`;
  const defenseWorkbench = useMemo(
    () => buildDefenseWorkbench(auditAppendix, defenseEvidenceOverrides),
    [auditAppendix, defenseEvidenceOverrides],
  );
  const brokerActionWorkbench = useMemo(
    () => buildBrokerActionWorkbench(auditAppendix, brokerFileActionOverrides),
    [auditAppendix, brokerFileActionOverrides],
  );

  useEffect(() => {
    const infoIssues = engineResult?.informational_issues || [];
    if (!engineResult?.audit_hash || infoIssues.length === 0) {
      return;
    }
    setLogs((prev) => {
      const next = [...prev];
      for (const issue of infoIssues) {
        const key = `${engineResult.audit_hash}:${issue.code}:${issue.scope_id}`;
        if (silnikLogKeysRef.current.has(key)) {
          continue;
        }
        silnikLogKeysRef.current.add(key);
        next.push({
          id: key,
          timestamp: new Date().toISOString(),
          level: 'info',
          stage: 'ENGINE',
          message: `${issue.code}: ${issue.message}`,
          details: issue,
        });
      }
      return next;
    });
  }, [engineResult]);

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setReportOrganizationStatus(getDefaultTaxReportOrganizationStatus(selectedYear));
    void applyTaxReportOrganizationStatusRead(
      selectedYear,
      () => !cancelled && selectedYearRef.current === selectedYear,
      (year) => StorageService.getTaxReportOrganizationStatus(year),
      setReportOrganizationStatus,
    );
    return () => { cancelled = true; };
  }, [selectedYear]);

  const availableYears = useMemo(() => {
    const years = new Set<number>();
    overrideYears.forEach((year) => addYearCandidate(years, year));
    addYearCandidate(years, selectedYear);
    addYearCandidate(years, new Date().getFullYear());
    addYearCandidate(years, engineResult?.active_tax_years);
    addYearCandidate(years, engineResult?.tax_years_detected);
    addYearCandidate(years, engineResult?.tax_filing_package?.draft?.tax_year);
    addYearCandidate(years, auditAppendix?.storage_smoke_report?.active_tax_years);
    auditAppendix?.source_trust_summary?.items?.forEach((item) => addYearCandidate(years, item.tax_years_detected));
    auditAppendix?.source_registry?.forEach((source) => addYearsFromRecord(years, source));
    auditAppendix?.normalized_storage_manifest?.forEach((source) => addYearsFromRecord(years, source));
    auditAppendix?.canonical_storage_history_rows?.forEach((row) => addYearsFromRecord(years, row));
    auditAppendix?.transaction_dossiers?.forEach((dossier) => addYearsFromRecord(years, dossier));
    return Array.from(years).sort((a, b) => b - a);
  }, [
    overrideYears,
    selectedYear,
    engineResult?.active_tax_years,
    engineResult?.tax_years_detected,
    engineResult?.tax_filing_package?.draft?.tax_year,
    auditAppendix,
  ]);

  const handleClearData = async () => {
    let runtimeClearResult: Awaited<ReturnType<typeof runtimeApi.clearAppData>> | null = null;
    let runtimeClearError: unknown = null;
    let safetyBackupId: string | null = null;
    let safetyBackupError: unknown = null;
    try {
      // Kopia decyzji przed wyczyszczeniem. Katalog kopii nie nalezy do zadnego
      // z czyszczonych korzeni, wiec przetrwa te operacje - dzieki temu ruch
      // nieodwracalny staje sie odwracalny.
      // Blad zapisu kopii przerywa czyszczenie, chyba ze uzytkownik osobno potwierdzi "BEZ kopii".
      const kopia = await przygotujKopiePrzedCzyszczeniem({
        collect: () => collectBackupSnapshot('Kopia przed wyczyszczeniem danych'),
        write: (snapshot) => runtimeApi.writeBackupSnapshot(snapshot),
        potwierdzBezKopii: (tresc) => globalThis.window?.confirm(tresc) === true,
      });
      if (!kopia.kontynuuj) {
        setShowClearConfirm(false);
        addLog('warn', 'END PROCESS', kopia.pominieteKlucze?.length
          ? `Kopia bezpieczeństwa jest niepełna (${kopia.pominieteKlucze.join(', ')}) — czyszczenie danych przerwane, nic nie usunięto.`
          : 'Nie udało się zapisać kopii bezpieczeństwa — czyszczenie danych przerwane, nic nie usunięto.', kopia.blad);
        return;
      }
      safetyBackupId = kopia.idKopii;
      safetyBackupError = kopia.blad;
      try {
        runtimeClearResult = await runtimeApi.clearAppData();
      } catch (error: unknown) {
        runtimeClearError = error;
      }
      await StorageService.clearAll();
      browserLocalStorage.clear();
      browserSessionStorage.clear();
      setFiles([]);
      setLogs([]);
      setProcessedStorageFiles([]);
      setOverrideCount(0);
      setOverrideYears([]);
      setDefenseEvidenceOverrides([]);
      setBrokerFileActionOverrides([]);
      setAutoCheckActionOverrides([]);
      defenseEvidenceBase.current = [];
      brokerFileActionBase.current = [];
      autoCheckActionBase.current = [];
      excludedStorageFilesBase.current = [];
      setActiveInsightDrawer(null);
      setHistorySearchSeed(null);
      setHistoryFocusRowId(null);
      setHistoryInitialMode(null);
      const neutralYear = new Date().getFullYear();
      setSelectedYearState(neutralYear);
      setReportOrganizationStatus(getDefaultTaxReportOrganizationStatus(neutralYear));
      setShowClearConfirm(false);
      setCurrentView('raport_roczny');
      setEngineRefreshKey((value) => value + 1);

      // Use setTimeout to ensure state is cleared before adding the log
      setTimeout(() => {
        if (safetyBackupId) {
          addLog('info', 'END PROCESS', `Przed wyczyszczeniem zapisano kopię Twoich decyzji: ${safetyBackupId}. Możesz ją przywrócić w Ustawieniach → Dane.`);
        } else {
          addLog('warn', 'END PROCESS', 'Nie udało się zapisać kopii przed wyczyszczeniem. Dane zostały usunięte bez kopii zapasowej.', safetyBackupError);
        }
        if (runtimeClearError) {
          addLog('warn', 'END PROCESS', 'Wyczyszczono pamięć przeglądarkową, ale nie udało się wyczyścić katalogów aplikacji', runtimeClearError);
          return;
        }
        // Warstwa desktopowa zglasza pliki, ktorych nie udalo sie usunac -
        // zwykle dlatego, ze trzyma je inny proces. Komunikat "usunięte do zera"
        // przy niepustej liście ostrzeżeń mówił nieprawdę.
        const clearWarnings = runtimeClearResult?.warnings || [];
        if (clearWarnings.length > 0) {
          addLog(
            'warn',
            'END PROCESS',
            `Wyczyszczono dane, ale ${clearWarnings.length} ${odmienLiczebnik(clearWarnings.length, 'pozycja została pominięta', 'pozycje zostały pominięte', 'pozycji zostało pominiętych')}. Zamknij programy używające tych plików i powtórz.`,
            runtimeClearResult,
          );
          return;
        }
        addLog('info', 'END PROCESS', 'Wszystkie dane zostały usunięte do zera', runtimeClearResult);
      }, 10);
    } catch (e) {
      console.error("Error clearing dane", e);
      addLog('error', 'END PROCESS', 'Błąd podczas usuwania danych', e);
    }
  };

  // Walidacja pokazuje kontrole jakosci silnika. Wczesniej filtrowala lokalna
  // kopie transakcji, ktorej po przebudowie nic nie zapisuje, wiec zawsze
  // konczyla sie komunikatem "brak bledow" - niezaleznie od stanu danych.
  const handleValidateData = () => {
    addLog('info', 'VALIDATE DATA', 'Rozpoczęto walidację danych');

    if (!engineResult) {
      addLog('warn', 'VALIDATE DATA', 'Silnik nie zwrócił jeszcze wyniku. Przelicz rok, żeby zobaczyć kontrole jakości.');
      return;
    }

    const blocking = engineResult.quality_report?.blocking_issues || [];
    const warningIssues = engineResult.quality_report?.warning_issues || [];
    const errors = blocking.length;
    const warnings = warningIssues.length;

    for (const issue of blocking.slice(0, 20)) {
      addLog('error', 'VALIDATE DATA', `${issue.code}: ${issue.message}`);
    }
    for (const issue of warningIssues.slice(0, 20)) {
      addLog('warn', 'VALIDATE DATA', `${issue.code}: ${issue.message}`);
    }

    if (errors === 0 && warnings === 0) {
      addLog('info', 'VALIDATE DATA', 'Walidacja zakończona. Silnik nie zgłosił blokad ani ostrzeżeń.');
    } else {
      addLog('info', 'VALIDATE DATA', `Walidacja zakończona. Błędy: ${errors}, Ostrzeżenia: ${warnings}`);
    }
  };

  const handleImportComplete = (newFiles: FileInfo[], newLogs: LogEntry[]) => {
    setFiles(prev => {
      // Merge new files with existing, or replace
      return [...prev, ...newFiles.map(f => ({ ...f, isEnabled: false }))];
    });
    setLogs(prev => [...prev, ...newLogs]);
    void loadData();
  };

  const handleOverrideLog = (level: LogEntry['level'], message: string, details?: unknown) => {
    addLog(level, 'WARSTWA OVERRIDE', message, details);
  };

  const handleReportOrganizationStatusChange = async (status: TaxReportOrganizationState) => {
    const next: TaxReportOrganizationStatus = {
      year: selectedYear,
      status,
      updatedAt: new Date().toISOString(),
    };
    setReportOrganizationStatus(next);
    await StorageService.saveTaxReportOrganizationStatus(next);
    addLog('info', 'DEBUG PANEL', `Zmieniono organizacyjny status raportu ${selectedYear}: ${status}`, next);
  };

  /**
   * Wyłączenie pliku z rozliczenia.
   *
   * Przełącznik zapisywał dotąd wyłącznie stan Reacta i wymuszał pełne
   * przeliczenie tym samym zestawem plików - kwota podatku nie mogła się
   * zmienić. Lista wyłączonych plików idzie teraz do localStorage i dalej do
   * silnika (`excludedStorageFiles` -> `--exclude-file`), więc decyzja
   * użytkownika naprawdę zmienia wynik i przeżywa odświeżenie strony.
   *
   * Osobny przycisk "usuń" znikał tylko z widoku i wracał przy najbliższym
   * `loadData`, bo plik zostawał w magazynie; nie ma API kasującego plik, więc
   * został jeden, uczciwy przełącznik.
   */
  const handleToggleFile = async (fileName: string, isEnabled: boolean) => {
    const storage = getBrowserTaxSettingsStorage();
    const excluded = new Set(excludedStorageFilesBase.current);
    if (isEnabled) {
      excluded.delete(fileName);
    } else {
      excluded.add(fileName);
    }
    const merged = mergeAndSaveExcludedStorageFiles(storage, excludedStorageFilesBase.current, [...excluded]);
    excludedStorageFilesBase.current = merged;
    const mergedSet = new Set(merged);
    setFiles(prev => prev.map(f => ({ ...f, isEnabled: !mergedSet.has(f.name) })));
    addLog(
      'info',
      'DEBUG PANEL',
      `${isEnabled ? 'Włączono' : 'Wyłączono'} plik: ${fileName}. Wyłączonych plików: ${merged.length}.`,
    );
    // Zestaw plikow zmienia wynik, wiec silnik musi policzyc rok jeszcze raz.
    setEngineRefreshKey((value) => value + 1);
  };

  const navigateToView = (view: View) => {
    setCurrentView(view);
    setIsMobileMenuOpen(false);
  };

  const openHistorySearch = (query: string, focusRowId?: string | null) => {
    const normalizedQuery = query.trim();
    setHistoryInitialMode(null);
    if (!normalizedQuery) {
      setHistorySearchSeed(null);
      setHistoryFocusRowId(null);
      setCurrentView('historia_transakcji');
      setIsMobileMenuOpen(false);
      return;
    }
    setHistorySearchSeed(normalizedQuery);
    setHistoryFocusRowId(focusRowId?.trim() || null);
    setCurrentView('historia_transakcji');
    setIsMobileMenuOpen(false);
  };

  const openCandidateTransactions = (sourceId?: string | null) => {
    setHistoryInitialMode('candidate');
    setHistorySearchSeed(sourceId?.trim() || null);
    setHistoryFocusRowId(null);
    setCurrentView('historia_transakcji');
    setIsMobileMenuOpen(false);
  };

  const openStorageHistory = () => {
    setHistoryInitialMode('all');
    setHistorySearchSeed(null);
    setHistoryFocusRowId(null);
    setCurrentView('historia_transakcji');
    setIsMobileMenuOpen(false);
  };

  const saveAutoCheckActionOverride = (
    item: AutoCheckItem,
    status: AutoCheckActionOverride['status'],
  ) => {
    const next = upsertAutoCheckActionOverride(autoCheckActionBase.current, {
      itemId: item.id,
      status,
      updatedAt: new Date().toISOString(),
    });
    const merged = mergeAndSaveAutoCheckActionOverrides(getBrowserTaxSettingsStorage(), autoCheckActionBase.current, next);
    autoCheckActionBase.current = merged;
    setAutoCheckActionOverrides(merged);
  };

  const handleMarkAutoCheckDone = (item: AutoCheckItem) => {
    saveAutoCheckActionOverride(item, 'done');
    addLog('info', 'DEBUG PANEL', `Samocheck: oznaczono jako sprawdzone: ${item.title}`, { itemId: item.id });
  };

  const handleHideAutoCheckItem = (item: AutoCheckItem) => {
    saveAutoCheckActionOverride(item, 'hidden');
    addLog('info', 'DEBUG PANEL', `Samocheck: ukryto informację: ${item.title}`, { itemId: item.id });
  };

  const saveBrokerFileActionOverride = (
    action: BrokerFileIntakeActionRow,
    status: BrokerFileActionOverride['status'],
    userNote?: string,
  ) => {
    const next = upsertBrokerFileActionOverride(brokerFileActionBase.current, {
      actionId: action.actionId,
      status,
      userNote,
      linkedRowId: action.linkedRowId || action.historySearchTerm || null,
      updatedAt: new Date().toISOString(),
    });
    const merged = mergeAndSaveBrokerFileActionOverrides(getBrowserTaxSettingsStorage(), brokerFileActionBase.current, next);
    brokerFileActionBase.current = merged;
    setBrokerFileActionOverrides(merged);
  };

  const handleResolveBrokerFileAction = (action: BrokerFileIntakeActionRow, note?: string) => {
    saveBrokerFileActionOverride(action, 'resolved', note || action.userNote);
    addLog('info', 'DEBUG PANEL', `Oznaczono sprawę importu jako rozwiązaną: ${action.label}`, {
      actionId: action.actionId,
    });
  };

  const handleIgnoreBrokerFileAction = (action: BrokerFileIntakeActionRow, note: string) => {
    saveBrokerFileActionOverride(action, 'ignored', note);
    addLog('warn', 'DEBUG PANEL', `Zignorowano sprawę importu z notatką: ${action.label}`, {
      actionId: action.actionId,
      note,
    });
  };


  const normalizeDefenseStatus = (value: string): DefenseEvidenceOverrideStatus => {
    if (value === 'complete' || value === 'missing_link' || value === 'high_risk_review') {
      return value;
    }
    return 'needs_user_evidence';
  };

  const saveDefenseEvidenceItemOverride = (
    item: DefenseWorkbenchItem,
    patch: Partial<DefenseEvidenceOverride>,
  ) => {
    const evidenceId = item.evidenceId || item.linkedCostId || item.checklistId || item.id;
    const current = defenseEvidenceBase.current.find((entry) => entry.evidenceId === evidenceId);
    const now = new Date().toISOString();
    const next = {
      evidenceId,
      defenseStatus: patch.defenseStatus || current?.defenseStatus || normalizeDefenseStatus(item.defenseStatus),
      linkedTradeIds: patch.linkedTradeIds || current?.linkedTradeIds || item.linkedTradeIds,
      linkedRowId: patch.linkedRowId ?? current?.linkedRowId ?? item.linkedRowId ?? item.historyTarget.rowId ?? undefined,
      updatedAt: now,
      userNote: patch.userNote ?? current?.userNote ?? item.localNote ?? undefined,
      evidenceConfirmed: patch.evidenceConfirmed ?? current?.evidenceConfirmed,
      checkedAt: patch.checkedAt ?? current?.checkedAt,
      includedInFilingPackage: patch.includedInFilingPackage ?? current?.includedInFilingPackage,
    };
    const local = [...defenseEvidenceBase.current.filter((entry) => entry.evidenceId !== evidenceId), next];
    const merged = mergeAndSaveDefenseEvidenceOverrides(getBrowserTaxSettingsStorage(), defenseEvidenceBase.current, local);
    defenseEvidenceBase.current = merged;
    setDefenseEvidenceOverrides(merged);
  };

  const handleConfirmEvidence = (item: DefenseWorkbenchItem) => {
    if (taxYearClosureStatus.isReadOnly) {
      addLog('warn', 'WARSTWA OVERRIDE', taxYearReadOnlyMessage, { selectedYear, evidenceId: item.evidenceId });
      return;
    }
    const now = new Date().toISOString();
    saveDefenseEvidenceItemOverride(item, {
      defenseStatus: 'complete',
      evidenceConfirmed: true,
      checkedAt: now,
      includedInFilingPackage: true,
    });
  };

  const handleAddEvidenceNote = (item: DefenseWorkbenchItem) => {
    if (taxYearClosureStatus.isReadOnly) {
      addLog('warn', 'WARSTWA OVERRIDE', taxYearReadOnlyMessage, { selectedYear, evidenceId: item.evidenceId });
      return;
    }
    const note = globalThis.window?.prompt?.('Notatka do dowodu PIT', item.localNote || '');
    if (note === undefined || note === null) {
      return;
    }
    saveDefenseEvidenceItemOverride(item, {
      userNote: note.trim(),
      defenseStatus: item.evidenceConfirmed ? 'complete' : normalizeDefenseStatus(item.defenseStatus),
    });
  };

  const handleLinkEvidenceRow = (item: DefenseWorkbenchItem) => {
    if (taxYearClosureStatus.isReadOnly) {
      addLog('warn', 'WARSTWA OVERRIDE', taxYearReadOnlyMessage, { selectedYear, evidenceId: item.evidenceId });
      return;
    }
    const rowId = globalThis.window?.prompt?.(
      uiLanguage === 'en' ? 'Enter history row ID or source identifier' : 'Podaj ID rekordu historii albo źródłowy identyfikator',
      item.linkedRowId || item.historyTarget.rowId || item.historyTarget.searchTerm,
    );
    if (rowId === undefined || rowId === null || !rowId.trim()) {
      return;
    }
    saveDefenseEvidenceItemOverride(item, {
      linkedRowId: rowId.trim(),
      defenseStatus: item.evidenceConfirmed ? 'complete' : normalizeDefenseStatus(item.defenseStatus),
    });
  };

  const openDefenseWorkbench = () => {
    setCurrentView('centrum_pracy');
    setIsMobileMenuOpen(false);
  };

  const navItems: Array<{ view: View; icon: LucideIcon; label: string }> = uiComplexityMode === 'simple'
    ? [
        { view: 'raport_roczny', icon: CalendarDays, label: t('nav.annualReport') },
        { view: 'historia_transakcji', icon: ListOrdered, label: t('nav.transactionHistory') },
      ]
    : [
        { view: 'raport_roczny', icon: CalendarDays, label: t('nav.annualReport') },
        { view: 'pulpit', icon: LayoutDashboard, label: t('nav.dashboard') },
        { view: 'historia_transakcji', icon: ListOrdered, label: t('nav.transactionHistory') },
        { view: 'centrum_pracy', icon: BriefcaseBusiness, label: t('nav.workspace') },
        { view: 'import_danych', icon: Upload, label: t('nav.importData') },
      ];

  // Funkcja, nie komponent: komponent zdefiniowany w renderze byl dla Reacta
  // nowym typem przy kazdym renderze App - przyciski montowaly sie od nowa i
  // gubily fokus klawiatury. Aktywna pozycja miala w ciemnym motywie jasne tlo
  // bg-blue-50 pod jasnym tekstem (2,4:1).
  const renderNavItem = ({ view, icon: Icon, label }: { view: View, icon: LucideIcon, label: string }) => (
    <button
      type="button"
      onClick={() => navigateToView(view)}
      aria-current={currentView === view ? 'page' : undefined}
      className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-colors ${
        currentView === view
          ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 font-medium'
          : 'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-gray-900 dark:hover:text-white'
      }`}
    >
      <Icon size={20} className={currentView === view ? 'text-blue-600 dark:text-blue-400' : 'text-gray-400'} />
      {label}
    </button>
  );

  return (
    <ErrorBoundary>
      <I18nProvider language={uiLanguage}>
      <div className="flex h-dvh w-full flex-col overflow-hidden bg-gray-50 font-sans transition-colors dark:bg-gray-900 md:flex-row">
        {/* Mobile Header */}
        <div className="md:hidden bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 p-4 flex justify-between items-center sticky top-0 z-20">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
              <span className="text-white font-bold text-lg">I</span>
            </div>
            <span className="font-bold text-gray-900 dark:text-white">InvestAnalyzer</span>
          </div>
          <button onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)} className="text-gray-500">
            {isMobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
          </button>
        </div>

        {/* Sidebar */}
        <div className={`
          fixed inset-y-0 left-0 z-10 w-64 bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 flex flex-col transition-transform duration-300 ease-in-out
          md:relative md:translate-x-0
          ${isMobileMenuOpen ? 'translate-x-0 mt-[73px] md:mt-0' : '-translate-x-full'}
        `}>
          <div className="p-6 hidden md:flex flex-col gap-4 border-b border-gray-100 dark:border-gray-900">
            {onExit && (
              <button 
                onClick={onExit}
                className="flex items-center text-xs text-blue-600 font-bold hover:underline mb-2"
              >
                <ArrowLeft size={14} className="mr-1" /> {t('app.backToHub')}
              </button>
            )}
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center shadow-sm">
                <span className="text-white font-bold text-xl">I</span>
              </div>
              <span className="font-bold text-xl text-gray-900 dark:text-white tracking-tight">InvestAnalyzer</span>
            </div>
          </div>
          
          <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
            {navItems.map((item) => (
              <div key={item.view}>
                {renderNavItem({ view: item.view, icon: item.icon, label: item.label })}
              </div>
            ))}
          </nav>
        </div>

        {/* Overlay for mobile */}
        {isMobileMenuOpen && (
          <div 
            className="fixed inset-0 bg-black/20 z-0 md:hidden"
            onClick={() => setIsMobileMenuOpen(false)}
          />
        )}

        {/* Clear Data Confirm Modal */}
        {showClearConfirm && (
          <div ref={refOknaCzyszczenia} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t('app.clearAllData')} className="outline-none fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
            <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl max-w-md w-full p-6 animate-in zoom-in-95 duration-200">
              <div className="flex items-center gap-4 mb-4 text-red-600">
                <div className="p-3 bg-red-100 rounded-full">
                  <AlertTriangle size={24} />
                </div>
                <h2 className="text-xl font-bold text-gray-900 dark:text-white">{t('app.clearAllData')}</h2>
              </div>
              <p className="text-gray-600 dark:text-gray-400 mb-6">
                {t('app.clearConfirm')}
              </p>
              <div className="flex justify-end gap-3">
                <button 
                  onClick={() => setShowClearConfirm(false)}
                  className="px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg font-medium transition-colors"
                >
                  {t('app.cancel')}
                </button>
                <button 
                  onClick={handleClearData}
                  className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium transition-colors"
                >
                  {t('app.confirmDelete')}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Main Content */}
        <main className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
          {/* Top Header */}
          <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4 md:px-8 py-4 flex justify-between items-center gap-3 shrink-0">
            <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-200 hidden lg:block whitespace-nowrap">
              {currentView === 'pulpit' && t('nav.dashboard')}
              {currentView === 'historia_transakcji' && t('nav.transactionHistory')}
              {currentView === 'raport_roczny' && t('nav.annualReport')}
              {currentView === 'centrum_pracy' && t('nav.workspace')}
              {currentView === 'import_danych' && t('nav.importData')}
            </h2>
            <div className="flex items-center gap-4 ml-auto">
              <div className="hidden items-center rounded-xl border border-gray-200 bg-gray-50 p-1 text-xs font-semibold dark:border-gray-700 dark:bg-gray-900 sm:flex">
                <button
                  type="button"
                  onClick={() => handleUiComplexityModeChange('simple')}
                  className={`rounded-lg px-3 py-1.5 whitespace-nowrap transition-colors ${
                    uiComplexityMode === 'simple'
                      ? 'bg-white text-blue-700 shadow-sm dark:bg-gray-800 dark:text-blue-300'
                      : 'text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100'
                  }`}
                >
                  {t('header.simpleMode')}
                </button>
                <button
                  type="button"
                  onClick={() => handleUiComplexityModeChange('expert')}
                  className={`rounded-lg px-3 py-1.5 whitespace-nowrap transition-colors ${
                    uiComplexityMode === 'expert'
                      ? 'bg-white text-blue-700 shadow-sm dark:bg-gray-800 dark:text-blue-300'
                      : 'text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100'
                  }`}
                >
                  {t('header.expertMode')}
                </button>
              </div>
              <div className="hidden items-center rounded-xl border border-gray-200 bg-gray-50 p-1 text-xs font-semibold dark:border-gray-700 dark:bg-gray-900 sm:flex">
                {(['pl', 'en'] as const).map((language) => (
                  <button
                    key={language}
                    type="button"
                    onClick={() => handleUiLanguageChange(language)}
                    className={`rounded-lg px-3 py-1.5 whitespace-nowrap transition-colors ${
                      uiLanguage === language
                        ? 'bg-white text-blue-700 shadow-sm dark:bg-gray-800 dark:text-blue-300'
                        : 'text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100'
                    }`}
                  >
                    {language === 'pl' ? 'PL' : 'EN'}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <label htmlFor="year-select" className="text-sm font-medium text-gray-600 dark:text-gray-400 whitespace-nowrap">{t('header.analysisYear')}</label>
                <select
                  id="year-select"
                  value={selectedYear || new Date().getFullYear()}
                  onChange={(e) => setSelectedYear(Number(e.target.value))}
                  className="border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 rounded-lg px-3 py-1.5 text-sm font-medium text-gray-800 dark:text-gray-200 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                >
                  {availableYears.map(year => (
                    <option key={year} value={year}>{year}</option>
                  ))}
                </select>
              </div>
            </div>
          </header>

          {(engineLoading || packageLoading) && (
            <EngineRunStatusBanner
              status={silnikJobStatus}
              isPackageRun={packageLoading}
              label={t}
            />
          )}

          <div className="flex-1 w-full overflow-y-auto p-4 md:p-8 custom-scrollbar ia-scroll-container">
            {isLoading ? (
              <div className="flex items-center justify-center h-full">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
              </div>
            ) : (
              <div className="animate-in fade-in duration-300">
                <Suspense fallback={<ViewLoadingFallback />}>
                  {currentView === 'pulpit' && (
                    <Dashboard
                      selectedYear={selectedYear}
                      engineLoading={engineLoading}
                      engineResult={staleEngineResult}
                      engineStale={engineStale}
                    />
                  )}
                  {currentView === 'centrum_pracy' && (
                    <WorkspaceCenter
                      selectedYear={selectedYear}
                      engineLoading={engineLoading}
                      engineResult={engineResult}
                      files={files}
                      logs={logs}
                      overrideCount={overrideCount}
                      reportOrganizationStatus={reportOrganizationStatus}
                      onNavigate={navigateToView}
                      onOpenHistorySearch={openHistorySearch}
                      defenseEvidenceOverrides={defenseEvidenceOverrides}
                      brokerFileActionOverrides={brokerFileActionOverrides}
                      autoCheckActionOverrides={autoCheckActionOverrides}
                      onConfirmEvidence={handleConfirmEvidence}
                      onAddEvidenceNote={handleAddEvidenceNote}
                      onLinkEvidenceRow={handleLinkEvidenceRow}
                      onMarkAutoCheckDone={handleMarkAutoCheckDone}
                      onHideAutoCheckItem={handleHideAutoCheckItem}
                      uiComplexityMode={uiComplexityMode}
                      onOpenInsight={setActiveInsightDrawer}
                    />
                  )}
                  {currentView === 'historia_transakcji' && (
                    <Transactions
                      selectedYear={selectedYear}
                      engineHistoryRows={engineResult?.transaction_history_rows || []}
                      privateCashFxViewRows={engineResult?.private_cash_fx_view || []}
                      editableRecords={engineResult?.editable_records || []}
                      initialSearchTerm={historySearchSeed}
                      initialFocusRowId={historyFocusRowId}
                      initialHistoryViewMode={historyInitialMode}
                      onInitialSearchConsumed={() => {
                        setHistorySearchSeed(null);
                        setHistoryFocusRowId(null);
                        setHistoryInitialMode(null);
                      }}
                      candidateTransactionPreviewRows={auditAppendix?.candidate_transaction_preview_rows || []}
                      canonicalStorageHistoryRows={auditAppendix?.canonical_storage_history_rows || []}
                      canonicalStorageHistorySummary={auditAppendix?.canonical_storage_history_summary || {}}
                      transactionDossiers={auditAppendix?.transaction_dossiers || []}
                      transactionDossierSummary={auditAppendix?.transaction_dossier_summary || {}}
                      fieldSourceMap={auditAppendix?.field_source_map || {}}
                      transactionConflicts={auditAppendix?.transaction_conflicts || []}
                      aiExtractedContext={auditAppendix?.ai_extracted_context || []}
                      onRefreshEngine={loadData}
                      onAddLog={handleOverrideLog}
                      defenseWorkbenchItems={defenseWorkbench.items}
                      defenseEvidenceOverrides={defenseEvidenceOverrides}
                      brokerActionWorkbench={brokerActionWorkbench}
                      onConfirmEvidence={handleConfirmEvidence}
                      onAddEvidenceNote={handleAddEvidenceNote}
                      isTaxYearReadOnly={taxYearClosureStatus.isReadOnly}
                      taxYearReadOnlyMessage={taxYearReadOnlyMessage}
                      uiComplexityMode={uiComplexityMode}
                      onOpenInsight={setActiveInsightDrawer}
                    />
                  )}
                  {currentView === 'raport_roczny' && (
                    <YearlyReport
                      selectedYear={selectedYear}
                      engineLoading={engineLoading}
                      packageLoading={packageLoading}
                      engineResult={staleEngineResult}
                      engineStale={engineStale}
                      canUseEngineResult={canUseEngineResult}
                      runPythonEngine={runPythonEngine}
                      reportOrganizationStatus={reportOrganizationStatus}
                      onReportOrganizationStatusChange={handleReportOrganizationStatusChange}
                      onOpenHistorySearch={openHistorySearch}
                      onOpenCandidateTransactions={openCandidateTransactions}
                      onOpenStorageHistory={openStorageHistory}
                      defenseEvidenceOverrides={defenseEvidenceOverrides}
                      defenseWorkbenchItems={defenseWorkbench.items}
                      brokerFileActionOverrides={brokerFileActionOverrides}
                      brokerActionWorkbench={brokerActionWorkbench}
                      onOpenImport={() => navigateToView('import_danych')}
                      onOpenDefenseWorkbench={openDefenseWorkbench}
                      uiComplexityMode={uiComplexityMode}
                      onOpenInsight={setActiveInsightDrawer}
                      onRequestExpertMode={() => handleUiComplexityModeChange('expert')}
                    />
                  )}
                  {currentView === 'import_danych' && (
                    <ImportData
                      onImportComplete={handleImportComplete}
                      auditAppendix={auditAppendix}
                      files={files}
                      processedStorageFiles={processedStorageFiles}
                      brokerFileActionOverrides={brokerFileActionOverrides}
                      onResolveBrokerFileAction={handleResolveBrokerFileAction}
                      onIgnoreBrokerFileAction={handleIgnoreBrokerFileAction}
                      onOpenHistorySearch={openHistorySearch}
                      onOpenCandidateTransactions={openCandidateTransactions}
                      onOpenStorageHistory={openStorageHistory}
                      uiComplexityMode={uiComplexityMode}
                      onOpenInsight={setActiveInsightDrawer}
                      selectedYear={selectedYear}
                    />
                  )}
                </Suspense>
              </div>
            )}
          </div>
        </main>

        <Suspense fallback={null}>
          <InvestSettingsPanel
            onClearData={() => setShowClearConfirm(true)}
            files={files}
            logs={logs}
            auditAppendix={auditAppendix}
            processedStorageFiles={processedStorageFiles}
            onReload={loadData}
            onValidate={handleValidateData}
            onToggleFile={handleToggleFile}
            uiComplexityMode={uiComplexityMode}
            onUiComplexityModeChange={handleUiComplexityModeChange}
            uiLanguage={uiLanguage}
            onUiLanguageChange={handleUiLanguageChange}
          />
        </Suspense>

        <InsightDrawer
          open={Boolean(activeInsightDrawer)}
          title={activeInsightDrawer?.title || t('drawer.details')}
          subtitle={activeInsightDrawer?.subtitle}
          sections={activeInsightDrawer?.sections || []}
          actions={activeInsightDrawer?.actions || []}
          onClose={() => setActiveInsightDrawer(null)}
        >
          {activeInsightDrawer?.children}
        </InsightDrawer>
      </div>
      </I18nProvider>
    </ErrorBoundary>
  );
}
