/**
 * Centre player. PLACEHOLDER from the skeleton; Builder C replaces the internals with the real
 * engine (canvas renderer driven by getFrameState, media element pool, Web Audio, clock).
 * Final interface: no props, reads/writes the store.
 */
import { useEffect, useRef, useState } from 'react';
import { ASPECTS } from '../model/catalog';
import { formatTimecode, projectDuration } from '../model/time';
import { useEditor } from '../store';
import { Icon } from '../ui/Icon';

export function Player() {
  const settings = useEditor((s) => s.project.settings);
  const duration = useEditor((s) => projectDuration(s.project));
  const playhead = useEditor((s) => s.playhead);
  const playing = useEditor((s) => s.playing);
  const togglePlay = useEditor((s) => s.togglePlay);
  const setAspectRatio = useEditor((s) => s.setAspectRatio);
  const [ratioOpen, setRatioOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Placeholder clock: advances the playhead in real time. Builder C replaces with the engine clock.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const s = useEditor.getState();
      const next = s.playhead + (now - last) * 1000;
      last = now;
      if (next >= projectDuration(s.project)) {
        s.setPlayhead(projectDuration(s.project));
        s.pause();
        return;
      }
      s.setPlayhead(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const k = Math.min((box.w - 24) / settings.width, (box.h - 24) / settings.height);
  const cw = Math.max(0, settings.width * k);
  const ch = Math.max(0, settings.height * k);

  return (
    <>
      <div className="panel__header">Player</div>
      <div ref={boxRef} style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: cw, height: ch, background: settings.background }} data-testid="player-canvas" />
      </div>
      <div style={{ height: 40, display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', padding: '0 12px', flex: 'none' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)' }}>
          <span style={{ color: 'var(--accent)' }}>{formatTimecode(playhead, settings.fps)}</span>
          <span style={{ color: 'var(--text-dim)' }}> / {formatTimecode(duration, settings.fps)}</span>
        </span>
        <button className="icon-btn" title="Play (Space)" onClick={togglePlay}>
          <Icon name={playing ? 'pause' : 'play'} />
        </button>
        <div style={{ justifySelf: 'end', position: 'relative' }}>
          <button className="btn btn--ghost" onClick={() => setRatioOpen(!ratioOpen)}>
            Ratio {settings.aspect}
          </button>
          {ratioOpen && (
            <div className="menu" style={{ bottom: 32, right: 0 }}>
              {ASPECTS.map((a) => (
                <button
                  key={a.id}
                  className={`menu__item${a.id === settings.aspect ? ' is-active' : ''}`}
                  onClick={() => {
                    setAspectRatio(a.id);
                    setRatioOpen(false);
                  }}
                >
                  {a.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
