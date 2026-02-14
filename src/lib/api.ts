import { invoke } from '@tauri-apps/api/core';
import type { Category, DailyEntry, ReportOutput, Sprint } from './types';

function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (typeof window === 'undefined' || typeof (window as any).__TAURI_INTERNALS__?.invoke !== 'function') {
    return Promise.reject(
      new Error(
        'Tauri runtime is not available. Storage only loads in the desktop app. Start with `npm run tauri:dev`.'
      )
    );
  }

  return invoke<T>(command, args);
}

export const api = {
  listCategories: () => tauriInvoke<Category[]>('list_categories'),
  createCategory: (payload: { name: string }) =>
    tauriInvoke<Category>('create_category', { input: payload }),
  updateCategory: (payload: { id: string; name: string }) =>
    tauriInvoke<Category>('update_category', { input: payload }),
  deleteCategory: (payload: { id: string; replacement_category_id?: string | null }) =>
    tauriInvoke<void>('delete_category', { input: payload }),

  listSprints: () => tauriInvoke<Sprint[]>('list_sprints'),
  createSprint: (payload: {
    name?: string | null;
    start_date: string;
    duration_days?: number;
  }) => tauriInvoke<Sprint>('create_sprint', { input: payload }),
  updateSprintName: (payload: { id: string; name: string }) =>
    tauriInvoke<Sprint>('update_sprint_name', { input: payload }),
  deleteSprint: (payload: { id: string }) => tauriInvoke<void>('delete_sprint', { input: payload }),

  listEntriesForSprint: (sprintId: string) =>
    tauriInvoke<DailyEntry[]>('list_entries_for_sprint', { sprintId }),

  addDailyEntry: (payload: {
    sprint_id: string;
    date: string;
    category_id: string;
    title: string;
    details?: string | null;
  }) => tauriInvoke<DailyEntry>('add_daily_entry', { input: payload }),
  updateDailyEntry: (payload: {
    id: string;
    date: string;
    category_id: string;
    title: string;
    details?: string | null;
  }) => tauriInvoke<DailyEntry>('update_daily_entry', { input: payload }),
  deleteDailyEntry: (payload: { id: string }) => tauriInvoke<void>('delete_daily_entry', { input: payload }),

  generateReport: (payload: {
    sprint_id: string;
    from_date?: string | null;
    to_date?: string | null;
    categories?: string[] | null;
  }) => tauriInvoke<ReportOutput>('generate_report', { input: payload }),

  getDataPath: () => tauriInvoke<string>('get_data_path'),
  updateMenubarSettings: (payload: {
    show_icon: boolean;
    add_item_shortcut?: string | null;
  }) => tauriInvoke<void>('update_menubar_settings', { input: payload }),
  resetDatabase: () => tauriInvoke<void>('reset_database')
};
