// Character vault + character sheet views (v2: permissions, locked base stats, overrides, Aurora round-trip, spell info).
import { ABILITIES, SKILLS, CONDITIONS, CLASSES, ALIGNMENTS, COIN_KEYS } from './data/srd.js';
import { overrideTargets, targetByKey, describeOverride, DURATIONS, DURATION_LABEL } from './data/overrides.js';
import * as R from './rules.js';
import { render as md } from './markdown.js';
import { h, clear, icon, button, modal, confirmDialog, promptDialog, toast, field, numInput, textInput, textArea, select, download, readFile, debounce } from './ui.js';
import { parseAurora, mergeAurora } from './aurora.js';
import { loadSpells, findSpell, searchSpells, spellSummary, spellMarkdown, SRD_ATTRIBUTION } from './spells.js';
import { resolveCharacter, lookupSpell, spellSummaryFromMeta } from './auroraContent.js';

const TABS = [['overview', 'Overview'], ['actions', 'Actions'], ['spells', 'Spells'], ['inventory', 'Inventory'], ['features', 'Features'], ['bio', 'Bio']];
const uid = () => Math.random().toString(36).slice(2, 10);

export function blankCharacter(name = 'New adventurer') {
  const now = Date.now();
  return {
    name, pronouns: '', race: '', classes: [{ name: 'Fighter', level: 1, subclass: '' }], background: '', alignment: '', xp: 0, inspiration: false,
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, saveProf: {}, skillProf: {}, skillNotes: {},
    hp: { current: 10, max: 10, temp: 0 }, hitDice: { total: 1, used: 0, die: 10 }, deathSaves: { s: 0, f: 0 },
    ac: 10, acNote: '', speed: 30, speedUnit: 'ft', initiativeBonus: 0, conditions: [], exhaustion: 0,
    senses: '', defenses: '', languages: 'Common', otherProficiencies: '',
    attacks: [], quickActions: '', spellcasting: { ability: 'int', slots: {}, spells: [] },
    inventory: [], coins: { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 }, features: [], overrides: [],
    bio: { appearance: '', backstory: '', allies: '', traits: '', ideals: '', bonds: '', flaws: '' },
    portrait: '', created: now, updated: now, deleted: null,
  };
}

// Fill any fields missing from older/imported records.
export function normalizeCharacter(c) {
  const b = blankCharacter();
  const out = { ...b, ...c };
  for (const k of ['abilities', 'saveProf', 'skillProf', 'skillNotes', 'hp', 'hitDice', 'deathSaves', 'coins', 'bio']) out[k] = { ...b[k], ...(c[k] || {}) };
  out.spellcasting = { ...b.spellcasting, ...(c.spellcasting || {}) };
  out.spellcasting.slots = out.spellcasting.slots || {}; out.spellcasting.spells = out.spellcasting.spells || [];
  for (const k of ['attacks', 'inventory', 'features', 'conditions', 'classes', 'overrides']) out[k] = Array.isArray(c[k]) ? c[k] : b[k];
  if (!out.classes.length) out.classes = b.classes;
  return out;
}

const initials = (name) => (name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
function avatar(ch, small = false) {
  const a = h('div', { class: `avatar${small ? ' small' : ''}` });
  if (ch.portrait) a.append(h('img', { src: ch.portrait, alt: '' })); else a.append(initials(ch.name));
  return a;
}

function permissions(ctx, ch) {
  const owner = ch.owner_id === ctx.user.id;
  const dm = !!(ch.campaign_id && ctx.isDM(ch.campaign_id));
  return { owner, dm, canEdit: owner, canEditBase: owner && !R.isLocked(ch), canOverride: owner || dm, canDownload: (owner || dm) && !!ch.has_aurora, locked: R.isLocked(ch) };
}

// ---------------------------------------------------------------- Vault
export function renderCharacters(ctx, header, main) {
  clear(header); clear(main);
  header.append(
    h('h1', {}, 'Party'),
    h('div', { class: 'row', style: { marginLeft: 'auto' } },
      button('Import Aurora / JSON', { class: 'btn', onClick: () => importDialog(ctx) }, 'upload'),
      button('New character', { class: 'btn primary', onClick: async () => {
        const name = await promptDialog('New character', '', { label: 'Character name', okLabel: 'Create' });
        if (name == null) return;
        try { const ch = await ctx.createChar(blankCharacter(name.trim() || 'New adventurer')); ctx.setCurrentChar(ch.id); ctx.navigate('sheet'); } catch (e) { toast(e.message, 'error'); }
      } }, 'plus')),
  );
  const chars = ctx.liveChars();
  const mine = chars.filter((c) => c.owner_id === ctx.user.id);
  const others = chars.filter((c) => c.owner_id !== ctx.user.id);
  if (!chars.length) { main.append(h('div', { class: 'empty' }, 'No characters yet. Import your Aurora Builder .dnd5e file, or create one by hand.')); return; }

  const section = (title, list, hint) => {
    const wrap = h('div', { class: 'stack', style: { marginBottom: '18px' } }, h('div', { class: 'row between' }, h('h3', {}, title), hint ? h('small', { class: 'muted' }, hint) : null));
    const grid = h('div', { class: 'grid auto' });
    for (const ch of list) grid.append(charCard(ctx, ch));
    if (!list.length) grid.append(h('div', { class: 'empty', style: { gridColumn: '1 / -1' } }, 'Nothing here yet.'));
    wrap.append(grid); return wrap;
  };
  main.append(section('My characters', mine));
  const byCamp = {};
  for (const ch of others) (byCamp[ch.campaign_id] ||= []).push(ch);
  for (const [cid, list] of Object.entries(byCamp)) {
    const camp = ctx.campaignById(cid);
    main.append(section(camp ? `${camp.name}` : 'Campaign', list, ctx.isDM(cid) ? 'You are the DM: full view' : 'Other players: read-only'));
  }
}

function charCard(ctx, ch) {
  const own = ch.owner_id === ctx.user.id;
  const maxHp = R.effectiveMaxHp(ch);
  const pct = maxHp ? Math.min(100, Math.round((ch.hp.current / maxHp) * 100)) : 0;
  const camp = ctx.campaignById(ch.campaign_id);
  return h('div', { class: `card char-card${ctx.state.prefs.lastCharacterId === ch.id ? ' active' : ''}`, tabindex: 0, role: 'button',
    onClick: () => { ctx.setCurrentChar(ch.id); ctx.navigate('sheet'); },
    onKeydown: (e) => { if (e.key === 'Enter') { ctx.setCurrentChar(ch.id); ctx.navigate('sheet'); } } },
    avatar(ch),
    h('div', { class: 'grow' },
      h('div', { class: 'row between' }, h('h3', {}, ch.name),
        own ? h('div', { class: 'row', style: { gap: '0' } },
          button('', { class: 'icon-btn small', title: 'Export JSON', onClick: (e) => { e.stopPropagation(); download(`${ch.name}.json`, JSON.stringify({ app: 'tome-and-table', version: 2, characters: [ch], notes: [] }, null, 2)); } }, 'download'),
          button('', { class: 'icon-btn small', title: 'Duplicate', onClick: (e) => { e.stopPropagation(); ctx.duplicateChar(ch.id); } }, 'copy'),
          button('', { class: 'icon-btn small', title: 'Delete', onClick: async (e) => { e.stopPropagation(); if (await confirmDialog(`Move ${ch.name} to the trash?`)) ctx.deleteChar(ch.id); } }, 'trash'))
          : h('span', { class: 'badge ro' }, ch.owner_name)),
      h('div', { class: 'muted' }, [ch.race, R.classSummary(ch)].filter(Boolean).join(' · ')),
      h('div', { class: 'hpbar' }, h('i', { style: { width: `${pct}%` } })),
      h('small', {}, `HP ${ch.hp.current}/${maxHp}${ch.hp.temp ? ` (+${ch.hp.temp})` : ''} · AC ${R.applyOverrides(ch).ac}`, camp ? ` · ${camp.name}` : '', ch.source === 'aurora' ? ' · Aurora' : '')));
}

export function importDialog(ctx) {
  modal({
    title: 'Import',
    body: (el, close) => {
      el.append(
        h('p', {}, 'Aurora Builder saves (.dnd5e) become a new, locked character whose base statistics come from the file. Tome & Table exports (.json) are merged into your account.'),
        button('Choose file…', { class: 'btn primary', onClick: async () => {
          const f = await readFile('.dnd5e,.xml,.json');
          if (!f) return;
          try {
            if (/\.(dnd5e|xml)$/i.test(f.name) || f.text.trim().startsWith('<') || f.text.trim().startsWith('﻿<')) {
              const parsed = parseAurora(f.text);
              const { warnings, ...rest } = parsed;
              const data = normalizeCharacter(rest);
              let resolved = null;
              try { resolved = await resolveCharacter(data); } catch (e) { console.warn('Aurora content lookup failed', e); }
              if (resolved && resolved.missing && !resolved.filled) warnings.push('No feature descriptions found. Upload Aurora\'s content folder in Settings → Aurora content, then use "Fill descriptions" on the Features tab.');
              else if (resolved && resolved.missing) warnings.push(`${resolved.missing} feature(s) have no description in the uploaded Aurora content.`);
              const ch = await ctx.createChar(data, f.text);
              ctx.setCurrentChar(ch.id); close();
              modal({ title: `Imported ${ch.name}`, body: h('div', {}, h('p', {}, `Imported from Aurora${resolved?.filled ? ` with ${resolved.filled} feature description(s)` : ''}. Base statistics are now locked to the file; use Overrides for in-play changes. Please check:`), h('ul', { class: 'warn-list' }, warnings.map((w) => h('li', {}, w)))),
                actions: [{ label: 'Open sheet', primary: true, onClick: () => ctx.navigate('sheet') }] });
            } else {
              const report = await ctx.importJson(JSON.parse(f.text));
              close(); toast(`Imported ${report.characters} character(s), ${report.notes} note(s)`, 'success');
            }
          } catch (e) { toast(`Import failed: ${e.message}`, 'error', 5000); }
        } }, 'upload'));
    },
  });
}

// ---------------------------------------------------------------- Sheet
export function renderSheet(ctx, header, main) {
  clear(header); clear(main);
  const ch = ctx.currentChar();
  if (!ch) {
    header.append(h('h1', {}, 'Character sheet'));
    main.append(h('div', { class: 'empty' }, 'No character selected. ', button('Go to Party', { class: 'btn primary', onClick: () => ctx.navigate('characters') })));
    return;
  }
  const perm = permissions(ctx, ch);
  const eff = R.applyOverrides(ch);
  const save = (rerender = false) => { if (!perm.canEdit) return; ch.updated = Date.now(); ctx.saveChar(ch); if (rerender) renderSheet(ctx, header, main); else renderHeader(); };
  const rerender = () => renderSheet(ctx, header, main);
  const ov = (key, el) => { if (R.isOverridden(eff, key)) { el.classList.add('ov'); el.title = (eff._overridden[key] || []).map(describeOverride).join('\n'); } return el; };

  // ---- header
  const renderHeader = () => {
    clear(header);
    const effNow = R.applyOverrides(ch);
    const wrap = h('div', { class: 'sheet-head' });
    const nameInput = h('input', { class: 'title', value: ch.name, 'aria-label': 'Character name' });
    nameInput.addEventListener('input', debounce(() => { ch.name = nameInput.value; save(); }, 400));
    const camp = ctx.campaignById(ch.campaign_id);
    const badges = h('div', { class: 'row', style: { gap: '6px' } },
      h('span', { class: 'muted' }, [ch.race, R.classSummary(ch), ch.background].filter(Boolean).join(' · ')),
      button('', { class: 'icon-btn small', title: perm.canEdit ? 'Edit details' : 'Details', 'data-ro-ok': '', onClick: () => detailsModal(ctx, ch, perm, () => save(true)) }, 'edit'),
      !perm.owner ? h('span', { class: 'badge ro' }, `${ch.owner_name}${perm.dm ? ' · DM view' : ' · read-only'}`) : null,
      perm.locked ? h('span', { class: 'badge lock', title: 'Base statistics come from Aurora Builder' }, icon('lock', 12), 'Aurora') : null,
      camp ? h('span', { class: 'badge' }, camp.name) : null,
      h('span', { class: 'saved', id: 'saved-indicator' }, 'Saved'));
    wrap.append(avatar(ch), h('div', { class: 'sheet-title' }, nameInput, badges));

    const vitals = h('div', { class: 'vitals' });
    const acIn = numInput(ch.ac, (v) => { ch.ac = v; save(); }, { title: ch.acNote || 'Armour class' });
    vitals.append(ov('ac', h('div', { class: 'vital' }, R.isOverridden(effNow, 'ac') ? h('b', {}, effNow.ac) : acIn, h('span', {}, 'AC'))));
    const init = R.initiative(effNow);
    vitals.append(ov('initiativeBonus', h('div', { class: 'vital' }, h('b', {}, R.fmtMod(init)), h('span', {}, 'Init'))));
    const spIn = numInput(ch.speed, (v) => { ch.speed = v; save(); });
    vitals.append(ov('speed', h('div', { class: 'vital' }, R.isOverridden(effNow, 'speed') ? h('b', {}, effNow.speed) : spIn, h('span', {}, `Speed ${ch.speedUnit || 'ft'}`))));
    vitals.append(ov('profBonusExtra', h('div', { class: 'vital' }, h('b', {}, R.fmtMod(R.charProf(effNow))), h('span', {}, 'Prof'))));
    vitals.append(h('div', { class: 'vital' }, h('b', {}, R.passivePerception(effNow)), h('span', {}, 'Pass. Perc')));
    const insp = button('', { class: `chip${ch.inspiration ? ' on' : ''}`, title: 'Inspiration', onClick: () => { ch.inspiration = !ch.inspiration; save(); } }, 'star');
    insp.append('Insp');
    vitals.append(h('div', { class: 'vital', style: { justifyContent: 'center' } }, insp));

    // HP block (current/temp on the base record; max may carry an override)
    const effMax = effNow.hp.max;
    const cur = numInput(ch.hp.current, (v) => { ch.hp.current = Math.max(0, Math.min(v, effMax)); save(); }, { class: 'hp-cur', 'aria-label': 'Current HP' });
    const max = numInput(ch.hp.max, (v) => { ch.hp.max = Math.max(0, v); ch.hp.current = Math.min(ch.hp.current, R.effectiveMaxHp(ch)); save(); }, { class: 'hp-max', 'aria-label': 'Max HP' });
    const temp = numInput(ch.hp.temp, (v) => { ch.hp.temp = Math.max(0, v); save(); }, { class: 'hp-temp', 'aria-label': 'Temporary HP' });
    const adjust = async (sign) => {
      const v = await promptDialog(sign > 0 ? 'Heal' : 'Damage', '', { label: 'Amount', okLabel: sign > 0 ? 'Heal' : 'Apply' });
      if (v == null || v === '') return;
      const amt = Math.abs(Number(v)) || 0;
      Object.assign(ch, sign > 0 ? R.applyHealing(ch, amt, R.effectiveMaxHp(ch)) : R.applyDamage(ch, amt));
      save();
      if (ch.hp.current === 0) toast(`${ch.name} is down!`, 'error');
    };
    const maxEl = R.isOverridden(effNow, 'hp.max') ? ov('hp.max', h('b', { class: 'hp-max', style: { display: 'inline-grid', placeItems: 'center' } }, effMax)) : max;
    vitals.append(h('div', { class: 'hp-block' },
      button('', { class: 'icon-btn', title: 'Damage', onClick: () => adjust(-1) }, 'minus'),
      h('label', {}, cur, 'HP'), h('span', { class: 'muted' }, '/'), h('label', {}, maxEl, 'Max'), h('label', {}, temp, 'Temp'),
      button('', { class: 'icon-btn', title: 'Heal', onClick: () => adjust(1) }, 'plus')));

    vitals.append(button('Short rest', { class: 'btn small', onClick: () => { Object.assign(ch, R.shortRest(ch)); toast('Short rest taken', 'success'); save(true); } }, 'bed'));
    vitals.append(button('Long rest', { class: 'btn small', onClick: async () => { if (await confirmDialog('Take a long rest? HP, slots, long-rest features and temporary overrides reset.', { okLabel: 'Rest', danger: false })) { Object.assign(ch, R.longRest(ch)); toast('Long rest taken', 'success'); save(true); } } }, 'bed'));
    const ovCount = (ch.overrides || []).length;
    if (perm.canOverride) { vitals.append(button('Overrides', { class: `btn small${ovCount ? ' active' : ''}`, 'data-ro-ok': '', title: 'Temporary and permanent modifiers', onClick: () => overridesModal(ctx, ch, perm, rerender) }, 'settings')); if (ovCount) vitals.append(h('span', { class: 'ov-count', style: { alignSelf: 'center' } }, ovCount)); }
    if (perm.owner) vitals.append(button('Update from Aurora', { class: 'btn small ghost', title: 'Re-import an updated .dnd5e (after levelling up)', onClick: () => reimportDialog(ctx, ch, rerender) }, 'upload'));
    if (perm.canDownload) vitals.append(button('Download .dnd5e', { class: 'btn small ghost', 'data-ro-ok': '', title: 'Aurora file with XP, coins and bio written back', onClick: () => ctx.downloadAurora(ch) }, 'download'));
    wrap.append(vitals);

    const cond = h('div', { class: 'row', style: { width: '100%', gap: '6px' } });
    for (const c of ch.conditions) cond.append(h('span', { class: 'chip danger' }, c, button('', { class: 'icon-btn small', style: { width: '22px', height: '22px' }, 'aria-label': `Remove ${c}`, onClick: () => { ch.conditions = ch.conditions.filter((x) => x !== c); save(); } }, 'x')));
    if (ch.exhaustion) cond.append(h('span', { class: 'chip danger' }, `Exhaustion ${ch.exhaustion}`));
    cond.append(button('Conditions', { class: 'btn small ghost', onClick: () => conditionsModal(ch, () => save()) }, 'plus'));
    if (perm.locked && perm.owner) cond.append(h('span', { class: 'lock-hint' }, icon('lock', 12), 'Ability scores, proficiencies and slot maxima come from Aurora. Use Overrides or re-import.'));
    wrap.append(cond);
    header.append(wrap);
    applyPermissions(header, perm);
  };
  renderHeader();

  // ---- tabs
  const tabs = h('div', { class: 'tabs', role: 'tablist', 'data-ro-ok': '' });
  for (const [key, label] of TABS) tabs.append(h('button', { class: `tab${ctx.state.sheetTab === key ? ' active' : ''}`, role: 'tab', 'data-ro-ok': '', onClick: () => { ctx.state.sheetTab = key; renderSheet(ctx, header, main); } }, label));
  main.append(tabs);
  if (!perm.owner) main.append(h('div', { class: 'ro-banner', style: { marginBottom: '12px' } }, icon('eye', 16), h('span', {}, `${ch.owner_name}'s character. ${perm.dm ? 'As the DM you can read everything and add overrides.' : 'Read-only view.'}`)));
  const body = h('div', { class: 'stack', style: { gap: '14px' } });
  main.append(body);
  const t = ctx.state.sheetTab;
  const a = { ctx, ch, eff, body, save, perm, ov };
  if (t === 'overview') overviewTab(a);
  else if (t === 'actions') actionsTab(a);
  else if (t === 'spells') spellsTab(a);
  else if (t === 'inventory') inventoryTab(a);
  else if (t === 'features') featuresTab(a);
  else bioTab(a);
  applyPermissions(main, perm);
}

// Disable what the viewer may not change. Buttons marked data-ro-ok stay usable.
function applyPermissions(root, perm) {
  if (!perm.canEdit) {
    root.classList.add('sheet-readonly');
    root.querySelectorAll('input, select, textarea').forEach((el) => { el.disabled = true; });
    root.querySelectorAll('button').forEach((b) => { if (!b.hasAttribute('data-ro-ok') && !b.closest('[data-ro-ok]')) b.disabled = true; });
  } else if (perm.locked) {
    root.querySelectorAll('[data-base]').forEach((el) => { el.disabled = true; el.title = 'Set by Aurora Builder. Change it there and use "Update from Aurora", or add an override.'; });
  }
}

// ---------------------------------------------------------------- Overview
function overviewTab({ ctx, ch, eff, body, save, perm, ov }) {
  const abil = h('div', { class: 'abilities' });
  for (const a of ABILITIES) {
    const mod = R.abilityMod(eff.abilities[a.key]);
    const sv = R.saveBonus(eff, a.key);
    const modEl = ov(`abilities.${a.key}`, h('div', { class: 'ab-mod', title: `${a.label} modifier` }, R.fmtMod(mod)));
    const score = numInput(eff.abilities[a.key], (v) => { ch.abilities[a.key] = v; save(true); }, { class: 'ab-score', 'aria-label': `${a.label} score`, 'data-base': '' });
    const prof = button(eff.saveProf[a.key] ? '●' : '', { class: `prof-toggle${eff.saveProf[a.key] ? ' on' : ''}`, title: 'Toggle save proficiency', 'data-base': '', onClick: () => { ch.saveProf[a.key] = !ch.saveProf[a.key]; save(true); } });
    const saveEl = ov(`saveBonus.${a.key}`, h('b', {}, R.fmtMod(sv)));
    abil.append(h('div', { class: 'card ability' }, h('div', { class: 'ab-name' }, a.label), modEl, score, h('div', { class: 'ab-save' }, ov(`saveProf.${a.key}`, prof), 'Save ', saveEl)));
  }
  body.append(abil);

  const grid = h('div', { class: 'grid cols-2' });
  const skillsCard = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Skills'), h('small', {}, '● proficient · ◆ expertise · ½ half')));
  const list = h('div', { class: 'skills' });
  for (const s of SKILLS) {
    const lvl = Number(eff.skillProf[s.key]) || 0;
    const bonus = R.skillBonus(eff, s.key);
    const tog = button(R.profLabel(lvl), { class: `prof-toggle${lvl ? ' on' : ''}`, title: 'Cycle proficiency', 'data-base': '', onClick: () => { ch.skillProf[s.key] = R.cycleProf(lvl); save(true); } });
    const rl = ov(`skillBonus.${s.key}`, h('span', { class: 'sk-val' }, R.fmtMod(bonus)));
    const note = ch.skillNotes?.[s.key];
    list.append(h('div', { class: 'skill' }, ov(`skillProf.${s.key}`, tog), h('span', { class: 'sk-name' }, s.label, ' ', h('span', { class: 'sk-ab' }, s.ability), note ? h('div', { class: 'sk-note' }, note) : null), rl));
  }
  skillsCard.append(list);
  grid.append(skillsCard);

  const right = h('div', { class: 'stack' });
  const hd = ch.hitDice;
  const hdPips = h('div', { class: 'pips' });
  for (let i = 0; i < (hd.total || 0); i++) hdPips.append(h('button', { class: `pip${i < hd.used ? ' used' : ''}`, title: 'Toggle hit die', onClick: () => { hd.used = i < hd.used ? i : i + 1; save(true); } }));
  const conMod = R.abilityMod(eff.abilities.con);
  const hdSpend = button(`Spend one (d${hd.die}${R.fmtMod(conMod)})`, { class: 'btn small', onClick: async () => {
    if (hd.used >= hd.total) { toast('No hit dice left', 'error'); return; }
    const v = await promptDialog('Spend a hit die', '', { label: `HP regained (roll d${hd.die} ${R.fmtMod(conMod)} Con)`, okLabel: 'Heal' });
    if (v == null || v === '') return;
    hd.used++; Object.assign(ch, R.applyHealing(ch, Math.max(0, Number(v) || 0), R.effectiveMaxHp(ch))); save(true);
  } });
  const ds = ch.deathSaves;
  const dsRow = (key, cls, label) => { const p = h('div', { class: 'pips' }); for (let i = 0; i < 3; i++) p.append(h('button', { class: `pip ${cls}${i < ds[key] ? ' used' : ''}`, onClick: () => { ds[key] = i < ds[key] ? i : i + 1; save(true); } })); return h('div', { class: 'row' }, h('span', { style: { minWidth: '80px' } }, label), p); };
  right.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', {}, 'Hit dice'), h('div', { class: 'row' }, h('small', {}, `${hd.total - hd.used} of ${hd.total} left`),
      button('', { class: 'icon-btn small', title: 'Edit hit dice', 'data-base': '', onClick: () => editModal('Hit dice', [{ key: 'total', label: 'Total', type: 'number' }, { key: 'used', label: 'Used', type: 'number' }, { key: 'die', label: 'Die size', type: 'select', options: [6, 8, 10, 12] }], hd, (v) => { Object.assign(hd, v); hd.die = Number(hd.die); save(true); }) }, 'edit'))),
    h('div', { class: 'row' }, hdPips, hdSpend),
    h('h3', { style: { marginTop: '12px' } }, 'Death saves'), dsRow('s', 'success', 'Successes'), dsRow('f', 'danger', 'Failures'),
    h('div', { class: 'row', style: { marginTop: '6px' } }, button('Reset death saves', { class: 'btn small ghost', onClick: () => { ds.s = 0; ds.f = 0; save(true); } }))));

  const txt = (label, key) => h('div', {}, h('div', { class: 'field' }, h('span', {}, label)), h('div', { class: 'md', html: ch[key] ? md(ch[key]) : '<p class="muted">—</p>' }));
  right.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', {}, 'Senses, defenses & proficiencies'), button('', { class: 'icon-btn small', title: 'Edit', onClick: () => editModal('Senses, defenses & proficiencies', [
      { key: 'senses', label: 'Senses', type: 'text' }, { key: 'defenses', label: 'Defenses / resistances', type: 'textarea' },
      { key: 'languages', label: 'Languages', type: 'text' }, { key: 'otherProficiencies', label: 'Other proficiencies', type: 'textarea' }, { key: 'acNote', label: 'AC note', type: 'text' },
    ], ch, (v) => { Object.assign(ch, v); save(true); }) }, 'edit')),
    h('div', { class: 'stack' }, txt('Senses', 'senses'), txt('Defenses', 'defenses'), txt('Languages', 'languages'), txt('Proficiencies', 'otherProficiencies'))));

  // Active overrides summary
  const ovs = ch.overrides || [];
  if (ovs.length) {
    const card = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, `Active overrides (${ovs.length})`), perm.canOverride ? button('Manage', { class: 'btn small', 'data-ro-ok': '', onClick: () => overridesModal(ctx, ch, perm, () => save(true)) }, 'settings') : null));
    for (const o of ovs) card.append(h('div', { class: 'list-item' }, h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, describeOverride(o), h('span', { class: `ov-dur ${o.duration}` }, DURATION_LABEL[o.duration] || o.duration)), o.note ? h('div', { class: 'li-sub' }, o.note) : null)));
    right.append(card);
  }
  grid.append(right);
  body.append(grid);
}

// ---------------------------------------------------------------- Actions
const ATTACK_FIELDS = [
  { key: 'name', label: 'Name', type: 'text' }, { key: 'toHit', label: 'To hit bonus (blank for saves)', type: 'number' },
  { key: 'damage', label: 'Damage (e.g. 1d8+2)', type: 'text' }, { key: 'damageType', label: 'Damage type', type: 'text' }, { key: 'notes', label: 'Notes', type: 'textarea' },
];
function actionsTab({ ctx, ch, eff, body, save, ov }) {
  const card = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Attacks'), button('Add attack', { class: 'btn small', onClick: () => editModal('New attack', ATTACK_FIELDS, { name: '', toHit: R.charProf(eff) + R.abilityMod(eff.abilities.str), damage: '1d8', damageType: '', notes: '' }, (v) => { ch.attacks.push({ id: uid(), ...v }); save(true); }) }, 'plus')));
  if (!ch.attacks.length) card.append(h('div', { class: 'empty' }, 'No attacks yet.'));
  for (const a of ch.attacks) {
    const hit = R.attackToHit(eff, a);
    const hitEl = hit == null ? h('span', { class: 'muted' }, 'save') : ov('attackBonus', h('b', {}, R.fmtMod(hit)));
    const dmg = R.attackDamage(eff, a);
    const dmgEl = dmg ? ov('damageBonus', h('b', {}, dmg)) : h('span', { class: 'muted' }, '—');
    card.append(h('div', { class: 'list-item' },
      h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, a.name, h('span', { class: 'chip' }, 'Hit ', hitEl), h('span', { class: 'chip' }, 'Dmg ', dmgEl, a.damageType ? h('small', {}, ` ${a.damageType}`) : null)), a.notes ? h('div', { class: 'li-sub' }, a.notes) : null),
      h('div', { class: 'li-actions' },
        button('', { class: 'icon-btn small', title: 'Edit', onClick: () => editModal('Edit attack', ATTACK_FIELDS, a, (v) => { Object.assign(a, v); save(true); }) }, 'edit'),
        button('', { class: 'icon-btn small', title: 'Delete', onClick: () => { ch.attacks = ch.attacks.filter((x) => x !== a); save(true); } }, 'trash'))));
  }
  body.append(card);
  body.append(mdCard('Quick actions & notes', ch.quickActions, (v) => { ch.quickActions = v; save(); }, ctx));
}

// ---------------------------------------------------------------- Spells
function spellsTab({ ctx, ch, eff, body, save, perm, ov }) {
  const sc = ch.spellcasting;
  const top = h('div', { class: 'card' });
  const abilitySel = select(sc.ability, ABILITIES.map((a) => [a.key, a.label]), (v) => { sc.ability = v; save(true); }, { 'data-base': '' });
  const atk = R.spellAttack(eff);
  top.append(h('div', { class: 'row', style: { gap: '18px' } },
    field('Casting ability', abilitySel),
    ov('spellDCBonus', h('div', { class: 'vital' }, h('b', {}, R.spellSaveDC(eff)), h('span', {}, 'Save DC'))),
    ov('spellAttackBonus', h('div', { class: 'vital' }, h('b', {}, R.fmtMod(atk)), h('span', {}, 'Attack'))),
    h('div', { class: 'vital' }, h('b', {}, R.fmtMod(R.castingMod(eff))), h('span', {}, 'Mod'))));
  const slotWrap = h('div', { style: { marginTop: '12px' } }, h('div', { class: 'card-head' }, h('h3', {}, 'Spell slots'),
    h('div', { class: 'row' },
      button('Suggest from class', { class: 'btn small ghost', 'data-base': '', onClick: () => { const s = R.suggestedSlots(ch.classes); if (!s) { toast('No caster levels found in classes', 'error'); return; } sc.slots = s; save(true); } }),
      button('Edit slots', { class: 'btn small', 'data-base': '', onClick: () => slotsModal(sc, () => save(true)) }, 'edit'))));
  const effSlots = eff.spellcasting.slots;
  const keys = Object.keys(effSlots).filter((k) => effSlots[k]?.max > 0).sort((a, b) => (a === 'pact' ? 1 : b === 'pact' ? -1 : a - b));
  if (!keys.length) slotWrap.append(h('div', { class: 'empty' }, perm.locked ? 'No spell slots in the Aurora file. Add some with an override if needed.' : 'No spell slots. Use "Suggest from class" or "Edit slots".'));
  for (const k of keys) {
    const s = effSlots[k];
    const base = sc.slots[k] || (sc.slots[k] = { max: 0, used: 0 });
    const pips = h('div', { class: 'pips' });
    for (let i = 0; i < s.max; i++) pips.append(h('button', { class: `pip${i < s.used ? ' used' : ''}`, title: 'Toggle slot', onClick: () => { base.used = i < s.used ? i : i + 1; save(true); } }));
    slotWrap.append(h('div', { class: 'slot-row' }, ov(`spellSlots.${k}`, h('b', {}, k === 'pact' ? `Pact (L${s.level})` : ordinal(k))), pips, h('small', { style: { marginLeft: 'auto' } }, `${s.max - s.used}/${s.max}`)));
  }
  top.append(slotWrap);
  body.append(top);

  const listCard = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Spells'), button('Add spell', { class: 'btn small', onClick: () => addSpellDialog(ch, (sp) => { sc.spells.push({ id: uid(), ...sp }); save(true); }) }, 'plus')));
  if (!sc.spells.length) listCard.append(h('div', { class: 'empty' }, 'No spells yet.'));
  const byLevel = {};
  for (const s of sc.spells) (byLevel[s.level] ||= []).push(s);
  for (const lvl of Object.keys(byLevel).sort((a, b) => a - b)) {
    listCard.append(h('h4', { class: 'muted', style: { marginTop: '10px', fontFamily: 'var(--font)', fontSize: '.75rem', textTransform: 'uppercase', letterSpacing: '.1em' } }, lvl === '0' ? 'Cantrips' : `${ordinal(lvl)} level`));
    for (const s of byLevel[lvl].sort((a, b) => a.name.localeCompare(b.name))) {
      const prep = button(s.prepared ? '●' : '', { class: `prof-toggle${s.prepared ? ' on' : ''}`, title: 'Prepared', onClick: () => { s.prepared = !s.prepared; save(true); } });
      const cast = Number(lvl) > 0 ? button('Cast', { class: 'btn small ghost', onClick: () => {
        const slot = effSlots[lvl] || effSlots.pact; const base = sc.slots[lvl] || sc.slots.pact;
        if (!slot || slot.used >= slot.max || !base) { toast('No slot available', 'error'); return; }
        base.used = slot.used + 1; if (s.conc && !ch.conditions.includes('Concentrating')) ch.conditions.push('Concentrating'); toast(`Cast ${s.name}`, 'success'); save(true);
      } }) : null;
      listCard.append(h('div', { class: `list-item${s.prepared ? '' : ' dim'}` }, prep,
        h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, s.name, s.conc ? h('span', { class: 'chip', title: 'Concentration' }, 'C') : null), s.notes ? h('div', { class: 'li-sub md', html: md(s.notes) }) : null),
        h('div', { class: 'li-actions' }, cast,
          button('', { class: 'icon-btn small', title: 'Spell description', 'data-ro-ok': '', onClick: () => spellInfoModal(s) }, 'info'),
          perm.owner ? button('', { class: 'icon-btn small', title: 'Open note', onClick: () => ctx.openNote(s.name, { characterId: ch.id, folder: 'Spells' }) }, 'book') : null,
          button('', { class: 'icon-btn small', title: 'Edit', onClick: () => editModal('Edit spell', SPELL_FIELDS, s, (v) => { Object.assign(s, v, { level: Number(v.level) || 0 }); save(true); }) }, 'edit'),
          button('', { class: 'icon-btn small', title: 'Delete', onClick: () => { sc.spells = sc.spells.filter((x) => x !== s); save(true); } }, 'trash'))));
    }
  }
  body.append(listCard);
  loadSpells().catch(() => {});
}

const SPELL_FIELDS = [
  { key: 'name', label: 'Spell', type: 'text' }, { key: 'level', label: 'Level (0 = cantrip)', type: 'number' },
  { key: 'prepared', label: 'Prepared / known', type: 'checkbox' }, { key: 'conc', label: 'Concentration', type: 'checkbox' }, { key: 'notes', label: 'Your notes (range, components, effect)', type: 'textarea' },
];

async function spellInfoModal(s) {
  try { await loadSpells(); } catch { /* offline: show notes only */ }
  const spell = findSpell(s.name);
  let aurora = null;
  if (!spell) { try { aurora = await lookupSpell(s.name, s.auroraId); } catch { /* no content uploaded */ } }
  modal({ title: s.name, wide: true, body: (el) => {
    if (spell) {
      el.append(h('div', { class: 'spell-meta' }, spellSummary(spell)));
      el.append(h('div', { class: 'md', html: md(spellMarkdown(spell)) }));
    } else if (aurora) {
      el.append(h('div', { class: 'spell-meta' }, spellSummaryFromMeta(aurora.meta)));
      el.append(h('div', { class: 'md', html: md(aurora.desc || '') }));
      el.append(h('p', { class: 'srd-attrib' }, `From your Aurora Builder content (${aurora.source || 'unknown source'}).`));
    } else {
      el.append(h('p', { class: 'muted' }, 'No SRD entry for this spell and nothing in the uploaded Aurora content (Settings → Aurora content). Your own notes are shown below.'));
    }
    if (s.notes) el.append(h('div', { class: 'spell-info-note' }, h('b', {}, 'Your notes'), h('div', { class: 'md', html: md(s.notes) })));
    if (spell) el.append(h('p', { class: 'srd-attrib' }, SRD_ATTRIBUTION));
  }, actions: [{ label: 'Close', primary: true }] });
}

function addSpellDialog(ch, onAdd) {
  const draft = { name: '', level: 1, prepared: true, conc: false, notes: '' };
  loadSpells().catch(() => {});
  modal({ title: 'Add spell', body: (el) => {
    const name = h('input', { type: 'text', placeholder: 'Start typing a spell name…', autocomplete: 'off' });
    const list = h('div', { class: 'ac-list' });
    const level = numInput(draft.level, (v) => { draft.level = v; });
    const conc = h('input', { type: 'checkbox', style: { width: '22px', height: '22px', minHeight: '0' } });
    const prepared = h('input', { type: 'checkbox', checked: true, style: { width: '22px', height: '22px', minHeight: '0' } });
    const notes = textArea('', (v) => { draft.notes = v; }, { rows: 3, placeholder: 'Optional notes' });
    const pick = (sp) => { draft.name = sp.name; draft.level = sp.level; draft.conc = !!sp.concentration; name.value = sp.name; level.value = sp.level; conc.checked = !!sp.concentration; clear(list); };
    name.addEventListener('input', () => {
      draft.name = name.value; clear(list);
      for (const sp of searchSpells(name.value, 8)) list.append(h('button', { class: 'result', onClick: () => pick(sp) }, sp.name, h('small', {}, spellSummary(sp))));
    });
    conc.addEventListener('change', () => { draft.conc = conc.checked; });
    prepared.addEventListener('change', () => { draft.prepared = prepared.checked; });
    el.append(field('Spell', name), list, field('Level (0 = cantrip)', level), h('label', { class: 'row' }, prepared, 'Prepared / known'), h('label', { class: 'row' }, conc, 'Concentration'), field('Your notes', notes));
    setTimeout(() => name.focus(), 30);
  }, actions: [{ label: 'Cancel' }, { label: 'Add', primary: true, onClick: () => { if (!draft.name.trim()) { toast('Enter a spell name', 'error'); return false; } onAdd({ ...draft, name: draft.name.trim(), level: Number(draft.level) || 0 }); } }] });
}

function slotsModal(sc, onDone) {
  const draft = {}; for (let i = 1; i <= 9; i++) draft[i] = sc.slots[i]?.max || 0; draft.pact = sc.slots.pact?.max || 0; draft.pactLevel = sc.slots.pact?.level || 1;
  modal({ title: 'Spell slots', body: (el) => {
    const g = h('div', { class: 'inline-fields' });
    for (let i = 1; i <= 9; i++) g.append(field(ordinal(i), numInput(draft[i], (v) => { draft[i] = v; }, { min: 0 })));
    g.append(field('Pact slots', numInput(draft.pact, (v) => { draft.pact = v; }, { min: 0 })), field('Pact level', numInput(draft.pactLevel, (v) => { draft.pactLevel = v; }, { min: 1, max: 5 })));
    el.append(g);
  }, actions: [{ label: 'Cancel' }, { label: 'Save', primary: true, onClick: () => {
    const slots = {};
    for (let i = 1; i <= 9; i++) if (draft[i] > 0) slots[i] = { max: draft[i], used: Math.min(sc.slots[i]?.used || 0, draft[i]) };
    if (draft.pact > 0) slots.pact = { max: draft.pact, used: Math.min(sc.slots.pact?.used || 0, draft.pact), level: draft.pactLevel };
    sc.slots = slots; onDone();
  } }] });
}

// ---------------------------------------------------------------- Inventory
const ITEM_FIELDS = [
  { key: 'name', label: 'Item', type: 'text' }, { key: 'qty', label: 'Quantity', type: 'number' }, { key: 'weight', label: 'Weight each (lb)', type: 'number', step: 'any' },
  { key: 'equipped', label: 'Equipped', type: 'checkbox' }, { key: 'attuned', label: 'Attuned', type: 'checkbox' }, { key: 'notes', label: 'Notes', type: 'textarea' },
];
function inventoryTab({ ctx, ch, eff, body, save, perm }) {
  const weight = R.totalWeight(ch.inventory); const cap = R.carryingCapacity(eff);
  const coins = h('div', { class: 'row', style: { gap: '8px' } });
  for (const k of COIN_KEYS) coins.append(h('div', { class: 'vital' }, numInput(ch.coins[k], (v) => { ch.coins[k] = v; save(); }, { style: { width: '64px' } }), h('span', {}, k)));
  const pct = cap ? Math.min(100, Math.round((weight / cap) * 100)) : 0;
  body.append(h('div', { class: 'card' }, h('div', { class: 'row between' },
    h('div', {}, h('h3', {}, 'Coins'), coins),
    h('div', { style: { minWidth: '220px' } }, h('h3', {}, 'Encumbrance'),
      h('div', { class: 'muted' }, `${weight} lb (${(weight * 0.4536).toFixed(1)} kg) of ${cap} lb (${(cap * 0.4536).toFixed(1)} kg)`),
      h('div', { class: 'hpbar' }, h('i', { style: { width: `${pct}%`, background: weight > cap ? 'var(--danger)' : 'var(--accent)' } })),
      h('small', {}, `Attuned ${R.attunedCount(ch.inventory)}/3`)))));
  const card = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Items'), button('Add item', { class: 'btn small', onClick: () => editModal('New item', ITEM_FIELDS, { name: '', qty: 1, weight: 0, equipped: false, attuned: false, notes: '' }, (v) => { ch.inventory.push({ id: uid(), ...v }); save(true); }) }, 'plus')));
  if (!ch.inventory.length) card.append(h('div', { class: 'empty' }, 'Empty pack.'));
  for (const it of ch.inventory) {
    const eq = button(it.equipped ? '●' : '', { class: `prof-toggle${it.equipped ? ' on' : ''}`, title: 'Equipped', onClick: () => { it.equipped = !it.equipped; save(true); } });
    card.append(h('div', { class: 'list-item' }, eq,
      h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, it.name, it.qty > 1 ? h('span', { class: 'chip' }, `×${it.qty}`) : null, it.attuned ? h('span', { class: 'chip on' }, 'attuned') : null, h('small', { class: 'muted' }, it.weight ? `${it.weight} lb${it.qty > 1 ? ' each' : ''}` : '')), it.notes ? h('div', { class: 'li-sub' }, it.notes) : null),
      h('div', { class: 'li-actions' },
        perm.owner ? button('', { class: 'icon-btn small', title: 'Open note', onClick: () => ctx.openNote(it.name, { characterId: ch.id, folder: 'Items' }) }, 'book') : null,
        button('', { class: 'icon-btn small', title: 'Edit', onClick: () => editModal('Edit item', ITEM_FIELDS, it, (v) => { Object.assign(it, v); save(true); }) }, 'edit'),
        button('', { class: 'icon-btn small', title: 'Delete', onClick: () => { ch.inventory = ch.inventory.filter((x) => x !== it); save(true); } }, 'trash'))));
  }
  body.append(card);
}

// ---------------------------------------------------------------- Features
const FEATURE_FIELDS = [
  { key: 'name', label: 'Feature', type: 'text' }, { key: 'source', label: 'Source (class, race, feat…)', type: 'text' },
  { key: 'kind', label: 'Category', type: 'select', options: R.FEATURE_KINDS },
  { key: 'usesMax', label: 'Uses (0 = unlimited)', type: 'number' }, { key: 'reset', label: 'Recharges on', type: 'select', options: [['long', 'Long rest'], ['short', 'Short rest'], ['none', 'Never / manual']] },
  { key: 'text', label: 'Description (markdown)', type: 'textarea' },
];
const featToForm = (f) => ({ name: f.name || '', source: f.source || '', kind: f.name ? R.featureKind(f) : 'active', usesMax: f.uses?.max || 0, reset: f.uses?.reset || 'long', text: f.text || '' });
const formToFeat = (v) => ({ name: v.name, source: v.source, kind: v.kind, text: v.text, uses: Number(v.usesMax) > 0 ? { max: Number(v.usesMax), used: 0, reset: v.reset === 'none' ? null : v.reset } : null });

// Which feature descriptions are minimised, remembered per device (viewers of other people's sheets too).
const COLLAPSE_KEY = 'tt:collapsedFeatures';
function collapsedSet() { try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]')); } catch { return new Set(); } }
function saveCollapsed(set) { try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set])); } catch { /* ignore */ } }
const featureKey = (ch, f) => `${ch.id}:${f.id || f.name}`;

function featureItem(ctx, ch, f, save, perm) {
  let uses = null;
  if (f.uses) {
    const pips = h('div', { class: 'pips' });
    for (let i = 0; i < f.uses.max; i++) pips.append(h('button', { class: `pip${i < f.uses.used ? ' used' : ''}`, title: 'Toggle use', onClick: () => { f.uses.used = i < f.uses.used ? i : i + 1; save(true); } }));
    uses = h('span', { class: 'uses' }, pips, h('small', {}, f.uses.reset === 'short' ? 'short rest' : f.uses.reset === 'long' ? 'long rest' : ''));
  }
  const key = featureKey(ch, f);
  const hasText = !!(f.text && f.text.trim());
  const collapsed = hasText && collapsedSet().has(key);
  const desc = hasText ? h('div', { class: 'feature-desc md', id: `fd-${key.replace(/[^\w-]/g, '_')}`, html: md(f.text), hidden: collapsed }) : null;
  const toggle = hasText ? button('', { class: `feature-toggle${collapsed ? ' collapsed' : ''}`, title: collapsed ? 'Show description' : 'Minimise description', 'aria-expanded': collapsed ? 'false' : 'true', 'data-ro-ok': '', onClick: () => {
    const set = collapsedSet(); const now = !desc.hidden;
    desc.hidden = now; toggle.classList.toggle('collapsed', now); toggle.title = now ? 'Show description' : 'Minimise description'; toggle.setAttribute('aria-expanded', now ? 'false' : 'true');
    if (now) set.add(key); else set.delete(key); saveCollapsed(set);
  } }, 'chevron') : h('span', { class: 'feature-toggle spacer' });
  const title = h('div', { class: 'li-title grow' }, f.name, f.source ? h('small', { class: 'muted' }, f.source) : null, uses);
  if (hasText) { title.classList.add('clickable'); title.addEventListener('click', (e) => { if (e.target.closest('.pip')) return; toggle.click(); }); }
  return h('div', { class: 'list-item feature-item' },
    h('div', { class: 'feature-head' }, toggle, title,
    h('div', { class: 'li-actions' },
      select(R.featureKind(f), R.FEATURE_KINDS.map(([k, l]) => [k, l.split(' ')[0]]), (v) => { f.kind = v; save(true); toast(`Moved ${f.name} to ${v}`, 'success'); }, { class: 'move-select', title: 'Move to another section', 'aria-label': `Section for ${f.name}` }),
      perm.owner ? button('', { class: 'icon-btn small', title: 'Open note', onClick: () => ctx.openNote(f.name, { characterId: ch.id, folder: 'Features' }) }, 'book') : null,
      button('', { class: 'icon-btn small', title: 'Edit', onClick: () => editModal('Edit feature', FEATURE_FIELDS, featToForm(f), (v) => { const nf = formToFeat(v); if (nf.uses && f.uses) nf.uses.used = Math.min(f.uses.used, nf.uses.max); Object.assign(f, nf); save(true); }) }, 'edit'),
      button('', { class: 'icon-btn small', title: 'Delete', onClick: () => { ch.features = ch.features.filter((x) => x !== f); save(true); } }, 'trash'))),
    desc);
}

function setAllCollapsed(ctx, ch, collapsed) {
  const set = collapsedSet();
  for (const f of ch.features) { const k = featureKey(ch, f); if (collapsed && f.text) set.add(k); else set.delete(k); }
  saveCollapsed(set);
}

function featuresTab({ ctx, ch, eff, body, save, perm }) {
  const groups = { active: [], passive: [], proficiency: [] };
  for (const f of ch.features) groups[R.featureKind(f)].push(f);
  const addBtn = (kind) => button('Add', { class: 'btn small ghost', title: `Add ${kind} feature`, onClick: () => editModal('New feature', FEATURE_FIELDS, { ...featToForm({}), kind }, (v) => { ch.features.push({ id: uid(), ...formToFeat(v) }); save(true); }) }, 'plus');
  const column = (kind, title, hint) => {
    const card = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('div', {}, h('h3', {}, title), h('small', {}, hint)), addBtn(kind)));
    if (!groups[kind].length) card.append(h('div', { class: 'empty' }, `No ${kind} features.`));
    for (const f of groups[kind]) card.append(featureItem(ctx, ch, f, save, perm));
    return card;
  };
  const rerenderTab = () => { ctx.state.sheetTab = 'features'; ctx.render(); };
  body.append(h('div', { class: 'row', style: { justifyContent: 'flex-end', gap: '6px' } },
    h('small', { class: 'muted' }, 'Descriptions:'),
    button('Expand all', { class: 'btn small ghost', 'data-ro-ok': '', onClick: () => { setAllCollapsed(ctx, ch, false); rerenderTab(); } }),
    button('Minimise all', { class: 'btn small ghost', 'data-ro-ok': '', onClick: () => { setAllCollapsed(ctx, ch, true); rerenderTab(); } }),
    perm.owner && ch.features.some((f) => f.auroraId) ? button('Fill descriptions from Aurora', { class: 'btn small', title: 'Look up every feature\'s description in the uploaded Aurora content', onClick: async () => {
      const overwrite = ch.features.some((f) => f.auroraId && f.text) ? await confirmDialog('Replace descriptions you already have with Aurora\'s text? Choose "Keep mine" to fill only the empty ones.', { okLabel: 'Replace all', danger: false }) : false;
      try {
        const r = await resolveCharacter(ch, { overwrite });
        if (!r.filled && !r.uses) { toast(r.missing ? 'No descriptions found. Upload Aurora\'s content folder in Settings → Aurora content.' : 'Nothing to fill.', 'error', 5000); return; }
        toast(`Filled ${r.filled} description(s)${r.uses ? `, ${r.uses} usage counter(s)` : ''}${r.missing ? `; ${r.missing} not found` : ''}`, 'success', 4000);
        save(true);
      } catch (e) { toast(e.message, 'error'); }
    } }, 'download') : null));
  body.append(h('div', { class: 'grid cols-2' },
    column('active', 'Active abilities', 'Actions, reactions and limited-use powers'),
    column('passive', 'Passive traits', 'Always on; nothing to track')));
  const prof = h('div', { class: 'card' }, h('div', { class: 'card-head' },
    h('div', {}, h('h3', {}, 'Proficiencies & training'), h('small', {}, 'Weapons, armour, tools, languages and skills gained from features')),
    h('div', { class: 'row', style: { gap: '2px' } },
      button('', { class: 'icon-btn small', title: 'Edit languages & proficiencies', onClick: () => editModal('Languages & proficiencies', [
        { key: 'languages', label: 'Languages', type: 'text' }, { key: 'otherProficiencies', label: 'Weapon, armour & tool proficiencies', type: 'textarea' },
      ], ch, (v) => { Object.assign(ch, v); save(true); }) }, 'edit'),
      addBtn('proficiency'))));
  for (const f of groups.proficiency) prof.append(featureItem(ctx, ch, f, save, perm));
  const skillNames = SKILLS.filter((s) => Number(eff.skillProf?.[s.key]) > 0).map((s) => `${s.label}${eff.skillProf[s.key] === 2 ? ' (expertise)' : eff.skillProf[s.key] === 0.5 ? ' (half)' : ''}`);
  const saveNames = ABILITIES.filter((a) => eff.saveProf?.[a.key]).map((a) => a.label);
  const line = (label, value) => value ? h('div', { class: 'list-item' }, h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, label), h('div', { class: 'li-sub md', html: md(value) }))) : null;
  prof.append(line('Saving throws', saveNames.join(', ')), line('Skills', skillNames.join(', ')), line('Languages', ch.languages), line('Weapons, armour & tools', ch.otherProficiencies));
  if (!groups.proficiency.length && !ch.languages && !ch.otherProficiencies) prof.append(h('div', { class: 'empty' }, 'Nothing recorded yet.'));
  body.append(prof);
}

// ---------------------------------------------------------------- Bio
function bioTab({ ctx, ch, body, save }) {
  const b = ch.bio;
  const grid = h('div', { class: 'grid cols-2' });
  grid.append(mdCard('Personality traits', b.traits, (v) => { b.traits = v; save(); }, ctx), mdCard('Ideals', b.ideals, (v) => { b.ideals = v; save(); }, ctx),
    mdCard('Bonds', b.bonds, (v) => { b.bonds = v; save(); }, ctx), mdCard('Flaws', b.flaws, (v) => { b.flaws = v; save(); }, ctx));
  body.append(grid);
  body.append(mdCard('Appearance', b.appearance, (v) => { b.appearance = v; save(); }, ctx));
  body.append(mdCard('Backstory', b.backstory, (v) => { b.backstory = v; save(); }, ctx));
  body.append(mdCard('Allies & organisations', b.allies, (v) => { b.allies = v; save(); }, ctx));
}

function mdCard(title, value, onChange, ctx) {
  let editing = false;
  let current = value || '';
  const card = h('div', { class: 'card' });
  const draw = () => {
    clear(card);
    card.append(h('div', { class: 'card-head' }, h('h3', {}, title), button(editing ? 'Done' : 'Edit', { class: 'btn small ghost', onClick: () => { editing = !editing; draw(); } }, editing ? 'eye' : 'edit')));
    if (editing) card.append(textArea(current, (v) => { current = v; onChange(v); }, { rows: 6, placeholder: 'Markdown. [[Links]] and #tags work here too.' }));
    else {
      const view = h('div', { class: 'md', html: current ? md(current, { resolveLink: (t) => ({ exists: !!ctx.findNote(t) }) }) : '<p class="muted">Nothing yet. Tap Edit.</p>' });
      view.addEventListener('click', (e) => { const a = e.target.closest('a.wikilink'); if (a) { e.preventDefault(); ctx.openNote(a.dataset.title, { characterId: ctx.currentChar()?.id }); } });
      card.append(view);
    }
  };
  draw();
  return card;
}

// ---------------------------------------------------------------- Overrides
function overridesModal(ctx, ch, perm, onDone) {
  const list = (ch.overrides || []).map((o) => ({ ...o }));
  const m = modal({ title: `Overrides — ${ch.name}`, wide: true, body: (el) => {
    const draw = async () => {
      clear(el);
      el.append(h('p', { class: 'muted' }, 'Modifiers on top of the Aurora base sheet: magic items, spells, blessings, curses, house rules. Temporary ones expire on the chosen rest; "until cancelled" and permanent ones stay until removed.'));
      const cur = h('div', { class: 'ov-list' });
      if (!list.length) cur.append(h('div', { class: 'empty' }, 'No overrides yet.'));
      for (const o of list) cur.append(h('div', { class: 'list-item' },
        h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, describeOverride(o), h('span', { class: `ov-dur ${o.duration}` }, DURATION_LABEL[o.duration] || o.duration)), h('div', { class: 'li-sub' }, [o.note, o.createdByName ? `added by ${o.createdByName}` : null].filter(Boolean).join(' · '))),
        h('div', { class: 'li-actions' }, button('', { class: 'icon-btn small', title: 'Remove', onClick: () => { list.splice(list.indexOf(o), 1); commit(); } }, 'trash'))));
      el.append(cur);
      // add form
      const targets = overrideTargets();
      const groups = [...new Set(targets.map((t) => t.group))];
      const tsel = h('select', { 'aria-label': 'What to change' });
      for (const g of groups) { const og = h('optgroup', { label: g }); for (const t of targets.filter((x) => x.group === g)) og.append(h('option', { value: t.key }, t.label)); tsel.append(og); }
      const valueBox = h('div', {});
      const draft = { target: targets[0].key, value: 1, duration: 'manual', note: '' };
      const drawValue = () => {
        clear(valueBox);
        const t = targetByKey(draft.target);
        if (t.mode === 'set') { draft.value = t.values[0][0]; valueBox.append(select(draft.value, t.values, (v) => { draft.value = Number(v); })); }
        else { draft.value = 1; valueBox.append(numInput(1, (v) => { draft.value = v; }, { step: 1, style: { width: '100px' } })); }
      };
      tsel.addEventListener('change', () => { draft.target = tsel.value; drawValue(); });
      drawValue();
      const dsel = select(draft.duration, DURATIONS, (v) => { draft.duration = v; });
      const note = textInput('', (v) => { draft.note = v; }, { placeholder: 'Reason (e.g. Ring of Protection, Bless, DM ruling)' });
      el.append(h('h3', { style: { marginTop: '14px' } }, 'Add an override'),
        h('div', { class: 'inline-fields' }, field('Change', tsel), field('Amount', valueBox), field('Lasts', dsel)),
        field('Note', note),
        h('div', { class: 'row' }, button('Add override', { class: 'btn primary', onClick: () => {
          const t = targetByKey(draft.target);
          list.push({ id: uid(), target: t.key, label: t.label, mode: t.mode, value: Number(draft.value) || 0, duration: draft.duration, note: draft.note.trim(), createdAt: Date.now(), createdBy: ctx.user.id, createdByName: ctx.user.username });
          commit();
        } }, 'plus')));
    };
    const commit = async () => {
      try { await ctx.saveOverrides(ch, list.map(({ ...o }) => o)); toast('Overrides saved', 'success'); draw(); onDone(); }
      catch (e) { toast(e.message, 'error'); }
    };
    draw();
  }, actions: [{ label: 'Close', primary: true }] });
  return m;
}

// ---------------------------------------------------------------- Aurora re-import
function reimportDialog(ctx, ch, onDone) {
  modal({ title: 'Update from Aurora Builder', body: (el, close) => {
    el.append(h('p', {}, 'Choose the updated .dnd5e file. Base statistics, features and spells are replaced from the file; current HP, used slots, conditions, inventory, coins, notes and overrides are kept. If the level went up, maximum HP is raised by the average per level.'),
      button('Choose .dnd5e…', { class: 'btn primary', onClick: async () => {
        const f = await readFile('.dnd5e,.xml'); if (!f) return;
        try {
          const parsed = parseAurora(f.text);
          const { warnings, ...rest } = parsed;
          const merged = mergeAurora(ch, normalizeCharacter(rest));
          try { const r = await resolveCharacter(merged); if (r.missing && !r.filled) warnings.push('No feature descriptions found in the uploaded Aurora content (Settings → Aurora content).'); } catch (e) { console.warn('Aurora content lookup failed', e); }
          await ctx.reimportAurora(ch, merged, f.text);
          close(); toast(`${ch.name} updated from Aurora`, 'success'); onDone();
          if (warnings.length) modal({ title: 'Please check', body: h('ul', { class: 'warn-list' }, warnings.map((w) => h('li', {}, w))), actions: [{ label: 'OK', primary: true }] });
        } catch (e) { toast(`Update failed: ${e.message}`, 'error', 5000); }
      } }, 'upload'));
  } });
}

// ---------------------------------------------------------------- Modals
export function editModal(title, fields, obj, onSave) {
  const draft = {};
  for (const f of fields) draft[f.key] = obj[f.key] ?? (f.type === 'checkbox' ? false : f.type === 'number' ? 0 : '');
  modal({ title, body: (el, close) => {
    for (const f of fields) {
      let input;
      if (f.type === 'number') input = numInput(draft[f.key], (v) => { draft[f.key] = v; }, { step: f.step || 1 });
      else if (f.type === 'textarea') input = textArea(draft[f.key], (v) => { draft[f.key] = v; }, { rows: 4 });
      else if (f.type === 'select') input = select(draft[f.key], f.options, (v) => { draft[f.key] = v; });
      else if (f.type === 'checkbox') { input = h('input', { type: 'checkbox', checked: !!draft[f.key], style: { width: '22px', height: '22px', minHeight: '0' } }); input.addEventListener('change', () => { draft[f.key] = input.checked; }); el.append(h('label', { class: 'row' }, input, f.label)); continue; }
      else { input = h('input', { type: 'text', value: draft[f.key] }); input.addEventListener('input', () => { draft[f.key] = input.value; }); }
      if (f.type === 'number') input.addEventListener('input', () => { draft[f.key] = input.value === '' ? null : Number(input.value); });
      if (f.type === 'textarea') input.addEventListener('input', () => { draft[f.key] = input.value; });
      el.append(field(f.label, input));
    }
  }, actions: [{ label: 'Cancel' }, { label: 'Save', primary: true, onClick: () => onSave(draft) }] });
}

function conditionsModal(ch, onChange) {
  modal({ title: 'Conditions & exhaustion', body: (el) => {
    const wrap = h('div', { class: 'row' });
    for (const c of CONDITIONS) {
      const b = button(c, { class: `chip${ch.conditions.includes(c) ? ' on' : ''}`, onClick: () => { if (ch.conditions.includes(c)) ch.conditions = ch.conditions.filter((x) => x !== c); else ch.conditions.push(c); b.classList.toggle('on'); onChange(); } });
      wrap.append(b);
    }
    el.append(wrap, field('Exhaustion level (0-6)', numInput(ch.exhaustion, (v) => { ch.exhaustion = Math.max(0, Math.min(6, v)); onChange(); }, { min: 0, max: 6 })));
  }, actions: [{ label: 'Done', primary: true }] });
}

function detailsModal(ctx, ch, perm, onDone) {
  const draft = { race: ch.race, background: ch.background, alignment: ch.alignment, xp: ch.xp, pronouns: ch.pronouns || '', speedUnit: ch.speedUnit || 'ft', initiativeBonus: ch.initiativeBonus || 0, portrait: ch.portrait || '' };
  const classes = ch.classes.map((c) => ({ ...c }));
  let campaignId = ch.campaign_id || '';
  const ro = !perm.canEdit;
  const m = modal({ title: ro ? `${ch.name} — details` : 'Character details', wide: true, body: (el) => {
    if (perm.locked || ro) {
      el.append(h('div', { class: 'lock-banner' }, icon('lock', 16), h('span', {}, perm.locked ? 'Race, class, level, background and alignment come from the Aurora file. Use "Update from Aurora" after changing them there.' : 'Read-only.')),
        h('div', { class: 'inline-fields' },
          field('Race / lineage', h('div', {}, ch.race || '—')), field('Classes', h('div', {}, R.classSummary(ch))),
          field('Background', h('div', {}, ch.background || '—')), field('Alignment', h('div', {}, ch.alignment || '—')),
          field('Source', h('div', {}, ch.source === 'aurora' ? 'Aurora Builder' : 'Manual')), field('Owner', h('div', {}, ch.owner_name || '—'))));
    } else {
      el.append(h('div', { class: 'inline-fields' },
        field('Race / lineage', textInput(draft.race, (v) => { draft.race = v; })), field('Background', textInput(draft.background, (v) => { draft.background = v; })),
        field('Alignment', select(draft.alignment, ['', ...ALIGNMENTS], (v) => { draft.alignment = v; }))));
      const clsBox = h('div', { class: 'stack' });
      const drawClasses = () => {
        clear(clsBox);
        clsBox.append(h('h3', {}, 'Classes'));
        classes.forEach((c, i) => {
          clsBox.append(h('div', { class: 'row' },
            select(CLASSES[c.name] ? c.name : '__custom', [...Object.keys(CLASSES).map((k) => [k, k]), ['__custom', 'Custom…']], (v) => { if (v === '__custom') { c.name = ''; drawClasses(); } else c.name = v; }),
            !CLASSES[c.name] ? textInput(c.name, (v) => { c.name = v; }, { placeholder: 'Class name' }) : null,
            numInput(c.level, (v) => { c.level = Math.max(1, Math.min(20, v)); }, { class: 'stat-input', min: 1, max: 20, title: 'Level' }),
            textInput(c.subclass || '', (v) => { c.subclass = v; }, { placeholder: 'Subclass' }),
            classes.length > 1 ? button('', { class: 'icon-btn small', onClick: () => { classes.splice(i, 1); drawClasses(); } }, 'trash') : null));
        });
        clsBox.append(button('Add class (multiclass)', { class: 'btn small ghost', onClick: () => { classes.push({ name: 'Fighter', level: 1, subclass: '' }); drawClasses(); } }, 'plus'));
      };
      drawClasses();
      el.append(clsBox);
    }
    if (!ro) {
      el.append(h('div', { class: 'inline-fields', style: { marginTop: '10px' } },
        field('XP', numInput(draft.xp, (v) => { draft.xp = v; })),
        field('Pronouns', textInput(draft.pronouns, (v) => { draft.pronouns = v; })), field('Speed unit', select(draft.speedUnit, [['ft', 'feet'], ['m', 'metres']], (v) => { draft.speedUnit = v; })),
        field('Initiative bonus (extra)', numInput(draft.initiativeBonus, (v) => { draft.initiativeBonus = v; }))));
      const camps = ctx.state.campaigns;
      el.append(field('Campaign', camps.length ? select(campaignId, [['', 'None'], ...camps.map((c) => [c.id, `${c.name}${c.dm_id === ctx.user.id ? ' (you DM)' : ''}`])], (v) => { campaignId = v; }) : h('small', { class: 'muted' }, 'Join or create a campaign first (Campaign view).'), 'The DM of the campaign can read this sheet; other players see it read-only.'));
      const portraitRow = h('div', { class: 'row' },
        button('Choose portrait…', { class: 'btn small', onClick: () => {
          const input = h('input', { type: 'file', accept: 'image/*' });
          input.addEventListener('change', () => { const f = input.files?.[0]; if (!f) return; const img = new Image(); const url = URL.createObjectURL(f); img.onload = () => { const s = 256; const cv = document.createElement('canvas'); cv.width = s; cv.height = s; const cx = cv.getContext('2d'); const r = Math.max(s / img.width, s / img.height); cx.drawImage(img, (s - img.width * r) / 2, (s - img.height * r) / 2, img.width * r, img.height * r); draft.portrait = cv.toDataURL('image/jpeg', .85); URL.revokeObjectURL(url); toast('Portrait ready; press Save', 'success'); }; img.src = url; });
          input.click();
        } }, 'upload'),
        button('Remove portrait', { class: 'btn small ghost', onClick: () => { draft.portrait = ''; } }));
      el.append(field('Portrait', portraitRow));
    }
  }, actions: ro ? [{ label: 'Close', primary: true }] : [{ label: 'Cancel' }, { label: 'Save', primary: true, onClick: async () => {
    if (!perm.locked) {
      Object.assign(ch, { race: draft.race, background: draft.background, alignment: draft.alignment }); ch.classes = classes.filter((c) => c.name);
      if (!ch.classes.length) ch.classes = [{ name: 'Fighter', level: 1, subclass: '' }];
      const lvl = R.charLevel(ch); if (ch.hitDice.total !== lvl) { ch.hitDice.total = lvl; ch.hitDice.used = Math.min(ch.hitDice.used, lvl); ch.hitDice.die = R.hitDieFor(ch.classes[0].name); }
    }
    Object.assign(ch, { xp: draft.xp, pronouns: draft.pronouns, speedUnit: draft.speedUnit, initiativeBonus: draft.initiativeBonus, portrait: draft.portrait });
    const newCamp = campaignId || null;
    if (newCamp !== (ch.campaign_id || null)) { try { await ctx.assignCampaign(ch, newCamp); } catch (e) { toast(e.message, 'error'); } }
    onDone();
  } }] });
  return m;
}

const ordinal = (n) => { n = Number(n); const s = ['th', 'st', 'nd', 'rd']; const v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
