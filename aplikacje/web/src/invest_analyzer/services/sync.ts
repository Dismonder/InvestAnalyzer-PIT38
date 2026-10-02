import { LogEntry } from '../types';
import { StorageService } from './storage';
import { getErrorMessage } from './errorMessage';
import { getStorageFileDisposition, isBrokerReportFile, storageDispositionMessage } from './storageImportDisposition';
import { runtimeApi } from './runtimeApi';

export const SyncService = {
  /**
   * Oznacza pliki z magazynu jako rozpoznane i zapisuje, jaka role kazdy z nich
   * pelni. Sama tresc idzie do silnika przez canonical_tax_input.json - ta
   * funkcja nie kopiuje juz transakcji do przegladarki.
   */
  async markStorageFilesProcessed(
    addLog: (level: LogEntry['level'], stage: LogEntry['stage'], message: string, details?: unknown) => void,
  ): Promise<string[]> {
    try {
      const files = (await runtimeApi.listStorageFilePaths())
        .filter((f: string) => f !== '.keep' && !f.startsWith('.'));
      const processedFiles = await StorageService.getProcessedStorageFiles();
      const newlyProcessed: string[] = [];

      for (const filename of files) {
        if (processedFiles.includes(filename)) {
          continue;
        }

        const disposition = getStorageFileDisposition(filename);
        if (disposition === 'evidence' || disposition === 'analytics' || disposition === 'reconciliation') {
          addLog('info', 'AUTO_IMPORT', storageDispositionMessage(filename, disposition));
        } else if (isBrokerReportFile(filename)) {
          addLog(
            'info',
            'AUTO_IMPORT',
            `Zsynchronizowano ${filename} jako źródło danych. Transaction Intelligence zapisze wpływ rekordu w canonical_tax_input.json.`,
          );
        } else {
          addLog(
            'info',
            'AUTO_IMPORT',
            `Zsynchronizowano ${filename} ze storage. Rozpoznanie i kwalifikacja idą przez canonical_tax_input.json.`,
          );
        }

        processedFiles.push(filename);
        newlyProcessed.push(filename);
      }

      if (newlyProcessed.length > 0) {
        await StorageService.saveProcessedStorageFiles(processedFiles);
      }
      return newlyProcessed;
    } catch (error: unknown) {
      addLog('warn', 'AUTO_IMPORT', 'Skrypt auto-importu napotkał problem', getErrorMessage(error));
      return [];
    }
  },
};
