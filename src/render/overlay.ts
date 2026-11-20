/** 2D-canvas overlay: outlines, wireframes, handles, brush cursors (screen-constant line widths). */
import type { View } from './gl.ts';
import type { Pt } from '../geom/mesh.ts';

export const C = {
  accent: '#ff5d8f',
  accent2: '#2ec4a6',
  blue: '#4f7dff',
  amber: '#ffb020',
  ink: '#1d1b2c',
  white: '#ffffff',
};

export class Overlay {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  view: View = { zoom: 1, panX: 0, panY: 0 };
  dpr = 1;
  w = 1;
  h = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
  }

  resize(w: number, h: number, dpr: number) {
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    const W = Math.round(w * dpr), H = Math.round(h * dpr);
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
  }

  begin(view: View) {
    this.view = view;
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.world();
  }

  /** world-space transform */
  world() {
    const { zoom, panX, panY } = this.view, d = this.dpr;
    this.ctx.setTransform(d * zoom, 0, 0, d * zoom, d * panX, d * panY);
  }
  /** screen-space (CSS px) transform */
  screen() {
    const d = this.dpr;
    this.ctx.setTransform(d, 0, 0, d, 0, 0);
  }
  /** CSS px → world length */
  px(v: number) {
    return v / this.view.zoom;
  }
  toScreen(x: number, y: number): [number, number] {
    return [x * this.view.zoom + this.view.panX, y * this.view.zoom + this.view.panY];
  }

  loopsPath(loops: Pt[][]) {
    const ctx = this.ctx;
    ctx.beginPath();
    for (const l of loops) {
      if (!l.length) continue;
      ctx.moveTo(l[0][0], l[0][1]);
      for (let i = 1; i < l.length; i++) ctx.lineTo(l[i][0], l[i][1]);
      ctx.closePath();
    }
  }

  indexLoopsPath(P: ArrayLike<number>, loops: number[][]) {
    const ctx = this.ctx;
    ctx.beginPath();
    for (const l of loops) {
      if (!l.length) continue;
      ctx.moveTo(P[2 * l[0]], P[2 * l[0] + 1]);
      for (let i = 1; i < l.length; i++) ctx.lineTo(P[2 * l[i]], P[2 * l[i] + 1]);
      ctx.closePath();
    }
  }

  /** Darken everything outside the loops. */
  dimOutside(loops: Pt[][], imgW: number, imgH: number, alpha = 0.55) {
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    const pad = Math.max(imgW, imgH) * 4;
    ctx.rect(-pad, -pad, imgW + 2 * pad, imgH + 2 * pad);
    for (const l of loops) {
      if (!l.length) continue;
      ctx.moveTo(l[0][0], l[0][1]);
      for (let i = 1; i < l.length; i++) ctx.lineTo(l[i][0], l[i][1]);
      ctx.closePath();
    }
    ctx.fillStyle = `rgba(20, 16, 40, ${alpha})`;
    ctx.fill('evenodd');
    ctx.restore();
  }

  strokeLoops(loops: Pt[][], color: string, width = 2.5, halo = true, dash?: number[]) {
    const ctx = this.ctx;
    this.loopsPath(loops);
    ctx.lineJoin = 'round';
    if (halo) {
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = this.px(width + 3);
      ctx.setLineDash([]);
      ctx.stroke();
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = this.px(width);
    ctx.setLineDash(dash ? dash.map((d) => this.px(d)) : []);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  points(pts: Pt[], color: string, r = 4.5, highlight = -1, selected?: Set<number>) {
    const ctx = this.ctx;
    for (let i = 0; i < pts.length; i++) {
      const [x, y] = pts[i];
      const big = i === highlight || selected?.has(i);
      ctx.beginPath();
      ctx.arc(x, y, this.px(big ? r * 1.6 : r), 0, Math.PI * 2);
      ctx.fillStyle = big ? C.accent : color;
      ctx.fill();
      ctx.lineWidth = this.px(1.5);
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    }
  }

  wireframe(P: ArrayLike<number>, T: ArrayLike<number>, color = 'rgba(255,255,255,0.75)', width = 1) {
    const ctx = this.ctx;
    ctx.beginPath();
    for (let k = 0; k < T.length; k += 3) {
      const a = T[k], b = T[k + 1], c = T[k + 2];
      ctx.moveTo(P[2 * a], P[2 * a + 1]);
      ctx.lineTo(P[2 * b], P[2 * b + 1]);
      ctx.lineTo(P[2 * c], P[2 * c + 1]);
      ctx.closePath();
    }
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(30,20,60,0.35)';
    ctx.lineWidth = this.px(width + 1.2);
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = this.px(width);
    ctx.stroke();
  }

  vertices(P: ArrayLike<number>, boundary: Uint8Array | null, r = 2.6, highlight = -1) {
    const ctx = this.ctx;
    const n = P.length >> 1;
    for (const pass of [0, 1]) {
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const onB = boundary ? boundary[i] === 1 : false;
        if ((pass === 1) !== onB) continue;
        ctx.moveTo(P[2 * i] + this.px(r), P[2 * i + 1]);
        ctx.arc(P[2 * i], P[2 * i + 1], this.px(r), 0, Math.PI * 2);
      }
      ctx.fillStyle = pass ? C.accent : C.blue;
      ctx.fill();
    }
    if (highlight >= 0) {
      ctx.beginPath();
      ctx.arc(P[2 * highlight], P[2 * highlight + 1], this.px(r * 2.6), 0, Math.PI * 2);
      ctx.lineWidth = this.px(2.5);
      ctx.strokeStyle = C.amber;
      ctx.stroke();
    }
  }

  pin(x: number, y: number, kind: 'pin' | 'grab' | 'hover', label?: string) {
    const ctx = this.ctx;
    const r = kind === 'grab' ? 13 : 9;
    ctx.save();
    ctx.shadowColor = 'rgba(30,10,60,0.35)';
    ctx.shadowBlur = 8 * this.dpr;
    ctx.shadowOffsetY = 2 * this.dpr;
    ctx.beginPath();
    ctx.arc(x, y, this.px(r), 0, Math.PI * 2);
    if (kind === 'grab') {
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.lineWidth = this.px(3);
      ctx.strokeStyle = C.accent2;
      ctx.stroke();
    } else {
      ctx.fillStyle = kind === 'hover' ? C.amber : C.accent;
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.lineWidth = this.px(2.5);
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, this.px(2.6), 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
    }
    ctx.restore();
    if (label) {
      ctx.font = `${this.px(11)}px ui-rounded, system-ui, sans-serif`;
      ctx.fillStyle = '#fff';
      ctx.fillText(label, x + this.px(12), y - this.px(10));
    }
  }

  circle(x: number, y: number, rWorld: number, color: string, width = 1.5, fill?: string) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(x, y, rWorld, 0, Math.PI * 2);
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    ctx.lineWidth = this.px(width + 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.stroke();
    ctx.lineWidth = this.px(width);
    ctx.strokeStyle = color;
    ctx.stroke();
  }

  polyline(pts: Pt[], color: string, width = 2, closed = false, dash?: number[]) {
    if (pts.length < 2) return;
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    if (closed) ctx.closePath();
    ctx.lineWidth = this.px(width + 2.5);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.setLineDash([]);
    ctx.stroke();
    ctx.lineWidth = this.px(width);
    ctx.strokeStyle = color;
    if (dash) ctx.setLineDash(dash.map((d) => this.px(d)));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /** draw a binary mask as a tinted image (cached canvas supplied by caller) */
  image(img: CanvasImageSource, x: number, y: number, w: number, h: number, alpha = 1) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, x, y, w, h);
    ctx.restore();
  }
}

/** Sequential (viridis-like) and diverging colour maps → rgba 0..1 */
const VIRIDIS = [
  [0.267, 0.005, 0.329], [0.283, 0.141, 0.458], [0.254, 0.265, 0.53], [0.207, 0.372, 0.553], [0.164, 0.471, 0.558],
  [0.128, 0.567, 0.551], [0.135, 0.659, 0.518], [0.267, 0.749, 0.441], [0.478, 0.821, 0.318], [0.741, 0.873, 0.15], [0.993, 0.906, 0.144],
];
export function viridis(t: number, out: Float32Array, o: number, a = 1) {
  t = Math.max(0, Math.min(1, t)) * (VIRIDIS.length - 1);
  const i = Math.min(VIRIDIS.length - 2, Math.floor(t)), f = t - i;
  for (let k = 0; k < 3; k++) out[o + k] = VIRIDIS[i][k] * (1 - f) + VIRIDIS[i + 1][k] * f;
  out[o + 3] = a;
}
export function diverging(t: number, out: Float32Array, o: number, a = 1) {
  // t in [-1, 1]: blue – white – red
  t = Math.max(-1, Math.min(1, t));
  const blue = [0.23, 0.36, 0.95], red = [0.95, 0.25, 0.42], white = [0.97, 0.97, 0.97];
  const c = t < 0 ? blue : red, f = Math.abs(t);
  for (let k = 0; k < 3; k++) out[o + k] = white[k] * (1 - f) + c[k] * f;
  out[o + 3] = a;
}
