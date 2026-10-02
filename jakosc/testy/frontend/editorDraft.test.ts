import test from "node:test";
import assert from "node:assert/strict";

import { shouldHydrateEditorDraft } from "../../../aplikacje/web/src/invest_analyzer/services/editorDraft.ts";

test("shouldHydrateEditorDraft hydrates only once for the same record key", () => {
  assert.equal(
    shouldHydrateEditorDraft({
      currentRecordKey: "manual-1",
      hydratedRecordKey: null,
    }),
    true,
  );

  assert.equal(
    shouldHydrateEditorDraft({
      currentRecordKey: "manual-1",
      hydratedRecordKey: "manual-1",
    }),
    false,
  );

  assert.equal(
    shouldHydrateEditorDraft({
      currentRecordKey: "manual-2",
      hydratedRecordKey: "manual-1",
    }),
    true,
  );
});

