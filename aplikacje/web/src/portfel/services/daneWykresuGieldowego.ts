export type TypWykresu = 'SWIECE' | 'LINIA' | 'OBSZAR';
export type SesjaNaWykresie = 'PRE' | 'REGULAR' | 'POST' | 'OVERNIGHT' | null | undefined;

export interface PunktWykresu {
  /** Znacznik czasu w milisekundach (UTC). */
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  session?: SesjaNaWykresie;
}

/** Kolory swiec poza sesja regularna sa przygaszone - ruch z pre-marketu nie udaje ruchu z sesji glownej. */
const KOLORY_SESJI: Record<'PRE' | 'POST' | 'OVERNIGHT', { wzrost: string; spadek: string }> = {
  PRE: { wzrost: '#FBBF24', spadek: '#B45309' },
  POST: { wzrost: '#A78BFA', spadek: '#6D28D9' },
  OVERNIGHT: { wzrost: '#38BDF8', spadek: '#0369A1' },
};

export interface DaneWykresu {
  swiece: Array<{ time: number; open: number; high: number; low: number; close: number; color?: string; wickColor?: string }>;
  linia: Array<{ time: number; value: number }>;
  wolumen: Array<{ time: number; value: number; color: string }>;
  /** Dane do paska pod kursorem, po znaczniku czasu swiecy. */
  szczegoly: Map<number, SzczegolySwiecy>;
}

export interface SzczegolySwiecy {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** `null`, gdy zrodlo nie podalo wolumenu (np. swiece nocne z probek). */
  volume: number | null;
  session: SesjaNaWykresie;
  /** Zamkniecie poprzedniej swiecy; `null` dla pierwszej - zmiany wtedy nie liczymy. */
  poprzednieZamkniecie: number | null;
}

/**
 * Porzadkuje punkty dla biblioteki: rosnaco w czasie, bez powtorzonych
 * znacznikow (wymog biblioteki) i bez swiec z niepelna cena - takiej swiecy nie
 * uzupelniamy zerem ani poprzednim kursem.
 */
export function przygotujDaneWykresu(punkty: PunktWykresu[]): DaneWykresu {
  const wgCzasu = new Map<number, PunktWykresu>();
  for (const p of punkty) {
    if (![p?.timestamp, p?.open, p?.high, p?.low, p?.close].every((x) => typeof x === 'number' && Number.isFinite(x))) continue;
    if (p.close <= 0) continue;
    wgCzasu.set(Math.floor(p.timestamp / 1000), p);
  }
  const posortowane = [...wgCzasu.entries()].sort((a, b) => a[0] - b[0]);
  const dane: DaneWykresu = { swiece: [], linia: [], wolumen: [], szczegoly: new Map() };
  let poprzednieZamkniecie: number | null = null;
  for (const [time, p] of posortowane) {
    const wzrost = p.close >= p.open;
    const sesja = p.session === 'PRE' || p.session === 'POST' || p.session === 'OVERNIGHT' ? KOLORY_SESJI[p.session] : null;
    const kolor = sesja ? (wzrost ? sesja.wzrost : sesja.spadek) : undefined;
    dane.swiece.push({ time, open: p.open, high: p.high, low: p.low, close: p.close, ...(kolor ? { color: kolor, wickColor: kolor } : {}) });
    dane.linia.push({ time, value: p.close });
    dane.wolumen.push({ time, value: typeof p.volume === 'number' && p.volume > 0 ? p.volume : 0, color: wzrost ? 'rgba(16,185,129,0.35)' : 'rgba(239,68,68,0.35)' });
    dane.szczegoly.set(time, {
      timestamp: p.timestamp, open: p.open, high: p.high, low: p.low, close: p.close,
      volume: typeof p.volume === 'number' && p.volume > 0 ? p.volume : null,
      session: p.session ?? null,
      poprzednieZamkniecie,
    });
    poprzednieZamkniecie = p.close;
  }
  return dane;
}

/** Ile historii pokazac na starcie dla przycisku zakresu; starsza jest o przesuniecie w lewo. */
export function sekundyZakresu(zakres: string): number {
  const dzien = 86_400;
  switch (zakres) {
    case '1d': return dzien;
    case '5d': return 7 * dzien; // 5 sesji to 7 dni kalendarzowych
    case '1mo': return 31 * dzien;
    case '6mo': return 183 * dzien;
    case '1y': return 366 * dzien;
    default: return 31 * dzien;
  }
}

const NAZWY_SESJI: Record<string, string> = { PRE: 'pre-market', REGULAR: 'sesja', POST: 'after-hours', OVERNIGHT: 'overnight' };

/** Pasek szczegolow swiecy (HTML): data, sesja, O/H/L/C, zmiana do poprzedniego zamkniecia i wolumen. */
export function opisSwiecy(s: SzczegolySwiecy): string {
  const liczba = (v: number) => v.toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // Klasy zamiast stalych kolorow: odcienie 500 mialy na jasnej legendzie 2,5-3,8:1.
  const WZROST = 'text-emerald-700 dark:text-emerald-400';
  const SPADEK = 'text-rose-700 dark:text-rose-400';
  const kolor = s.close >= s.open ? WZROST : SPADEK;
  const pole = (etykieta: string, v: number) => `<span>${etykieta} <b class="${kolor}">${liczba(v)}</b></span>`;
  const data = new Date(s.timestamp).toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const czesci = [`<span>${data}${s.session && NAZWY_SESJI[s.session] ? ` · ${NAZWY_SESJI[s.session]}` : ''}</span>`,
    pole('O', s.open), pole('H', s.high), pole('L', s.low), pole('C', s.close)];
  if (s.poprzednieZamkniecie !== null && s.poprzednieZamkniecie > 0) {
    const zmiana = s.close - s.poprzednieZamkniecie;
    const procent = (zmiana / s.poprzednieZamkniecie) * 100;
    const znak = zmiana >= 0 ? '+' : '';
    czesci.push(`<span class="${zmiana >= 0 ? WZROST : SPADEK}">${znak}${liczba(zmiana)} (${znak}${liczba(procent)}%)</span>`);
  }
  czesci.push(`<span>Wolumen <b>${s.volume !== null ? s.volume.toLocaleString('pl-PL') : '—'}</b></span>`);
  return czesci.join('');
}
