// Notes: WYSIWYG-first editor, folders, tags, search, backlinks, campaign sharing and read-only views.
import { render as md, extractLinks, extractTags, toggleTask } from './markdown.js';
import { h, clear, icon, button, confirmDialog, promptDialog, toast, select, debounce, todayIso, modal } from './ui.js';
import { createEditor } from './wysiwyg.js';

export function blankNote(title = 'Untitled', folder = '', body = '', characterId = null) {
  const now = Date.now();
  return { title, folder, body: body || `# ${title}\n\n`, tags: extractTags(body || ''), characterId, campaign_id: null, shared: false, created: now, updated: now, deleted: null };
}

const excerpt = (body) => String(body || '').replace(/^#.*$/m, '').replace(/[#*`\[\]>|-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90);

export function renderNotes(ctx, header, main) {
  clear(header); clear(main);
  const st = ctx.state;
  st.notesFilter ||= { folder: null, tag: null, query: '' };
  if (!['visual', 'markdown'].includes(st.noteMode)) st.noteMode = 'visual';
  const notes = ctx.liveNotes();
  let current = notes.find((n) => n.id === st.noteId) || null;
  if (!current && !st.showNoteList) { current = notes.find((n) => n.can_edit) || notes[0] || null; if (current) st.noteId = current.id; }

  header.append(h('h1', {}, 'Notes'),
    h('div', { class: 'row', style: { marginLeft: 'auto' } },
      button('Session note', { class: 'btn', onClick: async () => {
        const ch = ctx.currentChar();
        const n = await ctx.newNote({ title: `Session ${todayIso()}`, folder: 'Sessions', body: `# Session ${todayIso()}\n#session\n\n**Present:** ${ch ? `[[${ch.name}]]` : ''}\n\n## Notes\n- \n\n## Loot / XP\n- \n\n## Next time\n- `, characterId: ch?.id || null, campaign_id: ch?.campaign_id || null });
        st.noteId = n.id; st.showNoteList = false; renderNotes(ctx, header, main);
      } }, 'plus'),
      button('New note', { class: 'btn primary', onClick: async () => {
        const title = await promptDialog('New note', '', { label: 'Title', okLabel: 'Create' }); if (title == null) return;
        const n = await ctx.newNote({ title: title.trim() || 'Untitled', folder: st.notesFilter.folder || '' });
        st.noteId = n.id; st.showNoteList = false; renderNotes(ctx, header, main);
      } }, 'plus')));

  const root = h('div', { class: `notes${st.showNoteList ? ' show-list' : ''}` });
  const refresh = () => renderNotes(ctx, header, main);
  root.append(leftPane(ctx, notes, current, refresh));
  if (current) {
    root.append(editorPane(ctx, current, notes, refresh));
    root.append(rightPane(ctx, current, notes, refresh));
  } else {
    root.append(h('div', { class: 'editor' }, h('div', { class: 'empty', style: { margin: '40px' } }, 'No note selected. Create one with "New note".')));
  }
  main.append(root);
}

// ---------------------------------------------------------------- Left: list
function leftPane(ctx, notes, current, refresh) {
  const st = ctx.state; const f = st.notesFilter;
  const pane = h('div', { class: 'notes-side left' });
  const search = h('input', { type: 'search', placeholder: 'Search notes…', value: f.query });
  search.addEventListener('input', debounce(() => { f.query = search.value; refresh(); }, 250));
  pane.append(h('div', { class: 'pane-head' }, h('div', { class: 'search' }, icon('search', 18), search)));
  const body = h('div', { class: 'pane-body' });

  const q = f.query.trim().toLowerCase();
  const mine = notes.filter((n) => n.can_edit);
  const others = notes.filter((n) => !n.can_edit);
  let shown = notes;
  if (f.folder != null) shown = shown.filter((n) => n.can_edit && (n.folder || '') === f.folder);
  if (f.tag) shown = shown.filter((n) => (n.tags || []).includes(f.tag));
  if (q) shown = shown.filter((n) => n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q));

  if (f.folder != null || f.tag || q) {
    body.append(h('div', { class: 'row', style: { padding: '6px 8px' } }, h('small', {}, `${shown.length} result${shown.length === 1 ? '' : 's'}`), button('Clear', { class: 'btn small ghost', onClick: () => { f.folder = null; f.tag = null; f.query = ''; refresh(); } }, 'x')));
    for (const n of shown.sort((a, b) => b.updated - a.updated)) body.append(noteItem(ctx, n, current, refresh, false, !n.can_edit));
  } else {
    // My notes by folder
    body.append(h('h4', {}, 'My notes'));
    const folders = {};
    for (const n of mine) (folders[n.folder || ''] ||= []).push(n);
    const names = Object.keys(folders).sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
    st.openFolders ||= {};
    if (!mine.length) body.append(h('div', { class: 'muted', style: { padding: '0 8px' } }, h('small', {}, 'No notes yet.')));
    for (const name of names) {
      const open = st.openFolders[name] !== false;
      body.append(h('button', { class: 'tree-item folder', onClick: () => { st.openFolders[name] = !open; refresh(); }, onDblclick: () => { f.folder = name; refresh(); } },
        h('span', { style: { transform: open ? 'rotate(90deg)' : '', display: 'inline-flex', transition: 'transform .15s' } }, icon('chevron', 16)), icon('folder', 16), name || 'Notes', h('span', { class: 'count' }, folders[name].length)));
      if (open) for (const n of folders[name].sort((a, b) => a.title.localeCompare(b.title))) body.append(noteItem(ctx, n, current, refresh, true));
    }
    // Shared by DMs (I am a player)
    const shared = others.filter((n) => n.shared);
    if (shared.length) {
      body.append(h('h4', {}, 'Shared by the DM'));
      const byCamp = {};
      for (const n of shared) (byCamp[n.campaign_id] ||= []).push(n);
      for (const [cid, list] of Object.entries(byCamp)) {
        const camp = ctx.campaignById(cid);
        body.append(h('div', { class: 'tree-item folder', style: { cursor: 'default' } }, icon('link', 16), camp?.name || 'Campaign', h('span', { class: 'count' }, list.length)));
        for (const n of list.sort((a, b) => b.updated - a.updated)) body.append(noteItem(ctx, n, current, refresh, true, true));
      }
    }
    // Players' notes (I am the DM)
    const players = others.filter((n) => !n.shared);
    if (players.length) {
      body.append(h('h4', {}, "Players' notes"));
      const byOwner = {};
      for (const n of players) (byOwner[n.owner_name] ||= []).push(n);
      for (const [who, list] of Object.entries(byOwner).sort()) {
        st.openFolders[`@${who}`] ??= false;
        const open = st.openFolders[`@${who}`];
        body.append(h('button', { class: 'tree-item folder', onClick: () => { st.openFolders[`@${who}`] = !open; refresh(); } },
          h('span', { style: { transform: open ? 'rotate(90deg)' : '', display: 'inline-flex', transition: 'transform .15s' } }, icon('chevron', 16)), icon('users', 16), who, h('span', { class: 'count' }, list.length)));
        if (open) for (const n of list.sort((a, b) => b.updated - a.updated)) body.append(noteItem(ctx, n, current, refresh, true, true));
      }
    }
    // Tags
    const tagCount = {};
    for (const n of notes) for (const t of n.tags || []) tagCount[t] = (tagCount[t] || 0) + 1;
    const tags = Object.keys(tagCount).sort();
    if (tags.length) {
      body.append(h('h4', {}, 'Tags'));
      const wrap = h('div', { class: 'row', style: { padding: '0 8px', gap: '6px' } });
      for (const t of tags) wrap.append(button(`#${t}`, { class: 'chip', onClick: () => { f.tag = t; refresh(); } }), h('small', { class: 'muted' }, tagCount[t]));
      body.append(wrap);
    }
    const trashed = ctx.state.notes.filter((n) => n.deleted && n.can_edit).length;
    if (trashed) body.append(h('h4', {}, 'Trash'), h('button', { class: 'tree-item', onClick: () => ctx.navigate('settings') }, icon('trash', 16), `${trashed} in trash`, h('span', { class: 'count' }, 'Settings')));
  }
  pane.append(body);
  return pane;
}

function noteItem(ctx, n, current, refresh, indent = false, foreign = false) {
  return h('button', { class: `tree-item${indent ? ' indent' : ''}${current && n.id === current.id ? ' active' : ''}`, onClick: () => { ctx.state.noteId = n.id; ctx.state.showNoteList = false; refresh(); } },
    icon(foreign ? 'eye' : 'notes', 16), h('span', { class: 'grow', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, n.title),
    foreign && !indent ? h('span', { class: 'who' }, n.owner_name) : null);
}

// ---------------------------------------------------------------- Centre: editor
function editorPane(ctx, note, notes, refresh) {
  const st = ctx.state;
  const ro = !note.can_edit;
  const pane = h('div', { class: 'editor' });
  const resolveLink = (t) => ({ exists: !!ctx.findNote(t) });
  let rightRefresh = () => {};
  const persist = debounce(() => { note.tags = extractTags(note.body); ctx.saveNote(note); rightRefresh(); }, 350);

  const title = h('input', { class: 'title', value: note.title, 'aria-label': 'Note title', disabled: ro });
  title.addEventListener('input', debounce(() => { note.title = title.value.trim() || 'Untitled'; ctx.saveNote(note); }, 400));
  const folders = [...new Set(ctx.liveNotes().filter((n) => n.can_edit).map((n) => n.folder || ''))].sort();
  const folderSel = ro ? null : select(note.folder || '', [...folders.map((f) => [f, f || 'Notes']), ['__new', 'New folder…']], async (v) => {
    if (v === '__new') { const name = await promptDialog('New folder', '', { label: 'Folder name' }); if (name == null) { folderSel.value = note.folder || ''; return; } note.folder = name.trim(); } else note.folder = v;
    ctx.saveNote(note); refresh();
  }, { title: 'Folder' });
  const modeBtn = (mode, ic, label) => button(label, { class: `btn small${st.noteMode === mode ? ' active' : ' ghost'}`, title: label, onClick: () => { st.noteMode = mode; refresh(); } }, ic);
  const head = h('div', { class: 'editor-head' },
    button('', { class: 'icon-btn back-btn', title: 'All notes', onClick: () => { st.showNoteList = true; refresh(); } }, 'menu'),
    title, folderSel,
    h('div', { class: 'row', style: { gap: '2px' } }, modeBtn('visual', 'eye', 'Visual'), modeBtn('markdown', 'edit', 'Markdown')),
    ro ? null : button('', { class: 'icon-btn', title: 'Delete note', onClick: async () => { if (await confirmDialog(`Move "${note.title}" to the trash?`)) { await ctx.deleteNote(note.id); st.noteId = null; refresh(); } } }, 'trash'));
  pane.append(head);
  if (ro) pane.append(h('div', { class: 'note-ro-banner' }, icon('eye', 16), h('span', {}, `Read-only · written by ${note.owner_name}`, note.shared ? ' · shared with the table by your DM' : ' · you are the DM of this campaign')));

  const bodyEl = h('div', { class: 'editor-body wysiwyg-mode' });
  let editor = null; let ta = null; let acBox = null;

  if (st.noteMode === 'visual') {
    const tb = h('div', { class: 'toolbar' });
    const tbtn = (label, title, fn, style) => h('button', { title, style, onClick: (e) => { e.preventDefault(); fn(); } }, label);
    if (!ro) {
      tb.append(
        tbtn('B', 'Bold (Ctrl+B)', () => editor.exec('bold')), tbtn('I', 'Italic (Ctrl+I)', () => editor.exec('italic'), { fontStyle: 'italic' }),
        tbtn('S', 'Strikethrough', () => editor.exec('strike'), { textDecoration: 'line-through' }), tbtn('==', 'Highlight', () => editor.exec('highlight')),
        tbtn('H1', 'Heading 1', () => editor.exec('h1')), tbtn('H2', 'Heading 2', () => editor.exec('h2')), tbtn('H3', 'Heading 3', () => editor.exec('h3')), tbtn('¶', 'Paragraph', () => editor.exec('paragraph')),
        tbtn('•', 'Bullet list', () => editor.exec('ul')), tbtn('1.', 'Numbered list', () => editor.exec('ol')), tbtn('☐', 'Checklist', () => editor.exec('task')),
        tbtn('❝', 'Quote', () => editor.exec('quote')), tbtn('—', 'Divider', () => editor.exec('hr')), tbtn('⊞', 'Table', () => editor.exec('table')), tbtn('</>', 'Code', () => editor.exec('code')),
        tbtn('[[ ]]', 'Link to another note', () => pickNote(ctx, notes, note, (t) => editor.exec('wikilink', t))),
        tbtn('#', 'Tag', async () => { const t = await promptDialog('Add a tag', '', { label: 'Tag (letters, digits, dashes)', okLabel: 'Add' }); if (t && t.trim()) editor.exec('tag', t.trim().replace(/^#/, '').replace(/\s+/g, '-')); }),
        tbtn('🔗', 'Web link', async () => { const u = await promptDialog('Web link', 'https://', { label: 'URL', okLabel: 'Insert' }); if (u && /^https?:\/\//.test(u)) editor.exec('link', u); }),
        tbtn('📅', 'Insert today\'s date', () => editor.exec('insertText', todayIso())),
        tbtn('@', 'Link the current character', () => { const c = ctx.currentChar(); if (c) editor.exec('wikilink', c.name); else toast('No character selected', 'error'); }),
        tbtn('↶', 'Undo', () => editor.exec('undo')), tbtn('↷', 'Redo', () => editor.exec('redo')));
      pane.append(tb);
    }
    const mount = h('div', { class: 'grow', style: { minHeight: 0, overflow: 'auto' } });
    bodyEl.append(mount);
    editor = createEditor({
      mount, markdown: note.body, readOnly: ro, resolveLink,
      titles: () => ctx.liveNotes().map((n) => n.title),
      onChange: (text) => { if (ro) return; note.body = text; persist(); },
      onOpenLink: (t) => ctx.openNote(t, { characterId: note.characterId }),
      onTag: (t) => { st.notesFilter.tag = t; st.notesFilter.folder = null; st.showNoteList = true; refresh(); },
    });
    mount.querySelector('.wysiwyg')?.setAttribute('data-placeholder', 'Start writing… Use the toolbar for headings, lists and links.');
  } else {
    ta = h('textarea', { spellcheck: 'true', 'aria-label': 'Note body (markdown)', readOnly: ro });
    ta.value = note.body;
    const onInput = () => { if (ro) return; note.body = ta.value; persist(); autocomplete(); };
    ta.addEventListener('input', onInput);
    ta.addEventListener('keydown', (e) => {
      if (ro) return;
      if (e.key === 'Tab') { e.preventDefault(); insertAt(ta, '  '); onInput(); }
      if (e.key === 'Enter' && !e.shiftKey && !acBox.children.length) {
        const before = ta.value.slice(0, ta.selectionStart); const line = before.slice(before.lastIndexOf('\n') + 1);
        const m = line.match(/^(\s*)([-*+]|\d+[.)])\s(\[[ x]\]\s)?/);
        if (m && line.trim() !== m[0].trim()) { e.preventDefault(); const bullet = /\d/.test(m[2]) ? `${parseInt(m[2]) + 1}.` : m[2]; insertAt(ta, `\n${m[1]}${bullet} ${m[3] ? '[ ] ' : ''}`); onInput(); }
      }
      if (e.key === 'Escape') clear(acBox);
    });
    acBox = h('div', { class: 'popover', style: { display: 'none', maxHeight: '220px', overflow: 'auto' } });
    document.body.append(acBox);
    const autocomplete = () => {
      const before = ta.value.slice(0, ta.selectionStart);
      const m = before.match(/\[\[([^\]\n]*)$/);
      clear(acBox);
      if (!m) { acBox.style.display = 'none'; return; }
      const q = m[1].toLowerCase();
      const hits = notes.filter((n) => n.title.toLowerCase().includes(q) && n.id !== note.id).slice(0, 8);
      if (!hits.length) { acBox.style.display = 'none'; return; }
      for (const n of hits) acBox.append(h('button', { class: 'result tree-item', onClick: () => { const s = ta.selectionStart; ta.setRangeText(`${n.title}]]`, s - m[1].length, s, 'end'); acBox.style.display = 'none'; ta.focus(); onInput(); } }, n.title));
      const r = ta.getBoundingClientRect();
      acBox.style.display = 'flex'; acBox.style.left = `${r.left + 20}px`; acBox.style.top = `${Math.min(r.top + 60, window.innerHeight - 240)}px`;
    };
    if (!ro) pane.append(h('div', { class: 'toolbar' }, h('small', { class: 'muted', style: { padding: '8px' } }, 'Markdown source. Wikilinks: [[Title]] · tags: #tag · tasks: - [ ] · tables with |')));
    bodyEl.append(ta);
  }
  pane.append(bodyEl);

  const cleanup = new MutationObserver(() => { if (!document.body.contains(pane)) { acBox?.remove(); editor?.destroy?.(); cleanup.disconnect(); } });
  cleanup.observe(document.getElementById('main'), { childList: true });
  rightRefresh = () => { const rp = pane.parentElement?.querySelector('.notes-side.right'); if (rp) rp.replaceWith(rightPane(ctx, note, ctx.liveNotes(), refresh)); };
  return pane;
}

function insertAt(ta, text) { const s = ta.selectionStart; ta.setRangeText(text, s, ta.selectionEnd, 'end'); ta.focus(); }

// Pick an existing note title (or type a new one) for a wikilink.
function pickNote(ctx, notes, current, onPick) {
  const input = h('input', { type: 'search', placeholder: 'Search notes or type a new title…' });
  const list = h('div', { class: 'ac-list' });
  const m = modal({ title: 'Link to a note', body: (el) => { el.append(input, list); } });
  const draw = () => {
    clear(list);
    const q = input.value.trim().toLowerCase();
    const hits = notes.filter((n) => n.id !== current.id && (!q || n.title.toLowerCase().includes(q))).slice(0, 12);
    for (const n of hits) list.append(h('button', { class: 'result', onClick: () => { onPick(n.title); m.close(); } }, n.title, h('small', {}, n.can_edit ? (n.folder || 'Notes') : `${n.owner_name} · read-only`)));
    if (q && !hits.some((n) => n.title.toLowerCase() === q)) list.append(h('button', { class: 'result', onClick: () => { onPick(input.value.trim()); m.close(); } }, `Create "${input.value.trim()}"`, h('small', {}, 'New note, created when you click the link')));
  };
  input.addEventListener('input', draw);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); list.querySelector('button')?.click(); } });
  draw();
}

// ---------------------------------------------------------------- Right: properties, backlinks
function rightPane(ctx, note, notes, refresh) {
  const pane = h('div', { class: 'notes-side right' });
  const body = h('div', { class: 'pane-body' });
  const chars = ctx.liveChars();
  const ro = !note.can_edit;
  body.append(h('h4', {}, 'Properties'));
  const props = h('div', { class: 'props' });
  props.append(h('div', { class: 'owner-line' }, ro ? `By ${note.owner_name}` : 'Yours'));
  if (ro) {
    const ch = chars.find((c) => c.id === note.characterId);
    if (ch) props.append(h('div', { class: 'owner-line' }, `Character: ${ch.name}`));
    const camp = ctx.campaignById(note.campaign_id);
    if (camp) props.append(h('div', { class: 'owner-line' }, `Campaign: ${camp.name}`));
  } else {
    props.append(h('label', { class: 'field' }, h('span', {}, 'Character'), select(note.characterId || '', [['', '—'], ...chars.map((c) => [c.id, c.owner_id === ctx.user.id ? c.name : `${c.name} (${c.owner_name})`])], (v) => { note.characterId = v || null; ctx.saveNote(note); })));
    const camps = ctx.state.campaigns;
    if (camps.length) {
      props.append(h('label', { class: 'field' }, h('span', {}, 'Campaign'), select(note.campaign_id || '', [['', 'Personal (no campaign)'], ...camps.map((c) => [c.id, `${c.name}${c.dm_id === ctx.user.id ? ' (you DM)' : ''}`])], (v) => { note.campaign_id = v || null; if (!v || !ctx.isDM(v)) note.shared = false; ctx.saveNote(note); setTimeout(refresh, 450); })));
      if (note.campaign_id && ctx.isDM(note.campaign_id)) {
        const cb = h('input', { type: 'checkbox', checked: !!note.shared });
        cb.addEventListener('change', () => { note.shared = cb.checked; ctx.saveNote(note); toast(cb.checked ? 'Shared with the players' : 'No longer shared'); });
        props.append(h('label', { class: 'share-row' }, cb, h('span', {}, 'Share with players'), h('small', { class: 'muted' }, '(read-only for them)')));
      } else if (note.campaign_id) {
        props.append(h('small', { class: 'muted' }, 'Visible to your DM. Other players cannot see it.'));
      }
    }
  }
  props.append(h('div', { class: 'row', style: { gap: '6px' } }, (note.tags || []).length ? note.tags.map((t) => button(`#${t}`, { class: 'chip', onClick: () => { ctx.state.notesFilter.tag = t; ctx.state.showNoteList = true; refresh(); } })) : h('small', {}, 'No tags yet.')),
    h('small', {}, `Updated ${new Date(note.updated).toLocaleString()}`));
  body.append(props);

  const lname = note.title.toLowerCase();
  const back = notes.filter((n) => n.id !== note.id && extractLinks(n.body).some((l) => l.toLowerCase() === lname));
  body.append(h('h4', {}, `Backlinks (${back.length})`));
  if (!back.length) body.append(h('div', { class: 'muted', style: { padding: '0 8px' } }, h('small', {}, 'No other note links here yet.')));
  for (const n of back) body.append(h('button', { class: 'backlink', onClick: () => { ctx.state.noteId = n.id; refresh(); } }, h('b', {}, n.title), h('small', {}, excerpt(n.body))));
  const out = extractLinks(note.body);
  body.append(h('h4', {}, `Links (${out.length})`));
  for (const t of out) {
    const target = ctx.findNote(t);
    body.append(h('button', { class: 'backlink', onClick: () => ctx.openNote(t, { characterId: note.characterId }) }, h('b', { style: target ? {} : { color: 'var(--muted)' } }, t), h('small', {}, target ? excerpt(target.body) : 'Not created yet — click to create')));
  }
  const ch = chars.find((c) => c.id === note.characterId);
  if (ch) { body.append(h('h4', {}, 'Linked character')); body.append(h('button', { class: 'backlink', onClick: () => { ctx.setCurrentChar(ch.id); ctx.navigate('sheet'); } }, h('b', {}, ch.name), h('small', {}, `HP ${ch.hp.current}/${ch.hp.max} · AC ${ch.ac}`))); }
  pane.append(body);
  return pane;
}
