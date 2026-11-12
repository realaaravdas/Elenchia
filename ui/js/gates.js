// Gate controls: the human's decision surface. Used by the Approval inbox and
// the Experiment board drawer. Approvals are specific: a concrete spec with
// a code diff, runtime estimate and risk, never a vague "continue?".

import { h, put, diffView, gradeMeter, statusPill, pill, GATE_LABEL, toast, trunc } from './util.js';
import { A, S, modelsAvailable } from './state.js';
import { agentName } from './model.js';

const kvs = (pairs) => h('dl', { class: 'kv' }, pairs.filter(Boolean).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));

async function decide(gate, decision, note, edits) {
  try { await A.resolve(gate.id, { decision, note: note || null, edits: edits || null }); }
  catch (e) { toast(String(e)); }
}

export function gateControls(g, opts = {}) {
  const d = g.detail ?? {};
  const wrap = h('div', { class: 'stack', 'data-gate': g.id });
  const M = S.M;
  const key = (k) => ({ 'data-key': k });
  const condition = h('input', { type: 'text', placeholder: 'Condition (binding on the rest of the run)…', 'data-role': 'condition' });
  const note = (ph, role = 'note') => h('input', { type: 'text', placeholder: ph, 'data-role': role });

  if (g.kind === 'framing') {
    const q = h('textarea', { rows: 3, 'data-role': 'q' }, d.restated || d.question);
    const off = h('input', { type: 'text', value: (d.offlimits || []).join(', '), placeholder: 'e.g. patient records, vendor names' });
    const turns = h('input', { type: 'number', value: d.max_turns, min: 4, max: 500 });
    const mins = h('input', { type: 'number', value: 45, min: 1, max: 720 });
    const ds = h('input', { type: 'text', placeholder: 'Optional: path to a dataset the lab may read (copied read-only)' });
    put(wrap, 
      d.question !== d.restated ? h('div', {}, h('div', { class: 'cap' }, 'You asked'), h('div', { class: 'dim' }, d.question)) : null,
      h('div', { class: 'field' }, h('label', {}, 'The lab manager restated it as'), q),
      (d.scope || []).length ? kvs([['Scope', h('ul', { style: { margin: 0, paddingLeft: '18px' } }, d.scope.map((s) => h('li', {}, s)))], ['Assumes', (d.assumptions || []).join(' · ')]]) : null,
      h('div', { class: 'cols3' },
        h('div', { class: 'field' }, h('label', {}, 'Off-limits topics'), off),
        h('div', { class: 'field' }, h('label', {}, 'Turn budget'), turns),
        h('div', { class: 'field' }, h('label', {}, 'Time budget (min)'), mins)),
      h('div', { class: 'field' }, h('label', {}, 'Dataset'), ds),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn primary', ...key('a'), onclick: () => decide(g, 'approve', null, { question: q.value, offlimits: off.value.split(',').map((s) => s.trim()).filter(Boolean), max_turns: +turns.value, max_minutes: +mins.value, dataset: ds.value }) }, 'Confirm question ', h('kbd', {}, 'A')),
        h('button', { class: 'btn', ...key('r'), onclick: () => decide(g, 'reject') }, 'Reject ', h('kbd', {}, 'R'))));
  }

  if (g.kind === 'experiment') {
    const forbidden = d.forbidden || [];
    const code = h('textarea', { class: 'code', hidden: true }, d.code);
    const view = h('div', {}, diffView(d.prev_code, d.code));
    const toggle = h('button', { class: 'btn sm', onclick: () => { code.hidden = !code.hidden; view.hidden = !code.hidden; toggle.textContent = code.hidden ? 'Edit code' : 'Discard edit'; } }, 'Edit code');
    const plan = d.plan || {};
    put(wrap, 
      h('div', { class: 'row' }, pill(d.risk === 'low' ? 'low risk' : 'needs review', d.risk === 'low' ? '' : 'solid'), pill(`≈ ${d.est_seconds}s`), (d.needs || []).map((n) => pill('needs ' + n, 'dashed')), forbidden.map((f) => pill('blocked: ' + f, 'solid'))),
      h('div', {}, h('div', { class: 'cap' }, 'Protocol'), h('div', {}, d.protocol)),
      kvs([['Test', plan.test], ['Sample / power', [plan.n_per_group ? `n=${plan.n_per_group}/arm` : null, plan.power].filter(Boolean).join(' · ')], ['Alpha', plan.alpha], ['Stopping rule', plan.stopping_rule], ['Multiplicity', plan.multiple_comparisons], ['Statistician', plan.verdict ? `${plan.verdict}` : null]]),
      h('div', {}, h('div', { class: 'row', style: { justifyContent: 'space-between', marginBottom: '6px' } }, h('div', { class: 'cap' }, d.prev_code ? 'Code · diff against the previous experiment' : 'Code'), toggle), view, code),
      (d.critic_notes || []).length ? h('div', {}, h('div', { class: 'cap' }, 'Critic’s second pass'), (d.critic_notes).map((n) => h('div', { class: 'obj' }, `${n.severity}: ${n.text}`))) : null,
      h('div', { class: 'field' }, h('label', {}, 'Condition (optional)'), condition),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn primary', disabled: forbidden.length > 0, ...key('a'), onclick: () => decide(g, 'approve', condition.value, code.hidden ? null : { code: code.value }) }, code.hidden ? 'Approve & run' : 'Approve edited', ' ', h('kbd', {}, 'A')),
        h('button', { class: 'btn', disabled: forbidden.length > 0, ...key('c'), onclick: () => { if (!condition.value.trim()) { condition.focus(); return; } decide(g, 'approve', condition.value, code.hidden ? null : { code: code.value }); } }, 'Approve with condition ', h('kbd', {}, 'C')),
        h('button', { class: 'btn', ...key('k'), onclick: () => decide(g, 'ask_critic') }, 'Ask the critic again ', h('kbd', {}, 'K')),
        h('button', { class: 'btn', ...key('r'), onclick: () => decide(g, 'reject', condition.value || 'rejected') }, 'Reject ', h('kbd', {}, 'R'))));
    if (forbidden.length) put(wrap, h('div', { class: 'dim' }, 'This code cannot be approved as written. Edit it to remove the blocked calls, or reject it and the lab will redesign.'));
  }

  if (g.kind === 'resource') {
    const ds = h('input', { type: 'text', placeholder: 'Path to the file or dataset to grant (copied read-only)', value: d.dataset || '' });
    put(wrap, 
      h('div', {}, 'The experiment asks for: ', (d.needs || []).map((n) => pill(n.replace('_', ' '), 'solid'))),
      (d.needs || []).includes('files') ? h('div', { class: 'field' }, h('label', {}, 'Dataset'), ds, h('div', { class: 'hint' }, 'The sandbox gets a read-only copy. Nothing else on disk is visible to it.')) : null,
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn primary', ...key('a'), onclick: () => decide(g, 'grant_once', null, { dataset: ds.value }) }, 'Grant once ', h('kbd', {}, 'A')),
        h('button', { class: 'btn', ...key('g'), onclick: () => decide(g, 'grant_run', null, { dataset: ds.value }) }, 'Grant for this run ', h('kbd', {}, 'G')),
        h('button', { class: 'btn', ...key('r'), onclick: () => decide(g, 'deny') }, 'Deny ', h('kbd', {}, 'R'))));
  }

  if (g.kind === 'promotion') {
    const why = note('Why you’re sending it back (shown to the lab)…');
    put(wrap, 
      h('div', { class: 'card pad' }, h('div', { class: 'cap' }, `${d.hypothesis} · ${d.experiment}`), h('h3', { style: { margin: '4px 0 6px' } }, d.title), h('div', {}, d.finding)),
      h('div', { class: 'row' }, h('span', { class: 'cap' }, 'Evidence'), gradeMeter(d.grade), pill(d.grade), pill('critic ' + (d.conceded ? 'conceded' : 'did not concede'), d.conceded ? '' : 'dashed'), pill('verdict: ' + d.verdict)),
      h('div', { class: 'row' }, h('span', { class: 'cap' }, 'Proposed'), statusPill(d.proposed), h('span', { class: 'mute' }, `The most this evidence can support is “${d.ceiling}”.`)),
      d.unsourced ? h('div', { class: 'card pad blocked' }, 'No executed result backs this claim, so it cannot be promoted. It can only be recorded as tentative.') : null,
      (d.caveats || []).length ? h('ul', { style: { margin: 0, paddingLeft: '18px' } }, d.caveats.map((c) => h('li', { class: 'dim' }, c))) : null,
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn primary', disabled: d.unsourced, ...key('a'), onclick: () => decide(g, 'accept') }, `Accept as ${d.proposed} `, h('kbd', {}, 'A')),
        h('button', { class: 'btn', ...key('t'), onclick: () => decide(g, 'tentative') }, 'Mark tentative ', h('kbd', {}, 'T')),
        h('button', { class: 'btn', disabled: !d.can_send_back, ...key('r'), onclick: () => decide(g, 'send_back', why.value || 'sent back for more work') }, 'Send back ', h('kbd', {}, 'R'))),
      why);
  }

  if (g.kind === 'literature' || g.kind === 'search') {
    const q = h('textarea', { rows: 3 }, d.query);
    const full = h('input', { type: 'checkbox', checked: d.fulltext !== false });
    const src = h('select', {}, h('option', { value: 'papers' }, 'Scholarly papers (OpenAlex, Semantic Scholar)'), d.web_ready ? h('option', { value: 'web' }, 'General web (SearXNG or Wikipedia)') : null);
    const web = d.kind === 'web', open = d.kind === 'open';
    put(wrap,
      g.kind === 'search' ? h('div', {}, h('b', {}, d.agent_name), ` asks to ${open ? 'open a web page' : 'search the ' + (web ? 'web' : 'literature')}. ${d.searches_left} search${d.searches_left === 1 ? '' : 'es'} left in this run.`) : null,
      h('div', { class: 'card pad blocked' }, h('div', { class: 'cap' }, open ? 'Experimental · opens a page on the internet' : 'Experimental · leaves this machine'),
        h('div', { style: { marginTop: '4px' } }, open ? 'The built-in browser (fresh profile, no logins, downloads blocked) opens only the address below. Local and LAN addresses are refused.' : ['Only the text below is sent, to: ', (d.services || []).join(' · '), '. Nothing else about your lab, data or models is shared.'])),
      g.kind === 'literature' ? h('div', { class: 'field' }, h('label', {}, 'Search in'), src) : null,
      h('div', { class: 'field' }, h('label', {}, open ? 'Page address (edit before opening)' : 'Search query (edit before sending)'), q),
      open ? null : h('label', { class: 'row', style: { gap: '8px' } }, full, h('span', {}, web ? 'Also read the top 2 result pages (in the built-in browser)' : 'Also read the free full text of the top results (open-access PDFs)')),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn primary', ...key('a'), onclick: () => decide(g, 'approve', null, { query: q.value, fulltext: full.checked, kind: src.value }) }, 'Search ', h('kbd', {}, 'A')),
        g.kind === 'search' ? h('button', { class: 'btn', ...key('g'), onclick: () => decide(g, 'grant_run', null, { query: q.value, fulltext: full.checked }) }, 'Allow searches for this run ', h('kbd', {}, 'G')) : null,
        h('button', { class: 'btn', ...key('r'), onclick: () => decide(g, g.kind === 'search' ? 'deny' : 'skip') }, g.kind === 'search' ? 'Decline ' : 'Skip, stay offline ', h('kbd', {}, 'R'))));
  }

  if (g.kind === 'recovery') {
    const m = d.model || {};
    const cur = `${m.runtime}::${m.model}`;
    const sel = h('select', {}, h('option', { value: '' }, `Keep ${m.runtime}:${m.model}`),
      modelsAvailable().filter((x) => `${x.runtime}::${x.id}` !== cur).map((x) => h('option', { value: `${x.runtime}::${x.id}` }, `${x.runtime}: ${x.id}`)));
    const tok = h('input', { type: 'number', value: m.max_tokens, min: 256, max: 32000 });
    const temp = h('input', { type: 'number', value: Number(m.temperature).toFixed(2), min: 0, max: 1.5, step: 0.05 });
    const edits = () => ({ model: sel.value || null, max_tokens: +tok.value, temperature: +temp.value });
    put(wrap,
      h('div', { class: 'card pad blocked' }, h('div', { class: 'cap' }, `${d.agent_name} · ${d.stage} · automatic fixes ran out`), h('div', { style: { marginTop: '4px' } }, d.diagnosis)),
      d.error ? h('div', { class: 'mute' }, h('b', {}, 'Error: '), d.error) : null,
      d.last_output ? h('details', {}, h('summary', { class: 'dim' }, 'Last thing the model said'), h('pre', { class: 'code' }, d.last_output)) : null,
      h('div', { class: 'cols3' },
        h('div', { class: 'field' }, h('label', {}, 'Model for this role'), sel),
        h('div', { class: 'field' }, h('label', {}, 'Max tokens'), tok),
        h('div', { class: 'field' }, h('label', {}, 'Temperature'), temp)),
      h('div', { class: 'hint' }, 'The run is paused, not lost. Retrying continues from this exact step; changes apply to this role for the rest of the run.'),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn primary', ...key('a'), onclick: () => decide(g, 'retry', null, edits()) }, 'Retry ', h('kbd', {}, 'A')),
        h('button', { class: 'btn', ...key('r'), onclick: () => decide(g, 'halt') }, 'Stop the run ', h('kbd', {}, 'R'))));
  }

  if (g.kind === 'ethics') {
    const n = note('Written reason or constraint…');
    put(wrap, 
      h('div', { class: 'card pad blocked' }, h('div', { class: 'cap' }, `${agentName(M, d.agent)} · ${d.category}`), h('div', { style: { marginTop: '4px' } }, d.text)),
      h('div', { class: 'dim' }, 'Any agent can raise a flag; only you can clear it. The run is stopped until you decide.'),
      n,
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn primary', ...key('h'), onclick: () => decide(g, 'halt') }, 'Halt the run ', h('kbd', {}, 'H')),
        h('button', { class: 'btn', ...key('a'), onclick: () => decide(g, 'constrain', n.value) }, 'Constrain & continue ', h('kbd', {}, 'A')),
        h('button', { class: 'btn', ...key('o'), onclick: () => { if (!n.value.trim()) { n.focus(); toast('Overriding a flag requires a written reason.'); return; } decide(g, 'override', n.value); } }, 'Override with reason ', h('kbd', {}, 'O'))));
  }
  return wrap;
}

export function resolvedLine(g) {
  return h('div', { class: 'row dim' }, pill(GATE_LABEL[g.kind] || g.kind), pill(g.decision, 'solid'), h('span', {}, g.by === 'auto' ? 'auto-approved by autonomy setting' : 'by you'), g.note ? h('span', { class: 'mute' }, '— ' + trunc(g.note, 80)) : null);
}
