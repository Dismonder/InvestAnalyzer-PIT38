/** Nie wysylaj zlecenia bez jawnie podanej, dodatniej ilosci. */
export function iloscZlecenia(wartosc: string): number | null {
  const ilosc = Number(wartosc);
  return Number.isFinite(ilosc) && ilosc > 0 ? ilosc : null;
}
