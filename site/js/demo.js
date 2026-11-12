// The hero animation. It replays a run recorded from the real orchestrator (the scripted demo
// lab) through the app's own diagram renderer and event model, so what you see is what the
// desktop app draws. Gates pause for a simulated human decision.

import { derive } from './vendor/model.js';
import { Floor } from './vendor/diagram.js';
import { icon } from './vendor/util.js';

const $ = (s) => document.querySelector(s);
const demo = $('#demo');
const sleepRaw = (ms) => new Promise((r) => setTimeout(r, ms));
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

// step strips: gates are steps 1, 5 and 7, like the app
document.querySelectorAll('.steps').forEach((s) => [0, 4, 6].forEach((i) => s.children[i]?.classList.add('gate')));

// rail icons, drawn by the app's own icon set
const rail = $('#d-rail');
rail.innerHTML = '<img class="logo" src="favicon.svg" alt="">';
['floor', 'designer', 'board', 'inbox', 'notebook'].forEach((n, i) => { const el = document.createElement('i'); if (i === 0) el.className = 'on'; el.append(icon(n)); rail.append(el); });

const CAPTIONS = [
  ['Frame', 'You ask a question. The lab manager restates it so it can be <b>tested</b>, and you confirm or edit it before anything starts.'],
  ['Hypothesize', 'The generator proposes <b>rival hypotheses</b>. Each one is a seed on the commons between the generator and the critic.'],
  ['Challenge', 'The critic attacks them. Every open objection <b>cracks</b> its seed until it is answered, and they go back and forth.'],
  ['Design', 'The experimentalist writes a small program. The statistician sets the analysis plan: the test, the sample size, the stopping rule.'],
  ['Approve', 'Nothing runs until <b>you</b> approve a concrete spec: the code, a runtime estimate and a risk label.'],
  ['Analyze', 'Results come only from <b>executed code</b>. The statistician grades the evidence, and the critic gets a final pass.'],
  ['Promote', 'A finding is <b>tentative</b> by default. It only becomes established if you accept it and the evidence is real.'],
];
const PHASE_STEP = { frame: 0, hypothesize: 1, challenge: 2, answer: 2, resolve: 2, design: 3, plan: 3, approve: 4, run: 4, analyze: 5, finalpass: 5, promote: 6 };

let E;
try { E = await (await fetch('data/sample-run.json')).json(); } catch { E = null; }
if (!E || !E.length) { demo.hidden = true; throw new Error('no recording'); }

const canvas = $('#d-canvas');
const floor = new Floor(canvas, {});
addEventListener('themechange', () => { floor.colors(); floor.dirty = true; });

// ---------- rendering of the side panels ----------
const els = { title: $('#d-title'), phase: $('#d-phase'), turn: $('#d-turn'), status: $('#d-status'), feed: $('#d-feed'), cap: $('#d-cap'), capH: $('#d-cap-h'), steps: $('#d-steps') };
const trunc = (s, n) => (String(s ?? '').length > n ? String(s).slice(0, n - 1).trimEnd() + '…' : String(s ?? ''));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let seen = new Set(), gateUi = null, lastStep = -1;

function status(M) {
  let cls = 'idle', label = 'Idle', detail = '';
  if (M.ended) { cls = 'done'; label = 'Completed'; }
  else if (gateUi && gateUi.stage !== 'done') { cls = 'wait'; label = 'Waiting on you'; detail = gateUi.title; }
  else if (M.started) {
    cls = 'run'; label = 'Running';
    const a = Object.entries(M.agents || {}).find(([, s]) => s.status === 'thinking' || s.status === 'arguing');
    if (a) detail = `${M.lab.agents.find((x) => x.id === a[0])?.name ?? ''} is ${a[1].status === 'arguing' ? 'arguing' : 'thinking'}`;
  }
  els.status.className = `status ${cls}`;
  els.status.innerHTML = `<span class="dot"></span><b>${label}</b>${detail ? `<span class="sd">${esc(trunc(detail, 34))}</span>` : ''}`;
}

function card(key, cls, html) {
  const isNew = !seen.has(key); seen.add(key);
  return `<div class="${cls}${isNew ? ' new' : ''}">${html}</div>`;
}

function renderFeed(M) {
  const out = [];
  [...M.hyps.values()].slice(-3).forEach((hy) => {
    const objs = hy.objs.map((id) => M.objs.get(id)).filter(Boolean).slice(0, 2).map((o) => `
      <div class="obj${o.resolved === true ? ' done' : ''}"><div class="o-cap">${esc(o.id)} · critic · ${esc(o.severity)}</div><div class="o-text">${esc(trunc(o.text, 110))}</div>
      ${o.answer ? `<div class="o-ans">${esc(trunc(o.answer.response, 120))}</div>` : ''}</div>`).join('');
    out.push(`<div class="hcard ${seen.has('h' + hy.id) ? '' : 'new'}"><div class="hd"><b class="mono">${esc(hy.id)}</b><span class="pill">${esc(hy.status)}</span></div><div class="claim">${esc(trunc(hy.claim, 120))}</div>${hy.prediction ? `<div class="pred">${esc(trunc(hy.prediction, 90))}</div>` : ''}${objs}</div>`);
    seen.add('h' + hy.id);
  });
  const ev = M.evidence[M.evidence.length - 1];
  if (ev) {
    const n = { inconclusive: 0, weak: 1, moderate: 2, strong: 3 }[ev.grade] ?? 0;
    out.push(card('ev' + M.evidence.length, 'evcard', `<div class="cap" style="margin-bottom:6px">Evidence</div><span class="meter">${[0, 1, 2, 3].map((i) => `<i class="${i < n ? 'f' : ''}"></i>`).join('')}</span><b>${esc(ev.grade)}</b><div class="dim" style="margin-top:5px;color:var(--fg-dim)">${esc(trunc(ev.summary, 120))}</div>`));
  }
  const f = M.findings[M.findings.length - 1];
  if (f) out.push(card('f' + M.findings.length, 'evcard', `<div class="cap" style="margin-bottom:6px">Finding · ${esc(f.status)}</div><b>${esc(trunc(f.title, 70))}</b>`));
  if (gateUi) {
    const press = gateUi.stage === 'press' ? ' press' : '';
    out.push(`<div class="gatecard${gateUi.stage === 'done' ? ' done' : ''}${gateUi.fresh ? ' new' : ''}"><div class="cap">${gateUi.stage === 'done' ? 'Decided by you' : 'Needs your decision'}</div><div class="g-t">${esc(gateUi.title)}</div><div class="g-b">${esc(gateUi.body)}</div>${gateUi.stage === 'done' ? '' : `<div class="row"><span class="btn${press}" style="${press ? '' : 'background:var(--inv-bg);color:var(--inv-fg);border-color:var(--inv-bg)'}">${esc(gateUi.yes)}</span><span class="btn">Edit</span><span class="btn">Reject</span></div>`}</div>`);
    gateUi.fresh = false;
  }
  els.feed.innerHTML = out.join('');
}

function render(M) {
  const q = M.framed?.question ?? M.started?.question ?? '';
  els.title.textContent = q || 'Elenchia';
  const step = PHASE_STEP[M.phase] ?? lastStep;
  els.phase.hidden = !M.phase || !!M.ended; els.phase.textContent = `${M.phase ?? ''}${M.round ? ` · round ${M.round}` : ''}`;
  els.turn.hidden = !M.started; els.turn.textContent = `turn ${M.turns} / ${M.started?.max_turns ?? 60}`;
  [...els.steps.children].forEach((c, i) => c.classList.toggle('on', i === step));
  if (step !== lastStep && step >= 0) {
    lastStep = step;
    els.capH.textContent = `${step + 1} · ${CAPTIONS[step][0]}`;
    els.cap.style.opacity = 0;
    setTimeout(() => { els.cap.innerHTML = CAPTIONS[step][1]; els.cap.style.opacity = 1; }, 160);
  }
  status(M); renderFeed(M);
}

// ---------- playback ----------
let token = 0, paused = false, visible = true;
const wait = async (ms, t) => { const end = performance.now() + ms; while (performance.now() < end) { if (t !== token) return false; await sleepRaw(40); while ((paused || !visible) && t === token) await sleepRaw(120); } return t === token; };

const DELAY = { run_started: 700, phase: 900, hypothesis: 850, objection: 950, objection_answer: 500, objection_status: 700, experiment: 1000, experiment_state: 450, experiment_result: 1300, evidence: 1500, finding: 2800, run_ended: 3600, message: 450, gate_resolved: 700 };

function gateText(g) {
  const d = g.detail ?? {};
  if (g.kind === 'framing') return { body: trunc(d.restated || d.question, 140), yes: 'Confirm question' };
  if (g.kind === 'experiment') return { body: `${trunc(d.protocol, 110)}  ·  ≈ ${d.est_seconds}s  ·  ${d.risk === 'low' ? 'low risk' : 'needs review'}`, yes: 'Approve & run' };
  if (g.kind === 'promotion') return { body: trunc(`${d.title}: ${d.finding}`, 140), yes: `Accept as ${d.proposed}` };
  return { body: g.title || '', yes: 'Approve' };
}

async function typeBubble(ev, t) {
  const id = ev.data.id, from = ev.data.from;
  const msg = E.find((e) => e.kind === 'message' && e.data.id === id);
  const say = String(msg?.data?.say ?? '');
  if (!say) return true;
  const total = Math.min(2200, Math.max(700, say.length * 16)), steps = Math.max(8, Math.round(total / 45));
  for (let k = 1; k <= steps; k++) {
    floor.delta(id, from, `{"say":"${say.slice(0, Math.ceil((say.length * k) / steps)).replace(/"/g, '\\"')}`, '');
    if (!(await wait(total / steps, t))) return false;
  }
  return true;
}

async function play() {
  const t = ++token;
  seen = new Set(); gateUi = null; lastStep = -1;
  floor.setModel(derive(E.slice(0, 1)), { live: true, reset: true });
  for (let i = 0; i < E.length; i++) {
    if (t !== token) return;
    const ev = E[i], M = derive(E.slice(0, i + 1));
    if (ev.kind === 'gate_open' && !ev.data.auto) {
      const g = M.gates.get(ev.data.id);
      gateUi = { title: ev.data.title, ...gateText(g), stage: 'open', fresh: true };
    } else if (ev.kind === 'gate_resolved' && gateUi) {
      gateUi.stage = 'done'; gateUi.body = `${gateUi.yes}: approved`;
    } else if (ev.kind === 'phase' && gateUi?.stage === 'done') gateUi = null;
    floor.setModel(M, { live: true });
    floor.push(ev);
    render(M);
    if (ev.kind === 'turn_start') { if (!(await typeBubble(ev, t))) return; continue; }
    if (ev.kind === 'gate_open' && !ev.data.auto) {
      if (!(await wait(2100, t))) return;
      gateUi.stage = 'press'; render(M);
      if (!(await wait(450, t))) return;
      continue;
    }
    if (!(await wait(DELAY[ev.kind] ?? 220, t))) return;
  }
  await wait(4200, t);
  if (t === token) play();
}

function showFinal() {
  const M = derive(E);
  floor.setModel(M, { live: false, calm: true });
  seen = new Set(); gateUi = null; lastStep = -1; render(M);
  els.cap.style.opacity = 1;
}

// controls
const playBtn = $('#d-play'), restartBtn = $('#d-restart');
if (reduced) {
  showFinal(); playBtn.parentElement.hidden = true;
} else {
  playBtn.addEventListener('click', () => { paused = !paused; playBtn.textContent = paused ? 'Play' : 'Pause'; });
  restartBtn.addEventListener('click', () => { paused = false; playBtn.textContent = 'Pause'; play(); });
  new IntersectionObserver(([en]) => { visible = en.isIntersecting; }, { threshold: 0.15 }).observe(demo);
  play();
}
