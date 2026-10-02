/**
 * Zlecenia ochronne u brokera: potwierdzenie tylko wtedy, gdy jest prawdziwe.
 *
 * Trasa /orders/create konczyla kazda galaz odpowiedzia `success: true`
 * z numerem zlecenia zlozonym z biezacego czasu. XTB, IBKR i galaz domyslna
 * nie wysylaly przy tym zadnego zapytania, a Binance i Freedom24 raportowaly
 * sukces takze po wyjatku i po bledzie brokera. Uzytkownik widzial
 * "Uzbrojono Zlecenie Ochronne", a stop-loss nie istnial.
 *
 * /orders/cancel odpowiadala "pomyslnie anulowane" bez jednego zapytania.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

import brokersRouter from '../../../aplikacje/web/src/server/routes/brokers.ts';

async function zSerwerem<T>(uzyj: (adres: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.json());
  app.use('/api/brokers', brokersRouter);
  const serwer = app.listen(0);
  await new Promise<void>((gotowe) => serwer.once('listening', () => gotowe()));
  const port = (serwer.address() as AddressInfo).port;
  try {
    return await uzyj(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((gotowe) => serwer.close(() => gotowe()));
  }
}

async function wyslij(adres: string, sciezka: string, dane: unknown) {
  const odpowiedz = await fetch(`${adres}${sciezka}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dane),
  });
  return { status: odpowiedz.status, tresc: (await odpowiedz.json()) as Record<string, unknown> };
}

const ZLECENIE = {
  ticker: 'NVDA',
  action: 'SELL',
  orderType: 'STOP_LOSS',
  quantity: 10,
  stopPrice: 100,
  currency: 'USD',
};

test('niepoprawny symbol i wartości Binance kończą się 400 bez wywołania Binance', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith('https://api.binance.com/')) { calls++; throw new Error('unexpected fetch'); }
    return originalFetch(input, init);
  }) as typeof fetch;
  try {
    await zSerwerem(async (adres) => {
      const auth = { brokerType: 'BINANCE', apiKey: 'key', apiSecret: 'secret', confirm: true };
      for (const body of [
        { ...ZLECENIE, ticker: 'BTC&side=BUY' },
        { ...ZLECENIE, action: 'SELL&quantity=1' },
        { ...ZLECENIE, quantity: -1 },
        { ...ZLECENIE, stopPrice: 'Infinity' },
      ]) {
        assert.equal((await wyslij(adres, '/api/brokers/orders/create', { ...auth, ...body, newClientOrderId: 'bad-input' })).status, 400);
      }
      assert.equal((await wyslij(adres, '/api/brokers/orders/status', { ...auth, ticker: 'BTC&x=1', clientOrderId: 'id' })).status, 400);
      assert.equal((await wyslij(adres, '/api/brokers/orders/cancel', { ...auth, ticker: 'BTC&x=1', orderId: 123 })).status, 400);
      assert.equal(calls, 0);
    });
  } finally { globalThis.fetch = originalFetch; }
});

test('Binance używa tickSize i stepSize oraz zwraca wysłane wartości', async () => {
  const originalFetch = globalThis.fetch;
  let sent: URL | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/api/v3/exchangeInfo?')) return new Response(JSON.stringify({ symbols: [{ filters: [
      { filterType: 'PRICE_FILTER', tickSize: '0.000001' }, { filterType: 'LOT_SIZE', stepSize: '0.001' },
    ] }] }), { status: 200 });
    if (String(input).startsWith('https://api.binance.com/')) {
      sent = new URL(String(input));
      return new Response(JSON.stringify({ orderId: 991 }), { status: 200 });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  try {
    await zSerwerem(async (adres) => {
      const body = { ...ZLECENIE, ticker: 'TICK', quantity: 1.2345, stopPrice: 0.1111104, limitPrice: 0.1100004,
        brokerType: 'BINANCE', apiKey: 'tick-key', apiSecret: 'secret', confirm: true, newClientOrderId: 'tick-order' };
      const preview = await wyslij(adres, '/api/brokers/orders/preview', body);
      assert.equal(preview.tresc.stopPrice, '0.111111');
      const result = await wyslij(adres, '/api/brokers/orders/create', body);
      assert.equal(result.status, 200);
      assert.equal(result.tresc.quantity, '1.234');
      assert.equal(result.tresc.stopPrice, '0.111111');
      assert.equal(result.tresc.limitPrice, '0.110000');
      assert.equal(sent?.searchParams.get('quantity'), result.tresc.quantity);
      assert.equal(sent?.searchParams.get('stopPrice'), result.tresc.stopPrice);
      assert.equal(sent?.searchParams.get('price'), result.tresc.limitPrice);
    });
  } finally { globalThis.fetch = originalFetch; }
});

test('brak filtrów Binance blokuje zlecenie bez zgadywania kroku', async () => {
  const originalFetch = globalThis.fetch;
  let orderCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/api/v3/exchangeInfo?')) return new Response(JSON.stringify({ symbols: [{ filters: [] }] }), { status: 200 });
    if (String(input).startsWith('https://api.binance.com/')) { orderCalls++; throw new Error('unexpected order'); }
    return originalFetch(input, init);
  }) as typeof fetch;
  try {
    await zSerwerem(async (adres) => {
      const result = await wyslij(adres, '/api/brokers/orders/create', { ...ZLECENIE, ticker: 'NOFILTER',
        brokerType: 'BINANCE', apiKey: 'no-filter-key', apiSecret: 'secret', confirm: true, newClientOrderId: 'no-filter' });
      assert.equal(result.status, 503);
      assert.match(String(result.tresc.message), /filtrów/);
      assert.equal(orderCalls, 0);
    });
  } finally { globalThis.fetch = originalFetch; }
});

test('create i cancel bez confirm nie kontaktują się z brokerem', async () => {
  const originalFetch = globalThis.fetch;
  let brokerCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/api/v3/exchangeInfo?')) {
      return new Response(JSON.stringify({ symbols: [{ filters: [
        { filterType: 'PRICE_FILTER', tickSize: '0.01' },
        { filterType: 'LOT_SIZE', stepSize: '0.001' },
      ] }] }), { status: 200 });
    }
    if (String(input).startsWith('https://api.binance.com/')) {
      brokerCalls += 1;
      throw new Error('Nie wolno wywołać brokera');
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  try {
    await zSerwerem(async (adres) => {
      const auth = { brokerType: 'BINANCE', apiKey: 'test-key', apiSecret: 'test-secret' };
      const create = await wyslij(adres, '/api/brokers/orders/create', { ...ZLECENIE, ...auth, newClientOrderId: 'same-confirmation' });
      const cancel = await wyslij(adres, '/api/brokers/orders/cancel', { ...auth, orderId: '123', ticker: 'BTC' });
      assert.equal(create.status, 400);
      assert.equal(cancel.status, 400);
      assert.equal(brokerCalls, 0);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('ponowienie tego samego potwierdzenia Binance używa tego samego newClientOrderId', async () => {
  const originalFetch = globalThis.fetch;
  const ids: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/api/v3/exchangeInfo?')) {
      return new Response(JSON.stringify({ symbols: [{ filters: [
        { filterType: 'PRICE_FILTER', tickSize: '0.01' },
        { filterType: 'LOT_SIZE', stepSize: '0.001' },
      ] }] }), { status: 200 });
    }
    if (String(input).startsWith('https://api.binance.com/')) {
      ids.push(new URL(String(input)).searchParams.get('newClientOrderId') || '');
      return new Response(JSON.stringify(ids.length === 1 ? { orderId: 123, clientOrderId: ids[0] } : { msg: 'Duplicate order' }), { status: ids.length === 1 ? 200 : 400 });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  try {
    await zSerwerem(async (adres) => {
      const body = { ...ZLECENIE, brokerType: 'BINANCE', apiKey: 'test-key', apiSecret: 'test-secret', confirm: true, newClientOrderId: 'same-confirmation' };
      const first = await wyslij(adres, '/api/brokers/orders/create', body);
      const second = await wyslij(adres, '/api/brokers/orders/create', body);
      assert.equal(first.tresc.success, true);
      assert.equal(second.tresc.success, false);
      assert.equal(second.tresc.ambiguous, true);
      assert.deepEqual(ids, ['same-confirmation', 'same-confirmation']);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('równoległe zlecenia Binance dla tej samej pary odrzucają drugi identyfikator', async () => {
  const originalFetch = globalThis.fetch;
  let brokerCalls = 0;
  let odblokujPierwsze!: (response: Response) => void;
  let pierwszeWyslane!: () => void;
  const wyslane = new Promise<void>((resolve) => { pierwszeWyslane = resolve; });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/api/v3/exchangeInfo?')) {
      return new Response(JSON.stringify({ symbols: [{ filters: [
        { filterType: 'PRICE_FILTER', tickSize: '0.01' },
        { filterType: 'LOT_SIZE', stepSize: '0.001' },
      ] }] }), { status: 200 });
    }
    if (String(input).startsWith('https://api.binance.com/')) {
      brokerCalls += 1;
      pierwszeWyslane();
      return new Promise<Response>((resolve) => { odblokujPierwsze = resolve; });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  try {
    await zSerwerem(async (adres) => {
      const auth = { brokerType: 'BINANCE', apiKey: 'parallel-key', apiSecret: 'test-secret', confirm: true };
      const pierwszeZlecenie = wyslij(adres, '/api/brokers/orders/create', {
        ...ZLECENIE, ...auth, newClientOrderId: 'parallel-first',
      });
      await wyslane;
      const drugie = await wyslij(adres, '/api/brokers/orders/create', {
        ...ZLECENIE, ...auth, newClientOrderId: 'parallel-second',
      });
      assert.equal(drugie.status, 409);
      assert.equal(drugie.tresc.success, false);
      assert.equal(drugie.tresc.ambiguous, false);
      assert.equal(brokerCalls, 1);
      odblokujPierwsze(new Response(JSON.stringify({ orderId: 456, clientOrderId: 'parallel-first' }), { status: 200 }));
      assert.equal((await pierwszeZlecenie).tresc.success, true);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('timeout Binance po wysłaniu zwraca stan nieznany i zachowuje identyfikator przy ponowieniu', async () => {
  const originalFetch = globalThis.fetch;
  const ids: string[] = [];
  let brokerCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/api/v3/exchangeInfo?')) {
      return new Response(JSON.stringify({ symbols: [{ filters: [
        { filterType: 'PRICE_FILTER', tickSize: '0.01' },
        { filterType: 'LOT_SIZE', stepSize: '0.001' },
      ] }] }), { status: 200 });
    }
    if (String(input).startsWith('https://api.binance.com/')) {
      brokerCalls += 1;
      ids.push(new URL(String(input)).searchParams.get('newClientOrderId') || '');
      if (brokerCalls === 1) throw new Error('timeout after request was sent');
      return new Response(JSON.stringify({ code: -2010, msg: 'Duplicate order sent.' }), { status: 400 });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  try {
    await zSerwerem(async (adres) => {
      const body = {
        ...ZLECENIE,
        brokerType: 'BINANCE',
        apiKey: 'timeout-key',
        apiSecret: 'test-secret',
        confirm: true,
        newClientOrderId: 'same-after-timeout',
      };
      const first = await wyslij(adres, '/api/brokers/orders/create', body);
      const retry = await wyslij(adres, '/api/brokers/orders/create', body);

      assert.equal(first.status, 502);
      assert.equal(first.tresc.ambiguous, true);
      assert.equal(first.tresc.status, 'PENDING');
      assert.match(String(first.tresc.message), /sprawdź listę zleceń/);
      assert.equal(retry.tresc.ambiguous, true);
      assert.deepEqual(ids, ['same-after-timeout', 'same-after-timeout']);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('status Binance rozpoznaje istniejące zlecenie, -2013 i błąd sieci', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/api/v3/exchangeInfo?')) {
      return new Response(JSON.stringify({ symbols: [{ filters: [
        { filterType: 'PRICE_FILTER', tickSize: '0.01' },
        { filterType: 'LOT_SIZE', stepSize: '0.001' },
      ] }] }), { status: 200 });
    }
    if (String(input).startsWith('https://api.binance.com/')) {
      const url = new URL(String(input));
      assert.equal(url.pathname, '/api/v3/order');
      assert.equal(init?.method, 'GET');
      assert.ok(url.searchParams.get('signature'));
      const clientOrderId = url.searchParams.get('origClientOrderId');
      if (clientOrderId === 'found-order') {
        return new Response(JSON.stringify({ orderId: 987, clientOrderId, status: 'CANCELED' }), { status: 200 });
      }
      if (clientOrderId === 'missing-order') {
        return new Response(JSON.stringify({ code: -2013, msg: 'Order does not exist.' }), { status: 400 });
      }
      throw new Error('synthetic network failure');
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  try {
    await zSerwerem(async (adres) => {
      const auth = { brokerType: 'BINANCE', apiKey: 'test-key', apiSecret: 'test-secret', ticker: 'BTC' };
      const found = await wyslij(adres, '/api/brokers/orders/status', { ...auth, clientOrderId: 'found-order' });
      const missing = await wyslij(adres, '/api/brokers/orders/status', { ...auth, clientOrderId: 'missing-order' });
      const uncertain = await wyslij(adres, '/api/brokers/orders/status', { ...auth, clientOrderId: 'network-error' });

      assert.equal(found.status, 200);
      assert.equal(found.tresc.found, true);
      assert.equal((found.tresc.order as any).status, 'CANCELED');
      assert.equal(missing.status, 200);
      assert.equal(missing.tresc.found, false);
      assert.equal(missing.tresc.definitive, true);
      assert.equal(uncertain.status, 502);
      assert.equal(uncertain.tresc.success, false);
      assert.equal(uncertain.tresc.uncertain, true);
      assert.match(String(uncertain.tresc.message), /Sprawdź zlecenia w Binance/);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('stare trasy Freedom24 kierują do tras ochronnych bez wywołania brokera', async () => {
  await zSerwerem(async (adres) => {
    const create = await wyslij(adres, '/api/brokers/orders/create', { ...ZLECENIE, brokerType: 'FREEDOM24', confirm: true });
    const cancel = await wyslij(adres, '/api/brokers/orders/cancel', { brokerType: 'FREEDOM24', orderId: 1, confirm: true });
    assert.equal(create.status, 400);
    assert.match(String(create.tresc.message), /freedom24\/orders\/protect/);
    assert.equal(cancel.status, 400);
    assert.match(String(cancel.tresc.message), /freedom24\/orders\/cancel/);
  });
});

test('broker bez obsługi składania zleceń mówi to wprost, zamiast potwierdzać', async () => {
  await zSerwerem(async (adres) => {
    for (const brokerType of ['XTB', 'IBKR', 'REVOLUT', 'DEGIRO', 'CUSTOM']) {
      const { status, tresc } = await wyslij(adres, '/api/brokers/orders/create', {
        ...ZLECENIE,
        confirm: true,
        brokerType,
      });

      assert.equal(tresc.success, false, `${brokerType} nie może zgłaszać sukcesu`);
      assert.equal(status, 501, `${brokerType} ma odpowiadać 501`);
      assert.equal(tresc.status, 'NOT_SUPPORTED');
      assert.match(
        String(tresc.message),
        /nie składa zleceń/,
        `${brokerType}: komunikat ma powiedzieć, że zlecenia nie złożono`
      );
      assert.ok(!tresc.orderId, `${brokerType} nie może wymyślać numeru zlecenia`);
    }
  });
});

test('brak kluczy API zatrzymuje zlecenie zamiast je potwierdzać', async () => {
  await zSerwerem(async (adres) => {
    for (const brokerType of ['BINANCE']) {
      const { status, tresc } = await wyslij(adres, '/api/brokers/orders/create', {
        ...ZLECENIE,
        confirm: true,
        newClientOrderId: 'test-confirmation-1',
        brokerType,
      });

      assert.equal(tresc.success, false, `${brokerType} bez kluczy nie może zgłaszać sukcesu`);
      assert.equal(status, 400);
      assert.match(String(tresc.message), /klucz/i);
    }
  });
});

test('Binance potwierdza wyłącznie Stop-Loss, gdy żądano też Take-Profit', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/api/v3/exchangeInfo?')) {
      return new Response(JSON.stringify({ symbols: [{ filters: [
        { filterType: 'PRICE_FILTER', tickSize: '0.01' },
        { filterType: 'LOT_SIZE', stepSize: '0.001' },
      ] }] }), { status: 200 });
    }
    if (String(input).startsWith('https://api.binance.com/')) {
      assert.match(String(input), /type=STOP_LOSS_LIMIT/);
      return new Response(JSON.stringify({ orderId: 12345 }), { status: 200 });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  try {
    await zSerwerem(async (adres) => {
      const { status, tresc } = await wyslij(adres, '/api/brokers/orders/create', {
        ...ZLECENIE, brokerType: 'BINANCE', orderType: 'OCO_BRACKET',
        confirm: true, newClientOrderId: 'test-confirmation-2',
        takeProfitPrice: 150, apiKey: 'take-profit-key', apiSecret: 'test-secret',
      });
      assert.equal(status, 200);
      assert.equal(tresc.success, true);
      assert.equal(tresc.takeProfitPlaced, false);
      assert.match(String(tresc.message), /tylko Stop-Loss; Take-Profit NIE został złożony/);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('anulowanie bez potwierdzenia brokera nie jest zgłaszane jako sukces', async () => {
  await zSerwerem(async (adres) => {
    const { status, tresc } = await wyslij(adres, '/api/brokers/orders/cancel', {
      confirm: true,
      orderId: 'ORD-1',
      brokerType: 'XTB',
      ticker: 'NVDA',
    });

    assert.equal(tresc.success, false);
    assert.equal(status, 501);
    assert.match(String(tresc.message), /nie anuluje zleceń/);
    assert.match(String(tresc.message), /nie zdejmie go z rachunku/);
  });
});

test('anulowanie w Binance bez kluczy nie udaje, że zlecenie zniknęło', async () => {
  await zSerwerem(async (adres) => {
    const { status, tresc } = await wyslij(adres, '/api/brokers/orders/cancel', {
      confirm: true,
      orderId: '12345',
      brokerType: 'BINANCE',
      ticker: 'BTC',
    });

    assert.equal(tresc.success, false);
    assert.equal(status, 400);
    assert.match(String(tresc.message), /klucze API/);
  });
});

test('Freedom24 bez odpowiedzi nie udaje danych użytkownika', async () => {
  // Każda z tych tras zwracała wcześniej `success: true` z danymi wziętymi
  // z powietrza: przykładowymi zleceniami, przykładowymi dyspozycjami,
  // pustym portfelem o wartości 0 USD i komunikatem "brak wypłat dywidend".
  await zSerwerem(async (adres) => {
    const przypadki: Array<{ sciezka: string; pole: string }> = [
      { sciezka: '/api/brokers/freedom24/orders-history', pole: 'orders' },
      { sciezka: '/api/brokers/freedom24/cps/history', pole: 'cps' },
      { sciezka: '/api/brokers/freedom24/cashflows', pole: 'cashflows' },
      { sciezka: '/api/brokers/freedom24/portfolio', pole: 'pos' },
    ];

    for (const { sciezka, pole } of przypadki) {
      const { tresc } = await wyslij(adres, sciezka, {});
      assert.equal(tresc.success, false, `${sciezka} nie może zgłaszać sukcesu bez odpowiedzi brokera`);
      assert.deepEqual(tresc[pole], [], `${sciezka}: pusta lista, a nie dane przykładowe`);
      assert.ok(String(tresc.message).length > 0, `${sciezka}: ma powiedzieć, czego nie udało się pobrać`);
    }
  });
});

test('brak zapytania o dywidendy nie znaczy "nie było dywidend"', async () => {
  await zSerwerem(async (adres) => {
    const { tresc } = await wyslij(adres, '/api/brokers/freedom24/cashflows', {});
    assert.equal(tresc.success, false);
    assert.doesNotMatch(String(tresc.message), /^Brak zarejestrowanych wypłat/);
    assert.match(String(tresc.message), /nie znaczy, że nie było wypłat/);
  });
});

test('informacja o instrumencie bez tickera nie zwraca danych Apple', async () => {
  await zSerwerem(async (adres) => {
    const { status, tresc } = await wyslij(adres, '/api/brokers/freedom24/security-info', {});
    assert.equal(status, 400);
    assert.equal(tresc.success, false);
    assert.ok(!tresc.securityInfo, 'bez tickera nie ma opisu instrumentu');
  });
});

test('nieznany instrument nie dostaje opisu wymyślonego z symbolu', async () => {
  await zSerwerem(async (adres) => {
    const { tresc } = await wyslij(adres, '/api/brokers/freedom24/security-info', {
      ticker: 'ZZZZ.US',
    });
    assert.equal(tresc.success, false);
    assert.ok(!tresc.securityInfo, 'brak danych to brak opisu, a nie "ZZZZ Security"');
  });
});

test('bez poświadczeń trasa opcji nie oblicza lokalnego łańcucha', async () => {
  await zSerwerem(async (adres) => {
    const { status, tresc } = await wyslij(adres, '/api/brokers/freedom24/options', {
      ticker: 'AAPL',
      underlyingPrice: 228.5,
    });
    assert.equal(status, 400);
    assert.equal(tresc.success, false);
    assert.deepEqual(tresc.contracts, []);
  });
});

test('limit rezerwacji Binance nie usuwa nierozstrzygniętych zleceń', async () => {
  const originalFetch = globalThis.fetch;
  let orderCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/api/v3/exchangeInfo?')) return new Response(JSON.stringify({ symbols: [{ filters: [
      { filterType: 'PRICE_FILTER', tickSize: '0.01' }, { filterType: 'LOT_SIZE', stepSize: '0.001' },
    ] }] }), { status: 200 });
    if (String(input).startsWith('https://api.binance.com/')) {
      orderCalls++;
      return new Response(JSON.stringify({ msg: 'unknown' }), { status: 503 });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  try {
    await zSerwerem(async (adres) => {
      let full = false;
      for (let i = 0; i < 205; i++) {
        const result = await wyslij(adres, '/api/brokers/orders/create', { ...ZLECENIE, ticker: 'LIMIT', brokerType: 'BINANCE',
          apiKey: `reservation-key-${i}`, apiSecret: 'secret', confirm: true, newClientOrderId: `reservation-${i}` });
        if (result.status === 409) {
          assert.match(String(result.tresc.message), /limit rezerwacji/);
          full = true;
          break;
        }
        assert.equal(result.tresc.ambiguous, true);
      }
      assert.equal(full, true);
      assert.ok(orderCalls <= 200);
    });
  } finally { globalThis.fetch = originalFetch; }
});

