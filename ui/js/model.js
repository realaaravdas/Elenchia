// Everything on screen is a reduction over the run's event log. That is what
// makes the floor honest ("a view of real state") and replay trivial: scrub to
// event N and derive the model from events[0..N].

import { ARGUE, STAGE_LABEL, GATE_LABEL } from './util.js';

const GATE_AGENT = { framing: 'manager', experiment: 'experimentalist', resource: 'experimentalist', promotion: 'scribe' };

export function derive(events, upTo = events.length) {
  const M = {
    runId: events[0]?.run_id ?? null, started: null, lab: null, phase: null, round: 0, framed: null,
    msgs: [], hyps: new Map(), objs: new Map(), exps: new Map(), gates: new Map(), flags: [], findings: [],
    evidence: [], notes: [], decisions: [], pending: new Map(), ended: null, turns: 0, lastSeq: 0, firstTs: events[0]?.ts, lastTs: events[0]?.ts,
    agents: {}, sources: [], literature: null, searches: [], browsed: [],
  };
  for (let i = 0; i < Math.min(upTo, events.length); i++) {
    const { kind, data: d, seq, ts } = events[i];
    M.lastSeq = seq; M.lastTs = ts;
    switch (kind) {
      case 'run_started': M.started = d; M.lab = d.lab; break;
      case 'phase': M.phase = d.phase; if (d.round) M.round = d.round; break;
      case 'framed': M.framed = d; break;
      case 'sources': M.sources = d.sources; break;
      case 'literature': M.literature = d; M.searches.push(d); break;
      case 'browse': M.browsed.push({ ...d, ts }); break;
      case 'turn_start': M.pending.set(d.id, d); M.turns = d.turn; break;
      case 'turn_failed': M.pending.delete(d.id); M.notes.push({ ts, text: `A turn failed: ${d.reason}` }); break;
      case 'message': M.pending.delete(d.id); M.msgs.push({ ...d, ts, seq }); break;
      case 'hypothesis': M.hyps.set(d.id, { ...d, objs: [], exps: [], evidence: null, ts }); break;
      case 'hypothesis_status': { const x = M.hyps.get(d.id); if (x) x.status = d.status; break; }
      case 'objection': {
        M.objs.set(d.id, { ...d, answer: null, resolved: null, reason: null, ts });
        M.hyps.get(d.hypothesis)?.objs.push(d.id); break;
      }
      case 'objection_answer': { const o = M.objs.get(d.id); if (o) o.answer = d; break; }
      case 'objection_status': { const o = M.objs.get(d.id); if (o) { o.resolved = d.resolved; o.reason = d.reason; } break; }
      case 'experiment': {
        const prev = M.exps.get(d.id);
        const x = { ...(prev || { state: 'proposed', result: null, evidence: null, ts }), ...d };
        if (prev) x.state = prev.state === 'proposed' || d.state === 'edited' ? 'proposed' : prev.state;
        M.exps.set(d.id, x);
        const hy = M.hyps.get(d.hypothesis); if (hy && !hy.exps.includes(d.id)) hy.exps.push(d.id);
        break;
      }
      case 'experiment_state': { const x = M.exps.get(d.id); if (x) { x.state = d.state; x.stateNote = d.note; } break; }
      case 'experiment_result': { const x = M.exps.get(d.id); if (x) x.result = d; break; }
      case 'evidence': {
        M.evidence.push({ ...d, ts });
        const x = M.exps.get(d.experiment); if (x) x.evidence = d;
        const hy = M.hyps.get(d.hypothesis); if (hy) hy.evidence = d; break;
      }
      case 'gate_open': M.gates.set(d.id, { ...d, open: !d.auto, seq, ts }); break;
      case 'gate_resolved': {
        const g = M.gates.get(d.id);
        if (g) { g.open = false; g.decision = d.decision; g.by = d.by; g.note = d.note; g.resolvedTs = ts; }
        M.decisions.push({ ...d, ts, title: g?.title, seq }); break;
      }
      case 'flag': M.flags.push({ ...d, ts }); break;
      case 'finding': M.findings.push({ ...d, ts }); break;
      case 'refusal': case 'note': M.notes.push({ ts, text: d.text }); break;
      case 'run_ended': M.ended = { ...d, ts }; break;
    }
  }
  // agent status
  for (const a of M.lab?.agents ?? []) M.agents[a.id] = { status: 'idle', activity: M.ended ? 'run ended' : 'idle' };
  if (!M.ended) {
    for (const t of M.pending.values()) {
      const a = M.agents[t.from]; if (!a) continue;
      a.status = ARGUE.has(t.stage) ? 'arguing' : 'thinking';
      a.activity = STAGE_LABEL[t.stage] || 'working';
      a.to = t.to;
    }
    for (const g of M.gates.values()) {
      if (!g.open) continue;
      const aid = g.kind === 'ethics' ? g.detail?.agent : M.lab?.agents.find((a) => a.kind === GATE_AGENT[g.kind])?.id;
      const a = M.agents[aid]; if (a) { a.status = 'blocked'; a.activity = 'waiting on you: ' + (GATE_LABEL[g.kind] || g.kind).toLowerCase(); }
    }
  }
  M.openGates = [...M.gates.values()].filter((g) => g.open);
  return M;
}

export function agentName(M, id) {
  if (id === 'human') return 'You';
  return M.lab?.agents.find((a) => a.id === id)?.name ?? id;
}

export function toMarkdown(M, runMeta) {
  const L = [];
  const q = M.framed?.question ?? M.started?.question ?? runMeta?.question ?? '';
  L.push(`# Lab notebook`, '', `**Question.** ${q}`, '');
  if (M.started?.question && M.started.question !== q) L.push(`*Originally asked:* ${M.started.question}`, '');
  const t0 = M.firstTs ? new Date(M.firstTs).toISOString() : '';
  L.push(`*Lab:* ${M.lab?.name ?? ''} · *Started:* ${t0} · *Agent turns:* ${M.turns} · *Outcome:* ${M.ended ? M.ended.status + ' — ' + M.ended.reason : 'in progress'}`, '');
  if (M.started?.preview) L.push('> Recorded from the scripted demo lab (preview).', '');
  L.push('## Team', '');
  for (const a of M.lab?.agents ?? []) if (a.enabled) L.push(`- **${a.name}** (${a.kind}) — \`${a.model.runtime}:${a.model.model}\`, temperature ${a.model.temperature}`);
  if (M.msgs.some((m) => m.scripted)) L.push('', '> Some or all agents were the scripted demo, not language models.');
  L.push('', '## Findings', '');
  if (!M.findings.length) L.push('_No finding was promoted._', '');
  for (const f of M.findings) {
    L.push(`### ${f.title} — ${f.status.toUpperCase()}`, '', f.text, '', `- Hypothesis: ${f.hypothesis} · Experiment: ${f.experiment} · Evidence grade: **${f.grade}**`);
    if (f.downgraded) L.push('- Status was capped by the lab rules (evidence grade, critic concession or missing executed result).');
    L.push(`- Decision: ${f.decided}${f.note ? ` ("${f.note}")` : ''}`);
    for (const c of f.caveats || []) L.push(`- Caveat: ${c}`);
    L.push('');
  }
  L.push('## Hypotheses', '');
  for (const hy of M.hyps.values()) {
    L.push(`### ${hy.id} — ${hy.status}`, '', hy.claim, '', `- Prediction: ${hy.prediction}`, `- Assumptions: ${(hy.assumptions || []).join('; ') || '—'}`);
    for (const oid of hy.objs) {
      const o = M.objs.get(oid);
      const state = o.resolved === true ? 'resolved' : o.resolved === false ? 'unresolved' : 'open';
      L.push(`- Objection ${o.id} (${o.severity}, ${state}): ${o.text}`);
      if (o.answer) L.push(`  - ${o.answer.withdraw ? 'Withdrawn' : 'Answer'}: ${o.answer.response}`);
    }
    for (const eid of hy.exps) {
      const e = M.exps.get(eid);
      L.push(`- Experiment ${e.id} “${e.title}” — ${e.state}${e.evidence ? `; evidence **${e.evidence.grade}**, verdict ${e.evidence.verdict}` : ''}`);
      if (e.evidence) L.push(`  - ${e.evidence.summary}`);
    }
    L.push('');
  }
  L.push('## Experiments', '');
  for (const e of M.exps.values()) {
    L.push(`### ${e.id} — ${e.title}`, '', e.protocol ?? '', '', '```python', e.code ?? '', '```', '');
    if (e.result) L.push(`Executed by: ${e.result.executor} · seed ${e.result.seed} · ${e.result.duration_ms} ms · exit ${e.result.exit}`, '', '```json', JSON.stringify(e.result.result, null, 2), '```', '');
  }
  L.push('## Decisions', '', '| Time | Gate | Decision | By | Note |', '|---|---|---|---|---|');
  for (const d of M.decisions) L.push(`| ${new Date(d.ts).toISOString()} | ${GATE_LABEL[d.kind] || d.kind} | ${d.decision} | ${d.by} | ${(d.note || '').replace(/\|/g, '/')} |`);
  L.push('', '## Debate transcript', '');
  for (const m of M.msgs) L.push(`**${agentName(M, m.from)} → ${agentName(M, m.to)}** *(${m.stage}, round ${m.round})*: ${m.say}`, '');
  return L.join('\n');
}
