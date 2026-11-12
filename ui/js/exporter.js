// Notebook export. One neutral document (a list of blocks) is built from the
// derived run model, then rendered to Markdown, HTML, plain text, PDF and Word
// with no libraries, plus CSV for the transcript and a JSON bundle (.elenchia)
// that the app can open again to view the notebook.

import { agentName } from './model.js';
import { GATE_LABEL } from './util.js';

const iso = (ts) => (ts ? new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '');

// ---------------------------------------------------------------- document
// Blocks: {t:'h1'|'h2'|'h3'|'p'|'quote', text} {t:'ul', items} {t:'code', text} {t:'table', head, rows}
export function buildDoc(M, meta = {}, opt = {}) {
  const o = { transcript: true, code: true, decisions: true, sources: true, ...opt };
  const B = [];
  const q = M.framed?.question ?? M.started?.question ?? meta?.question ?? '';
  B.push({ t: 'h1', text: 'Lab notebook' });
  B.push({ t: 'p', text: `Question: ${q}`, bold: true });
  if (M.started?.question && M.started.question !== q) B.push({ t: 'p', text: `Originally asked: ${M.started.question}`, italic: true });
  B.push({ t: 'p', italic: true, text: `Lab: ${M.lab?.name ?? ''}  ·  Started: ${iso(M.firstTs)}  ·  Agent turns: ${M.turns}  ·  Outcome: ${M.ended ? `${M.ended.status}: ${M.ended.reason}` : 'in progress'}` });
  if (M.started?.preview) B.push({ t: 'quote', text: 'Recorded from the scripted demo lab (preview).' });

  B.push({ t: 'h2', text: 'Team' });
  B.push({ t: 'ul', items: (M.lab?.agents ?? []).filter((a) => a.enabled).map((a) => `${a.name} (${a.kind}): ${a.model.runtime}:${a.model.model}, temperature ${a.model.temperature}`) });
  if (M.msgs.some((m) => m.scripted)) B.push({ t: 'quote', text: 'Some or all agents were the scripted demo, not language models.' });

  B.push({ t: 'h2', text: 'Findings' });
  if (!M.findings.length) B.push({ t: 'p', italic: true, text: 'No finding was promoted.' });
  for (const f of M.findings) {
    B.push({ t: 'h3', text: `${f.title} (${String(f.status).toUpperCase()})` }, { t: 'p', text: f.text });
    const items = [`Hypothesis ${f.hypothesis}, experiment ${f.experiment}, evidence grade ${f.grade}`, `Decision: ${f.decided}${f.note ? ` ("${f.note}")` : ''}`];
    if (f.downgraded) items.push('Status was capped by the lab rules (evidence grade, critic concession or missing executed result).');
    for (const c of f.caveats || []) items.push(`Caveat: ${c}`);
    B.push({ t: 'ul', items });
  }

  if (o.sources && (M.sources?.length || M.searches?.length)) {
    B.push({ t: 'h2', text: 'Sources' });
    for (const s of M.sources || []) B.push({ t: 'p', text: `[${s.n}] ${s.name} (${s.kind}, ${s.truncated ? `${s.shown} of ${s.chars} characters read` : `${s.chars} characters`}) ${s.origin}` });
    for (const sr of M.searches || []) {
      B.push({ t: 'h3', text: `${sr.kind === 'web' ? 'Web search' : 'Literature search'}: ${sr.query}` });
      B.push({ t: 'ul', items: (sr.papers || sr.results || []).map((p) => `[${p.n}] ${p.title}${p.authors ? ` — ${p.authors}` : ''}${p.year ? ` (${p.year})` : ''}${p.venue ? `, ${p.venue}` : ''}${p.url ? ` <${p.url}>` : ''}`) });
    }
  }

  B.push({ t: 'h2', text: 'Hypotheses' });
  for (const hy of M.hyps.values()) {
    B.push({ t: 'h3', text: `${hy.id} (${hy.status})` }, { t: 'p', text: hy.claim });
    const items = [`Prediction: ${hy.prediction || '—'}`, `Assumptions: ${(hy.assumptions || []).join('; ') || '—'}`];
    for (const oid of hy.objs) {
      const ob = M.objs.get(oid);
      const state = ob.resolved === true ? 'resolved' : ob.resolved === false ? 'unresolved' : 'open';
      items.push(`Objection ${ob.id} (${ob.severity}, ${state}): ${ob.text}`);
      if (ob.answer) items.push(`   ${ob.answer.withdraw ? 'Withdrawn' : 'Answer'}: ${ob.answer.response}`);
    }
    for (const eid of hy.exps) {
      const e = M.exps.get(eid);
      items.push(`Experiment ${e.id} “${e.title}”, ${e.state}${e.evidence ? `; evidence ${e.evidence.grade}, verdict ${e.evidence.verdict}` : ''}`);
      if (e.evidence?.summary) items.push(`   ${e.evidence.summary}`);
    }
    B.push({ t: 'ul', items });
  }

  B.push({ t: 'h2', text: 'Experiments' });
  for (const e of M.exps.values()) {
    B.push({ t: 'h3', text: `${e.id}: ${e.title}` });
    if (e.protocol) B.push({ t: 'p', text: e.protocol });
    if (o.code && e.code) B.push({ t: 'code', text: e.code });
    if (e.result) {
      B.push({ t: 'p', italic: true, text: `Executed by ${e.result.executor}, seed ${e.result.seed}, ${e.result.duration_ms} ms, exit ${e.result.exit}` });
      if (e.result.result) B.push({ t: 'code', text: JSON.stringify(e.result.result, null, 2) });
    }
  }

  if (o.decisions) {
    B.push({ t: 'h2', text: 'Decisions' });
    B.push({ t: 'table', head: ['Time', 'Gate', 'Decision', 'By', 'Note'], rows: M.decisions.map((d) => [iso(d.ts), GATE_LABEL[d.kind] || d.kind, d.decision, d.by === 'auto' ? 'auto' : 'human', d.note || '']) });
  }
  if (M.browsed?.length) {
    B.push({ t: 'h2', text: 'Pages opened in the built-in browser' });
    B.push({ t: 'ul', items: M.browsed.map((b) => `${b.action}: ${b.title || b.url} <${b.url}>`) });
  }
  if (o.transcript) {
    B.push({ t: 'h2', text: 'Debate transcript' });
    for (const m of M.msgs) B.push({ t: 'p', text: `${agentName(M, m.from)} → ${agentName(M, m.to)} (${m.stage}, round ${m.round}): ${m.say}` });
  }
  return { title: 'Lab notebook', question: q, blocks: B };
}

// ---------------------------------------------------------------- markdown / text / html
export function toMd(doc) {
  const L = [];
  for (const b of doc.blocks) {
    if (b.t === 'h1') L.push(`# ${b.text}`, '');
    else if (b.t === 'h2') L.push(`## ${b.text}`, '');
    else if (b.t === 'h3') L.push(`### ${b.text}`, '');
    else if (b.t === 'p') L.push(b.bold ? `**${b.text}**` : b.italic ? `*${b.text}*` : b.text, '');
    else if (b.t === 'quote') L.push(`> ${b.text}`, '');
    else if (b.t === 'ul') L.push(...b.items.map((i) => (i.startsWith('   ') ? `  - ${i.trim()}` : `- ${i}`)), '');
    else if (b.t === 'code') L.push('```', b.text, '```', '');
    else if (b.t === 'table') L.push(`| ${b.head.join(' | ')} |`, `|${b.head.map(() => '---').join('|')}|`, ...b.rows.map((r) => `| ${r.map((c) => String(c).replace(/\|/g, '/').replace(/\n/g, ' ')).join(' | ')} |`), '');
  }
  return L.join('\n');
}

export function toTxt(doc) {
  const L = [];
  for (const b of doc.blocks) {
    if (b.t === 'h1') L.push(b.text.toUpperCase(), '='.repeat(b.text.length), '');
    else if (b.t === 'h2') L.push('', b.text.toUpperCase(), '-'.repeat(b.text.length), '');
    else if (b.t === 'h3') L.push(b.text, '');
    else if (b.t === 'p' || b.t === 'quote') L.push(b.text, '');
    else if (b.t === 'ul') L.push(...b.items.map((i) => (i.startsWith('   ') ? `    ${i.trim()}` : `  * ${i}`)), '');
    else if (b.t === 'code') L.push(...b.text.split('\n').map((l) => `    ${l}`), '');
    else if (b.t === 'table') L.push(b.head.join(' | '), ...b.rows.map((r) => r.join(' | ')), '');
  }
  return L.join('\n');
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function toHtml(doc) {
  const out = [];
  for (const b of doc.blocks) {
    if (b.t === 'h1' || b.t === 'h2' || b.t === 'h3') out.push(`<${b.t}>${esc(b.text)}</${b.t}>`);
    else if (b.t === 'p') out.push(`<p>${b.bold ? '<b>' : ''}${b.italic ? '<i>' : ''}${esc(b.text)}${b.italic ? '</i>' : ''}${b.bold ? '</b>' : ''}</p>`);
    else if (b.t === 'quote') out.push(`<blockquote>${esc(b.text)}</blockquote>`);
    else if (b.t === 'ul') out.push(`<ul>${b.items.map((i) => `<li${i.startsWith('   ') ? ' class="sub"' : ''}>${esc(i.trim())}</li>`).join('')}</ul>`);
    else if (b.t === 'code') out.push(`<pre>${esc(b.text)}</pre>`);
    else if (b.t === 'table') out.push(`<table><thead><tr>${b.head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${b.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(doc.title)}</title>
<style>body{font:15px/1.55 system-ui,Segoe UI,Helvetica,Arial,sans-serif;max-width:820px;margin:40px auto;padding:0 20px;color:#111}h1{font-size:28px}h2{margin-top:36px;border-bottom:1px solid #ddd;padding-bottom:4px}h3{margin-top:24px}
pre{background:#f5f5f5;padding:12px;border-radius:6px;overflow:auto;font-size:12.5px}blockquote{margin:12px 0;padding:6px 14px;border-left:3px solid #999;color:#444}li.sub{margin-left:18px;list-style:circle}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #ccc;padding:5px 8px;text-align:left;vertical-align:top}th{background:#f0f0f0}@media print{body{margin:0}}</style></head><body>${out.join('\n')}
<p style="color:#888;font-size:12px;margin-top:40px">Exported from Elenchia.</p></body></html>`;
}

// ---------------------------------------------------------------- CSV (transcript)
export function toCsv(M) {
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
  const rows = [['time', 'round', 'stage', 'from', 'to', 'model', 'say']];
  for (const m of M.msgs) rows.push([iso(m.ts), m.round, m.stage, agentName(M, m.from), agentName(M, m.to), m.model, m.say]);
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n');
}

// ---------------------------------------------------------------- bundle (.elenchia)
export function toBundle(events, M, meta, appVersion) {
  return JSON.stringify({
    format: 'elenchia-notebook', version: 1, app_version: appVersion || '', exported_at: new Date().toISOString(),
    run: { id: M.runId, question: M.framed?.question ?? M.started?.question ?? meta?.question ?? '', lab: M.lab?.name ?? '', status: M.ended?.status ?? 'in progress' },
    events,
  });
}

export function parseBundle(text) {
  let j;
  try { j = JSON.parse(text); } catch { throw new Error('That file is not valid JSON.'); }
  const events = Array.isArray(j) ? j : j?.events;
  if (!Array.isArray(events) || !events.length || !events.every((e) => e && typeof e.kind === 'string' && 'data' in e)) throw new Error('That does not look like an Elenchia notebook export.');
  if (j.format && j.format !== 'elenchia-notebook') throw new Error('Unrecognised notebook format.');
  return { events, meta: Array.isArray(j) ? {} : { exported_at: j.exported_at, app_version: j.app_version, run: j.run } };
}

// ---------------------------------------------------------------- bytes helpers
const enc = new TextEncoder();
const u8 = (s) => enc.encode(s);

function crc32(bytes) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < bytes.length; n++) {
    c = (crc ^ bytes[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Minimal ZIP writer (stored, no compression): enough for a .docx. */
function zip(files) {
  const parts = [], central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const name = u8(f.name), data = f.data, crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const csize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, csize, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let p = 0; for (const a of all) { out.set(a, p); p += a.length; }
  return out;
}

// ---------------------------------------------------------------- DOCX
const xml = (s) => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const run = (text, rpr = '') => `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
const para = (inner, ppr = '') => `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}${inner}</w:p>`;

export function toDocx(doc) {
  const body = [];
  for (const b of doc.blocks) {
    if (b.t === 'h1') body.push(para(run(b.text), '<w:pStyle w:val="Heading1"/>'));
    else if (b.t === 'h2') body.push(para(run(b.text), '<w:pStyle w:val="Heading2"/>'));
    else if (b.t === 'h3') body.push(para(run(b.text), '<w:pStyle w:val="Heading3"/>'));
    else if (b.t === 'p') body.push(para(run(b.text, `${b.bold ? '<w:b/>' : ''}${b.italic ? '<w:i/>' : ''}`)));
    else if (b.t === 'quote') body.push(para(run(b.text, '<w:i/>'), '<w:pBdr><w:left w:val="single" w:sz="12" w:space="8" w:color="888888"/></w:pBdr><w:ind w:left="480"/>'));
    else if (b.t === 'ul') for (const i of b.items) { const sub = i.startsWith('   '); body.push(para(run(`${sub ? '– ' : '• '}${i.trim()}`), `<w:ind w:left="${sub ? 900 : 480}" w:hanging="240"/>`)); }
    else if (b.t === 'code') for (const l of b.text.split('\n')) body.push(para(run(l === '' ? ' ' : l), '<w:pStyle w:val="Code"/>'));
    else if (b.t === 'table') {
      const cell = (t, head) => `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/>${head ? '<w:shd w:val="clear" w:color="auto" w:fill="EEEEEE"/>' : ''}</w:tcPr>${para(run(String(t), head ? '<w:b/><w:sz w:val="18"/>' : '<w:sz w:val="18"/>'))}</w:tc>`;
      const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="BBBBBB"/>`).join('');
      body.push(`<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${borders}</w:tblBorders></w:tblPr><w:tblGrid>${b.head.map(() => '<w:gridCol w:w="2000"/>').join('')}</w:tblGrid>` +
        `<w:tr>${b.head.map((h) => cell(h, true)).join('')}</w:tr>${b.rows.map((r) => `<w:tr>${r.map((c) => cell(c, false)).join('')}</w:tr>`).join('')}</w:tbl>`, para(''));
    }
  }
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="160"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="2" w:color="CCCCCC"/></w:pBdr><w:spacing w:before="320" w:after="120"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="30"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="25"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F3F3F3"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="18"/></w:rPr></w:style>
</w:styles>`;
  const files = [
    { name: '[Content_Types].xml', data: u8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>') },
    { name: '_rels/.rels', data: u8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>') },
    { name: 'word/_rels/document.xml.rels', data: u8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>') },
    { name: 'word/document.xml', data: u8(document) },
    { name: 'word/styles.xml', data: u8(styles) },
  ];
  return zip(files);
}

// ---------------------------------------------------------------- PDF
const WIN = { '“': 0x93, '”': 0x94, '‘': 0x91, '’': 0x92, '–': 0x96, '—': 0x97, '…': 0x85, '•': 0x95, '€': 0x80 };
const REPL = { '→': '->', '←': '<-', '≥': '>=', '≤': '<=', '≠': '!=', '×': 'x', '−': '-', '′': "'", '″': '"', '≈': '~', '✓': 'v' };
function winAnsi(s) {
  let out = '';
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    if (WIN[ch]) out += String.fromCharCode(WIN[ch]);
    else if (REPL[ch]) out += REPL[ch];
    else if (cp === 9) out += '    ';
    else if (cp < 32) out += ' ';
    else if (cp <= 255) out += ch;
    else out += '?';
  }
  return out;
}
const pdfStr = (s) => '(' + winAnsi(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)') + ')';

export function toPdf(doc) {
  const W = 595.28, H = 841.89, mx = 56, top = 60, bottom = 64, cw = W - 2 * mx;
  const ctx = document.createElement('canvas').getContext('2d');
  const FONT = { r: 'F1', b: 'F2', c: 'F3', i: 'F4' };
  const width = (t, size, kind) => {
    if (kind === 'c') return winAnsi(t).length * size * 0.6;
    ctx.font = `${kind === 'b' ? 'bold ' : kind === 'i' ? 'italic ' : ''}${size}px Helvetica, Arial, sans-serif`;
    return ctx.measureText(winAnsi(t)).width;
  };
  const pages = [];
  let ops, y;
  const newPage = () => { ops = []; pages.push(ops); y = H - top; };
  newPage();
  const need = (h) => { if (y - h < bottom) newPage(); };
  const put = (t, x, size, kind) => { ops.push(`BT /${FONT[kind]} ${size} Tf ${x.toFixed(2)} ${(y - size).toFixed(2)} Td ${pdfStr(t)} Tj ET`); };
  const wrap = (text, size, kind, maxW) => {
    const out = [];
    for (const para of String(text).split('\n')) {
      if (para === '') { out.push(''); continue; }
      if (kind === 'c') {
        const per = Math.max(8, Math.floor(maxW / (size * 0.6)));
        for (let i = 0; i < para.length; i += per) out.push(para.slice(i, i + per));
        continue;
      }
      let cur = '';
      for (const word of para.split(/(\s+)/)) {
        if (!word) continue;
        if (width(cur + word, size, kind) > maxW && cur.trim()) { out.push(cur.trimEnd()); cur = word.trimStart(); }
        else cur += word;
        while (width(cur, size, kind) > maxW && cur.length > 1) { // an unbreakable long token
          let k = cur.length; while (k > 1 && width(cur.slice(0, k), size, kind) > maxW) k--;
          out.push(cur.slice(0, k)); cur = cur.slice(k);
        }
      }
      if (cur.trim() || !out.length) out.push(cur.trimEnd());
    }
    return out;
  };
  const text = (t, size, kind, { x = mx, indent = 0, lead = size * 1.4, after = 6, color } = {}) => {
    for (const l of wrap(t, size, kind, cw - indent)) {
      need(lead); if (color) ops.push(color);
      put(l, x + indent, size, kind); y -= lead;
    }
    y -= after;
  };
  for (const b of doc.blocks) {
    if (b.t === 'h1') { need(60); text(b.text, 24, 'b', { after: 10 }); }
    else if (b.t === 'h2') {
      need(50); y -= 8; text(b.text, 15, 'b', { after: 2 });
      ops.push(`0.75 G 0.6 w ${mx} ${(y + 2).toFixed(2)} m ${(W - mx).toFixed(2)} ${(y + 2).toFixed(2)} l S 0 G`); y -= 8;
    } else if (b.t === 'h3') { need(36); y -= 4; text(b.text, 12, 'b', { after: 4 }); }
    else if (b.t === 'p') text(b.text, 10.5, b.bold ? 'b' : b.italic ? 'i' : 'r');
    else if (b.t === 'quote') text(b.text, 10.5, 'i', { indent: 14 });
    else if (b.t === 'ul') {
      for (const it of b.items) {
        const sub = it.startsWith('   '), ind = sub ? 30 : 14;
        const lines = wrap(it.trim(), 10.5, 'r', cw - ind - 2);
        lines.forEach((l, i) => { need(15); if (i === 0) put(sub ? '-' : '•', mx + ind - 11, 10.5, 'r'); put(l, mx + ind, 10.5, 'r'); y -= 14.6; });
        y -= 2;
      }
      y -= 4;
    } else if (b.t === 'code') {
      const lines = wrap(b.text, 8.5, 'c', cw - 16);
      for (const l of lines) { need(12.5); ops.push(`0.955 g ${mx} ${(y - 11).toFixed(2)} ${cw.toFixed(2)} 12 re f 0 g`); put(l, mx + 8, 8.5, 'c'); y -= 11.6; }
      y -= 8;
    } else if (b.t === 'table') {
      for (const r of [b.head, ...b.rows]) {
        const head = r === b.head;
        text(r.map((c) => String(c).replace(/\s+/g, ' ')).join('  |  '), 9, head ? 'b' : 'r', { after: 2, lead: 12 });
      }
      y -= 6;
    }
  }
  // assemble
  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offs = [];
  const add = (body) => { offs.push(out.length); out += `${offs.length} 0 obj\n${body}\nendobj\n`; };
  const fonts = ['Helvetica', 'Helvetica-Bold', 'Courier', 'Helvetica-Oblique'];
  const kids = pages.map((_, i) => `${7 + i * 2} 0 R`);
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`);
  fonts.forEach((f) => add(`<< /Type /Font /Subtype /Type1 /BaseFont /${f} /Encoding /WinAnsiEncoding >>`));
  pages.forEach((p, i) => {
    const footer = `BT /F1 8 Tf ${mx} 32 Td ${pdfStr(`Elenchia notebook · page ${i + 1} of ${pages.length}`)} Tj ET`;
    const stream = ['0 g', ...p, footer].join('\n');
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 6 0 R >> >> /Contents ${offs.length + 2} 0 R >>`);
    add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  const xref = out.length;
  out += `xref\n0 ${offs.length + 1}\n0000000000 65535 f \n${offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}`;
  out += `trailer\n<< /Size ${offs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 255;
  return bytes;
}
