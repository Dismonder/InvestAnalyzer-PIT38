import { useEffect, useRef, type RefObject } from 'react';

/**
 * Zamykanie okna modalnego klawiszem Escape i obsluga fokusu.
 *
 * Okna moga sie nakladac (np. katalog tickerow nad wykresami), wiec kazde
 * otwarte okno wpisuje sie na wspolny stos, a Escape zamyka tylko to, ktore
 * otwarto najpozniej. Bez stosu jeden Escape zamykalby wszystkie naraz.
 *
 * Zwracany ref podpiety pod kontener okna (z `tabIndex={-1}`) dostaje fokus
 * po otwarciu, a po zamknieciu fokus wraca do elementu, ktory okno otworzyl.
 * Wczesniej fokus zostawal na stronie pod oknem, wiec Tab chodzil po tle.
 * Tab i Shift+Tab kraza po elementach najwyzszego okna (pulapka fokusu) -
 * z ostatniego pola Tab nie ucieka juz na strone pod nakladka.
 *
 * Uwaga: hook musi byc wywolywany przy kazdym renderze. Wczesny powrot
 * `if (!isOpen) return null` PRZED hookami sprawia, ze React porzuca efekty
 * bez sprzatania (wyciekal nasluch Escape, fokus nie wracal). Takie okno
 * rozdzielamy na otoczke z warunkiem i tresc z hookami.
 */
const stos: symbol[] = [];

const FOKUSOWALNE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

function elementyFokusu(okno: HTMLElement): HTMLElement[] {
  return [...okno.querySelectorAll<HTMLElement>(FOKUSOWALNE)].filter(
    (element) => element.offsetParent !== null || element.getClientRects().length > 0,
  );
}

export function useZamknijEscape<T extends HTMLElement = HTMLDivElement>(
  aktywne: boolean,
  onClose: () => void,
): RefObject<T | null> {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const refOkna = useRef<T | null>(null);

  useEffect(() => {
    if (!aktywne || typeof window === 'undefined') return;
    const id = Symbol('okno');
    stos.push(id);
    const poprzedniFokus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const okno = refOkna.current;
    if (okno && !okno.contains(document.activeElement)) {
      okno.focus({ preventScroll: true });
    }
    const naKlawisz = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (stos[stos.length - 1] !== id) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      const kontener = refOkna.current;
      if (event.key !== 'Tab' || !kontener) return;
      const elementy = elementyFokusu(kontener);
      if (elementy.length === 0) {
        event.preventDefault();
        kontener.focus({ preventScroll: true });
        return;
      }
      const pierwszy = elementy[0];
      const ostatni = elementy[elementy.length - 1];
      const aktywny = document.activeElement;
      const wOknie = aktywny instanceof Node && kontener.contains(aktywny);
      if (event.shiftKey && (!wOknie || aktywny === pierwszy || aktywny === kontener)) {
        event.preventDefault();
        ostatni.focus();
      } else if (!event.shiftKey && (!wOknie || aktywny === ostatni)) {
        event.preventDefault();
        pierwszy.focus();
      }
    };
    window.addEventListener('keydown', naKlawisz);
    return () => {
      window.removeEventListener('keydown', naKlawisz);
      const indeks = stos.lastIndexOf(id);
      if (indeks >= 0) stos.splice(indeks, 1);
      if (poprzedniFokus?.isConnected) poprzedniFokus.focus({ preventScroll: true });
    };
  }, [aktywne]);

  return refOkna;
}
