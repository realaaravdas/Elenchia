// Shared application state. One mutable singleton: simple, and the views are
// rebuilt from it plus the derived run model.
import { derive } from './model.js';

export const S = {
  view: 'floor',
  detection: null,
  settings: null,
  lab: null, // the working lab (editable in the designer)
  labs: [],
  runs: [],
  runId: null,
  events: [],
  M: null,
  replay: null, // null = live; otherwise number of events shown
  playing: false,
  live: new Map(), // msgId -> raw streamed text
  feedTab: 'debate',
  calm: false,
  theme: 'dark',
  preview: false,
  focus: null, // {type:'hyp'|'exp', id} highlighted from the diagram
};

// Filled by main.js so views can call controller actions without import cycles.
export const A = {};

export function recompute() {
  const n = S.replay == null ? S.events.length : S.replay;
  const M = derive(S.events, n);
  if (!M.lab) {
    M.lab = S.lab;
    for (const a of S.lab?.agents ?? []) M.agents[a.id] = { status: 'idle', activity: 'idle' };
  }
  S.M = M;
  return M;
}

export const isLive = () => S.replay == null;
export const runMeta = () => S.runs.find((r) => r.id === S.runId);
export const running = () => !!S.runId && !!S.M?.started && !S.M.ended && isLive();

export function modelsAvailable() {
  const d = S.detection, out = [];
  for (const rt of ['lmstudio', 'ollama', 'openai']) for (const m of d?.[rt]?.models ?? []) out.push({ runtime: rt, id: m.id, size: m.size, family: m.family });
  return out;
}
