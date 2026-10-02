/** Polska odmiana po liczebniku: jeden, kilka, wiele. */
export function odmienLiczebnik(liczba: number, jeden: string, kilka: string, wiele: string): string {
  const reszta100 = Math.abs(liczba) % 100;
  const reszta10 = reszta100 % 10;
  if (reszta100 >= 12 && reszta100 <= 14) return wiele;
  // Tylko dokladnie 1 ma forme pojedyncza: 21, 31, 101 biora forme "wiele".
  if (Math.abs(liczba) === 1) return jeden;
  if (reszta10 >= 2 && reszta10 <= 4) return kilka;
  return wiele;
}
