import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Ile kopii recznych trzymamy na dysku. Starsze usuwamy, zeby katalog nie rosl bez konca. */
export const BACKUP_LIMIT = 30;
/** Kopie automatyczne (powod "Stan sprzed ...") maja wlasny, mniejszy limit. */
export const BACKUP_LIMIT_AUTOMATYCZNYCH = 10;
const BACKUP_PREFIX = "kopia-";
const BACKUP_SUFFIX = ".json";

export interface StoredBackupFile {
  id: string;
  path: string;
  createdAt: string;
  sizeBytes: number;
}

/**
 * Identyfikator kopii to nazwa pliku. Przyjmujemy wylacznie wlasny wzorzec,
 * zeby zadna sciezka podana z zewnatrz nie wyprowadzila poza katalog kopii.
 */
export function isBackupId(id: string): boolean {
  return (
    typeof id === "string" &&
    id.startsWith(BACKUP_PREFIX) &&
    id.endsWith(BACKUP_SUFFIX) &&
    id.length > BACKUP_PREFIX.length + BACKUP_SUFFIX.length &&
    /^[A-Za-z0-9._-]+$/.test(id)
  );
}

function ensureDir(backupsRoot: string): void {
  mkdirSync(backupsRoot, { recursive: true });
}

function readCreatedAt(filePath: string, fallback: string): string {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    const createdAt = parsed?.createdAt;
    return typeof createdAt === "string" && createdAt ? createdAt : fallback;
  } catch {
    return fallback;
  }
}

export function listBackupSnapshots(backupsRoot: string): StoredBackupFile[] {
  ensureDir(backupsRoot);
  const files: StoredBackupFile[] = [];
  for (const name of readdirSync(backupsRoot)) {
    if (!isBackupId(name)) continue;
    const filePath = path.join(backupsRoot, name);
    let stats;
    try {
      stats = statSync(filePath);
    } catch {
      continue;
    }
    if (!stats.isFile()) continue;
    files.push({
      id: name,
      path: filePath,
      createdAt: readCreatedAt(filePath, name),
      sizeBytes: stats.size,
    });
  }
  return files.sort((left, right) => porownajKolejnoscKopii(right.id, left.id));
}

/**
 * Klucz porzadku kopii: znacznik czasu (15 znakow) i numer kolejny z sufiksu "-N" (kopia bez sufiksu
 * ma numer 1, "-auto" nie liczy sie do numeru). Jak backup_order w wersji desktopowej: porownanie
 * tekstowe stawialo "-10" przed "-2", wiec rotacja usuwala niewlasciwe kopie z tej samej sekundy.
 */
function kluczKolejnosciKopii(id: string): [string, number] {
  const trzon = id.slice(BACKUP_PREFIX.length, id.length - BACKUP_SUFFIX.length);
  const znacznik = trzon.slice(0, 15);
  if (znacznik.length < 15) return [id, 0];
  const ogon = trzon.slice(15).replace(/^-auto/, "");
  if (ogon === "") return [znacznik, 1];
  const numer = /^-(\d+)$/.exec(ogon);
  return numer ? [znacznik, Number(numer[1])] : [id, 0];
}

function porownajKolejnoscKopii(lewa: string, prawa: string): number {
  const [znacznikLewej, numerLewej] = kluczKolejnosciKopii(lewa);
  const [znacznikPrawej, numerPrawej] = kluczKolejnosciKopii(prawa);
  if (znacznikLewej !== znacznikPrawej) return znacznikLewej < znacznikPrawej ? -1 : 1;
  if (numerLewej !== numerPrawej) return numerLewej - numerPrawej;
  return lewa < prawa ? -1 : lewa > prawa ? 1 : 0;
}
function backupStamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/**
 * Kopia automatyczna to kopia zabezpieczajaca (purpose: "safety", robiona przed
 * przywroceniem/wczytaniem/wyczyszczeniem). Sam powod nie rozstrzyga: przycisk
 * "Zapisz kopie" tez podaje powod, a kopia reczna nie moze byc rotowana limitem
 * kopii automatycznych. Kopie bez pola (starsze) sa reczne.
 */
function jestAutomatyczna(snapshot: unknown): boolean {
  const purpose = snapshot && typeof snapshot === "object" ? (snapshot as { purpose?: unknown }).purpose : undefined;
  return purpose === "safety";
}

const ZNACZNIK_AUTOMATYCZNEJ = "-auto";
const jestAutomatycznaId = (id: string) => id.includes(ZNACZNIK_AUTOMATYCZNEJ);

/**
 * Odcisk tresci bez pol, ktore zawsze sie roznia (czas utworzenia, powod):
 * dwie kopie tego samego stanu maja ten sam odcisk.
 */
function odciskTresci(snapshot: unknown): string {
  if (!snapshot || typeof snapshot !== "object") return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  const { createdAt: _createdAt, reason: _reason, ...tresc } = snapshot as Record<string, unknown>;
  return createHash("sha256").update(JSON.stringify(tresc)).digest("hex");
}

export function writeBackupSnapshot(
  backupsRoot: string,
  snapshot: unknown,
  now: Date = new Date(),
): StoredBackupFile {
  ensureDir(backupsRoot);
  const automatyczna = jestAutomatyczna(snapshot);

  // Kopia identyczna z ostatnia tego samego rodzaju nie wnosi nic, a wypieralaby
  // starsze kopie z ograniczonej puli - zwracamy istniejaca.
  const ostatnia = listBackupSnapshots(backupsRoot).find((entry) => jestAutomatycznaId(entry.id) === automatyczna);
  if (ostatnia) {
    try {
      if (odciskTresci(JSON.parse(readFileSync(ostatnia.path, "utf8"))) === odciskTresci(snapshot)) return ostatnia;
    } catch {
      // Nieczytelna ostatnia kopia: zapisujemy nowa.
    }
  }

  // Znacznik ma rozdzielczosc sekundy. Dwa zapisy w tej samej sekundzie trafialy
  // na te sama nazwe i drugi po cichu nadpisywal pierwszy.
  const stamp = `${BACKUP_PREFIX}${backupStamp(now)}${automatyczna ? ZNACZNIK_AUTOMATYCZNEJ : ""}`;
  let id = `${stamp}${BACKUP_SUFFIX}`;
  for (let attempt = 2; existsSync(path.join(backupsRoot, id)); attempt += 1) {
    id = `${stamp}-${attempt}${BACKUP_SUFFIX}`;
  }
  const filePath = path.join(backupsRoot, id);
  const body = JSON.stringify(snapshot, null, 2);
  // Zapis przez plik tymczasowy i zmiane nazwy: przerwany zapis nie zostawia
  // uciętej kopii, ktora wygladalaby na prawidlowa. Nazwa z kropka nie jest
  // identyfikatorem kopii, wiec pozostalosc po awarii nie trafia na liste.
  const tymczasowy = path.join(backupsRoot, `.${id}.tmp`);
  try {
    writeFileSync(tymczasowy, body, "utf8");
    renameSync(tymczasowy, filePath);
  } catch (error) {
    rmSync(tymczasowy, { force: true });
    throw error;
  }

  // Kopie reczne i automatyczne rotujemy osobno: seria automatycznych kopii
  // "Stan sprzed ..." nie moze wypchnac recznych, a odwrotnie tez nie.
  // Zostaje kopia wlasnie zapisana oraz najnowsze pozostale tego rodzaju. Kopia
  // nowa nie moze paść ofiara sprzatania: gdy zegar komputera cofnal sie, jej
  // identyfikator sortuje sie ponizej istniejacych, a funkcja zwracala wtedy
  // nazwe pliku, ktorego juz nie bylo.
  const limit = automatyczna ? BACKUP_LIMIT_AUTOMATYCZNYCH : BACKUP_LIMIT;
  const others = listBackupSnapshots(backupsRoot).filter(
    (entry) => entry.id !== id && jestAutomatycznaId(entry.id) === automatyczna,
  );
  for (const stale of others.slice(limit - 1)) {
    try {
      rmSync(stale.path, { force: true });
    } catch {
      // Nieudane sprzatanie nie moze uniewaznic zapisanej kopii.
    }
  }

  const createdAt =
    snapshot && typeof snapshot === "object" && typeof (snapshot as { createdAt?: unknown }).createdAt === "string"
      ? String((snapshot as { createdAt: string }).createdAt)
      : id;
  return { id, path: filePath, createdAt, sizeBytes: Buffer.byteLength(body, "utf8") };
}

export function readBackupSnapshot(backupsRoot: string, id: string): unknown {
  if (!isBackupId(id)) {
    throw new Error(`Nieprawidłowy identyfikator kopii: ${id}`);
  }
  return JSON.parse(readFileSync(path.join(backupsRoot, id), "utf8"));
}

/** Ile kopii *.bak zostaje dla kazdego pliku eksportu Freedom24. */
export const KOPII_EKSPORTU_FREEDOM24 = 10;

/**
 * Kopia poprzedniej wersji eksportu Freedom24 przed nadpisaniem (poza magazynem
 * skanowanym przez silnik). Nie kopiuje, gdy nowa tresc jest identyczna z obecna
 * albo obecna jest identyczna z ostatnia kopia; zostawia ostatnie
 * KOPII_EKSPORTU_FREEDOM24 kopii danego pliku. Zwraca, czy kopia powstala.
 */
export async function zachowajPoprzedniaWersjeEksportu(
  backupsRoot: string,
  targetPath: string,
  nowaTresc: Buffer,
  timestamp: string,
): Promise<boolean> {
  const fsPromises = await import("node:fs/promises");
  await fsPromises.mkdir(backupsRoot, { recursive: true });
  const parsed = path.parse(targetPath);
  const obecna = await fsPromises.readFile(targetPath);
  if (obecna.equals(nowaTresc)) return false;

  const koniec = `.bak${parsed.ext}`;
  const istniejace = (await fsPromises.readdir(backupsRoot))
    .filter((nazwa) => nazwa.startsWith(`${parsed.name}-`) && nazwa.endsWith(koniec))
    .sort();
  const ostatnia = istniejace[istniejace.length - 1];
  let nowa: string | null = null;
  if (!ostatnia || !(await fsPromises.readFile(path.join(backupsRoot, ostatnia))).equals(obecna)) {
    // Dwie zmiany w tej samej milisekundzie (A -> B, B -> C) mialy ten sam
    // znacznik, a copyFile nadpisywal wczesniejsza kopie - wersja A ginela.
    // COPYFILE_EXCL + kolejny sufiks (znak '~' sortuje sie za '.', wiec kopia z
    // sufiksem jest "nowsza" od bazowej).
    for (let proba = 1; nowa === null; proba += 1) {
      const nazwa = proba === 1
        ? `${parsed.name}-${timestamp}${koniec}`
        : `${parsed.name}-${timestamp}~${String(proba).padStart(2, "0")}${koniec}`;
      try {
        await fsPromises.copyFile(targetPath, path.join(backupsRoot, nazwa), fsConstants.COPYFILE_EXCL);
        nowa = nazwa;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "EEXIST" || proba > 1000) throw error;
      }
    }
    istniejace.push(nowa);
  }
  // Rotacja dopiero po udanym zapisie (wyjatek wyzej ja pomija) i nigdy nie usuwa
  // kopii wlasnie zapisanej - cofniety zegar dawalby jej nazwe ponizej pozostalych.
  const doUsuniecia = istniejace.filter((nazwa) => nazwa !== nowa).sort();
  const zostaje = KOPII_EKSPORTU_FREEDOM24 - (nowa ? 1 : 0);
  for (const stara of doUsuniecia.slice(0, Math.max(0, doUsuniecia.length - zostaje))) {
    await fsPromises.rm(path.join(backupsRoot, stara), { force: true }).catch(() => undefined);
  }
  return nowa !== null;
}
