import type { PitCaseFile } from "../hooks/useTaxEngineRun";
import type {
  TaxYearClosure,
  TaxYearClosureChangedDetail,
  TaxYearClosureStatus,
} from "./yearClosure";

export interface TaxYearClosureAuditExport {
  exportKind: "tax_year_closure_audit";
  generatedAt: string;
  taxYear: number;
  status: TaxYearClosureStatus["status"];
  statusLabel: string;
  recommendation: string;
  changedFields: string[];
  changedDetails: TaxYearClosureChangedDetail[];
  closedSnapshot: {
    caseFileId: string;
    generatedAt: string;
    planUsed: string | null;
    auditHash: string | null;
    inputFingerprint: string;
    calculationFingerprint: string;
    closureHash: string;
    packageSections: Record<string, number>;
    includedArtifacts: string[];
  };
  currentCaseFile: {
    caseFileId: string;
    generatedAt: string;
    planUsed: string | null;
    auditHash: string | null;
    inputFingerprint: string;
    calculationFingerprint: string;
  } | null;
  decisions: TaxYearClosure["decisions"];
}

export function buildTaxYearClosureAuditExport(input: {
  closure: TaxYearClosure;
  currentCaseFile?: PitCaseFile | null;
  status: TaxYearClosureStatus;
  generatedAt?: string;
}): TaxYearClosureAuditExport {
  const { closure, currentCaseFile = null, status } = input;
  const recommendation =
    status.status === "changed_after_close"
      ? "Wygeneruj nowy pakiet i zamknij rok ponownie, jeśli bieżące dane mają być podstawą złożenia PIT."
      : status.isReadOnly
        ? "Rok jest zamknięty. Zachowaj ten plik razem z pakietem PIT jako lokalny ślad decyzji."
        : "Rok jest otwarty do pracy. Zamknij rok dopiero po finalnej kontroli danych i pakietu PIT.";

  return {
    exportKind: "tax_year_closure_audit",
    generatedAt: input.generatedAt || new Date().toISOString(),
    taxYear: closure.taxYear,
    status: status.status,
    statusLabel: status.label,
    recommendation,
    changedFields: status.changedFields,
    changedDetails: status.changedDetails,
    closedSnapshot: {
      caseFileId: closure.snapshot.caseFileId,
      generatedAt: closure.snapshot.generatedAt,
      planUsed: closure.snapshot.planUsed,
      auditHash: closure.snapshot.auditHash,
      inputFingerprint: closure.snapshot.inputFingerprint,
      calculationFingerprint: closure.snapshot.calculationFingerprint,
      closureHash: closure.snapshot.closureHash,
      packageSections: closure.snapshot.packageSections,
      includedArtifacts: closure.snapshot.includedArtifacts,
    },
    currentCaseFile: currentCaseFile
      ? {
          caseFileId: currentCaseFile.case_file_id,
          generatedAt: currentCaseFile.generated_at,
          planUsed: currentCaseFile.plan_used || null,
          auditHash: currentCaseFile.audit_hash || null,
          inputFingerprint: currentCaseFile.input_fingerprint,
          calculationFingerprint: currentCaseFile.calculation_fingerprint,
        }
      : null,
    decisions: closure.decisions,
  };
}

export function downloadTaxYearClosureAuditExport(payload: TaxYearClosureAuditExport): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `audyt-zamkniecia-roku-${payload.taxYear}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
}
