# Tome & Table v2 — multi-user server, campaigns, overrides, WYSIWYG notes

Date: 2026-10-13
Status: contract for implementation (parallel agents build against this document)
Supersedes parts of `2026-09-13-dnd-companion-design.md` (storage, notes editor, sheet editing rules).

## 0. Summary

Tome & Table becomes a self-hosted multi-user web app. A small Python (FastAPI + SQLite) server
runs in a Docker container, stores every user's characters, notes and original Aurora `.dnd5e`
files, and serves the existing static web app from `web/`. Users sign up with a username and
password. A user can create a **campaign** (becoming its DM) and invite players with a code.
Within a campaign the DM sees every character sheet and every note; players can read each
other's sheets but never each other's notes; the DM can tick **Share with players** on any of
their own notes. Character base statistics (ability scores, proficiencies, slot maxima, class and
level) are locked to what Aurora Builder exported; in-play changes happen through **overrides**
(permanent, until short rest, until long rest, or until cancelled). After a session a player can
download their `.dnd5e` with XP, coins and bio written back, level up in Aurora, and re-upload.
Notes are edited directly in the rendered view (WYSIWYG) with the markdown source still
available. Spell descriptions from the SRD 5.1 are shown through an info button on each spell.

## 1. Repository layout (after this change)

```
dnd-companion/
  web/                      static web app (moved from the root; unchanged paths inside)
    index.html  manifest.webmanifest  sw.js  tests.html  css/  js/  icons/
  server/                   Python backend
    __init__.py  app.py  db.py  auth.py  aurora_patch.py  test_api.py
  data/                     runtime data (gitignored): tome.db, aurora/<character_id>.dnd5e
  requirements.txt  Dockerfile  docker-compose.yml  .gitignore
  docs/superpowers/specs/   this document and the v1 design
  README.md
```

Local run (Windows, no Docker): `py -m uvicorn server.app:app --port 8787 --app-dir dnd-companion`
Docker: `docker compose up -d --build` → http://localhost:8787/

## 2. Data model (SQLite, `data/tome.db`)

```
users           id TEXT PK, username TEXT UNIQUE (case-insensitive), password_hash TEXT, created REAL
sessions        token TEXT PK, user_id, created REAL, expires REAL
campaigns       id PK, name, dm_id, invite_code TEXT UNIQUE, created REAL
campaign_members campaign_id, user_id, joined REAL  (PK pair)  -- the DM is NOT listed as a member
characters      id PK, owner_id, campaign_id NULL, source TEXT ('aurora'|'manual'),
                data TEXT (JSON of the character object minus server fields), created, updated, deleted NULL
notes           id PK, owner_id, campaign_id NULL, character_id NULL, title, folder, body, tags TEXT (JSON array),
                shared INTEGER 0/1, created, updated, deleted NULL
login_attempts  key TEXT PK, count INTEGER, locked_until REAL   (in-memory is acceptable)
```

Aurora XML is stored on disk at `DATA_DIR/aurora/<character_id>.dnd5e` (UTF-8, byte-for-byte as uploaded).
IDs are `uuid4().hex`. Timestamps are Unix milliseconds (JavaScript `Date.now()` compatible).
Passwords: `hashlib.scrypt(n=2**14, r=8, p=1)` with a 16-byte random salt, stored as `scrypt$<salt_hex>$<hash_hex>`.
Sessions: 32 random bytes hex in an `HttpOnly; SameSite=Lax; Path=/` cookie named `tt_session`,
`Secure` when the request scheme (or `X-Forwarded-Proto`) is https or env `COOKIE_SECURE=1`. Lifetime `SESSION_DAYS` (default 30).

### 2.1 Character object (what the client holds; `data` column = this minus server fields)

Same shape as v1 plus:

```js
{
  // server-controlled fields (merged into the object on read, stripped on write):
  id, owner_id, owner_name, campaign_id, source, has_aurora, can_edit, can_override, updated, created, deleted,
  // v1 fields: name, pronouns, race, classes, background, alignment, xp, inspiration, abilities, saveProf,
  // skillProf, skillNotes, hp, hitDice, deathSaves, ac, acNote, speed, speedUnit, initiativeBonus, conditions,
  // exhaustion, senses, defenses, languages, otherProficiencies, attacks, quickActions, spellcasting, inventory,
  // coins, features, bio, portrait
  overrides: [ { id, target, label, mode: 'add'|'set', value, duration: 'permanent'|'short'|'long'|'manual', note, createdAt, createdBy } ],
}
```

**Base fields** (locked when `source === 'aurora'`): `abilities`, `saveProf`, `skillProf`, `classes`, `race`,
`background`, `alignment`, `hitDice.total`, `hitDice.die`, `spellcasting.ability`, and every
`spellcasting.slots[k].max`. The server copies these from the stored record on every ordinary PUT of an
Aurora-sourced character, so client tampering cannot change them. The only ways to change base fields are
`PUT /api/characters/{id}/aurora` (re-import) and overrides.

### 2.2 Override targets (client `js/data/overrides.js`, applied in `js/rules.js`)

| target key | mode | effect in `applyOverrides` |
|---|---|---|
| `abilities.<str|dex|con|int|wis|cha>` | add | score += value |
| `ac`, `speed`, `initiativeBonus`, `hp.max`, `profBonusExtra` | add | field += value |
| `saveBonus.<ab>` / `skillBonus.<skill>` | add | bonus maps += value (already read by rules.js) |
| `saveProf.<ab>` | set | true |
| `skillProf.<skill>` | set | 0.5 / 1 / 2 |
| `spellSlots.<1..9>` | add | `spellcasting.slots[n].max += value` (create if missing) |
| `spellAttackBonus`, `spellDCBonus`, `attackBonus`, `damageBonus` | add | extra fields read by rules / sheet |

`applyOverrides(ch)` returns a deep copy with every override applied (adds summed, sets last-wins) and `_active: true`.
`shortRest` removes overrides with duration `short`; `longRest` removes `short` and `long`. `manual` and
`permanent` are removed only by the user. The sheet always renders the effective character; values touched by an
override show a small accent dot with a tooltip listing the overrides. Owner and campaign DM may add/remove overrides.

## 3. HTTP API (all JSON; mutating requests require header `X-Requested-With: TomeAndTable`, else 403)

Errors: `{ "error": "<message>" }` with 400/401/403/404/409/429.

### Auth
- `POST /api/auth/signup {username, password}` → 201 `{user:{id,username}}` + cookie. Username 3–32 chars `[A-Za-z0-9_.-]`, password ≥ 8 chars. 409 if taken. 403 if env `ALLOW_SIGNUP=0`.
- `POST /api/auth/login {username, password}` → 200 `{user}` + cookie; 401 wrong; 429 after 5 failures (per username) for 60 s.
- `POST /api/auth/logout` → 204 (clears cookie).
- `GET /api/auth/me` → `{user}` | 401.
- `PUT /api/auth/password {current, new}` → 204.

### Bootstrap (everything the client needs)
- `GET /api/bootstrap` → `{ user, campaigns, characters, notes, serverTime }`
  - `campaigns[]`: `{id, name, dm_id, dm_name, invite_code (only when I am DM, else null), members:[{id, username}], created}` — campaigns I DM plus campaigns I belong to.
  - `characters[]`: flattened character objects (§2.1). Visible: mine (including my trashed ones with `deleted` set) + every non-deleted character whose `campaign_id` is a campaign I DM or belong to. `can_edit` = I own it. `can_override` = I own it or I DM its campaign.
  - `notes[]`: `{id, owner_id, owner_name, campaign_id, characterId, title, folder, body, tags, shared, can_edit, created, updated, deleted}`. Visible: mine (incl. trashed) + all non-deleted notes whose `campaign_id` is a campaign I DM + non-deleted notes whose `campaign_id` is a campaign I belong to AND whose owner is that campaign's DM AND `shared=1`.
  - Records deleted more than 30 days ago are purged during bootstrap.

### Characters
- `POST /api/characters` body: character JSON (no server fields) plus optional `"xml": "<string>"` → 201 flattened. With xml: `source='aurora'`, file saved. Without: `source='manual'`.
- `PUT /api/characters/{id}` body: flattened object → 200 flattened. Owner only. Server strips server fields, and for `source='aurora'` copies base fields (§2.1) from the stored record.
- `PUT /api/characters/{id}/aurora {data, xml}` → 200 flattened. Owner only. Replaces the XML file and stores `data` wholesale (sets `source='aurora'`).
- `PUT /api/characters/{id}/overrides {overrides:[...]}` → 200 flattened. Owner or DM of its campaign. Only the `overrides` array changes.
- `PUT /api/characters/{id}/campaign {campaign_id}` (null allowed) → 200 flattened. Owner only; must DM or belong to that campaign.
- `DELETE /api/characters/{id}` → 204 soft delete; `POST /api/characters/{id}/restore` → 200; `DELETE /api/characters/{id}/purge` → 204 hard delete (owner).
- `GET /api/characters/{id}/aurora.dnd5e` → the stored XML with session data written back (§3.1), `Content-Disposition: attachment; filename="<name>.dnd5e"`. Owner or campaign DM. 404 when no XML.

### 3.1 Aurora write-back (`server/aurora_patch.py`, pure function `patch_aurora(xml: str, ch: dict) -> str`)
Regex replacements on the raw text; everything else byte-for-byte unchanged; a tag that is absent is left absent:
- `<build><input><name>` ← `ch.name`; `<experience>` ← `ch.xp`
- `<currency><copper|silver|electrum|gold|platinum>` ← `ch.coins.cp|sp|ep|gp|pp`
- `<backstory>`, `<background-traits>`, `<background-ideals>`, `<background-bonds>`, `<background-flaws>` ← `ch.bio.backstory|traits|ideals|bonds|flaws` as `<![CDATA[...]]>` (split any `]]>` inside the text)
- `<organization><allies>` ← `ch.bio.allies`
- `<notes><note column="left">` ← plain-text session summary: date, HP current/max/temp, conditions, exhaustion, spell slots used, active overrides (one per line), `Exported from Tome & Table`.
Only the first occurrence inside `<build>…<input>…</input>` is touched.

### Notes
- `POST /api/notes {title, folder, body, tags, characterId, campaign_id, shared}` → 201; `PUT /api/notes/{id}` → 200 (owner); `DELETE /api/notes/{id}` → 204 soft; `POST /api/notes/{id}/restore`; `DELETE /api/notes/{id}/purge`.
- `campaign_id` must be a campaign the owner DMs or belongs to (else 400). `shared` is stored as 1 only when the owner is the DM of `campaign_id`; otherwise forced to 0.

### Campaigns
- `POST /api/campaigns {name}` → 201 campaign (I am DM; `invite_code` = 8 upper-case alphanumerics).
- `POST /api/campaigns/join {code}` → 200 campaign (adds me as member; DM cannot join own campaign; idempotent).
- `PUT /api/campaigns/{id} {name}` → 200 (DM). `POST /api/campaigns/{id}/invite/rotate` → 200 campaign with new code (DM).
- `POST /api/campaigns/{id}/leave` → 204 (member). Clears `campaign_id` on my characters and notes in it.
- `POST /api/campaigns/{id}/members/{user_id}/remove` → 204 (DM); clears that user's characters' and notes' `campaign_id` for it.
- `DELETE /api/campaigns/{id}` → 204 (DM); clears `campaign_id` on every record in it and removes members.

### Misc
- `GET /api/health` → `{ok:true}`. Static files: `web/` mounted at `/` (`/` → `index.html`). `/api/*` is never cached by the service worker.
- Env: `DATA_DIR` (default `./data` relative to the repo root), `PORT` (8787), `SESSION_DAYS` (30), `ALLOW_SIGNUP` (1), `COOKIE_SECURE` (auto).

## 4. Client changes (`web/js`)

- `api.js` — fetch wrapper (credentials: same-origin, JSON, the CSRF header, 401 → show auth screen).
- `auth.js` — full-screen sign-in / create-account panel; shown when bootstrap returns 401.
- `app.js` — state comes from `/api/bootstrap`; every save is a PUT/POST; a 20 s poll refreshes records I do not own (and the `overrides` of my own characters when I have no pending save). IndexedDB `store.js` remains only for the one-time "Import this browser's old local data" action in Settings.
- `campaign.js` — new **Campaign** view (nav item between Notes and Search): my campaigns, create, join by code, members, invite code (DM), characters in the campaign, leave/remove/delete; DM sees "Players' notes" counts.
- `sheet.js` — renders the **effective** character (`applyOverrides`). Permission pass after render: when `!can_edit` every input/select/textarea is disabled and every button is disabled except those marked `data-ro-ok` (tabs, spell info, override panel for DMs). When `source==='aurora'` the base controls (`data-base`) are disabled with a lock tooltip. New header items: **Overrides** button (count badge) opening the overrides panel; **Update from Aurora** (owner, re-import merging per §4.1); **Download .dnd5e** (when `has_aurora`). Campaign assignment lives in the details dialog.
- Spells tab: an **info** button (ⓘ) beside Edit/Delete opens a modal with the SRD description (`js/spells.js`, `js/data/srd-spells.json`) plus the user's own notes; "Add spell" offers SRD name suggestions. Unknown spells show "No SRD entry" and the notes only.
- `notes.js` — default mode is WYSIWYG (`js/wysiwyg.js`); a "Markdown" toggle reveals the source textarea for power users. Read-only notes (others') render with `contenteditable=false` and a banner naming the owner. Properties gain **Campaign** and, for the DM, **Share with players** (checkbox). Sidebar sections: My notes · Shared by the DM · Players' notes (DM only, grouped by player).

### 4.1 Re-import merge (client, `aurora.js: mergeAurora(existing, imported)`)
Take from the new file: race, classes, background, alignment, abilities, saveProf, skillProf, features (replace), spells (replace, preserving `prepared`/`notes` by name), slot maxima (used clamped), hitDice total/die (used clamped), xp = max(old, new), portrait if new one present. Keep from the app: name, hp (max += levels gained × (⌊die/2⌋+1+Con)), hitDice.used, deathSaves, conditions, exhaustion, inspiration, inventory, coins, attacks, quickActions, bio (unless the app's field is empty), overrides, acNote/ac/speed, senses/defenses/languages/otherProficiencies.

## 5. WYSIWYG editor contract (`web/js/wysiwyg.js`)

```js
export function htmlToMarkdown(rootElement) → string
export function createEditor({ mount, markdown, readOnly, resolveLink, titles, onChange, onOpenLink, onTag })
  → { setMarkdown(md), getMarkdown(), focus(), destroy(), exec(command, arg) }
```
`mount` receives a `div.wysiwyg[contenteditable]` filled with `render(markdown, {resolveLink})` from `markdown.js`.
`exec` commands: `bold`, `italic`, `strike`, `highlight`, `code`, `h1`, `h2`, `h3`, `paragraph`, `ul`, `ol`, `task`,
`quote`, `hr`, `link` (arg: url), `wikilink` (arg: title), `tag` (arg: tag), `table`, `undo`, `redo`, `insertText` (arg).
Typing `[[Title]]` converts to a wikilink anchor at the caret; clicking a wikilink calls `onOpenLink(title)`; clicking a
tag calls `onTag(tag)`; clicking a task checkbox toggles it. `onChange(markdown)` fires (debounced ≤ 300 ms) after edits.
`htmlToMarkdown` must round-trip every construct `markdown.js` renders (headings 1–6, paragraphs with `<br>`, bold,
italic, strike, highlight, inline code, fenced code, wikilinks with alias, tags, external links, images, ul/ol with
nesting, task items, blockquotes, hr, tables with alignment) and tolerate browser-generated HTML (`div`, `b`, `i`,
`span style`, `&nbsp;`, nested lists created by indent). Tests live in `web/tests.html` (round-trip idempotence).

## 6. Spells contract (`web/js/spells.js`, `web/js/data/srd-spells.json`)

JSON: array of `{ name, level, school, time, range, components, material, duration, concentration, ritual, classes, desc, higher }`
(`desc` = paragraphs joined with blank lines, tables kept as markdown; `higher` = "At Higher Levels" text or "").
Source: SRD 5.1 via dnd5eapi.co (CC-BY-4.0); attribution in `web/LICENSES/SRD-5.1-CC-BY-4.0.txt` and in Settings.
```js
export async function loadSpells()            // fetches + caches the JSON once
export function findSpell(name)               // case/punctuation-insensitive, handles ’ vs '
export function searchSpells(query, limit=8)  // prefix/substring name search
export function spellSummary(spell)           // "1st-level evocation · 1 action · 120 ft · V, S · Instantaneous"
```

## 7. Permissions summary

| Action | Owner | Campaign DM | Other player in campaign | Outsider |
|---|---|---|---|---|
| View character sheet | yes | yes | yes (read-only) | no |
| Edit tracked state (HP, slots used, inventory, attacks, spells list, features, bio, coins, XP) | yes | no | no | no |
| Edit base stats (abilities, profs, slot max, class/level) | only if `source='manual'` | no | no | no |
| Add / remove overrides | yes | yes | no | no |
| Download `.dnd5e` | yes | yes | no | no |
| Re-import `.dnd5e` | yes | no | no | no |
| View a note | owner | all notes in the campaign | DM's shared notes only | no |
| Edit a note / share toggle | owner (share: DM only) | no | no | no |
| Assign character to campaign | owner (must be member/DM) | no | no | no |

## 8. Testing

- `server/test_api.py` (FastAPI TestClient, temp DATA_DIR): signup/login/logout, lockout, CSRF header, character CRUD,
  base-field lock enforcement, overrides by owner and DM only, campaign create/join/leave/remove/delete and resulting
  visibility of characters and notes, shared-note rules, Aurora download patching (XP, coins, CDATA, notes block).
- `web/tests.html`: existing tests + `applyOverrides`, rest expiry, `mergeAurora`, WYSIWYG round-trip, spells lookup.
- Manual: two browser profiles (DM + player) against the Docker container.

## 9. Implementation notes (post-build, 2026-10-13)

- Built by three parallel Opus agents (server, WYSIWYG editor, SRD spells) against this contract; the client integration was done by hand. Validation: 430 server tests (`py -m server.test_api`), 88 browser tests (`web/tests.html`), a scripted DM/player/outsider flow (33 checks) and manual UI checks through the DM's browser.
- Server interpretations worth knowing: ordinary `PUT /api/characters/{id}` accepts `overrides` (rests expire them client-side); invisible records return 404, visible-but-forbidden 403; the password-change endpoint returns 403 (not 401) on a wrong current password; `shared` is stored as 0/1; invite codes are matched case-insensitively.
- `markdown.js` now extracts wikilinks and code spans before HTML-escaping (titles with `'`, `&`, `<` used to break).
- The editor verifies the effect of native `execCommand` list toggles, lifts lists that Chrome nests inside `<p>`, re-wraps loose inline content in `<p>` after commands, and supports toggling a list off.
- `sw.js` is network-first on localhost (development) and cache-first elsewhere; `/api/*` is never cached.
- Not verified here: the Docker image build (Docker Desktop was not running on the build machine). The Dockerfile and compose file were reviewed and `docker compose config` parses.
- Aurora content (added 2026-10-13, after the first live use): `.dnd5e` files reference features by element id only, so descriptions were empty on import. `web/js/auroraContent.js` parses Aurora's content XML (`<element>` → `<description>`, `<sheet usage action>` with level variants, `<setters>`) in the browser; `PUT /api/aurora/elements` stores compact entries instance-wide (`aurora_elements` table); `POST /api/aurora/elements/lookup` resolves ids/names; `parseAurora` now keeps `auroraId` on features and spells; imports, re-imports and the Features tab's "Fill descriptions from Aurora" fill text and usage counters; the spell ⓘ falls back to Aurora text for non-SRD spells. The server's catch-all `/api/{rest:path}` route must stay last on the router.
