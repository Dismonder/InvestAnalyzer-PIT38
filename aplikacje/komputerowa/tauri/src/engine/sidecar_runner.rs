use crate::engine::errors::{DesktopError, DesktopResult};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const EXE_NAME: &str = "investment-tax-engine.exe";

/// Sciezka deweloperska: silnik zbudowany przez `desktop:engine:build` lezy w
/// wydania/komputerowa. Wskazywala wczesniej na wydania/desktop - katalog,
/// ktory nie powstaje od czasu zmiany nazw, wiec galaz nigdy sie nie wykonywala.
///
/// Wzgledna od biezacego katalogu procesu, wiec w wydaniu (portable uruchomiony
/// z katalogu repozytorium) trafialaby na inny silnik niz ten dolaczony do
/// aplikacji. Dlatego `dozwolona` to wylacznie kompilacja deweloperska.
fn sciezka_deweloperska(dozwolona: bool) -> Option<PathBuf> {
    if !dozwolona {
        return None;
    }
    Some(
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("..")
            .join("..")
            .join("..")
            .join("wydania")
            .join("komputerowa")
            .join("investment-tax-engine")
            .join(EXE_NAME),
    )
}

fn wybierz_sidecar(dev_path: Option<PathBuf>, resource_dir: &Path) -> Option<PathBuf> {
    if let Some(dev_path) = dev_path.filter(|sciezka| sciezka.exists()) {
        return Some(dev_path);
    }
    [
        resource_dir
            .join("binaries")
            .join("investment-tax-engine")
            .join(EXE_NAME),
        resource_dir.join("investment-tax-engine").join(EXE_NAME),
    ]
    .into_iter()
    .find(|candidate| candidate.exists())
}

pub fn resolve_sidecar_exe(app: &AppHandle) -> DesktopResult<PathBuf> {
    let resource_dir = app.path().resource_dir().map_err(|error| {
        DesktopError::new(
            "ENGINE_NOT_FOUND",
            format!("Cannot resolve Tauri resource directory: {error}"),
            true,
        )
    })?;
    wybierz_sidecar(sciezka_deweloperska(cfg!(debug_assertions)), &resource_dir).ok_or_else(|| {
        DesktopError::new(
            "ENGINE_NOT_FOUND",
            "Python tax engine sidecar was not found. Build it with npm run desktop:engine:build.",
            true,
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use uuid::Uuid;

    fn zrob_plik(sciezka: &Path) {
        fs::create_dir_all(sciezka.parent().unwrap()).unwrap();
        fs::write(sciezka, b"exe").unwrap();
    }

    #[test]
    fn wydanie_nie_uzywa_sciezki_wzglednej_od_katalogu_procesu() {
        assert!(sciezka_deweloperska(false).is_none());
        assert!(sciezka_deweloperska(true).is_some());
    }

    #[test]
    fn bez_sciezki_deweloperskiej_wybierany_jest_silnik_z_zasobow() {
        let korzen = std::env::temp_dir().join(format!("ia-sidecar-{}", Uuid::new_v4()));
        let dev = korzen.join("repo").join(EXE_NAME);
        let zasoby = korzen.join("zasoby");
        let z_zasobow = zasoby.join("binaries").join("investment-tax-engine").join(EXE_NAME);
        zrob_plik(&dev);
        zrob_plik(&z_zasobow);

        assert_eq!(wybierz_sidecar(None, &zasoby), Some(z_zasobow.clone()));
        assert_eq!(wybierz_sidecar(Some(dev.clone()), &zasoby), Some(dev));
        assert_eq!(wybierz_sidecar(None, &korzen.join("pusto")), None);
        fs::remove_dir_all(korzen).unwrap();
    }
}
