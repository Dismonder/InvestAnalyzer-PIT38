import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryStorageSource, ensureFundingFeeEntries, readPriorYearLossEntries, mergeAndSaveFundingFeeEntries, mergeAndSavePriorYearLossEntries, type FundingFeeEntry, type PriorYearLossEntry } from '../../../aplikacje/web/src/invest_analyzer/services/taxEngineConfig.ts';
import { mergeAndSaveReviewDecisions, readReviewDecisions, setReviewDecision } from '../../../aplikacje/web/src/invest_analyzer/services/reviewDecisions.ts';

test('dwie karty zachowują niezależne decyzje i cofają tylko własną', () => {
  const storage = createMemoryStorageSource();
  const baseA = readReviewDecisions(storage);
  const baseB = readReviewDecisions(storage);
  const a = mergeAndSaveReviewDecisions(storage, baseA, setReviewDecision(baseA, 'a', 'handled_manually'));
  mergeAndSaveReviewDecisions(storage, baseB, setReviewDecision(baseB, 'b', 'no_tax_effect'));
  assert.deepEqual(readReviewDecisions(storage).map((entry) => entry.decisionKey).sort(), ['a', 'b']);

  mergeAndSaveReviewDecisions(storage, a, setReviewDecision(a, 'a', null));
  assert.deepEqual(readReviewDecisions(storage).map((entry) => entry.decisionKey), ['b']);
});

test('dwie karty zachowują straty z różnych lat i usuwają tylko własny wpis', () => {
  const storage = createMemoryStorageSource();
  const baseA = readPriorYearLossEntries(storage);
  const baseB = readPriorYearLossEntries(storage);
  const lossA: PriorYearLossEntry = { id: 'a', taxYear: 2022, amountPln: '100' };
  const lossB: PriorYearLossEntry = { id: 'b', taxYear: 2023, amountPln: '200' };
  const a = mergeAndSavePriorYearLossEntries(storage, baseA, [lossA]);
  mergeAndSavePriorYearLossEntries(storage, baseB, [lossB]);
  assert.deepEqual(readPriorYearLossEntries(storage).map((entry) => entry.id).sort(), ['a', 'b']);

  mergeAndSavePriorYearLossEntries(storage, a, []);
  assert.deepEqual(readPriorYearLossEntries(storage).map((entry) => entry.id), ['b']);
});

test('dwie karty zachowują opłaty i usuwają tylko własny wpis', () => {
  const storage = createMemoryStorageSource();
  const baseA = ensureFundingFeeEntries(storage);
  const baseB = ensureFundingFeeEntries(storage);
  const feeA: FundingFeeEntry = { id: 'a', amount: '10', currency: 'PLN', date: '2025-01-01' };
  const feeB: FundingFeeEntry = { id: 'b', amount: '20', currency: 'PLN', date: '2025-02-01' };
  const a = mergeAndSaveFundingFeeEntries(storage, baseA, [feeA]);
  mergeAndSaveFundingFeeEntries(storage, baseB, [feeB]);
  assert.deepEqual(ensureFundingFeeEntries(storage).map((entry) => entry.id).sort(), ['a', 'b']);

  mergeAndSaveFundingFeeEntries(storage, a, []);
  assert.deepEqual(ensureFundingFeeEntries(storage).map((entry) => entry.id), ['b']);
});
