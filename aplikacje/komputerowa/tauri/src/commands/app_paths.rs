use crate::engine::contract::REQUEST_CONTRACT_VERSION;
use crate::engine::errors::{DesktopError, DesktopResult};
use crate::security::path_guard::cleanup_runtime_dirs;
use crate::state::DesktopState;
use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub runtime: String,
    pub app_version: String,
    pub contract_version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPaths {
    pub data_dir: String,
    pub storage_dir: String,
    pub artifacts_dir: String,
    pub backups_dir: String,
    pub runs_dir: String,
    pub logs_dir: String,
    pub cache_dir: String,
    pub temp_dir: String,
}

fn ensure_dir(path: &PathBuf) -> DesktopResult<()> {
    fs::create_dir_all(path).map_err(|error| {
        DesktopError::io(
            "STORAGE_PERMISSION_DENIED",
            "Cannot create app directory",
            error,
        )
    })
}

pub fn resolve_app_paths(app: &AppHandle) -> DesktopResult<AppPaths> {
    let data_dir = app.path().app_data_dir().map_err(|error| {
        DesktopError::new(
            "STORAGE_NOT_FOUND",
            format!("Cannot resolve app data directory: {error}"),
            true,
        )
    })?;
    let local_data_dir = app.path().app_local_data_dir().map_err(|error| {
        DesktopError::new(
            "STORAGE_NOT_FOUND",
            format!("Cannot resolve local data directory: {error}"),
            true,
        )
    })?;

    let storage_dir = data_dir.join("storage");
    let artifacts_dir = data_dir.join("artifacts");
    // Kopie decyzji uzytkownika lezą obok danych, nie w katalogu tymczasowym:
    // maja przetrwac czyszczenie pamieci przegladarki i ponowna instalacje.
    let backups_dir = data_dir.join("backupy");
    let runs_dir = local_data_dir.join("runs");
    let logs_dir = local_data_dir.join("logs");
    let cache_dir = local_data_dir.join("cache");
    let temp_dir = local_data_dir.join("temp");

    for path in [
        &data_dir,
        &storage_dir,
        &artifacts_dir,
        &backups_dir,
        &runs_dir,
        &logs_dir,
        &cache_dir,
        &temp_dir,
    ] {
        ensure_dir(path)?;
    }
    // Katalogi aktywnych zadań silnika są nietykalne dla czyszczenia.
    let active_runs = app
        .try_state::<DesktopState>()
        .map(|state| state.aktywne_zadania())
        .unwrap_or_default();
    cleanup_runtime_dirs(&runs_dir, &logs_dir, &temp_dir, &active_runs);

    Ok(AppPaths {
        data_dir: data_dir.to_string_lossy().to_string(),
        storage_dir: storage_dir.to_string_lossy().to_string(),
        artifacts_dir: artifacts_dir.to_string_lossy().to_string(),
        backups_dir: backups_dir.to_string_lossy().to_string(),
        runs_dir: runs_dir.to_string_lossy().to_string(),
        logs_dir: logs_dir.to_string_lossy().to_string(),
        cache_dir: cache_dir.to_string_lossy().to_string(),
        temp_dir: temp_dir.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub fn get_runtime_info(app: AppHandle) -> RuntimeInfo {
    RuntimeInfo {
        runtime: "tauri".to_string(),
        app_version: app.package_info().version.to_string(),
        contract_version: REQUEST_CONTRACT_VERSION.to_string(),
    }
}

#[tauri::command]
pub fn get_app_paths(app: AppHandle) -> DesktopResult<AppPaths> {
    resolve_app_paths(&app)
}
