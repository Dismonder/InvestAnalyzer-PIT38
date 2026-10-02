import { TaxYearSummary, TaxRealizedGain, DividendTaxItem, Transaction, BrokerAccount } from '../types';
import { zakodujKomorkeCsv } from '../../shared/clientExport';

const SEPARATOR = ';';

// Kazda komorka przechodzi przez jedno kodowanie: neutralizacja formul i cytowanie.
const komorka = (wartosc: unknown): string => zakodujKomorkeCsv(wartosc, SEPARATOR);
const wiersz = (komorki: unknown[]): string => komorki.map(komorka).join(SEPARATOR);

export function exportTransactionsCSV(
  transactions: Transaction[],
  accounts: BrokerAccount[],
  filename: string = 'transakcje_eksport.csv'
) {
  downloadBlob(zbudujCsvTransakcji(transactions, accounts), filename, 'text/csv;charset=utf-8;');
}

export function zbudujCsvTransakcji(transactions: Transaction[], accounts: BrokerAccount[]): string {
  const headers = [
    'ID',
    'Konto Maklerskie',
    'Konto ID',
    'Ticker / Symbol',
    'Nazwa Aktywa',
    'Kategoria',
    'Typ Operacji',
    'Data Transakcji',
    'Ilość (Sztuki)',
    'Cena Jednostkowa',
    'Waluta',
    'Prowizja',
    'Waluta Prowizji',
    'Stawka podatku u źródła (%)',
    'Kwota podatku u źródła',
    'Notatki',
  ];

  const rows = transactions.map((t) => {
    const acc = accounts.find((a) => a.id === t.accountId);
    return [
      t.id,
      acc ? acc.name : t.accountId,
      t.accountId,
      t.ticker,
      t.name || '',
      t.category,
      t.type,
      t.date,
      t.quantity.toString().replace('.', ','),
      t.pricePerUnit.toString().replace('.', ','),
      t.currency,
      t.commission.toString().replace('.', ','),
      t.commissionCurrency,
      // Stawka i kwota osobno: sama stawka gubiła pobraną kwotę z wyciągu (1,44 zamiast 1,50 ze stawki).
      t.foreignTaxRate === undefined ? '' : t.foreignTaxRate.toString().replace('.', ','),
      t.foreignTaxAmount === undefined ? '' : t.foreignTaxAmount.toString().replace('.', ','),
      t.notes || '',
    ];
  });

  return '\uFEFF' + [wiersz(headers), ...rows.map(wiersz)].join('\r\n');
}

export interface OpcjeCsvZyskow {
  /** Widoczna pierwsza linia pliku, np. ostrzezenie o niegotowym rozliczeniu. */
  adnotacja?: string;
}

export function exportRealizedGainsCSV(
  gains: TaxRealizedGain[],
  summary: TaxYearSummary,
  accounts: BrokerAccount[],
  filename: string = 'rozliczenie_pit38_szczegoly.csv',
  opcje: OpcjeCsvZyskow = {},
) {
  downloadBlob(zbudujCsvZyskow(gains, summary, accounts, opcje), filename, 'text/csv;charset=utf-8;');
}

export function zbudujCsvZyskow(
  gains: TaxRealizedGain[],
  summary: TaxYearSummary,
  accounts: BrokerAccount[],
  opcje: OpcjeCsvZyskow = {},
): string {
  // Przecinek dziesietny w calym pliku. Wiersze mialy go od poczatku, a
  // podsumowanie kropke - arkusz w polskich ustawieniach czytal wtedy kwoty
  // z naglowka jako tekst i nie dalo sie ich zsumowac.
  const kwota = (wartosc: number): string => wartosc.toFixed(2).replace('.', ',');

  const summaryHeader = [
    ...(opcje.adnotacja ? [opcje.adnotacja] : []),
    `RAPORT PODATKOWY PIT-38 ZA ROK ${summary.year}`,
    `Przychód: ${summary.nieobliczony ? 'brak wyniku' : kwota(summary.revenuePLN)} PLN`,
    `Koszty KUP: ${summary.nieobliczony ? 'brak wyniku' : kwota(summary.costsPLN)} PLN`,
    `Dochód przed odliczeniem strat (poz. 28): ${summary.nieobliczony ? 'brak wyniku' : kwota(summary.incomePLN)} PLN`,
    `Strata: ${summary.nieobliczony ? 'brak wyniku' : kwota(summary.lossPLN)} PLN`,
    `Podstawa (poz. 31): ${summary.nieobliczony ? 'brak wyniku' : summary.taxBasePLN ?? 'brak wyniku'} PLN`,
    `Podatek 19% (poz. 33): ${summary.nieobliczony ? 'brak wyniku' : kwota(summary.taxBeforeCreditPLN ?? summary.taxDuePLN)} PLN`,
    `Podatek należny (poz. 35): ${summary.nieobliczony ? 'brak wyniku' : summary.taxDuePLN} PLN`,
  ].join('\r\n');

  const headers = [
    'Lp',
    'Ticker',
    'Nazwa',
    'Kategoria',
    'Konto Maklerskie',
    'Data Sprzedaży',
    'Ilość Sprzedana',
    'Cena Sprzedaży Waluta',
    'Waluta Sprzedaży',
    'Kurs NBP Sprzedaży',
    'Tabela NBP Sprzedaży',
    'Prowizja Sprzedaży PLN',
    'Przychód PLN',
    'Koszt Zakupu KUP PLN',
    'Zysk/Strata PLN',
    'Rok Podatkowy',
  ];

  const rows = gains.map((g, i) => {
    const acc = accounts.find((a) => a.id === g.accountId);
    return [
      (i + 1).toString(),
      g.ticker,
      g.name,
      g.category,
      acc ? acc.name : g.accountId,
      g.sellDate,
      g.sellQuantity.toString().replace('.', ','),
      g.sellPricePerUnit > 0 ? g.sellPricePerUnit.toString().replace('.', ',') : '',
      g.sellCurrency,
      g.sellExchangeRate > 0 ? g.sellExchangeRate.toString().replace('.', ',') : '',
      g.sellExchangeTable,
      g.sellCommissionPLN.toFixed(2).replace('.', ','),
      g.revenuePLN.toFixed(2).replace('.', ','),
      g.costPLN.toFixed(2).replace('.', ','),
      g.profitPLN.toFixed(2).replace('.', ','),
      g.taxYear.toString(),
    ];
  });

  return '\uFEFF' + summaryHeader + '\r\n\r\n' + [wiersz(headers), ...rows.map(wiersz)].join('\r\n');
}

function downloadBlob(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
