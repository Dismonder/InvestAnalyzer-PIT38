import { odmienLiczebnik } from '../services/odmianaLiczebnika';
import React, { useState } from 'react';
import { Transaction, BrokerAccount, Language, CurrencyCode, AssetCategory, TransactionType } from '../types';
import { getTranslation } from '../i18n/translations';
import { decodeStorageText } from '../../invest_analyzer/services/textEncoding';
import {
  podzielWiersz,
  podzielNaRekordy,
  zdejmijNeutralizacjeCsv,
  wykryjSeparator,
  liczbaZPola,
  konwencjaKolumnyLiczb,
  niejednoznacznyZapisLiczby,
  dataZPola,
  walutyImportu,
  kolumnyWalutCsv,
  kolumnyPodatkuZrodlaCsv,
  znakIlosciICenyOplaty,
  rodzajZPola,
  wygladaJakWierszDanych,
  kolumnaCenyCsv,
  znakIlosciICeny,
  kolejnoscDatZUkosnikiem,
  komorkiKolumnyDat,
  kategoriaImportu,
} from '../services/odczytCsv';
import { X, Upload, FileText, CheckCircle, AlertTriangle, ArrowRight } from 'lucide-react';
import { useZamknijEscape } from '../../shared/useZamknijEscape';

const LIMIT_PODGLADU = 200;
/** Ilosc i cena w podgladzie po polsku, bez obcinania ulamkow akcji. */
const liczbaPodgladu = (v: number) =>
  Number.isFinite(v) ? v.toLocaleString('pl-PL', { maximumFractionDigits: 6 }) : '—';

interface ImportTransactionsModalProps {
  accounts: BrokerAccount[];
  language: Language;
  onImport: (transactions: Transaction[]) => void;
  onClose: () => void;
}

const NAGLOWEK_KLASY_INSTRUMENTU =
  /asset\s*class|instrument\s*(?:type|class)|typ\s*(?:instrumentu|aktywa)|klasa\s*(?:instrumentu|aktywa)|category|kategoria/i;

/**
 * Kolumny klasy instrumentu, tickera i rodzaju operacji z naglowka CSV.
 *
 * Kolumna klasy nie moze zostac tickerem: polski naglowek "Typ instrumentu"
 * zawiera "instrument" i wygrywal z kolumna "Symbol" - symbolem stawalo sie "ETF".
 */
export function kolumnyInstrumentuCsv(headerParts: string[]): { instrumentClassCol: number; tickerCol: number; typeCol: number } {
  const instrumentClassCol = headerParts.findIndex((h) => NAGLOWEK_KLASY_INSTRUMENTU.test(h));
  const tickerCol = headerParts.findIndex((h) =>
    !NAGLOWEK_KLASY_INSTRUMENTU.test(h) &&
    (h.includes('symbol') || h.includes('ticker') || h.includes('instrument') || h.includes('walor') || h.includes('isin')),
  );
  const typeCol = headerParts.findIndex((h) =>
    !NAGLOWEK_KLASY_INSTRUMENTU.test(h) &&
    (h.includes('type') || h.includes('typ') || h.includes('action') || h.includes('operacja') || h.includes('side')),
  );
  return { instrumentClassCol, tickerCol, typeCol };
}

export function buildImportTransactionIdentity(
  accountId: string,
  brokerTransactionId: string,
  dateIdentity: string,
  ticker: string,
  type: string,
  quantity: number,
  price: number,
  currency: string,
  commission: number,
): string {
  return brokerTransactionId
    ? [accountId, 'broker', brokerTransactionId].join('|')
    : [accountId, dateIdentity, ticker, type, quantity, price, currency, commission].join('|');
}

export function createImportTransactionId(daneId: string, powtorzenia: Map<string, number>): string {
  let hash = 2166136261;
  for (let znak = 0; znak < daneId.length; znak++) hash = Math.imul(hash ^ daneId.charCodeAt(znak), 16777619);
  const skrot = (hash >>> 0).toString(16).padStart(8, '0');
  const powtorzenie = (powtorzenia.get(skrot) || 0) + 1;
  powtorzenia.set(skrot, powtorzenie);
  return `imp_${skrot}_${powtorzenie}`;
}

export function resolveCsvAccountId(accounts: BrokerAccount[], rawId: string, rawName: string): string | null {
  const byId = rawId ? accounts.filter((account) => account.id === rawId) : [];
  if (byId.length === 1) return byId[0].id;
  const byName = rawName ? accounts.filter((account) => account.name.trim().toLocaleLowerCase() === rawName.trim().toLocaleLowerCase()) : [];
  return byName.length === 1 ? byName[0].id : null;
}

export interface WynikImportuCsv {
  /** `null` - plik pusty lub bez wierszy danych; stan podgladu nalezy wyczyscic. */
  items: Transaction[] | null;
  nieznaneRachunki?: number;
  pominiete?: { nr: number; powod: string }[];
  blad: string;
}

/** Odczyt wyciagu CSV do transakcji; czysta funkcja (bez stanu okna), zeby dalo sie ja sprawdzic. */
export function parsujTransakcjeCsv(
  content: string,
  accountId: string,
  accounts: BrokerAccount[],
  fileName: string,
): WynikImportuCsv {
  const pominiete: { nr: number; powod: string }[] = [];
  try {
    if (!accountId || !accounts.some((account) => account.id === accountId)) {
      return { items: [], blad: 'Wybierz istniejący rachunek docelowy przed importem.' };
    }
    // Rekordy logiczne: nowa linia w cudzyslowie nalezy do pola.
    const lines = podzielNaRekordy(content);
    if (lines.length < 1) {
      return { items: null, blad: 'Plik jest pusty lub nie zawiera wierszy danych.' };
    }

    const delimiter = wykryjSeparator(lines[0], lines.slice(1));
    const items: Transaction[] = [];

    // Check header row
    const headerParts = podzielWiersz(lines[0], delimiter).map((p) => p.trim().toLowerCase().replace(/^"|"$/g, ''));
    
    let dateCol = headerParts.findIndex((h) => h.includes('date') || h.includes('data') || h.includes('time') || h.includes('czas'));
    const kolumnyInstrumentu = kolumnyInstrumentuCsv(headerParts);
    const instrumentClassCol = kolumnyInstrumentu.instrumentClassCol;
    let tickerCol = kolumnyInstrumentu.tickerCol;
    let typeCol = kolumnyInstrumentu.typeCol;
    let qtyCol = headerParts.findIndex((h) => h.includes('qty') || h.includes('quantity') || h.includes('ilosc') || h.includes('ilość') || h.includes('shares') || h.includes('volume') || h.includes('wolumen'));
    let priceCol = kolumnaCenyCsv(headerParts);
    const { currCol, commCol, commCurrCol } = kolumnyWalutCsv(headerParts);
    const { stawkaCol: stawkaWhtCol, kwotaCol: kwotaWhtCol } = kolumnyPodatkuZrodlaCsv(headerParts);
    let nameCol = headerParts.findIndex((h) => h.includes('name') || h.includes('nazwa') || h.includes('description') || h.includes('opis'));
    const transactionIdCol = headerParts.findIndex((h) =>
      /(?:transaction|trade|order|execution|deal|transakc|zlecen|operac).*(?:id|no|number|nr|numer)|(?:id|no|number|nr|numer).*(?:transaction|trade|order|execution|deal|transakc|zlecen|operac)/i.test(h),
    );
    const accountIdCol = headerParts.findIndex((h) => /konto\s*id|account\s*id|rachunek\s*id/i.test(h));
    // Kolumna "ID" z eksportu aplikacji (obok "Konto ID"): to identyfikator transakcji w aplikacji.
    // Zachowanie go sprawia, ze ponowny import tego samego pliku jest wykrywany jako duplikaty
    // (PortfelApp odrzuca wpisy o znanym ID). Sama kolumna "ID" bez "Konto ID" nalezy do obcego wyciagu.
    const eksportIdCol = accountIdCol >= 0 ? headerParts.findIndex((h) => h === 'id') : -1;
    const accountNameCol = headerParts.findIndex((h) => /konto maklerskie|account name|broker account|rachunek/i.test(h));
    const notesCol = headerParts.findIndex((h) => /^(?:notes?|notatki)$/i.test(h));
    const wlasnyEksport = accountIdCol >= 0 && eksportIdCol >= 0;
    let unknownAccounts = 0;

    const hasSmartHeaders = (tickerCol !== -1 || dateCol !== -1) && qtyCol !== -1 && priceCol !== -1;
    // Sciezka pozycyjna (bez naglowka) tylko dla pliku, ktorego pierwsza linia jest wierszem danych - wtedy
    // liczy sie od niej. Plik z naglowkiem, ktorego kolumn nie rozpoznajemy, jest odrzucany: kolejnosc
    // kolumn zgadywana z ksztaltu wiersza mieszala cene z wartoscia albo ilosc z cena.
    const pierwszaLiniaToDane = !hasSmartHeaders && wygladaJakWierszDanych(podzielWiersz(lines[0], delimiter));
    if (!hasSmartHeaders && !pierwszaLiniaToDane) {
      const nierozpoznane = [
        ...(tickerCol === -1 && dateCol === -1 ? ['data lub symbol'] : []),
        ...(qtyCol === -1 ? ['ilość'] : []),
        ...(priceCol === -1 ? ['cena'] : []),
      ];
      return {
        items: [],
        blad: `Nie rozpoznano kolumn: ${nierozpoznane.join(', ')}. Dodaj nagłówki (np. Data, Symbol, Typ, Ilość, Cena, Waluta) - kolejności kolumn nie zgadujemy.`,
      };
    }
    if (lines.length < 2 && !pierwszaLiniaToDane) {
      return { items: null, blad: 'Plik jest pusty lub nie zawiera wierszy danych.' };
    }
    const pierwszyWiersz = pierwszaLiniaToDane ? 0 : 1;
    // Daty z ukosnikiem: dzien/miesiac albo miesiac/dzien rozstrzyga cala kolumna daty,
    // nie pojedynczy wiersz - i tylko ona (opis zaczynajacy sie od daty nie moze tego przestawic).
    const wierszeDanych = lines.slice(pierwszyWiersz).map((linia) => podzielWiersz(linia, delimiter));
    const kolejnoscDat = kolejnoscDatZUkosnikiem(
      komorkiKolumnyDat(wierszeDanych, hasSmartHeaders ? dateCol : null));
    // Konwencja przecinka w liczbach ustalana dla CALEJ kolumny (jak kolejnosc dat), nie po jednej
    // komorce: "1,234" to 1,234 albo 1234, a silnik czyta je jako 1234. Bez dowodow - nie zgadujemy.
    const konwencjaKolumny = (kolumna: number) => konwencjaKolumnyLiczb(wierszeDanych.map((wiersz) => wiersz[kolumna]));
    const konwencjaBezNaglowkow = hasSmartHeaders
      ? 'BRAK_PRZECINKA' as const
      : konwencjaKolumnyLiczb(wierszeDanych.flatMap((wiersz) => [wiersz[3], wiersz[4], wiersz[5]]));
    const konwencjaIlosci = hasSmartHeaders ? (qtyCol !== -1 ? konwencjaKolumny(qtyCol) : 'BRAK_PRZECINKA' as const) : konwencjaBezNaglowkow;
    const konwencjaCeny = hasSmartHeaders ? (priceCol !== -1 ? konwencjaKolumny(priceCol) : 'BRAK_PRZECINKA' as const) : konwencjaBezNaglowkow;
    const konwencjaProwizji = commCol !== -1 ? konwencjaKolumny(commCol) : 'BRAK_PRZECINKA' as const;
    const konwencjaStawkiWht = stawkaWhtCol !== -1 ? konwencjaKolumny(stawkaWhtCol) : 'BRAK_PRZECINKA' as const;
    const konwencjaKwotyWht = kwotaWhtCol !== -1 ? konwencjaKolumny(kwotaWhtCol) : 'BRAK_PRZECINKA' as const;

    // Parse rows
    const powtorzenia = new Map<string, number>();
    const brokerTransactionIds = new Set<string>();
    const idyZEksportu = new Set<string>();
    for (let i = pierwszyWiersz; i < lines.length; i++) {
      // Apostrof neutralizujacy formule z eksportu aplikacji (zakodujKomorkeCsv) jest zdejmowany z kazdego pola.
      const parts = podzielWiersz(lines[i], delimiter).map((p) => zdejmijNeutralizacjeCsv(p.replace(/^"|"$/g, '').trim()));
      if (parts.length < 3) {
        pominiete.push({ nr: i + 1, powod: 'wiersz ma mniej niż trzy kolumny' });
        continue;
      }

      // Zadnych wartosci zastepczych. Wczesniej brak tickera dawal "ASSET"
      // albo - w sciezce awaryjnej - "NVDA" i "SPY", brak ilosci jedna sztuke,
      // a brak ceny sto jednostek waluty. Tak powstale transakcje wygladaly
      // jak wczytane z wyciagu i wchodzily do rozliczenia podatkowego.
      let ticker = '';
      let name = '';
      let type: TransactionType | null = null;
      let date: string | null = null;
      let dateIdentity = '';
      let qty: number | null = null;
      let price: number | null = null;
      // Waluta, rodzaj operacji i prowizja tez nie maja wartosci zastepczej.
      // USD dla pliku bez kolumny waluty kierowalo transakcje do rozliczenia
      // z cudzym kursem NBP, a nierozpoznany rodzaj operacji stawal sie
      // zakupem, czyli kosztem i partia FIFO, ktorych nie bylo.
      let currency: CurrencyCode | null = null;
      let rawCurrency = '';
      let rawCommissionCurrency = '';
      let commissionCurrency: CurrencyCode | null = null;
      let commission = 0;
      let prowizjaNieczytelna = false;
      let walutaNierozpoznana: string | null = null;
      let category: AssetCategory = 'STOCK_FOREIGN';
      let surowaIlosc: string | undefined;
      let surowaCena: string | undefined;
      let surowaProwizja: string | undefined;
      let surowaStawkaWht: string | undefined;
      let surowaKwotaWht: string | undefined;

      if (hasSmartHeaders) {
        if (tickerCol !== -1 && parts[tickerCol]) ticker = parts[tickerCol].toUpperCase().trim();
        if (nameCol !== -1 && parts[nameCol]) name = parts[nameCol];
        else name = ticker;
        if (dateCol !== -1) {
          dateIdentity = parts[dateCol] ?? '';
          date = dataZPola(dateIdentity, kolejnoscDat);
          if (wlasnyEksport && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(dateIdentity)) {
            date = dateIdentity;
          }
        }
        if (qtyCol !== -1) { qty = liczbaZPola(parts[qtyCol], konwencjaIlosci); surowaIlosc = parts[qtyCol]; }
        if (priceCol !== -1) { price = liczbaZPola(parts[priceCol], konwencjaCeny); surowaCena = parts[priceCol]; }
        if (currCol !== -1) rawCurrency = parts[currCol] ?? '';
        if (commCurrCol !== -1) rawCommissionCurrency = parts[commCurrCol] ?? '';
        if (commCol !== -1 && parts[commCol]) {
          const odczyt = liczbaZPola(parts[commCol], konwencjaProwizji);
          surowaProwizja = parts[commCol];
          if (odczyt === null) prowizjaNieczytelna = true;
          // Prowizja w wyciagach bywa zapisana ze znakiem minus (koszt).
          else commission = Math.abs(odczyt);
        }
        if (stawkaWhtCol !== -1) surowaStawkaWht = parts[stawkaWhtCol];
        if (kwotaWhtCol !== -1) surowaKwotaWht = parts[kwotaWhtCol];
        if (typeCol !== -1) type = rodzajZPola(parts[typeCol]);
      } else {
        // Sciezka dla plikow bez rozpoznawalnych naglowkow: kolejnosc kolumn
        // odczytujemy z ksztaltu pierwszego pola, ale nadal bez zgadywania
        // brakujacych wartosci.
        if (parts[0].match(/^[A-Z0-9.]{1,8}$/)) {
          ticker = parts[0].toUpperCase();
          name = parts[1] || ticker;
          type = rodzajZPola(parts[2]);
          dateIdentity = parts[3] ?? '';
          date = dataZPola(dateIdentity, kolejnoscDat);
          qty = liczbaZPola(parts[4], konwencjaIlosci);
          price = liczbaZPola(parts[5], konwencjaCeny);
          surowaIlosc = parts[4]; surowaCena = parts[5];
          rawCurrency = parts[6] ?? '';
        } else if (parts[0].match(/^\d{4}[-/.]/) || parts[0].match(/^\d{1,2}[-/.]/)) {
          dateIdentity = parts[0];
          date = dataZPola(dateIdentity, kolejnoscDat);
          ticker = (parts[1] ?? '').toUpperCase();
          name = ticker;
          type = rodzajZPola(parts[2]);
          qty = liczbaZPola(parts[3], konwencjaIlosci);
          price = liczbaZPola(parts[4], konwencjaCeny);
          surowaIlosc = parts[3]; surowaCena = parts[4];
          rawCurrency = parts[5] ?? '';
        } else {
          ticker = (parts[2] ?? '').toUpperCase();
          name = ticker;
          qty = liczbaZPola(parts[3], konwencjaIlosci);
          price = liczbaZPola(parts[4], konwencjaCeny);
          surowaIlosc = parts[3]; surowaCena = parts[4];
        }
      }

      // Clean ticker
      ticker = ticker.replace(/["']/g, '').trim();
      category = kategoriaImportu(ticker, instrumentClassCol === -1 ? undefined : parts[instrumentClassCol]);

      ({ currency, commissionCurrency } = walutyImportu(
        rawCurrency, rawCommissionCurrency, category === 'CRYPTO', category === 'STOCK_PL',
      ));
      if (rawCurrency && !currency) walutaNierozpoznana = rawCurrency.toUpperCase();

      // Kazdy brak jest nazwany po imieniu. Wiersz bez kompletu danych nie
      // wchodzi do rejestru - w rozliczeniu podatkowym brak pozycji jest do
      // zauwazenia, a pozycja zmyslona nie.
      const braki: string[] = [];
      // Opłata (FEE) nie ma symbolu ani liczby sztuk; kwota jest w cenie albo w prowizji.
      const znaki = type === 'FEE' ? znakIlosciICenyOplaty(qty, price, commission) : znakIlosciICeny(qty, price, type);
      qty = znaki.ilosc;
      price = znaki.cena;
      if (!ticker && type !== 'FEE') braki.push('brak symbolu instrumentu');
      if (!date) braki.push('nie rozpoznano daty');
      braki.push(...znaki.braki);
      // Podatek u źródła dotyczy tylko dywidendy; stawka i kwota są opcjonalne, ale zapis nieczytelny nie jest gubiony po cichu.
      let foreignTaxRate: number | undefined;
      let foreignTaxAmount: number | undefined;
      if (type === 'DIVIDEND') {
        if (surowaStawkaWht?.trim()) {
          const odczyt = liczbaZPola(surowaStawkaWht, konwencjaStawkiWht);
          if (odczyt === null || Math.abs(odczyt) > 100) braki.push(`nie da się odczytać stawki podatku u źródła "${surowaStawkaWht}"`);
          else foreignTaxRate = Math.abs(odczyt);
        }
        if (surowaKwotaWht?.trim()) {
          const odczyt = liczbaZPola(surowaKwotaWht, konwencjaKwotyWht);
          if (odczyt === null) braki.push(`nie da się odczytać kwoty podatku u źródła "${surowaKwotaWht}"`);
          else foreignTaxAmount = Math.abs(odczyt);
        }
      }
      // Zapis typu 1,234 w kolumnie bez dowodu konwencji: pomijamy wiersz, zamiast zgadywac 1,234 czy 1234.
      for (const [surowa, konwencja] of [
        [surowaIlosc, konwencjaIlosci], [surowaCena, konwencjaCeny], [surowaProwizja, konwencjaProwizji],
        [surowaStawkaWht, konwencjaStawkiWht], [surowaKwotaWht, konwencjaKwotyWht],
      ] as const) {
        if (niejednoznacznyZapisLiczby(surowa, konwencja)) {
          braki.push(`niejednoznaczny zapis liczby ${surowa} — zapisz 1234 albo 1,234 z kontekstem (kropka dziesiętna: 1.234)`);
        }
      }
      if (type === null) braki.push('nie rozpoznano rodzaju operacji (kupno/sprzedaż/dywidenda/opłata)');
      if (walutaNierozpoznana) braki.push(`nieobsługiwana waluta "${walutaNierozpoznana}"`);
      if (currency === null) braki.push('brak waluty rozliczenia');
      if (prowizjaNieczytelna) braki.push('nie da się odczytać prowizji');
      if (rawCommissionCurrency && !commissionCurrency) braki.push(`nieobsługiwana waluta prowizji "${rawCommissionCurrency}"`);

      if (braki.length > 0) {
        pominiete.push({ nr: i + 1, powod: braki.join(', ') });
        continue;
      }

      {
        const brokerTransactionId = transactionIdCol >= 0 ? (parts[transactionIdCol] || '').trim() : '';
        if (brokerTransactionId && brokerTransactionIds.has(brokerTransactionId)) {
          pominiete.push({ nr: i + 1, powod: `powtórzony identyfikator transakcji/zlecenia brokera "${brokerTransactionId}"` });
          continue;
        }
        if (brokerTransactionId) brokerTransactionIds.add(brokerTransactionId);
        const idZEksportu = eksportIdCol >= 0 ? (parts[eksportIdCol] || '').trim() : '';
        if (idZEksportu && idyZEksportu.has(idZEksportu)) {
          pominiete.push({ nr: i + 1, powod: `powtórzony identyfikator transakcji "${idZEksportu}"` });
          continue;
        }
        if (idZEksportu) idyZEksportu.add(idZEksportu);
        const rawAccountId = accountIdCol >= 0 ? parts[accountIdCol] : '';
        const rawAccountName = accountNameCol >= 0 ? parts[accountNameCol] : '';
        const resolvedId = resolveCsvAccountId(accounts, rawAccountId, rawAccountName);
        const resolved = accounts.find((a) => a.id === resolvedId);
        if ((rawAccountId || rawAccountName) && !resolved) unknownAccounts++;
        const rowAccountId = resolved?.id || accountId;
        const daneId = buildImportTransactionIdentity(
          rowAccountId,
          brokerTransactionId,
          dateIdentity || date || '',
          ticker,
          type as string,
          qty as number,
          price as number,
          currency as string,
          commission,
        );
        items.push({
          id: idZEksportu || createImportTransactionId(daneId, powtorzenia),
          accountId: rowAccountId,
          ticker,
          name: name || ticker,
          category,
          type: type as TransactionType,
          date: wlasnyEksport ? (date as string) : (date as string).slice(0, 10),
          quantity: qty as number,
          pricePerUnit: price as number,
          currency: currency as CurrencyCode,
          commission,
          commissionCurrency: commissionCurrency as CurrencyCode,
          ...(foreignTaxRate !== undefined ? { foreignTaxRate } : {}),
          ...(foreignTaxAmount !== undefined ? { foreignTaxAmount } : {}),
          notes: [notesCol >= 0 ? parts[notesCol] : '', 'Zaimportowano z pliku: ' + (fileName || 'CSV')].filter(Boolean).join('\n'),
        });
      }
    }

    return {
      items,
      nieznaneRachunki: unknownAccounts,
      pominiete,
      blad: items.length === 0
        ? (pominiete.length > 0
          ? `Nie zaimportowano żadnego wiersza. Pominięto ${pominiete.length} ${odmienLiczebnik(pominiete.length, 'wiersz', 'wiersze', 'wierszy')}; sprawdź powody poniżej.`
          : 'Plik nie zawiera rozpoznawalnych transakcji.')
        : '',
    };
  } catch {
    return { items: [], pominiete, blad: 'Nie udało się poprawnie zinterpretować struktury pliku CSV.' };
  }
}

/**
 * Odczyt wybranego pliku: nazwa pliku idzie wprost z pliku, nie ze stanu okna - stan
 * ustawiony przez setFileName nie jest jeszcze widoczny w FileReader.onload, wiec notatka
 * dostawala nazwe poprzedniego pliku albo 'CSV'.
 */
export function odczytPlikuImportu(
  bajty: Uint8Array,
  nazwaPliku: string,
  accountId: string,
  accounts: BrokerAccount[],
): { content: string; wynik: WynikImportuCsv } {
  const content = decodeStorageText(bajty).text.replace(/^\uFEFF/, '');
  return { content, wynik: parsujTransakcjeCsv(content, accountId, accounts, nazwaPliku) };
}

export function czyMoznaZatwierdzicImport(liczbaTransakcji: number, blad: string, nieznaneRachunki: number, potwierdzonoNieznane: boolean): boolean {
  return liczbaTransakcji > 0 && !blad && (!nieznaneRachunki || potwierdzonoNieznane);
}

export const ImportTransactionsModal: React.FC<ImportTransactionsModalProps> = ({
  accounts,
  language,
  onImport,
  onClose,
}) => {
  const refOkna = useZamknijEscape(true, onClose);
  const t = getTranslation(language);
  const [selectedAccountId, setSelectedAccountId] = useState(accounts[0]?.id || '');
  const [fileContent, setFileContent] = useState<string>('');
  const [fileName, setFileName] = useState<string>('');
  const [parsedItems, setParsedItems] = useState<Transaction[]>([]);
  const [errorMsg, setErrorMsg] = useState<string>('');
  // Wiersze, ktorych nie dalo sie odczytac. Pokazujemy je wprost, zamiast
  // podstawiac za nie wymyslone wartosci.
  const [pominieteWiersze, setPominieteWiersze] = useState<{ nr: number; powod: string }[]>([]);
  const [nieznaneRachunki, setNieznaneRachunki] = useState(0);
  const [potwierdzonoNieznane, setPotwierdzonoNieznane] = useState(false);
  const uploadGeneration = React.useRef(0);
  const selectedAccountIdRef = React.useRef(selectedAccountId);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const generation = ++uploadGeneration.current;
    setFileName(file.name);
    setFileContent('');
    setParsedItems([]);
    setErrorMsg('');
    setPominieteWiersze([]);
    setNieznaneRachunki(0);
    setPotwierdzonoNieznane(false);

    const reader = new FileReader();
    reader.onload = (event) => {
      if (generation !== uploadGeneration.current) return;
      const bytes = new Uint8Array(event.target?.result as ArrayBuffer);
      const { content, wynik } = odczytPlikuImportu(bytes, file.name, selectedAccountIdRef.current, accounts);
      setFileContent(content);
      zastosujWynik(wynik);
    };
    reader.readAsArrayBuffer(file);
  };

  const parseCSV = (content: string, accountId: string) => {
    zastosujWynik(parsujTransakcjeCsv(content, accountId, accounts, fileName));
  };

  const zastosujWynik = (wynik: WynikImportuCsv) => {
    setParsedItems(wynik.items ?? []);
    if (wynik.nieznaneRachunki !== undefined) {
      setNieznaneRachunki(wynik.nieznaneRachunki);
      setPotwierdzonoNieznane(false);
    }
    if (wynik.pominiete) setPominieteWiersze(wynik.pominiete);
    setErrorMsg(wynik.blad);
  };

  const handleConfirmImport = () => {
    if (czyMoznaZatwierdzicImport(parsedItems.length, errorMsg, nieznaneRachunki, potwierdzonoNieznane)) {
      onImport(parsedItems);
      onClose();
    }
  };

  return (
    <div ref={refOkna} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t.importFile} className="outline-none fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
      <div className="w-full max-w-xl bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-2xl p-6 space-y-4 animate-in fade-in zoom-in-95 duration-150 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
          <h2 className="text-base sm:text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Upload className="w-5 h-5 text-blue-600" />
            <span>{t.importFile}</span>
          </h2>
          <button
            aria-label="Zamknij"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-4 text-xs">
          {/* Target Account Picker */}
          <div>
            <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
              Docelowy Rachunek Maklerski:
            </label>
            <select aria-label="Docelowy Rachunek Maklerski"
              value={selectedAccountId}
              onChange={(e) => {
                selectedAccountIdRef.current = e.target.value;
                setSelectedAccountId(e.target.value);
                if (fileContent) parseCSV(fileContent, e.target.value);
              }}
              className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none"
            >
              {accounts.length === 0 ? (
                <option value="">Brak dostępnych rachunków</option>
              ) : (
                accounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    {acc.name} ({acc.brokerType} • {acc.currency})
                  </option>
                ))
              )}
            </select>
          </div>

          {/* Upload Area */}
          <div className="border-2 border-dashed border-slate-200 dark:border-slate-700 hover:border-blue-500 rounded-2xl p-6 text-center cursor-pointer transition-colors relative bg-slate-50/50 dark:bg-slate-800/20">
            <input
              type="file"
              accept=".csv,.txt"
              onChange={handleFileUpload}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
            <div className="flex flex-col items-center gap-2">
              <FileText className="w-10 h-10 text-blue-500" />
              <div className="font-semibold text-slate-800 dark:text-slate-200">
                {fileName ? fileName : 'Przeciągnij i upuść plik raportu CSV / wyciągu'}
              </div>
              <p className="text-[11px] text-slate-400">
                Obsługuje raporty: XTB CSV, IBKR Flex Query, Freedom24, Revolut, eMakler, Binance
              </p>
            </div>
          </div>

          {errorMsg && (
            <div className="p-3 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 text-rose-600 text-xs flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* Parsed Preview Table */}
          {pominieteWiersze.length > 0 && (
            <div className="p-3 rounded-xl border border-amber-200 dark:border-amber-900/60 bg-amber-50/80 dark:bg-amber-950/30 text-amber-900 dark:text-amber-200 space-y-1.5">
              <div className="flex items-center gap-1.5 font-bold text-[11px]">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                <span>Pominięto {pominieteWiersze.length} {odmienLiczebnik(pominieteWiersze.length, 'wiersz', 'wiersze', 'wierszy')}</span>
              </div>
              <div className="max-h-24 overflow-y-auto space-y-0.5 text-[11px] leading-relaxed">
                {pominieteWiersze.slice(0, 20).map((wiersz) => (
                  <div key={wiersz.nr} className="font-mono">
                    wiersz {wiersz.nr}: {wiersz.powod}
                  </div>
                ))}
                {pominieteWiersze.length > 20 && (
                  <div className="italic">…oraz {pominieteWiersze.length - 20} kolejnych.</div>
                )}
              </div>
              <div className="text-[10.5px]">
                Te wiersze nie trafią do rejestru. Uzupełnij je w pliku albo dodaj ręcznie — puste
                miejsce w rozliczeniu widać, a podstawiona liczba wygląda jak prawdziwa.
              </div>
            </div>
          )}

          {parsedItems.length > 0 && (
            <div className="space-y-2">
              {nieznaneRachunki > 0 && <label className="block rounded-lg border border-amber-300 bg-amber-50 p-2 text-amber-900"><input type="checkbox" checked={potwierdzonoNieznane} onChange={(e) => { setPotwierdzonoNieznane(e.target.checked); if (e.target.checked) setParsedItems((items) => items.map((item) => accounts.some((a) => a.id === item.accountId) ? item : { ...item, accountId: selectedAccountId })); else if (fileContent) parseCSV(fileContent, selectedAccountId); }} /> {nieznaneRachunki} wierszy ma nieznany lub niejednoznaczny rachunek; przypisz je do wybranego rachunku ({selectedAccountId}). Potwierdzam.</label>}
              <div className="flex items-center justify-between text-xs font-semibold text-slate-800 dark:text-slate-200">
                <span>Podgląd rozpoznanych transakcji:</span>
                <span className="text-emerald-600 dark:text-emerald-400 font-bold">
                  Rozpoznano: {parsedItems.length} {odmienLiczebnik(parsedItems.length, 'pozycję', 'pozycje', 'pozycji')}
                </span>
              </div>

              <div className="max-h-48 overflow-y-auto rounded-xl border border-slate-200 dark:border-slate-700">
                <table className="w-full text-left text-[11px]">
                  <thead className="bg-slate-100 dark:bg-slate-800 text-slate-500">
                    <tr>
                      <th className="p-2">Data</th>
                      <th className="p-2">Ticker</th>
                      <th className="p-2">Typ</th>
                      <th className="p-2 text-right">Ilość</th>
                      <th className="p-2 text-right">Cena</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {/* Podglad, nie pelna lista: plik z tysiacami wierszy renderowal
                        wszystkie naraz. Import obejmuje wszystkie pozycje. */}
                    {parsedItems.slice(0, LIMIT_PODGLADU).map((item, idx) => (
                      <tr key={idx} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                        <td className="p-2 font-mono">{item.date}</td>
                        <td className="p-2 font-bold text-slate-900 dark:text-white">{item.ticker}</td>
                        <td className="p-2 font-semibold text-blue-700 dark:text-blue-400">
                          {({ BUY: t.buy, SELL: t.sell, DIVIDEND: t.dividend, FEE: t.fee } as Record<string, string>)[item.type] ?? item.type}
                        </td>
                        <td className="p-2 text-right font-mono">{liczbaPodgladu(item.quantity)}</td>
                        <td className="p-2 text-right font-mono">
                          {liczbaPodgladu(item.pricePerUnit)} {item.currency}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {parsedItems.length > LIMIT_PODGLADU && (
                  <p className="p-2 text-[11px] text-slate-500 dark:text-slate-400">
                    Podgląd pokazuje {LIMIT_PODGLADU} z {parsedItems.length} pozycji — zaimportowane zostaną wszystkie.
                  </p>
                )}
              </div>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-100 dark:border-slate-800">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 font-semibold"
            >
              Anuluj
            </button>
            <button
              type="button"
              disabled={parsedItems.length === 0 || !selectedAccountId || (nieznaneRachunki > 0 && !potwierdzonoNieznane)}
              onClick={handleConfirmImport}
              className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold shadow-xs disabled:opacity-50 cursor-pointer"
            >
              Zatwierdź i Zaimportuj ({parsedItems.length})
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
