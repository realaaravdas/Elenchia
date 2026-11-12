//! The built-in browser the agents can use.
//!
//! A real Chromium (the Edge or Chrome already on the machine) runs in the
//! background with a throwaway profile (no cookies, no logins, no extensions,
//! downloads denied) and is driven over the Chrome DevTools Protocol. The app
//! shows the user what it sees (URL + live screenshot), and every page the
//! agents open is logged. Pages are untrusted data, never instructions.

use anyhow::{anyhow, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{path::PathBuf, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
};
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

pub struct Browser {
    child: Child,
    ws: Ws,
    next: u64,
    dir: PathBuf,
}

pub struct Page {
    pub url: String,
    pub title: String,
    pub text: String,
}

/// Locate Edge or Chrome without any registry lookups.
pub fn find_browser() -> Option<PathBuf> {
    let mut c: Vec<PathBuf> = vec![];
    for var in ["PROGRAMFILES(X86)", "PROGRAMFILES", "LOCALAPPDATA"] {
        if let Ok(base) = std::env::var(var) {
            let b = PathBuf::from(base);
            c.push(b.join("Microsoft/Edge/Application/msedge.exe"));
            c.push(b.join("Google/Chrome/Application/chrome.exe"));
            c.push(b.join("Chromium/Application/chrome.exe"));
        }
    }
    for p in [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/microsoft-edge",
    ] {
        c.push(PathBuf::from(p));
    }
    c.into_iter().find(|p| p.exists())
}

/// Refuse anything that is not a public http(s) page: no local files, no
/// loopback/LAN addresses (the local model server, routers, other services).
pub fn check_url(url: &str) -> Result<()> {
    let u = url.trim();
    let rest = u.strip_prefix("https://").or_else(|| u.strip_prefix("http://")).ok_or_else(|| anyhow!("only http(s) links can be opened"))?;
    let host = rest.split(['/', '?', '#']).next().unwrap_or("").rsplit('@').next().unwrap_or("");
    let host = host.rsplit_once(':').filter(|(_, p)| p.chars().all(|c| c.is_ascii_digit())).map(|(h, _)| h).unwrap_or(host).trim_matches(['[', ']']).to_lowercase();
    let private = host.is_empty()
        || host == "localhost"
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host == "::1"
        || host.starts_with("127.")
        || host.starts_with("10.")
        || host.starts_with("192.168.")
        || host.starts_with("169.254.")
        || host == "0.0.0.0"
        || host.strip_prefix("172.").and_then(|r| r.split('.').next()).and_then(|o| o.parse::<u8>().ok()).map(|o| (16..=31).contains(&o)).unwrap_or(false);
    if private {
        return Err(anyhow!("refused: that address is on this machine or your local network"));
    }
    Ok(())
}

pub fn encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

impl Browser {
    pub async fn launch(visible: bool) -> Result<Browser> {
        let exe = find_browser().ok_or_else(|| anyhow!("no Edge or Chrome found on this machine"))?;
        let dir = std::env::temp_dir().join(format!("elenchia-browser-{}", uuid::Uuid::new_v4()));
        let mut cmd = Command::new(&exe);
        cmd.args([
            "--remote-debugging-port=0",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions",
            "--disable-sync",
            "--disable-background-networking",
            "--mute-audio",
            "--window-size=1280,900",
        ]);
        cmd.arg(format!("--user-data-dir={}", dir.display()));
        if !visible {
            cmd.arg("--headless=new");
            #[cfg(windows)]
            cmd.creation_flags(0x0800_0000);
        }
        cmd.arg("about:blank").stdout(Stdio::null()).stderr(Stdio::piped()).stdin(Stdio::null()).kill_on_drop(true);
        let mut child = cmd.spawn().map_err(|e| anyhow!("could not start the browser: {e}"))?;
        let stderr = child.stderr.take().ok_or_else(|| anyhow!("no browser output"))?;
        let mut lines = BufReader::new(stderr).lines();
        let port = tokio::time::timeout(Duration::from_secs(20), async {
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(i) = line.find("ws://127.0.0.1:") {
                    let rest = &line[i + "ws://127.0.0.1:".len()..];
                    if let Some(p) = rest.split('/').next().and_then(|p| p.parse::<u16>().ok()) {
                        return Some(p);
                    }
                }
            }
            None
        })
        .await
        .map_err(|_| anyhow!("the browser did not start in time"))?
        .ok_or_else(|| anyhow!("the browser exited before it was ready"))?;
        // Keep draining stderr so the pipe never fills up and stalls the browser.
        tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });

        let mut ws_url = None;
        for _ in 0..20 {
            if let Ok(r) = reqwest::get(format!("http://127.0.0.1:{port}/json/list")).await {
                if let Ok(v) = r.json::<Value>().await {
                    ws_url = v.as_array().and_then(|a| a.iter().find(|t| t["type"] == "page")).and_then(|t| t["webSocketDebuggerUrl"].as_str().map(String::from));
                    if ws_url.is_some() {
                        break;
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        let ws_url = ws_url.ok_or_else(|| anyhow!("could not attach to the browser"))?;
        let (ws, _) = connect_async(&ws_url).await.map_err(|e| anyhow!("could not connect to the browser: {e}"))?;
        let mut b = Browser { child, ws, next: 0, dir };
        b.call("Page.enable", json!({})).await?;
        let _ = b.call("Page.setDownloadBehavior", json!({"behavior": "deny"})).await; // never save files
        Ok(b)
    }

    async fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        self.next += 1;
        let id = self.next;
        self.ws.send(Message::Text(json!({"id": id, "method": method, "params": params}).to_string())).await?;
        loop {
            let msg = tokio::time::timeout(Duration::from_secs(40), self.ws.next())
                .await
                .map_err(|_| anyhow!("the browser stopped responding"))?
                .ok_or_else(|| anyhow!("the browser closed"))??;
            if let Message::Text(t) = msg {
                let v: Value = serde_json::from_str(&t)?;
                if v["id"] == json!(id) {
                    if let Some(e) = v.get("error") {
                        return Err(anyhow!("browser error: {}", e["message"].as_str().unwrap_or("unknown")));
                    }
                    return Ok(v["result"].clone());
                }
            }
        }
    }

    pub async fn eval(&mut self, js: &str) -> Result<Value> {
        let r = self.call("Runtime.evaluate", json!({"expression": js, "returnByValue": true, "awaitPromise": true})).await?;
        if let Some(ex) = r.get("exceptionDetails") {
            return Err(anyhow!("page script failed: {}", ex["text"].as_str().unwrap_or("error")));
        }
        Ok(r["result"]["value"].clone())
    }

    /// Navigate and wait for the page to finish loading (bounded).
    pub async fn goto(&mut self, url: &str) -> Result<()> {
        check_url(url)?;
        self.call("Page.navigate", json!({"url": url})).await?;
        for _ in 0..80 {
            tokio::time::sleep(Duration::from_millis(300)).await;
            if self.eval("document.readyState").await.ok().and_then(|v| v.as_str().map(String::from)).as_deref() == Some("complete") {
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(700)).await; // let scripts render
        // A redirect may have landed somewhere private; refuse to read it.
        let now = self.eval("location.href").await?;
        if let Some(u) = now.as_str() {
            if u.starts_with("http") {
                check_url(u)?;
            }
        }
        Ok(())
    }

    pub async fn read(&mut self) -> Result<Page> {
        let v = self
            .eval("JSON.stringify({url:location.href,title:document.title,text:(document.body?document.body.innerText:'').slice(0,80000)})")
            .await?;
        let p: Value = serde_json::from_str(v.as_str().unwrap_or("{}"))?;
        Ok(Page {
            url: p["url"].as_str().unwrap_or("").into(),
            title: p["title"].as_str().unwrap_or("").into(),
            text: p["text"].as_str().unwrap_or("").into(),
        })
    }

    /// Small JPEG (base64) of what the browser is showing, for the live view.
    pub async fn screenshot(&mut self) -> Result<String> {
        let r = self.call("Page.captureScreenshot", json!({"format": "jpeg", "quality": 45})).await?;
        Ok(r["data"].as_str().unwrap_or("").to_string())
    }

    /// Background search on Wikipedia, read through the page itself. General web
    /// search engines show bot challenges to automated browsers, and bypassing
    /// those is off the table, so full web search goes through the user's own
    /// SearXNG instance; everything else is reached with `goto` on a specific URL.
    pub async fn search(&mut self, query: &str) -> Result<Vec<Value>> {
        self.goto(&format!("https://en.wikipedia.org/w/index.php?search={}&fulltext=1&ns0=1", encode(query))).await?;
        let v = self
            .eval(
                r#"JSON.stringify((() => {
                    const items = [...document.querySelectorAll('li.mw-search-result')].slice(0, 8).map(li => {
                        const a = li.querySelector('.mw-search-result-heading a'); if (!a) return null;
                        const s = li.querySelector('.searchresult');
                        return {title: a.innerText.trim(), url: a.href, snippet: s ? s.innerText.trim() : ''};
                    }).filter(Boolean);
                    if (items.length) return items;
                    // An exact title match redirects straight to the article.
                    if (location.pathname.startsWith('/wiki/')) {
                        const p = document.querySelector('#mw-content-text p:not(.mw-empty-elt)');
                        return [{title: document.title.replace(' - Wikipedia', ''), url: location.href, snippet: p ? p.innerText.trim().slice(0, 500) : ''}];
                    }
                    return [];
                })())"#,
            )
            .await?;
        let arr: Vec<Value> = serde_json::from_str(v.as_str().unwrap_or("[]"))?;
        if arr.is_empty() {
            return Err(anyhow!("no results on Wikipedia for that query. For general web search, set a SearXNG URL in Settings, or have an agent open a specific page"));
        }
        Ok(arr
            .into_iter()
            .map(|mut r| {
                r["source"] = json!("Built-in browser (Wikipedia)");
                r
            })
            .collect())
    }
}

impl Drop for Browser {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
        let dir = self.dir.clone();
        // The profile directory can stay locked for a moment after the process dies.
        std::thread::spawn(move || {
            for _ in 0..5 {
                std::thread::sleep(Duration::from_secs(2));
                if std::fs::remove_dir_all(&dir).is_ok() {
                    break;
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn blocks_private_and_non_http() {
        for bad in ["file:///C:/x", "http://localhost:1234/v1", "http://127.0.0.1", "https://192.168.1.1/admin", "http://10.0.0.5", "http://172.20.0.1", "http://[::1]/", "ftp://x.org", "http://user@localhost/"] {
            assert!(check_url(bad).is_err(), "{bad}");
        }
        for ok in ["https://arxiv.org/abs/1", "http://example.com:8080/x?y=1", "https://172.15.0.1"] {
            assert!(check_url(ok).is_ok(), "{ok}");
        }
    }
    /// Needs Edge or Chrome and internet: `cargo test browser -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn drives_a_real_browser() {
        let mut b = Browser::launch(false).await.expect("launch");
        b.goto("https://example.com").await.expect("goto");
        let p = b.read().await.expect("read");
        println!("{} | {} | {} chars
{}", p.url, p.title, p.text.len(), p.text.chars().take(400).collect::<String>());
        assert!(p.text.to_lowercase().contains("documentation examples"));
        let shot = b.screenshot().await.expect("shot");
        assert!(shot.len() > 1000);
        assert!(b.goto("http://localhost:1234").await.is_err());
    }

    #[tokio::test]
    #[ignore]
    async fn searches_the_web() {
        let mut b = Browser::launch(false).await.expect("launch");
        
        let r = b.search("attention deficit hyperactivity disorder").await;
        println!("{:?}", r.as_ref().map(|v| v.iter().map(|x| format!("{} <{}>", x["title"], x["url"])).collect::<Vec<_>>()));
        assert!(r.is_ok());
    }

    #[test]
    fn encodes_queries() {
        assert_eq!(encode("a b&c"), "a+b%26c");
    }
}
