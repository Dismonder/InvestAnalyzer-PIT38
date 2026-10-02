/**
 * Zaslepka pod opcjonalne zaleznosci jspdf.
 *
 * jspdf importuje html2canvas, canvg i dompurify na potrzeby metody doc.html(),
 * ktora renderuje HTML do dokumentu. Ten program jej nie uzywa - buduje PDF
 * z tekstu i tabel (autoTable) - a same te biblioteki waza w paczce okolo
 * 290 kB. Podmiana na zaslepke usuwa je z wydania i nie zmienia zachowania.
 *
 * Gdyby ktos kiedys siegnal po doc.html(), dostanie czytelny blad zamiast
 * cichej awarii.
 */

const komunikat =
  'Renderowanie HTML do PDF jest wylaczone w tym wydaniu (doc.html()). ' +
  'Raporty buduje sie z tekstu i tabel. Zeby to wlaczyc, usun podmiane ' +
  'html2canvas/canvg/dompurify w aplikacje/web/vite.config.ts.';

function niedostepne(): never {
  throw new Error(komunikat);
}

export default niedostepne;
export const Canvg = niedostepne;
export const sanitize = niedostepne;
