export interface OcenaProgow {
  /** Stosunek zysku do ryzyka; `null`, gdy uklad progow nie ma sensu albo brakuje kursu. */
  rrr: number | null;
  /** Powod, dla ktorego progow nie wolno uzbroic; `null`, gdy sa poprawne albo nie ma jeszcze czego oceniac. */
  blad: string | null;
}

/**
 * Progi maja sens tylko w ukladzie SL < kurs < TP. Prog po zlej stronie kursu
 * zadzialalby natychmiast, wiec nie liczymy dla niego wskaznika ani go nie uzbrajamy.
 */
export function ocenProgi(kurs: number | null, sl: number | null, tp: number | null): OcenaProgow {
  if (kurs === null || sl === null || tp === null || !(kurs > 0)) return { rrr: null, blad: null };
  if (sl >= kurs) return { rrr: null, blad: 'Stop-Loss jest na poziomie kursu albo powyżej — zadziałałby natychmiast.' };
  if (tp <= kurs) return { rrr: null, blad: 'Take-Profit jest na poziomie kursu albo poniżej — zadziałałby natychmiast.' };
  return { rrr: (tp - kurs) / (kurs - sl), blad: null };
}

/** Prog liczony od AKTUALNEGO kursu; bez kursu nie ma progu (nie podstawiamy ceny zakupu). */
export function progOdKursu(kurs: number | null, procent: number, kierunek: 'SL' | 'TP'): number | null {
  if (kurs === null || !(kurs > 0) || !Number.isFinite(procent)) return null;
  return kierunek === 'SL' ? kurs * (1 - procent / 100) : kurs * (1 + procent / 100);
}
