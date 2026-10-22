// Campaign view: create / join, members, invite code, characters and shared notes.
import { h, clear, icon, button, confirmDialog, promptDialog, toast, select } from './ui.js';
import * as R from './rules.js';

export function renderCampaign(ctx, header, main) {
  clear(header); clear(main);
  header.append(h('h1', {}, 'Campaigns'),
    h('div', { class: 'row', style: { marginLeft: 'auto' } },
      button('Join with code', { class: 'btn', onClick: async () => {
        const code = await promptDialog('Join a campaign', '', { label: 'Invite code from your DM', okLabel: 'Join' });
        if (code == null || !code.trim()) return;
        try { const c = await ctx.joinCampaign(code.trim().toUpperCase()); toast(`Joined ${c.name}`, 'success'); } catch (e) { toast(e.message, 'error'); }
      } }, 'link'),
      button('New campaign', { class: 'btn primary', onClick: async () => {
        const name = await promptDialog('New campaign', '', { label: 'Campaign name', okLabel: 'Create' });
        if (name == null || !name.trim()) return;
        try { await ctx.createCampaign(name.trim()); toast('Campaign created. Share the invite code with your players.', 'success'); } catch (e) { toast(e.message, 'error'); }
      } }, 'plus')));

  const wrap = h('div', { class: 'campaigns' });
  const camps = ctx.state.campaigns;
  if (!camps.length) {
    wrap.append(h('div', { class: 'card' }, h('h3', {}, 'No campaigns yet'),
      h('p', { class: 'muted' }, 'A campaign links a DM and their players. The DM can read every character sheet and every note in the campaign, and can share their own notes with the table. Players can read each other\'s sheets but never each other\'s notes.'),
      h('p', { class: 'muted' }, 'Create one if you are running the game, or join with the code your DM gives you.')));
  }
  for (const c of camps) wrap.append(campaignCard(ctx, c));
  main.append(wrap);
}

function campaignCard(ctx, c) {
  const me = ctx.user;
  const isDM = c.dm_id === me.id;
  const chars = ctx.liveChars().filter((x) => x.campaign_id === c.id);
  const mine = ctx.myChars().filter((x) => x.campaign_id !== c.id);
  const sharedNotes = ctx.liveNotes().filter((n) => n.campaign_id === c.id && n.shared && n.owner_id === c.dm_id);
  const playerNotes = isDM ? ctx.liveNotes().filter((n) => n.campaign_id === c.id && n.owner_id !== me.id) : [];

  const card = h('div', { class: 'card campaign-card' });
  card.append(h('div', { class: 'card-head' },
    h('h2', {}, c.name, h('span', { class: `badge${isDM ? ' dm' : ''}` }, isDM ? 'You are the DM' : `DM: ${c.dm_name}`)),
    h('div', { class: 'row', style: { gap: '4px' } },
      isDM ? button('', { class: 'icon-btn small', title: 'Rename', onClick: async () => { const n = await promptDialog('Rename campaign', c.name, { label: 'Name' }); if (n && n.trim()) { try { await ctx.renameCampaign(c.id, n.trim()); } catch (e) { toast(e.message, 'error'); } } } }, 'edit') : null,
      isDM ? button('Delete', { class: 'btn small danger', onClick: async () => { if (await confirmDialog(`Delete "${c.name}"? Characters and notes stay with their owners but leave the campaign.`)) { try { await ctx.deleteCampaign(c.id); toast('Campaign deleted'); } catch (e) { toast(e.message, 'error'); } } } }, 'trash')
        : button('Leave', { class: 'btn small', onClick: async () => { if (await confirmDialog(`Leave "${c.name}"? Your characters and notes stay yours but leave the campaign.`, { okLabel: 'Leave' })) { try { await ctx.leaveCampaign(c.id); toast('Left campaign'); } catch (e) { toast(e.message, 'error'); } } } }))));

  // Members
  const members = h('div', { class: 'members' },
    h('span', { class: 'chip on' }, icon('star', 14), c.dm_name, h('small', {}, ' DM')),
    c.members.map((m) => h('span', { class: 'chip' }, m.username,
      isDM ? button('', { class: 'icon-btn small', style: { width: '22px', height: '22px' }, title: `Remove ${m.username}`, onClick: async () => { if (await confirmDialog(`Remove ${m.username} from the campaign?`, { okLabel: 'Remove' })) { try { await ctx.removeMember(c.id, m.id); } catch (e) { toast(e.message, 'error'); } } } }, 'x') : null)));
  card.append(h('div', { class: 'stack', style: { marginTop: '8px' } }, h('div', { class: 'field' }, h('span', {}, `Players (${c.members.length})`)), members));

  if (isDM) {
    card.append(h('div', { class: 'stack', style: { marginTop: '12px' } },
      h('div', { class: 'field' }, h('span', {}, 'Invite code')),
      h('div', { class: 'row' },
        h('code', { class: 'invite' }, c.invite_code || '—'),
        button('Copy', { class: 'btn small', onClick: async () => { try { await navigator.clipboard.writeText(c.invite_code); toast('Invite code copied', 'success'); } catch { toast('Clipboard blocked; copy it by hand', 'error'); } } }, 'copy'),
        button('New code', { class: 'btn small ghost', title: 'Invalidate the old code', onClick: async () => { try { await ctx.rotateInvite(c.id); toast('New invite code generated', 'success'); } catch (e) { toast(e.message, 'error'); } } }),
        h('small', { class: 'muted' }, 'Players enter this under Join with code.'))));
  }

  // Characters
  const charBox = h('div', { class: 'stack', style: { marginTop: '14px' } }, h('div', { class: 'field' }, h('span', {}, `Characters in this campaign (${chars.length})`)));
  const grid = h('div', { class: 'char-grid' });
  for (const ch of chars) {
    const own = ch.owner_id === me.id;
    grid.append(h('button', { class: 'char-mini', onClick: () => { ctx.setCurrentChar(ch.id); ctx.navigate('sheet'); } },
      h('div', { class: 'avatar small' }, ch.portrait ? h('img', { src: ch.portrait, alt: '' }) : (ch.name || '?').slice(0, 2).toUpperCase()),
      h('div', { class: 'grow' }, h('b', {}, ch.name), h('small', { class: 'muted' }, `${own ? 'You' : ch.owner_name} · ${R.classSummary(ch)} · HP ${ch.hp.current}/${R.effectiveMaxHp(ch)}`)),
      own ? h('span', { class: 'badge' }, 'yours') : h('span', { class: 'badge ro' }, isDM ? 'DM view' : 'view')));
  }
  if (!chars.length) grid.append(h('div', { class: 'empty', style: { gridColumn: '1 / -1' } }, 'No characters yet. Players add theirs below.'));
  charBox.append(grid);
  if (mine.length) {
    const sel = select('', [['', 'Add one of my characters…'], ...mine.map((x) => [x.id, x.name])], async (v) => {
      if (!v) return; const ch = mine.find((x) => x.id === v);
      try { await ctx.assignCampaign(ch, c.id); toast(`${ch.name} joined ${c.name}`, 'success'); } catch (e) { toast(e.message, 'error'); }
    });
    charBox.append(h('div', { class: 'row' }, sel));
  }
  card.append(charBox);

  // Notes
  const noteBox = h('div', { class: 'stack', style: { marginTop: '14px' } });
  if (isDM) {
    noteBox.append(h('div', { class: 'field' }, h('span', {}, `Notes: ${sharedNotes.length} shared with players · ${playerNotes.length} written by players`)),
      h('p', { class: 'muted', style: { margin: 0 } }, 'Tick "Share with players" on any of your notes in this campaign to let the table read it. Players\' notes appear under "Players\' notes" in the Notes view.'));
  } else {
    noteBox.append(h('div', { class: 'field' }, h('span', {}, `Shared by the DM (${sharedNotes.length})`)));
    if (!sharedNotes.length) noteBox.append(h('small', { class: 'muted' }, 'Nothing shared yet.'));
    for (const n of sharedNotes.sort((a, b) => b.updated - a.updated)) noteBox.append(h('button', { class: 'backlink', onClick: () => { ctx.state.noteId = n.id; ctx.state.showNoteList = false; ctx.navigate('notes'); } }, h('b', {}, n.title), h('small', {}, `${c.dm_name} · ${new Date(n.updated).toLocaleDateString()}`)));
  }
  card.append(noteBox);
  return card;
}
