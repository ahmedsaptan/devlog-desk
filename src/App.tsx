import { ClipboardEvent, FormEvent, useEffect, useMemo, useState } from 'react';
import { api } from './lib/api';
import type { Category, DailyEntry, Sprint } from './lib/types';

type AppPage = 'home' | 'updates' | 'categories';

function isoDateToday() {
  return new Date().toISOString().slice(0, 10);
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

function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export default function App() {
  const [page, setPage] = useState<AppPage>('home');

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

  const sprintTimeline = useMemo(() => {
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
        setReportCategoryIds(loadedCategories.map((category) => category.id));
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
    if (!sprintId) {
      setEntries([]);
      return;
    }

    try {
      setBusy(true);
      setError('');
      const loadedEntries = await api.listEntriesForSprint(sprintId);
      setEntries(loadedEntries);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void bootstrap();
  }, []);

  useEffect(() => {
    void loadEntriesForSprint(selectedSprintId);
  }, [selectedSprintId]);

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

      if (!reportCategoryIds.includes(category.id)) {
        setReportCategoryIds((current) => [...current, category.id]);
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
    const ok = window.confirm(`Delete category "${category.name}"?`);
    if (!ok) {
      return;
    }

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

      if (selectedSprintId) {
        await loadEntriesForSprint(selectedSprintId);
      }

      setNotice(`Category ${category.name} deleted.`);
    } catch (err) {
      const message = String(err);
      setError(message);
      window.alert(message);
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
        start_date: newSprintStart
      });

      const nextSprints = [...sprints, sprint];
      setSprints(nextSprints);
      setSelectedSprintId(sprint.id);
      setNewSprintName('');
      setShowCreateSprintForm(false);
      setNotice(`Created ${sprint.code}.`);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onRenameSprint(sprint: Sprint) {
    const value = window.prompt('New sprint display name', sprint.name);
    if (value === null) {
      return;
    }

    const name = value.trim();
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
      setNotice(`Updated ${updated.code} name.`);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
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

  function openSprintInUpdates(sprintId: string) {
    setSelectedSprintId(sprintId);
    setPage('updates');
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

  return (
    <div className="page">
      <header className="hero">
        <p className="kicker">Desktop Sprint Journal</p>
        <h1>DevLog Desk</h1>
        <p className="subtitle">
          Daily engineering updates with sprint context, dynamic categories, and report export.
        </p>
        <p className="meta">Storage file: {dataPath || 'loading...'}</p>
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
          className={page === 'updates' ? 'tab tab-on' : 'tab'}
          onClick={() => setPage('updates')}
        >
          Updates
        </button>
        <button
          type="button"
          className={page === 'categories' ? 'tab tab-on' : 'tab'}
          onClick={() => setPage('categories')}
        >
          Categories
        </button>
      </nav>

      {page === 'home' ? (
        <main className="grid">
          <section className="card card-wide">
            <div className="card-head">
              <h2>Add New Sprint</h2>
              <button
                type="button"
                onClick={() => setShowCreateSprintForm((current) => !current)}
              >
                {showCreateSprintForm ? 'Hide Form' : 'Add Sprint'}
              </button>
            </div>

            {showCreateSprintForm ? (
              <form onSubmit={onCreateSprint} className="stack">
                <input
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
                    <input
                      type="date"
                      value={newSprintStart}
                      onChange={(e) => setNewSprintStart(e.target.value)}
                    />
                  </label>
                </div>
                <p className="meta">Duration is fixed to 2 weeks (14 days) from start date.</p>
                <button type="submit" disabled={busy}>
                  Create Next Sprint
                </button>
              </form>
            ) : (
              <p className="meta">Use Add Sprint to create a new active sprint.</p>
            )}
          </section>

          <section className="card">
            <h2>Current Active Sprint</h2>
            {activeSprint ? (
              <>
                <p className="sprint-code">{activeSprint.code}</p>
                <p>
                  <strong>{activeSprint.name}</strong>
                </p>
                <p className="meta">
                  {activeSprint.start_date} - {activeSprint.end_date ?? 'open'}
                </p>
                <div className="inline-actions">
                  <button type="button" onClick={() => openSprintInUpdates(activeSprint.id)}>
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

          <section className="card card-wide">
            <h2>Old Sprints</h2>
            {oldSprints.length === 0 ? (
              <p className="meta">No old sprints yet.</p>
            ) : (
              <ul className="sprint-list">
                {oldSprints.map((sprint) => (
                  <li key={sprint.id} className="old-sprint-item">
                    <div>
                      <div className="old-sprint-meta">
                        <p className="sprint-code">{sprint.code}</p>
                        <span className="old-sprint-badge">Archived</span>
                      </div>
                      <strong>{sprint.name}</strong>
                      <p className="meta">
                        {sprint.start_date} - {sprint.end_date ?? 'open'}
                      </p>
                    </div>
                    <div className="inline-actions">
                      <button type="button" onClick={() => openSprintInUpdates(sprint.id)}>
                        Open
                      </button>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => onRenameSprint(sprint)}
                      >
                        Rename
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
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
                placeholder="Category name (e.g. Preview, Meeting, Tasks)"
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
                          <button type="button" disabled={busy} onClick={() => startEditCategory(category)}>
                            Edit
                          </button>
                          <button
                            type="button"
                            className="btn-danger"
                            disabled={busy}
                            onClick={() => onDeleteCategory(category)}
                          >
                            Delete
                          </button>
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

      {page === 'updates' ? (
        <main className="grid">
          <section className="card card-wide sprint-meta-strip">
            <div className="sprint-meta-main">
              <label>
                Sprint
                <select
                  value={selectedSprintId}
                  onChange={(e) => setSelectedSprintId(e.target.value)}
                >
                  <option value="">Select a sprint</option>
                  {sprints.map((sprint) => (
                    <option key={sprint.id} value={sprint.id}>
                      {sprintDisplayLabel(sprint)}
                    </option>
                  ))}
                </select>
              </label>
              {selectedSprint ? (
                <div className="sprint-meta-values">
                  <p className="sprint-code">{selectedSprint.code}</p>
                  <p className="meta">
                    {selectedSprint.start_date} - {selectedSprint.end_date ?? 'open'}
                  </p>
                </div>
              ) : (
                <p className="meta">No sprint selected.</p>
              )}
            </div>
          </section>

          <section className="card card-wide">
            <h2>
              Generate Sprint Report
              {selectedSprint ? `: ${sprintDisplayLabel(selectedSprint)}` : ''}
            </h2>
            <div className="row">
              <label>
                From
                <input
                  type="date"
                  value={reportFromDate}
                  onChange={(e) => setReportFromDate(e.target.value)}
                />
              </label>
              <label>
                To
                <input
                  type="date"
                  value={reportToDate}
                  onChange={(e) => setReportToDate(e.target.value)}
                />
              </label>
            </div>

            <div className="chip-row">
              {categories.map((category) => (
                <button
                  key={category.id}
                  type="button"
                  className={reportCategoryIds.includes(category.id) ? 'chip chip-on' : 'chip'}
                  onClick={() => toggleReportCategory(category.id)}
                >
                  {category.name}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={onGenerateReport}
              disabled={busy || !selectedSprintId || categories.length === 0}
            >
              Generate + Save Markdown
            </button>

            {reportPath ? <p className="meta">Saved report: {reportPath}</p> : null}

            <textarea
              className="report-preview"
              value={reportMarkdown}
              onChange={(e) => setReportMarkdown(e.target.value)}
              placeholder="Report preview will appear here"
            />
          </section>

          <section className="card card-wide">
            <h2>Add Daily Item</h2>
            {categories.length === 0 ? (
              <p className="meta">No categories yet. Create one in the Categories page.</p>
            ) : null}
            <form onSubmit={onAddEntry} className="stack add-item-form">
              <label>
                Date
                <input
                  type="date"
                  value={entryDate}
                  onChange={(e) => setEntryDate(e.target.value)}
                />
              </label>

              <label>
                Category
                <select
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
                disabled={busy || !selectedSprintId || !entryCategoryId || categories.length === 0}
              >
                Add Item
              </button>
            </form>
          </section>

          <section className="card card-wide">
            <h2>Sprint Timeline</h2>
            {sprintTimeline.length === 0 ? (
              <p className="meta">No items yet for this sprint.</p>
            ) : (
              sprintTimeline.map((group) => (
                <div key={group.date} className="timeline-day">
                  <h3>{group.date}</h3>
                  {group.categories.map((categoryGroup) => (
                    <div key={`${group.date}-${categoryGroup.categoryId}`} className="timeline-category">
                      <h4>{categoryGroup.categoryName}</h4>
                      <ol className="timeline-ordered-list">
                        {categoryGroup.items.map((line, index) => (
                          <li key={`${group.date}-${categoryGroup.categoryId}-${index}`}>{line}</li>
                        ))}
                      </ol>
                    </div>
                  ))}
                </div>
              ))
            )}
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
