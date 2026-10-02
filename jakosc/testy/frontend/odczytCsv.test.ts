/**
 * Testy odczytu pol z wyciagu CSV.
 *
 * Kazdy przypadek odpowiada bledowi, ktory wczesniej cicho psul rejestr:
 * przesuniete kolumny przez cudzyslow z przecinkiem, data zamieniona na
 * dzisiejsza, brakujaca liczba zastapiona jedynka.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  podzielWiersz,
  podzielNaRekordy,
  wykryjSeparator,
  liczbaZPola,
  konwencjaKolumnyLiczb,
  niejednoznacznyZapisLiczby,
  dataZPola,
  kolejnoscDatZUkosnikiem,
  komorkiKolumnyDat,
  walutaZPola,
  walutyImportu,
  kolumnyWalutCsv,
  rodzajZPola,
  kolumnaCenyCsv,
  znakIlosciICeny,
  kategoriaImportu,
} from "../../../aplikacje/web/src/portfel/services/odczytCsv.ts";

test("pole w cudzysłowach z przecinkiem nie rozbija kolumn", () => {
  const wiersz = '2024-03-15,AAPL,"Apple Inc, Class A",BUY,50,170.25,USD,1.99';

  assert.deepEqual(podzielWiersz(wiersz, ","), [
    "2024-03-15",
    "AAPL",
    "Apple Inc, Class A",
    "BUY",
    "50",
    "170.25",
    "USD",
    "1.99",
  ]);
});

test("przecinek dziesiętny w cudzysłowach zostaje w swojej kolumnie", () => {
  const pola = podzielWiersz('15.07.2024,MSFT,"Microsoft Corp",SELL,10,"420,50",USD,"2,50"', ",");

  assert.equal(pola.length, 8);
  assert.equal(pola[5], "420,50");
  assert.equal(liczbaZPola(pola[5]), 420.5);
  assert.equal(liczbaZPola(pola[7]), 2.5);
});

test("podwojony cudzysłów w środku pola oznacza jeden znak", () => {
  assert.deepEqual(podzielWiersz('a,"on powiedział ""tak""",b', ","), [
    "a",
    'on powiedział "tak"',
    "b",
  ]);
});

test("separator wybiera się po liczbie pól, nie po pierwszym trafieniu", () => {
  // Naglowek rozdzielony srednikami, ale z przecinkiem w nazwie kolumny.
  assert.equal(wykryjSeparator("Data;Symbol;Nazwa, pełna;Ilość;Cena"), ";");
  assert.equal(wykryjSeparator("Date,Symbol,Name,Quantity,Price"), ",");
  assert.equal(wykryjSeparator("Date\tSymbol\tName\tQuantity"), "\t");
});

test("wiele przecinków w nazwie kolumny nie przebija prawdziwego separatora", () => {
  // Sam nagłówek daje po przecinku więcej pól niż po średniku, więc liczenie
  // kolumn wskazywało przecinek i cały poprawny plik rozsypywał się na wiersze
  // jednokolumnowe. Rozstrzyga zgodność nagłówka z danymi.
  const naglowek = "Data;Symbol;Ilość;Cena (USD, EUR, GBP, CHF, PLN)";
  const dane = ["2025-01-02;AAPL;2;100", "2025-01-03;MSFT;1;420"];

  assert.equal(wykryjSeparator(naglowek, dane), ";");
  assert.equal(podzielWiersz(dane[0], wykryjSeparator(naglowek, dane)).length, 4);
});

test("bez wierszy danych nadal wybiera sensowny separator", () => {
  assert.equal(wykryjSeparator("Data;Symbol;Ilość", []), ";");
  assert.equal(wykryjSeparator("Date,Symbol,Quantity", []), ",");
});

test('jawna klasa z CSV odroznia akcje FET od tokena FET', () => {
  assert.equal(kategoriaImportu('FET', 'Stock'), 'STOCK_FOREIGN');
  assert.equal(kategoriaImportu('FET', 'Crypto'), 'CRYPTO');
  assert.equal(kategoriaImportu('FET', 'ETF'), 'ETF');
  assert.equal(kategoriaImportu('FET', 'Bond'), 'BOND');
  assert.equal(kategoriaImportu('FET'), 'CRYPTO');
});

test("brak wartości daje null, a nie liczbę zastępczą", () => {
  assert.equal(liczbaZPola(""), null);
  assert.equal(liczbaZPola(undefined), null);
  assert.equal(liczbaZPola("brak"), null);
  assert.equal(liczbaZPola('"   "'), null);
});

test("liczba znosi separatory tysięcy i znak minus", () => {
  assert.equal(liczbaZPola("1 234,56"), 1234.56);
  assert.equal(liczbaZPola("1 234,56"), 1234.56);
  // Znak zostaje - o konwencji (sprzedaz, prowizja) decyduje importer (znakIlosciICeny).
  assert.equal(liczbaZPola("-42"), -42);
  assert.equal(liczbaZPola("0"), 0);
});

test("liczba rozpoznaje separatory dziesiętne bez akceptowania prefiksów", () => {
  assert.equal(liczbaZPola("1,234.56"), 1234.56);
  assert.equal(liczbaZPola("1.234,56"), 1234.56);
  assert.equal(liczbaZPola("1 234,56"), 1234.56);
  assert.equal(liczbaZPola("1234.5"), 1234.5);
  assert.equal(liczbaZPola("12,5"), 12.5);
  assert.equal(liczbaZPola("1,234"), 1.234);
  assert.equal(liczbaZPola("12abc"), null);
  assert.equal(liczbaZPola(""), null);
});

test("data czytana jest w obu układach, a nierozpoznana daje null", () => {
  assert.equal(dataZPola("2024-03-15"), "2024-03-15");
  assert.equal(dataZPola("2024/3/5"), "2024-03-05");
  assert.equal(dataZPola("15.07.2024"), "2024-07-15", "układ dzień-miesiąc-rok");
  assert.equal(dataZPola("01/02/2024"), "2024-02-01", "01/02 to 1 lutego, nie 2 stycznia");
  assert.equal(dataZPola("2024-03-15 14:30:00"), "2024-03-15");
  assert.equal(dataZPola("46024"), "2026-01-02", "serial Excela nie moze stac sie smieciowa data");
  assert.equal(dataZPola("46024,5"), "2026-01-02", "czesc ulamkowa oznacza godzine");
  assert.equal(dataZPola("12345"), null, "serial poza zakresem lat 1990-2100");

  assert.equal(dataZPola("brak-daty"), null);
  assert.equal(dataZPola(""), null);
  assert.equal(dataZPola(undefined), null);
});

test('waluta spoza listy obslugiwanych nie przechodzi jako waluta', () => {
  // Sciezka bez naglowkow robila `parts[6]?.toUpperCase() as CurrencyCode`,
  // czyli rzutowanie bez sprawdzenia: "AUD" albo dowolny smiec wchodzil do
  // rozliczenia jako waluta, a puste pole dawalo USD.
  assert.equal(walutaZPola('USD'), 'USD');
  assert.equal(walutaZPola(' pln '), 'PLN');
  assert.equal(walutaZPola('"EUR"'), 'EUR');
  assert.equal(walutaZPola('AUD'), null, 'AUD nie jest obslugiwane przez rozliczenie');
  assert.equal(walutaZPola('USDT'), null, 'waluta krypto nie przechodzi jako waluta akcji');
  assert.equal(walutaZPola('USDT', true), 'USDT');
  assert.equal(walutaZPola('BNB', true), 'BNB');
  assert.equal(walutaZPola('XYZ'), null);
  assert.equal(walutaZPola(''), null, 'brak waluty to nie USD');
  assert.equal(walutaZPola(undefined), null);
});

test('CSV krypto zachowuje osobna walute prowizji bez zmiany walut akcji', () => {
  assert.deepEqual(walutyImportu('USDT', 'BNB', true), {
    currency: 'USDT', commissionCurrency: 'BNB',
  });
  assert.deepEqual(walutyImportu('USD', 'PEPE', true), {
    currency: 'USD', commissionCurrency: 'PEPE',
  });
  assert.deepEqual(walutyImportu('USDT', 'BNB', false), {
    currency: null, commissionCurrency: null,
  });
  assert.deepEqual(kolumnyWalutCsv(['symbol', 'commission asset', 'currency', 'commission']), {
    currCol: 2, commCol: 3, commCurrCol: 1,
  });
});

test('nierozpoznany rodzaj operacji nie staje sie zakupem', () => {
  assert.equal(rodzajZPola('BUY'), 'BUY');
  assert.equal(rodzajZPola('Sprzedaż'), 'SELL');
  assert.equal(rodzajZPola('DYWIDENDA'), 'DIVIDEND');
  // Potracenie podatku to nie dochod z dywidendy.
  assert.equal(rodzajZPola('Dividend Tax'), null);
  assert.equal(rodzajZPola('Podatek od dywidendy'), null);
  assert.equal(rodzajZPola('WITHHOLDING'), null);
  assert.equal(rodzajZPola('Dividend'), 'DIVIDEND');
  assert.equal(rodzajZPola('TRANSFER'), null, 'przelew to nie zakup');
  assert.equal(rodzajZPola('SPLIT'), null);
  assert.equal(rodzajZPola(''), null, 'brak rodzaju to nie zakup');
  assert.equal(rodzajZPola(undefined), null);
});

test("kolumna ceny to cena waloru, a nie kurs waluty stojacy wczesniej", () => {
  assert.equal(kolumnaCenyCsv(["data", "ticker", "typ", "ilość", "kurs waluty", "cena", "waluta"]), 5);
  assert.equal(kolumnaCenyCsv(["date", "symbol", "side", "qty", "fx rate", "price", "currency"]), 5);
  // Polski wyciag bez kolumny "cena": kurs waloru nazywa sie "kurs".
  assert.equal(kolumnaCenyCsv(["data", "walor", "ilość", "kurs nbp", "kurs", "waluta"]), 4);
  assert.equal(kolumnaCenyCsv(["data", "walor", "ilość", "kurs waluty", "waluta"]), -1);
  assert.equal(kolumnaCenyCsv(["date", "symbol", "qty", "price (pln)", "currency"]), 3);
});

test("walor z GPW bez kolumny waluty jest w zlotych, reszta bez zgadywania", () => {
  assert.deepEqual(walutyImportu("", "", false, true), { currency: "PLN", commissionCurrency: "PLN" });
  // Podana waluta wygrywa, a nieznana nie zamienia sie w PLN.
  assert.equal(walutyImportu("EUR", "", false, true).currency, "EUR");
  assert.equal(walutyImportu("XYZ", "", false, true).currency, null);
  // Walor zagraniczny bez waluty nadal jest odrzucany.
  assert.equal(walutyImportu("", "", false, false).currency, null);
});

test("daty z ukosnikiem: kolejnosc rozstrzyga caly plik, a niemozliwa data jest odrzucana", () => {
  // Eksport amerykanski: 04/15/2026 moze byc tylko 15 kwietnia, wiec 04/03/2026 to 3 kwietnia.
  const usa = kolejnoscDatZUkosnikiem(["AAPL", "04/03/2026", "04/15/2026", "10"]);
  assert.equal(usa, "MDY");
  assert.equal(dataZPola("04/03/2026", usa), "2026-04-03");
  // Polski plik albo nierozstrzygniety - zapis polski (dzien przed miesiacem).
  assert.equal(kolejnoscDatZUkosnikiem(["15/04/2026", "04/03/2026"]), "DMY");
  assert.equal(kolejnoscDatZUkosnikiem(["04/03/2026", "05/06/2026"]), "DMY");
  assert.equal(dataZPola("04/03/2026"), "2026-03-04");
  // Kropka i myslnik zawsze po polsku, nawet gdy plik ma daty amerykanskie z ukosnikiem.
  assert.equal(dataZPola("04.03.2026", "MDY"), "2026-03-04");
  // Dzien albo miesiac, ktory nie istnieje, nie staje sie data.
  assert.equal(dataZPola("2026-13-45"), null);
  assert.equal(dataZPola("31.02.2026"), null);
  assert.equal(dataZPola("29.02.2024"), "2024-02-29");
});

test("kolumna ceny: cena za sztuke, nie kwota za cala transakcje", () => {
  assert.equal(kolumnaCenyCsv(["data", "walor", "ilość", "kurs", "cena całkowita", "waluta"]), 3);
  assert.equal(kolumnaCenyCsv(["date", "symbol", "qty", "total price", "unit price"]), 4);
  assert.equal(kolumnaCenyCsv(["date", "symbol", "qty", "price", "amount"]), 3);
  assert.equal(kolumnaCenyCsv(["data", "walor", "ilość", "wartość", "cena jednostkowa"]), 4);
});

test("kolejnosc dat tylko z kolumny daty - opis zaczynajacy sie od daty jej nie przestawia", () => {
  const wiersze = [["04/03/2026", "AAPL", "04/15/2026 dopłata", "10"], ["05/03/2026", "AAPL", "opis", "5"]];
  assert.equal(kolejnoscDatZUkosnikiem(komorkiKolumnyDat(wiersze, 0)), "DMY");
  assert.equal(dataZPola("04/03/2026", kolejnoscDatZUkosnikiem(komorkiKolumnyDat(wiersze, 0))), "2026-03-04");
  // Bez naglowkow: pierwsza i czwarta kolumna.
  assert.deepEqual(komorkiKolumnyDat([["a", "b", "c", "d", "e"]], null), ["a", "d"]);
  assert.deepEqual(komorkiKolumnyDat([["a", "b"]], -1), []);
});

test("minus przy sprzedazy to konwencja, przy kupnie i cenie - blad w pliku", () => {
  assert.deepEqual(znakIlosciICeny(-10, 100, "SELL"), { ilosc: 10, cena: 100, braki: [] });
  assert.deepEqual(znakIlosciICeny(-10, 100, "BUY").braki, ["ujemna liczba sztuk"]);
  assert.deepEqual(znakIlosciICeny(10, -100, "BUY").braki, ["ujemna cena"]);
  assert.deepEqual(znakIlosciICeny(null, 0, "BUY").braki, ["brak liczby sztuk", "brak ceny jednostkowej"]);
});

test("data krotka nie jest zgadywana, data z nazwa miesiaca bez przesuniecia dnia", () => {
  assert.equal(dataZPola("03/04/26"), null);
  assert.equal(dataZPola("Mar 4, 2026"), "2026-03-04");
  assert.equal(dataZPola("4 March 2026"), "2026-03-04");
});

test("nowa linia w cudzysłowie należy do pola, a nie rozcina rekordu", () => {
  const tresc = 'Data;Symbol;Nazwa;Ilosc\r\n2026-01-02;ABC;"Spółka\nSeria A";5\r\n\r\n2026-01-03;DEF;"Z ""cudzysłowem""";6\n';
  const rekordy = podzielNaRekordy(tresc);
  assert.equal(rekordy.length, 3);
  assert.deepEqual(podzielWiersz(rekordy[1], ";"), ["2026-01-02", "ABC", "Spółka\nSeria A", "5"]);
  assert.deepEqual(podzielWiersz(rekordy[2], ";"), ["2026-01-03", "DEF", 'Z "cudzysłowem"', "6"]);
});

test("niedomknięty cudzysłów nie połyka reszty pliku", () => {
  const rekordy = podzielNaRekordy('a;b\n1;5" rura\n2;x\n3;y');
  assert.equal(rekordy.length, 4);
});

test("konwencja liczb kolumny: przecinek dziesiętny wynika z wartości o innej liczbie cyfr niż trzy", () => {
  assert.equal(konwencjaKolumnyLiczb(["1,5", "1,234"]), "DZIESIETNY");
  assert.equal(liczbaZPola("1,234", "DZIESIETNY"), 1.234);
  assert.equal(konwencjaKolumnyLiczb(["0,125"]), "DZIESIETNY");
  assert.equal(konwencjaKolumnyLiczb(["12,50"]), "DZIESIETNY");
  assert.equal(konwencjaKolumnyLiczb(["1234,567"]), "DZIESIETNY");
  assert.equal(konwencjaKolumnyLiczb(["1.234,56", "1,234"]), "DZIESIETNY");
  assert.equal(konwencjaKolumnyLiczb(["5", "10"]), "BRAK_PRZECINKA");
});

test("konwencja liczb kolumny: przecinek tysięcy wynika z kropki dziesiętnej albo kilku grup", () => {
  assert.equal(konwencjaKolumnyLiczb(["1,234.50", "1,234"]), "TYSIECY");
  assert.equal(liczbaZPola("1,234", "TYSIECY"), 1234);
  assert.equal(liczbaZPola("1,234.50", "TYSIECY"), 1234.5);
  assert.equal(konwencjaKolumnyLiczb(["1,234,567"]), "TYSIECY");
  assert.equal(liczbaZPola("1,234,567", "TYSIECY"), 1234567);
});

test("kolumna z samymi zapisami typu 1,234 jest niejednoznaczna i nie jest zgadywana", () => {
  assert.equal(konwencjaKolumnyLiczb(["1,234", "2,345", "7"]), "NIEJEDNOZNACZNA");
  assert.equal(niejednoznacznyZapisLiczby("1,234", "NIEJEDNOZNACZNA"), true);
  assert.equal(niejednoznacznyZapisLiczby("7", "NIEJEDNOZNACZNA"), false);
  assert.equal(niejednoznacznyZapisLiczby("1,234", "DZIESIETNY"), false);
  assert.equal(niejednoznacznyZapisLiczby("1,234", "TYSIECY"), false);
});

test("kolumna ze sprzecznymi dowodami (1,234.50 i 1.234,50) jest sprzeczna, a wartość przeczącą konwencji nie jest po cichu zmieniana", () => {
  assert.equal(konwencjaKolumnyLiczb(["1,234.50", "1.234,50"]), "SPRZECZNA");
  assert.equal(niejednoznacznyZapisLiczby("1,234.50", "SPRZECZNA"), true);
  assert.equal(niejednoznacznyZapisLiczby("1.234,50", "SPRZECZNA"), true);
  assert.equal(niejednoznacznyZapisLiczby("12.5", "SPRZECZNA"), true);
  assert.equal(niejednoznacznyZapisLiczby("7", "SPRZECZNA"), false);
  assert.equal(liczbaZPola("1.234,50", "SPRZECZNA"), null);
  assert.equal(liczbaZPola("1,234.50", "SPRZECZNA"), null);
  // Wartość, której zapis przeczy konwencji kolumny, nie jest liczona po cichu.
  assert.equal(liczbaZPola("1.234,50", "TYSIECY"), null);
  assert.equal(liczbaZPola("1,234.50", "DZIESIETNY"), null);
  assert.equal(liczbaZPola("1.234,50", "DZIESIETNY"), 1234.5);
  assert.equal(liczbaZPola("1,234.50", "TYSIECY"), 1234.5);
});
