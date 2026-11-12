// Page behaviour: theme, latest-release links, install tabs, the surface switcher for the
// embedded app, and copy buttons. No dependencies.

const root = document.documentElement;
const REPO = 'realaaravdas/Elenchia';
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } } };

// The embedded app shares this origin's storage: skip its first-run tour in the frame.
store.set('elenchia.toured', '1');

// ---------- theme ----------
const ICONS = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z"/>',
};
const themeBtn = document.getElementById('theme');
function setTheme(t, persist = true) {
  root.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'dark' ? '#0a0a0a' : '#fafafa');
  themeBtn.innerHTML = `<svg viewBox="0 0 24 24">${t === 'dark' ? ICONS.sun : ICONS.moon}</svg>`;
  if (persist) store.set('elenchia.site.theme', t);
  store.set('elenchia.theme', t);
  try { const d = document.getElementById('app')?.contentDocument; if (d) d.documentElement.dataset.theme = t; } catch { /* cross-origin */ }
  window.dispatchEvent(new CustomEvent('themechange'));
}
setTheme(store.get('elenchia.site.theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'), false);
themeBtn.addEventListener('click', () => setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark'));

// ---------- install tabs with a sliding underline ----------
const tabs = [...document.querySelectorAll('#os-tabs button')];
const ind = document.getElementById('os-ind');
let placed = false;
function placeInd(animate = true) {
  const b = tabs.find((t) => t.getAttribute('aria-selected') === 'true');
  if (!b || !b.offsetWidth) return;
  if (!animate || !placed) ind.style.transition = 'none';
  ind.style.width = b.offsetWidth + 'px';
  ind.style.transform = `translateX(${b.offsetLeft}px)`;
  if (!animate || !placed) { void ind.offsetWidth; ind.style.transition = ''; placed = true; }
}
function showOs(os) {
  tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.os === os)));
  document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.dataset.panel !== os; });
  placeInd(true);
}
tabs.forEach((t) => t.addEventListener('click', () => showOs(t.dataset.os)));
addEventListener('resize', () => placeInd(false));
const ua = navigator.userAgent;
const myOs = /Windows/.test(ua) ? 'windows' : /Mac/.test(ua) ? 'mac' : /Linux|X11/.test(ua) ? 'linux' : 'windows';
showOs(myOs);
placeInd(false);

// ---------- latest release ----------
const fmt = (n) => `${(n / 1048576).toFixed(1)} MB`;
const KINDS = {
  windows: [[/x64-setup\.exe$/, 'Windows installer (.exe)']],
  mac: [[/aarch64\.dmg$/, 'Apple Silicon (.dmg)'], [/x64\.dmg$/, 'Intel (.dmg)']],
  linux: [[/\.AppImage$/, 'AppImage'], [/\.deb$/, 'Debian / Ubuntu (.deb)']],
};
fetch(`https://api.github.com/repos/${REPO}/releases?per_page=1`, { headers: { Accept: 'application/vnd.github+json' } })
  .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
  .then(([rel]) => {
    if (!rel) return;
    const tag = rel.tag_name;
    document.getElementById('ver').textContent = tag;
    document.getElementById('ver2').textContent = tag.replace(/^v/, '');
    const when = new Date(rel.published_at).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    document.getElementById('rel-line').textContent = `Latest release: ${tag}, ${when}${rel.prerelease ? ' (prerelease)' : ''}.`;
    for (const [os, kinds] of Object.entries(KINDS)) {
      const box = document.querySelector(`[data-dl="${os}"]`);
      for (const [re, label] of kinds) {
        const a = rel.assets.find((x) => re.test(x.name));
        if (!a) continue;
        const el = document.createElement('a');
        el.className = 'btn' + (box.children.length ? '' : ' primary');
        el.href = a.browser_download_url;
        el.textContent = `${label} · ${fmt(a.size)}`;
        box.append(el);
      }
    }
    const first = KINDS[myOs]?.map(([re]) => rel.assets.find((x) => re.test(x.name))).find(Boolean);
    if (first) {
      const cta = document.getElementById('cta-dl');
      cta.href = first.browser_download_url;
      cta.textContent = `Download for ${{ windows: 'Windows', mac: 'macOS', linux: 'Linux' }[myOs]}`;
      document.getElementById('cta-note').textContent = `${tag} · ${fmt(first.size)} · other platforms below`;
    }
  })
  .catch(() => {
    for (const box of document.querySelectorAll('[data-dl]')) {
      const a = document.createElement('a');
      a.className = 'btn primary'; a.href = `https://github.com/${REPO}/releases`; a.textContent = 'Open the releases page';
      box.append(a);
    }
  });

// ---------- the embedded app ----------
const SURF = [
  ['The floor', 'The living diagram of your lab. Agents are nodes, and messages travel between them as they speak, object and answer. Every shape is drawn from the run’s event log, and a timeline scrubber replays any moment.'],
  ['Lab designer', 'Staff the lab. Pick a model for each agent, edit its brief, set how contrarian it is, and wire who challenges whom. Mixing model families makes the critic more useful.'],
  ['Experiment board', 'Every experiment as a card: its hypothesis, the exact code that ran, the output and the statistician’s evidence grade.'],
  ['Approval inbox', 'Where you work. The lab stops here at each gate with a concrete spec: a code diff, a runtime estimate, the plan and a risk label. Keyboard shortcuts are printed on the buttons.'],
  ['Lab notebook', 'The record: findings with their status and caveats, hypotheses with their objections, experiments, decisions, and the full debate. Export it as PDF, Word, Markdown or HTML.'],
];
const surf = document.getElementById('surf'), desc = document.getElementById('surf-desc'), frame = document.getElementById('app');
function selectSurface(i, click = true) {
  [...surf.children].forEach((b, j) => b.setAttribute('aria-pressed', String(i === j)));
  desc.textContent = SURF[i][1];
  if (!click) return;
  try { frame.contentDocument.querySelector(`.rail-btn[aria-label="${SURF[i][0]}"]`)?.click(); } catch { /* not ready */ }
}
SURF.forEach(([name], i) => {
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = name; b.addEventListener('click', () => selectSurface(i));
  surf.append(b);
});
selectSurface(0, false);
frame.addEventListener('load', () => {
  try { frame.contentDocument.documentElement.dataset.theme = root.dataset.theme; } catch { /* ignore */ }
  // Keep the buttons in step if someone uses the app's own rail or number keys.
  try {
    const d = frame.contentDocument;
    const sync = () => setTimeout(() => {
      const cur = d.querySelector('.rail-btn[aria-current="page"]')?.getAttribute('aria-label');
      const i = SURF.findIndex(([n]) => n === cur);
      if (i >= 0) selectSurface(i, false);
    }, 60);
    d.addEventListener('click', sync);
    d.addEventListener('keydown', sync);
  } catch { /* ignore */ }
});

// ---------- copy buttons ----------
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  navigator.clipboard?.writeText(b.dataset.copy.replace(/&#10;/g, '\n')).then(() => {
    const t = b.textContent; b.textContent = 'Copied';
    setTimeout(() => { b.textContent = t; }, 1400);
  });
});
