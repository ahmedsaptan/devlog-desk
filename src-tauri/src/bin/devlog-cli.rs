use chrono::Utc;
use rusqlite::{params, Connection};
use std::collections::{BTreeMap, HashMap};
use std::env;
use std::fs;
use std::io::{self, IsTerminal, Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};

const APP_IDENTIFIER: &str = "com.ahmadsaptan.devlogdesk";
const DB_FILE_NAME: &str = "daily-updates.sqlite";
const DEFAULT_TRUNCATE_LINES: usize = 30;

#[derive(Debug, Clone)]
struct Sprint {
    id: String,
    code: String,
    name: String,
    start_date: String,
    end_date: Option<String>,
}

#[derive(Debug, Clone)]
struct DailyEntry {
    date: String,
    category_id: String,
    title: String,
    details: Option<String>,
}

#[derive(Debug)]
struct ReportOutput {
    file_path: String,
    total_items: usize,
}

#[derive(Debug, Clone, Copy)]
enum Key {
    Up,
    Down,
    Left,
    Right,
    Enter,
    Space,
    Quit,
    Unknown,
}

#[derive(Debug, Clone, Copy)]
enum MenuResult {
    Selected(usize),
    Back,
    Quit,
}

struct RawMode {
    original_state: String,
}

impl RawMode {
    fn new() -> Result<Self, String> {
        if !io::stdin().is_terminal() {
            return Err("interactive terminal required (stdin is not a TTY)".to_string());
        }

        let state = Command::new("stty")
            .arg("-g")
            .stdin(Stdio::inherit())
            .output()
            .map_err(|error| format!("failed to read terminal state: {error}"))?;

        if !state.status.success() {
            return Err("failed to read terminal state with stty -g".to_string());
        }

        let original_state = String::from_utf8(state.stdout)
            .map_err(|error| format!("invalid terminal state bytes: {error}"))?
            .trim()
            .to_string();

        let status = Command::new("stty")
            .args(["raw", "-echo"])
            .stdin(Stdio::inherit())
            .status()
            .map_err(|error| format!("failed to enable raw mode: {error}"))?;

        if !status.success() {
            return Err("failed to enable raw mode with stty raw -echo".to_string());
        }

        print!("\x1b[?25l");
        flush_stdout();

        Ok(Self { original_state })
    }
}

impl Drop for RawMode {
    fn drop(&mut self) {
        let _ = Command::new("stty")
            .arg(self.original_state.trim())
            .stdin(Stdio::inherit())
            .status();
        print!("\x1b[0m\x1b[?25h\n");
        flush_stdout();
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Error: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let raw_mode = RawMode::new()?;
    let conn = open_db()?;

    let result = run_app(&conn);
    drop(raw_mode);

    result
}

fn run_app(conn: &Connection) -> Result<(), String> {
    loop {
        let subtitle = vec![
            "Sprint explorer and report generator".to_string(),
            format!("Database: {}", resolve_db_path()?.display()),
        ];

        let options = vec!["Sprints".to_string(), "Exit".to_string()];

        match menu_screen("DevLog Desk CLI", &subtitle, &options)? {
            MenuResult::Selected(0) => {
                if !sprints_flow(conn)? {
                    return Ok(());
                }
            }
            MenuResult::Selected(1) | MenuResult::Back | MenuResult::Quit => return Ok(()),
            MenuResult::Selected(_) => {}
        }
    }
}

fn sprints_flow(conn: &Connection) -> Result<bool, String> {
    loop {
        let sprints = list_sprints(conn)?;

        if sprints.is_empty() {
            let lines = vec![
                "No sprints found yet.".to_string(),
                "Create a sprint in the desktop app first, then open this CLI again.".to_string(),
            ];

            match text_screen("Sprints", &lines)? {
                MenuResult::Quit => return Ok(false),
                _ => return Ok(true),
            }
        }

        let mut options = sprints
            .iter()
            .map(|sprint| sprint_label(sprint))
            .collect::<Vec<_>>();
        options.push("Back".to_string());

        let subtitle = vec!["Select a sprint".to_string()];

        match menu_screen("Sprints", &subtitle, &options)? {
            MenuResult::Selected(index) if index < sprints.len() => {
                if !sprint_flow(conn, &sprints[index])? {
                    return Ok(false);
                }
            }
            MenuResult::Selected(_) | MenuResult::Back => return Ok(true),
            MenuResult::Quit => return Ok(false),
        }
    }
}

fn sprint_flow(conn: &Connection, sprint: &Sprint) -> Result<bool, String> {
    loop {
        let entries = list_entries_for_sprint(conn, &sprint.id)?;
        let categories = list_categories_map(conn)?;

        let subtitle = vec![
            sprint_label(sprint),
            format!(
                "Window: {} to {}",
                sprint.start_date,
                sprint
                    .end_date
                    .clone()
                    .unwrap_or_else(|| "open".to_string())
            ),
            format!("Total entries: {}", entries.len()),
        ];

        let options = vec![
            "See sprint summary".to_string(),
            "See specific date".to_string(),
            "See all details".to_string(),
            "Copy one day data".to_string(),
            "Generate report".to_string(),
            "Back".to_string(),
        ];

        match menu_screen("Sprint", &subtitle, &options)? {
            MenuResult::Selected(0) => {
                let lines = sprint_summary_lines(sprint, &entries);
                match text_screen("Sprint Summary", &lines)? {
                    MenuResult::Quit => return Ok(false),
                    _ => {}
                }
            }
            MenuResult::Selected(1) => match pick_date(&entries)? {
                DatePick::Date(date) => {
                    let text = build_day_text(&date, &entries, &categories);
                    let lines = split_and_truncate(&text, DEFAULT_TRUNCATE_LINES);
                    match text_screen(&format!("Date {date}"), &lines)? {
                        MenuResult::Quit => return Ok(false),
                        _ => {}
                    }
                }
                DatePick::Back => {}
                DatePick::Quit => return Ok(false),
            },
            MenuResult::Selected(2) => {
                let text = build_all_details_text(&entries, &categories);
                let lines = split_and_truncate(&text, DEFAULT_TRUNCATE_LINES);
                match text_screen("All Details", &lines)? {
                    MenuResult::Quit => return Ok(false),
                    _ => {}
                }
            }
            MenuResult::Selected(3) => match pick_date(&entries)? {
                DatePick::Date(date) => {
                    let text = build_day_text(&date, &entries, &categories);
                    let copy_result = copy_to_clipboard(&text);
                    let mut lines = Vec::new();
                    lines.push(format!("Date: {date}"));
                    match copy_result {
                        Ok(()) => {
                            lines.push("Copied day data to clipboard.".to_string());
                        }
                        Err(error) => {
                            lines.push(format!("Clipboard copy failed: {error}"));
                            lines.push("Data preview:".to_string());
                            lines.extend(split_and_truncate(&text, 15));
                        }
                    }
                    match text_screen("Copy Day Data", &lines)? {
                        MenuResult::Quit => return Ok(false),
                        _ => {}
                    }
                }
                DatePick::Back => {}
                DatePick::Quit => return Ok(false),
            },
            MenuResult::Selected(4) => {
                let output = generate_report(conn, sprint)?;
                let lines = vec![
                    format!("Generated report for {}", sprint_label(sprint)),
                    format!("Included items: {}", output.total_items),
                    format!("File: {}", output.file_path),
                ];

                match text_screen("Report Generated", &lines)? {
                    MenuResult::Quit => return Ok(false),
                    _ => {}
                }
            }
            MenuResult::Selected(5) | MenuResult::Back => return Ok(true),
            MenuResult::Quit => return Ok(false),
            MenuResult::Selected(_) => {}
        }
    }
}

enum DatePick {
    Date(String),
    Back,
    Quit,
}

fn pick_date(entries: &[DailyEntry]) -> Result<DatePick, String> {
    let mut grouped = BTreeMap::<String, usize>::new();
    for entry in entries {
        *grouped.entry(entry.date.clone()).or_default() += 1;
    }

    if grouped.is_empty() {
        let lines = vec!["No entries in this sprint yet.".to_string()];
        let _ = text_screen("Dates", &lines)?;
        return Ok(DatePick::Back);
    }

    let mut dates = grouped.into_iter().collect::<Vec<_>>();
    dates.sort_by(|left, right| right.0.cmp(&left.0));

    let mut options = dates
        .iter()
        .map(|(date, count)| format!("{date} ({count} items)"))
        .collect::<Vec<_>>();
    options.push("Back".to_string());

    let subtitle = vec!["Pick a date".to_string()];

    match menu_screen("Dates", &subtitle, &options)? {
        MenuResult::Selected(index) if index < dates.len() => {
            Ok(DatePick::Date(dates[index].0.clone()))
        }
        MenuResult::Selected(_) | MenuResult::Back => Ok(DatePick::Back),
        MenuResult::Quit => Ok(DatePick::Quit),
    }
}

fn menu_screen(title: &str, subtitle: &[String], options: &[String]) -> Result<MenuResult, String> {
    if options.is_empty() {
        return Err("menu_screen requires at least one option".to_string());
    }

    let mut selected = 0usize;

    loop {
        clear_screen();
        println!("DevLog Desk CLI");
        println!("{title}");
        println!();

        for line in subtitle {
            println!("{line}");
        }

        if !subtitle.is_empty() {
            println!();
        }

        for (index, option) in options.iter().enumerate() {
            if index == selected {
                println!("> {option}");
            } else {
                println!("  {option}");
            }
        }

        println!();
        println!("Keys: Up/Down navigate, Space/Enter select, Left back, Q quit");
        flush_stdout();

        match read_key()? {
            Key::Up => {
                selected = selected.saturating_sub(1);
            }
            Key::Down => {
                if selected + 1 < options.len() {
                    selected += 1;
                }
            }
            Key::Enter | Key::Space => return Ok(MenuResult::Selected(selected)),
            Key::Left => return Ok(MenuResult::Back),
            Key::Quit => return Ok(MenuResult::Quit),
            Key::Right | Key::Unknown => {}
        }
    }
}

fn text_screen(title: &str, lines: &[String]) -> Result<MenuResult, String> {
    let mut subtitle = Vec::new();
    subtitle.extend_from_slice(lines);
    subtitle.push(String::new());
    subtitle.push("Press Space/Enter to go back.".to_string());

    menu_screen(title, &subtitle, &["Back".to_string()])
}

fn read_key() -> Result<Key, String> {
    let mut first = [0u8; 1];
    io::stdin()
        .read_exact(&mut first)
        .map_err(|error| format!("failed to read key: {error}"))?;

    match first[0] {
        b'\r' | b'\n' => Ok(Key::Enter),
        b' ' => Ok(Key::Space),
        b'q' | b'Q' => Ok(Key::Quit),
        b'\x1b' => {
            let mut seq = [0u8; 2];
            if io::stdin().read_exact(&mut seq).is_err() {
                return Ok(Key::Unknown);
            }

            if seq[0] == b'[' {
                match seq[1] {
                    b'A' => Ok(Key::Up),
                    b'B' => Ok(Key::Down),
                    b'C' => Ok(Key::Right),
                    b'D' => Ok(Key::Left),
                    _ => Ok(Key::Unknown),
                }
            } else {
                Ok(Key::Unknown)
            }
        }
        _ => Ok(Key::Unknown),
    }
}

fn clear_screen() {
    print!("\x1b[2J\x1b[H");
}

fn flush_stdout() {
    let _ = io::stdout().flush();
}

fn resolve_db_path() -> Result<PathBuf, String> {
    if let Ok(explicit_path) = env::var("DEVLOG_DB_PATH") {
        let trimmed = explicit_path.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }

    let mut root = app_data_root()?;
    root.push(DB_FILE_NAME);
    Ok(root)
}

fn app_data_root() -> Result<PathBuf, String> {
    if let Ok(explicit_root) = env::var("DEVLOG_DATA_DIR") {
        let trimmed = explicit_root.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }

    #[cfg(target_os = "macos")]
    {
        let home =
            env::var("HOME").map_err(|_| "HOME environment variable is missing".to_string())?;
        return Ok(PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join(APP_IDENTIFIER));
    }

    #[cfg(target_os = "windows")]
    {
        let appdata = env::var("APPDATA")
            .map_err(|_| "APPDATA environment variable is missing".to_string())?;
        return Ok(PathBuf::from(appdata).join(APP_IDENTIFIER));
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        if let Ok(xdg_data_home) = env::var("XDG_DATA_HOME") {
            let trimmed = xdg_data_home.trim();
            if !trimmed.is_empty() {
                return Ok(PathBuf::from(trimmed).join(APP_IDENTIFIER));
            }
        }

        let home =
            env::var("HOME").map_err(|_| "HOME environment variable is missing".to_string())?;
        Ok(PathBuf::from(home)
            .join(".local")
            .join("share")
            .join(APP_IDENTIFIER))
    }
}

fn reports_dir() -> Result<PathBuf, String> {
    let mut root = app_data_root()?;
    root.push("reports");
    fs::create_dir_all(&root).map_err(|error| {
        format!(
            "unable to create reports directory {}: {error}",
            root.display()
        )
    })?;
    Ok(root)
}

fn open_db() -> Result<Connection, String> {
    let db_path = resolve_db_path()?;

    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "unable to create data directory {}: {error}",
                parent.display()
            )
        })?;
    }

    let conn = Connection::open(&db_path)
        .map_err(|error| format!("unable to open database {}: {error}", db_path.display()))?;

    init_schema(&conn)?;
    ensure_default_categories_db(&conn)?;

    Ok(conn)
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

fn ensure_default_categories_db(conn: &Connection) -> Result<(), String> {
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM categories", [], |row| row.get(0))
        .map_err(|error| format!("failed to count categories: {error}"))?;

    if count > 0 {
        return Ok(());
    }

    let created_at = now();
    let defaults = vec![
        ("pr-reviews", "PR-Reviews"),
        ("meeting", "Meeting"),
        ("tasks", "Tasks"),
    ];

    for (id, name) in defaults {
        conn.execute(
            "INSERT INTO categories (id, name, created_at) VALUES (?1, ?2, ?3)",
            params![id, name, created_at],
        )
        .map_err(|error| format!("failed to seed category {id}: {error}"))?;
    }

    Ok(())
}

fn list_sprints(conn: &Connection) -> Result<Vec<Sprint>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, code, name, start_date, end_date
             FROM sprints
             ORDER BY start_date DESC, created_at DESC",
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
            })
        })
        .map_err(|error| format!("failed to query sprints: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to collect sprints: {error}"))
}

fn list_entries_for_sprint(conn: &Connection, sprint_id: &str) -> Result<Vec<DailyEntry>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT date, category_id, title, details
             FROM entries
             WHERE sprint_id = ?1
             ORDER BY date, category_id, created_at",
        )
        .map_err(|error| format!("failed to prepare entries query: {error}"))?;

    let rows = stmt
        .query_map(params![sprint_id], |row| {
            Ok(DailyEntry {
                date: row.get(0)?,
                category_id: row.get(1)?,
                title: row.get(2)?,
                details: row.get(3)?,
            })
        })
        .map_err(|error| format!("failed to query entries: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to collect entries: {error}"))
}

fn list_categories_map(conn: &Connection) -> Result<HashMap<String, String>, String> {
    let mut stmt = conn
        .prepare("SELECT id, name FROM categories")
        .map_err(|error| format!("failed to prepare categories query: {error}"))?;

    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("failed to query categories: {error}"))?;

    rows.collect::<Result<HashMap<_, _>, _>>()
        .map_err(|error| format!("failed to collect categories: {error}"))
}

fn sprint_summary_lines(sprint: &Sprint, entries: &[DailyEntry]) -> Vec<String> {
    let mut lines = vec![
        format!("Sprint: {}", sprint_label(sprint)),
        format!(
            "Window: {} to {}",
            sprint.start_date,
            sprint
                .end_date
                .clone()
                .unwrap_or_else(|| "open".to_string())
        ),
        format!("Total items: {}", entries.len()),
        String::new(),
        "Dates:".to_string(),
    ];

    let mut by_day = BTreeMap::<String, usize>::new();
    for entry in entries {
        *by_day.entry(entry.date.clone()).or_default() += 1;
    }

    if by_day.is_empty() {
        lines.push("- No entries yet".to_string());
        return lines;
    }

    for (date, count) in by_day.iter().rev() {
        lines.push(format!("- {date}: {count} items"));
    }

    truncate_lines(lines, DEFAULT_TRUNCATE_LINES)
}

fn build_day_text(
    date: &str,
    entries: &[DailyEntry],
    categories: &HashMap<String, String>,
) -> String {
    let mut grouped = BTreeMap::<String, Vec<&DailyEntry>>::new();

    for entry in entries {
        if entry.date != date {
            continue;
        }

        let category = categories
            .get(&entry.category_id)
            .cloned()
            .unwrap_or_else(|| entry.category_id.clone());
        grouped.entry(category).or_default().push(entry);
    }

    if grouped.is_empty() {
        return format!("{date}\n\nNo entries for this date.");
    }

    let mut out = String::new();
    out.push_str(&format!("{date}\n\n"));

    for (category, items) in grouped {
        out.push_str(&format!("{category}\n"));
        for item in items {
            out.push_str(&format!("- {}", item.title));
            if let Some(details) = &item.details {
                out.push_str(&format!(" - {}", details));
            }
            out.push('\n');
        }
        out.push('\n');
    }

    out
}

fn build_all_details_text(entries: &[DailyEntry], categories: &HashMap<String, String>) -> String {
    if entries.is_empty() {
        return "No entries in this sprint yet.".to_string();
    }

    let mut grouped = BTreeMap::<String, BTreeMap<String, Vec<&DailyEntry>>>::new();

    for entry in entries {
        let category = categories
            .get(&entry.category_id)
            .cloned()
            .unwrap_or_else(|| entry.category_id.clone());

        grouped
            .entry(entry.date.clone())
            .or_default()
            .entry(category)
            .or_default()
            .push(entry);
    }

    let mut out = String::new();

    for (date, categories_for_day) in grouped {
        out.push_str(&format!("{date}\n"));
        for (category, items) in categories_for_day {
            out.push_str(&format!("  {category}\n"));
            for item in items {
                out.push_str(&format!("  - {}", item.title));
                if let Some(details) = &item.details {
                    out.push_str(&format!(" - {}", details));
                }
                out.push('\n');
            }
        }
        out.push('\n');
    }

    out
}

fn generate_report(conn: &Connection, sprint: &Sprint) -> Result<ReportOutput, String> {
    let entries = list_entries_for_sprint(conn, &sprint.id)?;
    let categories = list_categories_map(conn)?;

    let mut grouped = BTreeMap::<String, BTreeMap<String, Vec<&DailyEntry>>>::new();

    for entry in &entries {
        let category = categories
            .get(&entry.category_id)
            .cloned()
            .unwrap_or_else(|| entry.category_id.clone());

        grouped
            .entry(entry.date.clone())
            .or_default()
            .entry(category)
            .or_default()
            .push(entry);
    }

    let mut markdown = String::new();
    markdown.push_str(&format!("# Sprint Report: {}\n\n", sprint.name));
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
    markdown.push('\n');

    if grouped.is_empty() {
        markdown.push_str("No items found for this sprint.\n");
    } else {
        for (date, by_category) in grouped {
            markdown.push_str(&format!("## {date}\n\n"));
            for (category, list) in by_category {
                markdown.push_str(&format!("### {category}\n"));
                for item in list {
                    markdown.push_str(&format!("- {}", item.title));
                    if let Some(details) = &item.details {
                        markdown.push_str(&format!(" - {}", details));
                    }
                    markdown.push('\n');
                }
                markdown.push('\n');
            }
        }
    }

    let mut report_path = reports_dir()?;
    report_path.push(format!(
        "report-{}-{}.md",
        slugify(&sprint.name),
        Utc::now().format("%Y%m%d%H%M%S")
    ));

    fs::write(&report_path, markdown).map_err(|error| {
        format!(
            "unable to write report file {}: {error}",
            report_path.display()
        )
    })?;

    Ok(ReportOutput {
        file_path: report_path.to_string_lossy().to_string(),
        total_items: entries.len(),
    })
}

fn copy_to_clipboard(content: &str) -> Result<(), String> {
    let attempts: Vec<(&str, Vec<&str>)> = {
        #[cfg(target_os = "macos")]
        {
            vec![("pbcopy", vec![])]
        }
        #[cfg(target_os = "windows")]
        {
            vec![("cmd", vec!["/C", "clip"])]
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            vec![
                ("wl-copy", vec![]),
                ("xclip", vec!["-selection", "clipboard"]),
                ("xsel", vec!["--clipboard", "--input"]),
            ]
        }
    };

    for (program, args) in attempts {
        if run_clipboard_program(program, &args, content).is_ok() {
            return Ok(());
        }
    }

    Err("no clipboard utility available (expected pbcopy/clip/wl-copy/xclip/xsel)".to_string())
}

fn run_clipboard_program(program: &str, args: &[&str], content: &str) -> Result<(), String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("failed to run {program}: {error}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(content.as_bytes())
            .map_err(|error| format!("failed to write to {program} stdin: {error}"))?;
    }

    let status = child
        .wait()
        .map_err(|error| format!("failed to wait for {program}: {error}"))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("{program} exited with non-zero status"))
    }
}

fn sprint_label(sprint: &Sprint) -> String {
    if sprint.name.trim().is_empty() {
        sprint.code.clone()
    } else if sprint.code.trim().is_empty() || sprint.code.eq_ignore_ascii_case(&sprint.name) {
        sprint.name.clone()
    } else {
        format!("{} - {}", sprint.code, sprint.name)
    }
}

fn now() -> String {
    Utc::now().to_rfc3339()
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

fn split_and_truncate(text: &str, limit: usize) -> Vec<String> {
    let lines = text
        .lines()
        .map(|line| line.to_string())
        .collect::<Vec<String>>();

    truncate_lines(lines, limit)
}

fn truncate_lines(mut lines: Vec<String>, limit: usize) -> Vec<String> {
    if lines.len() > limit {
        let omitted = lines.len() - limit;
        lines.truncate(limit);
        lines.push(format!("... ({omitted} more lines not shown)"));
    }

    lines
}
