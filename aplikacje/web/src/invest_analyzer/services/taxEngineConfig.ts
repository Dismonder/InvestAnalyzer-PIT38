import type { NadpisanieTransakcji } from "./transactionOverrides";
import type { DefenseEvidenceOverride } from "./defenseEvidenceOverrides";
import type { BrokerFileActionOverride } from "./brokerFileActionOverrides";
import { browserLocalStorage } from "./browserStorage";
import { mergeStoredLists } from "./mergeStoredLists";
import { kwotaTekstowaZWpisu, kwotaZWpisu } from "../../portfel/services/pit8c";

export interface FundingFeeEntry {
  id: string;
  amount: string;
  currency: string;
  date: string;
  depositId?: string;
  depositAmount?: string;
  evidenceNote?: string;
}

/**
 * Oplaty z kwota, ale bez daty - silnik pominalby je bez sladu. Puste, gdy wszystko jest kompletne,
 * gdy oplaty finansowania sa wylaczone (nie wchodza wtedy do rozliczenia) albo kwota to zero.
 */
export function bladyOplatFinansowania(entries: readonly FundingFeeEntry[] | undefined, oplatyWlaczone = true): string[] {
  if (!oplatyWlaczone) return [];
  return (entries ?? [])
    .filter((entry) => entry.amount.trim() !== "" && entry.date.trim() === "" && kwotaZWpisu(entry.amount) !== 0)
    .map((entry) => `Opłata ${entry.amount.trim()} ${entry.currency.trim() || "PLN"} nie ma daty — uzupełnij w ustawieniach kosztów.`);
}

/**
 * Strata z lat ubieglych zgloszona przez uzytkownika.
 *
 * Silnik nie zna rozliczen sprzed zakresu wgranych plikow, wiec te kwoty
 * moga pochodzic tylko od podatnika - z PIT-38 zlozonego za rok straty.
 */
export interface PriorYearLossEntry {
  id: string;
  taxYear: number;
  amountPln: string;
  /** Ile z tej straty zostalo jeszcze do wykorzystania. */
  remainingPln?: string;
  accepted?: boolean;
}

export interface TaxEngineRequest {
  year: number;
  runMode: string;
  taxPlan: string;
  includeFxConversionCosts: boolean;
  includeBankFundingFees: boolean;
  includeInterestCosts: boolean;
  includeAccountFees: boolean;
  packageScope?: string;
  filingMode?: string;
  fundingFees?: FundingFeeEntry[];
  priorYearLosses?: PriorYearLossEntry[];
  /**
   * Koszty nabycia walut wirtualnych nieodliczone w poprzednich latach.
   * Czesc E przenosi nadwyzke kosztow na kolejny rok zamiast tworzyc strate
   * (art. 22 ust. 16 ustawy o PIT).
   */
  cryptoCostsCarriedForward?: string;
  // Koszty wskazane przez użytkownika do ujęcia w planie agresywnym mimo
  // domyślnej polityki. Silnik zapisuje je w audycie jako decyzję podatnika.
  conditionalCostIds?: string[];
  // Ręczna korekta kursu ("USD:2026-05-11" -> "3.9812"). Działa wyłącznie przy
  // włączonym nbpAllowManualOverride, bo kurs ustawowy to kurs NBP z dnia
  // roboczego poprzedzającego zdarzenie.
  manualFxOverrides?: Record<string, string>;
  // Pliki magazynu wylaczone przez uzytkownika z rozliczenia. Przelacznik
  // i "usun z listy" zmienialy dotad wylacznie stan widoku: silnik liczyl
  // dalej z kompletu plikow, a po odswiezeniu lista wracala.
  excludedStorageFiles?: string[];
  nbpAllowManualOverride?: boolean;
  transactionOverrides?: NadpisanieTransakcji[];
  defenseEvidenceOverrides?: DefenseEvidenceOverride[];
  brokerFileActionOverrides?: BrokerFileActionOverride[];
  /** Decyzje o zdarzeniach czekajacych na rozstrzygniecie (klucz + rodzaj). */
  reviewDecisions?: Array<{ decisionKey: string; decision: string }>;
  sourceSelectionMode?: 'canonical_stream' | string;
  selectedCandidateSourceId?: string;
  canonicalTaxInputMode?: 'off' | 'prefer' | 'required' | string;
  aiNormalizerEnabled?: boolean;
  aiNormalizerGpuMode?: 'gpu' | 'auto' | string;
  aiNormalizerNumGpu?: number;
  aiNormalizerGpuBackend?: 'vulkan' | 'rocm' | 'cuda' | 'auto' | string;
  aiNormalizerGpuLoadLimitPercent?: number;
  aiNormalizerNumBatch?: number;
  aiNormalizerMaxParallel?: number;
  aiNormalizerGpuRequired?: boolean;
  aiNormalizerGpuConfirmed?: boolean;
  aiNormalizerComputeBackend?: 'gpu' | 'cpu' | 'unknown' | string;
  allowCpuAi?: boolean;
  /** Pomija serwerowy cache wyniku; ustawia go wyłącznie „Przelicz ponownie”. */
  forceRecalculate?: boolean;
  fundingFee?: undefined;
}

export interface TaxPackageRequestOptions {
  packageScope?: string;
  filingMode?: string;
}

export interface KeyValueStorageSource {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export type StorageSource = KeyValueStorageSource | Record<string, string | null | undefined>;

const FUNDING_FEE_ENTRIES_KEY = "fundingFeeEntries";

function readValue(source: StorageSource, key: string, fallback = ""): string {
  if ("getItem" in source && typeof source.getItem === "function") {
    return source.getItem(key) || fallback;
  }
  return String(source[key] ?? fallback);
}

function writeValue(source: StorageSource, key: string, value: string): void {
  // Formularze zapisuja przy kazdym znaku i przy zamontowaniu - zdarzenie
  // przeliczenia tylko wtedy, gdy wartosc naprawde sie zmienila.
  const poprzednia = "getItem" in source && typeof source.getItem === "function" ? source.getItem(key) : source[key];
  if (poprzednia === value) return;
  if ("setItem" in source && typeof source.setItem === "function") {
    source.setItem(key, value);
  } else {
    source[key] = value;
  }
  if (source === browserLocalStorage) globalThis.window?.dispatchEvent(new Event('tax-input-changed'));
}

export function createMemoryStorageSource(initial: Record<string, string | null | undefined> = {}): KeyValueStorageSource {
  const values: Record<string, string | null | undefined> = { ...initial };
  return {
    getItem: (key: string) => values[key] ?? null,
    setItem: (key: string, value: string) => {
      values[key] = value;
    },
  };
}

export function getBrowserTaxSettingsStorage(): KeyValueStorageSource {
  return browserLocalStorage;
}

function safeParseEntries(raw: string): FundingFeeEntry[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((entry) => entry && typeof entry === "object")
      .map((entry, index) => ({
        id: String(entry.id || `funding-fee-${index + 1}`),
        amount: String(entry.amount || ""),
        // Brak waluty zostaje brakiem - silnik zatrzyma przebieg z komunikatem.
        // Domyslne PLN odliczalo oplate w dolarach jak zlotowki 1:1.
        currency: String(entry.currency || "").toUpperCase(),
        date: String(entry.date || ""),
        depositId: entry.depositId ? String(entry.depositId) : undefined,
        depositAmount: entry.depositAmount ? String(entry.depositAmount) : undefined,
        evidenceNote: entry.evidenceNote ? String(entry.evidenceNote) : undefined,
      }));
  } catch {
    return [];
  }
}

export function migrateFundingFeeEntries(values: Record<string, string | null | undefined>): FundingFeeEntry[] {
  const amount = String(values.fundingFeeAmount || "").trim();
  const date = String(values.fundingFeeDate || "").trim();
  if (!amount || !date) {
    return [];
  }
  return [
    {
      id: "legacy-funding-fee-1",
      amount,
      currency: String(values.fundingFeeCurrency || "PLN").toUpperCase(),
      date,
      depositId: values.fundingFeeDepositId ? String(values.fundingFeeDepositId) : undefined,
      depositAmount: values.fundingFeeDepositAmount ? String(values.fundingFeeDepositAmount) : undefined,
      evidenceNote: values.fundingFeeEvidenceNote ? String(values.fundingFeeEvidenceNote) : undefined,
    },
  ];
}

export function ensureFundingFeeEntries(source: StorageSource): FundingFeeEntry[] {
  const current = safeParseEntries(readValue(source, FUNDING_FEE_ENTRIES_KEY));
  if (current.length > 0) {
    return current;
  }
  const migrated = migrateFundingFeeEntries({
    fundingFeeAmount: readValue(source, "fundingFeeAmount"),
    fundingFeeCurrency: readValue(source, "fundingFeeCurrency", "PLN"),
    fundingFeeDate: readValue(source, "fundingFeeDate"),
    fundingFeeDepositId: readValue(source, "fundingFeeDepositId"),
    fundingFeeDepositAmount: readValue(source, "fundingFeeDepositAmount"),
    fundingFeeEvidenceNote: readValue(source, "fundingFeeEvidenceNote"),
  });
  if (migrated.length > 0) {
    writeValue(source, FUNDING_FEE_ENTRIES_KEY, JSON.stringify(migrated));
  }
  return migrated;
}

export function saveFundingFeeEntries(source: StorageSource, entries: FundingFeeEntry[]): void {
  writeValue(source, FUNDING_FEE_ENTRIES_KEY, JSON.stringify(entries));
}

export function mergeAndSaveFundingFeeEntries(source: StorageSource, base: FundingFeeEntry[], local: FundingFeeEntry[]): FundingFeeEntry[] {
  const merged = mergeStoredLists(base, local, safeParseEntries(readValue(source, FUNDING_FEE_ENTRIES_KEY)), (entry) => entry.id);
  saveFundingFeeEntries(source, merged);
  return merged;
}

const PRIOR_YEAR_LOSS_ENTRIES_KEY = "priorYearLossEntries";
const CRYPTO_COSTS_BY_YEAR_KEY = "cryptoCostsCarriedForwardByYear";
const LEGACY_CRYPTO_COSTS_KEY = "cryptoCostsCarriedForward";
const CONDITIONAL_COST_IDS_KEY = "conditionalCostIds";
const EXCLUDED_STORAGE_FILES_KEY = "excludedStorageFiles";
const MANUAL_FX_OVERRIDES_KEY = "manualFxOverrides";

export function readConditionalCostIds(source: StorageSource): string[] {
  try {
    const parsed = JSON.parse(readValue(source, CONDITIONAL_COST_IDS_KEY, "[]"));
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry).trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function saveConditionalCostIds(source: StorageSource, costIds: string[]): void {
  writeValue(source, CONDITIONAL_COST_IDS_KEY, JSON.stringify([...new Set(costIds.map((id) => String(id).trim()).filter(Boolean))]));
}

export function mergeAndSaveConditionalCostIds(source: StorageSource, base: string[], local: string[]): string[] {
  const normalized = [...new Set(local.map((id) => String(id).trim()).filter(Boolean))];
  const merged = mergeStoredLists(base, normalized, readConditionalCostIds(source), (id) => id);
  saveConditionalCostIds(source, merged);
  return merged;
}

export function readExcludedStorageFiles(source: StorageSource): string[] {
  try {
    const parsed = JSON.parse(readValue(source, EXCLUDED_STORAGE_FILES_KEY, "[]"));
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry).trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function saveExcludedStorageFiles(source: StorageSource, fileNames: string[]): void {
  writeValue(
    source,
    EXCLUDED_STORAGE_FILES_KEY,
    JSON.stringify([...new Set(fileNames.map((name) => String(name).trim()).filter(Boolean))]),
  );
}

export function readManualFxOverrides(source: StorageSource): Record<string, string> {
  try {
    const parsed = JSON.parse(readValue(source, MANUAL_FX_OVERRIDES_KEY, "{}"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const rate = String(value ?? "").trim();
      if (key.trim() && rate) {
        result[key.trim()] = rate;
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function saveManualFxOverrides(source: StorageSource, overrides: Record<string, string>): void {
  writeValue(source, MANUAL_FX_OVERRIDES_KEY, JSON.stringify(overrides));
}

export function readPriorYearLossEntries(source: StorageSource): PriorYearLossEntry[] {
  const raw = readValue(source, PRIOR_YEAR_LOSS_ENTRIES_KEY, "");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is PriorYearLossEntry =>
        Boolean(entry) && typeof entry.taxYear === "number" && typeof entry.amountPln === "string",
    );
  } catch {
    return [];
  }
}

export function savePriorYearLossEntries(source: StorageSource, entries: PriorYearLossEntry[]): void {
  writeValue(source, PRIOR_YEAR_LOSS_ENTRIES_KEY, JSON.stringify(entries));
}

export function mergeAndSaveExcludedStorageFiles(source: StorageSource, base: string[], local: string[]): string[] {
  const normalized = [...new Set(local.map((name) => String(name).trim()).filter(Boolean))];
  const merged = mergeStoredLists(base, normalized, readExcludedStorageFiles(source), (name) => name);
  saveExcludedStorageFiles(source, merged);
  return merged;
}

export function mergeAndSavePriorYearLossEntries(source: StorageSource, base: PriorYearLossEntry[], local: PriorYearLossEntry[]): PriorYearLossEntry[] {
  const merged = mergeStoredLists(base, local, readPriorYearLossEntries(source), (entry) => `${entry.taxYear}:${entry.id}`);
  savePriorYearLossEntries(source, merged);
  return merged;
}

export function isPriorLossYearAvailable(entries: PriorYearLossEntry[], year: number, exceptIndex = -1): boolean {
  return !entries.some((entry, index) => index !== exceptIndex && entry.taxYear === year);
}

export function firstUnusedPriorLossYear(entries: PriorYearLossEntry[], selectedYear: number): number | undefined {
  return Array.from({ length: 5 }, (_, index) => selectedYear - index - 1)
    .find((year) => isPriorLossYearAvailable(entries, year));
}

/** Dawny koszt bez roku pozostaje w magazynie do jawnego przypisania w UI. */
export function readLegacyCryptoCosts(source: StorageSource): string {
  return readValue(source, LEGACY_CRYPTO_COSTS_KEY).trim();
}

export function readCryptoCostsForYear(source: StorageSource, year: number): string {
  try {
    const parsed: unknown = JSON.parse(readValue(source, CRYPTO_COSTS_BY_YEAR_KEY, "{}"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
    const value = (parsed as Record<string, unknown>)[String(year)];
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

export function saveCryptoCostsForYear(source: StorageSource, year: number, amount: string): void {
  let values: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(readValue(source, CRYPTO_COSTS_BY_YEAR_KEY, "{}"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      values = Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === "string")) as Record<string, string>;
    }
  } catch {
    // Zachowujemy możliwość poprawienia uszkodzonego wpisu.
  }
  values[String(year)] = amount;
  writeValue(source, CRYPTO_COSTS_BY_YEAR_KEY, JSON.stringify(values));
}

export function buildTaxEngineRequest(
  selectedYear: number,
  source: StorageSource = getBrowserTaxSettingsStorage(),
  packageRequest?: string | TaxPackageRequestOptions,
  transactionOverrides: NadpisanieTransakcji[] = [],
  defenseEvidenceOverrides: DefenseEvidenceOverride[] = [],
  brokerFileActionOverrides: BrokerFileActionOverride[] = [],
): TaxEngineRequest {
  const packageScope = typeof packageRequest === "string" ? packageRequest : packageRequest?.packageScope;
  const filingMode = typeof packageRequest === "string" ? undefined : packageRequest?.filingMode;
  // Odpada tylko wiersz calkiem pusty (bez kwoty). Wpis z kwota, ale bez daty zostaje w zadaniu i w
  // odcisku: silnik pomija taki wiersz po cichu (cli.py: `if not amount or not date: continue`),
  // wiec przebieg blokuje przygotujZadanieSilnika (bladyOplatFinansowania) - wynik nie moze byc
  // "gotowy" bez tego kosztu.
  const fundingFees = ensureFundingFeeEntries(source).filter((entry) => entry.amount.trim() !== "");
  // Silnik nakłada limit ustawowy sam; tutaj przekazujemy tylko to, co podał
  // użytkownik, wraz z rokiem poniesienia straty.
  // Kwota wpisana po polsku ("1234,56", "1 234,56") to nadal kwota: Number() dawal
  // dla niej NaN i strata znikala z zadania bez sladu - podatnik tracil odliczenie.
  // Pomijamy tylko wiersze puste i zerowe; wpis nieczytelny idzie do silnika,
  // ktory zatrzyma przebieg z komunikatem zamiast liczyc bez tej straty.
  const priorYearLosses = readPriorYearLossEntries(source)
    .filter((entry) => entry.taxYear > 0 && entry.amountPln.trim() !== "" && kwotaZWpisu(entry.amountPln) !== 0)
    .map((entry) => ({
      ...entry,
      amountPln: kwotaTekstowaZWpisu(entry.amountPln),
      ...(typeof entry.remainingPln === "string" && entry.remainingPln.trim() !== ""
        ? { remainingPln: kwotaTekstowaZWpisu(entry.remainingPln) }
        : {}),
    }));
  const conditionalCostIds = readConditionalCostIds(source);
  const manualFxOverrides = readManualFxOverrides(source);
  const excludedStorageFiles = readExcludedStorageFiles(source);
  const requestedCanonicalMode = readValue(source, "canonicalTaxInputMode", "required");
  const canonicalTaxInputMode = requestedCanonicalMode === "off" ? "off" : "required";
  return {
    year: selectedYear,
    runMode: "SAFE",
    taxPlan: readValue(source, "taxCalculationPlan", "aggressive_user"),
    includeFxConversionCosts: readValue(source, "includeFxConversionCosts", "true") === "true",
    includeBankFundingFees: readValue(source, "includeBankFundingFees", "true") === "true",
    includeInterestCosts: readValue(source, "includeInterestCosts", "true") === "true",
    includeAccountFees: readValue(source, "includeAccountFees", "true") === "true",
    packageScope,
    filingMode: packageScope ? (filingMode || "ORIGINAL") : undefined,
    fundingFees,
    priorYearLosses,
    cryptoCostsCarriedForward: readCryptoCostsForYear(source, selectedYear) || undefined,
    conditionalCostIds,
    manualFxOverrides,
    excludedStorageFiles,
    // Kurs ustawowy obowiązuje, dopóki użytkownik nie poda własnego.
    nbpAllowManualOverride: Object.keys(manualFxOverrides).length > 0,
    transactionOverrides,
    defenseEvidenceOverrides,
    brokerFileActionOverrides,
    sourceSelectionMode: 'canonical_stream',
    selectedCandidateSourceId: undefined,
    canonicalTaxInputMode,
    aiNormalizerEnabled: readValue(source, "aiNormalizerEnabled", "false") === "true",
    aiNormalizerGpuMode: readValue(source, "aiNormalizerGpuMode", "gpu"),
    aiNormalizerNumGpu: Number(readValue(source, "aiNormalizerNumGpu", "-1")),
    aiNormalizerGpuBackend: readValue(source, "aiNormalizerGpuBackend", "vulkan"),
    aiNormalizerGpuLoadLimitPercent: Number(readValue(source, "aiNormalizerGpuLoadLimitPercent", "85")),
    aiNormalizerNumBatch: Number(readValue(source, "aiNormalizerNumBatch", "128")),
    aiNormalizerMaxParallel: Number(readValue(source, "aiNormalizerMaxParallel", "1")),
    aiNormalizerGpuRequired: true,
    aiNormalizerGpuConfirmed: false,
    aiNormalizerComputeBackend: "unknown",
    allowCpuAi: false,
    fundingFee: undefined,
  };
}
