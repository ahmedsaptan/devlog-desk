import { invoke } from '@tauri-apps/api/core';
import type { Category, DailyEntry, ReportOutput, Sprint } from './types';

export const api = {
  listCategories: () => invoke<Category[]>('list_categories'),
  createCategory: (payload: { name: string }) =>
    invoke<Category>('create_category', { input: payload }),
  updateCategory: (payload: { id: string; name: string }) =>
    invoke<Category>('update_category', { input: payload }),
  deleteCategory: (payload: { id: string; replacement_category_id?: string | null }) =>
    invoke<void>('delete_category', { input: payload }),

  listSprints: () => invoke<Sprint[]>('list_sprints'),
  createSprint: (payload: {
    name?: string | null;
    start_date: string;
    duration_days?: number;
  }) => invoke<Sprint>('create_sprint', { input: payload }),
  updateSprintName: (payload: { id: string; name: string }) =>
    invoke<Sprint>('update_sprint_name', { input: payload }),
  deleteSprint: (payload: { id: string }) => invoke<void>('delete_sprint', { input: payload }),

  listEntriesForSprint: (sprintId: string) =>
    invoke<DailyEntry[]>('list_entries_for_sprint', { sprintId }),

  addDailyEntry: (payload: {
    sprint_id: string;
    date: string;
    category_id: string;
    title: string;
    details?: string | null;
  }) => invoke<DailyEntry>('add_daily_entry', { input: payload }),
  updateDailyEntry: (payload: {
    id: string;
    date: string;
    category_id: string;
    title: string;
    details?: string | null;
  }) => invoke<DailyEntry>('update_daily_entry', { input: payload }),
  deleteDailyEntry: (payload: { id: string }) => invoke<void>('delete_daily_entry', { input: payload }),

  generateReport: (payload: {
    sprint_id: string;
    from_date?: string | null;
    to_date?: string | null;
    categories?: string[] | null;
  }) => invoke<ReportOutput>('generate_report', { input: payload }),

  getDataPath: () => invoke<string>('get_data_path'),
  updateMenubarSettings: (payload: {
    show_icon: boolean;
    add_item_shortcut?: string | null;
  }) => invoke<void>('update_menubar_settings', { input: payload }),
  resetDatabase: () => invoke<void>('reset_database')
};
