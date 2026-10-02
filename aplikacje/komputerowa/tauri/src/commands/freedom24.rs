//! Local-file, read-only Freedom24 adapter.  Secrets never cross the Tauri IPC.
use hmac::{Hmac, Mac};
use reqwest::{Client, StatusCode};
use serde::Serialize;
use serde_json::{json, Map, Value};
use sha2::Sha256;
use std::{
    env, fs,
    path::{Path, PathBuf},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

const BASE_URL: &str = "https://freedom24.com";
const READ_ONLY: &[&str] = &[
    "getOPQ",
    "getPositionJson",
    "getTradesHistory",
    "getUserCashFlows",
    "getBrokerReport",
    "getDepositaryReport",
    "getSecurityInfo",
    "getMarketStatus",
    "getNotifyOrderJson",
];

const CASH_PATHS: [&str; 4] = ["/cashflow", "/result/cashflow", "/cashflows", "/result/cashflows"];
/// Tyle stron po 100 przeplywow jak w trasie web (routes/brokers.ts, full-export).
const MAX_STRON_PRZEPLYWOW: usize = 1_000;
const SEKCJE_RAPORTU: [&str; 9] = [
    "account_at_start",
    "account_at_end",
    "trades",
    "commissions",
    "corporate_actions",
    "in_outs",
    "in_outs_securities",
    "cash_flows",
    "securities_flows",
];
/// Sekcje raportu wplywajace na podatek; ich brak = eksport niekompletny.
const SEKCJE_PODATKOWE: [&str; 7] = [
    "trades",
    "commissions",
    "corporate_actions",
    "in_outs",
    "in_outs_securities",
    "cash_flows",
    "securities_flows",
];

#[derive(Clone)]
struct Credentials {
    public_key: String,
    private_key: String,
}

#[derive(Serialize)]
pub struct DesktopHttpResult {
    pub status: u16,
    pub body: Value,
}

fn credentials_dir(app: &AppHandle) -> Option<PathBuf> {
    if let Some(value) = env::var_os("FREEDOM24_CREDENTIALS_DIR") {
        return Some(PathBuf::from(value));
    }
    app.path().app_data_dir().ok().map(|dir| dir.join("API"))
}

fn find_pair(directory: &Path) -> Option<(PathBuf, PathBuf)> {
    for (public, private) in [("public", "private"), ("public key.txt", "private key.txt")] {
        let public = directory.join(public);
        let private = directory.join(private);
        if public.is_file() && private.is_file() {
            return Some((public, private));
        }
    }
    None
}

fn load_credentials(directory: &Path) -> Option<Credentials> {
    let (public, private) = find_pair(directory)?;
    let public_key = fs::read_to_string(public).ok()?.trim().to_string();
    let private_key = fs::read_to_string(private).ok()?.trim().to_string();
    (!public_key.is_empty() && !private_key.is_empty()).then_some(Credentials {
        public_key,
        private_key,
    })
}

pub fn canonical_json(value: &Value) -> String {
    match value {
        Value::Array(rows) => format!(
            "[{}]",
            rows.iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(row) => {
            let mut keys: Vec<&String> = row.keys().collect();
            keys.sort();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap_or_default(),
                        canonical_json(&row[key])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        _ => serde_json::to_string(value).unwrap_or_else(|_| "null".into()),
    }
}

pub fn signature(private_key: &str, payload: &str, timestamp: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(private_key.as_bytes())
        .expect("HMAC accepts keys of any length");
    mac.update(format!("{payload}{timestamp}").as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

pub fn sanitize(value: impl AsRef<str>) -> String {
    let mut text = value.as_ref().replace('\n', " ").replace('\r', " ");
    for marker in [
        "authorization",
        "api-key",
        "api_key",
        "token",
        "secret",
        "signature",
        "private key",
        "cookie",
    ] {
        if let Some(index) = text.to_ascii_lowercase().find(marker) {
            text.truncate(index + marker.len());
            text.push_str("=[redacted]");
        }
    }
    if text.is_empty() {
        "Błąd komunikacji z Freedom24.".into()
    } else {
        text.chars().take(240).collect()
    }
}

fn error(command: &str, retryable: bool, message: &str, broker_code: Option<Value>) -> Value {
    let mut error =
        json!({ "command": command, "retryable": retryable, "message": sanitize(message) });
    if let Some(code) = broker_code {
        error["brokerCode"] = code;
    }
    error
}

async fn read(
    credentials: &Credentials,
    command: &str,
    params: Value,
) -> Result<(u16, Value), Value> {
    if !READ_ONLY.contains(&command) {
        return Err(error(
            command,
            false,
            "Polecenie nie jest dozwolone w integracji tylko-do-odczytu.",
            None,
        ));
    }
    let payload = canonical_json(&params);
    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| {
            error(
                command,
                true,
                "Błąd sieci podczas połączenia z Freedom24.",
                None,
            )
        })?;
    for attempt in 0..=1 {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
            .to_string();
        let result = client
            .post(format!("{BASE_URL}/api/{command}"))
            .header("accept", "application/json")
            .header("content-type", "application/json")
            .header("X-NtApi-PublicKey", &credentials.public_key)
            .header("X-NtApi-Timestamp", &timestamp)
            .header(
                "X-NtApi-Sig",
                signature(&credentials.private_key, &payload, &timestamp),
            )
            .body(payload.clone())
            .send()
            .await;
        match result {
            Ok(response) => {
                let status = response.status();
                let text = response.text().await.unwrap_or_default();
                let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
                let code = body.get("code").or_else(|| body.get("errorCode")).cloned();
                let broker_failed = code
                    .as_ref()
                    .is_some_and(|x| x != &json!(0) && x != &json!("0") && x != &json!(200));
                if status.is_success()
                    && body != Value::Null
                    && !broker_failed
                    && body.get("error").is_none()
                    && body.get("errMsg").is_none()
                {
                    return Ok((status.as_u16(), body));
                }
                let retryable = status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error();
                if retryable && attempt == 0 {
                    thread::sleep(Duration::from_millis(250));
                    continue;
                }
                return Err(error(
                    command,
                    retryable,
                    body.get("errMsg")
                        .or_else(|| body.get("message"))
                        .and_then(Value::as_str)
                        .unwrap_or("Freedom24 odrzuciło żądanie."),
                    code,
                ));
            }
            Err(_) if attempt == 0 => thread::sleep(Duration::from_millis(250)),
            Err(_) => {
                return Err(error(
                    command,
                    true,
                    "Błąd sieci podczas połączenia z Freedom24.",
                    None,
                ))
            }
        }
    }
    Err(error(command, false, "Nieznany błąd Freedom24.", None))
}

fn unavailable() -> DesktopHttpResult {
    DesktopHttpResult {
        status: 503,
        body: json!({"success":false,"configured":false,"errorCode":"FREEDOM24_UNAVAILABLE","message":"Lokalne poświadczenia Freedom24 nie są skonfigurowane."}),
    }
}
fn failure(result: Value) -> DesktopHttpResult {
    let status = if result
        .get("brokerCode")
        .is_some_and(|x| x == &json!(401) || x == &json!(403))
    {
        401
    } else {
        502
    };
    DesktopHttpResult {
        status,
        body: json!({"success":false,"errorCode":result.get("brokerCode").cloned().unwrap_or(json!("FREEDOM24_REQUEST_FAILED")),"command":result["command"],"retryable":result["retryable"],"message":result["message"]}),
    }
}

fn number(value: Option<&Value>) -> Value {
    value
        .and_then(|x| x.as_f64().or_else(|| x.as_str()?.parse().ok()))
        .map_or(Value::Null, |v| json!(v))
}
fn portfolio(payload: &Value) -> Value {
    let ps = payload
        .pointer("/result/ps")
        .or_else(|| payload.get("ps"))
        .or_else(|| payload.pointer("/data/ps"))
        .unwrap_or(payload);
    let balances = ps.get("acc").and_then(Value::as_array).cloned().unwrap_or_default().into_iter().map(|row| json!({"currency":row.get("curr").and_then(Value::as_str).unwrap_or("").to_uppercase(),"amount":number(row.get("s")),"exchangeRate":number(row.get("currval"))})).collect::<Vec<_>>();
    let positions = ps.get("pos").and_then(Value::as_array).cloned().unwrap_or_default().into_iter().map(|row| {
        let raw = row.get("i").or_else(|| row.get("ticker")).and_then(Value::as_str).unwrap_or(""); let mut pieces = raw.splitn(2, '.'); let ticker = pieces.next().unwrap_or(""); let market = pieces.next().or_else(|| row.get("market").and_then(Value::as_str));
        json!({"ticker":ticker,"market":market,"isin":row.get("issue_nb").or_else(||row.get("isin")).cloned().unwrap_or(Value::Null),"currency":row.get("curr").and_then(Value::as_str).unwrap_or("").to_uppercase(),"quantity":number(row.get("q")),"marketValue":number(row.get("market_value")),"averagePrice":number(row.get("bal_price_a").or_else(||row.get("price_a"))),"marketPrice":number(row.get("mkt_price")),"profit":number(row.get("profit_close").or_else(||row.get("profit_price")))})
    }).collect::<Vec<_>>();
    json!({"balances":balances,"positions":positions})
}
fn rows(payload: &Value, paths: &[&str]) -> Vec<Value> {
    for path in paths {
        if let Some(found) = payload.pointer(path).and_then(Value::as_array) {
            return found.clone();
        }
    }
    vec![]
}
/// Dzien kalendarzowy w Polsce (jak `polskiDzienKalendarzowy` w web). Czas letni
/// trwa od ostatniej niedzieli marca 01:00 UTC do ostatniej niedzieli pazdziernika 01:00 UTC.
fn polski_dzien_kalendarzowy(now: chrono::DateTime<chrono::Utc>) -> String {
    use chrono::{Datelike, Duration as Dur, TimeZone, Weekday};
    let ostatnia_niedziela = |miesiac: u32| {
        let mut dzien = chrono::Utc.with_ymd_and_hms(now.year(), miesiac, 31, 1, 0, 0).unwrap();
        while dzien.weekday() != Weekday::Sun {
            dzien -= Dur::days(1);
        }
        dzien
    };
    let letni = now >= ostatnia_niedziela(3) && now < ostatnia_niedziela(10);
    (now + Dur::hours(if letni { 2 } else { 1 })).format("%Y-%m-%d").to_string()
}

/// Najwczesniejszy dzien (RRRR-MM-DD) wsrod transakcji i przeplywow.
fn najwczesniejszy_dzien_operacji(listy: &[&[Value]]) -> Option<String> {
    let mut najwczesniejszy: Option<String> = None;
    for wiersz in listy.iter().flat_map(|lista| lista.iter()) {
        for pole in ["date", "short_date", "datetime", "pay_d"] {
            let dzien: String = match wiersz.get(pole) {
                Some(Value::String(tekst)) => tekst.chars().take(10).collect(),
                _ => continue,
            };
            let poprawny = dzien.len() == 10
                && dzien.chars().enumerate().all(|(i, c)| if i == 4 || i == 7 { c == '-' } else { c.is_ascii_digit() });
            if poprawny && najwczesniejszy.as_ref().is_none_or(|obecny| dzien < *obecny) {
                najwczesniejszy = Some(dzien);
            }
        }
    }
    najwczesniejszy
}
fn request_object(request: Option<Value>) -> Value {
    request
        .filter(|v| v.is_object())
        .unwrap_or_else(|| Value::Object(Map::new()))
}

#[tauri::command]
pub fn freedom24_status(app: AppHandle, _request: Option<Value>) -> DesktopHttpResult {
    let configured = credentials_dir(&app)
        .and_then(|dir| load_credentials(&dir))
        .is_some();
    DesktopHttpResult {
        status: 200,
        body: json!({"success":true,"configured":configured,"mode":"local-file-read-only"}),
    }
}

#[tauri::command]
pub async fn freedom24_auth_check(app: AppHandle, _request: Option<Value>) -> DesktopHttpResult {
    let Some(credentials) = credentials_dir(&app).and_then(|dir| load_credentials(&dir)) else {
        return unavailable();
    };
    match read(&credentials, "getOPQ", json!({})).await {
        Ok((status, _)) => DesktopHttpResult {
            status: 200,
            body: json!({"success":true,"configured":true,"authenticated":true,"status":status}),
        },
        Err(value) => failure(value),
    }
}

#[tauri::command]
pub async fn freedom24_portfolio(app: AppHandle, _request: Option<Value>) -> DesktopHttpResult {
    let Some(credentials) = credentials_dir(&app).and_then(|dir| load_credentials(&dir)) else {
        return unavailable();
    };
    match read(&credentials, "getPositionJson", json!({})).await {
        Ok((status, data)) => DesktopHttpResult {
            status: 200,
            body: json!({"success":true,"configured":true,"status":status,"portfolio":portfolio(&data)}),
        },
        Err(value) => failure(value),
    }
}

#[tauri::command]
pub async fn freedom24_full_export(app: AppHandle, request: Option<Value>) -> DesktopHttpResult {
    let request = request_object(request);
    let from = request.get("dateFrom").and_then(Value::as_str);
    let to = request.get("dateTo").and_then(Value::as_str);
    if !from.is_none_or(|v| {
        v.len() == 10
            && v.chars().enumerate().all(|(i, c)| {
                if i == 4 || i == 7 {
                    c == '-'
                } else {
                    c.is_ascii_digit()
                }
            })
    }) || !to.is_none_or(|v| {
        v.len() == 10
            && v.chars().enumerate().all(|(i, c)| {
                if i == 4 || i == 7 {
                    c == '-'
                } else {
                    c.is_ascii_digit()
                }
            })
    }) || from.zip(to).is_some_and(|(a, b)| a > b)
    {
        return DesktopHttpResult {
            status: 400,
            body: json!({"success":false,"message":"Nieprawidłowy zakres dat."}),
        };
    }
    let Some(credentials) = credentials_dir(&app).and_then(|dir| load_credentials(&dir)) else {
        return unavailable();
    };
    let credentials = &credentials;
    build_full_export(
        |command: String, params: Value| async move { read(credentials, &command, params).await },
        from,
        to,
        &polski_dzien_kalendarzowy(chrono::Utc::now()),
    )
    .await
}

/// Skladanie eksportu z odczytow Tradernet. Czytnik jest wstrzykiwany, zeby
/// logike kompletnosci dalo sie sprawdzic bez sieci.
async fn build_full_export<R, Fut>(
    mut read: R,
    from: Option<&str>,
    to: Option<&str>,
    today: &str,
) -> DesktopHttpResult
where
    R: FnMut(String, Value) -> Fut,
    Fut: std::future::Future<Output = Result<(u16, Value), Value>>,
{
    let mut history = Map::new();
    if let Some(value) = from {
        history.insert("date_from".into(), json!(value));
    }
    if let Some(value) = to {
        history.insert("date_to".into(), json!(value));
    }
    let trades_result = read("getTradesHistory".into(), Value::Object(history)).await;
    let Ok((_status, trades_payload)) = trades_result else {
        return failure(trades_result.unwrap_err());
    };
    let mut filters = Vec::new();
    if let Some(value) = from {
        filters.push(json!({"field":"date","operator":"eqormore","value":value}));
    }
    if let Some(value) = to {
        filters.push(json!({"field":"date","operator":"eqorless","value":value}));
    }
    let base_cash =
        json!({"take":100,"skip":0,"filters":if filters.is_empty(){json!({})}else{json!(filters)}});
    let cash_result = read("getUserCashFlows".into(), base_cash.clone()).await;
    let Ok((_status, cash_payload)) = cash_result else {
        return failure(cash_result.unwrap_err());
    };
    let mut cash = rows(&cash_payload, &CASH_PATHS);
    let total = cash_payload
        .get("total")
        .or_else(|| cash_payload.pointer("/result/total"))
        .and_then(|x| x.as_u64().or_else(|| x.as_str()?.trim().parse().ok()));
    // Jak w trasie web: przerwane stronicowanie albo limit stron to blad z liczba
    // brakujacych rekordow, a nie po cichu okrojony plik zapisywany w miejsce kompletnego.
    let niepelny = |brakuje: usize, powod: &str| DesktopHttpResult {
        status: 502,
        body: json!({"success":false,"errorCode":"FREEDOM24_EXPORT_INCOMPLETE","missingRecords":brakuje,"message":format!("Eksport Freedom24 jest niepełny: {powod}")}),
    };
    let mut cash_pages = 1;
    while let Some(all) = total.filter(|all| cash.len() < *all as usize) {
        let brakuje = all as usize - cash.len();
        if cash_pages >= MAX_STRON_PRZEPLYWOW {
            return niepelny(brakuje, "przekroczono limit stron przepływów gotówkowych.");
        }
        let mut page = base_cash.clone();
        page["skip"] = json!(cash.len());
        match read("getUserCashFlows".into(), page).await {
            Ok((_, data)) => {
                let rows = rows(&data, &CASH_PATHS);
                if rows.is_empty() {
                    return niepelny(brakuje, "broker nie zwrócił pozostałych przepływów gotówkowych.");
                }
                cash.extend(rows);
                cash_pages += 1;
            }
            Err(value) => return failure(value),
        }
    }
    let positions_result = read("getPositionJson".into(), json!({})).await;
    let Ok((_status, positions_payload)) = positions_result else {
        return failure(positions_result.unwrap_err());
    };
    let trades = rows(
        &trades_payload,
        &[
            "/trades/trade",
            "/trades",
            "/result/trades/trade",
            "/result/trades",
        ],
    );
    let positions = portfolio(&positions_payload)["positions"].clone();

    // Raport maklerski sekcja po sekcji (jak tradernet-sdk w trasie web); sekcje
    // wplywajace na podatek, ktorych brakuje, oznaczaja eksport jako niekompletny.
    let report_params = json!({
        "date_start": from.unwrap_or("1970-01-01"),
        "date_end": to.unwrap_or(today),
        "time_period": "23:59:59",
        "format": "json",
    });
    let mut broker_report = Map::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut missing_sections: Vec<&str> = Vec::new();
    for section_type in SEKCJE_RAPORTU {
        let mut params = report_params.clone();
        params["type"] = json!(section_type);
        let podatkowa = SEKCJE_PODATKOWE.contains(&section_type);
        match read("getBrokerReport".into(), params).await {
            Ok((_, data)) => match data.pointer("/report").or_else(|| data.pointer("/result/report")) {
                Some(value) => {
                    broker_report.insert(section_type.to_string(), value.clone());
                }
                None if podatkowa => missing_sections.push(section_type),
                None => {}
            },
            Err(error) => {
                let message = error.get("message").and_then(Value::as_str).unwrap_or("Freedom24 odrzuciło żądanie.");
                warnings.push(format!("getBrokerReport/{section_type}: {message}"));
                if podatkowa {
                    missing_sections.push(section_type);
                }
            }
        }
    }
    // Raport depozytariusza to tylko dowod kontrolny; odrzuca zakres sprzed otwarcia
    // rachunku, wiec bez daty startu zaczynamy od pierwszej operacji.
    let depositary_start = from
        .map(str::to_string)
        .or_else(|| najwczesniejszy_dzien_operacji(&[&trades, &cash]));
    let depositary_report = match &depositary_start {
        None => {
            warnings.push("Raport depozytariusza pominięty: rachunek nie ma jeszcze żadnej operacji z datą.".into());
            Value::Null
        }
        Some(start) => {
            let mut params = report_params.clone();
            params["date_start"] = json!(start);
            params["type"] = json!("depoData");
            match read("getDepositaryReport".into(), params).await {
                Ok((_, data)) => data
                    .pointer("/report")
                    .or_else(|| data.pointer("/result/report"))
                    .cloned()
                    .unwrap_or(Value::Null),
                Err(error) => {
                    let message = error.get("message").and_then(Value::as_str).unwrap_or("Freedom24 odrzuciło żądanie.");
                    warnings.push(format!("Raport depozytariusza niepobrany (zakres od {start}): {message}"));
                    Value::Null
                }
            }
        }
    };
    let broker_report_sections = broker_report.len();
    let broker_report_value = if broker_report.is_empty() { Value::Null } else { Value::Object(broker_report) };
    let depositary_sections = depositary_report.as_object().map_or(0, Map::len);
    DesktopHttpResult {
        status: 200,
        body: json!({
            "success": true,
            "complete": missing_sections.is_empty(),
            "missingSections": missing_sections,
            "configured": true,
            "sections": {"trades": trades.len(), "cash_flows": cash.len(), "positions": positions.as_array().map_or(0, Vec::len), "broker_report_sections": broker_report_sections, "depositary_report_sections": depositary_sections},
            "warnings": warnings,
            "report": {"trades": trades, "cash_flows": cash, "positions": positions},
            "raportMaklerski": broker_report_value,
            "raportDepozytariusza": depositary_report,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canonical_signature_matches_web_vector() {
        assert_eq!(
            canonical_json(&json!({"b":2,"a":1,"nested":{"z":null,"a":true}})),
            "{\"a\":1,\"b\":2,\"nested\":{\"a\":true,\"z\":null}}"
        );
        assert_eq!(
            signature(
                "test-secret",
                &canonical_json(&json!({"b":2,"a":1})),
                "1700000000"
            ),
            "046bd822091f9ab01677cefdaa4397eee68630c729a21e0ce35e832888f43652"
        );
    }
    #[test]
    fn modifying_command_is_rejected_before_network() {
        assert!(!READ_ONLY.contains(&"putTradeOrder"));
        let credentials = Credentials {
            public_key: "fake-public".into(),
            private_key: "fake-private".into(),
        };
        for command in ["putTradeOrder", "putStopLoss", "delTradeOrder"] {
            let result = tauri::async_runtime::block_on(read(&credentials, command, json!({})));
            assert!(result.is_err(), "{command} musi byc odrzucone bez zapytania");
        }
    }
    type Odczyt = std::future::Ready<Result<(u16, Value), Value>>;

    /// Atrapa Tradernet: `total` przeplywow (strony po 100), wybrane sekcje raportu
    /// odrzucane, opcjonalnie pusta druga strona przeplywow.
    fn atrapa(
        total: usize,
        brak_sekcji: &'static [&'static str],
        pusta_druga_strona: bool,
        wywolania: std::rc::Rc<std::cell::RefCell<Vec<(String, Value)>>>,
    ) -> impl FnMut(String, Value) -> Odczyt {
        move |command, params| {
            wywolania.borrow_mut().push((command.clone(), params.clone()));
            let odpowiedz = match command.as_str() {
                "getTradesHistory" => Ok(json!({"trades":{"trade":[{"date":"2025-01-01"}]}})),
                "getUserCashFlows" => {
                    let skip = params["skip"].as_u64().unwrap_or(0) as usize;
                    let liczba = if pusta_druga_strona && skip > 0 { 0 } else { (total - skip).min(100) };
                    Ok(json!({"total": total, "cashflow": (0..liczba).map(|i| json!({"id": skip + i})).collect::<Vec<_>>()}))
                }
                "getPositionJson" => Ok(json!({"result":{"ps":{"acc":[],"pos":[]}}})),
                "getBrokerReport" => {
                    let typ = params["type"].as_str().unwrap_or("").to_string();
                    if brak_sekcji.contains(&typ.as_str()) {
                        Err(error("getBrokerReport", true, "Sekcja niedostepna", None))
                    } else {
                        Ok(json!({"report": []}))
                    }
                }
                "getDepositaryReport" => Ok(json!({"report": {"depo": []}})),
                inne => panic!("nieoczekiwane polecenie {inne}"),
            };
            std::future::ready(odpowiedz.map(|body| (200, body)))
        }
    }

    fn eksport(total: usize, brak_sekcji: &'static [&'static str], pusta_druga: bool) -> DesktopHttpResult {
        let wywolania = Default::default();
        tauri::async_runtime::block_on(build_full_export(
            atrapa(total, brak_sekcji, pusta_druga, wywolania),
            None,
            None,
            "2026-09-29",
        ))
    }

    #[test]
    fn kompletny_eksport_ma_complete_true_i_raport_maklerski() {
        let wynik = eksport(2101, &[], false);
        assert_eq!(wynik.status, 200);
        assert_eq!(wynik.body["complete"], true);
        assert_eq!(wynik.body["missingSections"], json!([]));
        // Bez ucinania na 2000 wierszach.
        assert_eq!(wynik.body["report"]["cash_flows"].as_array().unwrap().len(), 2101);
        assert_eq!(wynik.body["sections"]["broker_report_sections"], 9);
        assert!(wynik.body["raportMaklerski"].is_object());
        assert!(wynik.body["raportDepozytariusza"].is_object());
    }

    #[test]
    fn brak_sekcji_podatkowej_daje_complete_false_i_liste_sekcji() {
        let wynik = eksport(10, &["commissions", "account_at_start"], false);
        assert_eq!(wynik.status, 200);
        assert_eq!(wynik.body["complete"], false);
        // account_at_start nie wplywa na podatek - tak jak w trasie web.
        assert_eq!(wynik.body["missingSections"], json!(["commissions"]));
        assert!(wynik.body["warnings"].as_array().unwrap().iter().any(|w| w.as_str().unwrap().contains("commissions")));
    }

    #[test]
    fn przerwane_stronicowanie_przeplywow_to_blad_z_liczba_brakujacych() {
        let wynik = eksport(250, &[], true);
        assert_eq!(wynik.status, 502);
        assert_eq!(wynik.body["success"], false);
        assert_eq!(wynik.body["errorCode"], "FREEDOM24_EXPORT_INCOMPLETE");
        assert_eq!(wynik.body["missingRecords"], 150);
    }

    #[test]
    fn dzien_raportu_uwzglednia_czas_polski() {
        use chrono::TimeZone;
        let dzien = |r, m, d, g, min| polski_dzien_kalendarzowy(chrono::Utc.with_ymd_and_hms(r, m, d, g, min, 0).unwrap());
        assert_eq!(dzien(2026, 1, 1, 23, 30), "2026-01-02"); // zima, UTC+1
        assert_eq!(dzien(2026, 7, 1, 22, 30), "2026-07-02"); // lato, UTC+2
        assert_eq!(dzien(2026, 7, 1, 21, 30), "2026-07-01");
        assert_eq!(dzien(2026, 3, 29, 0, 30), "2026-03-29"); // przed zmiana czasu (UTC+1)
        assert_eq!(dzien(2026, 3, 29, 1, 30), "2026-03-29"); // po zmianie (UTC+2)
        assert_eq!(dzien(2026, 3, 28, 22, 30), "2026-03-28"); // jeszcze UTC+1
        assert_eq!(dzien(2026, 10, 25, 22, 30), "2026-10-25"); // po zmianie na zime: UTC+1 -> 23:30
    }

    #[test]
    fn earliest_operation_day_is_found() {
        let dzien = najwczesniejszy_dzien_operacji(&[
            &[json!({"date":"2025-03-01"}), json!({"short_date":"2024-12-31 10:00"})],
            &[json!({"pay_d":"2024-11-05"}), json!({"note":"brak"})],
        ]);
        assert_eq!(dzien.as_deref(), Some("2024-11-05"));
        assert_eq!(najwczesniejszy_dzien_operacji(&[&[json!({"x":1})]]), None);
    }

    #[test]
    fn missing_files_are_unavailable() {
        assert!(
            load_credentials(Path::new("C:/definitely-missing-freedom24-credentials")).is_none()
        );
    }
    #[test]
    fn sanitizer_removes_sensitive_tail() {
        let safe = sanitize("Authorization: fake-token-which-must-not-appear");
        assert!(!safe.contains("fake-token"));
        assert!(safe.contains("redacted"));
    }
    // Test na zywym API Freedom24 (tylko odczyt) jest poza domyslnym przebiegiem: bramka testow
    // nie dopuszcza pominietych testow, a #[ignore] liczyl sie jako pominiety. Uruchomienie jawne:
    // cargo test --lib --features freedom24-live real_read_only
    #[cfg(feature = "freedom24-live")]
    #[test]
    fn real_read_only_authentication_counts_only() {
        // Klucze czyta wylacznie runtime; wypisujemy tylko flagi i liczniki.
        let Some(credentials) = env::var_os("FREEDOM24_CREDENTIALS_DIR")
            .and_then(|d| load_credentials(Path::new(&d)))
        else {
            println!("configured=false (ustaw FREEDOM24_CREDENTIALS_DIR)");
            return;
        };
        tauri::async_runtime::block_on(async {
            let auth = read(&credentials, "getOPQ", json!({})).await;
            let authenticated = matches!(auth, Ok((200, _)));
            println!("authenticated={authenticated}");
            assert!(authenticated, "getOPQ nie zwrocil 200");
            let (status, body) = read(&credentials, "getPositionJson", json!({}))
                .await
                .expect("getPositionJson");
            println!("portfolio_status={status} body_is_object={}", body.is_object());
            assert_eq!(status, 200);
            let rejected = read(&credentials, "putTradeOrder", json!({})).await;
            assert!(rejected.is_err(), "polecenie zapisujace musi byc odrzucone lokalnie");
        });
    }
}
