import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider, translate, translateEngineMessage, useI18n } from "../../../aplikacje/web/src/invest_analyzer/services/i18n.tsx";

function Probe() {
  const { t, language } = useI18n();
  return <div>{language}:{t("nav.annualReport")}:{t("report.title", { year: 2025 })}</div>;
}

test("i18n tłumaczy klucze, interpoluje parametry i fallbackuje do PL", () => {
  assert.equal(translate("en", "nav.annualReport"), "Annual report");
  assert.equal(translate("pl", "nav.annualReport"), "Raport roczny");
  assert.equal(translate("en", "report.title", { year: 2025 }), "Annual Report 2025");
  assert.equal(translate("en", "language.pl"), "Polski");
  assert.equal(translate("en", "sourceTrust.activePitSource"), "Used for PIT");
  assert.equal(translate("pl", "advisorPack.title"), "Pakiet dla doradcy");
  assert.equal(translate("pl", "desktop.openStorage"), "Otwórz storage");
  assert.equal(translate("en", "desktop.openStorage"), "Open storage");
  assert.equal(translate("pl", "desktop.exportDiagnosticsSafe"), "Diagnostyka bez danych");
  assert.equal(translate("en", "desktop.exportDiagnosticsFull"), "Full local");
  assert.equal(translate("pl", "desktop.copyLegacyStorage"), "Skopiuj stare storage");
  assert.equal(translate("en", "desktop.storageMigration"), "Storage migration");
  assert.equal(translate("pl", "engineStatus.calculationRun"), "Silnik PIT liczy wynik");
  assert.equal(translate("en", "engineStatus.packageRun"), "PIT engine is generating package");
  assert.equal(translate("en", "unknown.key"), "unknown.key");
});

test("I18nProvider udostępnia język komponentom React", () => {
  const markup = renderToStaticMarkup(
    <I18nProvider language="en">
      <Probe />
    </I18nProvider>,
  );

  assert.equal(markup.includes("en:Annual report:Annual Report 2025"), true);
});

test("translateEngineMessage tłumaczy znane kody silnika", () => {
  assert.equal(
    translateEngineMessage("en", "AGGRESSIVE_PLAN_HAS_UNCERTAIN_ITEMS: Wybrany plan uwzględnia koszty dostępne tylko w wariancie agresywnym. Sprawdź ich podstawę w Dokumenty i silnik."),
    "The plan includes aggressive items requiring evidence.",
  );
  assert.equal(
    translateEngineMessage("pl", "DEPO_RECONCILIATION_SKIPPED: skipped"),
    "Pominięto depozytariusza: zakres nie pasuje do roku PIT.",
  );
});

