import assert from 'node:assert/strict';
import { test } from 'node:test';

import { przygotujZadanieSilnika } from '../../../aplikacje/web/src/invest_analyzer/services/taxEngineRequestFactory';
import { buildTaxEngineRequest, createMemoryStorageSource } from '../../../aplikacje/web/src/invest_analyzer/services/taxEngineConfig';
import { StorageService } from '../../../aplikacje/web/src/invest_analyzer/services/storage';
import { runtimeApi } from '../../../aplikacje/web/src/invest_analyzer/services/runtimeApi';

const GPU_OK = { serverRunning: true, gpuConfirmed: true, computeBackend: 'gpu', numGpu: 1 };

async function zUstawieniami(
  ustawienia: Record<string, string>,
  ollama: () => Promise<unknown>,
) {
  const zapis = new Map<string, string>(Object.entries(ustawienia));
  const previousStorage = globalThis.localStorage;
  const previousOverrides = StorageService.getTransactionOverrides;
  const previousOllama = runtimeApi.testOllamaGpu;
  globalThis.localStorage = {
    getItem: (key: string) => zapis.get(key) ?? null,
    setItem: (key: string, value: string) => { zapis.set(key, value); },
  } as Storage;
  StorageService.getTransactionOverrides = async () => [];
  runtimeApi.testOllamaGpu = ollama as typeof runtimeApi.testOllamaGpu;
  try {
    return await przygotujZadanieSilnika(2026, { transakcjePortfela: [] });
  } finally {
    globalThis.localStorage = previousStorage;
    StorageService.getTransactionOverrides = previousOverrides;
    runtimeApi.testOllamaGpu = previousOllama;
  }
}

test('oplata z kwota i bez daty zostaje w zadaniu, a przebieg jest blokowany komunikatem', async () => {
  const zrodlo = createMemoryStorageSource({
    fundingFeeEntries: JSON.stringify([
      { id: 'a', amount: '12,50', currency: 'PLN', date: '' },
      { id: 'b', amount: '', currency: 'PLN', date: '' },
      { id: 'c', amount: '5', currency: 'PLN', date: '2026-01-02' },
    ]),
  });
  const request = buildTaxEngineRequest(2026, zrodlo);
  // Wiersz calkiem pusty odpada; wpis z kwota, ale bez daty nie znika po cichu.
  assert.deepEqual(request.fundingFees?.map((wpis) => wpis.id), ['a', 'c']);

  await assert.rejects(
    zUstawieniami(
      { fundingFeeEntries: JSON.stringify([{ id: 'a', amount: '12,50', currency: 'PLN', date: '' }]) },
      async () => { throw new Error('bez AI'); },
    ),
    /Opłata 12,50 PLN nie ma daty — uzupełnij w ustawieniach kosztów/,
  );
});

test('kompletne oplaty nie blokuja przebiegu', async () => {
  const przygotowane = await zUstawieniami(
    { fundingFeeEntries: JSON.stringify([{ id: 'c', amount: '5', currency: 'PLN', date: '2026-01-02' }]) },
    async () => { throw new Error('bez AI'); },
  );
  assert.equal(przygotowane.request.fundingFees?.length, 1);
});

test('normalizator AI wymaga zgody uzytkownika ORAZ potwierdzonego GPU', async () => {
  const wylaczony = await zUstawieniami({ aiNormalizerEnabled: 'false' }, async () => GPU_OK);
  assert.equal(wylaczony.request.aiNormalizerEnabled, false);
  assert.equal(wylaczony.zatrzymajOllamePoPrzebiegu, false);

  const brakUstawienia = await zUstawieniami({}, async () => GPU_OK);
  assert.equal(brakUstawienia.request.aiNormalizerEnabled, false);

  const wlaczony = await zUstawieniami({ aiNormalizerEnabled: 'true' }, async () => GPU_OK);
  assert.equal(wlaczony.request.aiNormalizerEnabled, true);
  assert.equal(wlaczony.request.aiNormalizerGpuConfirmed, true);

  const bezGpu = await zUstawieniami({ aiNormalizerEnabled: 'true' }, async () => ({ ...GPU_OK, gpuConfirmed: false, computeBackend: 'cpu' }));
  assert.equal(bezGpu.request.aiNormalizerEnabled, false);
});

test('opłata bez daty nie blokuje przebiegu, gdy opłaty finansowania są wyłączone albo kwota to zero', async () => {
  const bezDaty = (kwota: string) => JSON.stringify([{ id: 'a', amount: kwota, currency: 'PLN', date: '' }]);
  const bezAi = async () => { throw new Error('bez AI'); };

  const wylaczone = await zUstawieniami({ fundingFeeEntries: bezDaty('12,50'), includeBankFundingFees: 'false' }, bezAi);
  assert.equal(wylaczone.request.includeBankFundingFees, false);

  for (const zero of ['0', '0,00', '0.00']) {
    await zUstawieniami({ fundingFeeEntries: bezDaty(zero) }, bezAi);
  }
  await assert.rejects(zUstawieniami({ fundingFeeEntries: bezDaty('0,01') }, bezAi), /nie ma daty/);
});
