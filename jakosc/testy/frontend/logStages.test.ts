import test from "node:test";
import assert from "node:assert/strict";

import { formatLogStageLabel } from "../../../aplikacje/web/src/invest_analyzer/services/logStages.ts";

test("formatLogStageLabel pokazuje auto-import storage jako oficjalny etap plikowy", () => {
  assert.equal(formatLogStageLabel("AUTO_IMPORT"), "AUTOIMPORT STORAGE");
});

