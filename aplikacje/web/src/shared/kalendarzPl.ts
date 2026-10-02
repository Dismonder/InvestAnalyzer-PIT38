/**
 * Polski kalendarz dni roboczych dla zasady T-1 (art. 11a ust. 1 i 3 ustawy
 * o PIT): kurs sredni NBP z ostatniego dnia roboczego przed dniem operacji.
 *
 * Wspolny dla serwera i przegladarki. Wczesniej obie strony mialy wlasna
 * kopie z recznie wpisanymi swietami ruchomymi tylko na lata 2022-2026 i bez
 * Wigilii (dzien wolny od 2025 r.), wiec np. T-1 dla 30.03.2027 wypadal
 * w Poniedzialek Wielkanocny. Serwer ratowal to cofaniem sie po odpowiedzi 404
 * z NBP, ale kosztem zbednych zapytan i bledow, gdy NBP nie odpowiadal.
 */

// Swieta stale (MM-DD).
const SWIETA_STALE = [
  '01-01', // Nowy Rok
  '01-06', // Trzech Kroli
  '05-01', // Swieto Pracy
  '05-03', // Swieto Konstytucji 3 Maja
  '08-15', // Wniebowziecie NMP
  '11-01', // Wszystkich Swietych
  '11-11', // Swieto Niepodleglosci
  '12-25', // Boze Narodzenie
  '12-26', // drugi dzien Bozego Narodzenia
];

/** Wigilia jest dniem ustawowo wolnym od 2025 r. */
const PIERWSZY_ROK_WOLNEJ_WIGILII = 2025;

/** Niedziela Wielkanocna (kalendarz gregorianski, algorytm Meeusa/Jonesa/Butchera). */
function wielkanoc(rok: number): { miesiac: number; dzien: number } {
  const a = rok % 19;
  const b = Math.floor(rok / 100);
  const c = rok % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const miesiac = Math.floor((h + l - 7 * m + 114) / 31);
  const dzien = ((h + l - 7 * m + 114) % 31) + 1;
  return { miesiac, dzien };
}

const swietaRuchome = new Map<number, Set<string>>();

/** Poniedzialek Wielkanocny (+1) i Boze Cialo (+60) dla danego roku, jako YYYY-MM-DD. */
function swietaRuchomeRoku(rok: number): Set<string> {
  let wynik = swietaRuchome.get(rok);
  if (!wynik) {
    const { miesiac, dzien } = wielkanoc(rok);
    const niedziela = Date.UTC(rok, miesiac - 1, dzien);
    const dzienMs = 24 * 60 * 60 * 1000;
    wynik = new Set([1, 60].map((przesuniecie) => new Date(niedziela + przesuniecie * dzienMs).toISOString().slice(0, 10)));
    swietaRuchome.set(rok, wynik);
  }
  return wynik;
}

export function isPolishBusinessDay(dateStr: string): boolean {
  const dzien = dateStr.slice(0, 10);
  const data = new Date(`${dzien}T12:00:00Z`);
  const dzienTygodnia = data.getUTCDay(); // 0 = niedziela, 6 = sobota
  if (dzienTygodnia === 0 || dzienTygodnia === 6) return false;
  const miesiacDzien = dzien.slice(5, 10);
  if (SWIETA_STALE.includes(miesiacDzien)) return false;
  const rok = data.getUTCFullYear();
  if (miesiacDzien === '12-24' && rok >= PIERWSZY_ROK_WOLNEJ_WIGILII) return false;
  return !swietaRuchomeRoku(rok).has(dzien);
}

export function getPreviousDayStr(dateStr: string): string {
  const d = new Date(`${dateStr.slice(0, 10)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Ostatni polski dzien roboczy PRZED data operacji (zasada T-1). */
export function getLastBusinessDayBefore(transactionDateStr: string): string {
  let current = getPreviousDayStr(transactionDateStr.slice(0, 10));
  let safetyLimit = 15;
  while (!isPolishBusinessDay(current) && safetyLimit > 0) {
    current = getPreviousDayStr(current);
    safetyLimit--;
  }
  return current;
}
