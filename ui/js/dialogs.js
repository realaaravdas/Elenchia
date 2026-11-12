// Drawers and dialogs: agent / hypothesis / experiment details, message and
// exchange viewers, new run, run history, runtimes & settings.

import { h, put, $, clear, pill, statusPill, gradeMeter, diffView, ago, clock, toast, trunc, STAGE_LABEL, GATE_LABEL } from './util.js';
import { A, S, modelsAvailable } from './state.js';
import { call } from './api.js';
import { agentName } from './model.js';
import { gateControls } from './gates.js';

export function openDrawer(title, body, sub) {
  const d = $('#drawer'); clear(d); d.hidden = false;
  d.append(
    h('header', {}, h('div', {}, h('h2', {}, title), sub ? h('div', { class: 'mute' }, sub) : null), h('button', { class: 'btn ghost sm', onclick: closeDrawer }, 'Close ', h('kbd', {}, 'Esc'))),
    h('div', { class: 'dbody' }, body));
}
export function closeDrawer() { $('#drawer').hidden = true; S.drawer = null; }
export function openModal(content, wide = false) {
  const m = $('#modal'); clear(m); m.hidden = false;
  m.append(h('div', { class: 'dialog' + (wide ? ' wide' : '') }, content));
  m.onmousedown = (e) => { if (e.target === m) closeModal(); };
}
export function closeModal() { $('#modal').hidden = true; }

const kvs = (pairs) => h('dl', { class: 'kv' }, pairs.filter(Boolean).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
const section = (t, ...kids) => h('div', { style: { marginBottom: '20px' } }, h('div', { class: 'cap', style: { marginBottom: '8px' } }, t), ...kids);

export function agentDrawer(id) {
  const M = S.M, a = M.lab.agents.find((x) => x.id === id); if (!a) return;
  const st = M.agents[id] ?? { status: 'idle' };
  const recent = M.msgs.filter((m) => m.from === id).slice(-6).reverse();
  S.drawer = { type: 'agent', id };
  openDrawer(a.name, h('div', {},
    h('div', { class: 'row', style: { marginBottom: '16px' } }, pill(st.status, st.status === 'idle' ? '' : 'solid dot' + (st.status === 'blocked' ? ' pulse' : '')), pill(a.kind, 'dashed'), a.model.runtime === 'demo' ? pill('scripted demo', 'dashed') : null),
    st.activity && st.status !== 'idle' ? section('Current thought', h('div', {}, st.activity + (st.to && st.to !== 'human' ? ' → ' + agentName(M, st.to) : ''))) : null,
    section('Configuration', kvs([['Model', `${a.model.runtime}:${a.model.model}`], ['Temperature', a.model.temperature], ['Disposition', (a.disposition < 0.34 ? 'conservative' : a.disposition > 0.66 ? 'aggressive' : 'balanced') + ` (${a.disposition.toFixed(2)})`], ['Tools', (a.tools || []).join(', ') || '—'], ['Memory scope', a.memory_scope || 'run'], ['How it disagrees', a.disagree || '—']])),
    section('Brief', h('div', { class: 'dim' }, a.brief)),
    section('Recent messages', recent.length ? h('div', { class: 'stack' }, recent.map(msgCard)) : h('div', { class: 'mute' }, 'Nothing said yet.')),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: () => { closeDrawer(); A.go('designer', { select: id }); } }, 'Edit in Lab designer'))), a.kind);
}

export function msgCard(m) {
  const M = S.M;
  return h('div', { class: 'msg', onclick: () => messageDialog(m.id) },
    h('div', { class: 'hd' }, h('b', {}, agentName(M, m.from)), '→', agentName(M, m.to), '·', m.stage, m.scripted ? '· scripted' : ''),
    h('div', {}, m.say));
}

export function messageDialog(id) {
  const M = S.M, m = M.msgs.find((x) => x.id === id);
  if (!m) { toast('That message is still being written.'); return; }
  const data = { ...m.data }; delete data.say;
  openModal(h('div', {},
    h('div', { class: 'row' }, h('h2', { style: { flex: 1 } }, `${agentName(M, m.from)} → ${agentName(M, m.to)}`), pill(m.stage), pill('round ' + m.round)),
    h('div', { class: 'mute', style: { marginBottom: '14px' } }, `${clock(m.ts)} · ${m.model}${m.scripted ? ' · scripted demo, not a language model' : ''} · temperature ${m.temperature} · ${m.attempts} attempt${m.attempts > 1 ? 's' : ''}`),
    h('p', { style: { fontSize: '15px', margin: '0 0 14px' } }, m.say),
    h('div', { class: 'cap', style: { margin: '14px 0 6px' } }, 'Structured message'),
    h('pre', { class: 'code' }, JSON.stringify(data, null, 2)),
    h('details', { style: { marginTop: '14px' } }, h('summary', { class: 'mute', style: { cursor: 'pointer' } }, 'Exact prompt sent (stored for replay)'),
      h('pre', { class: 'code', style: { marginTop: '8px' } }, `# system\n${m.prompt.system}\n\n# user\n${m.prompt.user}`)),
    h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: closeModal }, 'Close'))), true);
}

export function exchangeDialog(a, b) {
  const M = S.M;
  const ms = M.msgs.filter((m) => (m.from === a && m.to === b) || (m.from === b && m.to === a));
  openModal(h('div', {}, h('h2', {}, `${agentName(M, a)} ⇄ ${agentName(M, b)}`), h('div', { class: 'sub' }, 'Every exchange carried by this link.'),
    ms.length ? h('div', { class: 'stack' }, ms.map(msgCard)) : h('div', { class: 'empty' }, 'They haven’t spoken yet.'),
    h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: closeModal }, 'Close'))));
}

export function hypDrawer(id) {
  const M = S.M, hy = M.hyps.get(id); if (!hy) return;
  S.drawer = { type: 'hyp', id };
  openDrawer(`${hy.id}`, h('div', {},
    h('div', { class: 'row', style: { marginBottom: '14px' } }, statusPill(hy.status), pill('round ' + hy.round, 'dashed'), hy.evidence ? gradeMeter(hy.evidence.grade) : null),
    h('p', { style: { fontSize: '15px', margin: '0 0 14px', fontWeight: 600 } }, hy.claim),
    kvs([['Prediction', hy.prediction], ['Assumptions', (hy.assumptions || []).join(' · ')]]),
    section('Objections', hy.objs.length ? h('div', { class: 'stack' }, hy.objs.map((oid) => objThread(M.objs.get(oid)))) : h('div', { class: 'mute' }, 'None raised.')),
    section('Experiments', hy.exps.length ? h('div', { class: 'stack' }, hy.exps.map((e) => h('div', { class: 'msg', onclick: () => expDrawer(e) }, h('div', { class: 'hd' }, h('b', {}, e), M.exps.get(e).state), M.exps.get(e).title))) : h('div', { class: 'mute' }, 'None yet.')),
    hy.evidence ? section('Evidence', h('div', {}, hy.evidence.summary)) : null,
    h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: () => { closeDrawer(); A.go('notebook', { anchor: 'hyp-' + id }); } }, 'Open in notebook'))));
}

export function objThread(o) {
  return h('div', { class: `obj ${o.severity} ${o.resolved === true ? 'resolved' : 'open'}` },
    h('div', { class: 'who', 'data-sev': o.severity }, `${o.id} · critic`),
    h('div', { class: 'txt' }, o.text),
    o.answer ? h('div', { class: 'reply' }, h('div', { class: 'who' }, o.answer.withdraw ? 'generator withdrew' : 'generator'), o.answer.response) : null,
    o.resolved != null ? h('div', { class: 'reply' }, h('div', { class: 'who' }, 'critic'), o.resolved ? 'Resolved. ' : 'Not resolved. ', o.reason || '') : null);
}

export function expDrawer(id) {
  const M = S.M, e = M.exps.get(id); if (!e) return;
  S.drawer = { type: 'exp', id };
  const gates = M.openGates.filter((g) => (g.kind === 'experiment' || g.kind === 'resource') && g.detail?.experiment === id);
  const r = e.result;
  openDrawer(`${e.id} · ${e.title}`, h('div', {},
    h('div', { class: 'row', style: { marginBottom: '14px' } }, pill(e.state, e.state === 'running' ? 'solid dot pulse' : e.state === 'finished' ? 'solid' : ''), pill(e.hypothesis, 'dashed'), pill('round ' + e.round, 'dashed'), e.evidence ? gradeMeter(e.evidence.grade) : null),
    gates.map((g) => h('div', { class: 'card pad blocked', style: { marginBottom: '18px' } }, h('h3', { style: { marginBottom: '10px' } }, g.title), gateControls(g))),
    gates.length ? null : section('Protocol', h('div', {}, e.protocol)),
    gates.length ? null : section('Code', diffView(e.prev_code, e.code)),
    e.plan?.test ? section('Analysis plan', kvs([['Test', e.plan.test], ['n / power', [e.plan.n_per_group && `n=${e.plan.n_per_group}/arm`, e.plan.power].filter(Boolean).join(' · ')], ['Stopping rule', e.plan.stopping_rule]])) : null,
    r ? section('Result', kvs([['Executed by', r.executor], ['Seed', String(r.seed)], ['Runtime', r.duration_ms + ' ms'], ['Exit', r.timed_out ? 'timed out' : r.exit]]),
      r.result ? h('pre', { class: 'code', style: { marginTop: '10px' } }, JSON.stringify(r.result, null, 2)) : null,
      r.stderr ? h('details', { style: { marginTop: '10px' } }, h('summary', { class: 'mute', style: { cursor: 'pointer' } }, 'stderr'), h('pre', { class: 'code' }, r.stderr)) : null,
      h('details', { style: { marginTop: '10px' } }, h('summary', { class: 'mute', style: { cursor: 'pointer' } }, 'raw stdout'), h('pre', { class: 'code' }, r.stdout))) : null,
    e.evidence ? section('Evidence', h('div', { class: 'row', style: { marginBottom: '8px' } }, gradeMeter(e.evidence.grade), pill(e.evidence.grade), pill('verdict: ' + e.evidence.verdict)), h('div', {}, e.evidence.summary), (e.evidence.caveats || []).map((c) => h('div', { class: 'dim' }, '· ' + c))) : null), e.hypothesis);
}

// ---------- New run ----------
export function newRunDialog() {
  const q = h('textarea', { rows: 4, placeholder: 'e.g. Does this regularizer actually help, or is it tuning noise?' });
  const cons = h('textarea', { rows: 2, placeholder: 'One per line. e.g. Use only simulated data.' });
  const turns = h('input', { type: 'number', value: 60, min: 4, max: 500 });
  const mins = h('input', { type: 'number', value: 45, min: 1, max: 720 });
  const off = h('input', { type: 'text', placeholder: 'Comma-separated topics the lab must not touch' });
  const ds = h('input', { type: 'text', placeholder: 'Optional path to a dataset (granted read-only, only if an experiment asks and you approve)' });
  // Attached reference material (experimental): PDFs/text from disk, or a link.
  const attached = [];
  const list = h('div', { class: 'stack' });
  const url = h('input', { type: 'text', placeholder: 'Paste a link to a paper, PDF or web page…' });
  const msg = h('div', { class: 'mute' });
  const drawList = () => put(clear(list), attached.map((s) => h('div', { class: 'card pad row', title: s.preview },
    pill(s.kind), h('span', { style: { flex: 1, minWidth: 0 } }, trunc(s.name, 60), h('span', { class: 'mute' }, ` · ${Math.round(s.chars / 1000)}k chars`)),
    h('button', { class: 'btn sm ghost', onclick: async () => { attached.splice(attached.indexOf(s), 1); try { await call('remove_source', { id: s.id }); } catch { /* ignore */ } drawList(); } }, 'Remove'))));
  const browse = async () => {
    msg.textContent = 'Reading…';
    try {
      const r = await call('pick_sources');
      attached.push(...r.added); drawList();
      msg.textContent = r.errors.length ? r.errors.join(' · ') : '';
    } catch (e) { msg.textContent = String(e); }
  };
  const addUrl = async () => {
    if (!url.value.trim()) return;
    msg.textContent = 'Fetching…';
    try { attached.push(await call('add_source_url', { url: url.value.trim() })); url.value = ''; msg.textContent = ''; drawList(); }
    catch (e) { msg.textContent = String(e); }
  };
  const demo = S.lab.agents.every((a) => !a.enabled || a.model.runtime === 'demo');
  const haveModels = modelsAvailable().length > 0;
  const cloud = S.lab.agents.some((a) => a.enabled && a.model.runtime === 'openai');
  const examples = ['Does this regularizer actually help, or is it tuning noise?', 'Which of these three mechanisms best explains the pattern in my dataset?', 'Is this pricing experiment powered well enough to run?'];
  openModal(h('div', {},
    h('h2', {}, 'Start a research run'), h('div', { class: 'sub' }, 'You hold the gates: nothing consequential happens without your decision.'),
    cloud ? h('div', { class: 'card pad blocked', style: { marginBottom: '16px' } }, h('b', {}, 'Cloud model in use.'), h('div', { class: 'dim' }, 'Agents set to the OpenAI-compatible API send their prompts to that provider, including your question, attached material and experiment results. Use LM Studio for everything to keep it on this machine.')) : null,
    demo ? h('div', { class: 'card pad', style: { marginBottom: '16px' } }, h('b', {}, 'This lab is using the scripted demo.'), h('div', { class: 'dim' }, haveModels ? 'Local models are available. Assign them in the Lab designer to run on real models.' : 'No Ollama or LM Studio server was detected, so agents follow a script. The experiment itself is still really executed.'), haveModels ? h('div', { style: { marginTop: '8px' } }, h('button', { class: 'btn sm', onclick: () => { closeModal(); A.go('designer'); } }, 'Open Lab designer')) : null) : null,
    h('div', { class: 'field' }, h('label', {}, 'Research question'), q, h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '6px' } }, examples.map((x) => h('button', { class: 'btn sm ghost', onclick: () => { q.value = x; q.focus(); } }, trunc(x, 46))))),
    h('div', { class: 'field' }, h('label', {}, 'Constraints'), cons),
    h('div', { class: 'field' }, h('label', {}, 'Off-limits topics'), off),
    h('div', { class: 'cols2' }, h('div', { class: 'field' }, h('label', {}, 'Turn budget'), turns), h('div', { class: 'field' }, h('label', {}, 'Time budget (minutes)'), mins)),
    h('div', { class: 'field' }, h('label', {}, 'Dataset (optional)'), ds),
    h('div', { class: 'field' }, h('label', {}, 'Reference material ', pill('experimental', 'dashed')),
      h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: browse }, 'Choose files…'), url, h('button', { class: 'btn sm', onclick: addUrl }, 'Add link')),
      h('div', { class: 'hint' }, 'PDF, text, Markdown, CSV, LaTeX or HTML. The lab reads the passages most relevant to your question. Links are fetched only because you add them.'), msg, list),
    h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: async () => {
        if (!q.value.trim()) { q.focus(); return; }
        closeModal();
        await A.startRun({ question: q.value.trim(), constraints: cons.value.split('\n').map((s) => s.trim()).filter(Boolean), offlimits: off.value.split(',').map((s) => s.trim()).filter(Boolean), max_turns: +turns.value, max_minutes: +mins.value, dataset: ds.value.trim() || null, source_ids: attached.map((s) => s.id) });
      } }, 'Start run'))));
  setTimeout(() => q.focus(), 30);
}

// ---------- Run history ----------
export function runsDialog() {
  const rows = S.runs.map((r) => h('div', { class: 'card pad hover', onclick: () => { closeModal(); A.loadRun(r.id); } },
    h('div', { class: 'row' }, h('div', { style: { flex: 1, minWidth: 0 } }, h('div', { style: { fontWeight: 600 } }, trunc(r.question, 90)), h('div', { class: 'mute' }, `${r.lab} · ${ago(r.created)}`)), pill(r.status, r.status === 'running' ? 'solid dot pulse' : r.status === 'completed' ? 'solid' : 'dashed'))));
  openModal(h('div', {}, h('h2', {}, 'Runs'), h('div', { class: 'sub' }, 'Every run is stored locally and can be replayed from its event log.'),
    rows.length ? h('div', { class: 'stack' }, rows) : h('div', { class: 'empty' }, 'No runs yet.'),
    h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: closeModal }, 'Close'))));
}

// ---------- Runtimes & settings ----------
export function settingsDialog() {
  const d = S.detection, st = S.settings;
  const ou = h('input', { type: 'text', value: st.ollama_url }), lu = h('input', { type: 'text', value: st.lmstudio_url });
const cu = h('input', { type: 'text', value: st.openai_url, placeholder: 'https://api.openai.com/v1' });  const ck = h('input', { type: 'password', placeholder: st.openai_key_set ? 'A key is saved. Type to replace.' : 'sk-…', autocomplete: 'off' });
  const rt = (name, key) => {
    const x = d?.[key];
    return h('div', { class: 'card pad' }, h('div', { class: 'row' }, h('h3', { style: { flex: 1 } }, name), pill(x?.up ? (key === 'openai' ? 'connected' : 'running') : (key === 'openai' && !x?.configured ? 'not configured' : 'not detected'), x?.up ? 'solid' : 'dashed')),
      x?.up ? h('div', { class: 'mute', style: { marginTop: '6px' } }, x.models.length ? x.models.map((m) => m.id).join(' · ') : 'Server is up but no models are installed.') : h('div', { class: 'mute', style: { marginTop: '6px' } }, key === 'ollama' ? 'Install from ollama.com, then `ollama pull <model>`.' : key === 'openai' ? (x?.configured ? 'Could not list models. Check the key and base URL.' : 'Not configured. Add an API key below to use a cloud model.') : 'Start the local server from the Developer tab in LM Studio.'));
  };
  const hw = d?.hardware;
  openModal(h('div', {},
    h('h2', {}, 'Runtimes & hardware'), h('div', { class: 'sub' }, 'Agents run on local models by default (LM Studio first). Nothing leaves this machine unless you add a cloud API below or turn on online search in Settings.'),
    h('div', { class: 'stack' }, rt('LM Studio (default)', 'lmstudio'), rt('Ollama', 'ollama'), rt('OpenAI-compatible API (cloud)', 'openai'),
      h('div', { class: 'card pad' }, h('div', { class: 'row' }, h('h3', { style: { flex: 1 } }, 'Python (experiment sandbox)'), pill(d?.python?.found ? d.python.version : 'not found', d?.python?.found ? 'solid' : 'dashed')), d?.python?.found ? null : h('div', { class: 'mute', style: { marginTop: '6px' } }, 'Install Python 3.9+ to run experiments. The scripted demo falls back to a built-in kernel, clearly labelled.')),
      h('div', { class: 'card pad' }, h('h3', {}, 'Hardware'), kvs([['RAM', hw ? `${hw.ram_free_gb} GB free of ${hw.ram_total_gb} GB` : '—'], ['GPU', hw?.vram ? `${hw.vram.gpu} · ${hw.vram.free_gb.toFixed(1)} GB free of ${hw.vram.total_gb.toFixed(1)} GB` : 'no NVIDIA GPU reported'], ['Scheduling', 'One large model loaded at a time by default']]))),
    h('hr', { class: 'hr' }),
    h('div', { class: 'cols2' }, h('div', { class: 'field' }, h('label', {}, 'LM Studio URL'), lu), h('div', { class: 'field' }, h('label', {}, 'Ollama URL'), ou)),
    h('div', { class: 'card pad' }, h('div', { class: 'row' }, h('h3', { style: { flex: 1 } }, 'OpenAI-compatible API'), pill('cloud', 'solid')),
      h('div', { class: 'dim', style: { margin: '6px 0 8px' } }, 'Works with OpenAI, OpenRouter, Groq, Together, Azure-style gateways or any server that speaks the OpenAI chat API. Agents you assign to it send their prompts (your question, attached material, experiment results) to that provider. The key is stored unencrypted in this app’s local database.'),
      h('div', { class: 'cols2' }, h('div', { class: 'field' }, h('label', {}, 'Base URL'), cu), h('div', { class: 'field' }, h('label', {}, 'API key'), ck))),
    h('div', { class: 'mute' }, `Data folder: ${st.data_dir}`),
    S.preview ? h('div', { class: 'card pad', style: { marginTop: '12px' } }, 'Browser preview: replaying a run recorded from the desktop backend. Install the desktop app for local models, the real sandbox and persistent storage.') : null,
    h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: closeModal }, 'Close'), h('button', { class: 'btn primary', onclick: async () => { await A.saveSettings(ou.value, lu.value, { openaiUrl: cu.value, openaiKey: ck.value }); closeModal(); toast('Rescanned runtimes.'); } }, 'Save & rescan'))));
}

// ---------- App settings ----------
export function appSettingsDialog({ replayTour }) {
  const st = S.settings;
  const lit = h('input', { type: 'checkbox', checked: !!st.literature_enabled });
  const key = h('input', { type: 'password', placeholder: st.openalex_key_set ? 'A key is saved. Type to replace.' : 'Leave empty to use the shared limit' });
const brave = h('input', { type: 'password', placeholder: st.brave_key_set ? 'A key is saved. Type to replace.' : 'Brave Search API key (free tier available)', autocomplete: 'off' });  const searx = h('input', { type: 'text', value: st.searxng_url || '', placeholder: 'or your own SearXNG, e.g. http://localhost:8080' });
  const calm = h('input', { type: 'checkbox', checked: !!S.calm, onchange: () => A.toggleCalm() });
  const keys = [['1 – 5', 'Switch between the five views'], ['N', 'Start a new run'], ['Esc', 'Close panels'], ['A / R / C / K', 'On a gate: approve, reject, approve with condition, ask the critic again']];
  openModal(h('div', {},
    h('h2', {}, 'Settings'), h('div', { class: 'sub' }, `Elenchia ${st.version || ''}`),
    h('div', { class: 'stack' },
      h('div', { class: 'card pad' }, h('h3', {}, 'Help'),
        h('div', { class: 'dim', style: { margin: '4px 0 8px' } }, 'A guided walk through the five views, the gates and the controls.'),
        h('button', { class: 'btn', onclick: () => { closeModal(); replayTour(); } }, 'Replay the quick-start tour')),
      h('div', { class: 'card pad' }, h('h3', {}, 'Appearance'),
        h('div', { class: 'row', style: { marginTop: '8px' } }, h('span', { style: { flex: 1 } }, 'Theme'), h('button', { class: 'btn sm', onclick: () => A.toggleTheme() }, 'Switch light / dark')),
        h('label', { class: 'row', style: { gap: '8px', marginTop: '8px' } }, calm, h('span', {}, 'Calm mode: freeze the living diagram’s motion'))),
      h('div', { class: 'card pad' }, h('div', { class: 'row' }, h('h3', { style: { flex: 1 } }, 'Online research tools'), pill('experimental', 'dashed')),
        h('label', { class: 'row', style: { gap: '8px', marginTop: '8px' } }, lit, h('span', {}, 'Let the lab search papers (OpenAlex / Semantic Scholar) and, if configured below, the web. Agents can ask to search during a run; you approve each request and only the query text is sent.')),
        h('div', { class: 'field', style: { marginTop: '8px' } }, h('label', {}, 'OpenAlex API key (optional, free; raises the daily limit)'), key),
        h('div', { class: 'cols2', style: { marginTop: '8px' } }, h('div', { class: 'field' }, h('label', {}, 'Web search: Brave Search key'), brave), h('div', { class: 'field' }, h('label', {}, 'or SearXNG URL'), searx)),
        h('div', { class: 'hint' }, 'General web search needs one of these; without either, agents can only search papers. Keys are stored unencrypted in the local database.')),
      h('div', { class: 'card pad' }, h('h3', {}, 'Keyboard shortcuts'), kvs(keys))),
    h('div', { class: 'mute', style: { marginTop: '12px' } }, `Data folder: ${st.data_dir}`),
    h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: closeModal }, 'Close'),
      h('button', { class: 'btn primary', onclick: async () => { await A.saveSettings(st.ollama_url, st.lmstudio_url, { literatureEnabled: lit.checked, openalexKey: key.value, braveKey: brave.value, searxngUrl: searx.value }); closeModal(); toast('Settings saved.'); } }, 'Save'))));
}
