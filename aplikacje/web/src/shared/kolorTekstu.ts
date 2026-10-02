/**
 * Kolor tekstu czytelny na tle w kolorze wybranym przez uzytkownika (np. kolor
 * rachunku brokera). Staly bialy tekst mial na jasnych kolorach (zielen,
 * bursztyn) kontrast 2,1-2,5:1. Wybieramy bialy albo ciemny - ten, ktory daje
 * wiekszy kontrast wg WCAG. Kolor spoza #RGB/#RRGGBB zostawia bialy.
 */
const CIEMNY = '#0f172a'; // slate-900
const BIALY = '#ffffff';

function kanal(wartosc: number): number {
  const c = wartosc / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminancja(hex: string): number | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split('').map((z) => z + z).join('') : m[1];
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * kanal(r) + 0.7152 * kanal(g) + 0.0722 * kanal(b);
}

export function kolorTekstuNa(tlo: string): string {
  const l = luminancja(tlo);
  if (l === null) return BIALY;
  const zBialym = 1.05 / (l + 0.05);
  const zCiemnym = (l + 0.05) / (luminancja(CIEMNY)! + 0.05);
  return zCiemnym > zBialym ? CIEMNY : BIALY;
}
