// The floor: lanes (what each agent is doing), the living diagram, and the
// debate feed with objections threaded onto the hypotheses they target.

import { h, $, clear, pill, statusPill, gradeMeter, trunc, STAGE_LABEL } from './util.js';
import { A, S, isLive, running } from './state.js';
import { Floor } from './diagram.js';
import { agentName } from './model.js';
import { agentDrawer, hypDrawer, expDrawer, messageDialog, exchangeDialog, msgCard, objThread, newRunDialog } from './dialogs.js';

export function replayBar() {
  const n = S.events.length, at = S.replay ?? n;
  const range = h('input', { type: 'range', min: 0, max: n, value: at, 'aria-label': 'Timeline', oninput: () => A.setReplay(+range.value) });
  return h('div', { class: 'overlay' },
    h('button', { class: 'btn sm', title: 'Step back', onclick: () => A.stepReplay(-1), disabled: n === 0 }, '◀'),
    h('button', { class: 'btn sm', title: S.playing ? 'Pause' : 'Play', onclick: () => A.togglePlay(), disabled: n === 0 }, S.playing ? 'Pause' : S.replay == null ? 'Replay' : 'Play'),
    h('button', { class: 'btn sm', title: 'Step forward', onclick: () => A.stepReplay(1), disabled: n === 0 }, '▶'),
    range,
    h('span', { class: 'mono mute', style: { minWidth: '76px', textAlign: 'right' } }, `${at} / ${n}`),
    h('button', { class: 'btn sm', onclick: () => A.setReplay(null), disabled: S.replay == null }, 'Live'),
    h('button', { class: 'btn sm', 'aria-pressed': S.calm, onclick: () => A.toggleCalm(), title: 'Static layout, for when local models need every resource' }, S.calm ? 'Calm: on' : 'Calm'));
}

export function createFloor() {
  const canvas = h('canvas', { 'aria-label': 'Living diagram of the lab' });
  const lanes = h('section', { class: 'lanes' });
  const legend = h('div', { class: 'legend' }, 'seed = hypothesis · crack = open objection · vessel = experiment · signal = evidence');
  const banner = h('div', { class: 'banner' });
  const welcome = h('div', { style: { position: 'absolute', inset: 0, display: 'none', placeItems: 'center', pointerEvents: 'none' } });
  const toolchip = h('div', { class: 'toolchip', hidden: true, role: 'status', 'aria-live': 'polite' });
  const stage = h('section', { class: 'stage' }, canvas, legend, banner, welcome, toolchip);
  let toolTimer = null;
  const renderTool = () => {
    const s = S.toolStatus;
    if (!s) { toolchip.hidden = true; clearInterval(toolTimer); toolTimer = null; return; }
    toolchip.hidden = false; clear(toolchip);
    toolchip.append(h('span', { class: 'spin' }), h('span', {}, s.text), h('span', { class: 'mute' }, ` · ${Math.floor((Date.now() - s.t0) / 1000)}s`));
    if (!toolTimer) toolTimer = setInterval(renderTool, 1000);
  };
  const tabInd = h('div', { class: 'tab-ind no-anim', 'aria-hidden': 'true' });
  const tabs = h('div', { class: 'tabs', role: 'tablist' }, tabInd);
  let tabPlaced = false;
  const placeTab = (animate = true) => {
    const b = tabs.querySelector('[aria-selected="true"]');
    if (!b || !b.offsetWidth) return;
    if (!animate) tabInd.classList.add('no-anim');
    tabInd.style.width = b.offsetWidth + 'px'; tabInd.style.transform = `translateX(${b.offsetLeft}px)`;
    if (!animate || !tabPlaced) { tabPlaced = true; void tabInd.offsetWidth; setTimeout(() => tabInd.classList.remove('no-anim'), 80); }
  };
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => placeTab(false)).observe(tabs);
  const body = h('div', { class: 'body' });
  const feed = h('section', { class: 'feed' }, tabs, body);
  const root = h('div', { class: 'floor' }, lanes, stage, feed);

  // Resizable columns: drag the edges, double-click to reset. Sizes persist.
  const store = { get: (k) => { try { return +localStorage.getItem(k) || null; } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, String(v)); } catch { /* ignore */ } } };
  const apply = () => {
    const lw = store.get('elenchia.lanesW'), fw = store.get('elenchia.feedW');
    if (lw) root.style.setProperty('--lanes-w', lw + 'px'); else root.style.removeProperty('--lanes-w');
    if (fw) root.style.setProperty('--feed-w', fw + 'px'); else root.style.removeProperty('--feed-w');
  };
  const splitter = (cls, key, min, maxFrac, sign) => {
    const el = h('div', { class: 'split ' + cls, role: 'separator', 'aria-orientation': 'vertical', title: 'Drag to resize · double-click to reset' });
    el.addEventListener('dblclick', () => { try { localStorage.removeItem(key); } catch { /* ignore */ } apply(); });
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault(); el.setPointerCapture(e.pointerId); el.classList.add('drag');
      const rect = root.getBoundingClientRect();
      const move = (ev) => {
        const w = sign > 0 ? ev.clientX - rect.left : rect.right - ev.clientX;
        const v = Math.round(Math.max(min, Math.min(rect.width * maxFrac, w)));
        store.set(key, v); apply();
      };
      const up = () => { el.classList.remove('drag'); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
      el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    });
    return el;
  };
  root.append(splitter('lanes-split', 'elenchia.lanesW', 150, 0.35, 1), splitter('feed-split', 'elenchia.feedW', 260, 0.7, -1));
  apply();

  const floor = new Floor(canvas, {
    onAgent: (id) => agentDrawer(id),
    onMessage: (id) => messageDialog(id),
    onSeed: (id) => { S.focus = { type: 'hyp', id }; S.feedTab = "debate"; update(); const el = body.querySelector(`[data-hyp="${id}"]`); el?.scrollIntoView({ block: 'center', behavior: 'smooth' }); hypDrawer(id); },
    onVessel: (id) => id && expDrawer(id),
    onLink: (a, b) => exchangeDialog(a, b),
    onMoved: (id, x, y) => A.moveAgent(id, x, y),
  });

  function renderLanes(M) {
    clear(lanes);
    for (const a of M.lab.agents.filter((x) => x.enabled)) {
      const st = M.agents[a.id] ?? { status: 'idle', activity: '' };
      lanes.append(h('div', { class: 'lane', 'data-s': st.status, onclick: () => agentDrawer(a.id) },
        h('div', { class: 'glyph' }, a.name.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase()),
        h('div', { class: 'nm' }, a.name),
        h('div', { class: 'act' }, st.status === 'idle' ? (M.ended ? 'run ended' : 'idle') : st.activity + (st.to && st.to !== 'human' && st.status !== 'blocked' ? ` → ${agentName(M, st.to)}` : '')),
        h('div', { class: 'mdl' }, a.model.runtime === 'demo' ? 'scripted demo' : `${a.model.runtime} · ${a.model.model}`)));
    }
  }

  function renderBanner(M) {
    clear(banner);
    if (M.openGates.length && isLive()) banner.append(h('div', { class: 'card pad blocked' }, h('b', {}, `${M.openGates.length} decision${M.openGates.length > 1 ? 's' : ''} waiting on you`), h('div', { class: 'dim', style: { margin: '2px 0 8px' } }, M.openGates[0].title), h('button', { class: 'btn primary sm', onclick: () => A.go('inbox') }, 'Open inbox')));
    else if (M.ended) banner.append(h('div', { class: 'card pad' }, h('b', {}, 'Run ' + M.ended.status), h('div', { class: 'dim' }, M.ended.reason), M.findings.length ? h('div', { style: { marginTop: '8px' } }, h('button', { class: 'btn sm', onclick: () => A.go('notebook') }, 'Open notebook')) : null));
    else if (M.started && M.started.preview) banner.append(h('div', { class: 'card pad dim' }, 'Browser preview: replaying a recorded run of the scripted demo lab.'));
  }

  function renderWelcome(M) {
    clear(welcome);
    canvas.style.opacity = S.runId ? "1" : "0.28";
    if (S.runId) { welcome.style.display = "none"; return; }
    welcome.style.display = "grid";
    const steps = ['Frame', 'Hypothesize', 'Challenge', 'Design', 'Approve', 'Analyze', 'Promote'];
    welcome.append(h('div', { class: 'card pad', style: { maxWidth: '520px', pointerEvents: 'auto', background: 'var(--bg)' } },
      h('div', { class: 'cap' }, 'The lab is empty'),
      h('h2', { style: { margin: '6px 0 8px', fontSize: '19px' } }, 'You’re not chatting. You’re directing a lab.'),
      h('p', { class: 'dim', style: { margin: '0 0 12px' } }, 'Pose a research question. The team proposes, attacks, tests and grades. Each ● below is a gate where nothing happens without you.'),
      h('div', { class: 'steps', style: { gridTemplateColumns: 'repeat(7,1fr)', margin: '0 0 14px' } }, steps.map((s, i) => h('div', { class: [0, 4, 6].includes(i) ? 'gate' : '' }, s))),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', onclick: newRunDialog }, 'Start a research run'), h('button', { class: 'btn', onclick: () => A.go('designer') }, 'Staff the lab'))));
  }

  function renderFeed(M) {
    [...tabs.children].forEach((c) => { if (c !== tabInd) c.remove(); }); // keep the indicator element so it can slide
    const tabList = [['debate', 'Debate'], ['transcript', 'Transcript'], ['log', 'Decisions']];
    if (S.browserView || M.browsed?.length) tabList.splice(2, 0, ['browser', 'Browser']);
    for (const [id, label] of tabList)
      tabs.append(h('button', { role: 'tab', 'aria-selected': S.feedTab === id, onclick: () => { S.feedTab = id; renderFeed(M); } }, label));
    placeTab(true);
    const prev = body.scrollTop, atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
    clear(body);
    if (S.feedTab === 'debate') {
      if (!M.hyps.size) body.append(h('div', { class: 'empty' }, S.runId ? 'Waiting for the first hypotheses…' : 'The debate will appear here: hypotheses with their objections threaded beneath.'));
      for (const hy of M.hyps.values()) {
        body.append(h('div', { class: 'hcard', 'data-hyp': hy.id, style: S.focus?.id === hy.id ? { borderColor: 'var(--fg)' } : null },
          h('div', { class: 'row' }, h('span', { class: 'mono', style: { fontWeight: 700 } }, hy.id), statusPill(hy.status), h('span', { class: 'mute', style: { flex: 1 } }, 'round ' + hy.round), hy.evidence ? gradeMeter(hy.evidence.grade) : null),
          h('div', { class: 'claim', onclick: () => hypDrawer(hy.id), style: { cursor: 'pointer' } }, hy.claim),
          h('div', { class: 'pred' }, 'Predicts: ' + hy.prediction),
          hy.objs.length ? h('div', { class: 'thread' }, hy.objs.map((oid) => objThread(M.objs.get(oid)))) : null,
          hy.exps.length ? h('div', { class: 'row', style: { marginTop: '10px', flexWrap: 'wrap' } }, hy.exps.map((e) => h('button', { class: 'btn sm', onclick: () => expDrawer(e) }, `${e} · ${M.exps.get(e).state}`))) : null,
          hy.evidence ? h('div', { class: 'dim', style: { marginTop: '8px', fontSize: '12px' } }, trunc(hy.evidence.summary, 220)) : null));
      }
      for (const f of M.findings) body.append(h('div', { class: 'hcard', style: { borderColor: 'var(--fg)' } }, h('div', { class: 'cap' }, 'Finding'), h('div', { class: 'claim' }, f.title), h('div', {}, f.text), h('div', { class: 'row', style: { marginTop: '8px' } }, statusPill(f.status), gradeMeter(f.grade))));
    } else if (S.feedTab === 'transcript') {
      if (!M.msgs.length) body.append(h('div', { class: 'empty' }, 'No messages yet.'));
      for (const m of M.msgs) body.append(msgCard(m));
      for (const [id, raw] of S.live) if (isLive() && !M.msgs.find((m) => m.id === id)) { /* streaming messages show in bubbles */ }
    } else if (S.feedTab === 'browser') {
      const v = S.browserView;
      body.append(h('div', { class: 'cap' }, 'Built-in browser · fresh profile, no logins · page text is untrusted'));
      if (v && !v.closed) {
        body.append(h('div', { class: 'card pad', style: { margin: '8px 0' } },
          h('div', { class: 'row' }, pill(v.action === 'search' ? 'searching' : 'reading', 'solid'), h('span', { class: 'mono', style: { flex: 1, minWidth: 0, overflowWrap: 'anywhere' } }, v.url)),
          v.title ? h('div', { style: { fontWeight: 600, marginTop: '6px' } }, v.title) : null,
          v.shot ? h('img', { src: 'data:image/jpeg;base64,' + v.shot, alt: 'What the browser is showing', style: { width: '100%', borderRadius: '6px', marginTop: '8px', border: '1px solid var(--line)' } }) : null));
      } else body.append(h('div', { class: 'empty' }, v?.closed ? 'The browser closed when the run ended.' : 'No page opened yet. An agent can ask to search or open a page; you approve each request.'));
      if (M.browsed?.length) body.append(h('div', { class: 'cap', style: { marginTop: '10px' } }, 'Pages opened this run'), ...[...M.browsed].reverse().map((b) => h('div', { class: 'msg', style: { cursor: 'default' } }, h('div', { class: 'hd' }, h('b', {}, b.action), '·', `${b.chars} chars`), h('div', { style: { overflowWrap: 'anywhere' } }, b.title || b.url), h('div', { class: 'mute', style: { overflowWrap: 'anywhere' } }, b.url))));
    } else {
      const rows = [...M.decisions].reverse();
      if (!rows.length && !M.notes.length) body.append(h('div', { class: 'empty' }, 'Every approval, flag and override is logged here.'));
      for (const n of M.notes) body.append(h('div', { class: 'msg' }, h('div', { class: 'hd' }, 'note'), n.text));
      for (const d of rows) body.append(h('div', { class: 'msg', style: { cursor: 'default' } }, h('div', { class: 'hd' }, h('b', {}, d.kind), '·', d.by === 'auto' ? 'auto' : 'you'), h('b', {}, d.decision), d.title ? h('div', { class: 'mute' }, d.title) : null, d.note ? h('div', { class: 'dim' }, '“' + trunc(d.note, 120) + '”') : null));
    }
    if (atBottom && S.feedTab !== 'log') body.scrollTop = body.scrollHeight; else body.scrollTop = prev;
  }

  function refreshBar() {
    const old = stage.querySelector(".overlay");
    if (old && document.activeElement?.type === "range" && old.contains(document.activeElement)) {
      old.querySelector(".mono").textContent = `${S.replay ?? S.events.length} / ${S.events.length}`; return;
    }
    const nb = replayBar();
    if (old) old.replaceWith(nb); else stage.append(nb);
  }
  function update(ev, opts) {
    const M = S.M; if (!M?.lab) return;
    renderLanes(M); renderBanner(M); renderWelcome(M); renderFeed(M); refreshBar();
    floor.setModel(M, { live: isLive() || !!opts?.animate, calm: S.calm, reset: !!opts?.reset });
    if (ev) floor.push(ev);
  }

  return {
    el: root,
    update,
    delta: (msgId, from, raw, thought) => floor.delta(msgId, from, raw, thought),
    retry: (msgId, from, text) => floor.retry(msgId, from, text),
    browser: () => update(),
    tool: (status, from) => { floor.tool(status, from); renderTool(); },
    destroy: () => floor.destroy(),
    floor,
  };
}
