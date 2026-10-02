import type { LogEntry } from '../types';

const LOG_STAGE_LABELS: Record<LogEntry['stage'], string> = {
  'LOAD FILE': 'ŁADOWANIE DANYCH',
  'PARSE DATA': 'PARSOWANIE',
  'CLASSIFY TRANSACTION': 'KLASYFIKACJA TRANSAKCJI',
  'CALCULATE BALANCE': 'SALDO',
  'CALCULATE PROFIT': 'WYNIK',
  'VALIDATE DATA': 'WALIDACJA',
  'END PROCESS': 'ZAKOŃCZENIE',
  'DEBUG PANEL': 'PANEL SYSTEMOWY',
  'CLEANUP': 'CZYSZCZENIE',
  'ENGINE': 'SILNIK PODATKOWY',
  'WARSTWA OVERRIDE': 'WARSTWA OVERRIDE',
  'AUTO_IMPORT': 'AUTOIMPORT STORAGE',
};

export function formatLogStageLabel(stage: LogEntry['stage'] | string): string {
  return LOG_STAGE_LABELS[stage as LogEntry['stage']] || stage;
}
