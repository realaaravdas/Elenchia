// Guided tour: a spotlight walks the user across the five surfaces and the
// chrome. It navigates the real views, so what is highlighted is what they
// will use. Shown once on first launch; reopen from the "?" button in the rail.

import { h } from './util.js';
import { A } from './state.js';

const rail = (title) => `.rail-btn[title="${title}"]`;

const STEPS = [
  { title: 'Welcome to Elenchia', body: 'You are directing an AI lab, not chatting with an assistant. A team of agents (hypothesis generator, critic, experimentalist, statistician) argues about your research question, designs experiments, runs them, and grades the evidence. You decide what is allowed to happen.\n\nThis tour takes about a minute.' },
  { view: 'floor', target: '#view', title: '1 · The floor', rail: 'The floor', body: 'The living diagram of your lab. Agents are nodes; messages travel between them as they speak, object and answer. Drag nodes to rearrange them. Nothing here is decorative: every shape is drawn from the run’s event log.' },
  { view: 'floor', target: '.lanes', fallback: '#view', title: 'Who is doing what', body: 'Lanes show each agent’s current state and what the lab is waiting on. Next to them, the feed holds the full debate, and a timeline scrubber lets you replay any moment of a run.' },
  { view: 'designer', target: '#view', title: '2 · Lab designer', rail: 'Lab designer', body: 'Staff the lab. Pick a local model for each agent, edit its brief, set how contrarian it is, and connect agents with links. Use different models for generator and critic where you can: disagreement is more useful than agreement.' },
  { view: 'experiments', target: '#view', title: '3 · Experiment board', rail: 'Experiment board', body: 'Every experiment as a card: its hypothesis, the exact code that ran, the output, and the statistician’s evidence grade. Numbers only ever come from code that actually executed.' },
  { view: 'inbox', target: '#view', title: '4 · Approval inbox', rail: 'Approval inbox', body: 'This is where you work. The lab stops here and waits for you at five gates: question framing, experiment approval, resource and data access, claim promotion, and ethics flags. Each shows a concrete spec, never a vague “continue?”. Keyboard shortcuts are printed on the buttons.' },
  { view: 'notebook', target: '#view', title: '5 · Lab notebook', rail: 'Lab notebook', body: 'The record: findings with their status (tentative or established), their supporting evidence and caveats, and what the lab tried and dropped. Export it as Markdown. Findings only become established if you accept them and the evidence is real.' },
  { view: 'floor', target: '#topbar .btn.primary', title: 'Start a run', body: 'Press N or click New run and type a research question. The first gate lets you edit how the lab manager restated it, set off-limits topics and a time budget. Then the lab runs; Halt run stops it at any time.' },
  { view: 'floor', target: '#topbar .pill[title]', fallback: '#topbar', title: 'Local models only', body: 'This pill shows how many local models Elenchia found. For LM Studio: load a model, start the server on the Developer tab, and it appears here within seconds. With none running you get a clearly labelled scripted demo lab, so you can still see the whole flow.' },
  { view: 'floor', target: rail('Runtimes & hardware'), title: 'Runtimes & hardware', body: 'Server URLs for LM Studio (port 1234) and Ollama (11434), detected models, your RAM and VRAM, and whether Python is available for experiments.' },
  { view: 'floor', target: rail('Runs'), title: 'Runs & replay', body: 'Every run is saved to an append-only, hash-chained log. Reopen any past run and scrub through it, or verify that the log was never altered.' },
  { view: 'floor', target: rail('Toggle light / dark'), title: 'Keys', body: '1–5 switch views · N new run · Esc close panels · A / R / C / K on gate buttons to approve, reject, condition, or ask the critic again. The sun toggles light and dark.' },
  { title: 'You are set', body: 'The quickest way to learn it: start a run with the demo lab (or your LM Studio model) and watch it reach the first gate. Replay this tour any time from the ? button at the bottom of the rail.', last: true },
];

let root = null, idx = 0, onClose = null;

export function tourSeen() { try { return localStorage.getItem('elenchia.toured') === '1'; } catch { return false; } }
const markSeen = () => { try { localStorage.setItem('elenchia.toured', '1'); } catch { /* ignore */ } };

export function startTour(done) {
  if (root) return;
  onClose = done || null; idx = 0;
  root = h('div', { id: 'tour', role: 'dialog', 'aria-label': 'Quick start tour' },
    h('div', { class: 'tour-spot' }), h('div', { class: 'tour-card' }));
  document.body.append(root);
  window.addEventListener('keydown', keys, true);
  window.addEventListener('resize', place);
  show();
}

function end(finished) {
  markSeen();
  window.removeEventListener('keydown', keys, true);
  window.removeEventListener('resize', place);
  root?.remove(); root = null;
  if (finished && onClose) onClose();
}

function keys(e) {
  if (!root) return;
  if (e.key === 'Escape') { e.stopPropagation(); end(false); }
  else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); next(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); go(idx - 1); }
}

function next() { if (idx >= STEPS.length - 1) end(true); else go(idx + 1); }
function go(i) { idx = Math.max(0, Math.min(STEPS.length - 1, i)); show(); }

function targetEl(s) {
  if (!s.target) return null;
  return document.querySelector(s.target) || (s.fallback ? document.querySelector(s.fallback) : null);
}

function show() {
  const s = STEPS[idx];
  if (s.view) A.go(s.view);
  const card = root.querySelector('.tour-card');
  card.replaceChildren(
    h('div', { class: 'cap' }, `${idx + 1} / ${STEPS.length}`),
    h('h2', {}, s.title),
    ...s.body.split('\n\n').map((p) => h('p', {}, p)),
    h('div', { class: 'tour-dots' }, STEPS.map((_, i) => h('i', { class: i === idx ? 'on' : '' }))),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn sm', onclick: () => end(false) }, s.last ? 'Close' : 'Skip'),
      h('span', { style: { flex: 1 } }),
      idx > 0 ? h('button', { class: 'btn sm', onclick: () => go(idx - 1) }, 'Back') : null,
      h('button', { class: 'btn primary sm', onclick: next }, s.last ? 'Finish' : 'Next')));
  // Let the view mount before measuring.
  requestAnimationFrame(() => requestAnimationFrame(place));
}

function place() {
  if (!root) return;
  const s = STEPS[idx], spot = root.querySelector('.tour-spot'), card = root.querySelector('.tour-card');
  const el = targetEl(s);
  const vw = innerWidth, vh = innerHeight, pad = 6, cw = Math.min(360, vw - 32);
  card.style.width = cw + 'px';
  if (!el) {
    spot.style.cssText = 'left:50%;top:50%;width:0;height:0';
    card.style.left = (vw - cw) / 2 + 'px';
    card.style.top = Math.max(16, (vh - card.offsetHeight) / 2) + 'px';
    return;
  }
  const r = el.getBoundingClientRect();
  const big = r.width > vw * 0.6 && r.height > vh * 0.5; // whole-view target: outline it, put the card inside
  spot.style.cssText = `left:${r.left - pad}px;top:${r.top - pad}px;width:${r.width + pad * 2}px;height:${r.height + pad * 2}px`;
  const ch = card.offsetHeight;
  let x, y;
  if (big) { x = r.right - cw - 24; y = r.bottom - ch - 24; }
  else if (r.right + cw + 24 < vw) { x = r.right + 18; y = r.top; }          // right of target (rail items)
  else if (r.left - cw - 24 > 0) { x = r.left - cw - 18; y = r.top; }         // left of target
  else { x = r.left; y = r.bottom + 18; }                                      // below (top-bar items)
  card.style.left = Math.max(16, Math.min(vw - cw - 16, x)) + 'px';
  card.style.top = Math.max(16, Math.min(vh - ch - 16, y)) + 'px';
}
