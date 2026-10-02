import assert from 'node:assert/strict';
import { test } from 'node:test';

import { przygotujZadanieSilnika } from '../../../aplikacje/web/src/invest_analyzer/services/taxEngineRequestFactory';
import { StorageService } from '../../../aplikacje/web/src/invest_analyzer/services/storage';
import { runtimeApi } from '../../../aplikacje/web/src/invest_analyzer/services/runtimeApi';
import type { Transaction } from '../../../aplikacje/web/src/portfel/types';

test('wspólne żądanie przekazuje PIT-8C i znacznik rachunku polskiego', async () => {
  const zapis = new Map<string, string>();
  const previousStorage = globalThis.localStorage;
  const previousOverrides = StorageService.getTransactionOverrides;
  const previousOllama = runtimeApi.testOllamaGpu;
  globalThis.localStorage = {
    getItem: (key: string) => zapis.get(key) ?? null,
    setItem: (key: string, value: string) => { zapis.set(key, value); },
  } as Storage;
  StorageService.getTransactionOverrides = async () => [];
  runtimeApi.testOllamaGpu = async () => { throw new Error('syntetyczny test'); };
  try {
    zapis.set('pit38_accounts', JSON.stringify([
      { id: 'pl', brokerType: 'XTB' }, { id: 'foreign', brokerType: 'IBKR' }, { id: 'unknown', brokerType: 'CUSTOM' },
    ]));
    zapis.set('pit38_optymalizacja', JSON.stringify({ informacjePit8c: [
      { id: 'a', taxYear: 2026, revenuePln: '1 234,56', costsPln: '100,01' },
      { id: 'incomplete', taxYear: 2026, revenuePln: '1.234', costsPln: '' },
      { id: 'b', taxYear: 2025, revenuePln: '900', costsPln: '10' },
    ] }));
    const sell = (id: string, accountId: string): Transaction => ({
      id, accountId, ticker: 'ABC', name: 'ABC', category: 'STOCK_FOREIGN',
      type: 'SELL', date: '2026-02-01', quantity: 1, pricePerUnit: 100,
      currency: 'PLN', commission: 0, commissionCurrency: 'PLN',
    });
    const prepared = await przygotujZadanieSilnika(2026, {
      transakcjePortfela: [sell('pl-sale', 'pl'), sell('foreign-sale', 'foreign'), sell('unknown-sale', 'unknown')],
    });
    const request = prepared.request as typeof prepared.request & {
      pit8cEntries?: Array<{ revenuePln: string; costsPln: string }>;
    };
    assert.deepEqual(request.pit8cEntries, [
      { revenuePln: '1234.56', costsPln: '100.01' },
      { revenuePln: '1.234', costsPln: '' },
    ]);
    assert.equal(request.packageScope, 'draft');
    assert.equal(request.transactionOverrides?.find((row) => row.manualRecordId === 'portfel-pl-sale')?.values.wystawia_pit8c, 'true');
    assert.equal(request.transactionOverrides?.find((row) => row.manualRecordId === 'portfel-foreign-sale')?.values.wystawia_pit8c, 'false');
    assert.equal(request.transactionOverrides?.find((row) => row.manualRecordId === 'portfel-unknown-sale')?.values.wystawia_pit8c, undefined);

    zapis.delete('pit38_optymalizacja');
    const baseline = await przygotujZadanieSilnika(2026, {
      transakcjePortfela: [sell('foreign-sale', 'foreign')],
    });
    assert.equal((baseline.request as typeof request).pit8cEntries, undefined);
    assert.equal(baseline.request.packageScope, undefined);
  } finally {
    globalThis.localStorage = previousStorage;
    StorageService.getTransactionOverrides = previousOverrides;
    runtimeApi.testOllamaGpu = previousOllama;
  }
});
