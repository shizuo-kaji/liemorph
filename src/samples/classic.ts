/**
 * The original 2012 Maple data sets (p := [shape1, shape2, ...]; T := [...])
 * from the SCA 2012 experiments, converted to JSON (0-based triangles,
 * Maple's y-up coordinates).
 */
import data from './classic.json';

export interface ClassicData {
  key: string;
  label: string;
  source: string;
  frames: [number, number][][];
  tris: [number, number, number][];
}

export const classics = data as ClassicData[];

/**
 * Fit frames into an image-sized world (y flipped) and paint a cheerful
 * texture so the deformation is visible.
 */
export function prepareClassic(d: { frames: [number, number][][]; tris: number[][] }, size = 900) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const f of d.frames) for (const [x, y] of f) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    y0 = Math.min(y0, -y); y1 = Math.max(y1, -y);
  }
  const span = Math.max(x1 - x0, y1 - y0) || 1;
  const s = (size * 0.8) / span;
  const ox = (size - (x1 - x0) * s) / 2 - x0 * s;
  const oy = (size - (y1 - y0) * s) / 2 - y0 * s;
  const frames = d.frames.map((f) => {
    const a = new Float64Array(2 * f.length);
    f.forEach(([x, y], i) => {
      a[2 * i] = x * s + ox;
      a[2 * i + 1] = -y * s + oy;
    });
    return a;
  });
  const tris = Uint32Array.from(d.tris.flat());
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  // texture: soft diagonal gradient + grid + polka dots, drawn only on the rest shape's bbox region
  const g = ctx.createLinearGradient(0, 0, size, size);
  g.addColorStop(0, '#ff8fab');
  g.addColorStop(0.5, '#ffd166');
  g.addColorStop(1, '#5ad1b3');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 3;
  const step = size / 24;
  ctx.beginPath();
  for (let k = 0; k <= 24; k++) {
    ctx.moveTo(k * step, 0); ctx.lineTo(k * step, size);
    ctx.moveTo(0, k * step); ctx.lineTo(size, k * step);
  }
  ctx.stroke();
  ctx.fillStyle = 'rgba(60,30,90,0.18)';
  for (let yy = step / 2; yy < size; yy += step * 2)
    for (let xx = step / 2; xx < size; xx += step * 2) {
      ctx.beginPath();
      ctx.arc(xx, yy, step * 0.22, 0, Math.PI * 2);
      ctx.fill();
    }
  return { frames, tris, canvas };
}
