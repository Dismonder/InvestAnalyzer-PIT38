use crate::commands::app_paths::resolve_app_paths;
use crate::engine::errors::{DesktopError, DesktopResult};
use crate::security::extension_guard::{assert_import_extension, extension};
use crate::security::path_guard::{ensure_existing_child, ensure_new_child, reject_symlink_target};
use crate::security::text_encoding::decode_text;
use crate::state::{blokady_zapisu, zajmij};
use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use tauri::AppHandle;
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageFile {
    pub relative_path: String,
    pub file_name: String,
    pub extension: String,
    pub size_bytes: u64,
    pub modified_at: String,
    pub sha256: Option<String>,
    pub source_status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageFileReadResult {
    pub relative_path: String,
    pub file_name: String,
    pub mime_type: String,
    pub text: Option<String>,
    /// Kodowanie, w ktorym udalo sie odczytac tresc - "utf-8" albo
    /// "windows-1250". Puste dla plikow binarnych.
    pub encoding: Option<String>,
    pub base64: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFileRequest {
    pub relative_path: String,
    pub file_name: String,
    pub base64: String,
    /// Podmien plik o tej samej nazwie zamiast zapisywac kopie ze znacznikiem
    /// czasu. Uzywaja tego wylacznie pliki zarzadzane przez aplikacje, ktore sa
    /// odtwarzane przy kazdym przeliczeniu - kopie mnozylyby te same transakcje
    /// w oczach silnika. Pliki wgrane przez uzytkownika zostaja przy domysle,
    /// czyli nigdy nie sa nadpisywane po cichu.
    #[serde(default)]
    pub overwrite: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub imported: Vec<StorageFile>,
    pub skipped: Vec<StorageFile>,
    pub failed: Vec<ImportFailure>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFailure {
    pub file_name: String,
    pub relative_path: String,
    pub error_code: String,
    pub message: String,
    pub recoverable: bool,
}

enum ImportOutcome {
    Imported(StorageFile),
    Skipped(StorageFile),
}

#[tauri::command]
pub fn list_storage_files(app: AppHandle) -> DesktopResult<Vec<StorageFile>> {
    let paths = resolve_app_paths(&app)?;
    let storage_dir = PathBuf::from(paths.storage_dir);
    fs::create_dir_all(&storage_dir).map_err(|error| {
        DesktopError::io(
            "STORAGE_PERMISSION_DENIED",
            "Cannot create storage directory",
            error,
        )
    })?;

    let mut files = Vec::new();
    for entry in WalkDir::new(&storage_dir)
        .follow_links(false)
        .into_iter()
        .flatten()
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let relative_path = path
            .strip_prefix(&storage_dir)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        files.push(storage_file_from_path(&storage_dir, &relative_path, true)?);
    }
    files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(files)
}

#[tauri::command]
pub fn read_storage_file(
    app: AppHandle,
    relative_path: String,
) -> DesktopResult<StorageFileReadResult> {
    let paths = resolve_app_paths(&app)?;
    let storage_dir = PathBuf::from(paths.storage_dir);
    let target = ensure_existing_child(&storage_dir, &relative_path)?;
    let bytes = fs::read(&target).map_err(|error| {
        DesktopError::io(
            "STORAGE_PERMISSION_DENIED",
            "Cannot read storage file",
            error,
        )
    })?;
    let mime_type = guess_mime_type(&target);
    let file_name = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(&relative_path)
        .to_string();
    if mime_type.starts_with("text/") || mime_type == "application/json" {
        let (text, encoding) = decode_text(&bytes);
        return Ok(StorageFileReadResult {
            relative_path,
            file_name,
            mime_type,
            text: Some(text),
            encoding: Some(encoding.as_str().to_string()),
            base64: None,
        });
    }
    Ok(StorageFileReadResult {
        relative_path,
        file_name,
        mime_type,
        text: None,
        encoding: None,
        base64: Some(general_purpose::STANDARD.encode(bytes)),
    })
}

#[tauri::command]
pub fn import_files_to_storage(
    app: AppHandle,
    files: Vec<ImportFileRequest>,
) -> DesktopResult<ImportResult> {
    sprawdz_limit_partii(files.len())?;
    let paths = resolve_app_paths(&app)?;
    let storage_dir = PathBuf::from(paths.storage_dir);
    Ok(import_files_to_storage_dir(&storage_dir, files))
}

/// 50 plikow w partii, jak w serwerze web. Limit rozmiaru pliku jest inny niz w
/// web (2,8 MiB base64): tam wynika z rozmiaru ciala HTTP, a desktop go nie ma, wiec
/// wieloletni wyciag nie moze byc odrzucany. 32 MiB danych = 44 739 240 znakow base64
/// (najwieksza wielokrotnosc 4 dajaca nie wiecej niz 32 MiB po zdekodowaniu).
const MAX_PLIKOW_W_PARTII: usize = 50;
const MAX_BAJTOW_NA_PLIK_MIB: usize = 32;
const MAX_BASE64_NA_PLIK: usize = 44_739_240;

fn sprawdz_limit_partii(liczba_plikow: usize) -> DesktopResult<()> {
    if liczba_plikow > MAX_PLIKOW_W_PARTII {
        return Err(DesktopError::new(
            "TOO_MANY_FILES",
            format!("Zbyt wiele plików (limit {MAX_PLIKOW_W_PARTII})."),
            false,
        ));
    }
    Ok(())
}

fn import_files_to_storage_dir(storage_dir: &Path, files: Vec<ImportFileRequest>) -> ImportResult {
    let mut imported = Vec::new();
    let mut skipped = Vec::new();
    let mut failed = Vec::new();
    let mut warnings = Vec::new();

    for file in files {
        let file_name = sanitize_import_filename(&file.file_name)
            .or_else(|| sanitize_import_filename(&file.relative_path))
            .unwrap_or_else(|| "plik".to_string());
        let relative_path = sanitize_import_relative_path(&file.relative_path, &file.file_name);
        match import_single_file_to_storage(storage_dir, file) {
            Ok((ImportOutcome::Imported(file), file_warnings)) => {
                imported.push(file);
                warnings.extend(file_warnings);
            }
            Ok((ImportOutcome::Skipped(file), file_warnings)) => {
                skipped.push(file);
                warnings.extend(file_warnings);
            }
            Err(error) => {
                warnings.push(format!("{file_name}: {}", error.message));
                failed.push(ImportFailure {
                    file_name,
                    relative_path,
                    error_code: error.error_code,
                    message: error.message,
                    recoverable: error.recoverable,
                });
            }
        }
    }

    ImportResult {
        imported,
        skipped,
        failed,
        warnings,
    }
}

fn import_single_file_to_storage(
    storage_dir: &Path,
    file: ImportFileRequest,
) -> DesktopResult<(ImportOutcome, Vec<String>)> {
    // Przed dekodowaniem: base64 tego rozmiaru rozpychalby pamiec (jak w serwerze web).
    if file.base64.len() > MAX_BASE64_NA_PLIK {
        return Err(DesktopError::new(
            "FILE_TOO_LARGE",
            format!("Plik jest zbyt duży (limit {MAX_BAJTOW_NA_PLIK_MIB} MiB na plik)."),
            false,
        ));
    }
    let mut warnings = Vec::new();
    let relative_path = sanitize_import_relative_path(&file.relative_path, &file.file_name);
    let target = ensure_new_child(storage_dir, &relative_path)?;
    assert_import_extension(&target)?;
    let bytes = general_purpose::STANDARD
        .decode(file.base64.as_bytes())
        .map_err(|error| {
            DesktopError::new(
                "ENGINE_INVALID_JSON",
                format!("Invalid base64 import payload: {error}"),
                true,
            )
        })?;

    // Podmiana w miejscu tylko dla plikow tworzonych przez aplikacje. Wyciag
    // wgrany przez uzytkownika bywa jedyna kopia - sama flaga od frontu nie moze
    // go zastapic, dostaje kopie ze znacznikiem czasu jak kazdy plik.
    let nadpisz = file.overwrite.unwrap_or(false) && overwritable_in_place(&relative_path);
    // Rownolegle nadpisania tego samego pliku ida po kolei: kopia poprzedniej wersji i
    // podmiana nie moga sie przeplatac (jak kolejka blokad w wersji web).
    let blokada = nadpisz.then(|| blokady_zapisu().dla(&target));
    let _zapis = blokada.as_deref().map(zajmij);

    if target.exists() && !nadpisz {
        let existing_hash = sha256_file(&target).ok();
        let incoming_hash = sha256_bytes(&bytes);
        if existing_hash.as_deref() == Some(incoming_hash.as_str()) {
            return Ok((
                ImportOutcome::Skipped(storage_file_from_path(storage_dir, &relative_path, true)?),
                warnings,
            ));
        }
        warnings.push(format!(
            "File already exists and differs, writing timestamped copy: {relative_path}"
        ));
    }

    let final_target = if nadpisz {
        if target.exists() && managed_broker_export(&relative_path) {
            let backup_dir = storage_dir.parent().unwrap_or(storage_dir).join("backupy");
            if preserve_previous_export(&backup_dir, &target, &bytes)? {
                warnings.push("Previous Freedom24 export copied to backupy before update".to_string());
            }
        }
        target.clone()
    } else {
        unique_target_path(&target)
    };
    reject_symlink_target(&final_target)?;
    zapisz_atomowo(&final_target, &bytes, nadpisz)?;
    let canonical_storage_dir = storage_dir
        .canonicalize()
        .unwrap_or_else(|_| storage_dir.to_path_buf());
    let final_relative = final_target
        .strip_prefix(&canonical_storage_dir)
        .unwrap_or(&final_target)
        .to_string_lossy()
        .replace('\\', "/");
    Ok((
        ImportOutcome::Imported(storage_file_from_path(storage_dir, &final_relative, true)?),
        warnings,
    ))
}

/// Ile kopii `.bak` zostaje dla kazdego pliku eksportu Freedom24 (jak w web).
const KOPII_EKSPORTU_FREEDOM24: usize = 10;

/// Kopia poprzedniej wersji eksportu przed nadpisaniem (jak backupStore.ts w web):
/// nie kopiuje, gdy nowa tresc jest identyczna z obecna albo obecna jest identyczna
/// z ostatnia kopia; zostawia ostatnie KOPII_EKSPORTU_FREEDOM24 kopii pliku.
/// Zwraca, czy kopia powstala.
fn preserve_previous_export(backup_dir: &Path, target: &Path, new_bytes: &[u8]) -> DesktopResult<bool> {
    let timestamp = chrono::Utc::now().format("%Y%m%d-%H%M%S-%3f").to_string();
    preserve_previous_export_at(backup_dir, target, new_bytes, &timestamp)
}

fn preserve_previous_export_at(
    backup_dir: &Path,
    target: &Path,
    new_bytes: &[u8],
    timestamp: &str,
) -> DesktopResult<bool> {
    let io_error = |error: std::io::Error| {
        DesktopError::io("STORAGE_PERMISSION_DENIED", "Cannot back up broker export", error)
    };
    fs::create_dir_all(backup_dir).map_err(io_error)?;
    let current = fs::read(target).map_err(io_error)?;
    if current == new_bytes {
        return Ok(false);
    }
    let stem = target
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("freedom24_export")
        .to_string();
    let extension_suffix = target
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".bak.{value}"));
    let prefix = format!("{stem}-");
    let mut existing: Vec<String> = fs::read_dir(backup_dir)
        .map_err(io_error)?
        .flatten()
        .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
        .filter(|name| {
            name.starts_with(&prefix)
                && (name.ends_with(".bak")
                    || extension_suffix.as_deref().is_some_and(|suffix| name.ends_with(suffix)))
        })
        .collect();
    existing.sort();
    let same_as_last = match existing.last() {
        Some(last) => fs::read(backup_dir.join(last)).map(|bytes| bytes == current).unwrap_or(false),
        None => false,
    };
    let mut created = false;
    if !same_as_last {
        let name = copy_without_overwriting(target, backup_dir, &stem, timestamp).map_err(io_error)?;
        existing.push(name);
        existing.sort();
        created = true;
    }
    let excess = existing.len().saturating_sub(KOPII_EKSPORTU_FREEDOM24);
    for old in existing.into_iter().take(excess) {
        let _ = fs::remove_file(backup_dir.join(old));
    }
    Ok(created)
}
/// Kopiuje plik do `{stem}-{timestamp}.bak`; gdy taka nazwa juz istnieje (dwie kopie w tej
/// samej milisekundzie), dopisuje sufiks `_2`, `_3`... Plik powstaje przez create_new, wiec
/// istniejaca kopia nigdy nie jest nadpisywana. Sufiks sortuje sie po nazwie bez sufiksu.
fn copy_without_overwriting(
    source: &Path,
    backup_dir: &Path,
    stem: &str,
    timestamp: &str,
) -> std::io::Result<String> {
    // Zrodlo otwieramy przed utworzeniem celu: blad odczytu nie zostawia pustego .bak,
    // ktory zajmowalby miejsce w rotacji.
    let mut input = fs::File::open(source)?;
    for attempt in 1_u32.. {
        let name = if attempt == 1 {
            format!("{stem}-{timestamp}.bak")
        } else {
            format!("{stem}-{timestamp}_{attempt}.bak")
        };
        let mut destination = match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(backup_dir.join(&name))
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        };
        if let Err(error) = std::io::copy(&mut input, &mut destination) {
            drop(destination);
            let _ = fs::remove_file(backup_dir.join(&name));
            return Err(error);
        }
        return Ok(name);
    }
    unreachable!("petla po liczbach naturalnych konczy sie tylko przez return")
}
/// Zapis przez plik tymczasowy obok celu. Przerwany zapis nie zostawia w
/// magazynie ucietego pliku, na ktorym wywrocilby sie nastepny przebieg silnika,
/// a nowy plik nigdy nie zastepuje istniejacego (wyscig dwoch importow).
fn zapisz_atomowo(cel: &Path, bytes: &[u8], nadpisz: bool) -> DesktopResult<()> {
    let blad_zapisu = |error: std::io::Error| {
        DesktopError::io("STORAGE_PERMISSION_DENIED", "Cannot write imported file", error)
    };
    let tymczasowy = cel.with_file_name(format!(".{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&tymczasowy, bytes).map_err(blad_zapisu)?;
    let wynik = if nadpisz {
        fs::rename(&tymczasowy, cel)
    } else {
        match fs::hard_link(&tymczasowy, cel) {
            Ok(()) => fs::remove_file(&tymczasowy),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Err(error),
            // System plikow bez dowiazan (np. exFAT): nazwa jest swiezo
            // sprawdzona, a zmiana nazwy i tak nie zostawi ucietego pliku.
            Err(_) => fs::rename(&tymczasowy, cel),
        }
    };
    if let Err(error) = wynik {
        let _ = fs::remove_file(&tymczasowy);
        return Err(blad_zapisu(error));
    }
    Ok(())
}

/// Pliki w katalogu glownym magazynu, ktore aplikacja sama tworzy i odswieza.
fn overwritable_in_place(relative_path: &str) -> bool {
    matches!(
        relative_path,
        "freedom24_komplet.json"
            | "broker_raport_api.json"
            | "dezpozytariusz_raport_api.json"
            | "portfel_reczne_transakcje.json"
    )
}

fn managed_broker_export(relative_path: &str) -> bool {
    matches!(
        Path::new(relative_path)
            .file_name()
            .and_then(|name| name.to_str()),
        Some(
            "freedom24_komplet.json" | "broker_raport_api.json" | "dezpozytariusz_raport_api.json"
        )
    )
}

fn sanitize_import_relative_path(relative_path: &str, file_name: &str) -> String {
    let raw = if relative_path.trim().is_empty() {
        file_name
    } else {
        relative_path
    }
    .trim()
    .trim_matches('"')
    .trim_matches('\'')
    .replace('\\', "/");
    // Litera dysku i sciezka UNC musza byc rozpoznane niezaleznie od systemu,
    // na ktorym kod dziala. Na Linuksie sciezka z litera dysku nie jest uznawana
    // za bezwzgledna, wiec zamiast samej nazwy pliku powstawalo w magazynie
    // zaglebienie katalogow odwzorowujace cala sciezke z komputera uzytkownika.
    let bajty = raw.as_bytes();
    let ma_litere_dysku = bajty.len() >= 2 && bajty[0].is_ascii_alphabetic() && bajty[1] == b':';
    let path = Path::new(&raw);
    let unsafe_path = ma_litere_dysku
        || raw.starts_with("//")
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        });
    if unsafe_path {
        return sanitize_import_filename(file_name)
            .or_else(|| sanitize_import_filename(&raw))
            .unwrap_or_else(|| "plik".to_string());
    }
    let parts = raw
        .split('/')
        .filter_map(sanitize_import_filename)
        .collect::<Vec<_>>();
    if parts.is_empty() {
        sanitize_import_filename(file_name).unwrap_or_else(|| "plik".to_string())
    } else {
        parts.join("/")
    }
}

fn sanitize_import_filename(value: &str) -> Option<String> {
    let raw = value
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .replace('\\', "/");
    let leaf = raw
        .split('/')
        .filter(|part| !part.is_empty())
        .last()
        .unwrap_or(raw.as_str());
    let sanitized = leaf
        .chars()
        .map(|character| match character {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            character if character.is_control() => '_',
            character => character,
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string();
    if sanitized.is_empty() {
        None
    } else {
        Some(sanitized)
    }
}

pub fn storage_file_from_path(
    base_dir: &Path,
    relative_path: &str,
    include_hash: bool,
) -> DesktopResult<StorageFile> {
    let target = ensure_existing_child(base_dir, relative_path)?;
    let metadata = fs::metadata(&target).map_err(|error| {
        DesktopError::io(
            "STORAGE_NOT_FOUND",
            "Cannot read storage file metadata",
            error,
        )
    })?;
    let modified = metadata
        .modified()
        .ok()
        .map(chrono::DateTime::<chrono::Utc>::from)
        .map(|value| value.to_rfc3339())
        .unwrap_or_default();
    Ok(StorageFile {
        relative_path: relative_path.replace('\\', "/"),
        file_name: target
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(relative_path)
            .to_string(),
        extension: format!(".{}", extension(&target)),
        size_bytes: metadata.len(),
        modified_at: modified,
        sha256: if include_hash {
            sha256_file(&target).ok()
        } else {
            None
        },
        source_status: "unknown".to_string(),
    })
}

fn guess_mime_type(path: &Path) -> String {
    match extension(path).as_str() {
        "json" => "application/json",
        "csv" | "txt" | "xml" => "text/plain",
        "pdf" => "application/pdf",
        "xlsx" | "xls" => "application/octet-stream",
        _ => "application/octet-stream",
    }
    .to_string()
}

pub(crate) fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

pub(crate) fn unique_target_path(target: &Path) -> PathBuf {
    if !target.exists() {
        return target.to_path_buf();
    }
    let stem = target
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("file");
    let ext = target
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let timestamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    // Kilka plikow o tej samej nazwie w jednej sekundzie (np. Transakcje.xlsx z
    // dwoch folderow w jednym przeciagnieciu) dostawalo te sama nazwe z
    // sygnatura czasu - kolejny zapis nadpisywal poprzednia kopie.
    let mut proba = 0u32;
    loop {
        let przyrostek = if proba == 0 { String::new() } else { format!("-{proba}") };
        let filename = if ext.is_empty() {
            format!("{stem}-{timestamp}{przyrostek}")
        } else {
            format!("{stem}-{timestamp}{przyrostek}.{ext}")
        };
        let kandydat = target.with_file_name(filename);
        if !kandydat.exists() {
            return kandydat;
        }
        proba += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose;

    fn temp_storage_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "invest-analyzer-storage-test-{name}-{}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        fs::create_dir_all(&dir).expect("create temp storage dir");
        dir
    }

    #[test]
    fn sanitize_import_relative_path_turns_absolute_windows_path_into_filename() {
        assert_eq!(
            sanitize_import_relative_path(
                r#"C:\Users\TestUser\Downloads\investment-tax-engine\dane\pliki\broker_raport_bezbliansu.json"#,
                r#"C:\Users\TestUser\Downloads\investment-tax-engine\dane\pliki\broker_raport_bezbliansu.json"#,
            ),
            "broker_raport_bezbliansu.json",
        );
    }

    #[test]
    fn sanitize_import_relative_path_preserves_safe_nested_path() {
        assert_eq!(
            sanitize_import_relative_path("originals/broker.json", "broker.json"),
            "originals/broker.json",
        );
    }

    #[test]
    fn sanitize_import_relative_path_removes_traversal_from_drag_drop_names() {
        assert_eq!(
            sanitize_import_relative_path("../sekret/../../broker.json", "broker.json"),
            "broker.json",
        );
    }

    /// Plik wykonywalny nie ma czego szukac w katalogu skanowanym przez silnik.
    /// Odrzucenie go nie moze jednak przerwac calego importu - pozostale pliki
    /// z tej samej partii maja zostac wczytane, a powod odrzucenia zaraportowany.
    #[test]
    fn import_files_to_storage_dir_rejects_executables_but_keeps_the_rest_of_the_batch() {
        let dir = temp_storage_dir("partial");
        let result = import_files_to_storage_dir(
            &dir,
            vec![
                ImportFileRequest {
                    relative_path: r#"C:\Users\TestUser\Downloads\Transakcje.xlsx"#.to_string(),
                    file_name: r#"C:\Users\TestUser\Downloads\Transakcje.xlsx"#.to_string(),
                    base64: general_purpose::STANDARD.encode(b"ok"),
                    overwrite: None,
                },
                ImportFileRequest {
                    relative_path: "zly.exe".to_string(),
                    file_name: "zly.exe".to_string(),
                    base64: general_purpose::STANDARD.encode(b"bad"),
                    overwrite: None,
                },
            ],
        );

        assert_eq!(
            result.imported.len(),
            1,
            "warnings={:?} failed={:?}",
            result.warnings,
            result.failed
        );
        assert_eq!(result.imported[0].relative_path, "Transakcje.xlsx");
        assert_eq!(result.failed.len(), 1);
        assert_eq!(result.failed[0].file_name, "zly.exe");
        assert_eq!(result.failed[0].error_code, "UNSUPPORTED_FILE_TYPE");
        assert!(
            !dir.join("zly.exe").exists(),
            "odrzucony plik nie moze trafic na dysk"
        );
        fs::remove_dir_all(&dir).ok();
    }

    fn plik_json(nazwa: &str, base64: String) -> ImportFileRequest {
        ImportFileRequest {
            relative_path: nazwa.to_string(),
            file_name: nazwa.to_string(),
            base64,
            overwrite: None,
        }
    }

    /// Desktop: 32 MiB na plik, kod FILE_TOO_LARGE jak w web, reszta partii przechodzi;
    /// wyciag rzedu kilku MiB (odrzucany przez limit web) jest przyjmowany.
    #[test]
    fn za_duzy_plik_base64_jest_odrzucany_przed_dekodowaniem_a_reszta_partii_przechodzi() {
        let dir = temp_storage_dir("limit-rozmiaru");
        // Dlugosc bez sensu jako base64 (nie wielokrotnosc 4) - gdyby doszlo do
        // dekodowania, blad bylby inny niz FILE_TOO_LARGE.
        let za_duzy = "A".repeat(MAX_BASE64_NA_PLIK + 1);
        let na_granicy = "A".repeat(MAX_BASE64_NA_PLIK);
        let result = import_files_to_storage_dir(
            &dir,
            vec![
                plik_json("za-duzy.json", za_duzy),
                plik_json("na-granicy.json", na_granicy),
                plik_json("maly.json", general_purpose::STANDARD.encode(b"{}")),
                plik_json(
                    "wieloletni.json",
                    general_purpose::STANDARD.encode(vec![b' '; 5 * 1024 * 1024]),
                ),
            ],
        );
        assert_eq!(result.failed.len(), 1, "failed={:?}", result.failed);
        assert_eq!(result.failed[0].file_name, "za-duzy.json");
        assert_eq!(result.failed[0].error_code, "FILE_TOO_LARGE");
        assert!(result.failed[0].message.contains("32 MiB"), "{}", result.failed[0].message);
        assert!(!result.failed[0].recoverable);
        assert_eq!(result.imported.len(), 3, "warnings={:?}", result.warnings);
        assert!(!dir.join("za-duzy.json").exists());
        fs::remove_dir_all(&dir).ok();
    }

    /// Serwer web: partia ponad 50 plikow jest odrzucana w calosci.
    #[test]
    fn partia_ponad_limit_plikow_jest_odrzucana_w_calosci() {
        assert!(sprawdz_limit_partii(MAX_PLIKOW_W_PARTII).is_ok());
        let blad = sprawdz_limit_partii(MAX_PLIKOW_W_PARTII + 1).unwrap_err();
        assert_eq!(blad.error_code, "TOO_MANY_FILES");
        assert!(blad.message.contains("limit 50"), "{}", blad.message);
    }
}

#[cfg(test)]
mod testy_nadpisywania {
    use super::*;
    use base64::engine::general_purpose;

    #[test]
    fn nadpisanie_symlinka_nie_zapisuje_poza_magazynem() {
        let katalog = std::env::temp_dir().join(format!("ia-symlink-{}", uuid::Uuid::new_v4()));
        let magazyn = katalog.join("magazyn");
        fs::create_dir_all(&magazyn).unwrap();
        let poza = katalog.join("poza.json");
        fs::write(&poza, b"oryginal").unwrap();
        let link = magazyn.join("freedom24_komplet.json");
        #[cfg(windows)]
        let wynik_linku = std::os::windows::fs::symlink_file(&poza, &link);
        #[cfg(unix)]
        let wynik_linku = std::os::unix::fs::symlink(&poza, &link);
        if let Err(error) = wynik_linku {
            if error.kind() == std::io::ErrorKind::PermissionDenied
                || (cfg!(windows) && error.raw_os_error() == Some(1314))
            {
                fs::remove_dir_all(&katalog).ok();
                return; // Windows bez uprawnienia do tworzenia symlinkow.
            }
            panic!("Nie mozna utworzyc symlinka: {error}");
        }

        let wynik = import_single_file_to_storage(
            &magazyn,
            ImportFileRequest {
                relative_path: "freedom24_komplet.json".to_string(),
                file_name: "freedom24_komplet.json".to_string(),
                base64: general_purpose::STANDARD.encode(b"nowy"),
                overwrite: Some(true),
            },
        );
        assert_eq!(wynik.err().unwrap().error_code, "PATH_TRAVERSAL_BLOCKED");
        assert_eq!(fs::read(&poza).unwrap(), b"oryginal");
        fs::remove_dir_all(&katalog).ok();
    }

    /// Pliki odtwarzane przez aplikacje przy kazdym przeliczeniu musza
    /// zastepowac poprzednia wersje. Kopia ze znacznikiem czasu oznaczalaby,
    /// ze silnik liczy te same transakcje kilka razy.
    #[test]
    fn nadpisanie_zastepuje_plik_zamiast_tworzyc_kopie() {
        let katalog = std::env::temp_dir().join(format!("ia-nadpis-{}", std::process::id()));
        let _ = fs::remove_dir_all(&katalog);
        fs::create_dir_all(&katalog).unwrap();

        for tresc in [b"pierwsza".as_slice(), b"druga".as_slice()] {
            let wynik = import_files_to_storage_dir(
                &katalog,
                vec![ImportFileRequest {
                    relative_path: "portfel_reczne_transakcje.json".to_string(),
                    file_name: "portfel_reczne_transakcje.json".to_string(),
                    base64: general_purpose::STANDARD.encode(tresc),
                    overwrite: Some(true),
                }],
            );
            assert!(wynik.failed.is_empty(), "import nie moze sie wywrocic");
        }

        let pliki: Vec<_> = fs::read_dir(&katalog)
            .unwrap()
            .filter_map(|wpis| wpis.ok())
            .map(|wpis| wpis.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(
            pliki.len(),
            1,
            "nadpisanie nie moze mnozyc plikow: {pliki:?}"
        );
        assert_eq!(
            fs::read_to_string(katalog.join("portfel_reczne_transakcje.json")).unwrap(),
            "druga"
        );

        let _ = fs::remove_dir_all(&katalog);
    }

    /// Bez flagi nic sie nie zmienia: dane uzytkownika nie znikaja po cichu.
    #[test]
    fn bez_flagi_powstaje_kopia() {
        let katalog = std::env::temp_dir().join(format!("ia-kopia-{}", std::process::id()));
        let _ = fs::remove_dir_all(&katalog);
        fs::create_dir_all(&katalog).unwrap();

        for tresc in [b"pierwsza".as_slice(), b"druga".as_slice()] {
            import_files_to_storage_dir(
                &katalog,
                vec![ImportFileRequest {
                    relative_path: "wyciag.json".to_string(),
                    file_name: "wyciag.json".to_string(),
                    base64: general_purpose::STANDARD.encode(tresc),
                    overwrite: None,
                }],
            );
        }

        let liczba = fs::read_dir(&katalog).unwrap().count();
        assert_eq!(liczba, 2, "plik uzytkownika nie moze zostac nadpisany");

        let _ = fs::remove_dir_all(&katalog);
    }

    /// Trzy rozne pliki o tej samej nazwie w jednym imporcie (np. Transakcje.xlsx
    /// z trzech folderow) - zadna kopia nie moze nadpisac innej.
    #[test]
    fn trzy_pliki_o_tej_samej_nazwie_w_jednej_sekundzie_zostaja_osobno() {
        let katalog = std::env::temp_dir().join(format!("ia-trzy-{}", std::process::id()));
        let _ = fs::remove_dir_all(&katalog);
        fs::create_dir_all(&katalog).unwrap();

        let tresci = [b"rok2023".as_slice(), b"rok2024".as_slice(), b"rok2025".as_slice()];
        let wynik = import_files_to_storage_dir(
            &katalog,
            tresci
                .iter()
                .map(|tresc| ImportFileRequest {
                    relative_path: "wyciag.json".to_string(),
                    file_name: "wyciag.json".to_string(),
                    base64: general_purpose::STANDARD.encode(tresc),
                    overwrite: None,
                })
                .collect(),
        );
        assert!(wynik.failed.is_empty(), "import nie moze sie wywrocic");

        let mut zapisane: Vec<String> = fs::read_dir(&katalog)
            .unwrap()
            .filter_map(|wpis| wpis.ok())
            .map(|wpis| fs::read_to_string(wpis.path()).unwrap())
            .collect();
        zapisane.sort();
        assert_eq!(zapisane, vec!["rok2023", "rok2024", "rok2025"], "zadna kopia nie moze zginac");

        let _ = fs::remove_dir_all(&katalog);
    }

    /// Flaga nadpisania od frontu nie podmienia wyciagu uzytkownika ani pliku
    /// o nazwie eksportu lezacego w podkatalogu.
    #[test]
    fn flaga_nadpisania_nie_podmienia_wyciagu_uzytkownika() {
        let katalog = std::env::temp_dir().join(format!("ia-flaga-{}", std::process::id()));
        let _ = fs::remove_dir_all(&katalog);
        fs::create_dir_all(katalog.join("stare")).unwrap();

        for sciezka in ["wyciag_2025.json", "stare/freedom24_komplet.json"] {
            for tresc in [b"pierwsza".as_slice(), b"druga".as_slice()] {
                let wynik = import_files_to_storage_dir(
                    &katalog,
                    vec![ImportFileRequest {
                        relative_path: sciezka.to_string(),
                        file_name: sciezka.rsplit('/').next().unwrap().to_string(),
                        base64: general_purpose::STANDARD.encode(tresc),
                        overwrite: Some(true),
                    }],
                );
                assert!(wynik.failed.is_empty(), "import nie moze sie wywrocic: {:?}", wynik.failed.len());
            }
            assert_eq!(fs::read_to_string(katalog.join(sciezka)).unwrap(), "pierwsza");
        }
        assert_eq!(fs::read_dir(katalog.join("stare")).unwrap().count(), 2);

        let _ = fs::remove_dir_all(&katalog);
    }

    #[test]
    fn backup_eksportu_pomija_identyczna_tresc_i_rotuje_do_dziesieciu() {
        let root = std::env::temp_dir().join(format!("ia-bak-{}", uuid::Uuid::new_v4()));
        let backups = root.join("backupy");
        fs::create_dir_all(&root).unwrap();
        let target = root.join("freedom24_komplet.json");
        fs::write(&target, "v0").unwrap();

        // Nowa tresc identyczna z obecna: bez kopii.
        assert!(!preserve_previous_export(&backups, &target, b"v0").unwrap());
        assert!(!backups.exists() || fs::read_dir(&backups).unwrap().count() == 0);

        // Kolejne nadpisania roznymi trescia: kopia przy kazdej, do 10.
        for indeks in 1..=13 {
            assert!(preserve_previous_export(&backups, &target, format!("v{indeks}").as_bytes()).unwrap());
            fs::write(&target, format!("v{indeks}")).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(3));
        }
        let mut names: Vec<_> = fs::read_dir(&backups).unwrap().flatten().map(|e| e.file_name()).collect();
        names.sort();
        assert_eq!(names.len(), KOPII_EKSPORTU_FREEDOM24);
        // Zostaly najnowsze kopie: v3..v12 (v0..v2 rotowane).
        let tresci: Vec<String> = names.iter().map(|n| fs::read_to_string(backups.join(n)).unwrap()).collect();
        assert_eq!(tresci.first().unwrap(), "v3");
        assert_eq!(tresci.last().unwrap(), "v12");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn backup_eksportu_pomija_kopie_gdy_obecna_rowna_sie_ostatniej() {
        let root = std::env::temp_dir().join(format!("ia-bak-{}", uuid::Uuid::new_v4()));
        let backups = root.join("backupy");
        fs::create_dir_all(&root).unwrap();
        let target = root.join("freedom24_komplet.json");
        fs::write(&target, "stary").unwrap();

        assert!(preserve_previous_export(&backups, &target, b"nowy").unwrap());
        // Ta sama obecna tresc, inna nowa: ostatnia kopia juz ja zawiera.
        assert!(!preserve_previous_export(&backups, &target, b"jeszcze-nowszy").unwrap());
        assert_eq!(fs::read_dir(&backups).unwrap().count(), 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn kopie_eksportu_w_tej_samej_milisekundzie_nie_nadpisuja_sie() {
        let root = std::env::temp_dir().join(format!("ia-bak-ms-{}", uuid::Uuid::new_v4()));
        let backups = root.join("backupy");
        fs::create_dir_all(&root).unwrap();
        let target = root.join("freedom24_komplet.json");
        fs::write(&target, "v0").unwrap();

        // Bez przerw: kilka kopii wypada w tej samej milisekundzie.
        for indeks in 1..=12 {
            assert!(preserve_previous_export(&backups, &target, format!("v{indeks}").as_bytes()).unwrap());
            fs::write(&target, format!("v{indeks}")).unwrap();
        }

        let mut tresci: Vec<String> = fs::read_dir(&backups)
            .unwrap()
            .flatten()
            .map(|entry| fs::read_to_string(entry.path()).unwrap())
            .collect();
        tresci.sort();
        // 12 roznych poprzednich wersji (v0..v11), rotacja zostawia 10 najnowszych: v2..v11.
        let mut oczekiwane: Vec<String> = (2..=11).map(|i| format!("v{i}")).collect();
        oczekiwane.sort();
        assert_eq!(tresci, oczekiwane);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn kopie_eksportu_o_tym_samym_znaczniku_czasu_nie_nadpisuja_sie() {
        let root = std::env::temp_dir().join(format!("ia-bak-ts-{}", uuid::Uuid::new_v4()));
        let backups = root.join("backupy");
        fs::create_dir_all(&root).unwrap();
        let target = root.join("freedom24_komplet.json");
        fs::write(&target, "v0").unwrap();

        // Ten sam znacznik czasu (ta sama milisekunda): kazda kopia zostaje osobnym plikiem.
        for indeks in 1..=4 {
            assert!(
                preserve_previous_export_at(&backups, &target, format!("v{indeks}").as_bytes(), "20260929-120000-000")
                    .unwrap()
            );
            fs::write(&target, format!("v{indeks}")).unwrap();
        }

        let mut tresci: Vec<String> = fs::read_dir(&backups)
            .unwrap()
            .flatten()
            .map(|entry| fs::read_to_string(entry.path()).unwrap())
            .collect();
        tresci.sort();
        assert_eq!(tresci, ["v0", "v1", "v2", "v3"], "zadna wersja nie zostala nadpisana");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rownolegle_nadpisania_tego_samego_eksportu_nie_gubia_zadnej_wersji() {
        let root = std::env::temp_dir().join(format!("ia-rownolegle-{}", uuid::Uuid::new_v4()));
        let storage = root.join("storage");
        fs::create_dir_all(&storage).unwrap();
        fs::write(storage.join("freedom24_komplet.json"), "start").unwrap();

        let watki: Vec<_> = (0..8)
            .map(|indeks| {
                let storage = storage.clone();
                std::thread::spawn(move || {
                    import_files_to_storage_dir(
                        &storage,
                        vec![ImportFileRequest {
                            relative_path: "freedom24_komplet.json".to_string(),
                            file_name: "freedom24_komplet.json".to_string(),
                            base64: general_purpose::STANDARD.encode(format!("wersja-{indeks}")),
                            overwrite: Some(true),
                        }],
                    )
                })
            })
            .collect();
        for watek in watki {
            let wynik = watek.join().unwrap();
            assert!(wynik.failed.is_empty(), "nadpisanie sie nie udalo: {:?}", wynik.warnings);
        }

        // Kazda z 9 wersji (start + 8 nadpisan) istnieje: 8 kopii + biezacy plik.
        let mut wersje: Vec<String> = fs::read_dir(root.join("backupy"))
            .unwrap()
            .flatten()
            .map(|wpis| fs::read_to_string(wpis.path()).unwrap())
            .collect();
        wersje.push(fs::read_to_string(storage.join("freedom24_komplet.json")).unwrap());
        wersje.sort();
        let mut oczekiwane: Vec<String> = std::iter::once("start".to_string())
            .chain((0..8).map(|i| format!("wersja-{i}")))
            .collect();
        oczekiwane.sort();
        assert_eq!(wersje, oczekiwane);
        let _ = fs::remove_dir_all(root);
    }

    /// Nieodczytywalne zrodlo nie moze zostawic pustego .bak: zajmowalby miejsce w
    /// rotacji dziesieciu kopii i wypychal prawdziwe.
    #[test]
    fn blad_otwarcia_zrodla_nie_zostawia_pustej_kopii() {
        let root = std::env::temp_dir().join(format!("ia-bak-brak-{}", uuid::Uuid::new_v4()));
        let backups = root.join("backupy");
        fs::create_dir_all(&backups).unwrap();

        let wynik = copy_without_overwriting(
            &root.join("nie-istnieje.json"),
            &backups,
            "freedom24_komplet",
            "20260929-120000-000",
        );

        assert!(wynik.is_err());
        let pozostale: Vec<_> = fs::read_dir(&backups).unwrap().flatten().map(|e| e.file_name()).collect();
        assert!(pozostale.is_empty(), "pusta kopia zostala w rotacji: {pozostale:?}");
        let _ = fs::remove_dir_all(root);
    }
}
