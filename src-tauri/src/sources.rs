//! Reference material the human attaches to a run: PDFs and text files from disk,
//! or a URL. Text is extracted locally. A URL is fetched only because the user
//! typed it in; nothing is fetched on the lab's own initiative.

use anyhow::{anyhow, Result};
use std::path::Path;
use std::time::Duration;

const MAX_BYTES: usize = 25 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct Source {
    pub id: String,
    pub name: String,
    pub origin: String, // path or URL
    pub kind: String,   // "pdf" | "text" | "web"
    pub text: String,
}

fn pdf_text(bytes: Vec<u8>) -> Result<String> {
    // pdf-extract can panic on malformed files; contain that.
    let r = std::panic::catch_unwind(|| pdf_extract::extract_text_from_mem(&bytes));
    match r {
        Ok(Ok(t)) => Ok(t),
        Ok(Err(e)) => Err(anyhow!("could not read this PDF: {e}")),
        Err(_) => Err(anyhow!("could not read this PDF (malformed)")),
    }
}

fn tidy(t: &str) -> String {
    let mut out = String::new();
    let mut blank = 0;
    for line in t.replace('\r', "").lines() {
        let l = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if l.is_empty() {
            blank += 1;
            if blank == 1 && !out.is_empty() {
                out.push('\n');
            }
        } else {
            blank = 0;
            out.push_str(&l);
            out.push('\n');
        }
    }
    out.trim().to_string()
}

fn html_to_text(html: &str) -> (String, Option<String>) {
    let lower = html.to_lowercase();
    let title = lower.find("<title").and_then(|s| {
        let a = lower[s..].find('>')? + s + 1;
        let b = lower[a..].find("</title>")? + a;
        Some(html[a..b].trim().to_string())
    });
    let mut out = String::with_capacity(html.len() / 2);
    let (b, l) = (html.as_bytes(), lower.as_bytes());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'<' {
            // Drop whole script/style/noscript blocks.
            let mut skipped = false;
            for tag in ["script", "style", "noscript", "svg"] {
                if l[i..].starts_with(format!("<{tag}").as_bytes()) {
                    let close = format!("</{tag}>");
                    i = lower[i..].find(&close).map(|p| i + p + close.len()).unwrap_or(b.len());
                    skipped = true;
                    break;
                }
            }
            if skipped {
                continue;
            }
            let block = ["<p", "<br", "<div", "<li", "<h1", "<h2", "<h3", "<tr", "</p", "</div", "</h"].iter().any(|t| l[i..].starts_with(t.as_bytes()));
            while i < b.len() && b[i] != b'>' {
                i += 1;
            }
            i += 1;
            out.push(if block { '\n' } else { ' ' });
        } else {
            let start = i;
            while i < b.len() && b[i] != b'<' {
                i += 1;
            }
            out.push_str(&html[start..i]);
        }
    }
    let out = out.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'");
    (tidy(&out), title)
}

fn finish(name: String, origin: String, kind: &str, text: String) -> Result<Source> {
    let text = tidy(&text);
    if text.chars().count() < 40 {
        return Err(anyhow!("no readable text found in {name} (scanned PDFs need OCR, which Elenchia does not do yet)"));
    }
    Ok(Source { id: uuid::Uuid::new_v4().to_string(), name, origin, kind: kind.into(), text })
}

pub async fn from_path(path: &Path) -> Result<Source> {
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "file".into());
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let meta = tokio::fs::metadata(path).await.map_err(|e| anyhow!("cannot open {name}: {e}"))?;
    if meta.len() as usize > MAX_BYTES {
        return Err(anyhow!("{name} is larger than 25 MB"));
    }
    let bytes = tokio::fs::read(path).await.map_err(|e| anyhow!("cannot read {name}: {e}"))?;
    let origin = path.display().to_string();
    match ext.as_str() {
        "pdf" => {
            let t = tokio::task::spawn_blocking(move || pdf_text(bytes)).await??;
            finish(name, origin, "pdf", t)
        }
        "html" | "htm" => {
            let (t, _) = html_to_text(&String::from_utf8_lossy(&bytes));
            finish(name, origin, "text", t)
        }
        "txt" | "md" | "markdown" | "csv" | "tsv" | "json" | "tex" | "bib" | "rst" | "log" | "xml" | "yaml" | "yml" => {
            finish(name, origin, "text", String::from_utf8_lossy(&bytes).to_string())
        }
        other => Err(anyhow!("{name}: unsupported file type “.{other}”. Use PDF, text, Markdown, CSV, LaTeX or HTML.")),
    }
}

pub async fn from_url(http: &reqwest::Client, url: &str) -> Result<Source> {
    let u = url.trim();
    if !(u.starts_with("http://") || u.starts_with("https://")) {
        return Err(anyhow!("enter a full link starting with http:// or https://"));
    }
    let r = http.get(u).timeout(Duration::from_secs(30)).header("Accept", "text/html,application/pdf,text/plain").send().await.map_err(|e| anyhow!("could not fetch the link: {e}"))?;
    if !r.status().is_success() {
        return Err(anyhow!("the link returned {}", r.status()));
    }
    let ctype = r.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_lowercase();
    let bytes = r.bytes().await.map_err(|e| anyhow!("download failed: {e}"))?;
    if bytes.len() > MAX_BYTES {
        return Err(anyhow!("that file is larger than 25 MB"));
    }
    let host = u.split('/').nth(2).unwrap_or(u).to_string();
    let last = u.split('?').next().unwrap_or(u).trim_end_matches('/').rsplit('/').next().unwrap_or("").to_string();
    let is_pdf = ctype.contains("pdf") || bytes.starts_with(b"%PDF");
    if is_pdf {
        let v = bytes.to_vec();
        let t = tokio::task::spawn_blocking(move || pdf_text(v)).await??;
        let name = if last.is_empty() || last == host { format!("{host}.pdf") } else { last };
        return finish(name, u.into(), "pdf", t);
    }
    let body = String::from_utf8_lossy(&bytes).to_string();
    if ctype.contains("html") || body.trim_start().starts_with('<') {
        let (t, title) = html_to_text(&body);
        return finish(title.filter(|t| !t.is_empty()).unwrap_or(host), u.into(), "web", t);
    }
    finish(if last.is_empty() { host } else { last }, u.into(), "web", body)
}

/// Pick the passages most relevant to the question, in reading order, within a
/// character budget (local models have small context windows). Returns the
/// excerpt and whether anything was left out.
pub fn excerpt(text: &str, question: &str, cap: usize) -> (String, bool) {
    if text.chars().count() <= cap {
        return (text.to_string(), false);
    }
    let terms: Vec<String> = question
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.len() > 3)
        .map(String::from)
        .collect();
    // Paragraphs, merged so tiny lines (PDF line breaks) do not dominate.
    let mut paras: Vec<String> = vec![];
    for p in text.split("\n\n") {
        let p = p.replace('\n', " ");
        match paras.last_mut() {
            Some(last) if last.chars().count() < 200 => {
                last.push(' ');
                last.push_str(&p);
            }
            _ => paras.push(p),
        }
    }
    let mut scored: Vec<(usize, i64)> = paras
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let lp = p.to_lowercase();
            let hits = terms.iter().filter(|t| lp.contains(t.as_str())).count() as i64;
            // Lead paragraphs (abstract/intro) get a small bonus.
            (i, hits * 10 + if i < 3 { 15 } else { 0 })
        })
        .collect();
    scored.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let mut chosen: Vec<usize> = vec![];
    let mut used = 0;
    for (i, _) in scored {
        let n = paras[i].chars().count().min(900);
        if used + n > cap {
            continue;
        }
        used += n;
        chosen.push(i);
    }
    chosen.sort_unstable();
    let body = chosen.iter().map(|&i| paras[i].chars().take(900).collect::<String>()).collect::<Vec<_>>().join("\n…\n");
    (body, true)
}
