//! Runtime adapters: one interface over Ollama and LM Studio (both local-only),
//! plus hardware awareness. Nothing here talks to anything but localhost
//! unless the user pointed a base URL elsewhere.

use anyhow::{anyhow, Result};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ModelRef {
    pub runtime: String, // "ollama" | "lmstudio" | "demo"
    pub model: String,
    #[serde(default = "d_temp")]
    pub temperature: f32,
    #[serde(default = "d_tokens")]
    pub max_tokens: u32,
}
fn d_temp() -> f32 {
    0.4
}
fn d_tokens() -> u32 {
    1800
}

#[derive(Serialize, Clone, Debug)]
pub struct ChatMsg {
    pub role: String,
    pub content: String,
}
impl ChatMsg {
    pub fn new(role: &str, content: impl Into<String>) -> Self {
        Self { role: role.into(), content: content.into() }
    }
}

#[derive(Clone, Debug)]
pub struct Urls {
    pub ollama: String,
    pub lmstudio: String,
}
impl Default for Urls {
    fn default() -> Self {
        Self { ollama: "http://127.0.0.1:11434".into(), lmstudio: "http://127.0.0.1:1234".into() }
    }
}

fn trim(u: &str) -> &str {
    u.trim_end_matches('/')
}

/// Probe both servers and the machine. Never fails: absent things are reported absent.
pub async fn detect(http: &reqwest::Client, urls: &Urls) -> Value {
    let probe_timeout = Duration::from_millis(1500);

    let ollama = async {
        let r = http.get(format!("{}/api/tags", trim(&urls.ollama))).timeout(probe_timeout).send().await.ok()?;
        let v: Value = r.json().await.ok()?;
        let models: Vec<Value> = v["models"]
            .as_array()?
            .iter()
            .map(|m| {
                json!({
                    "id": m["name"], "size": m["size"],
                    "family": m["details"]["family"], "params": m["details"]["parameter_size"],
                    "quant": m["details"]["quantization_level"],
                })
            })
            .collect();
        Some(models)
    };
    let lmstudio = async {
        let r = http.get(format!("{}/v1/models", trim(&urls.lmstudio))).timeout(probe_timeout).send().await.ok()?;
        let v: Value = r.json().await.ok()?;
        let models: Vec<Value> = v["data"]
            .as_array()?
            .iter()
            .filter(|m| !m["id"].as_str().unwrap_or("").contains("embed"))
            .map(|m| json!({"id": m["id"], "size": Value::Null, "family": Value::Null}))
            .collect();
        Some(models)
    };
    let (o, l) = tokio::join!(ollama, lmstudio);

    json!({
        "ollama": {"up": o.is_some(), "url": urls.ollama, "models": o.unwrap_or_default()},
        "lmstudio": {"up": l.is_some(), "url": urls.lmstudio, "models": l.unwrap_or_default()},
        "hardware": hardware().await,
        "python": crate::sandbox::find_python().await,
    })
}

async fn hardware() -> Value {
    use sysinfo::System;
    let mut sys = System::new().expect("sysinfo");
    sys.refresh_memory();
    let gb = |b: u64| (b as f64 / 1_073_741_824.0 * 10.0).round() / 10.0;
    let mut vram = Value::Null;
    let mut cmd = tokio::process::Command::new("nvidia-smi");
    cmd.args(["--query-gpu=name,memory.total,memory.free", "--format=csv,noheader,nounits"]);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    if let Ok(Ok(out)) = tokio::time::timeout(Duration::from_secs(3), cmd.output()).await {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout);
            if let Some(line) = s.lines().next() {
                let p: Vec<&str> = line.split(',').map(|x| x.trim()).collect();
                if p.len() == 3 {
                    vram = json!({"gpu": p[0],
                                  "total_gb": p[1].parse::<f64>().unwrap_or(0.0) / 1024.0,
                                  "free_gb": p[2].parse::<f64>().unwrap_or(0.0) / 1024.0});
                }
            }
        }
    }
    json!({"ram_total_gb": gb(sys.total_memory()), "ram_free_gb": gb(sys.available_memory()), "vram": vram})
}

/// Stream one chat completion. `on_delta` returns false to abort (run halted).
/// Returns the full text.
pub async fn chat_stream(
    http: &reqwest::Client,
    urls: &Urls,
    m: &ModelRef,
    msgs: &[ChatMsg],
    mut on_delta: impl FnMut(&str) -> bool,
) -> Result<String> {
    let (url, body, ndjson) = match m.runtime.as_str() {
        "ollama" => (
            format!("{}/api/chat", trim(&urls.ollama)),
            json!({"model": m.model, "messages": msgs, "stream": true, "format": "json",
                   "options": {"temperature": m.temperature, "num_predict": m.max_tokens}}),
            true,
        ),
        "lmstudio" => (
            format!("{}/v1/chat/completions", trim(&urls.lmstudio)),
            json!({"model": m.model, "messages": msgs, "stream": true,
                   "temperature": m.temperature, "max_tokens": m.max_tokens}),
            false,
        ),
        other => return Err(anyhow!("unknown runtime '{other}'")),
    };
    let resp = http
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| anyhow!("cannot reach {} at {url}: {e}", m.runtime))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(anyhow!("{} returned {status}: {}", m.runtime, text.chars().take(300).collect::<String>()));
    }
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut full = String::new();
    let mut pending: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        pending.extend_from_slice(&chunk.map_err(|e| anyhow!("stream broke: {e}"))?);
        // Only decode complete UTF-8 prefixes so multi-byte chars split across chunks survive.
        let valid = match std::str::from_utf8(&pending) {
            Ok(s) => s.len(),
            Err(e) => e.valid_up_to(),
        };
        buf.push_str(std::str::from_utf8(&pending[..valid]).unwrap());
        pending.drain(..valid);
        while let Some(nl) = buf.find('\n') {
            let line: String = buf.drain(..=nl).collect();
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let delta = if ndjson {
                let v: Value = serde_json::from_str(line).map_err(|e| anyhow!("bad stream line: {e}"))?;
                if let Some(err) = v["error"].as_str() {
                    return Err(anyhow!("ollama: {err}"));
                }
                v["message"]["content"].as_str().unwrap_or("").to_string()
            } else {
                let Some(data) = line.strip_prefix("data:") else { continue };
                let data = data.trim();
                if data == "[DONE]" {
                    continue;
                }
                let v: Value = serde_json::from_str(data).unwrap_or(Value::Null);
                v["choices"][0]["delta"]["content"].as_str().unwrap_or("").to_string()
            };
            if !delta.is_empty() {
                full.push_str(&delta);
                if !on_delta(&delta) {
                    return Err(anyhow!("aborted"));
                }
            }
        }
    }
    if full.trim().is_empty() {
        return Err(anyhow!("{} returned an empty reply (is the model loaded?)", m.runtime));
    }
    Ok(full)
}
