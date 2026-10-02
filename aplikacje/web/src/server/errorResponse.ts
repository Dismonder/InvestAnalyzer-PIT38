/**
 * Komunikaty bledow odsylane do przegladarki.
 *
 * `error.message` szedl wczesniej do odpowiedzi HTTP dosłownie. Bledy systemu
 * plikow niosa pelna sciezke - "ENOENT: no such file or directory, stat
 * 'C:\Users\<nazwa>\...'" - wiec nazwa konta uzytkownika trafiala do
 * przegladarki, chociaz w kazdym innym miejscu ten program ja zaslania.
 *
 * Przepuszczamy wiec tylko komunikaty, ktore aplikacja sama napisala; reszta
 * dostaje ogolny opis, a szczegoly zostaja w logu serwera.
 */

/** Fragmenty wlasnych komunikatow walidacyjnych aplikacji. */
const APPLICATION_MESSAGE_PATTERNS: RegExp[] = [
  /rok podatkowy/i,
  /zakresem/i,
  /liczbą całkowitą/i,
  /nazwa pliku/i,
  /format pliku/i,
  /poza katalogiem/i,
  /nieobsługiwana nazwa pliku/i,
  /identyfikator kopii/i,
  /kopii/i,
  /silnika/i,
  /storage/i,
  /JSON/i,
];

/** Sciezka do profilu uzytkownika w komunikacie oznacza wyciek nazwy konta. */
const WINDOWS_SEPARATOR = String.fromCharCode(92);
const HOST_PATHS: RegExp[] = [
  /[a-z]:\/users\//,        // C:/Users/<nazwa>
  /(^|[^a-z])\/home\//,      // Linux: /home/<nazwa>
  /(^|[^a-z])\/users\//,     // macOS: /Users/<nazwa>
  /(^|[^a-z])\/root(\/|$)/,   // konto administratora
  /^\/\/[^/]+\//,             // udzial sieciowy \\serwer\zasob
];

/**
 * Kody bledow systemowych. Komunikat z takim kodem nigdy nie pochodzi od tej
 * aplikacji, wiec nie moze przejsc przez liste dozwolonych wzorcow - inaczej
 * wystarczy, ze systemowy blad wspomni plik ".json", i cala tresc (razem ze
 * sciezka) idzie do przegladarki.
 */
const SYSTEM_ERROR_CODE = /\b(ENOENT|EACCES|EPERM|EEXIST|EISDIR|ENOTDIR|EMFILE|ENFILE|EBUSY|ENOSPC|EROFS|ELOOP|ENAMETOOLONG|ECONNREFUSED|ETIMEDOUT)\b/;

function containsHostPath(message: string): boolean {
  // Ujednolicamy separator, zeby nie walczyc z ucieczkami w wyrazeniu.
  const normalized = message.split(WINDOWS_SEPARATOR).join('/').toLowerCase();
  return HOST_PATHS.some((pattern) => pattern.test(normalized));
}

export function isApplicationMessage(message: string): boolean {
  if (SYSTEM_ERROR_CODE.test(message)) {
    return false;
  }
  if (containsHostPath(message)) {
    return false;
  }
  return APPLICATION_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

export function getServerErrorMessage(error: unknown, fallback = "Wystąpił błąd serwera."): string {
  const raw =
    error instanceof Error && error.message.trim()
      ? error.message
      : typeof error === "string" && error.trim()
        ? error
        : "";

  if (!raw) {
    return fallback;
  }
  return isApplicationMessage(raw) ? raw : fallback;
}

export function getServerErrorStatus(message: string): number {
  return /rok podatkowy|zakresem|liczbą całkowitą|nazwa pliku|format pliku|poza katalogiem/i.test(message)
    ? 400
    : 500;
}
