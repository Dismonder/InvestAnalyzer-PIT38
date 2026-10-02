import type { TaxEngineRequest } from './taxEngineConfig';
import type { OllamaRuntimeStatus } from './runtimeApi.types';

/**
 * Normalizator AI w zadaniu rozpoznawania magazynu.
 *
 * Ta sama regula co w fabryce zadan silnika: wlaczony jest tylko wtedy, gdy uzytkownik
 * go wlaczyl w ustawieniach (`request.aiNormalizerEnabled` z buildTaxEngineRequest)
 * ORAZ potwierdzono GPU. Samo GPU nie wystarcza. Przy wylaczonym przelaczniku
 * (albo jawnym `useAi: false`) Ollama nie jest nawet sprawdzana.
 */
export async function zastosujNormalizatorAi(
  request: TaxEngineRequest,
  testujGpu: () => Promise<OllamaRuntimeStatus | null>,
  useAi?: boolean,
): Promise<void> {
  if (useAi === false || request.aiNormalizerEnabled !== true) {
    request.aiNormalizerEnabled = false;
    return;
  }
  const gpuStatus = await testujGpu().catch(() => null);
  if (gpuStatus?.serverRunning && gpuStatus.gpuConfirmed && gpuStatus.computeBackend === 'gpu') {
    request.aiNormalizerEnabled = true;
    request.aiNormalizerGpuMode = 'gpu';
    request.aiNormalizerNumGpu = typeof gpuStatus.numGpu === 'number' ? gpuStatus.numGpu : -1;
    request.aiNormalizerGpuBackend = gpuStatus.gpuBackend || 'vulkan';
    request.aiNormalizerGpuLoadLimitPercent = typeof gpuStatus.gpuLoadLimitPercent === 'number' ? gpuStatus.gpuLoadLimitPercent : 85;
    request.aiNormalizerNumBatch = typeof gpuStatus.numBatch === 'number' ? gpuStatus.numBatch : 128;
    request.aiNormalizerMaxParallel = typeof gpuStatus.maxParallel === 'number' ? gpuStatus.maxParallel : 1;
    request.aiNormalizerGpuConfirmed = true;
    request.aiNormalizerComputeBackend = 'gpu';
  } else {
    request.aiNormalizerEnabled = false;
    request.aiNormalizerGpuConfirmed = false;
    request.aiNormalizerComputeBackend = gpuStatus?.computeBackend || 'unknown';
  }
}
