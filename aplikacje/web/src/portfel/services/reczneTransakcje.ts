/**
 * Ręczne wpisy portfela a silnik podatkowy.
 *
 * Źródłem prawdy o transakcjach jest magazyn silnika (`dane/pliki`). Portfel
 * trzyma w przeglądarce wyłącznie to, co użytkownik dopisał sam. Takie wpisy
 * NIE są zapisywane do magazynu - kopia w `portfel_reczne_transakcje.json`
 * dublowała eksport brokera (457 rekordów NBIS). Idą do silnika razem
 * z żądaniem przeliczenia, tą samą drogą co ręczne rekordy z edytora historii
 * (`transactionOverrides`, tryb "new"), więc obie połowy aplikacji liczą
 * z identycznego wejścia.
 */

import type { Transaction } from '../types';
import type { NadpisanieTransakcji } from '../../invest_analyzer/services/transactionOverrides';

/** Klucz magazynu przeglądarki, pod którym portfel trzyma własne wpisy. */
export const KLUCZ_TRANSAKCJI_PORTFELA = 'pit38_transactions';

/** Przedrostek identyfikatora rekordu ręcznego wysyłanego do silnika. */
export const PRZEDROSTEK_REKORDU_PORTFELA = 'portfel-';

export type PowodPominiecia =
  | 'KOPIA_Z_API_BROKERA'
  | 'RODZAJ_NIEOBSLUGIWANY'
  | 'KRYPTOWALUTA'
  | 'NIEPELNE_DANE';

export interface PominietaTransakcja {
  transakcja: Transaction;
  powod: PowodPominiecia;
  opis: string;
}

export interface PodzialTransakcjiLokalnych {
  /** Kupna i sprzedaże, które silnik przyjmie jako ręczne rekordy. */
  doSilnika: Transaction[];
  /** Wpisy, które do rozliczenia NIE wejdą - z powodem do pokazania. */
  pominiete: PominietaTransakcja[];
}

/**
 * Wpis pobrany kiedyś z API Freedom24 do pamięci przeglądarki. Te same
 * transakcje są w eksporcie `freedom24_komplet.json`, z którego czyta silnik.
 */
export function czyKopiaZApiFreedom24(tx: Pick<Transaction, 'id'>): boolean {
  return typeof tx.id === 'string' && tx.id.startsWith('fr24_');
}

function liczbaDodatnia(wartosc: unknown): wartosc is number {
  return typeof wartosc === 'number' && Number.isFinite(wartosc) && wartosc > 0;
}

export function podzielTransakcjeLokalne(transakcje: readonly Transaction[]): PodzialTransakcjiLokalnych {
  const doSilnika: Transaction[] = [];
  const pominiete: PominietaTransakcja[] = [];

  for (const tx of transakcje) {
    if (czyKopiaZApiFreedom24(tx)) {
      pominiete.push({
        transakcja: tx,
        powod: 'KOPIA_Z_API_BROKERA',
        opis: 'Kopia z API Freedom24 - ta transakcja jest już w eksporcie brokera w magazynie silnika.',
      });
      continue;
    }
    if (tx.type !== 'BUY' && tx.type !== 'SELL') {
      pominiete.push({
        transakcja: tx,
        powod: 'RODZAJ_NIEOBSLUGIWANY',
        opis:
          'Silnik przyjmuje ręcznie tylko kupno i sprzedaż. Dywidendy i opłaty muszą pochodzić z dokumentu brokera ' +
          '(zakładka „Dokumenty i silnik”).',
      });
      continue;
    }
    if (tx.category === 'CRYPTO') {
      pominiete.push({
        transakcja: tx,
        powod: 'KRYPTOWALUTA',
        opis:
          'Ręczny rekord trafia do części C (papiery wartościowe). Waluty wirtualne rozlicza część E - ' +
          'dodaj je plikiem z giełdy, inaczej trafiłyby do złej sekcji PIT-38.',
      });
      continue;
    }
    const kompletna =
      typeof tx.ticker === 'string' &&
      tx.ticker.trim() !== '' &&
      typeof tx.date === 'string' &&
      /^\d{4}-\d{2}-\d{2}/.test(tx.date) &&
      typeof tx.currency === 'string' &&
      /^[A-Za-z]{3}$/.test(tx.currency) &&
      liczbaDodatnia(tx.quantity) &&
      typeof tx.pricePerUnit === 'number' &&
      Number.isFinite(tx.pricePerUnit) &&
      tx.pricePerUnit >= 0;
    if (!kompletna) {
      pominiete.push({
        transakcja: tx,
        powod: 'NIEPELNE_DANE',
        opis: 'Brakuje waloru, daty, waluty, ilości albo ceny - wpis nie może wejść do rozliczenia.',
      });
      continue;
    }
    doSilnika.push(tx);
  }

  return { doSilnika, pominiete };
}

/** Liczba zapisana bez notacji wykładniczej i bez ogona zer. */
function liczbaJakoTekst(wartosc: number): string {
  const tekst = wartosc.toFixed(8);
  return tekst.includes('.') ? tekst.replace(/0+$/, '').replace(/\.$/, '') : tekst;
}

/**
 * Ręczne kupna i sprzedaże w kształcie, który silnik zna z edytora historii.
 *
 * Znaczniki czasu biorą się z daty transakcji, nie z zegara: dwa kolejne
 * żądania dla tych samych danych muszą być identyczne, inaczej nie da się
 * rozpoznać, że przebieg dla nich już trwa.
 */
export function transakcjeJakoNadpisania(transakcje: readonly Transaction[]): NadpisanieTransakcji[] {
  return podzielTransakcjeLokalne(transakcje)
    .doSilnika.slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((tx) => {
      const manualRecordId = `${PRZEDROSTEK_REKORDU_PORTFELA}${tx.id}`;
      const prowizja =
        typeof tx.commission === 'number' && Number.isFinite(tx.commission) && tx.commission > 0 ? tx.commission : null;
      const values: Record<string, string | null> = {
        date: tx.date,
        symbol: tx.ticker.trim(),
        side: tx.type,
        quantity: liczbaJakoTekst(tx.quantity),
        price: liczbaJakoTekst(tx.pricePerUnit),
        gross_amount: liczbaJakoTekst(tx.quantity * tx.pricePerUnit),
        trade_currency: tx.currency.toUpperCase(),
        // Brak prowizji to "0" wpisane przez użytkownika w formularzu portfela;
        // silnik wymaga liczby w tym polu.
        commission: prowizja === null ? '0' : liczbaJakoTekst(prowizja),
        commission_currency: prowizja === null ? null : (tx.commissionCurrency || tx.currency).toUpperCase(),
        comment: tx.notes ? tx.notes : null,
      };
      return {
        overrideId: `override-${manualRecordId}`,
        mode: 'new' as const,
        recordType: 'TRADE' as const,
        baseRecordId: null,
        manualRecordId,
        deleted: false,
        values,
        updatedAt: tx.date,
        createdAt: tx.date,
        comment: tx.notes || undefined,
        sourceLabel: 'Portfel - wpis ręczny',
      };
    });
}

/** Wpisy portfela prosto z magazynu przeglądarki (dla warsztatu silnika). */
export function odczytajTransakcjePortfelaZMagazynu(): Transaction[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const zapis = localStorage.getItem(KLUCZ_TRANSAKCJI_PORTFELA);
    if (!zapis) return [];
    const odczyt: unknown = JSON.parse(zapis);
    if (!Array.isArray(odczyt)) return [];
    return odczyt.filter(
      (wpis): wpis is Transaction => Boolean(wpis) && typeof wpis === 'object' && typeof (wpis as Transaction).id === 'string'
    );
  } catch {
    return [];
  }
}
