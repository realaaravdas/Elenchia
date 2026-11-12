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
        // Native listing (LM Studio 0.3.6+) knows type and loaded state; the
        // OpenAI-compatible one works everywhere. Try native, fall back.
        if let Ok(r) = http.get(format!("{}/api/v0/models", trim(&urls.lmstudio))).timeout(probe_timeout).send().await {
            if let Ok(v) = r.json::<Value>().await {
                if let Some(arr) = v["data"].as_array() {
                    let models: Vec<Value> = arr
                        .iter()
                        .filter(|m| {
                            let t = m["type"].as_str().unwrap_or("llm");
                            t != "embeddings" && !m["id"].as_str().unwrap_or("").contains("embed")
                        })
                        .map(|m| {
                            json!({"id": m["id"], "size": Value::Null, "family": m["arch"],
                                   "quant": m["quantization"], "loaded": m["state"] == "loaded"})
                        })
                        .collect();
                    return Some(models);
                }
            }
        }
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
async fn chat_once(
    http: &reqwest::Client,
    urls: &Urls,
    m: &ModelRef,
    msgs: &[ChatMsg],
    max_tokens: u32,
    on_delta: &mut impl FnMut(&str) -> bool,
) -> Result<(String, String)> {
    let (url, body, ndjson) = match m.runtime.as_str() {
        "ollama" => (
            format!("{}/api/chat", trim(&urls.ollama)),
            json!({"model": m.model, "messages": msgs, "stream": true, "format": "json",
                   "options": {"temperature": m.temperature, "num_predict": max_tokens}}),
            true,
        ),
        "lmstudio" => (
            format!("{}/v1/chat/completions", trim(&urls.lmstudio)),
            json!({"model": m.model, "messages": msgs, "stream": true,
                   "temperature": m.temperature, "max_tokens": max_tokens}),
            false,
        ),
        other => return Err(anyhow!("unknown runtime '{other}'")),
    };
    let send = |body: &Value| http.post(&url).json(body).send();
    let mut resp = send(&body).await.map_err(|e| anyhow!("cannot reach {} at {url}: {e}", m.runtime))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        // Some chat templates served by LM Studio (Gemma, Mistral variants) reject a
        // system role. Retry once with the system text folded into the first user turn.
        let lower = text.to_lowercase();
        let role_problem = m.runtime == "lmstudio"
            && status.as_u16() == 400
            && (lower.contains("role") || lower.contains("template") || lower.contains("jinja") || lower.contains("alternate"));
        if !role_problem {
            let hint = if m.runtime == "lmstudio" && lower.contains("model") {
                " (in LM Studio: download/load that model, or enable Just-In-Time loading in Developer settings)"
            } else {
                ""
            };
            return Err(anyhow!("{} returned {status}: {}{hint}", m.runtime, text.chars().take(300).collect::<String>()));
        }
        let sys: Vec<&str> = msgs.iter().filter(|x| x.role == "system").map(|x| x.content.as_str()).collect();
        let mut folded: Vec<ChatMsg> = msgs.iter().filter(|x| x.role != "system").cloned().collect();
        if let Some(first) = folded.iter_mut().find(|x| x.role == "user") {
            first.content = format!("{}\n\n{}", sys.join("\n\n"), first.content);
        } else {
            folded.insert(0, ChatMsg::new("user", sys.join("\n\n")));
        }
        let mut b2 = body.clone();
        b2["messages"] = json!(folded);
        resp = send(&b2).await.map_err(|e| anyhow!("cannot reach {} at {url}: {e}", m.runtime))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(anyhow!("{} returned {status}: {}", m.runtime, text.chars().take(300).collect::<String>()));
        }
    }
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut full = String::new();
    let mut reasoning = String::new();
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
                if let Some(err) = v["error"]["message"].as_str().or_else(|| v["error"].as_str()) {
                    return Err(anyhow!("lmstudio: {err}"));
                }
                // Thinking models stream their reasoning separately. It is kept only as a
                // last-resort source for the answer, never shown to the agents' peers.
                let d = &v["choices"][0]["delta"];
                if let Some(r) = d["reasoning_content"].as_str().or_else(|| d["reasoning"].as_str()) {
                    reasoning.push_str(r);
                }
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
    Ok((full, reasoning))
}

/// Reasoning models inline `<think>…</think>` in the reply. Drop it, including
/// an unterminated block, so only the answer remains.
pub fn strip_think(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(s) = rest.find("<think>") {
        out.push_str(&rest[..s]);
        match rest[s..].find("</think>") {
            Some(e) => rest = &rest[s + e + "</think>".len()..],
            None => return out,
        }
    }
    out.push_str(rest);
    // A lone closing tag means the opening one was consumed by the chat template.
    match out.rfind("</think>") {
        Some(i) => out[i + "</think>".len()..].to_string(),
        None => out,
    }
}

/// Stream one chat completion. `on_delta` returns false to abort (run halted).
/// Returns the answer text.
///
/// Thinking models (Qwen3, DeepSeek-R1, gpt-oss…) can burn the whole token limit
/// on reasoning and return no answer. LM Studio gets a generous floor, and an
/// empty answer is retried once with a much larger budget before giving up.
pub async fn chat_stream(
    http: &reqwest::Client,
    urls: &Urls,
    m: &ModelRef,
    msgs: &[ChatMsg],
    mut on_delta: impl FnMut(&str) -> bool,
) -> Result<String> {
    let base = if m.runtime == "lmstudio" { m.max_tokens.max(4096) } else { m.max_tokens };
    let (full, reasoning) = chat_once(http, urls, m, msgs, base, &mut on_delta).await?;
    if !strip_think(&full).trim().is_empty() {
        return Ok(full);
    }
    let mut reasoning = reasoning;
    if m.runtime == "lmstudio" || m.runtime == "ollama" {
        let big = (base * 4).clamp(8192, 16000);
        let (full2, r2) = chat_once(http, urls, m, msgs, big, &mut on_delta).await?;
        if !strip_think(&full2).trim().is_empty() {
            return Ok(full2);
        }
        reasoning = if r2.is_empty() { reasoning } else { r2 };
    }
    // Some servers put the whole answer in the reasoning channel.
    if reasoning.contains('{') && reasoning.contains('}') {
        return Ok(reasoning);
    }
    Err(anyhow!(
        "{} returned no answer for '{}'. If it is a thinking model it spent its whole budget reasoning: turn thinking off for it in LM Studio (model settings → Thinking / reasoning), raise this agent's max tokens, or pick a non-thinking instruct model. Otherwise check that the model is loaded.",
        m.runtime, m.model
    ))
}
