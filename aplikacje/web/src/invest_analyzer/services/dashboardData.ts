import type { EngineHistoryRow } from '../hooks/useTaxEngineRun';

/** Punkt wykresu salda wplat: data i skumulowane saldo w PLN. */
export interface DepositBalancePoint {
  date: string;
  balancePln: number;
}

/**
 * Przeplywy pieniedzy miedzy Toba a rachunkiem maklerskim.
 *
 * INTERNAL_TRANSFER celowo tu nie ma: przelew miedzy wlasnymi subkontami nie
 * jest wplata. W danych uzytkownika taka para (-4132,10 i +3987,50 PLN)
 * przeliczyla sie po roznych kursach, wiec do "salda wplat" wnosila fikcyjne
 * -144,60 PLN. Reszta wierszy historii to obrot na instrumentach.
 */
export const EXTERNAL_CASH_ROW_KINDS = new Set([
  'BANK_TRANSFER',
  'DEPOSIT',
  'WITHDRAWAL',
  'CASH_MOVEMENT',
]);

/** Przeplywy zewnetrzne wybranego roku, posortowane po dacie. */
export function selectExternalCashMovements(
  rows: EngineHistoryRow[] | undefined | null,
  selectedYear: number,
): Array<{ day: string; amountPln: number; row: EngineHistoryRow }> {
  if (!rows || rows.length === 0) {
    return [];
  }
  const movements: Array<{ day: string; amountPln: number; row: EngineHistoryRow }> = [];
  for (const row of rows) {
    if (!EXTERNAL_CASH_ROW_KINDS.has(String(row.row_kind || '').toUpperCase())) {
      continue;
    }
    const day = displayDay(row.display_date);
    if (!day || Number(day.slice(0, 4)) !== selectedYear) {
      continue;
    }
    const amountPln = parseAmountPln(row.amount_pln);
    if (amountPln === 0) {
      continue;
    }
    movements.push({ day, amountPln, row });
  }
  return movements.sort((left, right) => left.day.localeCompare(right.day));
}

function parseAmountPln(value?: string | null): number {
  // Silnik podaje kwoty z kropka dziesietna; spacje i przecinki tysiecy usuwamy,
  // zeby zapis "1 234,56" albo "1,234.56" nie stawal sie cicho zerem.
  const text = String(value ?? '0').replace(/\s/g, '');
  const normalized = text.includes(',') && text.includes('.')
    ? text.replace(/,/g, '')
    : text.replace(',', '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function displayDay(value?: string | null): string | null {
  const text = String(value ?? '').trim();
  if (!text) {
    return null;
  }
  const day = text.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/**
 * Buduje skumulowane saldo wplat z historii silnika.
 *
 * Wczesniej wykres czytal lokalna kopie transakcji w przegladarce, ktorej po
 * przebudowie architektury nic juz nie zapisuje - byl wiec zawsze pusty.
 * Zrodlem jest teraz ten sam wynik silnika, z ktorego liczy sie podatek.
 */
export function buildDepositBalanceSeries(
  rows: EngineHistoryRow[] | undefined | null,
  selectedYear: number,
): DepositBalancePoint[] {
  if (!rows || rows.length === 0) {
    return [];
  }

  const movements = selectExternalCashMovements(rows, selectedYear);
  if (movements.length === 0) {
    return [];
  }

  const points: DepositBalancePoint[] = [];
  let balancePln = 0;
  for (const movement of movements) {
    balancePln += movement.amountPln;
    const rounded = Math.round(balancePln * 100) / 100;
    const last = points[points.length - 1];
    if (last && last.date === movement.day) {
      last.balancePln = rounded;
    } else {
      points.push({ date: movement.day, balancePln: rounded });
    }
  }

  return points;
}
