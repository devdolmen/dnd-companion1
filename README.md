# Tome & Table

A self-hosted D&D 5e companion for a group: character sheets fed by **Aurora Builder** files, an
Obsidian-style campaign notebook with direct (WYSIWYG) editing, campaigns with a DM and players,
SRD spell descriptions, and an override system for in-play modifiers. The web app is plain
HTML/CSS/JS; the server is a small Python (FastAPI + SQLite) service that runs in Docker.

- **Accounts**: username + password. Everything is stored on your server, per user.
- **Campaigns**: the creator is the DM and can read every sheet and note in the campaign. Players read each other's sheets but never each other's notes. The DM can tick *Share with players* on any of their notes.
- **Aurora round-trip**: import a `.dnd5e`, play, download it again with XP, coins and bio written back, level up in Aurora, re-import. Base statistics (ability scores, proficiencies, slot maxima, class/level) stay locked to the file.
- **Overrides**: magic items, spells, blessings and rulings as modifiers that last permanently, until the next short rest, until the next long rest, or until cancelled. The DM can add them to any character in the campaign.
- **Notes**: edited directly in the rendered view with a toolbar; `[[links]]`, `#tags`, backlinks, folders, search. Markdown source is one click away for power users.
- **Spells**: an ⓘ button beside every spell shows the SRD 5.1 description (CC-BY-4.0); "Add spell" suggests SRD names.
- **Features**: active abilities, passive traits and proficiencies in separate sections; each description sits under its name and can be minimised with the chevron (or the name), with *Expand all* / *Minimise all* for the whole tab. Minimised state is remembered per device.
- No dice roller, by design.

---

## 1. Run it with Docker (home server or this PC)

```bash
docker compose up -d --build
```

Open http://localhost:8787/ (or `http://<server-ip>:8787/` from the Chromebook) and create the first
account. Data lives in `./data/` next to `docker-compose.yml` (`tome.db` plus `aurora/*.dnd5e`).
Back that folder up.

Environment variables (set them in `docker-compose.yml`):

| Variable | Default | Meaning |
|---|---|---|
| `ALLOW_SIGNUP` | `1` | Set to `0` once your group has signed up to stop new registrations. |
| `SESSION_DAYS` | `30` | How long a sign-in lasts. |
| `COOKIE_SECURE` | auto | Set to `1` when you serve the app over HTTPS behind a proxy. |
| `DATA_DIR` | `/data` | Where the database and Aurora files are kept inside the container. |

Update after changing files:

```bash
docker compose up -d --build
```

### Without Docker (development on Windows)

```bash
py -m uvicorn server.app:app --port 8787 --app-dir dnd-companion
```

Then open http://localhost:8787/. Unit tests for the web app: http://localhost:8787/tests.html.
Server tests:

```bash
py -m server.test_api
```

### HTTPS and installing on the Chromebook

The app runs over plain HTTP on your LAN. Chrome only offers "Install app" and offline caching on
secure origins, so either put Caddy or another reverse proxy with HTTPS in front of port 8787, or on
the Chromebook open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, add
`http://<server-ip>:8787`, and relaunch. Use one stable URL: browser settings such as layout and
colour scheme are stored per origin.

## 2. Aurora Builder workflow

1. Build the character in Aurora Builder and save it (`Documents\5e Character Builder\<name>.dnd5e`).
2. **Party → Import Aurora / JSON** and choose the file. The sheet is created with `Aurora` lock badge.
3. Play. Track HP, slots, conditions, inventory, coins, XP and notes freely. Anything that would change
   the base sheet (a +1 ring, Bless, a curse, a house rule) goes in **Overrides**.
4. After the session: **Download .dnd5e**. The file is the one you uploaded with name, XP, coins,
   backstory, personality fields and allies written back, plus a session summary in Aurora's notes box.
5. Level up in Aurora, save, then **Update from Aurora** on the sheet. Base statistics, features and
   spells come from the new file; current HP, used slots, conditions, inventory, coins, overrides and
   notes are kept, and max HP rises by the average per level gained.

Aurora stores base ability scores before racial bonuses in some builds; check the six scores after
the first import.

### Feature descriptions (Aurora content)

A `.dnd5e` file only names your features; the descriptions live in Aurora Builder's content files.
Upload them once per server: **Settings → Aurora content → Upload Aurora content folder** and pick
`Documents\5e Character Builder\custom` (the whole folder, about 1,500 XML files). The browser reads
the files locally and sends only the descriptions, sheet summaries, usage ("1/Long Rest") and spell
details to the server, where everyone at the table shares them. After that:

- new imports and *Update from Aurora* fill every feature's description and set limited-use counters
  such as "1 per long rest" automatically;
- **Fill descriptions from Aurora** on the Features tab does the same for characters imported earlier;
- the spell ⓘ button falls back to Aurora's text for spells that are not in the SRD (homebrew).

Homebrew packs in `custom\user\` (for example *Wrath of Olympus*) are included when you upload the
folder, so Gorgonblood traits and Stonegaze features get their text too.

## 3. Campaigns and permissions

| Action | Owner | Campaign DM | Other player | Outsider |
|---|---|---|---|---|
| View character sheet | yes | yes | yes (read-only) | no |
| Edit HP, slots used, inventory, attacks, spell list, features, bio, coins, XP | yes | no | no | no |
| Edit base stats (abilities, proficiencies, slot maxima, class/level) | only for hand-made characters | no | no | no |
| Add / remove overrides | yes | yes | no | no |
| Download / re-import `.dnd5e` | yes | download only | no | no |
| Read a note | owner | all notes in the campaign | DM's shared notes only | no |
| Edit a note, share it | owner (share: DM only) | no | no | no |

Create a campaign under **Campaign**, give players the invite code, and have each player set the
campaign on their sheet (details dialog) or from the campaign page. Notes get a *Campaign* property
in the right-hand panel; the DM also sees *Share with players*.

## 4. Layouts and colour schemes

Five layouts and ten colour schemes, chosen in Settings and stored per device. `Ctrl+Shift+L` and
`Ctrl+Shift+C` cycle them; the command palette (`Ctrl+K`, `Ctrl+/`, or the Search button) lists
them as commands.

## 5. Project layout

```
web/                    static web app (index.html, css/, js/, icons/, tests.html)
  js/api.js             fetch wrapper
  js/auth.js            sign-in screen
  js/app.js             state, routing, polling, settings, command palette
  js/sheet.js           party + character sheet (permissions, overrides, Aurora round-trip, spell info)
  js/notes.js           notes (WYSIWYG via js/wysiwyg.js, sharing, read-only views)
  js/campaign.js        campaign view
  js/rules.js           5e maths + overrides (pure)
  js/aurora.js          .dnd5e importer + re-import merge (pure)
  js/spells.js          SRD spell lookup; data in js/data/srd-spells.json
  js/data/overrides.js  override target catalogue
server/                 FastAPI app, SQLite, Aurora write-back, test_api.py
data/                   runtime data (gitignored)
Dockerfile, docker-compose.yml, requirements.txt
docs/superpowers/specs  design documents (v1 and the v2 multi-user contract)
```

## 6. Updating

Edit the files, bump `VERSION` in `web/sw.js`, and rebuild the container. Signed-in browsers pick up
the new version on their next load. On `localhost` the service worker is network-first, so edits show
up immediately while developing; on any other host it is cache-first and only the version bump
triggers a refresh.

To start from a clean database, stop the server or container and delete `data/tome.db*` and
`data/aurora/`. The first account created afterwards starts with just a welcome note.

## 7. Licences

Spell text is from the System Reference Document 5.1 by Wizards of the Coast LLC, licensed under
CC-BY-4.0; see `web/LICENSES/SRD-5.1-CC-BY-4.0.txt`. Everything else in this repository is yours.
