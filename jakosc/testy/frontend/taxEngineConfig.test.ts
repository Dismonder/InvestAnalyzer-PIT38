import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTaxEngineRequest,
  createMemoryStorageSource,
  getBrowserTaxSettingsStorage,
  migrateFundingFeeEntries,
  readConditionalCostIds,
  readExcludedStorageFiles,
  readManualFxOverrides,
  saveConditionalCostIds,
  saveExcludedStorageFiles,
  saveManualFxOverrides,
} from "../../../aplikacje/web/src/invest_analyzer/services/taxEngineConfig.ts";
import { parseTaxEngineResponseText } from "../../../aplikacje/web/src/invest_analyzer/hooks/useTaxEngineRun.ts";

test("migrateFundingFeeEntries migrates legacy singleton values into the first list entry", () => {
  const migrated = migrateFundingFeeEntries({
    fundingFeeAmount: "36.85",
    fundingFeeCurrency: "USD",
    fundingFeeDate: "2025-01-21",
    fundingFeeDepositId: "82160362",
    fundingFeeDepositAmount: "10527.68",
    fundingFeeEvidenceNote: "Domyślna alokacja: proportional_first_batch",
  });

  assert.equal(migrated.length, 1);
  assert.equal(migrated[0].amount, "36.85");
  assert.equal(migrated[0].depositId, "82160362");
});

test("buildTaxEngineRequest sends repeatable fundingFees instead of singular fundingFee", () => {
  const request = buildTaxEngineRequest(
    2025,
    {
      taxCalculationPlan: "aggressive_user",
      includeFxConversionCosts: "true",
      includeBankFundingFees: "true",
      includeInterestCosts: "true",
      includeAccountFees: "true",
      fundingFeeEntries: JSON.stringify([
        {
          id: "fee-1",
          amount: "36.85",
          currency: "USD",
          date: "2025-01-21",
          depositId: "82160362",
          depositAmount: "10527.68",
          evidenceNote: "note",
        },
      ]),
    },
    "full",
  );

  assert.ok(Array.isArray(request.fundingFees));
  assert.equal(request.fundingFees?.length, 1);
  assert.equal(request.fundingFee, undefined);
  assert.equal(request.fundingFees?.[0].id, "fee-1");
});

test("buildTaxEngineRequest includes transaction overrides from the separate override layer", () => {
  const request = buildTaxEngineRequest(
    2025,
    {
      taxCalculationPlan: "aggressive_user",
      includeFxConversionCosts: "true",
      includeBankFundingFees: "true",
      includeInterestCosts: "true",
      includeAccountFees: "true",
      fundingFeeEntries: "[]",
    },
    undefined,
    [
      {
        overrideId: "override-1",
        mode: "override",
        recordType: "TRADE",
        baseRecordId: "488585388",
        manualRecordId: "manual-override-1",
        deleted: false,
        values: {
          quantity: "12",
          commission: "2.50",
        },
        updatedAt: "2026-04-23T12:00:00.000Z",
        createdAt: "2026-04-23T12:00:00.000Z",
        comment: "Ręczna korekta użytkownika",
        sourceLabel: "Ręczna korekta użytkownika",
      },
    ],
  );

  assert.equal(request.transactionOverrides?.length, 1);
  assert.equal(request.transactionOverrides?.[0].baseRecordId, "488585388");
  assert.equal(request.transactionOverrides?.[0].values.quantity, "12");
});

test("buildTaxEngineRequest includes defense evidence overrides without mixing them with tax overrides", () => {
  const request = buildTaxEngineRequest(
    2025,
    {
      taxCalculationPlan: "aggressive_user",
      includeFxConversionCosts: "true",
      includeBankFundingFees: "true",
      includeInterestCosts: "true",
      includeAccountFees: "true",
      fundingFeeEntries: "[]",
    },
    { packageScope: "full", filingMode: "ORIGINAL" },
    [],
    [
      {
        evidenceId: "EVIDENCE-COST-3368752211",
        defenseStatus: "complete",
        linkedTradeIds: ["TRADE-1"],
        updatedAt: "2026-05-10T10:00:00.000Z",
        userNote: "Potwierdzenie odsetek salda ujemnego z raportu brokera.",
        evidenceConfirmed: true,
        checkedAt: "2026-05-10T10:05:00.000Z",
        includedInFilingPackage: true,
      },
    ],
  );

  assert.equal(request.defenseEvidenceOverrides?.length, 1);
  assert.equal(request.defenseEvidenceOverrides?.[0].evidenceId, "EVIDENCE-COST-3368752211");
  assert.equal(request.defenseEvidenceOverrides?.[0].evidenceConfirmed, true);
  assert.equal(request.transactionOverrides?.length, 0);
});

test("buildTaxEngineRequest includes broker file action overrides as audit-only workflow state", () => {
  const request = buildTaxEngineRequest(
    2025,
    {
      taxCalculationPlan: "aggressive_user",
      includeFxConversionCosts: "true",
      includeBankFundingFees: "true",
      includeInterestCosts: "true",
      includeAccountFees: "true",
      fundingFeeEntries: "[]",
    },
    { packageScope: "full", filingMode: "ORIGINAL" },
    [],
    [],
    [
      {
        actionId: "BFAQ-cost-fx-loss-1",
        status: "ignored",
        userNote: "Sprawdzone ręcznie przed złożeniem.",
        linkedRowId: "FX-LOSS-1",
        updatedAt: "2026-05-12T12:00:00.000Z",
      },
    ],
  );

  assert.equal(request.brokerFileActionOverrides?.length, 1);
  assert.equal(request.brokerFileActionOverrides?.[0].actionId, "BFAQ-cost-fx-loss-1");
  assert.equal(request.brokerFileActionOverrides?.[0].status, "ignored");
  assert.equal(request.defenseEvidenceOverrides?.length, 0);
});

test("buildTaxEngineRequest uses canonical stream without source promotion approval", () => {
  const request = buildTaxEngineRequest(
    2025,
    {
      taxCalculationPlan: "aggressive_user",
      includeFxConversionCosts: "true",
      includeBankFundingFees: "true",
      includeInterestCosts: "true",
      includeAccountFees: "true",
      fundingFeeEntries: "[]",
    },
  );

  assert.equal(request.sourceSelectionMode, "canonical_stream");
  assert.equal(request.selectedCandidateSourceId, undefined);
  assert.equal(request.canonicalTaxInputMode, "required");
});

test("buildTaxEngineRequest sends AI normalizer flag only as an audit/import option", () => {
  const disabledRequest = buildTaxEngineRequest(2025, createMemoryStorageSource({
    fundingFeeEntries: "[]",
  }));
  const enabledRequest = buildTaxEngineRequest(2025, createMemoryStorageSource({
    fundingFeeEntries: "[]",
    aiNormalizerEnabled: "true",
  }));

  assert.equal(disabledRequest.aiNormalizerEnabled, false);
  assert.equal(enabledRequest.aiNormalizerEnabled, true);
  assert.equal(enabledRequest.sourceSelectionMode, "canonical_stream");
});

test("buildTaxEngineRequest normalizes stale prefer mode to required canonical input", () => {
  const request = buildTaxEngineRequest(2025, createMemoryStorageSource({
    fundingFeeEntries: "[]",
    canonicalTaxInputMode: "prefer",
  }));

  assert.equal(request.canonicalTaxInputMode, "required");
});

test("buildTaxEngineRequest ignores legacy source-selection storage for canonical stream", () => {
  const storage = createMemoryStorageSource({
    taxCalculationPlan: "aggressive_user",
    includeFxConversionCosts: "true",
    includeBankFundingFees: "true",
    includeInterestCosts: "true",
    includeAccountFees: "true",
    fundingFeeEntries: "[]",
  });
  storage.setItem("sourcePromotionApprovals:v1", JSON.stringify([{ sourceId: "legacy", status: "approved" }]));

  const request = buildTaxEngineRequest(2025, storage);

  assert.equal(request.sourceSelectionMode, "canonical_stream");
  assert.equal(request.selectedCandidateSourceId, undefined);
});

test("tax engine config can build requests without browser localStorage", () => {
  const originalWindow = globalThis.window;

  try {
    Object.defineProperty(globalThis, "window", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    const storage = getBrowserTaxSettingsStorage();
    const request = buildTaxEngineRequest(2025, storage);

    assert.equal(request.year, 2025);
    assert.equal(request.taxPlan, "aggressive_user");
    assert.equal(request.includeFxConversionCosts, true);
  } finally {
    Object.defineProperty(globalThis, "window", {
      value: originalWindow,
      configurable: true,
      writable: true,
    });
  }
});

test("memory storage source persists migrated settings for one request flow", () => {
  const storage = createMemoryStorageSource({
    fundingFeeAmount: "177",
    fundingFeeCurrency: "PLN",
    fundingFeeDate: "2025-01-21",
  });

  const request = buildTaxEngineRequest(2025, storage);

  assert.equal(request.fundingFees?.[0].amount, "177");
  assert.equal(storage.getItem("fundingFeeEntries")?.includes('"177"'), true);
});

test("parseTaxEngineResponseText returns controlled Polish errors for empty and non-JSON responses", () => {
  assert.deepEqual(parseTaxEngineResponseText("", 502), {
    success: false,
    error: "Serwer zwrócił pustą odpowiedź z endpointu silnika podatkowego (HTTP 502).",
  });

  const htmlResult = parseTaxEngineResponseText("<!doctype html><html>fallback</html>", 200);
  assert.equal(htmlResult.success, false);
  assert.match(String(htmlResult.error), /odpowiedź inną niż JSON/i);
  assert.doesNotMatch(String(htmlResult.error), /Unexpected token/i);
});


test("wskazane ręcznie koszty trafiają do żądania silnika", () => {
  const source = createMemoryStorageSource();
  saveConditionalCostIds(source, ["COST-FX-1", " COST-FX-2 ", "", "COST-FX-1"]);

  assert.deepEqual(readConditionalCostIds(source), ["COST-FX-1", "COST-FX-2"]);
  assert.deepEqual(buildTaxEngineRequest(2025, source).conditionalCostIds, ["COST-FX-1", "COST-FX-2"]);
});

test("bez wskazań użytkownika lista kosztów warunkowych jest pusta", () => {
  const source = createMemoryStorageSource();

  assert.deepEqual(buildTaxEngineRequest(2025, source).conditionalCostIds, []);
});

test("ręczna korekta kursu włącza zgodę dopiero, gdy użytkownik ją poda", () => {
  const source = createMemoryStorageSource();
  assert.equal(buildTaxEngineRequest(2025, source).nbpAllowManualOverride, false);

  saveManualFxOverrides(source, { "USD:2026-05-11": "3.9812" });

  const request = buildTaxEngineRequest(2025, source);
  assert.deepEqual(request.manualFxOverrides, { "USD:2026-05-11": "3.9812" });
  assert.equal(request.nbpAllowManualOverride, true);
});

test("uszkodzony zapis korekt kursu nie wywraca żądania", () => {
  const source = createMemoryStorageSource();
  source.setItem("manualFxOverrides", "{to nie jest json");
  source.setItem("conditionalCostIds", "{to nie jest json");

  assert.deepEqual(readManualFxOverrides(source), {});
  assert.deepEqual(readConditionalCostIds(source), []);
});

test("wyłączony plik trafia do zadania silnika, a nie tylko do wyglądu listy", () => {
  // Przełącznik przy pliku zapisywał wyłącznie stan Reacta i wymuszał pełne
  // przeliczenie tym samym zestawem plików - kwota podatku nie mogła się zmienić.
  const storage = createMemoryStorageSource();
  saveExcludedStorageFiles(storage, ["raport.json", "Dane/historia.json"]);

  const request = buildTaxEngineRequest(2025, storage);

  assert.deepEqual(request.excludedStorageFiles, ["raport.json", "Dane/historia.json"]);
});

test("brak wyłączeń daje puste zadanie, a nie pominięte pole", () => {
  const request = buildTaxEngineRequest(2025, createMemoryStorageSource());

  assert.deepEqual(request.excludedStorageFiles, []);
});

test("lista wyłączonych plików przeżywa zapis i odczyt bez duplikatów", () => {
  // Wyłączenie musi przetrwać odświeżenie strony - poprzednio "usuń plik"
  // znikał z widoku i wracał przy najbliższym wczytaniu danych.
  const storage = createMemoryStorageSource();

  saveExcludedStorageFiles(storage, ["raport.json", " raport.json ", "", "inny.xlsx"]);

  assert.deepEqual(readExcludedStorageFiles(storage), ["raport.json", "inny.xlsx"]);
});

test("uszkodzony wpis w pamięci nie wywraca odczytu wyłączeń", () => {
  const storage = createMemoryStorageSource();
  storage.setItem("excludedStorageFiles", "{to nie jest lista");

  assert.deepEqual(readExcludedStorageFiles(storage), []);
});

test("opłata finansowania bez waluty nie staje się złotówką", () => {
  const storage = createMemoryStorageSource({
    fundingFeeEntries: JSON.stringify([{ id: "f1", amount: "40", currency: "", date: "2026-04-03" }]),
  });
  const request = buildTaxEngineRequest(2026, storage);
  // Pusta waluta dociera do silnika jako brak - silnik zatrzyma przebieg z komunikatem,
  // zamiast odliczyć opłatę w dolarach jak złotówki.
  assert.equal(request.fundingFees?.[0]?.currency, "");
});
