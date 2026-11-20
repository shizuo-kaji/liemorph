/**
 * ARAP shape interpolation / multi-pose blending.
 *
 *  – Alexa, Cohen-Or, Levin: "As-rigid-as-possible shape interpolation", SIGGRAPH 2000
 *  – Kaji, Hirose, Sakata, Mizoguchi, Anjyo: "Mathematical analysis on affine maps
 *    for 2D shape interpolation", SCA 2012
 *
 * For every pose j and triangle t the affine map from the rest triangle is
 * A_{j,t} = R(θ_{j,t}) S_{j,t} (polar decomposition, S symmetric positive definite).
 * With (affine) weights w_j the ideal map of a triangle is
 *
 *    polar-log    : R(Σ w_j θ_j) · exp(Σ w_j log S_j)      (Kaji et al. 2012)
 *    polar-linear : R(Σ w_j θ_j) · Σ w_j S_j               (Alexa et al. 2000)
 *    affine-linear: Σ w_j A_j                              (naive)
 *
 * and the vertices are found by minimising Σ_t w_t ‖J_t(v) − A_t‖² (one linear
 * solve with a pre-factored matrix), with the centroid of every connected
 * component interpolated linearly.  Angles θ are real numbers, not angles mod
 * 2π: they are made consistent across adjacent triangles (and across poses) so
 * that blending never takes "the long way round".  Because the blend is affine
 * in (θ, log S), any weights work — including negative ones (extrapolation)
 * and spline weights (Catmull–Rom timing).
 */
import { EnvelopeCholesky } from './sparse.ts';
import { MeshOperator } from './arap.ts';
import { triangleNeighbors } from './mesh.ts';
import { polarAngle, stretchAfterRotation, symExp, symLog, TAU, wrapPi } from './mat2.ts';

export type InterpMethod = 'polar-log' | 'polar-linear' | 'affine-linear' | 'vertex-linear';
export type BranchMode = 'tracked' | 'consistent' | 'principal';

export const methodLabels: Record<InterpMethod, string> = {
  'polar-log': 'Polar–log (Kaji+ 2012)',
  'polar-linear': 'Polar–linear (Alexa+ 2000)',
  'affine-linear': 'Affine linear',
  'vertex-linear': 'Vertex linear',
};

export interface PoseInput {
  pos: ArrayLike<number>;
  /** tracked rotation angles (if recorded from live manipulation) */
  theta?: ArrayLike<number> | null;
  /** extra full turns added to every triangle */
  turns?: number;
}

interface Analyzed {
  pos: Float64Array;
  theta: Float64Array;
  S: Float64Array; // p q r per triangle
  logS: Float64Array;
  A: Float64Array; // a b c d per triangle
  centroid: Float64Array;
}

export class Interpolator {
  readonly op: MeshOperator;
  private ch: EnvelopeCholesky;
  private triNb: number[][];
  private refTri: Int32Array; // per component reference triangle
  private triComp: Int32Array;
  poses: Analyzed[] = [];
  private targets: Float64Array;
  private bx: Float64Array;
  private by: Float64Array;
  private sx: Float64Array;
  private sy: Float64Array;
  private tmp = new Float64Array(4);
  private cbuf: Float64Array<ArrayBufferLike>;
  stats = { solveMs: 0 };

  constructor(op: MeshOperator) {
    this.op = op;
    const n = op.n, m = op.m;
    this.ch = new EnvelopeCholesky(n, op.neighbors);
    op.addStiffness(this.ch, 1);
    const W = 1e3 * (op.meanDiag() || 1);
    for (const a of op.anchors) if (a >= 0) this.ch.addSym(a, a, W);
    this.ch.factor();
    this.triNb = triangleNeighbors(op.mesh);
    this.triComp = new Int32Array(m);
    this.refTri = new Int32Array(op.compCount).fill(-1);
    for (let t = 0; t < m; t++) {
      const c = op.comp[op.mesh.tris[3 * t]];
      this.triComp[t] = c;
      if (this.refTri[c] < 0 || op.area[t] > op.area[this.refTri[c]]) this.refTri[c] = t;
    }
    this.targets = new Float64Array(4 * m);
    this.bx = new Float64Array(n);
    this.by = new Float64Array(n);
    this.sx = new Float64Array(n);
    this.sy = new Float64Array(n);
    this.cbuf = new Float64Array(2 * op.compCount);
  }

  /**
   * Rotation angles made consistent over the triangle adjacency graph: BFS from
   * a reference triangle; each neighbour picks the branch closest to its parent
   * (cf. `rotFix` in the original Maple worksheet).  `refAngles` (per
   * component) chooses the branch of the reference triangles.
   */
  consistentAngles(principal: Float64Array, refAngles?: ArrayLike<number>): Float64Array {
    const m = this.op.m;
    const out = new Float64Array(m);
    const seen = new Uint8Array(m);
    for (let c = 0; c < this.refTri.length; c++) {
      const r = this.refTri[c];
      if (r < 0) continue;
      let base = principal[r];
      if (refAngles) base = refAngles[c] + wrapPi(principal[r] - refAngles[c]);
      out[r] = base;
      seen[r] = 1;
      const queue = [r];
      for (let q = 0; q < queue.length; q++) {
        const u = queue[q];
        for (const v of this.triNb[u]) {
          if (seen[v]) continue;
          seen[v] = 1;
          out[v] = out[u] + wrapPi(principal[v] - out[u]);
          queue.push(v);
        }
      }
    }
    for (let t = 0; t < m; t++) if (!seen[t]) out[t] = principal[t];
    return out;
  }

  /**
   * Analyse a list of poses (all relative to the rest mesh).  Index 0 is
   * usually the rest pose itself.  Branch choice: 'tracked' uses recorded
   * angles when available, 'consistent' unwraps spatially (and temporally
   * along the list), 'principal' uses raw angles in (−π, π].
   */
  setPoses(poses: PoseInput[], branch: BranchMode) {
    const op = this.op, m = op.m;
    const J = this.tmp;
    let prevRef: Float64Array | null = null;
    this.poses = poses.map((p) => {
      const pos = Float64Array.from(p.pos);
      const principal = op.principalAngles(pos);
      let theta: Float64Array;
      if (branch === 'principal') theta = principal;
      else if (branch === 'tracked' && p.theta && p.theta.length === m) {
        // trust tracked angles, but snap each to the branch nearest its tracked value
        theta = new Float64Array(m);
        for (let t = 0; t < m; t++) theta[t] = p.theta[t] + wrapPi(principal[t] - p.theta[t]);
      } else {
        const ref = prevRef ?? new Float64Array(this.refTri.length);
        theta = this.consistentAngles(principal, ref);
      }
      const turns = p.turns ?? 0;
      if (turns) for (let t = 0; t < m; t++) theta[t] += turns * TAU;
      prevRef = new Float64Array(this.refTri.length);
      for (let c = 0; c < this.refTri.length; c++) if (this.refTri[c] >= 0) prevRef[c] = theta[this.refTri[c]];

      const S = new Float64Array(3 * m), logS = new Float64Array(3 * m), A = new Float64Array(4 * m);
      for (let t = 0; t < m; t++) {
        op.jacobian(pos, t, J);
        A.set(J, 4 * t);
        stretchAfterRotation(J[0], J[1], J[2], J[3], theta[t], S, 3 * t);
        symLog(S[3 * t], S[3 * t + 1], S[3 * t + 2], logS, 3 * t);
      }
      return { pos, theta, S, logS, A, centroid: op.centroids(pos) };
    });
  }

  get count() {
    return this.poses.length;
  }

  /**
   * Blend analysed poses with weights (Σ w = 1 recommended; any real values
   * allowed).  Writes vertex positions into `out`.
   */
  blend(weights: ArrayLike<number>, method: InterpMethod, out: Float64Array) {
    const t0 = performance.now();
    const op = this.op, n = op.n, m = op.m;
    const P = this.poses;
    const idx: number[] = [];
    for (let j = 0; j < P.length; j++) if (weights[j]) idx.push(j);
    if (!idx.length) {
      out.set(op.mesh.rest);
      return out;
    }
    if (method === 'vertex-linear') {
      out.fill(0);
      for (const j of idx) {
        const w = weights[j], pp = P[j].pos;
        for (let i = 0; i < 2 * n; i++) out[i] += w * pp[i];
      }
      this.stats.solveMs = performance.now() - t0;
      return out;
    }
    const tg = this.targets, e = this.tmp;
    for (let t = 0; t < m; t++) {
      if (method === 'affine-linear') {
        let a = 0, b = 0, c = 0, d = 0;
        for (const j of idx) {
          const w = weights[j], A = P[j].A, o = 4 * t;
          a += w * A[o]; b += w * A[o + 1]; c += w * A[o + 2]; d += w * A[o + 3];
        }
        tg[4 * t] = a; tg[4 * t + 1] = b; tg[4 * t + 2] = c; tg[4 * t + 3] = d;
        continue;
      }
      let th = 0, p = 0, q = 0, r = 0;
      const src = method === 'polar-log' ? 'logS' : 'S';
      for (const j of idx) {
        const w = weights[j], M = P[j][src], o = 3 * t;
        th += w * P[j].theta[t];
        p += w * M[o]; q += w * M[o + 1]; r += w * M[o + 2];
      }
      if (method === 'polar-log') {
        symExp(p, q, r, e, 0);
        p = e[0]; q = e[1]; r = e[2];
      }
      const co = Math.cos(th), si = Math.sin(th);
      // R(θ)·S, S = [[p,q],[q,r]]
      tg[4 * t] = co * p - si * q;
      tg[4 * t + 1] = co * q - si * r;
      tg[4 * t + 2] = si * p + co * q;
      tg[4 * t + 3] = si * q + co * r;
    }
    const { bx, by, sx, sy } = this;
    bx.fill(0);
    by.fill(0);
    op.addTargetRhs(tg, bx, by);
    this.ch.solve(bx, sx);
    this.ch.solve(by, sy);
    for (let i = 0; i < n; i++) {
      out[2 * i] = sx[i];
      out[2 * i + 1] = sy[i];
    }
    // translation: interpolate each component's centroid linearly
    const cur = op.centroids(out, this.cbuf);
    const want = new Float64Array(2 * op.compCount);
    for (const j of idx) {
      const w = weights[j], c = P[j].centroid;
      for (let k = 0; k < want.length; k++) want[k] += w * c[k];
    }
    for (let i = 0; i < n; i++) {
      const c = op.comp[i];
      out[2 * i] += want[2 * c] - cur[2 * c];
      out[2 * i + 1] += want[2 * c + 1] - cur[2 * c + 1];
    }
    this.stats.solveMs = performance.now() - t0;
    return out;
  }

  /** Blended rotation angles (for handing a blended pose back to the live deformer). */
  blendTheta(weights: ArrayLike<number>): Float64Array {
    const m = this.op.m;
    const out = new Float64Array(m);
    for (let j = 0; j < this.poses.length; j++) {
      const w = weights[j];
      if (!w) continue;
      const th = this.poses[j].theta;
      for (let t = 0; t < m; t++) out[t] += w * th[t];
    }
    return out;
  }
}

// ------------------------------------------------------------------ timing

export type Easing = 'linear' | 'smooth' | 'spline';
export type LoopMode = 'loop' | 'pingpong' | 'once';

/**
 * Weights over keyframes 0..k-1 for continuous time τ (in "keyframe units").
 * linear: piecewise-linear; smooth: smoothstep easing; spline: uniform
 * Catmull–Rom (C¹, passes through every key, slight overshoot).
 */
export function timelineWeights(tau: number, k: number, easing: Easing, loop: LoopMode): Float64Array {
  const w = new Float64Array(k);
  if (k === 0) return w;
  if (k === 1) {
    w[0] = 1;
    return w;
  }
  const cyclic = loop === 'loop';
  const segs = cyclic ? k : k - 1;
  let s = Math.floor(tau);
  let u = tau - s;
  if (cyclic) s = ((s % segs) + segs) % segs;
  else if (s < 0) {
    s = 0;
    u = 0;
  } else if (s >= segs) {
    s = segs - 1;
    u = 1;
  }
  const at = (i: number) => (cyclic ? ((i % k) + k) % k : Math.max(0, Math.min(k - 1, i)));
  if (easing === 'spline') {
    const u2 = u * u, u3 = u2 * u;
    const c0 = 0.5 * (-u3 + 2 * u2 - u);
    const c1 = 0.5 * (3 * u3 - 5 * u2 + 2);
    const c2 = 0.5 * (-3 * u3 + 4 * u2 + u);
    const c3 = 0.5 * (u3 - u2);
    w[at(s - 1)] += c0;
    w[at(s)] += c1;
    w[at(s + 1)] += c2;
    w[at(s + 2)] += c3;
  } else {
    const e = easing === 'smooth' ? u * u * (3 - 2 * u) : u;
    w[at(s)] += 1 - e;
    w[at(s + 1)] += e;
  }
  return w;
}

/** Map wall-clock time to timeline position τ for the given loop mode. */
export function timelinePosition(seconds: number, perKey: number, k: number, loop: LoopMode): { tau: number; done: boolean } {
  if (k <= 1) return { tau: 0, done: true };
  const segs = loop === 'loop' ? k : k - 1;
  const x = seconds / Math.max(perKey, 1e-3);
  if (loop === 'loop') return { tau: x % segs, done: false };
  if (loop === 'pingpong') {
    const p = x % (2 * segs);
    return { tau: p <= segs ? p : 2 * segs - p, done: false };
  }
  return { tau: Math.min(x, segs), done: x >= segs };
}

// ------------------------------------------------------------- blend pad

/**
 * Generalised barycentric weights for a point in the 2D "pose space" pad.
 * Poses are points; we triangulate them (fan-free Delaunay for small sets
 * by brute force) and return barycentric coordinates of the containing (or
 * nearest) triangle — which extrapolate linearly outside the hull.
 */
export function padWeights(points: [number, number][], x: number, y: number): Float64Array {
  const k = points.length;
  const w = new Float64Array(k);
  if (k === 0) return w;
  if (k === 1) {
    w[0] = 1;
    return w;
  }
  if (k === 2) {
    const [a, b] = points;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const t = ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1);
    w[0] = 1 - t;
    w[1] = t;
    return w;
  }
  const tris = delaunaySmall(points);
  if (!tris.length) {
    // collinear: project onto the two farthest points
    let bi = 0, bj = 1, bd = -1;
    for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) {
      const d = (points[i][0] - points[j][0]) ** 2 + (points[i][1] - points[j][1]) ** 2;
      if (d > bd) { bd = d; bi = i; bj = j; }
    }
    const sub = padWeights([points[bi], points[bj]], x, y);
    w[bi] = sub[0];
    w[bj] = sub[1];
    return w;
  }
  let best: { t: number[]; b: number[]; d: number } | null = null;
  for (const t of tris) {
    const [a, b, c] = t.map((i) => points[i]);
    const det = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const l1 = ((x - a[0]) * (c[1] - a[1]) - (y - a[1]) * (c[0] - a[0])) / det;
    const l2 = ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])) / det;
    const l0 = 1 - l1 - l2;
    const outside = Math.max(0, -l0) + Math.max(0, -l1) + Math.max(0, -l2);
    if (!best || outside < best.d) best = { t, b: [l0, l1, l2], d: outside };
  }
  best!.t.forEach((i, j) => (w[i] = best!.b[j]));
  return w;
}

/** O(k⁴) Delaunay for a handful of points (pose pads have < 20). */
export function delaunaySmall(P: [number, number][]): [number, number, number][] {
  const k = P.length;
  const out: [number, number, number][] = [];
  for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) for (let l = j + 1; l < k; l++) {
    const [a, b, c] = [P[i], P[j], P[l]];
    const det = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(det) < 1e-9) continue;
    let ok = true;
    for (let q = 0; q < k && ok; q++) {
      if (q === i || q === j || q === l) continue;
      if (inCircle(a, b, c, P[q]) * Math.sign(det) > 1e-12) ok = false;
    }
    if (ok) out.push([i, j, l]);
  }
  return out;
}

function inCircle(a: number[], b: number[], c: number[], d: number[]) {
  const ax = a[0] - d[0], ay = a[1] - d[1];
  const bx = b[0] - d[0], by = b[1] - d[1];
  const cx = c[0] - d[0], cy = c[1] - d[1];
  return (ax * ax + ay * ay) * (bx * cy - cx * by) - (bx * bx + by * by) * (ax * cy - cx * ay) + (cx * cx + cy * cy) * (ax * by - bx * ay);
}

/** Transfer a pose from one mesh to another through the rest shapes (barycentric lookup). */
export function transferPose(
  fromRest: ArrayLike<number>,
  fromTris: ArrayLike<number>,
  fromPose: ArrayLike<number>,
  toRest: ArrayLike<number>,
  locate: (P: ArrayLike<number>, T: ArrayLike<number>, x: number, y: number, maxDist: number) => { tri: number; b: number[] } | null,
): Float64Array {
  const n = toRest.length >> 1;
  const out = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    const x = toRest[2 * i], y = toRest[2 * i + 1];
    const hit = locate(fromRest, fromTris, x, y, 1e9);
    if (!hit) {
      out[2 * i] = x;
      out[2 * i + 1] = y;
      continue;
    }
    const a = fromTris[3 * hit.tri], b = fromTris[3 * hit.tri + 1], c = fromTris[3 * hit.tri + 2];
    // extrapolate with unclamped barycentrics of the nearest triangle
    out[2 * i] = hit.b[0] * fromPose[2 * a] + hit.b[1] * fromPose[2 * b] + hit.b[2] * fromPose[2 * c];
    out[2 * i + 1] = hit.b[0] * fromPose[2 * a + 1] + hit.b[1] * fromPose[2 * b + 1] + hit.b[2] * fromPose[2 * c + 1];
  }
  return out;
}

/** Principal angles helper re-exported for UI heatmaps. */
export { polarAngle };
