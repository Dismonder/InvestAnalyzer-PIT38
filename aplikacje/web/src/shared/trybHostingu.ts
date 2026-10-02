/**
 * Tryb hostowany: aplikacja podana z Workera Cloudflare (telefon, przegladarka),
 * bez serwera Node i bez silnika. Widoki chowaja wtedy panele, ktore i tak
 * dostalyby odmowe 501 (broker Freedom24, sesje gieldowe z API brokera),
 * zamiast pokazywac na telefonie puste karty z komunikatem o braku serwera.
 *
 * Rozpoznanie jest synchroniczne, zeby pierwszy render byl juz wlasciwy:
 * adres `*.workers.dev` albo znacznik z poprzedniej sondy `/api/health`
 * (`tryb: 'hosting'`) zapisany w sessionStorage - na wypadek wlasnej domeny.
 */
const KLUCZ = 'ia_tryb_hostingu';

export function czyTrybHostowany(okno: { location?: { hostname?: string }; sessionStorage?: { getItem(k: string): string | null } } = globalThis as never): boolean {
  const host = okno.location?.hostname ?? '';
  if (host.endsWith('.workers.dev')) return true;
  try {
    return okno.sessionStorage?.getItem(KLUCZ) === 'hosting';
  } catch {
    return false;
  }
}

/** Zapamietuje odpowiedz sondy zdrowia; `true`, gdy tryb hostingu zostal wlasnie wykryty. */
export function zapiszTrybZeZdrowia(cialo: unknown, magazyn: { setItem(k: string, v: string): void; removeItem(k: string): void } | undefined = globalThis.sessionStorage): boolean {
  const hosting = typeof cialo === 'object' && cialo !== null && (cialo as { tryb?: unknown }).tryb === 'hosting';
  try {
    if (hosting) magazyn?.setItem(KLUCZ, 'hosting');
    else magazyn?.removeItem(KLUCZ);
  } catch {
    // Bez sessionStorage zostaje rozpoznanie po adresie.
  }
  return hosting;
}

/** Jednorazowa sonda po starcie; przy zmianie wyniku odswieza strone raz, zeby widoki od razu byly wlasciwe. */
export async function sprawdzTrybHostingu(): Promise<void> {
  if (typeof fetch !== 'function' || typeof location === 'undefined') return;
  if (location.protocol === 'tauri:' || location.hostname === 'tauri.localhost') return;
  const przed = czyTrybHostowany();
  try {
    const odpowiedz = await fetch('/api/health', { cache: 'no-store' });
    if (!odpowiedz.ok) return;
    const po = zapiszTrybZeZdrowia(await odpowiedz.json());
    if (po !== przed && !location.hostname.endsWith('.workers.dev')) location.reload();
  } catch {
    // Brak sieci: zostaje rozpoznanie po adresie.
  }
}
