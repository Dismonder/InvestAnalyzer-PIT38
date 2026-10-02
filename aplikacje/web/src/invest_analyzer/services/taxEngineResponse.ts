import type { TaxEngineResponse } from '../hooks/useTaxEngineRun';

function httpSuffix(status?: number): string {
  return typeof status === 'number' ? ` (HTTP ${status})` : '';
}

export function parseTaxEngineResponseText(responseText: string, status?: number): TaxEngineResponse {
  const trimmed = responseText.trim();
  if (!trimmed) {
    return {
      success: false,
      error: `Serwer zwrócił pustą odpowiedź z endpointu silnika podatkowego${httpSuffix(status)}.`,
    };
  }
  try {
    return JSON.parse(trimmed) as TaxEngineResponse;
  } catch {
    return {
      success: false,
      error: `Serwer zwrócił odpowiedź inną niż JSON z endpointu silnika podatkowego${httpSuffix(status)}. Sprawdź, czy backend działa poprawnie.`,
    };
  }
}
