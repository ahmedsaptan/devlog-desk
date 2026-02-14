# DevLog Desk

DevLog Desk is a Tauri desktop app for tracking daily engineering updates inside sprints and exporting clean sprint reports.

## Features

- Sprint management with automatic sprint codes (`sprint-1`, `sprint-2`, ...).
- Configurable sprint duration defaults (1 week or 2 weeks).
- Dynamic categories (create, rename, delete, auto-reassign items on delete).
- Daily timeline grouped by date and category.
- Quick copy per day in plain text or rich text format.
- Smart paste support for links (`[selected text](https://...)`).
- Markdown report generation with date and category filters.
- Reports saved locally to the app data `reports/` directory.
- Menu bar/tray actions:
  - Add new item to current sprint
  - Add new sprint
  - Toggle tray icon visibility
  - Custom global shortcut (default: `CmdOrCtrl+Shift+N`)
- Theme controls:
  - System / Light / Dark mode
  - Multiple color palettes
- Local-first storage in SQLite (no cloud dependency).

## Install (End Users)

1. Open the [GitHub Releases](https://github.com/ahmedsaptan/devlog-desk/releases) page.
2. Download the installer for your OS:
   - macOS: `.dmg`
   - Windows: installer bundle from release assets
   - Linux: package bundle from release assets
3. Install and launch DevLog Desk.

## Manual Release (Maintainers)

Releases are created manually so you can control the final title, notes, and attached assets.

### 1) Build installers on each OS

- macOS:

```bash
npm install
npm run tauri:release:dmg
```

- Windows:

```bash
npm install
npm run tauri:release
```

- Linux:

```bash
npm install
npm run tauri:release
```

Release bundles are generated under `src-tauri/target/release/bundle/`.

### 2) Create and push a version tag

```bash
git tag v0.2.1
git push origin v0.2.1
```

### 3) Create release on GitHub

1. Open [Releases](https://github.com/ahmedsaptan/devlog-desk/releases).
2. Click `Draft a new release`.
3. Select tag `v0.2.1`.
4. Title example: `DevLog Desk v0.2.1`.
5. Upload installer files from each OS build.
6. Paste release notes (template below), then publish.

### Release Notes Template

```md
## DevLog Desk v0.2.1

### What's New
- Improved sprint tracking and report flow.
- UI and settings refinements.

### Fixes
- Bug fixes and stability improvements.

### Install
- Download the installer for your OS from the assets below.
```

## Local Development

```bash
npm install
npm run tauri dev
```

## CLI

Run the interactive CLI:

```bash
npm run cli
```

Navigation keys:

- `Up/Down`: move between options
- `Space` or `Enter`: select option
- `Left`: go back
- `Q`: quit

CLI features:

- list all sprints
- enter sprint and view summary
- pick a specific date and view full details
- view all sprint details
- copy one day data to clipboard
- generate sprint markdown report

Optional environment overrides:

- `DEVLOG_DB_PATH`: direct SQLite database path
- `DEVLOG_DATA_DIR`: app data root (used for database and reports)

## Build Locally

```bash
npm run build
npm run tauri build
```
