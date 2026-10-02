import test from "node:test";
import assert from "node:assert/strict";

import { selectRawTransactionsForFallback, isManualLocalTransaction } from "../../../aplikacje/web/src/invest_analyzer/services/transactionHistory.ts";

test("isManualLocalTransaction recognizes explicit manual rows", () => {
  assert.equal(isManualLocalTransaction({
    id: "manual-1",
    date: "2025-01-21T12:00:00.000Z",
    type: "deposit",
    amount: 100,
    currency: "USD",
    ticker: "MANUAL",
    fileId: "MANUAL_LOCAL",
  }), true);
});

test("selectRawTransactionsForFallback keeps only manual rows when silnik history exists", () => {
  const rows = selectRawTransactionsForFallback(
    [
      {
        id: "manual-1",
        date: "2025-01-21T12:00:00.000Z",
        type: "deposit",
        amount: 100,
        currency: "USD",
        ticker: "MANUAL",
        fileId: "MANUAL_LOCAL",
      },
      {
        id: "imported-1",
        date: "2025-01-22T12:00:00.000Z",
        type: "buy",
        amount: -200,
        currency: "USD",
        ticker: "NBIS.US",
        fileId: "API_JSON_FULL",
      },
    ],
    [
      {
        row_id: "TRADE-1",
        parent_row_id: null,
        row_kind: "TRADE",
        transaction_id: "1",
        ticker: "NBIS.US",
      },
    ],
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "manual-1");
});

