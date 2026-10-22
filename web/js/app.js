// App shell v2: server-backed state, auth, campaigns, polling, settings, command palette.
import * as api from './api.js';
import * as legacyStore from './store.js';
import { authScreen } from './auth.js';
import { render as md } from './markdown.js';
import { h, clear, icon, button, modal, confirmDialog, promptDialog, toast, download, debounce } from './ui.js';
import { renderCharacters, renderSheet, normalizeCharacter, importDialog } from './sheet.js';
import { renderNotes, blankNote } from './notes.js';
import { renderCampaign } from './campaign.js';
import { sophorkeCharacter, seedNotes } from './seed.js';
import { SCHEMES, DEFAULT_SCHEME } from './data/schemes.js';
import { LAYOUTS, DEFAULT_LAYOUT } from './data/layouts.js';
import { SRD_ATTRIBUTION } from './spells.js';

const VIEWS = ['characters', 'sheet', 'notes', 'campaign', 'settings'];
const $ = (sel) => document.querySelector(sel);
const PREFS_KEY = 'tt:prefs';

const state = {
  user: null, campaigns: [], characters: [], notes: [],
  prefs: { scheme: DEFAULT_SCHEME, layout: DEFAULT_LAYOUT, lastCharacterId: null },
  view: 'characters', sheetTab: 'overview', noteId: null, notesFilter: { folder: null, tag: null, query: '' }, noteMode: 'visual', showNoteList: false,
  dirty: new Set(), online: true,
};

// ---------------------------------------------------------------- Prefs (per device)
function loadPrefs() { try { Object.assign(state.prefs, JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')); } catch { /* ignore */ } }
function savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs)); } catch { /* ignore */ } }

// ---------------------------------------------------------------- Save queue (debounced PUTs)
const savers = new Map();
const clean = (rec) => JSON.parse(JSON.stringify(rec, (k, v) => (k.startsWith('_') ? undefined : v)));
function queueSave(kind, rec) {
  rec._v = (rec._v || 0) + 1; state.dirty.add(rec.id);
  clearTimeout(savers.get(rec.id));
  savers.set(rec.id, setTimeout(() => flush(kind, rec), 400));
}
async function flush(kind, rec) {
  savers.delete(rec.id);
  const v = rec._v;
  try {
    const res = await api.put(`/api/${kind}/${rec.id}`, clean(rec));
    if (rec._v === v) { state.dirty.delete(rec.id); for (const k of Object.keys(res)) rec[k] = res[k]; }
    flashSaved(); setOnline(true);
  } catch (e) { setOnline(e.status !== 0); toast(`Save failed: ${e.message}`, 'error', 4000); }
}
async function flushAll() { for (const [id, t] of [...savers]) { clearTimeout(t); const rec = state.characters.find((c) => c.id === id) || state.notes.find((n) => n.id === id); const kind = state.characters.includes(rec) ? 'characters' : 'notes'; if (rec) await flush(kind, rec); } }

let savedTimer;
function flashSaved() { const el = $('#saved-indicator'); if (!el) return; el.classList.add('show'); clearTimeout(savedTimer); savedTimer = setTimeout(() => el.classList.remove('show'), 1200); }
function setOnline(on) { state.online = on; document.querySelectorAll('.sync-dot').forEach((d) => d.classList.toggle('off', !on)); }

// ---------------------------------------------------------------- Context passed to views
const ctx = {
  state,
  get user() { return state.user; },
  campaignById: (id) => state.campaigns.find((c) => c.id === id) || null,
  isDM: (cid) => !!state.campaigns.find((c) => c.id === cid && c.dm_id === state.user?.id),
  liveChars: () => state.characters.filter((c) => !c.deleted).sort((a, b) => (a.owner_id === state.user.id ? 0 : 1) - (b.owner_id === state.user.id ? 0 : 1) || b.updated - a.updated),
  myChars: () => state.characters.filter((c) => !c.deleted && c.owner_id === state.user.id),
  liveNotes: () => state.notes.filter((n) => !n.deleted),
  currentChar: () => state.characters.find((c) => c.id === state.prefs.lastCharacterId && !c.deleted) || null,
  setCurrentChar(id) { state.prefs.lastCharacterId = id; savePrefs(); },

  // characters
  saveChar(ch) { if (ch.owner_id !== state.user.id) return; ch.updated = Date.now(); queueSave('characters', ch); if (state.view === 'characters') render(); renderUtility(); },
  async createChar(data, xml) {
    const body = clean(normalizeCharacter(data)); delete body.id;
    if (xml) body.xml = xml;
    const rec = await api.post('/api/characters', body);
    state.characters.push(rec); render(); return rec;
  },
  async duplicateChar(id) {
    const src = state.characters.find((c) => c.id === id); if (!src) return;
    const copy = clean(src); for (const k of ['id', 'owner_id', 'owner_name', 'campaign_id', 'source', 'has_aurora', 'can_edit', 'can_override', 'updated', 'created', 'deleted']) delete copy[k];
    copy.name = `${src.name} (copy)`;
    try { await ctx.createChar(copy); toast(`Duplicated ${src.name}`, 'success'); } catch (e) { toast(e.message, 'error'); }
  },
  async deleteChar(id) {
    const c = state.characters.find((x) => x.id === id); if (!c) return;
    try { await api.del(`/api/characters/${id}`); c.deleted = Date.now(); } catch (e) { toast(e.message, 'error'); return; }
    if (state.prefs.lastCharacterId === id) { state.prefs.lastCharacterId = ctx.myChars()[0]?.id || null; savePrefs(); }
    toast('Moved to trash'); render();
  },
  async restoreChar(id) { const r = await api.post(`/api/characters/${id}/restore`); const c = state.characters.find((x) => x.id === id); if (c) Object.assign(c, r); render(); },
  async purgeChar(id) { await api.del(`/api/characters/${id}/purge`); state.characters = state.characters.filter((x) => x.id !== id); render(); },
  async saveOverrides(ch, overrides) { const r = await api.put(`/api/characters/${ch.id}/overrides`, { overrides }); if (!state.dirty.has(ch.id)) Object.assign(ch, r); else ch.overrides = r.overrides; renderUtility(); },
  async assignCampaign(ch, campaign_id) { const r = await api.put(`/api/characters/${ch.id}/campaign`, { campaign_id }); Object.assign(ch, { campaign_id: r.campaign_id, updated: r.updated }); render(); },
  async reimportAurora(ch, data, xml) { await flushAll(); const r = await api.put(`/api/characters/${ch.id}/aurora`, { data: clean(data), xml }); for (const k of Object.keys(ch)) if (!(k in r) && !k.startsWith('_')) delete ch[k]; Object.assign(ch, r); state.dirty.delete(ch.id); render(); },
  downloadAurora(ch) { flushAll().then(() => api.downloadUrl(`/api/characters/${ch.id}/aurora.dnd5e`, `${ch.name}.dnd5e`)); },

  // notes
  findNote: (title) => { const t = String(title || '').trim().toLowerCase(); const all = state.notes.filter((n) => !n.deleted && n.title.toLowerCase() === t); return all.find((n) => n.can_edit) || all[0] || null; },
  saveNote(n) { if (!n.can_edit) return; n.updated = Date.now(); queueSave('notes', n); renderUtility(); },
  async newNote({ title, folder = '', body, characterId = null, campaign_id = null }) {
    const n = blankNote(title, folder, body, characterId); n.campaign_id = campaign_id;
    const rec = await api.post('/api/notes', n); state.notes.push(rec); return rec;
  },
  async deleteNote(id) { const n = state.notes.find((x) => x.id === id); if (!n) return; await api.del(`/api/notes/${id}`); n.deleted = Date.now(); toast('Moved to trash'); },
  async restoreNote(id) { const r = await api.post(`/api/notes/${id}/restore`); const n = state.notes.find((x) => x.id === id); if (n) Object.assign(n, r); render(); },
  async purgeNote(id) { await api.del(`/api/notes/${id}/purge`); state.notes = state.notes.filter((x) => x.id !== id); render(); },
  async openNote(title, { characterId = null, folder = '' } = {}) {
    let n = ctx.findNote(title);
    if (!n) { n = await ctx.newNote({ title, folder, body: `# ${title}\n\n`, characterId }); toast(`Created "${title}"`, 'success'); }
    state.noteId = n.id; state.showNoteList = false; state.notesFilter = { folder: null, tag: null, query: '' };
    ctx.navigate('notes');
  },

  // campaigns
  async createCampaign(name) { const c = await api.post('/api/campaigns', { name }); await ctx.refresh(); render(); return c; },
  async joinCampaign(code) { const c = await api.post('/api/campaigns/join', { code }); await ctx.refresh(); render(); return c; },
  async leaveCampaign(id) { await api.post(`/api/campaigns/${id}/leave`); await ctx.refresh(); render(); },
  async deleteCampaign(id) { await api.del(`/api/campaigns/${id}`); await ctx.refresh(); render(); },
  async removeMember(cid, uid) { await api.post(`/api/campaigns/${cid}/members/${uid}/remove`); await ctx.refresh(); render(); },
  async rotateInvite(cid) { await api.post(`/api/campaigns/${cid}/invite/rotate`); await ctx.refresh(); render(); },
  async renameCampaign(cid, name) { await api.put(`/api/campaigns/${cid}`, { name }); await ctx.refresh(); render(); },

  async refresh(silent = false) { try { const b = await api.get('/api/bootstrap'); mergeBootstrap(b); setOnline(true); return true; } catch (e) { setOnline(e.status !== 0); if (!silent && e.status !== 401) toast(e.message, 'error'); return false; } },
  navigate(view) { if (!VIEWS.includes(view)) return; state.view = view; location.hash = view; render(); },
  setScheme(id) { if (!SCHEMES.some((s) => s.id === id)) return; state.prefs.scheme = id; savePrefs(); applyAppearance(); if (state.view === 'settings') render(); },
  setLayout(id) { if (!LAYOUTS.some((l) => l.id === id)) return; state.prefs.layout = id; savePrefs(); applyAppearance(); if (state.view === 'settings') render(); },
  render: () => render(),
  importJson: async (data) => importBundle(data),
};

// Merge a bootstrap payload into state, keeping local records with unsaved edits.
function mergeBootstrap(b) {
  state.user = b.user; state.campaigns = b.campaigns || [];
  const mergeList = (local, server) => {
    const byId = new Map(local.map((r) => [r.id, r]));
    const out = [];
    for (const s of server) {
      const l = byId.get(s.id);
      if (l && state.dirty.has(s.id)) out.push(l);
      else if (l) { for (const k of Object.keys(l)) if (!(k in s) && !k.startsWith('_')) delete l[k]; Object.assign(l, s); out.push(l); }
      else out.push(s);
    }
    for (const l of local) if (state.dirty.has(l.id) && !server.some((s) => s.id === l.id)) out.push(l);
    return out;
  };
  state.characters = mergeList(state.characters, (b.characters || []).map(normalizeCharacterKeepServer));
  state.notes = mergeList(state.notes, b.notes || []);
}
const normalizeCharacterKeepServer = (c) => ({ ...normalizeCharacter(c), id: c.id, owner_id: c.owner_id, owner_name: c.owner_name, campaign_id: c.campaign_id, source: c.source, has_aurora: c.has_aurora, can_edit: c.can_edit, can_override: c.can_override, updated: c.updated, created: c.created, deleted: c.deleted });

const signature = () => JSON.stringify([state.campaigns.map((c) => [c.id, c.name, c.invite_code, c.members.length]), state.characters.map((c) => [c.id, c.updated, c.campaign_id, (c.overrides || []).length]), state.notes.map((n) => [n.id, n.updated, n.shared, n.campaign_id])]);

async function poll() {
  if (document.hidden) return;
  const cur = ctx.currentChar(); const curNote = state.notes.find((n) => n.id === state.noteId);
  const before = signature(); const ovBefore = JSON.stringify(cur?.overrides || []); const noteUpd = curNote?.updated;
  if (!(await ctx.refresh(true))) return;
  if (signature() === before) return;
  const cur2 = ctx.currentChar(); const note2 = state.notes.find((n) => n.id === state.noteId);
  if (state.view === 'characters' || state.view === 'campaign') render();
  else if (state.view === 'sheet' && cur2 && (cur2.owner_id !== state.user.id || JSON.stringify(cur2.overrides || []) !== ovBefore) && !state.dirty.has(cur2.id)) render();
  else if (state.view === 'notes' && note2 && !note2.can_edit && note2.updated !== noteUpd) render();
  else if (state.view === 'notes' && !note2 && state.noteId) { state.noteId = null; render(); }
  renderUtility();
}

// ---------------------------------------------------------------- Appearance
const schemeIndex = () => Math.max(0, SCHEMES.findIndex((s) => s.id === state.prefs.scheme));
const layoutIndex = () => Math.max(0, LAYOUTS.findIndex((l) => l.id === state.prefs.layout));
function applyAppearance() {
  const scheme = SCHEMES[schemeIndex()] || { id: DEFAULT_SCHEME };
  const layout = LAYOUTS[layoutIndex()] || { id: DEFAULT_LAYOUT };
  document.documentElement.dataset.scheme = scheme.id;
  const app = document.getElementById('app'); if (app) app.dataset.layout = layout.id;
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  const tc = document.querySelector('meta[name="theme-color"]');
  if (tc && bg) tc.setAttribute('content', bg);
}
function cycleLayout() { const i = (layoutIndex() + 1) % LAYOUTS.length; ctx.setLayout(LAYOUTS[i].id); toast(`Layout ${i + 1}: ${LAYOUTS[i].name}`); }
function cycleScheme() { const i = (schemeIndex() + 1) % SCHEMES.length; ctx.setScheme(SCHEMES[i].id); toast(`Colour ${i + 1}: ${SCHEMES[i].name}`); }

// ---------------------------------------------------------------- Render
function render() {
  const header = $('#header'); const main = $('#main');
  document.getElementById('app').dataset.view = state.view;
  document.querySelectorAll('.rail-btn[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
  main.scrollTop = 0;
  if (state.view === 'characters') renderCharacters(ctx, header, main);
  else if (state.view === 'sheet') renderSheet(ctx, header, main);
  else if (state.view === 'notes') renderNotes(ctx, header, main);
  else if (state.view === 'campaign') renderCampaign(ctx, header, main);
  else renderSettings(header, main);
  renderUtility();
}

function renderUtility() {
  const u = $('#utility'); if (!u) return;
  clear(u);
  const tabs = h('div', { class: 'pane-tabs' }, h('button', { class: 'active' }, 'Linked notes'), h('span', { class: `sync-dot${state.online ? '' : ' off'}`, title: state.online ? 'Connected' : 'Server unreachable', style: { margin: 'auto 12px' } }));
  const body = h('div', { class: 'pane-body' });
  const ch = ctx.currentChar();
  if (!ch) body.append(h('div', { class: 'empty' }, 'Select a character to see its notes.'));
  else {
    const own = ch.owner_id === state.user.id;
    const linked = ctx.liveNotes().filter((n) => n.characterId === ch.id || n.body.includes(`[[${ch.name}]]`) || n.title === ch.name).sort((a, b) => b.updated - a.updated);
    body.append(h('div', { class: 'row between', style: { padding: '4px 8px' } }, h('b', {}, ch.name), own ? button('Hub note', { class: 'btn small ghost', onClick: () => ctx.openNote(ch.name, { characterId: ch.id, folder: 'Characters' }) }, 'book') : h('small', { class: 'muted' }, ch.owner_name)));
    if (!linked.length) body.append(h('div', { class: 'empty' }, own ? 'No notes mention this character yet.' : 'No notes you can see mention this character.'));
    for (const n of linked) body.append(h('button', { class: 'backlink', onClick: () => { state.noteId = n.id; state.showNoteList = false; ctx.navigate('notes'); } }, h('b', {}, n.title), h('small', {}, `${n.can_edit ? (n.folder || 'Notes') : n.owner_name} · ${new Date(n.updated).toLocaleDateString()}`)));
  }
  u.append(tabs, body);
}

// ---------------------------------------------------------------- Settings
function renderSettings(header, main) {
  clear(header); clear(main);
  header.append(h('h1', {}, 'Settings'));
  const wrap = h('div', { class: 'settings' });

  wrap.append(h('div', { class: 'card' }, h('h3', {}, 'Account'),
    h('p', { class: 'muted' }, `Signed in as `, h('b', {}, state.user.username), '. Your characters, notes and Aurora files are stored on this server.'),
    h('div', { class: 'row' },
      button('Change password', { class: 'btn', onClick: () => modal({ title: 'Change password', body: (el) => {
        el.append(h('label', { class: 'field' }, h('span', {}, 'Current password'), h('input', { type: 'password', id: 'pw-cur', autocomplete: 'current-password' })),
          h('label', { class: 'field' }, h('span', {}, 'New password (8+ characters)'), h('input', { type: 'password', id: 'pw-new', autocomplete: 'new-password' })));
      }, actions: [{ label: 'Cancel' }, { label: 'Change', primary: true, onClick: async () => { try { await api.put('/api/auth/password', { current: $('#pw-cur').value, new: $('#pw-new').value }); toast('Password changed', 'success'); } catch (e) { toast(e.message, 'error'); return false; } } }] }) }),
      button('Sign out', { class: 'btn danger', onClick: async () => { await flushAll(); try { await api.post('/api/auth/logout'); } catch { /* ignore */ } location.reload(); } }))));

  wrap.append(h('div', { class: 'card' }, h('h3', {}, 'Command palette'),
    h('p', { class: 'muted' }, 'Jump to any note or character, switch layout or colour scheme, or run a command. Also available from the Search button in the nav, or with Ctrl+K / Ctrl+/.'),
    button('Open command palette', { class: 'btn primary', id: 'open-palette-btn', onClick: () => openPalette() }, 'search')));

  wrap.append(h('div', { class: 'card' }, h('h3', {}, 'Layout'),
    h('p', { class: 'muted' }, 'How the shell is arranged on this device. Layouts are numbered in order; Ctrl+Shift+L steps through them.'),
    h('div', { class: 'tile-grid layouts' }, LAYOUTS.map(layoutTile))));
  wrap.append(h('div', { class: 'card' }, h('h3', {}, 'Colour scheme'),
    h('p', { class: 'muted' }, 'Ten palettes, numbered in order; Ctrl+Shift+C steps through them.'),
    h('div', { class: 'tile-grid schemes' }, SCHEMES.map(schemeTile)),
    h('p', { class: 'appearance-caption' }, `Layout ${layoutIndex() + 1} (${LAYOUTS[layoutIndex()]?.name || '—'}) · Colour ${schemeIndex() + 1} (${SCHEMES[schemeIndex()]?.name || '—'})`)));

  const legacyBtn = button('Import this browser\'s old local data', { class: 'btn', hidden: true, onClick: async () => {
    try { const [chars, notes] = await Promise.all([legacyStore.getAll('characters'), legacyStore.getAll('notes')]); const rep = await importBundle({ app: 'tome-and-table', characters: chars.filter((c) => !c.deleted), notes: notes.filter((n) => !n.deleted) }); toast(`Imported ${rep.characters} characters, ${rep.notes} notes from this browser`, 'success'); } catch (e) { toast(e.message, 'error'); }
  } }, 'upload');
  legacyStore.getAll('characters').then((c) => { if (c.length) legacyBtn.hidden = false; }).catch(() => {});
  wrap.append(h('div', { class: 'card' }, h('h3', {}, 'Backup & import'),
    h('p', { class: 'muted' }, 'Export your own characters and notes as a JSON file. Importing creates copies in your account; Aurora .dnd5e files become locked characters.'),
    h('div', { class: 'row' },
      button('Export my data', { class: 'btn primary', onClick: () => download(`tome-and-table-${state.user.username}-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(exportBundle(), null, 2)) }, 'download'),
      button('Import file (JSON or Aurora .dnd5e)', { class: 'btn', onClick: () => importDialog(ctx) }, 'upload'),
      legacyBtn,
      button('Add sample character (Sophorke)', { class: 'btn ghost', onClick: async () => { try { const ch = await ctx.createChar(sophorkeCharacter()); for (const n of seedNotes(ch.id)) { const { id, ...body } = n; const rec = await api.post('/api/notes', body); state.notes.push(rec); } toast('Sophorke and her notes added', 'success'); render(); } catch (e) { toast(e.message, 'error'); } } }))));

  // Aurora content: descriptions for imported features and non-SRD spells
  const auroraCard = h('div', { class: 'card' }, h('h3', {}, 'Aurora content'),
    h('p', { class: 'muted' }, 'A .dnd5e file only names your features; their descriptions live in Aurora Builder\'s content files. Upload that folder once and every import (and "Fill descriptions" on the Features tab) gets the full text, usage counters and homebrew spell descriptions. Everyone on this server shares the uploaded content.'),
    h('p', { class: 'muted' }, 'On Windows the folder is ', h('code', {}, 'Documents\\5e Character Builder\\custom'), '. Pick the whole folder; only the .xml files are read, in your browser, and only descriptions are sent to the server.'));
  const stats = h('div', { class: 'owner-line' }, 'Checking…');
  const progress = h('div', { class: 'muted', style: { minHeight: '1.2em' } });
  const refreshStats = () => import('./auroraContent.js').then((m) => m.contentStats()).then((s) => { stats.textContent = s.count ? `${s.count} element descriptions stored from ${s.sources} source(s), last upload ${s.updated ? new Date(s.updated).toLocaleString() : '—'}.` : 'No Aurora content uploaded yet.'; }).catch(() => { stats.textContent = ''; });
  refreshStats();
  const runUpload = async (files) => {
    if (!files || !files.length) return;
    const m = await import('./auroraContent.js');
    progress.textContent = 'Reading files…';
    try {
      const r = await m.uploadFiles(files, (p) => { progress.textContent = `File ${p.file} of ${p.files}: ${p.name} · ${p.parsed} elements parsed, ${p.stored} stored`; });
      progress.textContent = `Done: ${r.files} files, ${r.parsed} elements parsed, ${r.stored} stored${r.failed ? `, ${r.failed} files skipped` : ''}.`;
      toast(`Aurora content uploaded (${r.total} descriptions on the server)`, 'success', 4000);
      refreshStats();
    } catch (e) { progress.textContent = ''; toast(`Upload failed: ${e.message}`, 'error', 5000); }
  };
  const folderInput = h('input', { type: 'file', webkitdirectory: '', multiple: '', hidden: true });
  folderInput.addEventListener('change', () => runUpload(folderInput.files));
  const filesInput = h('input', { type: 'file', accept: '.xml', multiple: '', hidden: true });
  filesInput.addEventListener('change', () => runUpload(filesInput.files));
  auroraCard.append(stats, h('div', { class: 'row', style: { marginTop: '8px' } },
    button('Upload Aurora content folder', { class: 'btn primary', id: 'aurora-folder-btn', onClick: () => folderInput.click() }, 'upload'),
    button('Upload .xml files', { class: 'btn', onClick: () => filesInput.click() }, 'upload'), folderInput, filesInput), progress);
  wrap.append(auroraCard);

  if (installPrompt) wrap.append(h('div', { class: 'card' }, h('h3', {}, 'Install'), h('p', { class: 'muted' }, 'Add Tome & Table to your shelf / home screen for a full-screen experience.'), button('Install app', { class: 'btn primary', onClick: async () => { installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; render(); } })));

  const trashC = state.characters.filter((c) => c.deleted && c.owner_id === state.user.id); const trashN = state.notes.filter((n) => n.deleted && n.can_edit);
  const trash = h('div', { class: 'card' }, h('h3', {}, `Trash (${trashC.length + trashN.length})`), h('p', { class: 'muted' }, 'Items are removed for good after 30 days.'));
  for (const c of trashC) trash.append(h('div', { class: 'list-item' }, h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, c.name), h('div', { class: 'li-sub' }, 'Character')), h('div', { class: 'li-actions' }, button('Restore', { class: 'btn small', onClick: () => ctx.restoreChar(c.id).catch((e) => toast(e.message, 'error')) }), button('', { class: 'icon-btn small', title: 'Delete forever', onClick: async () => { if (await confirmDialog(`Permanently delete ${c.name}?`)) ctx.purgeChar(c.id).catch((e) => toast(e.message, 'error')); } }, 'trash'))));
  for (const n of trashN) trash.append(h('div', { class: 'list-item' }, h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, n.title), h('div', { class: 'li-sub' }, 'Note')), h('div', { class: 'li-actions' }, button('Restore', { class: 'btn small', onClick: () => ctx.restoreNote(n.id).catch((e) => toast(e.message, 'error')) }), button('', { class: 'icon-btn small', title: 'Delete forever', onClick: async () => { if (await confirmDialog(`Permanently delete "${n.title}"?`)) ctx.purgeNote(n.id).catch((e) => toast(e.message, 'error')); } }, 'trash'))));
  wrap.append(trash);

  wrap.append(h('div', { class: 'card' }, h('h3', {}, 'Keyboard shortcuts'),
    h('div', { class: 'md', html: md('| Keys | Action |\n|---|---|\n| Ctrl+K or Ctrl+/ | Command palette (also the Search button in the nav) |\n| Ctrl+N | New note |\n| Ctrl+E | Toggle visual / markdown note editing |\n| Ctrl+1..5 | Party / Sheet / Notes / Campaign / Settings |\n| Ctrl+Shift+L | Next layout |\n| Ctrl+Shift+C | Next colour scheme |') })));

  wrap.append(h('div', { class: 'card' }, h('h3', {}, 'About'),
    h('p', { class: 'muted' }, 'Tome & Table · self-hosted D&D 5e character sheets and campaign notebook.'),
    h('p', { class: 'srd-attrib' }, SRD_ATTRIBUTION)));
  main.append(wrap);
}

function layoutTile(l, i) {
  const active = i === layoutIndex();
  return h('button', { type: 'button', class: `tile${active ? ' active' : ''}`, 'aria-pressed': active ? 'true' : 'false', onClick: () => ctx.setLayout(l.id) },
    h('span', { class: 'tile-preview', html: l.preview, 'aria-hidden': 'true' }),
    h('span', { class: 'tile-head' }, h('b', {}, `${i + 1}. ${l.name}`), active ? h('span', { class: 'tile-chip' }, 'Selected') : null),
    h('small', { class: 'tile-desc' }, l.description));
}
function schemeTile(s, i) {
  const active = i === schemeIndex();
  const swatch = h('span', { class: 'tile-swatch', 'aria-hidden': 'true' }, ['bg', 'surface', 'accent', 'text'].map((k) => h('i', { style: { background: s.swatch?.[k] || 'transparent' } })));
  return h('button', { type: 'button', class: `tile${active ? ' active' : ''}`, 'aria-pressed': active ? 'true' : 'false', onClick: () => ctx.setScheme(s.id) },
    swatch, h('span', { class: 'tile-head' }, h('b', {}, `${i + 1}. ${s.name}`), h('span', { class: 'tile-tag' }, s.dark ? 'dark' : 'light'), active ? h('span', { class: 'tile-chip' }, 'Selected') : null),
    h('small', { class: 'tile-desc' }, s.description));
}

// ---------------------------------------------------------------- Export / import bundles
function exportBundle() {
  const mine = (r) => r.owner_id === state.user.id && !r.deleted;
  return { app: 'tome-and-table', version: 2, exportedAt: new Date().toISOString(), characters: state.characters.filter(mine).map(clean), notes: state.notes.filter((n) => n.can_edit && !n.deleted).map(clean) };
}
async function importBundle(data) {
  if (!data || data.app !== 'tome-and-table') throw new Error('Not a Tome & Table export');
  const idMap = new Map(); let chars = 0; let notes = 0;
  for (const c of data.characters || []) {
    if (!c || typeof c.name !== 'string') continue;
    const body = clean(normalizeCharacter(c)); const oldId = c.id;
    for (const k of ['id', 'owner_id', 'owner_name', 'campaign_id', 'source', 'has_aurora', 'can_edit', 'can_override', 'updated', 'created', 'deleted']) delete body[k];
    const rec = await api.post('/api/characters', body); state.characters.push(rec); chars++; if (oldId) idMap.set(oldId, rec.id);
  }
  for (const n of data.notes || []) {
    if (!n || typeof n.title !== 'string') continue;
    const body = { title: n.title, folder: n.folder || '', body: n.body || '', tags: n.tags || [], characterId: idMap.get(n.characterId) || null, campaign_id: null, shared: false };
    const rec = await api.post('/api/notes', body); state.notes.push(rec); notes++;
  }
  render();
  return { characters: chars, notes };
}

// ---------------------------------------------------------------- Command palette
function openPalette() {
  const input = h('input', { type: 'search', placeholder: 'Jump to a note or character…' });
  const results = h('div', { class: 'results' });
  let items = []; let active = 0;
  const build = () => {
    const q = input.value.trim().toLowerCase();
    const notes = ctx.liveNotes().filter((n) => !q || n.title.toLowerCase().includes(q)).slice(0, 12).map((n) => ({ label: n.title, sub: n.can_edit ? (n.folder || 'Note') : `${n.owner_name}'s note`, go: () => { state.noteId = n.id; state.showNoteList = false; ctx.navigate('notes'); } }));
    const chars = ctx.liveChars().filter((c) => !q || c.name.toLowerCase().includes(q)).map((c) => ({ label: c.name, sub: c.owner_id === state.user.id ? 'Character' : `${c.owner_name}'s character`, go: () => { ctx.setCurrentChar(c.id); ctx.navigate('sheet'); } }));
    const cmds = [['New note', () => document.dispatchEvent(new CustomEvent('tt:newnote'))], ['Campaigns', () => ctx.navigate('campaign')], ['Sign out', async () => { await flushAll(); await api.post('/api/auth/logout').catch(() => {}); location.reload(); }], ...LAYOUTS.map((l) => [`Layout: ${l.name}`, () => ctx.setLayout(l.id)]), ...SCHEMES.map((s) => [`Colour: ${s.name}`, () => ctx.setScheme(s.id)]), ['Export my data', () => download('tome-and-table.json', JSON.stringify(exportBundle(), null, 2))]]
      .filter(([l]) => q && l.toLowerCase().includes(q)).map(([l, go]) => ({ label: l, sub: 'Command', go }));
    if (q && !notes.some((n) => n.label.toLowerCase() === q)) cmds.unshift({ label: `Create note "${input.value.trim()}"`, sub: 'New', go: () => ctx.openNote(input.value.trim()) });
    items = [...chars, ...notes, ...cmds]; active = 0; draw();
  };
  const draw = () => { clear(results); items.forEach((it, i) => results.append(h('button', { class: `result${i === active ? ' active' : ''}`, onClick: () => { it.go(); m.close(); } }, icon(/character/i.test(it.sub) ? 'users' : it.sub === 'Command' || it.sub === 'New' ? 'chevron' : 'notes', 16), it.label, h('small', {}, it.sub)))); };
  input.addEventListener('input', build);
  input.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); draw(); e.preventDefault(); } if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); draw(); e.preventDefault(); } if (e.key === 'Enter' && items[active]) { items[active].go(); m.close(); } });
  const m = modal({ title: 'Jump to', body: (el) => { el.append(input, results); } });
  m.box.classList.add('palette');
  build();
}

// ---------------------------------------------------------------- Boot
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; if (state.view === 'settings') render(); });

async function seedWelcome() {
  const body = `# Welcome to Tome & Table

Your characters and notes live on this server under your account.

## Getting started
1. **Party → Import Aurora / JSON** and choose your Aurora Builder \`.dnd5e\` file. Ability scores, proficiencies and slots are locked to the file; use **Overrides** on the sheet for magic items, spells and rulings, and **Download .dnd5e** after a session to level up in Aurora.
2. **Campaign → New campaign** if you run the game, or **Join with code** with the code from your DM. Assign your character to the campaign in the sheet's details dialog.
3. Notes are edited right here, in the rendered view. Use the toolbar for headings, lists and links. [[Another note]] links are created when you click them.

## Who sees what
- The DM reads every sheet and every note in the campaign and can tick **Share with players** on their own notes.
- Players read each other's sheets but never each other's notes.
- Only you can edit your sheet.
`;
  const rec = await api.post('/api/notes', { ...blankNote('Welcome to Tome & Table', '', body), tags: [] });
  state.notes.push(rec);
}

async function boot() {
  loadPrefs(); applyAppearance();
  document.querySelectorAll('[data-icon]').forEach((el) => el.append(icon(el.dataset.icon, 22)));
  document.querySelectorAll('.rail-btn[data-view]').forEach((b) => b.addEventListener('click', () => ctx.navigate(b.dataset.view)));
  document.querySelectorAll('[data-action="palette"]').forEach((b) => b.addEventListener('click', () => openPalette()));

  let b = null;
  for (let attempt = 0; attempt < 3 && !b; attempt++) {
    try { b = await api.get('/api/bootstrap'); }
    catch (e) {
      if (e.status === 401) { await authScreen(); }
      else { document.body.insertAdjacentHTML('afterbegin', `<div class="banner" style="margin:12px">Cannot reach the Tome &amp; Table server (${e.message}). Start it and reload.</div>`); return; }
    }
  }
  if (!b) return;
  mergeBootstrap(b);
  if (!state.notes.length && !state.characters.length) { try { await seedWelcome(); } catch { /* ignore */ } }
  if (!state.prefs.lastCharacterId || !ctx.currentChar()) { state.prefs.lastCharacterId = ctx.myChars()[0]?.id || ctx.liveChars()[0]?.id || null; savePrefs(); }

  const hashView = location.hash.replace('#', '');
  state.view = VIEWS.includes(hashView) ? hashView : (ctx.currentChar() ? 'sheet' : 'characters');
  window.addEventListener('hashchange', () => { const v = location.hash.replace('#', ''); if (VIEWS.includes(v) && v !== state.view) { state.view = v; render(); } });

  document.addEventListener('keydown', (e) => {
    const inField = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '') || document.activeElement?.isContentEditable;
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'l') { e.preventDefault(); cycleLayout(); }
    else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'c') { e.preventDefault(); cycleScheme(); }
    else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'k' || e.key === '/')) { e.preventDefault(); openPalette(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); document.dispatchEvent(new CustomEvent('tt:newnote')); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e' && state.view === 'notes') { e.preventDefault(); state.noteMode = state.noteMode === 'visual' ? 'markdown' : 'visual'; render(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); flushAll().then(() => toast('Saved', 'success')); }
    else if ((e.ctrlKey || e.metaKey) && /^[1-5]$/.test(e.key) && !inField) { e.preventDefault(); ctx.navigate(VIEWS[Number(e.key) - 1]); }
  });
  document.addEventListener('tt:newnote', async () => { const n = await ctx.newNote({ title: 'Untitled', folder: state.notesFilter.folder || '' }); state.noteId = n.id; state.showNoteList = false; ctx.navigate('notes'); setTimeout(() => $('.editor-head input.title')?.select(), 50); });
  document.addEventListener('tt:unauthorized', async () => { if (document.getElementById('auth-screen')) return; toast('Session expired. Please sign in again.', 'error'); await authScreen(); await ctx.refresh(); render(); });
  window.addEventListener('beforeunload', () => { if (state.dirty.size) flushAll(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  setInterval(poll, 20000);

  render();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
}

boot().catch((e) => { console.error(e); document.body.insertAdjacentHTML('afterbegin', `<div class="banner" style="margin:12px">Failed to start: ${e.message}</div>`); });
