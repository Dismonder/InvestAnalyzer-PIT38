/**
 * Pobranie kompletu danych podatkowych z Freedom24 i przekazanie ich silnikowi.
 *
 * Dotad dane z Tradernet trafialy wylacznie do widzetow interfejsu: historia
 * transakcji szla do listy w przegladarce, a przeplywy pieniezne - prowizje,
 * oplaty, odsetki, przewalutowania, dywidendy i podatek u zrodla - ogladalo sie
 * i tyle. Silnik podatkowy ich nie widzial, wiec nie mogly pomniejszyc dochodu.
 *
 * Tutaj odpowiedz API ladujemy do magazynu silnika BEZ konwersji. Normalizator
 * silnika rozpoznaje natywne nazwy pol Tradernet (instr_nm, q, p, v, summ,
 * curr_c, trade_d_exch), wiec kazde mapowanie po drodze tylko gubiloby dane.
 */

import { runtimeApi } from '../../invest_analyzer/services/runtimeApi';
import { apiFetch } from './apiTransport';
import type { BrokerAccount } from '../types';

/** Stala nazwa pliku: kolejne pobranie nadpisuje poprzednie, zamiast mnozyc zrodla. */
export const NAZWA_PLIKU_FREEDOM24 = 'freedom24_komplet.json';
/**
 * Raport maklerski i depozytariusza z API zapisujemy osobno, bo silnik
 * rozpoznaje je po nazwach sekcji i traktuje jako zrodlo rekordow
 * (`BROKER_REPORT_SECTIONS`, `DEPOSITARY_SECTIONS` w source_resolver.py).
 * Do tej pory te same pliki trzeba bylo pobierac recznie z panelu brokera.
 */
export const NAZWA_PLIKU_RAPORT_MAKLERSKI = 'broker_raport_api.json';
export const NAZWA_PLIKU_RAPORT_DEPOZYTARIUSZA = 'dezpozytariusz_raport_api.json';

/** Gorna granica oczekiwania na odpowiedz Tradernet. */
const LIMIT_CZASU_MS = 120_000;

export interface WynikPobraniaKompletu {
  transakcje: number;
  przeplywy: number;
  pozycje: number;
  ostrzezenia: string[];
  /** Sekcje raportu brokera wplywajace na podatek, ktorych nie udalo sie pobrac. */
  brakujaceSekcje: string[];
  nazwaPliku: string;
  /** Nazwy wszystkich plikow zapisanych do magazynu w tym pobraniu. */
  zapisanePliki: string[];
}

interface OdpowiedzEksportu {
  success: boolean;
  message?: string;
  /** false, gdy brakuje sekcji raportu wplywajacej na podatek (serwer: missingSections). */
  complete?: boolean;
  missingSections?: string[];
  sections?: Record<string, number>;
  warnings?: string[];
  generatedAt?: string;
  range?: { dateFrom?: string; dateTo?: string };
  report?: { trades: unknown[]; cash_flows: unknown[]; positions: unknown[] };
  raportMaklerski?: Record<string, unknown> | null;
  raportDepozytariusza?: Record<string, unknown> | null;
}

function naBase64(tekst: string): string {
  if (typeof btoa === 'function') {
    // btoa nie przyjmuje znakow spoza Latin-1, a komentarze operacji bywaja
    // po polsku - stad przejscie przez procentowe kodowanie UTF-8.
    return btoa(
      encodeURIComponent(tekst).replace(/%([0-9A-F]{2})/g, (_, kod: string) =>
        String.fromCharCode(parseInt(kod, 16))
      )
    );
  }
  return Buffer.from(tekst, 'utf-8').toString('base64');
}

/**
 * Pobiera komplet danych z rachunku Freedom24 i zapisuje je w magazynie, skad
 * czyta je silnik podatkowy przy najblizszym przeliczeniu.
 */
export async function pobierzKompletZFreedom24(
  konto: BrokerAccount,
  zakres?: { odDaty?: string; doDaty?: string }
): Promise<WynikPobraniaKompletu> {
  if (konto.brokerType !== 'FREEDOM24') {
    throw new Error('Ta operacja dotyczy wyłącznie rachunku Freedom24.');
  }
  // Tradernet potrafi odpowiadac wolno przy dlugim zakresie dat, ale bez gornej
  // granicy zadanie wisialoby w nieskonczonosc razem z przyciskiem synchronizacji.
  const przerwanie = new AbortController();
  const licznik = setTimeout(() => przerwanie.abort(), LIMIT_CZASU_MS);

  let odpowiedz: Response;
  try {
    odpowiedz = await apiFetch('/api/brokers/freedom24/full-export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: przerwanie.signal,
      body: JSON.stringify({
        dateFrom: zakres?.odDaty,
        dateTo: zakres?.doDaty,
      }),
    });
  } catch (blad: unknown) {
    if ((blad as Error)?.name === 'AbortError') {
      throw new Error('Freedom24 nie odpowiedziało w wyznaczonym czasie. Spróbuj węższego zakresu dat.');
    }
    throw new Error('Nie udało się połączyć z serwerem aplikacji.');
  } finally {
    clearTimeout(licznik);
  }

  // Przy awarii posrednika odpowiedz bywa strona HTML, a nie JSON-em - wtedy
  // parser rzucal nieczytelnym bledem skladni zamiast powiedziec, co sie stalo.
  let wynik: OdpowiedzEksportu;
  try {
    wynik = (await odpowiedz.json()) as OdpowiedzEksportu;
  } catch {
    throw new Error(
      `Serwer zwrócił odpowiedź, której nie da się odczytać (status ${odpowiedz.status}).`
    );
  }

  if (!odpowiedz.ok || !wynik.success || !wynik.report) {
    throw new Error(wynik.message || 'Freedom24 nie zwróciło danych.');
  }
  if (!Array.isArray(wynik.report.trades) || !Array.isArray(wynik.report.cash_flows)) {
    throw new Error('Odpowiedź Freedom24 nie ma oczekiwanych sekcji transakcji i przepływów.');
  }
  // Sprawdzane przed zapisem: wynik zawiera dlugosc pozycji, wiec null wywalal
  // TypeError dopiero po zapisie plikow.
  if (!Array.isArray(wynik.report.positions)) {
    throw new Error('Odpowiedź Freedom24 nie ma sekcji pozycji.');
  }

  // Zapisy maja overwrite:true, wiec niepelny raport (przejsciowy blad jednej
  // sekcji) zastapilby kompletny, ktory czyta silnik. Nie zapisujemy nic.
  const brakujace = wynik.missingSections && wynik.missingSections.length > 0
    ? wynik.missingSections
    : wynik.complete === false ? ['nieznane sekcje raportu'] : [];
  if (brakujace.length > 0) {
    throw new Error(
      `Nie zapisano raportu maklerskiego: Freedom24 nie zwróciło sekcji ${brakujace.join(', ')}; spróbuj ponownie. Wcześniej zapisane dane pozostały bez zmian.`
    );
  }

  // Do magazynu trafia sam raport w formacie broker_report_json - bez metadanych
  // pobrania, ktore silnik potraktowalby jako nieznane sekcje.
  const doZapisu = [
    {
      relativePath: NAZWA_PLIKU_FREEDOM24,
      fileName: NAZWA_PLIKU_FREEDOM24,
      base64: naBase64(JSON.stringify(wynik.report, null, 2)),
      overwrite: true,
    },
  ];
  if (wynik.raportMaklerski && Object.keys(wynik.raportMaklerski).length > 0) {
    doZapisu.push({
      relativePath: NAZWA_PLIKU_RAPORT_MAKLERSKI,
      fileName: NAZWA_PLIKU_RAPORT_MAKLERSKI,
      base64: naBase64(JSON.stringify(wynik.raportMaklerski, null, 2)),
      overwrite: true,
    });
  }
  if (wynik.raportDepozytariusza && Object.keys(wynik.raportDepozytariusza).length > 0) {
    doZapisu.push({
      relativePath: NAZWA_PLIKU_RAPORT_DEPOZYTARIUSZA,
      fileName: NAZWA_PLIKU_RAPORT_DEPOZYTARIUSZA,
      base64: naBase64(JSON.stringify(wynik.raportDepozytariusza, null, 2)),
      overwrite: true,
    });
  }
  const zapis = await runtimeApi.importFilesToStorage(doZapisu);

  if (zapis.failed && zapis.failed.length > 0) {
    throw new Error(`Nie udało się zapisać danych do magazynu: ${zapis.failed[0].message}`);
  }

  return {
    transakcje: wynik.sections?.trades ?? wynik.report.trades.length,
    przeplywy: wynik.sections?.cash_flows ?? wynik.report.cash_flows.length,
    pozycje: wynik.sections?.positions ?? wynik.report.positions.length,
    ostrzezenia: wynik.warnings ?? [],
    // Niepelny eksport konczy sie wyjatkiem wyzej; pole zostaje dla zgodnosci.
    brakujaceSekcje: [],
    nazwaPliku: NAZWA_PLIKU_FREEDOM24,
    zapisanePliki: doZapisu.map((plik) => plik.fileName),
  };
}
