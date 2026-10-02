import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import type { LiveMarketQuote, PriceAlert } from '../../../aplikacje/web/src/portfel/types.ts';
import {
  buildPriceAlertMessage,
  calculatePriceAlertExpiry,
  evaluatePriceAlert,
  findPriceAlertQuote,
  isPriceAlertExpired,
  togglePriceAlert,
  updatePriceAlert,
} from '../../../aplikacje/web/src/portfel/services/priceAlertLogic.ts';

const now = Date.parse('2026-09-28T12:00:00.000Z');

function quote(overrides: Partial<LiveMarketQuote> = {}): LiveMarketQuote {
  return {
    ticker: 'NBIS', name: 'Nebius', category: 'STOCK_FOREIGN', price: 20, currency: 'USD',
    change24h: 2, changePercent24h: 10, high24h: 21, low24h: 18, volume24h: 1000,
    sparkline: [], lastUpdated: new Date(now - 1000).toISOString(), source: 'TRADINGVIEW', ...overrides,
  };
}

function alert(overrides: Partial<PriceAlert> = {}): PriceAlert {
  return {
    id: 'alert-1', ticker: 'NBIS.US', targetPrice: 15, currency: 'USD', condition: 'ABOVE',
    isActive: true, isTriggered: false, createdAt: new Date(now - 60_000).toISOString(), ...overrides,
  };
}

test('nie wyzwala alertu ceny przy innej walucie notowania', () => {
  const result = evaluatePriceAlert(alert({ currency: 'PLN' }), { NBIS: quote() }, now);
  assert.equal(result.currencyMismatch, true);
  assert.equal(result.updatedAlert, undefined);
});

test('dopasowuje pojedynczy symbol po sufiksie rynku, ale odrzuca niejednoznaczne skróty', () => {
  const onlyNbis = { NBIS: quote() };
  assert.equal(findPriceAlertQuote('NBIS.US', onlyNbis), onlyNbis.NBIS);
  assert.equal(evaluatePriceAlert(alert(), onlyNbis, now).updatedAlert?.isTriggered, true);

  const ambiguous = { 'NBIS.US': quote({ ticker: 'NBIS.US' }), 'NBIS.EU': quote({ ticker: 'NBIS.EU', currency: 'EUR' }) };
  assert.equal(findPriceAlertQuote('NBIS', ambiguous), undefined);
  assert.equal(findPriceAlertQuote('NBIS.EU', ambiguous), ambiguous['NBIS.EU']);
});

test('odrzuca nieaktualne, przyszłe i nieprawidłowo oznaczone notowania', () => {
  for (const lastUpdated of [
    new Date(now - 15 * 60 * 1000 - 1).toISOString(),
    new Date(now + 1).toISOString(),
    'niepoprawna-data',
  ]) {
    assert.equal(evaluatePriceAlert(alert(), { NBIS: quote({ lastUpdated }) }, now).updatedAlert, undefined);
  }
});

test('przełączenie nie uzbraja ponownie alertu, a zmiana warunku lub progu uzbraja', () => {
  const triggered = alert({ isTriggered: true, triggeredAt: new Date(now - 500).toISOString(), message: 'poprzedni alert' });
  assert.equal(togglePriceAlert(triggered).isTriggered, true);
  assert.equal(updatePriceAlert(triggered, { ...triggered, isActive: false }).isTriggered, true);

  const changedTarget = updatePriceAlert(triggered, { ...triggered, targetPrice: 25 });
  assert.equal(changedTarget.isTriggered, false);
  assert.equal(changedTarget.triggeredAt, undefined);
  const changedCondition = updatePriceAlert(triggered, { ...triggered, condition: 'BELOW' });
  assert.equal(changedCondition.isTriggered, false);
  assert.equal(updatePriceAlert(triggered, { ...triggered, expiresAt: new Date(now + 1000).toISOString() }).isTriggered, true);
});

test('wygaśnięcie jest w chwili granicznej, a ważność liczona jest jako czas trwania', () => {
  const expiresAt = new Date(now).toISOString();
  assert.equal(isPriceAlertExpired({ expiresAt }, now - 1), false);
  assert.equal(isPriceAlertExpired({ expiresAt }, now), true);
  assert.equal(calculatePriceAlertExpiry('7d', now), new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString());
  assert.equal(calculatePriceAlertExpiry('30d', now), new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString());
  assert.equal(calculatePriceAlertExpiry('never', now), undefined);
});

test('komunikat i etykiety jasno wskazują zmianę 24h', () => {
  const message = buildPriceAlertMessage(alert({ condition: 'PERCENT_CHANGE_UP', percentageThreshold: 5 }), quote());
  assert.match(message, /zmiana 24h/);
  const source = readFileSync('aplikacje/web/src/portfel/components/PriceAlertsModal.tsx', 'utf8');
  assert.match(source, /Wzrost zmiany 24h/);
  assert.match(source, /Spadek zmiany 24h/);
  assert.match(source, /Próg zmiany 24h/);
});

test('zmiana waloru albo waluty alertu uzbraja go ponownie (R15)', () => {
  const now = Date.parse('2026-09-28T12:00:00Z');
  const alert = { id: 'a1', ticker: 'NBIS.US', targetPrice: 50, currency: 'USD', condition: 'ABOVE', isActive: true, isTriggered: true, triggeredAt: new Date(now).toISOString() } as never;
  assert.equal(updatePriceAlert(alert, { ...(alert as object), ticker: 'AAPL.US' } as never).isTriggered, false);
  assert.equal(updatePriceAlert(alert, { ...(alert as object), currency: 'EUR' } as never).isTriggered, false);
  assert.equal(updatePriceAlert(alert, { ...(alert as object), ticker: ' nbis.us ' } as never).isTriggered, true, 'ten sam walor');
});

test('alert procentowy nie wyzwala sie, gdy dostawca nie podal zmiany dziennej (null to nie 0)', () => {
  const bezZmiany = quote({ change24h: null, changePercent24h: null });
  const wzrost = evaluatePriceAlert(alert({ condition: 'PERCENT_CHANGE_UP', percentageThreshold: 0 }), { NBIS: bezZmiany }, now);
  const spadek = evaluatePriceAlert(alert({ condition: 'PERCENT_CHANGE_DOWN', percentageThreshold: 0 }), { NBIS: bezZmiany }, now);
  assert.equal(wzrost.updatedAlert, undefined);
  assert.equal(spadek.updatedAlert, undefined);
  // Alert cenowy dziala bez zmiany dziennej.
  assert.equal(evaluatePriceAlert(alert(), { NBIS: bezZmiany }, now).updatedAlert?.isTriggered, true);
});
