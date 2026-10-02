use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::engine::errors::{DesktopError, DesktopResult};

/// Nazwa schematu zadania zapisywanego do request.json.
pub const REQUEST_CONTRACT_VERSION: &str = "investanalyzer.analysis-request.v1";

/// Opcjonalna sciezka do listy kwot z informacji PIT-8C w `request.overrides`.
pub const PIT8C_ENTRIES_PATH_FIELD: &str = "pit8c_path";

/// Nazwa schematu odpowiedzi silnika: result.json oraz error.json.
pub const RESULT_CONTRACT_VERSION: &str = "investanalyzer.analysis-result.v1";

/// Alias zachowany dla odczytu odpowiedzi silnika.
pub const CONTRACT_VERSION: &str = RESULT_CONTRACT_VERSION;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobIdResponse {
    pub job_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaxEngineJobStatus {
    pub job_id: String,
    pub state: String,
    pub stage: String,
    pub progress: u8,
    pub message: String,
    pub started_at: String,
    pub updated_at: String,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SidecarError {
    pub contract_version: String,
    pub status: String,
    pub run_id: String,
    pub error_code: String,
    pub message: String,
    pub details: Value,
    pub recoverable: bool,
}

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

pub fn queued_status(job_id: &str) -> TaxEngineJobStatus {
    let timestamp = now();
    TaxEngineJobStatus {
        job_id: job_id.to_string(),
        state: "queued".to_string(),
        stage: "preflight".to_string(),
        progress: 0,
        message: "Queued desktop tax engine job.".to_string(),
        started_at: timestamp.clone(),
        updated_at: timestamp,
        error_code: None,
    }
}

pub fn validate_contract_version(value: &Value, label: &str) -> DesktopResult<()> {
    match value.get("contract_version").and_then(Value::as_str) {
        Some(CONTRACT_VERSION) => Ok(()),
        Some(found) => Err(DesktopError::new(
            "ENGINE_CONTRACT_MISMATCH",
            format!("{label} contract version mismatch: expected {CONTRACT_VERSION}, got {found}."),
            true,
        )),
        None => Err(DesktopError::new(
            "ENGINE_CONTRACT_MISMATCH",
            format!("{label} is missing contract_version."),
            true,
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validate_contract_version_accepts_current_version() {
        let payload = json!({ "contract_version": CONTRACT_VERSION });

        assert!(validate_contract_version(&payload, "result").is_ok());
    }

    #[test]
    fn validate_contract_version_rejects_missing_or_mismatched_version() {
        let missing = json!({});
        let mismatched = json!({ "contract_version": "2.0" });

        let missing_error = validate_contract_version(&missing, "result").unwrap_err();
        let mismatched_error = validate_contract_version(&mismatched, "result").unwrap_err();

        assert_eq!(missing_error.error_code, "ENGINE_CONTRACT_MISMATCH");
        assert_eq!(mismatched_error.error_code, "ENGINE_CONTRACT_MISMATCH");
    }

    #[test]
    fn validate_contract_version_rejects_legacy_numeric_version() {
        // Kontrakt uzywa nazwanych schematow; stare "1.0" nie moze przejsc.
        let legacy = json!({ "contract_version": "1.0" });

        let error = validate_contract_version(&legacy, "result").unwrap_err();

        assert_eq!(error.error_code, "ENGINE_CONTRACT_MISMATCH");
    }

    #[test]
    fn validate_contract_version_rejects_request_schema_in_result_slot() {
        // Zadanie i odpowiedz maja rozne schematy - pomylenie ich to blad.
        let request_schema = json!({ "contract_version": REQUEST_CONTRACT_VERSION });

        let error = validate_contract_version(&request_schema, "result").unwrap_err();

        assert_eq!(error.error_code, "ENGINE_CONTRACT_MISMATCH");
    }
}
