import React, { useState, useEffect, useMemo } from 'react';
import { useZamknijEscape } from '../../shared/useZamknijEscape';
import { formatLiczba } from '../../portfel/services/nbpService';
import { BackupPanel } from './BackupPanel';
import { KwarantannaPanel } from './KwarantannaPanel';
import { Settings, X, Moon, Sun, Trash2, ShieldAlert, Cpu, Bug, CheckCircle, AlertTriangle, RefreshCw, Download, FolderOpen, HardDrive } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { StorageService } from '../services/storage';
import { FileInfo, LogEntry } from '../types';
import { ensureFundingFeeEntries, getBrowserTaxSettingsStorage, mergeAndSaveFundingFeeEntries, type FundingFeeEntry } from '../services/taxEngineConfig';
import {
  getActionButtonLabelMode,
  saveActionButtonLabelMode,
  type ActionButtonLabelMode,
  type UiComplexityMode,
  type UiLanguage,
} from '../services/uiPreferences';
import { useI18n } from '../services/i18n';
import { formatLogStageLabel } from '../services/logStages';
import { zbudujKontekstDiagnostyczny } from '../services/kontekstDiagnostyczny';
import {
  buildDisplayLogEntries,
  countBlockingDisplayLogs,
  userFacingLogKindLabel,
} from '../services/displayLogs';
import { buildBrokerFileIntakeSummary } from '../services/brokerFileIntake';
import {
  runtimeApi,
  type AppPaths,
  type LegacyStorageStatus,
  type OllamaConfig,
  type OllamaModelInfo,
  type OllamaStatus,
  type RuntimeInfo,
  type StorageMigrationStatus,
} from '../services/runtimeApi';
import type { TaxFilingPackageAuditAppendix } from '../hooks/useTaxEngineRun';
import { useUiMotion } from './cockpit/uiMotion';
import { REQUEST_CONTRACT_VERSION } from '../constants';
import { odczytajMotyw, zapiszMotywWszedzie, ZDARZENIE_PREFERENCJI, type Motyw } from '../../portfel/services/preferencesBridge';
import { dzisiajLokalnie } from '../../portfel/services/formularzTransakcji';
import { odmienLiczebnik } from '../../portfel/services/odmianaLiczebnika';

interface InvestSettingsPanelProps {
  onClearData: () => void;
  files: FileInfo[];
  logs: LogEntry[];
  auditAppendix?: TaxFilingPackageAuditAppendix | null;
  processedStorageFiles?: string[];
  onReload: () => void;
  onValidate: () => void;
  onToggleFile?: (fileName: string, isEnabled: boolean) => void;
  uiComplexityMode?: UiComplexityMode;
  onUiComplexityModeChange?: (mode: UiComplexityMode) => void;
  uiLanguage?: UiLanguage;
  onUiLanguageChange?: (language: UiLanguage) => void;
}

/** Pierwsza podana liczba albo myslnik - nigdy stala wpisana w kod. */
function liczbaAlboKreska(...wartosci: Array<number | undefined | null>): string {
  for (const wartosc of wartosci) {
    if (typeof wartosc === 'number') return String(wartosc);
  }
  return '—';
}

export function InvestSettingsPanel({
  onClearData,
  files,
  logs,
  auditAppendix,
  processedStorageFiles = [],
  onReload,
  onValidate,
  onToggleFile,
  uiComplexityMode = 'simple',
  onUiComplexityModeChange,
  uiLanguage = 'pl',
  onUiLanguageChange,
}: InvestSettingsPanelProps) {
  const { t } = useI18n();
  const uiMotion = useUiMotion();
  const taxSettingsStorage = getBrowserTaxSettingsStorage();
  const [isOpen, setIsOpen] = useState(false);
  const refPaneluUstawien = useZamknijEscape(isOpen, () => setIsOpen(false));
  // Motyw jest wspolny z powloka portfela. Wczesniej panel mial wlasny stan
  // zapisywany tylko pod kluczem silnika: przy starcie wygrywal klucz portfela,
  // wiec wybor stad znikal po przeladowaniu, a pasek dolny pokazywal inny motyw.
  const [theme, setThemeState] = useState<Motyw>(() => odczytajMotyw());
  const setTheme = (motyw: Motyw) => {
    setThemeState(motyw);
    zapiszMotywWszedzie(motyw);
  };
  const [activeTab, setActiveTab] = useState<'dane' | 'tax' | 'history' | 'logs' | 'advanced'>('tax');
  const [logFilter, setLogFilter] = useState<'all' | 'error' | 'warn' | 'info'>('all');
  const [taxPlan, setTaxPlan] = useState<'aggressive_user' | 'balanced_user' | 'conservative_user'>(() =>
    (taxSettingsStorage.getItem('taxCalculationPlan') as 'aggressive_user' | 'balanced_user' | 'conservative_user') || 'aggressive_user'
  );
  const [showAdvancedPlans, setShowAdvancedPlans] = useState(() =>
    taxSettingsStorage.getItem('showAdvancedTaxPlans') === 'true'
  );
  const [includeFxConversionCosts, setIncludeFxConversionCosts] = useState(() =>
    taxSettingsStorage.getItem('includeFxConversionCosts') !== 'false'
  );
  const [includeBankFundingFees, setIncludeBankFundingFees] = useState(() =>
    taxSettingsStorage.getItem('includeBankFundingFees') !== 'false'
  );
  const [includeInterestCosts, setIncludeInterestCosts] = useState(() =>
    taxSettingsStorage.getItem('includeInterestCosts') !== 'false'
  );
  const [includeAccountFees, setIncludeAccountFees] = useState(() =>
    taxSettingsStorage.getItem('includeAccountFees') !== 'false'
  );
  const [fundingFeeEntries, setFundingFeeEntries] = useState<FundingFeeEntry[]>(() =>
    ensureFundingFeeEntries(taxSettingsStorage)
  );
  const fundingFeeBase = React.useRef<FundingFeeEntry[]>(fundingFeeEntries);
  const [actionButtonMode, setActionButtonMode] = useState<ActionButtonLabelMode>(() =>
    getActionButtonLabelMode(taxSettingsStorage)
  );
  const [aiNormalizerEnabled, setAiNormalizerEnabled] = useState(() =>
    taxSettingsStorage.getItem('aiNormalizerEnabled') === 'true'
  );
  const [showDataDetails, setShowDataDetails] = useState(false);
  const [aiCopyStatus, setAiCopyStatus] = useState<string | null>(null);
  const [runtimeInfo, setRuntimeInfo] = useState<RuntimeInfo | null>(null);
  const [appPaths, setAppPaths] = useState<AppPaths | null>(null);
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus | null>(null);
  const [ollamaModels, setOllamaModels] = useState<OllamaModelInfo[]>([]);
  const [ollamaConfigDraft, setOllamaConfigDraft] = useState<OllamaConfig>({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen3:14b',
    exePath: '',
    gpuMode: 'gpu',
    numGpu: -1,
    gpuBackend: 'vulkan',
    gpuLoadLimitPercent: 85,
    numBatch: 128,
    maxParallel: 1,
  });
  const [isStartingOllama, setIsStartingOllama] = useState(false);
  const [ollamaActionStatus, setOllamaActionStatus] = useState<string | null>(null);
  const [desktopActionStatus, setDesktopActionStatus] = useState<string | null>(null);
  const [isLoadingDesktopInfo, setIsLoadingDesktopInfo] = useState(false);
  const [legacyStorageStatus, setLegacyStorageStatus] = useState<LegacyStorageStatus | null>(null);
  const [legacyStorageError, setLegacyStorageError] = useState<string | null>(null);
  const [storageMigrationStatus, setStorageMigrationStatus] = useState<StorageMigrationStatus | null>(null);
  const displayLogs = useMemo(() => buildDisplayLogEntries(logs), [logs]);
  const blockingLogCount = useMemo(() => countBlockingDisplayLogs(displayLogs), [displayLogs]);
  const brokerFileSummary = useMemo(
    () => buildBrokerFileIntakeSummary(auditAppendix, files, processedStorageFiles),
    [auditAppendix, files, processedStorageFiles],
  );
  const sourceInventoryRows = brokerFileSummary.sourceRows;
  const activeTaxSourceRows = sourceInventoryRows.filter((source) => ['transaction_source', 'transaction_report', 'primary_tax', 'baseline_tax', 'tax'].includes(source.role));
  const supportingSourceRows = sourceInventoryRows.filter((source) => !activeTaxSourceRows.includes(source));
  const daneTabCount = Math.max(sourceInventoryRows.length, files.length);

  useEffect(() => {
    const zsynchronizuj = () => setThemeState(odczytajMotyw());
    window.addEventListener(ZDARZENIE_PREFERENCJI, zsynchronizuj);
    return () => window.removeEventListener(ZDARZENIE_PREFERENCJI, zsynchronizuj);
  }, []);

  useEffect(() => {
    taxSettingsStorage.setItem('taxCalculationPlan', taxPlan);
  }, [taxPlan, taxSettingsStorage]);

  useEffect(() => {
    taxSettingsStorage.setItem('showAdvancedTaxPlans', showAdvancedPlans ? 'true' : 'false');
  }, [showAdvancedPlans, taxSettingsStorage]);

  useEffect(() => {
    const changed = taxSettingsStorage.getItem('includeFxConversionCosts') !== String(includeFxConversionCosts);
    taxSettingsStorage.setItem('includeFxConversionCosts', includeFxConversionCosts ? 'true' : 'false');
    if (changed) globalThis.window?.dispatchEvent(new Event('tax-input-changed'));
  }, [includeFxConversionCosts, taxSettingsStorage]);

  useEffect(() => {
    const changed = taxSettingsStorage.getItem('includeBankFundingFees') !== String(includeBankFundingFees);
    taxSettingsStorage.setItem('includeBankFundingFees', includeBankFundingFees ? 'true' : 'false');
    if (changed) globalThis.window?.dispatchEvent(new Event('tax-input-changed'));
  }, [includeBankFundingFees, taxSettingsStorage]);

  useEffect(() => {
    const changed = taxSettingsStorage.getItem('includeInterestCosts') !== String(includeInterestCosts);
    taxSettingsStorage.setItem('includeInterestCosts', includeInterestCosts ? 'true' : 'false');
    if (changed) globalThis.window?.dispatchEvent(new Event('tax-input-changed'));
  }, [includeInterestCosts, taxSettingsStorage]);

  useEffect(() => {
    const changed = taxSettingsStorage.getItem('includeAccountFees') !== String(includeAccountFees);
    taxSettingsStorage.setItem('includeAccountFees', includeAccountFees ? 'true' : 'false');
    if (changed) globalThis.window?.dispatchEvent(new Event('tax-input-changed'));
  }, [includeAccountFees, taxSettingsStorage]);

  useEffect(() => {
    const merged = mergeAndSaveFundingFeeEntries(taxSettingsStorage, fundingFeeBase.current, fundingFeeEntries);
    fundingFeeBase.current = merged;
    if (JSON.stringify(merged) !== JSON.stringify(fundingFeeEntries)) setFundingFeeEntries(merged);
  }, [fundingFeeEntries, taxSettingsStorage]);

  useEffect(() => {
    const changed = (taxSettingsStorage.getItem('aiNormalizerEnabled') === 'true') !== aiNormalizerEnabled;
    taxSettingsStorage.setItem('aiNormalizerEnabled', aiNormalizerEnabled ? 'true' : 'false');
    // Zmiana przelacznika zmienia zadanie do silnika - wynik ma byc od razu NIEAKTUALNY.
    if (changed) globalThis.window?.dispatchEvent(new Event('tax-input-changed'));
  }, [aiNormalizerEnabled, taxSettingsStorage]);

  useEffect(() => {
    if (!isOpen || activeTab !== 'advanced') return;
    let isCancelled = false;
    setIsLoadingDesktopInfo(true);
    Promise.all([
      runtimeApi.getRuntimeInfo(),
      runtimeApi.getAppPaths(),
      runtimeApi.getOllamaStatus(),
      runtimeApi.getStorageMigrationStatus(),
    ])
      .then(([runtime, paths, ollama, migrationStatus]) => {
        if (isCancelled) return;
        setRuntimeInfo(runtime);
        setAppPaths(paths);
        setOllamaStatus(ollama);
        setOllamaModels(ollama.models || []);
        setOllamaConfigDraft((draft) => ({
          ...draft,
          baseUrl: ollama.baseUrl || draft.baseUrl,
          model: ollama.model || draft.model,
          exePath: ollama.exePath || draft.exePath || '',
          gpuMode: ollama.gpuMode || draft.gpuMode || 'gpu',
          numGpu: typeof ollama.numGpu === 'number' ? ollama.numGpu : (draft.numGpu ?? -1),
          gpuBackend: ollama.gpuBackend || draft.gpuBackend || 'vulkan',
          gpuLoadLimitPercent: typeof ollama.gpuLoadLimitPercent === 'number' ? ollama.gpuLoadLimitPercent : (draft.gpuLoadLimitPercent ?? 85),
          numBatch: typeof ollama.numBatch === 'number' ? ollama.numBatch : (draft.numBatch ?? 128),
          maxParallel: typeof ollama.maxParallel === 'number' ? ollama.maxParallel : (draft.maxParallel ?? 1),
        }));
        setStorageMigrationStatus(migrationStatus);
        setDesktopActionStatus(null);
      })
      .catch((error) => {
        if (isCancelled) return;
        setDesktopActionStatus(error instanceof Error ? error.message : 'Nie udało się odczytać informacji runtime.');
      })
      .finally(() => {
        if (!isCancelled) setIsLoadingDesktopInfo(false);
      });
    runtimeApi.detectLegacyStorage()
      .then((status) => {
        if (isCancelled) return;
        setLegacyStorageStatus(status);
        setLegacyStorageError(null);
      })
      .catch((error) => {
        if (isCancelled) return;
        setLegacyStorageStatus(null);
        setLegacyStorageError(error instanceof Error ? error.message : 'Nie udało się sprawdzić starego magazynu.');
      });
    return () => {
      isCancelled = true;
    };
  }, [activeTab, isOpen]);

  const updateFundingFeeEntry = (id: string, patch: Partial<FundingFeeEntry>) => {
    setFundingFeeEntries((entries) => entries.map((entry) => entry.id === id ? { ...entry, ...patch } : entry));
  };

  const addFundingFeeEntry = () => {
    setFundingFeeEntries((entries) => [
      ...entries,
      {
        id: `funding-fee-${entries.length + 1}-${Date.now()}`,
        amount: '',
        currency: 'PLN',
        date: '',
        depositId: '',
        depositAmount: '',
        evidenceNote: '',
      },
    ]);
  };

  const removeFundingFeeEntry = (id: string) => {
    setFundingFeeEntries((entries) => entries.filter((entry) => entry.id !== id));
  };

  const applyTaxSettings = () => {
    globalThis.window?.dispatchEvent(new Event('tax-plan-changed'));
    onReload();
  };

  /**
   * Zapis ustawien AI. Przycisk "Zastosuj ustawienia AI" wolal
   * `applyTaxSettings`, ktory tylko przeladowywal silnik - zmieniony model,
   * backend czy limit GPU nigdy nie trafialy do `setOllamaConfig`, a ekran
   * zachowywal sie tak, jakby je przyjeto.
   */
  const applyAiSettings = async () => {
    setOllamaActionStatus('Zapisywanie ustawień AI...');
    try {
      await runtimeApi.setOllamaConfig(ollamaConfigDraft);
      await refreshOllamaStatus();
      setOllamaActionStatus('Zapisano ustawienia AI.');
      globalThis.window?.dispatchEvent(new Event('tax-plan-changed'));
      onReload();
    } catch (error) {
      setOllamaActionStatus(
        error instanceof Error ? error.message : 'Nie udało się zapisać ustawień AI.'
      );
    }
  };

  const refreshOllamaStatus = async () => {
    setOllamaActionStatus(null);
    const status = await runtimeApi.testOllamaGpu();
    setOllamaStatus(status);
    setOllamaModels(status.models || []);
    setOllamaConfigDraft((draft) => ({
      ...draft,
      baseUrl: status.baseUrl || draft.baseUrl,
      model: status.model || draft.model,
      exePath: status.exePath || draft.exePath || '',
      gpuMode: status.gpuMode || draft.gpuMode || 'gpu',
      numGpu: typeof status.numGpu === 'number' ? status.numGpu : (draft.numGpu ?? -1),
      gpuBackend: status.gpuBackend || draft.gpuBackend || 'vulkan',
      gpuLoadLimitPercent: typeof status.gpuLoadLimitPercent === 'number' ? status.gpuLoadLimitPercent : (draft.gpuLoadLimitPercent ?? 85),
      numBatch: typeof status.numBatch === 'number' ? status.numBatch : (draft.numBatch ?? 128),
      maxParallel: typeof status.maxParallel === 'number' ? status.maxParallel : (draft.maxParallel ?? 1),
    }));
    return status;
  };

  const handleStartOllama = async () => {
    setIsStartingOllama(true);
    setOllamaActionStatus('Uruchamianie Ollama...');
    try {
      await runtimeApi.setOllamaConfig(ollamaConfigDraft);
      const result = await runtimeApi.ensureOllamaRunning({
        requireGpu: true,
        restartIfGpuUnconfirmed: true,
      });
      setOllamaStatus(result.status);
      setOllamaModels(result.status.models || []);
      setOllamaActionStatus(result.message);
    } catch (error) {
      setOllamaActionStatus(error instanceof Error ? error.message : 'Nie udało się uruchomić Ollama.');
    } finally {
      setIsStartingOllama(false);
    }
  };

  const handleSaveOllamaConfig = async () => {
    try {
      await runtimeApi.setOllamaConfig(ollamaConfigDraft);
      await refreshOllamaStatus();
      setOllamaActionStatus('Konfiguracja Ollama zapisana.');
    } catch (error) {
      setOllamaActionStatus(error instanceof Error ? error.message : 'Nie udało się zapisać konfiguracji Ollama.');
    }
  };

  const handleTestOllama = async () => {
    try {
      await runtimeApi.setOllamaConfig(ollamaConfigDraft);
      const status = await runtimeApi.testOllamaGpu();
      setOllamaStatus(status);
      setOllamaModels(status.models || []);
      setOllamaActionStatus(
        status.gpuConfirmed
          ? `GPU potwierdzone (${status.gpuBackend || status.computeBackend}). AI może używać Ollama.`
          : `GPU niepotwierdzone. AI wyłączona bez CPU fallbacku. ${status.gpuFailureReason || ''}`,
      );
    } catch (error) {
      setOllamaActionStatus(error instanceof Error ? error.message : 'Nie udało się przetestować Ollama.');
    }
  };

  const handleAiNormalizerToggle = async (enabled: boolean) => {
    if (!enabled) {
      setAiNormalizerEnabled(false);
      return;
    }
    setIsStartingOllama(true);
    setOllamaActionStatus('Sprawdzam Ollama przed włączeniem AI normalizera...');
    try {
      await runtimeApi.setOllamaConfig(ollamaConfigDraft);
      const result = await runtimeApi.ensureOllamaRunning({
        requireGpu: true,
        restartIfGpuUnconfirmed: true,
      });
      setOllamaStatus(result.status);
      setOllamaModels(result.status.models || []);
      setOllamaActionStatus(result.message);
      setAiNormalizerEnabled(result.status.gpuConfirmed && result.status.computeBackend === 'gpu');
    } catch (error) {
      setAiNormalizerEnabled(false);
      setOllamaActionStatus(error instanceof Error ? error.message : 'Ollama niedostępna. AI normalizer nie został włączony.');
    } finally {
      setIsStartingOllama(false);
    }
  };

  const copyAiContext = async () => {
    // Bez nazw wyciagow i tresci logow: schowek zwykle trafia do zewnetrznego AI.
    const context = zbudujKontekstDiagnostyczny({ taxPlan, files, logs: displayLogs, formatStage: formatLogStageLabel });
    try {
      await navigator.clipboard.writeText(context);
      setAiCopyStatus('Skopiowano kontekst diagnostyczny.');
    } catch {
      setAiCopyStatus('Nie udało się skopiować kontekstu.');
    }
  };

  const openDesktopLocation = async (target: 'storage' | 'artifacts') => {
    setDesktopActionStatus(null);
    try {
      await runtimeApi.openArtifact(target === 'storage' ? '__storage__' : '__artifacts__');
      setDesktopActionStatus(target === 'storage' ? t('desktop.storageOpened') : t('desktop.artifactsOpened'));
    } catch (error) {
      setDesktopActionStatus(error instanceof Error ? error.message : t('desktop.actionFailed'));
    }
  };

  const exportDesktopDiagnostics = async (mode: 'safe' | 'anonymized' | 'full' = 'safe') => {
    setDesktopActionStatus(null);
    try {
      const result = await runtimeApi.exportDiagnosticsBundle({ mode });
      setDesktopActionStatus(t('desktop.diagnosticsExported', { path: result.path }));
    } catch (error) {
      setDesktopActionStatus(error instanceof Error ? error.message : t('desktop.actionFailed'));
    }
  };

  const copyLegacyStorage = async () => {
    setDesktopActionStatus(null);
    try {
      const result = await runtimeApi.copyLegacyStorageToAppData();
      setDesktopActionStatus(t('desktop.storageMigrationCopied', {
        copied: result.copied,
        skipped: result.skipped,
        path: result.manifestPath,
      }));
      const [legacyStorage, migrationStatus] = await Promise.all([
        runtimeApi.detectLegacyStorage(),
        runtimeApi.getStorageMigrationStatus(),
      ]);
      setLegacyStorageStatus(legacyStorage);
      setStorageMigrationStatus(migrationStatus);
      onReload();
    } catch (error) {
      setDesktopActionStatus(error instanceof Error ? error.message : t('desktop.actionFailed'));
    }
  };

  const filteredLogs = displayLogs.filter(log => logFilter === 'all' || log.displayLevel === logFilter);
  const isDesktopRuntime = runtimeInfo?.runtime === 'tauri';

  return (
    <>
      <motion.button
        data-motion="settings-launcher"
        onClick={() => setIsOpen(true)}
        whileHover={uiMotion.hoverSpin}
        whileTap={uiMotion.tapPress}
        className="fixed bottom-24 left-4 p-3 bg-indigo-600 text-white dark:bg-indigo-500 rounded-full shadow-lg hover:rotate-90 transition-transform duration-300 z-50 flex items-center justify-center group"
        title={t('settings.title')}
      >
        <Settings className="w-6 h-6" />
        {blockingLogCount > 0 && (
          <span className="absolute -top-1 -right-1 bg-red-600 text-white text-xs w-5 h-5 flex items-center justify-center rounded-full">
            {blockingLogCount}
          </span>
        )}
      </motion.button>

      <AnimatePresence>
      {isOpen && (
        <motion.div data-motion="settings-backdrop" className="fixed inset-0 bg-black/50 z-50 flex justify-start" {...uiMotion.fadeIn()} exit={{ opacity: 0 }}>
          <motion.div ref={refPaneluUstawien} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t('settings.title')} data-motion="settings-panel" className="outline-none w-full max-w-2xl bg-white dark:bg-gray-900 h-full shadow-2xl flex flex-col relative" {...uiMotion.drawerPanel}>
            <div className="p-4 border-b dark:border-gray-800 flex justify-between items-center bg-gray-50 dark:bg-gray-900 absolute top-0 left-0 right-0 z-10">
              <h2 className="text-xl font-bold flex items-center dark:text-white">
                <Settings className="w-5 h-5 mr-2 text-indigo-600" />
                {t('settings.title')}
              </h2>
              <button onClick={() => setIsOpen(false)} className="p-2 bg-gray-200 dark:bg-gray-800 rounded-full hover:bg-gray-300 dark:hover:bg-gray-700 transition">
                <X className="w-5 h-5 text-gray-700 dark:text-gray-300" />
              </button>
            </div>

            <div className="flex border-b border-gray-100 dark:border-gray-800 mt-[72px] bg-white dark:bg-gray-900 shrink-0 relative z-20 shadow-sm overflow-x-auto custom-scrollbar">
              {[
                { id: 'dane', label: t('settings.dane'), count: daneTabCount },
                { id: 'tax', label: t('settings.tax') },
                { id: 'history', label: t('settings.history') },
                { id: 'logs', label: t('settings.logs'), count: blockingLogCount },
                { id: 'advanced', label: t('settings.advanced') },
              ].map((tab) => (
                <button
                  key={tab.id}
                  className={`min-w-fit flex-1 px-4 py-3 text-sm font-semibold transition-all relative flex items-center justify-center gap-1.5 ${
                    activeTab === tab.id
                      ? 'text-indigo-600 dark:text-indigo-400 bg-indigo-50/50 dark:bg-indigo-500/10'
                      : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800/50'
                  }`}
                  onClick={() => setActiveTab(tab.id as typeof activeTab)}
                >
                  {tab.label}
                  {typeof tab.count === 'number' && tab.count > 0 && (
                    <span className={`text-[10px] py-0.5 px-2 rounded-full ${
                      activeTab === tab.id
                        ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300'
                        : tab.id === 'logs'
                          ? 'bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-400'
                          : 'bg-gray-100 text-gray-500 dark:bg-gray-800'
                    }`}>
                      {tab.count}
                    </span>
                  )}
                  {activeTab === tab.id && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-indigo-600 dark:bg-indigo-400" />}
                </button>
              ))}
            </div>

            {/* Content Area */}
            <div className="flex-1 overflow-y-auto bg-gray-50 dark:bg-gray-900/50 p-6 custom-scrollbar relative">
              {activeTab === 'tax' && (
                <div className="space-y-6">
                  <div className="hidden bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl p-5 shadow-sm">
                    <h3 className="text-sm font-bold tracking-wider text-gray-800 dark:text-gray-200 mb-4 flex items-center gap-2">
                      <Sun className="w-4 h-4 text-orange-500" />
                      Motyw interfejsu
                    </h3>
                    <div className="flex bg-gray-100 dark:bg-gray-900/50 p-1 rounded-lg">
                      <button
                        onClick={() => setTheme('light')}
                        className={`flex-1 flex justify-center items-center py-2 text-sm font-medium rounded-md transition-all ${theme === 'light' ? 'bg-white dark:bg-gray-800 shadow text-indigo-600 dark:text-indigo-400' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'}`}
                      >
                        <Sun className="w-4 h-4 mr-2" /> Jasny
                      </button>
                      <button
                        onClick={() => setTheme('dark')}
                        className={`flex-1 flex justify-center items-center py-2 text-sm font-medium rounded-md transition-all ${theme === 'dark' ? 'bg-gray-800 shadow text-indigo-400' : 'text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200'}`}
                      >
                        <Moon className="w-4 h-4 mr-2" /> Ciemny
                      </button>
                    </div>
                  </div>

                  <div className="hidden bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl p-5 shadow-sm">
                    <h3 className="text-sm font-bold tracking-wider text-gray-800 dark:text-gray-200 mb-4 flex items-center gap-2">
                      <Cpu className="w-4 h-4 text-purple-500" />
                      Sztuczna inteligencja
                    </h3>
                    <div className="bg-purple-50 dark:bg-purple-900/20 text-purple-800 dark:text-purple-300 p-4 rounded-xl text-sm border border-purple-100 dark:border-purple-800/50">
                      <p className="font-semibold mb-2 text-base">Asystent analizy dokumentów i logów</p>
                      <p className="text-sm opacity-90 leading-relaxed text-purple-700 dark:text-purple-300">
                        Ten moduł nie liczy podatku i nie zmienia danych silnika. Przygotowuje kontekst z plików, logów i ustawień, który możesz wykorzystać do analizy importu, opisania problemu lub konsultacji.
                      </p>
                      <button
                        type="button"
                        onClick={copyAiContext}
                        className="mt-3 inline-flex items-center gap-2 rounded-lg border border-purple-200 bg-white px-3 py-2 text-xs font-semibold text-purple-700 hover:bg-purple-100 dark:border-purple-800 dark:bg-purple-950/30 dark:text-purple-300 dark:hover:bg-purple-900/40"
                      >
                        <Download size={14} />
                        Skopiuj kontekst diagnostyczny
                      </button>
                      {aiCopyStatus && <p className="mt-2 text-xs text-purple-700 dark:text-purple-300">{aiCopyStatus}</p>}
                    </div>
                  </div>

                  <div className="hidden bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl p-5 shadow-sm space-y-4">
                    <h3 className="text-sm font-bold tracking-wider text-gray-800 dark:text-gray-200">Wygląd historii transakcji</h3>
                    <div className="grid grid-cols-1 gap-3 text-sm text-gray-700 dark:text-gray-300">
                      <label className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
                        <span>Przyciski akcji: ikona i pełny tekst</span>
                        <input
                          type="radio"
                          name="action-button-mode"
                          checked={actionButtonMode === 'full'}
                          onChange={() => {
                            setActionButtonMode('full');
                            saveActionButtonLabelMode('full', taxSettingsStorage);
                          }}
                        />
                      </label>
                      <label className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
                        <span>Przyciski akcji: same ikonki</span>
                        <input
                          type="radio"
                          name="action-button-mode"
                          checked={actionButtonMode === 'icon'}
                          onChange={() => {
                            setActionButtonMode('icon');
                            saveActionButtonLabelMode('icon', taxSettingsStorage);
                          }}
                        />
                      </label>
                    </div>
                  </div>

                  <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl p-5 shadow-sm space-y-4">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <h3 className="text-sm font-bold tracking-wider text-gray-800 dark:text-gray-200">Plan liczenia podatku</h3>
                        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                          Domyślnie aktywny jest plan <strong>Agresywny</strong>.
                        </p>
                      </div>
                      <button
                        onClick={() => setShowAdvancedPlans((value) => !value)}
                        className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300"
                      >
                        {showAdvancedPlans ? 'Ukryj zaawansowane' : 'Pokaż zaawansowane'}
                      </button>
                    </div>

                    <div className="rounded-xl border border-amber-200 dark:border-amber-800/50 bg-amber-50 dark:bg-amber-900/20 p-4">
                      <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">Plan agresywny</p>
                      <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
                        Szeroka interpretacja kosztów, w tym koszty przewalutowania EUR→USD powiązane z inwestowaniem.
                      </p>
                    </div>

                    {showAdvancedPlans && (
                      <div className="space-y-3">
                        <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                          Ustawienia &gt; Zaawansowane &gt; Plan liczenia
                        </label>
                        <select aria-label="Ustawienia &gt; Zaawansowane &gt; Plan liczenia"
                          value={taxPlan}
                          onChange={(event) => {
                            const nextPlan = event.target.value as 'aggressive_user' | 'balanced_user' | 'conservative_user';
                            // Zapis musi wyprzedzic przeliczenie. `setTaxPlan` planuje
                            // aktualizacje stanu, a efekt zapisujacy plan do storage
                            // wykona sie dopiero po renderze - silnik ruszal wiec z
                            // poprzednim planem i pokazywal wynik innego wariantu.
                            taxSettingsStorage.setItem('taxCalculationPlan', nextPlan);
                            setTaxPlan(nextPlan);
                            globalThis.window?.dispatchEvent(new Event('tax-plan-changed'));
                            onReload();
                          }}
                          className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-800 dark:text-gray-200"
                        >
                          <option value="aggressive_user">Agresywny</option>
                          <option value="balanced_user">Zrównoważony</option>
                          <option value="conservative_user">Konserwatywny</option>
                        </select>
                        <div className="grid grid-cols-1 gap-2 text-xs text-gray-600 dark:text-gray-400">
                          <div>Agresywny: szeroki zakres kosztów, pozycje aggressive-only i koszt przewalutowania.</div>
                          <div>Zrównoważony: koszt nabycia, prowizje, koszty rachunku i odsetki inwestycyjne bez kosztu przewalutowania.</div>
                          <div>Konserwatywny: koszt nabycia i prowizje kupna/sprzedaży bez kosztów spornych.</div>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl p-5 shadow-sm space-y-4">
                    <h3 className="text-sm font-bold tracking-wider text-gray-800 dark:text-gray-200">Koszty inwestycyjne</h3>
                    <div className="grid grid-cols-1 gap-3 text-sm text-gray-700 dark:text-gray-300">
                      <label className="flex items-center justify-between gap-3">
                        <span>Uwzględniaj koszt przewalutowania EUR→USD</span>
                        <input type="checkbox" checked={includeFxConversionCosts} onChange={(event) => setIncludeFxConversionCosts(event.target.checked)} />
                      </label>
                      <label className="flex items-center justify-between gap-3">
                        <span>Uwzględniaj prowizje bankowe za zasilenie konta</span>
                        <input type="checkbox" checked={includeBankFundingFees} onChange={(event) => setIncludeBankFundingFees(event.target.checked)} />
                      </label>
                      <label className="flex items-center justify-between gap-3">
                        <span>Uwzględniaj odsetki inwestycyjne</span>
                        <input type="checkbox" checked={includeInterestCosts} onChange={(event) => setIncludeInterestCosts(event.target.checked)} />
                      </label>
                      <label className="flex items-center justify-between gap-3">
                        <span>Uwzględniaj koszty rachunku i opłaty pomocnicze</span>
                        <input type="checkbox" checked={includeAccountFees} onChange={(event) => setIncludeAccountFees(event.target.checked)} />
                      </label>
                    </div>

                    <div className="rounded-xl border border-gray-200 dark:border-gray-700 p-4 space-y-4">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-sm font-semibold text-gray-800 dark:text-gray-200">Prowizje bankowe za zasilenie konta</p>
                        <button
                          type="button"
                          onClick={addFundingFeeEntry}
                          className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-indigo-200 dark:border-indigo-700 text-indigo-700 dark:text-indigo-300"
                        >
                          Dodaj kolejny wpis
                        </button>
                      </div>
                      {fundingFeeEntries.length === 0 && (
                        <p className="text-sm text-gray-500 dark:text-gray-400">
                          Brak wpisów. Dodaj koszt zasilenia, jeśli chcesz alokować go do pierwszego batcha zakupów.
                        </p>
                      )}
                      <div className="space-y-4">
                        {fundingFeeEntries.map((entry, index) => (
                          <div key={entry.id} className="rounded-xl border border-gray-200 dark:border-gray-700 p-4 space-y-3 bg-gray-50 dark:bg-gray-900/40">
                            <div className="flex items-center justify-between gap-3">
                              <p className="text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                                Wpis #{index + 1}
                              </p>
                              <button
                                type="button"
                                onClick={() => removeFundingFeeEntry(entry.id)}
                                className="text-xs font-semibold text-red-600 dark:text-red-400"
                              >
                                Usuń
                              </button>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                              <input value={entry.amount} onChange={(event) => updateFundingFeeEntry(entry.id, { amount: event.target.value })} placeholder="Kwota prowizji" className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-800 dark:text-gray-200" />
                              <input value={entry.currency} onChange={(event) => updateFundingFeeEntry(entry.id, { currency: event.target.value.toUpperCase() })} placeholder="Waluta" className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-800 dark:text-gray-200" />
                              <input type="date" aria-label="Data opłaty" value={entry.date} onChange={(event) => updateFundingFeeEntry(entry.id, { date: event.target.value })} className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-800 dark:text-gray-200" />
                              <input value={entry.depositId || ''} onChange={(event) => updateFundingFeeEntry(entry.id, { depositId: event.target.value })} placeholder="ID zasilenia / depozytu" className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-800 dark:text-gray-200" />
                              <input value={entry.depositAmount || ''} onChange={(event) => updateFundingFeeEntry(entry.id, { depositAmount: event.target.value })} placeholder="Kwota zasilenia" className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-800 dark:text-gray-200" />
                              <input value={entry.evidenceNote || ''} onChange={(event) => updateFundingFeeEntry(entry.id, { evidenceNote: event.target.value })} placeholder="Opis dowodu / notatka" className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-800 dark:text-gray-200" />
                            </div>
                          </div>
                        ))}
                      </div>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        Domyślna alokacja: proporcjonalnie do pierwszego batcha zakupów. Silnik rozkłada koszt na pierwsze zakupy finansowane z tego zasilenia.
                      </p>
                    </div>

                    <button
                      onClick={applyTaxSettings}
                      className="w-full flex items-center justify-center gap-2 py-2.5 px-3 border border-indigo-200 dark:border-indigo-700 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 dark:bg-indigo-900/30 dark:text-indigo-300 dark:hover:bg-indigo-900/50 rounded-lg text-sm font-medium transition-colors"
                    >
                      <Download size={16} /> Zastosuj ustawienia podatkowe
                    </button>
                  </div>

                  <div className="hidden bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl p-5 shadow-sm space-y-3">
                    <h3 className="text-sm font-bold tracking-wider text-gray-800 dark:text-gray-200 mb-4 flex items-center gap-2">
                      <Bug className="w-4 h-4 text-blue-500" />
                      Narzędzia diagnostyczne
                    </h3>
                    <button 
                      onClick={onValidate} 
                      className="w-full flex items-center justify-center gap-2 py-2.5 px-3 border border-blue-200 dark:border-blue-800 bg-blue-50 text-blue-600 hover:bg-blue-100 dark:bg-blue-900/30 dark:text-blue-400 dark:hover:bg-blue-900/50 rounded-lg text-sm font-medium transition-colors"
                    >
                      <CheckCircle size={16} /> Waliduj spójność danych
                    </button>
                    <button 
                      onClick={onReload} 
                      className="w-full flex items-center justify-center gap-2 py-2.5 px-3 border border-gray-200 dark:border-gray-700 bg-gray-50 text-gray-700 dark:bg-gray-900/50 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg text-sm font-medium transition-colors"
                    >
                      <RefreshCw size={16} /> Przeładuj GUI / Tabela
                    </button>
                  </div>
                </div>
              )}

              {activeTab === 'dane' && (
                <div className="space-y-6">
                  <BackupPanel onRestored={onReload} />
                  <KwarantannaPanel />
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                    <div className="rounded-xl border border-blue-100 bg-blue-50 p-4 text-blue-950 shadow-sm dark:border-blue-900/50 dark:bg-blue-950/20 dark:text-blue-100">
                      <p className="text-xs font-semibold uppercase tracking-wide opacity-70">Lokalna baza importu</p>
                      <p className="mt-2 text-2xl font-bold">{files.length}</p>
                      <p className="mt-1 text-sm opacity-80">Pliki faktycznie wczytane do lokalnej bazy UI.</p>
                    </div>
                    <div className="rounded-xl border border-emerald-100 bg-emerald-50 p-4 text-emerald-950 shadow-sm dark:border-emerald-900/50 dark:bg-emerald-950/20 dark:text-emerald-100">
                      <p className="text-xs font-semibold uppercase tracking-wide opacity-70">Aktywne źródła PIT</p>
                      <p className="mt-2 text-2xl font-bold">{activeTaxSourceRows.length}</p>
                      <p className="mt-1 text-sm opacity-80">Pliki użyte przez silnik do obliczeń podatku.</p>
                    </div>
                    <div className="rounded-xl border border-emerald-100 bg-emerald-50 p-4 text-emerald-950 shadow-sm dark:border-emerald-900/50 dark:bg-emerald-950/20 dark:text-emerald-100">
                      <p className="text-xs font-semibold uppercase tracking-wide opacity-70">Pełny inwentarz źródeł silnika</p>
                      <p className="mt-2 text-2xl font-bold">{sourceInventoryRows.length}</p>
                      <p className="mt-1 text-sm opacity-80">{supportingSourceRows.length} pomocniczych: dowody, NBP, reconciliation i fallbacki.</p>
                    </div>
                  </div>

                  {uiComplexityMode !== 'expert' && (
                    <button
                      type="button"
                      onClick={() => setShowDataDetails((value) => !value)}
                      className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm font-semibold text-gray-700 shadow-sm transition hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
                    >
                      {showDataDetails ? 'Ukryj szczegóły danych' : 'Pokaż szczegóły danych'}
                    </button>
                  )}

                  {(uiComplexityMode === 'expert' || showDataDetails) && (
                  <>
                  {/* Danger Zone Moved to Files Tab */}
                  <div className="bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-900/40 rounded-xl p-5 shadow-sm text-center">
                    <h3 className="text-sm font-bold tracking-wider text-red-600 dark:text-red-400 mb-2 flex items-center justify-center gap-2">
                      <ShieldAlert className="w-5 h-5" />
                      Resetowanie pamięci aplikacji
                    </h3>
                    <p className="text-xs text-red-700 dark:text-red-300 mb-5 leading-relaxed max-w-md mx-auto">
                      Ta sekcja pozwala bezpowrotnie usunąć wszystkie przetworzone logi, zyski i zaimportowane pliki. Strona zostanie przeładowana.
                    </p>
                    <button
                      onClick={() => {
                        onClearData();
                        setIsOpen(false);
                      }}
                      className="inline-flex items-center justify-center gap-2 px-6 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-lg font-bold text-sm transition-all shadow-md hover:shadow-lg focus:ring-4 focus:ring-red-500/20"
                    >
                      <Trash2 className="w-4 h-4" /> Wyczyść i resetuj aplikację
                    </button>
                  </div>

                  <div>
                    <h3 className="text-sm font-bold tracking-wider text-gray-800 dark:text-gray-200 mb-4 border-b border-gray-200 dark:border-gray-700 pb-2">
                      Pliki brokera rozpoznane przez silnik
                    </h3>
                    <div className="mb-5 rounded-xl border border-blue-100 bg-blue-50/70 p-4 text-sm text-blue-900 dark:border-blue-900/50 dark:bg-blue-950/20 dark:text-blue-200">
                      <p className="font-semibold">To jest pełny inwentarz źródeł z audytu silnika.</p>
                      <p className="mt-1 text-xs leading-relaxed text-blue-800 dark:text-blue-300">
                        Obejmuje pliki liczące PIT, kandydatów nowych raportów, pliki dowodowe, reconciliation, NBP i fallbacki. Niżej osobno zostaje lista plików, które frontend zaimportował do lokalnej bazy transakcji.
                      </p>
                    </div>
                    <div className="space-y-3 max-h-96 overflow-y-auto pr-1 custom-scrollbar">
                      {sourceInventoryRows.length === 0 ? (
                        <div className="rounded-xl border border-gray-100 bg-white p-5 text-sm text-gray-500 shadow-sm dark:border-gray-800 dark:bg-gray-800/30 dark:text-gray-400">
                          Pełna lista źródeł pojawi się po przebiegu silnika. Teraz widoczna jest tylko lokalna baza importu.
                        </div>
                      ) : (
                        sourceInventoryRows.map((source) => (
                          <div key={`${source.sourceId}:${source.filename}`} className="rounded-xl border border-gray-200 bg-white p-4 text-sm shadow-sm dark:border-gray-700 dark:bg-gray-800">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="truncate font-semibold text-gray-900 dark:text-gray-100" title={source.filename}>
                                  {source.filename}
                                </div>
                                <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                                  {source.detectedType} · {source.dateRangeLabel} · hash {source.hashShort}
                                </div>
                              </div>
                              <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${
                                source.role === 'transaction_source' || source.role === 'transaction_report' || source.role === 'baseline_tax' || source.role === 'primary_tax' || source.role === 'tax'
                                  ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300 dark:ring-emerald-900'
                                  : source.role === 'candidate_tax'
                                    ? 'bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200 dark:bg-indigo-950/30 dark:text-indigo-300 dark:ring-indigo-900'
                                    : source.role === 'reconciliation'
                                      ? 'bg-blue-50 text-blue-700 ring-1 ring-blue-200 dark:bg-blue-950/30 dark:text-blue-300 dark:ring-blue-900'
                                      : 'bg-gray-50 text-gray-700 ring-1 ring-gray-200 dark:bg-gray-900 dark:text-gray-300 dark:ring-gray-700'
                              }`}>
                                {source.roleLabel}
                              </span>
                            </div>
                            <div className="mt-3 grid grid-cols-2 gap-2 rounded-lg bg-gray-50 p-2.5 text-xs text-gray-600 dark:bg-gray-900/70 dark:text-gray-400">
                              <div>Rekordy: <span className="font-medium text-gray-900 dark:text-gray-100">{source.recordCountLabel}</span></div>
                              <div>Sekcje: <span className="font-medium text-gray-900 dark:text-gray-100">{source.sectionsLabel}</span></div>
                              <div>Ostrzeżenia: <span className="font-medium text-gray-900 dark:text-gray-100">{source.warningCount}</span></div>
                              <div>Błędy: <span className="font-medium text-gray-900 dark:text-gray-100">{source.errorCount}</span></div>
                            </div>
                            {(source.warnings?.length || source.errors?.length) ? (
                              <div className="mt-2 space-y-1 text-xs">
                                {source.errors?.slice(0, 2).map((error) => (
                                  <div key={error} className="text-red-600 dark:text-red-400">{error}</div>
                                ))}
                                {source.warnings?.slice(0, 2).map((warning) => (
                                  <div key={warning} className="text-amber-700 dark:text-amber-300">{warning}</div>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  <div>
                    <h3 className="text-sm font-bold tracking-wider text-gray-800 dark:text-gray-200 mb-2 border-b border-gray-200 dark:border-gray-700 pb-2">
                      Pliki zaimportowane do lokalnej bazy transakcji
                    </h3>
                    <p className="mb-4 text-xs leading-relaxed text-gray-500 dark:text-gray-400">
                      Ta lista ma {files.length} {odmienLiczebnik(files.length, 'pozycję', 'pozycje', 'pozycji')}, bo pokazuje wyłącznie pliki wczytane do lokalnej bazy UI. To nie jest pełna lista plików w storage; pełny inwentarz jest powyżej i w zakładce Import danych.
                    </p>
                    <div className="space-y-4">
                      {files.length === 0 ? (
                        <div className="flex flex-col items-center p-8 text-gray-400 dark:text-gray-400 bg-white dark:bg-gray-800/30 border border-gray-100 dark:border-gray-800 rounded-xl">
                          <RefreshCw size={32} className="mb-3 opacity-20" />
                          <p className="text-sm">Brak plików w pamięci systemu.</p>
                        </div>
                      ) : (
                        files.map((file, idx) => (
                          <div key={idx} className={`bg-white dark:bg-gray-800 p-4 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm text-sm transition-all hover:border-gray-300 dark:hover:border-gray-600 ${file.isEnabled === false ? 'opacity-50' : ''}`}>
                            <div className="flex items-start justify-between mb-3">
                              <div className="font-semibold text-gray-800 dark:text-gray-200 truncate pr-2 flex-1" title={file.name}>{file.name}</div>
                              <div className="flex items-center gap-2 shrink-0 bg-gray-50 dark:bg-gray-900 px-2 py-1 rounded-md border border-gray-100 dark:border-gray-800">
                                <label className="relative inline-flex items-center cursor-pointer mr-2" title="Włącz/wyłącz plik w rozliczeniu">
                                  <input 
                                    type="checkbox" 
                                    checked={file.isEnabled !== false} 
                                    onChange={(e) => onToggleFile && onToggleFile(file.name, e.target.checked)} 
                                    className="sr-only peer" 
                                  />
                                  <div className="w-7 h-4 bg-gray-200 peer-focus:outline-none rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all dark:border-gray-600 peer-checked:bg-indigo-600"></div>
                                </label>
                                {file.status === 'success' && <CheckCircle size={14} className="text-green-500" />}
                                {file.status === 'warning' && <AlertTriangle size={14} className="text-yellow-500" />}
                                {file.status === 'error' && <X size={14} className="text-red-500" />}
                              </div>
                            </div>
                            <div className="grid grid-cols-2 gap-2 text-xs text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-900/80 p-2.5 rounded-lg">
                              <div>Op-Type: <span className="text-gray-900 dark:text-gray-100 font-medium ml-1">{file.type}</span></div>
                              <div>Rekordów: <span className="text-gray-900 dark:text-gray-100 font-medium ml-1">{file.recordCount}</span></div>
                              <div>Rozmiar: <span className="text-gray-900 dark:text-gray-100 font-medium ml-1">{formatLiczba(file.size / 1024, 1)} KB</span></div>
                              <div>Ostatnio: <span className="text-gray-900 dark:text-gray-100 font-medium ml-1">{new Date(file.loadedAt).toLocaleTimeString('pl-PL')}</span></div>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                  </>
                  )}
                </div>
              )}

              {activeTab === 'history' && (
                <div className="space-y-6">
                  <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl p-5 shadow-sm space-y-4">
                    <h3 className="text-sm font-bold tracking-wider text-gray-800 dark:text-gray-200">Historia transakcji</h3>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      Widok historii jest tylko do odczytu. Ręczne zmiany zapisują warstwę override i po zapisie wpływają na kolejne przeliczenie silnika.
                    </p>
                    <div className="grid grid-cols-1 gap-3 text-sm text-gray-700 dark:text-gray-300">
                      <label className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
                        <span>Przyciski akcji: ikona i pełny tekst</span>
                        <input
                          type="radio"
                          name="history-action-button-mode"
                          checked={actionButtonMode === 'full'}
                          onChange={() => {
                            setActionButtonMode('full');
                            saveActionButtonLabelMode('full', taxSettingsStorage);
                          }}
                        />
                      </label>
                      <label className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
                        <span>Przyciski akcji: same ikonki</span>
                        <input
                          type="radio"
                          name="history-action-button-mode"
                          checked={actionButtonMode === 'icon'}
                          onChange={() => {
                            setActionButtonMode('icon');
                            saveActionButtonLabelMode('icon', taxSettingsStorage);
                          }}
                        />
                      </label>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 'advanced' && (
                <div className="space-y-6">
                  <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl p-5 shadow-sm">
                    <h3 className="text-sm font-bold tracking-wider text-gray-800 dark:text-gray-200 mb-4 flex items-center gap-2">
                      <Settings className="w-4 h-4 text-blue-500" />
                      {t('settings.language')}
                    </h3>
                    <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
                      {t('settings.languageDescription')}
                    </p>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      {([
                        ['pl', t('language.pl')],
                        ['en', t('language.en')],
                      ] as const).map(([language, label]) => (
                        <button
                          key={language}
                          type="button"
                          onClick={() => onUiLanguageChange?.(language)}
                          className={`rounded-xl border p-4 text-left font-semibold transition ${
                            uiLanguage === language
                              ? 'border-indigo-500 bg-indigo-50 text-indigo-900 dark:border-indigo-400 dark:bg-indigo-500/10 dark:text-indigo-100'
                              : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl p-5 shadow-sm space-y-4">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <h3 className="text-sm font-bold tracking-wider text-gray-800 dark:text-gray-200 flex items-center gap-2">
                          <HardDrive className="w-4 h-4 text-emerald-500" />
                          {t('desktop.title')}
                        </h3>
                        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                          {t('desktop.description')}
                        </p>
                      </div>
                      <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${
                        isDesktopRuntime
                          ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'
                          : 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300'
                      }`}>
                        {isLoadingDesktopInfo ? t('desktop.loading') : (isDesktopRuntime ? t('desktop.runtimeTauri') : t('desktop.runtimeWeb'))}
                      </span>
                    </div>

                    <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                      {[
                        // Wersja wpisana w kod ('0.1.0') wygladala jak odczytana z runtime.
                        [t('desktop.appVersion'), runtimeInfo?.appVersion || '—'],
                        [t('desktop.contractVersion'), runtimeInfo?.contractVersion || '—'],
                        [t('desktop.localData'), t('desktop.yes')],
                        [t('desktop.cloud'), t('desktop.no')],
                      ].map(([label, value]) => (
                        <div key={label} className="rounded-lg border border-gray-100 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900/50">
                          <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{label}</div>
                          <div className="mt-1 break-all font-semibold text-gray-900 dark:text-gray-100">{value}</div>
                        </div>
                      ))}
                    </div>

                    <div className="space-y-2 rounded-lg border border-gray-100 bg-gray-50 p-3 text-xs dark:border-gray-700 dark:bg-gray-900/50">
                      <div className="font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400">{t('desktop.folders')}</div>
                      {[
                        [t('desktop.storageDir'), appPaths?.storageDir],
                        [t('desktop.artifactsDir'), appPaths?.artifactsDir],
                        [t('desktop.runsDir'), appPaths?.runsDir],
                        [t('desktop.logsDir'), appPaths?.logsDir],
                      ].map(([label, value]) => (
                        <div key={label} className="grid grid-cols-[120px,1fr] gap-2 text-gray-600 dark:text-gray-300">
                          <span className="font-semibold">{label}</span>
                          <span className="break-all">{value || t('desktop.notAvailable')}</span>
                        </div>
                      ))}
                    </div>

                    <div className="rounded-lg border border-amber-100 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-100">
                      <div className="font-bold uppercase tracking-wide">{t('desktop.storageMigration')}</div>
                      <div className="mt-2">
                        {legacyStorageError || (legacyStorageStatus?.detected
                          ? t('desktop.legacyStorageDetected', {
                              count: legacyStorageStatus.fileCount,
                              plikiPl: odmienLiczebnik(legacyStorageStatus.fileCount, 'plik', 'pliki', 'plików'),
                              filesEn: legacyStorageStatus.fileCount === 1 ? 'file' : 'files',
                              path: legacyStorageStatus.sourceDir || '',
                            })
                          : t('desktop.legacyStorageNotDetected'))}
                      </div>
                      {legacyStorageStatus && (legacyStorageStatus.unreadableCount ?? 0) > 0 && (
                        <div className="mt-2">Nie udało się odczytać {legacyStorageStatus.unreadableCount} pozycji starego magazynu. Liczba plików może być niepełna.</div>
                      )}
                      {storageMigrationStatus?.migrated && storageMigrationStatus.manifestPath && (
                        <div className="mt-2 break-all">
                          {t('desktop.storageMigrationManifest', { path: storageMigrationStatus.manifestPath })}
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={copyLegacyStorage}
                        disabled={!isDesktopRuntime || !legacyStorageStatus?.detected}
                        className="mt-3 inline-flex items-center justify-center gap-2 rounded-lg border border-amber-200 bg-white px-3 py-2 text-xs font-semibold text-amber-800 transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-100"
                      >
                        <Download size={14} />
                        {t('desktop.copyLegacyStorage')}
                      </button>
                    </div>

                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-5">
                      <button
                        type="button"
                        onClick={() => openDesktopLocation('storage')}
                        disabled={!isDesktopRuntime}
                        className="inline-flex items-center justify-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-300"
                      >
                        <FolderOpen size={14} />
                        {t('desktop.openStorage')}
                      </button>
                      <button
                        type="button"
                        onClick={() => openDesktopLocation('artifacts')}
                        disabled={!isDesktopRuntime}
                        className="inline-flex items-center justify-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs font-semibold text-indigo-700 transition hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-indigo-800 dark:bg-indigo-900/20 dark:text-indigo-300"
                      >
                        <FolderOpen size={14} />
                        {t('desktop.openArtifacts')}
                      </button>
                      <button
                        type="button"
                        onClick={() => exportDesktopDiagnostics('safe')}
                        className="inline-flex items-center justify-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700 transition hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-300"
                      >
                        <Download size={14} />
                        {t('desktop.exportDiagnosticsSafe')}
                      </button>
                      <button
                        type="button"
                        onClick={() => exportDesktopDiagnostics('anonymized')}
                        className="inline-flex items-center justify-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700 transition hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-300"
                      >
                        <Download size={14} />
                        {t('desktop.exportDiagnosticsAnonymized')}
                      </button>
                      <button
                        type="button"
                        onClick={() => exportDesktopDiagnostics('full')}
                        className="inline-flex items-center justify-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700 transition hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300"
                      >
                        <Download size={14} />
                        {t('desktop.exportDiagnosticsFull')}
                      </button>
                    </div>

                    <div className="rounded-lg border border-gray-100 bg-gray-50 p-3 text-xs text-gray-600 dark:border-gray-700 dark:bg-gray-900/50 dark:text-gray-300">
                      <div className="font-semibold text-gray-800 dark:text-gray-100">{t('desktop.security')}</div>
                      <div className="mt-1">{t('desktop.securityDescription')}</div>
                      {desktopActionStatus && (
                        <div className="mt-3 rounded-md bg-white p-2 font-medium text-gray-700 dark:bg-gray-800 dark:text-gray-200">
                          {desktopActionStatus}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl p-5 shadow-sm">
                    <h3 className="text-sm font-bold tracking-wider text-gray-800 dark:text-gray-200 mb-4 flex items-center gap-2">
                      <Settings className="w-4 h-4 text-indigo-500" />
                      {t('settings.interfaceMode')}
                    </h3>
                    <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
                      {t('settings.interfaceModeDescription')}
                    </p>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      {([
                        ['simple', t('settings.simple'), t('settings.simpleDescription')],
                        ['expert', t('settings.expert'), t('settings.expertDescription')],
                      ] as const).map(([mode, label, description]) => (
                        <button
                          key={mode}
                          type="button"
                          onClick={() => onUiComplexityModeChange?.(mode)}
                          className={`rounded-xl border p-4 text-left transition ${
                            uiComplexityMode === mode
                              ? 'border-indigo-500 bg-indigo-50 text-indigo-900 dark:border-indigo-400 dark:bg-indigo-500/10 dark:text-indigo-100'
                              : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800'
                          }`}
                        >
                          <span className="block font-semibold">{label}</span>
                          <span className="mt-1 block text-xs opacity-75">{description}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl p-5 shadow-sm">
                    <h3 className="text-sm font-bold tracking-wider text-gray-800 dark:text-gray-200 mb-4 flex items-center gap-2">
                      <Sun className="w-4 h-4 text-orange-500" />
                      {t('settings.theme')}
                    </h3>
                    <div className="flex bg-gray-100 dark:bg-gray-900/50 p-1 rounded-lg">
                      <button
                        onClick={() => setTheme('light')}
                        className={`flex-1 flex justify-center items-center py-2 text-sm font-medium rounded-md transition-all ${theme === 'light' ? 'bg-white dark:bg-gray-800 shadow text-indigo-600 dark:text-indigo-400' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'}`}
                      >
                        <Sun className="w-4 h-4 mr-2" /> {t('settings.light')}
                      </button>
                      <button
                        onClick={() => setTheme('dark')}
                        className={`flex-1 flex justify-center items-center py-2 text-sm font-medium rounded-md transition-all ${theme === 'dark' ? 'bg-gray-800 shadow text-indigo-400' : 'text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200'}`}
                      >
                        <Moon className="w-4 h-4 mr-2" /> {t('settings.dark')}
                      </button>
                    </div>
                  </div>

                  <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl p-5 shadow-sm">
                    <h3 className="text-sm font-bold tracking-wider text-gray-800 dark:text-gray-200 mb-4 flex items-center gap-2">
                      <Cpu className="w-4 h-4 text-purple-500" />
                      Asystent diagnostyczny
                    </h3>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      Kopiuje kontekst techniczny do analizy logów i importu. Nie liczy podatku i nie zmienia danych silnika.
                    </p>
                    <button
                      type="button"
                      onClick={copyAiContext}
                      className="mt-3 inline-flex items-center gap-2 rounded-lg border border-purple-200 bg-white px-3 py-2 text-xs font-semibold text-purple-700 hover:bg-purple-100 dark:border-purple-800 dark:bg-purple-950/30 dark:text-purple-300 dark:hover:bg-purple-900/40"
                    >
                      <Download size={14} />
                      Skopiuj kontekst diagnostyczny
                    </button>
                    {aiCopyStatus && <p className="mt-2 text-xs text-purple-700 dark:text-purple-300">{aiCopyStatus}</p>}
                  </div>

                  <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl p-5 shadow-sm">
                    <h3 className="text-sm font-bold tracking-wider text-gray-800 dark:text-gray-200 mb-4 flex items-center gap-2">
                      <Cpu className="w-4 h-4 text-emerald-500" />
                      {t('settings.aiNormalizer')}
                    </h3>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      {t('settings.aiNormalizerDescription')}
                    </p>
                    <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-emerald-100 bg-emerald-50 p-4 text-sm text-emerald-950 dark:border-emerald-900/60 dark:bg-emerald-950/20 dark:text-emerald-100">
                      <input
                        type="checkbox"
                        checked={aiNormalizerEnabled}
                        onChange={(event) => { void handleAiNormalizerToggle(event.target.checked); }}
                        disabled={isStartingOllama}
                        className="mt-1 h-4 w-4 rounded border-emerald-300 text-emerald-600 focus:ring-emerald-500"
                      />
                      <span>
                        <span className="block font-semibold">{t('settings.aiNormalizerEnabled')}</span>
                        <span className="mt-1 block text-xs opacity-80">{t('settings.aiNormalizerSafety')}</span>
                      </span>
                    </label>
                    <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <label className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                        Endpoint
                        <input
                          value={ollamaConfigDraft.baseUrl || ''}
                          onChange={(event) => setOllamaConfigDraft((draft) => ({ ...draft, baseUrl: event.target.value }))}
                          className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm normal-case tracking-normal text-gray-900 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                          placeholder="http://127.0.0.1:11434"
                        />
                      </label>
                      <label className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                        Model
                        <input
                          value={ollamaConfigDraft.model || ''}
                          onChange={(event) => setOllamaConfigDraft((draft) => ({ ...draft, model: event.target.value }))}
                          className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm normal-case tracking-normal text-gray-900 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                          placeholder="qwen3:14b"
                        />
                      </label>
                      <label className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                        GPU
                        <select
                          value={ollamaConfigDraft.gpuMode || 'gpu'}
                          onChange={(event) => setOllamaConfigDraft((draft) => ({
                            ...draft,
                            gpuMode: event.target.value,
                            numGpu: event.target.value === 'gpu' ? (draft.numGpu ?? -1) : draft.numGpu,
                          }))}
                          className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm normal-case tracking-normal text-gray-900 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                        >
                          <option value="gpu">GPU wymagane (bez CPU fallback)</option>
                          <option value="auto">Auto Ollama</option>
                        </select>
                      </label>
                      <label className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                        Backend GPU
                        <select
                          value={ollamaConfigDraft.gpuBackend || 'vulkan'}
                          onChange={(event) => setOllamaConfigDraft((draft) => ({ ...draft, gpuBackend: event.target.value }))}
                          className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm normal-case tracking-normal text-gray-900 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                        >
                          <option value="vulkan">AMD/Intel/NVIDIA Vulkan</option>
                          <option value="rocm">AMD ROCm</option>
                          <option value="cuda">NVIDIA CUDA</option>
                          <option value="auto">Auto Ollama</option>
                        </select>
                      </label>
                      <label className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                        Warstwy GPU
                        <input
                          type="number"
                          value={typeof ollamaConfigDraft.numGpu === 'number' ? String(ollamaConfigDraft.numGpu) : ''}
                          onChange={(event) => setOllamaConfigDraft((draft) => ({
                            ...draft,
                            numGpu: event.target.value === '' ? null : Number(event.target.value),
                          }))}
                          className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm normal-case tracking-normal text-gray-900 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                          placeholder="-1"
                        />
                        <span className="mt-1 block text-[11px] normal-case tracking-normal text-gray-400">
                          -1 = wszystkie możliwe warstwy na GPU. CPU fallback jest wyłączony w UI.
                        </span>
                      </label>
                      <label className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                        Limit GPU
                        <input
                          type="number"
                          min={50}
                          max={95}
                          value={typeof ollamaConfigDraft.gpuLoadLimitPercent === 'number' ? String(ollamaConfigDraft.gpuLoadLimitPercent) : '85'}
                          onChange={(event) => setOllamaConfigDraft((draft) => ({
                            ...draft,
                            gpuLoadLimitPercent: Math.min(95, Math.max(50, Number(event.target.value || 85))),
                          }))}
                          className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm normal-case tracking-normal text-gray-900 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                          placeholder="85"
                        />
                        <span className="mt-1 block text-[11px] normal-case tracking-normal text-gray-400">
                          Miękki limit: ogranicza batch i równoległość; Ollama nie daje twardego limitu procentowego.
                        </span>
                      </label>
                      <label className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                        Batch
                        <input
                          type="number"
                          min={1}
                          value={typeof ollamaConfigDraft.numBatch === 'number' ? String(ollamaConfigDraft.numBatch) : '128'}
                          onChange={(event) => setOllamaConfigDraft((draft) => ({
                            ...draft,
                            numBatch: Math.max(1, Number(event.target.value || 128)),
                          }))}
                          className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm normal-case tracking-normal text-gray-900 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                          placeholder="128"
                        />
                      </label>
                      <label className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                        Równoległość
                        <input
                          type="number"
                          min={1}
                          max={2}
                          value={typeof ollamaConfigDraft.maxParallel === 'number' ? String(ollamaConfigDraft.maxParallel) : '1'}
                          onChange={(event) => setOllamaConfigDraft((draft) => ({
                            ...draft,
                            maxParallel: Math.min(2, Math.max(1, Number(event.target.value || 1))),
                          }))}
                          className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm normal-case tracking-normal text-gray-900 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                          placeholder="1"
                        />
                        <span className="mt-1 block text-[11px] normal-case tracking-normal text-gray-400">
                          Domyślnie 1, żeby nie dobijać GPU/VRAM przy importach.
                        </span>
                      </label>
                    </div>
                    <label className="mt-3 block text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      Ścieżka do ollama.exe
                      <input
                        value={ollamaConfigDraft.exePath || ''}
                        onChange={(event) => setOllamaConfigDraft((draft) => ({ ...draft, exePath: event.target.value }))}
                        className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm normal-case tracking-normal text-gray-900 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                        placeholder="%LOCALAPPDATA%\\Programs\\OllamaCLI\\ollama.exe"
                      />
                    </label>
                    <div className={`mt-3 rounded-lg border p-3 text-xs ${
                      ollamaStatus?.gpuConfirmed
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/20 dark:text-emerald-200'
                        : 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-100'
                    }`}>
                      <div className="font-bold uppercase tracking-wide">
                        {isStartingOllama
                          ? 'Ollama: uruchamianie'
                          : ollamaStatus?.gpuConfirmed ? 'Ollama GPU potwierdzona' : 'Ollama GPU niepotwierdzona'}
                      </div>
                      <div className="mt-1 break-all">
                        {t('settings.ollamaEndpoint')}: {ollamaStatus?.baseUrl || '—'}
                      </div>
                      <div className="mt-1">
                        {t('settings.ollamaModel')}: {ollamaStatus?.model || '—'}
                        {ollamaStatus?.modelAvailable === false && ollamaStatus?.available && (
                          <span className="ml-2 font-semibold text-amber-700 dark:text-amber-200">brak modelu</span>
                        )}
                      </div>
                      <div className="mt-1">
                        {/* Bez odpowiedzi Ollamy i bez ustawienia uzytkownika zostaje
                            myslnik. Wczesniej byly tu stale 'gpu', 'vulkan', 85, 128, 1, -1
                            pokazywane jako odczytany stan procesu. */}
                        GPU: {ollamaStatus?.gpuMode || ollamaConfigDraft.gpuMode || '—'}
                        {' '}· backend {ollamaStatus?.gpuBackend || ollamaConfigDraft.gpuBackend || '—'}
                        {' '}· limit {liczbaAlboKreska(ollamaStatus?.gpuLoadLimitPercent, ollamaConfigDraft.gpuLoadLimitPercent)}%
                        {' '}· batch {liczbaAlboKreska(ollamaStatus?.numBatch, ollamaConfigDraft.numBatch)}
                        {' '}· równoległość {liczbaAlboKreska(ollamaStatus?.maxParallel, ollamaConfigDraft.maxParallel)}
                        {' '}· num_gpu {liczbaAlboKreska(ollamaStatus?.numGpu, ollamaConfigDraft.numGpu)}
                      </div>
                      <div className="mt-1 break-all">
                        Exe: {ollamaStatus?.exePath || ollamaConfigDraft.exePath || 'nie wykryto'}
                      </div>
                      <div className="mt-1">
                        Probe GPU: {ollamaStatus?.gpuProbeStatus || 'not_run'} · compute: {ollamaStatus?.computeBackend || 'unknown'}
                      </div>
                      {ollamaStatus?.gpuFailureReason && (
                        <div className="mt-1 break-all font-semibold text-amber-700 dark:text-amber-200">
                          {ollamaStatus.gpuFailureReason}
                        </div>
                      )}
                      {ollamaStatus?.logEvidence && ollamaStatus.logEvidence.length > 0 && (
                        <details className="mt-2">
                          <summary className="cursor-pointer font-semibold">Dowody z logów GPU/CPU</summary>
                          <pre className="mt-1 max-h-36 overflow-auto whitespace-pre-wrap rounded bg-black/5 p-2 text-[11px] dark:bg-white/5">
                            {ollamaStatus.logEvidence.join('\n')}
                          </pre>
                        </details>
                      )}
                      <div className="mt-1">
                        Modele: {ollamaModels.length > 0 ? ollamaModels.slice(0, 5).map((model) => model.name).join(', ') : 'brak listy'}
                      </div>
                      {ollamaStatus?.error && (
                        <div className="mt-1 break-all opacity-80">{ollamaStatus.error}</div>
                      )}
                      {ollamaActionStatus && (
                        <div className="mt-1 break-all font-semibold opacity-90">{ollamaActionStatus}</div>
                      )}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={handleSaveOllamaConfig}
                        className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-200 dark:hover:bg-gray-900"
                      >
                        Zapisz konfigurację
                      </button>
                      <button
                        type="button"
                        onClick={() => { void refreshOllamaStatus(); }}
                        className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-200 dark:hover:bg-gray-900"
                      >
                        <RefreshCw size={14} />
                        Odśwież status
                      </button>
                      <button
                        type="button"
                        onClick={handleStartOllama}
                        disabled={isStartingOllama}
                        className="inline-flex items-center gap-2 rounded-lg border border-emerald-200 bg-white px-3 py-2 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-60 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300 dark:hover:bg-emerald-900/40"
                      >
                        <Cpu size={14} />
                        Uruchom Ollama
                      </button>
                      <button
                        type="button"
                        onClick={handleTestOllama}
                        className="inline-flex items-center gap-2 rounded-lg border border-emerald-200 bg-white px-3 py-2 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300 dark:hover:bg-emerald-900/40"
                      >
                        Test modelu
                      </button>
                      <button
                        type="button"
                        onClick={applyAiSettings}
                        className="inline-flex items-center gap-2 rounded-lg border border-emerald-200 bg-white px-3 py-2 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300 dark:hover:bg-emerald-900/40"
                      >
                        <RefreshCw size={14} />
                        {t('settings.applyAiSettings')}
                      </button>
                    </div>
                  </div>

                  <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl p-5 shadow-sm space-y-3">
                    <h3 className="text-sm font-bold tracking-wider text-gray-800 dark:text-gray-200 mb-4 flex items-center gap-2">
                      <Bug className="w-4 h-4 text-blue-500" />
                      Narzędzia diagnostyczne
                    </h3>
                    <button 
                      onClick={onValidate} 
                      className="w-full flex items-center justify-center gap-2 py-2.5 px-3 border border-blue-200 dark:border-blue-800 bg-blue-50 text-blue-600 hover:bg-blue-100 dark:bg-blue-900/30 dark:text-blue-400 dark:hover:bg-blue-900/50 rounded-lg text-sm font-medium transition-colors"
                    >
                      <CheckCircle size={16} /> Waliduj spójność danych
                    </button>
                    <button 
                      onClick={onReload} 
                      className="w-full flex items-center justify-center gap-2 py-2.5 px-3 border border-gray-200 dark:border-gray-700 bg-gray-50 text-gray-700 dark:bg-gray-900/50 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg text-sm font-medium transition-colors"
                    >
                      <RefreshCw size={16} /> Przeładuj GUI / Tabela
                    </button>
                  </div>
                </div>
              )}

                {activeTab === 'logs' && (
                  <div className="space-y-4 w-full">
                    <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 border-b border-gray-100 dark:border-gray-800 pb-4 mb-2">
                      <h3 className="text-sm font-bold tracking-wider text-gray-800 dark:text-gray-200 m-0">
                        Dziennik Zdarzeń Systemowych
                      </h3>
                      <button
                        onClick={() => {
                          if (logs.length === 0) return;
                          const logContent = displayLogs.map(l => `[${new Date(l.timestamp).toISOString()}] [${l.displayLevel.toUpperCase()}] [${l.stage}] [${l.userFacingKind}] ${l.displayMessage} ${l.details ? JSON.stringify(l.details) : ''}`).join('\n');
                          const blob = new Blob([logContent], { type: 'text/plain' });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement('a');
                          a.href = url;
                          a.download = `invest-analyzer-logs-${dzisiajLokalnie()}.txt`;
                          document.body.appendChild(a);
                          a.click();
                          document.body.removeChild(a);
                          URL.revokeObjectURL(url);
                        }}
                        disabled={logs.length === 0}
                        className="flex items-center justify-center gap-1.5 px-3 py-1.5 bg-indigo-50 dark:bg-indigo-500/10 hover:bg-indigo-100 dark:hover:bg-indigo-500/20 text-indigo-700 dark:text-indigo-400 border border-indigo-100 dark:border-indigo-500/30 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed w-full sm:w-auto"
                        title="Eksportuj logi"
                      >
                        <Download size={14} />
                        Pobierz .txt
                      </button>
                    </div>

                    <div className="flex flex-wrap gap-2 mb-4">
                      <button 
                        onClick={() => setLogFilter('all')} 
                        className={`px-3 py-1.5 text-xs font-semibold rounded-lg shrink-0 transition-colors ${logFilter === 'all' ? 'bg-gray-800 dark:bg-gray-100 text-white dark:text-gray-900 shadow-sm' : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'}`}
                      >Wszystkie</button>
                      <button 
                        onClick={() => setLogFilter('error')} 
                        className={`px-3 py-1.5 text-xs font-semibold rounded-lg shrink-0 transition-colors ${logFilter === 'error' ? 'bg-red-600 text-white shadow-sm' : 'bg-red-50 dark:bg-red-900/10 text-red-600 dark:text-red-400 border border-red-100 dark:border-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/30'}`}
                      >Błędy</button>
                      <button 
                        onClick={() => setLogFilter('warn')} 
                        className={`px-3 py-1.5 text-xs font-semibold rounded-lg shrink-0 transition-colors ${logFilter === 'warn' ? 'bg-amber-700 text-white shadow-sm' : 'bg-yellow-50 dark:bg-yellow-900/10 text-yellow-700 dark:text-yellow-400 border border-yellow-100 dark:border-yellow-900/20 hover:bg-yellow-100 dark:hover:bg-yellow-900/30'}`}
                      >Ostrzeżenia</button>
                      <button 
                        onClick={() => setLogFilter('info')} 
                        className={`px-3 py-1.5 text-xs font-semibold rounded-lg shrink-0 transition-colors ${logFilter === 'info' ? 'bg-blue-600 text-white shadow-sm' : 'bg-blue-50 dark:bg-blue-900/10 text-blue-600 dark:text-blue-400 border border-blue-100 dark:border-blue-900/20 hover:bg-blue-100 dark:hover:bg-blue-900/30'}`}
                      >Informacje</button>
                    </div>
                    
                    {filteredLogs.length === 0 ? (
                      <div className="flex flex-col items-center justify-center p-8 text-center text-gray-400 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/50 rounded-xl">
                        <CheckCircle size={32} className="mb-2 opacity-30" />
                        <p className="text-sm">Brak zarejestrowanych wpisów w tej kategorii.</p>
                      </div>
                    ) : (
                      <div className="space-y-3 font-mono">
                        {filteredLogs.map((log) => (
                          <div key={log.id} className={`p-3 rounded-xl text-sm transition-all shadow-sm border ${
                            log.displayLevel === 'error' ? 'bg-red-50 border-red-200 dark:bg-red-900/10 dark:border-red-800/50' : 
                            log.displayLevel === 'warn' ? 'bg-yellow-50 border-yellow-200 dark:bg-yellow-900/10 dark:border-yellow-800/50' : 
                            'bg-gray-50 dark:bg-gray-800/50 border-gray-200 dark:border-gray-700'
                          }`}>
                            <div className="flex justify-between items-center mb-2">
                              <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                                log.displayLevel === 'error' ? 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-400' :
                                log.displayLevel === 'warn' ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-500/20 dark:text-yellow-400' :
                                'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300'
                              }`}>
                                {formatLogStageLabel(log.stage)}
                              </span>
                              <span className="text-[10px] opacity-70 tracking-tighter">
                                {new Date(log.timestamp).toLocaleTimeString('pl-PL', { hour12: false, hour: '2-digit', minute:'2-digit', second:'2-digit' })}
                              </span>
                            </div>
                            
                            <div className={`text-xs font-semibold mb-1.5 leading-relaxed break-words ${
                               log.displayLevel === 'error' ? 'text-red-900 dark:text-red-300' :
                               log.displayLevel === 'warn' ? 'text-yellow-900 dark:text-yellow-300' :
                               'text-gray-800 dark:text-gray-200'
                            }`}>
                              {log.displayMessage}
                            </div>
                            <div className="text-[10px] font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                              {userFacingLogKindLabel(log.userFacingKind)}
                            </div>
                            
                            {log.details && (
                              <div className="mt-2 bg-black/5 dark:bg-black/40 rounded-lg p-2 overflow-x-auto border border-black/5 dark:border-black/50">
                                <pre className="text-[10px] leading-relaxed text-gray-600 dark:text-gray-400 whitespace-pre-wrap break-all">
                                  {typeof log.details === 'object' ? JSON.stringify(log.details, null, 2) : String(log.details)}
                                </pre>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
          </motion.div>
        </motion.div>
      )}
      </AnimatePresence>
    </>
  );
}
