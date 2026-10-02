/**
 * Strike kontraktu "przy pieniadzu" (ATM) - jeden, najblizszy cenie bazowej.
 * Staly prog 2,5 USD zaznaczal kilka wierszy przy tanich akcjach i zaden przy
 * drogich (krok strike'ow 5-10 USD). Bez ceny bazowej ATM nie istnieje.
 */
export function strikeAtm(strike: readonly number[], cenaBazowa: number | null): number | null {
  if (cenaBazowa === null || !Number.isFinite(cenaBazowa)) return null;
  let najblizszy: number | null = null;
  for (const s of strike) {
    if (!Number.isFinite(s)) continue;
    if (najblizszy === null || Math.abs(s - cenaBazowa) < Math.abs(najblizszy - cenaBazowa)) najblizszy = s;
  }
  return najblizszy;
}
