import type { CurrencyCode, LiveMarketQuote, OpenPosition } from '../types';
import type { KursyWycenyPLN } from './kursyNbp';
import { formatLiczba } from './nbpService';

/**
 * Wycena otwartych pozycji: jedno miejsce zamiast dwoch.
 *
 * Ten sam rachunek stal wczesniej osobno w PortfolioDashboard i w
 * RealTimeCharts, i w obu wygladal podobnie, ale nie tak samo - dashboard
 * pomijal w sumach pozycje bez kursu NBP, a wykresy wliczaly ja jako zero
 * i zanizaly jej udzial. Tu obowiazuje jedna regula: **brak notowania albo
 * brak kursu to brak wyceny**, a nie wycena po cenie zakupu ani po zerze.
 */

/** Cena pozycji podana przez brokera (adapter Freedom24, tylko odczyt). */
export interface CenaBrokera {
  ticker: string;
  price: number | null;
  currency: string;
}

export type ZrodloCeny = 'NOTOWANIE' | 'BROKER';

function bazaTickera(ticker: string): string {
  return ticker.trim().toUpperCase().split('.')[0];
}

export interface PozycjaZWycena extends OpenPosition {
  /** Skad jest cena; `null`, gdy zadne zrodlo jej nie podalo. */
  zrodloCeny: ZrodloCeny | null;
  /** Waluta ceny - zawsze pokazywana przy kwocie. `null` bez ceny. */
  walutaCeny: CurrencyCode | null;
  /** Czy zrodlo notowan podało cene tego instrumentu. */
  maNotowanie: boolean;
  /** Czy jest kurs NBP dla waluty pozycji (dla PLN zawsze). */
  maKursWaluty: boolean;
  /** Czy pozycje wolno wliczyc do sum i udzialow. */
  maWycene: boolean;
  quote?: LiveMarketQuote;
  kursPLN: number;
  currentPriceOrig: number;
  currentPricePLN: number;
  currentValuePLN: number;
  costOrig: number | null;
  valueOrig: number;
  unrealizedOrig: number | null;
  unrealizedPctOrig: number | null;
  fxImpactPLN: number | null;
  unrealizedPLN: number;
  unrealizedPct: number;
  change24h: number | null;
  dailyPnLPLN: number | null;
}

function kursDlaWaluty(waluta: CurrencyCode, kursy: KursyWycenyPLN): number | null {
  if (waluta === 'PLN') return 1;
  const kurs = kursy[waluta];
  return typeof kurs === 'number' && kurs > 0 ? kurs : null;
}

export function wycenPozycje(
  pozycje: readonly OpenPosition[],
  quotes: Record<string, LiveMarketQuote>,
  kursy: KursyWycenyPLN,
  cenyBrokera: readonly CenaBrokera[] = []
): PozycjaZWycena[] {
  // Cena z rachunku brokera jest zrodlem ZAPASOWYM: uzywana tylko wtedy, gdy
  // dostawca notowan nie zna instrumentu. Wymaga ceny > 0 i waluty.
  // Najpierw pelny ticker (VOD.L i VOD.US to dwa rynki, dwie ceny), baza tickera
  // dopiero wtedy, gdy wskazuje dokladnie jeden wpis brokera.
  const brokerWgTickera = new Map<string, { price: number; currency: CurrencyCode }>();
  const brokerWgBazy = new Map<string, { ticker: string; cena: { price: number; currency: CurrencyCode } }>();
  const wpisowNaBaze = new Map<string, number>();
  for (const cena of cenyBrokera) {
    const baza = bazaTickera(cena.ticker);
    wpisowNaBaze.set(baza, (wpisowNaBaze.get(baza) ?? 0) + 1);
    const waluta = (cena.currency || '').trim().toUpperCase();
    if (typeof cena.price === 'number' && Number.isFinite(cena.price) && cena.price > 0 && /^[A-Z]{3}$/.test(waluta)) {
      const wpis = { price: cena.price, currency: waluta as CurrencyCode };
      brokerWgTickera.set(cena.ticker.trim().toUpperCase(), wpis);
      brokerWgBazy.set(baza, { ticker: cena.ticker.trim(), cena: wpis });
    }
  }
  const cenaBrokera = (ticker: string) => {
    const pelny = brokerWgTickera.get(ticker.trim().toUpperCase());
    if (pelny) return pelny;
    // Baza laczy tylko zapis z rynkiem z zapisem bez rynku (VOD <-> VOD.US). Dwa rozne
    // sufiksy (VOD.L, VOD.US) to dwa rynki - cena jednego nie wycenia drugiego.
    const baza = bazaTickera(ticker);
    const wpis = wpisowNaBaze.get(baza) === 1 ? brokerWgBazy.get(baza) : undefined;
    return wpis && (!ticker.includes('.') || !wpis.ticker.includes('.')) ? wpis.cena : undefined;
  };
  return pozycje.map((pos) => {
    const notowanieDostawcy = quotes[pos.ticker.toUpperCase()];
    const maNotowanieDostawcy = typeof notowanieDostawcy?.price === 'number' && notowanieDostawcy.price > 0;
    const zBrokera = maNotowanieDostawcy ? undefined : cenaBrokera(pos.ticker);
    const zrodloCeny: ZrodloCeny | null = maNotowanieDostawcy ? 'NOTOWANIE' : zBrokera ? 'BROKER' : null;
    // Cena brokera nie niesie zmiany dziennej - to pole zostaje puste.
    const quote: LiveMarketQuote | undefined = maNotowanieDostawcy
      ? notowanieDostawcy
      : zBrokera
        ? ({ ticker: pos.ticker, price: zBrokera.price, currency: zBrokera.currency } as unknown as LiveMarketQuote)
        : notowanieDostawcy;
    // Brak notowania to brak wyceny, a nie wycena po cenie zakupu. Podstawiona
    // cena nabycia daje wynik 0 zl i zmiane 0% - wyglada jak spokojna sesja,
    // a znaczy "nie wiemy, ile to dzis warte".
    const maNotowanie = typeof quote?.price === 'number' && quote.price > 0;
    const cenaNabycia = typeof pos.avgBuyPrice === 'number' && Number.isFinite(pos.avgBuyPrice)
      ? pos.avgBuyPrice
      : 0;
    const currentPriceOrig = maNotowanie ? quote.price : cenaNabycia;

    // Kurs bierze sie z waluty NOTOWANIA, nie z waluty zapisanej przy pozycji.
    // Notowanie tego samego papieru bywa podane w innej walucie niz ta,
    // w ktorej zapisano zakup - przeliczenie ceny w dolarach kursem euro dawalo
    // wartosc zawyzona o kilkanascie procent.
    const walutaWyceny = maNotowanie ? quote.currency : pos.currency;
    const kursLubBrak = kursDlaWaluty(walutaWyceny, kursy);
    const maKursWaluty = kursLubBrak !== null;
    const maWycene = maNotowanie && maKursWaluty;
    const kursPLN = kursLubBrak ?? 0;

    const currentPricePLN = currentPriceOrig * kursPLN;
    const currentValuePLN = pos.totalQuantity * currentPricePLN;
    const unrealizedPLN = maWycene ? currentValuePLN - pos.totalCostPLN : 0;
    const unrealizedPct =
      maWycene && pos.totalCostPLN > 0 ? (unrealizedPLN / pos.totalCostPLN) * 100 : 0;

    // Wynik "w walucie instrumentu" ma sens tylko wtedy, gdy notowanie jest
    // w tej samej walucie co zapisany zakup.
    const tasamaWaluta = maNotowanie && quote.currency === pos.currency;
    const partie = pos.lots ?? [];
    const prowizjeWWalucieZgodne = partie.every((lot) =>
      lot.commissionOrig === undefined || lot.commissionOrig === 0 || lot.commissionCurrency === lot.currency
    );
    const maProwizjePartii = partie.some((lot) => lot.commissionOrig !== undefined);
    const maProwizjeNieprzeliczalne = partie.some((lot) =>
      lot.commissionOrig !== undefined && lot.commissionOrig !== 0 && lot.commissionCurrency !== lot.currency
    );
    const kosztZPartii = maProwizjePartii && prowizjeWWalucieZgodne
      ? partie.reduce((suma, lot) => suma + lot.remainingQty * lot.pricePerUnit + (lot.commissionOrig ?? 0), 0)
      : null;
    const costOrig = maProwizjeNieprzeliczalne
      ? null
      : kosztZPartii ?? pos.totalQuantity * cenaNabycia;
    const valueOrig = pos.totalQuantity * currentPriceOrig;
    const unrealizedOrig = maProwizjeNieprzeliczalne
      ? null
      : tasamaWaluta && costOrig !== null ? valueOrig - costOrig : 0;
    const unrealizedPctOrig = maProwizjeNieprzeliczalne
      ? null
      : tasamaWaluta && costOrig !== null && costOrig > 0 ? (unrealizedOrig / costOrig) * 100 : 0;
    const fxImpactPLN = maWycene && unrealizedOrig !== null ? unrealizedPLN - unrealizedOrig * kursPLN : null;

    const zmiana = quote?.changePercent24h;
    const change24h = maNotowanie && zrodloCeny === 'NOTOWANIE' && typeof zmiana === 'number' && Number.isFinite(zmiana)
      ? zmiana : null;
    const dailyPnLPLN = maWycene && change24h !== null && 100 + change24h > 0
      ? (currentValuePLN * change24h) / (100 + change24h) : null;

    return {
      ...pos,
      zrodloCeny,
      walutaCeny: maNotowanie && quote?.currency ? (quote.currency as CurrencyCode) : null,
      maNotowanie,
      maKursWaluty,
      maWycene,
      quote,
      kursPLN,
      currentPriceOrig,
      currentPricePLN,
      currentValuePLN,
      costOrig,
      valueOrig,
      unrealizedOrig,
      unrealizedPctOrig,
      fxImpactPLN,
      unrealizedPLN,
      unrealizedPct,
      change24h,
      dailyPnLPLN,
    };
  });
}

export interface PodsumowanieWyceny {
  wycenione: PozycjaZWycena[];
  liczbaBezWyceny: number;
  liczbaBezNotowania: number;
  liczbaBezKursu: number;
  /** Wartosc rynkowa wycenionych pozycji; `null`, gdy zadna nie ma notowania. */
  wartoscPLN: number | null;
  /**
   * Zainwestowany kapital WSZYSTKICH pozycji. Koszt zakupu jest znany
   * z transakcji i nie zalezy od tego, czy dzis jest notowanie - liczony
   * tylko z wycenionych pokazywal "0,00 zl" przy portfelu za 132 tys.
   */
  kosztPLN: number;
  /** Koszt samych wycenionych pozycji - podstawa wyniku niezrealizowanego. */
  kosztWycenionychPLN: number;
  /** `null`, gdy nie ma czego porownac (zadna pozycja bez notowania). */
  wynikPLN: number | null;
  wynikProcent: number | null;
  zmianaDziennaPLN: number | null;
  zmianaDziennaProcent: number | null;
}

/**
 * Sumy portfela.
 *
 * Wartosc rynkowa i wynik licza sie wylacznie z pozycji, ktore maja wycene -
 * gdyby koszt obejmowal pozycje bez wyceny, a wartosc nie, roznica
 * pokazywalaby strate, ktorej nie ma.
 *
 * Zainwestowany kapital jest inny: koszt zakupu znamy z transakcji niezaleznie
 * od tego, czy dzis jest notowanie. Liczony tylko z wycenionych dawal
 * "Zainwestowany Kapital (KUP): 0,00 zl" obok czterech pozycji za 132 tys. zl,
 * a razem z nim zerowy wynik i zielone "+0.00% zwrotu" nad brakiem danych.
 */
export function podsumujWycene(pozycje: readonly PozycjaZWycena[]): PodsumowanieWyceny {
  const wycenione = pozycje.filter((pozycja) => pozycja.maWycene);
  const saWyceny = wycenione.length > 0;
  const wartoscPLN = saWyceny
    ? wycenione.reduce((suma, pozycja) => suma + pozycja.currentValuePLN, 0)
    : null;
  const kosztPLN = pozycje.reduce((suma, pozycja) => suma + pozycja.totalCostPLN, 0);
  const kosztWycenionychPLN = wycenione.reduce((suma, pozycja) => suma + pozycja.totalCostPLN, 0);
  const wynikPLN = wartoscPLN === null ? null : wartoscPLN - kosztWycenionychPLN;
  const zeZnanaZmiana = wycenione.filter((pozycja) => pozycja.dailyPnLPLN !== null);
  const zmianaDziennaPLN = zeZnanaZmiana.length > 0
    ? zeZnanaZmiana.reduce((suma, pozycja) => suma + (pozycja.dailyPnLPLN as number), 0)
    : null;
  const wartoscZeZnanaZmiana = zeZnanaZmiana.reduce((suma, pozycja) => suma + pozycja.currentValuePLN, 0);

  return {
    wycenione,
    liczbaBezWyceny: pozycje.length - wycenione.length,
    liczbaBezNotowania: pozycje.filter((pozycja) => !pozycja.maNotowanie).length,
    liczbaBezKursu: pozycje.filter((pozycja) => pozycja.maNotowanie && !pozycja.maKursWaluty).length,
    wartoscPLN,
    kosztPLN,
    kosztWycenionychPLN,
    wynikPLN,
    wynikProcent:
      wynikPLN === null || kosztWycenionychPLN <= 0 ? null : (wynikPLN / kosztWycenionychPLN) * 100,
    zmianaDziennaPLN,
    zmianaDziennaProcent:
      zmianaDziennaPLN === null || wartoscZeZnanaZmiana - zmianaDziennaPLN <= 0
        ? null
        : (zmianaDziennaPLN / (wartoscZeZnanaZmiana - zmianaDziennaPLN)) * 100,
  };
}

/** Udzial pozycji w wycenionej czesci portfela; `null` znaczy "nie wiem", nie 0%. */
export function udzialWPortfelu(
  maWycene: boolean,
  wartoscPozycjiPLN: number,
  wartoscPortfelaPLN: number | null | undefined
): string | null {
  if (!maWycene || typeof wartoscPortfelaPLN !== 'number' || !(wartoscPortfelaPLN > 0)) return null;
  return formatLiczba((wartoscPozycjiPLN / wartoscPortfelaPLN) * 100, 1);
}

/** Przeliczenie sumy na inna walute; `null`, gdy brak sumy albo kursu. */
export function sumaWWalucie(wartoscPLN: number | null | undefined, kurs: number | null | undefined): number | null {
  if (typeof wartoscPLN !== 'number' || typeof kurs !== 'number' || !(kurs > 0)) return null;
  return wartoscPLN / kurs;
}

/** Zdanie do pokazania pod suma, gdy czesc pozycji nie ma wyceny. */
export function opiszBrakiWyceny(podsumowanie: PodsumowanieWyceny): string | null {
  const { liczbaBezWyceny, liczbaBezNotowania, liczbaBezKursu } = podsumowanie;
  if (liczbaBezWyceny === 0) return null;
  // "Nie wyceniono N pozycji" - po przeczeniu dopelniacz dla kazdego N.
  // Powod odmienia sie przez liczbe: jedna pozycja albo kilka.
  const jedna = liczbaBezWyceny === 1;
  const powod =
    liczbaBezNotowania > 0 && liczbaBezKursu > 0
      ? `${liczbaBezNotowania} bez notowania, ${liczbaBezKursu} bez kursu NBP`
      : liczbaBezNotowania > 0
        ? (jedna ? 'brak notowania instrumentu' : 'brak notowań tych instrumentów')
        : (jedna ? 'brak kursu NBP dla jej waluty' : 'brak kursu NBP dla ich walut');
  return `Kwota obejmuje ${podsumowanie.wycenione.length} z ${podsumowanie.wycenione.length + liczbaBezWyceny} pozycji. Nie wyceniono ${liczbaBezWyceny} pozycji — ${powod}.`;
}
