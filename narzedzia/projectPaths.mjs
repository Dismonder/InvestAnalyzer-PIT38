import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const narzedziaDir = dirname(fileURLToPath(import.meta.url));
export const rootDir = resolve(narzedziaDir, '..');
export const webDir = join(rootDir, 'aplikacje', 'web');
export const desktopDir = join(rootDir, 'aplikacje', 'komputerowa', 'tauri');
export const pythonEngineDir = join(rootDir, 'silnik', 'python');
export const storageDir = join(rootDir, 'dane', 'pliki');
export const backupsDir = join(rootDir, 'dane', 'backupy');
export const logsDir = join(rootDir, 'dane', 'logi');
export const tmpDir = join(rootDir, 'dane', 'tymczasowe');
export const scriptsDir = join(rootDir, 'narzedzia', 'skrypty');
export const wydaniaDir = join(rootDir, 'wydania');
export const wydaniaWebDir = join(wydaniaDir, 'web');
export const wydaniaDesktopDir = join(wydaniaDir, 'komputerowa');
