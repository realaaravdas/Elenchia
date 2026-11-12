// Experiment board, approval inbox and lab notebook.

import { h, $, clear, pill, statusPill, gradeMeter, trunc, ago, clock, GATE_LABEL, GATE_ORDER, download, toast } from './util.js';
import { A, S, isLive } from './state.js';
import { agentName, toMarkdown } from './model.js';
import { gateControls, resolvedLine } from './gates.js';
import { expDrawer, hypDrawer, objThread, messageDialog, openModal, closeModal } from './dialogs.js';
import { replayBar } from './floor.js';

// ---------------- Experiment board ----------------
export function createBoard() {
  const root = h('div', { class: 'board' });
  const COLS = [['Proposed', ['proposed', 'edited']], ['Approved', ['approved']], ['Running', ['running']], ['Finished', ['finished', 'failed', 'rejected']]];
  function update() {
    const M = S.M; clear(root);
    if (!M.exps.size) {
      root.style.display = 'block';
      root.append(h('div', { class: 'empty', style: { maxWidth: '560px', margin: '60px auto' } }, h('b', {}, 'No experiments yet.'), h('div', { style: { marginTop: '6px' } }, 'Proposed, approved, running and finished experiments appear here as cards. Approval happens on the card, with a code diff.')));
      return;
    }
    root.style.display = '';
    for (const [name, states] of COLS) {
      const items = [...M.exps.values()].filter((e) => states.includes(e.state));
      root.append(h('div', { class: 'col' },
        h('header', {}, h('span', { class: 'cap' }, name), h('span', { class: 'mono mute' }, items.length)),
        h('div', { class: 'cards' }, items.map((e) => {
          const waiting = M.openGates.find((g) => (g.kind === 'experiment' || g.kind === 'resource') && g.detail?.experiment === e.id);
          return h('div', { class: 'card xcard hover' + (waiting ? ' blocked' : ''), onclick: () => expDrawer(e.id) },
            h('div', { class: 'mono mute' }, `${e.id} · ${e.hypothesis} · round ${e.round}`),
            h('div', { class: 't' }, e.title),
            h('div', { class: 'dim', style: { fontSize: '12px' } }, trunc(e.protocol, 110)),
            h('div', { class: 'meta' },
              waiting ? pill('needs your approval', 'solid dot pulse') : null,
              e.state === 'failed' ? pill('failed', 'strike') : e.state === 'rejected' ? pill('rejected', 'strike') : null,
              pill(`≈ ${e.est_seconds}s`, 'dashed'),
              (e.needs || []).map((n) => pill(n, 'dashed')),
              e.result ? pill(`${e.result.duration_ms} ms`, 'dashed') : null,
              e.evidence ? h('span', { class: 'row', style: { gap: '6px' } }, gradeMeter(e.evidence.grade), pill(e.evidence.grade)) : null));
        }))));
    }
  }
  return { el: root, update, destroy() {} };
}

// ---------------- Approval inbox ----------------
export function createInbox() {
  const root = h('div', { class: 'scroll' });
  let sel = 0;
  const page = h('div', { class: 'page', style: { maxWidth: '860px' } });
  root.append(page);

  function items() {
    return [...S.M.openGates].sort((a, b) => (GATE_ORDER[a.kind] ?? 9) - (GATE_ORDER[b.kind] ?? 9) || a.seq - b.seq);
  }
  function update() {
    const M = S.M, list = items();
    sel = Math.min(sel, Math.max(0, list.length - 1));
    const activeInput = document.activeElement && page.contains(document.activeElement) && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName);
    if (activeInput) return; // never rebuild under the user's cursor
    clear(page);
    page.append(h('div', { class: 'row', style: { marginBottom: '18px' } }, h('div', { style: { flex: 1 } }, h('h1', {}, 'Approval inbox'), h('div', { class: 'dim' }, 'Everything waiting on you, ranked by what blocks the run.')),
      h('span', { class: 'mono mute' }, 'j/k move · A approve · C condition · R reject · K ask critic')));
    if (!list.length) {
      page.append(h('div', { class: 'empty' }, h('b', {}, 'Nothing is waiting on you.'), h('div', { style: { marginTop: '6px' } }, S.runId ? (M.ended ? 'This run has ended.' : 'The lab is working. You’ll be pulled in at the next gate.') : 'Start a run to put the lab to work.')));
    }
    list.forEach((g, i) => {
      page.append(h('div', { class: 'card inbox-item blocked', 'aria-selected': i === sel, 'data-i': i, onclick: () => { sel = i; } },
        h('div', { class: 'top' }, pill(GATE_LABEL[g.kind] || g.kind, 'solid'), h('h3', {}, g.title), h('span', { class: 'mute' }, ago(g.ts))),
        h('div', { style: { marginTop: '12px' } }, gateControls(g))));
    });
    const done = [...M.gates.values()].filter((g) => !g.open).sort((a, b) => b.seq - a.seq).slice(0, 10);
    if (done.length) page.append(h('div', { class: 'cap', style: { margin: '28px 0 10px' } }, 'Recently decided'), h('div', { class: 'stack' }, done.map((g) => h('div', { class: 'card pad' }, h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, g.title), resolvedLine(g)))));
    const ac = page.querySelector(`[data-i="${sel}"]`); if (ac) ac.style.borderColor = 'var(--fg)';
  }
  function key(e) {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || e.metaKey || e.ctrlKey || e.altKey) {
      if (e.key === 'Enter' && e.target.dataset?.role === 'condition') { e.preventDefault(); e.target.closest('[data-gate]')?.querySelector('[data-key="c"]')?.click(); }
      return;
    }
    const list = items(); if (!list.length) return;
    if (e.key === 'j' || e.key === 'ArrowDown') { sel = Math.min(list.length - 1, sel + 1); update(); page.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: 'nearest' }); return; }
    if (e.key === 'k' && !page.querySelector(`[data-i="${sel}"] [data-key="k"]`)) { sel = Math.max(0, sel - 1); update(); return; }
    if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); update(); return; }
    const card = page.querySelector(`[data-i="${sel}"]`);
    const btn = card?.querySelector(`[data-key="${e.key.toLowerCase()}"]`);
    if (btn) {
      e.preventDefault();
      if (e.key.toLowerCase() === 'c') card.querySelector('[data-role="condition"]')?.focus();
      if (!(e.key.toLowerCase() === 'c')) btn.click();
    }
  }
  document.addEventListener('keydown', key);
  return { el: root, update, destroy() { document.removeEventListener('keydown', key); } };
}

// ---------------- Notebook ----------------
export function createNotebook(opts = {}) {
  const root = h('div', { class: 'scroll' });
  const page = h('div', { class: 'page' });
  root.append(page);
  let audit = null;

  function sec(id, title, ...kids) { return h('section', { class: 'nb-sec', id: 'nb-' + id }, h('h2', {}, title), ...kids); }

  async function verify() {
    if (!S.runId) return;
    audit = await A.verify(); update();
    toast(audit.broken_at ? `Chain broken at event ${audit.broken_at}` : `Audit chain intact: ${audit.events} events`);
  }

  function update() {
    const M = S.M;
    const st = root.scrollTop; clear(page);
    if (!S.runId || !M.started) {
      page.append(h('div', { class: 'empty', style: { maxWidth: '560px', margin: '60px auto' } }, h('b', {}, 'The notebook is empty.'), h('div', { style: { marginTop: '6px' } }, 'Hypotheses with their status, evidence links, decisions and an exportable report build up here as a run proceeds.')));
      return;
    }
    const q = M.framed?.question ?? M.started.question;
    const toc = [['question', 'Question'], ['findings', 'Findings'], ['hypotheses', 'Hypotheses'], ['experiments', 'Experiments'], ['decisions', 'Decisions'], ['audit', 'Audit log']];
    const left = h('nav', { class: 'nb-toc' }, toc.map(([id, t]) => h('a', { onclick: () => $('#nb-' + id, page)?.scrollIntoView({ behavior: 'smooth' }) }, t)),
      h('hr', { class: 'hr' }),
      h('button', { class: 'btn sm', onclick: () => download(`elenchia-notebook-${S.runId.slice(0, 8)}.md`, toMarkdown(M, S.runs.find((r) => r.id === S.runId))) }, 'Export Markdown'));

    const main = h('div', {},
      sec('question', 'Question',
        h('p', { style: { fontSize: '16px', margin: '0 0 10px' } }, q),
        M.framed && M.started.question !== q ? h('div', { class: 'mute' }, 'Originally asked: ' + M.started.question) : null,
        h('div', { class: 'row', style: { marginTop: '10px', flexWrap: 'wrap' } }, pill(M.lab.name, 'dashed'), pill(`${M.turns} / ${M.framed?.max_turns ?? M.started.max_turns} turns`, 'dashed'), M.ended ? pill(M.ended.status, 'solid') : pill('in progress', 'dot pulse')),
        M.started.constraints?.length ? h('div', { class: 'dim', style: { marginTop: '8px' } }, 'Constraints: ' + M.started.constraints.join('; ')) : null,
        (M.framed?.offlimits ?? M.started.offlimits)?.length ? h('div', { class: 'dim' }, 'Off-limits: ' + (M.framed?.offlimits ?? M.started.offlimits).join(', ')) : null,
        M.msgs.some((m) => m.scripted) ? h('div', { class: 'card pad', style: { marginTop: '12px' } }, 'Agents in this run followed the scripted demo, not language models. Experiments were genuinely executed.') : null),
      sec('findings', 'Findings', M.findings.length ? h('div', { class: 'stack' }, M.findings.map((f) => h('div', { class: 'card pad' },
        h('div', { class: 'row' }, h('h3', { style: { flex: 1 } }, f.title), statusPill(f.status), gradeMeter(f.grade), pill(f.grade)),
        h('p', { style: { margin: '8px 0' } }, f.text),
        h('div', { class: 'mute' }, `${f.hypothesis} · ${f.experiment} · decided: ${f.decided}${f.downgraded ? ' · status capped by lab rules' : ''}`),
        (f.caveats || []).map((c) => h('div', { class: 'dim' }, '· ' + c))))) : h('div', { class: 'empty' }, 'Nothing has been promoted. Claims are tentative until you promote them.')),
      sec('hypotheses', 'Hypotheses', h('div', { class: 'stack' }, [...M.hyps.values()].map((hy) => h('div', { class: 'hcard', id: 'nb-hyp-' + hy.id },
        h('div', { class: 'row' }, h('span', { class: 'mono', style: { fontWeight: 700 } }, hy.id), statusPill(hy.status), h('span', { class: 'mute', style: { flex: 1 } }, 'round ' + hy.round), hy.evidence ? gradeMeter(hy.evidence.grade) : null),
        h('div', { class: 'claim' }, hy.claim), h('div', { class: 'pred' }, 'Predicts: ' + hy.prediction),
        h('div', { class: 'mute', style: { marginTop: '4px' } }, 'Assumes: ' + ((hy.assumptions || []).join(' · ') || '—')),
        hy.objs.length ? h('div', { class: 'thread' }, hy.objs.map((oid) => objThread(M.objs.get(oid)))) : null,
        hy.exps.length ? h('div', { class: 'row', style: { marginTop: '10px', flexWrap: 'wrap' } }, hy.exps.map((e) => h('button', { class: 'btn sm', onclick: () => expDrawer(e) }, `${e} · ${M.exps.get(e).state}`))) : null,
        hy.evidence ? h('div', { style: { marginTop: '8px' } }, hy.evidence.summary) : null))) ),
      sec('experiments', 'Experiments', M.exps.size ? h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['ID', 'Title', 'Hyp.', 'State', 'Executed by', 'Seed', 'Grade'].map((t) => h('th', {}, t)))),
        h('tbody', {}, [...M.exps.values()].map((e) => h('tr', { style: { cursor: 'pointer' }, onclick: () => expDrawer(e.id) }, h('td', { class: 'mono' }, e.id), h('td', {}, e.title), h('td', { class: 'mono' }, e.hypothesis), h('td', {}, e.state), h('td', { class: 'mute' }, e.result?.executor ?? '—'), h('td', { class: 'mono mute' }, e.result?.seed ?? '—'), h('td', {}, e.evidence ? gradeMeter(e.evidence.grade) : '—'))))) : h('div', { class: 'mute' }, 'None yet.')),
      sec('decisions', 'Decisions', M.decisions.length ? h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Time', 'Gate', 'Decision', 'By', 'Note'].map((t) => h('th', {}, t)))),
        h('tbody', {}, M.decisions.map((d) => h('tr', {}, h('td', { class: 'mono mute' }, clock(d.ts)), h('td', {}, GATE_LABEL[d.kind] || d.kind), h('td', { style: { fontWeight: 600 } }, d.decision), h('td', {}, d.by === 'auto' ? 'auto' : 'you'), h('td', { class: 'dim' }, d.note || ''))))) : h('div', { class: 'mute' }, 'No decisions yet.')),
      sec('audit', 'Audit log',
        h('p', { class: 'dim', style: { marginTop: 0 } }, 'Append-only and hash-chained. Each entry commits to the one before it, so a result can be traced to who decided what, and tampering is detectable.'),
        h('div', { class: 'row', style: { marginBottom: '10px' } }, h('button', { class: 'btn sm', onclick: verify }, 'Verify chain'), audit ? pill(audit.broken_at ? `broken at #${audit.broken_at}` : `intact · ${audit.events} events`, audit.broken_at ? 'strike' : 'solid') : null),
        h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['#', 'Time', 'Event', 'Hash'].map((t) => h('th', {}, t)))),
          h('tbody', {}, S.events.slice(0, S.replay ?? S.events.length).map((e) => h('tr', {}, h('td', { class: 'mono mute' }, e.seq), h('td', { class: 'mono mute' }, clock(e.ts)), h('td', { class: 'mono' }, e.kind), h('td', { class: 'mono mute' }, (e.hash || '').slice(0, 10))))))));

    page.append(
      h('div', { class: 'row', style: { marginBottom: '16px' } }, h('h1', { style: { flex: 1 } }, 'Lab notebook'), isLive() ? null : pill('replaying', 'solid')),
      h('div', { class: 'stage', style: { position: 'relative', height: '56px', background: 'none', marginBottom: '22px' } }, replayBar()),
      h('div', { class: 'nb-grid' }, left, main));
    // the replay bar is absolutely positioned for the floor; relax it here
    page.querySelector('.overlay').style.cssText = 'position:static;margin:0;width:100%';
    root.scrollTop = st;
    if (opts.anchor) { const a = $('#nb-' + opts.anchor, page); if (a) { a.scrollIntoView({ block: 'center' }); a.style.borderColor = 'var(--fg)'; } opts.anchor = null; }
  }
  return { el: root, update, destroy() {} };
}
