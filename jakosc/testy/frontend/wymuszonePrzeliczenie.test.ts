/**
 * "Przelicz ponownie" w portfelu.
 *
 * Portfel omijal tylko wynik trzymany w pamieci karty. Serwer ma wlasna pamiec
 * wynikow (klucz: magazyn + kod silnika + zadanie) i bez `forceRecalculate`
 * oddawal poprzedni wynik - np. brakujacy wczoraj kurs NBP nie byl pobierany
 * ponownie. Warsztat silnika wymusza przeliczenie tak samo.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { calculateTaxesWithEngine } from '../../../aplikacje/web/src/portfel/services/engineBridge';
import { StorageService } from '../../../aplikacje/web/src/invest_analyzer/services/storage';
import { runtimeApi } from '../../../aplikacje/web/src/invest_analyzer/services/runtimeApi';
import type { TaxEngineRequest } from '../../../aplikacje/web/src/invest_analyzer/services/taxEngineConfig';

async function zadanieWyslaneDoSilnika(rok: number, wymusPrzeliczenie: boolean): Promise<TaxEngineRequest | undefined> {
  const zapis = new Map<string, string>();
  const poprzedni = {
    magazyn: globalThis.localStorage,
    nadpisania: StorageService.getTransactionOverrides,
    ollama: runtimeApi.testOllamaGpu,
    start: runtimeApi.startTaxEngineJob,
    status: runtimeApi.getTaxEngineJobStatus,
    wynik: runtimeApi.getTaxEngineJobResult,
  };
  let wyslane: TaxEngineRequest | undefined;
  globalThis.localStorage = {
    getItem: (klucz: string) => zapis.get(klucz) ?? null,
    setItem: (klucz: string, wartosc: string) => { zapis.set(klucz, wartosc); },
    removeItem: (klucz: string) => { zapis.delete(klucz); },
  } as Storage;
  StorageService.getTransactionOverrides = async () => [];
  runtimeApi.testOllamaGpu = async () => { throw new Error('syntetyczny test'); };
  runtimeApi.startTaxEngineJob = async (request: TaxEngineRequest) => {
    wyslane = request;
    return { jobId: 'syntetyczny' };
  };
  runtimeApi.getTaxEngineJobStatus = async (jobId: string) => ({
    jobId, state: 'done', stage: 'done', progress: 100, message: '', startedAt: '', updatedAt: '',
  });
  runtimeApi.getTaxEngineJobResult = async () => ({ success: true, annual_summary: {} });
  try {
    await calculateTaxesWithEngine([], [], { year: rok, wymusPrzeliczenie });
  } catch {
    // Kształt wyniku nie jest tu przedmiotem testu - liczy się wysłane zadanie.
  } finally {
    globalThis.localStorage = poprzedni.magazyn;
    StorageService.getTransactionOverrides = poprzedni.nadpisania;
    runtimeApi.testOllamaGpu = poprzedni.ollama;
    runtimeApi.startTaxEngineJob = poprzedni.start;
    runtimeApi.getTaxEngineJobStatus = poprzedni.status;
    runtimeApi.getTaxEngineJobResult = poprzedni.wynik;
  }
  return wyslane;
}

test('zwykle przeliczenie portfela moze skorzystac z pamieci wynikow serwera', async () => {
  const zadanie = await zadanieWyslaneDoSilnika(2031, false);
  assert.ok(zadanie, 'zadanie trafilo do silnika');
  assert.equal(zadanie.forceRecalculate, undefined);
});

test('"Przelicz ponownie" w portfelu wymusza przeliczenie takze na serwerze', async () => {
  const zadanie = await zadanieWyslaneDoSilnika(2032, true);
  assert.ok(zadanie, 'zadanie trafilo do silnika');
  assert.equal(zadanie.forceRecalculate, true);
});
