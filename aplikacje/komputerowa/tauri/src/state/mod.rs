use crate::engine::contract::TaxEngineJobStatus;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::process::Child;
use std::sync::{Arc, Mutex, MutexGuard};

pub struct DesktopState {
    pub jobs: Arc<Mutex<HashMap<String, JobRecord>>>,
    cykl_zycia: Arc<Mutex<()>>,
}

impl Default for DesktopState {
    fn default() -> Self {
        Self {
            jobs: Arc::new(Mutex::new(HashMap::new())),
            cykl_zycia: Arc::new(Mutex::new(())),
        }
    }
}

impl DesktopState {
    /// Wspolna blokada startu przeliczenia i czyszczenia katalogow danych.
    pub fn zablokuj_cykl_zycia(&self) -> MutexGuard<'_, ()> {
        match self.cykl_zycia.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    /// Identyfikatory zadań, które jeszcze pracują (katalogu przebiegu nie wolno im
    /// usunąć spod nóg). Zatruty mutex nie ukrywa zadań: lepiej zachować za dużo.
    pub fn aktywne_zadania(&self) -> HashSet<String> {
        let jobs = match self.jobs.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        jobs.iter()
            .filter(|(_, record)| matches!(record.status.state.as_str(), "queued" | "running"))
            .map(|(id, _)| id.clone())
            .collect()
    }
}

pub struct JobRecord {
    pub status: TaxEngineJobStatus,
    pub result: Option<Value>,
    pub error: Option<Value>,
    pub child: Option<Arc<Mutex<Option<Child>>>>,
}

/// Blokady zapisu per plik: nadpisania tego samego pliku zarzadzanego (np.
/// freedom24_komplet.json) ida jedno po drugim - kopia poprzedniej wersji i podmiana
/// nie moga sie przeplatac. Odpowiednik kolejki blokad w wersji web. Mapa rosnie co
/// najwyzej o liczbe plikow zarzadzanych (kilka), wiec wpisow sie nie sprzata.
#[derive(Default)]
pub struct BlokadyZapisu {
    mapa: Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>,
}

impl BlokadyZapisu {
    pub fn dla(&self, sciezka: &Path) -> Arc<Mutex<()>> {
        let mut mapa = match self.mapa.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        mapa.entry(sciezka.to_path_buf()).or_default().clone()
    }
}

/// Zajmuje blokade; zatruty mutex (panika innego zapisu) nie blokuje kolejnych zapisow.
pub fn zajmij(blokada: &Mutex<()>) -> MutexGuard<'_, ()> {
    match blokada.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// Wspolny rejestr blokad zapisu calej aplikacji.
pub fn blokady_zapisu() -> &'static BlokadyZapisu {
    static BLOKADY: OnceLock<BlokadyZapisu> = OnceLock::new();
    BLOKADY.get_or_init(BlokadyZapisu::default)
}
