import test from 'node:test';
import assert from 'node:assert/strict';

import { oczyscRachunki } from '../../../aplikacje/web/src/portfel/services/rachunkiBrokera.ts';
import type { BrokerAccount, Transaction } from '../../../aplikacje/web/src/portfel/types.ts';
import { oczyscTransakcje } from '../../../aplikacje/web/src/portfel/services/transakcjePortfela.ts';

const poprawny: BrokerAccount = {
  id: 'acc-real', name: 'Moj rachunek', brokerType: 'XTB', currency: 'PLN', color: 'blue',
};

test('rachunki bez podstawowych pol odpadaja, poprawne zachowuja kolejnosc', () => {
  const drugi = { ...poprawny, id: 'acc-real-2' };
  const zepsute = [
    { id: 'x' },
    { ...poprawny, id: '' },
    { ...poprawny, name: undefined },
    { ...poprawny, brokerType: undefined },
    null,
    'tekst',
  ] as unknown as BrokerAccount[];
  assert.deepEqual(oczyscRachunki([drugi, ...zepsute, poprawny], []), [drugi, poprawny]);
});

test('nietkniety rachunek demo odpada, skonfigurowany kluczem zostaje', () => {
  const demo = { ...poprawny, id: 'acc_xtb_pln' };
  const polaczony = { ...demo, apiKey: 'prawdziwy-klucz' };
  const zSekretem = { ...demo, apiSecret: '123456' };
  const nietkniety = { ...demo, apiKey: '12345', apiSecret: '', accountNumber: '   ' };
  assert.deepEqual(oczyscRachunki([demo, nietkniety, poprawny, polaczony, zSekretem], []), [poprawny, polaczony, zSekretem]);
});

test('Revolut i eMakler z numerem rachunku zachowuja dane uzytkownika', () => {
  const revolut = { ...poprawny, id: 'acc_revolut', brokerType: 'REVOLUT' as const, accountNumber: '  PL123  ' };
  const emakler = { ...poprawny, id: 'acc_emakler', accountNumber: '123' };
  assert.deepEqual(oczyscRachunki([revolut, emakler], []), [revolut, emakler]);
});

test('rachunek o demo-id zostaje, gdy wskazuje go oczyszczona transakcja uzytkownika', () => {
  const rachunek = { ...poprawny, id: 'acc_xtb_pln' };
  const transakcja: Transaction = {
    id: 'tx-user', accountId: rachunek.id, ticker: 'CDR', name: 'CD Projekt',
    category: 'STOCK_PL', type: 'BUY', date: '2026-10-01', quantity: 1,
    pricePerUnit: 100, currency: 'PLN', commission: 0, commissionCurrency: 'PLN',
  };
  const transakcje: readonly Transaction[] = oczyscTransakcje([transakcja]);
  assert.deepEqual(oczyscRachunki([rachunek], transakcje), [rachunek]);
  assert.deepEqual(oczyscRachunki([rachunek], oczyscTransakcje([
    { ...transakcja, id: 'tx_01' }, { ...transakcja, id: 'tx_demo_user' },
  ])), []);
});
