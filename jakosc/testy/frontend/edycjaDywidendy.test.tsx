import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AddTransactionModal } from '../../../aplikacje/web/src/portfel/components/AddTransactionModal.tsx';
import { podatekZrodlaDywidendy } from '../../../aplikacje/web/src/portfel/services/formularzTransakcji.ts';
import type { BrokerAccount, Transaction } from '../../../aplikacje/web/src/portfel/types.ts';

const rachunek = { id: 'k1', name: 'Dom', brokerType: 'CUSTOM', currency: 'USD', color: '#000' } as BrokerAccount;
const dywidenda: Transaction = {
  id: 'div-1', accountId: 'k1', ticker: 'XYZ', name: 'XYZ', category: 'STOCK_FOREIGN', type: 'DIVIDEND',
  date: '2026-06-01', quantity: 1, pricePerUnit: 10, currency: 'USD', commission: 0, commissionCurrency: 'USD',
  foreignTaxRate: 15, foreignTaxAmount: 1.44,
};

test('edycja dywidendy zachowuje kwotę podatku u źródła (1,44 USD, nie 1,50 ze stawki)', () => {
  const wynik = podatekZrodlaDywidendy('DIVIDEND', '15', '1.44');
  assert.deepEqual(wynik, { foreignTaxRate: 15, foreignTaxAmount: 1.44 });
  // Puste pole kwoty = podatek liczony ze stawki; inne typy operacji bez podatku.
  assert.deepEqual(podatekZrodlaDywidendy('DIVIDEND', '15', ''), { foreignTaxRate: 15, foreignTaxAmount: undefined });
  assert.deepEqual(podatekZrodlaDywidendy('DIVIDEND', '', '0'), { foreignTaxRate: 0, foreignTaxAmount: 0 });
  assert.deepEqual(podatekZrodlaDywidendy('BUY', '15', '1.44'), { foreignTaxRate: undefined, foreignTaxAmount: undefined });
  assert.deepEqual(podatekZrodlaDywidendy('DIVIDEND', '15', 'abc'), { foreignTaxRate: 15, foreignTaxAmount: undefined });
});

test('formularz edycji dywidendy pokazuje zapisaną kwotę podatku u źródła', () => {
  const markup = renderToStaticMarkup(<AddTransactionModal accounts={[rachunek]} language="pl"
    editingTransaction={dywidenda} onSave={() => undefined} onClose={() => undefined} />);
  assert.match(markup, /value="1\.44"/);
  assert.match(markup, /Kwota podatku u źródła/);
});
