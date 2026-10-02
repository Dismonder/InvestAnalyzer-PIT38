use crate::commands::app_paths::resolve_app_paths;
use crate::engine::errors::{DesktopError, DesktopResult};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::AppHandle;

const DEFAULT_OLLAMA_BASE_URL: &str = "http://127.0.0.1:11434";
const DEFAULT_OLLAMA_MODEL: &str = "qwen3:14b";
const OLLAMA_CONFIG_FILE: &str = "ollama_config.json";
const OLLAMA_MANAGED_PROCESS_FILE: &str = "ollama_managed_process.json";
const OLLAMA_LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaModelInfo {
    pub name: String,
    pub modified_at: Option<String>,
    pub size: Option<u64>,
    pub digest: Option<String>,
    pub details: Option<Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaConfig {
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub exe_path: Option<String>,
    pub auto_start: Option<bool>,
    pub gpu_mode: Option<String>,
    pub num_gpu: Option<i32>,
    pub gpu_backend: Option<String>,
    pub gpu_load_limit_percent: Option<u8>,
    pub num_batch: Option<u32>,
    pub max_parallel: Option<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaRuntimeStatus {
    pub available: bool,
    pub server_running: bool,
    pub base_url: String,
    pub model: Option<String>,
    pub model_available: bool,
    pub models: Vec<OllamaModelInfo>,
    pub exe_path: Option<String>,
    pub exe_exists: bool,
    pub can_auto_start: bool,
    pub gpu_mode: String,
    pub num_gpu: Option<i32>,
    pub gpu_backend: String,
    pub gpu_load_limit_percent: u8,
    pub num_batch: u32,
    pub max_parallel: u8,
    pub gpu_confirmed: bool,
    pub compute_backend: String,
    pub gpu_probe_status: String,
    pub gpu_failure_reason: Option<String>,
    pub log_evidence: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaEnsureOptions {
    pub require_gpu: Option<bool>,
    pub restart_if_gpu_unconfirmed: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaEnsureResult {
    pub started: bool,
    pub already_running: bool,
    pub status: OllamaRuntimeStatus,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaStopResult {
    pub stopped: bool,
    pub status: OllamaRuntimeStatus,
    pub message: String,
}

fn config_path(app: &AppHandle) -> DesktopResult<PathBuf> {
    let paths = resolve_app_paths(app)?;
    Ok(PathBuf::from(paths.data_dir).join(OLLAMA_CONFIG_FILE))
}

fn managed_process_path(app: &AppHandle) -> DesktopResult<PathBuf> {
    let paths = resolve_app_paths(app)?;
    Ok(PathBuf::from(paths.data_dir).join(OLLAMA_MANAGED_PROCESS_FILE))
}

fn load_config(app: &AppHandle) -> OllamaConfig {
    let path = match config_path(app) {
        Ok(path) => path,
        Err(_) => return OllamaConfig::default(),
    };
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(_) => return OllamaConfig::default(),
    };
    serde_json::from_str(&content).unwrap_or_default()
}

fn save_config(app: &AppHandle, config: &OllamaConfig) -> DesktopResult<()> {
    let path = config_path(app)?;
    let parent = path.parent().ok_or_else(|| {
        DesktopError::new(
            "STORAGE_NOT_FOUND",
            "Cannot resolve Ollama config directory.",
            true,
        )
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        DesktopError::io(
            "STORAGE_PERMISSION_DENIED",
            "Cannot create Ollama config directory",
            error,
        )
    })?;
    let content = serde_json::to_string_pretty(config).map_err(|error| {
        DesktopError::new(
            "ENGINE_INVALID_JSON",
            format!("Cannot serialize Ollama config: {error}"),
            true,
        )
    })?;
    fs::write(path, content).map_err(|error| {
        DesktopError::io(
            "STORAGE_PERMISSION_DENIED",
            "Cannot write Ollama config",
            error,
        )
    })
}

fn normalize_base_url(value: Option<&str>) -> String {
    let requested = value
        .filter(|text| !text.trim().is_empty())
        .map(ToString::to_string)
        .or_else(|| env::var("INVEST_OLLAMA_BASE_URL").ok())
        .unwrap_or_else(|| DEFAULT_OLLAMA_BASE_URL.to_string())
        .trim()
        .trim_end_matches('/')
        .to_string();
    if parse_host_port(&requested).is_ok() && is_loopback_url(&requested) {
        requested
    } else {
        DEFAULT_OLLAMA_BASE_URL.to_string()
    }
}

fn configured_model(value: Option<&str>) -> Option<String> {
    value
        .filter(|text| !text.trim().is_empty())
        .map(|text| text.trim().to_string())
        .or_else(|| {
            env::var("INVEST_OLLAMA_MODEL")
                .ok()
                .filter(|text| !text.trim().is_empty())
        })
}

fn configured_gpu_mode(value: Option<&str>) -> String {
    let requested = value
        .filter(|text| !text.trim().is_empty())
        .map(|text| text.trim().to_lowercase())
        .or_else(|| {
            env::var("INVEST_OLLAMA_GPU_MODE")
                .ok()
                .map(|text| text.trim().to_lowercase())
        })
        .unwrap_or_else(|| "gpu".to_string());
    match requested.as_str() {
        "gpu" | "auto" => requested,
        _ => "gpu".to_string(),
    }
}

fn configured_num_gpu(configured: Option<i32>, gpu_mode: &str) -> Option<i32> {
    let value = configured
        .or_else(|| {
            env::var("INVEST_OLLAMA_NUM_GPU")
                .ok()
                .and_then(|text| text.parse::<i32>().ok())
        })
        .or_else(|| match gpu_mode {
            "gpu" => Some(-1),
            _ => None,
        });
    match value {
        Some(0) => Some(-1),
        other => other,
    }
}

fn configured_gpu_backend(value: Option<&str>) -> String {
    let requested = value
        .filter(|text| !text.trim().is_empty())
        .map(|text| text.trim().to_lowercase())
        .or_else(|| {
            env::var("INVEST_OLLAMA_GPU_BACKEND")
                .ok()
                .map(|text| text.trim().to_lowercase())
        })
        .unwrap_or_else(|| "vulkan".to_string());
    match requested.as_str() {
        "vulkan" | "rocm" | "cuda" | "auto" => requested,
        _ => "vulkan".to_string(),
    }
}

fn configured_gpu_load_limit_percent(value: Option<u8>) -> u8 {
    let parsed = value
        .map(i32::from)
        .or_else(|| {
            env::var("INVEST_OLLAMA_GPU_LOAD_LIMIT_PERCENT")
                .ok()
                .and_then(|text| text.parse::<i32>().ok())
        })
        .unwrap_or(85);
    parsed.clamp(50, 95) as u8
}

fn configured_num_batch(value: Option<u32>, gpu_load_limit_percent: u8) -> u32 {
    value
        .or_else(|| {
            env::var("INVEST_OLLAMA_NUM_BATCH")
                .ok()
                .and_then(|text| text.parse::<u32>().ok())
        })
        .filter(|number| *number > 0)
        .unwrap_or(if gpu_load_limit_percent <= 85 {
            128
        } else {
            256
        })
}

fn configured_max_parallel(value: Option<u8>) -> u8 {
    value
        .or_else(|| {
            env::var("OLLAMA_NUM_PARALLEL")
                .ok()
                .and_then(|text| text.parse::<u8>().ok())
        })
        .filter(|number| *number > 0)
        .map(|number| number.min(2))
        .unwrap_or(1)
}

fn choose_effective_model(requested: Option<String>, models: &[OllamaModelInfo]) -> String {
    if let Some(requested) = requested {
        return requested;
    }
    for preferred in [
        DEFAULT_OLLAMA_MODEL,
        "qwen3:8b",
        "qwen2.5:7b-instruct",
        "qwen2.5:7b",
        "llama3.1:8b-instruct",
        "llama3.1:8b",
    ] {
        if models.iter().any(|model| model.name == preferred) {
            return preferred.to_string();
        }
    }
    models
        .first()
        .map(|model| model.name.clone())
        .unwrap_or_else(|| DEFAULT_OLLAMA_MODEL.to_string())
}

fn parse_host_port(base_url: &str) -> Result<(String, u16), String> {
    let without_scheme = base_url
        .trim()
        .trim_end_matches('/')
        .strip_prefix("http://")
        .ok_or_else(|| "Ollama musi używać lokalnego HTTP.".to_string())?;
    let authority = without_scheme.split('/').next().unwrap_or("");
    if authority.is_empty() {
        return Err("Niepoprawny adres Ollama.".to_string());
    }
    if authority.starts_with('[') {
        let end = authority
            .find(']')
            .ok_or_else(|| "Niepoprawny adres IPv6 Ollama.".to_string())?;
        let host = authority[1..end].to_string();
        let rest = &authority[end + 1..];
        let port = if let Some(port_text) = rest.strip_prefix(':') {
            port_text
                .parse::<u16>()
                .map_err(|_| "Niepoprawny port Ollama.".to_string())?
        } else {
            11434
        };
        return Ok((host, port));
    }
    let mut parts = authority.rsplitn(2, ':');
    let maybe_port = parts.next().unwrap_or("");
    let maybe_host = parts.next();
    if let Some(host) = maybe_host {
        let port = maybe_port
            .parse::<u16>()
            .map_err(|_| "Niepoprawny port Ollama.".to_string())?;
        return Ok((host.to_string(), port));
    }
    Ok((authority.to_string(), 11434))
}

fn is_loopback_url(base_url: &str) -> bool {
    match parse_host_port(base_url) {
        Ok((host, _)) => matches!(host.as_str(), "127.0.0.1" | "localhost" | "::1"),
        Err(_) => false,
    }
}

fn exe_path_is_allowed(path: &Path) -> bool {
    path.file_name()
        .map(|name| name.to_string_lossy().eq_ignore_ascii_case("ollama.exe"))
        .unwrap_or(false)
        && path.exists()
        && path.is_file()
}

fn push_candidate(candidates: &mut Vec<PathBuf>, path: impl Into<PathBuf>) {
    let path = path.into();
    if !candidates.iter().any(|candidate| candidate == &path) {
        candidates.push(path);
    }
}

fn detect_ollama_exe(config: &OllamaConfig) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(path) = env::var("INVEST_OLLAMA_EXE_PATH") {
        push_candidate(&mut candidates, path);
    }
    if let Some(path) = config
        .exe_path
        .as_deref()
        .filter(|path| !path.trim().is_empty())
    {
        push_candidate(&mut candidates, path);
    }
    if let Ok(local_app_data) = env::var("LOCALAPPDATA") {
        let root = PathBuf::from(local_app_data);
        push_candidate(
            &mut candidates,
            root.join("Programs").join("OllamaCLI").join("ollama.exe"),
        );
        push_candidate(
            &mut candidates,
            root.join("Programs").join("Ollama").join("ollama.exe"),
        );
        push_candidate(&mut candidates, root.join("Ollama").join("ollama.exe"));
    }
    if let Ok(program_files) = env::var("ProgramFiles") {
        push_candidate(
            &mut candidates,
            PathBuf::from(program_files)
                .join("Ollama")
                .join("ollama.exe"),
        );
    }
    if let Ok(program_files_x86) = env::var("ProgramFiles(x86)") {
        push_candidate(
            &mut candidates,
            PathBuf::from(program_files_x86)
                .join("Ollama")
                .join("ollama.exe"),
        );
    }
    if let Ok(path_var) = env::var("PATH") {
        for entry in env::split_paths(&path_var) {
            push_candidate(&mut candidates, entry.join("ollama.exe"));
        }
    }
    candidates
        .into_iter()
        .find(|path| exe_path_is_allowed(path))
}

fn parse_tags_response(payload: &Value) -> Vec<OllamaModelInfo> {
    payload
        .get("models")
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .filter_map(|model| {
                    let name = model
                        .get("name")
                        .or_else(|| model.get("model"))
                        .and_then(Value::as_str)?
                        .to_string();
                    Some(OllamaModelInfo {
                        name,
                        modified_at: model
                            .get("modified_at")
                            .and_then(Value::as_str)
                            .map(ToString::to_string),
                        size: model.get("size").and_then(Value::as_u64),
                        digest: model
                            .get("digest")
                            .and_then(Value::as_str)
                            .map(ToString::to_string),
                        details: model.get("details").cloned(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn http_get_json(base_url: &str, path: &str, timeout: Duration) -> Result<Value, String> {
    let (host, port) = parse_host_port(base_url)?;
    let address = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|error| format!("Nie udało się rozwiązać adresu Ollama: {error}"))?
        .next()
        .ok_or_else(|| "Nie udało się rozwiązać adresu Ollama.".to_string())?;
    let mut stream = TcpStream::connect_timeout(&address, timeout)
        .map_err(|error| format!("Ollama nie odpowiada: {error}"))?;
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\nAccept: application/json\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("Nie udało się wysłać zapytania do Ollama: {error}"))?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|error| format!("Nie udało się odczytać odpowiedzi Ollama: {error}"))?;
    let (headers, body) = response
        .split_once("\r\n\r\n")
        .ok_or_else(|| "Ollama zwróciła niepoprawną odpowiedź HTTP.".to_string())?;
    let status_line = headers.lines().next().unwrap_or("");
    if !status_line.contains(" 200 ") {
        return Err(format!("Ollama zwróciła {status_line}."));
    }
    serde_json::from_str(body.trim())
        .map_err(|error| format!("Ollama zwróciła niepoprawny JSON: {error}"))
}

fn http_post_json(
    base_url: &str,
    path: &str,
    body: &Value,
    timeout: Duration,
) -> Result<Value, String> {
    let (host, port) = parse_host_port(base_url)?;
    let address = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|error| format!("Nie udało się rozwiązać adresu Ollama: {error}"))?
        .next()
        .ok_or_else(|| "Nie udało się rozwiązać adresu Ollama.".to_string())?;
    let body_text = serde_json::to_string(body)
        .map_err(|error| format!("Nie udało się zbudować JSON probe: {error}"))?;
    let mut stream = TcpStream::connect_timeout(&address, timeout)
        .map_err(|error| format!("Ollama nie odpowiada: {error}"))?;
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\nAccept: application/json\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body_text}",
        body_text.as_bytes().len()
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("Nie udało się wysłać probe do Ollama: {error}"))?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|error| format!("Nie udało się odczytać odpowiedzi probe Ollama: {error}"))?;
    let (headers, body) = response
        .split_once("\r\n\r\n")
        .ok_or_else(|| "Ollama zwróciła niepoprawną odpowiedź HTTP.".to_string())?;
    let status_line = headers.lines().next().unwrap_or("");
    if !status_line.contains(" 200 ") {
        return Err(format!("Ollama zwróciła {status_line}."));
    }
    serde_json::from_str(body.trim())
        .map_err(|error| format!("Ollama zwróciła niepoprawny JSON probe: {error}"))
}

fn read_ollama_logs(app: &AppHandle) -> Vec<String> {
    let Ok(paths) = resolve_app_paths(app) else {
        return Vec::new();
    };
    let logs_dir = PathBuf::from(paths.logs_dir);
    ["ollama-stderr.log", "ollama-stdout.log"]
        .iter()
        .filter_map(|name| fs::read_to_string(logs_dir.join(name)).ok())
        .flat_map(|text| {
            text.lines()
                .map(|line| line.trim().to_string())
                .collect::<Vec<_>>()
        })
        .filter(|line| !line.is_empty())
        .rev()
        .take(800)
        .collect()
}

fn selected_log_evidence(lines: &[String]) -> Vec<String> {
    let patterns = [
        "cpu model buffer",
        "cpu kv buffer",
        "loaded cpu backend",
        "inference compute id=cpu",
        "library=cpu",
        "dynamic llm libraries",
        "model weights",
        "kv cache",
        "compute graph",
        "gpu model buffer",
        "gpu kv buffer",
        "inference compute id=gpu",
        "library=vulkan",
        "library=rocm",
        "library=cuda",
        "vulkan",
        "rocm",
        "cuda",
    ];
    lines
        .iter()
        .filter(|line| {
            let lower = line.to_lowercase();
            patterns.iter().any(|pattern| lower.contains(pattern))
        })
        .take(20)
        .cloned()
        .collect()
}

fn fresh_ollama_log_segment(lines: &[String]) -> Vec<String> {
    let mut segment = Vec::new();
    for line in lines.iter().take(240) {
        segment.push(line.clone());
        if line.to_lowercase().contains("server config") {
            break;
        }
    }
    if segment.is_empty() {
        lines.iter().take(240).cloned().collect()
    } else {
        segment
    }
}

fn parse_gpu_probe_from_logs(
    lines: &[String],
) -> (bool, String, String, Option<String>, Vec<String>) {
    let fresh_segment = fresh_ollama_log_segment(lines);
    let evidence = selected_log_evidence(&fresh_segment);
    let joined = evidence.join("\n").to_lowercase();
    let backend = if joined.contains("vulkan") {
        "vulkan"
    } else if joined.contains("rocm") || joined.contains("hip") {
        "rocm"
    } else if joined.contains("cuda") {
        "cuda"
    } else {
        "gpu"
    };
    let gpu_markers = [
        "gpu model buffer",
        "gpu kv buffer",
        "inference compute id=gpu",
        "library=vulkan",
        "library=rocm",
        "library=cuda",
        "device=vulkan",
        "device=rocm",
        "device=cuda",
        "ggml-vulkan",
        "ggml-rocm",
        "ggml-cuda",
    ];
    if gpu_markers.iter().any(|marker| joined.contains(marker)) {
        return (true, "gpu".to_string(), "pass".to_string(), None, evidence);
    }
    let cpu_markers = [
        "cpu model buffer",
        "cpu kv buffer",
        "inference compute id=cpu",
        "library=cpu",
        "device=cpu",
    ];
    if cpu_markers.iter().any(|marker| joined.contains(marker)) {
        return (
            false,
            "cpu".to_string(),
            "fail".to_string(),
            Some(
                "Ollama potwierdziła CPU backend w logach. AI wyłączona, bez CPU fallbacku."
                    .to_string(),
            ),
            evidence,
        );
    }
    if joined.contains("loaded cpu backend") && !joined.contains(backend) {
        return (
            false,
            "cpu".to_string(),
            "fail".to_string(),
            Some(
                "Ollama potwierdziła tylko CPU backend w świeżych logach. AI wyłączona, bez CPU fallbacku."
                    .to_string(),
            ),
            evidence,
        );
    }
    (
        false,
        "unknown".to_string(),
        "fail".to_string(),
        Some(
            "Nie znaleziono w świeżych logach potwierdzenia GPU. AI wyłączona, bez CPU fallbacku."
                .to_string(),
        ),
        evidence,
    )
}

fn rotate_log_if_needed(path: &Path) -> DesktopResult<()> {
    let Ok(metadata) = fs::metadata(path) else {
        return Ok(());
    };
    if metadata.len() <= OLLAMA_LOG_MAX_BYTES {
        return Ok(());
    }
    let rotated = path.with_extension("log.1");
    if rotated.exists() {
        fs::remove_file(&rotated).map_err(|error| {
            DesktopError::io(
                "STORAGE_PERMISSION_DENIED",
                "Cannot rotate old Ollama log",
                error,
            )
        })?;
    }
    fs::rename(path, &rotated).map_err(|error| {
        DesktopError::io(
            "STORAGE_PERMISSION_DENIED",
            "Cannot rotate Ollama log",
            error,
        )
    })
}

fn attach_gpu_probe(status: &mut OllamaRuntimeStatus, app: &AppHandle) {
    let lines = read_ollama_logs(app);
    let (confirmed, backend, probe_status, reason, evidence) = parse_gpu_probe_from_logs(&lines);
    status.gpu_confirmed = confirmed;
    status.compute_backend = backend;
    status.gpu_probe_status = probe_status;
    status.gpu_failure_reason = reason;
    status.log_evidence = evidence;
    status.available = status.server_running && status.model_available && status.gpu_confirmed;
}

fn build_status(app: &AppHandle) -> OllamaRuntimeStatus {
    let config = load_config(app);
    let base_url = normalize_base_url(config.base_url.as_deref());
    let requested_model = configured_model(config.model.as_deref());
    let gpu_mode = configured_gpu_mode(config.gpu_mode.as_deref());
    let num_gpu = configured_num_gpu(config.num_gpu, &gpu_mode);
    let gpu_backend = configured_gpu_backend(config.gpu_backend.as_deref());
    let gpu_load_limit_percent = configured_gpu_load_limit_percent(config.gpu_load_limit_percent);
    let num_batch = configured_num_batch(config.num_batch, gpu_load_limit_percent);
    let max_parallel = configured_max_parallel(config.max_parallel);
    let exe_path = detect_ollama_exe(&config);
    match http_get_json(&base_url, "/api/tags", Duration::from_millis(1500)) {
        Ok(payload) => {
            let models = parse_tags_response(&payload);
            let model = choose_effective_model(requested_model, &models);
            let model_available = models.iter().any(|entry| entry.name == model);
            OllamaRuntimeStatus {
                available: false,
                server_running: true,
                base_url,
                model: Some(model),
                model_available,
                models,
                exe_exists: exe_path.is_some(),
                can_auto_start: exe_path.is_some(),
                gpu_mode,
                num_gpu,
                gpu_backend,
                gpu_load_limit_percent,
                num_batch,
                max_parallel,
                gpu_confirmed: false,
                compute_backend: "unknown".to_string(),
                gpu_probe_status: "not_run".to_string(),
                gpu_failure_reason: Some("GPU probe nie zostal uruchomiony.".to_string()),
                log_evidence: Vec::new(),
                exe_path: exe_path.map(|path| path.to_string_lossy().to_string()),
                error: None,
            }
        }
        Err(error) => OllamaRuntimeStatus {
            available: false,
            server_running: false,
            base_url,
            model: Some(choose_effective_model(requested_model, &[])),
            model_available: false,
            models: Vec::new(),
            exe_exists: exe_path.is_some(),
            can_auto_start: exe_path.is_some(),
            gpu_mode,
            num_gpu,
            gpu_backend,
            gpu_load_limit_percent,
            num_batch,
            max_parallel,
            gpu_confirmed: false,
            compute_backend: "unknown".to_string(),
            gpu_probe_status: "not_run".to_string(),
            gpu_failure_reason: Some("Ollama nie odpowiada, GPU niepotwierdzone.".to_string()),
            log_evidence: Vec::new(),
            exe_path: exe_path.map(|path| path.to_string_lossy().to_string()),
            error: Some(error),
        },
    }
}

pub fn ollama_engine_environment(app: &AppHandle) -> Vec<(String, String)> {
    let config = load_config(app);
    let base_url = normalize_base_url(config.base_url.as_deref());
    let requested_model = configured_model(config.model.as_deref());
    let gpu_mode = configured_gpu_mode(config.gpu_mode.as_deref());
    let num_gpu = configured_num_gpu(config.num_gpu, &gpu_mode);
    let gpu_backend = configured_gpu_backend(config.gpu_backend.as_deref());
    let gpu_load_limit_percent = configured_gpu_load_limit_percent(config.gpu_load_limit_percent);
    let num_batch = configured_num_batch(config.num_batch, gpu_load_limit_percent);
    let max_parallel = configured_max_parallel(config.max_parallel);
    let model = match http_get_json(&base_url, "/api/tags", Duration::from_millis(1500)) {
        Ok(payload) => choose_effective_model(requested_model, &parse_tags_response(&payload)),
        Err(_) => choose_effective_model(requested_model, &[]),
    };
    let mut envs = vec![
        ("INVEST_OLLAMA_BASE_URL".to_string(), base_url),
        ("INVEST_OLLAMA_MODEL".to_string(), model),
        ("INVEST_OLLAMA_GPU_MODE".to_string(), gpu_mode),
        ("INVEST_OLLAMA_GPU_BACKEND".to_string(), gpu_backend),
        (
            "INVEST_OLLAMA_GPU_LOAD_LIMIT_PERCENT".to_string(),
            gpu_load_limit_percent.to_string(),
        ),
        ("INVEST_OLLAMA_NUM_BATCH".to_string(), num_batch.to_string()),
        (
            "INVEST_OLLAMA_REQUEST_COOLDOWN_MS".to_string(),
            "250".to_string(),
        ),
        ("INVEST_OLLAMA_GPU_REQUIRED".to_string(), "true".to_string()),
        (
            "INVEST_OLLAMA_GPU_CONFIRMED".to_string(),
            "false".to_string(),
        ),
        (
            "INVEST_OLLAMA_ALLOW_CPU_AI".to_string(),
            "false".to_string(),
        ),
        (
            "INVEST_OLLAMA_COMPUTE_BACKEND".to_string(),
            "unknown".to_string(),
        ),
        ("OLLAMA_NUM_PARALLEL".to_string(), max_parallel.to_string()),
        ("OLLAMA_MAX_LOADED_MODELS".to_string(), "1".to_string()),
    ];
    if let Some(num_gpu) = num_gpu {
        envs.push(("INVEST_OLLAMA_NUM_GPU".to_string(), num_gpu.to_string()));
    }
    envs
}

fn spawn_ollama_serve(
    app: &AppHandle,
    exe_path: &Path,
    base_url: &str,
    gpu_mode: &str,
    num_gpu: Option<i32>,
    gpu_backend: &str,
    gpu_load_limit_percent: u8,
    num_batch: u32,
    max_parallel: u8,
) -> DesktopResult<()> {
    let paths = resolve_app_paths(app)?;
    let logs_dir = PathBuf::from(paths.logs_dir);
    fs::create_dir_all(&logs_dir).map_err(|error| {
        DesktopError::io(
            "STORAGE_PERMISSION_DENIED",
            "Cannot create Ollama logs directory",
            error,
        )
    })?;
    let stdout_path = logs_dir.join("ollama-stdout.log");
    let stderr_path = logs_dir.join("ollama-stderr.log");
    rotate_log_if_needed(&stdout_path)?;
    rotate_log_if_needed(&stderr_path)?;
    let stdout = OpenOptions::new()
        .create(true)
        .append(true)
        .open(stdout_path)
        .map_err(|error| {
            DesktopError::io(
                "STORAGE_PERMISSION_DENIED",
                "Cannot open Ollama stdout log",
                error,
            )
        })?;
    let stderr = OpenOptions::new()
        .create(true)
        .append(true)
        .open(stderr_path)
        .map_err(|error| {
            DesktopError::io(
                "STORAGE_PERMISSION_DENIED",
                "Cannot open Ollama stderr log",
                error,
            )
        })?;
    let (host, port) = parse_host_port(base_url)
        .map_err(|error| DesktopError::new("ENGINE_INVALID_JSON", error, true))?;
    let mut command = Command::new(exe_path);
    command
        .arg("serve")
        .env("OLLAMA_HOST", format!("{host}:{port}"))
        .env("INVEST_OLLAMA_GPU_MODE", gpu_mode)
        .env("INVEST_OLLAMA_GPU_BACKEND", gpu_backend)
        .env(
            "INVEST_OLLAMA_GPU_LOAD_LIMIT_PERCENT",
            gpu_load_limit_percent.to_string(),
        )
        .env("INVEST_OLLAMA_NUM_BATCH", num_batch.to_string())
        .env("INVEST_OLLAMA_REQUEST_COOLDOWN_MS", "250")
        .env("OLLAMA_NUM_PARALLEL", max_parallel.to_string())
        .env("OLLAMA_MAX_LOADED_MODELS", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    if gpu_backend == "vulkan" {
        command.env("OLLAMA_LLM_LIBRARY", "vulkan");
        command.env("OLLAMA_VULKAN", "1");
    } else if gpu_backend == "cuda" {
        command.env("OLLAMA_LLM_LIBRARY", "cuda");
    }
    if let Some(num_gpu) = num_gpu {
        command.env("OLLAMA_NUM_GPU", num_gpu.to_string());
        command.env("INVEST_OLLAMA_NUM_GPU", num_gpu.to_string());
    }
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let child = command
        .spawn()
        .map_err(|error| DesktopError::io("ENGINE_CRASHED", "Cannot start Ollama", error))?;
    let _ = write_managed_process_marker(app, exe_path, base_url, child.id());
    Ok(())
}

fn write_managed_process_marker(
    app: &AppHandle,
    exe_path: &Path,
    base_url: &str,
    pid: u32,
) -> DesktopResult<()> {
    let path = managed_process_path(app)?;
    let parent = path.parent().ok_or_else(|| {
        DesktopError::new(
            "STORAGE_NOT_FOUND",
            "Cannot resolve Ollama managed process marker directory.",
            true,
        )
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        DesktopError::io(
            "STORAGE_PERMISSION_DENIED",
            "Cannot create Ollama managed process marker directory",
            error,
        )
    })?;
    let payload = json!({
        "managedBy": "InvestAnalyzer",
        "pid": pid,
        "exePath": exe_path.to_string_lossy(),
        "baseUrl": base_url,
        "startedAt": chrono_timestamp(),
    });
    fs::write(
        path,
        serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".to_string()),
    )
    .map_err(|error| {
        DesktopError::io(
            "STORAGE_PERMISSION_DENIED",
            "Cannot write Ollama managed process marker",
            error,
        )
    })
}

fn read_managed_process_marker(app: &AppHandle) -> Option<Value> {
    let path = managed_process_path(app).ok()?;
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

fn clear_managed_process_marker(app: &AppHandle) {
    if let Ok(path) = managed_process_path(app) {
        let _ = fs::remove_file(path);
    }
}

fn chrono_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    format!("{seconds}")
}

fn powershell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(windows)]
fn stop_known_ollama_processes(exe_path: &Path) -> DesktopResult<bool> {
    let target = exe_path.to_string_lossy().to_string();
    let script = format!(
        "$target = {}; $stopped = $false; \
         Get-CimInstance Win32_Process -Filter \"name = 'ollama.exe'\" | \
         Where-Object {{ $_.ExecutablePath -and ([string]$_.ExecutablePath).Equals($target, [System.StringComparison]::OrdinalIgnoreCase) }} | \
         ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force; $stopped = $true }}; \
         if ($stopped) {{ 'stopped' }} else {{ 'none' }}",
        powershell_single_quote(&target)
    );
    run_ollama_stop_script(&script)
}

#[cfg(windows)]
fn run_ollama_stop_script(script: &str) -> DesktopResult<bool> {
    let mut command = Command::new("powershell.exe");
    command.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
    ]);
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command.output().map_err(|error| {
        DesktopError::io(
            "ENGINE_CRASHED",
            "Cannot stop existing Ollama process",
            error,
        )
    })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(DesktopError::new(
            "ENGINE_CRASHED",
            format!(
                "Cannot stop existing Ollama process{}",
                if stderr.is_empty() {
                    ".".to_string()
                } else {
                    format!(": {stderr}")
                }
            ),
            true,
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).contains("stopped"))
}

#[cfg(not(windows))]
fn stop_known_ollama_processes(_exe_path: &Path) -> DesktopResult<bool> {
    Ok(false)
}

/// Kogo `stop_ollama` ma zatrzymać. Tylko proces uruchomiony przez aplikację
/// (marker z PID) - serwer Ollama włączony przez użytkownika nie jest jej własnością.
#[derive(Debug, PartialEq)]
enum OllamaStopTarget {
    Managed { pid: u32, exe_path: Option<PathBuf> },
    NotManaged,
}

fn ollama_stop_target(marker: Option<&Value>) -> OllamaStopTarget {
    let Some(marker) = marker else {
        return OllamaStopTarget::NotManaged;
    };
    if marker.get("managedBy").and_then(Value::as_str) != Some("InvestAnalyzer") {
        return OllamaStopTarget::NotManaged;
    }
    let pid = marker
        .get("pid")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .filter(|pid| *pid > 0);
    let Some(pid) = pid else {
        return OllamaStopTarget::NotManaged;
    };
    let exe_path = marker
        .get("exePath")
        .and_then(Value::as_str)
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from);
    OllamaStopTarget::Managed { pid, exe_path }
}

/// Zatrzymuje proces `ollama.exe` o danym PID (tylko gdy jego ścieżka zgadza się
/// z zapisaną w markerze - PID mógł zostać oddany innemu programowi) razem z jego
/// potomkami `ollama.exe` (procesy robocze modelu).
#[cfg(windows)]
fn stop_managed_ollama_process(pid: u32, exe_path: &Path) -> DesktopResult<bool> {
    let target = exe_path.to_string_lossy().to_string();
    let script = format!(
        "$target = {}; $rootPid = {pid}; \
         $all = @(Get-CimInstance Win32_Process -Filter \"name = 'ollama.exe'\"); \
         $root = $all | Where-Object {{ $_.ProcessId -eq $rootPid -and $_.ExecutablePath -and ([string]$_.ExecutablePath).Equals($target, [System.StringComparison]::OrdinalIgnoreCase) }}; \
         if (-not $root) {{ 'none'; exit }}; \
         $ids = New-Object 'System.Collections.Generic.HashSet[int]'; [void]$ids.Add([int]$rootPid); \
         do {{ $added = $false; foreach ($p in $all) {{ if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)) {{ [void]$ids.Add([int]$p.ProcessId); $added = $true }} }} }} while ($added); \
         foreach ($id in $ids) {{ Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }}; 'stopped'",
        powershell_single_quote(&target)
    );
    run_ollama_stop_script(&script)
}

#[cfg(not(windows))]
fn stop_managed_ollama_process(_pid: u32, _exe_path: &Path) -> DesktopResult<bool> {
    Ok(false)
}
fn wait_for_ollama_shutdown(base_url: &str, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if http_get_json(base_url, "/api/tags", Duration::from_millis(300)).is_err() {
            return;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

fn wait_for_ollama_start(app: AppHandle, require_gpu: bool, takeover: bool) -> OllamaEnsureResult {
    let deadline = Instant::now() + Duration::from_secs(12);
    let mut latest = build_status(&app);
    while Instant::now() < deadline {
        if latest.server_running {
            if require_gpu {
                latest = test_ollama_gpu_internal(app.clone(), true);
            }
            return OllamaEnsureResult {
                started: true,
                already_running: false,
                message: if require_gpu && !latest.gpu_confirmed {
                    if takeover {
                        "Ollama przejęta i uruchomiona przez aplikację, ale GPU nadal nie jest potwierdzone. AI pozostaje wyłączona.".to_string()
                    } else {
                        "Ollama uruchomiona, ale GPU nie jest potwierdzone. AI pozostaje wyłączona."
                            .to_string()
                    }
                } else if takeover {
                    "Ollama przejęta przez aplikację i GPU potwierdzone. AI może działać."
                        .to_string()
                } else {
                    "Ollama uruchomiona.".to_string()
                },
                status: latest,
            };
        }
        std::thread::sleep(Duration::from_millis(400));
        latest = build_status(&app);
    }
    latest.error = Some(
        latest
            .error
            .unwrap_or_else(|| "Timeout startu Ollama.".to_string()),
    );
    OllamaEnsureResult {
        started: false,
        already_running: false,
        status: latest,
        message: "Ollama nie zaczęła odpowiadać w limicie czasu.".to_string(),
    }
}

#[tauri::command]
pub fn get_ollama_status(app: AppHandle) -> OllamaRuntimeStatus {
    build_status(&app)
}

#[tauri::command]
pub fn list_ollama_models(app: AppHandle) -> Vec<OllamaModelInfo> {
    build_status(&app).models
}

fn test_ollama_gpu_internal(app: AppHandle, allow_generate_probe: bool) -> OllamaRuntimeStatus {
    let mut status = build_status(&app);
    if !status.server_running {
        status.gpu_probe_status = "fail".to_string();
        status.gpu_failure_reason =
            Some("Ollama nie działa, więc GPU nie może zostać potwierdzone.".to_string());
        status.available = false;
        return status;
    }
    let lines = read_ollama_logs(&app);
    let (confirmed, backend, probe_status, reason, evidence) = parse_gpu_probe_from_logs(&lines);
    if confirmed || backend == "cpu" {
        status.gpu_confirmed = confirmed;
        status.compute_backend = backend;
        status.gpu_probe_status = probe_status;
        status.gpu_failure_reason = reason;
        status.log_evidence = evidence;
        status.available = status.server_running && status.model_available && status.gpu_confirmed;
        return status;
    }
    if !allow_generate_probe {
        status.gpu_confirmed = false;
        status.compute_backend = "unknown".to_string();
        status.gpu_probe_status = "fail".to_string();
        status.gpu_failure_reason = Some(
            "Nie uruchamiam promptu GPU probe na zewnętrznym procesie Ollama bez dowodów GPU. Zamknij Ollama z tray i uruchom ją z aplikacji.".to_string(),
        );
        status.log_evidence = evidence;
        status.available = false;
        return status;
    }
    if !status.model_available {
        status.gpu_probe_status = "fail".to_string();
        status.gpu_failure_reason = Some(format!(
            "Model {} nie jest pobrany. Nie uruchamiam CPU fallbacku.",
            status
                .model
                .clone()
                .unwrap_or_else(|| DEFAULT_OLLAMA_MODEL.to_string())
        ));
        status.available = false;
        return status;
    }
    let model = status
        .model
        .clone()
        .unwrap_or_else(|| DEFAULT_OLLAMA_MODEL.to_string());
    let probe = json!({
        "model": model,
        "prompt": "Return exactly: {\"ok\":true}",
        "stream": false,
        "keep_alive": "30s",
        "options": {
            "temperature": 0,
            "num_gpu": status.num_gpu.unwrap_or(-1),
            "num_batch": status.num_batch
        }
    });
    if let Err(error) = http_post_json(
        &status.base_url,
        "/api/generate",
        &probe,
        Duration::from_secs(60),
    ) {
        status.gpu_probe_status = "fail".to_string();
        status.gpu_failure_reason = Some(format!("GPU probe Ollama nie powiodl sie: {error}"));
        status.available = false;
        return status;
    }
    attach_gpu_probe(&mut status, &app);
    status
}

#[tauri::command]
pub fn test_ollama_gpu(app: AppHandle) -> OllamaRuntimeStatus {
    test_ollama_gpu_internal(app, false)
}

#[tauri::command]
pub fn set_ollama_config(app: AppHandle, config: OllamaConfig) -> DesktopResult<()> {
    if let Some(base_url) = config
        .base_url
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        if !is_loopback_url(base_url) {
            return Err(DesktopError::new(
                "ENGINE_INVALID_JSON",
                "Ollama endpoint must be local loopback HTTP.",
                true,
            ));
        }
    }
    if let Some(exe_path) = config
        .exe_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        if !exe_path_is_allowed(Path::new(exe_path)) {
            return Err(DesktopError::new(
                "UNSUPPORTED_FILE_TYPE",
                "Ollama executable path must point to an existing ollama.exe.",
                true,
            ));
        }
    }
    if let Some(gpu_mode) = config
        .gpu_mode
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        if !matches!(gpu_mode, "gpu" | "auto") {
            return Err(DesktopError::new(
                "ENGINE_INVALID_JSON",
                "Ollama GPU mode must be gpu or auto. CPU fallback is disabled.",
                true,
            ));
        }
    }
    if let Some(gpu_backend) = config
        .gpu_backend
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        if !matches!(gpu_backend, "vulkan" | "rocm" | "cuda" | "auto") {
            return Err(DesktopError::new(
                "ENGINE_INVALID_JSON",
                "Ollama GPU backend must be vulkan, rocm, cuda or auto.",
                true,
            ));
        }
    }
    if let Some(limit) = config.gpu_load_limit_percent {
        if !(50..=95).contains(&limit) {
            return Err(DesktopError::new(
                "ENGINE_INVALID_JSON",
                "Ollama GPU soft limit must be between 50 and 95 percent.",
                true,
            ));
        }
    }
    if let Some(max_parallel) = config.max_parallel {
        if !(1..=2).contains(&max_parallel) {
            return Err(DesktopError::new(
                "ENGINE_INVALID_JSON",
                "Ollama parallelism must be 1 or 2.",
                true,
            ));
        }
    }
    save_config(&app, &config)
}

#[tauri::command]
pub fn ensure_ollama_running(
    app: AppHandle,
    options: Option<OllamaEnsureOptions>,
) -> OllamaEnsureResult {
    let options = options.unwrap_or_default();
    let require_gpu = options.require_gpu.unwrap_or(false);
    let restart_if_gpu_unconfirmed = options.restart_if_gpu_unconfirmed.unwrap_or(false);
    let before = build_status(&app);
    if before.server_running {
        let status = if require_gpu {
            test_ollama_gpu_internal(app.clone(), false)
        } else {
            before
        };
        if require_gpu && !status.gpu_confirmed && restart_if_gpu_unconfirmed {
            let exe_path = match status.exe_path.clone() {
                Some(path) => PathBuf::from(path),
                None => {
                    return OllamaEnsureResult {
                        started: false,
                        already_running: true,
                        status,
                        message: "Ollama działa, ale nie znam ścieżki ollama.exe. Nie mogę bezpiecznie przejąć procesu.".to_string(),
                    };
                }
            };
            match stop_known_ollama_processes(&exe_path) {
                Ok(stopped) => {
                    if stopped {
                        wait_for_ollama_shutdown(&status.base_url, Duration::from_secs(6));
                    }
                }
                Err(error) => {
                    let mut failed = status;
                    failed.error = Some(error.to_string());
                    return OllamaEnsureResult {
                        started: false,
                        already_running: true,
                        status: failed,
                        message: "Nie udało się przejąć zewnętrznej Ollama.".to_string(),
                    };
                }
            }
            let after_stop = build_status(&app);
            if after_stop.server_running {
                return OllamaEnsureResult {
                    started: false,
                    already_running: true,
                    status: after_stop,
                    message: "Nie udało się zatrzymać zewnętrznej Ollama. Zamknij ją z tray i spróbuj ponownie.".to_string(),
                };
            }
            if let Err(error) = spawn_ollama_serve(
                &app,
                &exe_path,
                &status.base_url,
                &status.gpu_mode,
                status.num_gpu,
                &status.gpu_backend,
                status.gpu_load_limit_percent,
                status.num_batch,
                status.max_parallel,
            ) {
                let mut failed = build_status(&app);
                failed.error = Some(error.to_string());
                return OllamaEnsureResult {
                    started: false,
                    already_running: false,
                    status: failed,
                    message: "Nie udało się uruchomić Ollama po przejęciu procesu.".to_string(),
                };
            }
            return wait_for_ollama_start(app, require_gpu, true);
        }
        return OllamaEnsureResult {
            started: false,
            already_running: true,
            message: if require_gpu && !status.gpu_confirmed {
                "Ollama działa, ale GPU nie jest potwierdzone. AI pozostaje wyłączona.".to_string()
            } else {
                "Ollama już działa.".to_string()
            },
            status,
        };
    }
    let exe_path = match before.exe_path.clone() {
        Some(path) => PathBuf::from(path),
        None => {
            return OllamaEnsureResult {
                started: false,
                already_running: false,
                status: before,
                message: "Nie znaleziono ollama.exe. Ustaw ścieżkę w konfiguracji albo zainstaluj Ollama.".to_string(),
            };
        }
    };
    if let Err(error) = spawn_ollama_serve(
        &app,
        &exe_path,
        &before.base_url,
        &before.gpu_mode,
        before.num_gpu,
        &before.gpu_backend,
        before.gpu_load_limit_percent,
        before.num_batch,
        before.max_parallel,
    ) {
        let mut failed = build_status(&app);
        failed.error = Some(error.to_string());
        return OllamaEnsureResult {
            started: false,
            already_running: false,
            status: failed,
            message: "Nie udało się uruchomić Ollama.".to_string(),
        };
    }
    wait_for_ollama_start(app, require_gpu, false)
}

#[tauri::command]
pub fn stop_ollama(app: AppHandle) -> OllamaStopResult {
    let current_status = build_status(&app);
    let marker = read_managed_process_marker(&app);
    // Bez markera z PID aplikacja sama Ollamy nie uruchomiła (albo już ją
    // zatrzymała), więc nie zabijamy nic: serwer mógł włączyć użytkownik.
    let (pid, marker_exe) = match ollama_stop_target(marker.as_ref()) {
        OllamaStopTarget::Managed { pid, exe_path } => (pid, exe_path),
        OllamaStopTarget::NotManaged => {
            return OllamaStopResult {
                stopped: false,
                status: current_status,
                message: "Ollama nie została uruchomiona przez aplikację - zostawiam ją włączoną."
                    .to_string(),
            };
        }
    };
    let exe_path = match marker_exe.or_else(|| current_status.exe_path.clone().map(PathBuf::from)) {
        Some(path) => path,
        None => {
            clear_managed_process_marker(&app);
            return OllamaStopResult {
                stopped: false,
                status: current_status,
                message: "Nie znaleziono ścieżki ollama.exe do zatrzymania.".to_string(),
            };
        }
    };
    let base_url = marker
        .as_ref()
        .and_then(|value| value.get("baseUrl"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .unwrap_or(current_status.base_url);
    match stop_managed_ollama_process(pid, &exe_path) {
        Ok(stopped) => {
            if stopped {
                wait_for_ollama_shutdown(&base_url, Duration::from_secs(6));
            }
            clear_managed_process_marker(&app);
            OllamaStopResult {
                stopped,
                status: build_status(&app),
                message: if stopped {
                    "Ollama zatrzymana po zakończeniu pracy AI.".to_string()
                } else {
                    "Nie znaleziono aktywnego procesu Ollama uruchomionego przez aplikację."
                        .to_string()
                },
            }
        }
        Err(error) => {
            let mut status = build_status(&app);
            status.error = Some(error.to_string());
            OllamaStopResult {
                stopped: false,
                status,
                message: "Nie udało się zatrzymać Ollama.".to_string(),
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_host_port_accepts_loopback_defaults() {
        assert_eq!(
            parse_host_port("http://127.0.0.1:11434").unwrap(),
            ("127.0.0.1".to_string(), 11434)
        );
        assert_eq!(
            parse_host_port("http://localhost").unwrap(),
            ("localhost".to_string(), 11434)
        );
        assert_eq!(
            parse_host_port("http://[::1]:11434").unwrap(),
            ("::1".to_string(), 11434)
        );
    }

    #[test]
    fn loopback_guard_rejects_public_urls() {
        assert!(is_loopback_url("http://127.0.0.1:11434"));
        assert!(is_loopback_url("http://localhost:11434"));
        assert!(!is_loopback_url("https://127.0.0.1:11434"));
        assert!(!is_loopback_url("http://example.com:11434"));
    }

    #[test]
    fn parses_ollama_tags_models() {
        let models = parse_tags_response(&json!({
            "models": [
                { "name": "qwen3:14b", "size": 123, "digest": "abc", "modified_at": "2026-05-18T00:00:00Z" }
            ]
        }));
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].name, "qwen3:14b");
        assert_eq!(models[0].size, Some(123));
    }

    #[test]
    fn chooses_installed_qwen_fallback_when_default_is_missing() {
        let models = parse_tags_response(&json!({
            "models": [
                { "name": "qwen3:8b", "size": 123 }
            ]
        }));
        assert_eq!(choose_effective_model(None, &models), "qwen3:8b");
        assert_eq!(
            choose_effective_model(Some("custom:model".to_string()), &models),
            "custom:model"
        );
    }

    #[test]
    fn gpu_defaults_force_gpu_with_vulkan_and_safe_limits() {
        let gpu_mode = configured_gpu_mode(None);
        assert_eq!(gpu_mode, "gpu");
        assert_eq!(configured_num_gpu(None, &gpu_mode), Some(-1));
        assert_eq!(configured_gpu_backend(None), "vulkan");
        assert_eq!(configured_gpu_load_limit_percent(None), 85);
        assert_eq!(configured_num_batch(None, 85), 128);
        assert_eq!(configured_max_parallel(None), 1);
    }

    #[test]
    fn cpu_mode_is_not_accepted_by_desktop_config() {
        assert_eq!(configured_gpu_mode(Some("cpu")), "gpu");
        assert_eq!(configured_num_gpu(None, "gpu"), Some(-1));
        assert_eq!(configured_num_gpu(Some(0), "gpu"), Some(-1));
    }

    #[test]
    fn gpu_probe_rejects_cpu_evidence() {
        let lines = vec![
            "llama.cpp loaded CPU backend".to_string(),
            "llama_model_load: CPU model buffer size = 123 MiB".to_string(),
            "llama_new_context_with_model: CPU KV buffer size = 456 MiB".to_string(),
        ];
        let (confirmed, backend, status, reason, evidence) = parse_gpu_probe_from_logs(&lines);
        assert!(!confirmed);
        assert_eq!(backend, "cpu");
        assert_eq!(status, "fail");
        assert!(reason.unwrap().contains("CPU backend"));
        assert!(!evidence.is_empty());
    }

    #[test]
    fn gpu_probe_accepts_gpu_evidence() {
        let lines = vec![
            "Dynamic LLM libraries [cpu vulkan]".to_string(),
            "llama_new_context_with_model: GPU KV buffer size = 456 MiB".to_string(),
            "inference compute id=gpu library=vulkan".to_string(),
        ];
        let (confirmed, backend, status, reason, evidence) = parse_gpu_probe_from_logs(&lines);
        assert!(confirmed);
        assert_eq!(backend, "gpu");
        assert_eq!(status, "pass");
        assert!(reason.is_none());
        assert!(!evidence.is_empty());
    }

    #[test]
    fn gpu_probe_accepts_vulkan_even_when_cpu_backend_is_loaded() {
        let lines = vec![
            "time=2026-05-19T20:34:52 level=INFO source=types.go:42 msg=\"inference compute\" library=Vulkan name=Vulkan0 description=\"AMD Radeon RX 9070 XT\" type=discrete".to_string(),
            "time=2026-05-19T20:34:51 level=INFO source=routes.go:1752 msg=\"server config\" env=\"map[OLLAMA_LLM_LIBRARY:vulkan OLLAMA_NUM_PARALLEL:1]\"".to_string(),
            "load_backend: loaded CPU backend from C:\\Users\\TestUser\\AppData\\Local\\Programs\\OllamaCLI\\lib\\ollama\\ggml-cpu-icelake.dll".to_string(),
        ];
        let (confirmed, backend, status, reason, evidence) = parse_gpu_probe_from_logs(&lines);
        assert!(confirmed);
        assert_eq!(backend, "gpu");
        assert_eq!(status, "pass");
        assert!(reason.is_none());
        assert!(evidence.iter().any(|line| line.contains("Vulkan")));
    }

    #[test]
    fn gpu_probe_ignores_old_cpu_evidence_before_latest_server_config() {
        let lines = vec![
            "time=2026-05-19T20:34:52 level=INFO source=device.go:240 msg=\"model weights\" device=Vulkan0 size=\"8.2 GiB\"".to_string(),
            "time=2026-05-19T20:34:51 level=INFO source=routes.go:1752 msg=\"server config\" env=\"map[OLLAMA_LLM_LIBRARY:vulkan]\"".to_string(),
            "time=2026-05-19T18:00:00 level=INFO source=device.go:240 msg=\"model weights\" device=CPU size=\"8.2 GiB\"".to_string(),
            "llama_model_load: CPU model buffer size = 123 MiB".to_string(),
        ];
        let (confirmed, backend, status, reason, evidence) = parse_gpu_probe_from_logs(&lines);
        assert!(confirmed);
        assert_eq!(backend, "gpu");
        assert_eq!(status, "pass");
        assert!(reason.is_none());
        assert!(evidence
            .iter()
            .all(|line| !line.contains("CPU model buffer")));
    }

    #[test]
    fn stop_ollama_targets_only_the_pid_from_the_apps_own_marker() {
        // Marker zapisany przez write_managed_process_marker.
        let marker = json!({
            "managedBy": "InvestAnalyzer", "pid": 4242,
            "exePath": "C:\\Users\\TestUser\\AppData\\Local\\Programs\\Ollama\\ollama.exe",
            "baseUrl": "http://127.0.0.1:11434", "startedAt": "1"
        });
        assert_eq!(
            ollama_stop_target(Some(&marker)),
            OllamaStopTarget::Managed {
                pid: 4242,
                exe_path: Some(PathBuf::from("C:\\Users\\TestUser\\AppData\\Local\\Programs\\Ollama\\ollama.exe")),
            }
        );
    }

    #[test]
    fn stop_ollama_does_not_touch_an_ollama_started_by_the_user() {
        // Brak markera: Ollame uruchomil uzytkownik, wiec nic nie zatrzymujemy.
        assert_eq!(ollama_stop_target(None), OllamaStopTarget::NotManaged);
        for marker in [
            json!({}),
            json!({"managedBy": "InvestAnalyzer"}),
            json!({"managedBy": "InvestAnalyzer", "pid": 0}),
            json!({"managedBy": "InvestAnalyzer", "pid": -5}),
            json!({"managedBy": "InvestAnalyzer", "pid": "4242"}),
            json!({"managedBy": "InvestAnalyzer", "pid": 99_999_999_999_u64}),
            json!({"managedBy": "inna-aplikacja", "pid": 4242}),
            json!({"pid": 4242}),
        ] {
            assert_eq!(ollama_stop_target(Some(&marker)), OllamaStopTarget::NotManaged, "{marker}");
        }
    }}
