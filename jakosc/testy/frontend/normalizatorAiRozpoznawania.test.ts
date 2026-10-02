import assert from 'node:assert/strict';
import { test } from 'node:test';

import { zastosujNormalizatorAi } from '../../../aplikacje/web/src/invest_analyzer/services/normalizatorAiZadania';
import { buildTaxEngineRequest, createMemoryStorageSource } from '../../../aplikacje/web/src/invest_analyzer/services/taxEngineConfig';

const GPU_OK = { serverRunning: true, gpuConfirmed: true, computeBackend: 'gpu', numGpu: 1 } as never;

test('rozpoznawanie magazynu: AI tylko gdy przelacznik uzytkownika i GPU', async () => {
  let wywolania = 0;
  const testGpu = async () => { wywolania += 1; return GPU_OK; };

  const wylaczony = buildTaxEngineRequest(2026, createMemoryStorageSource({ aiNormalizerEnabled: 'false' }));
  await zastosujNormalizatorAi(wylaczony, testGpu);
  assert.equal(wylaczony.aiNormalizerEnabled, false);
  assert.equal(wywolania, 0);

  const wlaczony = buildTaxEngineRequest(2026, createMemoryStorageSource({ aiNormalizerEnabled: 'true' }));
  await zastosujNormalizatorAi(wlaczony, testGpu);
  assert.equal(wlaczony.aiNormalizerEnabled, true);
  assert.equal(wlaczony.aiNormalizerGpuConfirmed, true);

  const bezGpu = buildTaxEngineRequest(2026, createMemoryStorageSource({ aiNormalizerEnabled: 'true' }));
  await zastosujNormalizatorAi(bezGpu, async () => ({ ...(GPU_OK as object), gpuConfirmed: false, computeBackend: 'cpu' }) as never);
  assert.equal(bezGpu.aiNormalizerEnabled, false);

  const jawnieWylaczony = buildTaxEngineRequest(2026, createMemoryStorageSource({ aiNormalizerEnabled: 'true' }));
  await zastosujNormalizatorAi(jawnieWylaczony, testGpu, false);
  assert.equal(jawnieWylaczony.aiNormalizerEnabled, false);
});
