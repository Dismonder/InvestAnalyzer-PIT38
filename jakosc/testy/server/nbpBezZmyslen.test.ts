/**
 * Kurs NBP przelicza cala deklaracje - zmyslony kurs to zmyslony podatek.
 *
 * Trasa /api/nbp/table-a po nieudanym zapytaniu oddawala `success: true`
 * z jedenastoma kursami wpisanymi w kod, numerem tabeli "157/A/NBP/2026"
 * i data 2026-08-14, pod biezacym znacznikiem czasu. Ta sama wartosc
 * zastepcza, ktora usunieto juz z fetchOfficialNBPRate, stala w drugiej
 * trasie tego samego pliku.
 *
 * Druga rzecz: blad sieci przy odczycie kursu na wlasciwy dzien byl polykany,
 * a funkcja po cichu cofala sie o dzien i oddawala kurs z innej daty niz
 * wymaga art. 11a ust. 2.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

import nbpRouter, { fetchOfficialNBPRate } from '../../../aplikacje/web/src/server/routes/nbp.ts';

async function zSerwerem<T>(uzyj: (adres: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.json());
  app.use('/api/nbp', nbpRouter);
  const serwer = app.listen(0);
  await new Promise<void>((gotowe) => serwer.once('listening', () => gotowe()));
  const port = (serwer.address() as AddressInfo).port;
  try {
    return await uzyj(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((gotowe) => serwer.close(() => gotowe()));
  }
}

function bezNbp<T>(cialo: () => Promise<T>): Promise<T> {
  const oryginalny = globalThis.fetch;
  globalThis.fetch = (async (wejscie: any, opcje: any) => {
    if (String(wejscie).includes('api.nbp.pl')) {
      throw new TypeError('fetch failed');
    }
    return oryginalny(wejscie, opcje);
  }) as typeof fetch;
  return cialo().finally(() => {
    globalThis.fetch = oryginalny;
  });
}

test('tabela NBP niedostepna to blad, a nie kursy wpisane w kod', async () => {
  await bezNbp(async () => {
    await zSerwerem(async (adres) => {
      const odpowiedz = await fetch(`${adres}/api/nbp/table-a?date=2024-05-10`);
      const tresc = (await odpowiedz.json()) as Record<string, unknown>;

      assert.equal(odpowiedz.status, 502);
      assert.equal(tresc.success, false);
      assert.equal(tresc.errorCode, 'NBP_TABLE_UNAVAILABLE');
      assert.ok(!('rates' in tresc), 'brak tabeli to brak kursow');
      assert.ok(!JSON.stringify(tresc).includes('3.73'), 'kurs USD 3,7300 byl wpisany w kod');
      assert.ok(!JSON.stringify(tresc).includes('157/A/NBP'), 'numer tabeli byl zmyslony');
    });
  });
});

test('blad sieci nie daje kursu z innego dnia', async () => {
  // Mock zawodzi TYLKO na dniu wymaganym przez art. 11a ust. 2, a dla kazdego
  // wczesniejszego oddaje poprawny kurs. Gdyby kod cofal sie po bledzie sieci,
  // dostalby 3.9999 i test by tego nie przepuscil. Mock zawodzacy wszedzie
  // przechodzilby takze przy zlym zachowaniu.
  const oryginalny = globalThis.fetch;
  const dzienWymagany = '2024-05-09'; // ostatni dzien roboczy przed 2024-05-10
  globalThis.fetch = (async (wejscie: any, opcje: any) => {
    const adres = String(wejscie);
    if (!adres.includes('api.nbp.pl')) return oryginalny(wejscie, opcje);
    if (adres.includes(dzienWymagany)) {
      throw new TypeError('fetch failed');
    }
    return new Response(
      JSON.stringify({
        table: 'A',
        rates: [{ no: '999/A/NBP/2024', effectiveDate: '2024-05-08', mid: 3.9999 }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as typeof fetch;

  try {
    let kurs: unknown = null;
    let blad: Error | null = null;
    try {
      kurs = await fetchOfficialNBPRate('USD', '2024-05-10');
    } catch (e) {
      blad = e as Error;
    }

    assert.equal(kurs, null, `kurs z innego dnia nie moze wrocic: ${JSON.stringify(kurs)}`);
    assert.ok(blad, 'brak kursu na wymagany dzien to blad, nie kurs z dnia wczesniejszego');
    assert.match(blad!.message, /nie zostal podstawiony z innego dnia|Nie udalo sie pobrac/i);
  } finally {
    globalThis.fetch = oryginalny;
  }
});

test('PLN nie wymaga zapytania do NBP i ma kurs 1', async () => {
  const wynik = await fetchOfficialNBPRate('PLN', '2024-05-10');
  assert.equal(wynik.mid, 1.0);
  assert.equal(wynik.code, 'PLN');
});

test('trasa kursu odrzuca brak waluty albo daty bez zapytania do NBP', async () => {
  await bezNbp(async () => zSerwerem(async (adres) => {
    for (const query of ['', '?currency=USD', '?date=2024-05-10', '?currency=&date=2024-05-10']) {
      const odpowiedz = await fetch(`${adres}/api/nbp/rate${query}`);
      const tresc = (await odpowiedz.json()) as Record<string, unknown>;
      assert.equal(odpowiedz.status, 400);
      assert.equal(tresc.success, false);
      assert.match(String(tresc.error), /walutę.*datę/);
    }
  }));
});
