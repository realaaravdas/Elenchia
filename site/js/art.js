// Hero illustration: a hypothesis under objection. Generated live, not a recording. It uses the
// same visual vocabulary as the app's diagram (agents are nodes, hypotheses are seeds, an objection
// cracks a seed, evidence settles it) but plays out forever with random outcomes.

const box = document.getElementById('art');
const cv = document.getElementById('art-canvas');
if (box && cv) start();

function start() {
  const ctx = cv.getContext('2d');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let W = 0, H = 0, dpr = 1, c = {}, running = true, visible = true, last = 0, spawnAt = 0, hid = 0, oid = 0;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  const clamp01 = (v) => Math.max(0, Math.min(1, v));

  const colors = () => {
    const s = getComputedStyle(document.documentElement), g = (n) => s.getPropertyValue(n).trim();
    c = { fg: g('--fg'), bg: g('--bg'), dim: g('--fg-dim'), mute: g('--fg-mute'), line: g('--line'), strong: g('--line-strong'), mono: g('--mono'), sans: g('--sans') };
  };
  addEventListener('themechange', colors);

  // Layout in unit coordinates (0..1). The commons sits between generator and critic.
  const N = {
    gen: { x: 0.14, y: 0.50, name: 'Generator', ini: 'HG' },
    cri: { x: 0.56, y: 0.50, name: 'Critic', ini: 'CR' },
    exp: { x: 0.86, y: 0.26, name: 'Experimentalist', ini: 'EX' },
    sta: { x: 0.80, y: 0.80, name: 'Statistician', ini: 'ST' },
  };
  const LINKS = [['gen', 'cri'], ['cri', 'exp'], ['exp', 'sta'], ['sta', 'cri']];
  const commons = () => ({ x: (N.gen.x + N.cri.x) / 2, y: 0.5 });
  const SLOTS = [-0.30, -0.15, 0, 0.15, 0.30];
  const P = (n) => ({ x: n.x * W, y: n.y * H });

  const seeds = [], strikes = [], packets = [], rings = [];
  let meter = 0, meterT = 0;

  function resize() {
    const r = box.getBoundingClientRect();
    dpr = Math.min(2, devicePixelRatio || 1);
    W = Math.max(10, r.width); H = Math.max(10, r.height);
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  new ResizeObserver(resize).observe(box);

  function spawn(now) {
    const used = new Set(seeds.map((s) => s.slot));
    const free = SLOTS.map((_, i) => i).filter((i) => !used.has(i));
    if (!free.length) return;
    const slot = free[Math.floor(Math.random() * free.length)];
    seeds.push({ id: ++hid, slot, born: now, state: 'fly', t: now, obj: null, fate: Math.random() });
  }

  const seedPos = (s, now) => {
    const cm = commons(), to = { x: cm.x * W, y: (cm.y + SLOTS[s.slot] * 1.0) * H };
    const k = ease(clamp01((now - s.born) / 1100));
    const from = P(N.gen);
    return { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k - Math.sin(k * Math.PI) * 26, to };
  };

  function step(now) {
    if (now >= spawnAt) { spawn(now); spawnAt = now + rnd(2600, 3800); }
    for (const s of seeds) {
      const age = now - s.born;
      if (s.state === 'fly' && age > 1100) { s.state = 'open'; s.t = now; }
      else if (s.state === 'open' && now - s.t > 700) { // the critic raises an objection
        s.obj = ++oid; s.state = 'struck'; s.t = now;
        strikes.push({ s, t0: now }); packets.push({ a: 'cri', b: 'gen', t0: now, dur: 900 });
      } else if (s.state === 'struck' && now - s.t > 2300) {
        s.state = s.fate < 0.42 ? 'healed' : s.fate < 0.72 ? 'supported' : s.fate < 0.88 ? 'tentative' : 'refuted'; s.t = now;
        if (s.state === 'supported' || s.state === 'tentative') { packets.push({ a: 'cri', b: 'exp', t0: now, dur: 1100 }); rings.push({ n: 'exp', t0: now + 900 }); packets.push({ a: 'exp', b: 'sta', t0: now + 1000, dur: 1000 }); meter = s.state === 'supported' ? 3 : 2; meterT = now + 1900; }
      } else if (['healed', 'supported', 'tentative', 'refuted'].includes(s.state) && now - s.t > 5200) { s.state = 'fade'; s.t = now; }
    }
    for (let i = seeds.length - 1; i >= 0; i--) if (seeds[i].state === 'fade' && now - seeds[i].t > 1600) seeds.splice(i, 1);
    for (const arr of [strikes, packets, rings]) for (let i = arr.length - 1; i >= 0; i--) if (now - arr[i].t0 > (arr[i].dur ?? 1400) + 800) arr.splice(i, 1);
    if (now > meterT + 3500) meter = 0;
  }

  // ---------- drawing ----------
  const line = (a, b) => { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); };
  function drawGrid() {
    ctx.fillStyle = c.line;
    for (let y = 16; y < H; y += 28) for (let x = 16; x < W; x += 28) ctx.fillRect(x, y, 1.4, 1.4);
  }
  function drawLinks() {
    ctx.lineWidth = 1; ctx.strokeStyle = c.strong;
    LINKS.forEach(([a, b], i) => { ctx.setLineDash(i === 3 ? [3, 5] : []); line(P(N[a]), P(N[b])); });
    ctx.setLineDash([]);
  }
  function drawPackets(now) {
    for (const p of packets) {
      const t = (now - p.t0) / p.dur; if (t < 0 || t > 1) continue;
      const a = P(N[p.a]), b = P(N[p.b]), k = ease(t);
      ctx.fillStyle = c.fg; ctx.beginPath(); ctx.arc(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, 2.6, 0, 7); ctx.fill();
    }
  }
  function drawNode(key, now) {
    const n = N[key], p = P(n), R = 22;
    const busy = seeds.some((s) => (key === 'cri' && s.state === 'struck') || (key === 'gen' && s.state === 'fly'));
    if (busy) { const u = (now / 1100) % 1; ctx.strokeStyle = c.fg; ctx.globalAlpha = (1 - u) * 0.5; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(p.x, p.y, R + 3 + u * 16, 0, 7); ctx.stroke(); ctx.globalAlpha = 1; }
    for (const r of rings) if (r.n === key) { const u = (now - r.t0) / 900; if (u >= 0 && u <= 1) { ctx.strokeStyle = c.fg; ctx.globalAlpha = (1 - u) * 0.6; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(p.x, p.y, R + 2 + u * 18, 0, 7); ctx.stroke(); ctx.globalAlpha = 1; } }
    ctx.lineWidth = 1.5; ctx.strokeStyle = busy ? c.fg : c.mute; ctx.fillStyle = busy ? c.fg : c.bg;
    ctx.beginPath(); ctx.arc(p.x, p.y, R, 0, 7); ctx.fill(); ctx.stroke();
    ctx.fillStyle = busy ? c.bg : c.dim; ctx.font = `700 11px ${c.mono}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(n.ini, p.x, p.y + 1);
    ctx.textBaseline = 'alphabetic'; ctx.fillStyle = c.dim; ctx.font = `600 11px ${c.sans}`; ctx.fillText(n.name, p.x, p.y + R + 17);
    if (key === 'sta') { // evidence meter beside the statistician, as in the app
      for (let i = 0; i < 4; i++) { ctx.lineWidth = 1; ctx.strokeStyle = c.fg; ctx.fillStyle = i < meter ? c.fg : 'transparent'; ctx.fillRect(p.x + R + 10 + i * 7, p.y - 8, 5, 16); ctx.strokeRect(p.x + R + 10 + i * 7, p.y - 8, 5, 16); }
    }
  }
  function crack(x, y, r, k) {
    const pts = [[-0.1, -1], [0.35, -0.3], [-0.25, 0.1], [0.2, 0.55], [-0.05, 1]];
    ctx.lineWidth = 1.5; ctx.strokeStyle = c.fg; ctx.beginPath();
    pts.forEach(([px, py], i) => { const X = x + px * r * 0.9, Y = y + py * r * k; i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); });
    ctx.stroke();
  }
  function drawSeed(s, now) {
    const pos = seedPos(s, now), r = 10;
    const fade = s.state === 'fade' ? 1 - clamp01((now - s.t) / 1600) : 1;
    ctx.save(); ctx.globalAlpha = fade;
    const refuted = s.state === 'refuted';
    ctx.lineWidth = 1.6; ctx.strokeStyle = refuted ? c.mute : c.fg; ctx.fillStyle = c.bg;
    if (refuted) ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.arc(pos.x, pos.y, r, 0, 7); ctx.fill(); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = c.fg;
    if (s.state === 'supported') { ctx.beginPath(); ctx.arc(pos.x, pos.y, r, 0, 7); ctx.fill(); }
    if (s.state === 'tentative') { ctx.beginPath(); ctx.arc(pos.x, pos.y, r, Math.PI / 2, Math.PI * 1.5); ctx.fill(); }
    if (refuted) { ctx.strokeStyle = c.mute; ctx.beginPath(); ctx.moveTo(pos.x - 5, pos.y - 5); ctx.lineTo(pos.x + 5, pos.y + 5); ctx.moveTo(pos.x + 5, pos.y - 5); ctx.lineTo(pos.x - 5, pos.y + 5); ctx.stroke(); }
    if (s.state === 'struck') crack(pos.x, pos.y, r, 1);
    ctx.textAlign = 'left'; ctx.fillStyle = c.dim; ctx.font = `600 10px ${c.mono}`; ctx.fillText(`H${s.id}`, pos.x + 17, pos.y + 3);
    // a short status tag, like the app's cards
    const tag = s.state === 'struck' ? `O${s.obj} major` : s.state === 'healed' ? 'resolved' : s.state === 'supported' ? 'supported' : s.state === 'tentative' ? 'tentative' : refuted ? 'refuted' : s.state === 'open' ? 'open' : '';
    if (tag) { ctx.fillStyle = c.mute; ctx.font = `500 9.5px ${c.mono}`; ctx.fillText(tag, pos.x + 17, pos.y + 15); }
    ctx.restore();
  }
  function drawStrikes(now) {
    for (const k of strikes) {
      const pos = seedPos(k.s, now), a = P(N.cri), t = (now - k.t0) / 650;
      if (t < 0 || t > 1) continue;
      const kk = ease(t); ctx.strokeStyle = c.fg; ctx.globalAlpha = 0.55; ctx.lineWidth = 1.2; line(a, { x: a.x + (pos.x - a.x) * kk, y: a.y + (pos.y - a.y) * kk }); ctx.globalAlpha = 1;
      if (t > 0.9) { const u = (t - 0.9) / 0.1; ctx.strokeStyle = c.fg; ctx.globalAlpha = 1 - u; ctx.beginPath(); ctx.arc(pos.x, pos.y, 10 + u * 12, 0, 7); ctx.stroke(); ctx.globalAlpha = 1; }
    }
  }
  function draw(now) {
    ctx.clearRect(0, 0, W, H);
    drawGrid(); drawLinks(); drawStrikes(now); drawPackets(now);
    ctx.font = `600 9.5px ${c.mono}`; ctx.fillStyle = c.mute; ctx.textAlign = 'center';
    const cm = commons(); ctx.fillText('HYPOTHESES', cm.x * W, (cm.y - 0.42) * H);
    for (const s of seeds) drawSeed(s, now);
    for (const k of Object.keys(N)) drawNode(k, now);
  }

  function frame(t) {
    if (!running) return;
    if (visible && !document.hidden) { step(t); draw(t); }
    requestAnimationFrame(frame);
  }
  colors(); resize();
  if (reduced) { // one still frame: a few seeds in different states
    const t = performance.now();
    [[0, 'struck'], [1, 'supported'], [2, 'healed'], [3, 'tentative'], [4, 'refuted']].forEach(([slot, state], i) => seeds.push({ id: i + 1, slot, born: t - 5000, state, t, obj: i + 1, fate: 0 }));
    meter = 3; draw(t + 1);
  } else {
    spawnAt = performance.now() + 400;
    requestAnimationFrame(frame);
    new IntersectionObserver(([e]) => { visible = e.isIntersecting; }, { threshold: 0.05 }).observe(box);
  }
}
