import assert from 'node:assert/strict';
import test from 'node:test';

import { createFreedom24Api, Freedom24Credentials } from '../../../aplikacje/web/src/server/freedom24/freedom24Api.ts';

const configured = process.env.FREEDOM24_INTEGRATION === '1' && Freedom24Credentials.configured();

test('Freedom24 integration: skipped unless explicitly enabled with local credentials', { skip: configured }, () => {
  assert.equal(configured, false);
});

test('Freedom24 integration: authenticated read-only endpoints', { skip: !configured }, async () => {
  const api = createFreedom24Api();
  assert.ok(api, 'Local credentials should create a server-side client.');
  const checks: Array<[string, Record<string, unknown>]> = [
    ['getOPQ', {}],
    ['getPositionJson', {}],
    ['getTradesHistory', {}],
    ['getNotifyOrderJson', {}],
    ['getUserCashFlows', { filters: {}, take: 100 }],
    ['getSecurityInfo', { ticker: 'AAPL.US', sup: true }],
    ['getMarketStatus', { markets: ['US'] }],
  ];
  for (const [command, params] of checks) {
    const result = await api!.read(command, params);
    assert.equal(result.ok, true, `${command} should be authenticated and read-only`);
  }
});
