import type { BrokerAccount, BrokerSyncResult } from '../types';

/** Kody odpowiedzi oznaczajace, ze rachunek w ogole nie ma API do odpytania (to nie blad). */
export const KODY_BEZ_PUBLICZNEGO_API: readonly string[] = ['BRAK_PUBLICZNEGO_API', 'IMPORT_NIEDOSTEPNY'];

export function bezPublicznegoApi(kod: string | undefined, dodatkoweKody: readonly string[] = []): boolean {
  return kod !== undefined && (KODY_BEZ_PUBLICZNEGO_API.includes(kod) || dodatkoweKody.includes(kod));
}

export type WynikSynchronizacjiRachunku = 'SUKCES' | 'BEZ_API' | 'BLAD';

export function rodzajWynikuSynchronizacji(
  wynik: Pick<BrokerSyncResult, 'success' | 'errorCode'>,
  dodatkoweKody: readonly string[] = [],
): WynikSynchronizacjiRachunku {
  if (wynik.success) return 'SUKCES';
  return bezPublicznegoApi(wynik.errorCode, dodatkoweKody) ? 'BEZ_API' : 'BLAD';
}

/**
 * Wynik rachunku po nieudanym pobraniu kompletu Freedom24. Transakcje z API mogly sie udac,
 * ale magazyn silnika nie zostal odswiezony, wiec zbiorcza synchronizacja nie moze wyjsc zielona.
 */
export function rodzajPoBleduKompletu(rodzaj: WynikSynchronizacjiRachunku): WynikSynchronizacjiRachunku {
  return rodzaj === 'SUKCES' ? 'BLAD' : rodzaj;
}

/**
 * Pola rachunku po probie synchronizacji - jedno miejsce dla synchronizacji jednego rachunku
 * i zbiorczej. Znacznik ostatniej synchronizacji (`lastSyncAt`) tylko przy sukcesie: po nieudanej
 * probie rachunek wygladal na regularnie odswiezany. Rachunek bez API dostaje IDLE, nie ERROR.
 */
export function polaRachunkuPoSynchronizacji(
  wynik: Pick<BrokerSyncResult, 'success' | 'errorCode' | 'error' | 'message' | 'diagnostics'>,
  poprzedni: Pick<BrokerAccount, 'lastSyncAt' | 'isApiConnected'>,
  teraz: string,
  dodatkoweKody: readonly string[] = [],
): Partial<BrokerAccount> {
  const rodzaj = rodzajWynikuSynchronizacji(wynik, dodatkoweKody);
  return {
    lastSyncAt: rodzaj === 'SUKCES' ? teraz : poprzedni.lastSyncAt,
    isApiConnected: rodzaj === 'SUKCES' ? true : poprzedni.isApiConnected,
    lastSyncStatus: rodzaj === 'SUKCES' ? 'SUCCESS' : rodzaj === 'BEZ_API' ? 'IDLE' : 'ERROR',
    lastError: rodzaj === 'BLAD' ? (wynik.error || wynik.message) : undefined,
    lastErrorCode: rodzaj === 'BEZ_API' ? undefined : wynik.errorCode,
    statusMessage: wynik.message,
    diagnostics: wynik.diagnostics,
  };
}

/**
 * Wynik synchronizacji po pobraniu kompletu danych (Freedom24). Blad kompletu to blad
 * synchronizacji: prowizje, oplaty i przeplywy pieniezne nie weszly do rozliczenia, wiec
 * rachunek nie moze dostac SUCCESS ani nowego `lastSyncAt` (jak w polaRachunkuPoSynchronizacji).
 */
export function wynikZKompletem<T extends Pick<BrokerSyncResult, 'success' | 'error' | 'message' | 'errorCode'>>(
  wynik: T,
  bladKompletu: string | null,
): T {
  if (!wynik.success || bladKompletu === null) return wynik;
  return {
    ...wynik,
    success: false,
    error: `Nie pobrano kompletu danych z Freedom24: ${bladKompletu}`,
    message: `Transakcje pobrano, ale komplet danych (prowizje, opłaty, przepływy) nie: ${bladKompletu}`,
    errorCode: 'KOMPLET_NIEPELNY',
  };
}

/**
 * Stan bledu na karcie rachunku. Wynik "Testuj API" nie zaslania bledu synchronizacji:
 * udany test polaczenia nie znaczy, ze synchronizacja sie udala. Komunikat testu jest
 * pokazywany tylko wtedy, gdy to test sie nie powiodl.
 */
export function stanBleduKarty(
  rachunek: Pick<BrokerAccount, 'lastSyncStatus' | 'lastError' | 'lastErrorCode' | 'statusMessage' | 'diagnostics'>,
  test: { success: boolean; error?: string; message?: string; errorCode?: string; diagnostics?: BrokerAccount['diagnostics'] } | undefined,
  brakApi: boolean,
): { maBlad: boolean; komunikat: string | undefined; kod: string | undefined; diagnostyka: BrokerAccount['diagnostics'] } {
  const bladTestu = test !== undefined && !test.success;
  const bladSynchronizacji = rachunek.lastSyncStatus === 'ERROR' || Boolean(rachunek.lastError);
  return {
    maBlad: !brakApi && (bladTestu || bladSynchronizacji),
    komunikat: (bladTestu ? test?.error || test?.message : undefined) || rachunek.lastError || rachunek.statusMessage,
    kod: (bladTestu ? test?.errorCode : undefined) || rachunek.lastErrorCode,
    diagnostyka: (bladTestu ? test?.diagnostics : undefined) || rachunek.diagnostics,
  };
}
