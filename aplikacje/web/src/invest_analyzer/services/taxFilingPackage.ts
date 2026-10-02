import { runtimeApi } from './runtimeApi';

export type TaxPackageScope = "numbers_only" | "with_calculation" | "with_justification" | "full";

export interface TaxPackageScopeOption {
  value: TaxPackageScope;
  label: string;
  description: string;
}

const TAX_PACKAGE_SCOPE_OPTIONS: TaxPackageScopeOption[] = [
  {
    value: "numbers_only",
    label: "Tylko liczby",
    description: "Draft z podstawowymi liczbami i polami do przepisania.",
  },
  {
    value: "with_calculation",
    label: "Liczby + kalkulacja",
    description: "Draft plus rozpiska obliczeń.",
  },
  {
    value: "with_justification",
    label: "Liczby + kalkulacja + uzasadnienie",
    description: "Draft, kalkulacja i memorandum decyzji kosztowych.",
  },
  {
    value: "full",
    label: "Pełny pakiet",
    description: "Draft, kalkulacja, uzasadnienie i komplet artefaktów audytowych.",
  },
];

export function getPackageScopeOptions(): TaxPackageScopeOption[] {
  return [...TAX_PACKAGE_SCOPE_OPTIONS];
}

export function isDownloadableTaxArtifact(filePath: string): boolean {
  return (
    filePath.endsWith("tax_report.xlsx") ||
    filePath.endsWith("tax_filing_package.json") ||
    filePath.endsWith("artifacts_manifest.json") ||
    filePath.endsWith("advisor_review_pack.json") ||
    filePath.endsWith("tax_advisor_brief.md") ||
    filePath.endsWith("tax_advisor_brief.html") ||
    filePath.endsWith("evidence_checklist.json") ||
    filePath.endsWith("evidence_checklist.xlsx")
  );
}

export function getTaxArtifactLabel(filePath: string): string {
  if (filePath.endsWith("tax_report.xlsx")) {
    return "Pobierz workbook XLSX";
  }
  if (filePath.endsWith("tax_filing_package.json")) {
    return "Pobierz JSON pakietu";
  }
  if (filePath.endsWith("artifacts_manifest.json")) {
    return "Pobierz manifest artefaktów";
  }
  if (filePath.endsWith("advisor_review_pack.json")) {
    return "Pobierz pakiet dla doradcy JSON";
  }
  if (filePath.endsWith("tax_advisor_brief.md")) {
    return "Pobierz brief doradcy Markdown";
  }
  if (filePath.endsWith("tax_advisor_brief.html")) {
    return "Pobierz brief doradcy HTML";
  }
  if (filePath.endsWith("evidence_checklist.json")) {
    return "Pobierz checklistę dowodów JSON";
  }
  if (filePath.endsWith("evidence_checklist.xlsx")) {
    return "Pobierz checklistę dowodów XLSX";
  }
  return "Pobierz artefakt";
}

export function selectPrimaryPackageArtifact(
  exportedFiles: string[],
  scope: TaxPackageScope | string,
): string | null {
  const filingJson = exportedFiles.find((file) => file.endsWith("tax_filing_package.json"));
  const workbook = exportedFiles.find((file) => file.endsWith("tax_report.xlsx"));

  if (scope === "full") {
    return workbook || filingJson || null;
  }
  return filingJson || workbook || null;
}

export async function downloadTaxEngineArtifact(filePath: string): Promise<void> {
  await runtimeApi.downloadArtifact(filePath);
}
