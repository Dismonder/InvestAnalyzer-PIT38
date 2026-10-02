use crate::commands::app_paths::resolve_app_paths;
use crate::engine::errors::{DesktopError, DesktopResult};
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

/// Ile kopii trzymamy na dysku. Starsze usuwamy, zeby katalog nie rosl bez konca.
const BACKUP_LIMIT: usize = 30;
/// Kopie zabezpieczajace (purpose: safety, sufiks -auto) maja wlasny, mniejszy limit (jak w web).
const BACKUP_LIMIT_AUTOMATYCZNYCH: usize = 10;
const AUTO_MARKER: &str = "-auto";
const BACKUP_PREFIX: &str = "kopia-";
const BACKUP_SUFFIX: &str = ".json";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredBackupFile {
    pub id: String,
    pub path: String,
    pub created_at: String,
    pub size_bytes: u64,
}

fn backups_dir(app: &AppHandle) -> DesktopResult<PathBuf> {
    let paths = resolve_app_paths(app)?;
    let dir = PathBuf::from(&paths.backups_dir);
    fs::create_dir_all(&dir).map_err(|error| {
        DesktopError::io(
            "STORAGE_PERMISSION_DENIED",
            "Cannot create backups directory",
            error,
        )
    })?;
    Ok(dir)
}

/// Identyfikator kopii to nazwa pliku. Przyjmujemy wylacznie wlasny wzorzec,
/// zeby zadna sciezka podana z zewnatrz nie wyprowadzila poza katalog kopii.
fn resolve_backup_path(dir: &Path, id: &str) -> DesktopResult<PathBuf> {
    let valid = id.starts_with(BACKUP_PREFIX)
        && id.ends_with(BACKUP_SUFFIX)
        && id.len() > BACKUP_PREFIX.len() + BACKUP_SUFFIX.len()
        && id.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || character == '-'
                || character == '.'
                || character == '_'
        });
    if !valid {
        return Err(DesktopError::new(
            "INVALID_BACKUP_ID",
            format!("Nieprawidłowy identyfikator kopii: {id}"),
            false,
        ));
    }
    Ok(dir.join(id))
}

fn collect_backup_files(dir: &Path) -> Vec<StoredBackupFile> {
    let mut files: Vec<StoredBackupFile> = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return files;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // Ten sam wzorzec, ktorego uzywa odczyt. Luzniejszy filtr pokazywal na
        // liscie pliki, ktorych przycisk "Przywroc" nie potrafil otworzyc, i
        // pozwalal sprzataniu usunac cudzy plik o podobnej nazwie.
        if resolve_backup_path(dir, &name).is_err() {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let created_at = read_created_at(&entry.path()).unwrap_or_else(|| name.clone());
        files.push(StoredBackupFile {
            id: name,
            path: entry.path().to_string_lossy().to_string(),
            created_at,
            size_bytes: metadata.len(),
        });
    }
    files.sort_by(|left, right| backup_order(&right.id).cmp(&backup_order(&left.id)));
    files
}

fn backup_order(id: &str) -> (&str, u64) {
    let Some(stem) = id.strip_prefix(BACKUP_PREFIX).and_then(|name| name.strip_suffix(BACKUP_SUFFIX)) else {
        return (id, 0);
    };
    let Some(stamp) = stem.get(..15) else {
        return (id, 0);
    };
    // Znacznik kopii zabezpieczajacej (-auto) nie wchodzi do numeru kolejnego.
    let tail = stem.get(15..).map(|tail| tail.strip_prefix(AUTO_MARKER).unwrap_or(tail));
    let suffix = match tail {
        Some("") => 1,
        Some(tail) => match tail.strip_prefix('-').and_then(|number| number.parse().ok()) {
            Some(number) => number,
            None => return (id, 0),
        },
        None => return (id, 0),
    };
    (stamp, suffix)
}

fn read_created_at(path: &Path) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&content).ok()?;
    value
        .get("createdAt")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Kopia zabezpieczajaca (purpose: "safety", robiona przed przywroceniem/wczytaniem/
/// wyczyszczeniem) jest automatyczna; kopie reczne i starsze bez pola nie. Sam powod
/// nie rozstrzyga - jak w wersji web (backupStore.ts).
fn is_automatic_snapshot(snapshot: &Value) -> bool {
    snapshot.get("purpose").and_then(Value::as_str) == Some("safety")
}

fn is_automatic_id(id: &str) -> bool {
    id.contains(AUTO_MARKER)
}

/// Odcisk tresci bez pol, ktore zawsze sie roznia (czas utworzenia, powod).
fn content_fingerprint(snapshot: &Value) -> Value {
    let mut content = snapshot.clone();
    if let Some(map) = content.as_object_mut() {
        map.remove("createdAt");
        map.remove("reason");
    }
    content
}

/// Sprzatanie nigdy nie moze usunac kopii, ktora wlasnie powstala. Gdy zegar
/// komputera cofnal sie, jej identyfikator sortuje sie ponizej istniejacych i
/// trafiala do usuniecia razem ze starymi. Kopie reczne i automatyczne rotujemy
/// osobno: seria kopii "Stan sprzed ..." nie moze wypchnac recznych.
fn prune_old_backups(dir: &Path, just_written: &str, automatic: bool) {
    let limit = if automatic { BACKUP_LIMIT_AUTOMATYCZNYCH } else { BACKUP_LIMIT };
    let others: Vec<StoredBackupFile> = collect_backup_files(dir)
        .into_iter()
        .filter(|entry| entry.id != just_written && is_automatic_id(&entry.id) == automatic)
        .collect();
    for stale in others.into_iter().skip(limit - 1) {
        let _ = fs::remove_file(stale.path);
    }
}

/// Atomowa rezerwacja nazwy wspolna dla wszystkich instancji procesu.
struct BackupPublicationReservation {
    path: PathBuf,
}

impl Drop for BackupPublicationReservation {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn backup_target_exists(path: &Path) -> std::io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub fn write_backup_snapshot(app: AppHandle, snapshot: Value) -> DesktopResult<StoredBackupFile> {
    let dir = backups_dir(&app)?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    write_backup_in_dir(&dir, &stamp, &snapshot)
}

fn write_backup_in_dir(dir: &Path, stamp: &str, snapshot: &Value) -> DesktopResult<StoredBackupFile> {
    write_backup_in_dir_with(dir, stamp, snapshot, &|| {})
}

/// `po_zapisie_tresci` wywolywane, gdy tresc jest zapisana, a kopia nie jest jeszcze
/// widoczna pod docelowa nazwa (w testach: sprawdzenie, ze nic nie zajmuje slotu rotacji).
fn write_backup_in_dir_with(
    dir: &Path,
    stamp: &str,
    snapshot: &Value,
    po_zapisie_tresci: &dyn Fn(),
) -> DesktopResult<StoredBackupFile> {
    write_backup_in_dir_with_hooks(
        dir,
        stamp,
        snapshot,
        po_zapisie_tresci,
        &|source, target| fs::hard_link(source, target),
        &|| {},
    )
}

fn write_backup_in_dir_with_hooks(
    dir: &Path,
    stamp: &str,
    snapshot: &Value,
    po_zapisie_tresci: &dyn Fn(),
    hard_link: &dyn Fn(&Path, &Path) -> std::io::Result<()>,
    przed_zmiana_nazwy: &dyn Fn(),
) -> DesktopResult<StoredBackupFile> {
    let body = serde_json::to_vec_pretty(snapshot).map_err(|error| {
        DesktopError::new(
            "BACKUP_SERIALIZATION_FAILED",
            format!("Nie udało się zapisać kopii: {error}"),
            false,
        )
    })?;
    let automatic = is_automatic_snapshot(snapshot);
    let marker = if automatic { AUTO_MARKER } else { "" };
    // Kopia identyczna z ostatnia tego samego rodzaju nie wnosi nic, a wypieralaby starsze
    // z ograniczonej puli - zwracamy istniejaca.
    if let Some(last) = collect_backup_files(dir)
        .into_iter()
        .find(|entry| is_automatic_id(&entry.id) == automatic)
    {
        let same = fs::read_to_string(&last.path)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .is_some_and(|previous| content_fingerprint(&previous) == content_fingerprint(snapshot));
        if same {
            return Ok(last);
        }
    }
    // Tresc trafia najpierw do .{uuid}.tmp (ukryty plik, poza wzorcem kopii), a pod nazwa
    // kopii pojawia sie dopiero kompletna: przerwany zapis nie zostawia obcietej kopii
    // zajmujacej slot rotacji. Publikacja nie nadpisuje istniejacej kopii (hard_link).
    let blad_zapisu = |context: &str, error: std::io::Error| {
        DesktopError::io("STORAGE_PERMISSION_DENIED", context, error)
    };
    let tymczasowy = dir.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let zapis_tresci = || -> std::io::Result<()> {
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&tymczasowy)?;
        file.write_all(&body)?;
        file.sync_all()
    };
    if let Err(error) = zapis_tresci() {
        let _ = fs::remove_file(&tymczasowy);
        return Err(blad_zapisu("Cannot write backup file", error));
    }
    po_zapisie_tresci();
    let mut id = format!("{BACKUP_PREFIX}{stamp}{marker}{BACKUP_SUFFIX}");
    let mut attempt = 2;
    let (target, rezerwacja) = loop {
        let target = dir.join(&id);
        let rezerwacja_path = dir.join(format!(".{id}.publishing"));
        let rezerwacja = match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&rezerwacja_path)
        {
            Ok(plik) => {
                drop(plik);
                BackupPublicationReservation { path: rezerwacja_path }
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                id = format!("{BACKUP_PREFIX}{stamp}{marker}-{attempt}{BACKUP_SUFFIX}");
                attempt += 1;
                continue;
            }
            Err(error) => {
                let _ = fs::remove_file(&tymczasowy);
                return Err(blad_zapisu("Cannot reserve backup file", error));
            }
        };

        let wynik = match backup_target_exists(&target) {
            Ok(true) => Err(std::io::Error::from(ErrorKind::AlreadyExists)),
            Ok(false) => match hard_link(&tymczasowy, &target) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == ErrorKind::AlreadyExists => Err(error),
                // exFAT i podobne systemy: rezerwacja chroni sprawdzenie nazwy
                // i atomowy rename gotowej kopii przed innymi instancjami aplikacji.
                Err(_) => {
                    przed_zmiana_nazwy();
                    fs::rename(&tymczasowy, &target)
                }
            },
            Err(error) => Err(error),
        };
        match wynik {
            Ok(()) => break (target, rezerwacja),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                drop(rezerwacja);
                id = format!("{BACKUP_PREFIX}{stamp}{marker}-{attempt}{BACKUP_SUFFIX}");
                attempt += 1;
            }
            Err(error) => {
                drop(rezerwacja);
                let _ = fs::remove_file(&tymczasowy);
                return Err(blad_zapisu("Cannot publish backup file", error));
            }
        }
    };
    let _ = fs::remove_file(&tymczasowy);
    drop(rezerwacja);
    prune_old_backups(dir, &id, automatic);

    let created_at = snapshot
        .get("createdAt")
        .and_then(Value::as_str)
        .unwrap_or(&id)
        .to_string();
    Ok(StoredBackupFile {
        id,
        path: target.to_string_lossy().to_string(),
        created_at,
        size_bytes: body.len() as u64,
    })
}

#[tauri::command]
pub fn list_backup_snapshots(app: AppHandle) -> DesktopResult<Vec<StoredBackupFile>> {
    let dir = backups_dir(&app)?;
    Ok(collect_backup_files(&dir))
}

#[tauri::command]
pub fn read_backup_snapshot(app: AppHandle, id: String) -> DesktopResult<Value> {
    let dir = backups_dir(&app)?;
    let target = resolve_backup_path(&dir, &id)?;
    let content = fs::read_to_string(&target)
        .map_err(|error| DesktopError::io("STORAGE_NOT_FOUND", "Cannot read backup file", error))?;
    serde_json::from_str(&content).map_err(|error| {
        DesktopError::new(
            "BACKUP_PARSE_FAILED",
            format!("Plik kopii jest uszkodzony: {error}"),
            false,
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbered_snapshots_sort_by_numeric_suffix() {
        let dir = std::env::temp_dir().join(format!("ia-backup-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        for suffix in ["", "-2", "-10"] {
            fs::write(dir.join(format!("kopia-20260929-120000{suffix}.json")), "{}").unwrap();
        }
        let ids: Vec<_> = collect_backup_files(&dir).into_iter().map(|file| file.id).collect();
        assert_eq!(ids, [
            "kopia-20260929-120000-10.json",
            "kopia-20260929-120000-2.json",
            "kopia-20260929-120000.json",
        ]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn two_snapshots_with_same_stamp_have_distinct_files() {
        let dir = std::env::temp_dir().join(format!("ia-backup-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let first = write_backup_in_dir(&dir, "20260929-120000", &serde_json::json!({"n": 1})).unwrap();
        let second = write_backup_in_dir(&dir, "20260929-120000", &serde_json::json!({"n": 2})).unwrap();
        assert_ne!(first.id, second.id);
        assert_eq!(fs::read_to_string(first.path).unwrap().contains("1"), true);
        assert_eq!(fs::read_to_string(second.path).unwrap().contains("2"), true);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn backup_id_must_match_the_generated_pattern() {
        let dir = Path::new("C:/tmp/backupy");

        assert!(resolve_backup_path(dir, "kopia-20260906-101500.json").is_ok());
        assert!(resolve_backup_path(dir, "../sekret.json").is_err());
        assert!(resolve_backup_path(dir, "kopia-../../sekret.json").is_err());
        assert!(resolve_backup_path(dir, "inny-plik.json").is_err());
        assert!(resolve_backup_path(dir, "kopia-.json").is_err());
        assert!(resolve_backup_path(dir, "kopia-20260906.txt").is_err());
    }

    #[test]
    fn only_generated_backup_files_are_listed() {
        let dir = std::env::temp_dir().join(format!("ia-backup-test-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        fs::write(
            dir.join("kopia-20260101-000000.json"),
            r#"{"createdAt":"2026-01-01T00:00:00Z"}"#,
        )
        .unwrap();
        fs::write(
            dir.join("kopia-20260202-000000.json"),
            r#"{"createdAt":"2026-02-02T00:00:00Z"}"#,
        )
        .unwrap();
        fs::write(dir.join("notatka.txt"), "nie kopia").unwrap();

        let files = collect_backup_files(&dir);

        assert_eq!(files.len(), 2);
        assert_eq!(
            files[0].id, "kopia-20260202-000000.json",
            "najnowsza kopia jest pierwsza"
        );
        assert_eq!(files[0].created_at, "2026-02-02T00:00:00Z");
        let _ = fs::remove_dir_all(&dir);
    }

    fn zapisz(dir: &Path, stamp: &str, snapshot: Value) -> StoredBackupFile {
        write_backup_in_dir(dir, stamp, &snapshot).unwrap()
    }

    #[test]
    fn automatic_safety_backups_do_not_push_out_a_manual_backup() {
        let dir = std::env::temp_dir().join(format!("ia-backup-rot-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let reczna = zapisz(&dir, "20260101-000000", serde_json::json!({"n": "reczna"}));
        for indeks in 0..12 {
            let stamp = format!("20260102-0000{indeks:02}");
            let kopia = zapisz(&dir, &stamp, serde_json::json!({"purpose": "safety", "n": indeks}));
            assert!(kopia.id.contains("-auto"), "kopia zabezpieczajaca ma znacznik -auto: {}", kopia.id);
        }

        let ids: Vec<String> = collect_backup_files(&dir).into_iter().map(|file| file.id).collect();
        assert!(ids.contains(&reczna.id), "reczna kopia zostaje: {ids:?}");
        assert_eq!(ids.iter().filter(|id| id.contains("-auto")).count(), BACKUP_LIMIT_AUTOMATYCZNYCH);
        // Zostaly najnowsze automatyczne (n = 2..11).
        assert!(ids.contains(&"kopia-20260102-000011-auto.json".to_string()));
        assert!(!ids.contains(&"kopia-20260102-000001-auto.json".to_string()));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn manual_backups_rotate_at_their_own_limit_and_ignore_safety_ones() {
        let dir = std::env::temp_dir().join(format!("ia-backup-rot2-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let automatyczna = zapisz(&dir, "20260101-000000", serde_json::json!({"purpose": "safety", "n": "a"}));
        for indeks in 0..(BACKUP_LIMIT + 3) {
            zapisz(&dir, &format!("20260102-0000{indeks:02}"), serde_json::json!({"n": indeks, "purpose": "manual"}));
        }

        let ids: Vec<String> = collect_backup_files(&dir).into_iter().map(|file| file.id).collect();
        assert!(ids.contains(&automatyczna.id), "automatyczna kopia zostaje");
        assert_eq!(ids.iter().filter(|id| !id.contains("-auto")).count(), BACKUP_LIMIT);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn identical_content_is_not_written_twice_per_kind() {
        let dir = std::env::temp_dir().join(format!("ia-backup-dedup-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let pierwsza = zapisz(&dir, "20260102-000000", serde_json::json!({"n": 1, "createdAt": "a", "reason": "x"}));
        // Ta sama tresc, inny czas i powod: zwracana jest istniejaca kopia.
        let druga = zapisz(&dir, "20260102-000005", serde_json::json!({"n": 1, "createdAt": "b", "reason": "y"}));
        assert_eq!(pierwsza.id, druga.id);
        // Ta sama tresc jako kopia zabezpieczajaca to inny rodzaj: powstaje nowy plik.
        let auto = zapisz(&dir, "20260102-000006", serde_json::json!({"n": 1, "purpose": "safety"}));
        assert_ne!(auto.id, pierwsza.id);
        assert_eq!(collect_backup_files(&dir).len(), 2);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn auto_marker_does_not_break_ordering_or_the_id_pattern() {
        let dir = std::env::temp_dir().join(format!("ia-backup-ord-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        for nazwa in ["kopia-20260929-120000-auto.json", "kopia-20260929-120000-auto-2.json", "kopia-20260929-110000.json"] {
            fs::write(dir.join(nazwa), "{}").unwrap();
            assert!(resolve_backup_path(&dir, nazwa).is_ok());
        }
        let ids: Vec<_> = collect_backup_files(&dir).into_iter().map(|file| file.id).collect();
        assert_eq!(ids, [
            "kopia-20260929-120000-auto-2.json",
            "kopia-20260929-120000-auto.json",
            "kopia-20260929-110000.json",
        ]);
        fs::remove_dir_all(dir).unwrap();
    }
    /// Przerwanie zapisu (awaria, brak zasilania) nie moze zostawic czesciowej kopii pod
    /// nazwa kopii: zajmowalaby slot rotacji i wygladala na kopie do przywrocenia.
    #[test]
    fn kopia_nie_jest_widoczna_pod_docelowa_nazwa_przed_zakonczeniem_zapisu() {
        let dir = std::env::temp_dir().join(format!("ia-backup-atom-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let sprawdzone = std::cell::Cell::new(false);

        let kopia = write_backup_in_dir_with(&dir, "20260929-120000", &serde_json::json!({"n": 1}), &|| {
            assert!(collect_backup_files(&dir).is_empty(), "kopia widoczna przed zakonczeniem zapisu");
            sprawdzone.set(true);
        })
        .unwrap();

        assert!(sprawdzone.get());
        assert_eq!(collect_backup_files(&dir).len(), 1);
        assert!(serde_json::from_str::<Value>(&fs::read_to_string(&kopia.path).unwrap()).is_ok());
        let pliki: Vec<_> = fs::read_dir(&dir).unwrap().flatten().collect();
        assert_eq!(pliki.len(), 1, "po zapisie nie zostaje plik tymczasowy");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn publikacja_kopii_nie_nadpisuje_istniejacej_o_tym_samym_znaczniku() {
        let dir = std::env::temp_dir().join(format!("ia-backup-nadp-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("kopia-20260929-120000.json"), "cudza").unwrap();

        let kopia = zapisz(&dir, "20260929-120000", serde_json::json!({"n": 2}));

        assert_eq!(kopia.id, "kopia-20260929-120000-2.json");
        assert_eq!(fs::read_to_string(dir.join("kopia-20260929-120000.json")).unwrap(), "cudza");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rownolegle_publikacje_bez_hardlinka_zachowuja_obie_tresci() {
        use std::sync::{Arc, Barrier};

        let dir = std::env::temp_dir().join(format!("ia-backup-rename-race-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let hardlink_bariera = Arc::new(Barrier::new(2));
        let rename_bariera = Arc::new(Barrier::new(2));

        let pracownicy: Vec<_> = [1, 2]
            .into_iter()
            .map(|wartosc| {
                let dir = dir.clone();
                let hardlink_bariera = hardlink_bariera.clone();
                let rename_bariera = rename_bariera.clone();
                std::thread::spawn(move || {
                    write_backup_in_dir_with_hooks(
                        &dir,
                        "20260929-120000",
                        &serde_json::json!({"n": wartosc}),
                        &|| {},
                        &|_, _| {
                            hardlink_bariera.wait();
                            Err(std::io::Error::new(ErrorKind::Unsupported, "forced hardlink failure"))
                        },
                        &|| {
                            // Obie publikacje potwierdzaja brak celu przed ktorakolwiek zmiana nazwy.
                            rename_bariera.wait();
                        },
                    )
                })
            })
            .collect();
        let kopie: Vec<_> = pracownicy
            .into_iter()
            .map(|pracownik| pracownik.join().unwrap().unwrap())
            .collect();

        assert_ne!(kopie[0].id, kopie[1].id, "publikacje musza zarezerwowac rozne nazwy");
        let zachowane: Vec<_> = kopie
            .iter()
            .map(|kopia| serde_json::from_str::<Value>(&fs::read_to_string(&kopia.path).unwrap()).unwrap()["n"].clone())
            .collect();
        assert!(zachowane.contains(&serde_json::json!(1)));
        assert!(zachowane.contains(&serde_json::json!(2)));
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 2, "pliki rezerwacji sa sprzatane");
        fs::remove_dir_all(dir).unwrap();
    }
}
