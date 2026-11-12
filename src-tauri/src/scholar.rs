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
        ("select", "title,publication_year,doi,cited_by_count,authorships,primary_location,abstract_inverted_index,id"),
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
                "source": "OpenAlex",
            })
        })
        .collect())
}

async fn semantic(http: &reqwest::Client, q: &str) -> Result<Vec<Value>> {
    let r = http
        .get("https://api.semanticscholar.org/graph/v1/paper/search")
        .query(&[("query", q), ("limit", &LIMIT.to_string()), ("fields", "title,year,authors,abstract,externalIds,citationCount,venue,url")])
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
                "source": "Semantic Scholar",
            })
        })
        .collect())
}

/// Search for papers. Returns numbered records, best match first.
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
    for (i, p) in papers.iter_mut().enumerate() {
        p["n"] = json!(i + 1);
    }
    Ok(papers)
}

/// Compact text block handed to the agents. Only retrieved records appear here.
pub fn as_context(papers: &[Value]) -> String {
    let mut s = String::from("LITERATURE (retrieved from a scholarly index; cite as [n]; never cite anything not listed here):\n");
    for p in papers {
        s += &format!(
            "[{}] {} — {} ({}){}\n    {}\n",
            p["n"], p["title"].as_str().unwrap_or(""), p["authors"].as_str().unwrap_or(""), p["year"],
            p["venue"].as_str().map(|v| format!(", {v}")).unwrap_or_default(),
            p["abstract"].as_str().filter(|a| !a.is_empty()).unwrap_or("(no abstract available)"),
        );
    }
    s
}
