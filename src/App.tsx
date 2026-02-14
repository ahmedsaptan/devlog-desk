import { ClipboardEvent, FormEvent, ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { api } from './lib/api';
import type { Category, DailyEntry, Sprint } from './lib/types';
import appLogo from './assets/devlog-logo.svg';

type AppPage = 'home' | 'sprints' | 'sprint' | 'categories' | 'report' | 'settings';
type ThemeMode = 'system' | 'light' | 'dark';
type ResolvedTheme = 'light' | 'dark';
type ColorTheme = 'emberforge' | 'lagoon' | 'aurora';
type SprintDurationDays = 7 | 14;
type CopyToastState = { day: string; message: string } | null;
type ShortcutMatchSpec = {
  key: string;
  cmdOrCtrl: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
};

const THEME_STORAGE_KEY = 'devlog-desk-theme-mode';
const COLOR_THEME_STORAGE_KEY = 'devlog-desk-color-theme';
const SPRINT_DURATION_STORAGE_KEY = 'devlog-desk-sprint-duration-days';
const MENUBAR_ICON_VISIBLE_STORAGE_KEY = 'devlog-desk-menubar-icon-visible';
const ADD_ITEM_SHORTCUT_STORAGE_KEY = 'devlog-desk-add-item-shortcut';
const DEFAULT_ADD_ITEM_SHORTCUT = 'CmdOrCtrl+Shift+N';
const OLD_SPRINTS_PAGE_SIZE = 6;
const COLOR_THEME_OPTIONS: Array<{ id: ColorTheme; name: string; note: string; isDefault?: boolean }> = [
  {
    id: 'emberforge',
    name: 'Emberforge Classic',
    note: 'Copper highlights over midnight blue.',
    isDefault: true
  },
  {
    id: 'lagoon',
    name: 'Neptune Bloom',
    note: 'Lagoon teal with cool deep-ocean contrast.'
  },
  {
    id: 'aurora',
    name: 'Velvet Aurora',
    note: 'Rose-magenta glow with plum undertones.'
  }
];
const SHORTCUT_NAMED_KEY_NORMALIZER: Record<string, string> = {
  space: 'Space',
  spacebar: 'Space',
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  escape: 'Escape',
  esc: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight'
};
const SHORTCUT_MODIFIER_ALIASES: Record<string, 'cmdOrCtrl' | 'ctrl' | 'meta' | 'alt' | 'shift'> = {
  cmdorctrl: 'cmdOrCtrl',
  commandorcontrol: 'cmdOrCtrl',
  controlorcommand: 'cmdOrCtrl',
  cmd: 'meta',
  command: 'meta',
  ctrl: 'ctrl',
  control: 'ctrl',
  meta: 'meta',
  super: 'meta',
  alt: 'alt',
  option: 'alt',
  shift: 'shift'
};

function isoDateToday() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function pickActiveSprint(list: Sprint[]): Sprint | undefined {
  if (list.length === 0) {
    return undefined;
  }

  const today = isoDateToday();
  const newestFirst = [...list].sort((a, b) => b.created_at.localeCompare(a.created_at));

  const ongoing = newestFirst.find((sprint) => {
    const startsOk = sprint.start_date <= today;
    const endsOk = !sprint.end_date || sprint.end_date >= today;
    return startsOk && endsOk;
  });

  if (ongoing) {
    return ongoing;
  }

  return newestFirst[0];
}

function sprintDisplayLabel(sprint: Sprint): string {
  const code = sprint.code.trim();
  const name = sprint.name.trim();

  if (!code && !name) {
    return 'Sprint';
  }

  if (!name) {
    return code;
  }

  if (!code) {
    return name;
  }

  if (code.toLowerCase() === name.toLowerCase()) {
    return code;
  }

  return `${code} - ${name}`;
}

function normalizeCategoryName(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
}

function isTasksCategory(value: string): boolean {
  const normalized = normalizeCategoryName(value);
  return normalized === 'task' || normalized === 'tasks' || normalized.includes('task');
}

function pickDefaultReportCategoryIds(list: Category[]): string[] {
  return list.filter((category) => isTasksCategory(category.name)).map((category) => category.id);
}

function formatIsoDateForDisplay(value: string): string {
  const [yearRaw, monthRaw, dayRaw] = value.split('-');
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);

  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return value;
  }

  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(date);
}

function formatIsoDateForInput(value: string): string {
  const [yearRaw, monthRaw, dayRaw] = value.split('-');
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);

  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return value;
  }

  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: 'numeric'
  }).format(date);
}

function parseIsoDate(value: string): Date | null {
  if (!value) {
    return null;
  }

  const [yearRaw, monthRaw, dayRaw] = value.split('-');
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }

  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
}

function toIsoDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function monthLabel(value: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    year: 'numeric'
  }).format(value);
}

function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

type InlineToken =
  | { type: 'text'; value: string }
  | { type: 'link'; label: string; href: string };

function parseInlineMarkdownLinks(value: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  const linkPattern = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let lastIndex = 0;

  for (const match of value.matchAll(linkPattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      tokens.push({
        type: 'text',
        value: value.slice(lastIndex, index)
      });
    }

    const label = match[1] ?? '';
    const href = match[2] ?? '';
    tokens.push({ type: 'link', label, href });
    lastIndex = index + match[0].length;
  }

  if (lastIndex < value.length) {
    tokens.push({
      type: 'text',
      value: value.slice(lastIndex)
    });
  }

  if (tokens.length === 0) {
    return [{ type: 'text', value }];
  }

  return tokens;
}

function toInlineHtml(value: string): string {
  return parseInlineMarkdownLinks(value)
    .map((token) => {
      if (token.type === 'text') {
        return escapeHtml(token.value);
      }

      return `<a href="${escapeHtml(token.href)}">${escapeHtml(token.label)}</a>`;
    })
    .join('');
}

function isThemeMode(value: string): value is ThemeMode {
  return value === 'system' || value === 'light' || value === 'dark';
}

function isColorTheme(value: string): value is ColorTheme {
  return value === 'emberforge' || value === 'lagoon' || value === 'aurora';
}

function isSprintDurationDays(value: number): value is SprintDurationDays {
  return value === 7 || value === 14;
}

function normalizeShortcutKeyToken(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const lower = trimmed.toLowerCase();
  const named = SHORTCUT_NAMED_KEY_NORMALIZER[lower];
  if (named) {
    return named;
  }

  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) {
    return lower.toUpperCase();
  }

  if (trimmed.length === 1) {
    return trimmed.toUpperCase();
  }

  return null;
}

function normalizeEventKey(key: string): string | null {
  const lower = key.toLowerCase();
  const named = SHORTCUT_NAMED_KEY_NORMALIZER[lower];
  if (named) {
    return named;
  }

  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) {
    return lower.toUpperCase();
  }

  if (key.length === 1) {
    return key.toUpperCase();
  }

  return null;
}

function parseShortcut(value: string): ShortcutMatchSpec | null {
  const tokens = value
    .split('+')
    .map((token) => token.trim())
    .filter(Boolean);

  if (tokens.length < 2) {
    return null;
  }

  const spec: ShortcutMatchSpec = {
    key: '',
    cmdOrCtrl: false,
    ctrl: false,
    meta: false,
    alt: false,
    shift: false
  };

  for (const token of tokens) {
    const modifier = SHORTCUT_MODIFIER_ALIASES[token.toLowerCase()];
    if (modifier) {
      if (spec[modifier]) {
        return null;
      }
      spec[modifier] = true;
      continue;
    }

    if (spec.key) {
      return null;
    }

    const normalizedKey = normalizeShortcutKeyToken(token);
    if (!normalizedKey) {
      return null;
    }

    spec.key = normalizedKey;
  }

  if (!spec.key) {
    return null;
  }

  if (!spec.cmdOrCtrl && !spec.ctrl && !spec.meta && !spec.alt) {
    return null;
  }

  if (spec.cmdOrCtrl && (spec.ctrl || spec.meta)) {
    return null;
  }

  return spec;
}

function stringifyShortcut(spec: ShortcutMatchSpec): string {
  const parts: string[] = [];

  if (spec.cmdOrCtrl) {
    parts.push('CmdOrCtrl');
  }
  if (spec.ctrl) {
    parts.push('Ctrl');
  }
  if (spec.meta) {
    parts.push('Meta');
  }
  if (spec.alt) {
    parts.push('Alt');
  }
  if (spec.shift) {
    parts.push('Shift');
  }
  parts.push(spec.key);
  return parts.join('+');
}

function normalizeShortcut(value: string): string | null {
  const parsed = parseShortcut(value);
  return parsed ? stringifyShortcut(parsed) : null;
}

function shortcutDisplayLabel(value: string): string {
  const parsed = parseShortcut(value);
  if (!parsed) {
    return value;
  }

  const parts: string[] = [];
  if (parsed.cmdOrCtrl) {
    parts.push('Cmd/Ctrl');
  }
  if (parsed.ctrl) {
    parts.push('Ctrl');
  }
  if (parsed.meta) {
    parts.push('Cmd');
  }
  if (parsed.alt) {
    parts.push('Alt');
  }
  if (parsed.shift) {
    parts.push('Shift');
  }
  parts.push(parsed.key);
  return parts.join(' + ');
}

function shortcutMatchesEvent(event: KeyboardEvent, shortcut: ShortcutMatchSpec): boolean {
  const eventKey = normalizeEventKey(event.key);
  if (!eventKey || eventKey !== shortcut.key) {
    return false;
  }

  if (shortcut.cmdOrCtrl) {
    if (!event.metaKey && !event.ctrlKey) {
      return false;
    }
  } else {
    if (event.ctrlKey !== shortcut.ctrl) {
      return false;
    }
    if (event.metaKey !== shortcut.meta) {
      return false;
    }
  }

  if (event.altKey !== shortcut.alt) {
    return false;
  }

  if (event.shiftKey !== shortcut.shift) {
    return false;
  }

  return true;
}

function getInitialThemeMode(): ThemeMode {
  if (typeof window === 'undefined') {
    return 'system';
  }

  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored && isThemeMode(stored)) {
      return stored;
    }
  } catch {
    // Ignore localStorage read errors and use default.
  }

  return 'system';
}

function getInitialSprintDurationDays(): SprintDurationDays {
  if (typeof window === 'undefined') {
    return 14;
  }

  try {
    const stored = Number(window.localStorage.getItem(SPRINT_DURATION_STORAGE_KEY));
    if (isSprintDurationDays(stored)) {
      return stored;
    }
  } catch {
    // Ignore localStorage read errors and use default.
  }

  return 14;
}

function getInitialMenubarIconVisible(): boolean {
  if (typeof window === 'undefined') {
    return true;
  }

  try {
    const stored = window.localStorage.getItem(MENUBAR_ICON_VISIBLE_STORAGE_KEY);
    if (stored === null) {
      return true;
    }
    return stored === '1' || stored === 'true';
  } catch {
    // Ignore localStorage read errors and use default.
  }

  return true;
}

function getInitialAddItemShortcut(): string {
  if (typeof window === 'undefined') {
    return DEFAULT_ADD_ITEM_SHORTCUT;
  }

  try {
    const stored = window.localStorage.getItem(ADD_ITEM_SHORTCUT_STORAGE_KEY);
    const normalized = stored ? normalizeShortcut(stored) : null;
    if (normalized) {
      return normalized;
    }
  } catch {
    // Ignore localStorage read errors and use default.
  }

  return DEFAULT_ADD_ITEM_SHORTCUT;
}

function getInitialColorTheme(): ColorTheme {
  if (typeof window === 'undefined') {
    return 'emberforge';
  }

  try {
    const stored = window.localStorage.getItem(COLOR_THEME_STORAGE_KEY);
    if (stored && isColorTheme(stored)) {
      return stored;
    }
  } catch {
    // Ignore localStorage read errors and use default.
  }

  return 'emberforge';
}

function getSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'light';
  }

  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

type Crumb = {
  label: string;
  onClick?: () => void;
};

type TimelineDay = {
  date: string;
  categories: Array<{
    categoryId: string;
    categoryName: string;
    items: string[];
  }>;
};

type DatePickerProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  allowClear?: boolean;
  className?: string;
  ariaLabel?: string;
};

const WEEKDAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function DatePicker({
  value,
  onChange,
  placeholder = 'Select date',
  disabled = false,
  allowClear = false,
  className = '',
  ariaLabel = 'Select date'
}: DatePickerProps) {
  const selectedDate = useMemo(() => parseIsoDate(value), [value]);
  const [isOpen, setIsOpen] = useState<boolean>(false);
  const [visibleMonth, setVisibleMonth] = useState<Date>(() => {
    const base = selectedDate ?? new Date();
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });
  const rootRef = useRef<HTMLDivElement>(null);
  const todayIso = isoDateToday();
  const selectedIso = selectedDate ? toIsoDate(selectedDate) : '';

  useEffect(() => {
    if (!selectedDate || isOpen) {
      return;
    }

    setVisibleMonth(new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1));
  }, [selectedDate, isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && rootRef.current?.contains(target)) {
        return;
      }
      setIsOpen(false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen]);

  function onSelectDay(date: Date) {
    onChange(toIsoDate(date));
    setVisibleMonth(new Date(date.getFullYear(), date.getMonth(), 1));
    setIsOpen(false);
  }

  function onChangeMonth(offset: number) {
    setVisibleMonth((current) => new Date(current.getFullYear(), current.getMonth() + offset, 1));
  }

  function onJumpToTodayMonth() {
    const today = new Date();
    setVisibleMonth(new Date(today.getFullYear(), today.getMonth(), 1));
  }

  function onClearDate() {
    onChange('');
    setIsOpen(false);
  }

  const monthStart = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), 1);
  const firstGridDate = new Date(
    monthStart.getFullYear(),
    monthStart.getMonth(),
    1 - monthStart.getDay()
  );
  const calendarDays = Array.from({ length: 42 }, (_, index) => {
    const day = new Date(
      firstGridDate.getFullYear(),
      firstGridDate.getMonth(),
      firstGridDate.getDate() + index
    );
    const iso = toIsoDate(day);
    return {
      date: day,
      iso,
      dayNumber: day.getDate(),
      inCurrentMonth: day.getMonth() === visibleMonth.getMonth(),
      isSelected: iso === selectedIso,
      isToday: iso === todayIso
    };
  });

  const triggerLabel = value ? formatIsoDateForInput(value) : placeholder;
  const triggerClassName = className ? `date-picker-trigger ${className}` : 'date-picker-trigger';

  return (
    <div className={isOpen ? 'date-picker date-picker-open' : 'date-picker'} ref={rootRef}>
      <button
        type="button"
        className={triggerClassName}
        aria-label={ariaLabel}
        aria-expanded={isOpen}
        onClick={() => {
          if (!disabled) {
            setIsOpen((current) => !current);
          }
        }}
        disabled={disabled}
      >
        <span className={value ? 'date-picker-trigger-value' : 'date-picker-trigger-placeholder'}>
          {triggerLabel}
        </span>
        <span className="date-picker-trigger-icon" aria-hidden="true">
          ▾
        </span>
      </button>

      {allowClear && value ? (
        <button
          type="button"
          className="date-picker-clear"
          aria-label="Clear selected date"
          onClick={onClearDate}
          disabled={disabled}
        >
          Clear
        </button>
      ) : null}

      {isOpen ? (
        <div className="date-picker-popover" role="dialog" aria-label="Calendar">
          <div className="date-picker-head">
            <strong>{monthLabel(visibleMonth)}</strong>
            <div className="date-picker-nav">
              <button
                type="button"
                className="btn-secondary date-picker-nav-button"
                aria-label="Previous month"
                onClick={() => onChangeMonth(-1)}
              >
                ◀
              </button>
              <button
                type="button"
                className="btn-secondary date-picker-nav-button"
                aria-label="Jump to current month"
                onClick={onJumpToTodayMonth}
              >
                ●
              </button>
              <button
                type="button"
                className="btn-secondary date-picker-nav-button"
                aria-label="Next month"
                onClick={() => onChangeMonth(1)}
              >
                ▶
              </button>
            </div>
          </div>

          <div className="date-picker-weekdays">
            {WEEKDAY_LABELS.map((label) => (
              <span key={label}>{label}</span>
            ))}
          </div>

          <div className="date-picker-grid">
            {calendarDays.map((cell) => {
              const classNames = [
                'date-picker-day',
                cell.inCurrentMonth ? '' : 'date-picker-day-outside',
                cell.isSelected ? 'date-picker-day-selected' : '',
                cell.isToday ? 'date-picker-day-today' : ''
              ]
                .filter(Boolean)
                .join(' ');

              return (
                <button
                  key={cell.iso}
                  type="button"
                  className={classNames}
                  aria-pressed={cell.isSelected}
                  onClick={() => onSelectDay(cell.date)}
                >
                  {cell.dayNumber}
                </button>
              );
            })}
          </div>

          {allowClear ? (
            <div className="date-picker-foot">
              <button type="button" className="btn-secondary" onClick={onClearDate}>
                Clear date
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function EditIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4 17.25V20h2.75L17.8 8.95l-2.75-2.75L4 17.25zm15.7-9.04a1 1 0 0 0 0-1.41l-2.49-2.49a1 1 0 0 0-1.41 0l-1.18 1.18 3.9 3.9 1.18-1.18z"
        fill="currentColor"
      />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M8 4h8l1 2h4v2H3V6h4l1-2zm1 6h2v8H9v-8zm4 0h2v8h-2v-8zM6 8h12l-1 12a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 8z"
        fill="currentColor"
      />
    </svg>
  );
}

export default function App() {
  const [page, setPage] = useState<AppPage>('home');
  const [themeMode, setThemeMode] = useState<ThemeMode>(getInitialThemeMode);
  const [colorTheme, setColorTheme] = useState<ColorTheme>(getInitialColorTheme);
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(getSystemTheme);
  const [sprintDurationDays, setSprintDurationDays] = useState<SprintDurationDays>(
    getInitialSprintDurationDays
  );
  const [isMenubarIconVisible, setIsMenubarIconVisible] = useState<boolean>(
    getInitialMenubarIconVisible
  );
  const [addItemShortcut, setAddItemShortcut] = useState<string>(getInitialAddItemShortcut);
  const [addItemShortcutDraft, setAddItemShortcutDraft] = useState<string>(getInitialAddItemShortcut);
  const [addItemShortcutError, setAddItemShortcutError] = useState<string>('');

  const [categories, setCategories] = useState<Category[]>([]);
  const [sprints, setSprints] = useState<Sprint[]>([]);
  const [selectedSprintId, setSelectedSprintId] = useState<string>('');
  const [entries, setEntries] = useState<DailyEntry[]>([]);
  const [dataPath, setDataPath] = useState<string>('');
  const [notice, setNotice] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);

  const [newCategoryName, setNewCategoryName] = useState<string>('');
  const [editingCategoryId, setEditingCategoryId] = useState<string>('');
  const [editingCategoryName, setEditingCategoryName] = useState<string>('');
  const [pendingDeleteCategoryId, setPendingDeleteCategoryId] = useState<string>('');

  const [showCreateSprintForm, setShowCreateSprintForm] = useState<boolean>(false);
  const [newSprintName, setNewSprintName] = useState<string>('');
  const [newSprintStart, setNewSprintStart] = useState<string>(isoDateToday());

  const [entryDate, setEntryDate] = useState<string>(isoDateToday());
  const [entryCategoryId, setEntryCategoryId] = useState<string>('');
  const [entryTitle, setEntryTitle] = useState<string>('');
  const [entryDetails, setEntryDetails] = useState<string>('');

  const [reportFromDate, setReportFromDate] = useState<string>('');
  const [reportToDate, setReportToDate] = useState<string>('');
  const [reportCategoryIds, setReportCategoryIds] = useState<string[]>([]);
  const [reportMarkdown, setReportMarkdown] = useState<string>('');
  const [reportPath, setReportPath] = useState<string>('');
  const [copyToast, setCopyToast] = useState<CopyToastState>(null);
  const [isHeaderRenameOpen, setIsHeaderRenameOpen] = useState<boolean>(false);
  const [headerRenameValue, setHeaderRenameValue] = useState<string>('');
  const [collapsedTimelineDays, setCollapsedTimelineDays] = useState<Record<string, boolean>>({});
  const [oldSprintsPage, setOldSprintsPage] = useState<number>(1);
  const [confirmDeleteSprintId, setConfirmDeleteSprintId] = useState<string>('');
  const [pendingArchiveDeleteSprintId, setPendingArchiveDeleteSprintId] = useState<string>('');
  const [openSprintCardMenuId, setOpenSprintCardMenuId] = useState<string>('');
  const [closingSprintCardMenuId, setClosingSprintCardMenuId] = useState<string>('');
  const entriesRequestIdRef = useRef<number>(0);
  const sprintCardMenuCloseTimeoutRef = useRef<number | null>(null);
  const newSprintNameInputRef = useRef<HTMLInputElement>(null);
  const entryTitleInputRef = useRef<HTMLInputElement>(null);
  const headerRenameInputRef = useRef<HTMLInputElement>(null);
  const supportsSystemTheme = typeof window !== 'undefined' && typeof window.matchMedia === 'function';
  const resolvedTheme: ResolvedTheme = themeMode === 'system' ? systemTheme : themeMode;
  const selectedColorTheme = useMemo(() => {
    return COLOR_THEME_OPTIONS.find((option) => option.id === colorTheme);
  }, [colorTheme]);
  const sprintDurationWeeks = sprintDurationDays === 7 ? 1 : 2;

  function handleSmartPaste(
    e: ClipboardEvent<HTMLInputElement | HTMLTextAreaElement>,
    currentValue: string,
    setValue: (value: string) => void
  ) {
    const plainText = e.clipboardData.getData('text/plain').replace(/\r\n/g, '\n');
    if (!plainText) {
      return;
    }

    e.preventDefault();

    const target = e.currentTarget;
    const start = target.selectionStart ?? currentValue.length;
    const end = target.selectionEnd ?? start;
    const selectedText = currentValue.slice(start, end);
    const trimmed = plainText.trim();

    let insertedText = plainText;
    if (selectedText && isWebUrl(trimmed)) {
      insertedText = `[${selectedText}](${trimmed})`;
    }

    const nextValue = currentValue.slice(0, start) + insertedText + currentValue.slice(end);
    setValue(nextValue);

    requestAnimationFrame(() => {
      const cursor = start + insertedText.length;
      target.setSelectionRange(cursor, cursor);
    });
  }

  const selectedSprint = useMemo(
    () => sprints.find((sprint) => sprint.id === selectedSprintId),
    [sprints, selectedSprintId]
  );

  const activeSprint = useMemo(() => pickActiveSprint(sprints), [sprints]);

  const oldSprints = useMemo(() => {
    if (!activeSprint) {
      return [];
    }

    return [...sprints]
      .filter((sprint) => sprint.id !== activeSprint.id)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }, [sprints, activeSprint]);

  const oldSprintsTotalPages = Math.max(1, Math.ceil(oldSprints.length / OLD_SPRINTS_PAGE_SIZE));
  const oldSprintsPageSafe = Math.min(Math.max(oldSprintsPage, 1), oldSprintsTotalPages);
  const oldSprintsStartIndex = (oldSprintsPageSafe - 1) * OLD_SPRINTS_PAGE_SIZE;
  const pagedOldSprints = oldSprints.slice(
    oldSprintsStartIndex,
    oldSprintsStartIndex + OLD_SPRINTS_PAGE_SIZE
  );

  const sprintDirectory = useMemo(() => {
    return [...sprints].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }, [sprints]);

  const defaultReportCategoryIds = useMemo(() => {
    return pickDefaultReportCategoryIds(categories);
  }, [categories]);

  const selectedReportCategoryCount = reportCategoryIds.length;

  const categoryById = useMemo(() => {
    return new Map(categories.map((category) => [category.id, category.name]));
  }, [categories]);

  const groupedEntries = useMemo(() => {
    const byDate = new Map<string, Map<string, DailyEntry[]>>();

    for (const entry of entries) {
      const byCategory = byDate.get(entry.date) ?? new Map<string, DailyEntry[]>();
      const bucket = byCategory.get(entry.category_id) ?? [];
      bucket.push(entry);
      byCategory.set(entry.category_id, bucket);
      byDate.set(entry.date, byCategory);
    }

    return Array.from(byDate.entries())
      .sort(([a], [b]) => (a < b ? 1 : -1))
      .map(([date, byCategory]) => ({
        date,
        categories: Array.from(byCategory.entries())
          .map(([categoryId, items]) => ({
            categoryId,
            categoryName: categoryById.get(categoryId) ?? categoryId,
            items: [...items].sort((a, b) => a.created_at.localeCompare(b.created_at))
          }))
          .sort((a, b) => {
            return a.categoryName.localeCompare(b.categoryName);
          })
      }));
  }, [entries, categoryById]);

  const sprintTimeline = useMemo<TimelineDay[]>(() => {
    return groupedEntries.map((day) => ({
      date: day.date,
      categories: day.categories.map((category) => ({
        categoryId: category.categoryId,
        categoryName: category.categoryName,
        items: category.items.map((item) => {
          const details = item.details?.trim();
          if (!details) {
            return item.title;
          }
          return `${item.title} - ${details}`;
        })
      }))
    }));
  }, [groupedEntries]);

  function buildDayExportText(day: TimelineDay): string {
    const lines: string[] = [];
    for (const category of day.categories) {
      lines.push(category.categoryName);
      category.items.forEach((line, index) => {
        lines.push(`${index + 1}. ${line}`);
      });
      lines.push('');
    }
    return lines.join('\n').trim();
  }

  function buildDayHtmlText(day: TimelineDay): string {
    const categorySections = day.categories
      .map((category) => {
        const items = category.items
          .map((line) => `<li>${toInlineHtml(line)}</li>`)
          .join('');
        return `<section><h3>${escapeHtml(category.categoryName)}</h3><ol>${items}</ol></section>`;
      })
      .join('');

    return `<article><h2>${escapeHtml(day.date)}</h2>${categorySections}</article>`;
  }

  function renderInlineMarkdown(value: string): ReactNode {
    const tokens = parseInlineMarkdownLinks(value);
    return (
      <>
        {tokens.map((token, index) =>
          token.type === 'text' ? (
            <span key={`text-${index}`}>{token.value}</span>
          ) : (
            <a key={`link-${index}`} href={token.href} target="_blank" rel="noreferrer">
              {token.label}
            </a>
          )
        )}
      </>
    );
  }

  async function bootstrap() {
    try {
      setBusy(true);
      setError('');
      const [loadedCategories, loadedSprints, storagePath] = await Promise.all([
        api.listCategories(),
        api.listSprints(),
        api.getDataPath()
      ]);

      setCategories(loadedCategories);
      setSprints(loadedSprints);
      setDataPath(storagePath);

      if (!entryCategoryId && loadedCategories.length > 0) {
        setEntryCategoryId(loadedCategories[0].id);
      }

      if (reportCategoryIds.length === 0) {
        setReportCategoryIds(pickDefaultReportCategoryIds(loadedCategories));
      }

      const firstSelected = pickActiveSprint(loadedSprints);
      if (firstSelected) {
        setSelectedSprintId(firstSelected.id);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function loadEntriesForSprint(sprintId: string) {
    const requestId = ++entriesRequestIdRef.current;

    if (!sprintId) {
      setEntries([]);
      return;
    }

    try {
      setBusy(true);
      setError('');
      const loadedEntries = await api.listEntriesForSprint(sprintId);

      if (entriesRequestIdRef.current !== requestId) {
        return;
      }

      setEntries(loadedEntries);
    } catch (err) {
      if (entriesRequestIdRef.current !== requestId) {
        return;
      }

      setError(String(err));
    } finally {
      if (entriesRequestIdRef.current === requestId) {
        setBusy(false);
      }
    }
  }

  useEffect(() => {
    void bootstrap();
  }, []);

  useEffect(() => {
    void loadEntriesForSprint(selectedSprintId);
  }, [selectedSprintId]);

  useEffect(() => {
    // Reset draft fields when user switches to another sprint context.
    if (!selectedSprintId) {
      return;
    }

    setEntryDate(isoDateToday());
    setEntryTitle('');
    setEntryDetails('');
    setIsHeaderRenameOpen(false);
    setHeaderRenameValue('');
    setCollapsedTimelineDays({});
    setConfirmDeleteSprintId('');
  }, [selectedSprintId]);

  useEffect(() => {
    if (!supportsSystemTheme) {
      return;
    }

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const syncSystemTheme = () => {
      setSystemTheme(media.matches ? 'dark' : 'light');
    };

    syncSystemTheme();

    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', syncSystemTheme);
      return () => media.removeEventListener('change', syncSystemTheme);
    }

    media.addListener(syncSystemTheme);
    return () => media.removeListener(syncSystemTheme);
  }, [supportsSystemTheme]);

  useEffect(() => {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, themeMode);
    } catch {
      // Ignore localStorage write errors.
    }
  }, [themeMode]);

  useEffect(() => {
    try {
      window.localStorage.setItem(COLOR_THEME_STORAGE_KEY, colorTheme);
    } catch {
      // Ignore localStorage write errors.
    }
  }, [colorTheme]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SPRINT_DURATION_STORAGE_KEY, String(sprintDurationDays));
    } catch {
      // Ignore localStorage write errors.
    }
  }, [sprintDurationDays]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        MENUBAR_ICON_VISIBLE_STORAGE_KEY,
        isMenubarIconVisible ? '1' : '0'
      );
    } catch {
      // Ignore localStorage write errors.
    }
  }, [isMenubarIconVisible]);

  useEffect(() => {
    try {
      window.localStorage.setItem(ADD_ITEM_SHORTCUT_STORAGE_KEY, addItemShortcut);
    } catch {
      // Ignore localStorage write errors.
    }
  }, [addItemShortcut]);

  useEffect(() => {
    void api
      .updateMenubarSettings({
        show_icon: isMenubarIconVisible,
        add_item_shortcut: addItemShortcut
      })
      .catch(() => {
        // Ignore settings sync errors outside Tauri runtime.
      });
  }, [isMenubarIconVisible, addItemShortcut]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolvedTheme);
    document.documentElement.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);

  useEffect(() => {
    document.documentElement.setAttribute('data-color-theme', colorTheme);
  }, [colorTheme]);

  useEffect(() => {
    // Clear sprint-entry draft when user navigates away from sprint details.
    if (page === 'sprint') {
      return;
    }

    setEntryTitle('');
    setEntryDetails('');
  }, [page]);

  useEffect(() => {
    if (!copyToast?.message) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setCopyToast(null);
    }, 1700);

    return () => window.clearTimeout(timeoutId);
  }, [copyToast]);

  useEffect(() => {
    setOldSprintsPage((current) => {
      if (current < 1) {
        return 1;
      }
      if (current > oldSprintsTotalPages) {
        return oldSprintsTotalPages;
      }
      return current;
    });
  }, [oldSprintsTotalPages]);

  useEffect(() => {
    if (!notice) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setNotice('');
    }, 1800);

    return () => window.clearTimeout(timeoutId);
  }, [notice]);

  useEffect(() => {
    return () => {
      clearSprintCardMenuCloseTimer();
    };
  }, []);

  useEffect(() => {
    if (page === 'sprints') {
      return;
    }

    clearSprintCardMenuCloseTimer();
    setOpenSprintCardMenuId('');
    setClosingSprintCardMenuId('');
    setPendingArchiveDeleteSprintId('');
  }, [page]);

  useEffect(() => {
    if (!openSprintCardMenuId) {
      return;
    }

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest('[data-sprint-card-menu-root]')) {
        return;
      }

      beginCloseSprintCardMenu(openSprintCardMenuId);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        beginCloseSprintCardMenu(openSprintCardMenuId);
      }
    };

    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [openSprintCardMenuId]);

  useEffect(() => {
    let unlisten: null | (() => void) = null;
    const unlistenPromise = listen<string>('tray-action', (event) => {
      if (event.payload === 'add_new_sprint') {
        openCreateSprintFromShortcut();
        return;
      }

      if (event.payload === 'add_item_current_sprint') {
        openAddItemFromShortcut();
      }
    });

    void unlistenPromise
      .then((handler) => {
        unlisten = handler;
      })
      .catch(() => {
        // Ignore listener registration errors outside Tauri runtime.
      });

    return () => {
      if (unlisten) {
        unlisten();
        return;
      }

      void unlistenPromise
        .then((handler) => {
          handler();
        })
        .catch(() => {
          // Ignore listener cleanup errors.
        });
    };
  }, [sprints, categories, entryCategoryId]);

  useEffect(() => {
    const parsedShortcut = parseShortcut(addItemShortcut);
    if (!parsedShortcut) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) {
        return;
      }

      if (!shortcutMatchesEvent(event, parsedShortcut)) {
        return;
      }

      event.preventDefault();
      openAddItemFromShortcut();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [addItemShortcut, sprints, categories, entryCategoryId]);

  async function onCreateCategory(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!newCategoryName.trim()) {
      setError('Category name is required.');
      return;
    }

    try {
      setBusy(true);
      setError('');
      setNotice('');

      const category = await api.createCategory({ name: newCategoryName.trim() });

      const next = [...categories, category];
      setCategories(next);
      setNewCategoryName('');

      if (!entryCategoryId) {
        setEntryCategoryId(category.id);
      }

      setNotice(`Category ${category.name} added.`);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  function startEditCategory(category: Category) {
    setEditingCategoryId(category.id);
    setEditingCategoryName(category.name);
    setPendingDeleteCategoryId('');
    setError('');
    setNotice('');
  }

  function cancelEditCategory() {
    setEditingCategoryId('');
    setEditingCategoryName('');
  }

  async function onSaveCategory(categoryId: string) {
    if (!editingCategoryName.trim()) {
      setError('Category name is required.');
      return;
    }

    try {
      setBusy(true);
      setError('');
      setNotice('');

      const updated = await api.updateCategory({
        id: categoryId,
        name: editingCategoryName.trim()
      });

      setCategories((current) =>
        current.map((category) => (category.id === updated.id ? updated : category))
      );
      cancelEditCategory();
      setNotice(`Category ${updated.name} updated.`);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteCategory(category: Category) {
    try {
      setBusy(true);
      setError('');
      setNotice('');

      const replacementId = categories.find((item) => item.id !== category.id)?.id ?? null;

      await api.deleteCategory({
        id: category.id,
        replacement_category_id: replacementId
      });

      const freshCategories = await api.listCategories();
      setCategories(freshCategories);
      setReportCategoryIds((current) =>
        current
          .filter((id) => id !== category.id)
          .filter((id) => freshCategories.some((item) => item.id === id))
      );

      if (entryCategoryId === category.id) {
        setEntryCategoryId(freshCategories[0]?.id ?? '');
      }

      if (editingCategoryId === category.id) {
        cancelEditCategory();
      }

      if (pendingDeleteCategoryId === category.id) {
        setPendingDeleteCategoryId('');
      }

      if (selectedSprintId) {
        await loadEntriesForSprint(selectedSprintId);
      }

      setNotice(`Category ${category.name} deleted.`);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onCreateSprint(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    try {
      setBusy(true);
      setError('');
      setNotice('');

      const sprint = await api.createSprint({
        name: newSprintName.trim() ? newSprintName.trim() : null,
        start_date: newSprintStart,
        duration_days: sprintDurationDays
      });

      const nextSprints = [...sprints, sprint];
      setSprints(nextSprints);
      setSelectedSprintId(sprint.id);
      setPage('sprint');
      setNewSprintName('');
      setNewSprintStart(isoDateToday());
      setShowCreateSprintForm(false);
      setNotice(`Created ${sprint.code}.`);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  function toggleCreateSprintForm() {
    setShowCreateSprintForm((current) => {
      const next = !current;
      if (next) {
        setNewSprintStart(isoDateToday());
      }
      return next;
    });
  }

  function openCreateSprintFromShortcut() {
    setPage('sprints');
    setShowCreateSprintForm(true);
    setNewSprintStart(isoDateToday());
    window.setTimeout(() => {
      newSprintNameInputRef.current?.focus();
    }, 80);
  }

  function openAddItemFromShortcut() {
    const active = pickActiveSprint(sprints);
    if (!active) {
      openCreateSprintFromShortcut();
      setNotice('No active sprint found. Create one first.');
      return;
    }

    setSelectedSprintId(active.id);
    setPage('sprint');
    setEntryDate(isoDateToday());
    setEntryTitle('');
    setEntryDetails('');
    if (!entryCategoryId && categories.length > 0) {
      setEntryCategoryId(categories[0].id);
    }
    window.setTimeout(() => {
      entryTitleInputRef.current?.focus();
    }, 80);
  }

  function onSaveAddItemShortcut() {
    const normalized = normalizeShortcut(addItemShortcutDraft);
    if (!normalized) {
      setAddItemShortcutError(
        'Invalid shortcut. Example: CmdOrCtrl+Shift+N (must include Ctrl/Cmd or Alt plus a key).'
      );
      return;
    }

    setAddItemShortcut(normalized);
    setAddItemShortcutDraft(normalized);
    setAddItemShortcutError('');
    setError('');
    setNotice(`Shortcut updated: ${shortcutDisplayLabel(normalized)}`);
  }

  function onResetAddItemShortcut() {
    setAddItemShortcut(DEFAULT_ADD_ITEM_SHORTCUT);
    setAddItemShortcutDraft(DEFAULT_ADD_ITEM_SHORTCUT);
    setAddItemShortcutError('');
    setError('');
    setNotice(`Shortcut reset: ${shortcutDisplayLabel(DEFAULT_ADD_ITEM_SHORTCUT)}`);
  }

  function clearSprintCardMenuCloseTimer() {
    if (sprintCardMenuCloseTimeoutRef.current !== null) {
      window.clearTimeout(sprintCardMenuCloseTimeoutRef.current);
      sprintCardMenuCloseTimeoutRef.current = null;
    }
  }

  function beginCloseSprintCardMenu(menuId?: string) {
    const id = menuId ?? openSprintCardMenuId;
    if (!id) {
      return;
    }

    if (openSprintCardMenuId === id) {
      setOpenSprintCardMenuId('');
    }

    setPendingArchiveDeleteSprintId((current) => (current === id ? '' : current));
    setClosingSprintCardMenuId(id);
    clearSprintCardMenuCloseTimer();
    sprintCardMenuCloseTimeoutRef.current = window.setTimeout(() => {
      setClosingSprintCardMenuId((current) => (current === id ? '' : current));
      sprintCardMenuCloseTimeoutRef.current = null;
    }, 170);
  }

  function toggleSprintCardMenu(menuId: string) {
    if (openSprintCardMenuId === menuId) {
      beginCloseSprintCardMenu(menuId);
      return;
    }

    clearSprintCardMenuCloseTimer();
    setClosingSprintCardMenuId('');
    setPendingArchiveDeleteSprintId('');
    setOpenSprintCardMenuId(menuId);
  }

  function isSprintCardMenuVisible(menuId: string) {
    return openSprintCardMenuId === menuId || closingSprintCardMenuId === menuId;
  }

  function onRenameSprint(sprint: Sprint) {
    setSelectedSprintId(sprint.id);
    setPage('sprint');
    openHeaderRename(sprint);
  }

  function openHeaderRename(sprint: Sprint) {
    setHeaderRenameValue(sprint.name);
    setIsHeaderRenameOpen(true);
    setConfirmDeleteSprintId('');
    setPendingArchiveDeleteSprintId('');
    window.setTimeout(() => {
      headerRenameInputRef.current?.focus();
      headerRenameInputRef.current?.select();
    }, 40);
  }

  function cancelHeaderRename() {
    setIsHeaderRenameOpen(false);
    setHeaderRenameValue('');
  }

  async function onSaveHeaderRename(sprint: Sprint) {
    const name = headerRenameValue.trim();
    if (!name) {
      setError('Sprint name is required.');
      return;
    }

    try {
      setBusy(true);
      setError('');
      setNotice('');

      const updated = await api.updateSprintName({ id: sprint.id, name });
      setSprints((current) =>
        current.map((item) => (item.id === updated.id ? updated : item))
      );
      setIsHeaderRenameOpen(false);
      setHeaderRenameValue('');
      setNotice(`Updated ${updated.code} name.`);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteSprint(sprint: Sprint) {
    if (activeSprint?.id === sprint.id) {
      setError('You cannot delete the active sprint.');
      setNotice('');
      setConfirmDeleteSprintId('');
      setPendingArchiveDeleteSprintId('');
      return;
    }

    try {
      setBusy(true);
      setError('');
      setNotice('');

      await api.deleteSprint({ id: sprint.id });

      const nextSprints = await api.listSprints();
      setSprints(nextSprints);
      setEntries([]);
      setSelectedSprintId(pickActiveSprint(nextSprints)?.id ?? '');
      setPage('sprints');
      setConfirmDeleteSprintId('');
      setPendingArchiveDeleteSprintId('');
      setOpenSprintCardMenuId('');
      setClosingSprintCardMenuId('');
      setNotice(`Deleted ${sprint.code}.`);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  function onRequestDeleteSprint(sprint: Sprint) {
    if (activeSprint?.id === sprint.id) {
      setError('You cannot delete the active sprint.');
      setNotice('');
      setConfirmDeleteSprintId('');
      setPendingArchiveDeleteSprintId('');
      return;
    }

    setError('');
    setIsHeaderRenameOpen(false);
    setHeaderRenameValue('');
    setPendingArchiveDeleteSprintId('');
    setConfirmDeleteSprintId(sprint.id);
    setNotice('Press Confirm delete to remove this sprint.');
  }

  function onRequestDeleteArchivedSprint(sprint: Sprint) {
    if (activeSprint?.id === sprint.id) {
      setError('You cannot delete the active sprint.');
      setNotice('');
      setPendingArchiveDeleteSprintId('');
      return;
    }

    setError('');
    setIsHeaderRenameOpen(false);
    setHeaderRenameValue('');
    setConfirmDeleteSprintId('');
    setPendingArchiveDeleteSprintId(sprint.id);
    setNotice('Press Confirm delete in the menu to remove this archived sprint.');
  }

  async function onAddEntry(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selectedSprintId) {
      setError('Choose a sprint first.');
      return;
    }

    if (!entryCategoryId) {
      setError('Choose a category first.');
      return;
    }

    if (!entryTitle.trim()) {
      setError('Entry title is required.');
      return;
    }

    try {
      setBusy(true);
      setError('');
      setNotice('');

      await api.addDailyEntry({
        sprint_id: selectedSprintId,
        date: entryDate,
        category_id: entryCategoryId,
        title: entryTitle.trim(),
        details: entryDetails.trim() ? entryDetails.trim() : null
      });

      setEntryTitle('');
      setEntryDetails('');
      setEntryDate(isoDateToday());
      await loadEntriesForSprint(selectedSprintId);
      setNotice('Entry added.');
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  function toggleReportCategory(categoryId: string) {
    setReportCategoryIds((current) => {
      if (current.includes(categoryId)) {
        return current.filter((value) => value !== categoryId);
      }
      return [...current, categoryId];
    });
  }

  function onReportSelectAll() {
    setReportCategoryIds(categories.map((category) => category.id));
  }

  function openSprintDetails(sprintId: string) {
    setSelectedSprintId(sprintId);
    setPage('sprint');
  }

  function openReportPage() {
    if (!selectedSprintId) {
      setError('Choose a sprint first.');
      return;
    }

    setError('');
    setPage('report');
  }

  function openReportForSprint(sprintId: string) {
    setSelectedSprintId(sprintId);
    setError('');
    setPage('report');
  }

  async function onGenerateReport() {
    if (!selectedSprintId) {
      setError('Choose a sprint first.');
      return;
    }

    await onGenerateReportForSprint(selectedSprintId);
  }

  async function onGenerateReportForSprint(sprintId: string) {
    if (reportCategoryIds.length === 0) {
      setError('Select at least one category for the report.');
      return;
    }

    try {
      setBusy(true);
      setError('');
      setNotice('');

      const output = await api.generateReport({
        sprint_id: sprintId,
        from_date: reportFromDate || null,
        to_date: reportToDate || null,
        categories: reportCategoryIds
      });

      setReportMarkdown(output.markdown);
      setReportPath(output.file_path);
      setNotice(`Report generated (${output.total_items} items).`);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  function toggleTimelineDayCollapse(day: string) {
    setCollapsedTimelineDays((current) => ({
      ...current,
      [day]: current[day] === false
    }));
  }

  function isTimelineDayCollapsed(day: string) {
    return collapsedTimelineDays[day] !== false;
  }

  async function onCopyDayTimelineMarkdown(day: TimelineDay) {
    const markdown = buildDayExportText(day);
    if (!markdown) {
      setError('No timeline items to copy for this day.');
      return;
    }

    try {
      await navigator.clipboard.writeText(markdown);
      setError('');
      setCopyToast({ day: day.date, message: `Copied ${day.date} as Markdown` });
    } catch {
      // Fallback for environments where Clipboard API is unavailable.
      const area = document.createElement('textarea');
      area.value = markdown;
      area.style.position = 'fixed';
      area.style.left = '-9999px';
      document.body.appendChild(area);
      area.focus();
      area.select();
      document.execCommand('copy');
      document.body.removeChild(area);
      setError('');
      setCopyToast({ day: day.date, message: `Copied ${day.date} as Markdown` });
    }
  }

  async function onCopyDayTimelineHtml(day: TimelineDay) {
    const markdown = buildDayExportText(day);
    const html = buildDayHtmlText(day);
    if (!markdown || !html) {
      setError('No timeline items to copy for this day.');
      return;
    }

    try {
      const clipboardItemCtor = (window as { ClipboardItem?: unknown }).ClipboardItem as
        | (new (items: Record<string, Blob>) => { })
        | undefined;

      if (clipboardItemCtor && navigator.clipboard?.write) {
        const item = new clipboardItemCtor({
          'text/plain': new Blob([markdown], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' })
        });
        await navigator.clipboard.write([item as never]);
      } else {
        await navigator.clipboard.writeText(markdown);
      }

      setError('');
      setCopyToast({ day: day.date, message: `Copied ${day.date} as HTML` });
    } catch {
      // Fallback for environments where rich clipboard write is unavailable.
      const area = document.createElement('textarea');
      area.value = markdown;
      area.style.position = 'fixed';
      area.style.left = '-9999px';
      document.body.appendChild(area);
      area.focus();
      area.select();
      document.execCommand('copy');
      document.body.removeChild(area);
      setError('');
      setCopyToast({ day: day.date, message: `Copied ${day.date} as Markdown fallback` });
    }
  }

  const breadcrumbs = useMemo<Crumb[]>(() => {
    if (page === 'home') {
      return [{ label: 'home' }];
    }

    if (page === 'sprints') {
      return [
        { label: 'home', onClick: () => setPage('home') },
        { label: 'sprints' }
      ];
    }

    if (page === 'sprint') {
      return [
        { label: 'home', onClick: () => setPage('home') },
        { label: 'sprints', onClick: () => setPage('sprints') },
        { label: selectedSprint?.code ?? 'sprint' }
      ];
    }

    if (page === 'categories') {
      return [
        { label: 'home', onClick: () => setPage('home') },
        { label: 'categories' }
      ];
    }

    if (page === 'settings') {
      return [
        { label: 'home', onClick: () => setPage('home') },
        { label: 'settings' }
      ];
    }

    if (page === 'report') {
      return [
        { label: 'home', onClick: () => setPage('home') },
        { label: 'sprints', onClick: () => setPage('sprints') },
        { label: selectedSprint?.code ?? 'sprint', onClick: () => setPage('sprint') },
        { label: 'report' }
      ];
    }

    return [
      { label: 'home', onClick: () => setPage('home') },
      { label: 'sprints' }
    ];
  }, [page, selectedSprint]);

  function renderSprintDateRange(
    startDate: string,
    endDate?: string | null,
    extraClassName?: string
  ): ReactNode {
    const formattedStart = formatIsoDateForDisplay(startDate);
    const formattedEnd = endDate ? formatIsoDateForDisplay(endDate) : 'Open';
    const endChipClass = endDate ? 'sprint-date-chip' : 'sprint-date-chip sprint-date-chip-open';
    const wrapperClassName = extraClassName
      ? `sprint-date-range ${extraClassName}`
      : 'sprint-date-range';

    return (
      <div className={wrapperClassName} aria-label={`Sprint range: ${formattedStart} to ${formattedEnd}`}>
        <span className="sprint-date-chip">
          <span className="sprint-date-label">Start</span>
          <span className="sprint-date-value">{formattedStart}</span>
        </span>
        <span className={endChipClass}>
          <span className="sprint-date-label">End</span>
          <span className="sprint-date-value">{formattedEnd}</span>
        </span>
      </div>
    );
  }

  function renderSprintDateRangeLine(startDate: string, endDate?: string | null): ReactNode {
    const formattedStart = formatIsoDateForDisplay(startDate);
    const formattedEnd = endDate ? formatIsoDateForDisplay(endDate) : 'Open';
    return <p className="sprint-range-line">{formattedStart}{' -> '}{formattedEnd}</p>;
  }

  return (
    <div className="page">
      <header className="hero">
        <div className="hero-brand">
          <img src={appLogo} alt="DevLog Desk logo" className="app-logo" />
          <div>
            <p className="kicker">Desktop Sprint Journal</p>
            <h1>DevLog Desk</h1>
            <p className="subtitle">
              Daily engineering updates with sprint context, dynamic categories, and report export.
            </p>
            <p className="meta">Storage file: {dataPath || 'loading...'}</p>
          </div>
        </div>
      </header>

      <nav className="tabs">
        <button
          type="button"
          className={page === 'home' ? 'tab tab-on' : 'tab'}
          onClick={() => setPage('home')}
        >
          Home
        </button>
        <button
          type="button"
          className={page === 'sprints' || page === 'sprint' || page === 'report' ? 'tab tab-on' : 'tab'}
          onClick={() => setPage('sprints')}
        >
          Sprints
        </button>
        <button
          type="button"
          className={page === 'categories' ? 'tab tab-on' : 'tab'}
          onClick={() => setPage('categories')}
        >
          Categories
        </button>
        <button
          type="button"
          className={page === 'settings' ? 'tab tab-on' : 'tab'}
          onClick={() => setPage('settings')}
        >
          Settings
        </button>
      </nav>

      <nav className="breadcrumbs" aria-label="Breadcrumb">
        {breadcrumbs.map((crumb, index) => {
          const isLast = index === breadcrumbs.length - 1;
          return (
            <span key={`${crumb.label}-${index}`} className="breadcrumb-item">
              {crumb.onClick && !isLast ? (
                <button type="button" className="breadcrumb-link" onClick={crumb.onClick}>
                  {crumb.label}
                </button>
              ) : (
                <span className="breadcrumb-current">{crumb.label}</span>
              )}
              {!isLast ? <span className="breadcrumb-sep">/</span> : null}
            </span>
          );
        })}
      </nav>

      {page === 'home' ? (
        <main className="grid home-grid">
          <section className="card card-wide">
            <div className="card-head">
              <h2>Add New Sprint</h2>
              <button
                type="button"
                onClick={toggleCreateSprintForm}
              >
                {showCreateSprintForm ? 'Hide Form' : 'Add Sprint'}
              </button>
            </div>

            {showCreateSprintForm ? (
              <form onSubmit={onCreateSprint} className="stack">
                <input
                  ref={newSprintNameInputRef}
                  placeholder="Display name (optional)"
                  value={newSprintName}
                  onChange={(e) => setNewSprintName(e.target.value)}
                />
                <p className="meta">
                  Sprint code is auto-generated incrementally (example: sprint-190) and cannot be
                  edited.
                </p>
                <div className="row">
                  <label>
                    Start date
                    <DatePicker
                      className="date-input"
                      value={newSprintStart}
                      onChange={setNewSprintStart}
                      ariaLabel="Select sprint start date"
                    />
                  </label>
                </div>
                <p className="meta">
                  Duration is set in Settings: {sprintDurationWeeks} week
                  {sprintDurationWeeks > 1 ? 's' : ''} ({sprintDurationDays} days).
                </p>
                <div className="form-actions-right">
                  <button type="submit" disabled={busy}>
                    Create Sprint
                  </button>
                </div>
              </form>
            ) : (
              <p className="meta">Use Add Sprint to create a new active sprint.</p>
            )}
          </section>

          <section className="card home-active-sprint-card">
            <h2>Current Active Sprint</h2>
            {activeSprint ? (
              <>
                <p className="sprint-code">{activeSprint.code}</p>
                <p>
                  <strong>{activeSprint.name}</strong>
                </p>
                {renderSprintDateRange(activeSprint.start_date, activeSprint.end_date)}
                <div className="inline-actions">
                  <button type="button" onClick={() => openSprintDetails(activeSprint.id)}>
                    Open Sprint
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => onRenameSprint(activeSprint)}
                  >
                    Rename
                  </button>
                </div>
              </>
            ) : (
              <p className="meta">No sprint yet. Add your first sprint.</p>
            )}
          </section>

          <section className="card">
            <h2>Old Sprints</h2>
            {oldSprints.length === 0 ? (
              <p className="meta">No old sprints yet.</p>
            ) : (
              <>
                <ul className="sprint-list">
                  {pagedOldSprints.map((sprint) => (
                    <li key={sprint.id} className="old-sprint-item">
                      <div>
                        <div className="old-sprint-meta">
                          <p className="sprint-code">{sprint.code}</p>
                          <span className="old-sprint-badge">Archived</span>
                        </div>
                        <strong>{sprint.name}</strong>
                        {renderSprintDateRangeLine(sprint.start_date, sprint.end_date)}
                      </div>
                      <div className="inline-actions old-sprint-actions">
                        <button type="button" onClick={() => openSprintDetails(sprint.id)}>
                          View
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
                {oldSprintsTotalPages > 1 ? (
                  <div className="old-sprints-pagination">
                    <p className="meta old-sprints-page-meta">
                      Showing {oldSprintsStartIndex + 1}-{oldSprintsStartIndex + pagedOldSprints.length}{' '}
                      of {oldSprints.length}
                    </p>
                    <div className="old-sprints-pagination-controls">
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={oldSprintsPageSafe <= 1}
                        onClick={() => setOldSprintsPage((current) => Math.max(1, current - 1))}
                      >
                        Previous
                      </button>
                      <span className="old-sprints-page-indicator">
                        Page {oldSprintsPageSafe} of {oldSprintsTotalPages}
                      </span>
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={oldSprintsPageSafe >= oldSprintsTotalPages}
                        onClick={() =>
                          setOldSprintsPage((current) =>
                            Math.min(oldSprintsTotalPages, current + 1)
                          )
                        }
                      >
                        Next
                      </button>
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </section>
        </main>
      ) : null}

      {page === 'categories' ? (
        <main className="grid">
          <section className="card">
            <h2>Create Category</h2>
            <form onSubmit={onCreateCategory} className="stack">
              <input
                placeholder="Category name (e.g. PR-reviews, Meeting, Tasks)"
                value={newCategoryName}
                onChange={(e) => setNewCategoryName(e.target.value)}
              />
              <button type="submit" disabled={busy}>
                Add Category
              </button>
            </form>
          </section>

          <section className="card card-wide">
            <h2>All Categories</h2>
            {categories.length === 0 ? (
              <p className="meta">No categories found.</p>
            ) : (
              <div className="category-cards">
                {categories.map((category) => (
                  <article key={category.id} className="category-card">
                    {editingCategoryId === category.id ? (
                      <>
                        <label>
                          Category Name
                          <input
                            value={editingCategoryName}
                            onChange={(e) => setEditingCategoryName(e.target.value)}
                          />
                        </label>
                        <p className="meta">ID: {category.id}</p>
                        <div className="category-actions">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => onSaveCategory(category.id)}
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            className="btn-secondary"
                            disabled={busy}
                            onClick={cancelEditCategory}
                          >
                            Cancel
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <h3>{category.name}</h3>
                        <p className="meta">ID: {category.id}</p>
                        <div className="category-actions">
                          {pendingDeleteCategoryId === category.id ? (
                            <>
                              <button
                                type="button"
                                className="btn-danger"
                                disabled={busy}
                                onClick={() => onDeleteCategory(category)}
                              >
                                Confirm Delete
                              </button>
                              <button
                                type="button"
                                className="btn-secondary"
                                disabled={busy}
                                onClick={() => setPendingDeleteCategoryId('')}
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => startEditCategory(category)}
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                className="btn-danger"
                                disabled={busy}
                                onClick={() => setPendingDeleteCategoryId(category.id)}
                              >
                                Delete
                              </button>
                            </>
                          )}
                        </div>
                      </>
                    )}
                  </article>
                ))}
              </div>
            )}
          </section>
        </main>
      ) : null}

      {page === 'settings' ? (
        <main className="grid">
          <section className="card card-wide">
            <h2>Appearance</h2>
            <p className="meta">
              Select how DevLog Desk chooses the theme. System will follow your OS preference when
              available.
            </p>
            <div className="theme-options">
              <button
                type="button"
                className={themeMode === 'system' ? 'theme-option theme-option-on' : 'theme-option'}
                aria-pressed={themeMode === 'system'}
                onClick={() => setThemeMode('system')}
              >
                System
              </button>
              <button
                type="button"
                className={themeMode === 'light' ? 'theme-option theme-option-on' : 'theme-option'}
                aria-pressed={themeMode === 'light'}
                onClick={() => setThemeMode('light')}
              >
                Light
              </button>
              <button
                type="button"
                className={themeMode === 'dark' ? 'theme-option theme-option-on' : 'theme-option'}
                aria-pressed={themeMode === 'dark'}
                onClick={() => setThemeMode('dark')}
              >
                Dark
              </button>
            </div>
            <div className="theme-status">
              <p className="meta">Current mode: {themeMode}</p>
              <p className="meta">Applied theme: {resolvedTheme}</p>
              <p className="meta">
                System preference: {supportsSystemTheme ? systemTheme : 'not available'}
              </p>
            </div>
            <hr />
            <h3>Color Theme</h3>
            <p className="meta">
              Choose the visual palette. Emberforge Classic keeps the current default colors.
            </p>
            <div className="theme-palette-options">
              {COLOR_THEME_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={
                    colorTheme === option.id
                      ? 'theme-option theme-option-on theme-palette-option'
                      : 'theme-option theme-palette-option'
                  }
                  aria-pressed={colorTheme === option.id}
                  onClick={() => setColorTheme(option.id)}
                >
                  <span className="theme-palette-title">
                    <span className="theme-palette-swatch" data-theme-palette={option.id} />
                    {option.name}
                  </span>
                  <span className="theme-palette-note">
                    {option.note}
                    {option.isDefault ? ' Default palette.' : ''}
                  </span>
                </button>
              ))}
            </div>
            <div className="theme-status">
              <p className="meta">Selected palette: {selectedColorTheme?.name ?? colorTheme}</p>
            </div>
          </section>

          <section className="card card-wide">
            <h2>Sprint Defaults</h2>
            <p className="meta">
              Choose the default sprint duration used when creating a new sprint.
            </p>
            <div className="theme-options">
              <button
                type="button"
                className={sprintDurationDays === 7 ? 'theme-option theme-option-on' : 'theme-option'}
                aria-pressed={sprintDurationDays === 7}
                onClick={() => setSprintDurationDays(7)}
              >
                1 Week (7 days)
              </button>
              <button
                type="button"
                className={sprintDurationDays === 14 ? 'theme-option theme-option-on' : 'theme-option'}
                aria-pressed={sprintDurationDays === 14}
                onClick={() => setSprintDurationDays(14)}
              >
                2 Weeks (14 days)
              </button>
            </div>
            <div className="theme-status">
              <p className="meta">
                Current default: {sprintDurationWeeks} week
                {sprintDurationWeeks > 1 ? 's' : ''} ({sprintDurationDays} days)
              </p>
            </div>
          </section>

          <section className="card card-wide">
            <h2>Menu Bar + Shortcut</h2>
            <p className="meta">
              Control the menu bar icon and the quick shortcut for adding an item to the current
              sprint.
            </p>
            <label className="setting-toggle-row">
              <input
                type="checkbox"
                checked={isMenubarIconVisible}
                onChange={(event) => setIsMenubarIconVisible(event.target.checked)}
              />
              <span>Show menu bar icon</span>
            </label>
            <p className="meta">
              This controls whether DevLog Desk icon is visible in the system menu bar/tray.
            </p>
            <hr />
            <h3>Add Item Shortcut</h3>
            <p className="meta">
              Format: CmdOrCtrl+Shift+N. The saved shortcut is also shown in the menu bar/tray
              menu.
            </p>
            <div className="shortcut-settings-row">
              <input
                className="shortcut-input"
                value={addItemShortcutDraft}
                onChange={(event) => {
                  setAddItemShortcutDraft(event.target.value);
                  if (addItemShortcutError) {
                    setAddItemShortcutError('');
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    onSaveAddItemShortcut();
                  }
                }}
                placeholder="CmdOrCtrl+Shift+N"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
              <button type="button" onClick={onSaveAddItemShortcut}>
                Save Shortcut
              </button>
              <button type="button" className="btn-secondary" onClick={onResetAddItemShortcut}>
                Reset
              </button>
            </div>
            {addItemShortcutError ? <p className="bad">{addItemShortcutError}</p> : null}
            <div className="theme-status">
              <p className="meta">Current shortcut: {shortcutDisplayLabel(addItemShortcut)}</p>
            </div>
          </section>
        </main>
      ) : null}

      {page === 'sprints' ? (
        <main className="grid">
          <section className="card card-wide sprint-directory-head">
            <div className="card-head">
              <h2>Sprint Directory</h2>
              <button
                type="button"
                className="btn-secondary"
                onClick={toggleCreateSprintForm}
              >
                {showCreateSprintForm ? 'Hide Form' : 'Add New Sprint'}
              </button>
            </div>
            <p className="meta">Open a sprint to add daily items and prepare reports.</p>
            {showCreateSprintForm ? (
              <form onSubmit={onCreateSprint} className="stack sprint-inline-form">
                <input
                  ref={newSprintNameInputRef}
                  placeholder="Display name (optional)"
                  value={newSprintName}
                  onChange={(e) => setNewSprintName(e.target.value)}
                />
                <p className="meta">
                  Sprint code is auto-generated incrementally (example: sprint-190) and cannot be
                  edited.
                </p>
                <label>
                  Start date
                  <DatePicker
                    className="date-input"
                    value={newSprintStart}
                    onChange={setNewSprintStart}
                    ariaLabel="Select sprint start date"
                  />
                </label>
                <p className="meta">
                  Duration is set in Settings: {sprintDurationWeeks} week
                  {sprintDurationWeeks > 1 ? 's' : ''} ({sprintDurationDays} days).
                </p>
                <div className="form-actions-right">
                  <button type="submit" disabled={busy}>
                    Create Sprint
                  </button>
                </div>
              </form>
            ) : null}
          </section>

          <section className="card card-wide">
            {sprintDirectory.length === 0 ? (
              <p className="meta">No sprint yet. Create one from Home.</p>
            ) : (
              <div className="sprint-directory-grid">
                {sprintDirectory.map((sprint) => {
                  const isArchived = sprint.id !== activeSprint?.id;
                  const isMenuVisible = isSprintCardMenuVisible(sprint.id);
                  return (
                    <article
                      key={sprint.id}
                      className={
                        !isArchived
                          ? isMenuVisible
                            ? 'sprint-directory-card sprint-directory-card-active sprint-directory-card-menu-open'
                            : 'sprint-directory-card sprint-directory-card-active'
                          : isMenuVisible
                            ? 'sprint-directory-card sprint-directory-card-old sprint-directory-card-menu-open'
                            : 'sprint-directory-card sprint-directory-card-old'
                      }
                    >
                      <div className="sprint-directory-heading">
                        <h3>{sprintDisplayLabel(sprint)}</h3>
                        {!isArchived ? (
                          <span className="sprint-status-badge sprint-status-active">Active</span>
                        ) : (
                          <span className="sprint-status-badge sprint-status-archived">Archived</span>
                        )}
                      </div>
                      {renderSprintDateRangeLine(sprint.start_date, sprint.end_date)}
                      <div className="sprint-directory-divider" />
                      <div className="inline-actions sprint-directory-actions">
                        <button type="button" onClick={() => openSprintDetails(sprint.id)}>
                          {isArchived ? 'View' : 'Open'}
                        </button>
                        <div className="sprint-card-more" data-sprint-card-menu-root>
                          <button
                            type="button"
                            className={
                              openSprintCardMenuId === sprint.id
                                ? 'btn-secondary sprint-card-more-trigger sprint-card-more-trigger-active'
                                : 'btn-secondary sprint-card-more-trigger'
                            }
                            aria-label={`More actions for ${sprint.name}`}
                            aria-expanded={openSprintCardMenuId === sprint.id}
                            onClick={() => toggleSprintCardMenu(sprint.id)}
                          >
                            ...
                          </button>
                          <div
                            className={
                              openSprintCardMenuId === sprint.id
                                ? 'sprint-card-more-menu sprint-card-more-menu-open'
                                : isSprintCardMenuVisible(sprint.id)
                                  ? 'sprint-card-more-menu sprint-card-more-menu-closing'
                                  : 'sprint-card-more-menu'
                            }
                            aria-hidden={openSprintCardMenuId !== sprint.id}
                          >
                            {!isArchived ? (
                              <button
                                type="button"
                                className="btn-secondary"
                                onClick={() => {
                                  beginCloseSprintCardMenu(sprint.id);
                                  onRenameSprint(sprint);
                                }}
                              >
                                Rename
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className="btn-secondary"
                              onClick={() => {
                                beginCloseSprintCardMenu(sprint.id);
                                openReportForSprint(sprint.id);
                              }}
                            >
                              Report
                            </button>
                            {isArchived ? (
                              pendingArchiveDeleteSprintId === sprint.id ? (
                                <>
                                  <button
                                    type="button"
                                    className="btn-danger"
                                    disabled={busy}
                                    onClick={() => {
                                      beginCloseSprintCardMenu(sprint.id);
                                      void onDeleteSprint(sprint);
                                    }}
                                  >
                                    Confirm delete
                                  </button>
                                  <button
                                    type="button"
                                    className="btn-secondary"
                                    disabled={busy}
                                    onClick={() => setPendingArchiveDeleteSprintId('')}
                                  >
                                    Cancel
                                  </button>
                                </>
                              ) : (
                                <button
                                  type="button"
                                  className="btn-danger"
                                  disabled={busy}
                                  onClick={() => onRequestDeleteArchivedSprint(sprint)}
                                >
                                  Delete
                                </button>
                              )
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </main>
      ) : null}

      {page === 'sprint' ? (
        selectedSprint ? (
          <main className="sprint-detail-page">
            <section className="card sprint-detail-header">
              <div className="sprint-detail-header-main">
                {renderSprintDateRange(
                  selectedSprint.start_date,
                  selectedSprint.end_date,
                  'sprint-date-range-detail'
                )}
                <p className="meta sprint-detail-sprint-name">{sprintDisplayLabel(selectedSprint)}</p>
                {isHeaderRenameOpen ? (
                  <form
                    className="sprint-inline-rename"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void onSaveHeaderRename(selectedSprint);
                    }}
                  >
                    <input
                      ref={headerRenameInputRef}
                      value={headerRenameValue}
                      onChange={(e) => setHeaderRenameValue(e.target.value)}
                      placeholder="Sprint name"
                    />
                    <div className="inline-actions">
                      <button type="submit" disabled={busy || !headerRenameValue.trim()}>
                        Save
                      </button>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={cancelHeaderRename}
                        disabled={busy}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : null}
              </div>
              <div className="sprint-detail-actions-wrap">
                <div className="inline-actions sprint-detail-actions">
                  <button type="button" onClick={openReportPage} disabled={!selectedSprintId}>
                    Generate Sprint Report
                  </button>
                  <button
                    type="button"
                    className="icon-action-button btn-secondary"
                    aria-label="Edit sprint"
                    title="Edit sprint"
                    onClick={() => openHeaderRename(selectedSprint)}
                    disabled={busy}
                  >
                    <EditIcon />
                  </button>
                  {confirmDeleteSprintId === selectedSprint.id ? (
                    <>
                      <button
                        type="button"
                        className="btn-danger"
                        onClick={() => void onDeleteSprint(selectedSprint)}
                        disabled={busy}
                      >
                        Confirm delete
                      </button>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => setConfirmDeleteSprintId('')}
                        disabled={busy}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="icon-action-button btn-danger"
                      aria-label="Delete sprint"
                      aria-describedby={
                        activeSprint?.id === selectedSprint.id
                          ? 'active-sprint-delete-hint'
                          : undefined
                      }
                      title={
                        activeSprint?.id === selectedSprint.id
                          ? 'Active sprint cannot be deleted'
                          : 'Delete sprint'
                      }
                      onClick={() => onRequestDeleteSprint(selectedSprint)}
                      disabled={busy || activeSprint?.id === selectedSprint.id}
                    >
                      <TrashIcon />
                    </button>
                  )}
                </div>
                {activeSprint?.id === selectedSprint.id ? (
                  <p id="active-sprint-delete-hint" className="meta sprint-delete-hint">
                    Active sprint cannot be deleted. Create another sprint first.
                  </p>
                ) : null}
              </div>
            </section>

            <section className="sprint-detail-layout">
              <section className="card sprint-detail-timeline">
                <div className="card-head">
                  <h2>Sprint Timeline</h2>
                </div>
                {sprintTimeline.length === 0 ? (
                  <p className="meta">No items yet for this sprint.</p>
                ) : (
                  sprintTimeline.map((group) => (
                    <div key={group.date} className="timeline-day">
                      <div className="timeline-day-head">
                        <div className="timeline-day-head-main">
                          <h3>{group.date}</h3>
                          <div className="inline-actions">
                            <button
                              type="button"
                              className="btn-secondary"
                              onClick={() => onCopyDayTimelineHtml(group)}
                            >
                              Copy HTML
                            </button>
                            <button
                              type="button"
                              className="btn-secondary"
                              onClick={() => onCopyDayTimelineMarkdown(group)}
                            >
                              Copy Markdown
                            </button>
                            <button
                              type="button"
                              className="btn-secondary timeline-day-toggle"
                              aria-label={
                                isTimelineDayCollapsed(group.date)
                                  ? `Expand ${group.date}`
                                  : `Collapse ${group.date}`
                              }
                              aria-expanded={!isTimelineDayCollapsed(group.date)}
                              onClick={() => toggleTimelineDayCollapse(group.date)}
                            >
                              {isTimelineDayCollapsed(group.date) ? '▾' : '▴'}
                            </button>
                          </div>
                        </div>
                        {copyToast?.day === group.date ? (
                          <div className="timeline-copy-toast" role="status" aria-live="polite">
                            {copyToast.message}
                          </div>
                        ) : null}
                      </div>
                      {isTimelineDayCollapsed(group.date) ? null : (
                        <div className="timeline-day-body">
                          {group.categories.map((categoryGroup) => (
                            <div key={`${group.date}-${categoryGroup.categoryId}`} className="timeline-category">
                              <h4>{categoryGroup.categoryName}</h4>
                              <ol className="timeline-ordered-list">
                                {categoryGroup.items.map((line, index) => (
                                  <li key={`${group.date}-${categoryGroup.categoryId}-${index}`}>
                                    {renderInlineMarkdown(line)}
                                  </li>
                                ))}
                              </ol>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </section>

              <section className="card sprint-detail-form">
                <h2>Add Daily Item</h2>
                {categories.length === 0 ? (
                  <p className="meta">No categories yet. Create one in the Categories page.</p>
                ) : null}
                <form onSubmit={onAddEntry} className="stack add-item-form">
                  <label>
                    Date
                    <DatePicker
                      className="date-input"
                      value={entryDate}
                      onChange={setEntryDate}
                      ariaLabel="Select entry date"
                    />
                  </label>

                  <label>
                    Category
                    <select
                      className="select-input"
                      value={entryCategoryId}
                      onChange={(e) => setEntryCategoryId(e.target.value)}
                    >
                      <option value="">Select category</option>
                      {categories.map((category) => (
                        <option key={category.id} value={category.id}>
                          {category.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label>
                    Title
                    <input
                      ref={entryTitleInputRef}
                      placeholder="Example: Implemented invoice retry flow"
                      value={entryTitle}
                      onChange={(e) => setEntryTitle(e.target.value)}
                      onPaste={(e) => handleSmartPaste(e, entryTitle, setEntryTitle)}
                    />
                  </label>

                  <label>
                    Details (optional)
                    <textarea
                      rows={7}
                      placeholder="Extra context you may need in sprint review"
                      value={entryDetails}
                      onChange={(e) => setEntryDetails(e.target.value)}
                      onPaste={(e) => handleSmartPaste(e, entryDetails, setEntryDetails)}
                    />
                  </label>

                  <button
                    type="submit"
                    className="sprint-form-submit"
                    disabled={busy || !selectedSprintId || !entryCategoryId || categories.length === 0}
                  >
                    Add Item
                  </button>
                </form>
              </section>
            </section>
          </main>
        ) : (
          <main className="grid">
            <section className="card card-wide">
              <h2>No sprint selected</h2>
              <p className="meta">Open one from the Sprints page to view its details.</p>
              <button type="button" onClick={() => setPage('sprints')}>
                Go To Sprints
              </button>
            </section>
          </main>
        )
      ) : null}

      {page === 'report' ? (
        <main className="grid">
          <section className="card card-wide">
            <h2>
              Sprint Report Details
              {selectedSprint ? `: ${sprintDisplayLabel(selectedSprint)}` : ''}
            </h2>
            <p className="meta">
              This page is scoped to the sprint you opened from Sprint Details.
            </p>

            <div className="row">
              <label>
                From
                <DatePicker
                  className="date-input"
                  value={reportFromDate}
                  onChange={setReportFromDate}
                  placeholder="Any date"
                  allowClear
                  ariaLabel="Select report from date"
                />
              </label>
              <label>
                To
                <DatePicker
                  className="date-input"
                  value={reportToDate}
                  onChange={setReportToDate}
                  placeholder="Any date"
                  allowClear
                  ariaLabel="Select report to date"
                />
              </label>
            </div>

            <section className="report-filter-panel">
              <div className="report-filter-head">
                <h3>Select Categories</h3>
                <div className="report-filter-head-right">
                  <button type="button" className="btn-secondary" onClick={onReportSelectAll}>
                    Select All
                  </button>
                  <p className="meta">{selectedReportCategoryCount} selected</p>
                </div>
              </div>
              <p className="meta">Choose which categories should appear in the generated report.</p>
              <div className="chip-row">
                {categories.map((category) => {
                  const isSelected = reportCategoryIds.includes(category.id);
                  return (
                    <button
                      key={category.id}
                      type="button"
                      aria-pressed={isSelected}
                      className={isSelected ? 'chip chip-on' : 'chip'}
                      onClick={() => toggleReportCategory(category.id)}
                    >
                      {category.name}
                    </button>
                  );
                })}
              </div>
            </section>

            <div className="inline-actions">
              <button
                type="button"
                onClick={onGenerateReport}
                disabled={busy || !selectedSprintId || categories.length === 0}
              >
                Generate + Save Markdown
              </button>
            </div>

            {reportPath ? <p className="meta">Saved report: {reportPath}</p> : null}

            <textarea
              className="report-preview"
              value={reportMarkdown}
              onChange={(e) => setReportMarkdown(e.target.value)}
              placeholder="Report preview will appear here"
            />
          </section>
        </main>
      ) : null}

      <footer className="status">
        {busy ? <span>Working...</span> : null}
        {notice ? <span className="ok">{notice}</span> : null}
        {error ? <span className="bad">{error}</span> : null}
      </footer>
    </div>
  );
}
