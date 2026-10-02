import localforage from 'localforage';
import type { NadpisanieTransakcji } from './transactionOverrides';
import type { TaxReportOrganizationStatus } from './reportOrganizationStatus';
import {
  createEmptyOverrideSession,
  type SnapshotOverride,
  type StanSesjiOverride,
  type SzkicEdytoraTransakcji,
  type PinnedTransactionLink,
} from './overrideHistory';
import { browserLocalStorage } from './browserStorage';

localforage.config({
  name: 'InvestmentAnalyzer',
  storeName: 'dane'
});

// Kazda zmiana sesji korekt idzie przez jedna kolejke. Zapis szkicu czytal sesje, a gdy
// w tym czasie uzytkownik zapisal korekte, odkladal stara sesje i korekta znikala z magazynu.
let kolejkaSesji: Promise<unknown> = Promise.resolve();

function wKolejceSesji<T>(zadanie: () => Promise<T>): Promise<T> {
  const wynik = kolejkaSesji.then(zadanie);
  kolejkaSesji = wynik.catch(() => undefined);
  return wynik;
}

async function zapiszSesje(session: StanSesjiOverride): Promise<void> {
  await localforage.setItem('transactionOverrideSession', session);
  await localforage.setItem('transactionOverrides', session.transactionOverrides);
}

export const StorageService = {
  async getTransactionOverrides(): Promise<NadpisanieTransakcji[]> {
    const session = await this.getTransactionOverrideSession();
    return session.transactionOverrides;
  },

  async saveTransactionOverrides(overrides: NadpisanieTransakcji[]): Promise<void> {
    await wKolejceSesji(async () => {
      const session = await this.getTransactionOverrideSession();
      await zapiszSesje({ ...session, transactionOverrides: overrides });
    });
  },

  async upsertTransactionOverride(override: NadpisanieTransakcji): Promise<void> {
    await wKolejceSesji(async () => {
      const session = await this.getTransactionOverrideSession();
      const next = session.transactionOverrides.filter((entry) => entry.manualRecordId !== override.manualRecordId);
      next.push(override);
      await zapiszSesje({ ...session, transactionOverrides: next });
    });
  },

  async removeTransactionOverride(manualRecordId: string): Promise<void> {
    await wKolejceSesji(async () => {
      const session = await this.getTransactionOverrideSession();
      await zapiszSesje({
        ...session,
        transactionOverrides: session.transactionOverrides.filter((entry) => entry.manualRecordId !== manualRecordId),
      });
    });
  },

  async clearTransactionOverrides(): Promise<void> {
    await wKolejceSesji(async () => {
      await localforage.removeItem('transactionOverrides');
      await localforage.removeItem('transactionOverrideSession');
    });
  },

  async getTransactionOverrideSession(): Promise<StanSesjiOverride> {
    const dane = await localforage.getItem<Partial<StanSesjiOverride>>('transactionOverrideSession');
    if (dane && typeof dane === 'object') {
      const pinnedTransactionLinks = Array.isArray(
        (dane as Partial<StanSesjiOverride> & { pinnedTransactionLinks?: PinnedTransactionLink[] }).pinnedTransactionLinks,
      )
        ? (dane as Partial<StanSesjiOverride> & { pinnedTransactionLinks?: PinnedTransactionLink[] }).pinnedTransactionLinks || []
        : [];
      const snapshots = Array.isArray(dane.snapshots)
        ? dane.snapshots.map((snapshot) => ({
            ...snapshot,
            pinnedTransactionLinks: Array.isArray((snapshot as SnapshotOverride).pinnedTransactionLinks)
              ? (snapshot as SnapshotOverride).pinnedTransactionLinks
              : [],
          }))
        : [];
      return {
        ...createEmptyOverrideSession(),
        ...dane,
        transactionOverrides: Array.isArray(dane.transactionOverrides) ? dane.transactionOverrides : [],
        pinnedTransactionLinks,
        undoStack: Array.isArray(dane.undoStack) ? dane.undoStack : [],
        redoStack: Array.isArray(dane.redoStack) ? dane.redoStack : [],
        operationHistory: Array.isArray(dane.operationHistory) ? dane.operationHistory : [],
        snapshots,
        editorDraft: dane.editorDraft || null,
        lastMutationAt: dane.lastMutationAt || null,
      };
    }

    const legacyOverrides = (await localforage.getItem<NadpisanieTransakcji[]>('transactionOverrides')) || [];
    return createEmptyOverrideSession(legacyOverrides);
  },

  async saveTransactionOverrideSession(session: StanSesjiOverride): Promise<void> {
    await wKolejceSesji(() => zapiszSesje(session));
  },

  async getTransactionEditorDraft(): Promise<SzkicEdytoraTransakcji | null> {
    const session = await this.getTransactionOverrideSession();
    return session.editorDraft || null;
  },

  async saveTransactionEditorDraft(draft: SzkicEdytoraTransakcji | null): Promise<void> {
    // Szkic zmienia wylacznie swoje pole w NAJNOWSZEJ sesji - odczyt w kolejce, po
    // zapisach, ktore zlecono wczesniej.
    await wKolejceSesji(async () => {
      const session = await this.getTransactionOverrideSession();
      await zapiszSesje({ ...session, editorDraft: draft });
    });
  },

  async clearTransactionEditorDraft(): Promise<void> {
    await this.saveTransactionEditorDraft(null);
  },

  async getTransactionOverrideSnapshots(): Promise<SnapshotOverride[]> {
    const session = await this.getTransactionOverrideSession();
    return session.snapshots;
  },

  async getTaxReportOrganizationStatus(year: number): Promise<TaxReportOrganizationStatus | null> {
    const dane = await localforage.getItem<Record<string, TaxReportOrganizationStatus>>('taxReportOrganizationStatus');
    return dane?.[String(year)] || null;
  },

  async saveTaxReportOrganizationStatus(status: TaxReportOrganizationStatus): Promise<void> {
    const dane = (await localforage.getItem<Record<string, TaxReportOrganizationStatus>>('taxReportOrganizationStatus')) || {};
    dane[String(status.year)] = status;
    await localforage.setItem('taxReportOrganizationStatus', dane);
  },

  async getProcessedStorageFiles(): Promise<string[]> {
    const stored = await localforage.getItem<string[]>('processed_storage_files');
    if (Array.isArray(stored)) {
      return stored;
    }

    const legacyRaw = browserLocalStorage.getItem('processed_storage_files');
    if (!legacyRaw) {
      return [];
    }
    try {
      const legacy = JSON.parse(legacyRaw);
      if (Array.isArray(legacy)) {
        const normalized = legacy.map(String);
        await localforage.setItem('processed_storage_files', normalized);
        browserLocalStorage.removeItem('processed_storage_files');
        return normalized;
      }
    } catch {
      browserLocalStorage.removeItem('processed_storage_files');
    }
    return [];
  },

  async saveProcessedStorageFiles(files: string[]): Promise<void> {
    await localforage.setItem('processed_storage_files', Array.from(new Set(files.map(String))));
  },

  async clearRetiredBrokerApiState(): Promise<void> {
    const legacyKeys = [
      'freedom24LastRawHistoryStatus',
      'freedom24LastFullSyncStatus',
      'freedom24LiveProfitSnapshot',
      'freedom24LastSyncAt',
      'freedom24AutoSyncEnabled',
      'freedom24AutoSyncIntervalMinutes',
      'freedom24LastSyncHash',
      'investAnalyzerFreedomWorkspaceTab',
    ];
    await Promise.all([
      ...legacyKeys.map((key) => localforage.removeItem(key)),
    ]);
    for (const key of legacyKeys) {
      browserLocalStorage.removeItem(key);
    }
  },

  async clearAll(): Promise<void> {
    await localforage.clear();
  }
};
