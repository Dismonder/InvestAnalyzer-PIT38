use crate::engine::errors::{DesktopError, DesktopResult};
use chrono::{Duration, Utc};
use std::cmp::Reverse;
use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

pub fn safe_relative_path(relative_path: &str) -> DesktopResult<PathBuf> {
    let trimmed = relative_path.trim();
    if trimmed.is_empty() {
        return Err(DesktopError::new(
            "PATH_TRAVERSAL_BLOCKED",
            "Empty path is not allowed.",
            true,
        ));
    }
    // Path::components() rozbija sciezke wedlug regul systemu, na ktorym kod
    // dziala. Na Windows "..\\secret.txt" to ParentDir + plik i jest blokowane,
    // ale na Linuksie to JEDNA nazwa pliku z ukosnikiem wstecznym w srodku -
    // straznik przepuszczal ja bez slowa. Aplikacja dziala dzis tylko na
    // Windows, wiec dziury nie ma, ale straznik sciezek nie moze zalezec od
    // tego, gdzie akurat zostal skompilowany.
    if trimmed.contains('\\') {
        return Err(DesktopError::new(
            "PATH_TRAVERSAL_BLOCKED",
            "Backslashes are not allowed in paths from the frontend.",
            true,
        ));
    }
    // Przedrostek dysku ("C:") i sciezka UNC ("//serwer") sa bezwzgledne na
    // Windows, a na Linuksie wygladaja jak zwykla nazwa katalogu.
    let bytes = trimmed.as_bytes();
    let ma_litere_dysku = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    if ma_litere_dysku || trimmed.starts_with("//") {
        return Err(DesktopError::new(
            "PATH_TRAVERSAL_BLOCKED",
            "Absolute paths from the frontend are not allowed.",
            true,
        ));
    }
    if trimmed
        .split('/')
        .any(|czesc| czesc == ".." || czesc.trim() == "..")
    {
        return Err(DesktopError::new(
            "PATH_TRAVERSAL_BLOCKED",
            "Path traversal is blocked.",
            true,
        ));
    }

    let path = Path::new(trimmed);
    if path.is_absolute() {
        return Err(DesktopError::new(
            "PATH_TRAVERSAL_BLOCKED",
            "Absolute paths from the frontend are not allowed.",
            true,
        ));
    }
    for component in path.components() {
        if matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        ) {
            return Err(DesktopError::new(
                "PATH_TRAVERSAL_BLOCKED",
                "Path traversal is blocked.",
                true,
            ));
        }
    }
    Ok(path.to_path_buf())
}

pub fn ensure_existing_child(base_dir: &Path, relative_path: &str) -> DesktopResult<PathBuf> {
    let safe_relative = safe_relative_path(relative_path)?;
    let base = base_dir.canonicalize().map_err(|error| {
        DesktopError::io(
            "STORAGE_NOT_FOUND",
            "Cannot canonicalize base directory",
            error,
        )
    })?;
    let target = base.join(safe_relative);
    let canonical_target = target.canonicalize().map_err(|error| {
        DesktopError::io(
            "STORAGE_NOT_FOUND",
            "Cannot canonicalize target path",
            error,
        )
    })?;
    if !canonical_target.starts_with(&base) {
        return Err(DesktopError::new(
            "PATH_TRAVERSAL_BLOCKED",
            "Target path escapes allowed directory.",
            true,
        ));
    }
    Ok(canonical_target)
}

pub fn ensure_new_child(base_dir: &Path, relative_path: &str) -> DesktopResult<PathBuf> {
    let safe_relative = safe_relative_path(relative_path)?;
    fs::create_dir_all(base_dir).map_err(|error| {
        DesktopError::io(
            "STORAGE_PERMISSION_DENIED",
            "Cannot create base directory",
            error,
        )
    })?;
    let base = base_dir.canonicalize().map_err(|error| {
        DesktopError::io(
            "STORAGE_NOT_FOUND",
            "Cannot canonicalize base directory",
            error,
        )
    })?;
    let target = base.join(safe_relative);
    let parent = target.parent().ok_or_else(|| {
        DesktopError::new(
            "PATH_TRAVERSAL_BLOCKED",
            "Target path has no parent directory.",
            true,
        )
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        DesktopError::io(
            "STORAGE_PERMISSION_DENIED",
            "Cannot create target directory",
            error,
        )
    })?;
    let parent_canonical = parent.canonicalize().map_err(|error| {
        DesktopError::io(
            "STORAGE_NOT_FOUND",
            "Cannot canonicalize target parent",
            error,
        )
    })?;
    if !parent_canonical.starts_with(&base) {
        return Err(DesktopError::new(
            "PATH_TRAVERSAL_BLOCKED",
            "Target path escapes allowed directory.",
            true,
        ));
    }
    reject_symlink_target(&target)?;
    Ok(target)
}

pub fn reject_symlink_target(target: &Path) -> DesktopResult<()> {
    match fs::symlink_metadata(target) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(DesktopError::new(
            "PATH_TRAVERSAL_BLOCKED",
            "Target path is a symbolic link.",
            true,
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(DesktopError::io(
            "STORAGE_PERMISSION_DENIED",
            "Cannot inspect target path",
            error,
        )),
    }
}

/// Twardy limit liczby zachowanych przebiegów silnika w `runs`.
pub const MAX_RUNS_KEPT: usize = 20;
/// Twardy limit łącznego rozmiaru zachowanych przebiegów (wynik jednego przebiegu
/// na prawdziwych danych to ok. 100 MB).
pub const MAX_RUNS_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// `active_runs` to nazwy katalogów przebiegów zadań, które jeszcze pracują:
/// żadne czyszczenie ich nie rusza.
pub fn cleanup_runtime_dirs(
    runs_dir: &Path,
    logs_dir: &Path,
    temp_dir: &Path,
    active_runs: &HashSet<String>,
) {
    let none = HashSet::new();
    cleanup_entries_older_than(logs_dir, 30, &none);
    cleanup_entries_older_than(temp_dir, 7, &none);
    keep_latest_entries(runs_dir, MAX_RUNS_KEPT, MAX_RUNS_BYTES, active_runs);
    cleanup_entries_older_than(runs_dir, 30, active_runs);
}

fn cleanup_entries_older_than(dir: &Path, days: i64, protected: &HashSet<String>) {
    let cutoff = Utc::now() - Duration::days(days);
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if protected.contains(&entry.file_name().to_string_lossy().to_string()) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        let modified: chrono::DateTime<Utc> = modified.into();
        if modified < cutoff {
            let path = entry.path();
            if metadata.is_dir() {
                let _ = fs::remove_dir_all(path);
            } else {
                let _ = fs::remove_file(path);
            }
        }
    }
}

/// Wpis katalogu czyszczonego z limitami liczby i rozmiaru.
struct CleanupEntry {
    path: PathBuf,
    name: String,
    modified: std::time::SystemTime,
    size: u64,
}

/// Rozmiar pliku lub katalogu; dowiązania symboliczne nie są śledzone.
fn entry_size(path: &Path) -> u64 {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return 0;
    };
    if !metadata.is_dir() {
        return metadata.len();
    }
    let Ok(children) = fs::read_dir(path) else {
        return 0;
    };
    children.flatten().map(|child| entry_size(&child.path())).sum()
}

/// Wpisy do usunięcia z listy posortowanej od najnowszego. Aktywne przebiegi
/// zostają zawsze (i liczą się do limitów); najnowszy wpis też, żeby świeżo
/// utworzony katalog nie zniknął przed zarejestrowaniem zadania. Wiek nie chroni:
/// dawna ochrona 24 h pozwalała wynikom rosnąć bez granic.
fn entries_to_remove(
    entries_newest_first: &[CleanupEntry],
    keep: usize,
    max_bytes: u64,
    active: &HashSet<String>,
) -> Vec<PathBuf> {
    let mut kept = 0_usize;
    let mut bytes = 0_u64;
    let mut to_remove = Vec::new();
    for (index, entry) in entries_newest_first.iter().enumerate() {
        let fits = kept < keep && bytes.saturating_add(entry.size) <= max_bytes;
        if index == 0 || active.contains(&entry.name) || fits {
            kept += 1;
            bytes = bytes.saturating_add(entry.size);
        } else {
            to_remove.push(entry.path.clone());
        }
    }
    to_remove
}

fn keep_latest_entries(dir: &Path, keep: usize, max_bytes: u64, active: &HashSet<String>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut entries = entries
        .flatten()
        .filter_map(|entry| {
            let modified = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .ok()?;
            Some(CleanupEntry {
                name: entry.file_name().to_string_lossy().to_string(),
                size: entry_size(&entry.path()),
                path: entry.path(),
                modified,
            })
        })
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| Reverse(entry.modified));
    for path in entries_to_remove(&entries, keep, max_bytes, active) {
        if path.is_dir() {
            let _ = fs::remove_dir_all(path);
        } else {
            let _ = fs::remove_file(path);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn wpis(name: &str, age_rank: u64, size: u64) -> CleanupEntry {
        CleanupEntry {
            path: PathBuf::from(name),
            name: name.to_string(),
            modified: std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000 - age_rank),
            size,
        }
    }

    fn names(paths: Vec<PathBuf>) -> Vec<String> {
        paths.iter().map(|path| path.to_string_lossy().to_string()).collect()
    }

    #[test]
    fn fresh_runs_beyond_the_count_limit_are_removed_but_active_ones_survive() {
        // Wszystkie przebiegi sa swieze (nowsze niz 24 h), a i tak liczy sie limit.
        let entries: Vec<_> = (0..25).map(|i| wpis(&format!("run-{i}"), i, 10)).collect();
        let active = HashSet::from(["run-24".to_string()]);

        let removed = names(entries_to_remove(&entries, 20, u64::MAX, &active));

        // 20 najnowszych + aktywny (najstarszy); reszta za limitem odpada mimo swiezosci.
        assert_eq!(removed.len(), 4);
        assert!(!removed.contains(&"run-24".to_string()), "aktywny przebieg zostaje");
        assert!(!removed.contains(&"run-0".to_string()), "najnowszy zostaje");
        assert!(!removed.contains(&"run-19".to_string()));
        assert!(removed.contains(&"run-20".to_string()));
    }

    #[test]
    fn size_limit_removes_older_runs_even_when_count_is_small() {
        let entries = vec![wpis("nowy", 0, 60), wpis("starszy", 1, 60), wpis("najstarszy", 2, 10)];

        let removed = names(entries_to_remove(&entries, 20, 100, &HashSet::new()));

        assert_eq!(removed, vec!["starszy".to_string()]);
    }

    #[test]
    fn newest_entry_survives_even_when_alone_it_exceeds_the_size_limit() {
        let entries = vec![wpis("nowy", 0, 500), wpis("starszy", 1, 1)];

        let removed = names(entries_to_remove(&entries, 20, 100, &HashSet::new()));

        assert_eq!(removed, vec!["starszy".to_string()]);
    }

    #[test]
    fn active_run_survives_size_limit_and_counts_towards_it() {
        let entries = vec![wpis("nowy", 0, 30), wpis("aktywny", 1, 90), wpis("stary", 2, 10)];
        let active = HashSet::from(["aktywny".to_string()]);

        let removed = names(entries_to_remove(&entries, 20, 100, &active));

        assert_eq!(removed, vec!["stary".to_string()]);
    }

    #[test]
    fn keep_latest_entries_deletes_old_and_recent_directories_over_the_limit() {
        let dir = std::env::temp_dir().join(format!("ia-runs-{}", uuid::Uuid::new_v4()));
        for index in 0..5 {
            fs::create_dir_all(dir.join(format!("run-{index}"))).unwrap();
            fs::write(dir.join(format!("run-{index}")).join("result.json"), "{}").unwrap();
            // Rozdzielczosc czasu modyfikacji katalogu bywa gruba.
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
        let active = HashSet::from(["run-0".to_string()]);

        keep_latest_entries(&dir, 3, u64::MAX, &active);

        let mut left: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        left.sort();
        // Trzy najnowsze + aktywny (najstarszy); swiezy run-1 nie jest chroniony wiekiem.
        assert_eq!(left, ["run-0", "run-2", "run-3", "run-4"]);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn safe_relative_path_blocks_empty_absolute_and_parent_paths() {
        for path in [
            "",
            "   ",
            "../secret.txt",
            "..\\secret.txt",
            "C:\\secret.txt",
        ] {
            let error = safe_relative_path(path).unwrap_err();
            assert_eq!(error.error_code, "PATH_TRAVERSAL_BLOCKED", "{path}");
        }
    }

    #[test]
    fn safe_relative_path_accepts_nested_relative_storage_paths() {
        let path = safe_relative_path("broker/raport.json").unwrap();

        assert_eq!(path, PathBuf::from("broker/raport.json"));
    }

    #[test]
    fn ensure_existing_child_resolves_only_inside_base() {
        let base = std::env::temp_dir().join(format!(
            "invest-analyzer-path-test-{}",
            uuid::Uuid::new_v4()
        ));
        let nested = base.join("nested");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("file.json"), "{}").unwrap();

        let resolved = ensure_existing_child(&base, "nested/file.json").unwrap();

        assert!(resolved.starts_with(base.canonicalize().unwrap()));
        let _ = fs::remove_dir_all(base);
    }
}
