//! Roles, labs and the default team. A role is: brief + model + tool
//! allowlist + memory scope + disposition. Adversarial separation is enforced
//! by the orchestrator, not by the prompts: the critic's output can never edit
//! a hypothesis, and the experimentalist's output is never read as a grade.

use crate::runtime::ModelRef;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Agent {
    pub id: String,
    pub name: String,
    /// generator | critic | experimentalist | statistician | manager | scribe | librarian | custom
    pub kind: String,
    pub brief: String,
    pub model: ModelRef,
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default)]
    pub memory_scope: String,
    #[serde(default = "half")]
    pub disposition: f32,
    #[serde(default)]
    pub disagree: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub x: f32,
    #[serde(default)]
    pub y: f32,
}
fn half() -> f32 {
    0.5
}
fn yes() -> bool {
    true
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Link {
    pub from: String,
    pub to: String,
    /// "challenges" | "informs"
    pub kind: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Gates {
    /// manual | auto
    pub framing: String,
    /// manual | auto_low_risk
    pub experiment: String,
    /// always manual (kept for symmetry in the UI)
    pub resource: String,
    /// manual | auto_tentative  (never auto-establishes)
    pub promotion: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Lab {
    pub id: String,
    pub name: String,
    pub agents: Vec<Agent>,
    pub links: Vec<Link>,
    pub gates: Gates,
}

impl Lab {
    pub fn agent_of(&self, kind: &str) -> Option<&Agent> {
        self.agents.iter().find(|a| a.kind == kind && a.enabled)
    }
}

/// Rules appended to every agent's system prompt. Labs cannot configure these away.
pub const PROTOCOL: &str = "\
LAB PROTOCOL (fixed; you cannot change these rules):
- Reply with ONE JSON object and nothing else. No markdown fences, no prose outside the JSON.
- The first key must be \"say\": one or two plain sentences, written as if speaking to a colleague.
- Never state a number as a result unless it appears in an EXECUTED RESULT block you were shown. Reasoned estimates must be labelled as such.
- Every claim must cite a source, an assumption id or an experiment id. Unsourced claims cannot be promoted.
- If you see a human-safety, privacy, dual-use or bias concern, add it to \"flags\" (array of {\"category\",\"text\"}). Otherwise use an empty array. Only the human can clear a flag.
- Do not help with weapons, targeted harm, or re-identification of people. If the question requires it, raise a flag instead of answering.";

pub fn disposition_text(d: f32) -> &'static str {
    if d < 0.34 {
        "Disposition: conservative. Concede when an argument is sound; raise only objections that matter."
    } else if d > 0.66 {
        "Disposition: aggressive. Assume the claim is wrong until it survives. Press on weak points."
    } else {
        "Disposition: balanced. Challenge firmly but fairly; concede what is earned."
    }
}

fn agent(
    id: &str,
    name: &str,
    kind: &str,
    brief: &str,
    tools: &[&str],
    disp: f32,
    disagree: &str,
    temp: f32,
    x: f32,
    y: f32,
) -> Agent {
    Agent {
        id: id.into(),
        name: name.into(),
        kind: kind.into(),
        brief: brief.into(),
        model: ModelRef { runtime: "demo".into(), model: "scripted-lab".into(), temperature: temp, max_tokens: 1800 },
        tools: tools.iter().map(|s| s.to_string()).collect(),
        memory_scope: "run".into(),
        disposition: disp,
        disagree: disagree.into(),
        enabled: true,
        x,
        y,
    }
}

pub fn default_lab() -> Lab {
    let agents = vec![
        agent(
            "manager",
            "Lab manager",
            "manager",
            "You run the lab. Restate the research question precisely, list scope and assumptions, and keep the team inside the protocol and budget. You do not do the science.",
            &["orchestrator"],
            0.4,
            "Push back on vague scope; ask for a measurable question.",
            0.2,
            0.5,
            0.06,
        ),
        agent(
            "generator",
            "Hypothesis generator",
            "generator",
            "You propose rival, testable explanations for the research question, ranked, each with explicit assumptions and a concrete prediction that an experiment could falsify. Answer every objection or withdraw the hypothesis. You may not edit or grade experiments.",
            &["notes"],
            0.5,
            "Defend ideas with evidence, withdraw them honestly when beaten.",
            0.7,
            0.12,
            0.45,
        ),
        agent(
            "critic",
            "Critic",
            "critic",
            "You attack hypotheses and experimental designs: confounds, alternative explanations, leakage, weak logic, unfalsifiable claims. You cannot edit hypotheses, only object to them. Objections must be specific enough to answer.",
            &["read-only"],
            0.8,
            "Assume the claim is wrong; make the team prove otherwise.",
            0.5,
            0.5,
            0.45,
        ),
        agent(
            "experimentalist",
            "Experimentalist",
            "experimentalist",
            "You turn a hypothesis into a runnable protocol: a short Python 3 program (standard library, plus numpy/scipy only if clearly needed) that simulates or analyses data and prints a final line `RESULT_JSON {...}` with the metrics. Seed all randomness from the ELENCHIA_SEED environment variable. You never grade your own results.",
            &["sandbox", "data-loaders"],
            0.5,
            "Insist the design actually tests the prediction, not a proxy for it.",
            0.3,
            0.88,
            0.45,
        ),
        agent(
            "statistician",
            "Statistician",
            "statistician",
            "You set sample size, power, tests and stopping rules before a run, and grade evidence after it. You check assumptions, flag p-hacking and multiple comparisons, and refuse to call weak evidence strong. You only quote numbers from executed results.",
            &["stats", "sandbox"],
            0.7,
            "Refuse to bless underpowered or post-hoc analyses.",
            0.2,
            0.7,
            0.8,
        ),
        agent(
            "scribe",
            "Scribe",
            "scribe",
            "You write the lab notebook entry: the finding, its status, evidence grade and caveats, in plain language. Default to 'tentative'. Never write a claim that the evidence blocks do not support.",
            &["notebook"],
            0.3,
            "Keep the wording as strong as the evidence and no stronger.",
            0.3,
            0.3,
            0.8,
        ),
    ];
    let link = |f: &str, t: &str, k: &str| Link { from: f.into(), to: t.into(), kind: k.into() };
    Lab {
        id: "default".into(),
        name: "Default lab".into(),
        agents,
        links: vec![
            link("manager", "generator", "informs"),
            link("generator", "critic", "informs"),
            link("critic", "generator", "challenges"),
            link("generator", "experimentalist", "informs"),
            link("statistician", "experimentalist", "challenges"),
            link("experimentalist", "statistician", "informs"),
            link("critic", "experimentalist", "challenges"),
            link("statistician", "scribe", "informs"),
        ],
        gates: Gates {
            framing: "manual".into(),
            experiment: "manual".into(),
            resource: "manual".into(),
            promotion: "manual".into(),
        },
    }
}

/// Offline refusal rules agents cannot be configured away from. Intentionally
/// narrow: it halts obviously harmful framings before any model is called;
/// subtler cases are handled by agent flags and the ethics gate.
pub fn hard_refusal(question: &str) -> Option<&'static str> {
    let q = question.to_lowercase();
    const BLOCKED: &[(&str, &str)] = &[
        ("nerve agent", "chemical weapons"),
        ("bioweapon", "biological weapons"),
        ("biological weapon", "biological weapons"),
        ("synthesize sarin", "chemical weapons"),
        ("enhance pathogen transmissib", "enhancing pathogens"),
        ("build a bomb", "explosives"),
        ("deanonymi", "re-identifying people"),
        ("de-anonymi", "re-identifying people"),
    ];
    BLOCKED.iter().find(|(p, _)| q.contains(p)).map(|(_, why)| *why)
}

pub fn lab_to_value(l: &Lab) -> Value {
    json!(l)
}
