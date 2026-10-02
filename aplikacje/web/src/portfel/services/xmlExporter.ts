import { TaxYearSummary, TaxRealizedGain, DividendTaxItem, BrokerAccount } from '../types';
import { KODY_KRAJOW_MF } from '../data/kodyKrajowMf';
import { dzisiajLokalnie } from './formularzTransakcji';

/**
 * Wzory PIT-38 potwierdzone w Centralnym Repozytorium Wzorow (crd.gov.pl).
 *
 * Sprawdzone 2026-09-13 przez pobranie schematu i odczytanie atrybutu
 * `kodSystemowy`. Numeracja pozycji zmienila sie miedzy wariantem 14 (2019)
 * a 16: wiersz ulgi IPO (art. 21 ust. 1 pkt 105a) przesunal wszystko od
 * poz. 24 o dwa w gore. Wczesniej w kodzie stal adres
 * http://crd.gov.pl/wzor/2023/12/15/13100/, ktorego CRD nie zna.
 */
const WZORY_PIT38 = [
  {
    odRoku: 2025,
    wariant: '18',
    wersjaSchemy: '1-0E',
    przestrzenNazw: 'http://crd.gov.pl/wzor/2025/10/09/13914/',
    opis: 'PIT-38(18), wzór 2025/10/09/13914',
  },
  {
    odRoku: 2024,
    wariant: '17',
    wersjaSchemy: '1-0E',
    przestrzenNazw: 'http://crd.gov.pl/wzor/2024/10/15/13539/',
    opis: 'PIT-38(17), wzór 2024/10/15/13539',
  },
  {
    odRoku: 2023,
    wariant: '16',
    wersjaSchemy: '2-0E',
    przestrzenNazw: 'http://crd.gov.pl/wzor/2023/10/23/12948/',
    opis: 'PIT-38(16), wzór 2023/10/23/12948',
  },
] as const;

/** Najnowszy wzor obowiazujacy dla danego roku podatkowego. */
export function wzorPit38DlaRoku(rok: number): (typeof WZORY_PIT38)[number] | null {
  return WZORY_PIT38.find((wzor) => rok >= wzor.odRoku) ?? null;
}

/** Czy istnieje potwierdzony wariant wzoru dla danego roku podatkowego. */
export function czyWzorPit38PotwierdzonyDlaRoku(rok: number): boolean {
  const ostatniPotwierdzonyRok = Math.max(...WZORY_PIT38.map((wzor) => wzor.odRoku));
  return wzorPit38DlaRoku(rok) !== null && rok <= ostatniPotwierdzonyRok;
}

/** Ostrzeżenie przed eksportem za rok bez potwierdzonego wzoru; null, gdy wzór jest potwierdzony. */
export function ostrzezenieOWzorzePit38(rok: number): string | null {
  if (czyWzorPit38PotwierdzonyDlaRoku(rok)) return null;
  const wzor = wzorPit38DlaRoku(rok);
  return wzor
    ? `Wzór PIT-38 za ${rok} r. nie jest jeszcze potwierdzony — plik użyje wariantu ${wzor.wariant}; sprawdź na podatki.gov.pl przed wysyłką.`
    : `Brak wzoru PIT-38 dla ${rok} r. — sprawdź obowiązujący wzór na podatki.gov.pl przed wysyłką.`;
}

/**
 * Dane podatnika wymagane przez schemat.
 *
 * TIdentyfikatorOsobyFizycznej1 wymaga NIP albo PESEL, imienia, nazwiska
 * i daty urodzenia; Podmiot1 dodatkowo adresu zamieszkania. Bez adresu i daty
 * urodzenia plik nie przechodzil walidacji, mimo ze wygladal na kompletny.
 */
export interface DanePodatnika {
  peselOrNip?: string;
  firstName?: string;
  lastName?: string;
  /** Format RRRR-MM-DD. */
  birthDate?: string;
  taxOfficeCode?: string;
  wojewodztwo?: string;
  powiat?: string;
  gmina?: string;
  ulica?: string;
  nrDomu?: string;
  nrLokalu?: string;
  miejscowosc?: string;
  kodPocztowy?: string;
}

function downloadBlob(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/** Data urodzenia zakodowana w PESEL (miesiac +20 dla lat 2000-2099 itd.). */
export function dataUrodzeniaZPesel(pesel: string): string | null {
  if (!/^\d{11}$/.test(pesel)) return null;
  const rr = Number(pesel.slice(0, 2));
  let miesiac = Number(pesel.slice(2, 4));
  const dzien = Number(pesel.slice(4, 6));
  let stulecie = 1900;
  if (miesiac > 80) { stulecie = 1800; miesiac -= 80; }
  else if (miesiac > 60) { stulecie = 2200; miesiac -= 60; }
  else if (miesiac > 40) { stulecie = 2100; miesiac -= 40; }
  else if (miesiac > 20) { stulecie = 2000; miesiac -= 20; }
  const rok = stulecie + rr;
  const data = new Date(Date.UTC(rok, miesiac - 1, dzien));
  if (data.getUTCFullYear() !== rok || data.getUTCMonth() !== miesiac - 1 || data.getUTCDate() !== dzien) return null;
  return `${rok}-${String(miesiac).padStart(2, '0')}-${String(dzien).padStart(2, '0')}`;
}

export function peselPoprawny(pesel: string): boolean {
  if (!/^\d{11}$/.test(pesel) || dataUrodzeniaZPesel(pesel) === null) return false;
  const wagi = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3];
  const suma = wagi.reduce((acc, waga, i) => acc + waga * Number(pesel[i]), 0);
  return (10 - (suma % 10)) % 10 === Number(pesel[10]);
}

export function nipPoprawny(nip: string): boolean {
  if (!/^\d{10}$/.test(nip)) return false;
  const wagi = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  const reszta = wagi.reduce((acc, waga, i) => acc + waga * Number(nip[i]), 0) % 11;
  return reszta !== 10 && reszta === Number(nip[9]);
}

/**
 * Data RRRR-MM-DD, ktora istnieje w kalendarzu i miesci sie w typie TData
 * schematu (od 1900-01-01), a jako data urodzenia nie jest z przyszlosci.
 * Sam wzorzec przepuszczal 2026-02-31, a e-Deklaracje odrzucaja taki plik.
 */
export function dataIstnieje(tekst: string, dzisiaj: Date = new Date()): boolean {
  const czesci = /^(\d{4})-(\d{2})-(\d{2})$/.exec(tekst);
  if (!czesci) return false;
  const [rok, miesiac, dzien] = [Number(czesci[1]), Number(czesci[2]), Number(czesci[3])];
  const data = new Date(Date.UTC(rok, miesiac - 1, dzien));
  if (data.getUTCFullYear() !== rok || data.getUTCMonth() !== miesiac - 1 || data.getUTCDate() !== dzien) return false;
  return tekst >= '1900-01-01' && tekst <= dzisiajLokalnie(dzisiaj);
}

/**
 * Sklada plik XML zeznania PIT-38 w ukladzie e-Deklaracji.
 *
 * Numery pozycji pochodza z broszury Ministerstwa Finansow do PIT-38 za 2025 r.
 * (https://www.podatki.gov.pl/media/g5ebnm2e/broszura-do-pit-38-za-2025-r.pdf):
 *   czesc C  20-21 kwoty z PIT-8C, 22-23 pozostale i zagraniczne,
 *            24-25 ulga IPO, 26-27 razem, 28 dochod, 29 strata,
 *   czesc D  30 straty z lat ubieglych, 31 podstawa, 32 stawka, 33 podatek,
 *            34 podatek zaplacony za granica, 35 podatek nalezny,
 *   czesc E  36 przychod z walut wirtualnych, 37 koszty roku,
 *            38 koszty z lat ubieglych, 39 dochod, 40 koszty do przeniesienia,
 *   czesc F  41 podstawa, 42 stawka, 43 podatek, 44 podatek za granica,
 *            45 podatek nalezny,
 *   czesc G  46-49 zryczaltowany podatek, 51 do zaplaty, 52 nadplata.
 *
 * Wczesniej plik uzywal numeracji z PIT-38(14) z 2019 r. (sprawdzone w schemacie
 * http://crd.gov.pl/wzor/2019/12/23/8985/schemat.xsd), w ktorej czesc E zaczyna
 * sie od poz. 34, a laczny podatek stoi w poz. 48. Wiersz ulgi IPO dodany za
 * 2022 r. przesunal wszystko od poz. 24 w gore o dwa, wiec kwoty trafialy do
 * cudzych pol: dochod z krypto do "podatku zaplaconego za granica", a laczny
 * podatek do zaplaty do "zryczaltowanego podatku od dywidend zagranicznych".
 */
export function generatePit38XML(
  summary: TaxYearSummary,
  realizedGains: TaxRealizedGain[],
  dividends: DividendTaxItem[],
  taxpayerData?: DanePodatnika
): string {
  const year = summary.year;

  /** Pelne zlote z liczby, ktora moze byc undefined albo NaN. */
  const zlote = (wartosc: number | undefined): number =>
    Number.isFinite(wartosc as number) ? Math.round(wartosc as number) : 0;
  /** Grosze jako liczba całkowita, aby różnice pozycji nie traciły centów. */
  const grosze = (wartosc: number | undefined): number =>
    Number.isFinite(wartosc as number) ? Math.round((wartosc as number) * 100) : 0;
  const kwota2 = (wartoscWGroszach: number): string => (wartoscWGroszach / 100).toFixed(2);
  const polaSilnika = (summary as TaxYearSummary & { engineFormFields?: Record<string, number> }).engineFormFields;
  const poleGrosze = (pozycja: string): number | undefined =>
    polaSilnika?.[pozycja] === undefined ? undefined : grosze(polaSilnika[pozycja]);

  // CZESC C - dochody i straty z art. 30b ust. 1.
  const przychodRazem = grosze(summary.revenuePLN);
  const kosztyRazem = grosze(summary.costsPLN);
  let p20: number;
  let p21: number;
  let p22: number;
  let p23: number;
  // Pola silnika dla czesci C tylko w komplecie. Mapa z samymi poz. 31 i 45-51
  // (zwykly przebieg przed publikacja wszystkich pozycji) dawala tu zera w
  // poz. 20-29 obok dodatniej poz. 31 - XML zgodny ze schematem, ale sprzeczny.
  const czescCZSilnika = ['20', '21', '22', '23'].every((pozycja) => polaSilnika?.[pozycja] !== undefined);
  if (czescCZSilnika) {
    p20 = poleGrosze('20') ?? 0;
    p21 = poleGrosze('21') ?? 0;
    p22 = poleGrosze('22') ?? 0;
    p23 = poleGrosze('23') ?? 0;
  } else if (summary.pit8cZrodlo === 'informacja') {
    // Wiersz 1 to kwoty z otrzymanej informacji PIT-8C - urzad porownuje
    // zeznanie wlasnie z nia, wiec nie wolno ich przyciac do wlasnego
    // rachunku. Wiersz 2 zostaje przy tym, co aplikacja policzyla poza
    // rachunkami objetymi ta informacja.
    p20 = Math.max(0, grosze(summary.pit8cRevenuePLN));
    p21 = Math.max(0, grosze(summary.pit8cCostsPLN));
    if (summary.foreignRevenuePLN === undefined || summary.foreignCostsPLN === undefined) {
      throw new Error('Brak wiarygodnego podziału rachunków dla PIT-8C. Sprawdź przypisanie transakcji do rachunków przed eksportem.');
    }
    p22 = Math.max(0, grosze(summary.foreignRevenuePLN));
    p23 = Math.max(0, grosze(summary.foreignCostsPLN));
  } else {
    // Bez informacji PIT-8C reszta jest roznica kwot w groszach. Dzieki temu
    // suma wierszy odpowiada poz. 26 i 27 bez osobnego zaokraglania.
    p20 = Math.min(Math.max(0, grosze(summary.pit8cRevenuePLN)), przychodRazem);
    p21 = Math.min(Math.max(0, grosze(summary.pit8cCostsPLN)), kosztyRazem);
    p22 = przychodRazem - p20;
    p23 = kosztyRazem - p21;
  }
  // Poz. 24 i 25 to wiersz 3 - dochod zwolniony z ulgi IPO (art. 21 ust. 1
  // pkt 105a). Aplikacja nie sledzi daty pierwszej oferty publicznej ani
  // powiazan ze spolka, wiec nie potrafi tej ulgi wyliczyc. Zero znaczy tu
  // "nie korzystam z ulgi"; kto z niej korzysta, wpisuje kwoty recznie.
  const p24 = poleGrosze('24') ?? 0;
  const p25 = poleGrosze('25') ?? 0;
  const p26 = poleGrosze('26') ?? p20 + p22 - p24;
  const p27 = poleGrosze('27') ?? p21 + p23 - p25;
  // Dochod i strata licza sie z poz. 26 i 27, a nie z osobno zaokraglonych
  // sum z podsumowania - inaczej formularz sie nie domyka i urzad przelicza
  // deklaracje na inna podstawe.
  const p28 = poleGrosze('28') ?? Math.max(0, p26 - p27);
  const p29 = poleGrosze('29') ?? Math.max(0, p27 - p26);

  // CZESC D - obliczenie zobowiazania z art. 30b ust. 1.
  // Poz. 30 nie moze przekroczyc poz. 28 (broszura MF).
  const p30 = poleGrosze('30') ?? Math.min(Math.max(0, grosze(summary.priorYearLossUsedPLN)), p28);
  const p31 = polaSilnika?.['31'] ?? Math.max(0, zlote((p28 - p30) / 100));
  const p32 = 19;
  const p33 = poleGrosze('33') ?? p31 * p32; // w groszach
  // Poz. 34 to podatek zaplacony za granica OD DOCHODOW Z ART. 30B (zbycie
  // papierow), a nie podatek u zrodla od dywidend - ten idzie do czesci G.
  // Aplikacja nie zbiera podatku zaplaconego za granica od zyskow ze zbycia,
  // wiec pozycja zostaje pusta zamiast dostac cudza kwote.
  const p34 = poleGrosze('34') ?? 0;
  const p35 = polaSilnika?.['35'] ?? Math.max(0, zlote((p33 - p34) / 100));

  // Kontrola rachunkowa czesci C i D przed zapisem pliku. Schemat XSD jej nie
  // robi: czesciowa mapa pol silnika dala kiedys plik zgodny ze schematem, ale
  // z zerami w poz. 20-29 obok podstawy w poz. 31. Sprzecznego pliku nie wydajemy.
  const bledySpojnosci: string[] = [];
  if (p26 !== p20 + p22 - p24) bledySpojnosci.push('poz. 26 ≠ 20 + 22 − 24');
  if (p27 !== p21 + p23 - p25) bledySpojnosci.push('poz. 27 ≠ 21 + 23 − 25');
  if (p28 !== Math.max(0, p26 - p27)) bledySpojnosci.push('poz. 28 ≠ 26 − 27');
  if (p29 !== Math.max(0, p27 - p26)) bledySpojnosci.push('poz. 29 ≠ 27 − 26');
  if (p30 > p28) bledySpojnosci.push('poz. 30 > poz. 28');
  if (p31 !== Math.max(0, zlote((p28 - p30) / 100))) bledySpojnosci.push('poz. 31 ≠ pełne zł z 28 − 30');
  if (p33 !== p31 * p32) bledySpojnosci.push('poz. 33 ≠ 19% z poz. 31');
  if (p34 > p33) bledySpojnosci.push('poz. 34 > poz. 33');
  if (p35 !== Math.max(0, zlote((p33 - p34) / 100))) bledySpojnosci.push('poz. 35 ≠ pełne zł z 33 − 34');
  if (bledySpojnosci.length > 0) {
    throw new Error(
      `Deklaracja nie jest spójna rachunkowo (${bledySpojnosci.join('; ')}). ` +
        'Przelicz rozliczenie w silniku przed eksportem.'
    );
  }

  // CZESC E - odplatne zbycie walut wirtualnych (poz. 36-40).
  //
  // Dochod i koszty do przeniesienia licza sie z zaokraglonych poz. 36-38,
  // a nie z osobno zaokraglonego dochodu z podsumowania. Inaczej przy
  // przychodzie 106,49 i kosztach 103,50 formularz pokazywal 106 - 104 = 2,
  // a w poz. 39 dochod 3.
  const p36 = polaSilnika?.['36'] ?? Math.max(0, grosze(summary.cryptoRevenuePLN) / 100);
  const p38 = polaSilnika?.['38'] ?? Math.max(0, grosze(summary.cryptoCostsCarriedInPLN) / 100);
  const p37 = polaSilnika?.['37'] ?? Math.max(
    0,
    summary.cryptoCostsCurrentYearPLN !== undefined
      ? grosze(summary.cryptoCostsCurrentYearPLN) / 100
      : grosze(summary.cryptoCostsPLN) / 100 - p38
  );
  const p39 = polaSilnika?.['39'] ?? Math.max(0, Math.round((p36 - p37 - p38) * 100) / 100);
  const p40 = polaSilnika?.['40'] ?? Math.max(0, Math.round((p37 + p38 - p36) * 100) / 100);
  const maCzescE = p36 > 0 || p37 > 0 || p38 > 0;

  // CZESC F - obliczenie zobowiazania z art. 30b ust. 1a (poz. 41-45).
  // Poz. 43 i 44 maja grosze (TKwota2), poz. 41 i 45 pelne zlote. Roznica
  // 43 - 44 idzie na groszach calkowitych: 4,35 - 0,85 w liczbach
  // zmiennoprzecinkowych to 3,4999..., wiec zaokraglenie dawalo 3 zamiast 4.
  const p41 = polaSilnika?.['41'] ?? Math.max(0, zlote(p39));
  const p42 = polaSilnika?.['42'] ?? 19;
  const p43 = polaSilnika?.['43'] ?? Math.round(p41 * p42) / 100;
  const p44 = polaSilnika?.['44'] ?? 0;
  const p45 = polaSilnika?.['45'] ?? Math.max(0, zlote((grosze(p43) - grosze(p44)) / 100));

  // Kontrola rachunkowa czesci E i F - ta sama zasada co dla C i D.
  if (maCzescE) {
    const bledyKrypto: string[] = [];
    if (grosze(p39) !== Math.max(0, grosze(p36) - grosze(p37) - grosze(p38))) bledyKrypto.push('poz. 39 ≠ 36 − 37 − 38');
    if (grosze(p40) !== Math.max(0, grosze(p37) + grosze(p38) - grosze(p36))) bledyKrypto.push('poz. 40 ≠ 37 + 38 − 36');
    if (p41 !== Math.max(0, zlote(p39))) bledyKrypto.push('poz. 41 ≠ pełne zł z poz. 39');
    if (grosze(p43) !== Math.round(p41 * p42)) bledyKrypto.push('poz. 43 ≠ stawka z poz. 41');
    if (grosze(p44) > grosze(p43)) bledyKrypto.push('poz. 44 > poz. 43');
    if (p45 !== Math.max(0, zlote((grosze(p43) - grosze(p44)) / 100))) bledyKrypto.push('poz. 45 ≠ pełne zł z 43 − 44');
    if (bledyKrypto.length > 0) {
      throw new Error(
        `Deklaracja nie jest spójna rachunkowo (${bledyKrypto.join('; ')}). ` +
          'Przelicz rozliczenie w silniku przed eksportem.'
      );
    }
  }

  // CZESC G - zryczaltowany podatek dochodowy (poz. 46-52).
  // Poz. 47: 19% przychodu z dywidend i odsetek zagranicznych (art. 30a
  // ust. 1 pkt 1-5). Poz. 48: podatek zaplacony za granica, ale tylko do
  // wysokosci limitu z art. 30a ust. 9 - dlatego bierze sie go z roznicy
  // policzonej przez silnik, a nie z calej kwoty pobranej u zrodla.
  const p47 = Math.max(0, poleGrosze('47') ?? grosze(summary.dividendPolishTaxDuePLN));
  const dywidendyDoZaplaty = Math.min(Math.max(0, grosze(summary.dividendTaxToPayPLN)), p47);
  const p48 = poleGrosze('48') ?? (summary.dividendCreditUsedPLN !== undefined
    ? Math.max(0, grosze(summary.dividendCreditUsedPLN))
    : p47 - dywidendyDoZaplaty);
  const p49 = poleGrosze('49') ?? dywidendyDoZaplaty;
  const p46 = Math.max(0, polaSilnika?.['46'] ?? 0);
  const p50 = Math.max(0, polaSilnika?.['50'] ?? 0);
  // Gotowa poz. 51 z projekcji pakietu ma pierwszenstwo przed suma pomocnicza.
  const p51 = polaSilnika?.['51'] !== undefined
    ? grosze(polaSilnika['51'])
    : summary.formTaxToPayPLN !== undefined
    ? Math.max(0, grosze(summary.formTaxToPayPLN))
    : Math.max(0, (p35 + p45 + p46 - p50) * 100 + p49);
  const p52 = Math.max(0, (p50 - p35 - p45 - p46) * 100 - p49);
  const maCzescG = p46 > 0 || p47 > 0 || p48 > 0 || p49 > 0 || p50 > 0;
  const dywidendyPodatekZagraniczny = Math.max(0, grosze(summary.dividendForeignTaxPLN));
  const nieodliczonyPodatekZagraniczny = Math.max(0, dywidendyPodatekZagraniczny - p48);

  // Dane podatnika musza byc prawdziwe i kompletne.
  //
  // Wczesniej puste pola zamienialy sie w "JAN KOWALSKI" z numerem PESEL
  // 00000000000 i urzedem 0201. Plik wygladal na gotowy do wyslania i niosl
  // cudza, wymyslona tozsamosc na deklaracji podatkowej.
  //
  // Zestaw pol wynika ze schematu: TIdentyfikatorOsobyFizycznej1 wymaga
  // NIP albo PESEL, imienia, nazwiska i daty urodzenia, a Podmiot1 dodatkowo
  // adresu zamieszkania (TAdresPolski1: wojewodztwo, powiat, gmina, numer
  // domu, miejscowosc, kod pocztowy).
  // Dane wpisane recznie ida do tresci XML. Znak & w nazwisku ("Kowalski & Nowak")
  // albo < w adresie dawal dokument, ktorego e-Deklaracje nie sparsuja.
  const xmlTekst = (tekst: string): string => tekst
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  const identyfikator = (taxpayerData?.peselOrNip ?? '').trim();
  const imie = (taxpayerData?.firstName ?? '').trim();
  const nazwisko = (taxpayerData?.lastName ?? '').trim();
  const urzad = (taxpayerData?.taxOfficeCode ?? '').trim();
  const dataUrodzenia = (taxpayerData?.birthDate ?? '').trim();
  const wojewodztwo = (taxpayerData?.wojewodztwo ?? '').trim();
  const powiat = (taxpayerData?.powiat ?? '').trim();
  const gmina = (taxpayerData?.gmina ?? '').trim();
  const ulica = (taxpayerData?.ulica ?? '').trim();
  const nrDomu = (taxpayerData?.nrDomu ?? '').trim();
  const nrLokalu = (taxpayerData?.nrLokalu ?? '').trim();
  const miejscowosc = (taxpayerData?.miejscowosc ?? '').trim();
  const kodPocztowy = (taxpayerData?.kodPocztowy ?? '').trim();

  const brakujaceDane: string[] = [];
  if (!imie) brakujaceDane.push('imię podatnika');
  if (!nazwisko) brakujaceDane.push('nazwisko podatnika');
  if (!/^\d{10}$|^\d{11}$/.test(identyfikator)) brakujaceDane.push('PESEL (11 cyfr) albo NIP (10 cyfr)');
  // Sama liczba cyfr przepuszczala np. 00000000000 - e-Deklaracje odrzucaja
  // dokument przy weryfikacji podatnika. Suma kontrolna wylapuje literowke.
  else if (identyfikator.length === 11 && !peselPoprawny(identyfikator)) {
    brakujaceDane.push('poprawny PESEL (suma kontrolna albo data w numerze się nie zgadza)');
  } else if (identyfikator.length === 10 && !nipPoprawny(identyfikator)) {
    brakujaceDane.push('poprawny NIP (suma kontrolna się nie zgadza)');
  } else if (identyfikator.length === 11 && /^\d{4}-\d{2}-\d{2}$/.test(dataUrodzenia)
    && dataUrodzeniaZPesel(identyfikator) !== dataUrodzenia) {
    brakujaceDane.push('data urodzenia zgodna z numerem PESEL');
  }
  if (!dataIstnieje(dataUrodzenia)) brakujaceDane.push('data urodzenia (istniejąca data RRRR-MM-DD, nie późniejsza niż dziś)');
  if (!/^\d{4}$/.test(urzad)) brakujaceDane.push('czterocyfrowy kod urzędu skarbowego');
  if (!wojewodztwo) brakujaceDane.push('województwo');
  if (!powiat) brakujaceDane.push('powiat');
  if (!gmina) brakujaceDane.push('gmina');
  if (!nrDomu) brakujaceDane.push('numer domu');
  if (!miejscowosc) brakujaceDane.push('miejscowość');
  if (!/^\d{2}-\d{3}$/.test(kodPocztowy)) brakujaceDane.push('kod pocztowy (00-000)');
  if (brakujaceDane.length > 0) {
    throw new Error(`Nie można wygenerować deklaracji — uzupełnij: ${brakujaceDane.join(', ')}.`);
  }

  const wzor = wzorPit38DlaRoku(year);
  if (!wzor) {
    throw new Error(
      `Nie mam potwierdzonego wzoru PIT-38 za ${year} r. Najstarszy sprawdzony w Centralnym ` +
        'Repozytorium Wzorów to PIT-38(16) za 2023 r.'
    );
  }

  // Zalacznik PIT/ZG obejmuje WYLACZNIE dochody z art. 30b (odplatne zbycie),
  // skladany odrebnie dla kazdego panstwa. Dywidendy z art. 30a nie maja w nim
  // wlasnych pozycji - rozlicza sie je w czesci G samego PIT-38 (poz. 47-49).
  // Wczesniej wpisywalismy tu przychod brutto z dywidend i pobrany od nich
  // podatek, czyli kwoty z zupelnie innego zrodla.
  const KRAJ_Z_RYNKU: Record<string, string> = {
    US: 'US', US_: 'US', NASDAQ: 'US', NYSE: 'US',
    DE: 'DE', FR: 'FR', NL: 'NL', IT: 'IT', ES: 'ES', GB: 'GB', L: 'GB',
    PL: 'PL', WSE: 'PL', CH: 'CH', SE: 'SE', NO: 'NO', DK: 'DK', CA: 'CA', JP: 'JP',
  };

  /** Kod kraju z sufiksu tickera (np. `NBIS.US`), gdy da sie go odczytac. */
  const krajZTickera = (ticker: string): string | null => {
    const sufiks = ticker.includes('.') ? ticker.split('.').pop()!.toUpperCase() : '';
    return KRAJ_Z_RYNKU[sufiks] ?? null;
  };

  // Waluta rozliczenia to slabsza przeslanka niz sufiks tickera: papier
  // notowany w dolarach nie musi byc amerykanski (NBIS jest holenderski),
  // a euro nic nie mowi o panstwie - dlatego EUR nie ma tu wpisu. Kraj wziety
  // stad jest oznaczony w pliku, zeby dalo sie go sprawdzic przed wyslaniem.
  const KRAJ_Z_WALUTY: Record<string, string> = {
    USD: 'US', GBP: 'GB', CHF: 'CH', SEK: 'SE', NOK: 'NO', CAD: 'CA', JPY: 'JP', PLN: 'PL',
  };

  const dochodWgKraju = new Map<string, number>();
  const krajZgadnietyZWaluty = new Set<string>();
  let dochodBezKraju = 0;

  // Wiersze z silnika maja pierwszenstwo: panstwo z ISIN (ta sama funkcja co
  // poz. 34), dochod z groszami i podatek zaplacony za granica. Zgadywanie z
  // sufiksu tickera przypisywalo NBIS.US (spolka holenderska) do "US", a
  // P_30 zawsze bylo 0.00, choc silnik znal podatek. Heurystyka zostaje tylko
  // dla wyniku bez tych wierszy (starszy przebieg).
  const wierszeZgZSilnika = summary.pitZgRows;
  const podatekZagranicznyZg = new Map<string, number>();
  if (wierszeZgZSilnika) {
    for (const wiersz of wierszeZgZSilnika) {
      const kraj = wiersz.country.trim().toUpperCase();
      if (kraj === 'PL') continue; // dochod krajowy nie wchodzi do PIT/ZG
      // Tylko kody ze slownika MF: XX (nieustalone) i prefiksy ISIN w rodzaju XS
      // nie sa panstwami, a e-Deklaracje odrzucaja PIT/ZG z takim kodem.
      if (!KODY_KRAJOW_MF.has(kraj)) {
        dochodBezKraju += Math.max(0, wiersz.incomePLN);
        continue;
      }
      dochodWgKraju.set(kraj, (dochodWgKraju.get(kraj) ?? 0) + Math.max(0, wiersz.incomePLN));
      podatekZagranicznyZg.set(kraj, (podatekZagranicznyZg.get(kraj) ?? 0) + Math.max(0, wiersz.foreignTaxPLN));
    }
  } else {
    realizedGains.forEach((zysk) => {
      if (zysk.taxYear !== year) return;
      const zTickera = krajZTickera(zysk.ticker);
      const kraj = zTickera ?? KRAJ_Z_WALUTY[zysk.sellCurrency] ?? null;
      if (kraj === 'PL') return; // dochod krajowy nie wchodzi do PIT/ZG
      if (!kraj || !KODY_KRAJOW_MF.has(kraj)) {
        dochodBezKraju += zysk.profitPLN;
        return;
      }
      if (!zTickera) krajZgadnietyZWaluty.add(kraj);
      dochodWgKraju.set(kraj, (dochodWgKraju.get(kraj) ?? 0) + zysk.profitPLN);
    });
  }

  let pitZgSection = '';
  // Poz. 72 (czesc L) to liczba dolaczonych PIT/ZG - liczona z tego, co
  // faktycznie trafia do pliku, zeby zgadzala sie z zalacznikami.
  let liczbaZalacznikowZg = 0;
  dochodWgKraju.forEach((dochod, kodKraju) => {
    // Z silnika: grosze (P_29 i P_30 to TKwota2Nieujemna). Stara sciezka
    // zaokraglala dochod do pelnych zlotych.
    const dochodP29 = wierszeZgZSilnika ? kwota2(grosze(dochod)) : `${Math.round(dochod)}.00`;
    if ((wierszeZgZSilnika ? grosze(dochod) : Math.round(dochod)) <= 0) return;
    liczbaZalacznikowZg += 1;
    const podatekP30 = wierszeZgZSilnika ? kwota2(grosze(podatekZagranicznyZg.get(kodKraju) ?? 0)) : null;
    pitZgSection += `${
      krajZgadnietyZWaluty.has(kodKraju)
        ? `
    <!-- Kraj ${kodKraju} ustalony z waluty rozliczenia, bo ticker go nie niesie.
         Sprawdź go przed wysyłką: papier notowany w tej walucie nie musi
         pochodzić z tego państwa. -->`
        : ''
    }
    <zg38:Zalacznik_PIT_ZG>
      <!-- Wariant zalacznika nie zmienia sie razem z wzorem PIT-38: PIT/ZG (8)
           potwierdzono dla wzoru z 2025 r. Dla wczesniejszych lat sprawdz
           obowiazujacy wariant na podatki.gov.pl przed wysylka. -->
      <zg38:Naglowek>
        <zg38:KodFormularza kodSystemowy="PIT/ZG (8)" wersjaSchemy="1-0E">PIT/ZG</zg38:KodFormularza>
        <zg38:WariantFormularza>8</zg38:WariantFormularza>
      </zg38:Naglowek>
      <zg38:PozycjeSzczegolowe>
        <zg38:P_7>${kodKraju}</zg38:P_7>
        <zg38:P_29>${dochodP29}</zg38:P_29>${podatekP30 !== null ? `
        <zg38:P_30>${podatekP30}</zg38:P_30>` : `
        <!-- P_30 to podatek zaplacony za granica od tych dochodow. Ten wynik go
             nie niesie, wiec zostaje 0.00 - jesli podatek byl zaplacony, wpisz
             kwote recznie przed wysylka, inaczej tracisz odliczenie. -->
        <zg38:P_30>0.00</zg38:P_30>`}
      </zg38:PozycjeSzczegolowe>
    </zg38:Zalacznik_PIT_ZG>`;
  });

  if (Math.round(dochodBezKraju) > 0) {
    // Nie zgadujemy kraju. Komentarz jest widoczny w pliku, a kwota nie zostaje
    // po cichu przypisana do przypadkowego panstwa.
    pitZgSection += `
    <!-- UWAGA: dochód ${Math.round(dochodBezKraju)} PLN bez ustalonego kraju źródła.
         Dodaj dla niego osobny załącznik PIT/ZG przed wysyłką i zwiększ liczbę
         załączników w poz. 72. -->`;
  }

  const dywidendyBrutto = Math.max(0, zlote(summary.dividendGrossPLN));
  const uwagaODywidendach =
    dywidendyBrutto > 0
      ? `
    <!-- Dywidendy zagraniczne (${dywidendyBrutto} PLN brutto) nie wchodzą do PIT/ZG:
         art. 30a rozlicza się w części G tego zeznania, w poz. 47-49. -->`
      : '';

  const identyfikatorXml =
    identyfikator.length === 11
      ? `<etd:PESEL>${identyfikator}</etd:PESEL>`
      : `<etd:NIP>${identyfikator}</etd:NIP>`;

  const nowszyNizWzor = year > wzor.odRoku;

  const xml = `<?xml version="1.0" encoding="UTF-8"?>${
    nowszyNizWzor
      ? `
<!-- UWAGA: za ${year} r. nie ma jeszcze opublikowanego wzoru PIT-38. Plik używa
     najnowszego potwierdzonego: ${wzor.opis}. Sprawdź na podatki.gov.pl, czy
     w międzyczasie nie ukazał się nowszy. -->`
      : ''
  }
<Deklaracja xmlns="${wzor.przestrzenNazw}" xmlns:etd="http://crd.gov.pl/xml/schematy/dziedzinowe/mf/2022/09/13/eD/DefinicjeTypy/" xmlns:zg38="http://crd.gov.pl/xml/schematy/dziedzinowe/mf/2023/10/18/eD/PITZGZ38/">
  <Naglowek>
    <KodFormularza kodSystemowy="PIT-38 (${wzor.wariant})" kodPodatku="PPW" rodzajZobowiazania="Z" wersjaSchemy="${wzor.wersjaSchemy}">PIT-38</KodFormularza>
    <WariantFormularza>${wzor.wariant}</WariantFormularza>
    <!-- P_6 = 1 znaczy "zlozenie zeznania". Aplikacja nie obsluguje korekty;
         przy korekcie trzeba tu recznie wpisac 2 przed wyslaniem. -->
    <CelZlozenia poz="P_6">1</CelZlozenia>
    <Rok>${year}</Rok>
    <KodUrzedu>${urzad}</KodUrzedu>
  </Naglowek>
  <Podmiot1 rola="Podatnik">
    <OsobaFizyczna>
      ${identyfikatorXml}
      <etd:ImiePierwsze>${xmlTekst(imie)}</etd:ImiePierwsze>
      <etd:Nazwisko>${xmlTekst(nazwisko)}</etd:Nazwisko>
      <etd:DataUrodzenia>${dataUrodzenia}</etd:DataUrodzenia>
    </OsobaFizyczna>
    <AdresZamieszkania rodzajAdresu="RAD">
      <AdresPol>
        <KodKraju>PL</KodKraju>
        <Wojewodztwo>${xmlTekst(wojewodztwo)}</Wojewodztwo>
        <Powiat>${xmlTekst(powiat)}</Powiat>
        <Gmina>${xmlTekst(gmina)}</Gmina>${ulica ? `
        <Ulica>${xmlTekst(ulica)}</Ulica>` : ''}
        <NrDomu>${xmlTekst(nrDomu)}</NrDomu>${nrLokalu ? `
        <NrLokalu>${xmlTekst(nrLokalu)}</NrLokalu>` : ''}
        <Miejscowosc>${xmlTekst(miejscowosc)}</Miejscowosc>
        <KodPocztowy>${kodPocztowy}</KodPocztowy>
      </AdresPol>
    </AdresZamieszkania>
  </Podmiot1>
  <PozycjeSzczegolowe>
    <!-- CZĘŚĆ C: dochody i straty (art. 30b ust. 1 ustawy) -->${
      p20 > 0 || p21 > 0
        ? `
    <!-- wiersz 1: kwoty z informacji PIT-8C (jej poz. 35 i 36) -->
    <P_20>${kwota2(p20)}</P_20>
    <P_21>${kwota2(p21)}</P_21>`
        : ''
    }${
      p22 > 0 || p23 > 0
        ? `
    <!-- wiersz 2: przychody bez PIT-8C, w tym uzyskane za granicą -->
    <P_22>${kwota2(p22)}</P_22>
    <P_23>${kwota2(p23)}</P_23>`
        : ''
    }${
      p24 > 0 || p25 > 0
        ? `
    <!-- wiersz 3: dochód zwolniony z art. 21 ust. 1 pkt 105a (ulga IPO) -->
    <P_24>${kwota2(p24)}</P_24>
    <P_25>${kwota2(p25)}</P_25>`
        : ''
    }
    <!-- wiersz 4: razem (poz. 20+22-24 oraz 21+23-25), dochód albo strata -->
    <P_26>${kwota2(p26)}</P_26>
    <P_27>${kwota2(p27)}</P_27>
    ${p29 > 0 ? `<P_29>${kwota2(p29)}</P_29>` : `<P_28>${kwota2(p28)}</P_28>`}

    <!-- CZĘŚĆ D: obliczenie zobowiązania podatkowego (art. 30b ust. 1) -->${
      p30 > 0
        ? `
    <P_30>${kwota2(p30)}</P_30>`
        : ''
    }
    <P_31>${p31}</P_31>
    <P_32>${p32}</P_32>
    <P_33>${kwota2(p33)}</P_33>${
      p34 > 0
        ? `
    <P_34>${kwota2(p34)}</P_34>`
        : ''
    }
    <P_35>${p35}</P_35>
${
  maCzescE
    ? `    <!-- CZĘŚĆ E: odpłatne zbycie walut wirtualnych (art. 17 ust. 1f, art. 22 ust. 14-16) -->
    <P_36>${Number(p36).toFixed(2)}</P_36>
    <P_37>${Number(p37).toFixed(2)}</P_37>${
        p38 > 0
          ? `
    <P_38>${Number(p38).toFixed(2)}</P_38>`
          : ''
      }${
        p39 > 0
          ? `
    <P_39>${Number(p39).toFixed(2)}</P_39>`
          : ''
      }${
        p40 > 0
          ? `
    <P_40>${Number(p40).toFixed(2)}</P_40>`
          : ''
      }
`
    : ''
}${
  maCzescE
    ? `    <!-- CZĘŚĆ F: obliczenie zobowiązania podatkowego (art. 30b ust. 1a) -->
    <P_41>${p41}</P_41>
    <P_42>${p42}</P_42>
    <P_43>${Number(p43).toFixed(2)}</P_43>${
        p44 > 0
          ? `
    <P_44>${Number(p44).toFixed(2)}</P_44>`
          : ''
      }${
        p45 > 0
          ? `
    <P_45>${p45}</P_45>`
          : ''
      }
`
    : ''
}${
  maCzescG
    ? `    <!-- CZĘŚĆ G: zryczałtowany podatek dochodowy (art. 30a ust. 1 pkt 1-5 i ust. 9) -->
${p46 > 0 ? `    <P_46>${p46}</P_46>\n` : ''}    <P_47>${kwota2(p47)}</P_47>
    <P_48>${kwota2(p48)}</P_48>
    <P_49>${kwota2(p49)}</P_49>${p50 > 0 ? `\n    <P_50>${p50}</P_50>` : ''}
`
    : ''
}${
  nieodliczonyPodatekZagraniczny > 0
    ? `    <!-- Podatek pobrany za granicą przekracza limit stawki umownej
         (art. 30a ust. 9) o ${kwota2(nieodliczonyPodatekZagraniczny)} PLN. Ta nadwyżka nie
         obniża podatku w Polsce - odzyskuje się ją od zagranicznego urzędu. -->
`
    : ''
}    <!-- Podatek do zapłaty albo nadpłata - schemat dopuszcza tylko jedną z tych pozycji -->
${p52 > 0 ? `<P_52>${kwota2(p52)}</P_52>` : `<P_51>${kwota2(p51)}</P_51>`}${
  liczbaZalacznikowZg > 0
    ? `
    <!-- CZĘŚĆ L: liczba załączników PIT/ZG -->
    <P_72>${liczbaZalacznikowZg}</P_72>`
    : ''
}
  </PozycjeSzczegolowe>
  <!-- Pouczenia: wartość 1 potwierdza zapoznanie się z pouczeniami formularza.
       Schemat wymaga tej pozycji; treść pouczeń jest w formularzu PIT-38. -->
  <Pouczenia>1</Pouczenia>${
    pitZgSection.trim().length > 0 || uwagaODywidendach.length > 0
      ? `
  <Zalaczniki>${pitZgSection}${uwagaODywidendach}
  </Zalaczniki>`
      : ''
  }
</Deklaracja>`;

  return xml.trim();
}

export function exportPit38XML(
  summary: TaxYearSummary,
  realizedGains: TaxRealizedGain[],
  dividends: DividendTaxItem[],
  filename: string = `PIT38_${summary.year}_deklaracja.xml`,
  taxpayerData?: DanePodatnika
) {
  const xmlContent = generatePit38XML(summary, realizedGains, dividends, taxpayerData);
  downloadBlob(xmlContent, filename, 'application/xml;charset=utf-8;');
}
