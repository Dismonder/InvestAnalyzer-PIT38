import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { rootDir } from '../projectPaths.mjs';
import { znajdzPoswiadczeniaWTekscie } from './skan-poswiadczen.mjs';

const portableRoot = join(rootDir, 'wydania', 'komputerowa', 'przenosna');
// Jedno zrodlo wzorcow razem z testem dymnym paczki przenosnej. Dwie kopie tej
// listy zdazyly sie rozjechac: paczka przenosna przechodzila kontrole, ktorej
// repozytorium by nie przeszlo.
const privateNamePatternsFile = join(rootDir, 'narzedzia', 'prywatne_wzorce.json');
const privateNamePatterns = (() => {
  const payload = JSON.parse(readFileSync(privateNamePatternsFile, 'utf8'));
  const patterns = (payload.wzorce || [])
    .map((entry) => String(entry).trim())
    .filter(Boolean)
    .map((entry) => new RegExp(entry.replaceAll('.', '[.]'), 'i'));
  if (patterns.length === 0) {
    throw new Error(`Pusta lista wzorcow w ${privateNamePatternsFile}.`);
  }
  return patterns;
})();

function walkFiles(dir) {
  if (!existsSync(dir)) return [];
  const result = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...walkFiles(fullPath));
    } else if (entry.isFile()) {
      result.push(fullPath);
    }
  }
  return result;
}

// dane/pliki celowo trzyma lokalne pliki brokera, zeby testy integracyjne
// liczyly na prawdziwych danych. Bramka nie zabrania ich obecnosci - pilnuje,
// zeby zaden z nich nie byl sledzony przez gita.
// Bramka wykrywa wycieki na podstawie listy plikow sledzonych przez gita.
// Gdy git zawiedzie - brak w PATH, katalog nie jest repozytorium - kazde
// zapytanie zwracaloby pusta liste, bramka nie przeskanowalaby ani jednego
// pliku i mimo to oglosila, ze kod jest czysty. Awaria narzedzia musi
// zatrzymac bramke, a nie zamienic ja w atrape.
function trackedFilesUnder(relDir) {
  let output;
  try {
    output = execFileSync('git', ['ls-files', '--', relDir], {
      cwd: rootDir,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(
      `Nie udało się odczytać listy plików śledzonych przez gita dla "${relDir}". ` +
        'Bramka danych osobowych nie może potwierdzić czystości repozytorium. ' +
        `Powód: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((path) => !path.endsWith('.gitkeep'));
}

function untrackedFilesUnder(relDir) {
  let output;
  try {
    output = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', relDir], {
      cwd: rootDir,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(
      `Nie udało się odczytać listy plików nieśledzonych przez gita dla "${relDir}". ` +
        'Bramka danych osobowych nie może potwierdzić czystości repozytorium. ' +
        `Powód: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return output.split(/\r?\n/).filter(Boolean).filter((path) => !path.endsWith('.gitkeep'));
}

// Wzorce dla kodu zrodlowego sa wezsze niz dla artefaktow: nazwy plikow
// strukturalnych (tradernet_table_excel.py, domyslne nazwy wejsc w cli.py)
// sa poprawne, a wyciekiem jest dopiero konkretna osoba, jej adres e-mail
// albo sciezka do prywatnego profilu Windows.
// example.com, example.org i example.net sa zarezerwowane norma RFC 2606.
// Dopisane wyjatki dotycza wylacznie domen: polskie domeny przykladowe
// (przyklad.pl, przyklad.com) i domena .local uzywana w wystawcy kodu TOTP.
// Wyjatku po stronie nazwy uzytkownika celowo nie ma - wyprzedzenie da sie
// obejsc, dopasowujac adres o znak dalej, wiec dawaloby zludne poczucie
// kontroli. Podpowiedzi w formularzach maja uzywac domen przykladowych.
// wylacznie do dokumentacji i testow, wiec nie moga byc czyimkolwiek adresem.
const sourceLeakPatterns = [
  { label: 'imie wlasciciela', pattern: /damian/i },
  {
    label: 'adres e-mail',
    // Wykluczone koncowki to rozszerzenia plikow, nie domeny: "128x128@2x.png"
    // w tauri.conf.json pasowalo do wzorca adresu i zatrzymywalo bramke.
    pattern:
      /[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net)\b|przyklad\.pl\b|przyklad\.com\b|[A-Za-z0-9.-]+\.local\b)[A-Za-z0-9.-]+\.(?!png|jpe?g|gif|svg|webp|ico|woff2?|ttf|css|jsx?|tsx?|mjs|json|md|html?|txt|zip|exe|dll)[A-Za-z]{2,}/,
  },
  {
    label: 'sciezka do prywatnego profilu Windows',
    pattern: /[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}(?!TestUser|Public|Default|All Users)[A-Za-z0-9._-]+/i,
  },
];

// Bramka skanowala wczesniej liste wybranych katalogow. Kazdy nowy katalog z
// wynikami silnika byl wiec dla niej niewidzialny - tak do repozytorium trafil
// sledzony katalog "out/" z prawdziwymi danymi konta. Teraz skanowany jest
// kazdy plik sledzony przez gita, a wyjatki sa wymienione z nazwy.
// Katalogi z wynikami uruchomien nie moga byc sledzone w ogole: ich tresc
// zawsze pochodzi z prywatnych plikow uzytkownika.
const forbiddenTrackedDirs = ['dane/pliki', 'dane/out', 'dane/backupy', 'dane/API', 'dane/logi', 'dane/archiwum', 'dane/notowania_nocne', 'out', 'silnik/python/out', 'dane/tymczasowe', 'wydania'];

// Plikow binarnych nie da sie sensownie przeszukac jako tekst, wiec sprawdzana
// jest wylacznie ich nazwa.
const binaryExtensions = /\.(xlsx|xlsm|xls|pdf|png|jpe?g|gif|ico|zip|exe|dll|woff2?|ttf|bin)$/i;

// Bramki skanuja wlasny kod, wiec musza pominac wlasne definicje wzorcow.
// Plik wzorcow z natury zawiera szukane slowa - to definicja, nie wyciek.
// smoke_desktop_portable.py czyta te sama liste i tez jej nie powiela.
const sourceScanExclusions = new Set([
  'narzedzia/skrypty/assert-no-private-data.mjs',
  'narzedzia/skrypty/smoke_desktop_portable.py',
  'narzedzia/prywatne_wzorce.json',
]);

// Jawna lista wyjatkow skanu poswiadczen: plik + nazwa klucza, ktorego wartosc nie
// jest sekretem. Kazdy wpis wymaga uzasadnienia; wyjatek dotyczy tylko tego klucza
// w tym pliku, nie calego pliku.
const credentialScanExceptions = [
  {
    path: 'jakosc/testy/frontend/totp.test.ts',
    key: 'RFC_6238_SECRET',
    reason: 'publiczny wektor testowy z RFC 6238, nie poswiadczenie',
  },
];

let untrackedSourcesScanned = 0;
function scanTrackedSources() {
  const leaks = [];
  const untracked = untrackedFilesUnder('.');
  untrackedSourcesScanned = untracked.length;
  for (const rel of [...new Set([...trackedFilesUnder('.'), ...untracked])]) {
    if (sourceScanExclusions.has(rel)) continue;
    if (binaryExtensions.test(rel)) {
      if (isPrivateName(rel)) leaks.push(`${rel} -> prywatna nazwa pliku`);
      continue;
    }
    let text = '';
    try {
      text = readFileSync(join(rootDir, rel), 'utf8');
    } catch {
      continue;
    }
    for (const { label, pattern } of sourceLeakPatterns) {
      const match = text.match(pattern);
      if (match) {
        leaks.push(`${rel} -> ${label}: ${match[0].slice(0, 60)}`);
        break;
      }
    }
    // Poswiadczenia wpisane w kod (klucze API, tokeny, hasla, klucze prywatne).
    // Raport zawiera tylko numer linii i zamaskowany poczatek wartosci.
    for (const { linia, opis } of znajdzPoswiadczeniaWTekscie(text)) {
      const wyjatek = credentialScanExceptions.some((entry) => entry.path === rel && opis.includes(`"${entry.key}"`));
      if (!wyjatek) leaks.push(`${rel}:${linia} -> poswiadczenie w kodzie, ${opis}`);
    }
  }
  return leaks;
}

function isPrivateName(name) {
  return privateNamePatterns.some((pattern) => pattern.test(name));
}

// Lista nazw plikow w archiwum ZIP, czytana wprost z centralnego katalogu.
//
// Wczesniej robil to `tar -tf`, a wynik szedl do `catch { continue; }`. GNU tar
// z Git Basha w ogole nie czyta ZIP-ow ("This does not look like a tar archive"),
// wiec bramka po cichu pomijala kazde archiwum i mimo to oglaszala sukces -
// zaleznie od tego, ktory `tar` byl pierwszy w PATH. Bramka bezpieczenstwa nie
// moze zalezec od takiego przypadku, wiec czytamy archiwum sami.
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_ENTRY_SIGNATURE = 0x02014b50;
const ZIP_EOCD_MAX_COMMENT = 0xffff;

function listZipEntries(zipPath) {
  const buffer = readFileSync(zipPath);
  const scanFrom = Math.max(0, buffer.length - (ZIP_EOCD_MAX_COMMENT + 22));
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= scanFrom; offset -= 1) {
    if (buffer.readUInt32LE(offset) === ZIP_EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error(`Nie znaleziono katalogu centralnego w archiwum ${zipPath}.`);
  }

  const entryCount = buffer.readUInt16LE(eocd + 10);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (entryCount === 0xffff || directoryOffset === 0xffffffff) {
    throw new Error(`Archiwum ${zipPath} jest w formacie ZIP64, ktorego ta bramka nie czyta.`);
  }

  const entries = [];
  let cursor = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== ZIP_CENTRAL_ENTRY_SIGNATURE) {
      throw new Error(`Uszkodzony katalog centralny w archiwum ${zipPath} przy wpisie ${index}.`);
    }
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    entries.push(buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function scanPortableEntries() {
  const files = walkFiles(portableRoot);
  const leaks = [];
  for (const file of files) {
    const rel = relative(rootDir, file).replaceAll('\\', '/');
    if (rel.endsWith('NAJNOWSZA_WERSJA.txt')) continue;
    if (rel.includes('/binaries/investment-tax-engine/')) continue;
    if (isPrivateName(rel)) leaks.push(rel);
  }
  for (const zipPath of files.filter((file) => file.toLowerCase().endsWith('.zip'))) {
    // Nieczytelne archiwum zatrzymuje bramke. Milczace pominiecie znaczyloby, ze
    // paczka do rozdania nigdy nie zostala sprawdzona.
    const entries = listZipEntries(zipPath);
    for (const entry of entries) {
      if (entry.includes('/binaries/investment-tax-engine/')) continue;
      if (isPrivateName(entry)) leaks.push(`${relative(rootDir, zipPath).replaceAll('\\', '/')} -> ${entry}`);
    }
  }
  return leaks;
}

const errors = [];

// dane/pliki celowo trzyma lokalne pliki brokera, a katalogi z wynikami silnika
// powstaja przy kazdym uruchomieniu. Zaden z nich nie moze byc sledzony.
for (const dir of forbiddenTrackedDirs) {
  const tracked = trackedFilesUnder(dir);
  if (tracked.length > 0) {
    errors.push(
      `${dir} zawiera pliki sledzone przez gita (wyniki uruchomien na prywatnych danych nie naleza do repozytorium):\n` +
        tracked.slice(0, 30).map((entry) => `  - ${entry}`).join('\n'),
    );
  }
}

const sourceLeaks = scanTrackedSources();
if (sourceLeaks.length > 0) {
  errors.push(`Kod zrodlowy zawiera dane osobowe:\n${sourceLeaks.slice(0, 30).map((entry) => `  - ${entry}`).join('\n')}`);
}

const portableLeaks = scanPortableEntries();
if (portableLeaks.length > 0) {
  errors.push(`Wydania portable zawierają prywatnie wyglądające nazwy:\n${portableLeaks.slice(0, 30).map((entry) => `  - ${entry}`).join('\n')}`);
}

if (errors.length > 0) {
  console.error('Private data guard failed:');
  for (const error of errors) {
    console.error(error);
  }
  process.exit(1);
}

console.log(
  `Private data guard passed: ${forbiddenTrackedDirs.join(', ')} nie sa sledzone przez gita, ` +
    `przeskanowano nieśledzonych plików: ${untrackedSourcesScanned}, ` +
    'zaden sledzony plik nie zawiera danych osobowych, a wydania portable nie ujawniaja prywatnych nazw.',
);
