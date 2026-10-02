type ExportPrimitive = string | number | boolean | null;
type ExportRecord = Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeCellValue(value: unknown): ExportPrimitive {
  if (value === undefined || value === null) {
    return "";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry ?? "")).join("; ");
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return JSON.stringify(value);
}

export function flattenExportRecord(record: ExportRecord, prefix = ""): Record<string, ExportPrimitive> {
  const flat: Record<string, ExportPrimitive> = {};
  for (const [key, value] of Object.entries(record)) {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value)) {
      Object.assign(flat, flattenExportRecord(value, nextKey));
    } else {
      flat[nextKey] = normalizeCellValue(value);
    }
  }
  return flat;
}

export function normalizeExportRows(rows: unknown[]): Record<string, ExportPrimitive>[] {
  if (rows.length === 0) {
    return [{ komunikat: "Brak danych do eksportu" }];
  }
  return rows.map((row) => (
    isPlainObject(row)
      ? flattenExportRecord(row)
      : { wartosc: normalizeCellValue(row) }
  ));
}

const LICZBA_W_TEKSCIE = /^[+-]?\d+(?:[.,]\d+)?$/;

/**
 * Jedna komorka CSV dla wszystkich eksportow.
 *
 * Tekst zaczynajacy sie od = + - @ tabulatora albo CR arkusz wykonalby jako
 * formule, a nazwa rachunku, ticker czy notatka pochodza od uzytkownika albo
 * z wyciagu. Taki tekst dostaje apostrof. Liczby (number oraz zapis liczby
 * sformatowany przez aplikacje, np. "-12,50") zostaja bez zmian - ujemna kwota
 * nie moze zamienic sie w tekst. Cytowanie: separator, cudzyslow, \n, \r.
 */
export function zakodujKomorkeCsv(value: unknown, separator = ","): string {
  let text = String(value ?? "");
  if (typeof value !== "number" && !LICZBA_W_TEKSCIE.test(text) && /^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  if (text.includes(separator) || /["\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function buildCsvContent(rows: unknown[]): string {
  const normalizedRows = normalizeExportRows(rows);
  const headers = Array.from(
    normalizedRows.reduce((set, row) => {
      Object.keys(row).forEach((key) => set.add(key));
      return set;
    }, new Set<string>()),
  );
  const body = normalizedRows.map((row) => headers.map((header) => zakodujKomorkeCsv(row[header] ?? "")).join(","));
  return `\uFEFF${[headers.map((header) => zakodujKomorkeCsv(header)).join(","), ...body].join("\n")}`;
}

export function downloadExportData(dane: unknown[], filename: string, type: "json" | "csv"): void {
  const rows = Array.isArray(dane) ? dane : [dane];
  const content = type === "json"
    ? JSON.stringify(rows.length > 0 ? rows : normalizeExportRows([]), null, 2)
    : buildCsvContent(rows);
  const mimeType = type === "json" ? "application/json;charset=utf-8" : "text/csv;charset=utf-8";
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${filename}.${type}`;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
