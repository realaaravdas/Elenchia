// Small DOM + formatting helpers. No framework: the UI is a few hundred lines of
// functions that rebuild a view from the derived run model.

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && k !== 'list' && k !== 'form') { try { el[k] = v; } catch { el.setAttribute(k, v); } }
    else el.setAttribute(k, v === true ? (k.startsWith('aria-') ? 'true' : '') : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

export function toast(msg, ms = 3200) {
  const t = h('div', { class: 'toast' }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), ms);
}

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return new Date(ts).toLocaleDateString();
}
export const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour12: false });

export function trunc(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

export const STAGE_LABEL = {
  frame: 'restating the question', hypothesize: 'proposing hypotheses', challenge: 'raising objections',
  answer: 'answering objections', resolve: 'judging the answers', design: 'designing an experiment',
  plan: 'setting the analysis plan', analyze: 'grading the evidence', finalpass: 'making a final pass',
  promote: 'drafting the finding',
};
export const ARGUE = new Set(['challenge', 'answer', 'resolve', 'finalpass']);
export const GATE_LABEL = { framing: 'Question framing', experiment: 'Experiment approval', resource: 'Resource & data', promotion: 'Claim promotion', ethics: 'Ethics flag', literature: 'Literature search' };
export const GATE_ORDER = { ethics: 0, resource: 1, experiment: 2, promotion: 3, framing: 4, literature: 5 };
export const GRADE_N = { strong: 4, moderate: 3, weak: 2, inconclusive: 1 };

export function gradeMeter(g) {
  const n = GRADE_N[g] || 0;
  return h('span', { class: 'grade', title: `evidence: ${g}` }, [1, 2, 3, 4].map((i) => h('i', { class: i <= n ? 'on' : '' })));
}

export function pill(text, cls = '') { return h('span', { class: 'pill ' + cls }, text); }

export function statusPill(status) {
  const map = {
    open: ['open', ''], supported: ['supported', 'solid'], refuted: ['refuted', 'strike'],
    tentative: ['tentative', 'dashed'], withdrawn: ['withdrawn', 'dim strike'], established: ['established', 'solid'],
  };
  const [t, c] = map[status] || [status, ''];
  return pill(t, c);
}

// Line diff (LCS) for the experiment approval view.
export function lineDiff(a, b) {
  const A = (a ?? '').split('\n'), B = (b ?? '').split('\n');
  const n = A.length, m = B.length;
  if (n * m > 4_000_000) return B.map((t) => ({ t: 'add', s: t }));
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ t: 'ctx', s: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: 'del', s: A[i++] });
    else out.push({ t: 'add', s: B[j++] });
  }
  while (i < n) out.push({ t: 'del', s: A[i++] });
  while (j < m) out.push({ t: 'add', s: B[j++] });
  return out;
}

export function diffView(prev, next) {
  if (prev == null) return h('pre', { class: 'code' }, next);
  const rows = lineDiff(prev, next);
  const changed = rows.some((r) => r.t !== 'ctx');
  if (!changed) return h('div', {}, h('div', { class: 'mute', style: { marginBottom: '6px' } }, 'Identical to the previous experiment.'), h('pre', { class: 'code' }, next));
  return h('div', { class: 'diff' }, rows.map((r) => h('span', { class: 'ln ' + r.t }, (r.t === 'add' ? '+ ' : r.t === 'del' ? '- ' : '  ') + r.s)));
}

// Pull the "say" string out of a partially streamed JSON reply so bubbles show words, not braces.
export function partialSay(raw) {
  const m = /"say"\s*:\s*"((?:[^"\\]|\\.)*)("|$)/s.exec(raw);
  if (!m) return '';
  return m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\\u([0-9a-f]{4})/gi, (_, x) => String.fromCharCode(parseInt(x, 16))).replace(/\\\\/g, '\\');
}

export function download(filename, text, mime = 'text/markdown') {
  const url = URL.createObjectURL(new Blob([text], { type: mime + ';charset=utf-8' }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function icon(name) {
  const paths = {
    floor: '<circle cx="6" cy="7" r="2.4"/><circle cx="18" cy="7" r="2.4"/><circle cx="12" cy="18" r="2.4"/><path d="M8 8.2l3 7.6M16 8.2l-3 7.6M8.4 7h7.2"/>',
    designer: '<rect x="3" y="4" width="7" height="6" rx="1.5"/><rect x="14" y="14" width="7" height="6" rx="1.5"/><path d="M10 7h3a3 3 0 013 3v4"/>',
    board: '<rect x="3" y="4" width="5" height="16" rx="1.2"/><rect x="10" y="4" width="5" height="10" rx="1.2"/><rect x="17" y="4" width="4" height="13" rx="1.2"/>',
    inbox: '<path d="M3 13l3-8h12l3 8v6H3z"/><path d="M3 13h5l1 2h6l1-2h5"/>',
    notebook: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h3"/>',
    runs: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 114 2c-.9.6-1.6 1.1-1.6 2.3M12 17h.01"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/>',
    chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
    moon: '<path d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/>',
  };
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.innerHTML = paths[name] || '';
  return s;
}

// Like el.append(...) but skips null/false instead of printing "null".
export function put(el, ...kids) {
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
}

/** Separate a model's inline <think>…</think> reasoning from its answer (works on partial streams). */
export function splitThink(raw) {
  let thought = '', answer = '', rest = raw || '';
  for (;;) {
    const s = rest.indexOf('<think>');
    if (s < 0) { answer += rest; break; }
    answer += rest.slice(0, s);
    const e = rest.indexOf('</think>', s);
    if (e < 0) { thought += rest.slice(s + 7); break; }
    thought += rest.slice(s + 7, e); rest = rest.slice(e + 8);
  }
  const c = answer.lastIndexOf('</think>'); // opening tag was eaten by the chat template
  if (c >= 0) { thought += answer.slice(0, c); answer = answer.slice(c + 8); }
  return { thought: thought.trim(), answer };
}
