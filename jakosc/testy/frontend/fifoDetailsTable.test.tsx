import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { FifoDetailsTable } from "../../../aplikacje/web/src/portfel/components/FifoDetailsTable.tsx";
import type { TaxRealizedGain } from "../../../aplikacje/web/src/portfel/types.ts";

function sprzedaz(i: number, rok: number): TaxRealizedGain {
  return {
    id: `g${rok}_${i}`,
    sellTransactionId: `s${i}`,
    ticker: i % 2 ? "AAPL" : "NVDA",
    name: "Spolka",
    category: "STOCK_FOREIGN",
    accountId: "acc",
    sellDate: `${rok}-03-01`,
    sellQuantity: 1,
    sellPricePerUnit: 10,
    sellCurrency: "USD",
    sellCommission: 0,
    sellCommissionPLN: 0,
    sellExchangeRate: 4,
    sellExchangeDate: `${rok}-02-28`,
    sellExchangeTable: "1/A/NBP",
    revenuePLN: 40,
    costPLN: 30,
    profitPLN: 10,
    taxYear: rok,
    matchedBuyLots: [],
  };
}

test("rejestr FIFO renderuje sprzedaze porcjami, licznik obejmuje caly rok", () => {
  const gains = [
    ...Array.from({ length: 150 }, (_, i) => sprzedaz(i, 2026)),
    ...Array.from({ length: 5 }, (_, i) => sprzedaz(i, 2025)),
  ];
  const html = renderToStaticMarkup(
    <FifoDetailsTable realizedGains={gains} selectedYear={2026} accounts={[]} language="pl" />
  );
  assert.match(html, /150 transakcji zbycia/);
  const karty = html.match(/bg-slate-50\/50 dark:bg-slate-800\/30 overflow-hidden/g) ?? [];
  assert.equal(karty.length, 100);
  assert.match(html, /Pokaż kolejne sprzedaże \(100 z 150\)/);
  assert.match(html, /role="button"[^>]*aria-expanded="false"/);
});

test("przy malej liczbie sprzedazy nie ma przycisku kolejnej porcji", () => {
  const html = renderToStaticMarkup(
    <FifoDetailsTable realizedGains={[sprzedaz(1, 2026)]} selectedYear={2026} accounts={[]} language="pl" />
  );
  assert.match(html, /1 transakcja zbycia/);
  assert.doesNotMatch(html, /Pokaż kolejne sprzedaże/);
});
