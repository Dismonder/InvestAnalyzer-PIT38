import test from "node:test";
import assert from "node:assert/strict";

import { createMemoryStorageSource } from "../../../aplikacje/web/src/invest_analyzer/services/taxEngineConfig.ts";
import {
  DEFENSE_EVIDENCE_OVERRIDES_KEY,
  readDefenseEvidenceOverrides,
  upsertDefenseEvidenceOverride,
} from "../../../aplikacje/web/src/invest_analyzer/services/defenseEvidenceOverrides.ts";

test("defenseEvidenceOverrides:v1 zapisuje lokalne statusy dowodowe bez udziału silnika", () => {
  const storage = createMemoryStorageSource();

  upsertDefenseEvidenceOverride(
    storage,
    {
      evidenceId: "COST-3368752211",
      defenseStatus: "needs_user_evidence",
      userNote: "Zachować potwierdzenie finansowania salda ujemnego.",
      linkedTradeIds: ["TRADE-1"],
      linkedRowId: "row-trade-1",
      updatedAt: "2026-05-10T10:00:00.000Z",
      evidenceConfirmed: true,
      checkedAt: "2026-05-10T10:05:00.000Z",
      includedInFilingPackage: true,
    },
  );

  const stored = readDefenseEvidenceOverrides(storage);

  assert.equal(DEFENSE_EVIDENCE_OVERRIDES_KEY, "defenseEvidenceOverrides:v1");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].evidenceId, "COST-3368752211");
  assert.equal(stored[0].defenseStatus, "needs_user_evidence");
  assert.deepEqual(stored[0].linkedTradeIds, ["TRADE-1"]);
  assert.equal(stored[0].linkedRowId, "row-trade-1");
  assert.equal(stored[0].evidenceConfirmed, true);
  assert.equal(stored[0].checkedAt, "2026-05-10T10:05:00.000Z");
  assert.equal(stored[0].includedInFilingPackage, true);
});

test("upsertDefenseEvidenceOverride zastępuje wpis tego samego evidenceId i ignoruje uszkodzony JSON", () => {
  const storage = createMemoryStorageSource({
    [DEFENSE_EVIDENCE_OVERRIDES_KEY]: "{bad-json",
  });

  assert.deepEqual(readDefenseEvidenceOverrides(storage), []);

  upsertDefenseEvidenceOverride(storage, {
    evidenceId: "COST-1",
    defenseStatus: "missing_link",
    linkedTradeIds: ["OLD"],
    updatedAt: "2026-05-10T10:00:00.000Z",
  });
  upsertDefenseEvidenceOverride(storage, {
    evidenceId: "COST-1",
    defenseStatus: "complete",
    linkedTradeIds: ["NEW"],
    updatedAt: "2026-05-10T11:00:00.000Z",
  });

  const stored = readDefenseEvidenceOverrides(storage);

  assert.equal(stored.length, 1);
  assert.equal(stored[0].defenseStatus, "complete");
  assert.deepEqual(stored[0].linkedTradeIds, ["NEW"]);
});

