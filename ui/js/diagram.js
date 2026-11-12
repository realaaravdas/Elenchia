// The living diagram. A deliberately metaphorical, honest picture of real state:
//   agent        = node (outline idle, solid thinking/arguing, pulsing border blocked-on-you)
//   hypothesis   = seed carried from the generator to the commons between generator and critic
//   objection    = pulse that strikes a seed and cracks it until the objection is resolved
//   experiment   = vessel that waits at the sandbox gate until you approve it
//   result       = signal flowing back to the statistician, brightness = evidence grade
//   conversation = packets along the link and a speech bubble that streams the model's words
// Everything drawn maps to an event in the log; clicking jumps to the matching card.

import { ARGUE, GRADE_N, STAGE_LABEL, partialSay, splitThink, trunc } from './util.js';

const R = 24;
const ease = (t) => (t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t));
const GRADE_ALPHA = { strong: 1, moderate: 0.75, weak: 0.45, inconclusive: 0.2 };

export class Floor {
  constructor(canvas, hooks) {
    this.cv = canvas; this.ctx = canvas.getContext('2d'); this.hooks = hooks;
    this.M = null; this.live = true; this.calm = false; this.overrides = {};
    this.bubbles = new Map(); this.fx = []; this.vessels = new Map(); this.seedT = new Map();
    this.hit = []; this.drag = null; this.hover = null; this.raf = 0; this.running = true; this.lastGrade = null;
    this.W = 0; this.H = 0;
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(canvas.parentElement);
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointerleave', () => { this.hover = null; });
    this.colors(); this.resize(); this.loop = this.loop.bind(this); this.raf = requestAnimationFrame(this.loop);
    this.vis = () => { if (document.hidden) cancelAnimationFrame(this.raf); else { cancelAnimationFrame(this.raf); this.raf = requestAnimationFrame(this.loop); } };
    document.addEventListener('visibilitychange', this.vis);
  }

  destroy() { this.running = false; cancelAnimationFrame(this.raf); this.ro.disconnect(); document.removeEventListener('visibilitychange', this.vis); }

  colors() {
    const s = getComputedStyle(document.documentElement);
    const g = (n) => s.getPropertyValue(n).trim();
    this.c = { fg: g('--fg'), bg: g('--bg'), solid: g('--bg-solid'), dim: g('--fg-dim'), mute: g('--fg-mute'), line: g('--line'), strong: g('--line-strong'), sans: g('--sans'), mono: g('--mono') };
  }

  resize() {
    const p = this.cv.parentElement, dpr = window.devicePixelRatio || 1;
    this.W = p.clientWidth; this.H = p.clientHeight;
    this.cv.width = this.W * dpr; this.cv.height = this.H * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.dirty = true;
  }

  setModel(M, { live = true, calm = false, reset = false } = {}) {
    this.M = M; this.live = live; this.calm = calm; this.colors();
    if (reset || !live) { this.fx = []; this.bubbles.clear(); this.seedT.clear(); this.vessels.clear(); }
    if (!live) { // replay: pin the last thing each agent said
      for (const m of M.msgs) this.bubbles.set(m.from, { msgId: m.id, text: m.say, streaming: false, t: performance.now(), pinned: true });
    }
    this.dirty = true;
  }

  // ----- geometry -----
  agents() { return (this.M?.lab?.agents ?? []).filter((a) => a.enabled); }
  pos(id) {
    const a = (this.M?.lab?.agents ?? []).find((x) => x.id === id);
    if (!a) return { x: this.W / 2, y: this.H / 2 };
    const o = this.overrides[id], m = 74, nx = o ? o.x : a.x, ny = o ? o.y : a.y;
    return { x: m + nx * (this.W - 2 * m), y: 64 + ny * (this.H - 64 - 96) };
  }
  kindPos(kind) { const a = this.agents().find((x) => x.kind === kind); return a ? this.pos(a.id) : { x: this.W / 2, y: this.H / 2 }; }
  sandbox() { return { x: this.W - 96, y: 84 }; }
  gatePt() { const e = this.kindPos('experimentalist'), s = this.sandbox(); return { x: e.x + (s.x - e.x) * 0.55, y: e.y + (s.y - e.y) * 0.55 }; }
  commons() {
    const g = this.kindPos('generator'), c = this.kindPos('critic');
    return { x: (g.x + c.x) / 2, y: (g.y + c.y) / 2 };
  }
  seedPos(id) {
    const ids = [...(this.M?.hyps.keys() ?? [])].slice(-8), i = ids.indexOf(id), n = ids.length;
    const cm = this.commons();
    return { x: cm.x, y: cm.y + (i - (n - 1) / 2) * 38 };
  }

  // ----- event hooks (animation only; state comes from setModel) -----
  push(ev) {
    if (!this.live || this.calm) return;
    const now = performance.now(), d = ev.data ?? {}, k = ev.kind;
    if (k === 'turn_start') {
      this.bubbles.set(d.from, { msgId: d.id, text: '', thought: '', streaming: true, t: now, t0: now, last: null, stage: d.stage });
      if (d.to && d.to !== 'human') this.fx.push({ type: 'msg', a: d.from, b: d.to, t0: now, dur: 1100 });
    } else if (k === 'message') {
      this.bubbles.set(d.from, { msgId: d.id, text: d.say, streaming: false, t: now });
      if (d.to && d.to !== 'human') this.fx.push({ type: 'msg', a: d.from, b: d.to, t0: now, dur: 900 });
    } else if (k === 'hypothesis') {
      const g = this.kindPos('generator'); this.seedT.set(d.id, { t0: now, from: g, dur: 1000 });
    } else if (k === 'objection') {
      const t0 = Math.max(now, (this.seedT.get(d.hypothesis)?.t0 ?? 0) + 1000);
      this.fx.push({ type: 'strike', hyp: d.hypothesis, from: this.kindPos('critic'), t0, dur: 800 });
    } else if (k === 'objection_status' && d.resolved) {
      const o = this.M?.objs.get(d.id); if (o) this.fx.push({ type: 'heal', hyp: o.hypothesis, t0: now, dur: 900 });
    } else if (k === 'evidence') {
      this.fx.push({ type: 'signal', t0: now, dur: 1600, alpha: GRADE_ALPHA[d.grade] ?? 0.3 });
      this.lastGrade = d.grade;
    } else if (k === 'finding') {
      this.fx.push({ type: 'ring', at: this.kindPos('scribe'), t0: now, dur: 1400, big: true });
    }
  }

  delta(msgId, from, raw, thoughtRaw = '') {
    const now = performance.now();
    let b = this.bubbles.get(from);
    if (!b || b.msgId !== msgId) { b = { msgId, text: '', thought: '', streaming: true, t: now, t0: now, last: null }; this.bubbles.set(from, b); }
    const s = splitThink(raw);
    b.thought = `${thoughtRaw || ''} ${s.thought}`.trim();
    b.text = partialSay(s.answer); b.raw = raw; b.t = now; b.last = now; this.dirty = true;
  }

  /** An automatic retry started: clear the half-finished attempt and say why. */
  retry(msgId, from, text) {
    const now = performance.now();
    let b = this.bubbles.get(from);
    if (!b || b.msgId !== msgId) { b = { msgId, text: '', thought: '', streaming: true, t: now, t0: now, last: null }; this.bubbles.set(from, b); }
    b.text = ''; b.thought = ''; b.raw = ''; b.last = null; b.notice = text; b.noticeAt = now; b.noticeSticky = false; b.noticeHead = null; this.dirty = true;
  }

  /** An agent (or the lab) is running a search/page-open: say so on its bubble. */
  tool(status, from) {
    const now = performance.now();
    if (!status) {
      const b = from && this.bubbles.get(from);
      if (b) { b.notice = null; b.noticeSticky = false; }
      this.dirty = true; return;
    }
    const b = this.bubbles.get(status.from);
    if (b) { b.text = ''; b.thought = ''; b.streaming = true; b.last = null; b.notice = status.text; b.noticeSticky = true; b.noticeHead = 'SEARCHING'; b.noticeAt = now; }
    this.dirty = true;
  }

  // ----- pointer -----
  pt(e) { const r = this.cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  hitTest(p) {
    for (let i = this.hit.length - 1; i >= 0; i--) {
      const h = this.hit[i];
      if (h.r ? (p.x >= h.r.x && p.x <= h.r.x + h.r.w && p.y >= h.r.y && p.y <= h.r.y + h.r.h) : Math.hypot(p.x - h.x, p.y - h.y) <= h.rad) return h;
      if (h.seg) { const d = distSeg(p, h.seg[0], h.seg[1]); if (d < 7) return h; }
    }
    return null;
  }
  down(e) {
    const p = this.pt(e), h = this.hitTest(p);
    this.cv.setPointerCapture(e.pointerId);
    this.drag = { start: p, hit: h, moved: false };
  }
  move(e) {
    const p = this.pt(e);
    if (this.drag) {
      const d = this.drag;
      if (d.hit?.type === 'agent' && (d.moved || Math.hypot(p.x - d.start.x, p.y - d.start.y) > 5)) {
        d.moved = true;
        const m = 74;
        const nx = clampN((p.x - m) / (this.W - 2 * m)), ny = clampN((p.y - 64) / (this.H - 64 - 96));
        this.overrides[d.hit.id] = { x: nx, y: ny }; this.dirty = true;
      }
      return;
    }
    const h = this.hitTest(p); this.hover = h; this.cv.style.cursor = h ? (h.type === 'agent' ? 'grab' : 'pointer') : 'default';
  }
  up(e) {
    const d = this.drag; this.drag = null; if (!d) return;
    if (d.moved && d.hit?.type === 'agent') { const o = this.overrides[d.hit.id]; this.hooks.onMoved?.(d.hit.id, o.x, o.y); return; }
    const h = d.hit; if (!h) return;
    const hk = this.hooks;
    if (h.type === 'agent') hk.onAgent?.(h.id);
    else if (h.type === 'bubble') hk.onMessage?.(h.id, h.agent);
    else if (h.type === 'seed') hk.onSeed?.(h.id);
    else if (h.type === 'vessel') hk.onVessel?.(h.id);
    else if (h.type === 'link') hk.onLink?.(h.a, h.b);
    else if (h.type === 'sandbox') hk.onVessel?.(null);
  }

  /** Directed pairs that exchanged messages although the lab defines no link between them. */
  offPath() {
    const M = this.M; if (!M?.lab) return [];
    const key = `${M.msgs.length}:${M.lab.links.length}:${M.lab.agents.length}`;
    if (this._opKey === key) return this._op;
    const ids = new Set(M.lab.agents.map((a) => a.id));
    const linked = new Set(M.lab.links.flatMap((l) => [`${l.from}|${l.to}`, `${l.to}|${l.from}`]));
    const map = new Map();
    M.msgs.forEach((m, i) => {
      if (!m.to || m.to === 'human' || m.to === m.from || !ids.has(m.from) || !ids.has(m.to)) return;
      const k = `${m.from}|${m.to}`;
      if (linked.has(k)) return;
      const e = map.get(k) ?? { a: m.from, b: m.to, n: 0, last: 0 };
      e.n++; e.last = i; map.set(k, e);
    });
    this._opKey = key; this._op = [...map.values()];
    return this._op;
  }

  // ----- drawing -----
  loop(now) {
    if (!this.running) return;
    const needs = !this.calm || this.fx.length || this.dirty;
    if (needs) { this.draw(now); this.dirty = false; }
    this.raf = requestAnimationFrame(this.loop);
  }

  draw(now) {
    const { ctx, W, H, c, M } = this;
    if (W < 10 || H < 10) return;
    ctx.clearRect(0, 0, W, H);
    this.hit = [];
    if (!M?.lab) return;
    const animate = !this.calm;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';

    // links
    for (const l of M.lab.links) {
      const A = M.lab.agents.find((a) => a.id === l.from), B = M.lab.agents.find((a) => a.id === l.to);
      if (!A?.enabled || !B?.enabled) continue;
      const a = this.pos(l.from), b = this.pos(l.to);
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const p1 = { x: a.x + Math.cos(ang) * (R + 3), y: a.y + Math.sin(ang) * (R + 3) };
      const p2 = { x: b.x - Math.cos(ang) * (R + 5), y: b.y - Math.sin(ang) * (R + 5) };
      const active = this.fx.some((f) => f.type === 'msg' && ((f.a === l.from && f.b === l.to) || (f.a === l.to && f.b === l.from)));
      ctx.strokeStyle = active ? c.fg : c.strong; ctx.lineWidth = active ? 1.4 : 1;
      ctx.setLineDash(l.kind === 'informs' ? [3, 5] : []);
      line(ctx, p1, p2); ctx.setLineDash([]);
      if (l.kind === 'challenges') { // challenge marker: a bar across the line near the target
        const m = { x: p2.x - Math.cos(ang) * 10, y: p2.y - Math.sin(ang) * 10 };
        ctx.lineWidth = 2; line(ctx, { x: m.x - Math.sin(ang) * 5, y: m.y + Math.cos(ang) * 5 }, { x: m.x + Math.sin(ang) * 5, y: m.y - Math.cos(ang) * 5 });
      } else arrow(ctx, p2, ang, c.strong);
      this.hit.push({ type: 'link', a: l.from, b: l.to, seg: [p1, p2] });
    }

    // Off-path conversations: when an agent talks to someone it has no predefined
    // link to, draw an arrow to whoever it is talking to (dashed, so it reads as
    // "not part of the usual route"). Derived from the log, so replay shows it too.
    for (const e of this.offPath()) {
      const A = M.lab.agents.find((x) => x.id === e.a), B = M.lab.agents.find((x) => x.id === e.b);
      if (!A?.enabled || !B?.enabled) continue;
      const a = this.pos(e.a), b = this.pos(e.b);
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const p1 = { x: a.x + Math.cos(ang) * (R + 3), y: a.y + Math.sin(ang) * (R + 3) };
      const p2 = { x: b.x - Math.cos(ang) * (R + 5), y: b.y - Math.sin(ang) * (R + 5) };
      const active = this.fx.some((f) => f.type === 'msg' && f.a === e.a && f.b === e.b);
      const recent = M.msgs.length - e.last <= 6;
      ctx.save();
      ctx.globalAlpha = active ? 1 : recent ? 0.85 : 0.5;
      ctx.strokeStyle = active ? c.fg : c.strong; ctx.lineWidth = active ? 1.6 : 1.2; ctx.setLineDash([5, 4]);
      line(ctx, p1, p2); ctx.setLineDash([]);
      arrow(ctx, p2, ang, active ? c.fg : c.strong);
      ctx.restore();
      this.hit.push({ type: 'link', a: e.a, b: e.b, seg: [p1, p2] });
    }

    this.drawCommons(now, animate);
    this.drawSandbox(now, animate);

    // fx under nodes
    this.fx = this.fx.filter((f) => now < f.t0 + f.dur + 600);
    for (const f of this.fx) this.drawFx(f, now);

    // nodes
    for (const a of this.agents()) this.drawNode(a, now, animate);
    // bubbles last
    for (const a of this.agents()) this.drawBubble(a, now);
  }

  drawCommons(now, animate) {
    const { ctx, c, M } = this, cm = this.commons();
    ctx.font = `600 9.5px ${c.mono}`; ctx.fillStyle = c.mute; ctx.textAlign = 'center';
    if (M.hyps.size) ctx.fillText('HYPOTHESES', cm.x, this.seedPos([...M.hyps.keys()][Math.max(0, M.hyps.size - 8)]).y - 30);
    for (const id of [...M.hyps.keys()].slice(-8)) {
      const h = M.hyps.get(id), to = this.seedPos(id);
      let p = to, a = 1;
      const st = this.seedT.get(id);
      if (st && animate) { const t = (now - st.t0) / st.dur; if (t < 1) { const e = ease(t); p = { x: st.from.x + (to.x - st.from.x) * e, y: st.from.y + (to.y - st.from.y) * e - Math.sin(e * Math.PI) * 22 }; } }
      ctx.save(); ctx.translate(p.x, p.y);
      const dim = h.status === 'withdrawn';
      ctx.lineWidth = 1.6; ctx.strokeStyle = dim ? c.mute : c.fg; ctx.fillStyle = c.bg; ctx.globalAlpha = dim ? 0.55 : a;
      ctx.beginPath(); ctx.arc(0, 0, 10, 0, 7); if (dim) ctx.setLineDash([2, 3]);
      ctx.fill(); ctx.stroke(); ctx.setLineDash([]);
      if (h.status === 'supported') { ctx.fillStyle = c.fg; ctx.beginPath(); ctx.arc(0, 0, 10, 0, 7); ctx.fill(); }
      if (h.status === 'tentative') { ctx.fillStyle = c.fg; ctx.beginPath(); ctx.arc(0, 0, 10, Math.PI / 2, Math.PI * 1.5); ctx.fill(); }
      if (h.status === 'refuted') { ctx.beginPath(); ctx.moveTo(-5, -5); ctx.lineTo(5, 5); ctx.moveTo(5, -5); ctx.lineTo(-5, 5); ctx.stroke(); }
      const cracked = h.objs.some((oid) => { const o = M.objs.get(oid); return o && o.severity !== 'minor' && o.resolved !== true && o.status !== 'closed'; });
      if (cracked && !dim && h.status !== 'supported') {
        ctx.strokeStyle = c.fg; ctx.lineWidth = 1.3; ctx.beginPath();
        ctx.moveTo(-3, -10); ctx.lineTo(0, -4); ctx.lineTo(-4, 0); ctx.lineTo(1, 3); ctx.lineTo(-1, 10); ctx.stroke();
      }
      ctx.globalAlpha = 1; ctx.fillStyle = dim ? c.mute : c.dim; ctx.font = `600 10px ${c.mono}`; ctx.textAlign = 'left';
      ctx.fillText(id, 16, 3.5);
      ctx.restore();
      this.hit.push({ type: 'seed', id, x: p.x, y: p.y, rad: 14 });
    }
  }

  drawSandbox(now, animate) {
    const { ctx, c, M } = this, s = this.sandbox(), g = this.gatePt(), e = this.kindPos('experimentalist');
    // Only shown once an experiment is in play: experimentalist -> approval gate -> sandbox.
    const inPlay = M.exps.size > 0 || M.openGates.some((x) => x.kind === 'experiment' || x.kind === 'resource') || ['design', 'approve', 'run', 'analyze'].includes(M.phase);    if (!inPlay) return;
    if (!inPlay) return;
    // sandbox box
    ctx.lineWidth = 1; ctx.strokeStyle = c.strong; ctx.fillStyle = c.solid; ctx.setLineDash([4, 4]);
    rr(ctx, s.x - 62, s.y - 30, 124, 60, 10); ctx.fill(); ctx.stroke(); ctx.setLineDash([]);
    ctx.font = `600 9.5px ${c.mono}`; ctx.fillStyle = c.mute; ctx.textAlign = 'center';
    ctx.fillText('SANDBOX', s.x, s.y - 14); ctx.fillText('runs approved code', s.x, s.y + 4); ctx.fillText('no network', s.x, s.y + 24);
    this.hit.push({ type: 'sandbox', r: { x: s.x - 62, y: s.y - 30, w: 124, h: 60 } });
    // gate
    const open = M.openGates.some((x) => x.kind === 'experiment' || x.kind === 'resource');
    const ang = Math.atan2(s.y - e.y, s.x - e.x), nx = -Math.sin(ang), ny = Math.cos(ang);
    const pulse = open && animate ? 0.55 + 0.45 * Math.sin(now / 260) : 1;
    ctx.strokeStyle = open ? c.fg : c.strong; ctx.lineWidth = open ? 3 : 1.5; ctx.globalAlpha = open ? pulse : 1;
    line(ctx, { x: g.x + nx * 30, y: g.y + ny * 30 }, { x: g.x + nx * 9, y: g.y + ny * 9 });
    line(ctx, { x: g.x - nx * 9, y: g.y - ny * 9 }, { x: g.x - nx * 30, y: g.y - ny * 30 });
    ctx.globalAlpha = 1; ctx.fillStyle = open ? c.fg : c.mute; ctx.font = `600 9.5px ${c.mono}`;
    ctx.fillText(open ? 'APPROVAL GATE · WAITING ON YOU' : 'APPROVAL GATE', g.x + nx * 46 + 4, g.y + ny * 46);
    // vessels
    for (const [id, x] of M.exps) {
      let v = this.vessels.get(id);
      if (!v) { v = { x: e.x, y: e.y - 6, alpha: 0 }; this.vessels.set(id, v); }
      const front = { x: g.x - Math.cos(ang) * 26, y: g.y - Math.sin(ang) * 26 };
      const st = x.state;
      let target = front, ta = 1;
      if (st === 'approved' || st === 'running') target = { x: s.x, y: s.y + 2 };
      if (st === 'finished' || st === 'failed' || st === 'rejected') { target = { x: s.x, y: s.y + 2 }; ta = 0; }
      const k = animate ? 0.09 : 1;
      v.x += (target.x - v.x) * k; v.y += (target.y - v.y) * k; v.alpha += (ta - v.alpha) * (animate ? 0.08 : 1);
      if (v.alpha < 0.03 && ta === 0) continue;
      const waiting = st === 'proposed' && M.openGates.some((gg) => gg.kind === 'experiment' && gg.detail?.experiment === id);
      ctx.save(); ctx.translate(v.x, v.y); ctx.globalAlpha = v.alpha;
      ctx.lineWidth = waiting ? 2.2 : 1.6; ctx.strokeStyle = c.fg; ctx.fillStyle = st === 'running' ? c.fg : c.bg;
      if (waiting && animate) ctx.globalAlpha = v.alpha * (0.6 + 0.4 * Math.sin(now / 240));
      rr(ctx, -9, -9, 18, 18, 4); ctx.fill(); ctx.stroke();
      if (st === 'running') { ctx.strokeStyle = c.bg; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, 4, now / 150, now / 150 + 4); ctx.stroke(); }
      ctx.globalAlpha = v.alpha; ctx.fillStyle = c.dim; ctx.font = `600 10px ${c.mono}`; ctx.textAlign = 'left';
      ctx.fillText(id, 14, 4);
      ctx.restore();
      if (v.alpha > 0.3) this.hit.push({ type: 'vessel', id, x: v.x, y: v.y, rad: 16 });
    }
  }

  drawFx(f, now) {
    const { ctx, c } = this, t = (now - f.t0) / f.dur;
    if (t < 0) return;
    if (f.type === 'msg') {
      const a = this.pos(f.a), b = this.pos(f.b);
      if (t > 1) return;
      for (let i = 0; i < 4; i++) {
        const tt = ease(t) - i * 0.07; if (tt < 0 || tt > 1) continue;
        ctx.globalAlpha = 1 - i * 0.22; ctx.fillStyle = c.fg;
        ctx.beginPath(); ctx.arc(a.x + (b.x - a.x) * tt, a.y + (b.y - a.y) * tt, 3 - i * 0.4, 0, 7); ctx.fill();
      }
      ctx.globalAlpha = 1;
    } else if (f.type === 'strike') {
      const to = this.seedPos(f.hyp);
      if (t < 1) { const e = ease(t); ctx.fillStyle = c.fg; ctx.beginPath(); ctx.arc(f.from.x + (to.x - f.from.x) * e, f.from.y + (to.y - f.from.y) * e, 4, 0, 7); ctx.fill(); }
      else if (t < 1.7) { const u = (t - 1) / 0.7; ctx.strokeStyle = c.fg; ctx.globalAlpha = 1 - u; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(to.x, to.y, 10 + u * 22, 0, 7); ctx.stroke(); ctx.globalAlpha = 1; }
    } else if (f.type === 'heal') {
      const to = this.seedPos(f.hyp); if (t > 1) return;
      ctx.strokeStyle = c.dim; ctx.globalAlpha = 1 - t; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.arc(to.x, to.y, 12 + t * 14, 0, 7); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
    } else if (f.type === 'signal') {
      const s = this.sandbox(), st = this.kindPos('statistician');
      if (t > 1.2) return;
      const e = ease(Math.min(1, t)), x = s.x + (st.x - s.x) * e, y = s.y + (st.y - s.y) * e;
      ctx.globalAlpha = Math.max(0, f.alpha * (t > 1 ? 1 - (t - 1) / 0.2 : 1)); ctx.fillStyle = c.fg;
      ctx.beginPath(); ctx.arc(x, y, 8, 0, 7); ctx.fill();
      ctx.strokeStyle = c.fg; ctx.lineWidth = 1; ctx.globalAlpha *= 0.5; line(ctx, { x: s.x + (x - s.x) * 0.2, y: s.y + (y - s.y) * 0.2 }, { x, y }); ctx.globalAlpha = 1;
    } else if (f.type === 'ring') {
      if (t > 1) return; ctx.strokeStyle = c.fg; ctx.globalAlpha = 1 - t; ctx.lineWidth = f.big ? 3 : 1.5;
      ctx.beginPath(); ctx.arc(f.at.x, f.at.y, R + t * (f.big ? 60 : 30), 0, 7); ctx.stroke(); ctx.globalAlpha = 1;
    }
  }

  drawNode(a, now, animate) {
    const { ctx, c, M } = this, p = this.pos(a.id), st = M.agents[a.id] ?? { status: 'idle', activity: '' };
    const active = st.status === 'thinking' || st.status === 'arguing';
    ctx.save(); ctx.translate(p.x, p.y);
    if (animate && active) {
      const n = st.status === 'arguing' ? 2 : 1;
      for (let i = 0; i < n; i++) {
        const u = ((now / 1100 + i / n) % 1);
        ctx.strokeStyle = c.fg; ctx.globalAlpha = (1 - u) * 0.55; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(0, 0, R + 2 + u * 20, 0, 7); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    let lw = 1.6;
    if (st.status === 'blocked') { lw = 2.6; ctx.globalAlpha = animate ? 0.55 + 0.45 * Math.sin(now / 280) : 1; }
    ctx.lineWidth = lw; ctx.strokeStyle = st.status === 'idle' ? c.mute : c.fg;
    ctx.fillStyle = active ? c.fg : c.bg;
    ctx.beginPath(); ctx.arc(0, 0, R, 0, 7); ctx.fill(); ctx.stroke();
    if (st.status === 'blocked') { ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.arc(0, 0, R + 7, 0, 7); ctx.stroke(); ctx.setLineDash([]); }
    ctx.globalAlpha = 1;
    ctx.fillStyle = active ? c.bg : st.status === 'idle' ? c.dim : c.fg; ctx.font = `700 12px ${c.mono}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(initials(a.name), 0, 1);
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = st.status === 'idle' ? c.dim : c.fg; ctx.font = `600 11.5px ${c.sans}`;
    ctx.fillText(a.name, 0, R + 18);
    ctx.fillStyle = c.mute; ctx.font = `10.5px ${c.sans}`;
    ctx.fillText(trunc(st.status === 'idle' ? '' : st.activity, 34), 0, R + 32);
    if (a.kind === 'statistician' && this.M.evidence.length) { // evidence meter beside the statistician
      const g = this.M.evidence[this.M.evidence.length - 1].grade, n = GRADE_N[g] || 0;
      for (let i = 0; i < 4; i++) { ctx.fillStyle = i < n ? c.fg : 'transparent'; ctx.strokeStyle = c.fg; ctx.lineWidth = 1; ctx.fillRect(R + 10 + i * 7, -8, 5, 16); ctx.strokeRect(R + 10 + i * 7, -8, 5, 16); }
      ctx.fillStyle = c.mute; ctx.font = `600 9px ${c.mono}`; ctx.textAlign = 'left'; ctx.fillText(g.toUpperCase(), R + 10, 22);
    }
    ctx.restore();
    this.hit.push({ type: 'agent', id: a.id, x: p.x, y: p.y, rad: R + 6 });
  }

  drawBubble(a, now) {
    const b = this.bubbles.get(a.id); if (!b) return;
    const { ctx, c } = this;
    let alpha = 1;
    if (!b.streaming && !b.pinned) { const age = now - b.t; if (age > 9000) alpha = Math.max(0, 1 - (age - 9000) / 1500); if (alpha <= 0) { this.bubbles.delete(a.id); return; } }
    const p = this.pos(a.id);
    const maxW = 230;
    const secs = b.t0 != null ? Math.max(0, Math.floor((now - b.t0) / 1000)) : null;
    // What to show: the answer if it has started, else the model's live thoughts, else a waiting state.
    let text = b.text, head = (b.streaming ? (STAGE_LABEL[b.stage] || 'speaking') : a.name).toUpperCase().slice(0, 30), italic = false, hint = null;
    if (b.streaming && !b.text) {
      if (b.thought) {
        const tail = b.thought.length > 300 ? '…' + b.thought.slice(-300).replace(/^\S*\s/, '') : b.thought;
        text = tail; italic = true; head = `THINKING${secs != null ? ' · ' + secs + 's' : ''}`;
      } else if (b.notice && (b.noticeSticky || (b.noticeAt && now - b.noticeAt < 20000))) {
        text = b.notice; const ns = b.noticeSticky ? Math.floor((now - b.noticeAt) / 1000) : secs; head = `${b.noticeHead || 'RETRYING'}${ns != null ? ' · ' + ns + 's' : ''}`; italic = true;
      } else {
        const dots = '.'.repeat(1 + (Math.floor(now / 380) % 3));
        text = secs != null && secs < 2 ? 'Sending to the model' + dots : 'Waiting for the model' + dots;
        head = `${secs != null && secs >= 2 ? 'WAITING · ' + secs + 's' : 'STARTING'}`; italic = true;
      }
    } else if (b.streaming && secs != null) head = `${head} · ${secs}s`;
    if (b.streaming && b.t0 != null) {
      const quiet = (now - (b.last ?? b.t0)) / 1000;
      if (secs != null && secs >= 90) hint = `Taking longer than usual (${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s). Large models and long code can take a few minutes; it is still working.`;
      else if (quiet > 15) hint = b.last ? 'No new words for a while. It may be a long reasoning pass.' : 'Still no reply. A cold model can take a minute to load.';
    }
    ctx.font = `600 9px ${c.mono}`; const headW = ctx.measureText(head).width + 20;
    ctx.font = `${italic ? 'italic ' : ''}12px ${c.sans}`;
    let lines = wrap(ctx, text, maxW - 20);
    const maxLines = italic ? 4 : 5; let clipped = false;
    if (lines.length > maxLines) { lines = b.streaming ? lines.slice(-maxLines) : lines.slice(0, maxLines); clipped = true; if (!b.streaming) lines[maxLines - 1] = trunc(lines[maxLines - 1] + ' …', 40); }
    ctx.font = `10.5px ${c.sans}`; const hintLines = hint ? wrap(ctx, hint, 210).slice(0, 3) : []; ctx.font = `${italic ? 'italic ' : ''}12px ${c.sans}`;
    const lh = 16, w = Math.min(maxW + 40, Math.max(headW, hint ? 230 : 0, ...lines.map((l) => ctx.measureText(l).width + 20))), hgt = lines.length * lh + 26 + (hintLines.length ? hintLines.length * 13 + 8 : 0);
    const above = p.y > hgt + 70;
    let x = clampN2(p.x - w / 2, 8, this.W - w - 8);
    const y = above ? p.y - R - 16 - hgt : p.y + R + 44;
    ctx.save(); ctx.globalAlpha = alpha;
    ctx.fillStyle = c.solid; ctx.strokeStyle = b.streaming ? c.fg : c.strong; ctx.lineWidth = b.streaming ? 1.4 : 1;
    if (b.streaming && italic) ctx.setLineDash([4, 3]);
    rr(ctx, x, y, w, hgt, 10); ctx.fill(); ctx.stroke(); ctx.setLineDash([]);
    // tail
    const tx = clampN2(p.x, x + 14, x + w - 14), ty = above ? y + hgt : y;
    ctx.beginPath(); ctx.moveTo(tx - 6, ty); ctx.lineTo(tx, ty + (above ? 8 : -8)); ctx.lineTo(tx + 6, ty); ctx.fillStyle = c.solid; ctx.fill();
    ctx.beginPath(); ctx.moveTo(tx - 6, ty); ctx.lineTo(tx, ty + (above ? 8 : -8)); ctx.lineTo(tx + 6, ty); ctx.stroke();
    ctx.fillStyle = c.mute; ctx.font = `600 9px ${c.mono}`; ctx.textAlign = 'left';
    ctx.fillText(head, x + 10, y + 14);
    // live indicator: three pulsing dots at the top-right of a streaming bubble
    if (b.streaming && !this.calm) for (let i = 0; i < 3; i++) { ctx.globalAlpha = alpha * (0.25 + 0.75 * Math.max(0, Math.sin(now / 240 - i * 0.9))); ctx.fillStyle = c.fg; ctx.beginPath(); ctx.arc(x + w - 30 + i * 9, y + 11, 2, 0, 7); ctx.fill(); }
    ctx.globalAlpha = alpha;
    ctx.fillStyle = italic ? c.dim : c.fg; ctx.font = `${italic ? 'italic ' : ''}12px ${c.sans}`;
    lines.forEach((l, i) => ctx.fillText(l, x + 10, y + 30 + i * lh));
    if (hintLines.length) { ctx.fillStyle = c.mute; ctx.font = `10.5px ${c.sans}`; hintLines.forEach((l, i) => ctx.fillText(l, x + 10, y + hgt - 8 - (hintLines.length - 1 - i) * 13)); }
    ctx.restore();
    this.hit.push({ type: 'bubble', id: b.msgId, agent: a.id, r: { x, y, w, h: hgt } });
  }
}

// ---- helpers ----
function line(ctx, a, b) { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
function arrow(ctx, p, ang, color) {
  ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(p.x + Math.cos(ang) * 3, p.y + Math.sin(ang) * 3);
  ctx.lineTo(p.x - Math.cos(ang) * 6 + Math.sin(ang) * 4, p.y - Math.sin(ang) * 6 - Math.cos(ang) * 4);
  ctx.lineTo(p.x - Math.cos(ang) * 6 - Math.sin(ang) * 4, p.y - Math.sin(ang) * 6 + Math.cos(ang) * 4); ctx.fill();
}
function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
function initials(n) { const w = n.split(/\s+/).filter(Boolean); return (w.length > 1 ? w[0][0] + w[1][0] : n.slice(0, 2)).toUpperCase(); }
function wrap(ctx, text, maxW) {
  const out = []; let cur = '';
  for (const word of String(text).split(/\s+/)) {
    const t = cur ? cur + ' ' + word : word;
    if (ctx.measureText(t).width > maxW && cur) { out.push(cur); cur = word; } else cur = t;
  }
  if (cur) out.push(cur); return out.length ? out : [''];
}
function distSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
const clampN = (v) => Math.max(0.02, Math.min(0.98, v));
const clampN2 = (v, a, b) => Math.max(a, Math.min(b, v));
export { ARGUE };
