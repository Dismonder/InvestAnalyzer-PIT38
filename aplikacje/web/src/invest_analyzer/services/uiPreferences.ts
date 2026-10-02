import { getBrowserTaxSettingsStorage, type KeyValueStorageSource } from './taxEngineConfig';

export type ActionButtonLabelMode = 'full' | 'icon';
export type UiComplexityMode = 'simple' | 'expert';
export type UiLanguage = 'pl' | 'en';

export const ACTION_BUTTON_LABEL_MODE_KEY = 'historyActionButtonLabelMode';
export const HISTORY_SHOW_TECHNICAL_ROWS_KEY = 'historyShowTechnicalRows:v1';
export const UI_COMPLEXITY_MODE_KEY = 'uiComplexityMode:v1';
export const UI_LANGUAGE_KEY = 'uiLanguage:v1';
export const UI_PREFERENCES_CHANGED_EVENT = 'invest-analyzer-ui-preferences-changed';

export function getActionButtonLabelMode(storage: KeyValueStorageSource = getBrowserTaxSettingsStorage()): ActionButtonLabelMode {
  const rawValue = storage.getItem(ACTION_BUTTON_LABEL_MODE_KEY);
  return rawValue === 'icon' ? 'icon' : 'full';
}

export function saveActionButtonLabelMode(mode: ActionButtonLabelMode, storage: KeyValueStorageSource = getBrowserTaxSettingsStorage()): void {
  storage.setItem(ACTION_BUTTON_LABEL_MODE_KEY, mode);
  globalThis.window?.dispatchEvent(new Event(UI_PREFERENCES_CHANGED_EVENT));
}

export function getHistoryShowTechnicalRows(storage: KeyValueStorageSource = getBrowserTaxSettingsStorage()): boolean {
  return storage.getItem(HISTORY_SHOW_TECHNICAL_ROWS_KEY) === 'true';
}

export function saveHistoryShowTechnicalRows(showTechnicalRows: boolean, storage: KeyValueStorageSource = getBrowserTaxSettingsStorage()): void {
  storage.setItem(HISTORY_SHOW_TECHNICAL_ROWS_KEY, showTechnicalRows ? 'true' : 'false');
  globalThis.window?.dispatchEvent(new Event(UI_PREFERENCES_CHANGED_EVENT));
}

export function getUiComplexityMode(storage: KeyValueStorageSource = getBrowserTaxSettingsStorage()): UiComplexityMode {
  return storage.getItem(UI_COMPLEXITY_MODE_KEY) === 'expert' ? 'expert' : 'simple';
}

export function saveUiComplexityMode(mode: UiComplexityMode, storage: KeyValueStorageSource = getBrowserTaxSettingsStorage()): void {
  storage.setItem(UI_COMPLEXITY_MODE_KEY, mode);
  globalThis.window?.dispatchEvent(new Event(UI_PREFERENCES_CHANGED_EVENT));
}

export function getUiLanguage(storage: KeyValueStorageSource = getBrowserTaxSettingsStorage()): UiLanguage {
  return storage.getItem(UI_LANGUAGE_KEY) === 'en' ? 'en' : 'pl';
}

export function saveUiLanguage(language: UiLanguage, storage: KeyValueStorageSource = getBrowserTaxSettingsStorage()): void {
  storage.setItem(UI_LANGUAGE_KEY, language);
  globalThis.window?.dispatchEvent(new Event(UI_PREFERENCES_CHANGED_EVENT));
}
