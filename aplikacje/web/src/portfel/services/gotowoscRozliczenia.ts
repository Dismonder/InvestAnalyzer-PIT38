/**
 * Gotowosc rozliczenia do zlozenia, jak ja widzi eksport. Tylko `true` z silnika znaczy "gotowe":
 * `false` to blokady, a `null` i `undefined` (brak wyniku, wynik sprzed pierwszego przebiegu)
 * to brak potwierdzenia - tez niegotowe.
 */
export const ADNOTACJA_NIEGOTOWEGO_ROZLICZENIA = 'ROZLICZENIE NIEGOTOWE — silnik zgłasza blokady';

export function rozliczenieGotowe(gotoweDoZlozenia: boolean | null | undefined): boolean {
  return gotoweDoZlozenia === true;
}

/** Adnotacja do pliku PDF/CSV: tekst, gdy rozliczenie niegotowe, inaczej `undefined`. */
export function adnotacjaNiegotowego(gotoweDoZlozenia: boolean | null | undefined): string | undefined {
  return rozliczenieGotowe(gotoweDoZlozenia) ? undefined : ADNOTACJA_NIEGOTOWEGO_ROZLICZENIA;
}

/** Podpowiedz przy zablokowanym przycisku XML; `undefined`, gdy XML wolno przygotowac. */
export function powodBlokadyXml(
  exportZablokowany: boolean,
  gotoweDoZlozenia: boolean | null | undefined,
  tytulBlokadyEksportu: string | undefined,
): string | undefined {
  if (exportZablokowany) return tytulBlokadyEksportu;
  if (gotoweDoZlozenia === false) {
    return 'Silnik zgłasza blokady rozliczenia — usuń je (Sprawdź kontrolę PIT) przed przygotowaniem e-deklaracji.';
  }
  if (!rozliczenieGotowe(gotoweDoZlozenia)) {
    return 'Brak potwierdzenia gotowości rozliczenia z silnika — przelicz ponownie przed przygotowaniem e-deklaracji.';
  }
  return undefined;
}

/**
 * Powod, dla ktorego nie wolno kopiowac pol deklaracji (poz. 20-33 i in.); `undefined`, gdy wolno.
 * Kopiowanie omijalo bramke gotowosci, wiec przy blokadach silnika mozna bylo przepisac
 * do e-PIT kwoty, ktorych silnik nie uznal za gotowe.
 */
export function powodBlokadyKopiowania(
  wynikNieaktualnyLubNieobliczony: boolean,
  gotoweDoZlozenia: boolean | null | undefined,
): string | undefined {
  if (wynikNieaktualnyLubNieobliczony) return 'Wynik NIEAKTUALNY lub nieobliczony — przelicz ponownie przed kopiowaniem.';
  if (gotoweDoZlozenia === false) {
    return 'Silnik zgłasza blokady rozliczenia — nie przepisuj tych wartości do deklaracji, dopóki ich nie usuniesz.';
  }
  if (!rozliczenieGotowe(gotoweDoZlozenia)) {
    return 'Brak potwierdzenia gotowości rozliczenia z silnika — przelicz ponownie przed kopiowaniem.';
  }
  return undefined;
}

/** Minimalny wycinek jsPDF potrzebny do adnotacji (test bez ladowania biblioteki). */
export interface DokumentPdfAdnotacji {
  setTextColor: (...argumenty: number[]) => unknown;
  setFont: (...argumenty: string[]) => unknown;
  setFontSize: (rozmiar: number) => unknown;
  text: (tresc: string, x: number, y: number) => unknown;
}

/** Czerwona linia adnotacji pod naglowkiem raportu; nic nie robi bez adnotacji. */
export function dodajAdnotacjeDoPdf(doc: DokumentPdfAdnotacji, adnotacja: string | undefined, y = 30.5): void {
  if (!adnotacja) return;
  doc.setTextColor(185, 28, 28);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.text(adnotacja, 14, y);
}
