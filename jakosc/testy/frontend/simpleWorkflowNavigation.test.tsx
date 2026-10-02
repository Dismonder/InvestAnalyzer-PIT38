import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import InvestAnalyzerApp from "../../../aplikacje/web/src/invest_analyzer/App.tsx";
import { UI_COMPLEXITY_MODE_KEY } from "../../../aplikacje/web/src/invest_analyzer/services/uiPreferences.ts";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

function renderAppWithMode(mode: "simple" | "expert") {
  const previousLocalStorage = (globalThis as typeof globalThis & { localStorage?: unknown }).localStorage;
  const previousSessionStorage = (globalThis as typeof globalThis & { sessionStorage?: unknown }).sessionStorage;
  const localStorage = new MemoryStorage();
  const sessionStorage = new MemoryStorage();
  localStorage.setItem(UI_COMPLEXITY_MODE_KEY, mode);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: localStorage,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: sessionStorage,
  });
  try {
    return renderToStaticMarkup(<InvestAnalyzerApp />);
  } finally {
    if (previousLocalStorage === undefined) {
      Reflect.deleteProperty(globalThis, "localStorage");
    } else {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: previousLocalStorage,
      });
    }
    if (previousSessionStorage === undefined) {
      Reflect.deleteProperty(globalThis, "sessionStorage");
    } else {
      Object.defineProperty(globalThis, "sessionStorage", {
        configurable: true,
        value: previousSessionStorage,
      });
    }
  }
}

test("nawigacja simple pokazuje tylko raport i historię", () => {
  const markup = renderAppWithMode("simple");

  assert.equal(markup.includes("Raport roczny"), true);
  assert.equal(markup.includes("Historia transakcji"), true);
  assert.equal(markup.includes(">Pulpit<"), false);
  assert.equal(markup.includes(">Centrum pracy<"), false);
  assert.equal(markup.includes(">Import danych<"), false);
  assert.equal(markup.includes("Tryb prosty"), true);
  assert.equal(markup.includes("Tryb ekspert"), true);
});

test("nawigacja expert zachowuje pełne widoki", () => {
  const markup = renderAppWithMode("expert");

  assert.equal(markup.includes(">Pulpit<"), true);
  assert.equal(markup.includes(">Centrum pracy<"), true);
  assert.equal(markup.includes(">Import danych<"), true);
  assert.equal(markup.includes("Historia transakcji"), true);
  assert.equal(markup.includes("Raport roczny"), true);
});

