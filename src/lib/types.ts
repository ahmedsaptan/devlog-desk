export interface Category {
  id: string;
  name: string;
  created_at: string;
}

export interface Sprint {
  id: string;
  code: string;
  name: string;
  start_date: string;
  end_date?: string | null;
  created_at: string;
}

export interface DailyEntry {
  id: string;
  sprint_id: string;
  date: string;
  category_id: string;
  title: string;
  details?: string | null;
  created_at: string;
}

export interface ReportOutput {
  markdown: string;
  file_path: string;
  total_items: number;
}
