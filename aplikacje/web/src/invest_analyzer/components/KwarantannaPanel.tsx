import React, { useCallback, useEffect, useState } from 'react';
import { Download, ShieldAlert, Trash2 } from 'lucide-react';

import { odmienLiczebnik } from '../../portfel/services/odmianaLiczebnika';
import {
  eksportKwarantanny,
  listaKwarantanny,
  usunZKwarantanny,
  type PozycjaKwarantanny,
} from '../services/kwarantanna';

function magazynPrzegladarki(): Storage | null {
  try {
    return globalThis.window?.localStorage ?? null;
  } catch {
    return null;
  }
}

function opisCzasu(iso: string | null): string {
  if (!iso) return 'odłożony przy odczycie';
  const data = new Date(iso);
  return Number.isNaN(data.getTime()) ? iso : data.toLocaleString('pl-PL');
}

function pobierzPlik(tresc: string, nazwa: string): void {
  const blob = new Blob([tresc], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = nazwa;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Nieczytelne wpisy odlozone zamiast skasowane (panel bledu, bezpieczny odczyt
 * portfela). Bez tego widoku zostawaly w przegladarce na zawsze - takze po
 * pelnym czyszczeniu danych - i nikt nie wiedzial, ze tam sa ani co zawieraja
 * (np. klucze API rachunku). Panel znika, gdy kwarantanna jest pusta.
 */
export function KwarantannaPanel({ magazyn = magazynPrzegladarki() }: { magazyn?: Storage | null }) {
  const [pozycje, setPozycje] = useState<PozycjaKwarantanny[]>(() => (magazyn ? listaKwarantanny(magazyn) : []));
  const [komunikat, setKomunikat] = useState<string | null>(null);

  const odswiez = useCallback(() => {
    setPozycje(magazyn ? listaKwarantanny(magazyn) : []);
  }, [magazyn]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Inna karta mogla dolozyc albo usunac wpisy.
    window.addEventListener('storage', odswiez);
    return () => window.removeEventListener('storage', odswiez);
  }, [odswiez]);

  if (!magazyn || pozycje.length === 0) return null;

  const pobierz = (klucze: string[]) => {
    const stempel = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    pobierzPlik(eksportKwarantanny(magazyn, klucze), `investanalyzer-kwarantanna-${stempel}.json`);
    setKomunikat(`Pobrano ${klucze.length} ${odmienLiczebnik(klucze.length, 'pozycję', 'pozycje', 'pozycji')} kwarantanny do pliku.`);
  };

  const usun = (klucze: string[]) => {
    const pytanie = klucze.length === 1
      ? 'Usunąć tę pozycję kwarantanny? Surowa treść przepadnie, jeśli nie została pobrana do pliku.'
      : `Usunąć wszystkie pozycje kwarantanny (${klucze.length})? Surowa treść przepadnie, jeśli nie została pobrana do pliku.`;
    if (globalThis.window?.confirm(pytanie) !== true) return;
    const usuniete = usunZKwarantanny(magazyn, klucze);
    setKomunikat(`Usunięto ${usuniete} ${odmienLiczebnik(usuniete, 'pozycję', 'pozycje', 'pozycji')} kwarantanny.`);
    odswiez();
  };

  const wszystkie = pozycje.map((pozycja) => pozycja.klucz);

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-5 shadow-sm dark:border-amber-900/60 dark:bg-amber-950/20">
      <h3 className="mb-1 flex items-center gap-2 text-sm font-bold tracking-wider text-gray-800 dark:text-gray-200">
        <ShieldAlert className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        Kwarantanna nieczytelnych wpisów
      </h3>
      <p className="mb-4 text-sm text-gray-600 dark:text-gray-300">
        Wpisy, których program nie zdołał odczytać, zostały odłożone w tej przeglądarce zamiast skasowane.
        Mogą zawierać klucze API rachunków, więc nie trafiają do kopii na dysku. Pobierz je do pliku, jeśli chcesz
        je zachować, i usuń, gdy nie są już potrzebne — pełne czyszczenie danych ich nie rusza.
      </p>

      <ul className="divide-y divide-amber-200/70 dark:divide-amber-900/50">
        {pozycje.map((pozycja) => (
          <li key={pozycja.klucz} className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-800 dark:text-gray-200">
                {opisCzasu(pozycja.utworzono)}
                {' · '}
                {pozycja.wpisy.length} {odmienLiczebnik(pozycja.wpisy.length, 'wpis', 'wpisy', 'wpisów')}
                {' · '}
                {pozycja.znaki} {odmienLiczebnik(pozycja.znaki, 'znak', 'znaki', 'znaków')}
              </p>
              <p className="break-all text-xs text-gray-500 dark:text-gray-400">{pozycja.wpisy.join(', ')}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => pobierz([pozycja.klucz])}
                className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900/60 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                <Download size={14} /> Pobierz
              </button>
              <button
                type="button"
                onClick={() => usun([pozycja.klucz])}
                className="flex items-center gap-1.5 rounded-lg border border-rose-200 bg-white px-3 py-1.5 text-xs font-medium text-rose-700 transition-colors hover:bg-rose-50 dark:border-rose-800 dark:bg-gray-900/60 dark:text-rose-300 dark:hover:bg-rose-950/40"
              >
                <Trash2 size={14} /> Usuń
              </button>
            </div>
          </li>
        ))}
      </ul>

      {pozycje.length > 1 && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => pobierz(wszystkie)}
            className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900/60 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            <Download size={14} /> Pobierz wszystkie
          </button>
          <button
            type="button"
            onClick={() => usun(wszystkie)}
            className="flex items-center gap-1.5 rounded-lg border border-rose-200 bg-white px-3 py-1.5 text-xs font-medium text-rose-700 transition-colors hover:bg-rose-50 dark:border-rose-800 dark:bg-gray-900/60 dark:text-rose-300 dark:hover:bg-rose-950/40"
          >
            <Trash2 size={14} /> Usuń wszystkie
          </button>
        </div>
      )}

      {komunikat ? <p role="status" className="mt-3 text-sm text-emerald-700 dark:text-emerald-400">{komunikat}</p> : null}
    </div>
  );
}
