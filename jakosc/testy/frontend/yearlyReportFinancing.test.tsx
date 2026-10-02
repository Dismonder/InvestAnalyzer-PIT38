import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { YearlyReport } from "../../../aplikacje/web/src/invest_analyzer/components/YearlyReport.tsx";
import type { TaxEngineResponse } from "../../../aplikacje/web/src/invest_analyzer/hooks/useTaxEngineRun.ts";

function renderYearlyReport(engineResult: TaxEngineResponse) {
  const previousLocalStorage = (globalThis as typeof globalThis & { localStorage?: unknown }).localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      clear: () => undefined,
      getItem: () => null,
      key: () => null,
      removeItem: () => undefined,
      setItem: () => undefined,
      length: 0,
    },
  });

  try {
    return renderToStaticMarkup(
      <YearlyReport
        selectedYear={2025}
        engineLoading={false}
        packageLoading={false}
        engineResult={engineResult}
        runPythonEngine={async () => engineResult}
        reportOrganizationStatus={{ year: 2025, status: "draft", updatedAt: "2026-05-11T10:00:00.000Z" }}
        onReportOrganizationStatusChange={() => undefined}
        uiComplexityMode="expert"
      />,
    );
  } finally {
    if (previousLocalStorage === undefined) {
      Reflect.deleteProperty(globalThis, "localStorage");
    } else {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: previousLocalStorage,
      });
    }
  }
}

function engineResultWith(financingLedger: unknown): TaxEngineResponse {
  return {
    success: true,
    status: "SUCCESS",
    filing_ready: true,
    annual_summary: { tax_year: "2025", net_pln: "0" },
    financing_ledger: financingLedger,
  } as unknown as TaxEngineResponse;
}

const SETTLED_EPISODE = {
  episode_id: "financing:USD:2025-11-14",
  currency: "USD",
  opened_on: "2025-11-14",
  last_charged_on: "2025-12-01",
  settled_on: "2025-12-02",
  is_open: false,
  charged_days: 18,
  total_interest: "89.77",
  total_interest_pln: "328.70",
  daily_rate_used: "0.00041095",
  peak_principal: "11530.20",
  average_principal: "9840.55",
  principal_source: "broker_comment",
};

test("raport roczny pokazuje okres pozyczki od brokera z data uregulowania", () => {
  const markup = renderYearlyReport(
    engineResultWith({
      schema_version: "financing_ledger.v1",
      tax_year: 2025,
      episode_count: 1,
      charged_days: 18,
      open_episode_count: 0,
      total_interest_pln: "328.70",
      by_currency: {},
      episodes: [SETTLED_EPISODE],
    }),
  );

  assert.ok(markup.includes("Pieniądze pożyczone od brokera"));
  assert.ok(markup.includes("2025-11-14"));
  assert.ok(markup.includes("2025-12-02"), "data uregulowania musi byc widoczna");
  assert.ok(markup.includes("89.77 USD"));
  assert.ok(
    markup.includes("pochodzą wprost z opisu naliczeń brokera"),
    "uzytkownik musi wiedziec, czy kwota pozyczki jest odczytana czy oszacowana",
  );
  assert.ok(markup.includes("18"), "liczba dni z odsetkami musi byc widoczna");
});

test("okres siegajacy konca danych jest oznaczony jako nieuregulowany", () => {
  const markup = renderYearlyReport(
    engineResultWith({
      schema_version: "financing_ledger.v1",
      tax_year: 2026,
      episode_count: 1,
      charged_days: 2,
      open_episode_count: 1,
      total_interest_pln: null,
      by_currency: {},
      episodes: [
        {
          ...SETTLED_EPISODE,
          episode_id: "financing:USD:2026-05-10",
          opened_on: "2026-05-10",
          last_charged_on: "2026-05-11",
          settled_on: null,
          is_open: true,
          charged_days: 2,
          total_interest_pln: null,
        },
      ],
    }),
  );

  assert.ok(markup.includes("nieuregulowane"));
  assert.ok(
    markup.includes("Brak dalszych naliczeń nie dowodzi spłaty"),
    "uzytkownik musi wiedziec, ze brak naliczen to nie dowod splaty",
  );
});

test("brak pozyczek nie dokłada pustej sekcji do raportu", () => {
  const markup = renderYearlyReport(
    engineResultWith({
      schema_version: "financing_ledger.v1",
      tax_year: 2025,
      episode_count: 0,
      charged_days: 0,
      open_episode_count: 0,
      total_interest_pln: null,
      by_currency: {},
      episodes: [],
    }),
  );

  assert.ok(!markup.includes("Pieniądze pożyczone od brokera"));
});

test("raport dziala, gdy silnik nie zwrocil rejestru finansowania", () => {
  const markup = renderYearlyReport(engineResultWith(undefined));

  assert.ok(!markup.includes("Pieniądze pożyczone od brokera"));
  assert.ok(markup.length > 0);
});


test("raport renderuje wynik silnika bez lokalnej kopii transakcji w przeglądarce", () => {
  // Bramka sprawdzala wczesniej lokalna kopie transakcji, ktorej po przebudowie
  // architektury nic juz nie zapisuje. Raport nie pojawial sie nigdy, mimo
  // policzonego wyniku.
  const markup = renderYearlyReport(
    engineResultWith({
      schema_version: "financing_ledger.v1",
      tax_year: 2025,
      episode_count: 0,
      charged_days: 0,
      open_episode_count: 0,
      total_interest_pln: null,
      by_currency: {},
      episodes: [],
    }),
  );

  assert.ok(!markup.includes("Brak danych"), "raport nie moze zglaszac braku danych przy wyniku silnika");
  assert.ok(markup.length > 1000, "raport musi wyrenderowac tresc, a nie sam pusty ekran");
});

test("bez wyniku silnika raport pokazuje pusty ekran", () => {
  const markup = renderYearlyReport(null as unknown as TaxEngineResponse);

  assert.ok(markup.includes("Brak danych"));
});
