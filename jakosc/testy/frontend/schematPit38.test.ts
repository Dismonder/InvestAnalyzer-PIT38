/**
 * Deklaracja PIT-38 sprawdzana wobec prawdziwego schematu, nie wobec
 * oczekiwan przepisanych do testu.
 *
 * Eksport XML mial przez dlugi czas zmyslona przestrzen nazw
 * (`crd.gov.pl/wzor/2023/12/15/13100/`, ktorego repozytorium nie zna),
 * wymyslone nazwy pozycji zalacznika PIT/ZG i brakujace elementy wymagane -
 * a testy porownywaly go z regulami wpisanymi obok. Ten plik czyta schemat
 * z `jakosc/schematy/pit38` i buduje z niego model tresci, wiec nowy wymog
 * schematu ujawnia sie sam.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { generatePit38XML } from '../../../aplikacje/web/src/portfel/services/xmlExporter.ts';
import { URZEDY_SKARBOWE } from '../../../aplikacje/web/src/portfel/data/urzedySkarbowe.ts';
import { KODY_KRAJOW_MF } from '../../../aplikacje/web/src/portfel/data/kodyKrajowMf.ts';
import type { TaxYearSummary, TaxRealizedGain } from '../../../aplikacje/web/src/portfel/types.ts';

const KATALOG_SCHEMATOW = path.join(import.meta.dirname, '..', '..', 'schematy', 'pit38');

function schemat(nazwa: string): string {
  return fs.readFileSync(path.join(KATALOG_SCHEMATOW, nazwa), 'utf-8');
}

const PIT38 = schemat('schemat.xsd');
const PIT_ZG = schemat('PIT_ZG8_Z38_v1-0E.xsd');
const KODY_URZEDOW = schemat('KodyUrzedowSkarbowychExWUS_v8-0E.xsd');
const KODY_KRAJOW = schemat('KodyKrajow_v13-0E.xsd');

// ---------------------------------------------------------------------------
// Model tresci wyciagniety ze schematu
// ---------------------------------------------------------------------------

type Pole = { pole: string; min: number };
type Grupa = { rodzaj: 'sequence' | 'choice'; min: number; dzieci: (Grupa | Pole)[] };

/**
 * Buduje model zawartosci elementu `PozycjeSzczegolowe`: kolejnosc pozycji,
 * ktore z nich sa wymagane i ktore stanowia wybor jedna-albo-druga.
 */
function modelPozycji(xsd: string): Grupa {
  const start = xsd.indexOf('<xsd:element name="PozycjeSzczegolowe"');
  assert.ok(start > 0, 'schemat nie ma elementu PozycjeSzczegolowe');
  const fragment = xsd.slice(start);

  const korzen: Grupa = { rodzaj: 'sequence', min: 1, dzieci: [] };
  const stos: Grupa[] = [korzen];
  let pierwszaSekwencja = true;
  // -1, bo pierwszym napotkanym elementem jest samo PozycjeSzczegolowe:
  // jego otwarcie przestawia licznik na 0, czyli "jestesmy w srodku, ale nie
  // w zagniezdzonym elemencie".
  let wElemencie = -1;
  const znaczniki = /<(\/?)xsd:(sequence|choice|element)\b([^>]*?)(\/?)>/g;
  let dopasowanie: RegExpExecArray | null;

  while ((dopasowanie = znaczniki.exec(fragment)) !== null) {
    const [, zamykajacy, rodzaj, atrybuty, samozamykajacy] = dopasowanie;
    const nazwa = /name="([^"]+)"/.exec(atrybuty)?.[1];
    const min = Number(/minOccurs="(\d+)"/.exec(atrybuty)?.[1] ?? '1');

    if (rodzaj === 'element') {
      if (zamykajacy) {
        wElemencie -= 1;
        if (wElemencie < 0) break; // koniec PozycjeSzczegolowe
        continue;
      }
      if (nazwa?.startsWith('P_') && wElemencie === 0) {
        stos[stos.length - 1].dzieci.push({ pole: nazwa, min });
      }
      // Wnetrze elementu (np. inline simpleType z restriction) nie opisuje
      // kolejnosci pozycji. Bez tego licznika zagniezdzona sekwencja trafialaby
      // do modelu jako rodzenstwo elementu i model przepuszczalby wiecej,
      // niz dopuszcza schemat.
      if (!samozamykajacy) wElemencie += 1;
      continue;
    }

    if (wElemencie > 0) continue;

    if (zamykajacy) {
      stos.pop();
      if (stos.length === 0) break;
      continue;
    }
    if (samozamykajacy) continue;

    if (pierwszaSekwencja) {
      // Zewnetrzna sekwencja to korzen, ktory juz mamy na stosie.
      pierwszaSekwencja = false;
      stos.push(korzen);
      continue;
    }
    const grupa: Grupa = { rodzaj: rodzaj as Grupa['rodzaj'], min, dzieci: [] };
    stos[stos.length - 1].dzieci.push(grupa);
    stos.push(grupa);
  }

  assert.ok(korzen.dzieci.length > 0, 'nie udalo sie odczytac modelu pozycji');
  return korzen;
}

/** Czy lista pozycji (w kolejnosci z pliku) pasuje do modelu. Zwraca nowy indeks. */
function dopasuj(wezel: Grupa | Pole, pozycje: string[], od: number): number | null {
  if ('pole' in wezel) {
    if (pozycje[od] === wezel.pole) return od + 1;
    return wezel.min === 0 ? od : null;
  }

  if (wezel.rodzaj === 'choice') {
    for (const dziecko of wezel.dzieci) {
      const wynik = dopasuj(dziecko, pozycje, od);
      if (wynik !== null && wynik > od) return wynik;
    }
    return wezel.min === 0 ? od : null;
  }

  let indeks = od;
  for (const dziecko of wezel.dzieci) {
    const wynik = dopasuj(dziecko, pozycje, indeks);
    if (wynik === null) {
      // Cala grupa opcjonalna moze zostac pominieta, ale tylko jesli jeszcze
      // nic z niej nie weszlo - inaczej brakuje pozycji wymaganej.
      if (wezel.min === 0 && indeks === od) return od;
      return null;
    }
    indeks = wynik;
  }
  return indeks;
}

function sprawdzPozycje(xml: string, model: Grupa): void {
  const sekcja = /<PozycjeSzczegolowe>([\s\S]*?)<\/PozycjeSzczegolowe>/.exec(xml);
  assert.ok(sekcja, 'brak sekcji PozycjeSzczegolowe');
  // Dopuszczamy atrybuty przy pozycji: `<P_11 xsi:nil="true">` tez jest
  // pozycja, a pominiecie jej w liscie ukryloby blad kolejnosci.
  const pozycje = [...sekcja[1].matchAll(/<(P_[0-9A-Z]+)[\s/>]/g)].map((t) => t[1]);
  const koniec = dopasuj(model, pozycje, 0);
  assert.ok(
    koniec !== null && koniec === pozycje.length,
    `pozycje nie pasuja do modelu schematu: ${pozycje.join(', ')} (dopasowano ${koniec} z ${pozycje.length})`
  );
}

// ---------------------------------------------------------------------------
// Dane wejsciowe
// ---------------------------------------------------------------------------

const PODATNIK = {
  peselOrNip: '85041212344',
  firstName: 'ANNA',
  lastName: 'NOWAK',
  birthDate: '1985-04-12',
  taxOfficeCode: '1435',
  wojewodztwo: 'MAZOWIECKIE',
  powiat: 'm. st. Warszawa',
  gmina: 'Warszawa',
  ulica: 'Marszałkowska',
  nrDomu: '1',
  nrLokalu: '2',
  miejscowosc: 'Warszawa',
  kodPocztowy: '00-001',
};

function podsumowanie(nadpisania: Partial<TaxYearSummary> = {}): TaxYearSummary {
  return {
    year: 2025,
    revenuePLN: 0,
    costsPLN: 0,
    incomePLN: 0,
    lossPLN: 0,
    taxDuePLN: 0,
    dividendGrossPLN: 0,
    dividendForeignTaxPLN: 0,
    dividendPolishTaxDuePLN: 0,
    dividendTaxToPayPLN: 0,
    totalTaxToPayPLN: 0,
    transactionCount: 0,
    brokerBreakdowns: [],
    ...nadpisania,
  };
}

test('jedna złotówka odsetek z silnika trafia do poz. 47, 49 i 51 zgodnie ze schematem', () => {
  const summary = podsumowanie({
    totalTaxToPayPLN: 0.19,
    formTaxToPayPLN: 0.19,
  });
  (summary as TaxYearSummary & { engineFormFields: Record<string, number> }).engineFormFields = {
    '31': 0, '45': 0, '46': 0, '47': 0.19, '48': 0, '49': 0.19, '50': 0, '51': 0.19,
  };
  const xml = generatePit38XML(summary, [], [], PODATNIK);
  assert.match(xml, /<P_47>0\.19<\/P_47>/);
  assert.match(xml, /<P_49>0\.19<\/P_49>/);
  assert.match(xml, /<P_51>0\.19<\/P_51>/);
  sprawdzPozycje(xml, modelPozycji(PIT38));
});

const zyskZagraniczny = [
  {
    id: 'g1',
    ticker: 'NBIS.US',
    sellCurrency: 'USD',
    profitPLN: 12000,
    taxYear: 2025,
  } as unknown as TaxRealizedGain,
];

/** Przypadki, ktore w praktyce daja rozne galezie eksportu. */
const PRZYPADKI: Record<string, TaxYearSummary> = {
  'same zera': podsumowanie(),
  'zysk bez krypto': podsumowanie({
    revenuePLN: 1533701,
    costsPLN: 1487850,
    incomePLN: 45851,
    taxDuePLN: 8712,
    pit8cRevenuePLN: 29990,
    pit8cCostsPLN: 20010,
    pit8cZrodlo: 'transakcje',
    foreignRevenuePLN: 1503711,
    foreignCostsPLN: 1467840,
    totalTaxToPayPLN: 8712,
  }),
  strata: podsumowanie({ revenuePLN: 10000, costsPLN: 25000, lossPLN: 15000 }),
  'strata z lat ubieglych': podsumowanie({
    revenuePLN: 100000,
    costsPLN: 60000,
    incomePLN: 40000,
    taxDuePLN: 7600,
    priorYearLossUsedPLN: 5000,
    totalTaxToPayPLN: 6650,
  }),
  'same dywidendy': podsumowanie({
    dividendGrossPLN: 4000,
    dividendForeignTaxPLN: 600,
    dividendPolishTaxDuePLN: 760,
    dividendTaxToPayPLN: 160,
    totalTaxToPayPLN: 160,
  }),
  'samo krypto': podsumowanie({
    cryptoRevenuePLN: 50000,
    cryptoCostsPLN: 30000,
    cryptoCostsCurrentYearPLN: 30000,
    cryptoIncomePLN: 20000,
    cryptoTaxDuePLN: 3800,
    totalTaxToPayPLN: 3800,
  }),
  'krypto na minusie': podsumowanie({
    cryptoRevenuePLN: 10000,
    cryptoCostsPLN: 18000,
    cryptoCostsCurrentYearPLN: 15000,
    cryptoCostsCarriedInPLN: 3000,
    cryptoLossPLN: 8000,
  }),
  'wszystko naraz': podsumowanie({
    revenuePLN: 100000,
    costsPLN: 60000,
    incomePLN: 40000,
    taxDuePLN: 7600,
    pit8cRevenuePLN: 30000,
    pit8cCostsPLN: 20000,
    pit8cZrodlo: 'informacja',
    pit8cWyliczonyPrzychodPLN: 29990,
    pit8cWyliczoneKosztyPLN: 20010,
    foreignRevenuePLN: 70000,
    foreignCostsPLN: 40000,
    priorYearLossUsedPLN: 5000,
    cryptoRevenuePLN: 50000,
    cryptoCostsPLN: 33000,
    cryptoCostsCurrentYearPLN: 30000,
    cryptoCostsCarriedInPLN: 3000,
    cryptoIncomePLN: 17000,
    cryptoTaxDuePLN: 3230,
    dividendGrossPLN: 4000,
    dividendForeignTaxPLN: 1200,
    dividendPolishTaxDuePLN: 760,
    dividendTaxToPayPLN: 160,
    totalTaxToPayPLN: 10040,
  }),
};

// ---------------------------------------------------------------------------
// Testy
// ---------------------------------------------------------------------------

test('pozycje deklaracji pasują do modelu treści ze schematu', () => {
  const model = modelPozycji(PIT38);
  for (const [nazwa, dane] of Object.entries(PRZYPADKI)) {
    const xml = generatePit38XML(dane, zyskZagraniczny, [], PODATNIK);
    assert.doesNotThrow(() => sprawdzPozycje(xml, model), `przypadek "${nazwa}"`);
  }
});

test('nagłówek niesie wartości wymuszone przez schemat', () => {
  const xml = generatePit38XML(PRZYPADKI['zysk bez krypto'], [], [], PODATNIK);

  const przestrzen = /targetNamespace="([^"]+)"/.exec(PIT38)![1];
  assert.ok(xml.includes(`xmlns="${przestrzen}"`), `przestrzeń nazw ma być ${przestrzen}`);

  for (const atrybut of ['kodSystemowy', 'kodPodatku', 'rodzajZobowiazania', 'wersjaSchemy']) {
    const wymuszona = new RegExp(`name="${atrybut}"[^>]*fixed="([^"]+)"`).exec(PIT38)?.[1];
    assert.ok(wymuszona, `schemat nie wymusza atrybutu ${atrybut}`);
    assert.ok(
      xml.includes(`${atrybut}="${wymuszona}"`),
      `nagłówek ma nieść ${atrybut}="${wymuszona}"`
    );
  }

  const wariant = /<xsd:element name="WariantFormularza">[\s\S]*?<xsd:enumeration value="(\d+)"/.exec(PIT38)![1];
  assert.ok(
    xml.includes(`<WariantFormularza>${wariant}</WariantFormularza>`),
    `wariant formularza ma być ${wariant}`
  );

  const najstarszyRok = Number(/<xsd:minInclusive value="(\d{4})"\/>/.exec(PIT38)![1]);
  const rok = Number(/<Rok>(\d+)<\/Rok>/.exec(xml)![1]);
  assert.ok(rok >= najstarszyRok, `rok ${rok} jest starszy niż wzór (od ${najstarszyRok})`);
});

test('elementy najwyższego poziomu idą w kolejności ze schematu', () => {
  const xml = generatePit38XML(PRZYPADKI['wszystko naraz'], zyskZagraniczny, [], PODATNIK);
  const deklaracja = PIT38.slice(PIT38.indexOf('<xsd:element name="Deklaracja">'));
  const oczekiwane = [...deklaracja.matchAll(/<xsd:element name="(Naglowek|Podmiot1|PozycjeSzczegolowe|Pouczenia|Zalaczniki)"/g)]
    .map((t) => t[1]);
  assert.deepEqual(oczekiwane, ['Naglowek', 'Podmiot1', 'PozycjeSzczegolowe', 'Pouczenia', 'Zalaczniki']);

  const wPliku = oczekiwane.map((nazwa) => xml.indexOf(`<${nazwa}`));
  assert.ok(
    wPliku.every((pozycja, i) => pozycja >= 0 && (i === 0 || pozycja > wPliku[i - 1])),
    `zła kolejność albo brak elementu: ${oczekiwane.map((n, i) => `${n}=${wPliku[i]}`).join(', ')}`
  );
});

test('kod urzędu i kody krajów pochodzą ze słowników Ministerstwa Finansów', () => {
  const kodyUrzedow = new Set([...KODY_URZEDOW.matchAll(/<xsd:enumeration value="(\d{4})"/g)].map((t) => t[1]));
  const kodyKrajow = new Set([...KODY_KRAJOW.matchAll(/<xsd:enumeration value="([A-Z]{2})"/g)].map((t) => t[1]));

  const xml = generatePit38XML(PRZYPADKI['zysk bez krypto'], zyskZagraniczny, [], PODATNIK);
  const urzad = /<KodUrzedu>(\d+)<\/KodUrzedu>/.exec(xml)![1];
  assert.ok(kodyUrzedow.has(urzad), `kod urzędu ${urzad} nie występuje w słowniku`);

  for (const [, kraj] of xml.matchAll(/<zg38:P_7>([A-Z]{2})<\/zg38:P_7>/g)) {
    assert.ok(kodyKrajow.has(kraj), `kod kraju ${kraj} nie występuje w słowniku`);
    // PIT/ZG dotyczy dochodu zagranicznego, wiec wzorzec w schemacie wyklucza PL.
    assert.ok(
      /^P[A-KM-Z]$|^[A-OQ-Z][A-Z]$/.test(kraj),
      `kod kraju ${kraj} nie pasuje do wzorca załącznika`
    );
  }
});

test('lista urzędów w aplikacji zgadza się ze słownikiem co do kodu i nazwy', () => {
  const wSlowniku = new Map(
    [...KODY_URZEDOW.matchAll(/<xsd:enumeration value="(\d{4})">\s*<xsd:annotation>\s*<xsd:documentation>([\s\S]*?)<\/xsd:documentation>/g)]
      .map((t) => [t[1], t[2].split(/\s+/).join(' ').trim().toUpperCase()])
  );

  assert.equal(URZEDY_SKARBOWE.length, wSlowniku.size, 'inna liczba urzędów niż w słowniku');
  for (const urzad of URZEDY_SKARBOWE) {
    const nazwa = wSlowniku.get(urzad.code);
    assert.ok(nazwa, `kod ${urzad.code} nie występuje w słowniku`);
    assert.equal(
      urzad.name.toUpperCase(),
      nazwa,
      `nazwa urzędu ${urzad.code} rozjechała się ze słownikiem`
    );
  }
});

test('lista krajów w aplikacji zgadza się ze słownikiem KodyKrajow', () => {
  const wSlowniku = new Set([...KODY_KRAJOW.matchAll(/<xsd:enumeration value="([A-Z]{2})"/g)].map((t) => t[1]));
  assert.deepEqual([...KODY_KRAJOW_MF].sort(), [...wSlowniku].sort());
});

test('załącznik PIT/ZG niesie wartości wymuszone przez własny schemat', () => {
  const xml = generatePit38XML(PRZYPADKI['zysk bez krypto'], zyskZagraniczny, [], PODATNIK);

  const kod = /name="kodSystemowy"[^>]*fixed="([^"]+)"/.exec(PIT_ZG)![1];
  const wersja = /name="wersjaSchemy"[^>]*fixed="([^"]+)"/.exec(PIT_ZG)![1];
  const wariant = /<xsd:element name="WariantFormularza">[\s\S]*?<xsd:enumeration value="(\d+)"/.exec(PIT_ZG)![1];

  assert.ok(xml.includes(`kodSystemowy="${kod}"`), `załącznik ma nieść kodSystemowy="${kod}"`);
  assert.ok(xml.includes(`wersjaSchemy="${wersja}"`));
  assert.ok(xml.includes(`<zg38:WariantFormularza>${wariant}</zg38:WariantFormularza>`));

  // Pozycje zalacznika biora sie ze schematu, a nie z wymyslonych nazw.
  const pozycjeZg = new Set([...PIT_ZG.matchAll(/<xsd:element name="(P_\d+)"/g)].map((t) => t[1]));
  for (const [, pozycja] of xml.matchAll(/<zg38:(P_\d+)>/g)) {
    assert.ok(pozycjeZg.has(pozycja), `załącznik nie ma pozycji ${pozycja}`);
  }
});
