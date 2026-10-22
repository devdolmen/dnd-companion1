// SRD 5.1 spell reference: lazy-loaded data plus pure lookup / formatting helpers. No dependencies.
// Data: js/data/srd-spells.json, built from the SRD 5.1 via dnd5eapi.co (CC-BY-4.0, see LICENSES/SRD-5.1-CC-BY-4.0.txt).
// Each entry: { name, level, school, time, range, components, material, duration, concentration, ritual, classes, desc, higher }.

export const SRD_ATTRIBUTION = 'This work includes material taken from the System Reference Document 5.1 (“SRD 5.1”) by Wizards of the Coast LLC and available at https://dnd.wizards.com/resources/systems-reference-document. The SRD 5.1 is licensed under the Creative Commons Attribution 4.0 International License available at https://creativecommons.org/licenses/by/4.0/legalcode.';

// The SRD drops the wizards' names from these spells; Aurora Builder and the PHB use the long names.
const PHB_NAMES = {
  "Bigby's Hand": 'Arcane Hand',
  "Drawmij's Instant Summons": 'Instant Summons',
  "Evard's Black Tentacles": 'Black Tentacles',
  "Leomund's Secret Chest": 'Secret Chest',
  "Leomund's Tiny Hut": 'Tiny Hut',
  "Melf's Acid Arrow": 'Acid Arrow',
  "Mordenkainen's Faithful Hound": 'Faithful Hound',
  "Mordenkainen's Magnificent Mansion": 'Magnificent Mansion',
  "Mordenkainen's Private Sanctum": 'Private Sanctum',
  "Mordenkainen's Sword": 'Arcane Sword',
  "Nystul's Magic Aura": "Arcanist's Magic Aura",
  "Otiluke's Freezing Sphere": 'Freezing Sphere',
  "Otiluke's Resilient Sphere": 'Resilient Sphere',
  "Otto's Irresistible Dance": 'Irresistible Dance',
  "Rary's Telepathic Bond": 'Telepathic Bond',
  "Tasha's Hideous Laughter": 'Hideous Laughter',
  "Tenser's Floating Disk": 'Floating Disk',
};

let spells = null;   // array sorted by name, once loaded
let keys = null;     // normalizeName(name) for each entry of `spells`
let index = null;    // Map: normalized name without spaces -> spell (SRD names, then PHB aliases)
let aliases = null;  // [normalized PHB name, spell] pairs, for search
let inflight = null; // promise shared by concurrent loadSpells() callers

const byName = (a, b) => {
  const x = a.name.toLowerCase(), y = b.name.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
};
const compact = (key) => key.replace(/ /g, '');

// "Melf’s  Acid-Arrow" -> "melfs acidarrow"
export function normalizeName(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[\u2019\u2018\u00b4]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/ +/g, ' ')
    .trim();
}

function setData(list) {
  const sorted = list.filter((s) => s && typeof s.name === 'string').sort(byName);
  const k = sorted.map((s) => normalizeName(s.name));
  const idx = new Map();
  sorted.forEach((s, i) => { if (!idx.has(compact(k[i]))) idx.set(compact(k[i]), s); });
  const al = [];
  for (const [phb, srd] of Object.entries(PHB_NAMES)) {
    const s = idx.get(compact(normalizeName(srd)));
    if (!s) continue;
    const key = normalizeName(phb);
    al.push([key, s]);
    if (!idx.has(compact(key))) idx.set(compact(key), s);
  }
  spells = sorted; keys = k; index = idx; aliases = al;
}

async function fetchSpells() {
  const base = globalThis.document?.baseURI ?? globalThis.location?.href;
  const res = await fetch(new URL('./js/data/srd-spells.json', base));
  if (!res.ok) throw new Error(`SRD spells: HTTP ${res.status}`);
  const list = await res.json();
  if (!Array.isArray(list)) throw new Error('SRD spells: expected a JSON array');
  return list;
}

// Fetches and caches the spell list once. A failed fetch rejects and leaves the cache empty, so a later call retries.
export async function loadSpells() {
  if (spells) return spells;
  if (!inflight) {
    inflight = fetchSpells().then(
      (list) => { inflight = null; setData(list); return spells; },
      (err) => { inflight = null; throw err; },
    );
  }
  return inflight;
}

const stripParens = (s) => {
  let out = s, prev;
  do { prev = out; out = out.replace(/\s*\([^()]*\)\s*$/, ''); } while (out !== prev);
  return out;
};

// Case/punctuation-insensitive lookup; also tries the name without a trailing "(…)" and the PHB long names.
// Returns null when not found or when the data is not loaded yet.
export function findSpell(name) {
  if (!index || name == null) return null;
  const raw = String(name);
  for (const candidate of [raw, stripParens(raw)]) {
    const key = compact(normalizeName(candidate));
    if (key && index.has(key)) return index.get(key);
  }
  return null;
}

// Name prefix matches first, then substring matches (each sorted by name), then PHB-name and space-insensitive matches.
export function searchSpells(query, limit = 8) {
  if (!spells) return [];
  const q = normalizeName(query);
  if (q.length < 2) return [];
  const cq = compact(q);
  const prefix = [], inner = [], extra = new Set();
  spells.forEach((s, i) => {
    if (keys[i].startsWith(q)) prefix.push(s);
    else if (keys[i].includes(q)) inner.push(s);
    else if (compact(keys[i]).includes(cq)) extra.add(s);
  });
  for (const [key, s] of aliases) if (key.includes(q) && !prefix.includes(s) && !inner.includes(s)) extra.add(s);
  return [...prefix, ...inner, ...[...extra].sort(byName)].slice(0, limit);
}

const ordinal = (n) => `${n}${n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`;

// "Cantrip · Evocation · 1 action · 120 feet · V, S · Instantaneous"
// "1st-level Divination (ritual) · 1 action · Self · V, S · Concentration, up to 10 minutes"
export function spellSummary(spell) {
  if (!spell) return '';
  const level = Number(spell.level) || 0;
  const school = String(spell.school || '');
  const kind = level > 0 ? `${ordinal(level)}-level ${school}`.trim() : ['Cantrip', school].filter(Boolean).join(' · ');
  const parts = [kind + (spell.ritual ? ' (ritual)' : ''), spell.time, spell.range, spell.components, spell.duration];
  if (spell.concentration && !/concentration/i.test(spell.duration || '')) parts.push('Concentration');
  return parts.filter(Boolean).join(' · ');
}

// Full description as markdown (render with markdown.js).
export function spellMarkdown(spell) {
  if (!spell) return '';
  const components = [spell.components, spell.material ? `(${spell.material})` : ''].filter(Boolean).join(' ');
  let duration = spell.duration || '';
  if (spell.concentration && !/concentration/i.test(duration)) duration = duration ? `${duration} (concentration)` : 'Concentration';
  const facts = [['Casting time', spell.time], ['Range', spell.range], ['Components', components], ['Duration', duration]]
    .filter(([, v]) => v).map(([label, v]) => `**${label}** ${v}`).join(' · ');
  const blocks = [facts, spell.desc];
  if (spell.higher) blocks.push('### At higher levels', spell.higher);
  if (spell.classes?.length) blocks.push(`_Classes: ${spell.classes.join(', ')}_`);
  return blocks.filter(Boolean).join('\n\n');
}
