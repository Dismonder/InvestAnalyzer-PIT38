/**
 * Synchronizacja Freedom24: strona transakcji jest rozpoznawana jak w silniku
 * (determine_side), a pominiete wiersze trafiaja do ostrzezen. Dawniej SELL byl
 * tylko dla type '2'/'sell'/'SELL', a wszystko inne (takze oper:'sell' i nieznane
 * kody) stawalo sie kupnem; wiersze z ilosca lub cena NaN/0 znikaly bez slowa.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { syncFreedom24Trades } from '../../../aplikacje/web/src/server/routes/brokers.ts';

async function sync(trade: unknown[]): Promise<any> {
  const oryginalny = globalThis.fetch;
  const odpowiedzi: Record<string, unknown> = {
    getTradesHistory: { trades: { trade } },
    getPositionJson: { result: { ps: { pos: [] } } },
  };
  globalThis.fetch = (async (wejscie: any, opcje: any) => {
    const adres = String(wejscie);
    if (!/tradernet\.|freedom24\.com/.test(adres)) throw new Error(`nieoczekiwane zapytanie: ${adres.slice(0, 60)}`);
    const cialo = String(opcje?.body ?? '');
    const polecenie = Object.keys(odpowiedzi).find((k) => cialo.includes(`"cmd":"${k}"`) || adres.endsWith(`/cmd/${k}`));
    return new Response(JSON.stringify(polecenie ? odpowiedzi[polecenie] : { errMsg: 'nieznane' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    return await syncFreedom24Trades({ accountId: 'f9', apiKey: 'klucz', apiSecret: 'sekret' } as any);
  } finally {
    globalThis.fetch = oryginalny;
  }
}

const wiersz = (id: number, dodatkowe: Record<string, unknown>) => ({
  id, instr_nm: `T${id}.US`, q: '10', p: '100', curr_c: 'USD', trade_d_exch: '2024-06-12', ...dodatkowe,
});

test('strona transakcji: kody liczbowe i tekstowe z pol type, oper i operation', async () => {
  const wynik = await sync([
    wiersz(1, { type: '1' }),
    wiersz(2, { type: 2 }),
    wiersz(3, { oper: 'sell' }),
    wiersz(4, { oper: 'buy' }),
    wiersz(5, { operation: 'Sprzedaż' }),
    wiersz(6, { type: 'SELL' }),
    wiersz(7, { type: 'BUY' }),
  ]);
  const strony = Object.fromEntries(wynik.syncedTransactions.map((t: any) => [t.ticker, t.type]));
  assert.deepEqual(strony, { T1: 'BUY', T2: 'SELL', T3: 'SELL', T4: 'BUY', T5: 'SELL', T6: 'SELL', T7: 'BUY' });
});

test('nierozpoznana strona nie staje sie kupnem: wiersz jest pomijany z ostrzezeniem', async () => {
  const wynik = await sync([
    wiersz(1, { type: '9' }),
    wiersz(2, {}), // brak jakiegokolwiek pola strony
    wiersz(3, { type: '1', oper: 'sell' }), // sprzeczne pola
    wiersz(4, { type: '1' }),
  ]);
  assert.deepEqual(wynik.syncedTransactions.map((t: any) => t.ticker), ['T4']);
  const ostrzezenia = wynik.ostrzezenia.join(' ');
  for (const ticker of ['T1', 'T2', 'T3']) assert.match(ostrzezenia, new RegExp(ticker));
  assert.match(ostrzezenia, /strony/i);
});

test('wiersze z iloscia lub cena NaN/0 oraz bez symbolu trafiaja do ostrzezen', async () => {
  const wynik = await sync([
    wiersz(1, { type: '1', q: 'abc' }),
    wiersz(2, { type: '1', p: '0' }),
    { id: 3, q: '5', p: '10', curr_c: 'USD', type: '1', trade_d_exch: '2024-06-12' },
    wiersz(4, { type: '1' }),
  ]);
  assert.deepEqual(wynik.syncedTransactions.map((t: any) => t.ticker), ['T4']);
  const ostrzezenia = wynik.ostrzezenia.join(' ');
  assert.match(ostrzezenia, /T1/);
  assert.match(ostrzezenia, /T2/);
  assert.match(ostrzezenia, /bez symbolu/i);
});
