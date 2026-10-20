/**
 * Media tab (and Audio tab, which is the same bin filtered to audio).
 * Import button + OS file drop, search / grid-list / sort toolbar, tiles, "Added" badges.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { usedAssetIds } from '../model/project';
import { useEditor } from '../store';
import { withShortcut } from '../timeline/shortcutDefs';
import { consumeAssetHighlight, consumeImportRequest, onAppEvent, requestAssetHighlight } from '../ui/appEvents';
import { importSummary } from '../media/dropFiles';
import { Icon } from '../ui/Icon';
import { AssetTile } from './AssetTile';
import { SubprojectsList } from './SubprojectsPanel';
import { ComingSoon, GridLabel, LibraryBody, useFlash, type SidebarItem } from './LibraryLayout';
import { SORT_LABELS, visibleAssets, type AssetKindFilter, type AssetSort } from './libraryLogic';
import { usePref } from './prefs';
import { useSourcePreview } from '../player/sourcePreview';

const MEDIA_SIDEBAR: SidebarItem[] = [
  { id: 'import', label: 'Import', group: true },
  { id: 'all', label: 'All', child: true },
  { id: 'video', label: 'Videos', child: true },
  { id: 'image', label: 'Images', child: true },
  { id: 'audio', label: 'Audio', child: true },
  { id: 'subprojects', label: 'Subprojects' },
  { id: 'library', label: 'Library', disabled: true },
];

const AUDIO_SIDEBAR: SidebarItem[] = [
  { id: 'imported', label: 'Imported' },
  { id: 'sfx', label: 'Sound effects' },
  { id: 'music', label: 'Music', disabled: true },
];

export function MediaTab({ mode }: { mode: 'media' | 'audio' }) {
  const assetMap = useEditor((s) => s.project.assets);
  const used = useEditor(useShallow((s) => [...usedAssetIds(s.project)].sort()));
  const importFiles = useEditor((s) => s.importFiles);
  const addClip = useEditor((s) => s.addClip);
  const removeAsset = useEditor((s) => s.removeAsset);

  const [category, setCategory] = usePref<string>(`lib.${mode}.cat`, mode === 'media' ? 'all' : 'imported');
  const [view, setView] = usePref<'grid' | 'list'>(`lib.${mode}.view`, 'grid');
  const [sort, setSort] = usePref<AssetSort>(`lib.${mode}.sort`, 'added');
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const [flash, showFlash] = useFlash();

  // ⌘I (shortcut table): open the import picker. On first mount too, when ⌘I switched the
  // library to this tab (the request waits in appEvents until the Media tab consumes it).
  useEffect(() => {
    if (mode !== 'media') return;
    if (consumeImportRequest()) fileRef.current?.click();
    return onAppEvent('import', () => {
      if (consumeImportRequest()) fileRef.current?.click();
    });
  }, [mode]);

  // OS files dropped outside the timeline land here (src/media/dropImport.ts): show them all and
  // pulse the new tiles for a moment. Files dropped on this panel are handled by the same global
  // drop, so there is one import path and one overlay.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (mode !== 'media') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const show = (ids: string[]) => {
      if (!ids.length) return;
      consumeAssetHighlight();
      setQuery('');
      setCategory('all');
      setHighlight(new Set(ids));
      clearTimeout(timer);
      timer = setTimeout(() => setHighlight(new Set()), 1600);
      requestAnimationFrame(() => {
        const el = scrollRef.current?.querySelector<HTMLElement>(`[data-asset-id="${CSS.escape(ids[0]!)}"]`);
        el?.scrollIntoView?.({ block: 'nearest' });
      });
    };
    show(consumeAssetHighlight());
    const off = onAppEvent('assetHighlight', ({ ids }) => show(ids));
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [mode, setCategory]);

  const kind: AssetKindFilter = mode === 'audio' ? 'audio' : (['video', 'image', 'audio'].includes(category) ? (category as AssetKindFilter) : 'all');
  const assets = useMemo(() => Object.values(assetMap), [assetMap]);
  const list = useMemo(() => visibleAssets(assets, { kind, query, sort }), [assets, kind, query, sort]);
  const usedSet = useMemo(() => new Set(used), [used]);

  const doImport = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      setBusy((n) => n + files.length);
      try {
        const r = await importFiles(files);
        if (r.errors.length) showFlash(r.errors.length === 1 ? r.errors[0]! : `${r.errors.length} files could not be imported: ${r.errors[0]}`, 'error');
        else {
          const info = importSummary(r, (id) => useEditor.getState().project.assets[id]?.name);
          if (info) showFlash(info);
        }
        // files that were already here: point at their tiles
        if (r.reused.length) requestAssetHighlight(r.reused);
      } catch (e) {
        showFlash(e instanceof Error ? e.message : 'Import failed', 'error');
      } finally {
        setBusy((n) => Math.max(0, n - files.length));
      }
    },
    [importFiles, showFlash],
  );

  const onAdd = useCallback(
    (id: string) => {
      const clipId = addClip(id);
      if (!clipId) showFlash('Could not add — the target track is locked', 'error');
    },
    [addClip, showFlash],
  );
  const onRemove = useCallback(
    (id: string) => {
      const a = useEditor.getState().project.assets[id];
      if (!a) return;
      const inUse = usedAssetIds(useEditor.getState().project).has(id);
      if (inUse && !window.confirm(`"${a.name}" is used on the timeline. Delete it and its clips?`)) return;
      if (useSourcePreview.getState().assetId === id) useSourcePreview.getState().close();
      removeAsset(id);
      setSelected((s) => (s === id ? null : s));
    },
    [removeAsset],
  );

  // a click selects the tile and shows the file in the player (source preview)
  const onSelect = useCallback((id: string) => {
    setSelected(id);
    useSourcePreview.getState().open(id);
  }, []);

  const sidebar = mode === 'media' ? MEDIA_SIDEBAR : AUDIO_SIDEBAR;
  const showSfx = mode === 'audio' && category === 'sfx';
  const accept = mode === 'audio' ? 'audio/*' : 'video/*,audio/*,image/*';
  const emptyText =
    assets.length === 0 || (mode === 'audio' && !assets.some((a) => a.kind === 'audio'))
      ? mode === 'audio'
        ? 'Import audio files or drag them here'
        : 'Import videos, images or audio, or drag files here'
      : 'No matching media';

  return (
    <LibraryBody sidebar={sidebar} value={category} onChange={setCategory}>
      <div className="lib-drop">
        <input
          ref={fileRef}
          type="file"
          multiple
          accept={accept}
          hidden
          data-testid="media-import-input"
          onChange={(e) => {
            const files = e.target.files ? [...e.target.files] : [];
            e.target.value = '';
            void doImport(files);
          }}
        />
        <div className="lib__toolbar">
          <button className="lib__import" onClick={() => fileRef.current?.click()} title={withShortcut('Import files from your computer', 'importMedia')}>
            <span className="lib__import-dot">
              <Icon name="plus" size={12} />
            </span>
            Import
          </button>
          {busy > 0 && <span className="lib__busy">Importing…</span>}
          <span className="spacer" />
          {searchOpen ? (
            <div className="lib__search">
              <Icon name="search" size={14} />
              <input
                autoFocus
                value={query}
                placeholder="Search media"
                aria-label="Search media"
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Escape') {
                    setQuery('');
                    setSearchOpen(false);
                  }
                }}
              />
              <button
                className="icon-btn"
                title="Close search"
                onClick={() => {
                  setQuery('');
                  setSearchOpen(false);
                }}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          ) : (
            <button className="icon-btn" title="Search" aria-label="Search" onClick={() => setSearchOpen(true)}>
              <Icon name="search" size={16} />
            </button>
          )}
          <button
            className="icon-btn"
            title={view === 'grid' ? 'List view' : 'Grid view'}
            aria-label={view === 'grid' ? 'List view' : 'Grid view'}
            onClick={() => setView(view === 'grid' ? 'list' : 'grid')}
          >
            <Icon name={view === 'grid' ? 'list' : 'grid'} size={16} />
          </button>
          <div className="lib__sort">
            <button className="icon-btn" title={`Sort: ${SORT_LABELS[sort]}`} aria-label="Sort" onClick={() => setSortOpen((o) => !o)}>
              <Icon name="sort" size={16} />
            </button>
            {sortOpen && (
              <div className="menu lib__sort-menu" onMouseLeave={() => setSortOpen(false)}>
                {(Object.keys(SORT_LABELS) as AssetSort[]).map((k) => (
                  <button
                    key={k}
                    className={`menu__item${sort === k ? ' is-active' : ''}`}
                    onClick={() => {
                      setSort(k);
                      setSortOpen(false);
                    }}
                  >
                    {SORT_LABELS[k]}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {mode === 'media' && category === 'subprojects' ? (
          <SubprojectsList />
        ) : showSfx ? (
          <ComingSoon label="Sound effects" icon="audio" note="A sound-effects library is coming soon. Import your own sound files for now." />
        ) : (
          <div className="lib__scroll" ref={scrollRef}>
            <GridLabel>{query ? `Results for “${query}”` : 'All'}</GridLabel>
            {list.length === 0 ? (
              <div className="lib-empty">
                <Icon name="import" size={24} />
                <div>{emptyText}</div>
                {emptyText !== 'No matching media' && (
                  <button className="btn" onClick={() => fileRef.current?.click()}>
                    Import
                  </button>
                )}
              </div>
            ) : (
              <div className={view === 'grid' ? 'lib-grid' : 'lib-list'}>
                {list.map((a) => (
                  <AssetTile
                    key={a.id}
                    asset={a}
                    added={usedSet.has(a.id)}
                    view={view}
                    selected={selected === a.id}
                    highlighted={highlight.has(a.id)}
                    onSelect={onSelect}
                    onAdd={onAdd}
                    onRemove={onRemove}
                  />
                ))}
              </div>
            )}
          </div>
        )}
        {flash}
      </div>
    </LibraryBody>
  );
}
