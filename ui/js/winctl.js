// Custom window chrome. The native title bar is off (decorations: false), so the
// app's own top bar doubles as the title bar: empty areas drag the window,
// double-click maximizes, and the three controls match the rest of the UI.
// In a plain browser (preview) there is no window to control, so nothing renders.

import { h } from './util.js';

const T = window.__TAURI__;
const win = T?.window?.getCurrentWindow?.() ?? null;
export const hasWindowControls = !!win;

const svg = (d) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 12 12');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', d);
  s.append(p);
  return s;
};
const G = {
  min: 'M2 6h8',
  max: 'M2.5 2.5h7v7h-7z',
  restore: 'M4 2.5h5.5V8M2.5 4h5.5v5.5H2.5z',
  close: 'M2.5 2.5l7 7M9.5 2.5l-7 7',
};

let maxBtn = null;
async function syncMax() {
  if (!maxBtn || !win) return;
  let m = false;
  try { m = await win.isMaximized(); } catch { /* ignore */ }
  maxBtn.replaceChildren(svg(m ? G.restore : G.max));
  maxBtn.title = m ? 'Restore' : 'Maximize';
  maxBtn.setAttribute('aria-label', maxBtn.title);
}

export function windowControls() {
  if (!win) return null;
  const btn = (cls, title, glyph, fn) =>
    h('button', { class: 'wc ' + cls, title, 'aria-label': title, tabindex: -1, onclick: fn }, svg(glyph));
  maxBtn = btn('wc-max', 'Maximize', G.max, () => win.toggleMaximize().then(syncMax));
  syncMax();
  return h('div', { class: 'wctl' },
    btn('wc-min', 'Minimize', G.min, () => win.minimize()),
    maxBtn,
    btn('wc-close', 'Close', G.close, () => win.close()));
}

/** Make the top bar and the empty part of the rail behave like a title bar. */
export function installDrag() {
  if (!win) return;
  document.documentElement.classList.add('frameless');
  const interactive = 'button, a, input, select, textarea, kbd, [role="button"], .pill[onclick], .wctl';
  const bind = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.closest(interactive)) return;
      if (e.detail === 2) { win.toggleMaximize().then(syncMax); return; }
      win.startDragging();
    });
  };
  bind('#topbar');
  bind('#rail');
  window.addEventListener('resize', syncMax);
}
