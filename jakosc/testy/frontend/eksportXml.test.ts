/**
 * Testy generatora deklaracji PIT-38 w formacie e-Deklaracji.
 *
 * Plik idzie do urzedu skarbowego, wiec kazdy przypadek dotyczy tego, co
 * wczesniej trafialo tam niepoprawnie: wymyslone dane podatnika, zalacznik
 * PIT/ZG liczony wylacznie z dywidend i kraj zrodla zgadywany z waluty.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { czyWzorPit38PotwierdzonyDlaRoku, generatePit38XML, ostrzezenieOWzorzePit38 } from "../../../aplikacje/web/src/portfel/services/xmlExporter.ts";
import type {
  TaxYearSummary,
  TaxRealizedGain,
  DividendTaxItem,
} from "../../../aplikacje/web/src/portfel/types.ts";

const PODATNIK = {
  peselOrNip: "85041212344",
  firstName: "ANNA",
  lastName: "NOWAK",
  birthDate: "1985-04-12",
  // 1435 istnieje w slowniku MF; 1436 nie istnieje i e-Deklaracje odrzucaja
  // deklaracje z takim kodem.
  taxOfficeCode: "1435",
  wojewodztwo: "MAZOWIECKIE",
  powiat: "m. st. Warszawa",
  gmina: "Warszawa",
  ulica: "Marszałkowska",
  nrDomu: "1",
  nrLokalu: "2",
  miejscowosc: "Warszawa",
  kodPocztowy: "00-001",
};

test("wzór PIT-38 jest potwierdzony za 2025, ale nie za 2026", () => {
  assert.equal(czyWzorPit38PotwierdzonyDlaRoku(2025), true);
  assert.equal(czyWzorPit38PotwierdzonyDlaRoku(2026), false);
});

function podsumowanie(nadpisania: Partial<TaxYearSummary> = {}): TaxYearSummary {
  return {
    year: 2026,
    revenuePLN: 100000,
    costsPLN: 60000,
    incomePLN: 40000,
    lossPLN: 0,
    taxDuePLN: 7600,
    dividendGrossPLN: 0,
    dividendForeignTaxPLN: 0,
    dividendPolishTaxDuePLN: 0,
    dividendTaxToPayPLN: 0,
    totalTaxToPayPLN: 7600,
    transactionCount: 2,
    brokerBreakdowns: [],
    ...nadpisania,
  };
}

function zysk(nadpisania: Partial<TaxRealizedGain> = {}): TaxRealizedGain {
  return {
    id: "g1",
    sellTransactionId: "s1",
    ticker: "NBIS.US",
    name: "Nebius",
    category: "STOCK_FOREIGN",
    accountId: "acc",
    sellDate: "2026-01-21",
    sellQuantity: 70,
    sellPricePerUnit: 98.924,
    sellCurrency: "USD",
    sellCommission: 3.4,
    sellCommissionPLN: 12.26,
    sellExchangeRate: 3.6054,
    sellExchangeDate: "2026-01-20",
    sellExchangeTable: "A",
    revenuePLN: 24953.98,
    costPLN: 24224.07,
    profitPLN: 729.91,
    taxYear: 2026,
    matchedBuyLots: [],
    ...nadpisania,
  } as TaxRealizedGain;
}

function dywidenda(nadpisania: Partial<DividendTaxItem> = {}): DividendTaxItem {
  return {
    id: "d1",
    ticker: "AAPL",
    name: "Apple",
    accountId: "acc",
    paymentDate: "2026-03-01",
    grossAmount: 100,
    currency: "USD",
    exchangeRate: 4,
    exchangeDate: "2026-02-28",
    grossPLN: 400,
    foreignTaxPLN: 60,
    polishTaxDuePLN: 76,
    taxToPayPLN: 16,
    taxYear: 2026,
    ...nadpisania,
  } as DividendTaxItem;
}

test("brak danych podatnika zatrzymuje generowanie zamiast wpisywać zmyślone", () => {
  assert.throws(
    () => generatePit38XML(podsumowanie(), [], [], {}),
    /uzupełnij.*imię podatnika.*nazwisko podatnika.*PESEL.*urzędu/s
  );

  assert.throws(
    () => generatePit38XML(podsumowanie(), [], [], { ...PODATNIK, peselOrNip: "123" }),
    /PESEL \(11 cyfr\) albo NIP \(10 cyfr\)/
  );

  assert.throws(
    () => generatePit38XML(podsumowanie(), [], [], { ...PODATNIK, taxOfficeCode: "14" }),
    /kod urzędu skarbowego/
  );
});

test("wygenerowana deklaracja nie zawiera danych zastępczych", () => {
  const xml = generatePit38XML(podsumowanie(), [zysk()], [], PODATNIK);

  assert.ok(!xml.includes("KOWALSKI"), "brak zastępczego nazwiska");
  assert.ok(!xml.includes("00000000000"), "brak zastępczego numeru PESEL");
  assert.ok(xml.includes("<etd:Nazwisko>NOWAK</etd:Nazwisko>"));
  assert.ok(xml.includes("<KodUrzedu>1435</KodUrzedu>"));
});

test("PIT/ZG niesie dochód ze zbycia papierów zagranicznych w strukturze ze schematu", () => {
  const xml = generatePit38XML(podsumowanie(), [zysk({ profitPLN: 12000 })], [], PODATNIK);

  // Nazwy elementów pochodzą ze schematu PIT/ZG(8)_Z38: kod kraju to poz. 7,
  // dochód z art. 30b ust. 5a i 5b to poz. 29, podatek zapłacony za granicą
  // to poz. 30. Wcześniej plik miał wymyślone <KodKraju> i <P_C2_Dochod>.
  assert.match(xml, /<zg38:KodFormularza kodSystemowy="PIT\/ZG \(8\)"/);
  assert.match(xml, /<zg38:P_7>US<\/zg38:P_7>/);
  assert.match(xml, /<zg38:P_29>12000\.00<\/zg38:P_29>/);
  assert.ok(!xml.includes("P_C2_Dochod"), "nie ma wymyślonych nazw pozycji");
});

test("kraj źródła bierze się z sufiksu tickera, a nie z waluty", () => {
  const xml = generatePit38XML(
    podsumowanie(),
    [
      zysk({ id: "a", ticker: "ASML.NL", sellCurrency: "EUR", profitPLN: 5000 }),
      zysk({ id: "b", ticker: "SAN.FR", sellCurrency: "EUR", profitPLN: 3000 }),
    ],
    [],
    PODATNIK
  );

  assert.match(xml, /<zg38:P_7>NL<\/zg38:P_7>\s*<zg38:P_29>5000\.00<\/zg38:P_29>/);
  assert.match(xml, /<zg38:P_7>FR<\/zg38:P_7>\s*<zg38:P_29>3000\.00<\/zg38:P_29>/);
  assert.ok(!xml.includes("<zg38:P_7>DE</zg38:P_7>"), "euro nie oznacza Niemiec");
});

test("dochód bez ustalonego kraju jest oznaczony, a nie przypisany na chybił trafił", () => {
  const xml = generatePit38XML(
    podsumowanie(),
    [zysk({ ticker: "XYZ", sellCurrency: "AUD" as TaxRealizedGain["sellCurrency"], profitPLN: 900 })],
    [],
    PODATNIK
  );

  assert.match(xml, /bez ustalonego kraju źródła/);
  assert.ok(!/<zg38:P_7>/.test(xml), "nie powstaje załącznik z wymyślonym krajem");
});

test("dochód krajowy nie trafia do PIT/ZG", () => {
  const xml = generatePit38XML(
    podsumowanie(),
    [zysk({ ticker: "CDR.PL", sellCurrency: "PLN", profitPLN: 4000 })],
    [],
    PODATNIK
  );

  assert.ok(!xml.includes("Zalacznik_PIT_ZG"), "PIT/ZG dotyczy dochodów zagranicznych");
});

test("dywidendy nie wchodzą do PIT/ZG, tylko do części G", () => {
  // PIT/ZG do PIT-38 obejmuje wyłącznie dochody z art. 30b. Dywidendy z
  // art. 30a nie mają w nim własnych pozycji - wcześniej trafiał tam ich
  // przychód brutto razem z podatkiem pobranym u źródła.
  const xml = generatePit38XML(
    podsumowanie({
      dividendGrossPLN: 4000,
      dividendForeignTaxPLN: 600,
      dividendPolishTaxDuePLN: 760,
      dividendTaxToPayPLN: 160,
    }),
    [zysk({ ticker: "AAPL.US", profitPLN: 1000 })],
    [dywidenda({ ticker: "AAPL.US", grossPLN: 4000, foreignTaxPLN: 600 })],
    PODATNIK
  );

  assert.match(xml, /<zg38:P_7>US<\/zg38:P_7>\s*<zg38:P_29>1000\.00<\/zg38:P_29>/);
  assert.ok(!xml.includes("<zg38:P_29>5000.00</zg38:P_29>"), "dywidenda nie dolicza się do dochodu");
  assert.match(xml, /<P_47>760\.00<\/P_47>/);
  assert.match(xml, /nie wchodzą do PIT\/ZG/);
});

test("część E stoi w polach 36-40, a nie 34-38", () => {
  const xml = generatePit38XML(
    podsumowanie({
      dividendGrossPLN: 4000,
      dividendForeignTaxPLN: 600,
      dividendPolishTaxDuePLN: 760,
      dividendTaxToPayPLN: 160,
      cryptoRevenuePLN: 50000,
      cryptoCostsPLN: 30000,
      cryptoCostsCurrentYearPLN: 30000,
      cryptoIncomePLN: 20000,
      cryptoTaxDuePLN: 3800,
    }),
    [],
    [],
    PODATNIK
  );

  // Numeracja z broszury MF do PIT-38 za 2025 r.: część E to poz. 36-40,
  // część F (obliczenie podatku od walut wirtualnych) to poz. 41-45.
  assert.match(xml, /<P_36>50000\.00<\/P_36>/, "poz. 36 to przychód z walut wirtualnych");
  assert.match(xml, /<P_37>30000\.00<\/P_37>/, "poz. 37 to koszty poniesione w roku");
  assert.match(xml, /<P_39>20000\.00<\/P_39>/, "poz. 39 to dochód z części E");
  assert.match(xml, /<P_41>20000<\/P_41>/, "poz. 41 to podstawa opodatkowania");
  assert.match(xml, /<P_43>3800\.00<\/P_43>/, "poz. 43 to podatek 19% od walut wirtualnych");

  // Poz. 34 i 35 należą do części D (podatek zapłacony za granicą i podatek
  // należny z art. 30b ust. 1). Kwoty krypto nie mogą tam trafić.
  assert.ok(!xml.includes("<P_34>"), "poz. 34 nie jest przychodem z krypto");
  assert.ok(!xml.includes("<P_35>30000.00</P_35>"), "poz. 35 nie jest kosztem krypto");
  assert.ok(!xml.includes("<P_38>3800.00</P_38>"), "poz. 38 to koszty z lat ubiegłych, nie podatek");
});

test("koszty krypto z lat ubiegłych idą do poz. 38, a nie do poz. 37", () => {
  const xml = generatePit38XML(
    podsumowanie({
      cryptoRevenuePLN: 50000,
      cryptoCostsPLN: 33000,
      cryptoCostsCurrentYearPLN: 30000,
      cryptoCostsCarriedInPLN: 3000,
      cryptoIncomePLN: 17000,
      cryptoTaxDuePLN: 3230,
    }),
    [],
    [],
    PODATNIK
  );

  assert.match(xml, /<P_37>30000\.00<\/P_37>/);
  assert.match(xml, /<P_38>3000\.00<\/P_38>/);
});

test("nadwyżka kosztów krypto trafia do poz. 40 jako kwota na rok następny", () => {
  const xml = generatePit38XML(
    podsumowanie({
      cryptoRevenuePLN: 10000,
      cryptoCostsPLN: 18000,
      cryptoCostsCurrentYearPLN: 18000,
      cryptoIncomePLN: 0,
      cryptoLossPLN: 8000,
      cryptoTaxDuePLN: 0,
    }),
    [],
    [],
    PODATNIK
  );

  assert.match(xml, /<P_40>8000\.00<\/P_40>/);
  assert.match(xml, /<P_43>0\.00<\/P_43>/, "bez dochodu nie ma podatku z części F");
});

test("pola silnika części E mają pierwszeństwo przed kwotami podsumowania", () => {
  const summary = Object.assign(podsumowanie({
    cryptoRevenuePLN: 106.49,
    cryptoCostsPLN: 103.50,
    cryptoCostsCurrentYearPLN: 103.50,
    cryptoIncomePLN: 2.99,
    cryptoTaxDuePLN: 1,
  }), { engineFormFields: {
    '36': 106.49, '37': 103.50, '38': 0, '39': 2.99, '40': 0,
    '41': 3, '42': 19, '43': 0.57, '44': 0, '45': 1,
  } });
  const xml = generatePit38XML(summary, [], [], PODATNIK);
  assert.match(xml, /<P_36>106\.49<\/P_36>/);
  assert.match(xml, /<P_37>103\.50<\/P_37>/);
  assert.match(xml, /<P_39>2\.99<\/P_39>/);
  assert.match(xml, /<P_43>0\.57<\/P_43>/);
  assert.match(xml, /<P_45>1<\/P_45>/);
});

test("zastępcza część E liczy dochód z wyeksportowanych kwot", () => {
  const xml = generatePit38XML(podsumowanie({
    cryptoRevenuePLN: 106.49,
    cryptoCostsPLN: 103.50,
    cryptoCostsCurrentYearPLN: 103.50,
    cryptoIncomePLN: 2.99,
  }), [], [], PODATNIK);
  assert.match(xml, /<P_36>106\.49<\/P_36>/);
  assert.match(xml, /<P_37>103\.50<\/P_37>/);
  assert.match(xml, /<P_39>2\.99<\/P_39>/);
});

test("zastępcza część F ma grosze w poz. 43 i pełne złote w poz. 45", () => {
  const xml = generatePit38XML(podsumowanie({ cryptoRevenuePLN: 101, cryptoCostsPLN: 0 }), [], [], PODATNIK);
  assert.match(xml, /<P_41>101<\/P_41>/);
  assert.match(xml, /<P_43>19\.19<\/P_43>/, "19% z 101 zł to 19,19 zł, a nie 19,00");
  assert.match(xml, /<P_45>19<\/P_45>/);
});

test("podatek zapłacony za granicą z części F trafia do poz. 44", () => {
  const summary = Object.assign(podsumowanie({ cryptoRevenuePLN: 22 }), { engineFormFields: {
    '36': 22, '37': 0, '38': 0, '39': 22, '40': 0,
    // 22 zł × 19% = 4,18; 4,18 − 0,68 = 3,50 → 4 zł (w liczbach zmiennoprzecinkowych 3,4999...).
    '41': 22, '42': 19, '43': 4.18, '44': 0.68, '45': 4,
  } });
  const xml = generatePit38XML(summary, [], [], PODATNIK);
  assert.match(xml, /<P_43>4\.18<\/P_43>\s*<P_44>0\.68<\/P_44>\s*<P_45>4<\/P_45>/);
});

test("niespójna część F z silnika blokuje eksport", () => {
  const summary = Object.assign(podsumowanie({ cryptoRevenuePLN: 101 }), { engineFormFields: {
    '36': 101, '37': 0, '38': 0, '39': 101, '40': 0,
    '41': 101, '42': 19, '43': 19, '44': 0, '45': 19,
  } });
  assert.throws(() => generatePit38XML(summary, [], [], PODATNIK), /poz\. 43 ≠ stawka z poz\. 41/);
});

test("zryczałtowany podatek od dywidend zagranicznych stoi w części G", () => {
  const xml = generatePit38XML(
    podsumowanie({
      dividendGrossPLN: 4000,
      dividendForeignTaxPLN: 1200,
      dividendPolishTaxDuePLN: 760,
      dividendTaxToPayPLN: 160,
    }),
    [],
    [],
    PODATNIK
  );

  // Poz. 47 - podatek 19% od przychodów z art. 30a ust. 1 pkt 1-5,
  // poz. 48 - podatek zapłacony za granicą w granicach art. 30a ust. 9,
  // poz. 49 - różnica do dopłaty.
  assert.match(xml, /<P_47>760\.00<\/P_47>/);
  assert.match(xml, /<P_48>600\.00<\/P_48>/, "odliczeniu podlega tylko kwota w limicie umownym");
  assert.match(xml, /<P_49>160\.00<\/P_49>/);
  // Pobrane 1200 PLN przy limicie 600 PLN: nadwyżka nie obniża podatku w Polsce.
  assert.match(xml, /przekracza limit stawki umownej[\s\S]*600\.00 PLN/);
});

test("kwoty z PIT-8C trafiają do poz. 20 i 21, a reszta do 22 i 23", () => {
  const xml = generatePit38XML(
    podsumowanie({
      revenuePLN: 100000,
      costsPLN: 60000,
      pit8cRevenuePLN: 30000,
      pit8cCostsPLN: 20000,
      foreignRevenuePLN: 70000,
      foreignCostsPLN: 40000,
    }),
    [],
    [],
    PODATNIK
  );

  assert.match(xml, /<P_20>30000\.00<\/P_20>/);
  assert.match(xml, /<P_21>20000\.00<\/P_21>/);
  assert.match(xml, /<P_22>70000\.00<\/P_22>/);
  assert.match(xml, /<P_23>40000\.00<\/P_23>/);
});

test("PIT-38(18) zachowuje grosze w części C i podatku przed zaokrągleniem", () => {
  const xml = generatePit38XML(podsumowanie({
    year: 2025,
    revenuePLN: 11170937.84,
    costsPLN: 11083922.18,
    incomePLN: 87015.66,
    pit8cRevenuePLN: 100.10,
    pit8cCostsPLN: 20.09,
    priorYearLossUsedPLN: 0,
  }), [], [], PODATNIK);
  const pole = (numer: number) => xml.match(new RegExp(`<P_${numer}>(\\d+(?:\\.\\d+)?)</P_${numer}>`))?.[1];
  assert.equal(pole(20), '100.10');
  assert.equal(pole(21), '20.09');
  assert.equal(pole(22), '11170837.74');
  assert.equal(pole(23), '11083902.09');
  assert.equal(pole(26), '11170937.84');
  assert.equal(pole(27), '11083922.18');
  assert.equal(pole(28), '87015.66');
  assert.equal(Math.round(Number(pole(26)) * 100) - Math.round(Number(pole(27)) * 100), Math.round(Number(pole(28)) * 100));
  assert.equal(pole(31), '87016');
  assert.equal(pole(33), '16533.04');
  assert.equal(pole(35), '16533');
});

test("poz. 20 i 21 biorą się z informacji PIT-8C, a nie z własnego rachunku", () => {
  // Broker zgłosił urzędowi 30 000 / 20 000, aplikacja policzyła 29 990 / 20 010.
  // Do zeznania idzie kwota z informacji - to ją urząd porównuje z zeznaniem.
  const xml = generatePit38XML(
    podsumowanie({
      revenuePLN: 1533701,
      costsPLN: 1487850,
      pit8cRevenuePLN: 30000,
      pit8cCostsPLN: 20000,
      pit8cZrodlo: "informacja",
      pit8cWyliczonyPrzychodPLN: 29990,
      pit8cWyliczoneKosztyPLN: 20010,
      foreignRevenuePLN: 1503711,
      foreignCostsPLN: 1467840,
    }),
    [],
    [],
    PODATNIK
  );

  assert.match(xml, /<P_20>30000\.00<\/P_20>/);
  assert.match(xml, /<P_21>20000\.00<\/P_21>/);
  // Wiersz 2 zostaje przy tym, co aplikacja policzyla poza rachunkami z PIT-8C.
  assert.match(xml, /<P_22>1503711\.00<\/P_22>/);
  assert.match(xml, /<P_23>1467840\.00<\/P_23>/);
  assert.match(xml, /<P_26>1533711\.00<\/P_26>/, "poz. 26 = 20 + 22, nawet gdy różni się od własnej sumy");
});

test("XML przepisuje poz. 34, 35 i 51 z projekcji silnika", () => {
  const summary = Object.assign(podsumowanie({
    revenuePLN: 600, costsPLN: 150,
    pit8cZrodlo: 'informacja',
  }), { engineFormFields: {
    '20': 500, '21': 100, '22': 100, '23': 50,
    '26': 600, '27': 150, '28': 450, '29': 0, '30': 300,
    '31': 150, '33': 28.50, '34': 3.17, '35': 25, '51': 25,
  } });
  const xml = generatePit38XML(summary, [], [], PODATNIK);
  assert.match(xml, /<P_34>3\.17<\/P_34>/);
  assert.match(xml, /<P_35>25<\/P_35>/);
  assert.match(xml, /<P_51>25\.00<\/P_51>/);
});

test("bez rozbicia PIT-8C eksport wymaga przypisania rachunków", () => {
  assert.throws(() => generatePit38XML(
    podsumowanie({
      revenuePLN: 100000,
      costsPLN: 60000,
      pit8cRevenuePLN: 30000,
      pit8cCostsPLN: 20000,
      pit8cZrodlo: "informacja",
      foreignRevenuePLN: undefined,
      foreignCostsPLN: undefined,
    }),
    [],
    [],
    PODATNIK
  ), /Brak wiarygodnego podziału rachunków/);
});

test("części po zaokrągleniu nie podnoszą sumy przychodu", () => {
  // 40,50 + 60,50 zaokrąglane osobno dawało 41 + 61 = 102 zamiast 101,
  // a razem z kosztami podnosiło podstawę i podatek.
  const xml = generatePit38XML(
    podsumowanie({
      revenuePLN: 101,
      costsPLN: 99,
      incomePLN: 2,
      taxDuePLN: 0,
      pit8cRevenuePLN: 40.5,
      pit8cCostsPLN: 49.5,
      foreignRevenuePLN: 60.5,
      foreignCostsPLN: 49.5,
      totalTaxToPayPLN: 0,
    }),
    [],
    [],
    PODATNIK
  );

  assert.match(xml, /<P_26>101\.00<\/P_26>/, "suma poz. 20 i 22 to zaokrąglony przychód");
  assert.match(xml, /<P_27>99\.00<\/P_27>/);
});

test("podatek z części F wchodzi do kwoty do zapłaty", () => {
  const xml = generatePit38XML(
    podsumowanie({
      taxDuePLN: 7600,
      cryptoRevenuePLN: 50000,
      cryptoCostsPLN: 30000,
      cryptoCostsCurrentYearPLN: 30000,
      cryptoIncomePLN: 20000,
      cryptoTaxDuePLN: 3800,
      totalTaxToPayPLN: 11400,
    }),
    [],
    [],
    PODATNIK
  );

  assert.match(xml, /<P_45>3800<\/P_45>/);
  assert.match(xml, /<P_51>11400\.00<\/P_51>/, "poz. 51 to podatek z części D plus część F");
});

test("formularz się domyka: poz. 26-28, podstawa i kwota do zapłaty", () => {
  const xml = generatePit38XML(
    podsumowanie({
      pit8cRevenuePLN: 30000,
      pit8cCostsPLN: 20000,
      foreignRevenuePLN: 70000,
      foreignCostsPLN: 40000,
      priorYearLossUsedPLN: 5000,
      dividendPolishTaxDuePLN: 760,
      dividendTaxToPayPLN: 160,
    }),
    [],
    [],
    PODATNIK
  );

  const poz = (numer: number): number => {
    const trafienie = xml.match(new RegExp(`<P_${numer}>(-?\\d+(?:\\.\\d+)?)</P_${numer}>`));
    assert.ok(trafienie, `brak pozycji ${numer}`);
    return Number(trafienie![1]);
  };

  // Wiersz ulgi IPO (poz. 24-25) jest w schemacie opcjonalny jako para, wiec
  // przy zerach w ogole go nie emitujemy.
  assert.ok(!xml.includes("<P_24>"), "pusty wiersz ulgi IPO nie wchodzi do pliku");
  assert.equal(poz(26), poz(20) + poz(22), "poz. 26 = 20 + 22");
  assert.equal(poz(27), poz(21) + poz(23), "poz. 27 = 21 + 23");
  assert.equal(poz(28), poz(26) - poz(27), "poz. 28 = 26 - 27");
  assert.equal(poz(31), poz(28) - poz(30), "poz. 31 = 28 - 30");
  assert.equal(poz(33), Math.round((poz(31) * 19) / 100), "poz. 33 = 19% podstawy");
  assert.equal(poz(35), poz(33), "bez podatku zagranicznego poz. 35 = poz. 33");
  assert.equal(poz(51), poz(35) + poz(49), "poz. 51 to suma podatków należnych");
});

test("odliczona strata z lat ubiegłych nie przekracza dochodu", () => {
  const xml = generatePit38XML(
    podsumowanie({ incomePLN: 40000, priorYearLossUsedPLN: 999999 }),
    [],
    [],
    PODATNIK
  );

  assert.match(xml, /<P_30>40000\.00<\/P_30>/);
  assert.match(xml, /<P_31>0<\/P_31>/);
  assert.match(xml, /<P_33>0\.00<\/P_33>/);
});

test("łączny podatek nie trafia do pola zryczałtowanego podatku od dywidend", () => {
  const xml = generatePit38XML(
    podsumowanie({ taxDuePLN: 7600, totalTaxToPayPLN: 7600 }),
    [],
    [],
    PODATNIK
  );

  assert.ok(!xml.includes("<P_45>7600</P_45>"), "poz. 45 to podatek z części F");
  assert.match(xml, /<P_51>7600\.00<\/P_51>/, "kwota do zapłaty to poz. 51");
});

test("plik niesie potwierdzony numer wzoru z repozytorium MF", () => {
  const xml = generatePit38XML(podsumowanie({ year: 2025 }), [], [], PODATNIK);

  assert.ok(
    !xml.includes("crd.gov.pl/wzor/2023/12/15/13100"),
    "adres wzoru, którego nie ma w repozytorium, zniknął"
  );
  assert.match(xml, /xmlns="http:\/\/crd\.gov\.pl\/wzor\/2025\/10\/09\/13914\/"/);
  assert.match(xml, /kodSystemowy="PIT-38 \(18\)"/);
  assert.match(xml, /kodPodatku="PPW"/);
  assert.match(xml, /rodzajZobowiazania="Z"/);
  assert.match(xml, /<WariantFormularza>18<\/WariantFormularza>/);
  // Schemat wymaga pouczen i danych adresowych - bez nich plik nie przechodzi
  // walidacji, mimo ze wyglada na kompletny.
  assert.match(xml, /<Pouczenia>1<\/Pouczenia>/);
  assert.match(xml, /<etd:DataUrodzenia>1985-04-12<\/etd:DataUrodzenia>/);
  assert.match(xml, /<Wojewodztwo>MAZOWIECKIE<\/Wojewodztwo>/);
});

test("wzór dobiera się do roku podatkowego", () => {
  assert.match(generatePit38XML(podsumowanie({ year: 2024 }), [], [], PODATNIK), /PIT-38 \(17\)/);
  assert.match(generatePit38XML(podsumowanie({ year: 2023 }), [], [], PODATNIK), /PIT-38 \(16\)/);
  // Rok bez opublikowanego wzoru dostaje najnowszy i informacje o tym.
  const przyszly = generatePit38XML(podsumowanie({ year: 2026 }), [], [], PODATNIK);
  assert.match(przyszly, /PIT-38 \(18\)/);
  assert.match(przyszly, /nie ma jeszcze opublikowanego wzoru/);
  // Przed rokiem 2023 nie mamy potwierdzonego wzoru - lepiej nie wygenerowac
  // pliku niz wygenerowac go z numerami z innego formularza.
  assert.throws(() => generatePit38XML(podsumowanie({ year: 2022 }), [], [], PODATNIK), /wzoru PIT-38 za 2022/);
});

test("brak danych wymaganych przez schemat zatrzymuje eksport", () => {
  assert.throws(
    () => generatePit38XML(podsumowanie(), [], [], { ...PODATNIK, birthDate: "" }),
    /data urodzenia/
  );
  assert.throws(
    () => generatePit38XML(podsumowanie(), [], [], { ...PODATNIK, wojewodztwo: "", nrDomu: "" }),
    /województwo.*numer domu/s
  );
  assert.throws(
    () => generatePit38XML(podsumowanie(), [], [], { ...PODATNIK, kodPocztowy: "00001" }),
    /kod pocztowy/
  );
});

test("kwota do zapłaty i nadpłata wykluczają się nawzajem", () => {
  // Schemat dopuszcza tylko jedną z pozycji 51 i 52.
  const xml = generatePit38XML(podsumowanie(), [], [], PODATNIK);
  const maDoZaplaty = xml.includes("<P_51>");
  const maNadplate = xml.includes("<P_52>");
  assert.ok(maDoZaplaty !== maNadplate, "dokładnie jedna z pozycji 51 i 52");
});

test("bez operacji na krypto część E w ogóle się nie pojawia", () => {
  const xml = generatePit38XML(podsumowanie(), [zysk()], [], PODATNIK);

  assert.ok(!xml.includes("<P_36>"), "brak pustej części E");
  assert.ok(!xml.includes("CZĘŚĆ E"), "brak nagłówka części E bez danych");
});

test("pozycje idą w kolejności wymaganej przez schemat", () => {
  // Schemat PIT-38(18) opisuje PozycjeSzczegolowe jako sekwencję - element
  // wstawiony nie w swojej kolejności unieważnia cały plik, a walidator
  // e-Deklaracji mówi wtedy tylko "element nieoczekiwany".
  const xml = generatePit38XML(
    podsumowanie({
      pit8cRevenuePLN: 30000,
      pit8cCostsPLN: 20000,
      foreignRevenuePLN: 70000,
      foreignCostsPLN: 40000,
      priorYearLossUsedPLN: 5000,
      cryptoRevenuePLN: 50000,
      cryptoCostsPLN: 30000,
      cryptoCostsCurrentYearPLN: 30000,
      cryptoIncomePLN: 20000,
      cryptoTaxDuePLN: 3800,
      dividendGrossPLN: 4000,
      dividendForeignTaxPLN: 600,
      dividendPolishTaxDuePLN: 760,
      dividendTaxToPayPLN: 160,
    }),
    [zysk({ profitPLN: 12000 })],
    [],
    PODATNIK
  );

  const kolejnosc = [...xml.matchAll(/<(P_\d+)>/g)].map((t) => Number(t[1].slice(2)));
  const posortowane = [...kolejnosc].sort((a, b) => a - b);
  assert.deepEqual(kolejnosc, posortowane, `pozycje nie rosną: ${kolejnosc.join(', ')}`);

  // Naglowek, podmiot, pozycje, pouczenia, zalaczniki - w tej kolejnosci.
  const sekcje = ['<Naglowek>', '<Podmiot1', '<PozycjeSzczegolowe>', '<Pouczenia>', '<Zalaczniki>'];
  const pozycje = sekcje.map((s) => xml.indexOf(s));
  assert.ok(
    pozycje.every((p, i) => p >= 0 && (i === 0 || p > pozycje[i - 1])),
    `zła kolejność sekcji: ${pozycje.join(', ')}`
  );
});

test("częściowa mapa pól silnika (poz. 31 i 45-51) nie zeruje części C", () => {
  // Zwykły przebieg publikował w podsumowaniu tylko poz. 31 i 45-51. Eksport
  // uznawał to za pełną mapę formularza: poz. 20-29 dostawały zero obok
  // podstawy 87 016 zł w poz. 31 - XML zgodny ze schematem, ale sprzeczny.
  const summary = Object.assign(podsumowanie({
    year: 2025,
    revenuePLN: 11170937.84,
    costsPLN: 11083922.18,
    incomePLN: 87015.66,
    pit8cRevenuePLN: 0,
    pit8cCostsPLN: 0,
    priorYearLossUsedPLN: 0,
  }), { engineFormFields: {
    '31': 87016, '45': 0, '46': 0, '47': 0.14, '48': 0.11, '49': 0, '50': 0, '51': 16533,
  } });
  const xml = generatePit38XML(summary, [], [], PODATNIK);
  const pole = (numer: number) => xml.match(new RegExp(`<P_${numer}>(\\d+(?:\\.\\d+)?)</P_${numer}>`))?.[1];
  assert.equal(pole(22), '11170937.84');
  assert.equal(pole(26), '11170937.84');
  assert.equal(pole(27), '11083922.18');
  assert.equal(pole(28), '87015.66');
  assert.equal(pole(31), '87016');
  assert.equal(pole(51), '16533.00');
});

test("dane podatnika są escapowane w XML (znak & w nazwisku, < w adresie)", () => {
  const xml = generatePit38XML(podsumowanie(), [], [], {
    ...PODATNIK, lastName: "KOWALSKI & NOWAK", ulica: "Aleja <Róż>",
  });
  assert.match(xml, /<etd:Nazwisko>KOWALSKI &amp; NOWAK<\/etd:Nazwisko>/);
  assert.match(xml, /<Ulica>Aleja &lt;Róż&gt;<\/Ulica>/);
  assert.doesNotMatch(xml, /KOWALSKI & NOWAK/);
});

test("PESEL i NIP są sprawdzane sumą kontrolną, a PESEL także z datą urodzenia", () => {
  const eksport = (dane: Partial<typeof PODATNIK>) => () => generatePit38XML(podsumowanie(), [], [], { ...PODATNIK, ...dane });
  assert.throws(eksport({ peselOrNip: "00000000000" }), /poprawny PESEL/);
  assert.throws(eksport({ peselOrNip: "85041212345" }), /poprawny PESEL/);
  assert.throws(eksport({ birthDate: "1985-04-13" }), /data urodzenia zgodna z numerem PESEL/);
  assert.throws(eksport({ peselOrNip: "1234563217" }), /poprawny NIP/);
  assert.doesNotThrow(eksport({ peselOrNip: "1234563218" }));
});

test("PIT/ZG bierze państwo, dochód i podatek zapłacony za granicą z silnika", () => {
  // NBIS.US to spółka holenderska: silnik (ISIN) daje NL, sufiks tickera dałby US.
  const summary = podsumowanie({
    pitZgRows: [
      { country: "NL", incomePLN: 1234.56, foreignTaxPLN: 0 },
      { country: "US", incomePLN: 100.1, foreignTaxPLN: 15.02 },
      { country: "PL", incomePLN: 50, foreignTaxPLN: 0 },
    ],
  });
  const xml = generatePit38XML(summary, [zysk({ ticker: "NBIS.US", profitPLN: 1334.66 })], [], PODATNIK);
  assert.match(xml, /<zg38:P_7>NL<\/zg38:P_7>\s*<zg38:P_29>1234\.56<\/zg38:P_29>\s*<zg38:P_30>0\.00<\/zg38:P_30>/);
  assert.match(xml, /<zg38:P_7>US<\/zg38:P_7>\s*<zg38:P_29>100\.10<\/zg38:P_29>\s*<zg38:P_30>15\.02<\/zg38:P_30>/);
  assert.doesNotMatch(xml, /<zg38:P_7>PL<\/zg38:P_7>/, "dochód krajowy nie wchodzi do PIT/ZG");
  assert.match(xml, /<P_72>2<\/P_72>\s*<\/PozycjeSzczegolowe>/, "poz. 72 liczy dołączone PIT/ZG (bez PL)");
});

test("prefiks ISIN spoza słownika krajów (XS) nie staje się załącznikiem PIT/ZG", () => {
  const xml = generatePit38XML(podsumowanie({
    pitZgRows: [
      { country: "XS", incomePLN: 300, foreignTaxPLN: 0 },
      { country: "US", incomePLN: 100, foreignTaxPLN: 0 },
    ],
  }), [], [], PODATNIK);
  assert.doesNotMatch(xml, /<zg38:P_7>XS<\/zg38:P_7>/);
  assert.match(xml, /dochód 300 PLN bez ustalonego kraju źródła/);
  assert.match(xml, /<P_72>1<\/P_72>/);
});

test("nieistniejąca albo przyszła data urodzenia zatrzymuje eksport", () => {
  const eksport = (birthDate: string) => () =>
    generatePit38XML(podsumowanie(), [], [], { ...PODATNIK, peselOrNip: "1234563218", birthDate });
  assert.throws(eksport("1985-02-31"), /istniejąca data/);
  assert.throws(eksport("1899-12-31"), /istniejąca data/);
  assert.throws(eksport("2999-01-01"), /istniejąca data/);
  assert.doesNotThrow(eksport("1985-04-12"));
});

test("bez załączników PIT/ZG deklaracja nie podaje poz. 72", () => {
  const xml = generatePit38XML(podsumowanie({ pitZgRows: [{ country: "PL", incomePLN: 50, foreignTaxPLN: 0 }] }), [], [], PODATNIK);
  assert.doesNotMatch(xml, /<P_72>/);
  assert.doesNotMatch(xml, /Zalacznik_PIT_ZG/);
});

test("część G eksportuje pozycje 46 i 50 w pełnych złotych i we właściwej kolejności", () => {
  const summary = Object.assign(podsumowanie(), { engineFormFields: { '46': 12, '50': 3, '51': 7600 } });
  const xml = generatePit38XML(summary, [], [], PODATNIK);
  assert.match(xml, /<P_46>12<\/P_46>[\s\S]*<P_47>0\.00<\/P_47>[\s\S]*<P_49>0\.00<\/P_49>[\s\S]*<P_50>3<\/P_50>/);
});

test("sprzeczne pola silnika zatrzymują eksport zamiast dać plik zgodny tylko ze schematem", () => {
  const summary = Object.assign(podsumowanie(), { engineFormFields: {
    '20': 0, '21': 0, '22': 100, '23': 50, '26': 600, '27': 150, '28': 450, '29': 0, '30': 0,
    '31': 450, '33': 85.5, '34': 0, '35': 86,
  } });
  assert.throws(() => generatePit38XML(summary, [], [], PODATNIK), /nie jest spójna rachunkowo.*poz\. 26/);
});

test("ostrzeżenie o wzorze podaje wariant użyty w pliku, a dla potwierdzonego roku go nie ma", () => {
  assert.equal(ostrzezenieOWzorzePit38(2025), null);
  const ostrzezenie = ostrzezenieOWzorzePit38(2026) ?? "";
  assert.match(ostrzezenie, /2026/);
  assert.match(ostrzezenie, /wariantu 18/);
});
