/**
 * Kopia bezpieczenstwa przed wyczyszczeniem danych.
 *
 * Blad zapisu kopii nie moze po cichu przechodzic w nieodwracalne czyszczenie: bez kopii
 * czyszczenie idzie dalej dopiero po osobnym, jawnym potwierdzeniu "Wyczysc BEZ kopii".
 * Wzorzec jak przywrocZKopiaBezpieczenstwa (BackupPanel), tylko z mozliwoscia swiadomej zgody.
 */
/** Klucze, ktorych nie udalo sie odczytac do kopii (`skippedKeys` migawki); puste = kopia pelna. */
export function pominieteKluczeKopii(migawka: unknown): string[] {
  const klucze = (migawka as { skippedKeys?: unknown } | null | undefined)?.skippedKeys;
  return Array.isArray(klucze) ? klucze.filter((klucz): klucz is string => typeof klucz === 'string') : [];
}

export interface WynikKopiiPrzedCzyszczeniem {
  /** Czy wolno czyscic dane. */
  kontynuuj: boolean;
  /** ID zapisanej kopii; `null`, gdy kopii nie ma. */
  idKopii: string | null;
  /** Blad zapisu kopii (gdy wystapil), do dziennika. */
  blad: unknown;
  /** Klucze pominiete w kopii - niepusta lista znaczy kopie NIEPELNA. */
  pominieteKlucze?: string[];
}

export function trescOstrzezeniaNiepelnejKopii(pominiete: readonly string[]): string {
  return [
    `Kopia bezpieczeństwa przed wyczyszczeniem danych jest niepełna — nie udało się odczytać: ${pominiete.join(', ')}.`,
    '',
    'Po wyczyszczeniu tych danych NIE BĘDZIE jak odzyskać.',
    'Czy wyczyścić dane mimo niepełnej kopii?',
  ].join('\n');
}

export function trescOstrzezeniaBezKopii(szczegolBledu: string): string {
  return [
    `Nie udało się zapisać kopii bezpieczeństwa przed wyczyszczeniem danych. (${szczegolBledu})`,
    '',
    'Jeśli wyczyścisz dane teraz, NIE BĘDZIE ich jak odzyskać.',
    'Czy wyczyścić dane BEZ kopii?',
  ].join('\n');
}

export async function przygotujKopiePrzedCzyszczeniem<TSnapshot>(zaleznosci: {
  collect: () => Promise<TSnapshot>;
  write: (snapshot: TSnapshot) => Promise<{ id: string }>;
  potwierdzBezKopii: (tresc: string) => boolean;
}): Promise<WynikKopiiPrzedCzyszczeniem> {
  try {
    const migawka = await zaleznosci.collect();
    const zapis = await zaleznosci.write(migawka);
    // Migawka z pominietymi kluczami (blad odczytu localforage) to nie sukces: dane spoza kopii
    // przepadlyby przy czyszczeniu - wymagana jest osobna, jawna zgoda.
    const pominiete = pominieteKluczeKopii(migawka);
    if (pominiete.length > 0) {
      const zgodaNaNiepelna = zaleznosci.potwierdzBezKopii(trescOstrzezeniaNiepelnejKopii(pominiete));
      return { kontynuuj: zgodaNaNiepelna, idKopii: zapis.id, blad: null, pominieteKlucze: pominiete };
    }
    return { kontynuuj: true, idKopii: zapis.id, blad: null };
  } catch (blad) {
    const szczegol = blad instanceof Error ? blad.message : String(blad);
    const zgoda = zaleznosci.potwierdzBezKopii(trescOstrzezeniaBezKopii(szczegol));
    return { kontynuuj: zgoda, idKopii: null, blad };
  }
}
