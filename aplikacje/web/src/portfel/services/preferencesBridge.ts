/**
 * Wspolne ustawienia jezyka i motywu dla obu czesci aplikacji.
 *
 * Po polaczeniu projektow byly dwa niezalezne stany: portfel trzymal je pod
 * kluczami `pit38_lang` i `pit38_theme`, a warsztat silnika pod wlasnymi
 * kluczami w magazynie ustawien. Skutek byl widoczny od razu: powloka ciemna,
 * warsztat jasny, dwa przelaczniki jezyka pokazujace co innego.
 *
 * Tutaj zapis idzie do OBU magazynow i wysyla zdarzenie, ktorego warsztat
 * silnika juz nasluchuje, wiec obie strony przelaczaja sie od razu.
 */

import { getBrowserTaxSettingsStorage } from '../../invest_analyzer/services/taxEngineConfig';
import {
  UI_LANGUAGE_KEY,
  UI_PREFERENCES_CHANGED_EVENT,
} from '../../invest_analyzer/services/uiPreferences';
import type { Language } from '../types';

export type Motyw = 'dark' | 'light';

/** Zdarzenie, ktorego warsztat silnika juz nasluchuje. */
export const ZDARZENIE_PREFERENCJI = UI_PREFERENCES_CHANGED_EVENT;

const KLUCZ_JEZYKA_PORTFELA = 'pit38_lang';
const KLUCZ_MOTYWU_PORTFELA = 'pit38_theme';
const KLUCZ_MOTYWU_SILNIKA = 'theme';

const ZAKLADKI_PORTFELA = ['portfolio', 'tax', 'transactions', 'brokers', 'charts', 'alerts', 'engine', 'security'];

function odczytajTekst(klucz: string, magazyn?: Pick<Storage, 'getItem'>): string {
  try {
    return (magazyn ?? localStorage).getItem(klucz) ?? '';
  } catch {
    return '';
  }
}

/** Starsza lub uszkodzona preferencja nie moze prowadzic do pustej zakladki. */
export function odczytajZakladke(magazyn?: Pick<Storage, 'getItem'>): string {
  const zapis = odczytajTekst('pit38_active_tab', magazyn);
  return ZAKLADKI_PORTFELA.includes(zapis) ? zapis : 'portfolio';
}

export function odczytajRok(magazyn?: Pick<Storage, 'getItem'>, domyslny = new Date().getFullYear()): number {
  const zapis = odczytajTekst('pit38_selected_year', magazyn);
  // Czterocyfrowy rok kalendarzowy; Number('') i Number('NaN') nie sa latami.
  return /^[1-9]\d{3}$/.test(zapis) ? Number(zapis) : domyslny;
}

export function odczytajTickerWykresu(magazyn?: Pick<Storage, 'getItem'>): string {
  return odczytajTekst('pit38_selected_chart_ticker', magazyn);
}

function magazynSilnika() {
  return getBrowserTaxSettingsStorage();
}

function powiadomInterfejs(): void {
  globalThis.window?.dispatchEvent(new Event(UI_PREFERENCES_CHANGED_EVENT));
}

/** Jezyk startowy: decyduje ustawienie portfela, bo to jego pasek go przelacza. */
export function odczytajJezyk(): Language {
  try {
    const zPortfela = localStorage.getItem(KLUCZ_JEZYKA_PORTFELA);
    if (zPortfela === 'pl' || zPortfela === 'en') {
      return zPortfela;
    }
    const zSilnika = magazynSilnika().getItem(UI_LANGUAGE_KEY);
    return zSilnika === 'en' ? 'en' : 'pl';
  } catch {
    return 'pl';
  }
}

export function odczytajMotyw(): Motyw {
  try {
    const zPortfela = localStorage.getItem(KLUCZ_MOTYWU_PORTFELA);
    if (zPortfela === 'dark' || zPortfela === 'light') {
      return zPortfela;
    }
    return magazynSilnika().getItem(KLUCZ_MOTYWU_SILNIKA) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'dark';
  }
}

export function zapiszJezykWszedzie(jezyk: Language): void {
  try {
    localStorage.setItem(KLUCZ_JEZYKA_PORTFELA, jezyk);
    magazynSilnika().setItem(UI_LANGUAGE_KEY, jezyk);
  } catch {
    // Brak magazynu (tryb prywatny) nie moze wywracac przelacznika jezyka.
  }
  powiadomInterfejs();
}

export function zapiszMotywWszedzie(motyw: Motyw): void {
  try {
    localStorage.setItem(KLUCZ_MOTYWU_PORTFELA, motyw);
    magazynSilnika().setItem(KLUCZ_MOTYWU_SILNIKA, motyw);
  } catch {
    // jw.
  }
  if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('dark', motyw === 'dark');
  }
  powiadomInterfejs();
}

/** Jezyk zapisany po stronie warsztatu silnika - zrodlo przy zmianie w jego panelu. */
export function odczytajJezykSilnika(): Language {
  try {
    return magazynSilnika().getItem(UI_LANGUAGE_KEY) === 'en' ? 'en' : 'pl';
  } catch {
    return 'pl';
  }
}

export function odczytajMotywSilnika(): Motyw {
  try {
    return magazynSilnika().getItem(KLUCZ_MOTYWU_SILNIKA) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}
