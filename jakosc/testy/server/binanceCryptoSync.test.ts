import test from 'node:test';
import assert from 'node:assert/strict';
import { syncBinanceTrades } from '../../../aplikacje/web/src/server/routes/brokers.ts';

const pairs = [
  ['BTCUSDT', 'BTC', 'USDT'], ['BTCPLN', 'BTC', 'PLN'],
  ['ETHBTC', 'ETH', 'BTC'], ['BTCUSDC', 'BTC', 'USDC'],
  ['BTCFDUSD', 'BTC', 'FDUSD'], ['PEPEUSDT', 'PEPE', 'USDT'], ['EURUSDT', 'EUR', 'USDT'],
];
const trade = (id: number) => ({
  id, orderId: id + 5000, isBuyer: false, time: Date.parse('2025-12-31T23:30:00Z'),
  qty: '1', price: '2', commission: '0.1', commissionAsset: 'BNB',
});
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

async function withFetch(
  trades: (symbol: string, fromId: number) => Response,
  run: (queries: URL[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  const queries: URL[] = [];
  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input));
    queries.push(url);
    if (url.pathname.endsWith('/account')) return json({ balances: [
      { asset: 'BTC', free: '1', locked: '0' },
      { asset: 'ETH', free: '1', locked: '0' },
      { asset: 'PEPE', free: '1', locked: '0' },
      { asset: 'EUR', free: '10', locked: '0' },
    ] });
    if (url.pathname.endsWith('/exchangeInfo')) return json({ symbols: pairs.map(([symbol, baseAsset, quoteAsset]) => ({ symbol, baseAsset, quoteAsset })) });
    if (url.pathname.endsWith('/myTrades')) return trades(url.searchParams.get('symbol')!, Number(url.searchParams.get('fromId')));
    throw new Error('nieoczekiwane zapytanie');
  }) as typeof fetch;
  try { await run(queries); } finally { globalThis.fetch = original; }
}

test('Binance zachowuje quoteAsset i date Warszawy oraz pobiera historie od pierwszej strony', async () => {
  await withFetch((symbol, fromId) => {
    if (symbol === 'BTCUSDT') {
      if (fromId === 0) return json(Array.from({ length: 1000 }, (_, id) => trade(id)));
      if (fromId === 1000) return json([trade(1000)]);
    }
    return json([symbol === 'EURUSDT'
      ? { ...trade(1), isBuyer: true, qty: '5', price: '0.5', quoteQty: '2.5' }
      : trade(1)]);
  }, async (queries) => {
    const result = await syncBinanceTrades({ accountId: 'test', apiKey: 'synthetic', apiSecret: 'synthetic' } as any);
    assert.equal(result.syncedTransactions.length, 1007);
    assert.deepEqual(result.completeSymbols, pairs.map(([symbol]) => symbol));
    assert.deepEqual(result.incompleteSymbols, [
      'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'ADAUSDT', 'DOTUSDT', 'XRPUSDT', 'AVAXUSDT',
      'MATICUSDT', 'LINKUSDT', 'LTCUSDT', 'NEARUSDT', 'SUIUSDT', 'DOGEUSDT', 'BTCEUR', 'ETHEUR', 'SOLEUR',
    ]);
    assert.equal(queries.filter((q) => q.pathname.endsWith('/exchangeInfo')).length, 1);
    const btcPages = queries.filter((q) => q.searchParams.get('symbol') === 'BTCUSDT');
    assert.deepEqual(btcPages.map((q) => q.searchParams.get('fromId')), ['0', '1000']);
    assert.ok(btcPages.every((q) => q.searchParams.get('limit') === '1000'));
    for (const [symbol, base, quote] of pairs) {
      const item = result.syncedTransactions.find((t: any) => t.notes.includes(`Para ${symbol})`));
      assert.equal(item?.ticker, base === 'EUR' ? quote : base);
      assert.equal(item?.currency, base === 'EUR' ? base : quote);
      if (base === 'EUR') {
        assert.equal(item?.type, 'SELL');
        assert.equal(item?.quantity, 2.5);
        // Kupno 5 EUR za 2,5 USDT = sprzedaz 2,5 USDT po 2 EUR (kwota 5 EUR, nie 2,5 × cena pary).
        assert.equal(item?.pricePerUnit, 2);
        assert.equal((item?.quantity ?? 0) * (item?.pricePerUnit ?? 0), 5);
      }
      assert.equal(item?.commissionCurrency, 'BNB');
      assert.equal(item?.date, '2026-01-01');
    }
    assert.match(result.ostrzezenia.join(' '), /aktywow juz calkiem sprzedanych/);
  });
});

test('przerwana druga strona nie jest raportowana jako pelna historia pary', async () => {
  await withFetch((symbol, fromId) => {
    if (symbol === 'BTCUSDT' && fromId === 0) return json(Array.from({ length: 1000 }, (_, id) => trade(id)));
    if (symbol === 'BTCUSDT' && fromId === 1000) return new Response('limit', { status: 429 });
    return json([]);
  }, async () => {
    const result = await syncBinanceTrades({ accountId: 'test', apiKey: 'synthetic', apiSecret: 'synthetic' } as any);
    assert.equal(result.syncedTransactions.length, 0);
    assert.ok(result.incompleteSymbols.includes('BTCUSDT'));
    assert.ok(result.completeSymbols.includes('ETHBTC'));
    assert.match(result.ostrzezenia.join(' '), /BTCUSDT \(HTTP 429\)/);
    assert.match(result.message, /nie byl pelny/);
  });
});
