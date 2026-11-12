#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod browser;
mod demo;
mod orchestrator;
mod roles;
mod runtime;
mod sandbox;
mod scholar;
mod sources;
mod store;

use orchestrator::{AppState, Decision, StartParams};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::{Manager, State};

type S<'a> = State<'a, Arc<AppState>>;

fn urls(st: &AppState) -> runtime::Urls {
    runtime::Urls::load(|k| st.store.setting(k))
}

#[tauri::command]
async fn detect(st: S<'_>) -> Result<Value, String> {
    Ok(runtime::detect(&st.http, &urls(&st)).await)
}

#[tauri::command]
fn default_lab() -> Value {
    roles::lab_to_value(&roles::default_lab())
}

#[tauri::command]
fn list_labs(st: S<'_>) -> Result<Vec<Value>, String> {
    st.store.labs().map_err(|e| e.to_string())
}

#[tauri::command]
fn save_lab(st: S<'_>, lab: Value) -> Result<(), String> {
    let parsed: roles::Lab = serde_json::from_value(lab.clone()).map_err(|e| format!("invalid lab: {e}"))?;
    st.store.save_lab(&parsed.id, &parsed.name, &lab).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_lab(st: S<'_>, id: String) -> Result<(), String> {
    st.store.delete_lab(&id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn start_run(st: S<'_>, lab: Value, params: StartParams) -> Result<String, String> {
    let lab: roles::Lab = serde_json::from_value(lab).map_err(|e| format!("invalid lab: {e}"))?;
    if params.question.trim().is_empty() {
        return Err("Enter a research question first.".into());
    }
    orchestrator::start(st.inner().clone(), lab, params).await.map_err(|e| e.to_string())
}

#[tauri::command]
fn resolve_gate(st: S<'_>, gate_id: String, decision: Decision) -> Result<(), String> {
    orchestrator::resolve(&st, &gate_id, decision)
}

#[tauri::command]
fn halt_run(st: S<'_>, run_id: String) {
    orchestrator::halt(&st, &run_id);
}

#[tauri::command]
fn list_runs(st: S<'_>) -> Result<Vec<Value>, String> {
    st.store.runs().map_err(|e| e.to_string())
}

#[tauri::command]
fn run_events(st: S<'_>, run_id: String) -> Result<Value, String> {
    let ev = st.store.events(&run_id).map_err(|e| e.to_string())?;
    Ok(json!(ev))
}

#[tauri::command]
fn verify_audit(st: S<'_>, run_id: String) -> Result<Value, String> {
    let (n, broken) = st.store.verify(&run_id).map_err(|e| e.to_string())?;
    Ok(json!({"events": n, "broken_at": broken}))
}

#[tauri::command]
fn get_settings(st: S<'_>) -> Value {
    let u = urls(&st);
    json!({"version": env!("CARGO_PKG_VERSION"), "ollama_url": u.ollama, "lmstudio_url": u.lmstudio, "data_dir": st.data_dir.display().to_string(),
           "literature_enabled": st.store.setting("literature_enabled").as_deref() == Some("1"),
           "openalex_key_set": st.store.setting("openalex_key").map(|k| !k.is_empty()).unwrap_or(false),
           "openai_url": u.openai, "openai_key_set": !u.openai_key.is_empty(),
           "browser_path": browser::find_browser().map(|p| p.display().to_string()),
           "browser_visible": st.store.setting("browser_visible").as_deref() == Some("1"),
           "parallel": st.store.setting("parallel").unwrap_or_else(|| "auto".into()),
           "searxng_url": st.store.setting("searxng_url").unwrap_or_default()})
}

#[tauri::command]
fn set_settings(
    st: S<'_>,
    ollama_url: String,
    lmstudio_url: String,
    literature_enabled: Option<bool>,
    openalex_key: Option<String>,
    openai_url: Option<String>,
    openai_key: Option<String>,
    searxng_url: Option<String>,
    browser_visible: Option<bool>,
    parallel: Option<String>,
) -> Result<(), String> {
    if let Some(p) = parallel {
        let p = if matches!(p.as_str(), "1" | "2" | "3") { p } else { "auto".to_string() };
        st.store.set_setting("parallel", &p).map_err(|e| e.to_string())?;
    }
    st.store.set_setting("ollama_url", ollama_url.trim()).map_err(|e| e.to_string())?;
    st.store.set_setting("lmstudio_url", lmstudio_url.trim()).map_err(|e| e.to_string())?;
    if let Some(on) = literature_enabled {
        st.store.set_setting("literature_enabled", if on { "1" } else { "0" }).map_err(|e| e.to_string())?;
    }
    if let Some(u) = openai_url {
        st.store.set_setting("openai_url", u.trim()).map_err(|e| e.to_string())?;
    }
    if let Some(k) = openai_key {
        // Empty means "leave as is"; a single space clears the saved key.
        if !k.is_empty() {
            st.store.set_setting("openai_key", k.trim()).map_err(|e| e.to_string())?;
        }
    }
    if let Some(v) = browser_visible {
        st.store.set_setting("browser_visible", if v { "1" } else { "0" }).map_err(|e| e.to_string())?;
    }
    if let Some(u) = searxng_url {
        st.store.set_setting("searxng_url", u.trim()).map_err(|e| e.to_string())?;
    }
    if let Some(k) = openalex_key {
        // An empty field means "leave as is"; clearing is done by entering a single space.
        if !k.is_empty() {
            st.store.set_setting("openalex_key", k.trim()).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn source_json(s: &sources::Source) -> Value {
    json!({"id": s.id, "name": s.name, "kind": s.kind, "origin": s.origin, "chars": s.text.chars().count(),
           "preview": s.text.chars().take(240).collect::<String>()})
}

/// Opens the native file dialog and reads whatever the user picks.
#[tauri::command]
async fn pick_sources(st: S<'_>) -> Result<Value, String> {
    let picked = rfd::AsyncFileDialog::new()
        .set_title("Attach reference material")
        .add_filter("Documents", &["pdf", "txt", "md", "markdown", "csv", "tsv", "json", "tex", "bib", "html", "htm", "rst", "xml", "yaml", "yml"])
        .pick_files()
        .await
        .unwrap_or_default();
    let (mut added, mut errors) = (vec![], vec![]);
    for f in picked {
        match sources::from_path(f.path()).await {
            Ok(s) => {
                added.push(source_json(&s));
                st.sources.lock().unwrap().insert(s.id.clone(), s);
            }
            Err(e) => errors.push(e.to_string()),
        }
    }
    Ok(json!({"added": added, "errors": errors}))
}

#[tauri::command]
async fn add_source_url(st: S<'_>, url: String) -> Result<Value, String> {
    let s = sources::from_url(&st.http, &url).await.map_err(|e| e.to_string())?;
    let j = source_json(&s);
    st.sources.lock().unwrap().insert(s.id.clone(), s);
    Ok(j)
}

#[tauri::command]
fn remove_source(st: S<'_>, id: String) {
    st.sources.lock().unwrap().remove(&id);
}

/// Save an export through the native "Save as" dialog. `data_b64` is the file's bytes.
/// Returns the saved path, or null if the user cancelled.
#[tauri::command]
async fn save_export(name: String, data_b64: String) -> Result<Option<String>, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data_b64.trim()).map_err(|e| format!("bad data: {e}"))?;
    let ext = std::path::Path::new(&name).extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default();
    let mut dlg = rfd::AsyncFileDialog::new().set_title("Save export").set_file_name(&name);
    if !ext.is_empty() {
        dlg = dlg.add_filter(ext.to_uppercase(), &[ext.as_str()]);
    }
    let Some(file) = dlg.save_file().await else { return Ok(None) };
    tokio::fs::write(file.path(), bytes).await.map_err(|e| format!("could not save: {e}"))?;
    Ok(Some(file.path().display().to_string()))
}

/// Choose a saved notebook (.elenchia or .json) and return its text for viewing.
#[tauri::command]
async fn open_import() -> Result<Option<Value>, String> {
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_title("Open a notebook export")
        .add_filter("Elenchia notebook", &["elenchia", "json"])
        .pick_file()
        .await
    else {
        return Ok(None);
    };
    let meta = tokio::fs::metadata(file.path()).await.map_err(|e| e.to_string())?;
    if meta.len() > 200 * 1024 * 1024 {
        return Err("that file is larger than 200 MB".into());
    }
    let text = tokio::fs::read_to_string(file.path()).await.map_err(|e| format!("could not read the file: {e}"))?;
    Ok(Some(json!({"name": file.file_name(), "text": text})))
}

/// Manual literature lookup from the UI (the user asked for it explicitly).
#[tauri::command]
async fn search_literature(st: S<'_>, query: String) -> Result<Value, String> {
    let key = st.store.setting("openalex_key");
    let (papers, _notes) = scholar::search(&st.http, &query, key.as_deref()).await.map_err(|e| e.to_string())?;
    Ok(json!(papers))
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = match std::env::var("ELENCHIA_DATA_DIR") {
                Ok(d) => std::path::PathBuf::from(d),
                Err(_) => app.path().app_data_dir()?,
            };
            let store = Arc::new(store::Store::open(&dir.join("elenchia.db"))?);
            store.interrupt_stale()?;
            let http = reqwest::Client::builder().connect_timeout(std::time::Duration::from_secs(5)).build()?;
            let state = Arc::new(AppState {
                store,
                http,
                data_dir: dir,
                app: app.handle().clone(),
                pending: Mutex::new(HashMap::new()),
                halts: Mutex::new(HashMap::new()),
                sources: Mutex::new(HashMap::new()),
                browser: tokio::sync::Mutex::new(None),
            });
            app.manage(state.clone());
            if let Ok(out) = std::env::var("ELENCHIA_SELFTEST") {
                selftest(app.handle().clone(), state, out);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            detect, default_lab, list_labs, save_lab, delete_lab, start_run, resolve_gate, halt_run,
            list_runs, run_events, verify_audit, get_settings, set_settings,
            pick_sources, add_source_url, remove_source, search_literature, save_export, open_import
        ])
        .run(tauri::generate_context!())
        .expect("error while running Elenchia");
}

/// `ELENCHIA_SELFTEST=<out.json>` runs the default demo lab end to end with every
/// gate approved, writes the recorded event log to <out.json>, then exits.
/// Used to verify the backend and to record the sample run the browser preview replays.
fn selftest(handle: tauri::AppHandle, state: Arc<AppState>, out: String) {
    use tauri::Listener;
    let st = state.clone();
    let h2 = handle.clone();
    let out2 = out.clone();
    handle.listen("lab-event", move |ev| {
        let Ok(p) = serde_json::from_str::<Value>(ev.payload()) else { return };
        let Some(e) = p.get("event") else { return };
        match e["kind"].as_str() {
            Some("gate_open") if e["data"]["auto"].is_null() => {
                let kind = e["data"]["kind"].as_str().unwrap_or("");
                let decision = match kind {
                    "framing" | "experiment" => "approve",
                    "resource" => "grant_once",
                    "promotion" => "accept",
                    _ => "constrain",
                };
                let id = e["data"]["id"].as_str().unwrap_or("").to_string();
                let st = st.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(300));
                    let _ = orchestrator::resolve(
                        &st,
                        &id,
                        Decision { decision: decision.into(), note: Some("selftest".into()), edits: None },
                    );
                });
            }
            Some("run_ended") => {
                let run_id = e["run_id"].as_str().unwrap_or("");
                let events = st.store.events(run_id).unwrap_or_default();
                let verify = st.store.verify(run_id).unwrap_or((0, None));
                let _ = std::fs::write(&out2, serde_json::to_string_pretty(&events).unwrap());
                println!("SELFTEST ended: {} events, chain {:?}, data: {}", events.len(), verify, e["data"]);
                h2.exit(0);
            }
            _ => {}
        }
    });
    tauri::async_runtime::spawn(async move {
        let params = StartParams {
            question: std::env::var("ELENCHIA_SELFTEST_Q").unwrap_or_else(|_| "Does adding weight decay actually improve validation accuracy for my small CNN, or is the gain just tuning noise?".into()),
            constraints: vec![],
            offlimits: vec![],
            max_turns: 60,
            max_minutes: 10,
            dataset: None,
            source_ids: vec![],
        };
        match {
            let mut lab = roles::default_lab();
            if let Ok(m) = std::env::var("ELENCHIA_SELFTEST_MODEL") {
                if let Some((rt, name)) = m.split_once(':') {
                    for a in lab.agents.iter_mut() {
                        a.model.runtime = rt.into();
                        a.model.model = name.into();
                    }
                }
            }
            orchestrator::start(state, lab, params)
        }.await {
            Ok(id) => println!("SELFTEST started run {id}"),
            Err(e) => {
                println!("SELFTEST failed to start: {e}");
                std::process::exit(2)
            }
        }
    });
}
