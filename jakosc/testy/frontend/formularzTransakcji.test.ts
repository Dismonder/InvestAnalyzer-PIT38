import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WALUTY_PROWIZJI,
  czyUtworzycRachunekDlaTransakcji,
  dzisiajLokalnie,
  podpowiedzZamknieciaPozycji,
  poczatkowaWalutaProwizji,
  walutaProwiziPoZmianieWaluty,
} from '../../../aplikacje/web/src/portfel/services/formularzTransakcji.ts';
import type { OpenPosition } from '../../../aplikacje/web/src/portfel/types.ts';

test('waluta prowizji podaza za waluta transakcji, dopoki uzytkownik jej nie zmienil', () => {
  assert.equal(walutaProwiziPoZmianieWaluty('PLN', 'USD', false), 'PLN');
  assert.equal(walutaProwiziPoZmianieWaluty('CHF', 'PLN', false), 'CHF');
  assert.equal(walutaProwiziPoZmianieWaluty('PLN', 'EUR', true), 'EUR');
});

test('przy edycji waluta prowizji to zapisana, a bez niej waluta transakcji', () => {
  assert.equal(poczatkowaWalutaProwizji({ currency: 'PLN', commissionCurrency: 'USD' }, 'USD'), 'USD');
  assert.equal(poczatkowaWalutaProwizji({ currency: 'PLN', commissionCurrency: undefined as never }, 'USD'), 'PLN');
  assert.equal(poczatkowaWalutaProwizji(null, 'EUR'), 'EUR');
});

test('lista walut prowizji zawiera CHF i wszystkie waluty transakcji', () => {
  for (const waluta of ['PLN', 'USD', 'EUR', 'GBP', 'CHF']) assert.ok(WALUTY_PROWIZJI.includes(waluta as never), waluta);
});

test('data dzisiejsza jest lokalna, nie UTC', () => {
  // 1 stycznia 00:30 czasu lokalnego: UTC bylby jeszcze poprzedni dzien w strefach na wschod od Greenwich.
  assert.equal(dzisiajLokalnie(new Date(2026, 0, 1, 0, 30)), '2026-01-01');
  assert.equal(dzisiajLokalnie(new Date(2026, 11, 31, 23, 59)), '2026-12-31');
  assert.equal(dzisiajLokalnie(new Date(2026, 2, 5, 12, 0)), '2026-03-05');
});

const pozycja = {
  ticker: 'VOO', name: 'Vanguard S&P 500', category: 'ETF', currency: 'USD', totalQuantity: 12, avgBuyPrice: 400,
  avgBuyPricePLN: 1600, totalCostPLN: 19200, openLotsCount: 1, lots: [], accountIds: ['k1'],
} as unknown as OpenPosition;

test('zamkniecie pozycji: podpowiedz z ilosci pozycji i notowania w jego walucie', () => {
  const podpowiedz = podpowiedzZamknieciaPozycji(pozycja, { price: 480.5, currency: 'EUR' }, 'k1');
  assert.deepEqual(
    { ilosc: podpowiedz.quantity, cena: podpowiedz.pricePerUnit, waluta: podpowiedz.currency, typ: podpowiedz.type, konto: podpowiedz.accountId },
    { ilosc: 12, cena: 480.5, waluta: 'EUR', typ: 'SELL', konto: 'k1' },
  );
});

test('zamkniecie pozycji bez notowania zostawia cene pusta, a nie cene zakupu', () => {
  const podpowiedz = podpowiedzZamknieciaPozycji(pozycja, undefined, 'k1');
  assert.equal(podpowiedz.pricePerUnit, 0);
  assert.equal(podpowiedz.currency, 'USD');
  assert.equal(podpowiedzZamknieciaPozycji(pozycja, { price: 0, currency: 'EUR' }, 'k1').pricePerUnit, 0);
});

test('zapis transakcji nie tworzy rachunku dla obcego id; wyjatek: pierwszy rachunek domyslny formularza', () => {
  assert.equal(czyUtworzycRachunekDlaTransakcji('obce-id', ['k1']), false);
  assert.equal(czyUtworzycRachunekDlaTransakcji('obce-id', []), false);
  assert.equal(czyUtworzycRachunekDlaTransakcji('account_unresolved', ['k1']), false);
  assert.equal(czyUtworzycRachunekDlaTransakcji('acc_main', []), true);
  assert.equal(czyUtworzycRachunekDlaTransakcji('acc_main', ['k1']), false);
});
