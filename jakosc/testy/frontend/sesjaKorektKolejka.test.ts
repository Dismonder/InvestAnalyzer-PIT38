/**
 * Zapis szkicu edytora czytal sesje korekt, a gdy w tym czasie uzytkownik zapisal
 * korekte, odkladal stara sesje - korekta znikala z magazynu (audyt A43).
 */

import test from "node:test";
import assert from "node:assert/strict";
import localforage from "localforage";

import { StorageService } from "../../../aplikacje/web/src/invest_analyzer/services/storage.ts";
import { createEmptyOverrideSession } from "../../../aplikacje/web/src/invest_analyzer/services/overrideHistory.ts";
import type { NadpisanieTransakcji } from "../../../aplikacje/web/src/invest_analyzer/services/transactionOverrides.ts";

test("zapis szkicu w trakcie zapisu korekty nie usuwa korekty", async () => {
  const originalGet = localforage.getItem;
  const originalSet = localforage.setItem;
  const magazyn = new Map<string, unknown>();
  let pierwszyOdczyt = true;
  localforage.getItem = (async (key: string) => {
    const wartosc = magazyn.get(key) ?? null;
    if (pierwszyOdczyt && key === "transactionOverrideSession") {
      // Odczyt szkicu trwa dluzej niz zapis korekty zleconej zaraz po nim.
      pierwszyOdczyt = false;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    return wartosc;
  }) as typeof localforage.getItem;
  localforage.setItem = (async (key: string, value: unknown) => {
    magazyn.set(key, structuredClone(value));
    return value;
  }) as typeof localforage.setItem;
  try {
    magazyn.set("transactionOverrideSession", createEmptyOverrideSession([]));
    const korekta = { manualRecordId: "rekord-1" } as unknown as NadpisanieTransakcji;
    const sesjaZKorekta = { ...createEmptyOverrideSession([]), transactionOverrides: [korekta] };

    const zapisSzkicu = StorageService.saveTransactionEditorDraft(null);
    const zapisKorekty = StorageService.saveTransactionOverrideSession(sesjaZKorekta);
    await Promise.all([zapisSzkicu, zapisKorekty]);

    const zapisana = await StorageService.getTransactionOverrideSession();
    assert.deepEqual(zapisana.transactionOverrides.map((entry) => entry.manualRecordId), ["rekord-1"]);
  } finally {
    localforage.getItem = originalGet;
    localforage.setItem = originalSet;
  }
});

test("dwie korekty zapisane naraz obie zostaja w magazynie", async () => {
  const originalGet = localforage.getItem;
  const originalSet = localforage.setItem;
  const magazyn = new Map<string, unknown>([["transactionOverrideSession", createEmptyOverrideSession([])]]);
  localforage.getItem = (async (key: string) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return magazyn.get(key) ?? null;
  }) as typeof localforage.getItem;
  localforage.setItem = (async (key: string, value: unknown) => {
    magazyn.set(key, structuredClone(value));
    return value;
  }) as typeof localforage.setItem;
  try {
    await Promise.all([
      StorageService.upsertTransactionOverride({ manualRecordId: "a" } as unknown as NadpisanieTransakcji),
      StorageService.upsertTransactionOverride({ manualRecordId: "b" } as unknown as NadpisanieTransakcji),
    ]);
    const zapisane = await StorageService.getTransactionOverrides();
    assert.deepEqual(zapisane.map((entry) => entry.manualRecordId).sort(), ["a", "b"]);
  } finally {
    localforage.getItem = originalGet;
    localforage.setItem = originalSet;
  }
});
