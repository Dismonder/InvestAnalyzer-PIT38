import type { Transaction } from '../types';
import { DEMO_TRANSACTION_IDS } from './sampleData';

/**
 * Uszkodzony wpis z magazynu nie moze wywracac powloki portfela.
 *
 * Symbol jest obowiazkowy poza oplatami: import CSV tworzy oplaty (FEE, np. za
 * prowadzenie rachunku) bez symbolu waloru i takie wpisy sa prawidlowe.
 */
export function oczyscTransakcje(lista: Transaction[]): Transaction[] {
  return lista.filter((transakcja) =>
    transakcja !== null &&
    typeof transakcja === 'object' &&
    typeof transakcja.id === 'string' && transakcja.id.trim().length > 0 &&
    typeof transakcja.accountId === 'string' &&
    typeof transakcja.ticker === 'string' && (transakcja.ticker.trim().length > 0 || transakcja.type === 'FEE') &&
    typeof transakcja.type === 'string' &&
    typeof transakcja.date === 'string' && transakcja.date.length >= 10 &&
    typeof transakcja.quantity === 'number' && Number.isFinite(transakcja.quantity) &&
    typeof transakcja.pricePerUnit === 'number' && Number.isFinite(transakcja.pricePerUnit) &&
    typeof transakcja.currency === 'string' &&
    !DEMO_TRANSACTION_IDS.has(transakcja.id) &&
    // Rachunek o dawnym id demo moze zawierac prawdziwe transakcje uzytkownika.
    !transakcja.id.startsWith('tx_demo')
  );
}
