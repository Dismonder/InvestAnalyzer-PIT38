/**
 * Odczyt pol z wyciagu CSV.
 *
 * Funkcje wydzielone z okna importu, zeby dalo sie je sprawdzic osobno.
 * Kazda z nich zwraca `null` zamiast wartosci zastepczej: w rozliczeniu
 * podatkowym brakujaca pozycja jest do zauwazenia, a podstawiona - nie.
 */

import type { AssetCategory, CurrencyCode, TransactionType } from '../types';

/**
 * Dzieli wiersz CSV na pola z poszanowaniem cudzyslowow.
 *
 * Zwykly `split(separator)` rozbijal pole ujete w cudzyslowy, jesli zawieralo
 * separator - nazwe spolki z przecinkiem albo kwote z przecinkiem dziesietnym.
 * Wszystkie kolejne kolumny przesuwaly sie wtedy o jedna pozycje: liczba sztuk
 * ladowala w cenie, cena w walucie.
 */
export function podzielWiersz(wiersz: string, separator: string): string[] {
  const pola: string[] = [];
  let biezace = '';
  let wCudzyslowie = false;

  for (let i = 0; i < wiersz.length; i++) {
    const znak = wiersz[i];
    if (znak === '"') {
      if (wCudzyslowie && wiersz[i + 1] === '"') {
        biezace += '"';
        i++;
      } else {
        wCudzyslowie = !wCudzyslowie;
      }
    } else if (znak === separator && !wCudzyslowie) {
      pola.push(biezace.trim());
      biezace = '';
    } else {
      biezace += znak;
    }
  }
  pola.push(biezace.trim());
  return pola;
}

/**
 * Odwrotnosc neutralizacji formul z eksportu (zakodujKomorkeCsv): apostrof
 * sprzed = + - @ tabulatora albo CR jest zdejmowany, zeby nazwa "-cmd" wrocila
 * z eksportu jako "-cmd", a nie "'-cmd". Inne apostrofy (O'Neil) zostaja.
 */
export function zdejmijNeutralizacjeCsv(tekst: string): string {
  return /^'[=+\-@\t\r]/.test(tekst) ? tekst.slice(1) : tekst;
}

/**
 * Dzieli tresc CSV na rekordy logiczne (bez pustych).
 *
 * Nowa linia w cudzyslowie nalezy do pola: `split(/\r?\n/)` rozcinal pole
 * "Spolka\nSeria A" na dwa wiersze, a kolejne kolumny sie przesuwaly. Gdy
 * cudzyslow zostaje otwarty do konca pliku (zabłąkany znak w polu, np. 5" rura),
 * reszta jest dzielona zwykla linia, zeby jeden znak nie polknal calego pliku.
 */
export function podzielNaRekordy(tresc: string): string[] {
  const rekordy: string[] = [];
  let poczatek = 0;
  let wCudzyslowie = false;

  for (let i = 0; i < tresc.length; i++) {
    const znak = tresc[i];
    if (znak === '"') {
      wCudzyslowie = !wCudzyslowie;
    } else if (znak === '\n' && !wCudzyslowie) {
      rekordy.push(tresc.slice(poczatek, tresc.endsWith('\r', i) ? i - 1 : i));
      poczatek = i + 1;
    }
  }
  const reszta = tresc.slice(poczatek);
  if (wCudzyslowie) rekordy.push(...reszta.split(/\r?\n/));
  else rekordy.push(reszta);
  return rekordy.filter((rekord) => rekord.trim().length > 0);
}

/**
 * Separator wybrany po spojnosci naglowka z wierszami danych.
 *
 * Sama liczba pol w naglowku nie wystarcza. Naglowek
 * `Data;Symbol;Ilosc;Cena (USD, EUR, GBP, CHF, PLN)` daje po przecinku osiem
 * pol, a po sredniku cztery - przecinek "wygrywal" i caly plik rozsypywal sie
 * na wiersze jednokolumnowe, choc byl poprawny. Prawdziwy separator daje tyle
 * samo pol w naglowku co w danych.
 */
export function wykryjSeparator(naglowek: string, wierszeDanych: string[] = []): string {
  const kandydaci = [';', '\t', ','];
  const probki = wierszeDanych.filter((wiersz) => wiersz.trim().length > 0).slice(0, 5);

  let najlepszy = ',';
  let najlepszaOcena = -1;

  for (const kandydat of kandydaci) {
    const wNaglowku = podzielWiersz(naglowek, kandydat).length;
    if (wNaglowku < 2) continue;

    const zgodne = probki.filter(
      (wiersz) => podzielWiersz(wiersz, kandydat).length === wNaglowku
    ).length;

    // Najpierw liczy sie zgodnosc z danymi, dopiero potem liczba kolumn.
    const ocena = probki.length > 0 ? zgodne * 1000 + wNaglowku : wNaglowku;
    if (ocena > najlepszaOcena) {
      najlepszaOcena = ocena;
      najlepszy = kandydat;
    }
  }
  return najlepszy;
}

/**
 * Konwencja zapisu liczb z przecinkiem w CALEJ kolumnie (jak kolejnosc dat), nie w pojedynczej
 * komorce: "1,234" to 1,234 albo 1234 i sama komorka tego nie rozstrzyga. Silnik czyta "1,234"
 * jako 1234 (grupa tysiecy), wiec zgadywanie po jednej wartosci zmienialoby ilosc lub cene 1000-krotnie.
 *
 * - DZIESIETNY: jakas wartosc ma przecinek z liczba cyfr po nim inna niz trzy (1,5; 0,125; 12,50),
 *   albo przecinek po kropce tysiecy (1.234,56);
 * - TYSIECY: kropka dziesietna po przecinku (1,234.50) albo kilka grup (1,234,567);
 * - NIEJEDNOZNACZNA: wszystkie wartosci z przecinkiem maja postac ^[1-9]\d{0,2},\d{3}$ (albo dowody
 *   sie wykluczaja) - nie zgadujemy, wiersze z takim zapisem sa pomijane z powodem;
 * - BRAK_PRZECINKA: w kolumnie nie ma przecinka.
 */
export type KonwencjaLiczb = 'DZIESIETNY' | 'TYSIECY' | 'NIEJEDNOZNACZNA' | 'SPRZECZNA' | 'BRAK_PRZECINKA';

const GRUPA_TYSIECY = /^[1-9]\d{0,2}(?:,\d{3})+$/;

function bezZnakuIOdstepow(pole: string | undefined): string {
  return (pole ?? '').replace(/"/g, '').replace(/[\s ']/g, '').replace(/^[+-]/, '');
}

export function konwencjaKolumnyLiczb(wartosci: readonly (string | undefined)[]): KonwencjaLiczb {
  let zPrzecinkiem = false;
  let dziesietny = false;
  let tysiace = false;
  let jednaGrupa = false;
  for (const wartosc of wartosci) {
    const tekst = bezZnakuIOdstepow(wartosc);
    if (!tekst.includes(',')) continue;
    zPrzecinkiem = true;
    const przecinek = tekst.lastIndexOf(',');
    const kropka = tekst.lastIndexOf('.');
    if (kropka !== -1) {
      if (kropka > przecinek) tysiace = true;
      else dziesietny = true;
    } else if (GRUPA_TYSIECY.test(tekst)) {
      if (tekst.split(',').length > 2) tysiace = true;
      else jednaGrupa = true;
    } else {
      dziesietny = true;
    }
  }
  if (!zPrzecinkiem) return 'BRAK_PRZECINKA';
  // Sprzeczne dowody (1,234.50 obok 1.234,50): zadna wartosc z separatorami w kolumnie nie jest pewna.
  if (dziesietny && tysiace) return 'SPRZECZNA';
  if (dziesietny) return 'DZIESIETNY';
  if (tysiace) return 'TYSIECY';
  return jednaGrupa ? 'NIEJEDNOZNACZNA' : 'BRAK_PRZECINKA';
}

/** Czy ta wartosc, w kolumnie o niejednoznacznej konwencji, ma zapis typu 1,234 (jedna grupa po przecinku). */
export function niejednoznacznyZapisLiczby(pole: string | undefined, konwencja: KonwencjaLiczb): boolean {
  const tekst = bezZnakuIOdstepow(pole);
  // Kolumna ze sprzecznymi dowodami: pomijamy kazda wartosc z separatorem.
  if (konwencja === 'SPRZECZNA') return /[.,]/.test(tekst);
  if (konwencja !== 'NIEJEDNOZNACZNA') return false;
  return GRUPA_TYSIECY.test(tekst) && tekst.split(',').length === 2;
}

/**
 * Liczba z pola CSV albo `null`.
 *
 * Obsluguje przecinek dziesietny, spacje i twarde spacje w roli separatora
 * tysiecy oraz cudzyslowy. Wartosc ujemna zamienia na dodatnia, bo kierunek
 * operacji niesie osobna kolumna.
 */
export function liczbaZPola(pole: string | undefined, konwencja?: KonwencjaLiczb): number | null {
  if (pole === undefined) return null;
  let tekst = pole.replace(/"/g, '').replace(/[\s\u00a0']/g, '').trim();
  if (!tekst) return null;
  // Wartosc, ktorej zapis przeczy konwencji kolumny, nie jest po cichu przeksztalcana: null.
  const ostatniPrzecinek = tekst.lastIndexOf(',');
  const ostatniaKropka = tekst.lastIndexOf('.');
  if (konwencja === 'SPRZECZNA' && (ostatniPrzecinek !== -1 || ostatniaKropka !== -1)) return null;
  if (konwencja === 'TYSIECY' && ostatniPrzecinek > ostatniaKropka && ostatniaKropka !== -1) return null;
  if (konwencja === 'DZIESIETNY' && ostatniaKropka > ostatniPrzecinek && ostatniPrzecinek !== -1) return null;
  // Kolumna, w ktorej przecinek jest separatorem tysiecy ("1,234.50", "1,234,567"): "1,234" to 1234.
  if (konwencja === 'TYSIECY' && tekst.includes(',')) tekst = tekst.replace(/,/g, '');
  const przecinek = tekst.lastIndexOf(',');
  const kropka = tekst.lastIndexOf('.');
  if (przecinek !== -1 && kropka !== -1) {
    const dziesietny = przecinek > kropka ? ',' : '.';
    tekst = tekst.replace(dziesietny === ',' ? /\./g : /,/g, '').replace(dziesietny, '.');
  } else {
    const separator = przecinek !== -1 ? ',' : kropka !== -1 ? '.' : '';
    if (separator) {
      const czesci = tekst.split(separator);
      // Pojedynczy przecinek jest dziesietny; kilka separatorow grupuje tysiace tylko przy grupach po trzy cyfry.
      const grupowanie = czesci.length > 2 && czesci[0].length > 0 && czesci.slice(1).every((czesc) => /^\d{3}$/.test(czesc));
      tekst = grupowanie ? czesci.join('') : `${czesci.slice(0, -1).join('')}.${czesci.at(-1)}`;
    }
  }
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(tekst)) return null;
  const wartosc = Number(tekst);
  // Znak zostaje: minus przy cenie albo kupnie to blad w pliku, nie liczba dodatnia.
  // O tym, kiedy minus jest konwencja (sprzedaz, prowizja), decyduje importer.
  return Number.isFinite(wartosc) ? wartosc : null;
}

/**
 * Data operacji w formacie RRRR-MM-DD albo `null`.
 *
 * Nierozpoznana data zamieniala sie wczesniej w dzisiejsza. Wiersz z ubieglego
 * roku trafial wtedy do biezacego rozliczenia i byl przeliczany po dzisiejszym
 * kursie NBP, a nic tego nie zdradzalo.
 */
export function dataZPola(surowa: string | undefined, kolejnosc: KolejnoscDaty = 'DMY'): string | null {
  if (!surowa) return null;
  const czysta = surowa.trim().replace(/^"|"$/g, '').slice(0, 19);

  if (/^\d+(?:[.,]\d+)?$/.test(czysta)) {
    const serial = Number(czysta.replace(',', '.'));
    const min = Date.UTC(1990, 0, 1) - Date.UTC(1899, 11, 30);
    const max = Date.UTC(2101, 0, 1) - Date.UTC(1899, 11, 30);
    const dni = serial * 86_400_000;
    if (!Number.isFinite(dni) || dni < min || dni >= max) return null;
    return new Date(Date.UTC(1899, 11, 30) + dni).toISOString().slice(0, 10);
  }

  const rokNaPoczatku = czysta.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (rokNaPoczatku) {
    const [, rok, miesiac, dzien] = rokNaPoczatku;
    return poprawnaData(rok, miesiac, dzien);
  }

  const dzienNaPoczatku = czysta.match(/^(\d{1,2})([-/.])(\d{1,2})[-/.](\d{4})/);
  if (dzienNaPoczatku) {
    const [, pierwsze, separator, drugie, rok] = dzienNaPoczatku;
    // Miesiac przed dniem tylko dla ukosnika i tylko wtedy, gdy plik to udowodnil
    // (kolejnoscDatZUkosnikiem) - kropka i myslnik to zapis polski.
    const [dzien, miesiac] = separator === '/' && kolejnosc === 'MDY' ? [drugie, pierwsze] : [pierwsze, drugie];
    return poprawnaData(rok, miesiac, dzien);
  }

  // Zapis z nazwa miesiaca ("Mar 4, 2026", "4 March 2026") jest jednoznaczny, ale
  // tylko z czterocyfrowym rokiem - data krotka ("03/04/26") nie jest zgadywana
  // parserem przegladarki. Skladniki lokalne: toISOString przesuwal dzien o strefe.
  if (/\b\d{4}\b/.test(czysta) && /[a-z]{3}/i.test(czysta)) {
    const rozpoznana = new Date(czysta);
    if (!Number.isNaN(rozpoznana.getTime())) {
      return poprawnaData(String(rozpoznana.getFullYear()), String(rozpoznana.getMonth() + 1), String(rozpoznana.getDate()));
    }
  }
  return null;
}

/** Data RRRR-MM-DD albo `null`, gdy dzien lub miesiac nie istnieje (13. miesiac, 31 lutego). */
function poprawnaData(rok: string, miesiac: string, dzien: string): string | null {
  const r = Number(rok);
  const m = Number(miesiac);
  const d = Number(dzien);
  const kontrola = new Date(Date.UTC(r, m - 1, d));
  if (m < 1 || m > 12 || d < 1 || kontrola.getUTCMonth() !== m - 1 || kontrola.getUTCDate() !== d) return null;
  return `${rok}-${miesiac.padStart(2, '0')}-${dzien.padStart(2, '0')}`;
}

export type KolejnoscDaty = 'DMY' | 'MDY';

/**
 * Kolejnosc dnia i miesiaca w datach z ukosnikiem w calym pliku.
 *
 * Polskie wyciagi pisza dzien przed miesiacem, eksporty amerykanskie odwrotnie,
 * a z pojedynczej daty 04/03/2026 nie da sie tego rozstrzygnac. Z calego pliku
 * zwykle tak: liczba powyzej 12 moze byc tylko dniem. Miesiac przed dniem
 * przyjmujemy wylacznie wtedy, gdy plik to udowodnil; w pozostalych przypadkach
 * zostaje zapis polski.
 */
export function kolejnoscDatZUkosnikiem(komorki: readonly (string | undefined)[]): KolejnoscDaty {
  let dzienPierwszy = false;
  let miesiacPierwszy = false;
  for (const komorka of komorki) {
    const m = (komorka || '').trim().replace(/^"|"$/g, '').match(/^(\d{1,2})\/(\d{1,2})\/\d{4}/);
    if (!m) continue;
    if (Number(m[1]) > 12) dzienPierwszy = true;
    if (Number(m[2]) > 12) miesiacPierwszy = true;
  }
  return miesiacPierwszy && !dzienPierwszy ? 'MDY' : 'DMY';
}

/**
 * Komorki, z ktorych ustala sie kolejnosc dnia i miesiaca: tylko kolumna daty
 * transakcji. Opis albo komentarz zaczynajacy sie od daty (np. "04/15/2026 dopłata")
 * przestawial caly plik na zapis amerykanski. Bez naglowkow data stoi w pierwszej
 * albo czwartej kolumnie (ksztalty obslugiwane przez importer).
 */
export function komorkiKolumnyDat(wiersze: readonly (readonly string[])[], kolumnaDaty: number | null): (string | undefined)[] {
  if (kolumnaDaty === null) return wiersze.flatMap((czesci) => [czesci[0], czesci[3]]);
  return kolumnaDaty >= 0 ? wiersze.map((czesci) => czesci[kolumnaDaty]) : [];
}

/** Waluty, ktore aplikacja potrafi rozliczyc - zgodne z typem CurrencyCode. */
export const WALUTY_OBSLUGIWANE = [
  'PLN',
  'USD',
  'EUR',
  'GBP',
  'CHF',
  'CAD',
  'NOK',
  'SEK',
  'JPY',
] as const;

export const WALUTY_WIRTUALNE = [
  'BTC', 'ETH', 'SOL', 'ADA', 'XRP', 'DOGE', 'DOT', 'AVAX', 'MATIC', 'LTC',
  'BCH', 'LINK', 'UNI', 'ATOM', 'XLM', 'TRX', 'ETC', 'FIL', 'NEAR', 'ALGO',
  'USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'BNB', 'FDUSD', 'USDP', 'PYUSD',
  'EURC', 'EURI', 'AEUR', 'XUSD', 'SUI', 'TON', 'SHIB', 'PEPE', 'AAVE',
  'ARB', 'OP', 'APT', 'INJ', 'RENDER', 'POL', 'WIF', 'BONK', 'FET', 'ICP',
  'HBAR', 'VET', 'USDD', 'RLUSD',
] as const;

export function czySymbolKrypto(symbol: string): boolean {
  const tekst = symbol.toUpperCase().replace(/[\/\-_]/g, '');
  return WALUTY_WIRTUALNE.some((waluta) =>
    tekst === waluta || (tekst.startsWith(waluta) && tekst.length > waluta.length &&
      [...WALUTY_WIRTUALNE, ...WALUTY_OBSLUGIWANE].some((kwotowana) => tekst === waluta + kwotowana))
  );
}

/** Jawna klasa aktywa z CSV ma pierwszenstwo przed heurystyka symbolu. */
export function kategoriaZPolaKlasy(pole: string | undefined): AssetCategory | null {
  const wartosc = (pole ?? '').trim().toLowerCase();
  if (!wartosc) return null;
  if (/^(crypto|cryptocurrency|digital asset|virtual currency|krypto|kryptowalut\w*)$/.test(wartosc)) return 'CRYPTO';
  if (/^(etf|fund|fundusz|etn)$/.test(wartosc)) return 'ETF';
  if (/^(bond|obligacj\w*|fixed income|debt)$/.test(wartosc)) return 'BOND';
  if (/^(stock|stocks|share|shares|equity|equities|akcj\w*|udzia\w*)$/.test(wartosc)) return 'STOCK_FOREIGN';
  return null;
}

export function kategoriaImportu(symbol: string, jawnaKlasa?: string): AssetCategory {
  const jawna = kategoriaZPolaKlasy(jawnaKlasa);
  if (jawna) return jawna;
  const ticker = symbol.toUpperCase().trim();
  if (czySymbolKrypto(ticker)) return 'CRYPTO';
  if (ticker.startsWith('DGT') || ticker.includes('BOND') || ticker.includes('OBL') || ticker.includes('NOTE')) return 'BOND';
  if (ticker.endsWith('.PL') || ['CDR', 'DNP', 'PKN', 'PKO', 'PZU', 'KGH', 'ALE', 'LPP'].includes(ticker)) return 'STOCK_PL';
  if (['VOO', 'SPY', 'QQQ', 'VWCE', 'EUNL', 'CSPX', 'SXR8', 'VUSA'].includes(ticker) || ticker.includes('ETF')) return 'ETF';
  return 'STOCK_FOREIGN';
}

/**
 * Waluta z pola CSV albo `null`.
 *
 * Wczesniej sciezka bez naglowkow robila `parts[6]?.toUpperCase() as CurrencyCode`
 * - rzutowanie bez sprawdzenia, wiec "AUD" albo dowolny smiec wchodzil do
 * rozliczenia jako waluta, a brak pola dawal USD.
 */
export function walutaZPola(pole: string | undefined, krypto = false): CurrencyCode | null {
  const oczyszczone = (pole || '').replace(/["']/g, '').toUpperCase().trim();
  return ((WALUTY_OBSLUGIWANE as readonly string[]).includes(oczyszczone) ||
    (krypto && (WALUTY_WIRTUALNE as readonly string[]).includes(oczyszczone)))
    ? (oczyszczone as CurrencyCode)
    : null;
}

export function walutyImportu(
  walutaRozliczenia: string | undefined,
  walutaProwizji: string | undefined,
  krypto: boolean,
  walorGpw = false,
): { currency: CurrencyCode | null; commissionCurrency: CurrencyCode | null } {
  // Walor z GPW bez kolumny waluty jest notowany w zlotych. Ta domyslna wartosc
  // stala kiedys w importerze PRZED odczytem waluty i byla nim nadpisywana, wiec
  // wiersze z polskiego wyciagu bez kolumny waluty szly do pominietych.
  const currency = walorGpw && !(walutaRozliczenia || '').trim()
    ? 'PLN'
    : walutaZPola(walutaRozliczenia, krypto);
  const commissionCurrency = walutaProwizji?.trim()
    ? walutaZPola(walutaProwizji, krypto)
    : currency;
  return { currency, commissionCurrency };
}

/**
 * Znak liczby sztuk i ceny z wiersza CSV.
 *
 * Minus przy liczbie sztuk to czesta konwencja zapisu sprzedazy; przy kupnie albo
 * dywidendzie - i zawsze przy cenie - to blad w pliku. Wczesniej parser zdejmowal
 * kazdy minus, wiec ujemna cena albo ilosc stawaly sie poprawnymi liczbami.
 */
export function znakIlosciICeny(
  ilosc: number | null,
  cena: number | null,
  rodzaj: TransactionType | null,
): { ilosc: number | null; cena: number | null; braki: string[] } {
  const braki: string[] = [];
  const wynikIlosc = ilosc !== null && ilosc < 0 && rodzaj === 'SELL' ? Math.abs(ilosc) : ilosc;
  if (wynikIlosc !== null && wynikIlosc < 0) braki.push('ujemna liczba sztuk');
  else if (wynikIlosc === null || wynikIlosc === 0) braki.push('brak liczby sztuk');
  if (cena !== null && cena < 0) braki.push('ujemna cena');
  else if (cena === null || cena === 0) braki.push('brak ceny jednostkowej');
  return { ilosc: wynikIlosc, cena, braki };
}

/**
 * Liczba sztuk i kwota opłaty (FEE) z wiersza CSV.
 *
 * Opłata nie ma liczby sztuk ani symbolu: kwota siedzi w cenie albo w prowizji (tak ją czyta
 * silnik: prowizja, a gdy jej brak - cena). Brak obu jest brakiem kwoty, nie zerową opłatą.
 */
export function znakIlosciICenyOplaty(
  ilosc: number | null,
  cena: number | null,
  prowizja: number,
): { ilosc: number | null; cena: number | null; braki: string[] } {
  const braki: string[] = [];
  if (ilosc !== null && ilosc < 0) braki.push('ujemna liczba sztuk');
  const kwota = cena === null ? 0 : Math.abs(cena);
  if (kwota === 0 && prowizja === 0) braki.push('brak kwoty opłaty');
  return { ilosc: ilosc ?? 0, cena: kwota, braki };
}

/**
 * Czy linia CSV jest wierszem danych (data i co najmniej dwie liczby), a nie naglowkiem.
 * Tylko taki plik bez rozpoznanego naglowka czytamy pozycyjnie.
 */
export function wygladaJakWierszDanych(komorki: readonly string[]): boolean {
  const oczyszczone = komorki.map((komorka) => komorka.trim().replace(/^"|"$/g, ''));
  const data = oczyszczone.some((komorka) =>
    /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|^\d{1,2}[-/.]\d{1,2}[-/.]\d{4}/.test(komorka) && dataZPola(komorka) !== null);
  return data && oczyszczone.filter((komorka) => liczbaZPola(komorka) !== null).length >= 2;
}

/**
 * Kolumny stawki (%) i kwoty podatku u źródła (WHT) z nagłówka CSV.
 *
 * Nagłówek musi wskazywać podatek (WHT, withholding, "u źródła") albo "tax"/"podatek" ze słowem
 * stawka/rate/% (stawka) albo kwota/amount (kwota). Sam "Tax" bez określenia nie jest brany:
 * mógłby być podatkiem od transakcji, nie u źródła.
 */
export function kolumnyPodatkuZrodlaCsv(headers: string[]): { stawkaCol: number; kwotaCol: number } {
  const podatek = (h: string) => /wht|withhold|u źródła|u zrodla|podatek|podatku|tax/.test(h);
  const stawka = (h: string) => /%|stawk|rate|procent/.test(h);
  const kwota = (h: string) => /kwot|amount|value|wartość|wartosc/.test(h);
  return {
    stawkaCol: headers.findIndex((h) => podatek(h) && stawka(h)),
    kwotaCol: headers.findIndex((h) => podatek(h) && !stawka(h) && kwota(h)),
  };
}

/**
 * Kolumna ceny jednostkowej waloru.
 *
 * Pierwszy naglowek z "kurs" albo "rate" bywal kursem waluty ("Kurs waluty",
 * "Kurs NBP", "FX rate") - gdy stal przed kolumna "Cena", kurs dolara stawal sie
 * cena akcji i koszt nabycia wychodzil z powietrza. Najpierw "price"/"cena",
 * dopiero potem "kurs"/"rate"/"cost", zawsze z pominieciem kolumn walutowych.
 */
export function kolumnaCenyCsv(headers: string[]): number {
  // Kolumny podatku ("Withholding tax rate", "Kwota podatku") tez nie sa cena.
  const walutowa = (h: string) => /walut|currency|fx|exchange|nbp|tax|podat|wht|withhold/.test(h);
  // "Cena całkowita", "Total price", "Wartość" to kwota za cala transakcje, nie za sztuke -
  // wzieta jako cena jednostkowa mnozyla wartosc transakcji przez liczbe sztuk.
  const laczna = (h: string) => /całkowit|calkowit|łączn|łaczn|lączn|laczn|total|suma|wartość|wartosc|amount|kwota/.test(h);
  const cenowa = (h: string) => h.includes('price') || h.includes('cena');
  const kursowa = (h: string) => h.includes('kurs') || h.includes('rate') || h.includes('cost');
  const jednostkowa = headers.findIndex((h) =>
    (cenowa(h) || kursowa(h)) && /jednostk|unit|per share|za szt|za 1/.test(h) && !walutowa(h));
  if (jednostkowa !== -1) return jednostkowa;
  const cena = headers.findIndex((h) => cenowa(h) && !walutowa(h) && !laczna(h));
  if (cena !== -1) return cena;
  return headers.findIndex((h) => kursowa(h) && !walutowa(h) && !laczna(h));
}

export function kolumnyWalutCsv(headers: string[]) {
  const prowizja = (h: string) => /comm|prowizja|fee|opłata|oplata/.test(h);
  const waluta = (h: string) => /curr|currency|waluta/.test(h);
  const walutaProwizji = (h: string) => prowizja(h) && (waluta(h) || /asset|coin|token/.test(h));
  return {
    currCol: headers.findIndex((h) => waluta(h) && !prowizja(h)),
    commCol: headers.findIndex((h) => prowizja(h) && !walutaProwizji(h)),
    commCurrCol: headers.findIndex(walutaProwizji),
  };
}

/**
 * Rodzaj operacji z pola CSV albo `null`.
 *
 * Nierozpoznana wartosc stawala sie zakupem, czyli kosztem i partia FIFO,
 * ktorych w wyciagu nie bylo.
 */
export function rodzajZPola(pole: string | undefined): TransactionType | null {
  const t = (pole || '').toUpperCase().trim();
  if (!t) return null;
  // Wiersz podatku ("Dividend Tax", "Podatek od dywidendy", "Withholding") zawiera
  // "DIV"/"DYW", ale to potracenie, nie dochod - jako dywidenda zawyzalby czesc G.
  if (/TAX|PODAT|WHT|WITHHOLD|U ZRODLA|U ŹRÓDŁA/.test(t)) return null;
  if (t.includes('DIV') || t.includes('DYW') || t.includes('INTEREST') || t.includes('ODSET')) {
    return 'DIVIDEND';
  }
  // Opłata (typ FEE z eksportu aplikacji i jego odpowiedniki) - przed kupnem/sprzedażą,
  // żeby "Opłata za zakup" nie stała się zakupem.
  if (t === 'FEE' || t === 'FEES' || t.includes('OPŁAT') || t.includes('OPLAT') || t.includes('PROWIZ') || t.includes('COMMISSION')) {
    return 'FEE';
  }
  if (t.includes('SELL') || t.includes('SPRZED') || t === 'S' || t === 'ZBYCIE') return 'SELL';
  if (t.includes('BUY') || t.includes('KUP') || t.includes('ZAKUP') || t === 'B' || t === 'K') {
    return 'BUY';
  }
  return null;
}
