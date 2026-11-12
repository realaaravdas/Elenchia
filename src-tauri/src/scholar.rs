//! Literature search: the only code in Elenchia that talks to the internet, and
//! only after the user turns it on (Settings) and approves each query at a gate.
//!
//! Google Scholar has no official API and blocks automated access, so this uses
//! OpenAlex (primary) and Semantic Scholar (fallback): free, official, scholarly.
//! Only the query text is sent. Nothing about the lab, models or data goes out.

use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::time::Duration;

const LIMIT: usize = 8;

fn clip(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(n).collect::<String>().trim_end())
    }
}

fn authors(names: Vec<String>) -> String {
    match names.len() {
        0 => "unknown authors".into(),
        1..=4 => names.join(", "),
        _ => format!("{} et al.", names[..3].join(", ")),
    }
}

/// OpenAlex stores abstracts as {word: [positions]}; put them back in order.
fn abstract_of(inv: &Value) -> String {
    let Some(map) = inv.as_object() else { return String::new() };
    let mut words: Vec<(u64, &str)> = vec![];
    for (w, pos) in map {
        for p in pos.as_array().into_iter().flatten().filter_map(|x| x.as_u64()) {
            words.push((p, w.as_str()));
        }
    }
    words.sort_by_key(|x| x.0);
    words.iter().map(|x| x.1).collect::<Vec<_>>().join(" ")
}

async fn openalex(http: &reqwest::Client, q: &str, key: Option<&str>) -> Result<Vec<Value>> {
    let mut req = http.get("https://api.openalex.org/works").query(&[
        ("search", q),
        ("per-page", &LIMIT.to_string()),
        ("select", "title,publication_year,doi,cited_by_count,authorships,primary_location,abstract_inverted_index,id,open_access"),
    ]);
    if let Some(k) = key.filter(|k| !k.trim().is_empty()) {
        req = req.query(&[("api_key", k.trim())]);
    }
    let r = req.timeout(Duration::from_secs(15)).send().await.map_err(|e| anyhow!("openalex unreachable: {e}"))?;
    if !r.status().is_success() {
        return Err(anyhow!("openalex returned {}", r.status()));
    }
    let v: Value = r.json().await?;
    Ok(v["results"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|w| w["title"].as_str().is_some())
        .map(|w| {
            let names = w["authorships"].as_array().into_iter().flatten().filter_map(|a| a["author"]["display_name"].as_str().map(String::from)).collect();
            json!({
                "title": w["title"], "authors": authors(names), "year": w["publication_year"],
                "venue": w["primary_location"]["source"]["display_name"],
                "doi": w["doi"], "url": w["doi"].as_str().map(String::from).or_else(|| w["id"].as_str().map(String::from)),
                "cited_by": w["cited_by_count"], "abstract": clip(&abstract_of(&w["abstract_inverted_index"]), 700),
                "oa_url": w["open_access"]["oa_url"], "source": "OpenAlex",
            })
        })
        .collect())
}

async fn semantic(http: &reqwest::Client, q: &str) -> Result<Vec<Value>> {
    let r = http
        .get("https://api.semanticscholar.org/graph/v1/paper/search")
        .query(&[("query", q), ("limit", &LIMIT.to_string()), ("fields", "title,year,authors,abstract,externalIds,citationCount,venue,url,openAccessPdf")])
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| anyhow!("semantic scholar unreachable: {e}"))?;
    if !r.status().is_success() {
        return Err(anyhow!("semantic scholar returned {}", r.status()));
    }
    let v: Value = r.json().await?;
    Ok(v["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| p["title"].as_str().is_some())
        .map(|p| {
            let names = p["authors"].as_array().into_iter().flatten().filter_map(|a| a["name"].as_str().map(String::from)).collect();
            let doi = p["externalIds"]["DOI"].as_str().map(|d| format!("https://doi.org/{d}"));
            json!({
                "title": p["title"], "authors": authors(names), "year": p["year"], "venue": p["venue"],
                "doi": doi, "url": doi.clone().or_else(|| p["url"].as_str().map(String::from)),
                "cited_by": p["citationCount"], "abstract": clip(p["abstract"].as_str().unwrap_or(""), 700),
                "oa_url": p["openAccessPdf"]["url"], "source": "Semantic Scholar",
            })
        })
        .collect())
}

/// Search for papers. Returns records, best match first (the caller numbers them).
pub async fn search(http: &reqwest::Client, query: &str, openalex_key: Option<&str>) -> Result<Vec<Value>> {
    let q = query.trim();
    if q.is_empty() {
        return Err(anyhow!("empty query"));
    }
    let first = openalex(http, q, openalex_key).await;
    let mut papers = match first {
        Ok(p) if !p.is_empty() => p,
        other => {
            let why = other.err().map(|e| e.to_string());
            match semantic(http, q).await {
                Ok(p) => p,
                Err(e2) => return Err(anyhow!("{}; {e2}", why.unwrap_or_else(|| "openalex found nothing".into()))),
            }
        }
    };
    papers.truncate(LIMIT);
    Ok(papers)
}

fn strip_tags(s: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for ch in s.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.replace("&amp;", "&").replace("&quot;", "\"").replace("&#x27;", "'").replace("&#39;", "'").replace("&nbsp;", " ")
}

/// General web search through a provider the user configured: Brave Search
/// (API key) or their own SearXNG instance. There is deliberately no scraping
/// of Google/Bing, which is unreliable and against their terms.
pub async fn web(http: &reqwest::Client, query: &str, brave_key: Option<&str>, searxng: Option<&str>) -> Result<Vec<Value>> {
    let q = query.trim();
    if q.is_empty() {
        return Err(anyhow!("empty query"));
    }
    if let Some(k) = brave_key.map(str::trim).filter(|k| !k.is_empty()) {
        let r = http
            .get("https://api.search.brave.com/res/v1/web/search")
            .query(&[("q", q), ("count", "8")])
            .header("X-Subscription-Token", k)
            .header("Accept", "application/json")
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| anyhow!("brave search unreachable: {e}"))?;
        if !r.status().is_success() {
            return Err(anyhow!("brave search returned {} (check the API key)", r.status()));
        }
        let v: Value = r.json().await?;
        return Ok(v["web"]["results"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|x| x["url"].as_str().is_some())
            .map(|x| json!({"title": strip_tags(x["title"].as_str().unwrap_or("")), "url": x["url"],
                            "snippet": clip(&strip_tags(x["description"].as_str().unwrap_or("")), 500), "source": "Brave Search"}))
            .collect());
    }
    if let Some(base) = searxng.map(|s| s.trim().trim_end_matches('/')).filter(|s| !s.is_empty()) {
        let r = http
            .get(format!("{base}/search"))
            .query(&[("q", q), ("format", "json")])
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .map_err(|e| anyhow!("searxng unreachable: {e}"))?;
        if !r.status().is_success() {
            return Err(anyhow!("searxng returned {} (is the json format enabled?)", r.status()));
        }
        let v: Value = r.json().await?;
        return Ok(v["results"]
            .as_array()
            .into_iter()
            .flatten()
            .take(LIMIT)
            .filter(|x| x["url"].as_str().is_some())
            .map(|x| json!({"title": x["title"], "url": x["url"], "snippet": clip(x["content"].as_str().unwrap_or(""), 500), "source": "SearXNG"}))
            .collect());
    }
    Err(anyhow!("web search is not configured (add a Brave Search API key or a SearXNG URL in Settings)"))
}

/// Compact text block handed to the agents. Only retrieved records appear here.
pub fn as_context(papers: &[Value], web: &[Value]) -> String {
    let mut s = String::new();
    if !papers.is_empty() {
        s += "LITERATURE (retrieved from a scholarly index; cite as [n]; never cite anything not listed here):\n";
        for p in papers {
            s += &format!(
                "[{}] {} — {} ({}){}\n    {}\n",
                p["n"], p["title"].as_str().unwrap_or(""), p["authors"].as_str().unwrap_or(""), p["year"],
                p["venue"].as_str().map(|v| format!(", {v}")).unwrap_or_default(),
                p["abstract"].as_str().filter(|a| !a.is_empty()).unwrap_or("(no abstract available)"),
            );
            if let Some(f) = p["fulltext"].as_str().filter(|f| !f.is_empty()) {
                s += &format!("    FULL-TEXT EXCERPTS [{}]: {}\n", p["n"], f);
            }
        }
    }
    if !web.is_empty() {
        s += "\nWEB RESULTS (retrieved from a web search; cite as [Wn]; pages may be wrong or biased, weigh them accordingly):\n";
        for w in web {
            s += &format!("[{}] {} <{}>\n    {}\n", w["n"], w["title"].as_str().unwrap_or(""), w["url"].as_str().unwrap_or(""), w["snippet"].as_str().unwrap_or(""));
            if let Some(f) = w["fulltext"].as_str().filter(|f| !f.is_empty()) {
                s += &format!("    PAGE EXCERPTS [{}]: {}\n", w["n"], f);
            }
        }
    }
    s
}
