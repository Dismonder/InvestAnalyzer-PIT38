use crate::commands::app_paths::{resolve_app_paths, AppPaths};
use crate::engine::errors::{DesktopError, DesktopResult};
use crate::state::DesktopState;
use serde::Serialize;
use std::fs;
use std::path::Path;
use tauri::{AppHandle, State};

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearAppDataResult {
    pub removed_files: u64,
    pub removed_dirs: u64,
    pub cleared_roots: Vec<String>,
    pub warnings: Vec<String>,
}

#[tauri::command]
pub fn clear_app_data(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> DesktopResult<ClearAppDataResult> {
    let paths = resolve_app_paths(&app)?;
    clear_app_data_in(&paths, &state)
}

/// Czyszczenie danych odmawia, gdy silnik ma zadania w toku (queued/running): zadanie w
/// tle pisze do katalogu przebiegu, wiec usuniecie go spod nog dawaloby bledy zapisu
/// albo pol-usuniety przebieg. Zadania nie sa anulowane po cichu - anulowanie jest
/// asynchroniczne (kill dziecka, watek konczy zapis pozniej), wiec i tak trzeba by czekac;
/// uzytkownik decyduje: poczekac albo anulowac przeliczenie.
fn clear_app_data_in(paths: &AppPaths, state: &DesktopState) -> DesktopResult<ClearAppDataResult> {
    let _cykl_zycia = state.zablokuj_cykl_zycia();
    if !state.aktywne_zadania().is_empty() {
        return Err(DesktopError::new(
            "ENGINE_JOB_RUNNING",
            "Trwa przeliczanie — poczekaj na koniec albo je anuluj.",
            true,
        ));
    }
    let mut result = ClearAppDataResult::default();

    for root in [
        paths.storage_dir.as_str(),
        paths.artifacts_dir.as_str(),
        paths.runs_dir.as_str(),
        paths.logs_dir.as_str(),
        paths.cache_dir.as_str(),
        paths.temp_dir.as_str(),
    ] {
        clear_directory_contents(Path::new(root), &mut result)?;
        result.cleared_roots.push(root.to_string());
    }

    for filename in ["migration_manifest.json", "ollama_config.json"] {
        remove_known_file(
            Path::new(&paths.data_dir).join(filename).as_path(),
            &mut result,
        );
    }

    Ok(result)
}

pub fn clear_directory_contents(dir: &Path, result: &mut ClearAppDataResult) -> DesktopResult<()> {
    fs::create_dir_all(dir).map_err(|error| {
        DesktopError::io(
            "STORAGE_PERMISSION_DENIED",
            "Cannot create data directory",
            error,
        )
    })?;
    let entries = fs::read_dir(dir).map_err(|error| {
        DesktopError::io(
            "STORAGE_PERMISSION_DENIED",
            "Cannot read data directory",
            error,
        )
    })?;

    for entry in entries {
        let Ok(entry) = entry else {
            result
                .warnings
                .push("Nie udało się odczytać jednego wpisu podczas czyszczenia.".to_string());
            continue;
        };
        let path = entry.path();
        if path.file_name().and_then(|value| value.to_str()) == Some(".gitkeep") {
            continue;
        }
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            result.warnings.push(format!(
                "Nie udało się odczytać metadanych: {}",
                path.display()
            ));
            continue;
        };
        if metadata.is_dir() {
            match fs::remove_dir_all(&path) {
                Ok(()) => result.removed_dirs += 1,
                Err(error) => result.warnings.push(format!(
                    "Nie udało się usunąć katalogu {}: {error}",
                    path.display()
                )),
            }
        } else {
            match fs::remove_file(&path) {
                Ok(()) => result.removed_files += 1,
                Err(error) => result.warnings.push(format!(
                    "Nie udało się usunąć pliku {}: {error}",
                    path.display()
                )),
            }
        }
    }
    Ok(())
}

fn remove_known_file(path: &Path, result: &mut ClearAppDataResult) {
    if !path.exists() {
        return;
    }
    match fs::remove_file(path) {
        Ok(()) => result.removed_files += 1,
        Err(error) => result.warnings.push(format!(
            "Nie udało się usunąć pliku {}: {error}",
            path.display()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::contract::queued_status;
    use crate::state::JobRecord;
    use std::fs;

    #[test]
    fn clear_directory_contents_removes_files_and_dirs_but_keeps_gitkeep() {
        let root = std::env::temp_dir().join(format!("invest-reset-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::write(root.join(".gitkeep"), "").unwrap();
        fs::write(root.join("file.json"), "{}").unwrap();
        fs::write(root.join("nested").join("file.csv"), "a,b").unwrap();

        let mut result = ClearAppDataResult::default();
        clear_directory_contents(&root, &mut result).unwrap();

        assert!(root.join(".gitkeep").exists());
        assert!(!root.join("file.json").exists());
        assert!(!root.join("nested").exists());
        assert_eq!(result.removed_files, 1);
        assert_eq!(result.removed_dirs, 1);
        let _ = fs::remove_dir_all(root);
    }

    fn sciezki_testowe(root: &Path) -> AppPaths {
        let podkatalog = |nazwa: &str| {
            let sciezka = root.join(nazwa);
            fs::create_dir_all(&sciezka).unwrap();
            sciezka.to_string_lossy().to_string()
        };
        AppPaths {
            data_dir: podkatalog("data"),
            storage_dir: podkatalog("storage"),
            artifacts_dir: podkatalog("artifacts"),
            backups_dir: podkatalog("backupy"),
            runs_dir: podkatalog("runs"),
            logs_dir: podkatalog("logs"),
            cache_dir: podkatalog("cache"),
            temp_dir: podkatalog("temp"),
        }
    }

    fn stan_z_zadaniem(job_id: &str, stan: &str) -> DesktopState {
        let mut status = queued_status(job_id);
        status.state = stan.to_string();
        let stan_aplikacji = DesktopState::default();
        stan_aplikacji.jobs.lock().unwrap().insert(
            job_id.to_string(),
            JobRecord {
                status,
                result: None,
                error: None,
                child: None,
            },
        );
        stan_aplikacji
    }

    #[test]
    fn czyszczenie_odmawia_gdy_trwa_zadanie_silnika_i_nie_rusza_katalogu_przebiegu() {
        for stan in ["queued", "running"] {
            let root = std::env::temp_dir().join(format!("invest-reset-job-{}", uuid::Uuid::new_v4()));
            let paths = sciezki_testowe(&root);
            let katalog_przebiegu = Path::new(&paths.runs_dir).join("job-1");
            fs::create_dir_all(&katalog_przebiegu).unwrap();
            fs::write(katalog_przebiegu.join("request.json"), "{}").unwrap();
            fs::write(Path::new(&paths.storage_dir).join("a.json"), "{}").unwrap();

            let blad = clear_app_data_in(&paths, &stan_z_zadaniem("job-1", stan))
                .err()
                .expect("czyszczenie ma odmowic przy aktywnym zadaniu");

            assert_eq!(blad.error_code, "ENGINE_JOB_RUNNING");
            assert_eq!(blad.message, "Trwa przeliczanie — poczekaj na koniec albo je anuluj.");
            assert!(katalog_przebiegu.join("request.json").exists(), "stan {stan}");
            assert!(Path::new(&paths.storage_dir).join("a.json").exists(), "stan {stan}");
            let _ = fs::remove_dir_all(root);
        }
    }

    #[test]
    fn czyszczenie_dziala_gdy_zadania_sa_zakonczone() {
        let root = std::env::temp_dir().join(format!("invest-reset-done-{}", uuid::Uuid::new_v4()));
        let paths = sciezki_testowe(&root);
        let katalog_przebiegu = Path::new(&paths.runs_dir).join("job-2");
        fs::create_dir_all(&katalog_przebiegu).unwrap();

        let wynik = clear_app_data_in(&paths, &stan_z_zadaniem("job-2", "done"))
            .expect("zakonczone zadanie nie blokuje czyszczenia");

        assert_eq!(wynik.removed_dirs, 1);
        assert!(!katalog_przebiegu.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn czyszczenie_czeka_na_rejestracje_rozpoczynanego_zadania() {
        use std::sync::{mpsc, Arc};
        use std::time::Duration;

        let root = std::env::temp_dir().join(format!("invest-reset-race-{}", uuid::Uuid::new_v4()));
        let paths = sciezki_testowe(&root);
        let storage_file = Path::new(&paths.storage_dir).join("wejscie.json");
        fs::write(&storage_file, "synthetic").unwrap();
        let state = Arc::new(DesktopState::default());

        // Symuluje start, który przygotowuje run_dir/request przed dodaniem statusu do mapy.
        let blokada_startu = state.zablokuj_cykl_zycia();
        let (gotowy_tx, gotowy_rx) = mpsc::channel();
        let (wynik_tx, wynik_rx) = mpsc::channel();
        let state_czyszczenia = state.clone();
        let paths_czyszczenia = paths.clone();
        let czyszczenie = std::thread::spawn(move || {
            gotowy_tx.send(()).unwrap();
            wynik_tx
                .send(clear_app_data_in(&paths_czyszczenia, &state_czyszczenia))
                .unwrap();
        });

        gotowy_rx.recv().unwrap();
        assert!(
            wynik_rx.recv_timeout(Duration::from_millis(200)).is_err(),
            "czyszczenie nie czeka na sekcje przygotowujaca start"
        );

        let mut status = queued_status("job-w-trakcie-startu");
        status.state = "queued".to_string();
        state.jobs.lock().unwrap().insert(
            "job-w-trakcie-startu".to_string(),
            JobRecord { status, result: None, error: None, child: None },
        );
        drop(blokada_startu);

        let blad = wynik_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("czyszczenie powinno ruszyc po zwolnieniu blokady")
            .expect_err("zadanie zarejestrowane w trakcie startu blokuje czyszczenie");
        assert_eq!(blad.error_code, "ENGINE_JOB_RUNNING");
        assert!(storage_file.exists(), "magazyn wejściowy pozostaje nienaruszony");
        czyszczenie.join().unwrap();
        let _ = fs::remove_dir_all(root);
    }
}
