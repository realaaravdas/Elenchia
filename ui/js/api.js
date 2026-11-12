// Bridge to the Rust backend. In the desktop app this is Tauri's invoke/listen.
// Opened in a plain browser (no Tauri), it falls back to a *preview* backend that
// replays a run recorded from the real Rust orchestrator, so the UI can be
// explored and tested without the desktop shell. Preview mode is always labelled.

const T = window.__TAURI__;
export const isDesktop = !!(T && T.core);
const listeners = new Set();

export const onEvent = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const fire = (payload) => listeners.forEach((fn) => fn(payload));

let mock = null;
async function getMock() {
  if (!mock) mock = await (await import('./preview.js')).createPreview(fire);
  return mock;
}

if (isDesktop) T.event.listen('lab-event', (e) => fire(e.payload));

export async function call(cmd, args = {}) {
  if (isDesktop) return T.core.invoke(cmd, args);
  return (await getMock()).call(cmd, args);
}
