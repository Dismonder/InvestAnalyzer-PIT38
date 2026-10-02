/** Skladnik rachunku u brokera: gotowka albo wartosc rynkowa pozycji, zawsze z waluta. */
export interface SkladnikRachunku {
  waluta: string;
  kwota: number | null;
}

export interface SumaRachunku {
  /** Suma w PLN wg kursow NBP; `null`, gdy nic nie dalo sie przeliczyc. */
  sumaPLN: number | null;
  /** Rownowartosc w USD wg tego samego kursu NBP; `null` bez kursu USD. */
  sumaUSD: number | null;
  wgWaluty: Array<{ waluta: string; kwota: number; kursPLN: number | null }>;
  /** Waluty bez kursu NBP - ich kwoty NIE weszly do sumy. */
  bezKursu: string[];
  /** Skladniki bez kwoty (broker jej nie podal). */
  bezKwoty: number;
}

/**
 * Laczna wartosc rachunku. Kurs brokera (`currval`) ma nieznana walute bazowa,
 * wiec przeliczamy oficjalnym kursem srednim NBP. Waluta bez kursu nie jest
 * liczona po 1:1 - zostaje wymieniona jako nieujeta.
 */
export function sumaRachunkuBrokera(skladniki: SkladnikRachunku[], kursyPLN: Record<string, number | null | undefined>): SumaRachunku {
  const kwoty = new Map<string, number>();
  let bezKwoty = 0;
  for (const s of skladniki) {
    const waluta = String(s.waluta ?? '').trim().toUpperCase();
    if (typeof s.kwota !== 'number' || !Number.isFinite(s.kwota) || !/^[A-Z]{3}$/.test(waluta)) {
      bezKwoty += 1;
      continue;
    }
    kwoty.set(waluta, (kwoty.get(waluta) ?? 0) + s.kwota);
  }
  const kurs = (waluta: string): number | null => {
    if (waluta === 'PLN') return 1;
    const k = kursyPLN[waluta];
    return typeof k === 'number' && k > 0 ? k : null;
  };
  const wgWaluty = [...kwoty.entries()].map(([waluta, kwota]) => ({ waluta, kwota, kursPLN: kurs(waluta) }));
  const przeliczalne = wgWaluty.filter((w) => w.kursPLN !== null);
  const sumaPLN = przeliczalne.length > 0 ? przeliczalne.reduce((suma, w) => suma + w.kwota * (w.kursPLN as number), 0) : null;
  const kursUSD = kurs('USD');
  return {
    sumaPLN,
    sumaUSD: sumaPLN !== null && kursUSD ? sumaPLN / kursUSD : null,
    wgWaluty,
    bezKursu: wgWaluty.filter((w) => w.kursPLN === null && w.kwota !== 0).map((w) => w.waluta),
    bezKwoty,
  };
}
