use crate::commands::ai::ollama_engine_environment;
use crate::commands::app_paths::resolve_app_paths;
use crate::commands::diagnostics::mask_error_message;
use crate::commands::storage::list_storage_files;
use crate::engine::contract::{
    now, queued_status, validate_contract_version, JobIdResponse, SidecarError, TaxEngineJobStatus,
    CONTRACT_VERSION, PIT8C_ENTRIES_PATH_FIELD, REQUEST_CONTRACT_VERSION,
};
use crate::engine::errors::{DesktopError, DesktopResult};
use crate::engine::manifest::{read_manifest, write_manifest, RunManifest};
use crate::engine::sidecar_runner::resolve_sidecar_exe;
use crate::state::{DesktopState, JobRecord};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};
use uuid::Uuid;

const ENGINE_TIMEOUT_SECONDS: u64 = 600;

#[tauri::command]
pub fn start_tax_engine_job(
    app: AppHandle,
    state: State<'_, DesktopState>,
    request: Value,
) -> DesktopResult<JobIdResponse> {
    // Czyszczenie danych nie moze wejsc pomiedzy przygotowanie run_dir/request a
    // rejestracje zadania jako queued.
    let cykl_zycia = state.zablokuj_cykl_zycia();
    let sidecar_exe = resolve_sidecar_exe(&app)?;
    let paths = resolve_app_paths(&app)?;
    let run_id = Uuid::new_v4().to_string();
    let run_dir = PathBuf::from(&paths.runs_dir).join(&run_id);
    fs::create_dir_all(&run_dir).map_err(|error| {
        DesktopError::io(
            "STORAGE_PERMISSION_DENIED",
            "Cannot create run directory",
            error,
        )
    })?;

    let request_path = write_sidecar_request(&run_dir, &paths.storage_dir, &request, &run_id)?;
    let input_files = list_storage_files(app.clone()).unwrap_or_default();
    // Manifest opisuje ten sam przebieg co zadanie wyslane do silnika, wiec rok
    // musi byc ten sam. `unwrap_or(0)` zapisywal rok 0 obok wyniku liczonego
    // za inny rok. Zadanie bez roku nie przechodzi juz przez
    // write_sidecar_request, wiec tutaj brak roku znaczy blad w kodzie.
    let year = request.get("year").and_then(Value::as_i64).ok_or_else(|| {
        DesktopError::new(
            "REQUEST_YEAR_MISSING",
            "Zadanie do silnika nie zawiera roku podatkowego.",
            false,
        )
    })?;
    let source_selection_mode = request
        .get("sourceSelectionMode")
        .and_then(Value::as_str)
        .unwrap_or("canonical_stream")
        .to_string();
    let started_at = now();
    write_manifest(
        &run_dir,
        &RunManifest {
            run_id: run_id.clone(),
            app_version: app.package_info().version.to_string(),
            engine_version: None,
            contract_version: REQUEST_CONTRACT_VERSION.to_string(),
            year,
            source_selection_mode,
            started_at: started_at.clone(),
            finished_at: None,
            duration_ms: None,
            input_files,
            audit_hash: None,
            status: "running".to_string(),
        },
    );

    let child_slot: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
    let status = queued_status(&run_id);
    {
        let mut jobs = state.jobs.lock().map_err(|_| {
            DesktopError::new(
                "UNKNOWN_ENGINE_ERROR",
                "Cannot lock desktop job state.",
                true,
            )
        })?;
        prune_finished_jobs(&mut jobs, chrono::Utc::now());
        jobs.insert(
            run_id.clone(),
            JobRecord {
                status,
                result: None,
                error: None,
                child: Some(child_slot.clone()),
            },
        );
    }
    drop(cykl_zycia);

    let jobs = state.jobs.clone();
    let app_version = app.package_info().version.to_string();
    let mut ollama_env = ollama_engine_environment(&app);
    let ai_gpu_required = true;
    let ai_allow_cpu = false;
    let ai_compute_backend = request
        .get("aiNormalizerComputeBackend")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let ai_gpu_confirmed = request
        .get("aiNormalizerGpuConfirmed")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        && ai_compute_backend == "gpu";
    ollama_env.push((
        "INVEST_OLLAMA_GPU_REQUIRED".to_string(),
        ai_gpu_required.to_string(),
    ));
    ollama_env.push((
        "INVEST_OLLAMA_GPU_CONFIRMED".to_string(),
        ai_gpu_confirmed.to_string(),
    ));
    ollama_env.push((
        "INVEST_OLLAMA_ALLOW_CPU_AI".to_string(),
        ai_allow_cpu.to_string(),
    ));
    ollama_env.push((
        "INVEST_OLLAMA_COMPUTE_BACKEND".to_string(),
        ai_compute_backend,
    ));
    let run_id_for_thread = run_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_sidecar_job(
            jobs,
            run_id_for_thread,
            app_version,
            sidecar_exe,
            run_dir,
            request_path,
            ollama_env,
            child_slot,
            started_at,
        );
    });

    Ok(JobIdResponse { job_id: run_id })
}

#[tauri::command]
pub fn get_tax_engine_job_status(
    state: State<'_, DesktopState>,
    job_id: String,
) -> DesktopResult<TaxEngineJobStatus> {
    let jobs = state.jobs.lock().map_err(|_| {
        DesktopError::new(
            "UNKNOWN_ENGINE_ERROR",
            "Cannot lock desktop job state.",
            true,
        )
    })?;
    let record = jobs.get(&job_id).ok_or_else(|| {
        DesktopError::new(
            "UNKNOWN_ENGINE_ERROR",
            format!("Unknown tax engine job: {job_id}"),
            true,
        )
    })?;
    Ok(record.status.clone())
}

/// Wynik oddajemy raz (`take`): result.json ma ok. 100 MB, a klon przy każdym
/// odczycie trzymałby go w pamięci aż do końca sesji. Interfejs czyta wynik
/// jednego zadania dokładnie raz (useTaxEngineRun, engineBridge, ImportData).
fn take_job_result(record: &mut JobRecord) -> DesktopResult<Value> {
    if record.status.state == "failed" {
        return Err(DesktopError::new(
            record
                .status
                .error_code
                .clone()
                .unwrap_or_else(|| "UNKNOWN_ENGINE_ERROR".to_string()),
            record.status.message.clone(),
            true,
        ));
    }
    if let Some(result) = record.result.take() {
        return Ok(result);
    }
    if record.status.state == "done" {
        return Err(DesktopError::new(
            "ENGINE_RESULT_ALREADY_TAKEN",
            "Wynik tego przebiegu silnika został już odebrany i zwolniony z pamięci. Uruchom przeliczenie ponownie.",
            false,
        ));
    }
    Err(DesktopError::new(
        "UNKNOWN_ENGINE_ERROR",
        "Tax engine result is not ready.",
        true,
    ))
}

#[tauri::command]
pub fn get_tax_engine_job_result(
    state: State<'_, DesktopState>,
    job_id: String,
) -> DesktopResult<Value> {
    let mut jobs = state.jobs.lock().map_err(|_| {
        DesktopError::new(
            "UNKNOWN_ENGINE_ERROR",
            "Cannot lock desktop job state.",
            true,
        )
    })?;
    let record = jobs.get_mut(&job_id).ok_or_else(|| {
        DesktopError::new(
            "UNKNOWN_ENGINE_ERROR",
            format!("Unknown tax engine job: {job_id}"),
            true,
        )
    })?;
    take_job_result(record)
}

/// Ile zakończonych zadań zostaje w rejestrze (status; wynik tylko do odebrania).
const MAX_FINISHED_JOBS: usize = 10;
/// Po ilu minutach zakończone zadanie znika z rejestru.
const FINISHED_JOB_RETENTION_MINUTES: i64 = 60;

fn is_finished_state(state: &str) -> bool {
    matches!(state, "done" | "failed" | "cancelled")
}

/// Usuwa z rejestru zakończone zadania starsze niż `FINISHED_JOB_RETENTION_MINUTES`
/// oraz najstarsze ponad `MAX_FINISHED_JOBS`; zadania w toku zostają.
fn prune_finished_jobs(
    jobs: &mut std::collections::HashMap<String, JobRecord>,
    at: chrono::DateTime<chrono::Utc>,
) {
    let mut finished: Vec<(String, Option<chrono::DateTime<chrono::Utc>>)> = jobs
        .iter()
        .filter(|(_, record)| is_finished_state(&record.status.state))
        .map(|(id, record)| {
            let updated = chrono::DateTime::parse_from_rfc3339(&record.status.updated_at)
                .ok()
                .map(|value| value.with_timezone(&chrono::Utc));
            (id.clone(), updated)
        })
        .collect();
    finished.sort_by_key(|(_, updated)| std::cmp::Reverse(*updated));
    for (index, (id, updated)) in finished.into_iter().enumerate() {
        let expired = updated.map_or(true, |value| {
            at - value > chrono::Duration::minutes(FINISHED_JOB_RETENTION_MINUTES)
        });
        if index >= MAX_FINISHED_JOBS || expired {
            jobs.remove(&id);
        }
    }
}
#[tauri::command]
pub fn cancel_tax_engine_job(state: State<'_, DesktopState>, job_id: String) -> DesktopResult<()> {
    let mut jobs = state.jobs.lock().map_err(|_| {
        DesktopError::new(
            "UNKNOWN_ENGINE_ERROR",
            "Cannot lock desktop job state.",
            true,
        )
    })?;
    let record = jobs.get_mut(&job_id).ok_or_else(|| {
        DesktopError::new(
            "UNKNOWN_ENGINE_ERROR",
            format!("Unknown tax engine job: {job_id}"),
            true,
        )
    })?;
    if let Some(child_slot) = &record.child {
        if let Ok(mut guard) = child_slot.lock() {
            if let Some(child) = guard.as_mut() {
                let _ = child.kill();
            }
        }
    }
    mark_cancelled(record);
    Ok(())
}

fn mark_cancelled(record: &mut JobRecord) {
    record.status.state = "cancelled".to_string();
    record.status.stage = "cancelled".to_string();
    record.status.progress = 0;
    record.status.message = "Tax engine job was cancelled.".to_string();
    record.status.updated_at = now();
}

fn run_sidecar_job(
    jobs: Arc<Mutex<std::collections::HashMap<String, JobRecord>>>,
    run_id: String,
    app_version: String,
    sidecar_exe: PathBuf,
    run_dir: PathBuf,
    request_path: PathBuf,
    ollama_env: Vec<(String, String)>,
    child_slot: Arc<Mutex<Option<Child>>>,
    started_at: String,
) {
    if is_cancelled(&jobs, &run_id) {
        return;
    }
    update_status(
        &jobs,
        &run_id,
        "running",
        "preflight",
        5,
        "Starting local Python tax engine.",
        None,
    );
    let stdout = fs::File::create(run_dir.join("stdout.log")).ok();
    let stderr = fs::File::create(run_dir.join("stderr.log")).ok();
    let mut command = Command::new(sidecar_exe);
    command
        .arg("--request")
        .arg(&request_path)
        .current_dir(&run_dir)
        .envs(ollama_env)
        .stdout(stdout.map(Stdio::from).unwrap_or_else(Stdio::null))
        .stderr(stderr.map(Stdio::from).unwrap_or_else(Stdio::null));

    if is_cancelled(&jobs, &run_id) {
        return;
    }
    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            fail_job(
                &jobs,
                &run_id,
                "ENGINE_CRASHED",
                format!("Cannot start engine sidecar: {error}"),
            );
            return;
        }
    };
    if let Ok(mut guard) = child_slot.lock() {
        *guard = Some(child);
    }
    if is_cancelled(&jobs, &run_id) {
        if let Ok(mut guard) = child_slot.lock() {
            if let Some(child) = guard.as_mut() {
                let _ = child.kill();
            }
        }
        return;
    }

    let started = Instant::now();
    loop {
        std::thread::sleep(Duration::from_millis(300));
        if started.elapsed() > Duration::from_secs(ENGINE_TIMEOUT_SECONDS) {
            if let Ok(mut guard) = child_slot.lock() {
                if let Some(child) = guard.as_mut() {
                    let _ = child.kill();
                }
            }
            fail_job(
                &jobs,
                &run_id,
                "ENGINE_TIMEOUT",
                "Tax engine sidecar timed out after 10 minutes.",
            );
            write_runtime_error(
                &run_dir,
                &run_id,
                "ENGINE_TIMEOUT",
                "Tax engine sidecar timed out after 10 minutes.",
            );
            return;
        }

        let wait_result = {
            let Ok(mut guard) = child_slot.lock() else {
                fail_job(
                    &jobs,
                    &run_id,
                    "UNKNOWN_ENGINE_ERROR",
                    "Cannot lock sidecar process.",
                );
                return;
            };
            let Some(child) = guard.as_mut() else {
                if is_cancelled(&jobs, &run_id) {
                    return;
                }
                continue;
            };
            child.try_wait()
        };

        match wait_result {
            Ok(Some(status)) => {
                if is_cancelled(&jobs, &run_id) {
                    return;
                }
                finalize_sidecar_job(
                    &jobs,
                    &run_id,
                    &run_dir,
                    &app_version,
                    &started_at,
                    status.code(),
                );
                return;
            }
            Ok(None) => {
                update_status(
                    &jobs,
                    &run_id,
                    "running",
                    "source_parse",
                    35,
                    "Tax engine is processing local storage.",
                    None,
                );
            }
            Err(error) => {
                fail_job(
                    &jobs,
                    &run_id,
                    "ENGINE_CRASHED",
                    format!("Cannot wait for engine sidecar: {error}"),
                );
                return;
            }
        }
    }
}

fn finalize_sidecar_job(
    jobs: &Arc<Mutex<std::collections::HashMap<String, JobRecord>>>,
    run_id: &str,
    run_dir: &Path,
    app_version: &str,
    started_at: &str,
    exit_code: Option<i32>,
) {
    let result_path = run_dir.join("result.json");
    let error_path = run_dir.join("error.json");
    if result_path.exists() {
        match fs::read_to_string(&result_path)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        {
            Some(result) => {
                if let Err(error) = validate_contract_version(&result, "Engine result.json") {
                    fail_job(jobs, run_id, &error.error_code, error.message);
                    return;
                }
                let previous_manifest = read_manifest(run_dir);
                let audit_hash = result
                    .get("audit_hash")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let engine_version = result
                    .get("engine_version")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                // Rok 0 w manifescie wyglada jak zapisany rok podatkowy.
                // `unwrap_or_default()` wstawialo go, gdy silnik nie podal roku.
                let Some(year) = result
                    .get("tax_filing_package")
                    .and_then(|value| value.get("draft"))
                    .and_then(|value| value.get("tax_year"))
                    .and_then(Value::as_i64)
                    .or_else(|| previous_manifest.as_ref().map(|manifest| manifest.year))
                else {
                    fail_job(
                        jobs,
                        run_id,
                        "ENGINE_RESULT_YEAR_MISSING",
                        "Wynik silnika nie zawiera roku podatkowego (tax_filing_package.draft.tax_year).".to_string(),
                    );
                    return;
                };
                let source_selection_mode = previous_manifest
                    .as_ref()
                    .map(|manifest| manifest.source_selection_mode.clone())
                    .unwrap_or_else(|| "canonical_stream".to_string());
                let input_files = previous_manifest
                    .as_ref()
                    .map(|manifest| manifest.input_files.clone())
                    .unwrap_or_default();
                write_manifest(
                    run_dir,
                    &RunManifest {
                        run_id: run_id.to_string(),
                        app_version: app_version.to_string(),
                        engine_version,
                        contract_version: REQUEST_CONTRACT_VERSION.to_string(),
                        year,
                        source_selection_mode,
                        started_at: started_at.to_string(),
                        finished_at: Some(now()),
                        duration_ms: None,
                        input_files,
                        audit_hash,
                        status: "ok".to_string(),
                    },
                );
                if let Ok(mut map) = jobs.lock() {
                    if let Some(record) = map.get_mut(run_id) {
                        record.result = Some(result);
                        record.status.state = "done".to_string();
                        record.status.stage = "done".to_string();
                        record.status.progress = 100;
                        record.status.message = "Tax engine job completed.".to_string();
                        record.status.updated_at = now();
                    }
                    prune_finished_jobs(&mut map, chrono::Utc::now());
                }
                return;
            }
            None => {
                fail_job(
                    jobs,
                    run_id,
                    "ENGINE_INVALID_JSON",
                    "Engine result.json is not valid JSON.",
                );
                return;
            }
        }
    }

    if error_path.exists() {
        let parsed_error_text = fs::read_to_string(&error_path).ok();
        let parsed_error_value = parsed_error_text
            .as_deref()
            .and_then(|text| serde_json::from_str::<Value>(text).ok());
        if let Some(value) = &parsed_error_value {
            if let Err(error) = validate_contract_version(value, "Engine error.json") {
                fail_job(jobs, run_id, &error.error_code, error.message);
                return;
            }
        }
        let parsed_error =
            parsed_error_text.and_then(|text| serde_json::from_str::<SidecarError>(&text).ok());
        let (error_code, message, error) = match parsed_error {
            Some(error) => {
                let error_code = error.error_code.clone();
                // str(exc) z silnika bywa sciezka z nazwa uzytkownika albo nazwa wyciagu;
                // traceback zostaje tylko w error.json na dysku.
                let message = mask_error_message(&error.message);
                let mut value = serde_json::to_value(error).unwrap_or_else(|_| {
                    json!({ "error_code": "ENGINE_INVALID_JSON", "message": "Engine error.json is not valid JSON." })
                });
                value["message"] = json!(message);
                if let Some(details) = value.get_mut("details").and_then(Value::as_object_mut) {
                    details.remove("traceback");
                }
                (error_code, message, value)
            }
            None => (
                "ENGINE_INVALID_JSON".to_string(),
                "Engine error.json is not valid JSON.".to_string(),
                json!({ "error_code": "ENGINE_INVALID_JSON", "message": "Engine error.json is not valid JSON." }),
            ),
        };
        if let Ok(mut map) = jobs.lock() {
            if let Some(record) = map.get_mut(run_id) {
                record.error = Some(error);
                record.status.state = "failed".to_string();
                record.status.stage = "failed".to_string();
                record.status.progress = 100;
                record.status.message = message;
                record.status.error_code = Some(error_code);
                record.status.updated_at = now();
            }
        }
        return;
    }

    // Pelny stderr (traceback z sciezkami uzytkownika, nazwami wyciagow) zostaje w
    // stderr.log katalogu przebiegu; do interfejsu idzie tylko kod wyjscia i wskazowka,
    // gdzie szukac (jak w wersji web).
    let kod = exit_code.map_or_else(|| "brak".to_string(), |kod| kod.to_string());
    fail_job(
        jobs,
        run_id,
        "ENGINE_CRASHED",
        format!("Silnik zakończył się błędem (kod {kod}). Szczegóły w pliku stderr.log przebiegu {run_id}."),
    );
}

fn write_sidecar_request(
    run_dir: &Path,
    storage_dir: &str,
    frontend_request: &Value,
    run_id: &str,
) -> DesktopResult<PathBuf> {
    let overrides_dir = run_dir.join("overrides");
    fs::create_dir_all(&overrides_dir).map_err(|error| {
        DesktopError::io(
            "STORAGE_PERMISSION_DENIED",
            "Cannot create overrides directory",
            error,
        )
    })?;
    let transaction_overrides_path = write_optional_array(
        &overrides_dir,
        "transaction_overrides.json",
        frontend_request.get("transactionOverrides"),
    )?;
    let pit8c_path = write_optional_array(
        &overrides_dir,
        "pit8c_entries.json",
        frontend_request.get("pit8cEntries"),
    )?;
    let defense_overrides_path = write_optional_array(
        &overrides_dir,
        "defense_evidence_overrides.json",
        frontend_request.get("defenseEvidenceOverrides"),
    )?;
    let broker_action_overrides_path = write_optional_array(
        &overrides_dir,
        "broker_file_action_overrides.json",
        frontend_request.get("brokerFileActionOverrides"),
    )?;
    // Decyzje uzytkownika o zdarzeniach czekajacych na rozstrzygniecie - ta sama
    // droga co w wersji webowej, inaczej panel decyzji w desktopie bylby atrapa.
    let review_decisions_path = write_optional_array(
        &overrides_dir,
        "review_decisions.json",
        frontend_request.get("reviewDecisions"),
    )?;
    // Rok podatkowy nie ma wartosci zastepczej. `unwrap_or(2025)` znaczylo, ze
    // zadanie bez roku bylo po cichu liczone za 2025 - a manifest tego samego
    // przebiegu zapisywal rok 0 (nizej), wiec metadane przeczyly wynikowi.
    let year = frontend_request
        .get("year")
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            DesktopError::new(
                "REQUEST_YEAR_MISSING",
                "Zadanie do silnika nie zawiera roku podatkowego. Rok wyznacza kursy NBP \
                 i cala deklaracje, wiec nie zostanie podstawiony.",
                false,
            )
        })?;
    // Plan podatkowy tez wybiera uzytkownik. Ciche "aggressive_user" wybieralo
    // za niego wariant o najwiekszym ryzyku sporu z urzedem.
    let tax_plan = frontend_request
        .get("taxPlan")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            DesktopError::new(
                "REQUEST_TAX_PLAN_MISSING",
                "Zadanie do silnika nie zawiera wybranego planu podatkowego.",
                false,
            )
        })?;

    let mut request = json!({
        "contract_version": REQUEST_CONTRACT_VERSION,
        "run_id": run_id,
        "year": year,
        "run_mode": frontend_request.get("runMode").and_then(Value::as_str).unwrap_or("SAFE"),
        "tax_plan": tax_plan,
        "package_scope": frontend_request.get("packageScope").and_then(Value::as_str).unwrap_or(""),
        "filing_mode": frontend_request.get("filingMode").and_then(Value::as_str).unwrap_or("ORIGINAL"),
        "source_selection_mode": frontend_request.get("sourceSelectionMode").and_then(Value::as_str).unwrap_or("canonical_stream"),
        "selected_candidate_source_id": frontend_request.get("selectedCandidateSourceId").and_then(Value::as_str),
        "storage_dir": storage_dir,
        "out_dir": run_dir.to_string_lossy(),
        "nbp_dir": storage_dir,
        "overrides": {
            "transaction_overrides_path": transaction_overrides_path,
            "defense_evidence_overrides_path": defense_overrides_path,
            "broker_file_action_overrides_path": broker_action_overrides_path,
            "review_decisions_path": review_decisions_path
        },
        "flags": {
            "include_diagnostics": true,
            "strict_mode": true,
            "include_fx_conversion_costs": frontend_request.get("includeFxConversionCosts").and_then(Value::as_bool).unwrap_or(true),
            "include_bank_funding_fees": frontend_request.get("includeBankFundingFees").and_then(Value::as_bool).unwrap_or(true),
            "include_interest_costs": frontend_request.get("includeInterestCosts").and_then(Value::as_bool).unwrap_or(true),
            "include_account_fees": frontend_request.get("includeAccountFees").and_then(Value::as_bool).unwrap_or(true),
            "ai_normalizer_enabled": frontend_request.get("aiNormalizerEnabled").and_then(Value::as_bool).unwrap_or(false),
            "ai_normalizer_gpu_required": true,
            "ai_normalizer_gpu_confirmed": frontend_request.get("aiNormalizerGpuConfirmed").and_then(Value::as_bool).unwrap_or(false)
                && frontend_request.get("aiNormalizerComputeBackend").and_then(Value::as_str).unwrap_or("unknown") == "gpu",
            "ai_normalizer_compute_backend": frontend_request.get("aiNormalizerComputeBackend").and_then(Value::as_str).unwrap_or("unknown"),
            "canonical_tax_input_mode": frontend_request.get("canonicalTaxInputMode").and_then(Value::as_str).unwrap_or("required"),
            "nbp_allow_manual_override": frontend_request.get("nbpAllowManualOverride").and_then(Value::as_bool).unwrap_or(false),
            "allow_cpu_ai": false
        },
        "funding_fees": frontend_request.get("fundingFees").cloned().unwrap_or_else(|| json!([])),
        "prior_year_losses": frontend_request
            .get("priorYearLosses")
            .cloned()
            .unwrap_or_else(|| json!([])),
        // Koszty nabycia krypto z lat ubieglych (czesc E). Web przekazuje je flaga
        // --crypto-costs-carried-forward; bez tego pola desktop liczyl czesc E
        // bez przeniesionej nadwyzki kosztow.
        // Tekst albo liczba, jak String(x) w web.
        "crypto_costs_carried_forward": match frontend_request.get("cryptoCostsCarriedForward") {
            Some(Value::String(tekst)) => tekst.trim().to_string(),
            Some(Value::Number(liczba)) => liczba.to_string(),
            _ => String::new(),
        },
        "conditional_cost_ids": frontend_request
            .get("conditionalCostIds")
            .cloned()
            .unwrap_or_else(|| json!([])),
        "manual_fx_overrides": frontend_request
            .get("manualFxOverrides")
            .cloned()
            .unwrap_or_else(|| json!({})),
        // Pliki wylaczone przez uzytkownika w liscie magazynu. Przelacznik byl
        // dotad wylacznie ozdoba: zmienial stan widoku i wymuszal pelne
        // przeliczenie tym samym zestawem plikow.
        "excluded_files": frontend_request
            .get("excludedStorageFiles")
            .cloned()
            .unwrap_or_else(|| json!([])),
        "frontend_request": frontend_request
    });
    request["overrides"][PIT8C_ENTRIES_PATH_FIELD] = json!(pit8c_path);
    let request_path = run_dir.join("request.json");
    fs::write(
        &request_path,
        serde_json::to_vec_pretty(&request).unwrap_or_default(),
    )
    .map_err(|error| {
        DesktopError::io(
            "STORAGE_PERMISSION_DENIED",
            "Cannot write sidecar request",
            error,
        )
    })?;
    Ok(request_path)
}

fn write_optional_array(
    dir: &Path,
    filename: &str,
    value: Option<&Value>,
) -> DesktopResult<Option<String>> {
    let Some(value) = value else {
        return Ok(None);
    };
    // Dane w innym ksztalcie niz tablica znaczyly "pliku nie zapisano" i silnik
    // liczyl bez nadpisan uzytkownika, konczac sukcesem.
    if !value.is_array() {
        return Err(DesktopError::new(
            "REQUEST_OVERRIDES_INVALID",
            format!("Pole zapisywane do {filename} nie jest tablica JSON - silnik nie dostalby tych danych."),
            false,
        ));
    }
    let path = dir.join(filename);
    fs::write(&path, serde_json::to_vec_pretty(value).unwrap_or_default()).map_err(|error| {
        DesktopError::io(
            "STORAGE_PERMISSION_DENIED",
            "Cannot write override file",
            error,
        )
    })?;
    Ok(Some(path.to_string_lossy().to_string()))
}

fn update_status(
    jobs: &Arc<Mutex<std::collections::HashMap<String, JobRecord>>>,
    run_id: &str,
    state: &str,
    stage: &str,
    progress: u8,
    message: &str,
    error_code: Option<String>,
) {
    if let Ok(mut map) = jobs.lock() {
        if let Some(record) = map.get_mut(run_id) {
            if record.status.state == "cancelled" {
                return;
            }
            record.status.state = state.to_string();
            record.status.stage = stage.to_string();
            record.status.progress = progress;
            record.status.message = message.to_string();
            record.status.error_code = error_code;
            record.status.updated_at = now();
        }
    }
}

fn fail_job(
    jobs: &Arc<Mutex<std::collections::HashMap<String, JobRecord>>>,
    run_id: &str,
    error_code: &str,
    message: impl Into<String>,
) {
    update_status(
        jobs,
        run_id,
        "failed",
        "failed",
        100,
        &message.into(),
        Some(error_code.to_string()),
    );
}

fn is_cancelled(
    jobs: &Arc<Mutex<std::collections::HashMap<String, JobRecord>>>,
    run_id: &str,
) -> bool {
    jobs.lock()
        .ok()
        .and_then(|map| {
            map.get(run_id)
                .map(|record| record.status.state == "cancelled")
        })
        .unwrap_or(false)
}

fn write_runtime_error(run_dir: &Path, run_id: &str, error_code: &str, message: &str) {
    let payload = json!({
        "contract_version": CONTRACT_VERSION,
        "status": "error",
        "run_id": run_id,
        "error_code": error_code,
        "message": message,
        "details": {},
        "recoverable": true
    });
    let _ = fs::write(
        run_dir.join("error.json"),
        serde_json::to_vec_pretty(&payload).unwrap_or_default(),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sidecar_request_carries_optional_pit8c_entries_path() {
        let run_dir = std::env::temp_dir().join(format!("ia-pit8c-{}", Uuid::new_v4()));
        let frontend = json!({
            "year": 2026, "taxPlan": "defensible",
            "pit8cEntries": [{"revenuePln": 1234.56, "costsPln": 100.01}]
        });
        let request_path = write_sidecar_request(&run_dir, "syntetyczny", &frontend, "test-pit8c")
            .expect("zadanie sidecara");
        let request: Value = serde_json::from_slice(&fs::read(request_path).unwrap()).unwrap();
        assert_eq!(request["contract_version"], REQUEST_CONTRACT_VERSION);
        let pit8c_path = request["overrides"][PIT8C_ENTRIES_PATH_FIELD].as_str().unwrap();
        let entries: Value = serde_json::from_slice(&fs::read(pit8c_path).unwrap()).unwrap();
        assert_eq!(entries, frontend["pit8cEntries"]);
        assert!(run_dir.starts_with(std::env::temp_dir()));
        fs::remove_dir_all(run_dir).unwrap();
    }

    fn zapisz_zadanie(frontend: &Value, run_id: &str) -> Value {
        let run_dir = std::env::temp_dir().join(format!("ia-req-{}", Uuid::new_v4()));
        let request_path =
            write_sidecar_request(&run_dir, "syntetyczny", frontend, run_id).expect("zadanie sidecara");
        let request: Value = serde_json::from_slice(&fs::read(request_path).unwrap()).unwrap();
        fs::remove_dir_all(run_dir).unwrap();
        request
    }

    #[test]
    fn sidecar_request_carries_crypto_costs_carried_forward() {
        let request = zapisz_zadanie(
            &json!({"year": 2026, "taxPlan": "defensible", "cryptoCostsCarriedForward": " 1234.56 "}),
            "test-krypto",
        );
        // Web: --crypto-costs-carried-forward (przyciete), sidecar czyta payload.crypto_costs_carried_forward.
        assert_eq!(request["crypto_costs_carried_forward"], "1234.56");
        let bez = zapisz_zadanie(&json!({"year": 2026, "taxPlan": "defensible"}), "test-bez-krypto");
        assert_eq!(bez["crypto_costs_carried_forward"], "");
        // Web: String(x) - liczba (np. z ustawien) nie moze byc gubiona jak brak wartosci.
        for (wejscie, oczekiwane) in [(json!(1234.56), "1234.56"), (json!(500), "500"), (json!(null), "")] {
            let wynik = zapisz_zadanie(
                &json!({"year": 2026, "taxPlan": "defensible", "cryptoCostsCarriedForward": wejscie}),
                "test-krypto-liczba",
            );
            assert_eq!(wynik["crypto_costs_carried_forward"], oczekiwane);
        }
    }

    /// Pola `TaxEngineRequest` (web), ktore zadanie sidecara przenosi do request.json.
    const POLA_PRZENOSZONE: &[&str] = &[
        "year", "runMode", "taxPlan", "includeFxConversionCosts", "includeBankFundingFees",
        "includeInterestCosts", "includeAccountFees", "packageScope", "filingMode", "fundingFees",
        "priorYearLosses", "cryptoCostsCarriedForward", "conditionalCostIds", "manualFxOverrides",
        "excludedStorageFiles", "nbpAllowManualOverride", "transactionOverrides",
        "defenseEvidenceOverrides", "brokerFileActionOverrides", "reviewDecisions",
        "sourceSelectionMode", "selectedCandidateSourceId", "canonicalTaxInputMode",
        "aiNormalizerEnabled", "aiNormalizerGpuConfirmed", "aiNormalizerComputeBackend",
    ];
    /// Pola swiadomie nieprzenoszone do request.json, z powodem.
    const POLA_POMINIETE: &[(&str, &str)] = &[
        ("aiNormalizerGpuMode", "ustawienia GPU Ollamy idą z ustawień aplikacji (ollama_engine_environment)"),
        ("aiNormalizerNumGpu", "jw."),
        ("aiNormalizerGpuBackend", "jw."),
        ("aiNormalizerGpuLoadLimitPercent", "jw."),
        ("aiNormalizerNumBatch", "jw."),
        ("aiNormalizerMaxParallel", "jw."),
        ("aiNormalizerGpuRequired", "web i desktop wymuszają true"),
        ("allowCpuAi", "web i desktop wymuszają false"),
        ("forceRecalculate", "dotyczy wyłącznie cache wyniku serwera web"),
        ("fundingFee", "pole wycofane (typ undefined)"),
    ];

    /// Nazwy pól interfejsu `TaxEngineRequest` odczytane z kodu web, żeby nowe pole
    /// nie mogło zostać po cichu pominięte przez desktop.
    fn pola_interfejsu_zadania_web() -> Vec<String> {
        let zrodlo = include_str!("../../../../web/src/invest_analyzer/services/taxEngineConfig.ts");
        let poczatek = zrodlo
            .find("export interface TaxEngineRequest {")
            .expect("interfejs TaxEngineRequest");
        zrodlo[poczatek..]
            .lines()
            .skip(1)
            .take_while(|linia| linia.trim() != "}")
            .map(str::trim)
            .filter(|linia| !linia.is_empty() && !linia.starts_with('/') && !linia.starts_with('*'))
            .filter_map(|linia| {
                let nazwa = linia.split(':').next()?.trim().trim_end_matches('?');
                (!nazwa.is_empty() && nazwa.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
                    .then(|| nazwa.to_string())
            })
            .collect()
    }

    #[test]
    fn kazde_pole_zadania_web_jest_przenoszone_albo_swiadomie_pominiete() {
        let pola = pola_interfejsu_zadania_web();
        assert!(pola.len() > 30, "parser interfejsu znalazł za mało pól: {pola:?}");
        for pole in &pola {
            let przenoszone = POLA_PRZENOSZONE.contains(&pole.as_str());
            let pominiete = POLA_POMINIETE.iter().any(|(nazwa, _)| nazwa == pole);
            assert!(
                przenoszone ^ pominiete,
                "Pole {pole} z TaxEngineRequest nie jest ani przenoszone do sidecara, ani świadomie pominięte (albo jest na obu listach)."
            );
        }
        for pole in POLA_PRZENOSZONE.iter().chain(POLA_POMINIETE.iter().map(|(nazwa, _)| nazwa)) {
            assert!(pola.iter().any(|p| p == pole), "Lista desktopu zawiera pole {pole}, którego nie ma w TaxEngineRequest.");
        }
    }

    #[test]
    fn anulowane_zadanie_nie_uruchamia_sidecara() {
        let run_id = "anulowane".to_string();
        let child_slot = Arc::new(Mutex::new(None));
        let mut record = JobRecord {
            status: queued_status(&run_id),
            result: None,
            error: None,
            child: Some(child_slot.clone()),
        };
        mark_cancelled(&mut record);
        let jobs = Arc::new(Mutex::new(std::collections::HashMap::from([(run_id.clone(), record)])));
        let run_dir = std::env::temp_dir().join(format!("ia-cancel-{}", Uuid::new_v4()));
        run_sidecar_job(
            jobs.clone(),
            run_id.clone(),
            "test".to_string(),
            run_dir.join("brak-sidecara"),
            run_dir.clone(),
            run_dir.join("request.json"),
            Vec::new(),
            child_slot.clone(),
            now(),
        );
        assert_eq!(jobs.lock().unwrap()[&run_id].status.state, "cancelled");
        assert!(child_slot.lock().unwrap().is_none());
        assert!(!run_dir.exists());
    }

    fn zakonczone(state: &str, updated_at: &str) -> JobRecord {
        let mut status = queued_status("zadanie");
        status.state = state.to_string();
        status.updated_at = updated_at.to_string();
        JobRecord {
            status,
            result: Some(json!({"duzy": "wynik"})),
            error: None,
            child: None,
        }
    }

    #[test]
    fn wynik_zadania_mozna_odebrac_tylko_raz() {
        let mut record = zakonczone("done", &now());

        let pierwszy = take_job_result(&mut record).expect("pierwszy odczyt");
        assert_eq!(pierwszy, json!({"duzy": "wynik"}));
        assert!(record.result.is_none(), "wynik nie zostaje w pamieci");

        let drugi = take_job_result(&mut record).unwrap_err();
        assert_eq!(drugi.error_code, "ENGINE_RESULT_ALREADY_TAKEN");
        assert_eq!(record.status.state, "done", "status nadal dostepny");
    }

    #[test]
    fn wynik_zadania_w_toku_nie_jest_gotowy_a_nieudanego_zwraca_blad_silnika() {
        let mut w_toku = zakonczone("running", &now());
        w_toku.result = None;
        assert_eq!(take_job_result(&mut w_toku).unwrap_err().message, "Tax engine result is not ready.");

        let mut nieudane = zakonczone("failed", &now());
        nieudane.status.error_code = Some("ENGINE_CRASHED".to_string());
        assert_eq!(take_job_result(&mut nieudane).unwrap_err().error_code, "ENGINE_CRASHED");
    }

    #[test]
    fn rejestr_zadan_usuwa_stare_i_nadmiarowe_zakonczone_ale_nie_zadania_w_toku() {
        let teraz = chrono::Utc::now();
        let mut jobs = std::collections::HashMap::new();
        jobs.insert("w-toku".to_string(), zakonczone("running", &(teraz - chrono::Duration::hours(5)).to_rfc3339()));
        jobs.insert("stare".to_string(), zakonczone("done", &(teraz - chrono::Duration::hours(2)).to_rfc3339()));
        jobs.insert("zepsute".to_string(), zakonczone("done", "nie-data"));
        for indeks in 0..(MAX_FINISHED_JOBS + 3) {
            let wiek = chrono::Duration::seconds(10 + indeks as i64);
            jobs.insert(format!("swieze-{indeks}"), zakonczone("done", &(teraz - wiek).to_rfc3339()));
        }

        prune_finished_jobs(&mut jobs, teraz);

        assert!(jobs.contains_key("w-toku"), "zadanie w toku nigdy nie znika");
        assert!(!jobs.contains_key("stare"));
        assert!(!jobs.contains_key("zepsute"));
        let swieze = jobs.keys().filter(|id| id.starts_with("swieze-")).count();
        assert_eq!(swieze, MAX_FINISHED_JOBS);
        assert!(jobs.contains_key("swieze-0"), "zostaja najnowsze");
        assert!(!jobs.contains_key(&format!("swieze-{}", MAX_FINISHED_JOBS + 2)));
    }

    fn rejestr_z_zadaniem(
        run_id: &str,
    ) -> (Arc<Mutex<std::collections::HashMap<String, JobRecord>>>, String) {
        let mut status = queued_status(run_id);
        status.state = "running".to_string();
        let record = JobRecord { status, result: None, error: None, child: None };
        let jobs = Arc::new(Mutex::new(std::collections::HashMap::from([(run_id.to_string(), record)])));
        (jobs, run_id.to_string())
    }

    /// Awaria silnika bez result.json/error.json: do UI nie ida fragmenty stderr (sciezki
    /// uzytkownika, nazwy wyciagow, traceback) - tylko kod wyjscia i wskazanie pliku.
    #[test]
    fn awaria_bez_error_json_nie_oddaje_stderr_do_interfejsu() {
        let run_dir = std::env::temp_dir().join(format!("ia-crash-{}", Uuid::new_v4()));
        fs::create_dir_all(&run_dir).unwrap();
        fs::write(
            run_dir.join("stderr.log"),
            "Traceback (most recent call last):\n  File 'C:/Users/TestUser/wyciag_2025.csv', line 3\nKeyError: 'USD'\n",
        )
        .unwrap();
        let (jobs, run_id) = rejestr_z_zadaniem("crash-1");

        finalize_sidecar_job(&jobs, &run_id, &run_dir, "test", &now(), Some(3));

        let status = jobs.lock().unwrap()[&run_id].status.clone();
        assert_eq!(status.state, "failed");
        assert_eq!(status.error_code.as_deref(), Some("ENGINE_CRASHED"));
        assert_eq!(
            status.message,
            "Silnik zakończył się błędem (kod 3). Szczegóły w pliku stderr.log przebiegu crash-1."
        );
        assert!(run_dir.join("stderr.log").exists(), "pelny stderr zostaje w katalogu przebiegu");
        let _ = fs::remove_dir_all(&run_dir);
    }

    /// error.json zostaje na dysku w calosci; do UI trafia zamaskowany komunikat i
    /// szczegoly bez tracebacku.
    #[test]
    fn blad_z_error_json_ma_zamaskowany_komunikat_i_nie_niesie_tracebacku() {
        let run_dir = std::env::temp_dir().join(format!("ia-errjson-{}", Uuid::new_v4()));
        fs::create_dir_all(&run_dir).unwrap();
        let payload = json!({
            "contract_version": CONTRACT_VERSION,
            "status": "error",
            "run_id": "err-1",
            "error_code": "ENGINE_FAILED",
            "message": r"Brak pliku C:\Users\TestUser\Moje\wyciag_2025.csv w magazynie",
            "details": {
                "traceback": "Traceback (most recent call last):\n  File 'C:/Users/TestUser/x.py'",
                "stage": "source_parse"
            },
            "recoverable": true
        });
        fs::write(run_dir.join("error.json"), serde_json::to_vec_pretty(&payload).unwrap()).unwrap();
        let (jobs, run_id) = rejestr_z_zadaniem("err-1");

        finalize_sidecar_job(&jobs, &run_id, &run_dir, "test", &now(), Some(1));

        let map = jobs.lock().unwrap();
        let record = &map[&run_id];
        assert_eq!(record.status.error_code.as_deref(), Some("ENGINE_FAILED"));
        assert!(!record.status.message.contains("TestUser"), "{}", record.status.message);
        assert!(!record.status.message.contains("wyciag_2025"), "{}", record.status.message);
        assert!(record.status.message.contains("Brak pliku"), "{}", record.status.message);
        let blad = record.error.as_ref().expect("blad zadania");
        assert!(blad["details"].get("traceback").is_none(), "traceback nie idzie do UI: {blad}");
        assert_eq!(blad["details"]["stage"], "source_parse");
        assert!(!blad["message"].to_string().contains("TestUser"), "{blad}");
        let na_dysku = fs::read_to_string(run_dir.join("error.json")).unwrap();
        assert!(na_dysku.contains("traceback"), "error.json na dysku zostaje pelny");
        let _ = fs::remove_dir_all(&run_dir);
    }
}
