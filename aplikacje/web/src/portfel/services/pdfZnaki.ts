/**
 * Standardowe czcionki jsPDF (helvetica) znaja tylko WinAnsi. Napis z choc
 * jedna litera spoza tego zestawu (a, e z ogonkiem, l, s, z, c, n z kreska)
 * jspdf koduje jako UTF-16, co przegladarka PDF pokazywala jako "ZaB cznik",
 * "GBowne", "Warto[" - caly napis rozstrzelony i znieksztalcony. Bez
 * osadzonej czcionki TTF zamieniamy te litery na odpowiedniki bez ogonkow
 * (o z kreska jest w WinAnsi i zostaje), a reszte znakow spoza zestawu na
 * najblizszy zapis ASCII.
 */
const POLSKIE: Record<string, string> = {
  ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ś: 's', ź: 'z', ż: 'z',
  Ą: 'A', Ć: 'C', Ę: 'E', Ł: 'L', Ń: 'N', Ś: 'S', Ź: 'Z', Ż: 'Z',
};
const INNE: Record<string, string> = {
  ' ': ' ', '→': '->', '←': '<-', '≈': '~', '≥': '>=', '≤': '<=', '−': '-', '✓': 'v', '✗': 'x',
};
// Znaki WinAnsi spoza Latin-1 (0x80-0x9F w stronie kodowej 1252).
const WIN_ANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');

export function doWinAnsi(tekst: string): string {
  let wynik = '';
  for (const znak of tekst) {
    const kod = znak.codePointAt(0)!;
    if (kod < 0x80 || (kod >= 0xa0 && kod <= 0xff) || WIN_ANSI_EXTRA.has(znak)) wynik += znak;
    else wynik += POLSKIE[znak] ?? INNE[znak] ?? '?';
  }
  return wynik;
}

type Tekst = string | string[];
interface DokumentPdf {
  text: (tekst: Tekst, ...reszta: never[]) => unknown;
  splitTextToSize: (tekst: string, ...reszta: never[]) => string[];
  getTextWidth: (tekst: string) => number;
  getStringUnitWidth: (tekst: string, ...reszta: never[]) => number;
}

const naWinAnsi = (t: Tekst): Tekst => (Array.isArray(t) ? t.map(doWinAnsi) : typeof t === 'string' ? doWinAnsi(t) : t);

/**
 * Podmienia na dokumencie metody tekstowe, z ktorych korzysta tez
 * jspdf-autotable, wiec obejmuje naglowki, tabele i adnotacje w jednym miejscu.
 */
export function zabezpieczZnakiPdf<T extends object>(doc: T): T {
  const d = doc as unknown as DokumentPdf;
  const text = d.text.bind(d);
  const split = d.splitTextToSize.bind(d);
  const szerokosc = d.getTextWidth.bind(d);
  const szerokoscJednostkowa = d.getStringUnitWidth.bind(d);
  d.text = ((tekst: Tekst, ...reszta: never[]) => text(naWinAnsi(tekst), ...reszta)) as DokumentPdf['text'];
  d.splitTextToSize = ((tekst: string, ...reszta: never[]) => split(doWinAnsi(String(tekst)), ...reszta)) as DokumentPdf['splitTextToSize'];
  d.getTextWidth = (tekst: string) => szerokosc(doWinAnsi(String(tekst)));
  // Z tej metody jspdf-autotable liczy szerokosc kolumn.
  d.getStringUnitWidth = ((tekst: string, ...reszta: never[]) =>
    szerokoscJednostkowa(doWinAnsi(String(tekst)), ...reszta)) as DokumentPdf['getStringUnitWidth'];
  return doc;
}
