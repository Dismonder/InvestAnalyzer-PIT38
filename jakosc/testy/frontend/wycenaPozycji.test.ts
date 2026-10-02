/**
 * Wycena otwartych pozycji.
 *
 * Kazdy przypadek odpowiada bledowi, ktory realnie stal w aplikacji: cena
 * wpisana w kod udajaca notowanie z gieldy, brak kursu zamieniony na zero
 * i pozycja bez wyceny wliczana do sum jako zero.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  opiszBrakiWyceny,
  podsumujWycene,
  wycenPozycje,
} from "../../../aplikacje/web/src/portfel/services/wycenaPozycji.ts";
import type {
  LiveMarketQuote,
  OpenPosition,
} from "../../../aplikacje/web/src/portfel/types.ts";

function pozycja(nadpisania: Partial<OpenPosition> = {}): OpenPosition {
  return {
    ticker: "NVDA",
    name: "NVIDIA",
    category: "STOCK_FOREIGN",
    currency: "USD",
    totalQuantity: 10,
    avgBuyPrice: 100,
    totalCostPLN: 4000,
    accountIds: [],
    ...nadpisania,
  } as unknown as OpenPosition;
}

function notowanie(cena: number, zmiana = 0, waluta: LiveMarketQuote["currency"] = "USD"): LiveMarketQuote {
  return {
    ticker: "NVDA",
    name: "NVIDIA",
    category: "STOCK_FOREIGN",
    price: cena,
    currency: waluta,
    change24h: 0,
    changePercent24h: zmiana,
    high24h: cena,
    low24h: cena,
    volume24h: 0,
    sparkline: [],
    lastUpdated: new Date().toISOString(),
    source: "FREEDOM24",
  };
}

test("pozycja z notowaniem i kursem wchodzi do sum", () => {
  const wycena = wycenPozycje([pozycja()], { NVDA: notowanie(120) }, { USD: 4 });

  assert.equal(wycena[0].maWycene, true);
  assert.equal(wycena[0].currentValuePLN, 4800);
  assert.equal(wycena[0].unrealizedPLN, 800);

  const suma = podsumujWycene(wycena);
  assert.equal(suma.wartoscPLN, 4800);
  assert.equal(suma.liczbaBezWyceny, 0);
  assert.equal(opiszBrakiWyceny(suma), null);
});

test("brak notowania nie zamienia sie w wycene po cenie zakupu", () => {
  // Cena nabycia w miejscu notowania dawala wynik 0 zl i zmiane 0% - wyglada
  // jak spokojna sesja, a znaczy "nie wiemy, ile to dzis warte".
  const wycena = wycenPozycje([pozycja()], {}, { USD: 4 });

  assert.equal(wycena[0].maNotowanie, false);
  assert.equal(wycena[0].maWycene, false);
  assert.equal(wycena[0].unrealizedPLN, 0);

  const suma = podsumujWycene(wycena);
  assert.equal(suma.wartoscPLN, null, "bez zadnej wyceny wartosc jest nieznana, nie zerowa");
  assert.equal(suma.kosztWycenionychPLN, 0, "podstawa wyniku z tego samego zbioru co wartosc");
  assert.equal(suma.liczbaBezNotowania, 1);
  assert.match(opiszBrakiWyceny(suma) ?? "", /brak notowania/);
});

test("brak kursu NBP nie wycenia pozycji na zero", () => {
  // Wczesniej mnoznik 0 dawal wartosc 0 zl i strate calego kapitalu.
  const wycena = wycenPozycje([pozycja()], { NVDA: notowanie(120) }, {});

  assert.equal(wycena[0].maNotowanie, true);
  assert.equal(wycena[0].maKursWaluty, false);
  assert.equal(wycena[0].maWycene, false);
  assert.equal(wycena[0].unrealizedPLN, 0);

  const suma = podsumujWycene(wycena);
  assert.equal(suma.wartoscPLN, null);
  assert.equal(suma.liczbaBezKursu, 1);
  assert.match(opiszBrakiWyceny(suma) ?? "", /kursu NBP/);
});

test("wynik liczy sie z tego samego zbioru co wartosc, a kapitał ze wszystkich pozycji", () => {
  // Wynik: gdyby koszt obejmowal pozycje bez wyceny, a wartosc nie, roznica
  // pokazywalaby strate, ktorej nie ma - stad `kosztWycenionychPLN`.
  // Kapital: koszt zakupu znamy z transakcji niezaleznie od notowania.
  // Liczony tylko z wycenionych dawal "Zainwestowany Kapital: 0,00 zl"
  // przy portfelu, za ktory uzytkownik zaplacil 132 tys. zl.
  const wycena = wycenPozycje(
    [pozycja({ ticker: "NVDA" }), pozycja({ ticker: "AAPL", totalCostPLN: 9999 })],
    { NVDA: notowanie(120) },
    { USD: 4 }
  );

  const suma = podsumujWycene(wycena);
  assert.equal(suma.kosztWycenionychPLN, 4000, "podstawa wyniku to tylko wycenione");
  assert.equal(suma.kosztPLN, 13999, "zainwestowany kapital obejmuje wszystkie pozycje");
  assert.equal(suma.wynikPLN, 800, "wynik nadal bez fantomowej straty");
  assert.equal(suma.liczbaBezWyceny, 1);
});

test("bez zadnej wyceny wynik i zmiana dzienna sa nieznane, a kapital znany", () => {
  // Ekran pokazywal "0,00 PLN" wartosci, zielone "+0.00% zwrotu" i
  // "+0.00% dzisiaj" nad czterema pozycjami bez notowania.
  const wycena = wycenPozycje([pozycja({ ticker: "NVDA", totalCostPLN: 4000 })], {}, { USD: 4 });

  const suma = podsumujWycene(wycena);
  assert.equal(suma.wartoscPLN, null);
  assert.equal(suma.wynikPLN, null);
  assert.equal(suma.wynikProcent, null);
  assert.equal(suma.zmianaDziennaPLN, null);
  assert.equal(suma.zmianaDziennaProcent, null);
  assert.equal(suma.kosztPLN, 4000, "koszt zakupu jest znany bez notowania");
});

test("pozycja w zlotych nie potrzebuje kursu", () => {
  const wycena = wycenPozycje(
    [pozycja({ ticker: "CDR", currency: "PLN", avgBuyPrice: 200, totalCostPLN: 2000, totalQuantity: 10 })],
    { CDR: notowanie(250, 0, "PLN") },
    {}
  );

  assert.equal(wycena[0].maWycene, true);
  assert.equal(wycena[0].currentValuePLN, 2500);
  assert.equal(wycena[0].unrealizedPLN, 500);
});

test("zmiana dzienna liczy sie tylko dla wycenionych pozycji", () => {
  const zWycena = wycenPozycje([pozycja()], { NVDA: notowanie(120, 2) }, { USD: 4 });
  assert.equal(Math.round(zWycena[0].dailyPnLPLN as number), 94);

  const bezNotowania = wycenPozycje([pozycja()], {}, { USD: 4 });
  assert.equal(bezNotowania[0].change24h, null);
  assert.equal(bezNotowania[0].dailyPnLPLN, null);
});

test("zmiana dzienna odnosi sie do poprzedniego zamkniecia", () => {
  const wycena = wycenPozycje([pozycja()], { NVDA: notowanie(120, 6.17) }, { USD: 4 });
  const suma = podsumujWycene(wycena);
  const oczekiwana = 4800 * 6.17 / 106.17;
  assert.ok(Math.abs((suma.zmianaDziennaPLN as number) - oczekiwana) < 0.001);
  assert.ok(Math.abs((suma.zmianaDziennaProcent as number) - 6.17) < 0.001);
});

test("brak zmiany procentowej nie udaje zerowej zmiany dnia", () => {
  const bezZmiany = { ...notowanie(120), changePercent24h: undefined as unknown as number };
  const wycena = wycenPozycje([pozycja()], { NVDA: bezZmiany }, { USD: 4 });
  assert.equal(wycena[0].dailyPnLPLN, null);
  assert.equal(podsumujWycene(wycena).zmianaDziennaPLN, null);
  const znana = wycenPozycje([pozycja({ ticker: 'AAPL' })], { AAPL: { ...notowanie(100, 2), ticker: 'AAPL' } }, { USD: 4 });
  const suma = podsumujWycene([...wycena, ...znana]);
  assert.ok(Math.abs((suma.zmianaDziennaProcent as number) - 2) < 0.001);
});

test("niepoprawna podstawa zmiany dziennej zwraca brak danych", () => {
  const wycena = wycenPozycje([pozycja()], { NVDA: notowanie(120, -100) }, { USD: 4 });
  assert.equal(wycena[0].dailyPnLPLN, null);
});

test("obie przyczyny braku wyceny sa rozroznione w komunikacie", () => {
  const wycena = wycenPozycje(
    [pozycja({ ticker: "NVDA" }), pozycja({ ticker: "AAPL", currency: "GBP" })],
    { AAPL: { ...notowanie(50, 0, "GBP"), ticker: "AAPL" } },
    { USD: 4 }
  );

  const suma = podsumujWycene(wycena);
  assert.equal(suma.liczbaBezNotowania, 1, "NVDA nie ma notowania");
  assert.equal(suma.liczbaBezKursu, 1, "AAPL ma notowanie, ale nie ma kursu GBP");
  assert.match(opiszBrakiWyceny(suma) ?? "", /1 bez notowania, 1 bez kursu NBP/);
});

test("kurs bierze sie z waluty notowania, nie z waluty zapisanej przy pozycji", () => {
  // Pozycja zapisana w EUR, notowanie podane w dolarach. Przeliczenie ceny
  // w dolarach kursem euro zawyzalo wartosc o kilkanascie procent.
  const wycena = wycenPozycje(
    [pozycja({ currency: "EUR", avgBuyPrice: 90, totalCostPLN: 3600 })],
    { NVDA: notowanie(100, 0, "USD") },
    { USD: 4, EUR: 4.5 }
  );

  assert.equal(wycena[0].kursPLN, 4, "kurs dolara, bo notowanie jest w dolarach");
  assert.equal(wycena[0].currentValuePLN, 4000);
  // Wynik "w walucie instrumentu" nie ma sensu przy dwoch roznych walutach.
  assert.equal(wycena[0].unrealizedOrig, 0);
  assert.equal(wycena[0].unrealizedPctOrig, 0);
});

test("brak ceny nabycia nie rozlewa NaN po sumach", () => {
  const wycena = wycenPozycje(
    [pozycja({ avgBuyPrice: undefined as unknown as number })],
    {},
    { USD: 4 }
  );

  assert.equal(Number.isFinite(wycena[0].currentValuePLN), true);
  assert.equal(Number.isFinite(wycena[0].costOrig), true);
  const suma = podsumujWycene(wycena);
  // Suma jest albo liczba skonczona, albo jawnym `null` ("nie wiem") -
  // nigdy NaN i nigdy podstawionym zerem.
  assert.ok(suma.wartoscPLN === null || Number.isFinite(suma.wartoscPLN));
  assert.ok(suma.wynikProcent === null || Number.isFinite(suma.wynikProcent));
  assert.equal(Number.isFinite(suma.kosztPLN), true);
});

test("opis brakow wyceny odmienia powod dla kilku pozycji", () => {
  const dwieBezKursu = podsumujWycene(wycenPozycje([pozycja(), pozycja({ ticker: "AMD" })], { NVDA: notowanie(120), AMD: notowanie(90) }, {}));
  assert.match(opiszBrakiWyceny(dwieBezKursu) ?? "", /Nie wyceniono 2 pozycji — brak kursu NBP dla ich walut\./);
  const jednaBezKursu = podsumujWycene(wycenPozycje([pozycja()], { NVDA: notowanie(120) }, {}));
  assert.match(opiszBrakiWyceny(jednaBezKursu) ?? "", /brak kursu NBP dla jej waluty\./);
  const dwieBezNotowania = podsumujWycene(wycenPozycje([pozycja(), pozycja({ ticker: "AMD" })], {}, { USD: 4 }));
  assert.match(opiszBrakiWyceny(dwieBezNotowania) ?? "", /brak notowań tych instrumentów\./);
});
