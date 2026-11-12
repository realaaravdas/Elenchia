// Lab designer: staff the lab. Drag roles around the canvas, wire who can see
// and challenge whom, and set models, tools, disposition and autonomy per gate.

import { h, put, clear, pill, toast, trunc } from './util.js';
import { A, S, modelsAvailable } from './state.js';

const TOOLS = ['notes', 'read-only', 'sandbox', 'data-loaders', 'stats', 'notebook', 'orchestrator'];
const KINDS = { generator: 'Hypothesis generator', critic: 'Critic', experimentalist: 'Experimentalist', statistician: 'Statistician', manager: 'Lab manager', scribe: 'Scribe', custom: 'Custom role' };
const CW = 1100, CH = 640, NW = 168, NH = 74;

export function createDesigner(opts = {}) {
  let sel = opts.select ?? null;
  let linkKind = 'challenges';
  const root = h('div', { class: 'designer' });
  const wrap = h('div', { class: 'board-wrap' });
  const side = h('div', { class: 'inspector' });
  root.append(wrap, side);

  const lab = () => S.lab;
  const posPx = (a) => ({ x: 20 + a.x * (CW - NW - 40), y: 20 + a.y * (CH - NH - 40) });

  function modelLabel(a) { return a.model.runtime === 'demo' ? 'scripted demo' : `${a.model.runtime} · ${a.model.model}`; }

  function hardware() {
    const d = S.detection, hw = d?.hardware; if (!hw) return null;
    const sizes = new Map(modelsAvailable().map((m) => [m.runtime + '::' + m.id, m.size]));
    const used = lab().agents.filter((a) => a.enabled && a.model.runtime !== 'demo').map((a) => ({ a, size: sizes.get(a.model.runtime + '::' + a.model.model) })).filter((x) => x.size);
    if (!used.length) return null;
    const biggest = used.reduce((m, x) => (x.size > m.size ? x : m));
    const gb = biggest.size / 1073741824, budget = hw.vram ? hw.vram.free_gb : hw.ram_free_gb * 0.8;
    const total = new Set(used.map((x) => x.a.model.model)).size;
    return { gb, budget, fits: gb <= budget, where: hw.vram ? 'GPU memory' : 'free RAM', name: biggest.a.model.model, distinct: total };
  }

  function drawLinks() {
    const L = lab();
    const svg = wrap.querySelector('svg'); if (!svg) return;
    svg.innerHTML = '<defs><marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>';
    for (const l of L.links) {
      const A_ = L.agents.find((a) => a.id === l.from), B_ = L.agents.find((a) => a.id === l.to); if (!A_ || !B_) continue;
      const a = posPx(A_), b = posPx(B_);
      const x1 = a.x + NW / 2, y1 = a.y + NH / 2, x2 = b.x + NW / 2, y2 = b.y + NH / 2;
      const ang = Math.atan2(y2 - y1, x2 - x1);
      const edge = (cx, cy, towards) => { const dx = Math.cos(towards), dy = Math.sin(towards); const t = Math.min(Math.abs(NW / 2 / (dx || 1e-9)), Math.abs(NH / 2 / (dy || 1e-9))); return [cx + dx * (t + 4), cy + dy * (t + 4)]; };
      const [sx, sy] = edge(x1, y1, ang), [ex, ey] = edge(x2, y2, ang + Math.PI);
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', `M${sx} ${sy} L${ex} ${ey}`); p.setAttribute('fill', 'none');
      p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', l.kind === 'challenges' ? 1.8 : 1.2);
      if (l.kind === 'informs') p.setAttribute('stroke-dasharray', '3 5');
      p.setAttribute('marker-end', 'url(#ar)'); p.style.color = 'var(--fg-dim)';
      svg.append(p);
    }
  }

  function renderBoard() {
    const L = lab(), hw = hardware();
    clear(wrap);
    const names = Object.entries(KINDS);
    const kindSel = h('select', { style: { width: 'auto' } }, names.map(([k, n]) => h('option', { value: k }, n)));
    const labsSel = h('select', { style: { width: 'auto', maxWidth: '180px' }, onchange: () => { if (labsSel.value) A.loadLab(labsSel.value); } },
      h('option', { value: '' }, 'Load template…'), S.labs.map((l) => h('option', { value: l.id }, l.name)));
    const nameIn = h('input', { type: 'text', value: L.name, style: { width: '170px' }, 'aria-label': 'Lab name', oninput: () => { L.name = nameIn.value; } });
    wrap.append(h('div', { class: 'palette' },
      nameIn,
      kindSel, h('button', { class: 'btn sm', onclick: () => { A.addAgent(kindSel.value); } }, 'Add role'),
      h('span', { class: 'mute' }, '|'),
      h('div', { class: 'seg', role: 'group', 'aria-label': 'New link type' },
        h('button', { 'aria-pressed': linkKind === 'challenges', onclick: () => { linkKind = 'challenges'; renderBoard(); } }, 'challenges'),
        h('button', { 'aria-pressed': linkKind === 'informs', onclick: () => { linkKind = 'informs'; renderBoard(); } }, 'informs')),
      h('span', { class: 'mute', style: { fontSize: '11.5px' } }, 'drag ● to wire'),
      h('span', { style: { flex: 1 } }),
      labsSel,
      h('button', { class: 'btn sm', onclick: () => A.resetLab() }, 'Reset'),
      h('button', { class: 'btn sm primary', onclick: async () => { await A.saveLab(); toast('Lab saved as a template.'); renderBoard(); } }, 'Save')));
    const cv = h('div', { class: 'dcanvas', style: { width: CW + 'px', height: CH + 'px' } });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', `0 0 ${CW} ${CH}`); cv.append(svg);
    wrap.append(cv);
    for (const a of L.agents) {
      const p = posPx(a);
      const n = h('div', { class: 'dnode' + (sel === a.id ? ' sel' : '') + (a.enabled ? '' : ' off'), style: { left: p.x + 'px', top: p.y + 'px' }, 'data-id': a.id },
        h('div', { class: 'k' }, a.kind), h('div', { class: 'n' }, a.name), h('div', { class: 'm' }, modelLabel(a)),
        hw && !hw.fits && a.enabled && a.model.runtime !== 'demo' && a.model.model === hw.name ? h('div', { style: { marginTop: '4px' } }, pill('may not fit', 'solid')) : null,
        h('div', { class: 'port', title: 'Drag to another role to link', 'data-port': a.id }));
      cv.append(n);
      dragNode(n, a, cv);
    }
    cv.append(h('div', { class: 'dnode locked', style: { left: (CW - NW - 24) + 'px', top: (CH - NH - 20) + 'px' } }, h('div', { class: 'k' }, 'librarian'), h('div', { class: 'n' }, 'Librarian'), h('div', { class: 'm' }, 'coming in v0.2')));
    drawLinks();
  }

  function dragNode(n, a, cv) {
    n.addEventListener('pointerdown', (e) => {
      if (e.target.dataset.port) return startLink(e, a, cv);
      n.setPointerCapture(e.pointerId);
      const sx = e.clientX, sy = e.clientY, ox = posPx(a);
      let moved = false;
      const mv = (ev) => {
        if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
        moved = true;
        const nx = Math.max(20, Math.min(CW - NW - 20, ox.x + ev.clientX - sx)), ny = Math.max(20, Math.min(CH - NH - 20, ox.y + ev.clientY - sy));
        a.x = (nx - 20) / (CW - NW - 40); a.y = (ny - 20) / (CH - NH - 40);
        n.style.left = nx + 'px'; n.style.top = ny + 'px'; drawLinks();
      };
      const up = () => { n.removeEventListener('pointermove', mv); n.removeEventListener('pointerup', up); if (!moved) { sel = a.id; renderBoard(); renderSide(); } };
      n.addEventListener('pointermove', mv); n.addEventListener('pointerup', up);
    });
  }

  function startLink(e, a, cv) {
    e.preventDefault(); e.stopPropagation();
    const svg = cv.querySelector('svg'), rect = cv.getBoundingClientRect();
    const tmp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    tmp.setAttribute('stroke', 'currentColor'); tmp.setAttribute('stroke-dasharray', '4 4'); tmp.setAttribute('fill', 'none'); tmp.style.color = 'var(--fg)';
    svg.append(tmp);
    const p = posPx(a), x1 = p.x + NW, y1 = p.y + NH / 2;
    const mv = (ev) => tmp.setAttribute('d', `M${x1} ${y1} L${ev.clientX - rect.left} ${ev.clientY - rect.top}`);
    const up = (ev) => {
      document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up); tmp.remove();
      const t = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.dnode[data-id]');
      if (t && t.dataset.id !== a.id) A.addLink(a.id, t.dataset.id, linkKind);
    };
    document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up);
  }

  function renderSide() {
    const L = lab(); clear(side);
    const a = L.agents.find((x) => x.id === sel);
    if (!a) return renderLabSide();
    const avail = modelsAvailable();
    const val = `${a.model.runtime}::${a.model.model}`;
    const msel = h('select', { onchange: () => { const [rt, ...m] = msel.value.split('::'); a.model.runtime = rt; a.model.model = m.join('::'); A.touchLab(); renderBoard(); } },
      h('option', { value: 'demo::scripted-lab' }, 'Scripted demo (no model)'),
      ['lmstudio', 'ollama', 'openai'].map((rt) => { const ms = avail.filter((m) => m.runtime === rt); return ms.length ? h('optgroup', { label: { lmstudio: 'LM Studio (local)', ollama: 'Ollama (local)', openai: 'OpenAI-compatible API (cloud)' }[rt] }, ms.map((m) => h('option', { value: `${rt}::${m.id}` }, m.id + (m.size ? ` (${(m.size / 1073741824).toFixed(1)} GB)` : '')))) : null; }),
      avail.some((m) => m.runtime + '::' + m.id === val) || val === 'demo::scripted-lab' ? null : h('option', { value: val }, `${a.model.model} (not installed)`));
    msel.value = val;
    const core = ['generator', 'critic', 'experimentalist', 'statistician'].includes(a.kind);
    const bind = (el, fn) => { el.addEventListener('input', () => { fn(el); A.touchLab(); }); return el; };
    const temp = bind(h('input', { type: 'range', min: 0, max: 1.2, step: 0.05, value: a.model.temperature }), (el) => { a.model.temperature = +el.value; tv.textContent = el.value; });
    const tv = h('span', { class: 'mono' }, a.model.temperature);
    const disp = bind(h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: a.disposition }), (el) => { a.disposition = +el.value; dv.textContent = dl(+el.value); });
    const dl = (v) => (v < 0.34 ? 'conservative' : v > 0.66 ? 'aggressive' : 'balanced');
    const dv = h('span', { class: 'mono' }, dl(a.disposition));
    put(side, 
      h('div', { class: 'row', style: { marginBottom: '14px' } }, h('div', { style: { flex: 1 } }, h('div', { class: 'cap' }, a.kind), h('h2', {}, a.name)), h('button', { class: 'btn sm ghost', onclick: () => { sel = null; renderBoard(); renderSide(); } }, 'Lab settings')),
      h('div', { class: 'field' }, h('label', {}, 'Name'), bind(h('input', { type: 'text', value: a.name }), (el) => { a.name = el.value; })),
      h('div', { class: 'field' }, h('label', {}, 'Brief (system prompt)'), bind(h('textarea', { rows: 7 }, a.brief), (el) => { a.brief = el.value; })),
      h('div', { class: 'field' }, h('label', {}, 'Model'), msel, h('div', { class: 'hint' }, avail.length ? 'Pinned to this role. Mix families (e.g. critic on a different model than the generator) to reduce shared blind spots.' : 'No local models detected. Start Ollama or LM Studio, then rescan in Settings.')),
      h('div', { class: 'cols2' },
        h('div', { class: 'field' }, h('label', {}, 'Temperature ', tv), temp),
        h('div', { class: 'field' }, h('label', {}, 'Disposition ', dv), disp)),
      h('div', { class: 'field' }, h('label', {}, 'How it should disagree'), bind(h('input', { type: 'text', value: a.disagree || '' }), (el) => { a.disagree = el.value; })),
      h('div', { class: 'field' }, h('label', {}, 'Tool allowlist'), h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '6px 14px' } }, TOOLS.map((t) => h('label', { class: 'row', style: { gap: '6px', textTransform: 'none', letterSpacing: 0, fontWeight: 400, fontSize: '12.5px', color: 'var(--fg)' } }, h('input', { type: 'checkbox', checked: (a.tools || []).includes(t), onchange: (e) => { a.tools = e.target.checked ? [...new Set([...(a.tools || []), t])] : (a.tools || []).filter((x) => x !== t); A.touchLab(); } }), t)))),
      h('div', { class: 'field' }, h('label', {}, 'Memory scope'), (() => { const s = h('select', { onchange: () => { a.memory_scope = s.value; A.touchLab(); } }, ['run', 'lab'].map((v) => h('option', { value: v }, v === 'run' ? 'This run only' : 'Across runs (v0.2)'))); s.value = a.memory_scope || 'run'; return s; })()),
      core ? h('div', { class: 'card pad dim' }, 'Core role. It can be retuned but not removed; the protocol needs it. Adversarial separation is enforced by the orchestrator: the critic cannot edit hypotheses and the experimentalist cannot grade its own results.') :
        a.kind === 'custom' ? h('div', { class: 'card pad dim' }, 'Custom roles are saved with the lab and appear on the floor. In v0.1 the orchestrator schedules the six built-in roles only.') : null,
      h('div', { class: 'hr' }),
      h('div', { class: 'row' }, h('label', { class: 'row', style: { gap: '8px' } }, h('input', { type: 'checkbox', checked: a.enabled, disabled: core, onchange: (e) => { a.enabled = e.target.checked; A.touchLab(); renderBoard(); } }), 'Enabled'),
        h('span', { style: { flex: 1 } }),
        core ? null : h('button', { class: 'btn sm', onclick: () => { A.removeAgent(a.id); sel = null; } }, 'Remove role')),
      h('div', { class: 'cap', style: { margin: '18px 0 8px' } }, 'Links from and to this role'),
      h('div', { class: 'stack' }, lab().links.filter((l) => l.from === a.id || l.to === a.id).map((l) => h('div', { class: 'row' }, h('span', { style: { flex: 1 } }, `${nm(l.from)} ${l.kind === 'challenges' ? '⊣ challenges' : '→ informs'} ${nm(l.to)}`), h('button', { class: 'btn sm ghost', onclick: () => A.removeLink(l) }, 'Remove')))));
  }
  const nm = (id) => lab().agents.find((a) => a.id === id)?.name ?? id;

  function renderLabSide() {
    const L = lab(), hw = hardware(), g = L.gates;
    const dial = (key, opts_, hint) => {
      const seg = h('div', { class: 'seg' }, opts_.map(([v, label]) => h('button', { 'aria-pressed': g[key] === v, onclick: () => { g[key] = v; A.touchLab(); renderSide(); } }, label)));
      return h('div', { class: 'field' }, h('label', {}, GL[key]), seg, h('div', { class: 'hint' }, hint));
    };
    const GL = { framing: 'Question framing', experiment: 'Experiment approval', resource: 'Resource & data', promotion: 'Claim promotion' };
    put(side, 
      h('div', { class: 'cap' }, 'Lab'), h('h2', { style: { marginBottom: '4px' } }, L.name),
      h('p', { class: 'dim', style: { marginTop: 0 } }, 'Click a role to retune it. Drag ● from one role to another to wire who can challenge whom.'),
      h('div', { class: 'cap', style: { margin: '18px 0 8px' } }, 'Autonomy per gate'),
      dial('framing', [['manual', 'Manual'], ['auto', 'Auto-confirm']], 'Auto-confirm accepts the manager’s restatement.'),
      dial('experiment', [['manual', 'Manual'], ['auto_low_risk', 'Auto if low risk']], 'Auto-approves only sandboxed work needing no data, under 60 s, with no blocked calls. Still logged.'),
      dial('promotion', [['manual', 'Manual'], ['auto_tentative', 'Auto (tentative only)']], 'The lab can never auto-establish a claim.'),
      h('div', { class: 'field' }, h('label', {}, 'Resource & data'), h('div', { class: 'seg' }, h('button', { 'aria-pressed': true }, 'Always manual')), h('div', { class: 'hint' }, 'Anything touching files, personal data or heavy compute stays with you. Ethics flags cannot be automated.')),
      h('div', { class: 'hr' }),
      h('div', { class: 'cap', style: { marginBottom: '8px' } }, 'Models'),
      h('div', { class: 'row' }, h('button', { class: 'btn sm', disabled: !modelsAvailable().length, onclick: () => { A.autoAssign(); } }, 'Auto-assign local models'), h('button', { class: 'btn sm ghost', onclick: () => A.rescan() }, 'Rescan')),
      h('div', { class: 'hint mute', style: { marginTop: '6px' } }, modelsAvailable().length ? 'Spreads model families across roles, with the critic on a different family than the generator when possible.' : 'No Ollama or LM Studio models detected.'),
      hw ? h('div', { class: 'card pad', style: { marginTop: '12px' } }, h('b', {}, hw.fits ? 'Hardware check: fits' : 'Hardware check: may not fit'), h('div', { class: 'dim' }, `Largest model ${hw.name} ≈ ${hw.gb.toFixed(1)} GB vs ${hw.budget.toFixed(1)} GB of ${hw.where} available. Turns run one model at a time by default.`)) : null);
  }

  function update() { renderBoard(); renderSide(); }
  update();
  return { el: root, update, destroy() {} };
}
