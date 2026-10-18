/**
 * Media tab (and Audio tab, which is the same bin filtered to audio).
 * Import button + OS file drop, search / grid-list / sort toolbar, tiles, "Added" badges.
 */
import { useCallback, useMemo, useRef, useState, type DragEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { usedAssetIds } from '../model/project';
import { useEditor } from '../store';
import { Icon } from '../ui/Icon';
import { AssetTile } from './AssetTile';
import { ComingSoon, GridLabel, LibraryBody, useFlash, type SidebarItem } from './LibraryLayout';
import { isFileDrag, SORT_LABELS, visibleAssets, type AssetKindFilter, type AssetSort } from './libraryLogic';
import { usePref } from './prefs';

const MEDIA_SIDEBAR: SidebarItem[] = [
  { id: 'import', label: 'Import', group: true },
  { id: 'all', label: 'All', child: true },
  { id: 'video', label: 'Videos', child: true },
  { id: 'image', label: 'Images', child: true },
  { id: 'audio', label: 'Audio', child: true },
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
  const [dropping, setDropping] = useState(false);
  const [busy, setBusy] = useState(0);
  const dragDepth = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const [flash, showFlash] = useFlash();

  const kind: AssetKindFilter = mode === 'audio' ? 'audio' : (['video', 'image', 'audio'].includes(category) ? (category as AssetKindFilter) : 'all');
  const assets = useMemo(() => Object.values(assetMap), [assetMap]);
  const list = useMemo(() => visibleAssets(assets, { kind, query, sort }), [assets, kind, query, sort]);
  const usedSet = useMemo(() => new Set(used), [used]);

  const doImport = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      setBusy((n) => n + files.length);
      try {
        const { assetIds, errors } = await importFiles(files);
        if (errors.length) showFlash(errors.length === 1 ? errors[0]! : `${errors.length} files could not be imported: ${errors[0]}`, 'error');
        else if (assetIds.length) showFlash(`Imported ${assetIds.length} file${assetIds.length > 1 ? 's' : ''}`);
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
      removeAsset(id);
      setSelected((s) => (s === id ? null : s));
    },
    [removeAsset],
  );

  const dropHandlers = {
    onDragEnter: (e: DragEvent) => {
      if (!isFileDrag([...e.dataTransfer.types])) return;
      dragDepth.current++;
      setDropping(true);
    },
    onDragOver: (e: DragEvent) => {
      if (!isFileDrag([...e.dataTransfer.types])) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (e: DragEvent) => {
      if (!isFileDrag([...e.dataTransfer.types])) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) setDropping(false);
    },
    onDrop: (e: DragEvent) => {
      if (!isFileDrag([...e.dataTransfer.types])) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDropping(false);
      void doImport([...e.dataTransfer.files]);
    },
  };

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
      <div className="lib-drop" {...dropHandlers}>
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
          <button className="lib__import" onClick={() => fileRef.current?.click()} title="Import (files from your computer)">
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

        {showSfx ? (
          <ComingSoon label="Sound effects" icon="audio" note="A sound-effects library is coming soon. Import your own sound files for now." />
        ) : (
          <div className="lib__scroll">
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
                    onSelect={setSelected}
                    onAdd={onAdd}
                    onRemove={onRemove}
                  />
                ))}
              </div>
            )}
          </div>
        )}
        {dropping && (
          <div className="lib-drop__overlay">
            <Icon name="import" size={28} />
            Drop files to import
          </div>
        )}
        {flash}
      </div>
    </LibraryBody>
  );
}
