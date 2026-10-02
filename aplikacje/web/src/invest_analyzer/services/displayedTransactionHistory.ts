import type { EngineEditableRecord, EngineHistoryRow, PrivateCashFxViewRow } from "../hooks/useTaxEngineRun";

export type DisplayedHistoryRow = EngineHistoryRow;

export type HistoryTaxImpactKind =
  | "PIT_COUNTED"
  | "SCENARIO_COST"
  | "TECHNICAL_ONLY"
  | "REVIEW_REQUIRED"
  | "ANALYTICAL_ONLY"
  | "CANDIDATE_PREVIEW"
  | "SUPPLEMENTAL"
  | "RECONCILIATION"
  | "EVIDENCE";

export type HistoryTaxImpactFilterId = "all" | "pit_counted" | "scenario_cost" | "technical" | "review" | "analytical";

export type HistoryDefenseStatusFilterId =
  | "all"
  | "complete"
  | "needs_user_evidence"
  | "missing_link"
  | "high_risk_review"
  | "unknown";

export type HistoryViewModeId =
  | "investment"
  | "costs"
  | "cash_fx"
  | "position_check"
  | "evidence"
  | "technical"
  | "all"
  | "tax"
  | "candidate"
  | "supplemental"
  | "reconciliation"
  | "fix"
  | "import_actions";

export interface DisplayedHistoryRowPresentation {
  taxImpactKind: HistoryTaxImpactKind;
  taxImpactLabel: string;
  isTechnicalOnly: boolean;
  statusLabel: string;
  editabilityLabel: string;
}

export const HISTORY_TAX_IMPACT_FILTER_OPTIONS: Array<{ id: HistoryTaxImpactFilterId; label: string }> = [
  { id: "all", label: "Wszystkie" },
  { id: "pit_counted", label: "Liczone w PIT" },
  { id: "scenario_cost", label: "Koszty/scenariusze" },
  { id: "technical", label: "Techniczne" },
  { id: "review", label: "Do sprawdzenia" },
  { id: "analytical", label: "Analityczne" },
];

export const HISTORY_DEFENSE_STATUS_FILTER_OPTIONS: Array<{ id: HistoryDefenseStatusFilterId; label: string }> = [
  { id: "all", label: "Wszystkie" },
  { id: "complete", label: "Kompletne" },
  { id: "needs_user_evidence", label: "Wymaga dowodu" },
  { id: "missing_link", label: "Brak powiązania" },
  { id: "high_risk_review", label: "Wysokie ryzyko" },
  { id: "unknown", label: "Bez statusu" },
];

export const HISTORY_VIEW_MODE_OPTIONS: Array<{ id: HistoryViewModeId; label: string; description: string }> = [
  {
    id: "investment",
    label: "Inwestycyjne",
    description: "Normalne operacje inwestycyjne: kupno, sprzedaż, dywidendy i zdarzenia rynkowe.",
  },
  {
    id: "costs",
    label: "Koszty i opłaty",
    description: "Prowizje, odsetki, opłaty i potencjalne koszty podatkowe.",
  },
  {
    id: "cash_fx",
    label: "Gotówka/FX",
    description: "Ruchy gotówkowe, przelewy, zasilenia i przewalutowania.",
  },
  {
    id: "position_check",
    label: "Kontrola pozycji",
    description: "Dane depozytariusza i rekordy kontrolne pozycji.",
  },
  {
    id: "tax",
    label: "Podatkowo",
    description: "Transakcje, koszty scenariuszy i rekordy wymagające decyzji podatkowej.",
  },
  {
    id: "candidate",
    label: "Nowe pliki",
    description: "Podgląd transakcji z nowych plików-kandydatów. Nie wpływa na PIT.",
  },
  {
    id: "supplemental",
    label: "Pomocnicze",
    description: "Cash flow, arkusze pomocnicze i rekordy doprecyzowujące storage.",
  },
  {
    id: "reconciliation",
    label: "Kontrola",
    description: "Pozycje depozytariusza i rekordy kontroli pozycji.",
  },
  {
    id: "evidence",
    label: "Dowodowo",
    description: "Pozycje mające status dowodowy lub wymagające uzupełnienia obrony PIT.",
  },
  {
    id: "technical",
    label: "Technicznie",
    description: "Ruchy techniczne i analityczne, które nie są zwykłymi transakcjami PIT.",
  },
  {
    id: "all",
    label: "Wszystkie ze storage",
    description: "Pełny widok kanonicznej historii z całego folderu storage.",
  },
  {
    id: "fix",
    label: "Do naprawy",
    description: "Tylko rekordy wymagające decyzji, dowodu albo wyjaśnienia przed PIT.",
  },
  {
    id: "import_actions",
    label: "Sprawy importu",
    description: "Rekordy powiązane z kolejką akcji importu plików brokera.",
  },
];

export interface BuildDisplayedTransactionHistoryRowsInput {
  engineHistoryRows: EngineHistoryRow[];
  privateCashFxViewRows: PrivateCashFxViewRow[];
  editableRecords?: EngineEditableRecord[];
}

function stableHash(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  }
  return Math.abs(hash >>> 0).toString(36);
}

function buildPrivateCashFxRowId(row: PrivateCashFxViewRow): string {
  const stableKey = [
    row.row_id,
    row.source_event_id,
    row.use_reference,
    row.currency,
    row.quantity,
    row.pnl_pln,
    row.use_date || row.source_date || "",
  ]
    .filter(Boolean)
    .join(":");
  return `fx:${stableHash(stableKey)}`;
}

function parseNumber(value?: string | number | null): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const normalized = String(value).replace(/\s/g, "").replace(",", ".");
  // `Number("")` to 0: wartosc zlozona z samych spacji pokazywala sie jako
  // "0,00 PLN" zamiast myslnika.
  if (!normalized) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasExplicitSourceTime(value?: string | null): boolean {
  if (!value) {
    return false;
  }
  return /T\d{2}:\d{2}/.test(value) || /\s\d{2}:\d{2}/.test(value);
}

export function formatDisplayDateTime(value?: string | null): string {
  if (!value) {
    return "-";
  }
  // Sama data (RRRR-MM-DD) to data kalendarzowa - parsowana jako polnoc UTC
  // pokazywala sie w strefie za Greenwich jako poprzedni dzien, a 1 stycznia
  // wygladal na wiersz z poprzedniego roku.
  const samaData = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (samaData) {
    return `${samaData[3]}.${samaData[2]}.${samaData[1]}`;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  const date = new Intl.DateTimeFormat("pl-PL", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(parsed);
  if (!hasExplicitSourceTime(value)) {
    return date;
  }
  const time = new Intl.DateTimeFormat("pl-PL", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(parsed);
  return `${date} ${time}`;
}

export function formatQuantity(value?: string | number | null): string {
  const parsed = parseNumber(value);
  if (parsed === null) {
    return value === null || value === undefined || value === "" ? "-" : String(value);
  }
  return new Intl.NumberFormat("pl-PL", {
    maximumFractionDigits: 8,
  }).format(parsed);
}

export function formatMoney(value?: string | number | null, currency = "PLN"): string {
  const parsed = parseNumber(value);
  if (parsed === null) {
    // Wartosc z samych spacji to brak kwoty, a nie tekst do przepisania -
    // w tabeli zostawala pusta komorka bez znaku braku danych.
    return value === null || value === undefined || String(value).trim() === "" ? "-" : String(value);
  }
  const sign = parsed < 0 ? "-" : "";
  // toFixed na liczbie binarnej zaokraglal 1.005 do 1.00; najpierw usuwamy blad
  // reprezentacji (15 cyfr znaczacych), potem zaokraglamy polowke w gore.
  const grosze = Math.round(Number((Math.abs(parsed) * 100).toPrecision(15)));
  const [integerPart, decimalPart] = (grosze / 100).toFixed(2).split(".");
  const groupedInteger = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${sign}${groupedInteger},${decimalPart} ${currency}`;
}

function buildEditableRecordMap(editableRecords: EngineEditableRecord[] = []): Map<string, EngineEditableRecord> {
  const map = new Map<string, EngineEditableRecord>();
  for (const record of editableRecords) {
    map.set(record.manual_record_id, record);
    if (record.base_record_id) {
      map.set(record.base_record_id, record);
    }
  }
  return map;
}

function buildSearchText(row: EngineHistoryRow, status: string): string {
  return [
    row.ticker,
    row.transaction_id,
    row.manual_record_id,
    row.base_record_id,
    row.comment,
    row.message,
    row.source_name,
    row.source_manifest_id,
    row.conflict_count,
    row.tax_impact_label,
    row.tax_impact_kind,
    row.tax_impact_label_pl,
    row.row_kind,
    row.logical_world,
    row.currency,
    row.amount,
    row.amount_pln,
    status,
    row.details ? JSON.stringify(row.details) : "",
    formatDisplayDateTime(row.display_date || null),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function textFromDetails(details: Record<string, unknown> | undefined, keys: string[]): string | null {
  if (!details) {
    return null;
  }
  for (const key of keys) {
    const value = details[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function booleanFromDetails(details: Record<string, unknown> | undefined, key: string): boolean | null {
  if (!details || typeof details[key] !== "boolean") {
    return null;
  }
  return details[key] as boolean;
}

function isGenericLongTermToken(value?: string | null): boolean {
  return (value || "").trim().toUpperCase() === "LONG-TERM";
}

export function getHistoryInstrumentDisplay(row: Pick<EngineHistoryRow, "ticker" | "transaction_id" | "details">): {
  primary: string;
  secondary: string;
} {
  const detailInstrument = textFromDetails(row.details, [
    "instrument_name",
    "security_name",
    "asset_name",
    "full_name",
    "name",
    "ticker_original",
    "symbol",
    "isin",
  ]);
  const ticker = row.ticker?.trim() || "";
  const transactionId = row.transaction_id?.trim() || "-";

  if (isGenericLongTermToken(ticker)) {
    const candidate = detailInstrument && !isGenericLongTermToken(detailInstrument)
      ? detailInstrument
      : "Instrument długoterminowy";
    return {
      primary: candidate,
      secondary: transactionId,
    };
  }

  return {
    primary: ticker || detailInstrument || "-",
    secondary: transactionId,
  };
}

function normalizeTaxImpactKind(value?: unknown): HistoryTaxImpactKind | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.toUpperCase();
  return [
    "PIT_COUNTED",
    "SCENARIO_COST",
    "TECHNICAL_ONLY",
    "REVIEW_REQUIRED",
    "ANALYTICAL_ONLY",
    "CANDIDATE_PREVIEW",
    "SUPPLEMENTAL",
    "RECONCILIATION",
    "EVIDENCE",
  ].includes(normalized)
    ? (normalized as HistoryTaxImpactKind)
    : null;
}

function normalizeDefenseStatus(value?: unknown): Exclude<HistoryDefenseStatusFilterId, "all" | "unknown"> | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.toLowerCase();
  return ["complete", "needs_user_evidence", "missing_link", "high_risk_review"].includes(normalized)
    ? (normalized as Exclude<HistoryDefenseStatusFilterId, "all" | "unknown">)
    : null;
}

function defenseStatusFromRow(row: EngineHistoryRow): Exclude<HistoryDefenseStatusFilterId, "all"> {
  return (
    normalizeDefenseStatus(row.defense_status) ||
    normalizeDefenseStatus(row.details?.defense_status) ||
    "unknown"
  );
}

function displayCategoryFromRow(row: EngineHistoryRow): string {
  return String(row.display_category || row.details?.display_category || "").toLowerCase();
}

function taxImpactKindFromLegacyFields(row: EngineHistoryRow): HistoryTaxImpactKind {
  const explicit =
    normalizeTaxImpactKind(row.tax_impact_kind) ||
    normalizeTaxImpactKind(row.details?.tax_impact_kind);
  if (explicit) {
    return explicit;
  }
  if (row.is_technical_only === true || booleanFromDetails(row.details, "is_technical_only") === true) {
    return "TECHNICAL_ONLY";
  }

  const rowKind = (row.row_kind || "").toUpperCase();
  const eventKind = textFromDetails(row.details, ["event_kind"])?.toUpperCase() || "";
  const logicalWorld = (row.logical_world || "").toLowerCase();
  const costBucket = textFromDetails(row.details, ["cost_bucket"])?.toUpperCase() || "";
  const legacyLabel = `${row.tax_impact_label || ""} ${textFromDetails(row.details, ["tax_impact_label"]) || ""}`.toLowerCase();

  if (["REVIEW_REQUIRED", "CORPORATE_ACTION", "SECURITY_EVENT"].includes(rowKind) || eventKind === "REVIEW_REQUIRED") {
    return "REVIEW_REQUIRED";
  }
  if (
    rowKind === "ALLOCATED_COST" ||
    ["TRADE_FEE", "NEGATIVE_CASH_FEE", "FUNDING_TRANSFER_FEE"].includes(rowKind) ||
    ["TRADE_COMMISSION", "NEGATIVE_BALANCE_INTEREST", "FUNDING_TRANSFER_FEE", "SOURCE_TAX"].includes(costBucket) ||
    legacyLabel.includes("koszt wpływa")
  ) {
    return "SCENARIO_COST";
  }
  if (rowKind === "TRADE" && logicalWorld !== "diagnostic_only") {
    return "PIT_COUNTED";
  }
  if (
    ["CASH_MOVEMENT", "BLOCK", "UNBLOCK", "INTERNAL_TRANSFER", "BANK_TRANSFER", "DEPOSIT", "WITHDRAWAL", "FINANCING_REPAYMENT"].includes(rowKind) ||
    ["CASH_MOVEMENT", "BLOCK", "UNBLOCK", "INTERNAL_TRANSFER", "BANK_TRANSFER", "DEPOSIT", "WITHDRAWAL"].includes(eventKind) ||
    ["diagnostic_only", "cash_movement", "financing_repayment"].includes(logicalWorld) ||
    legacyLabel.includes("bez automatycznego wpływu") ||
    legacyLabel.includes("bez bezpośredniego wpływu")
  ) {
    return "TECHNICAL_ONLY";
  }
  if (rowKind === "PRIVATE_CASH_FX" || logicalWorld === "private_cash_fx") {
    return "ANALYTICAL_ONLY";
  }
  if (legacyLabel.includes("wymaga klasyfikacji") || legacyLabel.includes("do sprawdzenia")) {
    return "REVIEW_REQUIRED";
  }
  if (
    rowKind === "TRADE" ||
    ["DIVIDEND", "TAX", "SOURCE_TAX", "BONUS_CONTEST_SHARE"].includes(rowKind) ||
    ["equity_tax", "dividend_tax", "foreign_dividend", "source_tax"].includes(logicalWorld) ||
    legacyLabel.includes("wpływa na rozliczenie pit")
  ) {
    return "PIT_COUNTED";
  }
  return "REVIEW_REQUIRED";
}

function labelForTaxImpactKind(kind: HistoryTaxImpactKind): string {
  return {
    PIT_COUNTED: "Rekord obliczeniowy",
    SCENARIO_COST: "Koszt w scenariuszach",
    TECHNICAL_ONLY: "Techniczne",
    REVIEW_REQUIRED: "Do sprawdzenia",
    ANALYTICAL_ONLY: "Analityczne",
    CANDIDATE_PREVIEW: "Podgląd rekordu",
    SUPPLEMENTAL: "Pomocniczy",
    RECONCILIATION: "Kontrola pozycji",
    EVIDENCE: "Dowód / analityka",
  }[kind];
}

export function getDisplayedHistoryRowPresentation(row: EngineHistoryRow, canEditOverride?: boolean): DisplayedHistoryRowPresentation {
  const taxImpactKind = taxImpactKindFromLegacyFields(row);
  const taxImpactLabel =
    row.tax_impact_label_pl ||
    textFromDetails(row.details, ["tax_impact_label_pl"]) ||
    labelForTaxImpactKind(taxImpactKind);
  const isEngineChild = Boolean(row.parent_row_id || row.details?.is_engine_child);
  const canEdit = canEditOverride ?? row.details?.can_edit === true;
  const readOnlyReason = textFromDetails(row.details, ["read_only_reason"]);
  const editabilityLabel = canEdit
    ? "Można edytować"
    : isEngineChild
      ? "Wiersz pochodny z silnika"
      : readOnlyReason || "Tylko podgląd";
  return {
    taxImpactKind,
    taxImpactLabel,
    isTechnicalOnly: taxImpactKind === "TECHNICAL_ONLY",
    statusLabel: taxImpactLabel,
    editabilityLabel,
  };
}

function enrichEngineHistoryRow(row: EngineHistoryRow, editableMap: Map<string, EngineEditableRecord>): DisplayedHistoryRow {
  const editableRecord =
    (row.manual_record_id ? editableMap.get(row.manual_record_id) : undefined) ||
    (row.base_record_id ? editableMap.get(row.base_record_id) : undefined) ||
    (row.transaction_id ? editableMap.get(row.transaction_id) : undefined);
  const isEngineChild = Boolean(row.parent_row_id);
  const canEdit = Boolean(editableRecord && !editableRecord.deleted && !isEngineChild);
  const readOnly = !canEdit;
  const rowWithEditability: EngineHistoryRow = {
    ...row,
    read_only: readOnly,
    details: {
      ...row.details,
      can_edit: canEdit,
      is_engine_child: isEngineChild,
    },
  };
  const presentation = getDisplayedHistoryRowPresentation(rowWithEditability, canEdit);
  const status = presentation.statusLabel;
  return {
    ...row,
    read_only: readOnly,
    tax_impact_kind: presentation.taxImpactKind,
    is_technical_only: presentation.isTechnicalOnly,
    tax_impact_label_pl: presentation.taxImpactLabel,
    details: {
      ...row.details,
      can_edit: canEdit,
      edit_record_id: editableRecord?.manual_record_id || row.manual_record_id || row.base_record_id || null,
      ui_status: status,
      status_label: presentation.statusLabel,
      editability_label: presentation.editabilityLabel,
      tax_impact_kind: presentation.taxImpactKind,
      is_technical_only: presentation.isTechnicalOnly,
      tax_impact_label_pl: presentation.taxImpactLabel,
      display_category: row.display_category || row.details?.display_category || null,
      display_category_label_pl: row.display_category_label_pl || row.details?.display_category_label_pl || null,
      display_category_label_en: row.display_category_label_en || row.details?.display_category_label_en || null,
      lineage_summary: row.lineage_summary || row.details?.lineage_summary || null,
      dedupe_status: row.dedupe_status || row.details?.dedupe_status || null,
      is_engine_child: isEngineChild,
      read_only_reason: readOnly ? (isEngineChild ? "Wiersz pochodny z silnika" : "Brak dopasowanego rekordu edycji") : null,
      display_date_time: formatDisplayDateTime(row.display_date || null),
      has_source_time: hasExplicitSourceTime(row.display_date || null),
      source_manifest_id: row.source_manifest_id || row.details?.source_manifest_id || null,
      // Brak licznika w wyniku silnika to nie jest zero konfliktow - ekran
      // pokazuje wtedy myslnik, a nie potwierdzenie braku problemow.
      conflict_count: row.conflict_count ?? row.details?.conflict_count ?? null,
      tax_impact_label: row.tax_impact_label || row.details?.tax_impact_label || null,
      search_text: buildSearchText(row, status),
    },
  };
}

export function mapPrivateCashFxViewRowsToHistoryRows(
  rows: PrivateCashFxViewRow[],
): DisplayedHistoryRow[] {
  return rows.map((row) => {
    const displayDate = row.use_date || row.source_date || null;
    const historyRow: DisplayedHistoryRow = {
    row_id: buildPrivateCashFxRowId(row),
    parent_row_id: null,
    row_kind: "PRIVATE_CASH_FX",
    display_date: displayDate,
    transaction_id: row.use_reference || row.source_event_id,
    ticker: row.currency,
    quantity: row.quantity,
    amount: row.quantity,
    currency: row.currency,
    amount_pln: row.pnl_pln,
    comment: row.note || null,
    message: row.note || null,
    source_name: "Przewalutowanie",
    source_refs: [row.source_event_id, row.use_reference].filter(Boolean),
    logical_world: "private_cash_fx",
    read_only: true,
    details: {
      ui_row_source: "private_cash_fx_view",
      can_edit: false,
      ui_status: "Analityczne - nie wpływa na PIT",
      status_label: "Analityczne - nie wpływa na PIT",
      editability_label: "Tylko podgląd",
      tax_impact_kind: "ANALYTICAL_ONLY",
      is_technical_only: false,
      tax_impact_label_pl: "Analityczne - nie wpływa na PIT",
      read_only_reason: "Syntetyczny wiersz prezentacyjny FX",
      display_date_time: formatDisplayDateTime(displayDate),
      has_source_time: hasExplicitSourceTime(displayDate),
      source_event_id: row.source_event_id,
      use_reference: row.use_reference,
      source_fx_rate: row.source_fx_rate,
      use_fx_rate: row.use_fx_rate,
      source_date: row.source_date || null,
      use_date: row.use_date || null,
      pnl_pln: row.pnl_pln,
      note: row.note || null,
    },
  };
    return {
      ...historyRow,
      tax_impact_kind: "ANALYTICAL_ONLY",
      is_technical_only: false,
      tax_impact_label_pl: "Analityczne - nie wpływa na PIT",
      details: {
        ...historyRow.details,
        search_text: buildSearchText(historyRow, "Analityczne - nie wpływa na PIT"),
      },
    };
  });
}

export function buildDisplayedTransactionHistoryRows(
  input: BuildDisplayedTransactionHistoryRowsInput,
): DisplayedHistoryRow[] {
  const editableMap = buildEditableRecordMap(input.editableRecords || []);
  return [
    ...input.engineHistoryRows.map((row) => enrichEngineHistoryRow(row, editableMap)),
    ...mapPrivateCashFxViewRowsToHistoryRows(input.privateCashFxViewRows),
  ];
}

export function isPinnableHistoryRow(row: Pick<EngineHistoryRow, "parent_row_id" | "row_kind">): boolean {
  return row.parent_row_id == null && row.row_kind !== "PRIVATE_CASH_FX" && row.row_kind !== "ALLOCATED_COST";
}

export function isCandidatePreviewHistoryRow(row: EngineHistoryRow): boolean {
  return row.row_kind === "CANDIDATE_PREVIEW" || row.tax_impact_kind === "CANDIDATE_PREVIEW" || row.details?.candidate_preview === true;
}

export function matchesHistoryTaxImpactFilter(row: EngineHistoryRow, filterId: HistoryTaxImpactFilterId): boolean {
  if (filterId === "all") {
    return true;
  }
  const kind = getDisplayedHistoryRowPresentation(row).taxImpactKind;
  return (
    (filterId === "pit_counted" && kind === "PIT_COUNTED") ||
    (filterId === "scenario_cost" && kind === "SCENARIO_COST") ||
    (filterId === "technical" && kind === "TECHNICAL_ONLY") ||
    (filterId === "review" && kind === "REVIEW_REQUIRED") ||
    (filterId === "analytical" && kind === "ANALYTICAL_ONLY")
  );
}

export function matchesHistoryDefenseStatusFilter(row: EngineHistoryRow, filterId: HistoryDefenseStatusFilterId): boolean {
  if (filterId === "all") {
    return true;
  }
  return defenseStatusFromRow(row) === filterId;
}

export function matchesHistoryViewMode(row: EngineHistoryRow, modeId: HistoryViewModeId): boolean {
  if (modeId === "all") {
    return true;
  }
  const kind = getDisplayedHistoryRowPresentation(row).taxImpactKind;
  const defenseStatus = defenseStatusFromRow(row);
  const category = displayCategoryFromRow(row);
  if (modeId === "investment") {
    return (
      category === "investment" ||
      category === "dividend" ||
      (
        !category &&
        !isCandidatePreviewHistoryRow(row) &&
        (kind === "PIT_COUNTED" || kind === "SCENARIO_COST" || kind === "REVIEW_REQUIRED")
      )
    );
  }
  if (modeId === "costs") {
    return category === "fee_cost" || kind === "SCENARIO_COST";
  }
  if (modeId === "cash_fx") {
    return (
      category === "cash_flow" ||
      category === "fx" ||
      (defenseStatus === "unknown" && (row.row_kind === "PRIVATE_CASH_FX" || row.logical_world === "private_cash_fx"))
    );
  }
  if (modeId === "position_check") {
    return category === "position_check" || kind === "RECONCILIATION" || row.details?.storage_role === "reconciliation";
  }
  if (modeId === "tax") {
    return kind === "PIT_COUNTED" || kind === "SCENARIO_COST" || kind === "REVIEW_REQUIRED";
  }
  if (modeId === "candidate") {
    return isCandidatePreviewHistoryRow(row);
  }
  if (modeId === "supplemental") {
    return kind === "SUPPLEMENTAL" || row.details?.storage_role === "supplemental";
  }
  if (modeId === "reconciliation") {
    return kind === "RECONCILIATION" || row.details?.storage_role === "reconciliation";
  }
  if (modeId === "evidence") {
    return category === "evidence" || category === "analytics" || kind === "EVIDENCE" || defenseStatus !== "unknown";
  }
  if (modeId === "technical") {
    return category === "technical" || (defenseStatus === "unknown" && (kind === "TECHNICAL_ONLY" || kind === "ANALYTICAL_ONLY"));
  }
  if (modeId === "fix") {
    const rowWithEvidence = row as EngineHistoryRow & {
      missing_evidence_count?: number | string | null;
      details?: { missing_evidence_count?: number | string | null };
    };
    const missingEvidenceCount = Number(
      rowWithEvidence.missing_evidence_count ?? rowWithEvidence.details?.missing_evidence_count ?? 0,
    );
    return (
      kind === "REVIEW_REQUIRED" ||
      defenseStatus === "needs_user_evidence" ||
      defenseStatus === "missing_link" ||
      defenseStatus === "high_risk_review" ||
      missingEvidenceCount > 0
    );
  }
  if (modeId === "import_actions") {
    return false;
  }
  return false;
}

export function getVisibleHistoryTaxImpactFilterOptions(rows: EngineHistoryRow[]): Array<{ id: HistoryTaxImpactFilterId; label: string }> {
  const visibleKinds = new Set(rows.map((row) => getDisplayedHistoryRowPresentation(row).taxImpactKind));
  return HISTORY_TAX_IMPACT_FILTER_OPTIONS.filter((option) => {
    if (option.id === "all") {
      return true;
    }
    return (
      (option.id === "pit_counted" && visibleKinds.has("PIT_COUNTED")) ||
      (option.id === "scenario_cost" && visibleKinds.has("SCENARIO_COST")) ||
      (option.id === "technical" && visibleKinds.has("TECHNICAL_ONLY")) ||
      (option.id === "review" && visibleKinds.has("REVIEW_REQUIRED")) ||
      (option.id === "analytical" && visibleKinds.has("ANALYTICAL_ONLY"))
    );
  });
}

export function getVisibleHistoryDefenseStatusFilterOptions(rows: EngineHistoryRow[]): Array<{ id: HistoryDefenseStatusFilterId; label: string }> {
  const visibleStatuses = new Set(rows.map((row) => defenseStatusFromRow(row)));
  return HISTORY_DEFENSE_STATUS_FILTER_OPTIONS.filter((option) => option.id === "all" || visibleStatuses.has(option.id as Exclude<HistoryDefenseStatusFilterId, "all">));
}

export function getVisibleHistoryViewModeOptions(rows: EngineHistoryRow[]): Array<{ id: HistoryViewModeId; label: string; description: string }> {
  return HISTORY_VIEW_MODE_OPTIONS.filter((option) => option.id === "all" || rows.some((row) => matchesHistoryViewMode(row, option.id)));
}

export function buildDisplayedHistoryDiagnostics(input: {
  displayedRows: DisplayedHistoryRow[];
  privateCashFxViewRows: PrivateCashFxViewRow[];
  editableRecords: EngineEditableRecord[];
  pinnedChildRowIds?: string[];
}): string[] {
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const row of input.displayedRows) {
    if (seen.has(row.row_id)) {
      warnings.push(`duplicate rowId detected: ${row.row_id}`);
    }
    seen.add(row.row_id);
  }

  const fxRows = input.displayedRows.filter((row) => row.row_kind === "PRIVATE_CASH_FX");
  if (input.privateCashFxViewRows.length > 0 && fxRows.length === 0) {
    warnings.push(`private_cash_fx_view ma ${input.privateCashFxViewRows.length} rekordów, ale UI wygenerował 0 wierszy Przewalutowania`);
  }

  const editableRows = input.displayedRows.filter((row) => row.details?.can_edit === true);
  if (input.editableRecords.length > 0 && editableRows.length === 0) {
    warnings.push(`editable_records ma ${input.editableRecords.length} rekordów, ale 0 wierszy ma canEdit=true`);
  }

  const rowIds = new Set(input.displayedRows.map((row) => row.row_id));
  for (const childRowId of input.pinnedChildRowIds || []) {
    if (!rowIds.has(childRowId)) {
      warnings.push(`pinned child references missing row: ${childRowId}`);
    }
  }

  return warnings;
}
