/**
 * Jedno miejsce, w którym powstaje żądanie do silnika.
 *
 * Warsztat i portfel składały żądanie osobno - z innych ustawień i bez
 * wzajemnej wiedzy o ręcznych wpisach - więc ten sam rok potrafił dać dwie
 * różne kwoty na dwóch zakładkach. Obie połowy wołają teraz tę funkcję.
 */

import { bladyOplatFinansowania, buildTaxEngineRequest, getBrowserTaxSettingsStorage, type TaxEngineRequest, type TaxPackageRequestOptions } from './taxEngineConfig';
import { StorageService } from './storage';
import type { NadpisanieTransakcji } from './transactionOverrides';
import { readDefenseEvidenceOverrides } from './defenseEvidenceOverrides';
import { readBrokerFileActionOverrides } from './brokerFileActionOverrides';
import { runtimeApi } from './runtimeApi';
import { readReviewDecisions } from './reviewDecisions';
import {
  odczytajTransakcjePortfelaZMagazynu,
  PRZEDROSTEK_REKORDU_PORTFELA,
  transakcjeJakoNadpisania,
} from '../../portfel/services/reczneTransakcje';
import type { Transaction } from '../../portfel/types';
import type { BrokerAccount } from '../../portfel/types';
import { odczytajUstawienia } from '../../portfel/services/optymalizacjaPodatkowa';
import { kwotaTekstowaZWpisu, rachunekBezPit8c, wystawiaPit8c } from '../../portfel/services/pit8c';

export interface TaxEngineRequestWithPit8c extends TaxEngineRequest {
  /** Kwoty z otrzymanych informacji PIT-8C dla rozliczanego roku, w PLN. */
  pit8cEntries?: Array<{ revenuePln: string; costsPln: string }>;
}

export interface PrzygotowaneZadanieSilnika {
  request: TaxEngineRequestWithPit8c;
  /** Czy po przebiegu trzeba zatrzymać Ollamę uruchomioną na potrzeby AI. */
  zatrzymajOllamePoPrzebiegu: boolean;
  /** Odcisk żądania: te same dane i ustawienia dają ten sam klucz. */
  klucz: string;
}

/** Ręczne rekordy z edytora historii plus ręczne wpisy portfela, bez powtórzeń. */
export function polaczNadpisania(
  zWarsztatu: readonly NadpisanieTransakcji[],
  zPortfela: readonly NadpisanieTransakcji[],
): NadpisanieTransakcji[] {
  const zajete = new Set(zWarsztatu.map((wpis) => wpis.manualRecordId));
  return [...zWarsztatu, ...zPortfela.filter((wpis) => !zajete.has(wpis.manualRecordId))];
}

export function kluczZadaniaSilnika(request: TaxEngineRequest): string {
  return JSON.stringify(request);
}

export async function przygotujZadanieSilnika(
  rok: number,
  opcje: {
    packageRequest?: string | TaxPackageRequestOptions;
    /** Wpisy portfela z pamięci komponentu; bez nich czytamy magazyn przeglądarki. */
    transakcjePortfela?: readonly Transaction[];
  } = {},
): Promise<PrzygotowaneZadanieSilnika> {
  const zWarsztatu: NadpisanieTransakcji[] = await StorageService.getTransactionOverrides();
  const transakcjePortfela = opcje.transakcjePortfela ?? odczytajTransakcjePortfelaZMagazynu();
  let rachunki: BrokerAccount[] = [];
  try {
    const zapis = localStorage.getItem('pit38_accounts');
    const odczyt: unknown = zapis ? JSON.parse(zapis) : [];
    if (Array.isArray(odczyt)) rachunki = odczyt as BrokerAccount[];
  } catch { /* Brak zapisanych rachunków. */ }
  const kontoWgId = new Map(rachunki.map((konto) => [konto.id, konto]));
  const transakcjaWgId = new Map(transakcjePortfela.map((tx) => [tx.id, tx]));
  const zPortfela = transakcjeJakoNadpisania(transakcjePortfela).map((wpis) => {
    const tx = transakcjaWgId.get(wpis.manualRecordId.slice(PRZEDROSTEK_REKORDU_PORTFELA.length));
    const konto = tx ? kontoWgId.get(tx.accountId) : undefined;
    const pit8c = konto?.brokerType && wystawiaPit8c(konto.brokerType) ? 'true'
      : konto?.brokerType && rachunekBezPit8c(konto.brokerType) ? 'false' : undefined;
    return pit8c ? { ...wpis, values: { ...wpis.values, wystawia_pit8c: pit8c } } : wpis;
  });
  const ustawienia = getBrowserTaxSettingsStorage();
  const request: TaxEngineRequestWithPit8c = buildTaxEngineRequest(
    rok,
    ustawienia,
    opcje.packageRequest,
    polaczNadpisania(zWarsztatu, zPortfela),
    readDefenseEvidenceOverrides(ustawienia),
    readBrokerFileActionOverrides(ustawienia),
  );
  // Oplata bez daty nie moze zniknac z rozliczenia po cichu - przebieg konczy sie jasnym komunikatem.
  const bledyOplat = bladyOplatFinansowania(request.fundingFees, request.includeBankFundingFees);
  if (bledyOplat.length > 0) throw new Error(bledyOplat.join(' '));
  const informacjePit8c = odczytajUstawienia().informacjePit8c
    .filter((wpis) => Number(wpis.taxYear) === rok)
    .map((wpis) => ({ revenuePln: kwotaTekstowaZWpisu(wpis.revenuePln), costsPln: kwotaTekstowaZWpisu(wpis.costsPln) }));
  if (informacjePit8c.length > 0) {
    request.pit8cEntries = informacjePit8c;
  }
  if ((informacjePit8c.length > 0 || zPortfela.some((wpis) => wpis.values.wystawia_pit8c === 'true'))
    && !request.packageScope) {
    request.packageScope = 'draft';
    request.filingMode = 'ORIGINAL';
  }
  // Bez znacznika czasu: to samo wejscie ma dawac ten sam odcisk zadania.
  const decyzje = readReviewDecisions(ustawienia).map(({ decisionKey, decision }) => ({ decisionKey, decision }));
  if (decyzje.length > 0) request.reviewDecisions = decyzje;
  request.aiNormalizerGpuRequired = true;
  request.aiNormalizerGpuConfirmed = false;
  request.aiNormalizerComputeBackend = 'unknown';
  request.allowCpuAi = false;

  let zatrzymajOllamePoPrzebiegu = false;
  // Przelacznik uzytkownika (ustawienia) jest warunkiem koniecznym; GPU tylko warunkiem dodatkowym.
  // Przy wylaczonym przelaczniku nie sprawdzamy nawet Ollamy.
  const uzytkownikWlaczylAi = request.aiNormalizerEnabled === true;
  const ollamaStatus = uzytkownikWlaczylAi ? await runtimeApi.testOllamaGpu().catch(() => null) : null;
  if (uzytkownikWlaczylAi && ollamaStatus?.serverRunning && ollamaStatus.gpuConfirmed && ollamaStatus.computeBackend === 'gpu') {
    request.aiNormalizerEnabled = true;
    request.aiNormalizerGpuMode = 'gpu';
    request.aiNormalizerNumGpu = typeof ollamaStatus.numGpu === 'number' ? ollamaStatus.numGpu : -1;
    request.aiNormalizerGpuBackend = ollamaStatus.gpuBackend || request.aiNormalizerGpuBackend || 'vulkan';
    request.aiNormalizerGpuLoadLimitPercent =
      typeof ollamaStatus.gpuLoadLimitPercent === 'number' ? ollamaStatus.gpuLoadLimitPercent : 85;
    request.aiNormalizerNumBatch = typeof ollamaStatus.numBatch === 'number' ? ollamaStatus.numBatch : 128;
    request.aiNormalizerMaxParallel = typeof ollamaStatus.maxParallel === 'number' ? ollamaStatus.maxParallel : 1;
    request.aiNormalizerGpuConfirmed = true;
    request.aiNormalizerComputeBackend = 'gpu';
    zatrzymajOllamePoPrzebiegu = true;
  } else {
    request.aiNormalizerEnabled = false;
    request.aiNormalizerGpuConfirmed = false;
    request.aiNormalizerComputeBackend = ollamaStatus?.computeBackend || 'unknown';
  }

  return { request, zatrzymajOllamePoPrzebiegu, klucz: kluczZadaniaSilnika(request) };
}
