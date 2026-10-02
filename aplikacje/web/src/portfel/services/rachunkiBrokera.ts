import type { BrokerAccount, Transaction } from '../types';
import { DEMO_ACCOUNT_IDS } from './sampleData';

/** Odrzucamy uszkodzone rachunki, zanim widok odczyta ich pola. */
export function oczyscRachunki(lista: BrokerAccount[], transakcje: readonly Transaction[]): BrokerAccount[] {
  const uzywaneRachunki = new Set(transakcje.map((transakcja) => transakcja.accountId));
  return lista.filter((rachunek) => {
    if (!rachunek || typeof rachunek !== 'object' ||
      typeof rachunek.id !== 'string' || rachunek.id.trim().length === 0 ||
      typeof rachunek.name !== 'string' || typeof rachunek.brokerType !== 'string') {
      return false;
    }
    if (DEMO_ACCOUNT_IDS.has(rachunek.id)) {
      // Dawne id demo moze nalezec juz do uzytkownika; numer lub transakcja tez potwierdza uzycie.
      return Boolean((rachunek.apiKey && rachunek.apiKey.length > 5) ||
        (rachunek.apiSecret && rachunek.apiSecret.length > 5) ||
        rachunek.accountNumber?.trim() || uzywaneRachunki.has(rachunek.id));
    }
    return true;
  });
}
