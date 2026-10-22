// Starter content: Sophorke (from the completed Aurora-based sheet) and a few campaign notes.
import { uid } from './store.js';

export function sophorkeCharacter() {
  const now = Date.now();
  const id = uid();
  const f = (name, source, text, uses = null, kind = uses ? 'active' : 'passive') => ({ id: uid(), name, source, uses, text, kind });
  const sp = (name, level, notes = '', conc = false) => ({ id: uid(), name, level, prepared: true, conc, notes });
  const it = (name, qty, weight, notes = '', equipped = false) => ({ id: uid(), name, qty, weight, equipped, attuned: false, notes });
  return {
    id, name: 'Sophorke', pronouns: 'she/her', race: 'Gorgonblood (Cursekeeper)',
    classes: [{ name: 'Sorcerer', level: 1, subclass: 'Stonegaze' }],
    background: 'Outlander (Guide)', alignment: 'Lawful Neutral', xp: 0, inspiration: false,
    abilities: { str: 8, dex: 14, con: 14, int: 13, wis: 10, cha: 19 },
    saveProf: { con: true, cha: true },
    skillProf: { arcana: 1, athletics: 1, deception: 1, survival: 1 },
    skillNotes: { deception: 'advantage (Stoney Silence)', intimidation: 'advantage (Stoney Silence)', persuasion: 'disadvantage (Stoney Silence)' },
    hp: { current: 8, max: 8, temp: 0 }, hitDice: { total: 1, used: 0, die: 6 }, deathSaves: { s: 0, f: 0 },
    ac: 12, acNote: 'No armour: 10 + Dex', speed: 35, speedUnit: 'ft', initiativeBonus: 0, conditions: [], exhaustion: 0,
    senses: 'Darkvision 60 ft (18 m)', defenses: 'Resistance: poison. Cannot be surprised while conscious (Hissing Hair).',
    languages: 'Common, Draconic', otherProficiencies: 'Weapons: daggers, darts, slings, quarterstaffs, light crossbows, shortbows, longbows. Tools: pan flute.',
    attacks: [
      { id: uid(), name: 'Light crossbow', toHit: 4, damage: '1d8+2', damageType: 'piercing', notes: '80/320 ft (24/96 m), ammunition (20 bolts), loading, two-handed' },
      { id: uid(), name: 'Dagger', toHit: 4, damage: '1d4+2', damageType: 'piercing', notes: 'finesse, light, thrown 20/60 ft (6/18 m)' },
      { id: uid(), name: 'Fire Bolt', toHit: 6, damage: '1d10', damageType: 'fire', notes: 'Cantrip, 120 ft (36 m)' },
      { id: uid(), name: 'Acid Splash', toHit: null, damage: '1d6', damageType: 'acid', notes: 'Cantrip, DC 14 Dex save, 60 ft (18 m); one target or two within 5 ft of each other' },
    ],
    quickActions: '**Reactions (one per round):** Gorgon\'s Gaze (2/LR) · Stone Gaze (1/LR) · Cursed Vengeance (1/LR) · Shield (spell slot).\n\n**Arcane focus:** crystal (chip of grey-green statue-stone).',
    spellcasting: {
      ability: 'cha',
      slots: { 1: { max: 2, used: 0 } },
      spells: [
        sp('Fire Bolt', 0, 'Ranged spell attack +6, 1d10 fire; 120 ft. Ignites unattended flammables.'),
        sp('Acid Splash', 0, 'Gorgon Magic. 1 creature, or 2 within 5 ft: Dex save DC 14 or 1d6 acid. 60 ft.'),
        sp('Minor Illusion', 0, 'S, M (fleece). Sound or static image ≤ 5-ft cube for 1 min; DC 14 Investigation reveals.'),
        sp('Mage Hand', 0, 'Spectral hand, 30 ft, carries ≤ 10 lb (4.5 kg), 1 min.'),
        sp('Message', 0, 'Whisper to a creature within 120 ft; it can reply. M (copper wire).'),
        sp('Sleep', 1, '90 ft. 5d8 HP of creatures within 20 ft fall unconscious, lowest current HP first. +2d8 per higher slot.'),
        sp('Shield', 1, 'Reaction when hit or targeted by Magic Missile: +5 AC until start of next turn.'),
        sp('Detect Poison and Disease', 1, 'Stonegaze spell. Self, 30-ft radius, 10 min. Costs a slot (sorcerers have no ritual casting).', true),
      ],
    },
    inventory: [
      it('Light crossbow', 1, 5, 'Sorcerer kit', true), it('Crossbow bolts', 20, 0.075, 'No bolt case'),
      it('Dagger', 2, 1, 'Sorcerer kit', true), it('Arcane focus (crystal)', 1, 1, 'Chip of statue-stone from the enclave garden', true),
      it('Backpack', 1, 5, "Dungeoneer's pack"), it('Crowbar', 1, 5, "Dungeoneer's pack"), it('Hammer', 1, 3, "Dungeoneer's pack"),
      it('Pitons', 10, 0.25, "Dungeoneer's pack"), it('Torches', 10, 1, "Dungeoneer's pack"), it('Tinderbox', 1, 1, "Dungeoneer's pack"),
      it('Rations (days)', 10, 2, "Dungeoneer's pack"), it('Waterskin (full)', 1, 5, "Dungeoneer's pack"), it('Hempen rope, 50 ft (15 m)', 1, 10, "Dungeoneer's pack"),
      it('Staff', 1, 4, 'Outlander; quarterstaff (1d6) if the DM agrees'), it('Hunting trap', 1, 25, 'Outlander; DC 13 Str to escape, 1d4 piercing'),
      it('Trophy: jaguar fang', 1, 0, 'Outlander; first kill made by magic', true), it("Traveler's clothes", 1, 4, 'Outlander', true), it('Belt pouch', 1, 1, 'Holds the 10 gp'),
    ],
    coins: { cp: 0, sp: 0, ep: 0, gp: 10, pp: 0 },
    features: [
      f('Darkvision', 'Gorgonblood', '60 ft (18 m).'),
      f('Hissing Hair', 'Gorgonblood', "You can't be surprised while you are conscious."),
      f('Martial Training', 'Gorgonblood', 'Proficient with shortbows and longbows.', null, 'proficiency'),
      f('Stoney Silence', 'Gorgonblood', 'Advantage on Charisma (Deception) and Charisma (Intimidation) checks; disadvantage on Charisma (Persuasion) checks.'),
      f('Stone Gaze', 'Gorgonblood', 'When a creature you can see hits you with a melee attack, use your reaction: if it is not blinded, it must succeed on a Constitution save (DC 8 + prof + Cha = 14) or its attack misses and it is restrained until the start of its next turn. From 5th level it is petrified instead.', { max: 1, used: 0, reset: 'long' }),
      f('Cursed Vengeance', 'Cursekeeper', 'When you damage a creature you can see, use your reaction to curse it for 1 minute; whenever you damage it, it takes extra necrotic damage equal to your proficiency bonus (2).', { max: 1, used: 0, reset: 'long' }),
      f('Gorgon Magic', 'Cursekeeper', 'Know Acid Splash. 3rd level: Detect Poison and Disease (no material component); 5th: Ray of Enfeeblement; each 1/long rest free, or with slots. Spellcasting ability: Charisma.', null, 'active'),
      f('Venomous', 'Cursekeeper', 'Resistance to poison damage.'),
      f('Spellcasting', 'Sorcerer 1', 'Charisma. DC 14, attack +6. 4 cantrips, 2 spells known, 2 first-level slots. Sorcery points at 2nd, Metamagic at 3rd.', null, 'active'),
      f('Stonegaze Spells', 'Stonegaze', 'Extra spells that count as sorcerer spells and do not count against spells known: 1st Detect Poison and Disease; 3rd Hold Person; 5th Fear; 7th Freedom of Movement; 9th Hold Monster. On gaining a sorcerer level you may replace one with a conjuration or enchantment spell of the same level from the sorcerer or warlock list.'),
      f("Gorgon's Gaze", 'Stonegaze', 'When you become the target of an attack and can see the attacker, use your reaction: if it is not blinded, it must succeed on a Constitution save vs your spell save DC (14) or its attack misses and it is restrained until the start of its next turn. Uses = proficiency bonus.', { max: 2, used: 0, reset: 'long' }),
      f('Wanderer', 'Outlander', 'Excellent memory for maps and geography; always recall the general layout of terrain, settlements and features around you. Find food and fresh water for yourself and up to five others each day where the land offers berries, small game, water, etc.'),
    ],
    bio: {
      appearance: '**Age** 19 · **Height** 1.83 m (6 ft 0 in) · **Weight** 70 kg (155 lb) · **Eyes** pale stone-grey · **Skin** olive-brown, fine scale pattern at temples, neck and backs of hands · **Hair** heavy black braids threaded with four or five small living snakes\n\nTall and long-limbed, Sophorke moves with the deliberate stillness of a hunter. The snakes in her hair are still few; they coil under a hooded travelling cloak and hiss only when something approaches from behind. Her eyes are the colour of river stone and hold a gaze most people find hard to meet, which she has learned to use. She wears plain traveler\'s clothes, a crossbow slung but rarely drawn, a hunting trap and coiled rope on her pack, and on a cord at her throat a jaguar\'s fang and a chip of grey-green statue-stone that serves as her arcane focus.',
      backstory: 'Sophorke was born in a [[Gorgonblood enclave]] hidden deep in the jungle: a place of strict law, patient schemes and a garden of petrified trespassers. Where the other children were drilled with bow and axe, she quietly refused to carry a weapon, and to the matriarchs refusal looked like weakness. She survived by being useful instead: she read the jungle better than anyone and steered game toward the hunters\' ambushes so reliably that they stopped asking how.\n\nThe elders eventually saw what the hunters had felt for years: the girl was casting. Small, instinctive magic: sounds in the undergrowth that were never there, a whispered word that reached a hunter fifty paces away, a spatter of acid that dropped a jaguar no spear had touched. In a culture that prizes curse-weaving, an untaught sorceress was both a prize and a problem. Sophorke drew her own conclusion: a rule that holds back a gift has failed its purpose. At fourteen, a year short of adulthood, she left, taking the jaguar\'s fang and a chip of statue-stone from the garden, and went looking for someone who could teach her control.\n\nShe found [[Sophorke\'s master|a master]] in the lowlands and was, for years, a devoted student of theory and discipline. But the lessons never ended and the power never grew; drill after drill, and no monster at the end of any of them. In her eyes her master had broken his side of the bargain, which released her from hers. She left as she had left the enclave: without apology, with a plan, and meaning to prove against real monsters what the jungle had already taught her: that the deadliest thing in any fight is the mind behind it.',
      allies: 'The enclave\'s hunters (friendly; she will answer their call). The matriarchs (regard her departure as irregular). Her former master (considers the apprenticeship unfinished; may want her back, or the stone she took).',
      traits: '1. I watch over my friends as if they were a litter of newborn pups.\n2. I\'d rather solve a problem with a plan than a weapon. A blade is what you reach for when you\'ve stopped thinking.',
      ideals: '**Discipline.** A gift you don\'t govern with rules ends up governing you. (Lawful)',
      bonds: 'The enclave\'s hunters kept me alive when the matriarchs called me soft. If any of them ever calls for help, I answer.',
      flaws: 'I remember every insult I\'ve received and nurse a silent resentment toward anyone who\'s ever wronged me.',
    },
    portrait: '',
    created: now, updated: now, deleted: null,
  };
}

export function seedNotes(characterId) {
  const now = Date.now();
  const n = (title, folder, body, tags = [], charId = null) => ({ id: uid(), title, folder, body, tags, characterId: charId, created: now, updated: now, deleted: null });
  return [
    n('Welcome to Tome & Table', '', `# Welcome to Tome & Table

This is your character sheet and campaign notebook in one place. Everything is saved on this device.

## Notes work like Obsidian
- Link pages with double brackets: [[Sophorke]] or [[Gorgonblood enclave|the enclave]]. Click a missing link to create the page.
- Add tags anywhere: #npc #location #quest #session #rules
- The right-hand panel shows **backlinks** (pages that link here) and **outgoing links**.
- Checkboxes work in preview: click to tick.
  - [ ] Try ticking me
- Tables, headings, quotes and code blocks render in Preview.

## The sheet works like D&D Beyond
- Modifiers, saves, skills, spell DC and encumbrance are calculated for you from scores, level and proficiencies. Roll your own dice at the table.
- HP, spell slots, feature uses and hit dice are tap-to-track. **Short rest** and **Long rest** buttons reset the right counters.
- "Open note" on a feature, spell or item creates a note with the same name, linked to the character.

## Keyboard (when the Duet keyboard is attached)
| Shortcut | Action |
|---|---|
| Ctrl+K or Ctrl+/ | Command palette (or tap Search in the nav) |
| Ctrl+N | New note |
| Ctrl+E | Toggle edit / preview |
| Ctrl+1..4 | Party / Sheet / Notes / Settings |

## Backups
Settings → **Export** downloads a single JSON file with every character and note. Import it on another device to move everything.`, ['help']),

    n('Sophorke', 'Characters', `# Sophorke (she/her)
#pc #sorcerer

Gorgonblood (Cursekeeper) · Stonegaze Sorcerer 1 · Outlander (Guide) · Lawful Neutral

Sources: D&D 5e (2014) + *Wrath of Olympus* (MonkeyDM). See [[DM flags for Sophorke]] for every rules assumption.

## People and places
- Born in the [[Gorgonblood enclave]]
- Trained under [[Sophorke's master]]
- Enclave hunters: friendly, will answer their call

## Combat cheat-sheet
| Thing | Value |
|---|---|
| AC | 12 (no armour) |
| Spell save DC | 14 |
| Spell attack | +6 |
| Reactions | Gorgon's Gaze 2/LR · Stone Gaze 1/LR · Cursed Vengeance 1/LR · Shield |

## Open questions for the DM
- [ ] Does Stonegaze spell replacement apply at 1st level or first at 2nd?
- [ ] Which encumbrance rule does the table use? (105 lb carried, 120 lb capacity)
- [ ] Is the Outlander staff a quarterstaff (1d6)?`, ['pc', 'sorcerer'], characterId),

    n('Gorgonblood enclave', 'Lore', `# Gorgonblood enclave
#location #homebrew

A hidden settlement deep in the jungle: strict law, patient schemes, and a garden of petrified trespassers.

- Ruled by the **matriarchs**, who prize curse-weaving.
- Children are drilled with bow and axe from a young age; [[Sophorke]] refused and was called soft.
- The **hunters** kept her alive and now regard her as one of their own.
- Sophorke took a chip of statue-stone from the garden as her arcane focus.

**DM:** name the enclave, decide whether Sophorke is a deserter, an exile, or unfinished business.`, ['location', 'homebrew']),

    n("Sophorke's master", 'NPCs', `# Sophorke's master
#npc

A lowland spellcaster who taught [[Sophorke]] theory and discipline for roughly five years. Drill after drill, and no monster at the end of any of them.

- Considers the apprenticeship **unfinished**.
- May want her back, or the statue-stone she took from the [[Gorgonblood enclave]].

**DM:** name, school of magic, and whether he is looking for her.`, ['npc']),

    n('DM flags for Sophorke', 'Rules', `# DM flags for Sophorke
#rules #homebrew

1. **Third-party source.** Gorgonblood (Cursekeeper) and Stonegaze Sorcerer are from *Wrath of Olympus* (MonkeyDM). DM approval needed. Everything else is PHB 2014.
2. **Ability array.** 17→Cha (19), 12→Int (13), 14 Dex, 14 Con, 10 Wis, 8 Str.
3. **Gorgon Magic ability.** Charisma chosen.
4. **Sorcerer skills.** Arcana and Deception; Deception gains advantage from Stoney Silence.
5. **Outlander choices.** Pan flute proficiency; Draconic. No instrument owned yet.
6. **Two gaze reactions.** Racial Stone Gaze (on being *hit* by a melee attack, 1/LR) and class Gorgon's Gaze (on being *targeted*, 2/LR) are separate, both DC 14. Both use her single reaction, as does Shield.
7. **Cursed Vengeance timing.** Triggers on any damage (cantrips qualify). Whether the triggering hit gets the +2 necrotic is a DM call.
8. **No ritual casting.** Detect Poison and Disease costs a slot until 3rd level.
9. **Hit points.** 8 fixed at 1st (6 + Con); 1d6 (or 4) + Con thereafter.
10. **Encumbrance.** 105 lb carried vs 120 lb capacity. Variant rule would make her heavily encumbered; dropping the 25 lb hunting trap puts her at exactly 80 lb.
11. **Staff.** Treated as a quarterstaff (1d6, versatile 1d8) only if the DM agrees.
12. **Alignment.** Lawful Neutral by choice; the race text says most gorgonbloods are lawful evil.`, ['rules', 'homebrew'], characterId),

    n('Session 0', 'Sessions', `# Session 0
#session

**Date:** ${new Date().toISOString().slice(0, 10)}
**Present:** [[Sophorke]]

## Before the session
- [ ] Confirm homebrew approval ([[DM flags for Sophorke]])
- [ ] Agree encumbrance rule
- [ ] Buy a pan flute (12 gp) when there is money

## Notes
-

## Loot / XP
-

## Next time
-`, ['session'], characterId),
  ];
}
