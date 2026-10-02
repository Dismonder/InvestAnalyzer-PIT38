use crate::commands::storage::StorageFile;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunManifest {
    pub run_id: String,
    pub app_version: String,
    pub engine_version: Option<String>,
    pub contract_version: String,
    pub year: i64,
    pub source_selection_mode: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub duration_ms: Option<i64>,
    pub input_files: Vec<StorageFile>,
    pub audit_hash: Option<String>,
    pub status: String,
}

pub fn read_manifest(path: &Path) -> Option<RunManifest> {
    let payload = fs::read_to_string(path.join("run_manifest.json")).ok()?;
    serde_json::from_str::<RunManifest>(&payload).ok()
}

pub fn write_manifest(path: &Path, manifest: &RunManifest) {
    if let Ok(payload) = serde_json::to_vec_pretty(manifest) {
        let _ = fs::write(path.join("run_manifest.json"), payload);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::storage::StorageFile;

    #[test]
    fn manifest_roundtrip_preserves_input_files() {
        let dir = std::env::temp_dir().join(format!(
            "invest-analyzer-manifest-test-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        let manifest = RunManifest {
            run_id: "run-1".to_string(),
            app_version: "0.1.0".to_string(),
            engine_version: Some("engine".to_string()),
            contract_version: "1.0".to_string(),
            year: 2026,
            source_selection_mode: "canonical_stream".to_string(),
            started_at: "2026-05-17T00:00:00Z".to_string(),
            finished_at: None,
            duration_ms: None,
            input_files: vec![StorageFile {
                relative_path: "broker.json".to_string(),
                file_name: "broker.json".to_string(),
                extension: ".json".to_string(),
                size_bytes: 42,
                modified_at: "2026-05-17T00:00:00Z".to_string(),
                sha256: Some("abc".to_string()),
                source_status: "unknown".to_string(),
            }],
            audit_hash: Some("hash".to_string()),
            status: "ok".to_string(),
        };

        write_manifest(&dir, &manifest);
        let restored = read_manifest(&dir).unwrap();

        assert_eq!(restored.input_files.len(), 1);
        assert_eq!(restored.input_files[0].relative_path, "broker.json");
        let _ = fs::remove_dir_all(dir);
    }
}
