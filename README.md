# Undead Legacy Research Tree IDE

A local visual editor for the **research tree** of [Undead Legacy](http://ul.subquake.com) (7 Days to Die). Drop it into your game's `Mods/` folder, double-click `启动IDE.bat`, and every installed mod's research tree opens as an interactive graph — edit nodes, rename with automatic reference updates, tweak unlocks and costs, then export with full validation and automatic backup.

**This is a local Node.js application, not a website.** It runs on your machine only — there is nothing hosted here (this repository is not a GitHub Pages site); opening the files directly in a browser or hosting them does nothing. You need Node.js 18+ installed, the server started (`启动IDE.bat` does it for you), and then a browser pointed at the local URL it prints.

**Safety rails.** Every export is validated (errors block writing), original files are backed up automatically, files you never touch are re-serialized byte-for-byte identical, and unknown XML data is always preserved.

**Scope.** The research tree (`Config/Custom/recipes_research.xml`) is the main feature, covering all installed mods at once. The progression tree (`Config/progression.xml`, vanilla perk/skill format) is optional and off by default. The radial skill layouts in `Config/Custom/recipes_skills.xml` are out of scope.

No build step, no dependencies — just Node.js 18+ and a browser.

## Features

- Multi-mod scan of the whole `Mods/` folder, filterable by mod and research branch
- Interactive SVG graph: search, zoom, pan, multi-select, drag (view-only layout)
- Inspector editing: IDs (cascade rename across referencing files), icons, prerequisites, unlocks, ingredient costs, categories
- Undo/redo for every edit (Ctrl+Z / Ctrl+Y), including deletions
- Validation with a clickable problem list; errors block export
- Line-level diff and structured change summary
- Export with automatic backup of the original files
- Bilingual display names (Chinese/English) plus user-added language files for search
- UI available in Chinese or English — toggle in the top bar, choice is remembered
- Byte-identical round-trip: untouched files are re-serialized exactly as they were, unknown data is preserved

## Getting started

1. Put this folder anywhere inside the game's `Mods/` directory (e.g. `Mods/ULTechTreeIDE/`). It does not affect the game while you edit — changes reach the game only after export.
2. **Double-click `启动IDE.bat`** (recommended). The launcher checks Node.js, reuses an already-running IDE instance if one answers its health check, otherwise starts `node server.js`, waits for the health check, and opens the **real** URL in your browser.

   Or start it manually:

   ```bash
   node server.js      # or: npm start
   ```

3. **Never assume port 8899.** 8899 is only the default preferred port — when it is busy the server automatically picks the next free one, and `UL_IDE_PORT` can point it anywhere else. The console banner, the launcher output and <http://127.0.0.1:8899/api/health> (on whatever port it actually took) always tell you the real address.

The launcher itself opens the browser; set `UL_NO_BROWSER=1` to skip that (scripted runs). The server never opens a browser by itself.

## Startup, ports & diagnostics

- **Port management lives only in `server.js`.** Resolution order: `UL_IDE_PORT` → `8899`; while the preferred port is busy it walks upward (a few attempts). To pin a port: `set UL_IDE_PORT=9000` before starting (the `.bat` passes your environment through to Node).
- **`GET /api/health`** is the only accepted proof that a port is running this IDE:
  ```json
  { "ok": true, "service": "UL-IDE", "version": "1.1.0", "pid": 12345, "host": "127.0.0.1", "port": 8899 }
  ```
  Anything else answering on a port — an unrelated HTTP server, an old IDE build — is not trusted, even if the port responds.
- **`.runtime/instance.json`** is written by the server once it is actually listening (`pid`, `host`, `port`, `url`, `startedAt`) and deleted on clean shutdown. It is a *hint* for the launcher: after a crash it may go stale, so the launcher always re-verifies it through `/api/health` before reusing it — and removes the stale file otherwise. The folder is gitignored.
- **Already-running detection:** `启动IDE.bat` (via `launch.mjs`) reads the instance file, asks `/api/health`, and if a healthy UL-IDE answers it just opens that URL instead of starting a second server.
- **Mods folder detection** (highest priority first): `UL_MODS_DIR` → the folder holding the IDE contains a `ModInfo.xml` (IDE inside a single mod) → the folder holding the IDE *is* the `Mods` folder (by name or because a sibling folder ships `ModInfo.xml`) → walking up the tree to any `<…>/7 Days To Die/Mods`. If nothing matches, the server still starts but warns loudly and scans nothing until you point it somewhere. **`/api/defaults` always returns the resolved `modsDir`** (plus `modsDirSource` / `modsDirWarning`) — check it when scans come up empty.

### Configuration

| Variable | Purpose | Default |
|---|---|---|
| `UL_IDE_PORT` | preferred server port (auto-increments while busy; the server owns the final choice) | `8899` |
| `UL_MODS_DIR` | Mods folder to scan | auto-detected (see *Startup, ports & diagnostics*) |
| `UL_VANILLA_CONFIG` | game `Data/Config` folder (read-only, for name/icon lookups) | **auto-detected**: the game folder containing the Mods folder, then Steam libraries (`libraryfolders.vdf` + Windows registry + common drives) |
| `UL_NO_BROWSER` | `1` stops the *launcher* from opening the browser (the server never opens one) | unset |

`UL_VANILLA_CONFIG` only needs to be set when auto-detection fails (unusual install layout) — without it the IDE still works, but vanilla localization fallback and icons are limited (the server log tells you when that happens). Added language files live in `langs/`, backups in `backups/`, export copies in `export/`.

## How to use

1. **Browse** — use the left panel to search or filter by mod/branch; `F` fits the view, wheel zooms, drag pans, Shift+drag box-selects, double-click focuses a node.
2. **Edit** — click a node and edit it in the right-hand inspector. Renaming an ID updates every reference across all files. Dragging nodes only moves them in the editor view (stored locally, never written to XML) — the game arranges its tree by itself at runtime.
3. **Validate** — the Validate button runs all checks; problems are clickable and any error blocks export until fixed.
4. **Review** — the Diff tab shows line-level and structured changes per file; the XML Preview tab shows exactly what would be written.
5. **Export** — Save/Export validates, backs up the original files to `backups/<timestamp>/`, then writes only the changed files back to the mod folder (copy kept in `export/`).
6. **Undo** — Ctrl+Z / Ctrl+Y reverts and redoes any edit.

## Adding language files

Left panel → *Language files* → **Add language file**: pick a UTF-8 two-column CSV (`Key,Translation`, same format as mod localization files). The file is stored under `langs/` and its translations immediately become searchable — in the graph search box and in the name suggestion fields, which show `language: translation · key`. Node display names always use Chinese/English. Remove a file with ✕.

## Testing

```bash
npm test        # core regression (round-trip, parser, commands…) + startup tests
node test/run-tests.js      # core regression only
node test/startup.test.js   # startup tests only: /api/health, ports, instance file, launcher
```

The startup tests spawn real `node server.js` / `node launch.mjs` processes on 127.0.0.1. They use port 8899 for the default-port assertion when it is free, and fall back to asserting an incremented port when something already occupies it (e.g. your running IDE). Set `UL_VANILLA_ROOT` to your game folder to enable the vanilla-localization assertions in the core suite (skipped automatically when not available).

## Notices

- This is an unofficial, fan-made utility. It is **not affiliated with** Subquake (Undead Legacy) or The Fun Pimps.
- It does **not** copy or redistribute any Undead Legacy or game content. It only edits the XML files already installed in your own game, in place, always after an automatic backup.
- You are responsible for using modified files in accordance with the **Undead Legacy terms of use** (<http://ul.subquake.com>) and the 7 Days to Die EULA — in particular, do not redistribute modified Undead Legacy files without the permissions those terms require.
- The built-in backup is a convenience, not a guarantee — keep your own backups as well.
