/**
 * Rejestracja service workera (PWA): aplikacja daje sie zainstalowac na telefonie
 * i startuje bez sieci z pamieci przegladarki.
 *
 * Tylko w wydaniu produkcyjnym podanym przez https albo localhost: serwer
 * deweloperski nie ma `sw.js` (buduje go wtyczka w vite.config.ts), a wersja
 * desktopowa (Tauri) ma wlasny protokol, na ktorym service worker nie dziala
 * i tylko sypalby bledami w konsoli.
 *
 * Aktualizacje: nowa wersja service workera (nowe wydanie, takze poprawka
 * bezpieczenstwa) nie czeka, az uzytkownik zamknie wszystkie karty. Strona prosi
 * ja o przejecie (POMIN_OCZEKIWANIE → skipWaiting), a po zmianie kontrolera
 * przeladowuje sie raz - od razu, gdy karta jest schowana, albo przy najblizszym
 * schowaniu karty, zeby nie przerywac wpisywania. Przy powrocie do karty
 * sprawdzamy aktualizacje, nie czesciej niz raz na godzine.
 */
export function czyRejestrowacServiceWorker(okno: {
  location?: { protocol?: string; hostname?: string };
  navigator?: { serviceWorker?: unknown };
  __TAURI_INTERNALS__?: unknown;
}, produkcja: boolean): boolean {
  if (!produkcja || !okno.navigator?.serviceWorker) return false;
  if ('__TAURI_INTERNALS__' in okno && okno.__TAURI_INTERNALS__ !== undefined) return false;
  const protokol = okno.location?.protocol;
  const host = okno.location?.hostname;
  if (protokol === 'tauri:' || host === 'tauri.localhost') return false;
  return protokol === 'https:' || host === 'localhost' || host === '127.0.0.1';
}

/** Wiadomosc do czekajacego service workera (obsluga w sw.szablon.js). */
export const WIADOMOSC_POMIN_OCZEKIWANIE = { typ: 'POMIN_OCZEKIWANIE' } as const;

/** Odstep miedzy sprawdzeniami aktualizacji przy powrocie do karty. */
export const ODSTEP_SPRAWDZANIA_AKTUALIZACJI_MS = 60 * 60 * 1000;

/**
 * Nowy service worker zainstalowal sie, a strona ma juz kontrolera: to aktualizacja,
 * a nie pierwsza instalacja - prosimy o przejecie. Przy pierwszej instalacji nie ma
 * czego pomijac (clients.claim() i tak przejmuje strone).
 */
export function czyProsicOPrzejecie(stanNowego: string, maKontrolera: boolean): boolean {
  return stanNowego === 'installed' && maKontrolera;
}

/**
 * Przeladowanie po zmianie kontrolera tylko raz i tylko gdy strona miala juz
 * kontrolera przed zmiana (pierwsze przejecie po instalacji nie zmienia kodu
 * strony - przeladowanie byloby mignieciem bez powodu).
 */
export function czyOdswiezycPoZmianieKontrolera(mialaKontrolera: boolean, juzOdswiezono: boolean): boolean {
  return mialaKontrolera && !juzOdswiezono;
}

/** Czy od ostatniego sprawdzenia minal odstep (przy powrocie do widocznej karty). */
export function czySprawdzicAktualizacje(widoczna: boolean, teraz: number, ostatnie: number, odstepMs = ODSTEP_SPRAWDZANIA_AKTUALIZACJI_MS): boolean {
  return widoczna && teraz - ostatnie >= odstepMs;
}

interface SrodowiskoAktualizacji {
  kontener: { controller: ServiceWorker | null; addEventListener(typ: 'controllerchange', f: () => void): void };
  dokument: { visibilityState: string; addEventListener(typ: 'visibilitychange', f: () => void): void };
  przeladuj: () => void;
  teraz?: () => number;
}

/** Podlacza przeplyw aktualizacji do rejestracji; wydzielone, zeby dalo sie przetestowac bez przegladarki. */
export function podlaczAktualizacje(rejestracja: {
  waiting: ServiceWorker | null;
  installing: ServiceWorker | null;
  addEventListener(typ: 'updatefound', f: () => void): void;
  update(): Promise<unknown>;
}, srodowisko: SrodowiskoAktualizacji): void {
  const { kontener, dokument, przeladuj } = srodowisko;
  const teraz = srodowisko.teraz ?? (() => Date.now());
  const mialaKontrolera = kontener.controller !== null;

  const poprosOPrzejecie = (nowy: ServiceWorker | null) => {
    if (!nowy) return;
    nowy.addEventListener('statechange', () => {
      if (czyProsicOPrzejecie(nowy.state, kontener.controller !== null)) nowy.postMessage(WIADOMOSC_POMIN_OCZEKIWANIE);
    });
  };
  // Wersja, ktora juz czeka (zainstalowana przy poprzedniej wizycie).
  if (rejestracja.waiting && mialaKontrolera) rejestracja.waiting.postMessage(WIADOMOSC_POMIN_OCZEKIWANIE);
  rejestracja.addEventListener('updatefound', () => poprosOPrzejecie(rejestracja.installing));

  let odswiezono = false;
  let odswiezeniePoSchowaniu = false;
  kontener.addEventListener('controllerchange', () => {
    if (!czyOdswiezycPoZmianieKontrolera(mialaKontrolera, odswiezono)) return;
    if (dokument.visibilityState === 'hidden') {
      odswiezono = true;
      przeladuj();
    } else {
      odswiezeniePoSchowaniu = true;
    }
  });

  let ostatnieSprawdzenie = teraz();
  dokument.addEventListener('visibilitychange', () => {
    if (dokument.visibilityState === 'hidden') {
      if (odswiezeniePoSchowaniu && !odswiezono) {
        odswiezono = true;
        przeladuj();
      }
      return;
    }
    if (czySprawdzicAktualizacje(dokument.visibilityState === 'visible', teraz(), ostatnieSprawdzenie)) {
      ostatnieSprawdzenie = teraz();
      rejestracja.update().catch(() => {});
    }
  });
}

export function zarejestrujServiceWorker(): void {
  if (!czyRejestrowacServiceWorker(window as never, import.meta.env.PROD)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then((rejestracja) => {
      podlaczAktualizacje(rejestracja, {
        kontener: navigator.serviceWorker,
        dokument: document,
        przeladuj: () => window.location.reload(),
      });
    }).catch((blad) => {
      console.warn('[PWA] Rejestracja service workera nie powiodła się', blad);
    });
  });
}
