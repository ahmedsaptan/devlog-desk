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

## Release to GitHub (Maintainers)

This repo includes an automated release workflow at `.github/workflows/release.yml`.

### What it does

- Triggers on tag push (`v*`) and optional manual dispatch.
- Builds installers for macOS, Windows, and Linux.
- Creates/updates a GitHub Release and uploads installers as assets.

### Publish a new version

1. Update versions:
   - `package.json`
   - `src-tauri/tauri.conf.json`
   - `src-tauri/Cargo.toml` (recommended to keep aligned)
2. Commit and push your changes.
3. Create and push a version tag:

```bash
git tag v0.2.0
git push origin v0.2.0
```

4. Wait for the `release` GitHub Action to finish.
5. Share the Release URL with users for easy installation.

## Local Development

```bash
npm install
npm run tauri dev
```

## Build Locally

```bash
npm run build
npm run tauri build
```
