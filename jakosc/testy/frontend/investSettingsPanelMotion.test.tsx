import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { InvestSettingsPanel } from "../../../aplikacje/web/src/invest_analyzer/components/InvestSettingsPanel.tsx";

test("InvestSettingsPanel ma animowany launcher ustawień bez otwierania panelu", () => {
  const markup = renderToStaticMarkup(
    <InvestSettingsPanel
      onClearData={() => undefined}
      files={[]}
      logs={[]}
      onReload={() => undefined}
      onValidate={() => undefined}
    />,
  );

  assert.equal(markup.includes('data-motion="settings-launcher"'), true);
});

