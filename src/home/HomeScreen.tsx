/**
 * Home screen: every project stored in this browser, newest first.
 *
 * A card is a cover frame (grabbed from the player the last time the project was open), its name,
 * ratio, clip count, duration and when it was last edited. Click opens it; the ⋯ menu renames,
 * duplicates or deletes it. Opening, creating and leaving all save the project being left first
 * (src/store/projects.ts), so nothing here can lose work.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatShort } from '../model/time';
import type { Id } from '../model/types';
import { projectSummaries, type ProjectSummary } from '../store/persistence';
import { duplicateProject, removeProject, renameProject } from '../store/projects';
import { Modal } from '../ui/controls';
import { Icon } from '../ui/Icon';
import { useAppRoute } from './route';
import './home.css';

/** "just now" / "14 min ago" / "3 h ago" / "yesterday" / "12 Oct" / "12 Oct 2025". */
export function relativeTime(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return 'just now';
  if (s < 90) return 'a minute ago';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = new Date(at);
  const days = Math.round(h / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

function CardMenu({ onRename, onDuplicate, onDelete }: { onRename: () => void; onDuplicate: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  return (
    <div className="home-card__menu" ref={wrap}>
      <button
        className="icon-btn"
        aria-label="Project options"
        aria-expanded={open}
        title="More"
        data-testid="project-menu"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="more" size={16} />
      </button>
      {open && (
        <div className="home-menu" role="menu">
          <button role="menuitem" onClick={run(onRename)}>
            <Icon name="text" size={14} /> Rename
          </button>
          <button role="menuitem" onClick={run(onDuplicate)}>
            <Icon name="copy" size={14} /> Duplicate
          </button>
          <button role="menuitem" className="is-danger" onClick={run(onDelete)}>
            <Icon name="trash" size={14} /> Delete
          </button>
        </div>
      )}
    </div>
  );
}

function ProjectCard({
  p,
  renaming,
  onOpen,
  onStartRename,
  onRename,
  onDuplicate,
  onDelete,
}: {
  p: ProjectSummary;
  renaming: boolean;
  onOpen: () => void;
  onStartRename: () => void;
  onRename: (name: string) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState(p.name);
  useEffect(() => setDraft(p.name), [p.name, renaming]);
  return (
    <article className="home-card" data-testid="project-card" data-project-id={p.id} data-project-name={p.name}>
      <button className="home-card__open" onClick={onOpen} aria-label={`Open ${p.name}`} data-testid="project-open">
        <span className="home-card__cover">
          {p.cover ? (
            <img src={p.cover} alt="" draggable={false} />
          ) : (
            <span className="home-card__blank" aria-hidden="true">
              <Icon name="media" size={22} />
            </span>
          )}
          <span className="home-card__badge">{formatShort(p.duration)}</span>
        </span>
      </button>
      <div className="home-card__foot">
        <div className="home-card__text">
          {renaming ? (
            <input
              className="home-card__rename"
              autoFocus
              aria-label="Project name"
              value={draft}
              data-testid="project-rename-input"
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => onRename(draft)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') {
                  setDraft(p.name);
                  onRename(p.name);
                }
              }}
            />
          ) : (
            <button className="home-card__name" onClick={onStartRename} title="Rename" data-testid="project-name">
              {p.name}
            </button>
          )}
          <div className="home-card__meta">
            <span>{p.aspect}</span>
            <span>·</span>
            <span>
              {p.clips} {p.clips === 1 ? 'clip' : 'clips'}
            </span>
            <span>·</span>
            <span>{relativeTime(p.updatedAt)}</span>
          </div>
        </div>
        <CardMenu onRename={onStartRename} onDuplicate={onDuplicate} onDelete={onDelete} />
      </div>
    </article>
  );
}

export function HomeScreen() {
  const route = useAppRoute((s) => s.route);
  const busy = useAppRoute((s) => s.busy);
  const open = useAppRoute((s) => s.open);
  const create = useAppRoute((s) => s.create);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [query, setQuery] = useState('');
  const [renamingId, setRenamingId] = useState<Id | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ProjectSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setProjects(await projectSummaries());
      setError(null);
    } catch (e) {
      setProjects([]);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (route === 'home') void reload();
  }, [route, reload]);

  const shown = useMemo(() => {
    const list = projects ?? [];
    const q = query.trim().toLowerCase();
    return q ? list.filter((p) => p.name.toLowerCase().includes(q)) : list;
  }, [projects, query]);

  const doRename = async (id: Id, name: string) => {
    setRenamingId(null);
    const was = projects?.find((p) => p.id === id)?.name;
    if (name.trim() && name !== was) {
      await renameProject(id, name);
      await reload();
    }
  };

  return (
    <div className="home" data-testid="home-screen">
      <header className="home__bar">
        <div className="home__brand">
          <Icon name="home" size={16} /> Our Editor
        </div>
        <button className="btn btn--primary" onClick={() => void create()} disabled={busy} data-testid="home-new-project">
          <Icon name="plus" size={14} /> New project
        </button>
      </header>

      <div className="home__body">
        <div className="home__head">
          <h1>
            Projects {projects && <span className="home__count">{projects.length}</span>}
          </h1>
          {(projects?.length ?? 0) > 6 && (
            <label className="home__search">
              <Icon name="search" size={14} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search projects"
                aria-label="Search projects"
                data-testid="home-search"
              />
            </label>
          )}
        </div>

        {error && <p className="home__error">Could not read your projects: {error}</p>}

        {projects === null ? (
          <p className="home__hint">Loading…</p>
        ) : shown.length === 0 ? (
          <div className="home__empty">
            <Icon name="media" size={28} />
            <p>{projects.length === 0 ? 'No projects yet.' : 'No project matches that name.'}</p>
            {projects.length === 0 && (
              <>
                <p className="home__hint">Projects are kept in this browser, with their media. Nothing is uploaded.</p>
                <button className="btn btn--primary" onClick={() => void create()} disabled={busy}>
                  <Icon name="plus" size={14} /> New project
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="home__grid">
            {shown.map((p) => (
              <ProjectCard
                key={p.id}
                p={p}
                renaming={renamingId === p.id}
                onOpen={() => {
                  void open(p.id).then((ok) => {
                    if (!ok) void reload();
                  });
                }}
                onStartRename={() => setRenamingId(p.id)}
                onRename={(name) => void doRename(p.id, name)}
                onDuplicate={() => void duplicateProject(p.id).then(reload)}
                onDelete={() => setConfirmDelete(p)}
              />
            ))}
          </div>
        )}

        <p className="home__foot">Projects and their media stay in this browser. Nothing is uploaded.</p>
      </div>

      {confirmDelete && (
        <Modal
          title="Delete project"
          onClose={() => setConfirmDelete(null)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirmDelete(null)}>
                Cancel
              </button>
              <button
                className="btn btn--danger"
                data-testid="confirm-delete"
                onClick={() => {
                  const id = confirmDelete.id;
                  setConfirmDelete(null);
                  void removeProject(id).then(reload);
                }}
              >
                Delete
              </button>
            </>
          }
        >
          <p>
            Delete <strong>{confirmDelete.name}</strong>? Its timeline is removed from this browser, and media no other
            project uses is freed. This cannot be undone.
          </p>
        </Modal>
      )}

      {busy && (
        <div className="home__busy" role="status">
          Opening…
        </div>
      )}
    </div>
  );
}
