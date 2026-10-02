import localforage from 'localforage';

import { browserLocalStorage } from './browserStorage';

/**
 * Kopia decyzji uzytkownika.
 *
 * Pliki brokera leza na dysku i mozna je wgrac ponownie. Nie da sie odtworzyc
 * tego, co uzytkownik sam wprowadzil: recznych korekt transakcji, strat z lat
 * ubieglych, prowizji bankowych, rozstrzygniec dowodowych i zamkniec roku.
 * Kopia obejmuje wylacznie te dane - wyniki silnika powstaja na nowo przy
 * kazdym przeliczeniu.
 */
export const BACKUP_KIND = 'investanalyzer-backup';
export const BACKUP_VERSION = 3;

export type BackupPurpose = 'manual' | 'safety';

/** Powody kopii zabezpieczajacych wykonywanych automatycznie przed operacja nadpisujaca stan. */
const POWODY_ZABEZPIECZAJACE = /^(Stan sprzed|Kopia przed)/;

export interface BackupSnapshot {
  kind: typeof BACKUP_KIND;
  version: number;
  createdAt: string;
  reason?: string;
  /**
   * Rodzaj kopii: "safety" to kopia automatyczna przed operacja nadpisujaca stan
   * (rotowana osobnym, mniejszym limitem), "manual" - wykonana przez uzytkownika.
   * Brak pola (starsze kopie) znaczy "manual".
   */
  purpose?: BackupPurpose;
  appVersion?: string;
  local: Record<string, string>;
  offline: Record<string, unknown>;
  coveredKeys?: { local: string[]; offline: string[]; localPrefixes: string[] };
  skippedKeys?: string[];
}

export interface StoredBackupFile {
  id: string;
  path: string;
  createdAt: string;
  sizeBytes: number;
  reason?: string;
}

// Klucze localforage z decyzjami uzytkownika. `processed_storage_files` to
// rejestr rozpoznanych plikow - bez niego aplikacja pokazalaby wszystko jako
// nowe, wiec tez nalezy do stanu wartego zachowania.
const OFFLINE_KEYS = [
  'transactionOverrides',
  'transactionOverrideSession',
  'taxReportOrganizationStatus',
  'processed_storage_files',
];

// Klucze localStorage. Prefiksy obejmuja wpisy zalezne od roku podatkowego.
const LOCAL_KEYS = [
  'fundingFeeEntries',
  'priorYearLossEntries',
  'conditionalCostIds',
  'excludedStorageFiles',
  'manualFxOverrides',
  'taxCalculationPlan',
  'includeFxConversionCosts',
  'includeBankFundingFees',
  'includeInterestCosts',
  'includeAccountFees',
  'canonicalTaxInputMode',
  // Ustawienia normalizatora AI zmieniaja to, jak silnik rozpoznaje rekordy,
  // wiec kopia bez nich przywracalaby inne dane wejsciowe niz oryginal.
  'aiNormalizerEnabled',
  'aiNormalizerGpuMode',
  'aiNormalizerNumGpu',
  'aiNormalizerGpuBackend',
  'aiNormalizerGpuLoadLimitPercent',
  'aiNormalizerNumBatch',
  'aiNormalizerMaxParallel',
  'showAdvancedTaxPlans',
  'cryptoCostsCarriedForward',
  'cryptoCostsCarriedForwardByYear',
  'pit8cEntries',
  'pit38_optymalizacja',
  'pit38_prior_years_loss',
  'pit38_transactions',
  // Alerty cenowe i progi SL/TP oraz lista obserwowanych to ustawienia wpisane
  // przez uzytkownika - bez nich przywrocony profil tracil je bez sladu.
  // Rejestr zlecen (pit38_broker_orders) celowo NIE: stan zlecenia zna broker,
  // a stara lista pokazalaby wykonane lub anulowane zlecenia jako aktywne.
  'pit38_alerts',
  'pit38_favorite_tickers',
  'theme',
  'selectedAnalysisYear:v1',
  'investAnalyzer:ollamaConfig:v1',
  'defenseEvidenceOverrides:v1',
  'defenseVault:v1',
  'brokerFileActionOverrides:v1',
  'autoCheckActionOverrides:v1',
  'reviewDecisions:v1',
  'source_trust_decisions:v1',
  'storage_version',
  'uiComplexityMode:v1',
  'uiLanguage:v1',
  'historyShowTechnicalRows:v1',
  'historyActionButtonLabelMode',
];

// Dane identyfikacyjne podatnika (PESEL, adres - klucze pit38_taxpayer_*) celowo
// NIE trafiaja do kopii: eksport to zwykly plik JSON, a te dane mozna wpisac
// ponownie - w przeciwienstwie do decyzji, ktorych nie da sie odtworzyc.
const LOCAL_KEY_PREFIXES = ['pitCaseFileBaseline:', 'taxYearClosure:'];

// Rachunki portfela. Typ brokera decyduje, czy reczne transakcje sa "polskie"
// (informacja PIT-8C), wiec bez rachunkow kopia odtwarzala transakcje
// wskazujace na nieistniejace konta. Rachunek niesie jednak sekrety (klucze API,
// SID, haslo, kod SMS), a kopia to zwykly plik JSON - trafiaja do niej tylko
// pola z tej listy. Przy przywracaniu sekrety rachunku o tym samym id zostaja
// z przegladarki. Kopia bez rachunkow (starsza) ich nie usuwa.
const ACCOUNTS_KEY = 'pit38_accounts';
const ACCOUNT_BACKUP_FIELDS = ['id', 'name', 'brokerType', 'currency', 'color', 'apiServerType', 'freedom24AuthMethod', 'autoSync'] as const;

function parseAccounts(value: string | null): Array<Record<string, unknown>> | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      : null;
  } catch {
    return null;
  }
}

function accountsWithoutSecrets(value: string | null): string | null {
  const accounts = parseAccounts(value);
  if (accounts === null) return null;
  return JSON.stringify(accounts.map((account) => Object.fromEntries(
    ACCOUNT_BACKUP_FIELDS.filter((field) => account[field] !== undefined).map((field) => [field, account[field]]),
  )));
}

function accountsMergedWithLocalSecrets(fromBackup: string, local: string | null): string {
  const restored = parseAccounts(fromBackup) ?? [];
  const localById = new Map((parseAccounts(local) ?? []).map((account) => [String(account.id), account]));
  // Lokalne poswiadczenia wracaja tylko do rachunku tego samego brokera i tej samej metody
  // logowania. Dawniej rachunek przywrocony jako IBKR dostawal klucz i sekret Binance z
  // biezacego rachunku o tym samym ID, a synchronizacja wysylala je do IBKR. Bez zgodnego
  // rachunku lokalnego zostaje wpis z kopii w calosci (kopia nie niesie sekretow).
  const wynik = restored.map((account) => {
    const localAccount = localById.get(String(account.id));
    const compatible = localAccount !== undefined
      && localAccount.brokerType === account.brokerType
      && localAccount.freedom24AuthMethod === account.freedom24AuthMethod;
    return compatible ? { ...localAccount, ...account } : { ...account };
  });
  // Rachunki dodane po utworzeniu kopii nie sa w niej (kopia nie niesie sekretow), ale nie wolno ich
  // kasowac razem z kluczami API - zostaja w calosci, za rachunkami z kopii.
  const idyZKopii = new Set(restored.map((account) => String(account.id)));
  for (const [id, localAccount] of localById) {
    if (!idyZKopii.has(id)) wynik.push({ ...localAccount });
  }
  return JSON.stringify(wynik);
}

function collectLocalKeys(): string[] {
  const keys = new Set(LOCAL_KEYS);
  try {
    // `globalThis.window` nie istnieje poza przegladarka, a wtedy caly skan
    // prefiksow milczaco nie znajdowal nic - kopia gubila wszystkie wpisy
    // `pitCaseFileBaseline:*` i `taxYearClosure:*`, czyli dokladnie te decyzje,
    // dla ktorych ta funkcja powstala.
    const storage =
      globalThis.window?.localStorage
      ?? (globalThis as typeof globalThis & { localStorage?: Storage }).localStorage;
    if (storage) {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key && LOCAL_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) {
          keys.add(key);
        }
      }
    }
  } catch {
    // Brak dostepu do localStorage nie moze przerwac tworzenia kopii.
  }
  return [...keys];
}

export async function collectBackupSnapshot(reason?: string, purpose?: BackupPurpose): Promise<BackupSnapshot> {
  const local: Record<string, string> = {};
  const localKeys = collectLocalKeys();
  for (const key of localKeys) {
    const value = browserLocalStorage.getItem(key);
    if (value !== null) {
      local[key] = value;
    }
  }
  const accounts = accountsWithoutSecrets(browserLocalStorage.getItem(ACCOUNTS_KEY));
  if (accounts !== null) {
    local[ACCOUNTS_KEY] = accounts;
  }

  const offline: Record<string, unknown> = {};
  const skippedKeys: string[] = [];
  for (const key of OFFLINE_KEYS) {
    try {
      const value = await localforage.getItem(key);
      if (value !== null && value !== undefined) {
        offline[key] = value;
      }
    } catch {
      skippedKeys.push(key);
    }
  }

  return {
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    reason,
    purpose: purpose ?? (reason && POWODY_ZABEZPIECZAJACE.test(reason) ? 'safety' : 'manual'),
    local,
    offline,
    coveredKeys: { local: localKeys, offline: [...OFFLINE_KEYS], localPrefixes: [...LOCAL_KEY_PREFIXES] },
    skippedKeys,
  };
}

export function isBackupSnapshot(value: unknown): value is BackupSnapshot {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<BackupSnapshot>;
  return (
    candidate.kind === BACKUP_KIND &&
    typeof candidate.version === 'number' &&
    typeof candidate.local === 'object' &&
    candidate.local !== null &&
    typeof candidate.offline === 'object' &&
    candidate.offline !== null
  );
}

export interface RestoreSummary {
  localKeys: number;
  offlineKeys: number;
  createdAt: string;
  untouchedKeys: string[];
}

export class BackupRestoreError extends Error {
  constructor(public readonly failedKey: string, public readonly rollbackFailedKeys: string[]) {
    super(rollbackFailedKeys.length
      ? `Przywracanie nie powiodło się przy „${failedKey}”. Wycofanie stanu też nie powiodło się dla: ${rollbackFailedKeys.join(', ')}.`
      : `Przywracanie nie powiodło się przy „${failedKey}”. Przywrócono stan sprzed operacji.`);
  }
}

export async function restoreBackupSnapshot(snapshot: BackupSnapshot): Promise<RestoreSummary> {
  if (!isBackupSnapshot(snapshot)) {
    throw new Error('To nie jest kopia zapasowa InvestAnalyzer.');
  }
  if (snapshot.version > BACKUP_VERSION) {
    throw new Error(
      `Kopia pochodzi z nowszej wersji aplikacji (format ${snapshot.version}, obsługiwany ${BACKUP_VERSION}).`,
    );
  }

  // Nie rozpoczynaj przywracania, jeśli ustawienia localStorage trafiłyby
  // wyłącznie do pamięci ulotnej.
  browserLocalStorage.assertPersistentAvailable();

  const covered = snapshot.version >= 3 ? snapshot.coveredKeys : undefined;
  const skipped = new Set(snapshot.skippedKeys ?? []);
  const localKeys = collectLocalKeys();
  const usunLokalne = covered ? localKeys.filter((key) =>
    (covered.local.includes(key) || covered.localPrefixes.some((prefix) => key.startsWith(prefix)))
      && !(key in snapshot.local) && !skipped.has(key)) : [];
  const usunOffline = covered ? OFFLINE_KEYS.filter((key) =>
    covered.offline.includes(key) && !(key in snapshot.offline) && !skipped.has(key)) : [];
  const localBefore = new Map<string, string | null>();
  const offlineBefore = new Map<string, unknown>();
  const untouchedKeys: string[] = [];
  for (const key of new Set([...localKeys, ACCOUNTS_KEY, ...Object.keys(snapshot.local)])) {
    const value = browserLocalStorage.getItem(key);
    if (value !== null && !covered && !(key in snapshot.local)) untouchedKeys.push(key);
    if (usunLokalne.includes(key) || key in snapshot.local) localBefore.set(key, value);
  }
  for (const key of new Set([...OFFLINE_KEYS, ...Object.keys(snapshot.offline)])) {
    if (skipped.has(key) && !(key in snapshot.offline)) continue;
    const affected = usunOffline.includes(key) || key in snapshot.offline;
    if (!affected && covered) continue;
    let value: unknown;
    try { value = await localforage.getItem(key); }
    catch (error) {
      if (affected) throw error;
      continue;
    }
    if (value !== null && value !== undefined && !covered && !(key in snapshot.offline)) untouchedKeys.push(key);
    if (affected) offlineBefore.set(key, value);
  }

  let failedKey = '';
  try {
    for (const key of usunLokalne) {
      failedKey = key;
      browserLocalStorage.removeItem(key);
      if (browserLocalStorage.getItem(key) !== null) throw new Error('Usunięcie nie zostało utrwalone');
    }
    for (const [key, value] of Object.entries(snapshot.local)) {
      failedKey = key;
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      const zapis = key === ACCOUNTS_KEY
        ? accountsMergedWithLocalSecrets(text, localBefore.get(ACCOUNTS_KEY) ?? null) : text;
      browserLocalStorage.setItemPersistent(key, zapis);
      if (browserLocalStorage.getItem(key) !== zapis) throw new Error('Zapis nie został utrwalony');
    }
    for (const key of usunOffline) {
      failedKey = key;
      await localforage.removeItem(key);
      if (await localforage.getItem(key) != null) throw new Error('Usunięcie nie zostało utrwalone');
    }
    for (const [key, value] of Object.entries(snapshot.offline)) {
      failedKey = key;
      await localforage.setItem(key, value);
      if (JSON.stringify(await localforage.getItem(key)) !== JSON.stringify(value)) throw new Error('Zapis nie został utrwalony');
    }
  } catch {
    const rollbackFailedKeys: string[] = [];
    // Najpierw usuwamy wpisy utworzone przez przywracanie, dopiero potem odtwarzamy
    // poprzednie wartosci: przy pelnym magazynie duza stara wartosc nie zmiescilaby
    // sie obok nowych wpisow i przepadlaby, choc miejsce zaraz by sie zwolnilo.
    const lokalnePoKolei = [...localBefore].sort(([, a], [, b]) => Number(a !== null) - Number(b !== null));
    for (const [key, value] of lokalnePoKolei) {
      try {
        if (value === null) browserLocalStorage.removeItem(key);
        else browserLocalStorage.setItemPersistent(key, value);
        if (browserLocalStorage.getItem(key) !== value) throw new Error('Wycofanie nie zostało utrwalone');
      } catch { rollbackFailedKeys.push(key); }
    }
    const offlinePoKolei = [...offlineBefore].sort(([, a], [, b]) => Number(a != null) - Number(b != null));
    for (const [key, value] of offlinePoKolei) {
      try {
        if (value === null || value === undefined) await localforage.removeItem(key);
        else await localforage.setItem(key, value);
        if (JSON.stringify(await localforage.getItem(key)) !== JSON.stringify(value ?? null)) throw new Error('Wycofanie nie zostało utrwalone');
      } catch { rollbackFailedKeys.push(key); }
    }
    throw new BackupRestoreError(failedKey, rollbackFailedKeys);
  }

  return {
    localKeys: Object.keys(snapshot.local).length,
    offlineKeys: Object.keys(snapshot.offline).length,
    createdAt: snapshot.createdAt,
    untouchedKeys,
  };
}

export function parseBackupFileContent(content: string): BackupSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Plik kopii nie jest poprawnym dokumentem JSON.');
  }
  if (!isBackupSnapshot(parsed)) {
    throw new Error('To nie jest kopia zapasowa InvestAnalyzer.');
  }
  return parsed;
}

export function backupFileName(createdAt: string): string {
  const stamp = createdAt.replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  return `investanalyzer-kopia-${stamp}.json`;
}
