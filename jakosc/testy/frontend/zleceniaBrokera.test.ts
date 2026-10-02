import test from 'node:test';
import assert from 'node:assert/strict';

import { oczyscZlecenia } from '../../../aplikacje/web/src/portfel/services/zleceniaBrokera.ts';
import type { BrokerOrder } from '../../../aplikacje/web/src/portfel/types.ts';

const poprawne: BrokerOrder = {
  id: 'ord-1', accountId: 'acc-1', brokerType: 'FREEDOM24', ticker: 'NBIS.US', orderType: 'STOP_LOSS',
  action: 'SELL', quantity: 3, stopPrice: 200, currency: 'USD', status: 'ARMED',
  createdAt: '2026-09-30T10:00:00.000Z', isApiOrder: true,
};

test('zlecenie bez symbolu, statusu albo rachunku odpada, poprawne zostaje bez zmian', () => {
  const lista = [
    poprawne,
    { id: 'zepsute-zlecenie' },
    { ...poprawne, id: 'bez-tickera', ticker: '   ' },
    { ...poprawne, id: 'ticker-liczba', ticker: 123 },
    { ...poprawne, id: 'bez-statusu', status: undefined },
    { ...poprawne, id: 'bez-rachunku', accountId: undefined },
    null,
  ] as unknown as BrokerOrder[];
  assert.deepEqual(oczyscZlecenia(lista), [poprawne]);
});

test('czysta lista wraca w tej samej kolejnosci i bez utraty zlecen zakonczonych', () => {
  const lista: BrokerOrder[] = [poprawne, { ...poprawne, id: 'ord-2', status: 'CANCELLED' }, { ...poprawne, id: 'ord-3', status: 'EXECUTED' }];
  assert.deepEqual(oczyscZlecenia(lista), lista);
});
