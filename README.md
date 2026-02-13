# DevLog Desk (Tauri MVP)

A cross-platform desktop app for software engineers to log daily updates inside sprints and generate sprint-review reports.

## Why this fits your workflow

- Track updates daily by category: `Tasks`, `PR Reviews`, `Meetings`.
- Organize updates under specific sprints (for example `Sprint 150`).
- Generate markdown reports on demand with filters (date range + categories).
- Useful for biweekly sprint-end meetings where you may only include `Tasks`.

## Suggested project names

- DevLog Desk (chosen in this scaffold)
- Sprint Ledger
- DevLog Desk
- Standup Vault
- Sprint Notes Hub
- ShipLog
- Dev Sprint Journal
- Workstream Chronicle

## Tech stack

- Desktop shell: Tauri (Rust)
- UI: React + TypeScript + Vite
- Storage: local SQLite database in app data directory
- Report output: markdown files under app data `reports/`

## Data model

- `Sprint`
  - `id`, `name`, `start_date`, `end_date`, `created_at`
- `DailyEntry`
  - `id`, `sprint_id`, `date`, `category`, `title`, `details`, `created_at`
- `EntryCategory`
  - `task | review | meeting`

## Commands exposed from Rust

- `list_sprints`
- `create_sprint`
- `list_entries_for_sprint`
- `add_daily_entry`
- `generate_report`
- `get_data_path`

## Run locally

1. Install dependencies:
   - `npm install`
2. Run desktop app:
   - `npm run tauri dev`

## Current project structure

```txt
.
├── package.json
├── index.html
├── src
│   ├── App.tsx
│   ├── main.tsx
│   ├── styles.css
│   └── lib
│       ├── api.ts
│       └── types.ts
└── src-tauri
    ├── Cargo.toml
    ├── build.rs
    ├── tauri.conf.json
    ├── capabilities
    │   └── default.json
    └── src
        └── main.rs
```

## Next iteration ideas

- Edit/delete entries and sprints.
- Search and tag support.
- Export PDF/CSV in addition to markdown.
- Optional SQLite backend for larger datasets.
- Team sync mode with remote API.
