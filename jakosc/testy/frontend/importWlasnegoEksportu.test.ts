import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import { zbudujCsvTransakcji } from '../../../aplikacje/web/src/portfel/services/csvExporter.ts';
import { zdejmijNeutralizacjeCsv } from '../../../aplikacje/web/src/portfel/services/odczytCsv.ts';
import type { BrokerAccount, Transaction } from '../../../aplikacje/web/src/portfel/types.ts';

const importModalModule = await import(process.env.INVEST_IMPORT_MODAL_MODULE ?? new URL('../../../aplikacje/web/src/portfel/components/ImportTransactionsModal.tsx', import.meta.url).href);
const { czyMoznaZatwierdzicImport, ImportTransactionsModal, odczytPlikuImportu, parsujTransakcjeCsv } = importModalModule;

const rachunek = { id: 'k1', name: 'Dom; makler', brokerType: 'CUSTOM', currency: 'PLN', color: '#000' } as BrokerAccount;

function transakcja(zmiany: Partial<Transaction>): Transaction {
  return {
    id: 'reczna_1', accountId: 'k1', ticker: 'ABC', name: 'Spółka', category: 'STOCK_FOREIGN', type: 'BUY',
    date: '2026-01-02', quantity: 1.5, pricePerUnit: 10.25, currency: 'USD', commission: 0.5,
    commissionCurrency: 'USD', ...zmiany,
  };
}

const zrodlo = [
  transakcja({}),
  transakcja({ id: 'reczna_2', ticker: 'DEF', name: '-cmd', date: '2026-02-03', type: 'SELL', quantity: 2, pricePerUnit: 20 }),
  transakcja({ id: 'reczna_3', ticker: 'GHI', name: 'Spółka\nSeria A', date: '2026-03-04' }),
];

test('eksport aplikacji zaimportowany do tego samego rachunku nie dodaje duplikatow', () => {
  const csv = zbudujCsvTransakcji(zrodlo, [rachunek]).replace(/^\uFEFF/, '');
  const wynik = parsujTransakcjeCsv(csv, 'k1', [rachunek], 'eksport.csv');
  assert.equal(wynik.blad, '');
  assert.deepEqual(wynik.pominiete, []);
  assert.deepEqual(wynik.items?.map(({ id }) => id), ['reczna_1', 'reczna_2', 'reczna_3']);
  // Ta sama regula co w PortfelApp.handleImportTransactions: dedup po ID.
  const znane = new Set(zrodlo.map(({ id }) => id));
  assert.equal((wynik.items ?? []).filter(({ id }) => !znane.has(id)).length, 0);
});

test('nazwa neutralizowana przy eksporcie wraca bez apostrofu, a nazwa z nowa linia zostaje cala', () => {
  const csv = zbudujCsvTransakcji(zrodlo, [rachunek]).replace(/^\uFEFF/, '');
  const { items } = parsujTransakcjeCsv(csv, 'k1', [rachunek], 'eksport.csv');
  assert.equal(items?.[1].name, '-cmd');
  assert.equal(items?.[2].name, 'Spółka\nSeria A');
});

test('zdejmijNeutralizacjeCsv usuwa tylko apostrof sprzed = + - @ tab CR', () => {
  for (const znak of ['=', '+', '-', '@', '\t', '\r']) assert.equal(zdejmijNeutralizacjeCsv(`'${znak}x`), `${znak}x`);
  assert.equal(zdejmijNeutralizacjeCsv("'abc"), "'abc");
  assert.equal(zdejmijNeutralizacjeCsv("O'Neil"), "O'Neil");
});

const RACHUNEK_CSV = { id: 'k1', name: 'Dom', brokerType: 'CUSTOM', currency: 'USD', color: '#000' } as BrokerAccount;
const NAGLOWEK = 'Data;Symbol;Typ;Ilosc;Cena;Waluta';

test('import CSV: niejednoznaczne "1,234" w kolumnie ilości pomija wiersz z powodem, nie zgaduje', () => {
  const csv = `${NAGLOWEK}\n2026-01-02;ABC;BUY;1,234;10;USD\n2026-01-03;ABC;BUY;2,345;10;USD\n`;
  const wynik = parsujTransakcjeCsv(csv, 'k1', [RACHUNEK_CSV], 'p.csv');
  assert.deepEqual(wynik.items, []);
  assert.equal(wynik.pominiete?.length, 2);
  assert.match(wynik.pominiete?.[0].powod ?? '', /niejednoznaczny zapis liczby 1,234/);
});

test('import CSV: konwencja kolumny rozstrzyga - przecinek dziesiętny i przecinek tysięcy', () => {
  const dziesietny = parsujTransakcjeCsv(`${NAGLOWEK}\n2026-01-02;ABC;BUY;1,234;10;USD\n2026-01-03;ABC;BUY;1,5;10;USD\n`, 'k1', [RACHUNEK_CSV], 'p.csv');
  assert.deepEqual(dziesietny.items?.map((t) => t.quantity), [1.234, 1.5]);
  const tysiace = parsujTransakcjeCsv(`${NAGLOWEK}\n2026-01-02;ABC;BUY;1,234;10;USD\n2026-01-03;ABC;BUY;1,234,567;10;USD\n`, 'k1', [RACHUNEK_CSV], 'p.csv');
  assert.deepEqual(tysiace.items?.map((t) => t.quantity), [1234, 1234567]);
  // Cena z kropka dziesietna obok przecinka tysiecy w tej samej kolumnie.
  const cena = parsujTransakcjeCsv(`${NAGLOWEK}\n2026-01-02;ABC;BUY;1;1,234.50;USD\n2026-01-03;ABC;BUY;1;1,234;USD\n`, 'k1', [RACHUNEK_CSV], 'p.csv');
  assert.deepEqual(cena.items?.map((t) => t.pricePerUnit), [1234.5, 1234]);
});

test('import CSV: kolumna ze sprzecznymi zapisami (1,234.50 i 1.234,50) pomija wszystkie wiersze z separatorami', () => {
  const csv = `${NAGLOWEK}\n2026-01-02;ABC;BUY;1;1,234.50;USD\n2026-01-03;ABC;BUY;1;1.234,50;USD\n2026-01-04;ABC;BUY;1;7;USD\n`;
  const wynik = parsujTransakcjeCsv(csv, 'k1', [RACHUNEK_CSV], 'p.csv');
  assert.deepEqual(wynik.items?.map((t) => t.pricePerUnit), [7]);
  assert.equal(wynik.pominiete?.length, 2);
  assert.match(wynik.pominiete?.[0].powod ?? '', /niejednoznaczny zapis liczby 1,234\.50/);
});
test('pełny cykl eksport-import: dywidenda zachowuje stawkę i kwotę WHT (bez kwoty zostaje sama stawka)', () => {
  const dywidenda = transakcja({
    id: 'div-1', ticker: 'XYZ', name: 'XYZ', type: 'DIVIDEND', date: '2026-06-01', quantity: 1, pricePerUnit: 10,
    commission: 0, foreignTaxRate: 15, foreignTaxAmount: 1.44,
  });
  const tylkoStawka = transakcja({
    id: 'div-2', ticker: 'XYZ', name: 'XYZ', type: 'DIVIDEND', date: '2026-07-01', quantity: 1, pricePerUnit: 10,
    commission: 0, foreignTaxRate: 15,
  });
  const csv = zbudujCsvTransakcji([dywidenda, tylkoStawka], [rachunek]).replace(/^\uFEFF/, '');
  assert.match(csv, /Stawka podatku u źródła \(%\)/);
  assert.match(csv, /Kwota podatku u źródła/);
  const wynik = parsujTransakcjeCsv(csv, 'k1', [rachunek], 'eksport.csv');
  assert.deepEqual(wynik.pominiete, []);
  assert.equal(wynik.blad, '');
  const [div, stawka] = wynik.items ?? [];
  assert.equal(div.type, 'DIVIDEND');
  assert.equal(div.foreignTaxRate, 15);
  assert.equal(div.foreignTaxAmount, 1.44);
  assert.equal(stawka.foreignTaxRate, 15);
  assert.equal(stawka.foreignTaxAmount, undefined);
  // Ponowny import do tego samego rachunku jest wykrywany po ID.
  assert.deepEqual(wynik.items?.map(({ id }) => id), ['div-1', 'div-2']);
});

test('pełny cykl eksport-import: opłata (FEE) nie jest pomijana, także bez symbolu i bez liczby sztuk', () => {
  const oplata = transakcja({
    id: 'fee-1', ticker: '', name: '', type: 'FEE', date: '2026-07-01', quantity: 1, pricePerUnit: 5, commission: 0, currency: 'PLN',
    commissionCurrency: 'PLN',
  });
  const oplataProwizja = transakcja({
    id: 'fee-2', ticker: 'XYZ', name: 'XYZ', type: 'FEE', date: '2026-07-02', quantity: 0, pricePerUnit: 0, commission: 2.5,
    currency: 'USD', commissionCurrency: 'USD',
  });
  const csv = zbudujCsvTransakcji([oplata, oplataProwizja], [rachunek]).replace(/^\uFEFF/, '');
  const wynik = parsujTransakcjeCsv(csv, 'k1', [rachunek], 'eksport.csv');
  assert.deepEqual(wynik.pominiete, []);
  assert.equal(wynik.blad, '');
  const [fee, feeProwizja] = wynik.items ?? [];
  assert.equal(fee.type, 'FEE');
  assert.equal(fee.pricePerUnit, 5);
  assert.equal(fee.currency, 'PLN');
  assert.equal(feeProwizja.type, 'FEE');
  assert.equal(feeProwizja.commission, 2.5);
  assert.equal(feeProwizja.currency, 'USD');
  assert.deepEqual(wynik.items?.map(({ id }) => id), ['fee-1', 'fee-2']);
});

test('opłata bez kwoty (ani ceny, ani prowizji) jest pomijana z powodem', () => {
  const csv = 'Date;Symbol;Type;Quantity;Price;Currency\n2026-07-01;;Fee;0;0;PLN\n';
  const wynik = parsujTransakcjeCsv(csv, 'k1', [rachunek], 'obcy.csv');
  assert.equal(wynik.items?.length, 0);
  assert.match(wynik.pominiete?.[0].powod ?? '', /brak kwoty opłaty/);
});

test('import rozpoznaje kolumny WHT także w cudzych plikach, gdy nagłówek pasuje', () => {
  const csv = 'Date;Symbol;Type;Quantity;Price;Currency;Withholding tax rate (%);Withholding tax amount\n2026-06-01;XYZ;Dividend;1;10;USD;15;1,44\n';
  const [d] = parsujTransakcjeCsv(csv, 'k1', [rachunek], 'obcy.csv').items ?? [];
  assert.equal(d?.foreignTaxRate, 15);
  assert.equal(d?.foreignTaxAmount, 1.44);
});

test('plik bez nagłówka: pierwszy wiersz danych też jest importowany', () => {
  const csv = '2026-03-04;AAPL;Kupno;10;150;USD\n2026-03-05;AAPL;Sprzedaż;4;155;USD\n';
  const wynik = parsujTransakcjeCsv(csv, 'k1', [rachunek], 'bez-naglowka.csv');
  assert.deepEqual(wynik.pominiete, []);
  assert.equal(wynik.items?.length, 2);
  assert.deepEqual(wynik.items?.map((t) => [t.date, t.ticker, t.type, t.quantity, t.pricePerUnit]), [
    ['2026-03-04', 'AAPL', 'BUY', 10, 150],
    ['2026-03-05', 'AAPL', 'SELL', 4, 155],
  ]);
});

test('eksport własny zachowuje czas transakcji, który rozstrzyga kolejność partii FIFO', () => {
  const csv = zbudujCsvTransakcji([
    transakcja({ id: 'zakup-wczesniej', date: '2026-01-02T09:15:00' }),
    transakcja({ id: 'zakup-pozniej', date: '2026-01-02T14:45:00' }),
  ], [rachunek]).replace(/^\uFEFF/, '');
  const wynik = parsujTransakcjeCsv(csv, 'k1', [rachunek], 'eksport.csv');
  assert.deepEqual(wynik.items?.map(({ date }) => date), ['2026-01-02T09:15:00', '2026-01-02T14:45:00']);
});

test('import własnego eksportu zachowuje notatkę użytkownika i dopisuje nazwę pliku', () => {
  const csv = zbudujCsvTransakcji([transakcja({ notes: 'powód zakupu' })], [rachunek]).replace(/^\uFEFF/, '');
  const wynik = parsujTransakcjeCsv(csv, 'k1', [rachunek], 'eksport.csv');
  assert.equal(wynik.items?.[0].notes, 'powód zakupu\nZaimportowano z pliku: eksport.csv');
});

test('błąd ostatnio wybranego pliku blokuje zatwierdzenie wcześniejszego podglądu', () => {
  assert.equal(czyMoznaZatwierdzicImport(2, 'Plik jest pusty lub nie zawiera wierszy danych.', 0, false), false);
});

test('wybór pustego pliku po poprawnym pliku czyści podgląd i nie importuje starych transakcji', () => {
  const poprzedniCzytnik = globalThis.FileReader;
  const poprzedniDispatcher = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H;
  const stany: unknown[] = [];
  let indeksStanu = 0;
  const zawartosc = new Map([['poprawny.csv', 'Date;Symbol;Type;Quantity;Price;Currency\n2026-03-04;AAPL;Buy;1;150;USD\n'], ['pusty.csv', '']]);
  class CzytnikPlikuTestowego {
    onload: ((event: { target: { result: ArrayBuffer } }) => void) | null = null;
    readAsArrayBuffer(file: { name: string }) {
      const bytes = new TextEncoder().encode(zawartosc.get(file.name) ?? '');
      this.onload?.({ target: { result: bytes.buffer as ArrayBuffer } });
    }
  }
  (globalThis as any).FileReader = CzytnikPlikuTestowego;
  (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = {
    // Efekty (np. zamykanie okna Escape) nie dzialaja w renderze bez DOM.
    useEffect() {},
    useState(poczatkowa: unknown) {
      const index = indeksStanu++;
      if (!(index in stany)) stany[index] = typeof poczatkowa === 'function' ? (poczatkowa as () => unknown)() : poczatkowa;
      return [stany[index], (wartosc: unknown) => {
        stany[index] = typeof wartosc === 'function' ? (wartosc as (poprzednia: unknown) => unknown)(stany[index]) : wartosc;
      }];
    },
    useRef(poczatkowa: unknown) {
      const index = indeksStanu++;
      if (!(index in stany)) stany[index] = { current: poczatkowa };
      return stany[index];
    },
  };
  let importowane: Transaction[] | undefined;
  const render = () => {
    indeksStanu = 0;
    return ImportTransactionsModal({ accounts: [rachunek], language: 'pl', onImport: (items) => { importowane = items; }, onClose: () => {} });
  };
  const znajdz = (drzewo: any, predykat: (element: any) => boolean): any[] => {
    if (Array.isArray(drzewo)) return drzewo.flatMap((element) => znajdz(element, predykat));
    if (!drzewo || typeof drzewo !== 'object' || !('props' in drzewo)) return [];
    return [...(predykat(drzewo) ? [drzewo] : []), ...znajdz(drzewo.props.children, predykat)];
  };
  const wybierzPlik = (nazwa: string) => {
    const input = znajdz(render(), (element) => element.type === 'input' && element.props.type === 'file')[0];
    input.props.onChange({ target: { files: [{ name: nazwa }] } });
  };

  try {
    wybierzPlik('poprawny.csv');
    const przycisk = () => znajdz(render(), (element) => element.type === 'button').at(-1);
    assert.equal(przycisk().props.disabled, false);
    wybierzPlik('pusty.csv');
    assert.equal(przycisk().props.disabled, true);
    przycisk().props.onClick();
    assert.equal(importowane, undefined);
  } finally {
    (globalThis as any).FileReader = poprzedniCzytnik;
    (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = poprzedniDispatcher;
  }
});

test('późny odczyt starszego pliku nie zastępuje wyniku nowszego pliku', () => {
  const poprzedniCzytnik = globalThis.FileReader;
  const poprzedniDispatcher = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H;
  const stany: unknown[] = [];
  let indeksStanu = 0;
  const czytniki: any[] = [];
  class CzytnikOdroczony {
    onload: ((event: { target: { result: ArrayBuffer } }) => void) | null = null;
    nazwa = '';
    constructor() { czytniki.push(this); }
    readAsArrayBuffer(file: { name: string }) { this.nazwa = file.name; }
    zakoncz(tekst: string) {
      const bytes = new TextEncoder().encode(tekst);
      this.onload?.({ target: { result: bytes.buffer as ArrayBuffer } });
    }
  }
  (globalThis as any).FileReader = CzytnikOdroczony;
  (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = {
    // Efekty (np. zamykanie okna Escape) nie dzialaja w renderze bez DOM.
    useEffect() {},
    useState(poczatkowa: unknown) {
      const index = indeksStanu++;
      if (!(index in stany)) stany[index] = poczatkowa;
      return [stany[index], (wartosc: unknown) => {
        stany[index] = typeof wartosc === 'function' ? (wartosc as (poprzednia: unknown) => unknown)(stany[index]) : wartosc;
      }];
    },
    useRef(poczatkowa: unknown) {
      const index = indeksStanu++;
      if (!(index in stany)) stany[index] = { current: poczatkowa };
      return stany[index];
    },
  };
  let importowane: Transaction[] | undefined;
  const render = () => {
    indeksStanu = 0;
    return ImportTransactionsModal({ accounts: [rachunek], language: 'pl', onImport: (items) => { importowane = items; }, onClose: () => {} });
  };
  const znajdz = (drzewo: any, predykat: (element: any) => boolean): any[] => {
    if (Array.isArray(drzewo)) return drzewo.flatMap((element) => znajdz(element, predykat));
    if (!drzewo || typeof drzewo !== 'object' || !('props' in drzewo)) return [];
    return [...(predykat(drzewo) ? [drzewo] : []), ...znajdz(drzewo.props.children, predykat)];
  };
  const wybierzPlik = (nazwa: string) => {
    const input = znajdz(render(), (element) => element.type === 'input' && element.props.type === 'file')[0];
    input.props.onChange({ target: { files: [{ name: nazwa }] } });
  };
  const zatwierdz = () => znajdz(render(), (element) => element.type === 'button').at(-1);

  try {
    wybierzPlik('starszy.csv');
    wybierzPlik('nowszy.csv');
    const nowyCzytnik = czytniki.find((czytnik) => czytnik.nazwa === 'nowszy.csv');
    const staryCzytnik = czytniki.find((czytnik) => czytnik.nazwa === 'starszy.csv');
    nowyCzytnik.zakoncz('');
    staryCzytnik.zakoncz('Date;Symbol;Type;Quantity;Price;Currency\n2026-03-04;AAPL;Buy;1;150;USD\n');
    assert.equal(zatwierdz().props.disabled, true);
    zatwierdz().props.onClick();
    assert.equal(importowane, undefined);
  } finally {
    (globalThis as any).FileReader = poprzedniCzytnik;
    (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = poprzedniDispatcher;
  }
});

test('odczyt Freedom24 używa rachunku wybranego przed zakończeniem FileReader', () => {
  const poprzedniCzytnik = globalThis.FileReader;
  const poprzedniDispatcher = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H;
  const stany: unknown[] = [];
  let indeksStanu = 0;
  let czytnik: any;
  class CzytnikOdroczony {
    onload: ((event: { target: { result: ArrayBuffer } }) => void) | null = null;
    constructor() { czytnik = this; }
    readAsArrayBuffer(_file: { name: string }) {}
    zakoncz(tekst: string) {
      const bytes = new TextEncoder().encode(tekst);
      this.onload?.({ target: { result: bytes.buffer as ArrayBuffer } });
    }
  }
  const rachunekB = { ...rachunek, id: 'k2', name: 'Drugi rachunek' };
  (globalThis as any).FileReader = CzytnikOdroczony;
  (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = {
    // Efekty (np. zamykanie okna Escape) nie dzialaja w renderze bez DOM.
    useEffect() {},
    useState(poczatkowa: unknown) {
      const index = indeksStanu++;
      if (!(index in stany)) stany[index] = poczatkowa;
      return [stany[index], (wartosc: unknown) => {
        stany[index] = typeof wartosc === 'function' ? (wartosc as (poprzednia: unknown) => unknown)(stany[index]) : wartosc;
      }];
    },
    useRef(poczatkowa: unknown) {
      const index = indeksStanu++;
      if (!(index in stany)) stany[index] = { current: poczatkowa };
      return stany[index];
    },
  };
  let importowane: Transaction[] | undefined;
  const render = () => {
    indeksStanu = 0;
    return ImportTransactionsModal({ accounts: [rachunek, rachunekB], language: 'pl', onImport: (items) => { importowane = items; }, onClose: () => {} });
  };
  const znajdz = (drzewo: any, predykat: (element: any) => boolean): any[] => {
    if (Array.isArray(drzewo)) return drzewo.flatMap((element) => znajdz(element, predykat));
    if (!drzewo || typeof drzewo !== 'object' || !('props' in drzewo)) return [];
    return [...(predykat(drzewo) ? [drzewo] : []), ...znajdz(drzewo.props.children, predykat)];
  };

  try {
    const input = () => znajdz(render(), (element) => element.type === 'input' && element.props.type === 'file')[0];
    input().props.onChange({ target: { files: [{ name: 'f24.csv' }] } });
    const rachunekPicker = () => znajdz(render(), (element) => element.type === 'select')[0];
    rachunekPicker().props.onChange({ target: { value: 'k2' } });
    czytnik.zakoncz('Date;Symbol;Type;Quantity;Price;Currency\n2026-03-04;ABC.US;Buy;1;10;USD\n');
    const zatwierdz = () => znajdz(render(), (element) => element.type === 'button').at(-1);
    assert.equal(zatwierdz().props.disabled, false);
    zatwierdz().props.onClick();
    assert.equal(importowane?.[0].accountId, 'k2');
  } finally {
    (globalThis as any).FileReader = poprzedniCzytnik;
    (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = poprzedniDispatcher;
  }
});

test('plik bez nagłówka, symbol na początku: pierwszy wiersz danych nie znika', () => {
  const csv = 'AAPL;Apple;Kupno;2026-03-04;10;150;USD\nMSFT;Microsoft;Kupno;2026-03-05;2;300;USD\n';
  const wynik = parsujTransakcjeCsv(csv, 'k1', [rachunek], 'bez-naglowka.csv');
  assert.deepEqual(wynik.items?.map((t) => [t.ticker, t.quantity, t.pricePerUnit]), [['AAPL', 10, 150], ['MSFT', 2, 300]]);
});

test('plik z nierozpoznanym nagłówkiem (Wartość zamiast ceny) jest odrzucony, nie zgadywany', () => {
  const csv = 'Data;Symbol;Typ;Ilość;Wartość;Waluta\n2026-03-04;AAPL;Kupno;10;1500;USD\n';
  const wynik = parsujTransakcjeCsv(csv, 'k1', [rachunek], 'wartosc.csv');
  assert.deepEqual(wynik.items, []);
  assert.match(wynik.blad, /nie rozpoznano kolumn: cena/i);
});

test('plik z nagłówkiem bez rozpoznanej ilości i ceny wskazuje brakujące kolumny', () => {
  const csv = 'Data;Symbol;Typ;Liczba;Kurs zakupu;Waluta\n2026-03-04;AAPL;Kupno;10;150;USD\n';
  const wynik = parsujTransakcjeCsv(csv, 'k1', [rachunek], 'liczba.csv');
  assert.deepEqual(wynik.items, []);
  assert.match(wynik.blad, /nie rozpoznano kolumn: ilość/i);
});

test('nazwa pliku w notatce importu pochodzi z wybranego pliku, nie ze stanu sprzed wyboru', () => {
  const csv = 'Date;Symbol;Type;Quantity;Price;Currency\n2026-03-04;AAPL;Buy;10;150;USD\n';
  const { wynik } = odczytPlikuImportu(new TextEncoder().encode(csv), 'nowy-plik.csv', 'k1', [rachunek]);
  assert.equal(wynik.items?.[0].notes, 'Zaimportowano z pliku: nowy-plik.csv');
});
