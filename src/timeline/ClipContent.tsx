/**
 * What is drawn inside a clip: video filmstrip, image strip, audio waveform.
 * All three only render the part of the clip that is inside the visible window
 * (`fromPx`..`toPx`, clip-local pixels), so long clips at high zoom stay cheap.
 */
import { memo, useEffect, useRef, useState } from 'react';
import { dbToGain } from '../model/project';
import type { AudioClip, ImageClip, MediaAsset, VideoClip } from '../model/types';
import { getThumb, peekThumb } from './media/thumbnails';
import { getPeaks, peaksReady } from './media/waveform';
import { normGain, peakAt, quantizeTime, thumbStep, tileRange, type Peaks } from './media/peaks';
import { useAssetUrl } from './media/useAssetUrl';

interface ViewWindow {
  /** Clip width in px. */
  width: number;
  height: number;
  zoom: number;
  fromPx: number;
  toPx: number;
}

// ---------------------------------------------------------------- video filmstrip

function Tile({ assetId, url, time, height, left, width }: { assetId: string; url: string; time: number; height: number; left: number; width: number }) {
  const [src, setSrc] = useState<string | undefined>(() => peekThumb(assetId, time, height));
  useEffect(() => {
    let alive = true;
    const hit = peekThumb(assetId, time, height);
    if (hit) {
      setSrc(hit);
      return;
    }
    void getThumb(assetId, url, time, height).then((u) => {
      if (alive && u) setSrc(u);
    });
    return () => {
      alive = false;
    };
  }, [assetId, url, time, height]);
  return (
    <div
      className="tl-film__tile"
      style={{ left, width, backgroundImage: src ? `url("${src}")` : undefined }}
    />
  );
}

export const Filmstrip = memo(function Filmstrip({ clip, asset, width, height, zoom, fromPx, toPx }: ViewWindow & { clip: VideoClip; asset: MediaAsset }) {
  const url = useAssetUrl(asset.id);
  if (!url || asset.missing) return null;
  const ratio = asset.width && asset.height ? asset.width / asset.height : 16 / 9;
  const tileW = Math.max(16, Math.round(height * ratio));
  const [first, last] = tileRange(fromPx - tileW, toPx + tileW, tileW, width);
  const tileSec = (tileW / zoom) * clip.speed;
  const step = thumbStep(tileSec);
  const dur = asset.duration / 1e6;
  const tiles = [];
  for (let i = first; i <= last; i++) {
    const src = clip.inPoint / 1e6 + ((i * tileW) / zoom) * clip.speed;
    const t = quantizeTime(src, step, dur);
    tiles.push(<Tile key={i} assetId={asset.id} url={url} time={t} height={height} left={i * tileW} width={tileW} />);
  }
  return <div className="tl-film">{tiles}</div>;
});

// ---------------------------------------------------------------- image strip

export function ImageStrip({ asset }: { clip: ImageClip; asset: MediaAsset }) {
  const url = useAssetUrl(asset.id);
  if (!url || asset.missing) return null;
  return <div className="tl-film tl-film--image" style={{ backgroundImage: `url("${url}")` }} />;
}

// ---------------------------------------------------------------- waveform

function usePeaks(assetId: string, url: string | undefined): Peaks | null {
  const [peaks, setPeaks] = useState<Peaks | null>(() => peaksReady(assetId) ?? null);
  useEffect(() => {
    if (!url) return;
    let alive = true;
    void getPeaks(assetId, url).then((p) => {
      if (alive) setPeaks(p);
    });
    return () => {
      alive = false;
    };
  }, [assetId, url]);
  return peaks;
}

const MAX_CANVAS_W = 4096;

export const Waveform = memo(function Waveform({ clip, asset, width, height, zoom, fromPx, toPx }: ViewWindow & { clip: AudioClip | VideoClip; asset: MediaAsset }) {
  const url = useAssetUrl(asset.id);
  const peaks = usePeaks(asset.id, asset.missing ? undefined : url);
  const ref = useRef<HTMLCanvasElement>(null);
  const a = Math.max(0, Math.floor(fromPx));
  const b = Math.min(width, Math.ceil(toPx), a + MAX_CANVAS_W);
  const w = Math.max(0, b - a);
  const gain = clip.audio.muted ? 0 : Math.min(2, dbToGain(clip.audio.volumeDb));

  useEffect(() => {
    const cv = ref.current;
    if (!cv || !peaks || w <= 0) return;
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(height * dpr);
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, height);
    ctx.fillStyle = getComputedStyle(cv).color || '#6ea0ff';
    const norm = normGain(peaks) * gain;
    const in0 = clip.inPoint / 1e6;
    const secPerPx = clip.speed / zoom;
    for (let x = 0; x < w; x++) {
      const t0 = in0 + (a + x) * secPerPx;
      const v = Math.min(1, peakAt(peaks, t0, t0 + secPerPx) * norm);
      const h = Math.max(v > 0 ? 1 : 0, v * (height - 2));
      ctx.fillRect(x, height - h, 1, h);
    }
  }, [peaks, w, a, height, zoom, clip.inPoint, clip.speed, gain]);

  if (!url || asset.missing || w <= 0) return null;
  return <canvas ref={ref} className="tl-wave" style={{ left: a, width: w, height }} aria-hidden />;
});
