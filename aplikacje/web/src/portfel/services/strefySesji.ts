export type SesjaPunktu = 'PRE' | 'REGULAR' | 'POST' | 'OVERNIGHT' | null | undefined;

export interface StrefaSesji {
  sesja: 'PRE' | 'POST' | 'OVERNIGHT';
  /** Etykiety osi X (pole `date`) pierwszej i ostatniej swiecy strefy. */
  od: string;
  do: string;
}

/**
 * Ciagle odcinki handlu poza sesja regularna. Wykres cieniuje je, zeby ruch
 * z pre-marketu nie wygladal jak ruch z sesji glownej.
 */
export function wyznaczStrefySesji(punkty: Array<{ date: string; session?: SesjaPunktu }>): StrefaSesji[] {
  const strefy: StrefaSesji[] = [];
  let biezaca: StrefaSesji | null = null;
  for (const punkt of punkty) {
    const sesja = punkt.session === 'PRE' || punkt.session === 'POST' || punkt.session === 'OVERNIGHT' ? punkt.session : null;
    if (sesja && biezaca && biezaca.sesja === sesja) {
      biezaca.do = punkt.date;
    } else {
      if (biezaca) strefy.push(biezaca);
      biezaca = sesja ? { sesja, od: punkt.date, do: punkt.date } : null;
    }
  }
  if (biezaca) strefy.push(biezaca);
  return strefy;
}
