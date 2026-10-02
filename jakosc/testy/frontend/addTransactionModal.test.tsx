/**
 * Formularz recznej transakcji nie moze podsuwac danych, ktore zapisza sie jako
 * dane podatnika, ani myląco opisywac pola dywidendy.
 */

import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AddTransactionModal } from "../../../aplikacje/web/src/portfel/components/AddTransactionModal.tsx";
import type { Transaction } from "../../../aplikacje/web/src/portfel/types.ts";

function render(editingTransaction: Transaction | null): string {
  return renderToStaticMarkup(
    <AddTransactionModal
      accounts={[]}
      language="pl"
      editingTransaction={editingTransaction}
      onSave={() => undefined}
      onClose={() => undefined}
    />,
  );
}

test("nowa transakcja nie ma przykladowej ilosci, ceny, prowizji ani nazwy NVIDIA", () => {
  const markup = render(null);
  for (const przyklad of ['value="10"', 'value="135.00"', 'value="1.50"', 'value="15"', 'value="NVIDIA Corporation"']) {
    assert.ok(!markup.includes(przyklad), `formularz podsuwa ${przyklad}`);
  }
});

test("dywidenda: pole kwoty opisuje kwote na jedna akcje, podglad pokazuje sume", () => {
  const markup = render({
    id: "tx_1",
    accountId: "",
    ticker: "AAPL",
    name: "Apple",
    category: "STOCK_FOREIGN",
    type: "DIVIDEND",
    date: "2026-05-15",
    quantity: 50,
    pricePerUnit: 0.25,
    currency: "USD",
    commission: 0,
    commissionCurrency: "USD",
  } as Transaction);
  assert.match(markup, /Dywidenda brutto na 1 akcję/);
  assert.match(markup, /Dywidenda brutto razem:/);
  assert.match(markup, /12,50 USD/);
  assert.ok(!markup.includes("Kwota Dywidendy"));
});
