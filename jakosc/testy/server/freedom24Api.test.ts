import assert from 'node:assert/strict';
import test from 'node:test';

import {
  adaptPortfolio,
  canonicalJson,
  createFreedom24Api,
  Freedom24ApiClient,
  Freedom24Credentials,
  Freedom24HttpClient,
  Freedom24Signer,
  freedom24LegacyRequest,
  sanitizeFreedom24Text,
} from '../../../aplikacje/web/src/server/freedom24/freedom24Api.ts';

test('Freedom24: canonical JSON and HMAC are deterministic', () => {
  const payload = canonicalJson({ b: 2, a: 1, nested: { z: null, a: true } });
  assert.equal(payload, '{"a":1,"b":2,"nested":{"a":true,"z":null}}');
  assert.equal(
    new Freedom24Signer('test-secret').sign(canonicalJson({ b: 2, a: 1 }), '1700000000'),
    '046bd822091f9ab01677cefdaa4397eee68630c729a21e0ce35e832888f43652',
  );
});

test('Freedom24: nie-JSON przy HTTP 401/403 wyjaśnia problem z kluczami', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const status of [401, 403]) {
      globalThis.fetch = async () => new Response('<html>Denied</html>', { status });
      const http = new Freedom24HttpClient({ publicKey: 'public', privateKey: 'private' } as any, 100, 0);
      const signed = await http.post('getOPQ', {});
      const legacy = await freedom24LegacyRequest('getOPQ', {});
      for (const result of [signed, legacy]) {
        assert.equal(result.ok, false);
        if (result.ok === false) {
          assert.match(result.error.message, new RegExp(`HTTP ${status}`));
          assert.match(result.error.message, /Wprowadź nowe klucze/);
        }
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Freedom24: missing credentials are unavailable without a crash', () => {
  assert.equal(Freedom24Credentials.configured('C:/definitely-missing-freedom24-credentials'), false);
  assert.equal(Freedom24Credentials.load('C:/definitely-missing-freedom24-credentials'), null);
});

test('Freedom24: read-only client blocks a modifying command before HTTP', async () => {
  const http = new Freedom24HttpClient({ publicKey: 'public', privateKey: 'private' } as any);
  const api = new Freedom24ApiClient(http);
  const result = await api.read('putTradeOrder');
  assert.equal(result.ok, false);
  if (result.ok === false) assert.match(result.error.message, /tylko-do-odczytu/);
});

test('Freedom24: HTTP errors are mapped without response bodies', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 12, errMsg: 'token=abc12345678901234567890123456789 denied' }), { status: 403 });
  try {
    const http = new Freedom24HttpClient({ publicKey: 'public', privateKey: 'private' } as any, 100, 0);
    const result = await http.post('getOPQ', {});
    assert.equal(result.ok, false);
    if (result.ok === false) {
      assert.equal(result.error.status, 403);
      assert.equal(result.error.retryable, false);
      assert.doesNotMatch(result.error.message, /abc123/);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Freedom24: timeout zapisu daje wynik niejednoznaczny po jednym żądaniu', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new DOMException('timeout', 'TimeoutError'); };
  try {
    const api = new Freedom24ApiClient(new Freedom24HttpClient({ publicKey: 'public', privateKey: 'private' }, 100, 1));
    const result = await api.protect('putStopLoss', { instr_name: 'TEST.US', stop_loss: 100 });
    assert.equal(calls, 1);
    assert.equal(result.ok, false);
    if (result.ok === false) {
      assert.equal(result.error.ambiguous, true);
      assert.equal(result.error.retryable, false);
      assert.match(result.error.message, /sprawdź listę zleceń/);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Freedom24: odczyt nadal ponawia błąd serwera', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('{}', { status: calls === 1 ? 503 : 200 });
  };
  try {
    const api = new Freedom24ApiClient(new Freedom24HttpClient({ publicKey: 'public', privateKey: 'private' }, 100, 1));
    const result = await api.read('getOPQ');
    assert.equal(calls, 2);
    assert.equal(result.ok, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Freedom24: adapter retains currencies and never treats missing fields as zero', () => {
  const portfolio = adaptPortfolio({
    result: { ps: { acc: [{ curr: 'USD', s: '4.5', currval: '84.25' }, { curr: 'EUR' }], pos: [
      { i: 'ABC.US', curr: 'USD', q: '2', market_value: '8', mkt_price: '4' },
      { i: 'BOND.EU', curr: 'EUR' },
    ] } },
  });
  assert.deepEqual(portfolio.balances.map((row) => row.currency), ['USD', 'EUR']);
  assert.equal(portfolio.balances[0].exchangeRate, 84.25);
  assert.equal(portfolio.positions[0].ticker, 'ABC');
  assert.equal(portfolio.positions[0].market, 'US');
  assert.equal(portfolio.positions[1].quantity, null);
  assert.equal(portfolio.positions[1].marketValue, null);
});

test('Freedom24: sanitization removes secrets from headers and messages', () => {
  const value = sanitizeFreedom24Text('Authorization: bearer-token api-key=abc12345678901234567890123456789 signature=secret-value');
  assert.doesNotMatch(value, /bearer-token|abc123|secret-value/i);
  assert.match(value, /redacted/i);
});

test('Freedom24: starsza ścieżka z kluczami z żądania też nie wyśle polecenia zmieniającego rachunek', async () => {
  const { sendTradernetRequest } = await import('../../../aplikacje/web/src/server/routes/brokers.ts');
  const originalFetch = globalThis.fetch;
  let wywolania = 0;
  globalThis.fetch = async () => {
    wywolania += 1;
    return new Response('{}', { status: 200 });
  };
  try {
    for (const polecenie of ['putTradeOrder', 'putStopLoss', 'delTradeOrder', 'addStockList', 'deleteStockListTicker']) {
      const wynik = await sendTradernetRequest(polecenie, {}, 'klucz-publiczny-testowy', 'klucz-prywatny-testowy');
      assert.equal(wynik.success, false);
      assert.equal(wynik.errorCode, 'FREEDOM24_READ_ONLY');
    }
    assert.equal(wywolania, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Freedom24: proces testu nigdy nie siega po prawdziwe klucze, nawet bez FREEDOM24_DISABLE_LIVE', () => {
  // Runner testow Node uruchamia plik w procesie potomnym bez `--test` w argv;
  // ochrona musi rozpoznac go po NODE_TEST_CONTEXT. Wczesniej test uruchomiony
  // poza skryptem npm czytal klucze z dane/API i pytal prawdziwe API.
  const poprzednie = {
    wylaczone: process.env.FREEDOM24_DISABLE_LIVE,
    integracja: process.env.FREEDOM24_INTEGRATION,
    load: Freedom24Credentials.load,
  };
  let odczytKluczy = false;
  delete process.env.FREEDOM24_DISABLE_LIVE;
  delete process.env.FREEDOM24_INTEGRATION;
  (Freedom24Credentials as unknown as { load: () => unknown }).load = () => {
    odczytKluczy = true;
    return { publicKey: 'syntetyczny', privateKey: 'syntetyczny' };
  };
  try {
    assert.ok(process.env.NODE_TEST_CONTEXT, 'plik testu dziala w procesie potomnym runnera');
    assert.equal(createFreedom24Api(), null);
    assert.equal(odczytKluczy, false, 'klucze nie zostaly nawet odczytane');
  } finally {
    if (poprzednie.wylaczone === undefined) delete process.env.FREEDOM24_DISABLE_LIVE;
    else process.env.FREEDOM24_DISABLE_LIVE = poprzednie.wylaczone;
    if (poprzednie.integracja === undefined) delete process.env.FREEDOM24_INTEGRATION;
    else process.env.FREEDOM24_INTEGRATION = poprzednie.integracja;
    (Freedom24Credentials as unknown as { load: unknown }).load = poprzednie.load;
  }
});
