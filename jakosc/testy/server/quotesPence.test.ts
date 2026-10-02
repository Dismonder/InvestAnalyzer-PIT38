import assert from 'node:assert/strict';
import test from 'node:test';

import { cenaNocna, fetchHistoricalChart, normalizePenceQuote, normalizedQuoteCurrency } from '../../../aplikacje/web/src/server/routes/quotes.ts';

test('notowanie Yahoo w GBp jest przeliczane na GBP', () => {
  assert.equal(normalizedQuoteCurrency('GBp'), 'GBP');
  assert.equal(normalizePenceQuote(75.4, 'GBp'), 0.754);
  assert.equal(normalizePenceQuote(75.4, 'GBX'), 0.754);
  assert.equal(normalizePenceQuote(75.4, 'USD'), 75.4);
});

test('świece Yahoo i nocna próbka w GBp/GBX mają wartości w GBP', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ chart: { result: [{
    meta: { currency: 'GBX', fulldayPrice: 1234 },
    timestamp: [1_700_000_000],
    indicators: { quote: [{ open: [1200], high: [1300], low: [1100], close: [1250], volume: [10] }] },
  }] } }), { status: 200 })) as typeof fetch;
  try {
    const history = await fetchHistoricalChart('TEST.UK', '5d', '1d');
    assert.deepEqual(
      { open: history.points[0].open, high: history.points[0].high, low: history.points[0].low, close: history.points[0].close },
      { open: 12, high: 13, low: 11, close: 12.5 },
    );
    assert.equal(await cenaNocna('TEST.UK'), 12.34);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
