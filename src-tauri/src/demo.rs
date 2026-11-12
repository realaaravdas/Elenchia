//! Scripted demo lab. This is NOT a model: it is a deterministic script that
//! lets you see the whole product (debate, gates, sandbox, evidence grading,
//! promotion) on a machine with no Ollama or LM Studio. Every demo message is
//! labelled "demo (scripted)" in the UI. The experiment it proposes is a
//! real, seeded permutation test that is genuinely executed (Python if
//! available, otherwise a built-in kernel, labelled as such).

use serde_json::{json, Value};

const SENSITIVE: &[&str] = &["patient", "participant", "human subject", "personal data", "employee", "student"];

fn q_short(q: &str) -> String {
    let q = q.trim();
    if q.chars().count() > 140 {
        format!("{}…", q.chars().take(140).collect::<String>())
    } else {
        q.to_string()
    }
}

pub fn python_code(n: u32, true_d: f64, perms: u32) -> String {
    format!(
        r#"import os, json, math, random, statistics as st

seed = int(os.environ.get("ELENCHIA_SEED", "0"))
rng = random.Random(seed)
N, TRUE_D, PERMS = {n}, {true_d}, {perms}

# Simulated two-arm experiment: control ~ N(0,1), treatment ~ N(TRUE_D,1)
a = [rng.gauss(0, 1) for _ in range(N)]
b = [rng.gauss(TRUE_D, 1) for _ in range(N)]
diff = st.mean(b) - st.mean(a)

# Two-sided permutation test, single pre-registered comparison
pooled, hits = a + b, 0
for _ in range(PERMS):
    rng.shuffle(pooled)
    if abs(st.mean(pooled[N:]) - st.mean(pooled[:N])) >= abs(diff):
        hits += 1
p = (hits + 1) / (PERMS + 1)
sd = math.sqrt((st.variance(a) + st.variance(b)) / 2)
se = math.sqrt(st.variance(a) / N + st.variance(b) / N)
print("RESULT_JSON " + json.dumps({{
    "n_per_group": N, "mean_diff": round(diff, 4), "cohens_d": round(diff / sd, 4),
    "p_value": round(p, 4), "ci95": [round(diff - 1.96 * se, 4), round(diff + 1.96 * se, 4)],
    "permutations": PERMS, "seed": seed}}))
"#
    )
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        // splitmix64
        self.0 = self.0.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        z ^ (z >> 31)
    }
    fn unif(&mut self) -> f64 {
        ((self.next() >> 11) as f64 + 1.0) / ((1u64 << 53) as f64 + 1.0)
    }
    fn gauss(&mut self, mu: f64) -> f64 {
        mu + (-2.0 * self.unif().ln()).sqrt() * (2.0 * std::f64::consts::PI * self.unif()).cos()
    }
}

fn mean(v: &[f64]) -> f64 {
    v.iter().sum::<f64>() / v.len() as f64
}
fn var(v: &[f64]) -> f64 {
    let m = mean(v);
    v.iter().map(|x| (x - m).powi(2)).sum::<f64>() / (v.len() as f64 - 1.0)
}

/// Same experiment as `python_code`, for machines without Python.
pub fn native_kernel(params: &Value, seed: u64) -> String {
    let n = params["n"].as_u64().unwrap_or(40) as usize;
    let d = params["true_d"].as_f64().unwrap_or(0.25);
    let perms = params["perms"].as_u64().unwrap_or(2000) as usize;
    let mut r = Rng(seed ^ 0xA5A5_5A5A);
    let a: Vec<f64> = (0..n).map(|_| r.gauss(0.0)).collect();
    let b: Vec<f64> = (0..n).map(|_| r.gauss(d)).collect();
    let diff = mean(&b) - mean(&a);
    let mut pooled: Vec<f64> = a.iter().chain(b.iter()).cloned().collect();
    let mut hits = 0usize;
    for _ in 0..perms {
        for i in (1..pooled.len()).rev() {
            let j = (r.next() % (i as u64 + 1)) as usize;
            pooled.swap(i, j);
        }
        if (mean(&pooled[n..]) - mean(&pooled[..n])).abs() >= diff.abs() {
            hits += 1;
        }
    }
    let p = (hits as f64 + 1.0) / (perms as f64 + 1.0);
    let sd = ((var(&a) + var(&b)) / 2.0).sqrt();
    let se = (var(&a) / n as f64 + var(&b) / n as f64).sqrt();
    let r4 = |x: f64| (x * 10000.0).round() / 10000.0;
    format!(
        "[native demo kernel: Python not found, same algorithm run in Rust]\nRESULT_JSON {}\n",
        json!({"n_per_group": n, "mean_diff": r4(diff), "cohens_d": r4(diff / sd), "p_value": r4(p),
               "ci95": [r4(diff - 1.96 * se), r4(diff + 1.96 * se)], "permutations": perms, "seed": seed})
    )
}

pub fn respond(stage: &str, ctx: &Value) -> Value {
    let round = ctx["round"].as_u64().unwrap_or(1);
    let q = q_short(ctx["question"].as_str().unwrap_or("the research question"));
    let lower = ctx["question"].as_str().unwrap_or("").to_lowercase();
    match stage {
        "frame" => json!({
            "say": "I read this as a question about whether the effect is real or just noise. I'll hold the team to one pre-specified comparison.",
            "restated_question": format!("Is the effect implied by “{q}” distinguishable from noise under a pre-specified, adequately powered test?"),
            "scope": ["Simulated two-arm comparison", "Single pre-registered primary test", "Evidence graded before any claim is promoted"],
            "assumptions": ["Outcomes are roughly normal", "Samples are independent", "No tuning on the evaluation data"],
            "flags": []
        }),
        "hypothesize" => {
            let (c1, a1) = if round == 1 {
                ("There is a real effect of moderate size (d≈0.3–0.5) in the treatment arm.", vec!["Normal outcomes", "Independent samples", "One comparison, no tuning"])
            } else {
                ("There is a small real effect (d≈0.3). The pilot was underpowered, not null.", vec!["Normal outcomes", "n sized for 90% power", "Single pre-registered comparison"])
            };
            json!({
                "say": if round == 1 { "Two rival explanations: a genuine effect, or selection noise. I'm ranking the real effect first." } else { "Revising after the pilot: the first run was too small to tell. Same hypothesis, now with an honest power requirement." },
                "hypotheses": [
                    {"id": format!("H{}", round*2-1), "rank": 1, "claim": c1, "assumptions": a1,
                     "prediction": "A two-sided permutation test gives p < 0.05 and a 95% CI for the mean difference that excludes 0."},
                    {"id": format!("H{}", round*2), "rank": 2, "claim": "There is no real effect; apparent gains come from noise and best-of-k selection.",
                     "assumptions": ["Group means are equal", "Any observed gap is sampling variation"],
                     "prediction": "p-values are uniformly distributed; the CI includes 0 at adequate n."}
                ],
                "flags": []
            })
        }
        "challenge" => {
            let h1 = format!("H{}", round * 2 - 1);
            let h2 = format!("H{}", round * 2);
            let sensitive = round == 1 && SENSITIVE.iter().any(|s| lower.contains(s));
            let flags = if sensitive {
                json!([{"category": "privacy", "text": "The question mentions people. Confirm no identifiable data leaves the machine and that only aggregate or synthetic data is used."}])
            } else {
                json!([])
            };
            json!({
                "say": "Not convinced yet. The first claim never says how many samples it needs, and nothing stops us picking the best of several comparisons.",
                "objections": [
                    {"id": format!("O{}a", round), "hypothesis": h1, "severity": "major", "text": "No sample size is committed. A significant p-value from a small n is often a fluke (winner's curse); say how many samples and what power."},
                    {"id": format!("O{}b", round), "hypothesis": h1, "severity": "minor", "text": "How many variants were tried before this one? Without a single pre-registered comparison, p-values are not interpretable."},
                    {"id": format!("O{}c", round), "hypothesis": h2, "severity": "minor", "text": "The null needs a concrete prediction to be falsifiable, not just 'it was noise'."}
                ],
                "flags": flags
            })
        }
        "answer" => json!({
            "say": "Fair. I'll commit to one comparison and let the statistician set n. The null gets a stated false-positive expectation.",
            "answers": ctx["objections"].as_array().map(|os| os.iter().map(|o| json!({
                "objection": o["id"], "withdraw": false,
                "response": match o["id"].as_str().unwrap_or("").chars().last() {
                    Some('a') => "Agreed: n will be chosen by a power analysis before the run, not after.",
                    Some('b') => "One comparison only, declared up front. No other variants are being tested.",
                    _ => "Under the null, the permutation p-value is uniform; I expect p>0.05 at the pre-set alpha.",
                }
            })).collect::<Vec<_>>()).unwrap_or_default(),
            "flags": []
        }),
        "resolve" => json!({
            "say": "Those answers are acceptable as commitments. I'll hold you to them when I see the design.",
            "verdicts": ctx["objections"].as_array().map(|os| os.iter().map(|o| json!({
                "objection": o["id"], "resolved": true, "reason": "Answered with a concrete, checkable commitment."
            })).collect::<Vec<_>>()).unwrap_or_default(),
            "flags": []
        }),
        "design" => {
            let (n, d, perms) = if round == 1 { (40u32, 0.25f64, 2000u32) } else { (200u32, 0.3f64, 4000u32) };
            json!({
                "say": if round == 1 { "A pilot: two simulated arms of 40, one permutation test. Cheap to run, and it tells us whether a bigger study is worth it." } else { "Full study this time: 200 per arm, 4000 permutations, same single comparison." },
                "title": if round == 1 { "Pilot permutation test (n=40/arm)" } else { "Powered permutation test (n=200/arm)" },
                "hypothesis": format!("H{}", round * 2 - 1),
                "protocol": format!("Simulate control ~ N(0,1) and treatment ~ N({d},1), {n} per arm. Compute the mean difference, a two-sided permutation p-value ({perms} shuffles) and a normal-approximation 95% CI. Seed from ELENCHIA_SEED. One comparison only."),
                "code": python_code(n, d, perms),
                "est_seconds": if round == 1 { 3 } else { 10 },
                "needs": [],
                "demo_params": {"n": n, "true_d": d, "perms": perms},
                "flags": []
            })
        }
        "plan" => json!({
            "say": if round == 1 { "I'll allow this as a pilot only. At n=40 the power for d≈0.5 is around 60%, so a null here would not be informative." } else { "n=200 per arm gives about 90% power for d=0.3 at alpha 0.05. One look at the end, no peeking." },
            "test": "Two-sided permutation test on the mean difference",
            "alpha": 0.05,
            "n_per_group": if round == 1 { 40 } else { 200 },
            "power": if round == 1 { "≈0.6 for d=0.5 (pilot only)" } else { "≈0.9 for d=0.3" },
            "stopping_rule": "Single analysis at the planned n. No interim looks.",
            "multiple_comparisons": "Not applicable: one pre-registered comparison.",
            "verdict": "approve",
            "required_changes": [],
            "flags": []
        }),
        "analyze" => {
            let r = &ctx["result"];
            let p = r["p_value"].as_f64();
            let d = r["cohens_d"].as_f64().unwrap_or(0.0);
            let n = r["n_per_group"].as_u64().unwrap_or(0);
            let Some(p) = p else {
                return json!({"say": "The run produced no usable RESULT_JSON, so I can't grade anything.",
                    "grade": "inconclusive", "verdict": "inconclusive",
                    "summary": "No parseable result from the executed experiment.",
                    "caveats": ["Execution failed or printed no RESULT_JSON line."], "flags": []});
            };
            let (grade, verdict) = if n < 100 { if p < 0.15 { ("weak", "inconclusive") } else { ("inconclusive", "inconclusive") } }
                else if p < 0.01 && d > 0.0 { ("strong", "supports") }
                else if p < 0.05 && d > 0.0 { ("moderate", "supports") }
                else if p < 0.15 { ("weak", "inconclusive") }
                else { ("inconclusive", "inconclusive") };
            let summary = format!(
                "Executed result: n={n}/arm, Cohen's d={d}, permutation p={p}, 95% CI {}. {}",
                r["ci95"],
                match grade {
                    "strong" => "Clears the pre-set alpha with adequate n.",
                    "moderate" => "Clears alpha, but the sample is modest.",
                    "weak" => "Pilot-sized sample: suggestive only, not enough to decide. A powered study is needed.",
                    _ => "Cannot distinguish the effect from noise at this n.",
                }
            );
            json!({
                "say": format!("Graded {grade}. {summary}"),
                "grade": grade, "verdict": verdict, "summary": summary,
                "caveats": ["Simulated data: the effect is a property of the simulation, not of the real world.", "Single seed; a replication across seeds would tighten this."],
                "flags": []
            })
        }
        "finalpass" => {
            let weak = matches!(ctx["grade"].as_str(), Some("weak") | Some("inconclusive"));
            json!({
                "say": if weak { "I can't sign off on this. The evidence is too thin to move past the pilot." } else { "I have no standing objection to the analysis as run. My remaining concern is the simulated setting." },
                "concede": !weak,
                "remaining_objections": if weak { json!([{"text": "Underpowered: re-run with the sample size the power analysis calls for.", "severity": "major"}]) } else { json!([{"text": "Results come from a simulation; do not generalise to real systems without real data.", "severity": "minor"}]) },
                "flags": []
            })
        }
        "promote" => {
            let status = match ctx["grade"].as_str() {
                Some("strong") | Some("moderate") if ctx["verdict"] == "supports" => "tentative",
                Some("strong") | Some("moderate") => "refuted",
                _ => "tentative",
            };
            json!({
                "say": "Drafting the entry. I'm leaving it tentative: it's one simulated experiment.",
                "title": "Finding",
                "finding": ctx["summary"].as_str().unwrap_or("See experiment result."),
                "status": status,
                "caveats": ["Single simulated experiment.", "Evidence grade shown beside this finding is the statistician's, not the scribe's."],
                "flags": []
            })
        }
        _ => json!({"say": "…"}),
    }
}
