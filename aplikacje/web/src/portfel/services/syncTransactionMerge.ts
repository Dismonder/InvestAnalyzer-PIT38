import type { Transaction } from '../types';

/**
 * Ta sama operacja niezaleznie od identyfikatora: import CSV i API brokera nadaja rozne ID.
 * Bez daty, ilosci albo ceny nie ma czego porownac - wpisy z brakami dostawaly wspolny klucz
 * (NaN) i rozne operacje zastepowaly sie nawzajem.
 */
function kluczTresci(transaction: Transaction): string | null {
  const dzien = String(transaction.date ?? '').slice(0, 10);
  const ilosc = Number(transaction.quantity);
  const cena = Number(transaction.pricePerUnit);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dzien) || !Number.isFinite(ilosc) || ilosc <= 0 || !Number.isFinite(cena) || cena < 0) {
    return null;
  }
  return [
    transaction.accountId,
    transaction.type,
    // Ta sama liczba i cena w innej walucie to inna operacja.
    String(transaction.currency ?? '').trim().toUpperCase(),
    String(transaction.ticker ?? '').trim().toUpperCase(),
    dzien,
    ilosc,
    cena,
  ].join('|');
}

/**
 * Dokleja transakcje z synchronizacji rachunku, nie kasujac historii spoza jej wyniku.
 *
 * Dawniej wynik synchronizacji zastepowal cala historie rachunku: raport IBKR Flex z samymi
 * nowszymi operacjami usuwal wczesniejsze, w tym sprzedaze idace do rozliczenia PIT-38.
 * Wpis o tym samym ID jest aktualizowany; wpis bez tego ID, ale o tej samej tresci (ta sama
 * operacja zaimportowana wczesniej z pliku) - zastepowany, zeby transakcja nie weszla dwa razy.
 */
export function mergeSyncedTransactions(
  previous: Transaction[],
  accountId: string,
  synced: Transaction[],
): Transaction[] {
  const merged = [...previous];
  const indexById = new Map<string, number>();
  const indeksyPoTresci = new Map<string, number[]>();
  const zajete = new Set<number>();

  merged.forEach((transaction, index) => {
    if (transaction.accountId !== accountId) return;
    indexById.set(transaction.id, index);
    const klucz = kluczTresci(transaction);
    if (klucz) indeksyPoTresci.set(klucz, [...(indeksyPoTresci.get(klucz) ?? []), index]);
  });

  // Dwa przejscia: dopasowanie po ID nie moze zalezec od kolejnosci wpisow. W jednej petli
  // wpis bez znanego ID zajmowal po tresci miejsce wpisu, ktory zaraz mial pasowac po ID.
  const doDopasowaniaPoTresci: Transaction[] = [];
  for (const transaction of synced) {
    // Wynik synchronizacji rachunku nie moze zmieniac historii innego rachunku.
    if (transaction.accountId !== accountId) continue;
    const indexPoId = indexById.get(transaction.id);
    if (indexPoId !== undefined && !zajete.has(indexPoId)) {
      merged[indexPoId] = transaction;
      zajete.add(indexPoId);
    } else {
      doDopasowaniaPoTresci.push(transaction);
    }
  }

  for (const transaction of doDopasowaniaPoTresci) {
    const klucz = kluczTresci(transaction);
    const index = klucz ? (indeksyPoTresci.get(klucz) ?? []).find((kandydat) => !zajete.has(kandydat)) : undefined;
    if (index !== undefined) {
      merged[index] = transaction;
      zajete.add(index);
    } else {
      zajete.add(merged.length);
      merged.push(transaction);
    }
  }

  return merged;
}
