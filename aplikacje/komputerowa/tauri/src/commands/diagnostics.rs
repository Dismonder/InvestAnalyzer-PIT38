use crate::commands::app_paths::resolve_app_paths;
use crate::commands::storage::{list_storage_files, StorageFile};
use crate::engine::errors::{DesktopError, DesktopResult};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsExportOptions {
    pub mode: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsExportResult {
    pub path: String,
    pub redacted: bool,
}

#[tauri::command]
pub fn export_diagnostics_bundle(
    app: AppHandle,
    options: DiagnosticsExportOptions,
) -> DesktopResult<DiagnosticsExportResult> {
    let paths = resolve_app_paths(&app)?;
    let mode = normalize_mode(&options.mode);
    let artifacts_dir = PathBuf::from(&paths.artifacts_dir);
    fs::create_dir_all(&artifacts_dir).map_err(|error| {
        DesktopError::io(
            "STORAGE_PERMISSION_DENIED",
            "Cannot create artifacts directory",
            error,
        )
    })?;
    let filename = format!(
        "invest-analyzer-diagnostics-{}.json",
        chrono::Utc::now().format("%Y%m%d-%H%M%S")
    );
    let target = artifacts_dir.join(filename);
    let storage_files = list_storage_files(app.clone()).unwrap_or_default();
    let runs_dir = PathBuf::from(&paths.runs_dir);
    let latest_run_dir = latest_run_dir(&runs_dir);
    // Sol losowa na eksport, nigdzie nie zapisywana: skrotow nie da sie odtworzyc
    // slownikiem nazw ani porownac miedzy eksportami. Stad "pseudonimizowany".
    let sol = nowa_sol();
    let payload = json!({
        "appVersion": app.package_info().version.to_string(),
        "runtime": "tauri",
        "mode": mode,
        "generatedAt": chrono::Utc::now().to_rfc3339(),
        "appPaths": sanitize_paths(&paths, mode, &sol),
        "storageSummary": storage_summary(&storage_files),
        "storageManifest": sanitize_storage_manifest(&storage_files, mode, &sol),
        "lastRunManifest": latest_run_dir
            .as_ref()
            .and_then(|dir| read_json_file(&dir.join("run_manifest.json")))
            .map(|manifest| sanitize_run_manifest(manifest, mode, &sol)),
        "lastError": latest_run_dir
            .as_ref()
            .and_then(|dir| read_json_file(&dir.join("error.json")))
            .map(|error| sanitize_error(error, mode)),
        "note": "Safe diagnostics do not include raw broker file contents. Full mode is local-only and may include local paths and filenames.",
    });
    fs::write(
        &target,
        serde_json::to_vec_pretty(&payload).unwrap_or_default(),
    )
    .map_err(|error| {
        DesktopError::io(
            "STORAGE_PERMISSION_DENIED",
            "Cannot write diagnostics file",
            error,
        )
    })?;
    Ok(DiagnosticsExportResult {
        path: target.to_string_lossy().to_string(),
        redacted: mode != "full",
    })
}

fn normalize_mode(mode: &str) -> &str {
    match mode {
        "full" => "full",
        "anonymized" => "anonymized",
        _ => "safe",
    }
}

fn nowa_sol() -> Vec<u8> {
    let mut sol = uuid::Uuid::new_v4().as_bytes().to_vec();
    sol.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    sol
}

/// HMAC-SHA256 z sola eksportu jako kluczem.
fn hash_text(sol: &[u8], value: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(sol).expect("HMAC przyjmuje klucz dowolnej dlugosci");
    mac.update(value.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

fn basename(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_string()
}

fn sanitize_path(path: &str, mode: &str, sol: &[u8]) -> Value {
    match mode {
        "full" => json!(path),
        "anonymized" => json!({ "basename": basename(path), "pathHash": hash_text(sol, path) }),
        _ => json!("<redacted>"),
    }
}

fn sanitize_paths(paths: &crate::commands::app_paths::AppPaths, mode: &str, sol: &[u8]) -> Value {
    json!({
        "dataDir": sanitize_path(&paths.data_dir, mode, sol),
        "storageDir": sanitize_path(&paths.storage_dir, mode, sol),
        "artifactsDir": sanitize_path(&paths.artifacts_dir, mode, sol),
        "runsDir": sanitize_path(&paths.runs_dir, mode, sol),
        "logsDir": sanitize_path(&paths.logs_dir, mode, sol),
        "cacheDir": sanitize_path(&paths.cache_dir, mode, sol),
        "tempDir": sanitize_path(&paths.temp_dir, mode, sol),
    })
}

fn sanitize_storage_file(file: &StorageFile, mode: &str, sol: &[u8]) -> Value {
    match mode {
        "full" => serde_json::to_value(file).unwrap_or_else(|_| json!({})),
        "anonymized" => json!({
            "relativePathHash": hash_text(sol, &file.relative_path),
            "fileNameHash": hash_text(sol, &file.file_name),
            "extension": file.extension,
            "sizeBytes": file.size_bytes,
            "modifiedAt": file.modified_at,
            "sha256": file.sha256.as_deref().map(|skrot| hash_text(sol, skrot)),
            "sourceStatus": file.source_status,
        }),
        _ => json!({
            "extension": file.extension,
            "sizeBytes": file.size_bytes,
            "modifiedAt": file.modified_at,
            "sourceStatus": file.source_status,
        }),
    }
}

fn sanitize_storage_manifest(files: &[StorageFile], mode: &str, sol: &[u8]) -> Vec<Value> {
    files
        .iter()
        .map(|file| sanitize_storage_file(file, mode, sol))
        .collect()
}

fn storage_summary(files: &[StorageFile]) -> Value {
    let total_bytes = files.iter().map(|file| file.size_bytes).sum::<u64>();
    let mut extensions = std::collections::BTreeMap::<String, usize>::new();
    for file in files {
        *extensions.entry(file.extension.clone()).or_insert(0) += 1;
    }
    json!({
        "fileCount": files.len(),
        "totalBytes": total_bytes,
        "extensions": extensions,
    })
}

fn latest_run_dir(runs_dir: &Path) -> Option<PathBuf> {
    let mut entries = fs::read_dir(runs_dir)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            if !metadata.is_dir() {
                return None;
            }
            let modified = metadata.modified().ok()?;
            Some((entry.path(), modified))
        })
        .collect::<Vec<_>>();
    entries.sort_by_key(|(_, modified)| std::cmp::Reverse(*modified));
    entries.into_iter().map(|(path, _)| path).next()
}

fn read_json_file(path: &Path) -> Option<Value> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&text).ok()
}

/// Rozszerzenia wyciagow, ktorych nazwy zdradzaja brokera, konto albo okres.
const ROZSZERZENIA_WYCIAGOW: [&str; 5] = [".json", ".xlsx", ".csv", ".pdf", ".xml"];

/// Komunikat z sidecara bywa `str(exc)`: bezwzgledna sciezka z nazwa uzytkownika,
/// nazwa wyciagu i wartosci wpisane przez uzytkownika. Kolejnosc ma znaczenie:
/// najpierw wartosci w cudzyslowach (obejmuja tez sciezki w cudzyslowach), potem
/// sciezki, na koncu nazwy plikow. Maskowanie woli za duzo niz za malo.
pub(crate) fn mask_error_message(message: &str) -> String {
    mask_file_names(&mask_paths(&mask_quoted_values(message)))
}

/// Najdluzsza wartosc w cudzyslowie, jaka maskujemy; dalsze zamkniecie to zwykle
/// przypadkowy apostrof z innego miejsca tekstu.
const MAX_DLUGOSC_WARTOSCI: usize = 200;

/// Apostrof miedzy dwiema literami ("Can't") jest czescia slowa, nie cudzyslowem.
fn is_word_apostrophe(chars: &[char], i: usize) -> bool {
    chars[i] == '\''
        && i > 0
        && chars[i - 1].is_alphanumeric()
        && chars.get(i + 1).is_some_and(|c| c.is_alphanumeric())
}

/// Maskuje tylko segmenty z pasujacym zamknieciem (ten sam znak, ta sama linia,
/// rozsadna dlugosc). Niedomkniety cudzyslow zostaje zwyklym znakiem, zeby nie
/// zamazywac reszty komunikatu.
fn mask_quoted_values(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut result = String::new();
    let mut i = 0;
    while i < chars.len() {
        let closing = match chars[i] {
            '"' => Some('"'),
            '\'' if !is_word_apostrophe(&chars, i) => Some('\''),
            '„' | '“' => Some('”'),
            _ => None,
        };
        let end = closing.and_then(|closing| {
            (i + 1..chars.len().min(i + 2 + MAX_DLUGOSC_WARTOSCI))
                .take_while(|&j| chars[j] != '\n' && chars[j] != '\r')
                .find(|&j| chars[j] == closing && !is_word_apostrophe(&chars, j))
        });
        match end {
            Some(end) => {
                result.push_str("<value>");
                i = end + 1;
            }
            None => {
                result.push(chars[i]);
                i += 1;
            }
        }
    }
    result
}

fn is_path_terminator(c: char) -> bool {
    c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>' | '|' | '*' | '?')
}

fn starts_path(chars: &[char], i: usize) -> bool {
    let c = chars[i];
    let next = chars.get(i + 1).copied();
    let previous_is_word = i > 0 && chars[i - 1].is_alphanumeric();
    if previous_is_word {
        return false;
    }
    if c.is_ascii_alphabetic() {
        return next == Some(':') && matches!(chars.get(i + 2), Some('\\') | Some('/'));
    }
    if c == '\\' {
        return next == Some('\\');
    }
    // POSIX: '/' po spacji, na poczatku albo po '(' / '=' / ':', zaraz przed znakiem nazwy.
    c == '/'
        && (i == 0 || chars[i - 1].is_whitespace() || matches!(chars[i - 1], '(' | '=' | ':'))
        && next.is_some_and(|n| n.is_alphanumeric() || matches!(n, '.' | '_' | '~' | '-'))
}

/// Czy slowo zaczynajace sie w `start` jest dalszym ciagiem sciezki: zawiera
/// separator albo konczy sie rozszerzeniem wyciagu.
fn word_continues_path(chars: &[char], start: usize) -> bool {
    let word: String = chars[start..].iter().take_while(|c| !is_path_terminator(**c)).collect();
    let lower = word.trim_end_matches(['.', ',', ';', ':', ')']).to_lowercase();
    word.contains(['\\', '/']) || ROZSZERZENIA_WYCIAGOW.iter().any(|ext| lower.ends_with(ext))
}

fn mask_paths(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut result = String::new();
    let mut i = 0;
    while i < chars.len() {
        if !starts_path(&chars, i) {
            result.push(chars[i]);
            i += 1;
            continue;
        }
        let mut end = i;
        loop {
            while end < chars.len() && !is_path_terminator(chars[end]) {
                end += 1;
            }
            // Spacja w srodku sciezki ("Jan Kowalski"): szukamy dalej, o ile w ciagu
            // kilku slow trafi sie element z separatorem albo nazwa wyciagu.
            let mut probe = end;
            let mut words = 0;
            let mut continues = None;
            while probe < chars.len() && chars[probe] == ' ' && words < 4 {
                let word_start = probe + 1;
                if word_start >= chars.len() || is_path_terminator(chars[word_start]) {
                    break;
                }
                if word_continues_path(&chars, word_start) {
                    continues = Some(word_start);
                    break;
                }
                probe = word_start;
                while probe < chars.len() && !is_path_terminator(chars[probe]) {
                    probe += 1;
                }
                words += 1;
            }
            match continues {
                Some(word_start) => end = word_start,
                None => break,
            }
        }
        // Interpunkcja konczaca zdanie nie nalezy do sciezki.
        while end > i + 1 && matches!(chars[end - 1], '.' | ',' | ';' | ':' | ')') {
            end -= 1;
        }
        result.push_str("<path>");
        i = end;
    }
    result
}

fn mask_file_names(text: &str) -> String {
    let mut result = String::new();
    let mut token = String::new();
    let flush = |token: &mut String, result: &mut String| {
        let lower = token.to_lowercase();
        let is_file = ROZSZERZENIA_WYCIAGOW
            .iter()
            .any(|ext| lower.ends_with(ext) && lower.len() > ext.len());
        result.push_str(if is_file { "<file>" } else { token });
        token.clear();
    };
    for c in text.chars() {
        if c.is_alphanumeric() || matches!(c, '_' | '-' | '.' | '+') {
            token.push(c);
        } else {
            flush(&mut token, &mut result);
            result.push(c);
        }
    }
    flush(&mut token, &mut result);
    result
}

fn sanitize_error(error: Value, mode: &str) -> Value {
    if mode == "full" {
        return error;
    }
    json!({
        "contract_version": error.get("contract_version").cloned().unwrap_or(Value::Null),
        "status": error.get("status").cloned().unwrap_or(Value::Null),
        "error_code": error.get("error_code").cloned().unwrap_or(Value::Null),
        "message": match error.get("message") {
            Some(Value::String(message)) => json!(mask_error_message(message)),
            // Obiekt albo tablica moga niesc sciezki i wartosci uzytkownika.
            Some(Value::Null) | None => Value::Null,
            Some(other) => json!(mask_error_message(&other.to_string())),
        },
        "recoverable": error.get("recoverable").cloned().unwrap_or(Value::Null),
    })
}

fn sanitize_run_manifest(mut manifest: Value, mode: &str, sol: &[u8]) -> Value {
    if mode == "full" {
        return manifest;
    }
    if let Some(input_files) = manifest.get("inputFiles").and_then(Value::as_array) {
        let sanitized = input_files
            .iter()
            .filter_map(|file| serde_json::from_value::<StorageFile>(file.clone()).ok())
            .map(|file| sanitize_storage_file(&file, mode, sol))
            .collect::<Vec<_>>();
        manifest["inputFiles"] = Value::Array(sanitized);
    }
    manifest
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_file() -> StorageFile {
        StorageFile {
            relative_path: "private/broker.json".to_string(),
            file_name: "broker.json".to_string(),
            extension: ".json".to_string(),
            size_bytes: 100,
            modified_at: "2026-05-17T00:00:00Z".to_string(),
            sha256: Some("abc".to_string()),
            source_status: "unknown".to_string(),
        }
    }

    #[test]
    fn safe_diagnostics_hide_file_names_and_paths() {
        let file = sample_file();
        let sanitized = sanitize_storage_file(&file, "safe", b"sol");

        assert!(sanitized.get("relativePath").is_none());
        assert!(sanitized.get("fileName").is_none());
        assert_eq!(sanitized["extension"], ".json");
    }

    #[test]
    fn komunikat_bledu_w_trybach_bez_full_nie_zawiera_sciezek_plikow_ani_wartosci() {
        let error = json!({
            "contract_version": "1", "status": "error", "error_code": "ENGINE_INPUT_INVALID",
            "recoverable": true,
            "message": r"Nie można wczytać C:\Users\TestUser\Documents\wyciag_2025.xlsx: {'amount': '1234,56'}"
        });
        for tryb in ["safe", "anonymized"] {
            let wynik = sanitize_error(error.clone(), tryb);
            let komunikat = wynik["message"].as_str().unwrap();
            for wyciek in ["TestUser", "Users", "wyciag_2025", "xlsx", "1234,56", "amount"] {
                assert!(!komunikat.contains(wyciek), "{tryb}: '{wyciek}' w '{komunikat}'");
            }
            assert!(komunikat.contains("<path>") && komunikat.contains("<value>"), "{komunikat}");
            assert_eq!(wynik["error_code"], "ENGINE_INPUT_INVALID");
            assert_eq!(wynik["status"], "error");
        }
        assert_eq!(sanitize_error(error.clone(), "full"), error);
    }

    #[test]
    fn maskowanie_komunikatu_obejmuje_posix_spacje_i_gole_nazwy_plikow() {
        let m = mask_error_message;
        assert_eq!(m("Brak /home/testuser/dane/a.csv w magazynie"), "Brak <path> w magazynie");
        assert_eq!(
            m(r"Błąd w C:\Users\TestUser Kowalski\Moje\raport.pdf oraz w drugim"),
            "Błąd w <path> oraz w drugim"
        );
        assert_eq!(m("Plik Wyciag_Q1.CSV jest pusty"), "Plik <file> jest pusty");
        assert_eq!(m("Wartość „1234,56” jest zła"), "Wartość <value> jest zła");
        assert_eq!(m("Rok 2025/01 i and/or bez zmian"), "Rok 2025/01 i and/or bez zmian");
    }

    #[test]
    fn apostrof_w_slowie_nie_otwiera_cudzyslowu_a_niedomkniety_nie_maskuje_reszty() {
        let m = mask_error_message;
        assert_eq!(m("Can't parse the input: value is bad"), "Can't parse the input: value is bad");
        assert_eq!(m("It isn't valid and doesn't fit"), "It isn't valid and doesn't fit");
        assert_eq!(m("Can't open 'a b' now"), "Can't open <value> now");
        assert_eq!(m("Brak pola 'amount' oraz 'currency'"), "Brak pola <value> oraz <value>");
        // Apostrof otwierajacy bez zamkniecia w tej samej linii zostaje zwyklym znakiem.
        assert_eq!(m("Wartosc 'niedomknieta\nDruga linia 'x"), "Wartosc 'niedomknieta\nDruga linia 'x");
        // Zamkniecie za daleko (ponad rozsadna dlugosc) nie jest cudzyslowem.
        let daleko = format!("Start 'a{}' koniec", "b".repeat(400));
        assert_eq!(m(&daleko), daleko);
    }

    #[test]
    fn komunikat_nietekstowy_jest_serializowany_i_maskowany() {
        let error = json!({"status": "error", "error_code": "X", "message": {"path": r"C:\Users\TestUser\wyciag.xlsx", "amount": "1234,56"}});
        let wynik = sanitize_error(error, "safe");
        let tekst = wynik["message"].to_string();
        assert!(!tekst.contains("TestUser") && !tekst.contains("1234") && !tekst.contains("wyciag"), "{tekst}");
        let lista = sanitize_error(json!({"message": ["'sekret'"]}), "anonymized");
        assert!(!lista["message"].to_string().contains("sekret"));
    }

    #[test]
    fn pseudonimizacja_nie_uzywa_nieosolonego_skrotu() {
        let file = sample_file();
        let nieosolony = |tekst: &str| hex::encode(<sha2::Sha256 as sha2::Digest>::digest(tekst.as_bytes()));
        let sanitized = sanitize_storage_file(&file, "anonymized", b"sol-eksportu");
        assert_ne!(sanitized["fileNameHash"], json!(nieosolony("broker.json")));
        assert_ne!(sanitized["relativePathHash"], json!(nieosolony("private/broker.json")));
        assert_ne!(sanitized["sha256"], json!("abc"), "skrót zawartości wyciągu nie może iść jawnie");
        let sciezka = sanitize_path("C:/Users/TestUser/dane", "anonymized", b"sol-eksportu");
        assert_ne!(sciezka["pathHash"], json!(nieosolony("C:/Users/TestUser/dane")));
    }

    #[test]
    fn skroty_zaleza_od_soli_eksportu_i_sa_stabilne_w_jego_obrebie() {
        let file = sample_file();
        let a1 = sanitize_storage_file(&file, "anonymized", b"sol-a");
        let a2 = sanitize_storage_file(&file, "anonymized", b"sol-a");
        let b = sanitize_storage_file(&file, "anonymized", b"sol-b");
        assert_eq!(a1, a2);
        assert_ne!(a1["fileNameHash"], b["fileNameHash"]);
        assert_ne!(a1["sha256"], b["sha256"]);
        assert_ne!(nowa_sol(), nowa_sol());
    }

    #[test]
    fn anonymized_diagnostics_hash_file_names() {
        let file = sample_file();
        let sanitized = sanitize_storage_file(&file, "anonymized", b"sol");

        assert!(sanitized.get("relativePathHash").is_some());
        assert!(sanitized.get("fileNameHash").is_some());
        assert!(sanitized.get("fileName").is_none());
    }
}
