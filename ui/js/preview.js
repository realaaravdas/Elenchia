// Preview backend (browser only). Replays an event log recorded from the real
// Rust orchestrator running the scripted demo lab. Gates really block; the
// path after a gate is always the recorded one. Not used inside the desktop app.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = () => 'preview-' + Math.random().toString(36).slice(2, 10);

export async function createPreview(fire) {
  const sample = await (await fetch('mock/sample-run.json')).json();
  const baseLab = sample.find((e) => e.kind === 'run_started').data.lab;
  const runs = new Map(); // id -> {meta, events}
  const waits = new Map(); // gate id -> resolve fn
  const halted = new Set();
  let labs = [];

  function emit(run, kind, data, persisted = true) {
    if (!persisted) return fire({ persisted: false, run_id: run.meta.id, kind, data });
    const ev = { seq: run.events.length + 1, run_id: run.meta.id, ts: Date.now(), kind, data, hash: 'preview' };
    run.events.push(ev);
    fire({ persisted: true, event: ev });
  }

  async function play(run, params) {
    const id = run.meta.id;
    try {
      for (let i = 0; i < sample.length; i++) {
        if (halted.has(id)) throw new Error('halted');
        const e = sample[i];
        const d = JSON.parse(JSON.stringify(e.data));
        if (e.kind === 'run_started') { d.question = params.question; d.constraints = params.constraints || []; d.offlimits = params.offlimits || []; d.max_turns = params.max_turns; d.lab = params.lab; d.preview = true; }
        if (e.kind === 'run_ended') { emit(run, 'run_ended', d); run.meta.status = d.status; return; }
        if (e.kind === 'turn_start') {
          emit(run, 'turn_start', d);
          const m = sample.slice(i).find((x) => x.kind === 'message' && x.data.id === d.id);
          const text = JSON.stringify(m.data.data);
          for (let c = 0; c < text.length; c += 18) {
            if (halted.has(id)) throw new Error('halted');
            emit(run, 'message_delta', { id: d.id, from: d.from, text: text.slice(c, c + 18) }, false);
            await sleep(14);
          }
          continue;
        }
        if (e.kind === 'phase' || e.kind === 'objection' || e.kind === 'hypothesis' || e.kind === 'experiment') await sleep(260);
        if (e.kind === 'gate_open' && !d.auto) {
          emit(run, 'gate_open', d);
          const dec = await new Promise((res) => waits.set(d.id, res));
          if (halted.has(id)) throw new Error('halted');
          if (['reject', 'halt', 'deny', 'send_back'].includes(dec.decision)) {
            emit(run, 'gate_resolved', { id: d.id, kind: d.kind, decision: dec.decision, note: dec.note, by: 'human' });
            emit(run, 'run_ended', { status: 'halted', reason: 'You declined at a gate. Preview replays one recorded path; the desktop app branches for real.', turns: 0 });
            run.meta.status = 'halted'; return;
          }
          // skip the recorded gate_resolved; substitute the human's decision
          const j = sample.findIndex((x, k) => k > i && x.kind === 'gate_resolved' && x.data.id === d.id);
          emit(run, 'gate_resolved', { id: d.id, kind: d.kind, decision: dec.decision, note: dec.note ?? null, by: 'human' });
          sample[j]._skip = true;
          continue;
        }
        if (e.kind === 'gate_resolved' && e._skip) { delete e._skip; continue; }
        emit(run, e.kind, d);
        if (e.kind === 'experiment_state' && d.state === 'running') await sleep(1200);
      }
    } catch (err) {
      if (!String(err.message).includes('halted')) console.error(err);
      emit(run, 'run_ended', { status: 'halted', reason: 'halted by you', turns: 0 });
      run.meta.status = 'halted';
    } finally {
      // never leave a recorded _skip marker behind
      sample.forEach((x) => delete x._skip);
    }
  }

  const api = {
    detect: () => ({
      ollama: { up: false, url: 'http://127.0.0.1:11434', models: [] },
      lmstudio: { up: false, url: 'http://127.0.0.1:1234', models: [] },
      hardware: { ram_total_gb: 32, ram_free_gb: 18.4, vram: null },
      python: { found: false },
      preview: true,
    }),
    default_lab: () => JSON.parse(JSON.stringify(baseLab)),
    list_labs: () => labs,
    save_lab: ({ lab }) => { labs = [lab, ...labs.filter((l) => l.id !== lab.id)]; },
    delete_lab: ({ id }) => { labs = labs.filter((l) => l.id !== id); },
    start_run: ({ lab, params }) => {
      const id = uid();
      const run = { meta: { id, lab: lab.name, question: params.question, status: 'running', created: Date.now() }, events: [] };
      runs.set(id, run);
      play(run, { ...params, lab });
      return id;
    },
    resolve_gate: ({ gateId, decision }) => {
      const r = waits.get(gateId);
      if (!r) throw 'that gate is no longer waiting';
      if (decision.decision === 'override' && !(decision.note || '').trim()) throw 'overriding an ethics flag requires a written reason';
      waits.delete(gateId); r(decision);
    },
    halt_run: ({ runId }) => { halted.add(runId); [...waits.values()].forEach((r) => r({ decision: 'reject' })); waits.clear(); },
    list_runs: () => [...runs.values()].map((r) => r.meta).reverse(),
    run_events: ({ runId }) => runs.get(runId)?.events ?? [],
    verify_audit: ({ runId }) => ({ events: runs.get(runId)?.events.length ?? 0, broken_at: null }),
    get_settings: () => ({ ollama_url: 'http://127.0.0.1:11434', lmstudio_url: 'http://127.0.0.1:1234', data_dir: '(browser preview)' }),
    set_settings: () => {},
  };
  return {
    async call(cmd, args) {
      const f = api[cmd];
      if (!f) throw new Error('unknown command ' + cmd);
      return f(args);
    },
  };
}
