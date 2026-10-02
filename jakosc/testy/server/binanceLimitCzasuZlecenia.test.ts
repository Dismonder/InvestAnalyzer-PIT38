/**
 * POST zlecenia Binance bez limitu czasu wisial w nieskonczonosc, a rezerwacja
 * pary blokowala kolejne zlecenia (409). Po przekroczeniu limitu wynik jest
 * niepewny (PENDING) - tak jak przy bledzie sieci - i nie ma automatycznego ponowienia.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

import brokersRouter from '../../../aplikacje/web/src/server/routes/brokers.ts';

test('zlecenie Binance wiszace ponad limit czasu konczy sie wynikiem PENDING z identyfikatorem', { timeout: 10_000 }, async () => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  let wywolaniaZlecenia = 0;
  let sygnal: AbortSignal | undefined;
  // Skracamy limit produkcyjny (15 s), zeby test nie czekal.
  AbortSignal.timeout = () => originalTimeout.call(AbortSignal, 30);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const adres = String(input);
    if (adres.includes('/api/v3/exchangeInfo?')) {
      return new Response(JSON.stringify({ symbols: [{ filters: [
        { filterType: 'PRICE_FILTER', tickSize: '0.01' },
        { filterType: 'LOT_SIZE', stepSize: '0.001' },
      ] }] }), { status: 200 });
    }
    if (adres.startsWith('https://api.binance.com/')) {
      wywolaniaZlecenia += 1;
      sygnal = init?.signal ?? undefined;
      return new Promise<Response>((_, odrzuc) => {
        init?.signal?.addEventListener('abort', () => odrzuc(init.signal!.reason));
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  const app = express();
  app.use(express.json());
  app.use('/api/brokers', brokersRouter);
  const serwer = app.listen(0);
  await new Promise<void>((gotowe) => serwer.once('listening', () => gotowe()));
  try {
    const adres = `http://127.0.0.1:${(serwer.address() as AddressInfo).port}`;
    const odpowiedz = await fetch(`${adres}/api/brokers/orders/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ticker: 'NVDA', action: 'SELL', orderType: 'STOP_LOSS', quantity: 10, stopPrice: 100, currency: 'USD',
        brokerType: 'BINANCE', apiKey: 'limit-czasu-key', apiSecret: 'secret', confirm: true, newClientOrderId: 'limit-czasu-1',
      }),
    });
    const tresc = (await odpowiedz.json()) as Record<string, unknown>;
    assert.ok(sygnal, 'POST zlecenia musi miec AbortSignal');
    assert.equal(odpowiedz.status, 502);
    assert.equal(tresc.status, 'PENDING');
    assert.equal(tresc.ambiguous, true);
    assert.equal(tresc.clientOrderId, 'limit-czasu-1');
    assert.match(String(tresc.message), /sprawdź listę zleceń/);
    assert.equal(wywolaniaZlecenia, 1, 'bez automatycznego ponowienia');
  } finally {
    await new Promise<void>((gotowe) => serwer.close(() => gotowe()));
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
  }
});
