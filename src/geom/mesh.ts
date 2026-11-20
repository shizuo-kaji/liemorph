/**
 * Triangle meshes for 2D shapes: boundary resampling, interior point
 * generation, constrained Delaunay triangulation (Delaunator + Constrainautor),
 * relaxation, editing and topology helpers.
 */
import Delaunator from 'delaunator';
import Constrainautor from '@kninnug/constrainautor';
import { edt } from './raster.ts';

export type Pt = [number, number];

export interface Mesh {
  /** rest (reference) vertex positions, interleaved x,y */
  rest: Float64Array;
  /** triangle vertex indices, 3 per triangle */
  tris: Uint32Array;
  /** boundary loops as vertex index cycles (outer boundaries and holes) */
  loops: number[][];
}

export interface MeshOptions {
  /** target edge length in world units */
  edge: number;
  /** relaxation sweeps after triangulation */
  relax: number;
  /** interior point distribution */
  pattern: 'hex' | 'poisson' | 'none';
  /** control points whose turning angle exceeds this (degrees) are kept exactly */
  cornerAngle: number;
  /** keep interior points at least this × edge away from the boundary */
  boundaryGap: number;
  seed: number;
}

export const defaultMeshOptions: MeshOptions = {
  edge: 24,
  relax: 3,
  pattern: 'hex',
  cornerAngle: 40,
  boundaryGap: 0.6,
  seed: 1,
};

export function vcount(m: Mesh) {
  return m.rest.length >> 1;
}
export function tcount(m: Mesh) {
  return (m.tris.length / 3) | 0;
}

// ---------------------------------------------------------------- utilities

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function polygonArea(loop: Pt[]): number {
  let s = 0;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    s += (loop[j][0] - loop[i][0]) * (loop[j][1] + loop[i][1]);
  }
  return s / 2;
}

export function loopLength(loop: Pt[]): number {
  let s = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    s += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return s;
}

/** Even–odd point-in-polygon test against a set of loops. */
export function insideLoops(x: number, y: number, loops: Pt[][]): boolean {
  let inside = false;
  for (const loop of loops) {
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const xi = loop[i][0], yi = loop[i][1];
      const xj = loop[j][0], yj = loop[j][1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + t * dx - px, qy = ay + t * dy - py;
  return qx * qx + qy * qy;
}

/** Uniform grid over boundary segments for fast "distance to boundary" queries. */
class SegmentGrid {
  cell: number;
  x0: number;
  y0: number;
  nx: number;
  ny: number;
  cells: number[][];
  segs: number[]; // ax, ay, bx, by
  constructor(loops: Pt[][], cell: number) {
    this.cell = cell;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const l of loops) for (const p of l) {
      x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]);
      x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
    }
    this.x0 = x0 - cell; this.y0 = y0 - cell;
    this.nx = Math.max(1, Math.ceil((x1 - x0) / cell) + 3);
    this.ny = Math.max(1, Math.ceil((y1 - y0) / cell) + 3);
    this.cells = Array.from({ length: this.nx * this.ny }, () => []);
    this.segs = [];
    for (const l of loops) {
      for (let i = 0; i < l.length; i++) {
        const a = l[i], b = l[(i + 1) % l.length];
        const id = this.segs.length / 4;
        this.segs.push(a[0], a[1], b[0], b[1]);
        const cx0 = this.cx(Math.min(a[0], b[0])), cx1 = this.cx(Math.max(a[0], b[0]));
        const cy0 = this.cy(Math.min(a[1], b[1])), cy1 = this.cy(Math.max(a[1], b[1]));
        for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) this.cells[cy * this.nx + cx].push(id);
      }
    }
  }
  cx(x: number) {
    return Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.x0) / this.cell)));
  }
  cy(y: number) {
    return Math.min(this.ny - 1, Math.max(0, Math.floor((y - this.y0) / this.cell)));
  }
  /** true if some segment is closer than r */
  near(x: number, y: number, r: number) {
    const r2 = r * r;
    const cx0 = this.cx(x - r), cx1 = this.cx(x + r), cy0 = this.cy(y - r), cy1 = this.cy(y + r);
    const s = this.segs;
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
      for (const id of this.cells[cy * this.nx + cx]) {
        const o = id * 4;
        if (segDist2(x, y, s[o], s[o + 1], s[o + 2], s[o + 3]) < r2) return true;
      }
    }
    return false;
  }
}

/** Remove consecutive duplicates / near-duplicates from a closed loop. */
export function cleanLoop(loop: Pt[], eps = 1e-6): Pt[] {
  const out: Pt[] = [];
  for (const p of loop) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > eps) out.push([p[0], p[1]]);
  }
  while (out.length > 1) {
    const a = out[0], b = out[out.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= eps) out.pop();
    else break;
  }
  return out;
}

export type SizeFn = (x: number, y: number) => number;

/**
 * Local edge-length field: h everywhere, but ≈ 0.8 × local thickness in thin
 * parts (thickness from a distance transform of the rasterised shape, max-
 * filtered over a radius h), never below 0.3 h.
 */
export function sizingField(loops: Pt[][], h: number): SizeFn {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of loops) for (const p of l) {
    x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
  }
  if (!isFinite(x0)) return () => h;
  let cell = h / 4;
  // keep the grid reasonable
  const maxCells = 600 * 600;
  if (((x1 - x0) / cell) * ((y1 - y0) / cell) > maxCells) cell = Math.sqrt(((x1 - x0) * (y1 - y0)) / maxCells);
  const W = Math.ceil((x1 - x0) / cell) + 5, H = Math.ceil((y1 - y0) / cell) + 5;
  const ox = x0 - 2 * cell, oy = y0 - 2 * cell;
  // rasterise (even–odd) – "on" = outside, so the EDT gives distance to the boundary for inside cells
  const outside = new Uint8Array(W * H).fill(1);
  for (let gy = 0; gy < H; gy++) {
    const cy = oy + (gy + 0.5) * cell;
    const xs: number[] = [];
    for (const l of loops)
      for (let i = 0, j = l.length - 1; i < l.length; j = i++) {
        const a = l[j], b = l[i];
        if (a[1] > cy !== b[1] > cy) xs.push(a[0] + ((cy - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
      }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil((xs[k] - ox) / cell - 0.5)), xb = Math.min(W - 1, Math.floor((xs[k + 1] - ox) / cell - 0.5));
      for (let gx = xa; gx <= xb; gx++) outside[gy * W + gx] = 0;
    }
  }
  const d2 = edt(outside, W, H);
  const D = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) D[i] = Math.sqrt(d2[i]);
  // max filter (separable) with radius r cells
  const r = Math.max(1, Math.ceil(h / cell));
  const tmp = new Float32Array(W * H), M = new Float32Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let m = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(W - 1, x + r); k++) m = Math.max(m, D[y * W + k]);
      tmp[y * W + x] = m;
    }
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let m = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(H - 1, y + r); k++) m = Math.max(m, tmp[k * W + x]);
      M[y * W + x] = m;
    }
  return (x, y) => {
    const gx = Math.min(W - 1, Math.max(0, Math.floor((x - ox) / cell)));
    const gy = Math.min(H - 1, Math.max(0, Math.floor((y - oy) / cell)));
    const thickness = 2 * M[gy * W + gx] * cell;
    return Math.min(h, Math.max(0.3 * h, 0.8 * thickness));
  };
}

/** Resample an open polyline (first point kept, last point excluded) with spacing ≈ size(x, y). */
function resamplePolyline(pts: Pt[], size: SizeFn, minSegs: number, out: Pt[]) {
  // split long segments so the size field is sampled densely enough
  const P: Pt[] = [pts[0]];
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1], b = pts[k];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(l / (0.25 * size(a[0], a[1]))));
    for (let i = 1; i <= n; i++) P.push([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
  }
  const cum = [0];
  for (let k = 1; k < P.length; k++) {
    const l = Math.hypot(P[k][0] - P[k - 1][0], P[k][1] - P[k - 1][1]);
    cum.push(cum[k - 1] + l / size((P[k][0] + P[k - 1][0]) / 2, (P[k][1] + P[k - 1][1]) / 2));
  }
  const L = cum[cum.length - 1];
  const segs = Math.max(minSegs, Math.round(L));
  let k = 0;
  for (let s = 0; s < segs; s++) {
    const t = (s * L) / segs;
    while (k < cum.length - 2 && cum[k + 1] < t) k++;
    const span = cum[k + 1] - cum[k];
    const u = span > 0 ? (t - cum[k]) / span : 0;
    out.push([P[k][0] + u * (P[k + 1][0] - P[k][0]), P[k][1] + u * (P[k + 1][1] - P[k][1])]);
  }
}

/**
 * Resample a closed loop so that edges follow the size field (≈ h, smaller in
 * thin parts), keeping sharp corners (turning angle > cornerDeg) exactly.
 */
export function resampleLoop(loop0: Pt[], h: number, cornerDeg: number, size: SizeFn = () => h): Pt[] {
  const loop = cleanLoop(loop0);
  const n = loop.length;
  if (n < 3) return loop;
  const cosLim = Math.cos((cornerDeg * Math.PI) / 180);
  const corners: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = loop[(i + n - 1) % n], b = loop[i], c = loop[(i + 1) % n];
    const ux = b[0] - a[0], uy = b[1] - a[1], vx = c[0] - b[0], vy = c[1] - b[1];
    const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
    if (lu < 1e-9 || lv < 1e-9) continue;
    if ((ux * vx + uy * vy) / (lu * lv) < cosLim) corners.push(i);
  }
  const out: Pt[] = [];
  if (corners.length === 0) {
    resamplePolyline([...loop, loop[0]], size, 3, out);
  } else {
    for (let c = 0; c < corners.length; c++) {
      const start = corners[c], end = corners[(c + 1) % corners.length];
      const pts: Pt[] = [];
      let i = start;
      do {
        pts.push(loop[i]);
        i = (i + 1) % n;
      } while (i !== end);
      pts.push(loop[end]);
      resamplePolyline(pts, size, 1, out);
    }
  }
  // merge samples that ended up much closer than the local size (e.g. two nearby corners)
  for (let pass = 0; pass < 3 && out.length > 3; pass++) {
    let removed = false;
    for (let i = 0; i < out.length && out.length > 3; i++) {
      const a = out[i], b = out[(i + 1) % out.length];
      const lim = 0.4 * size((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < lim) {
        const j = (i + 1) % out.length;
        out[i] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        out.splice(j, 1);
        removed = true;
      }
    }
    if (!removed) break;
  }
  return out.length >= 3 ? out : loop;
}

// ------------------------------------------------------------- triangulation

/** Constrained Delaunay triangulation of points with boundary loops; keeps triangles inside (even–odd). */
export function triangulate(coords: Float64Array, loops: number[][]): { tris: Uint32Array; failed: number } {
  const n = coords.length >> 1;
  if (n < 3) return { tris: new Uint32Array(0), failed: 0 };
  let del: Delaunator<ArrayLike<number>>;
  try {
    del = new Delaunator(coords);
  } catch {
    return { tris: new Uint32Array(0), failed: loops.length };
  }
  if (del.triangles.length < 3) return { tris: new Uint32Array(0), failed: 0 };
  let failed = 0;
  try {
    const con = new Constrainautor(del);
    for (const loop of loops) {
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i], b = loop[(i + 1) % loop.length];
        if (a === b) continue;
        try {
          con.constrainOne(a, b);
        } catch {
          failed++;
        }
      }
    }
  } catch {
    failed++;
  }
  const polys: Pt[][] = loops.map((l) => l.map((i) => [coords[2 * i], coords[2 * i + 1]] as Pt));
  const t = del.triangles;
  const keep: number[] = [];
  for (let k = 0; k < t.length; k += 3) {
    const a = t[k], b = t[k + 1], c = t[k + 2];
    const ax = coords[2 * a], ay = coords[2 * a + 1];
    const bx = coords[2 * b], by = coords[2 * b + 1];
    const cx = coords[2 * c], cy = coords[2 * c + 1];
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-12) continue;
    const mx = (ax + bx + cx) / 3, my = (ay + by + cy) / 3;
    if (insideLoops(mx, my, polys)) {
      // consistent orientation: positive signed area in (x right, y down) coordinates
      if (area > 0) keep.push(a, b, c);
      else keep.push(a, c, b);
    }
  }
  return { tris: Uint32Array.from(keep), failed };
}

/** Drop vertices not referenced by any triangle; remap loops. */
export function compact(mesh: Mesh): Mesh {
  const n = vcount(mesh);
  const used = new Uint8Array(n);
  for (const v of mesh.tris) used[v] = 1;
  const map = new Int32Array(n).fill(-1);
  let k = 0;
  for (let i = 0; i < n; i++) if (used[i]) map[i] = k++;
  if (k === n) return mesh;
  const rest = new Float64Array(2 * k);
  for (let i = 0; i < n; i++) if (map[i] >= 0) {
    rest[2 * map[i]] = mesh.rest[2 * i];
    rest[2 * map[i] + 1] = mesh.rest[2 * i + 1];
  }
  const tris = mesh.tris.map((v) => map[v]);
  const loops = mesh.loops.map((l) => l.map((v) => map[v]).filter((v) => v >= 0)).filter((l) => l.length >= 3);
  return { rest, tris, loops };
}

function interiorPoints(loops: Pt[][], opts: MeshOptions): Pt[] {
  if (opts.pattern === 'none') return [];
  const h = opts.edge;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of loops) for (const p of l) {
    x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
  }
  const grid = new SegmentGrid(loops, h);
  const gap = opts.boundaryGap * h;
  const rnd = mulberry32(opts.seed);
  const out: Pt[] = [];
  const accept = (x: number, y: number) => insideLoops(x, y, loops) && !grid.near(x, y, gap);
  if (opts.pattern === 'hex') {
    const dy = (h * Math.sqrt(3)) / 2;
    let row = 0;
    for (let y = y0 + dy / 2; y < y1; y += dy, row++) {
      for (let x = x0 + (row % 2 ? h / 2 : 0); x < x1; x += h) {
        const jx = x + (rnd() - 0.5) * 0.04 * h, jy = y + (rnd() - 0.5) * 0.04 * h;
        if (accept(jx, jy)) out.push([jx, jy]);
      }
    }
  } else {
    // Bridson Poisson-disk sampling
    const r = h * 0.92;
    const cs = r / Math.SQRT2;
    const gw = Math.ceil((x1 - x0) / cs) + 1, gh = Math.ceil((y1 - y0) / cs) + 1;
    const g = new Int32Array(gw * gh).fill(-1);
    const pts: Pt[] = [];
    const active: number[] = [];
    const put = (x: number, y: number) => {
      pts.push([x, y]);
      g[Math.floor((y - y0) / cs) * gw + Math.floor((x - x0) / cs)] = pts.length - 1;
      active.push(pts.length - 1);
    };
    const ok = (x: number, y: number) => {
      if (x < x0 || y < y0 || x > x1 || y > y1) return false;
      const gx = Math.floor((x - x0) / cs), gy = Math.floor((y - y0) / cs);
      for (let yy = Math.max(0, gy - 2); yy <= Math.min(gh - 1, gy + 2); yy++)
        for (let xx = Math.max(0, gx - 2); xx <= Math.min(gw - 1, gx + 2); xx++) {
          const id = g[yy * gw + xx];
          if (id >= 0 && Math.hypot(pts[id][0] - x, pts[id][1] - y) < r) return false;
        }
      return true;
    };
    // seed with a few interior points
    for (let tries = 0; tries < 200 && pts.length < 1; tries++) {
      const x = x0 + rnd() * (x1 - x0), y = y0 + rnd() * (y1 - y0);
      if (accept(x, y)) put(x, y);
    }
    while (active.length) {
      const ai = Math.floor(rnd() * active.length);
      const p = pts[active[ai]];
      let found = false;
      for (let k = 0; k < 24; k++) {
        const ang = rnd() * Math.PI * 2, rad = r * (1 + rnd());
        const x = p[0] + Math.cos(ang) * rad, y = p[1] + Math.sin(ang) * rad;
        if (ok(x, y) && insideLoops(x, y, loops)) {
          put(x, y);
          found = true;
          break;
        }
      }
      if (!found) active.splice(ai, 1);
    }
    for (const p of pts) if (accept(p[0], p[1])) out.push(p);
  }
  return out;
}

/** Build a mesh from control loops (outer boundaries + holes, even–odd). */
export function buildMesh(controlLoops: Pt[][], opts: MeshOptions = defaultMeshOptions): Mesh & { failed: number } {
  const size = sizingField(controlLoops, opts.edge);
  const loops = controlLoops.map((l) => resampleLoop(l, opts.edge, opts.cornerAngle, size)).filter((l) => l.length >= 3);
  const pts: Pt[] = [];
  const loopIdx: number[][] = [];
  for (const l of loops) {
    const idx: number[] = [];
    for (const p of l) {
      idx.push(pts.length);
      pts.push(p);
    }
    loopIdx.push(idx);
  }
  for (const p of interiorPoints(loops, opts)) pts.push(p);
  const rest = new Float64Array(pts.length * 2);
  pts.forEach((p, i) => {
    rest[2 * i] = p[0];
    rest[2 * i + 1] = p[1];
  });
  let mesh: Mesh = { rest, tris: new Uint32Array(0), loops: loopIdx };
  let { tris, failed } = triangulate(rest, loopIdx);
  mesh.tris = tris;
  for (let it = 0; it < opts.relax; it++) {
    relaxOnce(mesh);
    const r = triangulate(mesh.rest, mesh.loops);
    mesh.tris = r.tris;
    failed = r.failed;
  }
  mesh = compact(mesh);
  return { ...mesh, failed };
}

/** Rebuild triangles for the current vertex positions (after editing). */
export function retriangulate(mesh: Mesh): Mesh & { failed: number } {
  const { tris, failed } = triangulate(mesh.rest, mesh.loops);
  return { ...compact({ rest: mesh.rest, tris, loops: mesh.loops }), failed };
}

/** One sweep of area-weighted centroid smoothing on interior vertices (in place, never inverts). */
export function relaxOnce(mesh: Mesh, fixed?: Uint8Array) {
  const n = vcount(mesh);
  const onB = new Uint8Array(n);
  for (const l of mesh.loops) for (const v of l) onB[v] = 1;
  const sx = new Float64Array(n), sy = new Float64Array(n), sw = new Float64Array(n);
  const P = mesh.rest, T = mesh.tris;
  for (let k = 0; k < T.length; k += 3) {
    const a = T[k], b = T[k + 1], c = T[k + 2];
    const ax = P[2 * a], ay = P[2 * a + 1], bx = P[2 * b], by = P[2 * b + 1], cx = P[2 * c], cy = P[2 * c + 1];
    const area = Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2;
    const mx = (ax + bx + cx) / 3, my = (ay + by + cy) / 3;
    for (const v of [a, b, c]) {
      sx[v] += area * mx;
      sy[v] += area * my;
      sw[v] += area;
    }
  }
  const inc = vertexTriangles(mesh);
  for (let v = 0; v < n; v++) {
    if (onB[v] || sw[v] === 0 || (fixed && fixed[v])) continue;
    const ox = P[2 * v], oy = P[2 * v + 1];
    const nx = sx[v] / sw[v], ny = sy[v] / sw[v];
    P[2 * v] = nx;
    P[2 * v + 1] = ny;
    // reject if any incident triangle inverts
    for (const t of inc[v]) {
      if (signedArea(P, T, t) <= 0) {
        P[2 * v] = ox;
        P[2 * v + 1] = oy;
        break;
      }
    }
  }
}

export function signedArea(P: ArrayLike<number>, T: ArrayLike<number>, t: number) {
  const a = T[3 * t], b = T[3 * t + 1], c = T[3 * t + 2];
  return ((P[2 * b] - P[2 * a]) * (P[2 * c + 1] - P[2 * a + 1]) - (P[2 * b + 1] - P[2 * a + 1]) * (P[2 * c] - P[2 * a])) / 2;
}

// ---------------------------------------------------------------- topology

export function vertexNeighbors(mesh: Mesh): number[][] {
  const n = vcount(mesh);
  const sets: Set<number>[] = Array.from({ length: n }, () => new Set());
  const T = mesh.tris;
  for (let k = 0; k < T.length; k += 3) {
    const a = T[k], b = T[k + 1], c = T[k + 2];
    sets[a].add(b); sets[a].add(c);
    sets[b].add(a); sets[b].add(c);
    sets[c].add(a); sets[c].add(b);
  }
  return sets.map((s) => [...s]);
}

export function vertexTriangles(mesh: Mesh): number[][] {
  const n = vcount(mesh);
  const out: number[][] = Array.from({ length: n }, () => []);
  for (let t = 0; t < mesh.tris.length / 3; t++) {
    out[mesh.tris[3 * t]].push(t);
    out[mesh.tris[3 * t + 1]].push(t);
    out[mesh.tris[3 * t + 2]].push(t);
  }
  return out;
}

/** Edge-adjacent triangles (for rotation-angle propagation). */
export function triangleNeighbors(mesh: Mesh): number[][] {
  const m = tcount(mesh);
  const n = vcount(mesh);
  const out: number[][] = Array.from({ length: m }, () => []);
  const map = new Map<number, number>();
  const T = mesh.tris;
  for (let t = 0; t < m; t++) {
    for (let e = 0; e < 3; e++) {
      const a = T[3 * t + e], b = T[3 * t + ((e + 1) % 3)];
      const key = a < b ? a * n + b : b * n + a;
      const o = map.get(key);
      if (o === undefined) map.set(key, t);
      else {
        out[t].push(o);
        out[o].push(t);
      }
    }
  }
  return out;
}

/** Connected components of vertices: comp[v] and number of components. */
export function components(mesh: Mesh): { comp: Int32Array; count: number } {
  const n = vcount(mesh);
  const nb = vertexNeighbors(mesh);
  const comp = new Int32Array(n).fill(-1);
  let count = 0;
  for (let s = 0; s < n; s++) {
    if (comp[s] >= 0) continue;
    const stack = [s];
    comp[s] = count;
    while (stack.length) {
      const u = stack.pop()!;
      for (const v of nb[u]) if (comp[v] < 0) {
        comp[v] = count;
        stack.push(v);
      }
    }
    count++;
  }
  return { comp, count };
}

/** Boundary loops recovered from triangles (edges used once), for meshes imported without loops. */
export function boundaryLoopsFromTris(n: number, tris: ArrayLike<number>): number[][] {
  const count = new Map<string, number>();
  const directed: [number, number][] = [];
  for (let k = 0; k < tris.length; k += 3) {
    for (let e = 0; e < 3; e++) {
      const a = tris[k + e], b = tris[k + ((e + 1) % 3)];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      count.set(key, (count.get(key) ?? 0) + 1);
      directed.push([a, b]);
    }
  }
  const next = new Map<number, number>();
  for (const [a, b] of directed) {
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    if (count.get(key) === 1) next.set(a, b);
  }
  const loops: number[][] = [];
  const used = new Set<number>();
  for (const s of next.keys()) {
    if (used.has(s)) continue;
    const loop: number[] = [];
    let v: number | undefined = s;
    while (v !== undefined && !used.has(v) && loop.length <= n) {
      used.add(v);
      loop.push(v);
      v = next.get(v);
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

// ------------------------------------------------------------- measurement

export interface MeshQuality {
  vertices: number;
  triangles: number;
  minAngle: number; // degrees
  meanQuality: number; // 1 = equilateral (normalised radius ratio)
  histogram: number[]; // 10 bins of quality
}

export function meshQuality(P: ArrayLike<number>, T: ArrayLike<number>): MeshQuality {
  let minA = 180, sumQ = 0;
  const hist = new Array(10).fill(0);
  const m = T.length / 3;
  for (let t = 0; t < m; t++) {
    const a = T[3 * t], b = T[3 * t + 1], c = T[3 * t + 2];
    const ax = P[2 * a], ay = P[2 * a + 1], bx = P[2 * b], by = P[2 * b + 1], cx = P[2 * c], cy = P[2 * c + 1];
    const la = Math.hypot(bx - cx, by - cy), lb = Math.hypot(ax - cx, ay - cy), lc = Math.hypot(ax - bx, ay - by);
    const area = Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2;
    const q = (4 * Math.sqrt(3) * area) / (la * la + lb * lb + lc * lc || 1);
    sumQ += q;
    hist[Math.min(9, Math.floor(q * 10))]++;
    const ang = (x: number, y: number, z: number) => Math.acos(Math.max(-1, Math.min(1, (y * y + z * z - x * x) / (2 * y * z || 1))));
    minA = Math.min(minA, ang(la, lb, lc), ang(lb, la, lc), ang(lc, la, lb));
  }
  if (minA !== 180) minA = (minA * 180) / Math.PI;
  return { vertices: P.length >> 1, triangles: m, minAngle: m ? minA : 0, meanQuality: m ? sumQ / m : 0, histogram: hist };
}

// -------------------------------------------------------------- picking

export interface BaryHit {
  tri: number;
  b: [number, number, number];
  /** distance outside the triangle (0 if inside) */
  dist: number;
}

/** Locate a point in the (deformed) mesh; returns nearest triangle within maxDist. */
export function locate(P: ArrayLike<number>, T: ArrayLike<number>, x: number, y: number, maxDist = 0): BaryHit | null {
  let best: BaryHit | null = null;
  const m = T.length / 3;
  for (let t = 0; t < m; t++) {
    const a = T[3 * t], b = T[3 * t + 1], c = T[3 * t + 2];
    const ax = P[2 * a], ay = P[2 * a + 1], bx = P[2 * b], by = P[2 * b + 1], cx = P[2 * c], cy = P[2 * c + 1];
    const det = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(det) < 1e-12) continue;
    const l1 = ((x - ax) * (cy - ay) - (y - ay) * (cx - ax)) / det;
    const l2 = ((bx - ax) * (y - ay) - (by - ay) * (x - ax)) / det;
    const l0 = 1 - l1 - l2;
    if (l0 >= -1e-9 && l1 >= -1e-9 && l2 >= -1e-9) return { tri: t, b: [l0, l1, l2], dist: 0 };
    if (maxDist > 0) {
      const d = Math.min(
        Math.sqrt(segDist2(x, y, ax, ay, bx, by)),
        Math.sqrt(segDist2(x, y, bx, by, cx, cy)),
        Math.sqrt(segDist2(x, y, cx, cy, ax, ay)),
      );
      if (d <= maxDist && (!best || d < best.dist)) {
        // clamp barycentrics to the triangle
        let b0 = Math.max(0, l0), b1 = Math.max(0, l1), b2 = Math.max(0, l2);
        const s = b0 + b1 + b2 || 1;
        b0 /= s; b1 /= s; b2 /= s;
        best = { tri: t, b: [b0, b1, b2], dist: d };
      }
    }
  }
  return best;
}

export function nearestVertex(P: ArrayLike<number>, x: number, y: number, maxDist: number, filter?: (i: number) => boolean): number {
  let best = -1, bd = maxDist * maxDist;
  for (let i = 0; i < P.length / 2; i++) {
    if (filter && !filter(i)) continue;
    const d = (P[2 * i] - x) ** 2 + (P[2 * i + 1] - y) ** 2;
    if (d <= bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

/** Bounding box of interleaved coordinates. */
export function bbox(P: ArrayLike<number>): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < P.length; i += 2) {
    x0 = Math.min(x0, P[i]); x1 = Math.max(x1, P[i]);
    y0 = Math.min(y0, P[i + 1]); y1 = Math.max(y1, P[i + 1]);
  }
  return [x0, y0, x1, y1];
}

/** Add a Steiner vertex (if inside the shape) and retriangulate. */
export function addVertex(mesh: Mesh, x: number, y: number, minDist: number): Mesh | null {
  const polys = mesh.loops.map((l) => l.map((i) => [mesh.rest[2 * i], mesh.rest[2 * i + 1]] as Pt));
  if (!insideLoops(x, y, polys)) return null;
  if (nearestVertex(mesh.rest, x, y, minDist) >= 0) return null;
  const rest = new Float64Array(mesh.rest.length + 2);
  rest.set(mesh.rest);
  rest[mesh.rest.length] = x;
  rest[mesh.rest.length + 1] = y;
  return retriangulate({ rest, tris: mesh.tris, loops: mesh.loops });
}

/** Remove a vertex (interior, or boundary when its loop keeps ≥ 3 vertices). */
export function removeVertex(mesh: Mesh, v: number): Mesh | null {
  const loops = mesh.loops.map((l) => l.slice());
  for (const l of loops) {
    const k = l.indexOf(v);
    if (k >= 0) {
      if (l.length <= 3) return null;
      l.splice(k, 1);
    }
  }
  const n = vcount(mesh);
  const rest = new Float64Array(2 * (n - 1));
  for (let i = 0, j = 0; i < n; i++) if (i !== v) {
    rest[2 * j] = mesh.rest[2 * i];
    rest[2 * j + 1] = mesh.rest[2 * i + 1];
    j++;
  }
  const remap = (i: number) => (i > v ? i - 1 : i);
  return retriangulate({ rest, tris: new Uint32Array(0), loops: loops.map((l) => l.map(remap)) });
}
