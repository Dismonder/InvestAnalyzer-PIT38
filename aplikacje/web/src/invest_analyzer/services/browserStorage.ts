export type BrowserStorageKind = 'local' | 'session';

export interface SafeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  setItemPersistent(key: string, value: string): void;
  assertPersistentAvailable(): void;
  removeItem(key: string): void;
  clear(): void;
}

function resolveBrowserStorage(kind: BrowserStorageKind): Storage | null {
  try {
    const browserWindow = globalThis.window;
    if (browserWindow) {
      return kind === 'local' ? browserWindow.localStorage : browserWindow.sessionStorage;
    }
    const globalStorage = kind === 'local'
      ? (globalThis as typeof globalThis & { localStorage?: Storage }).localStorage
      : (globalThis as typeof globalThis & { sessionStorage?: Storage }).sessionStorage;
    return globalStorage || null;
  } catch {
    return null;
  }
}

function createNoopStorage(kind: BrowserStorageKind): SafeStorage {
  const memory = new Map<string, string>();
  const assertPersistentAvailable = () => {
    if (!resolveBrowserStorage(kind)) {
      throw new Error('Magazyn przeglądarki jest niedostępny. Przywracanie kopii wymaga trwałego localStorage.');
    }
  };
  return {
    getItem: (key) => resolveBrowserStorage(kind)?.getItem(key) ?? memory.get(key) ?? null,
    setItem: (key, value) => {
      const storage = resolveBrowserStorage(kind);
      if (storage) {
        storage.setItem(key, value);
        return;
      }
      memory.set(key, value);
    },
    setItemPersistent: (key, value) => {
      assertPersistentAvailable();
      resolveBrowserStorage(kind)!.setItem(key, value);
    },
    assertPersistentAvailable,
    removeItem: (key) => {
      resolveBrowserStorage(kind)?.removeItem(key);
      memory.delete(key);
    },
    clear: () => {
      resolveBrowserStorage(kind)?.clear();
      memory.clear();
    },
  };
}

export const browserLocalStorage = createNoopStorage('local');
export const browserSessionStorage = createNoopStorage('session');
