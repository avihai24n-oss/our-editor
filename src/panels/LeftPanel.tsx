/**
 * Left panel — the Library (CapCut desktop): icon-over-label tab bar, then each tab's
 * category sidebar + grid. v1 tabs: Media, Audio, Text, Transitions, Filters, Adjustment.
 * The rest keep their place in the bar and show a "Coming soon" state.
 * Final interface: no props, reads/writes the store.
 */
import { useEffect, useRef, useState } from 'react';
import { onAppEvent } from '../ui/appEvents';
import { Icon, type IconName } from '../ui/Icon';
import { ComingSoon } from './LibraryLayout';
import { AdjustmentTab, FiltersTab } from './LooksTabs';
import { MediaTab } from './MediaTab';
import { usePref } from './prefs';
import { TextTab } from './TextTab';
import { TransitionsTab } from './TransitionsTab';
import './library.css';

export type LibraryTab =
  | 'media'
  | 'audio'
  | 'text'
  | 'stickers'
  | 'effects'
  | 'transitions'
  | 'captions'
  | 'filters'
  | 'adjustment'
  | 'templates';

export const LIBRARY_TABS: { id: LibraryTab; label: string; icon: IconName; v1: boolean }[] = [
  { id: 'media', label: 'Media', icon: 'media', v1: true },
  { id: 'audio', label: 'Audio', icon: 'audio', v1: true },
  { id: 'text', label: 'Text', icon: 'text', v1: true },
  { id: 'stickers', label: 'Stickers', icon: 'stickers', v1: false },
  { id: 'effects', label: 'Effects', icon: 'effects', v1: false },
  { id: 'transitions', label: 'Transitions', icon: 'transitions', v1: true },
  { id: 'captions', label: 'Captions', icon: 'captions', v1: false },
  { id: 'filters', label: 'Filters', icon: 'filters', v1: true },
  { id: 'adjustment', label: 'Adjustment', icon: 'adjustment', v1: true },
  { id: 'templates', label: 'Templates', icon: 'templates', v1: false },
];

const SOON_NOTES: Partial<Record<LibraryTab, string>> = {
  stickers: 'Stickers are coming in a later version.',
  effects: 'Video effects are coming in a later version.',
  captions: 'Manual captions and SRT import are coming in a later version.',
  templates: 'Templates are coming in a later version.',
};

/** Tab / Shift+Tab (shortcut table): the library tab `dir` steps away from `tab`, wrapping around. */
export function cycleLibraryTab(tab: LibraryTab, dir: 1 | -1): LibraryTab {
  const i = LIBRARY_TABS.findIndex((t) => t.id === tab);
  const n = LIBRARY_TABS.length;
  return LIBRARY_TABS[(((i + dir) % n) + n) % n]!.id;
}

function TabBar({ tab, onChange }: { tab: LibraryTab; onChange: (t: LibraryTab) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ left: false, right: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setOverflow({ left: el.scrollLeft > 2, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2 });
    update();
    el.addEventListener('scroll', update);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro?.disconnect();
    };
  }, []);
  // keep the active tab visible (Tab / Shift+Tab cycles through tabs that may be scrolled away)
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>('.lib-tabs__item.is-active');
    el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [tab]);
  const scroll = (dir: number) => ref.current?.scrollBy({ left: dir * 160, behavior: 'smooth' });
  return (
    <div className="lib-tabs">
      {overflow.left && (
        <button className="lib-tabs__chev" title="Scroll left" aria-label="Scroll tabs left" onClick={() => scroll(-1)}>
          <Icon name="chevron-left" size={14} />
        </button>
      )}
      <div className="lib-tabs__row" ref={ref} role="tablist" aria-label="Library">
        {LIBRARY_TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`lib-tabs__item${tab === t.id ? ' is-active' : ''}${t.v1 ? '' : ' is-soon'}`}
            title={t.v1 ? t.label : `${t.label} — coming soon`}
            data-testid={`library-tab-${t.id}`}
            onClick={() => onChange(t.id)}
          >
            <Icon name={t.icon} size={20} />
            <span>{t.label}</span>
          </button>
        ))}
      </div>
      {overflow.right && (
        <button className="lib-tabs__chev" title="Scroll right" aria-label="Scroll tabs right" onClick={() => scroll(1)}>
          <Icon name="chevron-right" size={14} />
        </button>
      )}
    </div>
  );
}

export function LeftPanel() {
  const [stored, setTab] = usePref<string>('lib.tab', 'media');
  const tab: LibraryTab = LIBRARY_TABS.some((t) => t.id === stored) ? (stored as LibraryTab) : 'media';
  const current = LIBRARY_TABS.find((t) => t.id === tab)!;
  const tabRef = useRef(tab);
  tabRef.current = tab;

  useEffect(() => {
    const offCycle = onAppEvent('libraryTab', ({ dir }) => setTab(cycleLibraryTab(tabRef.current, dir)));
    // ⌘I: the import picker lives in the Media tab
    const offImport = onAppEvent('import', () => {
      if (tabRef.current !== 'media') setTab('media');
    });
    const offShow = onAppEvent('libraryShow', ({ tab }) => {
      if (tabRef.current !== tab) setTab(tab);
    });
    return () => {
      offCycle();
      offImport();
      offShow();
    };
  }, [setTab]);

  return (
    <div className="lib-root">
      <TabBar tab={tab} onChange={setTab} />
      <div className="lib-content">
        {tab === 'media' && <MediaTab key="media" mode="media" />}
        {tab === 'audio' && <MediaTab key="audio" mode="audio" />}
        {tab === 'text' && <TextTab />}
        {tab === 'transitions' && <TransitionsTab />}
        {tab === 'filters' && <FiltersTab />}
        {tab === 'adjustment' && <AdjustmentTab />}
        {!current.v1 && <ComingSoon label={current.label} icon={current.icon} note={SOON_NOTES[tab]} />}
      </div>
    </div>
  );
}
