import { pominieteKluczeKopii } from './kopiaPrzedCzyszczeniem';

/** Klucze kwarantanny: surowe nieczytelne wpisy odlozone przed usunieciem (zob. kwarantanna.ts). */
export const PREFIKS_KWARANTANNY = 'investAnalyzer:recovery-quarantine:';

export interface MagazynDoKwarantanny {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function odczytajUszkodzoneWpisy(
  magazyn: MagazynDoKwarantanny,
  objeteKlucze: readonly string[],
  prefiksy: readonly string[],
): Array<{ key: string; value: string }> {
  const klucze = new Set(objeteKlucze);
  const namespace = ['pit38_', 'investAnalyzer:', 'ia_', ...prefiksy];
  const wadliwe: Array<{ key: string; value: string }> = [];

  for (let i = 0; i < magazyn.length; i += 1) {
    const key = magazyn.key(i);
    if (!key || key.startsWith(PREFIKS_KWARANTANNY)) continue;
    if (!klucze.has(key) && !namespace.some((prefix) => key.startsWith(prefix))) continue;
    const value = magazyn.getItem(key);
    if (value === null || !/^\s*[[{]/.test(value)) continue;
    try { JSON.parse(value); } catch { wadliwe.push({ key, value }); }
  }
  return wadliwe;
}

function zapiszKwarantanne(magazyn: MagazynDoKwarantanny, wadliwe: Array<{ key: string; value: string }>, teraz: number): string[] {
  if (wadliwe.length === 0) return [];
  const quarantinePrefix = `${PREFIKS_KWARANTANNY}${teraz}`;
  let quarantineKey = quarantinePrefix;
  let suffix = 1;
  while (magazyn.getItem(quarantineKey) !== null) quarantineKey = `${quarantinePrefix}:${suffix++}`;
  // setItem musi w pełni przejść (np. nie zabraknąć miejsca) przed usunięciem dowolnego wpisu.
  magazyn.setItem(quarantineKey, JSON.stringify({ createdAt: new Date(teraz).toISOString(), entries: wadliwe }));
  return wadliwe.map(({ key }) => key);
}

/** Zapisuje surowe uszkodzone dane lokalnie, zachowując oryginały do końca operacji. */
export function zachowajUszkodzoneWpisyWKwarantannie(
  magazyn: MagazynDoKwarantanny,
  objeteKlucze: readonly string[],
  prefiksy: readonly string[],
  teraz = Date.now(),
): string[] {
  return zapiszKwarantanne(magazyn, odczytajUszkodzoneWpisy(magazyn, objeteKlucze, prefiksy), teraz);
}

/** Zachowuje surowe wpisy przed usunięciem ich z kluczy aplikacji. */
export function usunUszkodzoneWpisyDoKwarantanny(
  magazyn: MagazynDoKwarantanny,
  objeteKlucze: readonly string[],
  prefiksy: readonly string[],
  teraz = Date.now(),
): string[] {
  const wadliwe = odczytajUszkodzoneWpisy(magazyn, objeteKlucze, prefiksy);
  const usuniete = zapiszKwarantanne(magazyn, wadliwe, teraz);
  for (const entry of wadliwe) magazyn.removeItem(entry.key);
  return usuniete;
}

/** Usuwa dane z localStorage, zachowując lokalne kopie odzyskiwania. */
export function wyczyscLocalStoragePozaKwarantanna(magazyn: MagazynDoKwarantanny): void {
  for (let i = magazyn.length - 1; i >= 0; i -= 1) {
    const key = magazyn.key(i);
    if (key && !key.startsWith(PREFIKS_KWARANTANNY)) magazyn.removeItem(key);
  }
}

function opisBledu(blad: unknown): string {
  return blad instanceof Error && blad.message ? blad.message : String(blad);
}

/** Dlaczego kopii nie ma albo jest niepelna - do pytania o zgode na dzialanie bez niej. */
export type PowodBrakuKopii =
  | { rodzaj: 'blad'; szczegol: string }
  | { rodzaj: 'niepelna'; pominiete: string[] };

/**
 * Tresc pytania o zgode na dzialanie bez kopii. Skutek zalezy od operacji:
 * pelne czyszczenie kasuje decyzje bezpowrotnie, kwarantanna tylko przenosi
 * nieczytelne wpisy do lokalnego magazynu tej przegladarki.
 */
export function trescZgodyBezKopii(akcja: 'kwarantanna' | 'czyszczenie', powod: PowodBrakuKopii): string {
  const naglowek = powod.rodzaj === 'niepelna'
    ? `Kopia bezpieczeństwa jest niepełna — nie udało się odczytać: ${powod.pominiete.join(', ')}.`
    : `Nie udało się zapisać kopii bezpieczeństwa. (${powod.szczegol})`;
  const skutek = akcja === 'czyszczenie'
    ? ['Jeśli wyczyścisz dane teraz, NIE BĘDZIE ich jak odzyskać.', 'Czy wyczyścić dane przeglądarki BEZ kopii?']
    : ['Nieczytelne wpisy trafią wyłącznie do lokalnej kwarantanny w tej przeglądarce.', 'Czy usunąć je BEZ kopii na dysku?'];
  return [naglowek, '', ...skutek].join('\n');
}

/**
 * Zapisuje pelna kopie przed zmiana danych; bez kompletnej kopii nie podejmuje
 * akcji - chyba ze uzytkownik jawnie sie zgodzi (potwierdzBezKopii), tak jak
 * przy czyszczeniu danych w Ustawieniach. Bez tej furtki panel bledu zostawial
 * uzytkownika bez wyjscia dokladnie wtedy, gdy magazyn albo serwer kopii
 * szwankowal, a dane byly juz nie do odczytania.
 *
 * Komunikat mowi, na ktorym etapie operacja stanela. Surowy blad przegladarki
 * ("Failed to fetch", "Unexpected end of JSON input") nie odpowiadal na jedyne
 * pytanie uzytkownika: czy cos zniknelo. Przed zapisaniem kopii nic nie jest
 * ruszane; po jej zapisaniu komunikat podaje identyfikator kopii.
 *
 * Zwraca identyfikator kopii albo null, gdy operacja poszla za zgoda bez kopii.
 */
export async function wykonajOdzyskiwanieZKopia<TMigawka>(zaleznosci: {
  collect: () => Promise<TMigawka>;
  write: (migawka: TMigawka) => Promise<{ id: string }>;
  apply: (migawka: TMigawka | null) => Promise<void> | void;
  reload: () => void;
  potwierdzBezKopii?: (powod: PowodBrakuKopii) => boolean;
}): Promise<string | null> {
  const zgoda = (powod: PowodBrakuKopii): boolean => zaleznosci.potwierdzBezKopii?.(powod) === true;
  let migawka: TMigawka | null = null;
  let bezKopii = false;
  try {
    migawka = await zaleznosci.collect();
  } catch (blad) {
    if (!zgoda({ rodzaj: 'blad', szczegol: opisBledu(blad) })) {
      throw new Error(`Nie udało się przygotować kopii bezpieczeństwa — odzyskiwanie przerwane, nic nie usunięto. (${opisBledu(blad)})`);
    }
    bezKopii = true;
  }

  if (!bezKopii) {
    const pominiete = pominieteKluczeKopii(migawka);
    if (pominiete.length > 0 && !zgoda({ rodzaj: 'niepelna', pominiete })) {
      throw new Error(`Kopia bezpieczeństwa jest niepełna. Nie usunięto danych; pominięte wpisy: ${pominiete.join(', ')}.`);
    }
  }

  let kopia: { id: string } | null = null;
  if (!bezKopii) {
    try {
      const zapis = await zaleznosci.write(migawka as TMigawka);
      if (!zapis?.id) throw new Error('Kopia bezpieczeństwa nie została potwierdzona.');
      kopia = zapis;
    } catch (blad) {
      if (!zgoda({ rodzaj: 'blad', szczegol: opisBledu(blad) })) {
        throw new Error(`Nie udało się zapisać kopii bezpieczeństwa — odzyskiwanie przerwane, nic nie usunięto. (${opisBledu(blad)})`);
      }
      bezKopii = true;
    }
  }

  try {
    await zaleznosci.apply(migawka);
  } catch (blad) {
    const kontekst = kopia ? `Kopia bezpieczeństwa sprzed operacji: ${kopia.id}.` : 'Operacja szła za zgodą bez kopii bezpieczeństwa.';
    throw new Error(`Odzyskiwanie nie zostało dokończone (${opisBledu(blad)}). ${kontekst}`);
  }
  zaleznosci.reload();
  return kopia?.id ?? null;
}
