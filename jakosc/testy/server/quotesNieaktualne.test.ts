/**
 * Przy awarii dostawcy /api/quotes podstawial stara cene z zapasu jako
 * biezace notowanie (success:true, REAL_LIVE_FEED). Teraz pozycja jest oznaczona
 * (stale + fetchedAt), a odpowiedz zbiorcza mowi, ze wszystkie ceny sa stare.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

import quotesRouter, { cacheQuote, quoteCache, ostatnieDobreNotowania, STALE_QUOTE_MAX_AGE_MS } from '../../../aplikacje/web/src/server/routes/quotes.ts';

async function pobierz(tickers: string, sciezka = (t: string) => `/api/quotes?tickers=${t}&force=true`): Promise<any> {
  const oryginalny = globalThis.fetch;
  const oryginalnyLog = console.error;
  console.error = () => undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('127.0.0.1')) return oryginalny(input, init);
    throw new Error('dostawca niedostepny');
  }) as typeof fetch;
  const app = express();
  app.use('/api', quotesRouter);
  const serwer = app.listen(0, '127.0.0.1');
  await new Promise<void>((gotowe) => serwer.once('listening', () => gotowe()));
  try {
    const adres = `http://127.0.0.1:${(serwer.address() as AddressInfo).port}`;
    const odpowiedz = await fetch(`${adres}${sciezka(tickers)}`);
    return { status: odpowiedz.status, ...(await odpowiedz.json()) };
  } finally {
    await new Promise<void>((gotowe) => serwer.close(() => gotowe()));
    globalThis.fetch = oryginalny;
    console.error = oryginalnyLog;
  }
}

const cena = (ticker: string) => ({ ticker, price: 123.45, currency: 'USD', lastUpdated: '2020-01-01T00:00:00.000Z' });

test('awaria dostawcy: cena z zapasu jest oznaczona jako nieaktualna i nie udaje odczytu na zywo', async () => {
  const pobranoO = Date.now() - 60_000;
  cacheQuote('STALEAAA', cena('STALEAAA'), pobranoO);
  try {
    const wynik = await pobierz('STALEAAA');
    assert.equal(wynik.quotes.STALEAAA.price, 123.45);
    assert.equal(wynik.quotes.STALEAAA.stale, true);
    assert.equal(wynik.quotes.STALEAAA.fetchedAt, new Date(pobranoO).toISOString());
    assert.deepEqual(wynik.staleTickers, ['STALEAAA']);
    assert.equal(wynik.allStale, true);
    assert.notEqual(wynik.source, 'REAL_LIVE_FEED');
  } finally { quoteCache.delete('STALEAAA'); }
});

test('zapas ceny przezywa kolejne cykle awarii mimo czyszczenia cache po TTL', async () => {
  cacheQuote('STALEDDD', cena('STALEDDD'), Date.now() - 60_000);
  try {
    const cykl1 = await pobierz('STALEDDD');
    assert.equal(cykl1.quotes.STALEDDD.stale, true);
    // Zapis innego tickera czysci z quoteCache wpisy starsze niz TTL.
    cacheQuote('STALEINNY', cena('STALEINNY'));
    assert.equal(quoteCache.has('STALEDDD'), false, 'warunek testu: wpis wypadl z cache TTL');
    const cykl2 = await pobierz('STALEDDD');
    assert.equal(cykl2.quotes.STALEDDD?.stale, true, 'drugi cykl awarii nadal ma zapas');
    assert.equal(cykl2.quotes.STALEDDD.price, 123.45);
  } finally {
    quoteCache.delete('STALEDDD'); quoteCache.delete('STALEINNY');
    ostatnieDobreNotowania.delete('STALEDDD'); ostatnieDobreNotowania.delete('STALEINNY');
  }
});

test('magazyn ostatnich dobrych cen ma limit rozmiaru', () => {
  for (let i = 0; i < 600; i++) cacheQuote(`LIMITZ${i}`, cena(`LIMITZ${i}`));
  try {
    assert.ok(ostatnieDobreNotowania.size <= 500, `rozmiar: ${ostatnieDobreNotowania.size}`);
  } finally {
    for (let i = 0; i < 600; i++) { quoteCache.delete(`LIMITZ${i}`); ostatnieDobreNotowania.delete(`LIMITZ${i}`); }
  }
});

test('cena z zapasu starsza niz limit wieku nie jest podawana', async () => {
  cacheQuote('STALEBBB', cena('STALEBBB'), Date.now() - STALE_QUOTE_MAX_AGE_MS - 1_000);
  try {
    const wynik = await pobierz('STALEBBB');
    assert.equal(wynik.quotes.STALEBBB, undefined);
    assert.equal(wynik.allStale, false);
  } finally { quoteCache.delete('STALEBBB'); }
});

test('/api/quote/:ticker po bledzie dostawcy: cena z magazynu ostatnich dobrych, oznaczona i z limitem wieku', async () => {
  const pojedyncza = (t: string) => `/api/quote/${t}?force=true`;
  const pobranoO = Date.now() - 60_000;
  cacheQuote('STALEEEE', cena('STALEEEE'), pobranoO);
  cacheQuote('STALEFFF', cena('STALEFFF'), Date.now() - STALE_QUOTE_MAX_AGE_MS - 1_000);
  try {
    const swieza = await pobierz('STALEEEE', pojedyncza);
    assert.equal(swieza.success, true);
    assert.equal(swieza.quote.price, 123.45);
    assert.equal(swieza.quote.stale, true);
    assert.equal(swieza.quote.fetchedAt, new Date(pobranoO).toISOString());
    assert.equal(swieza.source, 'STALE_CACHE');
    // Zapas dziala tez po wyczyszczeniu cache TTL (drugi cykl awarii).
    cacheQuote('STALEINNY2', cena('STALEINNY2'));
    assert.equal(quoteCache.has('STALEEEE'), false);
    const drugi = await pobierz('STALEEEE', pojedyncza);
    assert.equal(drugi.quote?.stale, true);
    const zaStara = await pobierz('STALEFFF', pojedyncza);
    assert.equal(zaStara.status, 404, 'cena starsza niz limit wieku nie jest podawana');
  } finally {
    for (const t of ['STALEEEE', 'STALEFFF', 'STALEINNY2']) { quoteCache.delete(t); ostatnieDobreNotowania.delete(t); }
  }
});
