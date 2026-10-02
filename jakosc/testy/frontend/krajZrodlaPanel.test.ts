/**
 * Kraj źródła dla sprzedaży bez ISIN (np. wykup noty DGT4016.JUN26).
 *
 * Wykup jest sprzedażą złożoną przez silnik ze zdarzenia - nie ma go na liście
 * historii, więc bez tego panelu blokady PIT/ZG nie dało się usunąć z interfejsu.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { nadpisaniaKrajuZrodla } from '../../../aplikacje/web/src/invest_analyzer/components/KrajZrodlaPanel.tsx';
import type { EngineEditableRecord } from '../../../aplikacje/web/src/invest_analyzer/hooks/useTaxEngineRun.ts';

function rekord(baseId: string, symbol: string, side: string, recordType = 'TRADE'): EngineEditableRecord {
  return {
    base_record_id: baseId,
    manual_record_id: `edit-${baseId}`,
    record_type: recordType,
    overlay_status: 'ORIGINAL',
    deleted: false,
    original_values: { symbol, side },
    current_values: { symbol, side, quantity: '3', price: '320.45', trade_currency: 'USD', date: '2026-06-11', country: '' },
    modified_fields: [],
    validation_state: { is_valid: true, status: 'VALID', errors: [], warnings: [] },
    diffs: [],
  } as EngineEditableRecord;
}

test('kraj trafia tylko do sprzedaży wskazanego instrumentu, z pełnymi wartościami rekordu', () => {
  const rekordy = [
    rekord('MATURITY-DGT4016.JUN26|2026-06-11|3|320.45|USD', 'DGT4016.JUN26', 'SELL'),
    rekord('545087410', 'DGT4016.JUN26', 'BUY'),
    rekord('NBIS-1', 'NBIS.US', 'SELL'),
    rekord('EV-1', 'DGT4016.JUN26', 'SELL', 'EVENT'),
  ];
  const nadpisania = nadpisaniaKrajuZrodla(rekordy, 'dgt4016.jun26', ' cy ');
  assert.equal(nadpisania.length, 1);
  assert.equal(nadpisania[0].baseRecordId, 'MATURITY-DGT4016.JUN26|2026-06-11|3|320.45|USD');
  // Ten sam identyfikator co zapis z edytora - bez drugiego nadpisania rekordu.
  assert.equal(nadpisania[0].manualRecordId, 'edit-MATURITY-DGT4016.JUN26|2026-06-11|3|320.45|USD');
  assert.equal(nadpisania[0].mode, 'override');
  assert.equal(nadpisania[0].values.country, 'CY');
  assert.equal(nadpisania[0].values.quantity, '3');
  assert.equal(nadpisania[0].values.price, '320.45');
});

test('kod spoza słownika MF nie tworzy nadpisań', () => {
  const rekordy = [rekord('M-1', 'DGT4016.JUN26', 'SELL')];
  assert.deepEqual(nadpisaniaKrajuZrodla(rekordy, 'DGT4016.JUN26', 'XS'), []);
  assert.deepEqual(nadpisaniaKrajuZrodla(rekordy, 'DGT4016.JUN26', 'XX'), []);
  assert.deepEqual(nadpisaniaKrajuZrodla(rekordy, 'DGT4016.JUN26', ''), []);
});

test('recznie dodana sprzedaz bez rekordu bazowego dostaje kraj jako ten sam nowy rekord', () => {
  const nowa = {
    ...rekord('', 'NOTA.X', 'SELL'),
    base_record_id: null,
    manual_record_id: 'manual-trade-1',
    overlay_status: 'NEW',
  } as unknown as EngineEditableRecord;
  const nadpisania = nadpisaniaKrajuZrodla([nowa], 'NOTA.X', 'CY');
  assert.equal(nadpisania.length, 1);
  assert.equal(nadpisania[0].mode, 'new');
  assert.equal(nadpisania[0].baseRecordId, null);
  assert.equal(nadpisania[0].manualRecordId, 'manual-trade-1');
  assert.equal(nadpisania[0].values.country, 'CY');
  // Rekord bez bazy i bez statusu NEW (np. osierocony) nie jest ruszany.
  assert.deepEqual(nadpisaniaKrajuZrodla([{ ...nowa, overlay_status: 'ORPHAN' } as EngineEditableRecord], 'NOTA.X', 'CY'), []);
});
