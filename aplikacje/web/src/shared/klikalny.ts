import type { KeyboardEvent } from 'react';

/**
 * Atrybuty dla klikalnego elementu, ktory nie jest przyciskiem (kafelek,
 * karta, wiersz tabeli). Sam `onClick` na `div`/`tr` dziala tylko mysza:
 * element nie dostaje fokusu Tab i nie reaguje na Enter ani Spacje.
 *
 * `wiersz: true` dla `<tr>` zostawia role wiersza tabeli (rola przycisku
 * psulaby nawigacje po tabeli w czytniku ekranu), dodaje tylko fokus i klawisze.
 * `wybrany` ustawia aria-pressed dla kafelkow dzialajacych jak przelacznik.
 */
export function klikalny(
  akcja: () => void,
  opcje: { wiersz?: boolean; wybrany?: boolean } = {},
) {
  return {
    ...(opcje.wiersz ? {} : { role: 'button' as const }),
    ...(opcje.wybrany === undefined ? {} : { 'aria-pressed': opcje.wybrany }),
    tabIndex: 0,
    onClick: akcja,
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        akcja();
      }
    },
  };
}
