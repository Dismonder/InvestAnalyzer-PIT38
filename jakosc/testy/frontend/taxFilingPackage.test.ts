import test from "node:test";
import assert from "node:assert/strict";

import {
  getTaxArtifactLabel,
  getPackageScopeOptions,
  isDownloadableTaxArtifact,
  selectPrimaryPackageArtifact,
} from "../../../aplikacje/web/src/invest_analyzer/services/taxFilingPackage.ts";

test("package scope options expose all supported downloadable package variants", () => {
  const options = getPackageScopeOptions();

  assert.deepEqual(
    options.map((option) => option.value),
    ["numbers_only", "with_calculation", "with_justification", "full"],
  );
});

test("selectPrimaryPackageArtifact prefers filing JSON for partial packages and workbook for full package", () => {
  const files = [
    "C:/tmp/investment-tax-engine-dev-runtime/tax_report.xlsx",
    "C:/tmp/investment-tax-engine-dev-runtime/audit/tax_filing_package.json",
    "C:/tmp/investment-tax-engine-dev-runtime/audit/artifacts_manifest.json",
  ];

  assert.equal(
    selectPrimaryPackageArtifact(files, "numbers_only"),
    "C:/tmp/investment-tax-engine-dev-runtime/audit/tax_filing_package.json",
  );
  assert.equal(
    selectPrimaryPackageArtifact(files, "with_calculation"),
    "C:/tmp/investment-tax-engine-dev-runtime/audit/tax_filing_package.json",
  );
  assert.equal(
    selectPrimaryPackageArtifact(files, "full"),
    "C:/tmp/investment-tax-engine-dev-runtime/tax_report.xlsx",
  );
});

test("downloadable package artifacts include advisor and evidence exports", () => {
  const downloadable = [
    "C:/tmp/out/tax_report.xlsx",
    "C:/tmp/out/audit/tax_filing_package.json",
    "C:/tmp/out/audit/artifacts_manifest.json",
    "C:/tmp/out/advisor_review_pack.json",
    "C:/tmp/out/tax_advisor_brief.md",
    "C:/tmp/out/tax_advisor_brief.html",
    "C:/tmp/out/evidence_checklist.json",
    "C:/tmp/out/evidence_checklist.xlsx",
  ];

  for (const file of downloadable) {
    assert.equal(isDownloadableTaxArtifact(file), true, file);
    assert.notEqual(getTaxArtifactLabel(file), "Pobierz artefakt", file);
  }
  assert.equal(isDownloadableTaxArtifact("C:/tmp/out/internal_debug.log"), false);
});

