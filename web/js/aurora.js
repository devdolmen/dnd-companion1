// Best-effort importer for Aurora Builder .dnd5e XML files.
// Aurora stores BASE ability scores and resolves racial bonuses, HP and many derived values from
// its content index, which is not available here. Everything importable is imported; the rest is
// estimated and listed in the returned `warnings` so the user can check the sheet.
import { CLASSES } from './data/srd.js';
import { abilityMod, featureKind } from './rules.js';

const ABIL = { strength: 'str', dexterity: 'dex', constitution: 'con', intelligence: 'int', wisdom: 'wis', charisma: 'cha' };
const SKILL_IDS = {
  ACROBATICS: 'acrobatics', ANIMAL_HANDLING: 'animalHandling', ARCANA: 'arcana', ATHLETICS: 'athletics',
  DECEPTION: 'deception', HISTORY: 'history', INSIGHT: 'insight', INTIMIDATION: 'intimidation',
  INVESTIGATION: 'investigation', MEDICINE: 'medicine', NATURE: 'nature', PERCEPTION: 'perception',
  PERFORMANCE: 'performance', PERSUASION: 'persuasion', RELIGION: 'religion', SLEIGHT_OF_HAND: 'sleightOfHand',
  STEALTH: 'stealth', SURVIVAL: 'survival',
};

const uid = () => Math.random().toString(36).slice(2, 10);
const titleCase = (s) => s.toLowerCase().replace(/(^|[\s(])(\w)/g, (m, p, c) => p + c.toUpperCase());
const fromId = (id, marker) => {
  // ID_MONKEYDM_WOO_RACE_GORGONBLOOD -> "Gorgonblood"; ID_WOTC_PHB_CLASS_SORCERER -> "Sorcerer"
  const idx = id.indexOf(marker);
  if (idx < 0) return '';
  return titleCase(id.slice(idx + marker.length).replace(/_/g, ' ').trim());
};
const text = (parent, tag) => parent?.querySelector(`:scope > ${tag}`)?.textContent?.trim() ?? '';
const num = (v, d = 0) => { const n = parseFloat(String(v).replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? n : d; };

export function parseAurora(xmlString) {
  const doc = new DOMParser().parseFromString(xmlString, 'application/xml');
  const root = doc.querySelector('character');
  if (!root || doc.querySelector('parsererror')) throw new Error('Not an Aurora Builder .dnd5e file');
  const warnings = [];

  const disp = root.querySelector('display-properties');
  const input = root.querySelector('build > input');
  const appearance = root.querySelector('build > appearance');
  const abilitiesEl = root.querySelector('build > abilities');

  const name = text(input, 'name') || text(disp, 'name') || 'Imported character';

  // Abilities (base scores)
  const abilities = { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };
  if (abilitiesEl) for (const [tag, key] of Object.entries(ABIL)) abilities[key] = num(text(abilitiesEl, tag), 10);
  if (abilitiesEl?.getAttribute('available-points') && num(abilitiesEl.getAttribute('available-points')) > 0) {
    warnings.push(`Aurora still had ${abilitiesEl.getAttribute('available-points')} unspent ability points.`);
  }
  warnings.push('Aurora stores base ability scores; racial bonuses are applied by its content files. Check the six scores.');

  // Walk elements
  const all = [...root.querySelectorAll('build > elements element')];
  const levelEls = all.filter((e) => e.getAttribute('type') === 'Level');
  const level = Math.max(1, levelEls.length || num(text(disp, 'level'), 1));

  const classes = [];
  let race = ''; let subrace = ''; let background = ''; let alignment = '';
  const saveProf = {}; const skillProf = {};
  const features = [];
  const seenFeature = new Set();

  const addFeature = (nm, source, auroraId = null) => {
    const clean = nm.replace(/^Feature:\s*/i, '').trim();
    if (!clean || seenFeature.has(clean)) return;
    seenFeature.add(clean);
    const feat = { id: uid(), name: clean, source, uses: null, text: '', auroraId };
    feat.kind = featureKind(feat);
    features.push(feat);
  };

  for (const el of all) {
    const type = el.getAttribute('type');
    const reg = el.getAttribute('registered') || '';
    const id = el.getAttribute('id') || '';
    const nm = el.getAttribute('name') || '';
    const key = reg || id;
    switch (type) {
      case 'Class': {
        if (!reg) break;
        const cname = fromId(reg, '_CLASS_');
        const lvlAttr = num(el.closest('element[type="Level"]')?.getAttribute('name'), 1);
        let entry = classes.find((c) => c.name === cname);
        if (!entry) { entry = { name: cname, level: 0, subclass: '' }; classes.push(entry); }
        entry.level += 1; entry._first = Math.min(entry._first ?? lvlAttr, lvlAttr);
        break;
      }
      case 'Archetype': {
        if (!reg) break;
        const sub = fromId(reg, '_ARCHETYPE_');
        const cls = el.closest('element[type="Class"]');
        const cname = cls ? fromId(cls.getAttribute('registered') || '', '_CLASS_') : '';
        const entry = classes.find((c) => c.name === cname) || classes[0];
        if (entry && !entry.subclass) entry.subclass = sub;
        break;
      }
      case 'Race': if (reg) race = fromId(reg, '_RACE_'); break;
      case 'Sub Race': if (reg) { const m = reg.match(/_SUBRACE_(?:[A-Z]+_)?([A-Z_]+)$/); subrace = m ? titleCase(m[1].replace(/_/g, ' ')) : fromId(reg, '_SUBRACE_'); } break;
      case 'Background': if (reg) background = fromId(reg, '_BACKGROUND_'); break;
      case 'Alignment': if (reg) alignment = fromId(reg, '_ALIGNMENT_'); break;
      case 'Proficiency': {
        const m1 = key.match(/SAVINGTHROW_([A-Z]+)/);
        if (m1) { const ab = ABIL[m1[1].toLowerCase()]; if (ab) saveProf[ab] = true; break; }
        const m2 = key.match(/PROFICIENCY_SKILL_([A-Z_]+)/);
        if (m2 && SKILL_IDS[m2[1]]) { skillProf[SKILL_IDS[m2[1]]] = 1; break; }
        const m3 = key.match(/EXPERTISE_([A-Z_]+)/);
        if (m3 && SKILL_IDS[m3[1]]) { skillProf[SKILL_IDS[m3[1]]] = 2; }
        break;
      }
      case 'Racial Trait': case 'Class Feature': case 'Archetype Feature': case 'Background Feature': case 'Feat': case 'Feat Feature': {
        if (/subrace|spellcasting ability|variant feature/i.test(nm)) break;
        if (!id && !reg) break;
        if (el.querySelector(':scope > element[type="Archetype"]')) break; // container such as "Sorcerous Origin"
        const src = type === 'Racial Trait' ? (subrace || race || 'Race') : type === 'Feat' ? 'Feat' : type === 'Background Feature' ? (background || 'Background') : (classes[classes.length - 1]?.name || 'Class');
        addFeature(nm, src, key || null);
        break;
      }
      default: break;
    }
  }
  // Fix class levels: Aurora nests one Class element per level; if only found once, use total level.
  for (const c of classes) delete c._first;
  if (classes.length === 1) classes[0].level = level;
  if (!classes.length) {
    const dispClass = text(disp, 'class');
    if (dispClass) classes.push({ name: dispClass, level, subclass: text(disp, 'archetype') });
    else warnings.push('No class found; set one on the sheet.');
  }
  if (!race) race = text(disp, 'race');
  if (!background) background = text(disp, 'background');
  const dispRace = text(disp, 'race');
  const raceLabel = dispRace.includes('(') ? dispRace : (subrace && race ? `${race} (${subrace})` : (race || subrace || dispRace));

  // HP estimate: max at level 1 + average per level after.
  const hitDie = CLASSES[classes[0]?.name]?.hitDie || 8;
  const conMod = abilityMod(abilities.con);
  const hpMax = Math.max(1, hitDie + conMod + (level - 1) * (Math.floor(hitDie / 2) + 1 + conMod));
  warnings.push('Hit points estimated (max at level 1, average afterwards). Adjust if you rolled.');

  // Magic
  const spells = []; const slots = {}; let castAbility = null;
  const sc = root.querySelector('build > magic > spellcasting');
  if (sc) {
    castAbility = ABIL[(sc.getAttribute('ability') || '').toLowerCase()] || null;
    const slotEl = sc.querySelector('slots');
    if (slotEl) for (let i = 1; i <= 9; i++) { const n = num(slotEl.getAttribute(`s${i}`)); if (n > 0) slots[i] = { max: n, used: 0 }; }
    for (const sp of sc.querySelectorAll('cantrips > spell, spells > spell')) {
      spells.push({ id: uid(), name: sp.getAttribute('name'), level: num(sp.getAttribute('level')), prepared: true, conc: false, notes: '', auroraId: sp.getAttribute('id') || null });
    }
  }
  for (const sp of root.querySelectorAll('build > magic > additional > spell')) {
    if (!spells.some((s) => s.name === sp.getAttribute('name'))) {
      spells.push({ id: uid(), name: sp.getAttribute('name'), level: num(sp.getAttribute('level')), prepared: true, conc: false, notes: sp.getAttribute('source') || '', auroraId: sp.getAttribute('id') || null });
    }
  }
  if (!castAbility) castAbility = CLASSES[classes[0]?.name]?.ability || 'int';

  // Equipment
  const inventory = [];
  for (const it of root.querySelectorAll('build > equipment item')) {
    inventory.push({ id: uid(), name: it.getAttribute('name') || 'Item', qty: num(it.getAttribute('amount'), 1) || 1, weight: num(it.getAttribute('weight')), equipped: it.getAttribute('equipped') === 'true', attuned: false, notes: '' });
  }
  const eqText = input?.querySelector('currency > equipment')?.textContent?.trim();
  if (!inventory.length && eqText) warnings.push('Equipment was free text in Aurora; it was placed in the Quick actions box.');

  const cur = input?.querySelector('currency');
  const coins = { cp: num(text(cur, 'copper')), sp: num(text(cur, 'silver')), ep: num(text(cur, 'electrum')), gp: num(text(cur, 'gold')), pp: num(text(cur, 'platinum')) };

  const bioParts = [];
  if (appearance) {
    const f = (tag, label) => { const v = text(appearance, tag); if (v) bioParts.push(`**${label}** ${v}`); };
    f('age', 'Age'); f('height', 'Height'); f('weight', 'Weight'); f('eyes', 'Eyes'); f('skin', 'Skin'); f('hair', 'Hair');
  }
  const portrait = disp?.querySelector('portrait > base64')?.textContent?.trim() || '';

  return {
    name, race: raceLabel, background, alignment, xp: num(text(input, 'experience')),
    classes, abilities, saveProf, skillProf,
    hp: { current: hpMax, max: hpMax, temp: 0 }, hitDice: { total: level, used: 0, die: hitDie },
    features,
    spellcasting: { ability: castAbility, slots, spells },
    inventory, coins,
    quickActions: eqText && !inventory.length ? eqText : '',
    bio: {
      appearance: bioParts.join(' · '),
      backstory: text(input, 'backstory'),
      allies: input?.querySelector('organization > allies')?.textContent?.trim() || '',
      traits: text(input, 'background-traits'), ideals: text(input, 'background-ideals'),
      bonds: text(input, 'background-bonds'), flaws: text(input, 'background-flaws'),
    },
    portrait: portrait ? `data:image/${portrait.startsWith('/9j/') ? 'jpeg' : 'png'};base64,${portrait}` : '',
    warnings,
  };
}


// Merge a freshly parsed Aurora file into an existing character (spec §4.1). Returns a new object.
export function mergeAurora(existing, imported) {
  const out = JSON.parse(JSON.stringify(existing));
  const lvl = (c) => (c.classes || []).reduce((s, k) => s + (Number(k.level) || 0), 0);
  const oldLevel = Math.max(1, lvl(existing)); const newLevel = Math.max(1, lvl(imported));
  for (const k of ['race', 'classes', 'background', 'alignment', 'abilities', 'saveProf', 'skillProf']) out[k] = JSON.parse(JSON.stringify(imported[k] ?? out[k]));
  if (imported.alignment === '' && existing.alignment) out.alignment = existing.alignment;
  if (imported.background === '' && existing.background) out.background = existing.background;
  out.features = JSON.parse(JSON.stringify(imported.features || []));
  const oldSpells = existing.spellcasting?.spells || [];
  const byName = new Map(oldSpells.map((s) => [String(s.name).toLowerCase(), s]));
  out.spellcasting = out.spellcasting || { ability: 'int', slots: {}, spells: [] };
  out.spellcasting.ability = imported.spellcasting?.ability || out.spellcasting.ability;
  out.spellcasting.spells = (imported.spellcasting?.spells || []).map((s) => {
    const old = byName.get(String(s.name).toLowerCase());
    return old ? { ...s, id: old.id, prepared: old.prepared, conc: old.conc, notes: old.notes || s.notes } : s;
  });
  const slots = {};
  for (const [k, v] of Object.entries(imported.spellcasting?.slots || {})) {
    const used = Math.min(existing.spellcasting?.slots?.[k]?.used || 0, v.max);
    slots[k] = { ...v, used };
  }
  out.spellcasting.slots = slots;
  out.hitDice = { total: imported.hitDice?.total ?? out.hitDice.total, die: imported.hitDice?.die ?? out.hitDice.die, used: Math.min(existing.hitDice?.used || 0, imported.hitDice?.total ?? out.hitDice.total) };
  out.xp = Math.max(Number(existing.xp) || 0, Number(imported.xp) || 0);
  if (imported.portrait) out.portrait = imported.portrait;
  const gained = newLevel - oldLevel;
  if (gained > 0) {
    const con = Math.floor(((Number(out.abilities.con) || 10) - 10) / 2);
    const perLevel = Math.floor((out.hitDice.die || 8) / 2) + 1 + con;
    out.hp.max = (Number(existing.hp?.max) || 0) + gained * perLevel;
    out.hp.current = Math.min(out.hp.max, (Number(existing.hp?.current) || 0) + gained * perLevel);
  }
  for (const k of ['appearance', 'backstory', 'allies', 'traits', 'ideals', 'bonds', 'flaws']) {
    if (!existing.bio?.[k] && imported.bio?.[k]) out.bio[k] = imported.bio[k];
  }
  out.source = 'aurora';
  return out;
}
