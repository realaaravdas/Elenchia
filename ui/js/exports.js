// Export / import UI: the export dialog (formats + what to include), saving
// through the native "Save as" dialog on desktop, and opening an exported
// notebook (.elenchia) to view it in the lab notebook.

import { h, toast } from './util.js';
import { A, S, recompute } from './state.js';
import { call, isDesktop } from './api.js';
import { derive } from './model.js';
import { openModal, closeModal } from './dialogs.js';
import { buildDoc, toMd, toTxt, toHtml, toCsv, toPdf, toDocx, toBundle, parseBundle } from './exporter.js';

const slug = (s) => String(s || 'notebook').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'notebook';

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function saveFile(name, data, mime) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  if (isDesktop) {
    const p = await call('save_export', { name, dataB64: b64(bytes) });
    if (p) toast(`Saved to ${p}`, 6000);
    return !!p;
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
  toast(`Exported ${name}`);
  return true;
}

const FORMATS = [
  ['pdf', 'PDF', 'A readable document with headings, code and tables', 'application/pdf', (d) => toPdf(d)],
  ['docx', 'Word', 'Editable .docx for Word, Pages or Google Docs', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', (d) => toDocx(d)],
  ['md', 'Markdown', 'Plain text with light formatting', 'text/markdown', (d) => toMd(d)],
  ['html', 'HTML', 'One self-contained web page', 'text/html', (d) => toHtml(d)],
  ['txt', 'Plain text', 'No formatting at all', 'text/plain', (d) => toTxt(d)],
];

export function exportDialog() {
  if (!S.runId || !S.events.length) { toast('Nothing to export yet.'); return; }
  const M = derive(S.events); // always the whole run, even while scrubbing the replay
  const meta = S.runs.find((r) => r.id === S.runId);
  const base = `elenchia-${slug(M.framed?.question ?? M.started?.question ?? meta?.question)}`;
  const chk = (label, on = true) => { const c = h('input', { type: 'checkbox', checked: on }); return [c, h('label', { class: 'row', style: { gap: '10px' } }, c, h('span', {}, label))]; };
  const [cT, lT] = chk('Debate transcript'); const [cC, lC] = chk('Experiment code'); const [cD, lD] = chk('Decision log'); const [cS, lS] = chk('Sources and searches');
  const opts = () => ({ transcript: cT.checked, code: cC.checked, decisions: cD.checked, sources: cS.checked });
  const go = async (name, fn, mime) => {
    try { if (await saveFile(name, fn(), mime)) closeModal(); } catch (e) { toast('Export failed: ' + (e.message || e), 6000); }
  };
  openModal(h('div', {},
    h('h2', {}, 'Export notebook'), h('div', { class: 'sub' }, 'Save the findings, hypotheses, experiments and debate of this run.'),
    h('div', { class: 'cap' }, 'Include'),
    h('div', { class: 'stack', style: { margin: '8px 0 16px' } }, lT, lC, lD, lS),
    h('div', { class: 'cap' }, 'Document formats'),
    h('div', { class: 'stack', style: { margin: '8px 0 16px' } }, FORMATS.map(([ext, name, desc, mime, fn]) =>
      h('button', { class: 'card pad hover', style: { textAlign: 'left', cursor: 'pointer' }, onclick: () => go(`${base}.${ext}`, () => fn(buildDoc(M, meta, opts())), mime) },
        h('div', { class: 'row' }, h('b', { style: { flex: 1 } }, name), h('span', { class: 'mono mute' }, '.' + ext)), h('div', { class: 'mute' }, desc)))),
    h('div', { class: 'cap' }, 'Data'),
    h('div', { class: 'stack', style: { margin: '8px 0 6px' } },
      h('button', { class: 'card pad hover', style: { textAlign: 'left', cursor: 'pointer' }, onclick: () => go(`${base}.elenchia`, () => toBundle(S.events, M, meta, S.settings?.version), 'application/json') },
        h('div', { class: 'row' }, h('b', { style: { flex: 1 } }, 'Elenchia notebook'), h('span', { class: 'mono mute' }, '.elenchia')),
        h('div', { class: 'mute' }, 'The complete run (every event, prompt and result). Open it again in Elenchia to view it as a notebook.')),
      h('button', { class: 'card pad hover', style: { textAlign: 'left', cursor: 'pointer' }, onclick: () => go(`${base}-transcript.csv`, () => toCsv(M), 'text/csv') },
        h('div', { class: 'row' }, h('b', { style: { flex: 1 } }, 'Transcript table'), h('span', { class: 'mono mute' }, '.csv')), h('div', { class: 'mute' }, 'One row per agent message, for spreadsheets.')),
      h('button', { class: 'card pad hover', style: { textAlign: 'left', cursor: 'pointer' }, onclick: () => go(`${base}-events.json`, () => JSON.stringify(S.events, null, 2), 'application/json') },
        h('div', { class: 'row' }, h('b', { style: { flex: 1 } }, 'Raw event log'), h('span', { class: 'mono mute' }, '.json')), h('div', { class: 'mute' }, 'The hash-chained audit log as JSON.'))),
    h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: closeModal }, 'Close'))));
}

async function pickFile() {
  if (isDesktop) { const r = await call('open_import'); return r ? { name: r.name, text: r.text } : null; }
  return new Promise((resolve) => {
    const inp = h('input', { type: 'file', accept: '.elenchia,.json,application/json', style: { display: 'none' } });
    inp.addEventListener('change', async () => { const f = inp.files[0]; inp.remove(); resolve(f ? { name: f.name, text: await f.text() } : null); });
    inp.addEventListener('cancel', () => { inp.remove(); resolve(null); });
    document.body.append(inp); inp.click();
  });
}

/** Open an exported notebook and show it, read-only, in the lab notebook. */
export async function importNotebook() {
  try {
    const f = await pickFile();
    if (!f) return;
    const { events, meta } = parseBundle(f.text);
    A.stopAll?.();
    S.imported = { name: f.name, exportedAt: meta.exported_at, appVersion: meta.app_version };
    S.runId = events[0]?.run_id || 'imported';
    S.events = events; S.replay = events.length; S.live.clear(); S.thought?.clear(); S.focus = null;
    S.browserView = null; S.toolStatus = null;
    recompute();
    A.go('notebook');
    toast(`Opened ${f.name} (view only)`);
  } catch (e) { toast(e.message || String(e), 6000); }
}
