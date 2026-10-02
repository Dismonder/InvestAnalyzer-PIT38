import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createMemoryStorageSource,
  readConditionalCostIds,
  mergeAndSaveConditionalCostIds,
  readExcludedStorageFiles,
  mergeAndSaveExcludedStorageFiles,
  type KeyValueStorageSource,
} from '../../../aplikacje/web/src/invest_analyzer/services/taxEngineConfig.ts';
import {
  readDefenseEvidenceOverrides,
  mergeAndSaveDefenseEvidenceOverrides,
  type DefenseEvidenceOverride,
} from '../../../aplikacje/web/src/invest_analyzer/services/defenseEvidenceOverrides.ts';
import {
  readBrokerFileActionOverrides,
  mergeAndSaveBrokerFileActionOverrides,
  type BrokerFileActionOverride,
} from '../../../aplikacje/web/src/invest_analyzer/services/brokerFileActionOverrides.ts';
import {
  readAutoCheckActionOverrides,
  mergeAndSaveAutoCheckActionOverrides,
  type AutoCheckActionOverride,
} from '../../../aplikacje/web/src/invest_analyzer/services/autoCheckActionOverrides.ts';

function twoTabs<T>(
  name: string,
  read: (storage: KeyValueStorageSource) => T[],
  save: (storage: KeyValueStorageSource, base: T[], local: T[]) => T[],
  entry: (id: string) => T,
  key: (value: T) => string,
) {
  test(`${name}: dwie karty zachowują dodatki i usuwają tylko własny wpis`, () => {
    const storage = createMemoryStorageSource();
    let firstBase = read(storage);
    let secondBase = read(storage);

    firstBase = save(storage, firstBase, [entry('first')]);
    secondBase = save(storage, secondBase, [entry('second')]);
    assert.deepEqual(new Set(read(storage).map(key)), new Set(['first', 'second']));
    assert.deepEqual(new Set(secondBase.map(key)), new Set(['first', 'second']));

    firstBase = save(storage, firstBase, []);
    assert.deepEqual(read(storage).map(key), ['second']);
    assert.deepEqual(firstBase.map(key), ['second']);

    // Druga karta wciąż ma bazę sprzed usunięcia; jej nowy wpis nie przywraca pierwszego.
    secondBase = save(storage, secondBase, [...secondBase, entry('third')]);
    assert.deepEqual(new Set(read(storage).map(key)), new Set(['second', 'third']));
    assert.deepEqual(new Set(secondBase.map(key)), new Set(['second', 'third']));
  });
}

twoTabs('conditionalCostIds', readConditionalCostIds, mergeAndSaveConditionalCostIds, (id) => id, (id) => id);
twoTabs('excludedStorageFiles', readExcludedStorageFiles, mergeAndSaveExcludedStorageFiles, (id) => id, (id) => id);
twoTabs<DefenseEvidenceOverride>(
  'defenseEvidenceOverrides:v1', readDefenseEvidenceOverrides, mergeAndSaveDefenseEvidenceOverrides,
  (id) => ({ evidenceId: id, defenseStatus: 'complete', linkedTradeIds: [], updatedAt: '2026-01-01' }),
  (entry) => entry.evidenceId,
);
twoTabs<BrokerFileActionOverride>(
  'brokerFileActionOverrides:v1', readBrokerFileActionOverrides, mergeAndSaveBrokerFileActionOverrides,
  (id) => ({ actionId: id, status: 'resolved', updatedAt: '2026-01-01' }),
  (entry) => entry.actionId,
);
twoTabs<AutoCheckActionOverride>(
  'autoCheckActionOverrides:v1', readAutoCheckActionOverrides, mergeAndSaveAutoCheckActionOverrides,
  (id) => ({ itemId: id, status: 'done', updatedAt: '2026-01-01' }),
  (entry) => entry.itemId,
);
