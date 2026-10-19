/**
 * Bottom timeline (CapCut desktop): toolbar, ruler, track headers, tracks with clips, playhead,
 * snapping guides, magnet insert line, transitions on cuts, library drops, marquee selection,
 * zoom/scroll, auto-scroll while playing, and the global keyboard shortcuts.
 *
 * Layout: ONE scroll container. The ruler row is sticky to the top, every track header is sticky
 * to the left, so horizontal and vertical scroll stay in sync for free.
 *
 * Gestures: every edit gesture is one undo step (beginTx → actions → commitTx; Escape → cancelTx).
 * Moves are previewed with a ghost and committed on release; trims are applied live.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as RPointerEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { findClip, timelineRows } from '../model/project';
import { clipEnd, formatShort, formatTimecode, projectDuration, pxToUs, snapToFrame, usToPx } from '../model/time';
import type { Clip, Id, Marker, Track, Us } from '../model/types';
import { importDroppedFiles } from '../media/dropImport';
import { addTextPreset } from '../panels/TextTab';
import { TEXT_PRESETS, textPreset } from '../panels/presets';
import { useEditor } from '../store';
import { ClipView, type ClipPart } from './ClipView';
import { acceptsDrag, isFileDrag, readPayload } from './dnd';
import { anchoredScroll, bandHeights, clampZoom, clipsInSpan, DRAG_THRESHOLD_PX, fitZoom, followScroll, HEADER_W, nearestCut, stableContentWidth } from './geometry';
import {
  assetDropOptions,
  moveInsertCut,
  resolveMoveTarget,
  snapMove,
  snapPoint,
  textDropTrack,
  type MoveTarget,
  type RowKey,
} from './gestures';
import { Ruler } from './Ruler';
import { useTimelineShortcuts } from './shortcuts';
import { Toolbar } from './Toolbar';
import { TrackHeader } from './TrackHeader';
import { useTimelineUi } from './uiStore';
import './timeline.css';

const RULER_H = 26;
const MAIN_H = 64;
const TRACK_H = 48;
const BAND_MIN_H = 28;

const rowHeight = (t: Track) => (t.kind === 'main' ? MAIN_H : TRACK_H);

// ---------------------------------------------------------------- gesture state

type Gesture =
  | {
      kind: 'move';
      pointerId: number;
      clip: Clip;
      fromTrack: Track;
      x0: number;
      y0: number;
      started: boolean;
      /** Click on an already selected clip in a multi-selection: reduce to it on release (if no drag). */
      reselect: boolean;
      start: Us;
      target: MoveTarget;
    }
  | {
      kind: 'trim';
      pointerId: number;
      clip: Clip;
      edge: 'left' | 'right';
      x0: number;
      started: boolean;
    }
  | {
      kind: 'marquee';
      pointerId: number;
      /** Content coordinates (scroll-independent). */
      cx0: number;
      cy0: number;
      x0: number;
      y0: number;
      additive: boolean;
      started: boolean;
      base: Id[];
    }
  | { kind: 'scrub'; pointerId: number };

interface Ghost {
  clipId: Id;
  type: Clip['type'];
  start: Us;
  duration: Us;
  /** Track id, or 'band:top' / 'band:bottom'. */
  rowKey: string;
  insertAt: Us | null;
}

interface Marquee {
  left: number;
  top: number;
  width: number;
  height: number;
}

const keyOf = (r: RowKey): string => (r.type === 'track' ? r.trackId : `band:${r.band}`);

function parseRowKey(k: string): RowKey {
  if (k === 'band:top') return { type: 'band', band: 'top' };
  if (k === 'band:bottom') return { type: 'band', band: 'bottom' };
  return { type: 'track', trackId: k };
}

export function Timeline() {
  const project = useEditor((s) => s.project);
  const { zoom, playhead, playing } = useEditor(useShallow((s) => ({ zoom: s.zoom, playhead: s.playhead, playing: s.playing })));
  const selection = useEditor((s) => s.selection);
  const { tool, hoverTime, area } = useTimelineUi(
    useShallow((s) => ({ tool: s.tool, hoverTime: s.hoverTime, area: s.area })),
  );

  const rows = useMemo(() => timelineRows(project), [project]);
  const duration = projectDuration(project);
  const fps = project.settings.fps;
  const selectedSet = useMemo(() => new Set(selection.clipIds), [selection.clipIds]);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ left: 0, width: 800, height: 240 });
  const laneW = Math.max(100, view.width - HEADER_W);
  // never narrower than what is on screen: a shorter edit must not clamp (jump) the scroll
  const contentW = stableContentWidth(duration, zoom, laneW, Math.max(view.left, scrollerRef.current?.scrollLeft ?? 0));
  const viewFrom = view.left;
  const viewTo = view.left + laneW;

  const [ghost, setGhost] = useState<Ghost | null>(null);
  const [guide, setGuide] = useState<Us | null>(null);
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const [trimTip, setTrimTip] = useState<{ x: number; text: string } | null>(null);
  const [dropHint, setDropHint] = useState<{ at: Us; rowKey: string | null } | null>(null);
  const [splitHover, setSplitHover] = useState<Us | null>(null);
  const gesture = useRef<Gesture | null>(null);

  // ---------------------------------------------------------------- view tracking

  /** Copies the scroller's geometry into `view` (virtualised clips and ruler ticks read it). */
  const syncView = useCallback(() => {
    const sc = scrollerRef.current;
    if (!sc) return;
    setView((v) =>
      v.left === sc.scrollLeft && v.width === sc.clientWidth && v.height === sc.clientHeight
        ? v
        : { left: sc.scrollLeft, width: sc.clientWidth, height: sc.clientHeight },
    );
  }, []);

  /**
   * Scroll writes made by the timeline itself (zoom anchor, playback follow). The view is synced in
   * the same frame — called from a layout effect, React re-renders before paint — so clips and
   * ruler ticks are never drawn for the previous scroll position (that one-frame flicker read as a
   * jump while zooming). The written value is remembered so the scroll listener can tell these
   * apart from the user's own scrolling.
   */
  const lastWrite = useRef<number | null>(null);
  const knownLeft = useRef(0);
  const follow = useRef({ suspended: false, userAt: 0 });
  const writeScrollLeft = useCallback(
    (x: number) => {
      const sc = scrollerRef.current;
      if (!sc) return;
      sc.scrollLeft = x;
      lastWrite.current = sc.scrollLeft;
      knownLeft.current = sc.scrollLeft;
      syncView();
    },
    [syncView],
  );

  /** Last pointer position over the scroller, so hover lines follow the content when it scrolls. */
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const refreshHoverRef = useRef<() => void>(() => undefined);

  useLayoutEffect(() => {
    const sc = scrollerRef.current;
    if (!sc) return;
    let raf = 0;
    const read = () => {
      raf = 0;
      syncView();
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(read);
    };
    const onScroll = () => {
      const left = sc.scrollLeft;
      if (left !== knownLeft.current) {
        const ours = lastWrite.current !== null && Math.abs(left - lastWrite.current) <= 1;
        // the user scrolled sideways while playing: stop following until the playhead is back in view
        if (!ours && useEditor.getState().playing) follow.current = { suspended: true, userAt: performance.now() };
        knownLeft.current = left;
      }
      lastWrite.current = null;
      schedule();
      refreshHoverRef.current();
    };
    read();
    knownLeft.current = sc.scrollLeft;
    sc.addEventListener('scroll', onScroll, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    ro?.observe(sc);
    return () => {
      sc.removeEventListener('scroll', onScroll);
      ro?.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [syncView]);

  /** Lane x (px from time 0) for a client X. */
  const laneX = useCallback((clientX: number): number => {
    const sc = scrollerRef.current;
    if (!sc) return 0;
    return clientX - sc.getBoundingClientRect().left - HEADER_W + sc.scrollLeft;
  }, []);
  const timeAt = useCallback((clientX: number): Us => Math.max(0, pxToUs(laneX(clientX), useEditor.getState().zoom)), [laneX]);

  /** Row under a client Y (tracks and the top/bottom bands), or null. */
  const rowAt = useCallback((clientY: number): RowKey | null => {
    const el = rowsRef.current;
    if (!el) return null;
    const list = Array.from(el.querySelectorAll<HTMLElement>('[data-row-key]'));
    for (const r of list) {
      const b = r.getBoundingClientRect();
      if (clientY >= b.top && clientY < b.bottom) return parseRowKey(r.dataset.rowKey ?? '');
    }
    const first = list[0];
    const last = list[list.length - 1];
    if (first && clientY < first.getBoundingClientRect().top) return { type: 'band', band: 'top' };
    if (last && clientY >= last.getBoundingClientRect().bottom) return { type: 'band', band: 'bottom' };
    return null;
  }, []);

  // ---------------------------------------------------------------- zoom (anchored)

  const anchor = useRef<{ time: Us; offset: number } | null>(null);

  const zoomTo = useCallback((z: number, anchorClientX?: number) => {
    const sc = scrollerRef.current;
    const s = useEditor.getState();
    const nz = clampZoom(z);
    if (nz === s.zoom) return;
    if (!sc) {
      s.setZoom(nz);
      return;
    }
    const lw = sc.clientWidth - HEADER_W;
    let offset: number;
    if (anchorClientX !== undefined) offset = anchorClientX - sc.getBoundingClientRect().left - HEADER_W;
    else {
      offset = usToPx(s.playhead, s.zoom) - sc.scrollLeft;
      if (offset < 0 || offset > lw) offset = 0; // playhead off-screen: keep the left edge
    }
    offset = Math.max(0, Math.min(lw, offset));
    anchor.current = { time: pxToUs(sc.scrollLeft + offset, s.zoom), offset };
    s.setZoom(nz);
  }, []);

  const fit = useCallback(() => {
    const sc = scrollerRef.current;
    const s = useEditor.getState();
    if (!sc) return;
    const z = fitZoom(projectDuration(s.project), sc.clientWidth - HEADER_W);
    anchor.current = { time: 0, offset: 0 };
    if (z === s.zoom) writeScrollLeft(0);
    else s.setZoom(z);
  }, [writeScrollLeft]);

  useLayoutEffect(() => {
    const sc = scrollerRef.current;
    const a = anchor.current;
    if (!sc || !a) return;
    anchor.current = null;
    writeScrollLeft(anchoredScroll(a.time, a.offset, zoom));
  }, [zoom, writeScrollLeft]);

  useEffect(() => {
    useTimelineUi.getState().setView({
      zoomTo,
      zoomBy: (f, x) => zoomTo(useEditor.getState().zoom * f, x),
      fit,
    });
    return () => useTimelineUi.getState().setView(null);
  }, [zoomTo, fit]);

  // ⌘/Ctrl + wheel (and trackpad pinch) zooms at the cursor; Alt + wheel scrolls horizontally.
  useEffect(() => {
    const sc = scrollerRef.current;
    if (!sc) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025));
        zoomTo(useEditor.getState().zoom * factor, e.clientX);
      } else if (e.altKey) {
        e.preventDefault();
        sc.scrollLeft += e.deltaY || e.deltaX;
      }
    };
    sc.addEventListener('wheel', onWheel, { passive: false });
    return () => sc.removeEventListener('wheel', onWheel);
  }, [zoomTo]);

  // Playback follows the playhead (gliding, see followScroll). A sideways scroll by the user while
  // playing suspends it — before, the next frame snapped the view back, so a trackpad scroll during
  // playback shook between the two positions — until the playhead is on screen again.
  useLayoutEffect(() => {
    if (playing) follow.current = { suspended: false, userAt: 0 };
  }, [playing]);
  useLayoutEffect(() => {
    if (!playing) return;
    const sc = scrollerRef.current;
    if (!sc || gesture.current) return;
    const lane = sc.clientWidth - HEADER_W;
    const px = usToPx(playhead, zoom);
    const f = follow.current;
    if (f.suspended) {
      const onScreen = px >= sc.scrollLeft && px <= sc.scrollLeft + lane;
      if (!onScreen || performance.now() - f.userAt < 800) return;
      f.suspended = false;
    }
    const next = followScroll(px, sc.scrollLeft, lane);
    if (next !== null && next !== sc.scrollLeft) writeScrollLeft(next);
  }, [playing, playhead, zoom, writeScrollLeft]);

  // ---------------------------------------------------------------- gestures

  const endGesture = useCallback(() => {
    gesture.current = null;
    setGhost(null);
    setGuide(null);
    setMarquee(null);
    setTrimTip(null);
  }, []);

  // Window listeners read the latest handlers through refs, so add/remove always pair up.
  const moveRef = useRef<(e: PointerEvent) => void>(() => undefined);
  const upRef = useRef<(e: PointerEvent) => void>(() => undefined);
  const onWinMove = useCallback((e: PointerEvent) => moveRef.current(e), []);
  const onWinUp = useCallback((e: PointerEvent) => upRef.current(e), []);
  const detach = useCallback(() => {
    window.removeEventListener('pointermove', onWinMove);
    window.removeEventListener('pointerup', onWinUp);
    window.removeEventListener('pointercancel', onWinUp);
  }, [onWinMove, onWinUp]);

  const cancelGesture = useCallback((): boolean => {
    const g = gesture.current;
    if (!g) return false;
    if (g.kind === 'trim' && g.started) useEditor.getState().cancelTx();
    detach();
    endGesture();
    return true;
  }, [detach, endGesture]);

  moveRef.current = (e: PointerEvent) => {
    const g = gesture.current;
    if (!g || e.pointerId !== g.pointerId) return;
    if (e.buttons === 0) {
      // The button was released where we got no pointerup (outside the window, over the
      // browser UI…). Finish the gesture here; otherwise the playhead / ghost / trim kept
      // following the bare mouse — the "playhead jumps with the mouse" bug.
      upRef.current(e);
      return;
    }
    const s = useEditor.getState();
    const z = s.zoom;

    if (g.kind === 'scrub') {
      s.setPlayhead(snapToFrame(timeAt(e.clientX), s.project.settings.fps));
      return;
    }

    if (g.kind === 'move') {
      const dx = e.clientX - g.x0;
      const dy = e.clientY - g.y0;
      if (!g.started) {
        if (Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
        g.started = true;
      }
      const raw = g.clip.start + pxToUs(dx, z);
      const sn = snapMove(s.project, s.playhead, g.clip.id, raw, g.clip.duration, z, s.snapping && !e.altKey);
      const row = rowAt(e.clientY);
      const target = resolveMoveTarget(s.project, g.clip, g.fromTrack, row);
      g.start = sn.value;
      g.target = target;
      const rowKey = target.trackId ?? (row && row.type === 'band' ? keyOf(row) : g.fromTrack.id);
      setGhost({
        clipId: g.clip.id,
        type: g.clip.type,
        start: sn.value,
        duration: g.clip.duration,
        rowKey,
        insertAt: moveInsertCut(s.project, target, g.clip, sn.value, s.magnet),
      });
      setGuide(sn.guide);
      return;
    }

    if (g.kind === 'trim') {
      const dx = e.clientX - g.x0;
      if (!g.started) {
        if (Math.abs(dx) < 1) return;
        g.started = true;
        s.beginTx();
      }
      const base = useEditor.getState().txBase ?? s.project;
      const edgeT = (g.edge === 'left' ? g.clip.start : clipEnd(g.clip)) + pxToUs(dx, z);
      const sn = snapPoint(base, s.playhead, edgeT, z, s.snapping && !e.altKey, [g.clip.id]);
      // Re-apply from the gesture's base each time so the result never accumulates.
      useEditor.getState().cancelTx();
      useEditor.getState().beginTx();
      if (g.edge === 'left') useEditor.getState().trimStart(g.clip.id, sn.value);
      else useEditor.getState().trimEnd(g.clip.id, sn.value);
      const now = findClip(useEditor.getState().project, g.clip.id)?.clip;
      setGuide(sn.guide);
      if (now) setTrimTip({ x: usToPx(g.edge === 'left' ? now.start : clipEnd(now), z), text: `${(now.duration / 1e6).toFixed(1)}s` });
      return;
    }

    // marquee
    const sc = scrollerRef.current;
    if (!sc) return;
    const dx = e.clientX - g.x0;
    const dy = e.clientY - g.y0;
    if (!g.started) {
      if (Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
      g.started = true;
    }
    const r = sc.getBoundingClientRect();
    const cx = Math.max(HEADER_W, e.clientX - r.left + sc.scrollLeft);
    const cy = e.clientY - r.top + sc.scrollTop;
    const m = { left: Math.min(g.cx0, cx), top: Math.min(g.cy0, cy), width: Math.abs(cx - g.cx0), height: Math.abs(cy - g.cy0) };
    setMarquee(m);
    const t0 = Math.max(0, pxToUs(m.left - HEADER_W, z));
    const t1 = pxToUs(m.left + m.width - HEADER_W, z);
    const yTop = m.top - sc.scrollTop + r.top;
    const yBot = yTop + m.height;
    const hit: Id[] = [];
    rowsRef.current?.querySelectorAll<HTMLElement>('[data-row-key]').forEach((el) => {
      const key = el.dataset.rowKey ?? '';
      if (key.startsWith('band:')) return;
      const b = el.getBoundingClientRect();
      if (b.bottom <= yTop || b.top >= yBot) return;
      const track = s.project.tracks.find((t) => t.id === key);
      if (!track || track.locked) return;
      for (const c of clipsInSpan(track, t0, t1)) hit.push(c.id);
    });
    s.select(g.additive ? [...new Set([...g.base, ...hit])] : hit);
  };

  upRef.current = (e: PointerEvent) => {
    const g = gesture.current;
    if (!g || e.pointerId !== g.pointerId) return;
    detach();
    const s = useEditor.getState();

    if (g.kind === 'move') {
      if (!g.started) {
        if (g.reselect) s.select([g.clip.id]);
      } else {
        s.beginTx();
        let trackId = g.target.trackId;
        const sel = s.selection.clipIds;
        let ok: boolean;
        if (!g.target.newKind && trackId && sel.length > 1 && sel.includes(g.clip.id)) {
          // CapCut moves the whole selection: same time delta, same row delta
          const rowsNow = timelineRows(s.project);
          const from = rowsNow.findIndex((t) => t.id === g.fromTrack.id);
          const to = rowsNow.findIndex((t) => t.id === trackId);
          ok = useEditor.getState().moveClips(sel, g.start - g.clip.start, from >= 0 && to >= 0 ? to - from : 0);
        } else {
          if (g.target.newKind) trackId = useEditor.getState().addTrack(g.target.newKind);
          ok = useEditor.getState().moveClip(g.clip.id, { start: g.start, trackId });
        }
        if (ok) useEditor.getState().commitTx();
        else useEditor.getState().cancelTx();
      }
    } else if (g.kind === 'trim') {
      if (g.started) s.commitTx();
    } else if (g.kind === 'marquee') {
      if (!g.started) {
        // plain click on empty track space: move the playhead there, clear the selection
        s.pause();
        s.setPlayhead(snapToFrame(timeAt(e.clientX), s.project.settings.fps));
        if (!g.additive) s.clearSelection();
      }
    }
    endGesture();
  };

  const beginGesture = useCallback(
    (g: Gesture) => {
      gesture.current = g;
      // a gesture hides the hover lines; the player shows what the gesture does, not a stale hover frame
      useTimelineUi.getState().setHoverTime(null);
      setSplitHover(null);
      window.addEventListener('pointermove', onWinMove);
      window.addEventListener('pointerup', onWinUp);
      window.addEventListener('pointercancel', onWinUp);
    },
    [onWinMove, onWinUp],
  );

  useEffect(() => detach, [detach]);

  useTimelineShortcuts(cancelGesture);

  const onClipPointerDown = useCallback(
    (e: RPointerEvent, clip: Clip, part: ClipPart) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const s = useEditor.getState();
      const f = findClip(s.project, clip.id);
      if (!f || f.track.locked || gesture.current) return;

      if (useTimelineUi.getState().tool === 'split' && part === 'body') {
        s.splitClip(clip.id, snapToFrame(timeAt(e.clientX), s.project.settings.fps));
        return;
      }

      const additive = e.shiftKey || e.metaKey || e.ctrlKey;
      const isSel = s.selection.clipIds.includes(clip.id);
      if (part !== 'body') {
        if (!isSel) s.select([clip.id]);
        beginGesture({ kind: 'trim', pointerId: e.pointerId, clip: f.clip, edge: part, x0: e.clientX, started: false });
        return;
      }
      if (additive) {
        s.select([clip.id], 'toggle');
        return;
      }
      if (!isSel) s.select([clip.id]);
      beginGesture({
        kind: 'move',
        pointerId: e.pointerId,
        clip: f.clip,
        fromTrack: f.track,
        x0: e.clientX,
        y0: e.clientY,
        started: false,
        reselect: isSel && s.selection.clipIds.length > 1,
        start: f.clip.start,
        target: { trackId: f.track.id },
      });
    },
    [beginGesture, timeAt],
  );

  const onLanePointerDown = useCallback(
    (e: RPointerEvent) => {
      if (e.button !== 0 || gesture.current) return;
      const sc = scrollerRef.current;
      if (!sc) return;
      const r = sc.getBoundingClientRect();
      if (e.clientX - r.left < HEADER_W) return; // the sticky header column
      if ((e.target as HTMLElement).closest('button')) return;
      beginGesture({
        kind: 'marquee',
        pointerId: e.pointerId,
        cx0: e.clientX - r.left + sc.scrollLeft,
        cy0: e.clientY - r.top + sc.scrollTop,
        x0: e.clientX,
        y0: e.clientY,
        additive: e.shiftKey || e.metaKey || e.ctrlKey,
        started: false,
        base: [...useEditor.getState().selection.clipIds],
      });
    },
    [beginGesture],
  );

  const onScrubStart = useCallback(
    (e: RPointerEvent) => {
      if (e.button !== 0 || gesture.current) return;
      e.stopPropagation();
      e.preventDefault();
      const s = useEditor.getState();
      s.pause();
      s.setPlayhead(snapToFrame(timeAt(e.clientX), s.project.settings.fps));
      beginGesture({ kind: 'scrub', pointerId: e.pointerId });
    },
    [beginGesture, timeAt],
  );

  const onMarkerClick = useCallback((m: Marker) => {
    const s = useEditor.getState();
    s.pause();
    s.setPlayhead(m.time);
  }, []);
  const onMarkerRemove = useCallback((m: Marker) => useEditor.getState().removeMarker(m.id), []);

  // Preview axis (the amber hover line, CapCut) and the split-mode blade line. Hovering never
  // touches the playhead: it only sets hoverTime, and the player shows that frame while paused.
  const hoverAt = useCallback(
    (clientX: number, clientY: number, target: Element | null) => {
      if (gesture.current) return;
      const ui = useTimelineUi.getState();
      const sc = scrollerRef.current;
      const r = sc?.getBoundingClientRect();
      const inside = !!r && clientY >= r.top && clientY < r.top + (sc?.clientHeight ?? 0) && clientX < r.left + (sc?.clientWidth ?? 0);
      const inLane = inside && laneX(clientX) >= 0;
      const fps = useEditor.getState().project.settings.fps;
      const t = snapToFrame(timeAt(clientX), fps);
      ui.setHoverTime(ui.previewAxis && inLane ? t : null);
      const overClip = !!target?.closest('[data-clip-id]');
      const blade = ui.tool === 'split' && overClip && inLane ? t : null;
      setSplitHover((h) => (h === blade ? h : blade));
    },
    [laneX, timeAt],
  );
  const onHover = useCallback(
    (e: RPointerEvent) => {
      pointer.current = { x: e.clientX, y: e.clientY };
      hoverAt(e.clientX, e.clientY, e.target as Element);
    },
    [hoverAt],
  );
  refreshHoverRef.current = () => {
    const p = pointer.current;
    if (p) hoverAt(p.x, p.y, document.elementFromPoint(p.x, p.y));
  };
  const onHoverLeave = useCallback(() => {
    pointer.current = null;
    useTimelineUi.getState().setHoverTime(null);
    setSplitHover(null);
  }, []);
  useEffect(() => {
    if (tool !== 'split') setSplitHover(null);
  }, [tool]);

  // ---------------------------------------------------------------- library / OS drops

  const onDragOver = useCallback(
    (e: DragEvent) => {
      const types = Array.from(e.dataTransfer.types);
      if (!acceptsDrag(types)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      const row = rowAt(e.clientY);
      const s = useEditor.getState();
      const at = snapPoint(s.project, s.playhead, timeAt(e.clientX), s.zoom, s.snapping && !e.altKey).value;
      const rowKey = row ? keyOf(row) : null;
      setDropHint((h) => (h && h.at === at && h.rowKey === rowKey ? h : { at, rowKey }));
    },
    [rowAt, timeAt],
  );

  const onDragLeave = useCallback((e: DragEvent) => {
    const next = e.relatedTarget as Node | null;
    if (!next || !(e.currentTarget as HTMLElement).contains(next)) setDropHint(null);
  }, []);

  const onDrop = useCallback(
    (e: DragEvent) => {
      const types = Array.from(e.dataTransfer.types);
      if (!acceptsDrag(types)) return;
      e.preventDefault();
      setDropHint(null);
      const s = useEditor.getState();
      const row = rowAt(e.clientY);
      const at = snapPoint(s.project, s.playhead, timeAt(e.clientX), s.zoom, s.snapping && !e.altKey).value;

      if (isFileDrag(types)) {
        const files = Array.from(e.dataTransfer.files);
        if (!files.length) return;
        void importDroppedFiles(files).then((assetIds) => {
          let t = at;
          for (const id of assetIds) {
            const st = useEditor.getState();
            const a = st.project.assets[id];
            if (!a) continue;
            const nid = st.addClip(id, assetDropOptions(st.project, a.kind, row, t));
            const c = nid ? findClip(useEditor.getState().project, nid)?.clip : undefined;
            if (c) t = clipEnd(c);
          }
        });
        return;
      }

      const payload = readPayload((t) => e.dataTransfer.getData(t));
      if (!payload) return;
      if (payload.kind === 'asset') {
        const a = s.project.assets[payload.assetId];
        if (a) s.addClip(a.id, assetDropOptions(s.project, a.kind, row, at));
      } else if (payload.kind === 'text') {
        // a styled preset from the Text tab lands styled, in one undo step
        const preset = payload.preset ? textPreset(payload.preset) : undefined;
        addTextPreset(preset ?? TEXT_PRESETS[0]!, { at, trackId: textDropTrack(s.project, row) });
      } else {
        const threshold = Math.max(pxToUs(40, s.zoom), 1);
        const rowTrack = row?.type === 'track' ? s.project.tracks.find((t) => t.id === row.trackId) : undefined;
        const candidates = [rowTrack, ...s.project.tracks.filter((t) => t.kind === 'main')].filter(
          (t): t is Track => !!t && t.kind !== 'audio' && !t.locked,
        );
        for (const t of candidates) {
          const cut = nearestCut(t, at, t === rowTrack ? threshold : threshold / 2);
          if (cut) {
            s.addTransition(cut.fromClipId, payload.type);
            return;
          }
        }
      }
    },
    [rowAt, timeAt],
  );

  // ---------------------------------------------------------------- render

  // 1px short of the visible height: rounding at fractional zoom must never overflow by a sub-pixel
  const minRowsH = Math.max(0, view.height - RULER_H - 1);
  // The main track stays where it is while tracks come and go (see bandHeights).
  const mainIdx = rows.findIndex((t) => t.kind === 'main');
  const aboveH = rows.slice(0, Math.max(0, mainIdx)).reduce((h, t) => h + rowHeight(t), 0);
  const belowH = rows.slice(mainIdx + 1).reduce((h, t) => h + rowHeight(t), 0);
  const mainRowH = mainIdx >= 0 ? rowHeight(rows[mainIdx]!) : 0;
  const { top: topBandH, bottom: bottomBandH } = bandHeights(minRowsH, aboveH, mainRowH, belowH, BAND_MIN_H);
  const visFrom = pxToUs(viewFrom - 200, zoom);
  const visTo = pxToUs(viewTo + 200, zoom);
  const dropRowKey = dropHint?.rowKey ?? null;

  const renderGhost = (rowKey: string, h: number) =>
    ghost && ghost.rowKey === rowKey ? (
      <div
        className={`tl-ghost tl-ghost--${ghost.type}`}
        style={{ left: usToPx(ghost.start, zoom), width: Math.max(2, usToPx(ghost.duration, zoom)), height: h - 8 }}
      />
    ) : null;

  return (
    <div className={`tl${tool === 'split' ? ' tl--split' : ''}`} data-drop-zone="timeline" onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <Toolbar />
      <div className="tl-scroller" ref={scrollerRef} onPointerMove={onHover} onPointerLeave={onHoverLeave}>
        <div className="tl-content" style={{ width: HEADER_W + contentW }}>
          <div className="tl-ruler-row" style={{ height: RULER_H }}>
            <div className="tl-corner" style={{ width: HEADER_W }}>
              <span className="tl-corner__tc" title="Playhead">
                {formatTimecode(playhead, fps)}
              </span>
            </div>
            <Ruler
              zoom={zoom}
              fps={fps}
              width={contentW}
              viewFrom={viewFrom}
              viewTo={viewTo}
              markers={project.markers}
              area={area}
              areaEnd={projectDuration(project)}
              onScrubStart={onScrubStart}
              onMarkerClick={onMarkerClick}
              onMarkerRemove={onMarkerRemove}
            />
            <div
              className="tl-playhead-head"
              style={{ left: HEADER_W + usToPx(playhead, zoom) }}
              onPointerDown={onScrubStart}
              data-testid="playhead"
              title={formatTimecode(playhead, fps)}
            />
            {hoverTime !== null && !ghost && (
              <div className="tl-hover tl-hover--ruler" style={{ left: HEADER_W + usToPx(hoverTime, zoom) }} data-testid="timeline-hover-head">
                <span className="tl-hover__label">{formatShort(hoverTime)}</span>
              </div>
            )}
          </div>

          <div
            className="tl-rows"
            ref={rowsRef}
            style={{ minHeight: minRowsH }}
            onPointerDown={onLanePointerDown}
          >
            <div className={`tl-band${dropRowKey === 'band:top' ? ' is-drop' : ''}`} data-row-key="band:top" style={{ height: topBandH }}>
              <div className="tl-band__header" style={{ width: HEADER_W }} />
              <div className="tl-lane" style={{ width: contentW }}>
                {renderGhost('band:top', TRACK_H)}
              </div>
            </div>

            {rows.map((track, i) => {
              const h = rowHeight(track);
              return (
                <div
                  key={track.id}
                  className={`tl-row tl-row--${track.kind}${track.locked ? ' is-locked' : ''}${track.hidden ? ' is-hidden' : ''}${dropRowKey === track.id ? ' is-drop' : ''}`}
                  style={{ height: h }}
                  data-row-key={track.id}
                  data-testid="timeline-track"
                  data-track-index={i}
                  data-track-id={track.id}
                  data-track-kind={track.kind === 'main' || track.kind === 'overlay' ? 'video' : track.kind}
                  data-track-role={track.kind}
                >
                  <TrackHeader track={track} />
                  <div className="tl-lane" style={{ width: contentW }}>
                    {track.kind === 'main' && track.clips.length === 0 && (
                      <div className="tl-lane__hint" style={{ left: viewFrom + 12 }}>
                        Drag media here to start editing
                      </div>
                    )}
                    {track.clips.map((c) =>
                      c.start <= visTo && clipEnd(c) >= visFrom ? (
                        <ClipView
                          key={c.id}
                          clip={c}
                          asset={c.type === 'text' ? undefined : project.assets[c.assetId]}
                          zoom={zoom}
                          height={h}
                          selected={selectedSet.has(c.id)}
                          locked={track.locked}
                          ghosted={ghost?.clipId === c.id}
                          viewFrom={viewFrom}
                          viewTo={viewTo}
                          onPointerDown={onClipPointerDown}
                        />
                      ) : null,
                    )}
                    {track.transitions.map((tr) => {
                      const from = track.clips.find((c) => c.id === tr.fromClipId);
                      if (!from) return null;
                      const w = Math.max(14, usToPx(tr.duration, zoom));
                      return (
                        <button
                          type="button"
                          key={tr.id}
                          className={`tl-transition${selection.transitionId === tr.id ? ' is-selected' : ''}`}
                          style={{ left: usToPx(clipEnd(from), zoom) - w / 2, width: w }}
                          title={`Transition: ${tr.type} (${(tr.duration / 1e6).toFixed(1)}s)`}
                          aria-label="Transition"
                          data-testid="timeline-transition"
                          data-transition-id={tr.id}
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            if (!track.locked) useEditor.getState().selectTransition(tr.id);
                          }}
                          onMouseDown={(e) => e.preventDefault()}
                        >
                          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                            <path d="M1 1l8 8V1L1 9z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                          </svg>
                        </button>
                      );
                    })}
                    {renderGhost(track.id, h)}
                  </div>
                </div>
              );
            })}

            <div className={`tl-band${dropRowKey === 'band:bottom' ? ' is-drop' : ''}`} data-row-key="band:bottom" style={{ height: bottomBandH }}>
              <div className="tl-band__header" style={{ width: HEADER_W }} />
              <div className="tl-lane" style={{ width: contentW }}>
                {renderGhost('band:bottom', TRACK_H)}
              </div>
            </div>

            {/* overlay lines: lane coordinates + header offset */}
            <div className="tl-playhead" style={{ left: HEADER_W + usToPx(playhead, zoom) }} />
            {guide !== null && <div className="tl-guide" style={{ left: HEADER_W + usToPx(guide, zoom) }} />}
            {ghost?.insertAt != null && <div className="tl-insert" style={{ left: HEADER_W + usToPx(ghost.insertAt, zoom) }} />}
            {dropHint && <div className="tl-guide tl-guide--drop" style={{ left: HEADER_W + usToPx(dropHint.at, zoom) }} />}
            {hoverTime !== null && !ghost && (
              <div className="tl-hover" style={{ left: HEADER_W + usToPx(hoverTime, zoom) }} data-testid="timeline-hover" />
            )}
            {splitHover !== null && <div className="tl-blade" data-testid="timeline-blade" style={{ left: HEADER_W + usToPx(splitHover, zoom) }} />}
            {trimTip && (
              <div className="tl-trimtip" style={{ left: HEADER_W + trimTip.x }}>
                {trimTip.text}
              </div>
            )}
            {marquee && <div className="tl-marquee" style={{ left: marquee.left, top: marquee.top - RULER_H, width: marquee.width, height: marquee.height }} />}
          </div>
        </div>
      </div>
    </div>
  );
}
