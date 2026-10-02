import type { BrokerOrder } from '../types';

/**
 * Zlecenia brokera zdatne do pokazania i sprawdzenia.
 *
 * Lista `pit38_broker_orders` przechodzila tylko kontrole ksztaltu tablicy z polem
 * id. Wpis bez symbolu (poprawny JSON o zlym ksztalcie, np. po przerwanym zapisie
 * albo z innej wersji) wywracal cala zakladke Alerty przy `order.ticker.toUpperCase()`,
 * a przycisk "Usun tylko uszkodzone wpisy" nie mial czego usunac - pomagalo dopiero
 * pelne czyszczenie danych. Ten sam filtr dziala przy odczycie i przy wyrownaniu
 * magazynu (useSynchronizowanaLista), jak oczyscAlerty dla alertow.
 */
export function oczyscZlecenia(lista: BrokerOrder[]): BrokerOrder[] {
  return lista.filter(
    (zlecenie) =>
      Boolean(zlecenie) &&
      typeof zlecenie.id === 'string' &&
      zlecenie.id.length > 0 &&
      typeof zlecenie.ticker === 'string' &&
      zlecenie.ticker.trim().length > 0 &&
      typeof zlecenie.status === 'string' &&
      typeof zlecenie.accountId === 'string',
  );
}
