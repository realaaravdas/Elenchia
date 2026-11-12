// Controller: boots the app, owns the active run, routes events from the Rust
// orchestrator into the derived model, and exposes actions to the views.

import { h, $, clear, pill, toast, icon, trunc } from './util.js';
import { agentName } from './model.js';
import { call, onEvent, isDesktop } from './api.js';
import { S, A, recompute, isLive, running, modelsAvailable } from './state.js';
import { windowControls, installDrag } from './winctl.js';
import { startTour, tourSeen } from './tour.js';
import { createFloor } from './floor.js';
import { createDesigner } from './designer.js';
import { createBoard, createInbox, createNotebook } from './board.js';
import { newRunDialog, runsDialog, settingsDialog, appSettingsDialog, closeDrawer, closeModal } from './dialogs.js';

const VIEWS = {
  floor: createFloor, designer: createDesigner, experiments: createBoard, inbox: createInbox, notebook: createNotebook,
};
const NAV = [['floor', 'The floor', 'floor'], ['designer', 'Lab designer', 'designer'], ['experiments', 'Experiment board', 'board'], ['inbox', 'Approval inbox', 'inbox'], ['notebook', 'Lab notebook', 'notebook']];

let view = null, viewName = null, saveTimer = null, playTimer = null;
const ls = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage may be unavailable */ } },
};

// ---------- chrome ----------
function renderRail() {
  const r = $('#rail'); clear(r);
  r.append(h('img', { class: 'logo', src: 'elenchia-logo.svg', alt: 'Elenchia' }));
  for (const [id, label, ic] of NAV) {
    const n = id === 'inbox' && isLive() ? (S.M?.openGates.length ?? 0) : 0;
    r.append(h('button', { class: 'rail-btn', 'data-tip': `${label}  [${NAV.findIndex((x) => x[0] === id) + 1}]`, 'aria-label': label, 'aria-current': S.view === id ? 'page' : null, onclick: () => A.go(id) }, icon(ic), n ? h('span', { class: 'badge pulse' }, n) : null));
  }
r.append(h('div', { class: 'spacer' }),    h('button', { class: 'rail-btn', 'data-tip': 'Past runs and replay', 'aria-label': 'Past runs', onclick: runsDialog }, icon('runs')),    h('button', { class: 'rail-btn', 'data-tip': 'Models, hardware and servers', 'aria-label': 'Runtimes', onclick: settingsDialog }, icon('chip')),    h('button', { class: 'rail-btn', 'data-tip': 'Settings and tour', 'aria-label': 'Settings', onclick: () => appSettingsDialog({ replayTour: () => startTour(newRunDialog) }) }, icon('gear')),    h('button', { class: 'rail-btn', 'data-tip': S.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme', 'aria-label': 'Toggle theme', onclick: () => A.toggleTheme() }, icon(S.theme === 'dark' ? 'sun' : 'moon')));
}

/** The one colour-coded element in the app: what the lab is doing right now. */
function statusIndicator(M) {
  let kind = 'idle', label = 'Idle', detail = '';
  const name = (id) => M?.lab?.agents.find((a) => a.id === id)?.name ?? '';
  if (!S.runId || !M?.started) { kind = 'idle'; label = S.awaiting ? 'Starting' : 'Idle'; if (S.awaiting) kind = 'run'; }
  else if (!isLive()) { kind = 'idle'; label = 'Replay'; }
  else if (M.ended) {
    const s = M.ended.status;
    [kind, label] = s === 'completed' ? ['done', 'Completed'] : s === 'error' ? ['err', 'Error'] : s === 'halted' ? ['halt', 'Halted'] : ['halt', 'Stopped'];
    detail = M.ended.reason && s !== 'completed' ? M.ended.reason : '';
  } else if (M.openGates.length) {
    kind = 'wait'; label = 'Waiting on you'; detail = M.openGates[0].title || '';
  } else if (S.toolStatus) {
    kind = 'search'; label = 'Searching'; detail = S.toolStatus.who || '';
  } else if (S.retryUntil && Date.now() < S.retryUntil) {
    kind = 'retry'; label = 'Retrying'; detail = S.retryWho || '';
  } else {
    const active = Object.entries(M.agents || {}).find(([, st]) => st.status === 'thinking' || st.status === 'arguing');
    kind = 'run'; label = 'Running'; detail = active ? `${name(active[0])} ${active[1].status === 'arguing' ? 'is arguing' : 'is thinking'}` : (M.phase || '');
  }
  const live = ['run', 'search', 'retry'].includes(kind);
  return h('div', { class: `status st-${kind}${live ? ' live' : ''}`, role: 'status', title: detail ? `${label}: ${detail}` : label },
    h('span', { class: 'dot' }), h('b', {}, label), detail ? h('span', { class: 'sd' }, trunc(detail, 34)) : null);
}

function renderTop() {
  const t = $('#topbar'), M = S.M; clear(t);
  const meta = S.runs.find((r) => r.id === S.runId);
  const q = M?.framed?.question ?? M?.started?.question ?? meta?.question;
  t.append(...[h("div", { class: "title" }, q ? q : "Elenchia"),
    M?.started && !M.ended && M.phase ? pill(M.phase + (M.round ? ` · round ${M.round}` : ''), 'dashed') : null,
    M?.started ? pill(`turn ${M.turns} / ${M.framed?.max_turns ?? M.started.max_turns}`, 'dashed') : null,
    !isLive() ? pill('replay', 'solid') : null,
    h("div", { class: "grow" })].filter(Boolean));
  const d = S.detection;
  const n = modelsAvailable().length;
  t.append(...[
    statusIndicator(S.M),
    S.preview ? pill('browser preview', 'dashed') : null,
    h('button', { class: 'pill', style: { cursor: 'pointer', background: 'none' }, title: 'Runtimes & hardware', onclick: settingsDialog }, n ? `${n} model${n > 1 ? 's' : ''}` : 'no local models · demo lab'),
    running() ? h('button', { class: 'btn sm', onclick: () => A.halt() }, 'Halt run') : null,
    h('button', { class: 'btn primary sm', onclick: newRunDialog }, 'New run ', h("kbd", {}, "N")),
    windowControls()].filter(Boolean));
  void d;
}

function mountView(opts = {}) {
  if (view) view.destroy?.();
  viewName = S.view;
  const host = $('#view'); clear(host);
  view = VIEWS[S.view](opts);
  host.append(view.el);
  view.update(null, { reset: true });
}

function refresh(ev, o) { renderRail(); renderTop(); view?.update(ev, o); }

// ---------- events ----------
function handleEvent(p) {
  if (!p.persisted) {
    if (p.run_id !== S.runId && !S.awaiting) return;
    if (p.kind === 'tool_status') {
      S.toolStatus = p.data.state === 'start' ? { ...p.data, t0: Date.now() } : null;
      renderTop();
      if (S.view === 'floor') view?.tool?.(S.toolStatus, p.data.from);
      return;
    }
    if (p.kind === 'browser_view') {
      S.browserView = p.data.closed ? { ...(S.browserView || {}), closed: true } : p.data;
      if (!p.data.closed && !S.browserShown) { S.browserShown = true; S.feedTab = 'browser'; }
      if (S.view === 'floor') view?.browser?.();
      return;
    }
    if (p.kind === 'message_retry') {
      S.live.delete(p.data.id); S.thought.delete(p.data.id);
      S.retryUntil = Date.now() + 9000; S.retryWho = agentName(S.M, p.data.from);
      renderTop(); setTimeout(renderTop, 9100);
      if (S.view === 'floor') view?.retry?.(p.data.id, p.data.from, p.data.reason);
      return;
    }
    if (p.kind === 'message_delta') {
      const id = p.data.id;
      if (p.data.channel === 'thought') S.thought.set(id, (S.thought.get(id) || '') + p.data.text);
      else S.live.set(id, (S.live.get(id) || '') + p.data.text);
      if (S.view === 'floor') view?.delta?.(id, p.data.from, S.live.get(id) || '', S.thought.get(id) || '');
    }
    return;
  }
  const ev = p.event;
  if (ev.run_id !== S.runId) {
    if (S.awaiting && ev.kind === 'run_started') { S.runId = ev.run_id; S.events = []; S.live.clear(); S.thought.clear(); S.browserView = null; S.browserShown = false; S.toolStatus = null; }
    else { if (ev.kind === 'run_ended') loadRuns(); return; }
  }
  S.events.push(ev);
  if (ev.kind === 'message') { S.live.delete(ev.data.id); S.thought.delete(ev.data.id); }
  if (ev.kind === 'run_started') S.awaiting = false;
  if (S.replay != null) { refresh(null); return; } // user is scrubbing; keep their place
  recompute();
  if (ev.kind === 'gate_open' && !ev.data.auto) toast(`Waiting on you: ${ev.data.title}`);
  if (ev.kind === 'run_ended') { loadRuns().then(renderTop); if (ev.data.status === 'error') toast('Run stopped: ' + ev.data.reason, 8000); }
  refresh(ev);
}

async function loadRuns() { S.runs = await call('list_runs'); }

// ---------- actions ----------
Object.assign(A, {
  go(name, opts = {}) {
    S.view = name; closeDrawer(); renderRail();
    mountView(opts); renderTop();
  },
  async startRun(params) {
    S.awaiting = true; S.events = []; S.replay = null; S.live.clear(); S.thought.clear(); S.browserView = null; S.browserShown = false; S.toolStatus = null; S.focus = null; stopPlay();
    try {
      const id = await call('start_run', { lab: S.lab, params });
      S.runId = id; await loadRuns();
    } catch (e) { S.awaiting = false; toast(String(e), 6000); return; }
    recompute(); A.go('floor');
  },
  async loadRun(id) {
    stopPlay();
    S.events = await call('run_events', { runId: id }); S.runId = id; S.replay = null; S.live.clear(); S.thought.clear(); S.browserView = null; S.browserShown = false; S.toolStatus = null;
    recompute(); A.go('floor');
  },
  async resolve(gateId, decision) { await call('resolve_gate', { gateId, decision }); },
  async halt() { if (S.runId) await call('halt_run', { runId: S.runId }); },
  async verify() { return call('verify_audit', { runId: S.runId }); },
  setReplay(i) {
    const n = S.events.length;
    if (i == null || i >= n) { S.replay = null; stopPlay(); } else S.replay = Math.max(0, i);
    recompute(); refresh(null, { reset: true });
  },
  stepReplay(d) {
    stopPlay();
    const n = S.events.length, cur = S.replay ?? n, next = Math.max(0, Math.min(n, cur + d));
    S.replay = next >= n ? null : next;
    recompute(); refresh(d > 0 && next > 0 ? S.events[next - 1] : null, { animate: true, reset: d < 0 });
  },
  togglePlay() {
    if (playTimer) { stopPlay(); refresh(null); return; }
    if (S.replay == null) { S.replay = 0; recompute(); refresh(null, { reset: true }); }
    S.playing = true;
    playTimer = setInterval(() => {
      const n = S.events.length, next = (S.replay ?? n) + 1;
      if (next >= n) { A.setReplay(null); return; }
      S.replay = next; recompute(); refresh(S.events[next - 1], { animate: true });
    }, 650);
    refresh(null);
  },
  toggleCalm() { S.calm = !S.calm; ls.set('elenchia.calm', S.calm ? '1' : '0'); refresh(null); },
  toggleTheme() { setTheme(S.theme === 'dark' ? 'light' : 'dark'); },
  moveAgent(id, x, y) {
    const a = S.lab.agents.find((z) => z.id === id); if (a && !S.M.started) { a.x = x; a.y = y; A.touchLab(); }
  },
  // ----- lab editing -----
  touchLab() { ls.set('elenchia.lab', JSON.stringify(S.lab)); if (!S.M?.started) { S.M = null; recompute(); } },
  async saveLab() { A.touchLab(); await call('save_lab', { lab: S.lab }); S.labs = await call('list_labs'); },
  async loadLab(id) { const l = S.labs.find((x) => x.id === id); if (l) { S.lab = JSON.parse(JSON.stringify(l)); A.touchLab(); designerRefresh(); } },
  async resetLab() { S.lab = await call('default_lab'); A.touchLab(); designerRefresh(); },
  addAgent(kind) {
    const names = { generator: 'Hypothesis generator', critic: 'Critic', experimentalist: 'Experimentalist', statistician: 'Statistician', manager: 'Lab manager', scribe: 'Scribe', custom: 'Custom role' };
    const base = S.lab.agents.find((a) => a.kind === 'critic') ?? S.lab.agents[0];
    const id = kind + '-' + Math.random().toString(36).slice(2, 6);
    S.lab.agents.push({ id, name: names[kind] + (S.lab.agents.some((a) => a.kind === kind) ? ' 2' : ''), kind, brief: kind === 'custom' ? 'Describe what this role does, what it produces, and how it should disagree.' : `Additional ${names[kind].toLowerCase()}.`, model: { ...base.model }, tools: [], memory_scope: 'run', disposition: 0.5, disagree: '', enabled: true, x: 0.5, y: 0.5 });
    A.touchLab(); designerRefresh(id);
  },
  removeAgent(id) { S.lab.agents = S.lab.agents.filter((a) => a.id !== id); S.lab.links = S.lab.links.filter((l) => l.from !== id && l.to !== id); A.touchLab(); designerRefresh(); },
  addLink(from, to, kind) { if (!S.lab.links.some((l) => l.from === from && l.to === to && l.kind === kind)) S.lab.links.push({ from, to, kind }); A.touchLab(); designerRefresh(); },
  removeLink(l) { S.lab.links = S.lab.links.filter((x) => x !== l); A.touchLab(); designerRefresh(); },
  autoAssign() {
    const all = modelsAvailable(); if (!all.length) return;
    const local = all.filter((m) => m.runtime !== 'openai');
    const ms = local.length ? local : all; // local models first; cloud only if nothing local is available
    const fam = (m) => (m.family || m.id.split(/[:\-/ ]/)[0] || '').toLowerCase();
    const bySize = [...ms].sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
    const gen = bySize[0], critic = ms.find((m) => fam(m) !== fam(gen)) ?? bySize[1 % ms.length];
    const coder = ms.find((m) => /cod/i.test(m.id)) ?? gen, small = bySize[bySize.length - 1];
    const pick = { generator: gen, critic, experimentalist: coder, statistician: gen, manager: small, scribe: small };
    for (const a of S.lab.agents) { const m = pick[a.kind]; if (m) { a.model.runtime = m.runtime; a.model.model = m.id; } }
    A.touchLab(); designerRefresh(); toast('Assigned local models. Critic runs on a different family where available.');
  },
  async rescan() { S.detection = await call('detect'); refresh(null); designerRefresh(); },
  async saveSettings(o, l, extra = {}) { await call('set_settings', { ollamaUrl: o, lmstudioUrl: l, ...extra }); S.settings = await call('get_settings'); await A.rescan(); },
});

function designerRefresh(select) {
  if (S.view === 'designer') mountView({ select });
}

function stopPlay() { if (playTimer) clearInterval(playTimer); playTimer = null; S.playing = false; }

function setTheme(t) {
  S.theme = t; document.documentElement.dataset.theme = t; ls.set('elenchia.theme', t);
  view?.floor?.colors?.(); refresh(null);
}

// ---------- boot ----------
async function boot() {
  installDrag();
  const saved = ls.get('elenchia.theme');
  setTheme(saved || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
  S.calm = ls.get('elenchia.calm') === '1' || matchMedia('(prefers-reduced-motion: reduce)').matches;
  try {
    [S.settings, S.detection, S.labs, S.runs] = await Promise.all([call('get_settings'), call('detect'), call('list_labs'), call('list_runs')]);
  } catch (e) {
    $('#view').append(h('div', { class: 'welcome' }, h('h1', {}, 'Could not start the backend'), h('p', {}, String(e))));
    return;
  }
  S.preview = !isDesktop || !!S.detection.preview;
  let lab = null;
  try { lab = JSON.parse(ls.get('elenchia.lab') || 'null'); } catch { /* ignore */ }
  S.lab = lab && lab.agents ? lab : await call('default_lab');
  recompute(); renderRail(); renderTop(); mountView();
  onEvent(handleEvent);
  if (!tourSeen()) setTimeout(() => startTour(newRunDialog), 600);
  // Re-detect runtimes now and then so starting Ollama later is noticed.
  setInterval(async () => { if (!running()) { try { S.detection = await call('detect'); renderTop(); } catch { /* offline */ } } }, 20000);
}

document.addEventListener('keydown', (e) => {
  if (document.getElementById('tour')) return;
  if (e.key === 'Escape') { closeModal(); closeDrawer(); return; }
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
  const map = { 1: 'floor', 2: 'designer', 3: 'experiments', 4: 'inbox', 5: 'notebook' };
  if (map[e.key]) A.go(map[e.key]);
  else if (e.key === 'n' && S.view !== 'inbox') { e.preventDefault(); newRunDialog(); }
});

boot();
