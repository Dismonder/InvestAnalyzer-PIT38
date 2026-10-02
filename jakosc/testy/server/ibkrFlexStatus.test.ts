/**
 * IBKR Flex: GetStatement bez sprawdzenia HTTP i statusu XML uznawal odpowiedz
 * "Statement generation in progress" (Status Warn, kod 1019) za pusty raport
 * i zwracal success:true z pusta lista transakcji.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { syncIBKRTrades } from '../../../aplikacje/web/src/server/routes/brokers.ts';

const ZAPYTANIE_OK =
  '<FlexStatementResponse><Status>Success</Status><ReferenceCode>111</ReferenceCode></FlexStatementResponse>';
const W_TOKU =
  '<FlexStatementResponse><Status>Warn</Status><ErrorCode>1019</ErrorCode><ErrorMessage>Statement generation in progress. Please try again shortly.</ErrorMessage></FlexStatementResponse>';
const RAPORT =
  '<FlexQueryResponse><Trade symbol="MSFT" quantity="5" tradePrice="400" currency="USD" buySell="BUY" dateTime="20240311;101500" /></FlexQueryResponse>';

async function zAtrapa(
  odpowiedziRaportu: Array<() => Response>,
  cialo: (opoznienia: number[], zapytaniaRaportu: () => number) => Promise<void>
) {
  const oryginalny = globalThis.fetch;
  let zapytania = 0;
  const opoznienia: number[] = [];
  globalThis.fetch = (async (wejscie: any) => {
    const adres = String(wejscie);
    if (adres.includes('SendRequest')) return new Response(ZAPYTANIE_OK);
    if (adres.includes('GetStatement')) {
      const odpowiedz = odpowiedziRaportu[Math.min(zapytania, odpowiedziRaportu.length - 1)];
      zapytania += 1;
      return odpowiedz();
    }
    throw new Error(`nieoczekiwane zapytanie: ${adres.slice(0, 60)}`);
  }) as typeof fetch;
  try {
    await cialo(opoznienia, () => zapytania);
  } finally {
    globalThis.fetch = oryginalny;
  }
}

const dane = { accountId: 'a1', apiKey: 't', queryId: 'q' } as any;

test('raport IBKR w toku jest ponawiany i ostatecznie zwraca transakcje', async () => {
  await zAtrapa([() => new Response(W_TOKU), () => new Response(W_TOKU), () => new Response(RAPORT)], async (opoznienia, zapytania) => {
    const wynik: any = await syncIBKRTrades(dane, async (ms) => { opoznienia.push(ms); });
    assert.equal(wynik.success, true);
    assert.equal(wynik.syncedTransactions.length, 1);
    assert.equal(zapytania(), 3);
    assert.deepEqual(opoznienia, [1500, 2000, 2000]);
  });
});

test('raport IBKR wciąż w toku po 5 próbach to porażka, a nie pusty sukces', async () => {
  await zAtrapa([() => new Response(W_TOKU)], async (_opoznienia, zapytania) => {
    const wynik: any = await syncIBKRTrades(dane, async () => {});
    assert.equal(wynik.success, false);
    assert.match(String(wynik.message), /nadal jest generowany/);
    assert.equal(zapytania(), 5);
  });
});

test('kod 1018 (za dużo zapytań) nie jest ponawiany jak raport w toku', async () => {
  const zaDuzo =
    '<FlexStatementResponse><Status>Warn</Status><ErrorCode>1018</ErrorCode><ErrorMessage>Too many requests have been made from this token. Please try again shortly.</ErrorMessage></FlexStatementResponse>';
  await zAtrapa([() => new Response(zaDuzo)], async (_opoznienia, zapytania) => {
    const wynik: any = await syncIBKRTrades(dane, async () => {});
    assert.equal(wynik.success, false);
    assert.match(String(wynik.message), /1018/);
    assert.match(String(wynik.message), /za dużo zapytań/i);
    assert.equal(zapytania(), 1, 'ponowienie tylko pogłębiłoby limit zapytań');
  });
});

test('zapytania do Flex mają limit czasu (AbortSignal) i przekroczenie daje porażkę z komunikatem', async () => {
  const oryginalny = globalThis.fetch;
  const oryginalnyTimeout = AbortSignal.timeout;
  const sygnaly: Array<AbortSignal | undefined> = [];
  AbortSignal.timeout = () => oryginalnyTimeout.call(AbortSignal, 20);
  globalThis.fetch = (async (wejscie: any, init?: RequestInit) => {
    const adres = String(wejscie);
    sygnaly.push(init?.signal ?? undefined);
    if (adres.includes('SendRequest')) return new Response(ZAPYTANIE_OK);
    return new Promise<Response>((_, odrzuc) => {
      init?.signal?.addEventListener('abort', () => odrzuc(init.signal!.reason));
    });
  }) as typeof fetch;
  try {
    const wynik: any = await syncIBKRTrades(dane, async () => {});
    assert.ok(sygnaly.length === 2 && sygnaly.every(Boolean), 'oba zapytania z sygnałem');
    assert.equal(wynik.success, false);
    assert.match(String(wynik.message), /nie odpowiedział/);
  } finally {
    globalThis.fetch = oryginalny;
    AbortSignal.timeout = oryginalnyTimeout;
  }
});

test('błąd HTTP i status Fail z Flex są porażką z komunikatem', async () => {
  await zAtrapa([() => new Response('Bad gateway', { status: 502 })], async () => {
    const wynik: any = await syncIBKRTrades(dane, async () => {});
    assert.equal(wynik.success, false);
    assert.match(String(wynik.message), /HTTP 502/);
  });
  const blad = '<FlexStatementResponse><Status>Fail</Status><ErrorCode>1015</ErrorCode><ErrorMessage>Token is invalid.</ErrorMessage></FlexStatementResponse>';
  await zAtrapa([() => new Response(blad)], async (_o, zapytania) => {
    const wynik: any = await syncIBKRTrades(dane, async () => {});
    assert.equal(wynik.success, false);
    assert.match(String(wynik.message), /1015.*Token is invalid/);
    assert.equal(zapytania(), 1, 'błąd inny niż "w toku" nie jest ponawiany');
  });
});
