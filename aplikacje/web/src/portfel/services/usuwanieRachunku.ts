/**
 * Tresc potwierdzenia usuniecia rachunku.
 *
 * Usuniecie rachunku nie kasuje jego transakcji - zostaja w historii bez
 * rachunku, a silnik nie zna wtedy typu brokera i nie da informacji o
 * PIT-8C. Uzytkownik ma to wiedziec przed klikniecie, a nie po.
 */
export function trescPotwierdzeniaUsunieciaRachunku(nazwaRachunku: string, liczbaTransakcji: number): string {
  const nazwa = nazwaRachunku.trim() || 'bez nazwy';
  if (liczbaTransakcji <= 0) {
    return `Usunąć rachunek „${nazwa}”? Rachunek nie ma powiązanych transakcji.`;
  }
  return [
    `Usunąć rachunek „${nazwa}”?`,
    '',
    `Powiązane transakcje: ${liczbaTransakcji}. Nie zostaną usunięte - pozostaną w historii bez rachunku.`,
    'Bez rachunku aplikacja nie zna typu brokera, więc trzeba samodzielnie ustalić źródło PIT-8C dla tych transakcji.',
  ].join('\n');
}
