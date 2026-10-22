// Pure 5e maths. No DOM, no storage.
import { SKILLS, CLASSES, FULL_CASTER_SLOTS, HALF_CASTER_SLOTS, PACT_SLOTS } from './data/srd.js';

export const abilityMod = (score) => Math.floor(((Number(score) || 0) - 10) / 2);

export const fmtMod = (n) => (n >= 0 ? `+${n}` : `${n}`);

export const totalLevel = (classes = []) =>
  classes.reduce((sum, c) => sum + (Number(c.level) || 0), 0);

export const proficiencyBonus = (level) => {
  const l = Math.max(1, Math.min(20, Number(level) || 1));
  return 2 + Math.floor((l - 1) / 4);
};

export const charLevel = (ch) => Math.max(1, totalLevel(ch.classes));
export const charProf = (ch) => proficiencyBonus(charLevel(ch)) + (Number(ch.profBonusExtra) || 0);

export const saveBonus = (ch, ability) =>
  abilityMod(ch.abilities[ability]) + (ch.saveProf?.[ability] ? charProf(ch) : 0) +
  (Number(ch.saveBonus?.[ability]) || 0);

// skillProf levels: 0 none, 0.5 half (Jack of All Trades), 1 proficient, 2 expertise
export const profContribution = (prof, level) => {
  if (level === 2) return prof * 2;
  if (level === 1) return prof;
  if (level === 0.5) return Math.floor(prof / 2);
  return 0;
};

export const skillDef = (key) => SKILLS.find((s) => s.key === key);

export const skillBonus = (ch, key) => {
  const def = skillDef(key);
  if (!def) return 0;
  const level = Number(ch.skillProf?.[key]) || 0;
  return abilityMod(ch.abilities[def.ability]) + profContribution(charProf(ch), level) +
    (Number(ch.skillBonus?.[key]) || 0);
};

export const passivePerception = (ch) => 10 + skillBonus(ch, 'perception');

export const initiative = (ch) => abilityMod(ch.abilities.dex) + (Number(ch.initiativeBonus) || 0);

export const castingMod = (ch) => abilityMod(ch.abilities[ch.spellcasting?.ability || 'int']);
export const spellSaveDC = (ch) => 8 + charProf(ch) + castingMod(ch) + (Number(ch.spellDCBonus) || 0);
export const spellAttack = (ch) => charProf(ch) + castingMod(ch) + (Number(ch.spellAttackBonus) || 0);

export const carryingCapacity = (ch) => (Number(ch.abilities.str) || 0) * 15;
export const totalWeight = (inventory = []) =>
  Math.round(inventory.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.weight) || 0), 0) * 100) / 100;

export const attunedCount = (inventory = []) => inventory.filter((i) => i.attuned).length;

export const cycleProf = (level) => {
  // none -> proficient -> expertise -> half -> none
  if (level === 0) return 1;
  if (level === 1) return 2;
  if (level === 2) return 0.5;
  return 0;
};

export const profLabel = (level) =>
  ({ 0: '', 0.5: '½', 1: '●', 2: '◆' })[level] ?? '';

export const hitDieFor = (className) => CLASSES[className]?.hitDie || 8;

// Suggested slot table from class list; returns {1:{max,used},...} or null if not a caster.
export function suggestedSlots(classes = []) {
  let fullLevels = 0; let halfLevels = 0; let pactLevel = 0;
  for (const c of classes) {
    const def = CLASSES[c.name];
    const lvl = Number(c.level) || 0;
    if (!def || !def.caster) continue;
    if (def.caster === 'full') fullLevels += lvl;
    else if (def.caster === 'half') halfLevels += lvl;
    else if (def.caster === 'pact') pactLevel += lvl;
  }
  const slots = {};
  if (fullLevels || halfLevels) {
    // Single-class shortcut; multiclass uses the combined table.
    let row;
    if (fullLevels && !halfLevels) row = FULL_CASTER_SLOTS[fullLevels - 1];
    else if (halfLevels && !fullLevels) row = HALF_CASTER_SLOTS[halfLevels - 1];
    else row = FULL_CASTER_SLOTS[Math.min(20, fullLevels + Math.floor(halfLevels / 2)) - 1];
    (row || []).forEach((n, i) => { if (n) slots[i + 1] = { max: n, used: 0 }; });
  }
  if (pactLevel) {
    const [count, level] = PACT_SLOTS[pactLevel - 1];
    slots.pact = { max: count, used: 0, level };
  }
  return Object.keys(slots).length ? slots : null;
}

export function applyDamage(ch, amount) {
  const dmg = Math.max(0, Number(amount) || 0);
  const hp = { ...ch.hp };
  const fromTemp = Math.min(hp.temp || 0, dmg);
  hp.temp = (hp.temp || 0) - fromTemp;
  hp.current = Math.max(0, hp.current - (dmg - fromTemp));
  return { ...ch, hp };
}

export function applyHealing(ch, amount, maxHp = ch.hp.max) {
  const heal = Math.max(0, Number(amount) || 0);
  const hp = { ...ch.hp, current: Math.min(maxHp, ch.hp.current + heal) };
  return { ...ch, hp };
}

export function shortRest(ch) {
  const features = (ch.features || []).map((f) =>
    f.uses && f.uses.reset === 'short' ? { ...f, uses: { ...f.uses, used: 0 } } : f);
  return { ...ch, features, overrides: expireOverrides(ch.overrides, 'short') };
}

export function longRest(ch) {
  const features = (ch.features || []).map((f) =>
    f.uses && (f.uses.reset === 'short' || f.uses.reset === 'long')
      ? { ...f, uses: { ...f.uses, used: 0 } } : f);
  const slots = {};
  for (const [k, v] of Object.entries(ch.spellcasting?.slots || {})) slots[k] = { ...v, used: 0 };
  const hd = { ...ch.hitDice };
  const regain = Math.max(1, Math.floor((hd.total || 1) / 2));
  hd.used = Math.max(0, (hd.used || 0) - regain);
  const overrides = expireOverrides(ch.overrides, 'long');
  const maxHp = effectiveMaxHp({ ...ch, overrides });
  return {
    ...ch,
    features,
    overrides,
    hp: { ...ch.hp, current: maxHp, temp: 0 },
    hitDice: hd,
    deathSaves: { s: 0, f: 0 },
    exhaustion: Math.max(0, (ch.exhaustion || 0) - 1),
    spellcasting: { ...ch.spellcasting, slots },
  };
}

export function classSummary(ch) {
  const parts = (ch.classes || []).filter((c) => c.name).map((c) =>
    `${c.name}${c.subclass ? ` (${c.subclass})` : ''} ${c.level}`);
  return parts.join(' / ') || 'Level 1';
}

// Feature category: 'active' (needs an action/reaction or has limited uses), 'passive', or
// 'proficiency' (grants proficiencies, training, languages, tools). Explicit f.kind wins.
export const FEATURE_KINDS = [['active', 'Active ability'], ['passive', 'Passive trait'], ['proficiency', 'Proficiency / training']];
export function featureKind(f) {
  if (f.kind && FEATURE_KINDS.some(([k]) => k === f.kind)) return f.kind;
  const t = `${f.name || ''} ${f.text || ''}`.toLowerCase();
  if (!f.uses && /proficien|training|\blanguages?\b|\btools?\b/.test(t)) return 'proficiency';
  if (f.uses || /\b(bonus action|reaction|action)\b|\/(long|short) rest|you can (cast|use|spend|expend)/.test(t)) return 'active';
  return 'passive';
}

// ---------------------------------------------------------------- Overrides (spec §2.2)
// Remove overrides that expire on the given rest ('short' clears short; 'long' clears short + long).
export function expireOverrides(overrides, rest) {
  const list = Array.isArray(overrides) ? overrides : [];
  if (rest === 'long') return list.filter((o) => o.duration !== 'short' && o.duration !== 'long');
  if (rest === 'short') return list.filter((o) => o.duration !== 'short');
  return list;
}

// Effective maximum HP after overrides (base + every hp.max add).
export function effectiveMaxHp(ch) {
  return (Number(ch.hp?.max) || 0) + (ch.overrides || []).filter((o) => o.target === 'hp.max').reduce((s, o) => s + (Number(o.value) || 0), 0);
}

// Return a deep copy of the character with every override applied. `_overridden` maps target -> overrides.
export function applyOverrides(ch) {
  const eff = JSON.parse(JSON.stringify(ch));
  eff._overridden = {};
  eff.abilities ||= {}; eff.hp ||= { current: 0, max: 0, temp: 0 }; eff.saveProf ||= {}; eff.skillProf ||= {};
  eff.spellcasting ||= { ability: 'int', slots: {}, spells: [] }; eff.spellcasting.slots ||= {};
  const note = (key, o) => { (eff._overridden[key] ||= []).push(o); };
  for (const o of Array.isArray(ch.overrides) ? ch.overrides : []) {
    const t = String(o.target || ''); const v = Number(o.value) || 0; let m;
    if ((m = t.match(/^abilities\.(str|dex|con|int|wis|cha)$/))) { eff.abilities[m[1]] = (Number(eff.abilities[m[1]]) || 0) + v; note(t, o); }
    else if (['ac', 'speed', 'initiativeBonus', 'profBonusExtra', 'spellAttackBonus', 'spellDCBonus', 'attackBonus', 'damageBonus'].includes(t)) { eff[t] = (Number(eff[t]) || 0) + v; note(t, o); }
    else if (t === 'hp.max') { eff.hp.max = (Number(eff.hp.max) || 0) + v; note(t, o); }
    else if ((m = t.match(/^saveBonus\.(\w+)$/))) { eff.saveBonus ||= {}; eff.saveBonus[m[1]] = (Number(eff.saveBonus[m[1]]) || 0) + v; note(t, o); }
    else if ((m = t.match(/^skillBonus\.(\w+)$/))) { eff.skillBonus ||= {}; eff.skillBonus[m[1]] = (Number(eff.skillBonus[m[1]]) || 0) + v; note(t, o); }
    else if ((m = t.match(/^saveProf\.(\w+)$/))) { eff.saveProf[m[1]] = true; note(t, o); }
    else if ((m = t.match(/^skillProf\.(\w+)$/))) { eff.skillProf[m[1]] = Number(o.value) || 1; note(t, o); }
    else if ((m = t.match(/^spellSlots\.([1-9])$/))) { const s = eff.spellcasting.slots[m[1]] ||= { max: 0, used: 0 }; s.max = Math.max(0, (Number(s.max) || 0) + v); s.used = Math.min(s.used || 0, s.max); note(t, o); }
  }
  eff.hp.max = Math.max(0, eff.hp.max);
  eff.hp.current = Math.max(0, Math.min(Number(eff.hp.current) || 0, eff.hp.max));
  return eff;
}

export const isOverridden = (eff, key) => !!(eff._overridden && eff._overridden[key]?.length);

// Attack helpers that include the global attack/damage overrides.
export const attackToHit = (eff, a) => (a.toHit == null || a.toHit === '' ? null : Number(a.toHit) + (Number(eff.attackBonus) || 0));
export const attackDamage = (eff, a) => { if (!a.damage) return ''; const b = Number(eff.damageBonus) || 0; return b ? `${a.damage}${b > 0 ? '+' : ''}${b}` : a.damage; };

// Base fields that are locked for Aurora-sourced characters (spec §2.1).
export const BASE_FIELDS = ['abilities', 'saveProf', 'skillProf', 'classes', 'race', 'background', 'alignment'];
export const isLocked = (ch) => ch.source === 'aurora';
