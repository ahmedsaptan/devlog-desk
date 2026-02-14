use chrono::{Duration, Local, NaiveDate, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use tauri::{
    menu::{MenuBuilder, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, Runtime,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Category {
    id: String,
    name: String,
    created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Sprint {
    id: String,
    #[serde(default)]
    code: String,
    name: String,
    start_date: String,
    end_date: Option<String>,
    created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DailyEntry {
    id: String,
    sprint_id: String,
    date: String,
    #[serde(alias = "category")]
    category_id: String,
    title: String,
    details: Option<String>,
    created_at: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct AppData {
    #[serde(default)]
    categories: Vec<Category>,
    #[serde(default)]
    sprints: Vec<Sprint>,
    #[serde(default)]
    entries: Vec<DailyEntry>,
}

#[derive(Debug, Deserialize)]
struct NewCategoryInput {
    name: String,
}

#[derive(Debug, Deserialize)]
struct UpdateCategoryInput {
    id: String,
    name: String,
}

#[derive(Debug, Deserialize)]
struct DeleteCategoryInput {
    id: String,
    replacement_category_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct NewSprintInput {
    name: Option<String>,
    start_date: String,
    duration_days: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct UpdateSprintNameInput {
    id: String,
    name: String,
}

#[derive(Debug, Deserialize)]
struct DeleteSprintInput {
    id: String,
}

#[derive(Debug, Deserialize)]
struct NewDailyEntryInput {
    sprint_id: String,
    date: String,
    category_id: String,
    title: String,
    details: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ReportInput {
    sprint_id: String,
    from_date: Option<String>,
    to_date: Option<String>,
    categories: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct MenubarSettingsInput {
    show_icon: bool,
    add_item_shortcut: Option<String>,
}

#[derive(Debug, Serialize)]
struct ReportOutput {
    markdown: String,
    file_path: String,
    total_items: usize,
}

const TRAY_ICON_ID: &str = "devlog-tray";
const TRAY_MENU_ADD_ITEM_ID: &str = "tray_add_item";
const TRAY_MENU_ADD_SPRINT_ID: &str = "tray_add_sprint";
const TRAY_MENU_QUIT_ID: &str = "tray_quit";
const DEFAULT_ADD_ITEM_SHORTCUT: &str = "CmdOrCtrl+Shift+N";

fn now() -> String {
    Utc::now().to_rfc3339()
}

fn next_id(prefix: &str) -> String {
    let ts = Utc::now().timestamp_nanos_opt().unwrap_or(0);
    format!("{prefix}-{ts}")
}

fn pick_active_sprint_id(sprints: &[Sprint]) -> Option<String> {
    if sprints.is_empty() {
        return None;
    }

    let today = Local::now().date_naive().format("%Y-%m-%d").to_string();
    let mut newest_first = sprints.to_vec();
    newest_first.sort_by(|left, right| right.created_at.cmp(&left.created_at));

    if let Some(ongoing) = newest_first.iter().find(|sprint| {
        let starts_ok = sprint.start_date <= today;
        let ends_ok = sprint
            .end_date
            .as_deref()
            .map(|end_date| end_date >= today.as_str())
            .unwrap_or(true);
        starts_ok && ends_ok
    }) {
        return Some(ongoing.id.clone());
    }

    newest_first.first().map(|sprint| sprint.id.clone())
}

fn app_data_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("unable to resolve app data dir: {error}"))?;

    fs::create_dir_all(&root).map_err(|error| format!("unable to create app data dir: {error}"))?;
    Ok(root)
}

fn db_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let mut path = app_data_root(app)?;
    path.push("daily-updates.sqlite");
    Ok(path)
}

fn legacy_data_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let mut path = app_data_root(app)?;
    path.push("daily-updates-data.json");
    Ok(path)
}

fn reports_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let mut app_data = app_data_root(app)?;
    app_data.push("reports");

    fs::create_dir_all(&app_data)
        .map_err(|error| format!("unable to create reports dir: {error}"))?;
    Ok(app_data)
}

fn slugify(raw: &str) -> String {
    let mut out = String::new();

    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if (ch.is_ascii_whitespace() || ch == '-' || ch == '_') && !out.ends_with('-') {
            out.push('-');
        }
    }

    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "value".to_string()
    } else {
        trimmed.to_string()
    }
}

fn humanize_category_id(raw: &str) -> String {
    let clean = raw.trim().replace(['-', '_'], " ");
    if clean.is_empty() {
        return "Category".to_string();
    }

    clean
        .split_whitespace()
        .map(|word| {
            let mut chars = word.chars();
            if let Some(first) = chars.next() {
                let mut out = String::new();
                out.push(first.to_ascii_uppercase());
                out.push_str(chars.as_str().to_ascii_lowercase().as_str());
                out
            } else {
                String::new()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn within_range(date: &str, from: &Option<String>, to: &Option<String>) -> bool {
    if let Some(start) = from {
        if date < start.as_str() {
            return false;
        }
    }

    if let Some(end) = to {
        if date > end.as_str() {
            return false;
        }
    }

    true
}

fn sprint_number(raw: &str) -> Option<u32> {
    let value = raw.trim().to_ascii_lowercase();
    if value.is_empty() {
        return None;
    }

    if let Ok(number) = value.parse::<u32>() {
        return Some(number);
    }

    let rest = value
        .strip_prefix("sprint-")
        .or_else(|| value.strip_prefix("sprint "))
        .or_else(|| value.strip_prefix("sprint"))?;

    let digits = rest
        .trim()
        .trim_start_matches('-')
        .trim_start_matches('_')
        .trim();

    digits.parse::<u32>().ok()
}

fn format_sprint_code(number: u32) -> String {
    format!("sprint-{number}")
}

fn default_categories() -> Vec<Category> {
    let created_at = now();

    vec![
        Category {
            id: "preview".to_string(),
            name: "Preview".to_string(),
            created_at: created_at.clone(),
        },
        Category {
            id: "meeting".to_string(),
            name: "Meeting".to_string(),
            created_at: created_at.clone(),
        },
        Category {
            id: "tasks".to_string(),
            name: "Tasks".to_string(),
            created_at,
        },
    ]
}

fn ensure_default_categories(data: &mut AppData) {
    if data.categories.is_empty() {
        data.categories = default_categories();
    }
}

fn assign_missing_sprint_codes(data: &mut AppData) -> bool {
    let mut changed = false;
    let mut highest = data
        .sprints
        .iter()
        .filter_map(|sprint| sprint_number(&sprint.code).or_else(|| sprint_number(&sprint.name)))
        .max()
        .unwrap_or(0);

    let mut index_list = (0..data.sprints.len()).collect::<Vec<_>>();
    index_list.sort_by(|left, right| {
        data.sprints[*left]
            .created_at
            .cmp(&data.sprints[*right].created_at)
    });

    for index in &index_list {
        let sprint = &mut data.sprints[*index];

        if sprint.code.trim().is_empty() {
            if let Some(number) = sprint_number(&sprint.name) {
                sprint.code = format_sprint_code(number);
                if number > highest {
                    highest = number;
                }
                changed = true;
            }
        } else if let Some(number) = sprint_number(&sprint.code) {
            let normalized = format_sprint_code(number);
            if sprint.code != normalized {
                sprint.code = normalized;
                changed = true;
            }
            if number > highest {
                highest = number;
            }
        }
    }

    for index in &index_list {
        let sprint = &mut data.sprints[*index];
        if sprint.code.trim().is_empty() {
            highest += 1;
            sprint.code = format_sprint_code(highest);
            changed = true;
        }
    }

    changed
}

fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS categories (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL UNIQUE COLLATE NOCASE,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sprints (
            id TEXT PRIMARY KEY,
            code TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            start_date TEXT NOT NULL,
            end_date TEXT,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS entries (
            id TEXT PRIMARY KEY,
            sprint_id TEXT NOT NULL,
            date TEXT NOT NULL,
            category_id TEXT NOT NULL,
            title TEXT NOT NULL,
            details TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (sprint_id) REFERENCES sprints(id) ON DELETE CASCADE,
            FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE RESTRICT
        );

        CREATE INDEX IF NOT EXISTS idx_entries_sprint_date
            ON entries (sprint_id, date, category_id, created_at);
        ",
    )
    .map_err(|error| format!("failed to initialize database schema: {error}"))
}

fn db_is_empty(conn: &Connection) -> Result<bool, String> {
    let categories_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM categories", [], |row| row.get(0))
        .map_err(|error| format!("failed to count categories: {error}"))?;
    let sprints_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM sprints", [], |row| row.get(0))
        .map_err(|error| format!("failed to count sprints: {error}"))?;
    let entries_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM entries", [], |row| row.get(0))
        .map_err(|error| format!("failed to count entries: {error}"))?;

    Ok(categories_count == 0 && sprints_count == 0 && entries_count == 0)
}

fn migrate_legacy_json_if_needed(app: &AppHandle, conn: &mut Connection) -> Result<(), String> {
    if !db_is_empty(conn)? {
        return Ok(());
    }

    let legacy_path = legacy_data_file_path(app)?;
    if !legacy_path.exists() {
        return Ok(());
    }

    let raw = fs::read_to_string(&legacy_path).map_err(|error| {
        format!(
            "unable to read legacy data file {}: {error}",
            legacy_path.display()
        )
    })?;

    let mut legacy: AppData = serde_json::from_str(&raw).map_err(|error| {
        format!(
            "invalid legacy data format in {}: {error}",
            legacy_path.display()
        )
    })?;

    ensure_default_categories(&mut legacy);
    assign_missing_sprint_codes(&mut legacy);

    let mut known_category_ids = legacy
        .categories
        .iter()
        .map(|category| category.id.clone())
        .collect::<HashSet<_>>();

    for entry in &legacy.entries {
        let category_id = entry.category_id.trim();
        if category_id.is_empty() || known_category_ids.contains(category_id) {
            continue;
        }

        legacy.categories.push(Category {
            id: category_id.to_string(),
            name: humanize_category_id(category_id),
            created_at: now(),
        });
        known_category_ids.insert(category_id.to_string());
    }

    let tx = conn
        .transaction()
        .map_err(|error| format!("failed to start migration transaction: {error}"))?;

    for category in &legacy.categories {
        if category.id.trim().is_empty() || category.name.trim().is_empty() {
            continue;
        }

        tx.execute(
            "INSERT OR IGNORE INTO categories (id, name, created_at) VALUES (?1, ?2, ?3)",
            params![category.id, category.name, category.created_at],
        )
        .map_err(|error| format!("failed to migrate category {}: {error}", category.id))?;
    }

    let mut migrated_sprint_ids = HashSet::new();
    for sprint in &legacy.sprints {
        if sprint.id.trim().is_empty() || sprint.start_date.trim().is_empty() {
            continue;
        }

        let code = if sprint.code.trim().is_empty() {
            format_sprint_code(Utc::now().timestamp_subsec_nanos())
        } else {
            sprint.code.trim().to_string()
        };

        let name = if sprint.name.trim().is_empty() {
            code.clone()
        } else {
            sprint.name.trim().to_string()
        };

        tx.execute(
            "INSERT OR IGNORE INTO sprints (id, code, name, start_date, end_date, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                sprint.id,
                code,
                name,
                sprint.start_date,
                sprint.end_date,
                sprint.created_at
            ],
        )
        .map_err(|error| format!("failed to migrate sprint {}: {error}", sprint.id))?;

        migrated_sprint_ids.insert(sprint.id.clone());
    }

    for entry in &legacy.entries {
        if entry.sprint_id.trim().is_empty()
            || entry.category_id.trim().is_empty()
            || entry.title.trim().is_empty()
            || entry.date.trim().is_empty()
        {
            continue;
        }

        if !migrated_sprint_ids.contains(&entry.sprint_id) {
            continue;
        }

        tx.execute(
            "INSERT OR IGNORE INTO entries (id, sprint_id, date, category_id, title, details, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                if entry.id.trim().is_empty() {
                    next_id("entry-import")
                } else {
                    entry.id.clone()
                },
                entry.sprint_id,
                entry.date,
                entry.category_id,
                entry.title,
                entry.details,
                entry.created_at
            ],
        )
        .map_err(|error| format!("failed to migrate entry {}: {error}", entry.id))?;
    }

    tx.commit()
        .map_err(|error| format!("failed to commit legacy migration: {error}"))?;

    Ok(())
}

fn ensure_default_categories_db(conn: &Connection) -> Result<(), String> {
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM categories", [], |row| row.get(0))
        .map_err(|error| format!("failed to count categories: {error}"))?;

    if count > 0 {
        return Ok(());
    }

    for category in default_categories() {
        conn.execute(
            "INSERT INTO categories (id, name, created_at) VALUES (?1, ?2, ?3)",
            params![category.id, category.name, category.created_at],
        )
        .map_err(|error| format!("failed to seed default category {}: {error}", category.id))?;
    }

    Ok(())
}

fn ensure_sprint_codes_db(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT id, code, name, created_at FROM sprints ORDER BY created_at")
        .map_err(|error| format!("failed to load sprints for code normalization: {error}"))?;

    let mapped = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|error| format!("failed to read sprint rows: {error}"))?;

    let mut rows = mapped
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to collect sprint rows: {error}"))?;

    rows.sort_by(|left, right| left.3.cmp(&right.3));

    let mut used_numbers = HashSet::<u32>::new();
    let mut highest = 0u32;
    let mut updates = Vec::<(String, String)>::new();

    for (id, code, name, _) in &rows {
        let parsed = sprint_number(code).or_else(|| sprint_number(name));

        let chosen = if let Some(value) = parsed {
            if used_numbers.contains(&value) {
                let mut candidate = highest + 1;
                while used_numbers.contains(&candidate) {
                    candidate += 1;
                }
                candidate
            } else {
                value
            }
        } else {
            let mut candidate = highest + 1;
            while used_numbers.contains(&candidate) {
                candidate += 1;
            }
            candidate
        };

        used_numbers.insert(chosen);
        if chosen > highest {
            highest = chosen;
        }

        let normalized = format_sprint_code(chosen);
        if code != &normalized {
            updates.push((id.clone(), normalized));
        }
    }

    for (id, code) in updates {
        conn.execute(
            "UPDATE sprints SET code = ?1 WHERE id = ?2",
            params![code, id],
        )
        .map_err(|error| format!("failed to normalize sprint code: {error}"))?;
    }

    Ok(())
}

fn open_db(app: &AppHandle) -> Result<Connection, String> {
    let db_path = db_file_path(app)?;
    let mut conn = Connection::open(&db_path)
        .map_err(|error| format!("unable to open database {}: {error}", db_path.display()))?;

    init_schema(&conn)?;
    migrate_legacy_json_if_needed(app, &mut conn)?;
    ensure_default_categories_db(&conn)?;
    ensure_sprint_codes_db(&conn)?;

    Ok(conn)
}

fn category_name_exists(
    conn: &Connection,
    name: &str,
    excluding_id: Option<&str>,
) -> Result<bool, String> {
    if let Some(excluding) = excluding_id {
        let existing = conn
            .query_row(
                "SELECT id FROM categories WHERE lower(name) = lower(?1) AND id <> ?2 LIMIT 1",
                params![name, excluding],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| format!("failed to check category uniqueness: {error}"))?;

        Ok(existing.is_some())
    } else {
        let existing = conn
            .query_row(
                "SELECT id FROM categories WHERE lower(name) = lower(?1) LIMIT 1",
                params![name],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| format!("failed to check category uniqueness: {error}"))?;

        Ok(existing.is_some())
    }
}

fn category_exists(conn: &Connection, id: &str) -> Result<bool, String> {
    let existing = conn
        .query_row(
            "SELECT 1 FROM categories WHERE id = ?1 LIMIT 1",
            params![id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| format!("failed to check category existence: {error}"))?;

    Ok(existing.is_some())
}

fn sprint_exists(conn: &Connection, id: &str) -> Result<bool, String> {
    let existing = conn
        .query_row(
            "SELECT 1 FROM sprints WHERE id = ?1 LIMIT 1",
            params![id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| format!("failed to check sprint existence: {error}"))?;

    Ok(existing.is_some())
}

fn list_categories_db(conn: &Connection) -> Result<Vec<Category>, String> {
    let mut stmt = conn
        .prepare("SELECT id, name, created_at FROM categories ORDER BY created_at")
        .map_err(|error| format!("failed to prepare categories query: {error}"))?;

    let rows = stmt
        .query_map([], |row| {
            Ok(Category {
                id: row.get(0)?,
                name: row.get(1)?,
                created_at: row.get(2)?,
            })
        })
        .map_err(|error| format!("failed to query categories: {error}"))?;

    let items = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to collect categories: {error}"))?;

    Ok(items)
}

fn list_sprints_db(conn: &Connection) -> Result<Vec<Sprint>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, code, name, start_date, end_date, created_at FROM sprints ORDER BY created_at",
        )
        .map_err(|error| format!("failed to prepare sprints query: {error}"))?;

    let rows = stmt
        .query_map([], |row| {
            Ok(Sprint {
                id: row.get(0)?,
                code: row.get(1)?,
                name: row.get(2)?,
                start_date: row.get(3)?,
                end_date: row.get(4)?,
                created_at: row.get(5)?,
            })
        })
        .map_err(|error| format!("failed to query sprints: {error}"))?;

    let items = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to collect sprints: {error}"))?;

    Ok(items)
}

fn list_entries_for_sprint_db(
    conn: &Connection,
    sprint_id: &str,
) -> Result<Vec<DailyEntry>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, sprint_id, date, category_id, title, details, created_at
             FROM entries
             WHERE sprint_id = ?1
             ORDER BY date, category_id, created_at",
        )
        .map_err(|error| format!("failed to prepare entries query: {error}"))?;

    let rows = stmt
        .query_map(params![sprint_id], |row| {
            Ok(DailyEntry {
                id: row.get(0)?,
                sprint_id: row.get(1)?,
                date: row.get(2)?,
                category_id: row.get(3)?,
                title: row.get(4)?,
                details: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .map_err(|error| format!("failed to query entries: {error}"))?;

    let items = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to collect entries: {error}"))?;

    Ok(items)
}

fn next_sprint_code_db(conn: &Connection) -> Result<String, String> {
    let mut stmt = conn
        .prepare("SELECT code, name FROM sprints")
        .map_err(|error| format!("failed to prepare next sprint code query: {error}"))?;

    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("failed to query sprint codes: {error}"))?;

    let pairs = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to collect sprint codes: {error}"))?;

    let highest = pairs
        .iter()
        .filter_map(|(code, name)| sprint_number(code).or_else(|| sprint_number(name)))
        .max()
        .unwrap_or(0);

    Ok(format_sprint_code(highest + 1))
}

#[tauri::command]
fn list_categories(app: AppHandle) -> Result<Vec<Category>, String> {
    let conn = open_db(&app)?;
    list_categories_db(&conn)
}

#[tauri::command]
fn create_category(app: AppHandle, input: NewCategoryInput) -> Result<Category, String> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err("category name is required".to_string());
    }

    let conn = open_db(&app)?;
    if category_name_exists(&conn, name, None)? {
        return Err("category name already exists".to_string());
    }

    let category = Category {
        id: format!("cat-{}-{}", slugify(name), Utc::now().timestamp_millis()),
        name: name.to_string(),
        created_at: now(),
    };

    conn.execute(
        "INSERT INTO categories (id, name, created_at) VALUES (?1, ?2, ?3)",
        params![category.id, category.name, category.created_at],
    )
    .map_err(|error| format!("failed to create category: {error}"))?;

    Ok(category)
}

#[tauri::command]
fn update_category(app: AppHandle, input: UpdateCategoryInput) -> Result<Category, String> {
    let id = input.id.trim();
    let name = input.name.trim();

    if id.is_empty() {
        return Err("category id is required".to_string());
    }

    if name.is_empty() {
        return Err("category name is required".to_string());
    }

    let conn = open_db(&app)?;

    if category_name_exists(&conn, name, Some(id))? {
        return Err("category name already exists".to_string());
    }

    let affected = conn
        .execute(
            "UPDATE categories SET name = ?1 WHERE id = ?2",
            params![name, id],
        )
        .map_err(|error| format!("failed to update category: {error}"))?;

    if affected == 0 {
        return Err("category not found".to_string());
    }

    conn.query_row(
        "SELECT id, name, created_at FROM categories WHERE id = ?1",
        params![id],
        |row| {
            Ok(Category {
                id: row.get(0)?,
                name: row.get(1)?,
                created_at: row.get(2)?,
            })
        },
    )
    .map_err(|error| format!("failed to load updated category: {error}"))
}

#[tauri::command]
fn delete_category(app: AppHandle, input: DeleteCategoryInput) -> Result<(), String> {
    let category_id = input.id.trim();
    if category_id.is_empty() {
        return Err("category id is required".to_string());
    }

    let conn = open_db(&app)?;

    let total_categories: i64 = conn
        .query_row("SELECT COUNT(*) FROM categories", [], |row| row.get(0))
        .map_err(|error| format!("failed to count categories: {error}"))?;

    if total_categories <= 1 {
        return Err("at least one category is required".to_string());
    }

    if !category_exists(&conn, category_id)? {
        return Err("category not found".to_string());
    }

    let used_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM entries WHERE category_id = ?1",
            params![category_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("failed to count category usage: {error}"))?;

    if used_count > 0 {
        let replacement_from_input = input
            .replacement_category_id
            .as_ref()
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string());

        let replacement_id = if let Some(value) = replacement_from_input {
            value
        } else {
            conn.query_row(
                "SELECT id FROM categories WHERE id <> ?1 ORDER BY created_at LIMIT 1",
                params![category_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| format!("failed to find replacement category: {error}"))?
            .ok_or_else(|| "no replacement category available".to_string())?
        };

        if replacement_id == category_id {
            return Err("replacement category must be different".to_string());
        }

        if !category_exists(&conn, replacement_id.as_str())? {
            return Err("replacement category not found".to_string());
        }

        conn.execute(
            "UPDATE entries SET category_id = ?1 WHERE category_id = ?2",
            params![replacement_id, category_id],
        )
        .map_err(|error| format!("failed to reassign category entries: {error}"))?;
    }

    let affected = conn
        .execute("DELETE FROM categories WHERE id = ?1", params![category_id])
        .map_err(|error| format!("failed to delete category: {error}"))?;

    if affected == 0 {
        return Err("category not found".to_string());
    }

    Ok(())
}

#[tauri::command]
fn list_sprints(app: AppHandle) -> Result<Vec<Sprint>, String> {
    let conn = open_db(&app)?;
    list_sprints_db(&conn)
}

#[tauri::command]
fn create_sprint(app: AppHandle, input: NewSprintInput) -> Result<Sprint, String> {
    let start_date = input.start_date.trim();
    if start_date.is_empty() {
        return Err("start_date is required".to_string());
    }

    let parsed_start = NaiveDate::parse_from_str(start_date, "%Y-%m-%d")
        .map_err(|_| "start_date must be in YYYY-MM-DD format".to_string())?;
    let duration_days = input.duration_days.unwrap_or(14);
    if duration_days != 7 && duration_days != 14 {
        return Err("duration_days must be 7 or 14".to_string());
    }
    let calculated_end = (parsed_start + Duration::days(duration_days - 1))
        .format("%Y-%m-%d")
        .to_string();

    let conn = open_db(&app)?;
    let code = next_sprint_code_db(&conn)?;

    let display_name = input
        .name
        .as_ref()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| code.clone());

    let sprint = Sprint {
        id: next_id("sprint"),
        code,
        name: display_name,
        start_date: start_date.to_string(),
        end_date: Some(calculated_end),
        created_at: now(),
    };

    conn.execute(
        "INSERT INTO sprints (id, code, name, start_date, end_date, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            sprint.id,
            sprint.code,
            sprint.name,
            sprint.start_date,
            sprint.end_date,
            sprint.created_at
        ],
    )
    .map_err(|error| format!("failed to create sprint: {error}"))?;

    Ok(sprint)
}

#[tauri::command]
fn update_sprint_name(app: AppHandle, input: UpdateSprintNameInput) -> Result<Sprint, String> {
    let sprint_id = input.id.trim();
    let name = input.name.trim();

    if sprint_id.is_empty() {
        return Err("sprint id is required".to_string());
    }

    if name.is_empty() {
        return Err("sprint name is required".to_string());
    }

    let conn = open_db(&app)?;

    let affected = conn
        .execute(
            "UPDATE sprints SET name = ?1 WHERE id = ?2",
            params![name, sprint_id],
        )
        .map_err(|error| format!("failed to update sprint name: {error}"))?;

    if affected == 0 {
        return Err("sprint not found".to_string());
    }

    conn.query_row(
        "SELECT id, code, name, start_date, end_date, created_at FROM sprints WHERE id = ?1",
        params![sprint_id],
        |row| {
            Ok(Sprint {
                id: row.get(0)?,
                code: row.get(1)?,
                name: row.get(2)?,
                start_date: row.get(3)?,
                end_date: row.get(4)?,
                created_at: row.get(5)?,
            })
        },
    )
    .map_err(|error| format!("failed to fetch updated sprint: {error}"))
}

#[tauri::command]
fn delete_sprint(app: AppHandle, input: DeleteSprintInput) -> Result<(), String> {
    let sprint_id = input.id.trim();
    if sprint_id.is_empty() {
        return Err("sprint id is required".to_string());
    }

    let conn = open_db(&app)?;
    let sprints = list_sprints_db(&conn)?;
    if let Some(active_sprint_id) = pick_active_sprint_id(&sprints) {
        if active_sprint_id == sprint_id {
            return Err("cannot delete the active sprint".to_string());
        }
    }

    let affected = conn
        .execute("DELETE FROM sprints WHERE id = ?1", params![sprint_id])
        .map_err(|error| format!("failed to delete sprint: {error}"))?;

    if affected == 0 {
        return Err("sprint not found".to_string());
    }

    Ok(())
}

#[tauri::command]
fn list_entries_for_sprint(app: AppHandle, sprint_id: String) -> Result<Vec<DailyEntry>, String> {
    let conn = open_db(&app)?;
    list_entries_for_sprint_db(&conn, sprint_id.as_str())
}

#[tauri::command]
fn add_daily_entry(app: AppHandle, input: NewDailyEntryInput) -> Result<DailyEntry, String> {
    let title = input.title.trim();

    if title.is_empty() {
        return Err("title is required".to_string());
    }

    if input.date.trim().is_empty() {
        return Err("date is required".to_string());
    }

    if input.category_id.trim().is_empty() {
        return Err("category_id is required".to_string());
    }

    let conn = open_db(&app)?;

    if !sprint_exists(&conn, input.sprint_id.as_str())? {
        return Err("the selected sprint does not exist".to_string());
    }

    if !category_exists(&conn, input.category_id.as_str())? {
        return Err("the selected category does not exist".to_string());
    }

    let entry = DailyEntry {
        id: next_id("entry"),
        sprint_id: input.sprint_id,
        date: input.date,
        category_id: input.category_id,
        title: title.to_string(),
        details: input.details.and_then(|value| {
            let trimmed = value.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        }),
        created_at: now(),
    };

    conn.execute(
        "INSERT INTO entries (id, sprint_id, date, category_id, title, details, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            entry.id,
            entry.sprint_id,
            entry.date,
            entry.category_id,
            entry.title,
            entry.details,
            entry.created_at
        ],
    )
    .map_err(|error| format!("failed to add entry: {error}"))?;

    Ok(entry)
}

#[tauri::command]
fn generate_report(app: AppHandle, input: ReportInput) -> Result<ReportOutput, String> {
    let conn = open_db(&app)?;

    let sprint = conn
        .query_row(
            "SELECT id, code, name, start_date, end_date, created_at FROM sprints WHERE id = ?1",
            params![input.sprint_id],
            |row| {
                Ok(Sprint {
                    id: row.get(0)?,
                    code: row.get(1)?,
                    name: row.get(2)?,
                    start_date: row.get(3)?,
                    end_date: row.get(4)?,
                    created_at: row.get(5)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("failed to read sprint for report: {error}"))?
        .ok_or_else(|| "the selected sprint does not exist".to_string())?;

    let category_filter = input.categories.and_then(|categories| {
        if categories.is_empty() {
            None
        } else {
            Some(categories)
        }
    });

    let category_set = category_filter
        .as_ref()
        .map(|categories| categories.iter().cloned().collect::<BTreeSet<_>>());

    let categories = list_categories_db(&conn)?;
    let category_name_map: HashMap<String, String> = categories
        .iter()
        .map(|category| (category.id.clone(), category.name.clone()))
        .collect();

    let mut filtered = list_entries_for_sprint_db(&conn, input.sprint_id.as_str())?
        .into_iter()
        .filter(|entry| within_range(&entry.date, &input.from_date, &input.to_date))
        .filter(|entry| {
            if let Some(set) = &category_set {
                set.contains(&entry.category_id)
            } else {
                true
            }
        })
        .collect::<Vec<_>>();

    filtered.sort_by(|left, right| {
        left.date
            .cmp(&right.date)
            .then(left.category_id.cmp(&right.category_id))
            .then(left.created_at.cmp(&right.created_at))
    });

    let mut grouped: BTreeMap<String, BTreeMap<String, Vec<DailyEntry>>> = BTreeMap::new();

    for entry in &filtered {
        let category_label = category_name_map
            .get(&entry.category_id)
            .cloned()
            .unwrap_or_else(|| entry.category_id.clone());

        grouped
            .entry(entry.date.clone())
            .or_default()
            .entry(category_label)
            .or_default()
            .push(entry.clone());
    }

    let mut markdown = String::new();
    markdown.push_str(&format!("# Sprint Report: {}\n\n", sprint.name));
    markdown.push_str(&format!("- Sprint ID: `{}`\n", sprint.id));
    markdown.push_str(&format!("- Sprint Code: `{}`\n", sprint.code));
    markdown.push_str(&format!(
        "- Sprint Window: {} to {}\n",
        sprint.start_date,
        sprint
            .end_date
            .clone()
            .unwrap_or_else(|| "open".to_string())
    ));
    markdown.push_str(&format!("- Exported At: {}\n", now()));

    if let Some(from) = &input.from_date {
        markdown.push_str(&format!("- Report From: {}\n", from));
    }

    if let Some(to) = &input.to_date {
        markdown.push_str(&format!("- Report To: {}\n", to));
    }

    markdown.push_str(&format!("- Included Items: {}\n\n", filtered.len()));

    if grouped.is_empty() {
        markdown.push_str("No items found for the selected filters.\n");
    } else {
        for (date, by_category) in grouped {
            markdown.push_str(&format!("## {}\n\n", date));
            for (category_label, entries) in by_category {
                markdown.push_str(&format!("### {}\n", category_label));
                for item in entries {
                    markdown.push_str(&format!("- {}", item.title));
                    if let Some(details) = item.details {
                        markdown.push_str(&format!(" - {}", details));
                    }
                    markdown.push('\n');
                }
                markdown.push('\n');
            }
        }
    }

    let mut report_path = reports_dir(&app)?;
    report_path.push(format!(
        "report-{}-{}.md",
        slugify(&sprint.name),
        Utc::now().format("%Y%m%d%H%M%S")
    ));

    fs::write(&report_path, &markdown).map_err(|error| {
        format!(
            "unable to write report file {}: {error}",
            report_path.display()
        )
    })?;

    Ok(ReportOutput {
        markdown,
        file_path: report_path.to_string_lossy().to_string(),
        total_items: filtered.len(),
    })
}

#[tauri::command]
fn get_data_path(app: AppHandle) -> Result<String, String> {
    let path = db_file_path(&app)?;
    Ok(path.to_string_lossy().to_string())
}

fn normalize_shortcut_accelerator(value: Option<String>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn build_tray_menu<R: Runtime, M: Manager<R>>(
    app: &M,
    add_item_shortcut: Option<&str>,
) -> tauri::Result<tauri::menu::Menu<R>> {
    let add_item = MenuItem::with_id(
        app,
        TRAY_MENU_ADD_ITEM_ID,
        "Add New Item to Current Sprint",
        true,
        add_item_shortcut,
    )?;
    let add_sprint = MenuItem::with_id(
        app,
        TRAY_MENU_ADD_SPRINT_ID,
        "Add New Sprint",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, TRAY_MENU_QUIT_ID, "Quit", true, None::<&str>)?;

    MenuBuilder::new(app)
        .item(&add_item)
        .item(&add_sprint)
        .separator()
        .item(&quit)
        .build()
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn emit_tray_action(app: &AppHandle, action: &str) {
    show_main_window(app);
    let _ = app.emit("tray-action", action);
}

#[tauri::command]
fn update_menubar_settings(app: AppHandle, input: MenubarSettingsInput) -> Result<(), String> {
    let shortcut = normalize_shortcut_accelerator(input.add_item_shortcut);
    let tray_menu = build_tray_menu(
        &app,
        shortcut
            .as_deref()
            .or(Some(DEFAULT_ADD_ITEM_SHORTCUT)),
    )
    .map_err(|error| format!("failed to rebuild tray menu: {error}"))?;

    let tray_icon = app
        .tray_by_id(TRAY_ICON_ID)
        .ok_or_else(|| "tray icon is not available".to_string())?;

    tray_icon
        .set_menu(Some(tray_menu))
        .map_err(|error| format!("failed to update tray menu: {error}"))?;

    tray_icon
        .set_visible(input.show_icon)
        .map_err(|error| format!("failed to update tray icon visibility: {error}"))?;

    Ok(())
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let tray_menu = build_tray_menu(app, Some(DEFAULT_ADD_ITEM_SHORTCUT))?;

            let mut tray_builder = TrayIconBuilder::with_id(TRAY_ICON_ID)
                .menu(&tray_menu)
                .tooltip("DevLog Desk")
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| {
                    if event.id() == TRAY_MENU_ADD_ITEM_ID {
                        emit_tray_action(app, "add_item_current_sprint");
                    } else if event.id() == TRAY_MENU_ADD_SPRINT_ID {
                        emit_tray_action(app, "add_new_sprint");
                    } else if event.id() == TRAY_MENU_QUIT_ID {
                        app.exit(0);
                    }
                });

            if let Some(icon) = app.default_window_icon().cloned() {
                tray_builder = tray_builder.icon(icon);
            }

            tray_builder.build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_categories,
            create_category,
            update_category,
            delete_category,
            list_sprints,
            create_sprint,
            update_sprint_name,
            delete_sprint,
            list_entries_for_sprint,
            add_daily_entry,
            generate_report,
            get_data_path,
            update_menubar_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri app");
}
