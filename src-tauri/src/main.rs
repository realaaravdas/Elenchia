#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod demo;
mod orchestrator;
mod roles;
mod runtime;
mod sandbox;
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
    let d = runtime::Urls::default();
    runtime::Urls {
        ollama: st.store.setting("ollama_url").unwrap_or(d.ollama),
        lmstudio: st.store.setting("lmstudio_url").unwrap_or(d.lmstudio),
    }
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
    json!({"ollama_url": u.ollama, "lmstudio_url": u.lmstudio, "data_dir": st.data_dir.display().to_string()})
}

#[tauri::command]
fn set_settings(st: S<'_>, ollama_url: String, lmstudio_url: String) -> Result<(), String> {
    st.store.set_setting("ollama_url", ollama_url.trim()).map_err(|e| e.to_string())?;
    st.store.set_setting("lmstudio_url", lmstudio_url.trim()).map_err(|e| e.to_string())
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
            });
            app.manage(state.clone());
            if let Ok(out) = std::env::var("ELENCHIA_SELFTEST") {
                selftest(app.handle().clone(), state, out);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            detect, default_lab, list_labs, save_lab, delete_lab, start_run, resolve_gate, halt_run,
            list_runs, run_events, verify_audit, get_settings, set_settings
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
