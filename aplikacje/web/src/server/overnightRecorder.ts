import fs from 'node:fs';
import path from 'node:path';

/**
 * Sesja nocna rynku USA (Blue Ocean ATS, 20:00-04:00 czasu Nowego Jorku).
 *
 * Zadne bezplatne zrodlo nie oddaje historii swiec z tej sesji: dostawca
 * notowan i `getHloc` brokera koncza sie na 04:00-20:00. Dostawca podaje za to
 * biezaca cene "calodobowa" (`fulldayPrice`). Serwer zapisuje ja co minute
 * w godzinach sesji nocnej i sam sklada z probek swiece - wglad, nie handel.
 */

export interface ProbkaNocna {
  /** Znacznik czasu w sekundach (UTC). */
  t: number;
  /** Cena w walucie instrumentu. */
  p: number;
}

export interface SwiecaNocna {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  liczbaProbek: number;
}

const STREFA_GIELDY = 'America/New_York';

/** Godzina i dzien tygodnia w Nowym Jorku - z uwzglednieniem czasu letniego. */
function czasNowegoJorku(znacznikMs: number): { godzina: number; dzienTygodnia: number } {
  const czesci = new Intl.DateTimeFormat('en-US', { timeZone: STREFA_GIELDY, hour: 'numeric', hourCycle: 'h23', weekday: 'short' }).formatToParts(
    new Date(znacznikMs),
  );
  const godzina = Number(czesci.find((c) => c.type === 'hour')?.value);
  const dzien = czesci.find((c) => c.type === 'weekday')?.value ?? '';
  return { godzina, dzienTygodnia: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(dzien) };
}

/**
 * Sesja nocna trwa od niedzieli 20:00 do piatku 04:00 czasu NY: wieczory
 * niedziela-czwartek i wczesne poranki poniedzielnik-piatek.
 */
export function czySesjaNocna(znacznikMs: number): boolean {
  const { godzina, dzienTygodnia } = czasNowegoJorku(znacznikMs);
  if (!Number.isFinite(godzina) || dzienTygodnia < 0) return false;
  if (godzina >= 20) return dzienTygodnia >= 0 && dzienTygodnia <= 4;
  if (godzina < 4) return dzienTygodnia >= 1 && dzienTygodnia <= 5;
  return false;
}

/** Sklada probki w swiece o podanym interwale. Probki spoza sesji nocnej i bez ceny odpadaja. */
export function swieceZProbek(probki: ProbkaNocna[], interwalSekundy: number): SwiecaNocna[] {
  const kubelki = new Map<number, SwiecaNocna>();
  const posortowane = [...probki]
    .filter((x) => Number.isFinite(x?.t) && Number.isFinite(x?.p) && x.p > 0 && czySesjaNocna(x.t * 1000))
    .sort((a, b) => a.t - b.t);
  for (const probka of posortowane) {
    const start = Math.floor(probka.t / interwalSekundy) * interwalSekundy;
    const swieca = kubelki.get(start);
    if (!swieca) {
      kubelki.set(start, { timestamp: start, open: probka.p, high: probka.p, low: probka.p, close: probka.p, liczbaProbek: 1 });
    } else {
      swieca.high = Math.max(swieca.high, probka.p);
      swieca.low = Math.min(swieca.low, probka.p);
      swieca.close = probka.p;
      swieca.liczbaProbek += 1;
    }
  }
  return [...kubelki.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function nazwaPliku(ticker: string): string | null {
  const bezpieczny = ticker.trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9._-]{0,20}$/.test(bezpieczny) ? `${bezpieczny}.jsonl` : null;
}

export const MAX_OBSERWOWANYCH = 50;
const OKRES_OBSERWACJI_MS = 7 * 86_400_000;

export class RejestratorNocny {
  private readonly obserwowane = new Map<string, number>();
  private zegar: ReturnType<typeof setInterval> | null = null;
  private ostatniePrzycinanie: number | null = null;

  constructor(
    private readonly katalog: string,
    private readonly cenaCalodobowa: (ticker: string) => Promise<number | null>,
    private readonly teraz: () => number = () => Date.now(),
    private readonly limitObserwowanych = MAX_OBSERWOWANYCH,
  ) {}

  /**
   * Wykres zglasza walor, ktory uzytkownik oglada; obserwujemy go przez 7 dni od ostatniego wejscia.
   * GET historii nie ma kontroli Origin, wiec mapa ma limit: po zapelnieniu (po
   * usunieciu wygaslych) nowy walor jest odrzucany, a juz obserwowane odswieza sie dalej.
   */
  obserwuj(ticker: string): boolean {
    const nazwa = nazwaPliku(ticker);
    if (!nazwa) return false;
    const klucz = nazwa.slice(0, -'.jsonl'.length);
    const teraz = this.teraz();
    if (!this.obserwowane.has(klucz) && this.obserwowane.size >= this.limitObserwowanych) {
      for (const [obserwowany, ostatnio] of [...this.obserwowane.entries()]) {
        if (teraz - ostatnio > OKRES_OBSERWACJI_MS) this.obserwowane.delete(obserwowany);
      }
      if (this.obserwowane.size >= this.limitObserwowanych) return false;
    }
    this.obserwowane.set(klucz, teraz);
    return true;
  }

  start(coIleMs = 60_000): void {
    if (this.zegar) return;
    this.przytnijBezBledu();
    this.zegar = setInterval(() => {
      void this.probkuj().catch((error: unknown) => {
        const code = (error as NodeJS.ErrnoException)?.code || 'UNKNOWN';
        console.error(`Rejestrator nocny: nie udało się zapisać próbki (${code}).`);
      });
    }, coIleMs);
    if (typeof this.zegar.unref === 'function') this.zegar.unref();
  }

  stop(): void {
    if (this.zegar) clearInterval(this.zegar);
    this.zegar = null;
  }

  /** Jedna runda: poza sesja nocna nic nie robi, wiec w dzien nie generuje ruchu. */
  async probkuj(): Promise<number> {
    const teraz = this.teraz();
    if (this.ostatniePrzycinanie === null || teraz - this.ostatniePrzycinanie >= 86_400_000) this.przytnijBezBledu();
    if (!czySesjaNocna(teraz)) return 0;
    let zapisane = 0;
    for (const [ticker, ostatnio] of [...this.obserwowane.entries()]) {
      if (teraz - ostatnio > OKRES_OBSERWACJI_MS) {
        this.obserwowane.delete(ticker);
        continue;
      }
      const cena = await this.cenaCalodobowa(ticker).catch(() => null);
      if (typeof cena !== 'number' || !(cena > 0)) continue;
      fs.mkdirSync(this.katalog, { recursive: true });
      fs.appendFileSync(path.join(this.katalog, `${ticker}.jsonl`), `${JSON.stringify({ t: Math.floor(teraz / 1000), p: cena })}\n`);
      zapisane += 1;
    }
    return zapisane;
  }

  private przytnijBezBledu(): void {
    this.ostatniePrzycinanie = this.teraz();
    try {
      this.przytnij();
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException)?.code || 'UNKNOWN';
      console.error(`Rejestrator nocny: nie udało się przyciąć plików próbek (${code}).`);
    }
  }

  /**
   * Usuwa probki starsze niz okres obserwacji (7 dni), a pliki bez swiezych probek - w tym walorow
   * dawno nieobserwowanych - kasuje w calosci. Bez tego pliki rosly bez konca, a odczyt wczytuje caly plik.
   */
  przytnij(): void {
    if (!fs.existsSync(this.katalog)) return;
    const granica = Math.floor((this.teraz() - OKRES_OBSERWACJI_MS) / 1000);
    for (const wpis of fs.readdirSync(this.katalog, { withFileTypes: true })) {
      if (!wpis.isFile() || !wpis.name.endsWith('.jsonl') || !nazwaPliku(wpis.name.slice(0, -'.jsonl'.length))) continue;
      const plik = path.join(this.katalog, wpis.name);
      try {
        const wiersze = fs.readFileSync(plik, 'utf8').split('\n').filter((wiersz) => wiersz.trim());
        const zachowane = wiersze.filter((wiersz) => {
          try {
            const probka = JSON.parse(wiersz) as ProbkaNocna;
            return Number.isFinite(probka.t) && Number.isFinite(probka.p) && probka.t >= granica;
          } catch {
            return false;
          }
        });
        if (zachowane.length === wiersze.length && wiersze.length > 0) continue;
        if (zachowane.length === 0) {
          fs.rmSync(plik, { force: true });
          continue;
        }
        const tymczasowy = `${plik}.tmp`;
        fs.writeFileSync(tymczasowy, `${zachowane.join('\n')}\n`);
        fs.renameSync(tymczasowy, plik);
      } catch {
        // Jeden nieczytelny plik nie zatrzymuje przycinania pozostalych.
      }
    }
  }

  /** Probki z ostatnich `dni` dni; uszkodzone wiersze pliku sa pomijane. */
  odczytaj(ticker: string, dni = 7): ProbkaNocna[] {
    const nazwa = nazwaPliku(ticker);
    if (!nazwa) return [];
    const plik = path.join(this.katalog, nazwa);
    if (!fs.existsSync(plik)) return [];
    const granica = Math.floor(this.teraz() / 1000) - dni * 86_400;
    const probki: ProbkaNocna[] = [];
    for (const wiersz of fs.readFileSync(plik, 'utf8').split('\n')) {
      if (!wiersz.trim()) continue;
      try {
        const probka = JSON.parse(wiersz) as ProbkaNocna;
        if (Number.isFinite(probka.t) && Number.isFinite(probka.p) && probka.t >= granica) probki.push(probka);
      } catch {
        // Przerwany zapis (np. wylaczenie komputera w polowie wiersza).
      }
    }
    return probki;
  }
}
