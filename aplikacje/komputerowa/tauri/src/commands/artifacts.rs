use crate::commands::app_paths::resolve_app_paths;
use crate::engine::errors::{DesktopError, DesktopResult};
use crate::security::path_guard::ensure_existing_child;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::AppHandle;

/// Plik wyniku przebiegu silnika (runs/<id>/...). Silnik oddaje sciezki bezwzgledne
/// do katalogu przebiegu - bez tej galezi otwarcie raportu i pakietu w desktopie
/// konczylo sie bledem. Sciezka po rozwiazaniu dowiazan musi byc plikiem wewnatrz
/// katalogu przebiegow.
pub(crate) fn artefakt_przebiegu(runs_dir: &Path, path: &str) -> Option<PathBuf> {
    let kandydat = Path::new(path.trim());
    if !kandydat.is_absolute() {
        return None;
    }
    let korzen = runs_dir.canonicalize().ok()?;
    let cel = kandydat.canonicalize().ok()?;
    (cel.starts_with(&korzen) && cel != korzen && cel.is_file()).then_some(cel)
}

#[tauri::command]
pub fn open_artifact(app: AppHandle, path: String) -> DesktopResult<()> {
    let app_paths = resolve_app_paths(&app)?;
    let artifacts_dir = PathBuf::from(app_paths.artifacts_dir);
    let storage_dir = PathBuf::from(app_paths.storage_dir);
    let runs_dir = PathBuf::from(app_paths.runs_dir);

    let target = if path == "__storage__" {
        storage_dir.canonicalize().map_err(|error| {
            DesktopError::io("STORAGE_NOT_FOUND", "Cannot open storage directory", error)
        })?
    } else if path.trim().is_empty() || path == "." || path == "__artifacts__" {
        artifacts_dir.canonicalize().map_err(|error| {
            DesktopError::io(
                "STORAGE_NOT_FOUND",
                "Cannot open artifacts directory",
                error,
            )
        })?
    } else if let Ok(target) = ensure_existing_child(&artifacts_dir, &path) {
        target
    } else if let Some(target) = artefakt_przebiegu(&runs_dir, &path) {
        target
    } else {
        ensure_existing_child(&storage_dir, &path)?
    };

    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(target)
            .spawn()
            .map_err(|error| {
                DesktopError::io("STORAGE_PERMISSION_DENIED", "Cannot open artifact", error)
            })?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        Command::new("xdg-open")
            .arg(target)
            .spawn()
            .map_err(|error| {
                DesktopError::io("STORAGE_PERMISSION_DENIED", "Cannot open artifact", error)
            })?;
    }
    Ok(())
}

#[cfg(test)]
mod testy {
    use super::artefakt_przebiegu;
    use std::fs;

    #[test]
    fn plik_przebiegu_otwiera_sie_a_sciezka_spoza_katalogu_przebiegow_nie() {
        let korzen = std::env::temp_dir().join(format!("ia-przebiegi-{}", std::process::id()));
        let _ = fs::remove_dir_all(&korzen);
        let przebieg = korzen.join("runs").join("job-1");
        fs::create_dir_all(&przebieg).unwrap();
        let raport = przebieg.join("tax_report.xlsx");
        fs::write(&raport, b"x").unwrap();
        let obcy = korzen.join("obcy.xlsx");
        fs::write(&obcy, b"x").unwrap();
        let runs = korzen.join("runs");

        assert!(artefakt_przebiegu(&runs, raport.to_str().unwrap()).is_some());
        assert!(artefakt_przebiegu(&runs, obcy.to_str().unwrap()).is_none(), "plik spoza runs");
        assert!(artefakt_przebiegu(&runs, "job-1/tax_report.xlsx").is_none(), "tylko sciezki bezwzgledne");
        let obejscie = format!("{}/../obcy.xlsx", przebieg.display());
        assert!(artefakt_przebiegu(&runs, &obejscie).is_none(), "wyjscie przez ..");
        assert!(artefakt_przebiegu(&runs, runs.to_str().unwrap()).is_none(), "sam katalog to nie plik");

        let _ = fs::remove_dir_all(&korzen);
    }
}
