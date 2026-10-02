/**
 * Kod i komunikat odmowy hostowanej wersji (Worker Cloudflare bez serwera Node).
 * Osobny, lekki modul: importuje go API hostingu (hosting/apiHostowane.ts) i powloka
 * portfela (PortfelApp.tsx), ktora po tym kodzie rozpoznaje tryb hostowany i zamiast
 * czerwonego bledu silnika pokazuje spokojna informacje, co w tej wersji dziala.
 */
export const KOD_NIEDOSTEPNE_W_HOSTINGU = 'NIEDOSTEPNE_W_HOSTINGU';

export const KOMUNIKAT_NIEDOSTEPNE_W_HOSTINGU =
  'Ta funkcja wymaga lokalnego serwera aplikacji albo wersji komputerowej. W wersji hostowanej (telefon, przeglądarka) '
  + 'działają portfel, notowania, wykresy i alerty; rozliczenie PIT-38, import plików i integracje brokera nie są dostępne. '
  + 'Nic nie zostało wysłane.';

/** Czy komunikat bledu pochodzi z odmowy hostingu (tekst z API, nie wyjatek sieciowy). */
export function czyOdmowaHostingu(komunikat: string | null | undefined): boolean {
  return typeof komunikat === 'string' && (komunikat.includes(KOD_NIEDOSTEPNE_W_HOSTINGU) || komunikat.includes('W wersji hostowanej (telefon, przeglądarka)'));
}
