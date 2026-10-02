import test from "node:test";
import assert from "node:assert/strict";

import { createMemoryStorageSource } from "../../../aplikacje/web/src/invest_analyzer/services/taxEngineConfig";
import {
  DEFENSE_VAULT_KEY,
  readDefenseVaultItems,
  saveDefenseVaultItems,
  upsertDefenseVaultItem,
} from "../../../aplikacje/web/src/invest_analyzer/services/defenseVault";
import {
  PIT_TRUST_STORAGE_VERSION,
  PIT_TRUST_STORAGE_VERSION_KEY,
  SOURCE_TRUST_DECISIONS_KEY,
  readSourceTrustDecisions,
  saveSourceTrustDecisions,
} from "../../../aplikacje/web/src/invest_analyzer/services/sourceTrustDecisions";

test("Defense Vault storage zapisuje tylko poprawne metadata dowodów", () => {
  const storage = createMemoryStorageSource();

  saveDefenseVaultItems(storage, [
    {
      evidenceId: "EVIDENCE-1",
      title: "Potwierdzenie kosztu",
      status: "available",
      linkedRecordIds: ["ROW-1"],
      linkedSourceIds: ["SRC-1"],
      linkedNoOverpayItemIds: ["COST-1"],
      updatedAt: "2026-05-15T00:00:00.000Z",
    },
    {
      evidenceId: "",
      title: "invalid",
      status: "available",
      linkedRecordIds: [],
      linkedSourceIds: [],
      linkedNoOverpayItemIds: [],
      updatedAt: "",
    },
  ]);

  assert.equal(readDefenseVaultItems(storage).length, 1);
  assert.match(storage.getItem(DEFENSE_VAULT_KEY) || "", /EVIDENCE-1/);

  upsertDefenseVaultItem(storage, {
    evidenceId: "EVIDENCE-1",
    title: "Potwierdzenie kosztu",
    status: "advisor_review",
    linkedRecordIds: ["ROW-1"],
    linkedSourceIds: ["SRC-1"],
    linkedNoOverpayItemIds: ["COST-1"],
    userNote: "Do sprawdzenia z doradcą.",
    updatedAt: "2026-05-15T01:00:00.000Z",
  });

  const [updated] = readDefenseVaultItems(storage);
  assert.equal(updated.status, "advisor_review");
  assert.equal(updated.userNote, "Do sprawdzenia z doradcą.");
});

test("Source Trust decisions zapisują wersję storage i odrzucają błędne wpisy", () => {
  const storage = createMemoryStorageSource();

  saveSourceTrustDecisions(storage, [
    {
      sourceId: "SRC-1",
      status: "needs_review",
      userNote: "Różnica wymaga kontroli.",
      updatedAt: "2026-05-15T00:00:00.000Z",
    },
    {
      sourceId: "",
      status: "accepted",
      updatedAt: "",
    },
  ]);

  const decisions = readSourceTrustDecisions(storage);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].sourceId, "SRC-1");
  assert.equal(storage.getItem(PIT_TRUST_STORAGE_VERSION_KEY), PIT_TRUST_STORAGE_VERSION);
  assert.match(storage.getItem(SOURCE_TRUST_DECISIONS_KEY) || "", /SRC-1/);
});

