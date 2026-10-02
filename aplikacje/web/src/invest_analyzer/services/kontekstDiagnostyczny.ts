import { odmienLiczebnik } from '../../portfel/services/odmianaLiczebnika';

/**
 * Kontekst diagnostyczny kopiowany do schowka (zwykle wklejany do zewnetrznego AI).
 * Nazwy wyciagow zdradzaja brokera, konto i okres, a tresc logow moze niesc kwoty
 * i sciezki - domyslnie kontekst ma wiec tylko identyfikatory plikow (z
 * rozszerzeniem) oraz poziomy i etapy logow.
 */

export interface PlikKontekstu {
  name: string;
  recordCount: number;
  isEnabled?: boolean;
}

export interface LogKontekstu {
  displayLevel: string;
  stage: string;
  userFacingKind?: string;
}

function rozszerzenie(nazwa: string): string {
  const koncowa = nazwa.split(/[\/]/).pop() ?? '';
  const kropka = koncowa.lastIndexOf('.');
  const rozszerzenie = kropka > 0 ? koncowa.slice(kropka + 1).toLowerCase() : '';
  return /^[a-z0-9]{1,5}$/.test(rozszerzenie) ? `.${rozszerzenie}` : '';
}

export function zbudujKontekstDiagnostyczny(dane: {
  taxPlan: string;
  files: readonly PlikKontekstu[];
  logs: readonly LogKontekstu[];
  formatStage: (stage: string) => string;
  /** Tylko na wyrazne zadanie uzytkownika: prawdziwe nazwy plikow zamiast identyfikatorow. */
  jawneNazwyPlikow?: boolean;
}): string {
  const pliki = dane.files
    .map((plik, indeks) => {
      const nazwa = dane.jawneNazwyPlikow ? plik.name : `plik-${indeks + 1}${rozszerzenie(plik.name)}`;
      return `${nazwa} (${plik.recordCount} ${odmienLiczebnik(plik.recordCount, 'rekord', 'rekordy', 'rekordów')}, ${plik.isEnabled === false ? 'wyłączony' : 'aktywny'})`;
    })
    .join('; ');
  const logi = dane.logs
    .slice(-10)
    .map((log) => `[${log.displayLevel}] ${dane.formatStage(log.stage)}${log.userFacingKind ? ` (${log.userFacingKind})` : ''}`)
    .join(' | ');
  return [
    'Kontekst diagnostyczny InvestAnalyzer',
    `Plan podatkowy: ${dane.taxPlan}`,
    `Pliki bazowe: ${pliki || 'brak'}`,
    `Ostatnie logi: ${logi || 'brak'}`,
    'Zadanie dla AI: wskaż ryzyka importu, niespójności danych i pytania do doradcy podatkowego. Nie zmieniaj obliczeń silnika.',
  ].join('\n');
}
