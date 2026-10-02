export type TypOperacjiOverride = "override" | "new";

export type TypRekorduEdycji = "TRADE" | "EVENT" | "BONUS_CONTEST_SHARE";

export interface NadpisanieTransakcji {
  overrideId: string;
  mode: TypOperacjiOverride;
  recordType: TypRekorduEdycji;
  baseRecordId: string | null;
  manualRecordId: string;
  deleted: boolean;
  values: Record<string, string | null>;
  updatedAt: string;
  createdAt: string;
  comment?: string;
  sourceLabel?: string;
}

export interface WalidacjaRekorduEdycji {
  isValid: boolean;
  status: "VALID" | "INVALID" | "ORPHAN";
  errors: string[];
  warnings: string[];
}

export interface RoznicaRekorduEdycji {
  fieldName: string;
  originalValue: string | null;
  currentValue: string | null;
}

export interface RekordEdycyjny {
  baseRecordId: string | null;
  manualRecordId: string;
  recordType: TypRekorduEdycji;
  overlayStatus: "ORIGINAL" | "MODIFIED" | "NEW";
  deleted: boolean;
  originalValues: Record<string, string | null>;
  currentValues: Record<string, string | null>;
  modifiedFields: string[];
  validationState: WalidacjaRekorduEdycji;
  diffs: RoznicaRekorduEdycji[];
  title?: string | null;
  ticker?: string | null;
  displayDate?: string | null;
  sourceName?: string | null;
}

function parseDecimal(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  let normalized = String(value).trim().replace(/\u00a0/g, "").replace(/\s+/g, "");
  if (normalized.includes(",") && normalized.includes(".")) {
    normalized = normalized.lastIndexOf(",") > normalized.lastIndexOf(".")
      ? normalized.replace(/\./g, "").replace(",", ".")
      : normalized.replace(/,/g, "");
  } else {
    normalized = normalized.replace(",", ".");
  }
  // Pole z samych spacji po oczyszczeniu jest puste, a `Number("")` to 0 -
  // brakujaca kwota, cena albo prowizja przechodzila jako zero.
  if (!normalized) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function grossMatchesProduct(quantity: number, price: number, grossAmount: number): boolean {
  const product = quantity * price;
  if (!Number.isFinite(product)) return false;
  const tolerance = Math.max(0.01, Math.abs(product) * 0.0001);
  const floatMargin = Number.EPSILON * Math.max(1, Math.abs(grossAmount), Math.abs(product));
  return Math.abs(grossAmount - product) <= tolerance + floatMargin;
}

/**
 * Czy kwota brutto ma podążać za ilością i ceną: pusta albo równa ich iloczynowi.
 *
 * Formularz trzyma ten stan osobno, bo w trakcie pisania pole ilości bywa puste
 * albo niepełne - ocena po poprzedniej wartości gubiła przeliczanie po pierwszym
 * skasowaniu cyfry.
 */
export function czyBruttoZIloczynu(values: Record<string, string | null>): boolean {
  if (!String(values.gross_amount ?? "").trim()) return true;
  const quantity = parseDecimal(values.quantity);
  const price = parseDecimal(values.price);
  const gross = parseDecimal(values.gross_amount);
  return quantity !== null && price !== null && gross !== null && grossMatchesProduct(quantity, price, gross);
}

/**
 * Czy brutto dalej podąża za iloczynem po zmianie pola.
 *
 * Wpisanie własnej kwoty wyłącza przeliczanie także wtedy, gdy kwota akurat równa
 * się iloczynowi - inaczej późniejsza zmiana ilości nadpisałaby wpis użytkownika.
 * Wyczyszczenie pola przywraca przeliczanie.
 */
export function bruttoAutomatycznePoZmianie(automatyczne: boolean, fieldName: string, value: string): boolean {
  return fieldName === "gross_amount" ? !String(value ?? "").trim() : automatyczne;
}

/** Zmiana pola formularza TRADE wraz z zależnymi polami, o ile były automatyczne. */
export function updateTradeFieldValues(
  current: Record<string, string | null>,
  fieldName: string,
  value: string,
  bruttoZIloczynu?: boolean,
): Record<string, string | null> {
  const next = { ...current, [fieldName]: value };
  if (fieldName === "quantity" || fieldName === "price") {
    const oldQuantity = parseDecimal(current.quantity);
    const oldPrice = parseDecimal(current.price);
    const oldGross = parseDecimal(current.gross_amount);
    const newQuantity = parseDecimal(next.quantity);
    const newPrice = parseDecimal(next.price);
    const automatyczne = bruttoZIloczynu ?? (
      oldQuantity !== null && oldPrice !== null && oldGross !== null &&
      grossMatchesProduct(oldQuantity, oldPrice, oldGross)
    );
    if (
      automatyczne &&
      newQuantity !== null && newPrice !== null &&
      Number.isFinite(newQuantity * newPrice)
    ) {
      next.gross_amount = (newQuantity * newPrice).toFixed(8).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
    }
  }
  if (fieldName === "trade_currency") {
    const previousCurrency = (current.trade_currency || "").trim().toUpperCase();
    const commissionCurrency = (current.commission_currency || "").trim().toUpperCase();
    if (!commissionCurrency || commissionCurrency === previousCurrency) {
      next.commission_currency = value;
    }
  }
  return next;
}

export function collectModifiedFields(
  originalValues: Record<string, string | null>,
  currentValues: Record<string, string | null>,
): string[] {
  return Array.from(new Set([...Object.keys(originalValues), ...Object.keys(currentValues)]))
    .filter((fieldName) => (originalValues[fieldName] ?? null) !== (currentValues[fieldName] ?? null))
    .sort();
}

export function buildRecordDiffs(
  originalValues: Record<string, string | null>,
  currentValues: Record<string, string | null>,
): RoznicaRekorduEdycji[] {
  return collectModifiedFields(originalValues, currentValues).map((fieldName) => ({
    fieldName,
    originalValue: originalValues[fieldName] ?? null,
    currentValue: currentValues[fieldName] ?? null,
  }));
}

export function validateEditableRecordValues(
  recordType: TypRekorduEdycji,
  values: Record<string, string | null>,
): WalidacjaRekorduEdycji {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!values.date) {
    errors.push("Data jest wymagana.");
  } else if (Number.isNaN(Date.parse(values.date))) {
    errors.push("Data ma nieprawidłowy format.");
  }

  const currencyField = recordType === "TRADE" ? "trade_currency" : "currency";
  if (!values[currencyField]) {
    errors.push("Waluta jest wymagana.");
  }

  if (recordType === "TRADE") {
    const quantity = parseDecimal(values.quantity);
    const price = parseDecimal(values.price);
    const grossAmount = parseDecimal(values.gross_amount);
    const commission = parseDecimal(values.commission);
    const side = String(values.side || "").toUpperCase();

    if (!["BUY", "SELL"].includes(side)) {
      errors.push("Strona transakcji musi być ustawiona na BUY albo SELL.");
    }
    if (quantity === null) {
      errors.push("Ilość musi być prawidłową liczbą.");
    } else if (quantity <= 0) {
      errors.push("Ilość dla transakcji kupna lub sprzedaży musi być większa od zera.");
    }
    if (price === null) {
      errors.push("Cena musi być prawidłową liczbą.");
    } else if (price < 0) {
      errors.push("Cena nie może być ujemna.");
    }
    if (grossAmount === null) {
      errors.push("Kwota brutto musi być prawidłową liczbą.");
    }
    if (quantity !== null && price !== null && grossAmount !== null) {
      if (!grossMatchesProduct(quantity, price, grossAmount)) {
        warnings.push("Kwota brutto różni się od ilość × cena o więcej niż 0,01 lub 0,01%. Silnik rozliczy kwotę brutto.");
      }
    }
    if (commission === null) {
      errors.push("Prowizja musi być prawidłową liczbą.");
    } else if (commission < 0) {
      errors.push("Prowizja nie może być ujemna.");
    }
    if (!values.symbol) {
      errors.push("Instrument jest wymagany.");
    }
  }

  if (recordType === "EVENT") {
    const amount = parseDecimal(values.amount);
    if (!values.event_kind) {
      errors.push("Typ zdarzenia jest wymagany.");
    }
    if (amount === null) {
      errors.push("Kwota zdarzenia musi być prawidłową liczbą.");
    }
  }

  if (recordType === "BONUS_CONTEST_SHARE") {
    const quantity = parseDecimal(values.quantity);
    const grantMarketValue = parseDecimal(values.grant_market_value);
    if (!values.symbol) {
      errors.push("Instrument jest wymagany.");
    }
    if (quantity === null || quantity <= 0) {
      errors.push("Ilość akcji bonusowej musi być większa od zera.");
    }
    if (grantMarketValue === null || grantMarketValue < 0) {
      errors.push("Wartość rynkowa z dnia przyznania musi być prawidłową liczbą nieujemną.");
    }
    if (!values.promotion_basis) {
      warnings.push("Brak podstawy promocji. Pozycja zostanie oznaczona do przeglądu.");
    }
  }

  return {
    isValid: errors.length === 0,
    status: errors.length === 0 ? "VALID" : "INVALID",
    errors,
    warnings,
  };
}

export function createEmptyRecordValues(recordType: TypRekorduEdycji): Record<string, string | null> {
  if (recordType === "TRADE") {
    return {
      date: "",
      symbol: "",
      isin: "",
      side: "BUY",
      quantity: "",
      price: "",
      gross_amount: "",
      trade_currency: "USD",
      commission: "0",
      commission_currency: "USD",
      settlement_date: "",
      comment: "",
      message: "",
      instrument_class: "EQUITY",
      instrument_type_code: "",
      market_id: "",
      country: "",
    };
  }
  if (recordType === "BONUS_CONTEST_SHARE") {
    return {
      date: "",
      symbol: "",
      quantity: "",
      grant_market_value: "",
      currency: "USD",
      promotion_basis: "",
      comment: "",
      message: "",
      country: "",
    };
  }
  return {
    date: "",
    event_kind: "",
    symbol: "",
    amount: "",
    currency: "USD",
    quantity: "",
    comment: "",
    message: "",
    country: "",
  };
}

export function createTransactionOverride(params: {
  recordType: TypRekorduEdycji;
  baseRecordId: string | null;
  manualRecordId?: string;
  mode: TypOperacjiOverride;
  values: Record<string, string | null>;
  deleted?: boolean;
  comment?: string;
  sourceLabel?: string;
}): NadpisanieTransakcji {
  const now = new Date().toISOString();
  const manualRecordId = params.manualRecordId || `manual-${params.recordType.toLowerCase()}-${Date.now()}`;
  return {
    overrideId: `override-${manualRecordId}`,
    mode: params.mode,
    recordType: params.recordType,
    baseRecordId: params.baseRecordId,
    manualRecordId,
    deleted: params.deleted === true,
    values: Object.fromEntries(
      Object.entries(params.values).map(([key, value]) => [key, value === "" ? null : value]),
    ),
    updatedAt: now,
    createdAt: now,
    comment: params.comment,
    sourceLabel: params.sourceLabel || "Ręczna korekta użytkownika",
  };
}

export function getEditableRecordKey(record: Pick<RekordEdycyjny, "manualRecordId" | "baseRecordId">): string {
  return record.manualRecordId || record.baseRecordId || "";
}
