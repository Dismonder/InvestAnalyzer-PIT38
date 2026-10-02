use crate::commands::app_paths::resolve_app_paths;
use crate::commands::storage::{sha256_file, unique_target_path};
use crate::engine::errors::{DesktopError, DesktopResult};
use crate::security::extension_guard::assert_import_extension;
use crate::security::path_guard::ensure_new_child;
use crate::state::{blokady_zapisu, zajmij};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use walkdir::WalkDir;

const MANIFEST_FILENAME: &str = "migration_manifest.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyStorageStatus {
    pub detected: bool,
    pub source_dir: Option<String>,
    pub target_dir: String,
    pub file_count: usize,
    pub total_bytes: u64,
    pub unreadable_count: usize,
    pub already_migrated: bool,
    pub manifest_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageMigrationEntry {
    pub source_relative_path: String,
    pub target_relative_path: Option<String>,
    pub sha256: Option<String>,
    pub size_bytes: u64,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageMigrationResult {
    pub migration_id: String,
    pub started_at: String,
    pub finished_at: String,
    pub source_dir: String,
    pub target_dir: String,
    pub manifest_path: String,
    pub copied: usize,
    pub skipped: usize,
    pub renamed: usize,
    pub entries: Vec<StorageMigrationEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageMigrationStatus {
    pub migrated: bool,
    pub manifest_path: Option<String>,
    pub last_manifest: Option<serde_json::Value>,
}

#[tauri::command]
pub fn detect_legacy_storage(app: AppHandle) -> DesktopResult<LegacyStorageStatus> {
    let paths = resolve_app_paths(&app)?;
    let target_dir = PathBuf::from(&paths.storage_dir);
    let manifest_path = PathBuf::from(&paths.data_dir).join(MANIFEST_FILENAME);
    let source_dir = detect_legacy_storage_dir(&target_dir);
    let (file_count, total_bytes, unreadable_count) = match &source_dir {
        Some(source) => summarize_storage(source),
        None => (0, 0, 0),
    };

    Ok(LegacyStorageStatus {
        detected: source_dir.is_some(),
        source_dir: source_dir.map(|path| path.to_string_lossy().to_string()),
        target_dir: target_dir.to_string_lossy().to_string(),
        file_count,
        total_bytes,
        unreadable_count,
        already_migrated: manifest_path.exists(),
        manifest_path: if manifest_path.exists() {
            Some(manifest_path.to_string_lossy().to_string())
        } else {
            None
        },
    })
}

#[tauri::command]
pub fn get_storage_migration_status(app: AppHandle) -> DesktopResult<StorageMigrationStatus> {
    let paths = resolve_app_paths(&app)?;
    let manifest_path = PathBuf::from(paths.data_dir).join(MANIFEST_FILENAME);
    let last_manifest = fs::read_to_string(&manifest_path)
        .ok()
        .and_then(|payload| serde_json::from_str::<serde_json::Value>(&payload).ok());

    Ok(StorageMigrationStatus {
        migrated: manifest_path.exists(),
        manifest_path: if manifest_path.exists() {
            Some(manifest_path.to_string_lossy().to_string())
        } else {
            None
        },
        last_manifest,
    })
}

#[tauri::command]
pub fn copy_legacy_storage_to_appdata(app: AppHandle) -> DesktopResult<StorageMigrationResult> {
    let paths = resolve_app_paths(&app)?;
    let target_dir = PathBuf::from(&paths.storage_dir);
    let data_dir = PathBuf::from(&paths.data_dir);
    let source_dir = detect_legacy_storage_dir(&target_dir).ok_or_else(|| {
        DesktopError::new(
            "STORAGE_NOT_FOUND",
            "Legacy storage directory was not detected.",
            true,
        )
    })?;

    let started_at = chrono::Utc::now().to_rfc3339();
    let migration_id = uuid::Uuid::new_v4().to_string();
    let CopyOutcome {
        copied,
        skipped,
        renamed,
        entries,
    } = copy_storage_files(&source_dir, &target_dir)?;
    let finished_at = chrono::Utc::now().to_rfc3339();
    let manifest_path = data_dir.join(MANIFEST_FILENAME);
    let result = StorageMigrationResult {
        migration_id,
        started_at,
        finished_at,
        source_dir: source_dir.to_string_lossy().to_string(),
        target_dir: target_dir.to_string_lossy().to_string(),
        manifest_path: manifest_path.to_string_lossy().to_string(),
        copied,
        skipped,
        renamed,
        entries,
    };
    fs::write(
        &manifest_path,
        serde_json::to_vec_pretty(&result).unwrap_or_default(),
    )
    .map_err(|error| {
        DesktopError::io(
            "STORAGE_PERMISSION_DENIED",
            "Cannot write migration manifest",
            error,
        )
    })?;
    Ok(result)
}

struct CopyOutcome {
    copied: usize,
    skipped: usize,
    renamed: usize,
    entries: Vec<StorageMigrationEntry>,
}

/// Kopiuje (nie przenosi) pliki magazynu; ukryte i niedozwolone pomija z wpisem w manifescie.
fn copy_storage_files(source_dir: &Path, target_dir: &Path) -> DesktopResult<CopyOutcome> {
    let mut copied = 0_usize;
    let mut skipped = 0_usize;
    let mut renamed = 0_usize;
    let mut entries = Vec::new();

    fs::create_dir_all(target_dir).map_err(|error| {
        DesktopError::io(
            "STORAGE_PERMISSION_DENIED",
            "Cannot create target storage",
            error,
        )
    })?;

    for entry in collect_walk_entries(WalkDir::new(source_dir).follow_links(false).into_iter())? {
        if !entry.file_type().is_file() {
            continue;
        }
        let source_path = entry.path();
        let source_relative = source_path
            .strip_prefix(source_dir)
            .unwrap_or(source_path)
            .to_string_lossy()
            .replace('\\', "/");
        // Plik ukryty (np. .gitkeep) albo o niedozwolonym rozszerzeniu nie jest
        // wyciagiem: pomijamy go z wpisem w manifescie zamiast przerywac cala migracje.
        if !is_migratable_source(&source_relative, source_path) {
            skipped += 1;
            entries.push(StorageMigrationEntry {
                source_relative_path: source_relative,
                target_relative_path: None,
                sha256: None,
                size_bytes: entry
                    .metadata()
                    .map(|metadata| metadata.len())
                    .unwrap_or_default(),
                status: "skipped_unsupported".to_string(),
            });
            continue;
        }
        // Blad skrotu to blad migracji: None == None po obu stronach uznawano za pliki
        // identyczne i pomijano kopiowanie, choc nikt ich nie porownal.
        let source_hash = Some(sha256_file(source_path).map_err(|error| hash_error(source_path, error))?);
        let size_bytes = entry
            .metadata()
            .map(|metadata| metadata.len())
            .unwrap_or_default();
        let initial_target = ensure_new_child(target_dir, &source_relative)?;

        if initial_target.exists() {
            let target_hash = Some(sha256_file(&initial_target).map_err(|error| hash_error(&initial_target, error))?);
            if target_hash == source_hash {
                skipped += 1;
                entries.push(StorageMigrationEntry {
                    source_relative_path: source_relative,
                    target_relative_path: None,
                    sha256: source_hash,
                    size_bytes,
                    status: "skipped_identical".to_string(),
                });
                continue;
            }
        }

        if let Some(parent) = initial_target.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                DesktopError::io(
                    "STORAGE_PERMISSION_DENIED",
                    "Cannot create target storage subdirectory",
                    error,
                )
            })?;
        }
        let final_target = opublikuj_kopie(source_path, &initial_target)?;
        if final_target != initial_target {
            renamed += 1;
        }
        copied += 1;
        let target_relative = final_target
            .strip_prefix(target_dir)
            .unwrap_or(&final_target)
            .to_string_lossy()
            .replace('\\', "/");
        entries.push(StorageMigrationEntry {
            source_relative_path: source_relative,
            target_relative_path: Some(target_relative),
            sha256: source_hash,
            size_bytes,
            status: if final_target.file_name() == initial_target.file_name() {
                "copied".to_string()
            } else {
                "copied_renamed".to_string()
            },
        });
    }
    Ok(CopyOutcome {
        copied,
        skipped,
        renamed,
        entries,
    })
}

/// Kopiuje zrodlo do pliku tymczasowego obok celu i publikuje je pod nazwa, ktorej nikt
/// inny nie zajal: hard_link konczy sie AlreadyExists, gdy rownolegly import albo migracja
/// utworzyl te sama nazwe miedzy wyborem nazwy a zapisem - wtedy bierzemy nastepna.
/// Istniejacy plik nigdy nie jest nadpisywany, a przerwana kopia nie zostawia ucietego celu.
fn opublikuj_kopie(source: &Path, initial_target: &Path) -> DesktopResult<PathBuf> {
    let blad_zapisu = |error: std::io::Error| {
        DesktopError::io(
            "STORAGE_PERMISSION_DENIED",
            "Cannot copy legacy storage file",
            error,
        )
    };
    let tymczasowy = initial_target.with_file_name(format!(".{}.tmp", uuid::Uuid::new_v4()));
    fs::copy(source, &tymczasowy).map_err(|error| {
        let _ = fs::remove_file(&tymczasowy);
        blad_zapisu(error)
    })?;
    // Import nadpisujacy plik zarzadzany trzyma te sama blokade; publikacja nie
    // przeplata sie z jego kopia poprzedniej wersji i podmiana.
    let blokada = blokady_zapisu().dla(initial_target);
    let _zapis = zajmij(&blokada);
    let wynik = publikuj_wylacznie(&tymczasowy, initial_target);
    let _ = fs::remove_file(&tymczasowy);
    wynik.map_err(blad_zapisu)
}

fn publikuj_wylacznie(tymczasowy: &Path, initial_target: &Path) -> std::io::Result<PathBuf> {
    loop {
        let kandydat = unique_target_path(initial_target);
        match fs::hard_link(tymczasowy, &kandydat) {
            Ok(()) => return Ok(kandydat),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            // System plikow bez dowiazan (np. exFAT): create_new tez nie nadpisuje
            // istniejacego pliku; nieudana kopia jest sprzatana.
            Err(_) => {
                let mut cel = match fs::OpenOptions::new().write(true).create_new(true).open(&kandydat) {
                    Ok(plik) => plik,
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(error) => return Err(error),
                };
                let mut zrodlo = fs::File::open(tymczasowy)?;
                if let Err(error) = std::io::copy(&mut zrodlo, &mut cel) {
                    drop(cel);
                    let _ = fs::remove_file(&kandydat);
                    return Err(error);
                }
                return Ok(kandydat);
            }
        }
    }
}

fn hash_error(path: &Path, error: std::io::Error) -> DesktopError {
    DesktopError::new(
        "STORAGE_MIGRATION_INCOMPLETE",
        format!("Nie udało się obliczyć skrótu pliku {}: {error}", path.display()),
        true,
    )
}
fn detect_legacy_storage_dir(target_dir: &Path) -> Option<PathBuf> {
    if let Ok(env_path) = std::env::var("INVEST_ANALYZER_LEGACY_STORAGE") {
        let path = PathBuf::from(env_path);
        if is_usable_legacy_storage(&path, target_dir) {
            return Some(path);
        }
    }
    let current_dir = std::env::current_dir().ok()?;
    find_legacy_storage_dir(&current_dir, target_dir)
}

/// Szuka magazynu w katalogu roboczym i jego rodzicu; pierwszy pasujacy wygrywa.
fn find_legacy_storage_dir(current_dir: &Path, target_dir: &Path) -> Option<PathBuf> {
    let parent = current_dir.parent();
    [
        // Dzisiejszy magazyn repozytorium (workspacePaths.ts), potem starsze uklady.
        Some(current_dir.join("dane").join("pliki")),
        parent.map(|parent| parent.join("dane").join("pliki")),
        Some(current_dir.join("dane").join("storage")),
        Some(current_dir.join("storage")),
        parent.map(|parent| parent.join("dane").join("storage")),
        parent.map(|parent| parent.join("storage")),
    ]
    .into_iter()
    .flatten()
    .find(|candidate| is_usable_legacy_storage(candidate, target_dir))
}
fn is_usable_legacy_storage(candidate: &Path, target_dir: &Path) -> bool {
    if !candidate.is_dir() {
        return false;
    }
    let candidate = candidate.canonicalize().ok();
    let target = target_dir.canonicalize().ok();
    match (candidate, target) {
        (Some(candidate), Some(target)) => candidate != target,
        (Some(_), None) => true,
        _ => false,
    }
}

/// Czy plik magazynu jest wyciagiem do skopiowania: nie ukryty (zadna czesc sciezki
/// nie zaczyna sie od kropki) i z dozwolonym rozszerzeniem.
fn is_migratable_source(relative: &str, path: &Path) -> bool {
    let hidden = relative
        .split('/')
        .any(|part| part.starts_with('.') && part != "." && part != "..");
    !hidden && assert_import_extension(path).is_ok()
}

fn collect_walk_entries<I>(walk: I) -> DesktopResult<Vec<walkdir::DirEntry>>
where
    I: IntoIterator<Item = Result<walkdir::DirEntry, walkdir::Error>>,
{
    let mut entries = Vec::new();
    let mut unreadable = 0;
    for item in walk {
        match item {
            Ok(entry) => entries.push(entry),
            Err(_) => unreadable += 1,
        }
    }
    if unreadable > 0 {
        return Err(DesktopError::new(
            "STORAGE_MIGRATION_INCOMPLETE",
            format!("Nie udało się odczytać {unreadable} pozycji magazynu."),
            true,
        ));
    }
    Ok(entries)
}

fn summarize_storage(storage_dir: &Path) -> (usize, u64, usize) {
    let mut count = 0_usize;
    let mut bytes = 0_u64;
    let mut unreadable = 0_usize;
    for item in WalkDir::new(storage_dir).follow_links(false) {
        let entry = match item {
            Ok(entry) => entry,
            Err(_) => {
                unreadable += 1;
                continue;
            }
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(storage_dir)
            .unwrap_or(entry.path())
            .to_string_lossy()
            .replace('\\', "/");
        if !is_migratable_source(&relative, entry.path()) {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(_) => {
                unreadable += 1;
                continue;
            }
        };
        count += 1;
        bytes += metadata.len();
    }
    (count, bytes, unreadable)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::storage::storage_file_from_path;

    #[test]
    fn walk_errors_fail_instead_of_yielding_partial_entries() {
        let missing = std::env::temp_dir().join(format!("ia-missing-{}", uuid::Uuid::new_v4()));
        let error = WalkDir::new(missing).into_iter().next().unwrap().unwrap_err();
        let result = collect_walk_entries(vec![Err(error)]);
        let failure = result.unwrap_err();
        assert_eq!(failure.error_code, "STORAGE_MIGRATION_INCOMPLETE");
        assert!(failure.message.contains("1 pozycji"));
    }

    #[test]
    fn storage_summary_preserves_detection_when_tree_is_unreadable() {
        let missing = std::env::temp_dir().join(format!("ia-missing-{}", uuid::Uuid::new_v4()));
        assert_eq!(summarize_storage(&missing), (0, 0, 1));
    }

    #[test]
    fn migration_result_serializes_manifest_shape() {
        let result = StorageMigrationResult {
            migration_id: "migration".to_string(),
            started_at: "2026-05-18T00:00:00Z".to_string(),
            finished_at: "2026-05-18T00:00:01Z".to_string(),
            source_dir: "source".to_string(),
            target_dir: "target".to_string(),
            manifest_path: "manifest.json".to_string(),
            copied: 1,
            skipped: 1,
            renamed: 0,
            entries: vec![StorageMigrationEntry {
                source_relative_path: "broker.json".to_string(),
                target_relative_path: Some("broker.json".to_string()),
                sha256: Some("abc".to_string()),
                size_bytes: 10,
                status: "copied".to_string(),
            }],
        };

        let payload = serde_json::to_value(result).unwrap();

        assert_eq!(payload["copied"], 1);
        assert_eq!(payload["entries"][0]["sourceRelativePath"], "broker.json");
    }

    #[test]
    fn storage_summary_counts_files_and_bytes() {
        let dir = std::env::temp_dir().join(format!(
            "invest-analyzer-migration-test-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(dir.join("nested")).unwrap();
        fs::write(dir.join("a.json"), "123").unwrap();
        fs::write(dir.join("nested").join("b.csv"), "12").unwrap();

        let (count, bytes, unreadable) = summarize_storage(&dir);

        assert_eq!(count, 2);
        assert_eq!(bytes, 5);
        assert_eq!(unreadable, 0);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn storage_file_from_path_still_reads_migrated_files() {
        let dir = std::env::temp_dir().join(format!(
            "invest-analyzer-storage-file-test-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("broker.json"), "{}").unwrap();

        let file = storage_file_from_path(&dir, "broker.json", true).unwrap();

        assert_eq!(file.file_name, "broker.json");
        assert!(file.sha256.is_some());
        let _ = fs::remove_dir_all(dir);
    }

    fn temp_dir_migracji(prefix: &str) -> PathBuf {
        std::env::temp_dir().join(format!("{prefix}-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn detection_finds_repository_storage_dane_pliki_before_older_layouts() {
        let root = temp_dir_migracji("ia-detect");
        let cwd = root.join("aplikacje");
        fs::create_dir_all(root.join("dane").join("pliki")).unwrap();
        fs::create_dir_all(root.join("dane").join("storage")).unwrap();
        fs::create_dir_all(&cwd).unwrap();
        let target = root.join("appdata").join("storage");

        let found = find_legacy_storage_dir(&cwd, &target).expect("magazyn wykryty");

        assert_eq!(found, root.join("dane").join("pliki"));
        // Sam katalog docelowy nigdy nie jest zrodlem.
        fs::create_dir_all(&target).unwrap();
        assert_ne!(find_legacy_storage_dir(&target, &target), Some(target.clone()));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn migration_skips_hidden_and_unsupported_files_and_copies_the_rest() {
        let root = temp_dir_migracji("ia-migr");
        let source = root.join("pliki");
        let target = root.join("cel");
        fs::create_dir_all(source.join("broker")).unwrap();
        fs::write(source.join(".gitkeep"), "").unwrap();
        fs::write(source.join("broker").join("wyciag.csv"), "a,b").unwrap();
        fs::write(source.join("broker").join("program.exe"), "MZ").unwrap();
        fs::write(source.join("notatki"), "bez rozszerzenia").unwrap();
        fs::create_dir_all(source.join(".ukryty")).unwrap();
        fs::write(source.join(".ukryty").join("dane.csv"), "x").unwrap();

        let outcome = copy_storage_files(&source, &target).expect("migracja nie przerywa sie na .gitkeep");

        assert_eq!(outcome.copied, 1);
        assert_eq!(outcome.skipped, 4);
        assert_eq!(fs::read_to_string(target.join("broker").join("wyciag.csv")).unwrap(), "a,b");
        assert!(!target.join(".gitkeep").exists());
        assert!(!target.join("broker").join("program.exe").exists());
        let mut pominiete: Vec<_> = outcome
            .entries
            .iter()
            .filter(|entry| entry.status == "skipped_unsupported")
            .map(|entry| entry.source_relative_path.clone())
            .collect();
        pominiete.sort();
        assert_eq!(pominiete, [".gitkeep", ".ukryty/dane.csv", "broker/program.exe", "notatki"]);
        // Migracja KOPIUJE: zrodlo zostaje nietkniete.
        assert!(source.join("broker").join("wyciag.csv").exists());
        assert!(source.join(".gitkeep").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn storage_summary_ignores_hidden_and_unsupported_files() {
        let dir = temp_dir_migracji("ia-summary");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(".gitkeep"), "").unwrap();
        fs::write(dir.join("a.json"), "123").unwrap();
        fs::write(dir.join("b.exe"), "MZ").unwrap();

        assert_eq!(summarize_storage(&dir), (1, 3, 0));
        let _ = fs::remove_dir_all(dir);
    }

    /// Otwiera plik bez udostepniania (Windows): kazdy inny odczyt konczy sie bledem.
    #[cfg(windows)]
    fn zablokuj(path: &Path) -> fs::File {
        use std::os::windows::fs::OpenOptionsExt;
        fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(path)
            .expect("blokada pliku")
    }

    #[cfg(windows)]
    #[test]
    fn hash_error_on_both_sides_is_a_migration_error_not_identical() {
        let root = temp_dir_migracji("ia-hash-both");
        let (source, target) = (root.join("pliki"), root.join("cel"));
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(source.join("a.csv"), "zrodlo").unwrap();
        fs::write(target.join("a.csv"), "inny").unwrap();
        let _blokada_zrodla = zablokuj(&source.join("a.csv"));
        let _blokada_celu = zablokuj(&target.join("a.csv"));

        let error = copy_storage_files(&source, &target)
            .err()
            .expect("None == None nie moze byc uznane za identyczne");

        assert_eq!(error.error_code, "STORAGE_MIGRATION_INCOMPLETE");
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn hash_error_on_the_target_side_is_a_migration_error() {
        let root = temp_dir_migracji("ia-hash-target");
        let (source, target) = (root.join("pliki"), root.join("cel"));
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(source.join("a.csv"), "zrodlo").unwrap();
        fs::write(target.join("a.csv"), "inny").unwrap();
        let _blokada_celu = zablokuj(&target.join("a.csv"));

        let error = copy_storage_files(&source, &target).err().expect("blad skrotu celu");

        assert_eq!(error.error_code, "STORAGE_MIGRATION_INCOMPLETE");
        let _ = fs::remove_dir_all(root);
    }

    /// Kilka rownoczesnych migracji/importow do tego samego katalogu docelowego: zadna
    /// tresc nie moze zostac nadpisana przez inna (unique_target_path + fs::copy dawaly
    /// dwom watkom ta sama nazwe).
    #[test]
    fn rownolegle_migracje_do_tego_samego_celu_nie_nadpisuja_sie() {
        const WATKI: usize = 8;
        for runda in 0..10 {
            let root = temp_dir_migracji("ia-migr-rownolegle");
            let target = root.join("cel");
            fs::create_dir_all(&target).unwrap();
            fs::write(target.join("a.csv"), "istniejacy").unwrap();
            let bariera = std::sync::Arc::new(std::sync::Barrier::new(WATKI));
            let watki: Vec<_> = (0..WATKI)
                .map(|indeks| {
                    let source = root.join(format!("zrodlo-{indeks}"));
                    fs::create_dir_all(&source).unwrap();
                    fs::write(source.join("a.csv"), format!("tresc-{indeks}")).unwrap();
                    let (target, bariera) = (target.clone(), bariera.clone());
                    std::thread::spawn(move || {
                        bariera.wait();
                        copy_storage_files(&source, &target).map(|outcome| outcome.copied)
                    })
                })
                .collect();
            for watek in watki {
                assert_eq!(watek.join().unwrap().expect("migracja"), 1, "runda {runda}");
            }

            let mut tresci: Vec<String> = fs::read_dir(&target)
                .unwrap()
                .flatten()
                .map(|wpis| fs::read_to_string(wpis.path()).unwrap())
                .collect();
            tresci.sort();
            let mut oczekiwane: Vec<String> = (0..WATKI).map(|i| format!("tresc-{i}")).collect();
            oczekiwane.push("istniejacy".to_string());
            oczekiwane.sort();
            assert_eq!(tresci, oczekiwane, "runda {runda}: jakas tresc zostala nadpisana");
            let _ = fs::remove_dir_all(root);
        }
    }

    /// Cel utworzony miedzy sprawdzeniem nazwy a publikacja nie jest nadpisywany:
    /// kopia dostaje nowa nazwe, a po drodze nie zostaje plik tymczasowy.
    #[test]
    fn publikacja_kopii_nie_nadpisuje_celu_ktory_juz_istnieje() {
        let root = temp_dir_migracji("ia-publikacja");
        fs::create_dir_all(&root).unwrap();
        let source = root.join("zrodlo.csv");
        let cel = root.join("a.csv");
        fs::write(&source, "nowa").unwrap();
        fs::write(&cel, "cudza").unwrap();

        let opublikowany = opublikuj_kopie(&source, &cel).expect("publikacja");

        assert_ne!(opublikowany, cel);
        assert_eq!(fs::read_to_string(&cel).unwrap(), "cudza");
        assert_eq!(fs::read_to_string(&opublikowany).unwrap(), "nowa");
        assert_eq!(fs::read_to_string(&source).unwrap(), "nowa", "zrodlo zostaje");
        let nazwy: Vec<_> = fs::read_dir(&root).unwrap().flatten().map(|w| w.file_name()).collect();
        assert_eq!(nazwy.len(), 3, "zostal plik tymczasowy: {nazwy:?}");
        let _ = fs::remove_dir_all(root);
    }
}
