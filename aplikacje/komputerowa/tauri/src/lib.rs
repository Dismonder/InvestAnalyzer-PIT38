mod commands;
mod engine;
mod security;
mod state;

use state::DesktopState;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .manage(DesktopState::default())
        .invoke_handler(tauri::generate_handler![
            commands::app_paths::get_runtime_info,
            commands::app_paths::get_app_paths,
            commands::ai::get_ollama_status,
            commands::ai::test_ollama_gpu,
            commands::ai::ensure_ollama_running,
            commands::ai::stop_ollama,
            commands::ai::list_ollama_models,
            commands::ai::set_ollama_config,
            commands::storage::list_storage_files,
            commands::storage::read_storage_file,
            commands::storage::import_files_to_storage,
            commands::storage_migration::detect_legacy_storage,
            commands::storage_migration::copy_legacy_storage_to_appdata,
            commands::storage_migration::get_storage_migration_status,
            commands::freedom24::freedom24_status,
            commands::freedom24::freedom24_auth_check,
            commands::freedom24::freedom24_portfolio,
            commands::freedom24::freedom24_full_export,
            commands::engine_jobs::start_tax_engine_job,
            commands::engine_jobs::get_tax_engine_job_status,
            commands::engine_jobs::get_tax_engine_job_result,
            commands::engine_jobs::cancel_tax_engine_job,
            commands::artifacts::open_artifact,
            commands::diagnostics::export_diagnostics_bundle,
            commands::backups::write_backup_snapshot,
            commands::backups::list_backup_snapshots,
            commands::backups::read_backup_snapshot,
            commands::reset::clear_app_data
        ])
        .run(tauri::generate_context!())
        .expect("error while running InvestAnalyzer desktop runtime");
}
