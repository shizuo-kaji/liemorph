/**
 * Automatic foreground extraction and contour tracing.
 *
 *  1. feature map: alpha channel, or CIELAB distance to background colours
 *     (k-means over the image border)
 *  2. threshold (Otsu by default) → binary mask
 *  3. background flood-fill from the border (fills holes), morphology via
 *     exact Euclidean distance transforms, connected-component filtering
 *  4. Gaussian-smoothed mask → marching squares at 0.5 → Douglas–Peucker
 *
 * Pure functions on plain arrays (no DOM), so they run in tests and workers.
 */
import type { Pt } from './mesh.ts';
import { polygonArea } from './mesh.ts';
import { edt } from './raster.ts';

export { edt };

export interface ImageLike {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

export type DetectMode = 'auto' | 'alpha' | 'background';

export interface DetectOptions {
  mode: DetectMode;
  /** null → automatic (Otsu).  ΔE (CIELAB) for background mode, 0–255 for alpha. */
  threshold: number | null;
  /** pre-blur radius (mask pixels) */
  blur: number;
  /** morphological closing radius (bridges gaps) */
  close: number;
  /** morphological opening radius (removes specks / thin hairs) */
  open: number;
  /** grow the mask by this many pixels so the mesh covers soft edges */
  margin: number;
  fillHoles: boolean;
  keepLargest: boolean;
  /** drop components smaller than this fraction of the image */
  minArea: number;
  /** Gaussian σ (mask pixels) applied before tracing */
  smooth: number;
  /** Douglas–Peucker tolerance (mask pixels) */
  simplify: number;
}

export const defaultDetectOptions: DetectOptions = {
  mode: 'auto',
  threshold: null,
  blur: 1,
  close: 2,
  open: 1,
  margin: 1.5,
  fillHoles: true,
  keepLargest: true,
  minArea: 0.002,
  smooth: 1.2,
  simplify: 0.8,
};

export interface Mask {
  w: number;
  h: number;
  /** 1 = foreground */
  data: Uint8Array;
  /** image pixels per mask pixel */
  scale: number;
}

export interface DetectResult {
  mask: Mask;
  mode: 'alpha' | 'background';
  autoThreshold: number;
  usedThreshold: number;
  /** feature map normalised to 0..255 (for the threshold preview) */
  feature: Uint8Array;
  bgColors: [number, number, number][];
}

// ------------------------------------------------------------------ colour

function srgbToLinear(c: number) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const LIN = new Float32Array(256).map((_, i) => srgbToLinear(i));
function fLab(t: number) {
  return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
}
export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const R = LIN[r], G = LIN[g], B = LIN[b];
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const fx = fLab(X), fy = fLab(Y), fz = fLab(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

// --------------------------------------------------------------- filters

/** Separable box blur on interleaved RGBA (approximate Gaussian with 2 passes). */
function blurRGBA(src: Uint8ClampedArray | Uint8Array, w: number, h: number, r: number): Uint8ClampedArray {
  let a = Uint8ClampedArray.from(src);
  if (r < 0.5) return a;
  const rad = Math.round(r);
  let b = new Uint8ClampedArray(a.length);
  for (let pass = 0; pass < 2; pass++) {
    // horizontal
    for (let y = 0; y < h; y++) {
      for (let c = 0; c < 4; c++) {
        let s = 0;
        for (let x = -rad; x <= rad; x++) s += a[(y * w + Math.min(w - 1, Math.max(0, x))) * 4 + c];
        for (let x = 0; x < w; x++) {
          b[(y * w + x) * 4 + c] = s / (2 * rad + 1);
          const xo = Math.max(0, x - rad), xi = Math.min(w - 1, x + rad + 1);
          s += a[(y * w + xi) * 4 + c] - a[(y * w + xo) * 4 + c];
        }
      }
    }
    // vertical
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 4; c++) {
        let s = 0;
        for (let y = -rad; y <= rad; y++) s += b[(Math.min(h - 1, Math.max(0, y)) * w + x) * 4 + c];
        for (let y = 0; y < h; y++) {
          a[(y * w + x) * 4 + c] = s / (2 * rad + 1);
          const yo = Math.max(0, y - rad), yi = Math.min(h - 1, y + rad + 1);
          s += b[(yi * w + x) * 4 + c] - b[(yo * w + x) * 4 + c];
        }
      }
    }
  }
  return a;
}

/** Gaussian blur of a float field (separable, truncated at 3σ). */
export function gaussian(f: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma < 0.3) return f.slice();
  const R = Math.ceil(3 * sigma);
  const k = new Float32Array(2 * R + 1);
  let s = 0;
  for (let i = -R; i <= R; i++) s += k[i + R] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let i = -R; i <= R; i++) {
        const xx = x + i;
        if (xx >= 0 && xx < w) a += k[i + R] * f[y * w + xx];
      }
      tmp[y * w + x] = a;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let i = -R; i <= R; i++) {
        const yy = y + i;
        if (yy >= 0 && yy < h) a += k[i + R] * tmp[yy * w + x];
      }
      out[y * w + x] = a;
    }
  return out;
}

export function dilate(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return m.slice();
  const d = edt(m, w, h);
  const r2 = r * r;
  return Uint8Array.from(d, (v) => (v <= r2 ? 1 : 0));
}
export function erode(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return m.slice();
  const inv = Uint8Array.from(m, (v) => 1 - v);
  const d = edt(inv, w, h);
  const r2 = r * r;
  return Uint8Array.from(d, (v) => (v > r2 ? 1 : 0));
}

/** 4-connected component labelling. Returns labels (0 = background, 1.. = components) and areas. */
export function label(m: Uint8Array, w: number, h: number, value = 1): { labels: Int32Array; areas: number[] } {
  const labels = new Int32Array(w * h);
  const areas = [0];
  const stack: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (m[i] !== value || labels[i]) continue;
    const id = areas.length;
    let area = 0;
    labels[i] = id;
    stack.push(i);
    while (stack.length) {
      const p = stack.pop()!;
      area++;
      const x = p % w, y = (p / w) | 0;
      if (x > 0 && m[p - 1] === value && !labels[p - 1]) { labels[p - 1] = id; stack.push(p - 1); }
      if (x < w - 1 && m[p + 1] === value && !labels[p + 1]) { labels[p + 1] = id; stack.push(p + 1); }
      if (y > 0 && m[p - w] === value && !labels[p - w]) { labels[p - w] = id; stack.push(p - w); }
      if (y < h - 1 && m[p + w] === value && !labels[p + w]) { labels[p + w] = id; stack.push(p + w); }
    }
    areas.push(area);
  }
  return { labels, areas };
}

/** Otsu threshold of values in [0, max]. */
export function otsu(values: Float32Array, max: number, bins = 256): number {
  const hist = new Float64Array(bins);
  for (const v of values) hist[Math.min(bins - 1, Math.max(0, Math.floor((v / max) * (bins - 1))))]++;
  const total = values.length;
  let sum = 0;
  for (let i = 0; i < bins; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, bestVar = -1;
  for (let i = 0; i < bins; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > bestVar) {
      bestVar = between;
      best = i;
    }
  }
  return ((best + 0.5) / (bins - 1)) * max;
}

function kmeans(samples: [number, number, number][], k: number, iters = 12): { centers: [number, number, number][]; counts: number[] } {
  if (!samples.length) return { centers: [[100, 0, 0]], counts: [1] };
  // k-means++ style deterministic init: farthest-point
  const centers: [number, number, number][] = [samples[0]];
  while (centers.length < k) {
    let best = samples[0], bd = -1;
    for (const s of samples) {
      let d = Infinity;
      for (const c of centers) d = Math.min(d, (s[0] - c[0]) ** 2 + (s[1] - c[1]) ** 2 + (s[2] - c[2]) ** 2);
      if (d > bd) { bd = d; best = s; }
    }
    if (bd < 4) break;
    centers.push([...best] as [number, number, number]);
  }
  let counts = new Array(centers.length).fill(0);
  for (let it = 0; it < iters; it++) {
    const acc = centers.map(() => [0, 0, 0]);
    counts = new Array(centers.length).fill(0);
    for (const s of samples) {
      let bi = 0, bd = Infinity;
      centers.forEach((c, i) => {
        const d = (s[0] - c[0]) ** 2 + (s[1] - c[1]) ** 2 + (s[2] - c[2]) ** 2;
        if (d < bd) { bd = d; bi = i; }
      });
      acc[bi][0] += s[0]; acc[bi][1] += s[1]; acc[bi][2] += s[2];
      counts[bi]++;
    }
    centers.forEach((c, i) => {
      if (counts[i]) {
        c[0] = acc[i][0] / counts[i];
        c[1] = acc[i][1] / counts[i];
        c[2] = acc[i][2] / counts[i];
      }
    });
  }
  return { centers, counts };
}

// ----------------------------------------------------------------- detect

/** Does the image carry a meaningful alpha channel? */
export function hasTransparency(img: ImageLike): boolean {
  const d = img.data;
  let clear = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 200) clear++;
  return clear > 0.02 * (d.length / 4);
}

export function detectMask(img: ImageLike, scale: number, o: DetectOptions = defaultDetectOptions): DetectResult {
  const { width: w, height: h } = img;
  const N = w * h;
  const mode: 'alpha' | 'background' = o.mode === 'auto' ? (hasTransparency(img) ? 'alpha' : 'background') : o.mode;
  const px = blurRGBA(img.data, w, h, o.blur);
  const feat = new Float32Array(N);
  let maxF = 255;
  let bgColors: [number, number, number][] = [];
  if (mode === 'alpha') {
    for (let i = 0; i < N; i++) feat[i] = px[4 * i + 3];
  } else {
    // background colours from the border (alpha-composited on white)
    const border: [number, number, number][] = [];
    const lab = new Float32Array(3 * N);
    for (let i = 0; i < N; i++) {
      const a = px[4 * i + 3] / 255;
      const r = Math.round(px[4 * i] * a + 255 * (1 - a));
      const g = Math.round(px[4 * i + 1] * a + 255 * (1 - a));
      const b = Math.round(px[4 * i + 2] * a + 255 * (1 - a));
      const L = rgbToLab(r, g, b);
      lab[3 * i] = L[0]; lab[3 * i + 1] = L[1]; lab[3 * i + 2] = L[2];
    }
    const bw = Math.max(1, Math.round(Math.min(w, h) * 0.01));
    const step = Math.max(1, Math.floor((2 * (w + h)) / 800));
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (!(x < bw || y < bw || x >= w - bw || y >= h - bw)) continue;
        if ((x + y) % step) continue;
        const i = y * w + x;
        border.push([lab[3 * i], lab[3 * i + 1], lab[3 * i + 2]]);
      }
    const { centers, counts } = kmeans(border, 4);
    const total = counts.reduce((a, b) => a + b, 0) || 1;
    bgColors = centers.filter((_, i) => counts[i] / total > 0.06);
    if (!bgColors.length) bgColors = centers;
    maxF = 0;
    for (let i = 0; i < N; i++) {
      let d = Infinity;
      for (const c of bgColors) d = Math.min(d, Math.hypot(lab[3 * i] - c[0], lab[3 * i + 1] - c[1], lab[3 * i + 2] - c[2]));
      feat[i] = d;
      if (d > maxF) maxF = d;
    }
    maxF = Math.max(maxF, 1);
  }
  let auto = mode === 'alpha' ? 128 : Math.max(6, otsu(feat, maxF));
  if (mode === 'background') auto = Math.min(auto, 60);
  const thr = o.threshold ?? auto;
  let fg: Uint8Array = new Uint8Array(N);
  for (let i = 0; i < N; i++) fg[i] = feat[i] > thr ? 1 : 0;

  fg = erode(dilate(fg, w, h, o.close), w, h, o.close);
  if (o.open > 0) fg = dilate(erode(fg, w, h, o.open), w, h, o.open);

  // holes: background regions not connected to the image border
  {
    const { labels, areas } = label(fg, w, h, 0);
    const touches = new Uint8Array(areas.length);
    for (let x = 0; x < w; x++) { touches[labels[x]] = 1; touches[labels[(h - 1) * w + x]] = 1; }
    for (let y = 0; y < h; y++) { touches[labels[y * w]] = 1; touches[labels[y * w + w - 1]] = 1; }
    const minHole = o.fillHoles ? Infinity : Math.max(16, N * 0.0005);
    for (let i = 0; i < N; i++) {
      const l = labels[i];
      if (l && !touches[l] && areas[l] < minHole) fg[i] = 1;
    }
  }
  // components
  {
    const { labels, areas } = label(fg, w, h, 1);
    let largest = 0;
    for (let i = 1; i < areas.length; i++) if (areas[i] > areas[largest] || largest === 0) largest = i;
    const keep = new Uint8Array(areas.length);
    for (let i = 1; i < areas.length; i++) {
      if (o.keepLargest) keep[i] = i === largest ? 1 : 0;
      else keep[i] = areas[i] >= o.minArea * N && areas[i] >= 0.02 * areas[largest] ? 1 : 0;
    }
    for (let i = 0; i < N; i++) fg[i] = keep[labels[i]];
  }
  if (o.margin > 0) fg = dilate(fg, w, h, o.margin);

  const feature = new Uint8Array(N);
  for (let i = 0; i < N; i++) feature[i] = Math.min(255, (feat[i] / maxF) * 255);
  return { mask: { w, h, data: fg, scale }, mode, autoThreshold: auto, usedThreshold: thr, feature, bgColors };
}

// ------------------------------------------------------------------ trace

/** Iso-contours (level 0.5) of a scalar field via marching squares → closed loops (field coordinates). */
export function marchingSquares(f: Float32Array, w: number, h: number, iso = 0.5): Pt[][] {
  // pad with zeros so every contour closes
  const W = w + 2, H = h + 2;
  const v = new Float32Array(W * H);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) v[(y + 1) * W + x + 1] = f[y * w + x];
  const pts = new Map<number, Pt>();
  const adj = new Map<number, number[]>();
  const edgePoint = (id: number): Pt => {
    let p = pts.get(id);
    if (p) return p;
    const cell = id >> 1, x = cell % W, y = (cell / W) | 0;
    if ((id & 1) === 0) {
      const a = v[y * W + x], b = v[y * W + x + 1];
      const t = (iso - a) / (b - a);
      p = [x + t, y];
    } else {
      const a = v[y * W + x], b = v[(y + 1) * W + x];
      const t = (iso - a) / (b - a);
      p = [x, y + t];
    }
    pts.set(id, p);
    return p;
  };
  const link = (a: number, b: number) => {
    edgePoint(a);
    edgePoint(b);
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  };
  for (let y = 0; y < H - 1; y++)
    for (let x = 0; x < W - 1; x++) {
      const tl = v[y * W + x], tr = v[y * W + x + 1], br = v[(y + 1) * W + x + 1], bl = v[(y + 1) * W + x];
      const c = (tl > iso ? 1 : 0) | (tr > iso ? 2 : 0) | (br > iso ? 4 : 0) | (bl > iso ? 8 : 0);
      if (c === 0 || c === 15) continue;
      const T = (y * W + x) * 2, B = ((y + 1) * W + x) * 2, L = (y * W + x) * 2 + 1, R = (y * W + x + 1) * 2 + 1;
      const center = (tl + tr + br + bl) / 4 > iso;
      switch (c) {
        case 1: link(L, T); break;
        case 2: link(T, R); break;
        case 3: link(L, R); break;
        case 4: link(R, B); break;
        case 5: if (center) { link(T, R); link(B, L); } else { link(L, T); link(R, B); } break;
        case 6: link(T, B); break;
        case 7: link(L, B); break;
        case 8: link(B, L); break;
        case 9: link(T, B); break;
        case 10: if (center) { link(L, T); link(R, B); } else { link(T, R); link(B, L); } break;
        case 11: link(R, B); break;
        case 12: link(L, R); break;
        case 13: link(T, R); break;
        case 14: link(L, T); break;
      }
    }
  const loops: Pt[][] = [];
  const used = new Set<number>();
  for (const start of adj.keys()) {
    if (used.has(start)) continue;
    const loop: Pt[] = [];
    let prev = -1, cur = start;
    while (!used.has(cur)) {
      used.add(cur);
      const p = pts.get(cur)!;
      loop.push([p[0] - 1, p[1] - 1]);
      const nb = adj.get(cur)!;
      const nxt = nb[0] !== prev ? nb[0] : nb[1];
      if (nxt === undefined) break;
      prev = cur;
      cur = nxt;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

/** Douglas–Peucker for a closed loop. */
export function simplifyLoop(loop: Pt[], tol: number): Pt[] {
  const n = loop.length;
  if (n <= 4 || tol <= 0) return loop.slice();
  // split at two far-apart points
  let far = 0, fd = -1;
  for (let i = 0; i < n; i++) {
    const d = (loop[i][0] - loop[0][0]) ** 2 + (loop[i][1] - loop[0][1]) ** 2;
    if (d > fd) { fd = d; far = i; }
  }
  const keep = new Uint8Array(n);
  keep[0] = keep[far] = 1;
  const tol2 = tol * tol;
  const rec = (i0: number, i1: number) => {
    // indices along the loop from i0 to i1 (cyclic, i1 > i0 in unrolled index)
    const a = loop[i0 % n], b = loop[i1 % n];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    let best = -1, bd = tol2;
    for (let i = i0 + 1; i < i1; i++) {
      const p = loop[i % n];
      let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = (a[0] + t * dx - p[0]) ** 2 + (a[1] + t * dy - p[1]) ** 2;
      if (d > bd) { bd = d; best = i; }
    }
    if (best >= 0) {
      keep[best % n] = 1;
      rec(i0, best);
      rec(best, i1);
    }
  };
  rec(0, far);
  rec(far, n);
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(loop[i]);
  return out;
}

export interface TraceOptions {
  smooth: number;
  simplify: number;
  /** drop loops smaller than this many mask pixels² */
  minLoopArea: number;
}

/** Trace a mask into control loops in image coordinates. */
export function traceMask(mask: Mask, o: TraceOptions): Pt[][] {
  const { w, h, data, scale } = mask;
  const f = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) f[i] = data[i];
  const g = gaussian(f, w, h, o.smooth);
  const loops = marchingSquares(g, w, h, 0.5)
    .filter((l) => Math.abs(polygonArea(l)) >= o.minLoopArea)
    .map((l) => simplifyLoop(l, o.simplify))
    .filter((l) => l.length >= 3);
  // mask pixel centres → image coordinates
  return loops.map((l) => l.map(([x, y]) => [(x + 0.5) * scale, (y + 0.5) * scale] as Pt));
}

// ----------------------------------------------------------- mask editing

/** Paint a round brush stroke segment into the mask (value 1 = add, 0 = erase). */
export function paintSegment(mask: Mask, x0: number, y0: number, x1: number, y1: number, r: number, value: 0 | 1) {
  const { w, h, data } = mask;
  const minX = Math.max(0, Math.floor(Math.min(x0, x1) - r - 1)), maxX = Math.min(w - 1, Math.ceil(Math.max(x0, x1) + r + 1));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1) - r - 1)), maxY = Math.min(h - 1, Math.ceil(Math.max(y0, y1) + r + 1));
  const dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy, r2 = r * r;
  for (let y = minY; y <= maxY; y++)
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5, py = y + 0.5;
      let t = l2 ? ((px - x0) * dx + (py - y0) * dy) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      const ex = x0 + t * dx - px, ey = y0 + t * dy - py;
      if (ex * ex + ey * ey <= r2) data[y * w + x] = value;
    }
}

/** Fill a polygon (mask coordinates) with value (even–odd scanline). */
export function fillPolygon(mask: Mask, poly: Pt[], value: 0 | 1) {
  const { w, h, data } = mask;
  let y0 = Infinity, y1 = -Infinity;
  for (const p of poly) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
  for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(h - 1, Math.ceil(y1)); y++) {
    const cy = y + 0.5;
    const xs: number[] = [];
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[j], b = poly[i];
      if (a[1] > cy !== b[1] > cy) xs.push(a[0] + ((cy - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k] - 0.5)), xb = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = xa; x <= xb; x++) data[y * w + x] = value;
    }
  }
}

/** Rasterise loops (image coordinates) into a new mask. */
export function maskFromLoops(loops: Pt[][], w: number, h: number, scale: number): Mask {
  const mask: Mask = { w, h, data: new Uint8Array(w * h), scale };
  // even-odd across all loops: accumulate parity per pixel
  const parity = new Uint8Array(w * h);
  for (const l of loops) {
    const tmp: Mask = { w, h, data: new Uint8Array(w * h), scale };
    fillPolygon(tmp, l.map(([x, y]) => [x / scale, y / scale] as Pt), 1);
    for (let i = 0; i < w * h; i++) parity[i] ^= tmp.data[i];
  }
  mask.data.set(parity);
  return mask;
}
