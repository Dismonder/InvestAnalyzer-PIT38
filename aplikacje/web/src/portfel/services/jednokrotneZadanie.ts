/** Uruchamia co najwyżej jedną instancję akcji naraz; synchroniczna blokada obejmuje też ten sam tick przed rerenderem Reacta. */
export async function wykonajJednokrotnie<T>(
  blokada: { current: boolean },
  akcja: () => Promise<T>,
): Promise<T | undefined> {
  if (blokada.current) return undefined;
  blokada.current = true;
  try {
    return await akcja();
  } finally {
    blokada.current = false;
  }
}
