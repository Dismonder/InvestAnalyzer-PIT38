import type { EngineEditableRecord } from "../hooks/useTaxEngineRun";
import type { RekordEdycyjny } from "./transactionOverrides";

export type FiltrListyEdycji = "wszystkie" | "zmodyfikowane" | "nowe" | "ukryte" | "z_bledami";

export interface OpcjeFiltrowaniaRekordowEdycyjnych {
  filtr: FiltrListyEdycji;
  szukaj: string;
}

export function mapujRekordEdycyjnySilnika(record: EngineEditableRecord): RekordEdycyjny {
  return {
    baseRecordId: record.base_record_id,
    manualRecordId: record.manual_record_id,
    recordType: record.record_type as RekordEdycyjny["recordType"],
    overlayStatus: record.overlay_status as RekordEdycyjny["overlayStatus"],
    deleted: record.deleted,
    originalValues: record.original_values,
    currentValues: record.current_values,
    modifiedFields: record.modified_fields,
    validationState: {
      isValid: record.validation_state.is_valid,
      status: record.validation_state.status as RekordEdycyjny["validationState"]["status"],
      errors: record.validation_state.errors,
      warnings: record.validation_state.warnings,
    },
    diffs: record.diffs.map((diff) => ({
      fieldName: diff.field_name,
      originalValue: diff.original_value,
      currentValue: diff.current_value,
    })),
    title: record.title,
    ticker: record.ticker,
    displayDate: record.display_date,
    sourceName: record.source_name,
  };
}

function pasujeDoWyszukiwania(record: RekordEdycyjny, query: string): boolean {
  if (!query) {
    return true;
  }
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  const haystack = [
    record.title,
    record.ticker,
    record.manualRecordId,
    record.baseRecordId,
    record.sourceName,
    record.currentValues.symbol,
    record.currentValues.isin,
    record.originalValues?.isin,
    record.currentValues.comment,
    record.currentValues.message,
  ]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());
  return haystack.some((value) => value.includes(normalized));
}

function pasujeDoFiltra(record: RekordEdycyjny, filtr: FiltrListyEdycji): boolean {
  switch (filtr) {
    case "zmodyfikowane":
      return record.overlayStatus === "MODIFIED" && !record.deleted;
    case "nowe":
      return record.overlayStatus === "NEW" && !record.deleted;
    case "ukryte":
      return record.deleted;
    case "z_bledami":
      return !record.validationState.isValid || record.validationState.status === "ORPHAN";
    case "wszystkie":
    default:
      return true;
  }
}

export function filtrujRekordyEdycyjne(
  records: RekordEdycyjny[],
  options: OpcjeFiltrowaniaRekordowEdycyjnych,
): RekordEdycyjny[] {
  return [...records]
    .filter((record) => pasujeDoFiltra(record, options.filtr))
    .filter((record) => pasujeDoWyszukiwania(record, options.szukaj))
    .sort((left, right) => {
      const leftDate = left.displayDate ? Date.parse(left.displayDate) : 0;
      const rightDate = right.displayDate ? Date.parse(right.displayDate) : 0;
      if (leftDate !== rightDate) {
        return rightDate - leftDate;
      }
      return left.manualRecordId.localeCompare(right.manualRecordId);
    });
}

export function etykietaStatusuNakladki(record: RekordEdycyjny): string {
  if (record.deleted) {
    return "Ukryta";
  }
  if (record.overlayStatus === "NEW") {
    return "Nowa";
  }
  if (record.overlayStatus === "MODIFIED") {
    return "Zmieniona";
  }
  return "Z silnika";
}

export function etykietaTypuRekordu(recordType: RekordEdycyjny["recordType"]): string {
  switch (recordType) {
    case "TRADE":
      return "Transakcja giełdowa";
    case "EVENT":
      return "Zdarzenie rachunkowe";
    case "BONUS_CONTEST_SHARE":
      return "Akcja bonusowa";
    default:
      return recordType;
  }
}
