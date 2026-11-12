<img src="assets/elenchia-logo.svg" width="72" align="right" alt="Elenchia">

# Elenchia

**Direct an AI lab, don't chat with an assistant.**

Elenchia is a local-first desktop app. You staff a lab with specialised agents (hypothesis generator, critic, experimentalist, statistician, plus a lab manager and scribe), point them at a research question, and watch them argue, design experiments, run them, and grade the evidence. You are the ethics and approval layer: nothing consequential happens without your decision, and every decision is logged.

Every agent runs on a **local model** served by Ollama and/or LM Studio. Questions, data and intermediate reasoning never leave your machine.

This is **v0.1**, the MVP from the product concept: four core agents with editable briefs, statistical/ML experiments run as Python in a local sandbox, the five surfaces (floor, designer, experiment board, approval inbox, notebook), approval and promotion gates, and an append-only audit log.

## Download

Installers for Windows, macOS (Apple Silicon and Intel) and Linux are attached to each [release](https://github.com/realaaravdas/Elenchia/releases). They are built by GitHub Actions when a `v*` tag is pushed, and are **unsigned**, so the OS warns on first launch:

| Platform | File | First launch |
|---|---|---|
| Windows | `Elenchia_<version>_x64-setup.exe` | SmartScreen: *More info* → *Run anyway* |
| macOS | `Elenchia_<version>_aarch64.dmg` (Apple Silicon) or `_x64.dmg` (Intel) | Right-click the app → *Open*, or `xattr -dr com.apple.quarantine /Applications/Elenchia.app` |
| Linux | `.AppImage` or `.deb` | `chmod +x` the AppImage and run it, or `sudo dpkg -i` the `.deb` |

On Linux the app needs WebKitGTK 4.1 (`libwebkit2gtk-4.1`), which most current distributions ship.

## Run it

Prerequisites: Rust (stable, MSVC on Windows) and the WebView2 runtime (ships with Windows 11). No Node toolchain: the UI is plain HTML/CSS/JS.

```bash
cargo run --manifest-path src-tauri/Cargo.toml          # dev
cargo build --release --manifest-path src-tauri/Cargo.toml   # single binary in target/release
```

Optional, for experiments on real code: install **Python 3.9+** (and numpy/scipy if your experiments use them). Optional, for real agents: install [Ollama](https://ollama.com) (`ollama pull <model>`) or [LM Studio](https://lmstudio.ai) and start its local server. Elenchia auto-detects both at launch (ports 11434 and 1234; override in *Runtimes*), lists installed models in a per-agent picker, and warns when the largest model will not fit your VRAM/RAM.

With no runtime installed, the app uses a clearly labelled **scripted demo lab** so you can see the whole product. The demo agents are a script, not models; the experiment they propose is still genuinely executed (Python if present, otherwise a built-in kernel, labelled as such).

### Using LM Studio

1. In LM Studio, download an instruction-tuned model (7B+ works best; the agents must emit JSON).
2. Open the **Developer** tab, load the model, and switch **Start Server** on (default `http://127.0.0.1:1234`). Enabling *Just-In-Time model loading* lets Elenchia use any downloaded model without loading it by hand.
3. Launch Elenchia. The top bar shows LM Studio as up and every agent's model picker lists its models. Pick one per agent (or the same one for all; turns run one at a time anyway).

Compatibility notes: Elenchia talks to the OpenAI-compatible `/v1/chat/completions` stream and lists models via `/api/v0/models` (falling back to `/v1/models`). `<think>` blocks and `reasoning_content` from thinking models are ignored, and if a model's chat template rejects the system role the request is retried with the system text folded into the first user message. If your server runs on another port, change it under *Runtimes*.

Installers: `cargo install tauri-cli --version "^2"` then `cargo tauri build` (run from `src-tauri/`).

Browser preview (no desktop shell): `powershell -ExecutionPolicy Bypass -File tools/serve.ps1`, then open http://127.0.0.1:8123. It replays a run recorded from the real Rust orchestrator and says so on screen.

## How a run works

`Frame ● → Hypothesize → Challenge → Design → Approve ● and run → Analyze → Promote ●` (● = human gate). Steps 2-6 loop (max 3 rounds, plus your turn and time budget) until the critic and statistician have no open objections.

| Gate | Fires when | You can |
|---|---|---|
| Question framing | a run starts | edit scope, set off-limits topics and budget |
| Experiment approval | a spec is ready | approve, edit the code, approve with a condition, reject, ask the critic for another pass |
| Resource and data | an experiment needs files, personal data or heavy compute | grant once, grant for the run, deny |
| Claim promotion | the team wants to record a finding | accept, mark tentative, send back |
| Ethics flag | any agent raises a concern | halt, constrain, or override with a written reason |

Principles the code enforces rather than merely asks for:

- **Approvals are specific.** You approve a concrete spec with a code diff against the previous experiment, a runtime estimate, the statistician's plan and a risk label.
- **Any agent can flag, only you can clear.** A flag stops the run until resolved. Overrides need a written reason.
- **Roles stay adversarial.** The critic can only add objections; the experimentalist's output is never read as a grade; the statistician's grade is clamped to inconclusive if nothing executed.
- **Numbers come from executed code.** Agents exchange schema-checked JSON (validated and retried); results are parsed from the sandbox's `RESULT_JSON` line.
- **Tentative is the default.** A finding can only reach "established" if you accept it, it links to an executed result, the evidence is moderate or strong, and the critic conceded. Autonomy per gate is a dial, but promotion can never auto-establish and resource/ethics gates are never automatic.
- **Everything is replayable.** The event log is hash-chained SQLite with triggers that reject UPDATE/DELETE. Every screen is a reduction over it, so the timeline scrubber replays any moment. Prompts, model names, temperatures and seeds are stored.

## Architecture

```
src-tauri/src/
  orchestrator.rs   the seven-step protocol, gates, budgets, role boundaries
  runtime.rs        Ollama + LM Studio adapters (streaming), hardware detection
  sandbox.rs        isolated Python process, static code scan, output caps
  store.rs          SQLite: labs, runs, settings, append-only hash-chained events
  roles.rs          roles, default lab, fixed protocol rules, built-in refusals
  demo.rs           the scripted demo lab + built-in kernel
ui/                 black-and-white UI (vanilla JS, canvas living diagram)
tools/icongen       renders assets/elenchia-logo.svg into the icon set
```

The orchestrator emits events over Tauri's event bus; the UI derives everything (lanes, diagram, debate feed, board, inbox, notebook) from them.

## Honest limits in v0.1

- **The sandbox is process isolation, not an OS container.** Generated code runs in a separate `python -I` process with a scrubbed environment, a throwaway directory, a read-only dataset copy, in-interpreter network blocking, a wall-clock limit and capped output. A static scan blocks process spawning and deletion and routes file access to the resource gate. A determined program could still get around the in-interpreter network block; an OS-level sandbox (Job Objects / AppContainer) is the next hardening step, and until then you should read the code you approve.
- **Turns run one at a time** (one model loaded at a time, as designed), so the living diagram shows one conversation at a time rather than several in parallel.
- **Custom roles** are stored and drawn but only the six built-in roles are scheduled. The librarian, per-gate replay of alternative branches, mixed-model disagreement metrics and reproducibility reruns are v0.2/v0.3 per the concept.
- **Refusal rules are narrow.** A short built-in list halts clearly harmful framings before any model is called; everything subtler relies on agent flags and your ethics gate.
- Tested against the scripted lab end to end, and against a mock Ollama server for streaming, schema validation, retry and error handling. Not yet tested against a real LM Studio or Ollama server (the LM Studio paths follow its documented API), and not against Python (none was installed on the dev machine; the sandbox code path for Python is untested).

## v1.2 (experimental): research assistance features

These are on the `v1.2-experimental` branch and are being finalised for v2. Behaviour may change.

- **Reference material.** In *New run*, attach PDFs, text, Markdown, CSV, LaTeX or HTML files with the native file picker, or paste a link to a paper or page. Text is extracted locally; the lab reads the passages most relevant to your question (small local models cannot take whole papers) and cites them as `[S1]`, `[S2]`. A link is fetched only because you added it. Scanned PDFs need OCR, which is not supported yet.
- **Online literature search** (off by default; enable under *Runtimes & hardware*). Uses OpenAlex, with Semantic Scholar as fallback, because Google Scholar has no API and blocks automated access. After you confirm the question, a gate shows the exact query text, which you can edit, and sends nothing until you approve. Results appear in the notebook's *Sources* section and agents may cite them as `[n]`. This is the only code that touches the internet.
- **Real debate.** The generator and critic now go back and forth: while the critic is unsatisfied it explains what is missing and the generator must respond, for up to three exchanges, depending on the budget left.
- **Time awareness.** Every agent turn is told the wall-clock time and turns remaining and is asked to be briefer as they run out. The debate depth shrinks automatically so the experiment still gets its time.
- **Thinking-model fix.** Empty replies from reasoning models in LM Studio are retried with a larger token budget, and the error now says how to fix it (turn thinking off or raise max tokens).

Untested against live services: the literature APIs, PDF extraction and the file dialog were compiled but not exercised end to end.

### OpenAI-compatible cloud models (experimental)

LM Studio stays the default and Elenchia assigns local models first. If you want a cloud model for some roles, add an **OpenAI-compatible API** under *Runtimes & hardware* (base URL and API key; works with OpenAI, OpenRouter, Groq, Together or any server that speaks the OpenAI chat API). Its models then appear in each agent's picker, labelled *cloud*. Agents on it send their prompts (your question, attached material, experiment results) to that provider, and a warning is shown when you start a run with one. The key is stored unencrypted in the local database.

### v1.2 (experimental): research tools and self-healing

- **Open-access full text.** After a paper search, the free PDFs of the top results are fetched and the passages relevant to your question are read (not just abstracts). A checkbox on the search gate turns this off.
- **Search as an agent tool.** With *Online research tools* enabled, an agent can reply with a search request (`papers`, `web` or `open` for one page) instead of answering. You approve each one at a gate that shows the exact query (editable), or allow searches for the rest of the run. At most 4 per run. Results are numbered `[n]` / `[Wn]`, passed to every later prompt and shown in the notebook.
- **Built-in browser.** Agents can ask to open a specific public page (or search Wikipedia) in a real Chromium (the Edge or Chrome already installed) running with a throwaway profile: no cookies or logins, no extensions, downloads denied, and local/LAN addresses refused. It is driven over the Chrome DevTools Protocol. You approve each request, see the page live in the *Browser* tab of the debate panel (or tick *Show the browser window* in Settings), and every page opened is logged. Page text is passed to the agents marked as untrusted data. General search engines (Google, DuckDuckGo) show bot challenges to automated browsers and Elenchia does not try to bypass them, so full web search needs your own SearXNG URL in Settings.
- **Automatic recovery.** Bad model output is diagnosed from the text itself, with no extra AI call. The app first repairs it deterministically (strips fences and `<think>` blocks, removes trailing commas, closes cut-off JSON, fixes key spelling and types, maps synonyms such as `result` to `summary`, and never invents missing content). Every repair is logged on the message. If that fails it retries up to 4 times, adapting each attempt: more tokens when the reply was cut off, lower temperature, and an exact JSON skeleton in the retry prompt. Server hiccups, rate limits and unreachable servers are retried with 2s/6s/15s backoff.
- **Manual retry.** If automatic fixes run out, the run pauses at a *Needs a retry* gate showing the diagnosis, the last output and the error. Retry as-is, or change the model, max tokens or temperature for that role, then continue from the same step. Nothing is rerun from the start.

## v1.3 (experimental)

Everything below, plus the v1.2 features above, lives on the `v1.3-experimental` branch and is being finalised for v2.

- **Parallel work.** While one hypothesis's experiment runs, other hypotheses are designed, reviewed and analysed at the same time (up to 3 pipelines; the best result is promoted and the others are logged). *Auto* (the default) only does this when the machine can take it: with local models it needs a GPU with room for the model(s), and a CPU-only machine or an over-full GPU stays one at a time. The run log says which it chose and why. Settings can force it off or on.
- **Export.** Notebook → *Export…* saves PDF, Word (.docx), Markdown, HTML, plain text, a transcript CSV, the raw event log, or an **Elenchia notebook** (`.elenchia`).
- **Import.** *Open notebook file…* (Notebook or Runs) shows an exported `.elenchia` file in the lab notebook, read-only, with its full replayable history. It is not re-verified against the audit chain on the machine that opens it.
- **Built-in browser, automatic recovery, search fallbacks, status badge and sliding navigation** as described above.
