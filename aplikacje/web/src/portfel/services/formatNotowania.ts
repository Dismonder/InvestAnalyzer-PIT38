/**
 * Pola notowania, ktorych zrodlo (dostawca w desktopie) moze nie podac. Zmiana dzienna
 * jest wtedy `null`, a nie 0: 0 wygladaloby na prawdziwy, niezmieniony kurs.
 */
export function zmianaLubNull(wartosc: unknown): number | null {
  return typeof wartosc === 'number' && Number.isFinite(wartosc) ? wartosc : null;
}

// Polski zapis jak w pozostalych kwotach (formatLiczba); toFixed dawal "+1.23%".
const procentPl = new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "+1,23%" / "-0,40%", albo "—" gdy zrodlo nie podalo zmiany. */
export function formatujProcentZmiany(wartosc: unknown): string {
  const liczba = zmianaLubNull(wartosc);
  if (liczba === null) return '—';
  return `${liczba >= 0 ? '+' : ''}${procentPl.format(liczba)}%`;
}