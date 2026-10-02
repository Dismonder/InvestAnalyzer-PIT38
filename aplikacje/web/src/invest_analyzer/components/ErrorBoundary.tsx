import React, { ErrorInfo, ReactNode } from 'react';
import { StorageService } from '../services/storage';
import { browserSessionStorage } from '../services/browserStorage';
import type { BackupSnapshot } from '../services/backup';
import { zwolnijOdrzuconeLeniwe } from '../../shared/leniwyZPonowieniem';

interface Props {
  children?: ReactNode;
  onDismiss?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
  recoveryBusy: boolean;
  recoveryMessage: string | null;
}

/**
 * Nieudane doczytanie czesci aplikacji (serwer zatrzymany, zerwana siec, nowa
 * wersja po aktualizacji) nie ma nic wspolnego z danymi uzytkownika. Taki blad
 * nie moze prowadzic do ekranu, ktory proponuje skasowanie decyzji.
 */
export function czyBladLadowaniaModulu(error: unknown): boolean {
  const tresc = error instanceof Error ? `${error.name} ${error.message}` : String(error ?? '');
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|ChunkLoadError|Loading chunk \S+ failed/i.test(
    tresc,
  );
}

const KLUCZ_PRZELADOWANIA = 'ia_przeladowanie_po_bledzie_modulu';
const ODSTEP_PRZELADOWAN_MS = 60_000;

/**
 * Czy wolno samemu przeladowac strone po bledzie ladowania modulu. Gdy serwer
 * odpowiada, ale brakuje pliku czesci aplikacji, kazde przeladowanie konczylo
 * sie tym samym bledem - strona odswiezala sie co 2 s bez konca. Jedno
 * automatyczne przeladowanie na minute; potem zostaje przycisk "Odswiez".
 */
export function moznaPrzeladowacPoBledzieModulu(
  magazyn: Pick<Storage, 'getItem' | 'setItem'>,
  teraz: number,
): boolean {
  try {
    const poprzednie = Number(magazyn.getItem(KLUCZ_PRZELADOWANIA));
    if (Number.isFinite(poprzednie) && poprzednie > 0 && teraz - poprzednie < ODSTEP_PRZELADOWAN_MS) return false;
    magazyn.setItem(KLUCZ_PRZELADOWANIA, String(teraz));
    return true;
  } catch {
    // Bez sessionStorage nie da sie policzyc przeladowan - bezpieczniej nie petlic.
    return false;
  }
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    // @ts-ignore
    this.state = { hasError: false, error: null, recoveryBusy: false, recoveryMessage: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, recoveryBusy: false, recoveryMessage: null };
  }

  private ponawianie: ReturnType<typeof setInterval> | null = null;

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error:', error, errorInfo);
    // Blad dotarl do granicy: od teraz ponowne otwarcie okna albo zakladki pobiera paczke od nowa.
    zwolnijOdrzuconeLeniwe();
    if (czyBladLadowaniaModulu(error) && !this.props.onDismiss) this.czekajNaSerwer();
  }

  componentWillUnmount() {
    if (this.ponawianie) clearInterval(this.ponawianie);
  }

  /** Serwer wrocil - przeladowanie pobiera brakujacy modul; danych nie dotykamy. */
  private czekajNaSerwer() {
    if (this.ponawianie || typeof globalThis.window === 'undefined') return;
    this.ponawianie = setInterval(async () => {
      try {
        const odpowiedz = await fetch('/', { method: 'HEAD', cache: 'no-store' });
        if (!odpowiedz.ok) return;
        if (this.ponawianie) clearInterval(this.ponawianie);
        if (moznaPrzeladowacPoBledzieModulu(browserSessionStorage, Date.now())) globalThis.window.location.reload();
      } catch {
        // Serwer nadal nie odpowiada - probujemy dalej.
      }
    }, 2000);
  }

  // Przycisk odzyskiwania czyscil wczesniej dwa klucze, ktorych nic nie
  // zapisuje, wiec stan powodujacy awarie zostawal nietkniety i aplikacja
  // wywalala sie zaraz po przeladowaniu.
  /**
   * Lagodniejsze odzyskiwanie: usuwa wylacznie wpisy, ktorych nie da sie
   * odczytac. Pelne czyszczenie kasuje rachunki, transakcje, alerty i sekret
   * 2FA - a najczestsza przyczyna awarii jest jeden uszkodzony wpis, wiec
   * nie ma powodu placic za to cala zawartoscia magazynu.
   */
  private recoveryInProgress = false;

  private async wykonajBezpieczneOdzyskiwanie(
    akcja: 'kwarantanna' | 'czyszczenie',
    apply: (snapshot: BackupSnapshot | null) => Promise<void> | void,
  ) {
    if (this.recoveryInProgress) return;
    this.recoveryInProgress = true;
    this.setState({ recoveryBusy: true, recoveryMessage: null });
    try {
      const [{ collectBackupSnapshot }, { runtimeApi }, { wykonajOdzyskiwanieZKopia, trescZgodyBezKopii }] = await Promise.all([
        import('../services/backup'),
        import('../services/runtimeApi'),
        import('../services/odzyskiwanieAwaryjne'),
      ]);
      const idKopii = await wykonajOdzyskiwanieZKopia({
        collect: () => collectBackupSnapshot('Kopia przed odzyskiwaniem danych', 'safety'),
        write: (snapshot) => runtimeApi.writeBackupSnapshot(snapshot),
        apply,
        reload: () => globalThis.window?.location.reload(),
        // Bez kopii tylko po jawnym potwierdzeniu - jak przy czyszczeniu danych w Ustawieniach.
        potwierdzBezKopii: (powod) => globalThis.window?.confirm(trescZgodyBezKopii(akcja, powod)) === true,
      });
      console.info(idKopii
        ? `Przed odzyskiwaniem zapisano kopię bezpieczeństwa: ${idKopii}`
        : 'Odzyskiwanie wykonano bez kopii bezpieczeństwa (za zgodą użytkownika).');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Nie udało się przygotować kopii bezpieczeństwa. Nie usunięto danych.';
      console.error('Odzyskiwanie przerwane', error);
      this.setState({ recoveryBusy: false, recoveryMessage: message });
      this.recoveryInProgress = false;
    }
  }

  handleRemoveCorrupted = () => this.wykonajBezpieczneOdzyskiwanie('kwarantanna', (snapshot) => {
    const magazyn = globalThis.window?.localStorage;
    if (!magazyn) throw new Error('Magazyn przeglądarki jest niedostępny. Nie usunięto danych.');
    return import('../services/odzyskiwanieAwaryjne').then(({ usunUszkodzoneWpisyDoKwarantanny }) => {
      const usuniete = usunUszkodzoneWpisyDoKwarantanny(
        magazyn,
        Object.keys(snapshot?.local ?? {}),
        snapshot?.coveredKeys?.localPrefixes ?? [],
      );
      console.info(`Usunięto uszkodzone wpisy aplikacji: ${usuniete.join(', ') || 'brak'}`);
    });
  });

  handleReset = () => this.wykonajBezpieczneOdzyskiwanie('czyszczenie', async (snapshot) => {
    const magazyn = globalThis.window?.localStorage;
    if (!magazyn) throw new Error('Magazyn przeglądarki jest niedostępny. Nie usunięto danych.');
    const { zachowajUszkodzoneWpisyWKwarantannie, wyczyscLocalStoragePozaKwarantanna } = await import('../services/odzyskiwanieAwaryjne');
    // Niewalidowalne konta nie mogą trafić do kopii zewnętrznej (zawierają sekrety).
    // Zachowaj ich surową treść wyłącznie lokalnie i przed czyszczeniem jakiegokolwiek magazynu.
    zachowajUszkodzoneWpisyWKwarantannie(
      magazyn,
      Object.keys(snapshot?.local ?? {}),
      snapshot?.coveredKeys?.localPrefixes ?? [],
    );
    await StorageService.clearAll();
    wyczyscLocalStoragePozaKwarantanna(magazyn);
    browserSessionStorage.clear();
  });

  /** Ponowna proba: wraca do zawartosci bez przeladowania strony i bez dotykania danych. */
  handleRetry = () => {
    this.setState({ hasError: false, error: null, recoveryMessage: null });
  };

  render() {
    // @ts-ignore
    const { hasError, error } = this.state as State;
    if (hasError && this.props.onDismiss) {
      return (
        <div role="alert" data-testid="blad-modala" className="fixed top-4 inset-x-4 z-[60] mx-auto max-w-xl rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 shadow-xl dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          <p className="font-semibold">Nie udało się otworzyć tego okna. Reszta aplikacji działa.</p>
          <p className="mt-1 font-mono text-[11px] opacity-80">{error?.message || 'Nieznany błąd'}</p>
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={this.props.onDismiss} className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700">Zamknij okno</button>
            <button type="button" onClick={() => globalThis.window?.location.reload()} className="rounded-lg border border-amber-400 px-3 py-1.5 text-xs font-semibold hover:bg-amber-100 dark:hover:bg-amber-900/40">Odśwież stronę</button>
          </div>
        </div>
      );
    }
    if (hasError && czyBladLadowaniaModulu(error)) {
      // Blad jednego widoku nie moze zaslaniac i blokowac reszty aplikacji.
      return (
        <div role="alert" className="fixed top-0 inset-x-0 z-50 bg-amber-100 text-amber-900 text-sm px-4 py-2 text-center shadow">
          Nie udało się załadować części aplikacji. Twoje dane są nietknięte.
          <button type="button" onClick={() => globalThis.window?.location.reload()} className="ml-3 rounded border border-amber-500 px-2 py-1 font-semibold hover:bg-amber-200">
            Odśwież stronę
          </button>
        </div>
      );
    }
    if (hasError) {
      // Nigdy pelnoekranowo: blad jednego widoku nie moze zaslaniac i blokowac reszty aplikacji.
      // Czyszczenie danych jest schowane - to ostatecznosc, nie pierwsza propozycja.
      return (
        <div role="alert" data-testid="blad-widoku" className="m-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-semibold">Ten widok napotkał błąd. Reszta aplikacji działa, a Twoje dane są nietknięte.</p>
              <p className="mt-0.5 font-mono text-[11px] opacity-80">{error?.message || 'Nieznany błąd'}</p>
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={this.handleRetry} className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700">
                Spróbuj ponownie
              </button>
              <button type="button" onClick={() => globalThis.window?.location.reload()} className="rounded-lg border border-amber-400 px-3 py-1.5 text-xs font-semibold hover:bg-amber-100 dark:hover:bg-amber-900/40">
                Odśwież stronę
              </button>
            </div>
          </div>
          <details className="mt-2 text-[11px]">
            <summary className="cursor-pointer opacity-70">Więcej (tylko gdy błąd wraca po odświeżeniu)</summary>
            <p className="mt-1 opacity-80">
              Jeśli przyczyną jest uszkodzony zapis w pamięci przeglądarki, można usunąć same nieczytelne wpisy. Pełne
              czyszczenie kasuje wszystkie decyzje zapisane w przeglądarce (korekty, straty z lat ubiegłych, zamknięcia lat);
              pliki brokera na dysku zostają. Surowe uszkodzone wpisy są zachowywane lokalnie w kwarantannie do odzyskania
              („Dokumenty i silnik” → Ustawienia → Dane). Przed każdą z tych operacji powstaje kopia bezpieczeństwa; gdy nie
              da się jej zapisać, program pyta o zgodę na działanie bez kopii.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" disabled={this.state.recoveryBusy} onClick={this.handleRemoveCorrupted} className="rounded-md border border-amber-400 px-2 py-1 font-semibold hover:bg-amber-100 disabled:opacity-50 dark:hover:bg-amber-900/40">
                Usuń tylko uszkodzone wpisy
              </button>
              <button type="button" disabled={this.state.recoveryBusy} onClick={this.handleReset} className="rounded-md border border-rose-400 px-2 py-1 font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50 dark:text-rose-300 dark:hover:bg-rose-950/40">
                Wyczyść dane przeglądarki
              </button>
            </div>
            {this.state.recoveryBusy && <p role="status" className="mt-2">Tworzenie kopii bezpieczeństwa…</p>}
            {this.state.recoveryMessage && <p role="alert" className="mt-2 rounded-md border border-rose-300 bg-rose-50 p-2 text-rose-800 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-200">{this.state.recoveryMessage}</p>}
          </details>
        </div>
      );
    }
    // @ts-ignore
    return this.props.children;
  }
}
