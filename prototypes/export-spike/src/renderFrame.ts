// Stand-in for the editor's compositor: renderFrame(ctx, project, t, frameSource).
// Pure function of t (integer microseconds). DOM-free, so it works on OffscreenCanvas / in a Worker.

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export type Us = number;

export function renderFrame(ctx: Ctx2D, t: Us, frameIndex: number): void {
  const { width: W, height: H } = ctx.canvas;
  const s = t / 1e6;

  // background gradient that shifts hue over time
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, `hsl(${(s * 60) % 360} 60% 25%)`);
  g.addColorStop(1, `hsl(${(s * 60 + 120) % 360} 60% 10%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // moving circle (left -> right)
  ctx.fillStyle = '#ff5a5f';
  ctx.beginPath();
  ctx.arc(100 + (W - 200) * (s / 3), H * 0.3, 90, 0, Math.PI * 2);
  ctx.fill();

  // rotating square
  ctx.save();
  ctx.translate(W / 2, H * 0.55);
  ctx.rotate(s * Math.PI);
  ctx.fillStyle = '#3ddc97';
  ctx.fillRect(-150, -150, 300, 300);
  ctx.restore();

  // drawn text (stand-in for a text clip)
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 110px system-ui, sans-serif';
  ctx.fillText('Our Editor', W / 2, H * 0.78);

  // frame counter
  ctx.font = 'bold 72px ui-monospace, monospace';
  ctx.fillText(`frame ${String(frameIndex).padStart(3, '0')}  t=${s.toFixed(3)}s`, W / 2, H * 0.9);
}
