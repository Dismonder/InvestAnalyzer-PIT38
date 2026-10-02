import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Transactions } from "../../../aplikacje/web/src/invest_analyzer/components/Transactions.tsx";

test("Transactions simple pokazuje, że historia bazuje na pełnym storage", () => {
  const markup = renderToStaticMarkup(
    <Transactions
      selectedYear={2026}
      canonicalStorageHistoryRows={[
        {
          row_id: "storage-row-1",
          row_kind: "TRADE",
          display_date: "2026-01-02",
          ticker: "AAPL",
          side: "BUY",
          amount: "100",
          currency: "USD",
          display_category: "investment",
          display_category_label_pl: "Inwestycyjne",
          tax_impact_kind: "PIT_COUNTED",
          tax_impact_label_pl: "Liczy PIT",
          details: {},
        } as never,
      ]}
      canonicalStorageHistorySummary={{
        rawRowCount: 1847,
        deduplicatedRowCount: 884,
        mergedRecordCount: 963,
      }}
      onRefreshEngine={() => undefined}
      onAddLog={() => undefined}
      uiComplexityMode="simple"
    />,
  );

  assert.equal(markup.includes("Historia bazuje na całym storage"), true);
  assert.equal(markup.includes("1847"), true);
  assert.equal(markup.includes("884"), true);
  assert.equal(markup.includes("963"), true);
});

