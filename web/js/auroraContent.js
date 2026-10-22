// Aurora Builder content files (the XML "elements" under Documents\5e Character Builder\custom) carry the
// descriptions that .dnd5e character files only reference by id. This module parses those files in the
// browser, uploads compact entries to the server, and fills feature/spell descriptions on import.
import { post, put, get } from './api.js';

const ELEMENT_RE = /<element\b([^>]*)>([\s\S]*?)<\/element>/g;
const ATTR_RE = /([\w:-]+)="([^"]*)"/g;

const attrs = (s) => { const o = {}; for (const m of s.matchAll(ATTR_RE)) o[m[1]] = decodeEntities(m[2]); return o; };
const decodeEntities = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, '&');

// Convert a fragment of Aurora's description HTML into markdown-ish text.
export function htmlToMd(html) {
  if (!html || !html.trim()) return '';
  const doc = new DOMParser().parseFromString(`<div id="r">${html}</div>`, 'text/html');
  const root = doc.getElementById('r');
  const inline = (node) => {
    let out = '';
    for (const n of node.childNodes) {
      if (n.nodeType === 3) out += n.data.replace(/\s+/g, ' ');
      else if (n.nodeType !== 1) continue;
      else {
        const t = n.tagName;
        if (t === 'BR') out += '\n';
        else if (t === 'B' || t === 'STRONG') out += `**${inline(n).trim()}**`;
        else if (t === 'I' || t === 'EM') out += `*${inline(n).trim()}*`;
        else if (t === 'U') out += inline(n);
        else if (t === 'A') out += inline(n);
        else if (t === 'SPAN') out += inline(n);
        else out += inline(n);
      }
    }
    return out;
  };
  const blocks = [];
  const walk = (node, depth = 0) => {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { const t = n.data.trim(); if (t) blocks.push(t.replace(/\s+/g, ' ')); continue; }
      if (n.nodeType !== 1) continue;
      const t = n.tagName;
      if (t === 'P' || t === 'DIV') { const s = inline(n).trim(); if (s) blocks.push(s); }
      else if (/^H[1-6]$/.test(t)) { const s = inline(n).trim(); if (s) blocks.push(`### ${s}`); }
      else if (t === 'UL' || t === 'OL') {
        let i = 0;
        const items = [];
        for (const li of n.children) {
          if (li.tagName !== 'LI') continue;
          i++;
          const nested = [...li.children].filter((c) => c.tagName === 'UL' || c.tagName === 'OL');
          const own = inline(li).trim();
          items.push(`${'  '.repeat(depth)}${t === 'OL' ? `${i}.` : '-'} ${own}`);
          for (const sub of nested) { const before = blocks.length; walk({ childNodes: [sub] }, depth + 1); items.push(...blocks.splice(before)); }
        }
        if (items.length) blocks.push(items.join('\n'));
      }
      else if (t === 'TABLE') {
        const rows = [...n.querySelectorAll('tr')].map((tr) => [...tr.children].map((c) => inline(c).trim().replace(/\|/g, '/')));
        if (rows.length) {
          const width = Math.max(...rows.map((r) => r.length));
          const line = (r) => `| ${Array.from({ length: width }, (_, i) => r[i] || '').join(' | ')} |`;
          blocks.push([line(rows[0]), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n'));
        }
      }
      else if (t === 'BLOCKQUOTE') { const s = inline(n).trim(); if (s) blocks.push(`> ${s}`); }
      else { const s = inline(n).trim(); if (s) blocks.push(s); }
    }
  };
  walk(root);
  return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Replace Aurora's {{stat}} placeholders with readable text.
export function fillPlaceholders(text) {
  return String(text || '').replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, key) => {
    const k = key.toLowerCase().trim();
    if (k === 'proficiency') return 'your proficiency bonus';
    if (k === 'level') return 'your level';
    let m;
    if ((m = k.match(/^(strength|dexterity|constitution|intelligence|wisdom|charisma):modifier$/))) return `your ${m[1][0].toUpperCase()}${m[1].slice(1)} modifier`;
    if (/:dc$/.test(k)) return 'the DC';
    if (/:level$/.test(k)) return 'your level in that class';
    if (/spellcasting:attack|:attack$/.test(k)) return 'your spell attack bonus';
    return `[${key.trim()}]`;
  });
}

// Parse one Aurora content XML file into compact entries.
export function parseElements(xmlText, sourceFile = '') {
  const out = [];
  const text = String(xmlText || '');
  for (const m of text.matchAll(ELEMENT_RE)) {
    const a = attrs(m[1]);
    if (!a.id || !a.name) continue;
    let inner = m[2];
    const sheetM = inner.match(/<sheet\b([^>]*)>([\s\S]*?)<\/sheet>/);
    const sheet = [];
    let usage = ''; let action = '';
    if (sheetM) {
      const sa = attrs(sheetM[1]); usage = sa.usage || ''; action = sa.action || '';
      for (const d of sheetM[2].matchAll(/<description\b([^>]*)>([\s\S]*?)<\/description>/g)) {
        const da = attrs(d[1]);
        const t = htmlToMd(d[2]) || decodeEntities(d[2]).replace(/\s+/g, ' ').trim();
        if (t) sheet.push({ level: Number(da.level) || 0, text: fillPlaceholders(t) });
      }
      inner = inner.replace(sheetM[0], '');
    } else if (/<sheet\b[^>]*\/>/.test(inner)) {
      const sa = attrs((inner.match(/<sheet\b([^>]*)\/>/) || ['', ''])[1]); usage = sa.usage || ''; action = sa.action || '';
    }
    const descM = inner.match(/<description\b[^>]*>([\s\S]*?)<\/description>/);
    const desc = descM ? htmlToMd(descM[1]) : '';
    const meta = {};
    const settersM = inner.match(/<setters>([\s\S]*?)<\/setters>/);
    if (settersM) for (const s of settersM[1].matchAll(/<set\b([^>]*?)(?:\/>|>([\s\S]*?)<\/set>)/g)) { const sa = attrs(s[1]); if (sa.name) meta[sa.name] = decodeEntities((s[2] || '').trim()); }
    if (!desc && !sheet.length && !Object.keys(meta).length) continue;
    out.push({ id: a.id, name: a.name, type: a.type || '', source: a.source || sourceFile, sheet, desc, usage, action, meta });
  }
  return out;
}

// "1/Long Rest" -> { max: 1, reset: 'long' }; "{{proficiency}}/Short Rest" -> { max: prof, reset: 'short' }; else null.
export function usesFromUsage(usage, prof = 2) {
  const m = String(usage || '').trim().match(/^(\d+|\{\{\s*proficiency\s*\}\})\s*\/\s*(long rest|short rest|day|rest)$/i);
  if (!m) return null;
  const max = /\d/.test(m[1]) ? Number(m[1]) : Math.max(1, Number(prof) || 2);
  const unit = m[2].toLowerCase();
  return { max, used: 0, reset: unit === 'short rest' || unit === 'rest' ? 'short' : 'long' };
}

// Best sheet text for a character level (highest "level" variant not above the character's level).
export function sheetTextFor(entry, level = 1) {
  const list = (entry?.sheet || []).filter((s) => (Number(s.level) || 0) <= (Number(level) || 1));
  if (!list.length) return '';
  return list.reduce((best, s) => ((Number(s.level) || 0) >= (Number(best.level) || 0) ? s : best)).text || '';
}

// Markdown for a feature: the sheet summary (if different) followed by the full rules text.
export function featureTextFrom(entry, level = 1) {
  const summary = sheetTextFor(entry, level).trim();
  const full = (entry?.desc || '').trim();
  if (!summary) return full;
  if (!full || full.replace(/\W/g, '').toLowerCase().startsWith(summary.replace(/\W/g, '').toLowerCase().slice(0, 60))) return full || summary;
  return `${summary}\n\n${full}`;
}

// ---------------------------------------------------------------- server round-trips
const BATCH = 400;

export async function uploadFiles(files, onProgress = () => {}) {
  const list = [...files].filter((f) => /\.xml$/i.test(f.name));
  let parsed = 0; let stored = 0; let total = 0; let failed = 0;
  let pending = [];
  const flush = async () => {
    if (!pending.length) return;
    const res = await put('/api/aurora/elements', { elements: pending });
    stored += res.stored; total = res.total; pending = [];
  };
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    try {
      const buf = await f.arrayBuffer();
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { text = new TextDecoder('windows-1252').decode(buf); }
      const entries = parseElements(text, f.name.replace(/\.xml$/i, ''));
      parsed += entries.length;
      pending.push(...entries);
      while (pending.length >= BATCH) { const chunk = pending.splice(0, BATCH); const res = await put('/api/aurora/elements', { elements: chunk }); stored += res.stored; total = res.total; }
    } catch (e) { failed++; console.warn('Aurora content: skipped', f.name, e); }
    onProgress({ file: i + 1, files: list.length, parsed, stored, name: f.name });
  }
  await flush();
  return { files: list.length, parsed, stored, total, failed };
}

export const contentStats = () => get('/api/aurora/elements/stats');

export async function lookup(ids = [], names = [], type = '') {
  if (!ids.length && !names.length) return { elements: {}, byName: {} };
  return post('/api/aurora/elements/lookup', { ids, names, type });
}

export async function lookupSpell(name, auroraId) {
  const r = await lookup(auroraId ? [auroraId] : [], name ? [name] : [], 'Spell');
  return (auroraId && r.elements[auroraId]) || r.byName[name] || null;
}

// Fill feature descriptions (and limited-use counters) from stored Aurora content. Mutates ch.
export async function resolveCharacter(ch, { overwrite = false } = {}) {
  const level = Math.max(1, (ch.classes || []).reduce((s, c) => s + (Number(c.level) || 0), 0));
  const prof = 2 + Math.floor((Math.min(20, level) - 1) / 4);
  const feats = (ch.features || []).filter((f) => f.auroraId && (overwrite || !(f.text && f.text.trim())));
  const spells = (ch.spellcasting?.spells || []).filter((s) => s.auroraId);
  const ids = [...new Set([...feats, ...spells].map((x) => x.auroraId))];
  if (!ids.length) return { filled: 0, uses: 0, spells: 0, missing: 0 };
  const { elements } = await lookup(ids);
  let filled = 0; let uses = 0; let missing = 0; let spellsFilled = 0;
  for (const f of feats) {
    const e = elements[f.auroraId];
    if (!e) { missing++; continue; }
    const text = featureTextFrom(e, level);
    if (text) { f.text = text; filled++; }
    if (!f.uses && e.usage) { const u = usesFromUsage(e.usage, prof); if (u) { f.uses = u; uses++; } }
    if (e.action && !f.kind) f.kind = 'active';
  }
  for (const s of spells) {
    const e = elements[s.auroraId];
    if (!e) continue;
    if (e.meta?.isConcentration === 'true') s.conc = true;
    if (!s.notes && e.desc && !/^ID_(PHB|SRD)_/i.test(s.auroraId)) { s.notes = e.desc.slice(0, 600); spellsFilled++; }
  }
  return { filled, uses, spells: spellsFilled, missing };
}

export function spellSummaryFromMeta(meta = {}) {
  const lvl = Number(meta.level) || 0;
  const ord = (n) => { const s = ['th', 'st', 'nd', 'rd']; const v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
  const comps = [meta.hasVerbalComponent === 'true' ? 'V' : null, meta.hasSomaticComponent === 'true' ? 'S' : null, meta.hasMaterialComponent === 'true' ? `M${meta.materialComponent ? ` (${meta.materialComponent})` : ''}` : null].filter(Boolean).join(', ');
  return [lvl === 0 ? `Cantrip · ${meta.school || ''}` : `${ord(lvl)}-level ${meta.school || ''}${meta.isRitual === 'true' ? ' (ritual)' : ''}`, meta.time, meta.range, comps, meta.duration, meta.isConcentration === 'true' && !/concentration/i.test(meta.duration || '') ? 'Concentration' : null].filter(Boolean).join(' · ');
}
