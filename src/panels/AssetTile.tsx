/**
 * One media-bin item (grid tile or list row). A click selects it and shows it in the player
 * (source preview); adding to the timeline is the hover "+", a drag, or the right-click menu
 * (CapCut: double-click and Enter do NOT add). Carries the e2e ids (media-asset + data-*).
 */
import { memo, useEffect, useMemo, useState, type DragEvent, type MouseEvent } from 'react';
import type { MediaAsset } from '../model/types';
import { Icon } from '../ui/Icon';
import type { Peaks } from '../timeline/media/peaks';
import { useAssetUrl } from '../timeline/media/useAssetUrl';
import { getPeaks, peaksReady } from '../timeline/media/waveform';
import { durationBadge, middleEllipsis, setDragPayload, waveformBars } from './libraryLogic';
import { useAssetThumb } from './thumbnails';

export interface AssetTileProps {
  asset: MediaAsset;
  added: boolean;
  view: 'grid' | 'list';
  selected: boolean;
  /** Just imported by a drop: pulses briefly. */
  highlighted?: boolean;
  onSelect: (id: string) => void;
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
}

const BAR_COUNT = 28;

/** Real peaks (decoded once per asset, shared with the timeline); a seeded stand-in until ready. */
function useTileBars(assetId: string): number[] {
  const url = useAssetUrl(assetId);
  const [peaks, setPeaks] = useState<Peaks | null | undefined>(() => peaksReady(assetId));
  useEffect(() => {
    let alive = true;
    if (url) void getPeaks(assetId, url).then((p) => alive && setPeaks(p));
    return () => {
      alive = false;
    };
  }, [assetId, url]);
  return useMemo(() => {
    if (!peaks || !peaks.data.length) return waveformBars(assetId, BAR_COUNT);
    const per = peaks.data.length / BAR_COUNT;
    const out: number[] = [];
    let max = 0;
    for (let i = 0; i < BAR_COUNT; i++) {
      let m = 0;
      for (let j = Math.floor(i * per); j < Math.min(peaks.data.length, Math.floor((i + 1) * per)); j++) m = Math.max(m, peaks.data[j]!);
      out.push(m);
      max = Math.max(max, m);
    }
    return out.map((v) => Math.max(0.08, max > 0 ? v / max : 0));
  }, [peaks, assetId]);
}

function Waveform({ seed }: { seed: string }) {
  const bars = useTileBars(seed);
  return (
    <div className="atile__wave" aria-hidden>
      {bars.map((h, i) => (
        <span key={i} style={{ height: `${h * 100}%` }} />
      ))}
    </div>
  );
}

export function Thumb({ asset }: { asset: MediaAsset }) {
  const url = useAssetThumb(asset);
  if (asset.missing) return <div className="atile__lost">Media lost</div>;
  if (asset.kind === 'audio') return <Waveform seed={asset.id} />;
  if (url) return <img className="atile__img" src={url} alt="" draggable={false} />;
  return (
    <div className="atile__placeholder">
      <Icon name={asset.kind === 'image' ? 'image' : 'media'} size={20} />
    </div>
  );
}

export const AssetTile = memo(function AssetTile({ asset, added, view, selected, highlighted, onSelect, onAdd, onRemove }: AssetTileProps) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('pointerdown', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('blur', close);
    };
  }, [menu]);

  const badge = durationBadge(asset);
  const onDragStart = (e: DragEvent) => {
    if (asset.missing) {
      e.preventDefault();
      return;
    }
    setDragPayload(e.dataTransfer, { kind: 'asset', assetId: asset.id });
  };
  const onContext = (e: MouseEvent) => {
    e.preventDefault();
    onSelect(asset.id);
    setMenu({ x: e.clientX, y: e.clientY });
  };
  const add = (e: MouseEvent) => {
    e.stopPropagation();
    if (!asset.missing) onAdd(asset.id);
  };

  return (
    <div
      className={`atile atile--${view}${selected ? ' is-selected' : ''}${asset.missing ? ' is-missing' : ''}${highlighted ? ' is-new' : ''}`}
      draggable={!asset.missing}
      onDragStart={onDragStart}
      onClick={() => onSelect(asset.id)}
      onContextMenu={onContext}
      title={asset.name}
      data-testid="media-asset"
      data-asset-name={asset.name}
      data-asset-kind={asset.kind}
      data-asset-id={asset.id}
      tabIndex={0}
      onKeyDown={(e) => {
        // handled here, so the window shortcuts do not also run (Enter = the split-caption toast,
        // Delete = delete the TIMELINE selection). Enter previews the item, it does not add it.
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          onSelect(asset.id);
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          onRemove(asset.id);
        }
      }}
    >
      <div className="atile__thumb">
        <Thumb asset={asset} />
        {added && <span className="atile__added">Added</span>}
        {badge && view === 'grid' && <span className="atile__dur">{badge}</span>}
        {!asset.missing && (
          <button className="atile__add" title="Add to timeline" aria-label={`Add ${asset.name} to timeline`} onClick={add}>
            <Icon name="plus" size={14} />
          </button>
        )}
      </div>
      {view === 'grid' ? (
        <div className="atile__name">{middleEllipsis(asset.name)}</div>
      ) : (
        <>
          <div className="atile__name">{asset.name}</div>
          <div className="atile__meta">{asset.kind === 'image' ? 'Image' : asset.kind === 'audio' ? 'Audio' : 'Video'}</div>
          <div className="atile__meta atile__meta--num">{badge ?? '—'}</div>
        </>
      )}
      {menu && (
        <div className="menu" style={{ position: 'fixed', left: menu.x, top: menu.y }} onPointerDown={(e) => e.stopPropagation()}>
          <button
            className="menu__item"
            disabled={asset.missing}
            onClick={(e) => {
              setMenu(null);
              add(e);
            }}
          >
            Add to timeline
          </button>
          <button
            className="menu__item"
            onClick={(e) => {
              e.stopPropagation();
              setMenu(null);
              onRemove(asset.id);
            }}
          >
            Delete from project
          </button>
        </div>
      )}
    </div>
  );
});
