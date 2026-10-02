import { CurrencyCode, NBPRate } from '../types';
import { apiFetch } from './apiTransport';

// Kalendarz dni roboczych (zasada T-1) jest wspolny z serwerem.
import { getLastBusinessDayBefore, getPreviousDayStr, isPolishBusinessDay } from '../../shared/kalendarzPl';
export { getLastBusinessDayBefore, getPreviousDayStr, isPolishBusinessDay };

// In-memory rate cache
const rateCache: Map<string, NBPRate> = new Map();

/**
 * Kurs sredni NBP z ostatniego dnia roboczego przed data operacji (zasada T-1,
 * art. 11a ust. 1 i 3 ustawy o PIT).
 *
 * Zwraca `null`, gdy kursu nie da sie pobrac. Wczesniej funkcja zawsze oddawala
 * jakis kurs: najpierw zagladala do wpisanej w kod tabeli "przykladowych kursow
 * historycznych" (przed zapytaniem do NBP, wiec dla tych dat prawdziwy kurs w
 * ogole nie byl pobierany), a gdy i to zawiodlo, wyliczala kurs z daty -
 * stala bazowa waluty plus przesuniecie z reszty z dzielenia - i dorabiala do
 * niego numer tabeli w rodzaju "137/A/NBP/2026". Wynik wygladal jak kurs
 * urzedowy i trafial do rozliczenia. Brak kursu jest mniej szkodliwy niz kurs
 * zmyslony.
 */
export async function getNBPRateForDate(
  currency: CurrencyCode,
  transactionDate: string
): Promise<NBPRate | null> {
  if (currency === 'PLN') {
    return {
      currency: 'PLN',
      code: 'PLN',
      table: 'A',
      no: 'BRAK/PLN',
      effectiveDate: transactionDate.slice(0, 10),
      mid: 1.0,
    };
  }

  const rateDate = getLastBusinessDayBefore(transactionDate);
  const cacheKey = `${currency}_${rateDate}`;

  if (rateCache.has(cacheKey)) {
    return rateCache.get(cacheKey)!;
  }

  try {
    const url = `/api/nbp/rate?currency=${encodeURIComponent(currency)}&date=${encodeURIComponent(transactionDate)}`;
    const response = await apiFetch(url, { headers: { Accept: 'application/json' } });
    if (response.ok) {
      const data = await response.json();
      if (data && data.success && data.data && typeof data.data.mid === 'number') {
        const rateInfo = data.data;
        const rate: NBPRate = {
          currency,
          code: currency,
          table: rateInfo.table || 'A',
          no: rateInfo.no,
          effectiveDate: rateInfo.effectiveDate,
          mid: rateInfo.mid,
        };
        rateCache.set(cacheKey, rate);
        return rate;
      }
    }
  } catch (err) {
    console.warn(`[NBP] Nie udało się pobrać kursu ${currency} na ${rateDate}:`, err);
  }

  return null;
}

// Intl.NumberFormat jest kosztowny w tworzeniu, a tabele wolaja formatowanie
// setki razy na render - jeden formatter na liczbe miejsc po przecinku.
const formatteryPl = new Map<number, Intl.NumberFormat>();
function formatterPl(decimals: number): Intl.NumberFormat {
  let formatter = formatteryPl.get(decimals);
  if (!formatter) {
    formatter = new Intl.NumberFormat('pl-PL', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    formatteryPl.set(decimals, formatter);
  }
  return formatter;
}

/**
 * Liczba w zapisie polskim (przecinek dziesietny, spacja tysiecy) - ten sam
 * co w formatCurrency. `toFixed` dawal "12.34" obok "1 234,56 PLN".
 */
export function formatLiczba(value: number, decimals = 2): string {
  return formatterPl(decimals).format(value);
}

/**
 * Format currency amount with proper suffix and digits
 */
export function formatCurrency(amount: number, currency: CurrencyCode = 'PLN', decimals = 2): string {
  return `${formatLiczba(amount, decimals)} ${currency}`;
}

/**
 * Format date in Polish notation (DD.MM.YYYY)
 */
export function formatPolishDate(dateStr: string): string {
  if (!dateStr) return '';
  const datePart = dateStr.slice(0, 10);
  const [year, month, day] = datePart.split('-');
  return `${day}.${month}.${year}`;
}
