/**
 * Generator PDF. Biblioteka jspdf wazy w paczce kilkaset kilobajtow i jest
 * potrzebna dopiero w chwili eksportu, wiec doladowujemy ja na zadanie -
 * statyczny import wciagal ja do pakietu startowego aplikacji.
 */
type ModulJsPdf = typeof import('jspdf')['default'];
type FunkcjaAutoTable = typeof import('jspdf-autotable')['default'];

let zaladowane: { jsPDF: ModulJsPdf; autoTable: FunkcjaAutoTable } | null = null;

async function zaladujGeneratorPdf() {
  if (!zaladowane) {
    const [modulPdf, modulTabel] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
    zaladowane = { jsPDF: modulPdf.default, autoTable: modulTabel.default };
  }
  return zaladowane;
}
import { TaxYearSummary, TaxRealizedGain, DividendTaxItem, BrokerAccount } from '../types';
import { formatCurrency, formatLiczba, formatPolishDate } from './nbpService';
import { dodajAdnotacjeDoPdf } from './gotowoscRozliczenia';
import { dzisiajLokalnie } from './formularzTransakcji';
import { zabezpieczZnakiPdf } from './pdfZnaki';

/** Ilosc i cena jednostkowa w PDF po polsku, bez obcinania ulamkow (kwoty PLN ida przez formatCurrency). */
const liczbaPdf = (v: number): string => v.toLocaleString('pl-PL', { maximumFractionDigits: 6 });

const POLA_KRYPTO_PIT38: Array<[string, string, string]> = [
  ['36', 'Przychód ze zbycia walut wirtualnych', 'E'],
  ['37', 'Koszty poniesione w roku podatkowym', 'E'],
  ['38', 'Koszty z lat ubiegłych', 'E'],
  ['39', 'Dochód z walut wirtualnych', 'E'],
  ['40', 'Koszty do potrącenia w roku następnym', 'E'],
  ['41', 'Podstawa obliczenia podatku', 'F'],
  ['42', 'Stawka podatku', 'F'],
  ['43', 'Podatek od dochodów z walut wirtualnych', 'F'],
  ['44', 'Podatek zapłacony za granicą', 'F'],
  ['45', 'Podatek należny od walut wirtualnych', 'F'],
];

export function wierszeCzesciEF(fields: Record<string, number>): string[][] {
  const maDane = POLA_KRYPTO_PIT38.some(([position]) =>
    Number.isFinite(fields[position]) && fields[position] !== 0);
  if (!maDane) return [];
  return POLA_KRYPTO_PIT38.flatMap(([position, label, section]) => {
    const value = fields[position];
    if (value === 0) return [];
    // Silnik podaje stawke jako tekst "19%", ktory mapa pol liczbowych odrzuca -
    // dla czesci F to zawsze stawka ustawowa 19% (art. 30b ust. 1a).
    if (position === '42') return [[label, `Poz. 42 (część F)`, `${Number.isFinite(value) ? value : 19}%`]];
    return [[label, `Poz. ${position} (część ${section})`, !Number.isFinite(value) ? '–' : formatCurrency(value)]];
  });
}

/** Wiersze części C bez przeliczania kwot: wartości pochodzą z mapy pól formularza silnika. */
export function wierszeCzesciC(
  fields: Record<string, number>,
  sumy?: { revenuePLN: number; costsPLN: number },
): string[][] {
  // Bez rozbicia z silnika pokazujemy sumy z jawną etykietą - kreski w miejscu
  // przychodu i kosztów wyglądały jak zero.
  if (sumy && !['20', '21', '22', '23'].some((pozycja) => typeof fields[pozycja] === 'number')) {
    return [
      ['Przychód razem (poz. 20 i 22; rozbicie PIT-8C niedostępne)', 'Poz. 20 + 22', formatCurrency(sumy.revenuePLN)],
      ['Koszty razem (poz. 21 i 23; rozbicie PIT-8C niedostępne)', 'Poz. 21 + 23', formatCurrency(sumy.costsPLN)],
    ];
  }
  return [
    ['Przychód z PIT-8C', 'Poz. 20', fields['20']],
    ['Koszty z PIT-8C', 'Poz. 21', fields['21']],
    ['Pozostały przychód (bez PIT-8C)', 'Poz. 22', fields['22']],
    ['Pozostałe koszty (bez PIT-8C)', 'Poz. 23', fields['23']],
  ].map(([label, position, value]) => [
    String(label), String(position), typeof value === 'number' ? formatCurrency(value) : '–',
  ]);
}

export async function exportAnnualSummaryPDF(
  selectedYear: number,
  yearSummaries: Map<number, TaxYearSummary>,
  accounts: BrokerAccount[],
  taxpayerName: string = 'Inwestor Indywidualny',
  adnotacja?: string
) {
  const { jsPDF, autoTable } = await zaladujGeneratorPdf();
  const doc = zabezpieczZnakiPdf(new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  }));

  const primaryColor: [number, number, number] = [15, 23, 42]; // Slate 900
  const accentColor: [number, number, number] = [37, 99, 235]; // Blue 600

  const summary: TaxYearSummary = yearSummaries.get(selectedYear) || {
    year: selectedYear,
    revenuePLN: 0,
    costsPLN: 0,
    incomePLN: 0,
    lossPLN: 0,
    taxDuePLN: 0,
    pit8cRevenuePLN: 0,
    pit8cCostsPLN: 0,
    foreignRevenuePLN: 0,
    foreignCostsPLN: 0,
    cryptoRevenuePLN: 0,
    cryptoCostsPLN: 0,
    cryptoIncomePLN: 0,
    cryptoLossPLN: 0,
    cryptoTaxDuePLN: 0,
    dividendGrossPLN: 0,
    dividendForeignTaxPLN: 0,
    dividendPolishTaxDuePLN: 0,
    dividendTaxToPayPLN: 0,
    totalTaxToPayPLN: 0,
    transactionCount: 0,
    brokerBreakdowns: [],
  };

  // Header Banner
  doc.setFillColor(...primaryColor);
  doc.rect(0, 0, 210, 26, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text('ROCZNE ZESTAWIENIE PODATKOWE DO DEKLARACJI PIT-38', 14, 12);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.text(
    `ROK ROZLICZENIOWY: ${selectedYear} | Sporządzono: ${new Date().toLocaleDateString('pl-PL')} ${new Date().toLocaleTimeString('pl-PL')}`,
    14,
    19
  );
  doc.text(`Podatnik: ${taxpayerName}`, 140, 19);
  dodajAdnotacjeDoPdf(doc, adnotacja);

  let currentY = 32;

  // Legal Notice Box
  doc.setDrawColor(203, 213, 225);
  doc.setFillColor(248, 250, 252);
  doc.roundedRect(14, currentY, 182, 22, 2, 2, 'FD');

  doc.setTextColor(30, 41, 59);
  doc.setFontSize(8.5);
  doc.setFont('helvetica', 'bold');
  doc.text('Załącznik informacyjny do zeznania PIT-38:', 18, currentY + 5.5);
  doc.setFont('helvetica', 'normal');
  doc.text(
    'Podsumowanie przychodów i kosztów uzyskania przychodów (art. 30b ust. 1, art. 17 ust. 1 pkt 6, art. 22 ust. 1 ustawy o PIT).',
    18,
    currentY + 10.5
  );
  doc.text(
    'Zastosowano metodę kolejki FIFO oraz oficjalne kursy średnie NBP z dnia roboczego T-1.',
    18,
    currentY + 15.5
  );

  currentY += 28;

  // 1. PIT-38 Key Fields Box
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10.5);
  doc.setTextColor(15, 23, 42);
  doc.text(`1. POZYCJE FORMULARZA PIT-38 ZA ROK ${selectedYear} (CZĘŚCI C–G)`, 14, currentY);

  currentY += 4;

  // Numery pozycji za broszura MF do PIT-38 za 2025 r. Wczesniej ta tabela
  // szla za numeracja z PIT-38(14) z 2019 r.: "razem" w poz. 24-25, dochod
  // w 26-27, doplata od dywidend w 36, laczny podatek w 45. Wiersz ulgi IPO
  // dodany za 2022 r. przesunal wszystko od poz. 24 o dwa w gore.
  const fields = (summary as TaxYearSummary & { engineFormFields?: Record<string, number> }).engineFormFields ?? {};
  const fromEngine = (position: string, fallback?: number): string => {
    const value = fields[position] ?? fallback;
    return value === undefined ? '–' : formatCurrency(value);
  };
  const mainTableData = [
    ['Przychód wykazany w informacjach PIT-8C (brokerzy krajowi)', 'Poz. 20 (część C, wiersz 1)', fromEngine('20', summary.pit8cRevenuePLN)],
    ['Koszty wykazane w informacjach PIT-8C (brokerzy krajowi)', 'Poz. 21 (część C, wiersz 1)', fromEngine('21', summary.pit8cCostsPLN)],
    ['Inne przychody ze zbycia papierów (w tym zagranica - Freedom24, IBKR)', 'Poz. 22 (część C, wiersz 2)', formatCurrency(summary.foreignRevenuePLN !== undefined ? summary.foreignRevenuePLN : summary.revenuePLN)],
    ['Inne koszty uzyskania przychodów (w tym zagranica - FIFO + prowizje)', 'Poz. 23 (część C, wiersz 2)', formatCurrency(summary.foreignCostsPLN !== undefined ? summary.foreignCostsPLN : summary.costsPLN)],
    ['Razem przychód podlegający opodatkowaniu (art. 30b)', 'Poz. 26 (część C, wiersz 4)', formatCurrency(summary.revenuePLN)],
    ['Razem koszty uzyskania przychodów (art. 22 ust. 1)', 'Poz. 27 (część C, wiersz 4)', formatCurrency(summary.costsPLN)],
    ['Dochód przed odliczeniem strat (Przychód - Koszty)', 'Poz. 28 (część C)', formatCurrency(summary.incomePLN)],
    ['Strata podatkowa za rok bieżący (Koszty > Przychód)', 'Poz. 29 (część C)', formatCurrency(summary.lossPLN)],
    ['Straty z lat ubiegłych odliczone od dochodu', 'Poz. 30 (część D)', fromEngine('30', summary.priorYearLossUsedPLN)],
    ['Podstawa po odliczeniu strat (pełne złote)', 'Poz. 31 (część D)', fromEngine('31', summary.taxBasePLN)],
    ['Podatek 19% przed odliczeniem zagranicznym', 'Poz. 33 (część D)', formatCurrency(summary.taxBeforeCreditPLN ?? summary.taxDuePLN)],
    ['Podatek należny (pełne złote)', 'Poz. 35 (część D)', formatCurrency(summary.taxDuePLN)],
    ...wierszeCzesciEF(fields),
    ['Przychód brutto z dywidend zagranicznych (bez załącznika PIT/ZG)', 'Część G (podstawa poz. 47)', formatCurrency(summary.dividendGrossPLN)],
    ['Podatek zapłacony za granicą (WHT podlegający odliczeniu)', 'Poz. 48 (część G)', fromEngine('48', summary.dividendCreditUsedPLN)],
    ['Dopłata podatku od dywidend w Polsce (do stawki 19%)', 'Poz. 49 (część G)', fromEngine('49')],
    ['ŁĄCZNY PODATEK DO ZAPŁATY ZA ROK ' + selectedYear, 'Poz. 51 (część G)', fromEngine('51', summary.formTaxToPayPLN)],
  ];

  autoTable(doc, {
    startY: currentY,
    head: [['Pozycja formularza PIT-38', 'Identyfikator pola', 'Wartość (PLN)']],
    body: mainTableData,
    theme: 'grid',
    headStyles: { fillColor: primaryColor, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8.5 },
    bodyStyles: { fontSize: 8, textColor: [30, 41, 59] },
    columnStyles: {
      0: { cellWidth: 105 },
      1: { cellWidth: 38 },
      2: { cellWidth: 39, halign: 'right', fontStyle: 'bold' },
    },
    margin: { left: 14, right: 14 },
  });

  currentY = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 8;

  // 2. Broker Accounts Breakdown
  if (summary.brokerBreakdowns.length > 0) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(15, 23, 42);
    const liczbaKont = summary.brokerBreakdowns.filter((pozycja) => pozycja.accountId !== 'unassigned').length;
    doc.text(`2. ROZBICIE WEDŁUG RACHUNKÓW I BIUR MAKLERSKICH (${liczbaKont} KONT)`, 14, currentY);

    currentY += 4;

    const brokerRows = summary.brokerBreakdowns.map((b) => [
      b.accountName,
      b.brokerType,
      formatCurrency(b.revenuePLN),
      formatCurrency(b.costsPLN),
      formatCurrency(b.incomePLN),
      formatCurrency(b.lossPLN),
    ]);

    autoTable(doc, {
      startY: currentY,
      head: [['Rachunek maklerski', 'Typ brokera', 'Przychód (PLN)', 'Koszty KUP (PLN)', 'Dochód (PLN)', 'Strata (PLN)']],
      body: brokerRows,
      theme: 'striped',
      headStyles: { fillColor: [51, 65, 85], textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8 },
      bodyStyles: { fontSize: 7.5, textColor: [30, 41, 59] },
      columnStyles: {
        2: { halign: 'right' },
        3: { halign: 'right' },
        4: { halign: 'right' },
        5: { halign: 'right' },
      },
      margin: { left: 14, right: 14 },
    });

    currentY = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 8;
  }

  // 3. Historical Years Multi-Year Comparison Table if available
  const allYears = Array.from(yearSummaries.keys()).sort((a, b) => b - a);
  if (allYears.length > 1) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(15, 23, 42);
    doc.text('3. WIELOLETNIE ZESTAWIENIE WYNIKÓW PODATKOWYCH', 14, currentY);

    currentY += 4;

    const multiYearRows = allYears.map((yr) => {
      const s = yearSummaries.get(yr)!;
      const amount = (value: number): string => s.nieobliczony ? 'brak wyniku' : formatCurrency(value);
      return [
        yr.toString(),
        amount(s.revenuePLN),
        amount(s.costsPLN),
        amount(s.incomePLN),
        amount(s.lossPLN),
        s.nieobliczony ? 'brak wyniku' : formatCurrency(s.formTaxToPayPLN ?? s.totalTaxToPayPLN),
      ];
    });

    autoTable(doc, {
      startY: currentY,
      head: [['Rok', 'Przychód (PLN)', 'Koszty (PLN)', 'Dochód (PLN)', 'Strata (PLN)', 'Podatek Należny (PLN)']],
      body: multiYearRows,
      theme: 'grid',
      headStyles: { fillColor: accentColor, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8 },
      bodyStyles: { fontSize: 7.5, textColor: [30, 41, 59] },
      columnStyles: {
        0: { fontStyle: 'bold' },
        1: { halign: 'right' },
        2: { halign: 'right' },
        3: { halign: 'right' },
        4: { halign: 'right' },
        5: { halign: 'right', fontStyle: 'bold' },
      },
      margin: { left: 14, right: 14 },
    });
  }

  // Footer on page
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(7.5);
    doc.setTextColor(148, 163, 184);
    doc.text(
      `Strona ${i} z ${pageCount} | Podsumowanie PIT-38 (${selectedYear}) | Wygenerowano przez system rozliczeń giełdowych`,
      105,
      290,
      { align: 'center' }
    );
  }

  doc.save(`Podsumowanie_Roczne_PIT38_${selectedYear}_${dzisiajLokalnie()}.pdf`);
}

export async function exportTaxReportPDF(
  summary: TaxYearSummary,
  realizedGains: TaxRealizedGain[],
  dividends: DividendTaxItem[],
  accounts: BrokerAccount[],
  taxpayerName: string = 'Inwestor Indywidualny',
  adnotacja?: string
) {
  const { jsPDF, autoTable } = await zaladujGeneratorPdf();
  const doc = zabezpieczZnakiPdf(new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  }));

  const primaryColor: [number, number, number] = [15, 23, 42]; // Slate 900
  const accentColor: [number, number, number] = [37, 99, 235]; // Blue 600
  const successColor: [number, number, number] = [22, 101, 52]; // Green 800

  // Title & Header
  doc.setFillColor(...primaryColor);
  doc.rect(0, 0, 210, 26, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text('RAPORT PODATKOWY PIT-38 / ZYSKI KAPITAŁOWE', 14, 12);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(`ROK PODATKOWY: ${summary.year} | Wygenerowano: ${new Date().toLocaleDateString('pl-PL')} ${new Date().toLocaleTimeString('pl-PL')}`, 14, 19);
  doc.text(`Podatnik: ${taxpayerName}`, 140, 19);
  dodajAdnotacjeDoPdf(doc, adnotacja);

  let currentY = 34;

  // Metadata Box
  doc.setDrawColor(226, 232, 240);
  doc.setFillColor(248, 250, 252);
  doc.roundedRect(14, currentY, 182, 22, 2, 2, 'FD');

  doc.setTextColor(51, 65, 85);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  doc.text('Podstawa prawna i metoda rozliczenia:', 18, currentY + 6);
  doc.setFont('helvetica', 'normal');
  doc.text('Metoda FIFO (First-In, First-Out) zgodnie z art. 17 ust. 1 pkt 6 oraz art. 22 ust. 1 ustawy o PIT.', 18, currentY + 11);
  doc.text('Przeliczenie walut obcych wg kursów średnich NBP z ostatniego dnia roboczego poprzedzającego transakcję.', 18, currentY + 16);

  currentY += 28;

  // Summary PIT-38 Table
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(15, 23, 42);
  doc.text('1. PODSUMOWANIE POZYCJI DO DEKLARACJI PIT-38 (CZĘŚĆ C)', 14, currentY);

  currentY += 4;

  const engineFormFields = (summary as TaxYearSummary & { engineFormFields?: Record<string, number> }).engineFormFields ?? {};
  const pitTableData = [
    ...wierszeCzesciC(engineFormFields, summary),
    ['Dochód przed odliczeniem strat (Przychód - Koszty)', 'Poz. 28', formatCurrency(summary.incomePLN)],
    ['Strata podatkowa (jeżeli Koszty > Przychód)', 'Poz. 29', formatCurrency(summary.lossPLN)],
    ['Stawka podatku dochodowego', '19%', '19.00%'],
    ['PODATEK 19% PRZED ODLICZENIEM', 'Poz. 33', formatCurrency(summary.taxBeforeCreditPLN ?? summary.taxDuePLN)],
    ['PODATEK NALEŻNY Z AKCJI', 'Poz. 35', formatCurrency(summary.taxDuePLN)],
  ];

  autoTable(doc, {
    startY: currentY,
    head: [['Pozycja rozliczenia PIT-38', 'Pole w formularzu', 'Wartość (PLN)']],
    body: pitTableData,
    theme: 'grid',
    headStyles: { fillColor: primaryColor, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 9 },
    bodyStyles: { fontSize: 8.5, textColor: [30, 41, 59] },
    columnStyles: {
      0: { cellWidth: 100 },
      1: { cellWidth: 40 },
      2: { cellWidth: 42, halign: 'right', fontStyle: 'bold' },
    },
    margin: { left: 14, right: 14 },
  });

  currentY = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 8;

  // Dividends Summary Table if any
  if (dividends.length > 0) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(15, 23, 42);
    doc.text('2. ROZLICZENIE DYWIDEND ZAGRANICZNYCH (PIT-38, CZĘŚĆ G)', 14, currentY);

    currentY += 4;

    const divTableData = [
      ['Łączny przychód brutto z dywidend', formatCurrency(summary.dividendGrossPLN)],
      ['Podatek zapłacony za granicą (WHT)', formatCurrency(summary.dividendForeignTaxPLN)],
      ['Podatek należny w Polsce (19%)', formatCurrency(summary.dividendPolishTaxDuePLN)],
      ['PODATEK OD DYWIDEND DO ZAPŁATY W PL (dopłata do 19%)', formatCurrency(summary.dividendTaxToPayPLN)],
    ];

    autoTable(doc, {
      startY: currentY,
      head: [['Wyszczególnienie dywidend', 'Wartość (PLN)']],
      body: divTableData,
      theme: 'grid',
      headStyles: { fillColor: accentColor, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 9 },
      bodyStyles: { fontSize: 8.5, textColor: [30, 41, 59] },
      columnStyles: {
        0: { cellWidth: 140 },
        1: { cellWidth: 42, halign: 'right', fontStyle: 'bold' },
      },
      margin: { left: 14, right: 14 },
    });

    currentY = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 8;
  }

  // Broker Accounts Breakdown
  if (summary.brokerBreakdowns.length > 0) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(15, 23, 42);
    doc.text('3. ZESTAWIENIE WEDŁUG RACHUNKÓW MAKLERSKICH', 14, currentY);

    currentY += 4;

    const brokerRows = summary.brokerBreakdowns.map((b) => [
      b.accountName,
      b.brokerType,
      formatCurrency(b.revenuePLN),
      formatCurrency(b.costsPLN),
      formatCurrency(b.incomePLN),
      formatCurrency(b.lossPLN),
    ]);

    autoTable(doc, {
      startY: currentY,
      head: [['Konto Maklerskie', 'Typ Brokera', 'Przychód (PLN)', 'Koszty KUP (PLN)', 'Dochód (PLN)', 'Strata (PLN)']],
      body: brokerRows,
      theme: 'striped',
      headStyles: { fillColor: [51, 65, 85], textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8.5 },
      bodyStyles: { fontSize: 8, textColor: [30, 41, 59] },
      columnStyles: {
        2: { halign: 'right' },
        3: { halign: 'right' },
        4: { halign: 'right' },
        5: { halign: 'right' },
      },
      margin: { left: 14, right: 14 },
    });

    currentY = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 10;
  }

  // Add Page for Detailed FIFO Transactions
  doc.addPage();
  doc.setFillColor(...primaryColor);
  doc.rect(0, 0, 210, 18, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text(`SZCZEGÓŁOWY REJESTR ZREALIZOWANYCH TRANSAKCJI (FIFO) - ROK ${summary.year}`, 14, 12);

  currentY = 25;

  const detailedRows = realizedGains.map((g, idx) => {
    const acc = accounts.find((a) => a.id === g.accountId);
    const buyInfo = g.matchedBuyLots
      .map(
        (b) =>
          `${formatPolishDate(b.buyDate)}: ${liczbaPdf(b.buyQuantity)} szt. @ ${liczbaPdf(b.buyPricePerUnit)} ${b.buyCurrency} (NBP ${formatLiczba(b.buyExchangeRate, 4)})`
      )
      .join('\n');

    return [
      (idx + 1).toString(),
      `${g.ticker}\n(${g.name.slice(0, 16)})`,
      acc?.name || 'Główne',
      formatPolishDate(g.sellDate),
      `${liczbaPdf(g.sellQuantity)} szt.\n@ ${liczbaPdf(g.sellPricePerUnit)} ${g.sellCurrency}`,
      `NBP: ${formatLiczba(g.sellExchangeRate, 4)}\n${g.sellExchangeDate}`,
      buyInfo || 'Brak powiązania',
      formatCurrency(g.revenuePLN),
      formatCurrency(g.costPLN),
      formatCurrency(g.profitPLN),
    ];
  });

  autoTable(doc, {
    startY: currentY,
    head: [['Lp.', 'Walor', 'Konto', 'Data Sprzedaży', 'Ilość i Cena', 'Kurs NBP T-1', 'Dopasowane Kupna (FIFO)', 'Przychód PLN', 'Koszt KUP PLN', 'Zysk/Strata PLN']],
    body: detailedRows,
    theme: 'grid',
    headStyles: { fillColor: primaryColor, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 7.5 },
    bodyStyles: { fontSize: 7, textColor: [15, 23, 42] },
    columnStyles: {
      0: { cellWidth: 8, halign: 'center' },
      1: { cellWidth: 20, fontStyle: 'bold' },
      2: { cellWidth: 18 },
      3: { cellWidth: 18 },
      4: { cellWidth: 22 },
      5: { cellWidth: 22 },
      6: { cellWidth: 34 },
      7: { cellWidth: 20, halign: 'right' },
      8: { cellWidth: 20, halign: 'right' },
      9: { cellWidth: 20, halign: 'right', fontStyle: 'bold' },
    },
    margin: { left: 8, right: 8 },
  });

  // Footer on all pages
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(7.5);
    doc.setTextColor(148, 163, 184);
    doc.text(
      `Strona ${i} z ${pageCount} | Kalkulator Podatku Giełdowego PIT-38 | Wygenerowano w systemie`,
      105,
      290,
      { align: 'center' }
    );
  }

  doc.save(`Raport_Podatkowy_PIT38_${summary.year}_${dzisiajLokalnie()}.pdf`);
}
