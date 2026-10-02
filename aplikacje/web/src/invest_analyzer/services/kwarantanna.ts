import { SUFIKS_USZKODZONEGO } from '../../portfel/services/magazynPrzegladarki';
import { PREFIKS_KWARANTANNY } from './odzyskiwanieAwaryjne';

/**
 * Kwarantanna nieczytelnych wpisow magazynu przegladarki.
 *
 * Dwa miejsca odkladaja surowe wpisy zamiast je kasowac: panel bledu
 * (`investAnalyzer:recovery-quarantine:<czas>` - paczka wpisow) i bezpieczny
 * odczyt portfela (`<klucz>:uszkodzony` - pojedynczy wpis). Dotad nic ich nie
 * pokazywalo ani nie usuwalo: zostawaly w przegladarce takze po pelnym
 * czyszczeniu danych, a moga zawierac klucze API rachunkow. Ten modul daje
 * liste, eksport do pliku i usuwanie - decyzja nalezy do uzytkownika.
 */
export interface MagazynKwarantanny {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  removeItem(key: string): void;
}

export interface PozycjaKwarantanny {
  /** Klucz w magazynie przegladarki. */
  klucz: string;
  /** Skad wpis pochodzi: paczka z panelu bledu albo pojedynczy wpis odlozony przy odczycie. */
  rodzaj: 'panel-bledu' | 'odczyt';
  /** Czas odlozenia (ISO) - znany tylko dla paczek z panelu bledu. */
  utworzono: string | null;
  /** Nazwy odlozonych wpisow (dla paczki - wszystkie, dla wpisu - klucz bez sufiksu). */
  wpisy: string[];
  /** Rozmiar surowej tresci w znakach. */
  znaki: number;
}

function czasZKlucza(klucz: string): string | null {
  const znacznik = Number(klucz.slice(PREFIKS_KWARANTANNY.length).split(':')[0]);
  return Number.isFinite(znacznik) && znacznik > 0 ? new Date(znacznik).toISOString() : null;
}

export function listaKwarantanny(magazyn: MagazynKwarantanny): PozycjaKwarantanny[] {
  const pozycje: PozycjaKwarantanny[] = [];
  for (let i = 0; i < magazyn.length; i += 1) {
    const klucz = magazyn.key(i);
    if (!klucz) continue;
    const tresc = magazyn.getItem(klucz);
    if (tresc === null) continue;
    if (klucz.startsWith(PREFIKS_KWARANTANNY)) {
      let wpisy: string[] = [];
      let utworzono: string | null = czasZKlucza(klucz);
      try {
        const paczka = JSON.parse(tresc) as { createdAt?: unknown; entries?: Array<{ key?: unknown }> };
        if (typeof paczka.createdAt === 'string') utworzono = paczka.createdAt;
        wpisy = (paczka.entries ?? []).map((wpis) => String(wpis.key ?? '?'));
      } catch {
        wpisy = ['(nieczytelna paczka)'];
      }
      pozycje.push({ klucz, rodzaj: 'panel-bledu', utworzono, wpisy, znaki: tresc.length });
    } else if (klucz.endsWith(SUFIKS_USZKODZONEGO)) {
      pozycje.push({ klucz, rodzaj: 'odczyt', utworzono: null, wpisy: [klucz.slice(0, -SUFIKS_USZKODZONEGO.length)], znaki: tresc.length });
    }
  }
  // Najnowsze paczki na gorze; wpisy odlozone przy odczycie na koncu, alfabetycznie.
  return pozycje.sort((a, b) => (b.utworzono ?? '').localeCompare(a.utworzono ?? '') || a.klucz.localeCompare(b.klucz));
}

/** Tresc pliku eksportu: surowe wpisy tak, jak leza w magazynie (bez interpretacji). */
export function eksportKwarantanny(magazyn: MagazynKwarantanny, klucze: readonly string[]): string {
  const wpisy = klucze
    .map((klucz) => ({ klucz, wartosc: magazyn.getItem(klucz) }))
    .filter((wpis): wpis is { klucz: string; wartosc: string } => wpis.wartosc !== null);
  return JSON.stringify({ rodzaj: 'investanalyzer-kwarantanna', wyeksportowano: new Date().toISOString(), wpisy }, null, 2);
}

/** Usuwa wskazane klucze; zwraca liczbe faktycznie usunietych. Nie rusza niczego poza kwarantanna. */
export function usunZKwarantanny(magazyn: MagazynKwarantanny, klucze: readonly string[]): number {
  let usuniete = 0;
  for (const klucz of klucze) {
    if (!klucz.startsWith(PREFIKS_KWARANTANNY) && !klucz.endsWith(SUFIKS_USZKODZONEGO)) continue;
    if (magazyn.getItem(klucz) === null) continue;
    magazyn.removeItem(klucz);
    usuniete += 1;
  }
  return usuniete;
}
