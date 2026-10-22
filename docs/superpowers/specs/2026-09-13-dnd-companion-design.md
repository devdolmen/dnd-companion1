# Tome & Table — D&D character sheet + campaign notes for a Lenovo Duet Chromebook

Date: 2026-09-13
Status: v1 (single-user, offline). Superseded in part by `2026-10-13-multiuser-server-design.md` (accounts, server storage, campaigns, overrides, WYSIWYG notes, SRD spells).

## 0. One-paragraph summary

A single offline-first Progressive Web App (PWA), written in plain HTML/CSS/JS with no build
step, that combines an interactive D&D 5e character sheet (D&D Beyond-style: auto-calculated
modifiers, spell slots, HP tracking; no dice roller by user decision) with an Obsidian-style markdown notebook
(`[[wikilinks]]`, backlinks, tags, full-text search). Everything is stored on-device in IndexedDB
and can be exported/imported as a single JSON file. The same folder can be installed directly from
Chrome on the Chromebook, or wrapped into an Android APK with PWABuilder (no local toolchain) or
Capacitor (local toolchain).

## 1. Assumptions

| # | Assumption | Why | If wrong |
|---|------------|-----|----------|
| A1 | Ruleset is D&D 5e (2014 SRD skill/ability list; also fits the 2024 rules). | "DndBeyond" in the request. | Skill/ability tables live in one data file (`js/data/srd.js`) and can be swapped. |
| A2 | Single player, single device, no accounts or sync. | Simplest thing that works offline on a tablet. | Export/import JSON covers moving between devices; a sync layer can be added later. |
| A3 | Vanilla JS PWA, no framework, no bundler. | This Windows machine has no Node.js; a no-build app can be opened, edited and served with Python alone and loads straight into Chrome on the Chromebook. | Capacitor still wraps it unchanged. |
| A4 | Target screen: Lenovo Duet (10.1"-13.3", 1920x1200 class, touch + detachable keyboard), landscape most of the time. | Device named in the request. | Layout is responsive from 360 px phones up to desktop. |
| A5 | Dark scheme by default (table-side use), light schemes available. | Common preference at a game table. | 10 colour schemes and 5 layouts are pickable in Settings, or cycled with Ctrl+Shift+C / Ctrl+Shift+L. |
| A6 | No copyrighted D&D content is bundled (no spell/monster text). Users type their own entries. | Licensing; keeps the app small. | An SRD JSON import can be added later. |
| D1 | **No dice roller.** User decision mid-build: the app shows computed modifiers but never rolls. | Explicit request. | Physical dice at the table; hit-die spending asks for the rolled amount. |

## 2. Goals and non-goals

Goals
- Run and manage a character during a live session without a laptop: HP, spell slots, conditions, inventory.
- Keep campaign notes (sessions, NPCs, locations, quests) with cross-links, like Obsidian.
- Link sheet and notes both ways: every feature/spell/item on the sheet can open a note of the same name; notes can reference a character.
- Work fully offline; install to the Chromebook shelf; be packagable as an APK.
- Touch first: 44 px minimum tap targets, bottom tab bar reachable with thumbs in portrait.

Non-goals (for now)
- Multiplayer, DM screen, cloud sync, character builder wizard, rules-content database, graph view.

## 3. Front-end visual design

### 3.1 Visual language
- Mood: "leather journal + brass" - warm dark neutrals with a single accent, restrained, readable.
- Colour tokens (dark): background `#15120f`, surface `#201b16`, raised `#2a231d`, border `#3a3129`,
  text `#efe6d8`, muted `#a89b8a`, accent (brass) `#d4a24c`, danger `#c9553d`, success `#6fa06a`,
  info `#5f8fb4`.
- Rather than one fixed dark theme with a light toggle, the palette is **selectable: 10 colour schemes**
  (`brass` (default), `parchment`, `midnight`, `forest`, `crimson`, `arcane`, `frost`, `sepia`, `slate`,
  `contrast`), each a full re-definition of the same tokens, declared in `js/data/schemes.js` and styled
  in `css/themes.css` under `:root[data-scheme="<id>"]`. Schemes are both dark and light; the `dark` flag
  on each entry drives `color-scheme` and the swatch tag in Settings.
- The shell arrangement is likewise selectable: **5 layouts** (`rail` (default), `topbar`, `focus`,
  `dashboard`, `compact`), declared in `js/data/layouts.js` and styled in `css/layouts.css` under
  `#app[data-layout="<id>"]`. Layout and scheme are independent; both are numbered in Settings (the user
  refers to them as "layout 3", "colour 2") and cycle with `Ctrl+Shift+L` / `Ctrl+Shift+C`.
- Typography: system UI stack for body at 16 px base; a serif display face for headings and
  character names (`Georgia, "Iowan Old Style", serif`). No web fonts, so the app is fully offline.
- Shape: 12 px radius on cards, 8 px on controls, 1 px borders instead of heavy shadows.
- Icons: inline SVG, 20-24 px, stroke-based (single colour = `currentColor`).
- Motion: 150 ms ease on hover/press; nothing heavier than a fade.

### 3.2 App shell (responsive layouts)

```
Landscape tablet >= 900 px                       Portrait / phone < 900 px
+----+--------------------------+--------------+  +--------------------------+
|Nav | Header: name . lvl class |  Utility     |  | Header                   |
|rail| Tabs ------------------- |  panel       |  | Tabs (scrollable)        |
|64px|                          |  (linked     |  |                          |
|    |   Main content           |   notes)     |  | Main content             |
|    |                          |              |  |                          |
|    |                          |  300 px      |  |                          |
+----+--------------------------+--------------+  +--------------------------+
|                                              |  | Bottom tab bar           |
+----------------------------------------------+  +--------------------------+
```

- Nav rail (landscape) / bottom bar (portrait): Characters, Sheet, Notes, Settings.
- Utility panel (landscape only): "Linked notes" (notes that reference the current character).

### 3.3 Screens

1. **Characters (vault)** - grid of character cards (initials, name, race/class/level, HP bar). New, Import JSON, Duplicate, Delete (confirm).
2. **Sheet** - sticky header (name, level/class, HP `current / max` with +/- and temp HP, AC, initiative, speed, proficiency, inspiration toggle, conditions chips, Short/Long rest). Tabs:
   - *Overview*: six ability cards (score, modifier, save). Skill list with proficiency cycle (none, proficient, expertise, half), passive Perception, hit dice, death saves.
   - *Actions*: attack rows (name, to-hit, damage, notes), plus free-text quick actions.
   - *Spells*: casting ability, spell save DC and attack bonus (auto), slot trackers per level (tap pips), spell list grouped by level with prepared toggle, concentration flag, "Open note".
   - *Inventory*: items with qty/weight/equipped/attuned, total weight vs carrying capacity (STR x 15), coin purse.
   - *Features*: three categories. Two columns, **Active abilities** (actions, reactions, limited-use powers with use pips) and **Passive traits**, with **Proficiencies & training** as a full-width section at the very bottom (proficiency-type features such as Martial Training, plus saves, skills, languages and weapon/armour/tool proficiencies). Each feature has a `kind` (active / passive / proficiency); unset kinds are auto-classified from the text, and a "Move to" dropdown on every row re-files it into another section.
   - *Bio*: appearance, backstory, allies, traits/ideals/bonds/flaws in markdown.
   - Long rest: HP to max, all slots, regain half hit dice, long-rest features. Short rest: short-rest features.
3. **Notes** - Obsidian layout: left column (folder tree + tags + search), centre editor (toolbar; Edit / Preview / Split), right column (backlinks, outgoing links, properties: tags, linked character). `[[Page]]` links; missing pages are created on click. "Session note" button creates `Sessions/Session YYYY-MM-DD`.
4. **Settings** - **Layout** (grid of 5 tiles, each with a preview SVG, name and description) and
   **Colour scheme** (grid of 10 tiles, each with a bg/surface/accent/text swatch strip, name, description
   and a dark/light tag); the active tile carries an accent border and a "Selected" chip, and a caption
   under the grids reads back the numbered pair (`Layout 3 (Focus) · Colour 2 (Parchment)`). Then export
   all data (JSON download + clipboard), import (file or paste), trash, keyboard shortcuts, reset.

### 3.4 Interaction rules
- No dice rolling anywhere (decision D1). Values are shown as ready-to-roll modifiers.
- Every edit autosaves (debounced 300 ms) with a "Saved" pulse; no Save buttons.
- Destructive actions ask once; deleted characters/notes go to Trash instead of disappearing.
- Keyboard: `Ctrl+K` command palette (jump to note/character; also "Layout: <name>" and "Colour: <name>"
  commands), `Ctrl+N` new note, `Ctrl+E` toggle preview, `Ctrl+Shift+L` next layout, `Ctrl+Shift+C` next
  colour scheme.

## 4. Feature plan and phasing

Phase 1 - MVP (implemented in this session)
- Character vault CRUD, import/export JSON.
- Sheet header, Overview, Actions, Spells, Inventory, Features, Bio with auto-calculations and rest logic.
- Notes: folders, markdown (headings, emphasis, lists, checkboxes, code, tables, quotes, links), `[[wikilinks]]`, `#tags`, backlinks, full-text search, session-note shortcut.
- Sheet-notes link: "Open note" on features/spells/items; notes can set a linked character; utility panel lists linked notes.
- PWA: manifest, service worker (cache-first shell), IndexedDB storage.
- 10 colour schemes and 5 shell layouts (switchable in Settings, the command palette, or by keyboard), responsive shell, command palette.
- In-browser unit tests for rules, markdown and the Aurora importer (`tests.html`).
- Aurora Builder `.dnd5e` import (best effort) and a pre-loaded starter character (Sophorke) built from the finished sheet.

Phase 2
- Note templates; graph view; print stylesheet; richer Aurora import (equipment weights, chosen options).

Phase 3
- SRD JSON import for spells/items; optional file-based sync (Google Drive on ChromeOS).

## 5. Architecture

```
dnd-companion/
  index.html              app shell
  manifest.webmanifest    PWA manifest
  sw.js                   service worker (cache-first)
  css/app.css             base tokens, layout, components
  css/themes.css          10 colour schemes (:root[data-scheme])
  css/layouts.css         5 shell layouts (#app[data-layout])
  css/settings-appearance.css  layout / colour picker tiles
  js/app.js               router, shell, command palette, appearance, boot
  js/store.js             IndexedDB wrapper + export/import + trash
  js/rules.js             pure 5e maths (mods, prof, saves, skills, DC, capacity, rests)
  js/markdown.js          markdown to HTML, wikilinks, tags (pure)
  js/sheet.js             character sheet views
  js/notes.js             notes views
  js/ui.js                DOM helpers, modal, toast, icons
  js/aurora.js            Aurora Builder .dnd5e importer (pure)
  js/seed.js              starter character (Sophorke) and notes
  js/data/srd.js          abilities, skills, conditions, class list, slot table
  js/data/schemes.js      colour scheme list + DEFAULT_SCHEME
  js/data/layouts.js      layout list (preview SVGs) + DEFAULT_LAYOUT
  icons/                  PNG 192/512 + maskable
  tests.html              browser test runner for rules/markdown/aurora
  capacitor.config.json   ready for `npx cap add android`
  README.md               run, install as PWA, build APK (both paths)
```

Pure modules (`rules`, `markdown`, `aurora`) have no DOM access and are covered by `tests.html`.
Views receive state and a `save()` callback; they never touch IndexedDB directly.

### 5.1 Data model (IndexedDB database `tome-and-table`, stores `characters`, `notes`, `meta`)

```js
Character {
  id, name, race, classes:[{name, level, subclass}], background, alignment, xp, inspiration,
  abilities:{str,dex,con,int,wis,cha},
  saveProf:{str:bool,...}, skillProf:{acrobatics:0|0.5|1|2,...},
  hp:{current,max,temp}, hitDice:{total,used,die}, deathSaves:{s,f},
  ac, speed, initiativeBonus, conditions:[], exhaustion,
  attacks:[{id,name,toHit,damage,notes}], quickActions:"",
  spellcasting:{ability, slots:{1:{max,used},...}, spells:[{id,name,level,prepared,conc,notes}]},
  inventory:[{id,name,qty,weight,equipped,attuned,notes}], coins:{cp,sp,ep,gp,pp},
  features:[{id,name,source,kind:'active'|'passive'|'proficiency',uses:{max,used,reset:'short'|'long'|null},text}],
  bio:{appearance,backstory,allies,traits,ideals,bonds,flaws},
  created, updated, deleted:null|timestamp
}
Note { id, title, folder, body, tags:[], characterId:null|id, created, updated, deleted }
Meta { scheme, layout, lastCharacterId, seeded }   // pre-v3 `theme:'dark'|'light'` migrates to scheme 'brass'|'parchment'
```

### 5.2 Error handling
- IndexedDB unavailable: fall back to localStorage with a warning banner.
- Bad import: validated record-by-record; report skipped records; never wipe existing data.

### 5.3 Testing
- `tests.html`: assertions for modifiers, proficiency by level, skill/save totals, spell DC, carrying capacity, rest logic, markdown (wikilinks, tags, tables), Aurora import.
- Manual: install as PWA on the Chromebook, offline reload, landscape/portrait, keyboard shortcuts.

## 6. Packaging routes (detail in README)
1. **Install as PWA from Chrome** (recommended on ChromeOS): open the hosted URL, then Install.
2. **APK without a local toolchain**: host on GitHub Pages, use pwabuilder.com to produce an Android package, sign, then `adb install` via the Chromebook's Linux container.
3. **APK with Capacitor**: Node 20 + Android Studio, `npx cap add android`, `gradlew assembleDebug`.
