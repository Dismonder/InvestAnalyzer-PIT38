import test from "node:test";
import assert from "node:assert/strict";
import localforage from "localforage";

import {
  BACKUP_KIND,
  BACKUP_VERSION,
  BackupRestoreError,
  backupFileName,
  collectBackupSnapshot,
  isBackupSnapshot,
  parseBackupFileContent,
  restoreBackupSnapshot,
  type BackupSnapshot,
} from "../../../aplikacje/web/src/invest_analyzer/services/backup.ts";

function validSnapshot(): BackupSnapshot {
  return {
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    createdAt: "2026-09-06T10:15:00.000Z",
    local: { priorYearLossEntries: "[]" },
    offline: { transactionOverrides: [] },
  };
}

test("kopia rozpoznaje własny format", () => {
  assert.equal(isBackupSnapshot(validSnapshot()), true);
});

test("błąd w połowie przywracania wycofuje skasowane i nadpisane wpisy", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const store = new Map<string, string>([
    ["priorYearLossEntries", "stare straty"],
    ["taxYearClosure:2024", "zamknięty"],
    ["pit38_alerts", "stare alerty"],
  ]);
  let failOnce = true;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (key === "pit38_alerts" && failOnce) {
        failOnce = false;
        throw new DOMException("limit", "QuotaExceededError");
      }
      store.set(key, value);
    },
    removeItem: (key: string) => { store.delete(key); },
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() { return store.size; },
  } });
  try {
    const snapshot: BackupSnapshot = {
      ...validSnapshot(), local: { priorYearLossEntries: "nowe straty", pit38_alerts: "nowe alerty" },
      offline: {}, coveredKeys: { local: ["priorYearLossEntries", "pit38_alerts"], offline: [], localPrefixes: ["taxYearClosure:"] },
    };
    await assert.rejects(restoreBackupSnapshot(snapshot), (error: unknown) => {
      assert.ok(error instanceof BackupRestoreError);
      assert.deepEqual(error.rollbackFailedKeys, []);
      assert.match(error.message, /Przywrócono stan sprzed operacji/);
      return true;
    });
    assert.equal(store.get("priorYearLossEntries"), "stare straty");
    assert.equal(store.get("taxYearClosure:2024"), "zamknięty");
    assert.equal(store.get("pit38_alerts"), "stare alerty");
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("kopia v2 raportuje nowsze klucze pozostawione bez zmian", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const store = new Map<string, string>([["pit38_alerts", "bieżące alerty"]]);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() { return store.size; },
  } });
  try {
    const summary = await restoreBackupSnapshot({ ...validSnapshot(), version: 2, coveredKeys: undefined, offline: {} });
    assert.ok(summary.untouchedKeys.includes("pit38_alerts"));
    assert.equal(store.get("pit38_alerts"), "bieżące alerty");
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("obcy plik JSON nie jest kopią", () => {
  assert.equal(isBackupSnapshot({ kind: "cos-innego", version: 2, local: {}, offline: {} }), false);
  assert.equal(isBackupSnapshot({ kind: BACKUP_KIND, version: 2 }), false);
  assert.equal(isBackupSnapshot(null), false);
  assert.equal(isBackupSnapshot("kopia"), false);
});

test("wczytanie pliku, który nie jest JSON-em, daje zrozumiały komunikat", () => {
  assert.throws(() => parseBackupFileContent("{to nie jest json"), /nie jest poprawnym dokumentem JSON/);
});

test("wczytanie obcego JSON-a mówi wprost, że to nie kopia", () => {
  assert.throws(() => parseBackupFileContent('{"kind":"cos-innego"}'), /nie jest kopia zapasowa|nie jest kopią zapasową/i);
});

test("poprawny plik kopii daje się wczytać", () => {
  const snapshot = parseBackupFileContent(JSON.stringify(validSnapshot()));

  assert.equal(snapshot.createdAt, "2026-09-06T10:15:00.000Z");
  assert.deepEqual(snapshot.local, { priorYearLossEntries: "[]" });
});

test("nazwa pliku kopii nie zawiera znaków zakazanych w systemie plików", () => {
  const name = backupFileName("2026-09-06T10:15:00.000Z");

  assert.equal(name, "investanalyzer-kopia-2026-09-06_10-15-00.json");
  assert.equal(/[:*?"<>|]/.test(name), false);
});

test("przywrócenie odtwarza stan z kopii, a nie dokleja go do bieżącego", async () => {
  // Samo nadpisanie kluczy zostawiało te, które powstały po zapisaniu kopii -
  // przywrócenie wczorajszej kopii nie cofało zamknięcia roku.
  const store = new Map<string, string>();
  const previous = (globalThis as typeof globalThis & { localStorage?: unknown }).localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
      key: (index: number) => [...store.keys()][index] ?? null,
      get length() {
        return store.size;
      },
    },
  });

  try {
    store.set("priorYearLossEntries", '[{"taxYear":2024}]');
    store.set("cryptoCostsCarriedForward", "1000.00");
    store.set("cryptoCostsCarriedForwardByYear", '{"2025":"1000.00","2026":"400.00"}');
    const reviewDecisions = '[{"decisionKey":"bonus-1","decision":"no_tax_effect"}]';
    store.set("reviewDecisions:v1", reviewDecisions);
    store.set("pit38_taxpayer_pesel", "PESEL-TESTOWY");
    store.set("pit38_alerts", '[{"id":"a1","ticker":"NBIS","targetPrice":50}]');
    store.set("pit38_broker_orders", '[{"id":"o1"}]');
    const snapshot = await collectBackupSnapshot();

    assert.equal(snapshot.local["reviewDecisions:v1"], reviewDecisions, "rozstrzygnięcia trafiają do kopii");
    assert.equal(snapshot.local["cryptoCostsCarriedForwardByYear"], '{"2025":"1000.00","2026":"400.00"}');
    assert.equal(snapshot.coveredKeys?.local.includes("cryptoCostsCarriedForwardByYear"), true);
    assert.equal(snapshot.local["pit38_taxpayer_pesel"], undefined, "dane identyfikacyjne podatnika nie trafiają do kopii");
    assert.equal(snapshot.local["pit38_alerts"], '[{"id":"a1","ticker":"NBIS","targetPrice":50}]', "alerty cenowe trafiają do kopii");
    assert.equal(snapshot.local["pit38_broker_orders"], undefined, "stan zleceń zna broker - rejestr nie trafia do kopii");
    store.set("taxYearClosure:2024", '{"status":"closed"}');
    store.set("reviewDecisions:v1", "[]");
    await restoreBackupSnapshot(snapshot);

    assert.equal(store.get("priorYearLossEntries"), '[{"taxYear":2024}]', "wpis z kopii zostaje");
    assert.equal(store.get("cryptoCostsCarriedForward"), "1000.00");
    assert.equal(store.get("cryptoCostsCarriedForwardByYear"), '{"2025":"1000.00","2026":"400.00"}');
    assert.equal(store.has("taxYearClosure:2024"), false, "zamknięcie roku spoza kopii musi zniknąć");
    assert.equal(store.get("reviewDecisions:v1"), reviewDecisions, "rozstrzygnięcia wracają z kopii");
    const oldSnapshot: BackupSnapshot = {
      ...snapshot,
      local: { priorYearLossEntries: '[{"taxYear":2023,"amountPln":"900"}]', cryptoCostsCarriedForward: "750.00" },
      coveredKeys: { local: ["priorYearLossEntries", "cryptoCostsCarriedForward"], offline: [], localPrefixes: [] },
    };
    await restoreBackupSnapshot(oldSnapshot);
    assert.equal(store.get("priorYearLossEntries"), oldSnapshot.local.priorYearLossEntries);
    assert.equal(store.get("cryptoCostsCarriedForward"), "750.00");
    assert.equal(store.get("cryptoCostsCarriedForwardByYear"), '{"2025":"1000.00","2026":"400.00"}', "stara kopia nie usuwa nowego formatu");
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(globalThis, "localStorage");
    } else {
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: previous });
    }
  }
});

test("przywrócenie odrzuca kopię, gdy magazyn przeglądarki jest niedostępny", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get: () => { throw new Error("blocked"); },
  });
  try {
    await assert.rejects(
      restoreBackupSnapshot(validSnapshot()),
      /Magazyn przeglądarki jest niedostępny.*trwałego localStorage/,
    );
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("rachunki portfela trafiają do kopii bez sekretów, a przywrócenie zachowuje lokalne klucze", async () => {
  // Typ brokera decyduje o PIT-8C, więc kopia bez rachunków odtwarzała transakcje
  // wskazujące na nieistniejące konta. Rachunek niesie jednak klucze API i hasła.
  const store = new Map<string, string>();
  const previous = (globalThis as typeof globalThis & { localStorage?: unknown }).localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
      key: (index: number) => [...store.keys()][index] ?? null,
      get length() {
        return store.size;
      },
    },
  });
  try {
    store.set("pit38_accounts", JSON.stringify([
      { id: "xtb", name: "XTB", brokerType: "XTB", currency: "PLN", color: "#000", apiKey: "SEKRET-KLUCZ",
        apiSecret: "SEKRET", sid: "SID", password: "HASLO", smsCode: "123456", loginEmail: "LOGIN-SYNTETYCZNY", accountNumber: "PL123" },
    ]));
    const snapshot = await collectBackupSnapshot();
    const zKopii = JSON.parse(snapshot.local["pit38_accounts"]);
    assert.deepEqual(zKopii, [{ id: "xtb", name: "XTB", brokerType: "XTB", currency: "PLN", color: "#000" }]);
    assert.doesNotMatch(JSON.stringify(snapshot), /SEKRET|HASLO|SID|123456|LOGIN-SYNTETYCZNY|PL123/, "sekrety nie trafiają do pliku kopii");

    // Przywrócenie: rachunek o tym samym id zachowuje lokalne klucze, nowy wraca bez nich.
    snapshot.local["pit38_accounts"] = JSON.stringify([
      { id: "xtb", name: "XTB główny", brokerType: "XTB", currency: "PLN", color: "#000" },
      { id: "ibkr", name: "IBKR", brokerType: "IBKR", currency: "USD", color: "#111" },
    ]);
    await restoreBackupSnapshot(snapshot);
    const poPrzywroceniu = JSON.parse(store.get("pit38_accounts") ?? "[]");
    assert.equal(poPrzywroceniu.length, 2);
    assert.equal(poPrzywroceniu[0].name, "XTB główny");
    assert.equal(poPrzywroceniu[0].apiKey, "SEKRET-KLUCZ", "lokalny klucz API zostaje");
    assert.equal(poPrzywroceniu[1].apiKey, undefined);

    // Po zmianie typu brokera lokalne poświadczenia nie mogą przejść z Binance do IBKR.
    store.set("pit38_accounts", JSON.stringify([
      { id: "xtb", name: "Binance", brokerType: "BINANCE", apiKey: "KLUCZ-BINANCE", apiSecret: "SECRET-BINANCE" },
    ]));
    snapshot.local["pit38_accounts"] = JSON.stringify([
      { id: "xtb", name: "IBKR", brokerType: "IBKR", currency: "USD", color: "#000" },
    ]);
    await restoreBackupSnapshot(snapshot);
    const poZmianieTypu = JSON.parse(store.get("pit38_accounts") ?? "[]")[0];
    assert.equal(poZmianieTypu.apiKey, undefined);
    assert.equal(poZmianieTypu.apiSecret, undefined);

    // Zgodny typ i metoda uwierzytelnienia zachowują poświadczenia.
    store.set("pit38_accounts", JSON.stringify([
      { id: "xtb", name: "XTB", brokerType: "XTB", apiKey: "KLUCZ-XTB" },
    ]));
    snapshot.local["pit38_accounts"] = JSON.stringify([
      { id: "xtb", name: "XTB", brokerType: "XTB", currency: "PLN", color: "#000" },
    ]);
    await restoreBackupSnapshot(snapshot);
    assert.equal(JSON.parse(store.get("pit38_accounts") ?? "[]")[0].apiKey, "KLUCZ-XTB");

    // Świeża instalacja (brak rachunku lokalnego): wpis z kopii zostaje w całości, łącznie
    // z polami, które nie są sekretami (numer rachunku, identyfikator zapytania IBKR).
    store.delete("pit38_accounts");
    snapshot.local["pit38_accounts"] = JSON.stringify([
      { id: "ibkr", name: "IBKR", brokerType: "IBKR", currency: "USD", color: "#000", accountNumber: "U123", queryId: "Q-9" },
    ]);
    await restoreBackupSnapshot(snapshot);
    const naSwiezej = JSON.parse(store.get("pit38_accounts") ?? "[]")[0];
    assert.equal(naSwiezej.accountNumber, "U123");
    assert.equal(naSwiezej.queryId, "Q-9");
    snapshot.local["pit38_accounts"] = JSON.stringify([
      { id: "xtb", name: "XTB", brokerType: "XTB", currency: "PLN", color: "#000" },
    ]);
    store.set("pit38_accounts", JSON.stringify([
      { id: "xtb", name: "XTB", brokerType: "XTB", apiKey: "KLUCZ-XTB" },
    ]));

    // Starsza kopia (bez rachunków) nie usuwa rachunków ani ich kluczy.
    const bezRachunkow = { ...snapshot, local: { ...snapshot.local } };
    delete bezRachunkow.local["pit38_accounts"];
    await restoreBackupSnapshot(bezRachunkow);
    assert.equal(JSON.parse(store.get("pit38_accounts") ?? "[]")[0].apiKey, "KLUCZ-XTB");
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(globalThis, "localStorage");
    } else {
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: previous });
    }
  }
});

test("nieczytelny klucz localforage jest opisany i nie jest usuwany przy przywracaniu", async () => {
  const originalGet = localforage.getItem;
  const originalRemove = localforage.removeItem;
  const originalSet = localforage.setItem;
  const removed: string[] = [];
  localforage.getItem = (async (key: string) => {
    if (key === "transactionOverrides") throw new Error("nieczytelne");
    return null;
  }) as typeof localforage.getItem;
  localforage.removeItem = (async (key: string) => { removed.push(key); }) as typeof localforage.removeItem;
  localforage.setItem = (async (_key: string, value: unknown) => value) as typeof localforage.setItem;
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() { return store.size; },
  } });
  try {
    const snapshot = await collectBackupSnapshot();
    assert.deepEqual(snapshot.skippedKeys, ["transactionOverrides"]);
    await restoreBackupSnapshot(snapshot);
    assert.equal(removed.includes("transactionOverrides"), false);
  } finally {
    localforage.getItem = originalGet;
    localforage.removeItem = originalRemove;
    localforage.setItem = originalSet;
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("starsza kopia nie usuwa nowych kluczy, a nowa cofa tylko objęte klucze i zamknięcia roku", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() { return store.size; },
  } });
  try {
    store.set("theme", "dark");
    store.set("taxYearClosure:2024", "closed");
    const old = { ...validSnapshot(), version: 2, offline: {} };
    await restoreBackupSnapshot(old);
    assert.equal(store.get("theme"), "dark");
    assert.equal(store.get("taxYearClosure:2024"), "closed");
    const newer = { ...validSnapshot(), offline: {}, coveredKeys: { local: ["priorYearLossEntries"], offline: [], localPrefixes: ["taxYearClosure:"] } };
    await restoreBackupSnapshot(newer);
    assert.equal(store.get("theme"), "dark");
    assert.equal(store.has("taxYearClosure:2024"), false);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("wycofanie przy pełnym magazynie najpierw usuwa nowe wpisy, potem odtwarza duże stare (R15)", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const LIMIT = 100;
  const store = new Map<string, string>([["priorYearLossEntries", "S".repeat(60)]]);
  const zajete = (bez: string) => [...store].reduce((suma, [klucz, wartosc]) => suma + (klucz === bez ? 0 : wartosc.length), 0);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (key === "pit38_alerts" || zajete(key) + value.length > LIMIT) throw new DOMException("limit", "QuotaExceededError");
      store.set(key, value);
    },
    removeItem: (key: string) => { store.delete(key); },
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() { return store.size; },
  } });
  try {
    const snapshot: BackupSnapshot = {
      ...validSnapshot(),
      local: { priorYearLossEntries: "s", conditionalCostIds: "N".repeat(50), pit38_alerts: "a" },
      offline: {},
      coveredKeys: { local: ["priorYearLossEntries", "conditionalCostIds", "pit38_alerts"], offline: [], localPrefixes: [] },
    };
    await assert.rejects(restoreBackupSnapshot(snapshot), (error: unknown) => {
      assert.ok(error instanceof BackupRestoreError);
      assert.deepEqual(error.rollbackFailedKeys, [], "wycofanie musi się zmieścić");
      return true;
    });
    assert.equal(store.get("priorYearLossEntries"), "S".repeat(60), "duża stara wartość wraca");
    assert.equal(store.has("conditionalCostIds"), false, "wpis utworzony przez przywracanie usunięty");
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("przywrócenie kopii zachowuje rachunki dodane po jej utworzeniu razem z ich kluczami", async () => {
  const store = new Map<string, string>();
  const previous = (globalThis as typeof globalThis & { localStorage?: unknown }).localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
      key: (index: number) => [...store.keys()][index] ?? null,
      get length() {
        return store.size;
      },
    },
  });
  try {
    store.set("pit38_accounts", JSON.stringify([{ id: "xtb", name: "XTB", brokerType: "XTB", currency: "PLN", color: "#000" }]));
    const snapshot = await collectBackupSnapshot();
    // Po utworzeniu kopii użytkownik dodaje rachunek Binance z kluczami API.
    store.set("pit38_accounts", JSON.stringify([
      { id: "xtb", name: "XTB", brokerType: "XTB", currency: "PLN", color: "#000", apiKey: "KLUCZ-XTB-ATRAPA" },
      { id: "binance", name: "Binance", brokerType: "BINANCE", currency: "USD", color: "#222", apiKey: "KLUCZ-BINANCE-ATRAPA", apiSecret: "SEKRET-BINANCE-ATRAPA" },
    ]));
    await restoreBackupSnapshot(snapshot);
    const po = JSON.parse(store.get("pit38_accounts") ?? "[]") as Array<Record<string, unknown>>;
    assert.deepEqual(po.map((rachunek) => rachunek.id), ["xtb", "binance"], "rachunek z kopii, potem lokalny spoza kopii");
    assert.equal(po[0].apiKey, "KLUCZ-XTB-ATRAPA");
    assert.equal(po[1].apiKey, "KLUCZ-BINANCE-ATRAPA", "klucze rachunku dodanego po kopii nie są kasowane");
    assert.equal(po[1].apiSecret, "SEKRET-BINANCE-ATRAPA");
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(globalThis, "localStorage");
    } else {
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: previous });
    }
  }
});