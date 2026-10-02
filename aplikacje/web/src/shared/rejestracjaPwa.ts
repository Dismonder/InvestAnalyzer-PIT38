/**
 * Rejestracja service workera (PWA): aplikacja daje sie zainstalowac na telefonie
 * i startuje bez sieci z pamieci przegladarki.
 *
 * Tylko w wydaniu produkcyjnym podanym przez https albo localhost: serwer
 * deweloperski nie ma `sw.js` (buduje go wtyczka w vite.config.ts), a wersja
 * desktopowa (Tauri) ma wlasny protokol, na ktorym service worker nie dziala
 * i tylko sypalby bledami w konsoli.
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

export function zarejestrujServiceWorker(): void {
  if (!czyRejestrowacServiceWorker(window as never, import.meta.env.PROD)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch((blad) => {
      console.warn('[PWA] Rejestracja service workera nie powiodła się', blad);
    });
  });
}
