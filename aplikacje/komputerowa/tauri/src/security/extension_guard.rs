use crate::engine::errors::{DesktopError, DesktopResult};
use std::path::Path;

pub fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

/// Formaty, w ktorych brokerzy udostepniaja wyciagi, oraz dokumenty dowodowe.
///
/// Lista jest zamknieta celowo: katalog storage jest skanowany przez silnik,
/// a plik wykonywalny albo skrypt nie ma tam czego szukac. Kontrakt sidecara
/// przewiduje dla tego przypadku blad `UNSUPPORTED_FILE_TYPE`.
const ALLOWED_IMPORT_EXTENSIONS: &[&str] = &[
    "json", "csv", "tsv", "xlsx", "xlsm", "xls", "xml", "pdf", "txt", "zip", "html", "htm",
];

pub fn assert_import_extension(path: &Path) -> DesktopResult<()> {
    let found = extension(path);
    if found.is_empty() {
        return Err(DesktopError::new(
            "UNSUPPORTED_FILE_TYPE",
            "Plik bez rozszerzenia nie moze zostac zaimportowany.",
            true,
        ));
    }
    if ALLOWED_IMPORT_EXTENSIONS.contains(&found.as_str()) {
        return Ok(());
    }
    Err(DesktopError::new(
        "UNSUPPORTED_FILE_TYPE",
        format!(
            "Rozszerzenie .{found} nie jest obslugiwane przy imporcie. Dozwolone: {}.",
            ALLOWED_IMPORT_EXTENSIONS.join(", ")
        ),
        true,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn broker_statement_and_evidence_formats_are_accepted() {
        for filename in [
            "broker.JSON",
            "rates.csv",
            "trades.xlsx",
            "legacy.xls",
            "raport.xml",
            "document.pdf",
            "notes.txt",
            "archive.zip",
        ] {
            assert!(
                assert_import_extension(&PathBuf::from(filename)).is_ok(),
                "{filename} powinien byc dozwolony"
            );
        }
    }

    #[test]
    fn executables_and_scripts_are_blocked() {
        for filename in [
            "payload.exe",
            "script.ps1",
            "installer.msi",
            "library.dll",
            "run.bat",
            "run.cmd",
            "macro.vbs",
            "shell.sh",
            "link.lnk",
            "screensaver.scr",
        ] {
            let error = assert_import_extension(&PathBuf::from(filename))
                .expect_err(&format!("{filename} nie moze przejsc importu"));
            assert_eq!(error.error_code, "UNSUPPORTED_FILE_TYPE");
        }
    }

    #[test]
    fn file_without_extension_is_blocked() {
        let error = assert_import_extension(&PathBuf::from("wyciag"))
            .expect_err("plik bez rozszerzenia nie moze przejsc importu");

        assert_eq!(error.error_code, "UNSUPPORTED_FILE_TYPE");
    }

    #[test]
    fn extension_check_ignores_letter_case() {
        assert!(assert_import_extension(&PathBuf::from("Trades.XLSX")).is_ok());
        assert!(assert_import_extension(&PathBuf::from("payload.EXE")).is_err());
    }

    #[test]
    fn double_extension_is_judged_by_the_last_one() {
        // "wyciag.csv.exe" jest plikiem wykonywalnym, mimo ze wyglada na dane.
        assert!(assert_import_extension(&PathBuf::from("wyciag.csv.exe")).is_err());
        assert!(assert_import_extension(&PathBuf::from("wyciag.exe.csv")).is_ok());
    }
}
