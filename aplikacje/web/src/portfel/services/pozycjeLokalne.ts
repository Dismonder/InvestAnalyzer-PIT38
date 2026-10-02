/**
 * Pozycje portfela liczone w przegladarce - TYLKO dla wersji hostowanej (telefon),
 * ktora nie ma silnika Pythona. Silnik pozostaje jedyna droga rozliczenia PIT-38:
 * tutaj nie ma kwot formularza, dywidend ani sprzedazy do podatku - podsumowanie
 * roku zostaje "nieobliczone" (kreska), a rejestr pokazuje transakcje lokalne.
 *
 * Rachunek: FIFO w obrebie pary ticker + rachunek (jak silnik), koszt w PLN po
 * kursie NBP T-1 z API hostingu (ten sam, ktorego uzywa serwer). Partia bez kursu
 * (brak sieci) wchodzi z kosztem 0 i jest liczona w `pominieteBezDanych`, zeby
 * pulpit mogl powiedziec, ze kapital jest niepelny.
 */
import type { BrokerAccount, CurrencyCode, OpenLotDetail, OpenPosition, Transaction } from '../types';
import { getNBPRateForDate } from './nbpService';

interface Kurs { mid: number; effectiveDate: string; table: string }

interface PartiaOtwarta {
  tx: Transaction;
  pozostalo: number;
  kurs: Kurs | null;
  prowizjaPLN: number;
}

export interface WynikPozycjiLokalnych {
  openPositions: OpenPosition[];
  unmatchedSalesWarnings: { transaction: Transaction; missingQuantity: number }[];
  /** Partie bez kursu NBP (koszt PLN niepelny). */
  pominieteBezDanych: number;
}

export type PobierzKurs = (currency: CurrencyCode, date: string) => Promise<Kurs | null>;

async function kursTransakcji(tx: Transaction, pobierz: PobierzKurs, pamiec: Map<string, Promise<Kurs | null>>): Promise<Kurs | null> {
  if (typeof tx.customExchangeRate === 'number' && tx.customExchangeRate > 0) {
    return { mid: tx.customExchangeRate, effectiveDate: tx.customExchangeRateDate || tx.date, table: tx.customExchangeRateTable || 'A' };
  }
  const klucz = `${tx.currency}|${tx.date.slice(0, 10)}`;
  if (!pamiec.has(klucz)) pamiec.set(klucz, pobierz(tx.currency, tx.date).catch(() => null));
  return pamiec.get(klucz)!;
}

async function kursProwizji(tx: Transaction, kursWaluty: Kurs | null, pobierz: PobierzKurs, pamiec: Map<string, Promise<Kurs | null>>): Promise<Kurs | null> {
  const prowizja = tx.commission ?? 0;
  if (!(prowizja > 0)) return { mid: 0, effectiveDate: tx.date, table: 'A' };
  const waluta = tx.commissionCurrency || tx.currency;
  if (waluta === tx.currency) return kursWaluty;
  const klucz = `${waluta}|${tx.date.slice(0, 10)}`;
  if (!pamiec.has(klucz)) pamiec.set(klucz, pobierz(waluta, tx.date).catch(() => null));
  return pamiec.get(klucz)!;
}

export async function policzPozycjeLokalnie(
  transactions: readonly Transaction[],
  pobierz: PobierzKurs = getNBPRateForDate,
): Promise<WynikPozycjiLokalnych> {
  const posortowane = [...transactions]
    .filter((tx) => tx.type === 'BUY' || tx.type === 'SELL')
    .sort((a, b) => a.date.localeCompare(b.date));
  const pamiec = new Map<string, Promise<Kurs | null>>();
  const partie = new Map<string, PartiaOtwarta[]>();
  const unmatchedSalesWarnings: WynikPozycjiLokalnych['unmatchedSalesWarnings'] = [];
  let pominieteBezDanych = 0;

  for (const tx of posortowane) {
    const klucz = `${tx.ticker}|${tx.accountId}`;
    if (tx.type === 'BUY') {
      const kurs = await kursTransakcji(tx, pobierz, pamiec);
      const kursProw = await kursProwizji(tx, kurs, pobierz, pamiec);
      if (!kurs) pominieteBezDanych += 1;
      const lista = partie.get(klucz) ?? [];
      lista.push({ tx, pozostalo: tx.quantity, kurs, prowizjaPLN: (tx.commission ?? 0) * (kursProw?.mid ?? 0) });
      partie.set(klucz, lista);
      continue;
    }
    let potrzeba = tx.quantity;
    const lista = partie.get(klucz) ?? [];
    while (potrzeba > 0.000001 && lista.length > 0) {
      const partia = lista[0];
      const zdjete = Math.min(potrzeba, partia.pozostalo);
      partia.pozostalo -= zdjete;
      potrzeba -= zdjete;
      if (partia.pozostalo <= 0.000001) lista.shift();
    }
    if (potrzeba > 0.000001) unmatchedSalesWarnings.push({ transaction: tx, missingQuantity: potrzeba });
  }

  const openPositions: OpenPosition[] = [];
  for (const [klucz, lista] of partie) {
    const aktywne = lista.filter((p) => p.pozostalo > 0.000001);
    if (aktywne.length === 0) continue;
    const [ticker, accountId] = klucz.split('|');
    const lots: OpenLotDetail[] = aktywne.map((p) => {
      const udzial = p.tx.quantity > 0 ? p.pozostalo / p.tx.quantity : 0;
      const kursMid = p.kurs?.mid ?? 0;
      return {
        buyTransactionId: p.tx.id,
        buyDate: p.tx.date.slice(0, 10),
        remainingQty: p.pozostalo,
        initialQty: p.tx.quantity,
        pricePerUnit: p.tx.pricePerUnit,
        currency: p.tx.currency,
        exchangeRate: kursMid,
        exchangeDate: p.kurs?.effectiveDate ?? '',
        exchangeTable: p.kurs ? p.kurs.table : 'BRAK',
        costPLN: p.pozostalo * p.tx.pricePerUnit * kursMid,
        commissionPLN: udzial * p.prowizjaPLN,
        commissionOrig: udzial * (p.tx.commission ?? 0),
        commissionCurrency: p.tx.commissionCurrency || p.tx.currency,
        accountId,
      };
    });
    const totalQuantity = lots.reduce((s, l) => s + l.remainingQty, 0);
    const totalCostPLN = lots.reduce((s, l) => s + l.costPLN + l.commissionPLN, 0);
    const wartoscWWalucie = lots.reduce((s, l) => s + l.remainingQty * l.pricePerUnit, 0);
    const pierwsza = aktywne[0].tx;
    openPositions.push({
      ticker,
      name: pierwsza.name || ticker,
      category: pierwsza.category,
      currency: pierwsza.currency,
      totalQuantity,
      avgBuyPrice: totalQuantity > 0 ? wartoscWWalucie / totalQuantity : 0,
      avgBuyPricePLN: totalQuantity > 0 ? totalCostPLN / totalQuantity : 0,
      totalCostPLN,
      openLotsCount: lots.length,
      lots,
      accountIds: [accountId],
    });
  }
  openPositions.sort((a, b) => b.totalCostPLN - a.totalCostPLN);
  return { openPositions, unmatchedSalesWarnings, pominieteBezDanych };
}

/**
 * Wynik w ksztalcie przebiegu silnika dla powloki portfela (PortfelApp) - bez kwot
 * podatkowych. `pustePodsumowanieRoku` daje rok "nieobliczony" (kreska zamiast zer).
 */
export async function policzPortfelLokalnie(
  transactions: readonly Transaction[],
  _accounts: readonly BrokerAccount[],
  options: { year: number; pobierz?: PobierzKurs },
) {
  const { pustePodsumowanieRoku } = await import('./engineBridge');
  const { openPositions, unmatchedSalesWarnings, pominieteBezDanych } = await policzPozycjeLokalnie(transactions, options.pobierz);
  const lata = new Set<number>([options.year]);
  for (const tx of transactions) {
    const rok = Number(tx.date.slice(0, 4));
    if (Number.isFinite(rok)) lata.add(rok);
  }
  const yearSummaries = new Map([...lata].sort((a, b) => b - a).map((rok) => [rok, pustePodsumowanieRoku(rok)] as const));
  return {
    realizedGains: [],
    dividends: [],
    yearSummaries,
    openPositions,
    unmatchedSalesWarnings,
    transakcjeSilnika: [...transactions],
    pominieteBezDanych,
    rokSilnika: options.year,
    gotoweDoZlozenia: null,
  };
}
