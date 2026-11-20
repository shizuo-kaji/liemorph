/**
 * As-rigid-as-possible machinery on triangle meshes.
 *
 * Every piecewise-linear map of a triangle t is described by its Jacobian
 * J_t = Σ_k y_k g_{t,k}ᵀ where y_k are the deformed vertex positions and
 * g_{t,k} the gradients of the rest barycentric coordinates.  All energies in
 * this app have the form
 *
 *     E(y) = Σ_t w_t ‖J_t(y) − M_t‖²_F     (+ constraints)
 *
 * where the per-triangle "ideal" matrix M_t is
 *   – the closest rotation (ARAP) / similarity (ASAP) of J_t  (deformation),
 *   – a blended affine map R(θ)·S            (shape interpolation, see interp.ts).
 * The normal equations K y = b share the same matrix K = Σ_t w_t G_t G_tᵀ
 * (the cotangent Laplacian when w_t = area), which is factored once.
 */
import { EnvelopeCholesky } from './sparse.ts';
import { type Mesh, vcount, tcount, vertexNeighbors, components } from './mesh.ts';
import { polarAngle, wrapPi } from './mat2.ts';

export type Weighting = 'area' | 'uniform';

/** Pre-computed differential quantities of a rest mesh. */
export class MeshOperator {
  readonly mesh: Mesh;
  readonly n: number;
  readonly m: number;
  readonly area: Float64Array;
  /** 6 numbers per triangle: g0x g0y g1x g1y g2x g2y */
  readonly grad: Float64Array;
  readonly weight: Float64Array;
  readonly neighbors: number[][];
  readonly comp: Int32Array;
  readonly compCount: number;
  /** lumped (normalised per component) vertex mass, Σ_v∈comp μ_v = 1 */
  readonly mu: Float64Array;
  /** lumped vertex area / L² (for dynamics) */
  readonly mass: Float64Array;
  /** one anchor vertex per component */
  readonly anchors: Int32Array;
  /** characteristic size of the shape (max bbox side) */
  readonly L: number;
  readonly totalArea: number;
  readonly weighting: Weighting;

  constructor(mesh: Mesh, weighting: Weighting = 'area') {
    this.mesh = mesh;
    this.weighting = weighting;
    const n = (this.n = vcount(mesh));
    const m = (this.m = tcount(mesh));
    const P = mesh.rest, T = mesh.tris;
    this.area = new Float64Array(m);
    this.grad = new Float64Array(6 * m);
    this.weight = new Float64Array(m);
    let tot = 0;
    for (let t = 0; t < m; t++) {
      const a = T[3 * t], b = T[3 * t + 1], c = T[3 * t + 2];
      const e1x = P[2 * b] - P[2 * a], e1y = P[2 * b + 1] - P[2 * a + 1];
      const e2x = P[2 * c] - P[2 * a], e2y = P[2 * c + 1] - P[2 * a + 1];
      const det = e1x * e2y - e2x * e1y;
      const ar = Math.abs(det) / 2;
      this.area[t] = ar;
      tot += ar;
      if (ar < 1e-12) continue;
      const g1x = e2y / det, g1y = -e2x / det;
      const g2x = -e1y / det, g2y = e1x / det;
      const o = 6 * t;
      this.grad[o] = -(g1x + g2x);
      this.grad[o + 1] = -(g1y + g2y);
      this.grad[o + 2] = g1x;
      this.grad[o + 3] = g1y;
      this.grad[o + 4] = g2x;
      this.grad[o + 5] = g2y;
    }
    this.totalArea = tot;
    const mean = m ? tot / m : 1;
    for (let t = 0; t < m; t++) this.weight[t] = this.area[t] < 1e-12 ? 0 : weighting === 'area' ? this.area[t] : mean;

    this.neighbors = vertexNeighbors(mesh);
    const cc = components(mesh);
    this.comp = cc.comp;
    this.compCount = cc.count;
    this.mass = new Float64Array(n);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i++) {
      x0 = Math.min(x0, P[2 * i]); x1 = Math.max(x1, P[2 * i]);
      y0 = Math.min(y0, P[2 * i + 1]); y1 = Math.max(y1, P[2 * i + 1]);
    }
    this.L = Math.max(x1 - x0, y1 - y0, 1e-9);
    for (let t = 0; t < m; t++) {
      const a3 = this.area[t] / 3;
      this.mass[T[3 * t]] += a3;
      this.mass[T[3 * t + 1]] += a3;
      this.mass[T[3 * t + 2]] += a3;
    }
    const compMass = new Float64Array(this.compCount);
    for (let i = 0; i < n; i++) compMass[this.comp[i]] += this.mass[i];
    this.mu = new Float64Array(n);
    for (let i = 0; i < n; i++) this.mu[i] = compMass[this.comp[i]] > 0 ? this.mass[i] / compMass[this.comp[i]] : 0;
    const L2 = this.L * this.L;
    for (let i = 0; i < n; i++) this.mass[i] = Math.max(this.mass[i] / L2, 1e-9);
    this.anchors = new Int32Array(this.compCount).fill(-1);
    // anchor = heaviest vertex of each component (well inside the shape)
    for (let i = 0; i < n; i++) {
      const c = this.comp[i];
      if (this.anchors[c] < 0 || this.mu[i] > this.mu[this.anchors[c]]) this.anchors[c] = i;
    }
  }

  /** Jacobian of triangle t for positions Y → writes a,b,c,d into out[o..]. */
  jacobian(Y: ArrayLike<number>, t: number, out: Float64Array, o = 0) {
    const T = this.mesh.tris, g = this.grad, k = 6 * t;
    const i0 = T[3 * t], i1 = T[3 * t + 1], i2 = T[3 * t + 2];
    const x0 = Y[2 * i0], y0 = Y[2 * i0 + 1], x1 = Y[2 * i1], y1 = Y[2 * i1 + 1], x2 = Y[2 * i2], y2 = Y[2 * i2 + 1];
    out[o] = x0 * g[k] + x1 * g[k + 2] + x2 * g[k + 4];
    out[o + 1] = x0 * g[k + 1] + x1 * g[k + 3] + x2 * g[k + 5];
    out[o + 2] = y0 * g[k] + y1 * g[k + 2] + y2 * g[k + 4];
    out[o + 3] = y0 * g[k + 1] + y1 * g[k + 3] + y2 * g[k + 5];
  }

  /** Assemble scale·K into a factorisation object (adds; caller clears). */
  addStiffness(ch: EnvelopeCholesky, scale = 1) {
    const T = this.mesh.tris, g = this.grad;
    for (let t = 0; t < this.m; t++) {
      const w = this.weight[t] * scale;
      if (!w) continue;
      for (let i = 0; i < 3; i++) {
        const vi = T[3 * t + i];
        const gix = g[6 * t + 2 * i], giy = g[6 * t + 2 * i + 1];
        for (let j = i; j < 3; j++) {
          const vj = T[3 * t + j];
          const v = w * (gix * g[6 * t + 2 * j] + giy * g[6 * t + 2 * j + 1]);
          ch.addSym(vi, vj, v);
        }
      }
    }
  }

  /** Right-hand side b = Σ_t w_t G_t M_tᵀ for per-triangle targets M (a,b,c,d), scaled; adds into bx, by. */
  addTargetRhs(targets: Float64Array, bx: Float64Array, by: Float64Array, scale = 1) {
    const T = this.mesh.tris, g = this.grad;
    for (let t = 0; t < this.m; t++) {
      const w = this.weight[t] * scale;
      if (!w) continue;
      const a = targets[4 * t], b = targets[4 * t + 1], c = targets[4 * t + 2], d = targets[4 * t + 3];
      for (let i = 0; i < 3; i++) {
        const v = T[3 * t + i];
        const gx = g[6 * t + 2 * i], gy = g[6 * t + 2 * i + 1];
        bx[v] += w * (gx * a + gy * b);
        by[v] += w * (gx * c + gy * d);
      }
    }
  }

  /** Mean diagonal of K (to scale penalty weights). */
  meanDiag(): number {
    let s = 0;
    for (let t = 0; t < this.m; t++) {
      const g = this.grad, k = 6 * t;
      s += this.weight[t] * (g[k] ** 2 + g[k + 1] ** 2 + g[k + 2] ** 2 + g[k + 3] ** 2 + g[k + 4] ** 2 + g[k + 5] ** 2);
    }
    return this.n ? s / this.n : 1;
  }

  /** Per-component centroids (μ-weighted) of positions Y: 2·compCount numbers. */
  centroids(Y: ArrayLike<number>, out: Float64Array = new Float64Array(2 * this.compCount)) {
    out.fill(0);
    for (let i = 0; i < this.n; i++) {
      const c = this.comp[i];
      out[2 * c] += this.mu[i] * Y[2 * i];
      out[2 * c + 1] += this.mu[i] * Y[2 * i + 1];
    }
    return out;
  }

  /** Rotation angles (principal branch) of every triangle for positions Y. */
  principalAngles(Y: ArrayLike<number>, out: Float64Array = new Float64Array(this.m)) {
    const J = new Float64Array(4);
    for (let t = 0; t < this.m; t++) {
      this.jacobian(Y, t, J);
      out[t] = polarAngle(J[0], J[1], J[2], J[3]);
    }
    return out;
  }
}

export interface Pin {
  id: number;
  tri: number;
  b: [number, number, number];
  /** target position (world) */
  x: number;
  y: number;
  /** temporary grab handle (removed on release) */
  temp?: boolean;
}

export interface DeformOptions {
  /** 1 = as-rigid-as-possible, 0 = as-similar-as-possible */
  rigidity: number;
  iterations: number;
  jelly: boolean;
  /** jelly stiffness (≈ ω², 1/s²) */
  stiffness: number;
  /** jelly velocity damping per second (0..) */
  damping: number;
  /** gravity in shape-sizes per s² */
  gravity: number;
  /** y coordinate of the floor (world) or null */
  floor: number | null;
}

export const defaultDeformOptions: DeformOptions = {
  rigidity: 1,
  iterations: 8,
  jelly: false,
  stiffness: 80,
  damping: 1.5,
  gravity: 0,
  floor: null,
};

/** Interactive ARAP / ASAP deformer with soft barycentric pins and optional "jelly" dynamics. */
export class Deformer {
  readonly op: MeshOperator;
  readonly n: number;
  readonly m: number;
  pos: Float64Array;
  vel: Float64Array;
  /** tracked (unwrapped) rotation angle per triangle */
  theta: Float64Array;
  pins: Pin[] = [];
  opts: DeformOptions;
  /** last measured energy and timing for the stats panel */
  stats = { energy: 0, solveMs: 0, factorMs: 0, flipped: 0, iterations: 0 };

  private ch: EnvelopeCholesky;
  private needFactor = true;
  private factoredFor = '';
  private targets: Float64Array;
  private bx: Float64Array;
  private by: Float64Array;
  private sx: Float64Array;
  private sy: Float64Array;
  private J = new Float64Array(4);
  private pred: Float64Array;
  private Y: Float64Array;
  private pinW: number;
  private regW: number;
  private kDiag: number;
  private accum = 0;
  private settle = 0;

  constructor(op: MeshOperator, opts: Partial<DeformOptions> = {}) {
    this.op = op;
    this.n = op.n;
    this.m = op.m;
    this.opts = { ...defaultDeformOptions, ...opts };
    this.pos = Float64Array.from(op.mesh.rest);
    this.vel = new Float64Array(2 * this.n);
    this.theta = new Float64Array(this.m);
    this.ch = new EnvelopeCholesky(this.n, op.neighbors);
    this.targets = new Float64Array(4 * this.m);
    this.bx = new Float64Array(this.n);
    this.by = new Float64Array(this.n);
    this.sx = new Float64Array(this.n);
    this.sy = new Float64Array(this.n);
    this.pred = new Float64Array(2 * this.n);
    this.Y = new Float64Array(2 * this.n);
    this.kDiag = op.meanDiag() || 1;
    this.pinW = 1e4 * this.kDiag;
    this.regW = 1e-7 * this.kDiag;
  }

  setOptions(o: Partial<DeformOptions>) {
    const jellyChanged = o.jelly !== undefined && o.jelly !== this.opts.jelly;
    const stiffChanged = o.stiffness !== undefined && o.stiffness !== this.opts.stiffness;
    Object.assign(this.opts, o);
    if (jellyChanged || stiffChanged) this.needFactor = true;
    if (jellyChanged) this.vel.fill(0);
    this.wake();
  }

  /** stored coefficients of the factorised matrix (fill-in measure) */
  get envelopeSize() {
    return this.ch.envelopeSize;
  }

  /** Mark the solver as active (it will iterate until settled). */
  wake() {
    this.settle = 30;
  }

  get active() {
    return this.settle > 0 || this.pins.some((p) => p.temp) || (this.opts.jelly && this.kinetic() > 1e-10);
  }

  private kinetic() {
    let s = 0;
    for (let i = 0; i < this.vel.length; i++) s += this.vel[i] * this.vel[i];
    return s / (this.op.L * this.op.L);
  }

  pinsChanged() {
    this.needFactor = true;
    this.wake();
  }

  addPin(p: Pin) {
    this.pins.push(p);
    this.pinsChanged();
  }

  removePin(id: number) {
    const k = this.pins.findIndex((p) => p.id === id);
    if (k >= 0) {
      this.pins.splice(k, 1);
      this.pinsChanged();
    }
  }

  /** world position of a pin's material point under the current deformation */
  pinPosition(p: Pin): [number, number] {
    const T = this.op.mesh.tris, Y = this.pos;
    const a = T[3 * p.tri], b = T[3 * p.tri + 1], c = T[3 * p.tri + 2];
    return [
      p.b[0] * Y[2 * a] + p.b[1] * Y[2 * b] + p.b[2] * Y[2 * c],
      p.b[0] * Y[2 * a + 1] + p.b[1] * Y[2 * b + 1] + p.b[2] * Y[2 * c + 1],
    ];
  }

  /** Snap all pin targets to where their material points currently are. */
  resetPinTargets() {
    for (const p of this.pins) [p.x, p.y] = this.pinPosition(p);
  }

  setPose(pos: ArrayLike<number>, theta?: ArrayLike<number>) {
    this.pos.set(pos);
    this.vel.fill(0);
    if (theta) this.theta.set(theta);
    else this.retrackFromPrincipal();
    this.resetPinTargets();
    this.wake();
  }

  resetPose() {
    this.setPose(this.op.mesh.rest, new Float64Array(this.m));
  }

  /** Recompute θ from the current pose by spatial unwrapping (used after external pose edits). */
  retrackFromPrincipal() {
    const prev = Float64Array.from(this.theta);
    const ang = this.op.principalAngles(this.pos);
    for (let t = 0; t < this.m; t++) this.theta[t] = prev[t] + wrapPi(ang[t] - prev[t]);
  }

  private dynKey() {
    return `${this.opts.jelly ? 1 : 0}:${this.opts.stiffness}`;
  }

  private factor() {
    const t0 = performance.now();
    const ch = this.ch, op = this.op;
    ch.clear();
    const dt = 1 / 120;
    if (this.opts.jelly) {
      // (M/h² + k K + W P): with mass = area/L² the stiffness k is ≈ ω² of the slowest modes (1/s²)
      op.addStiffness(ch, this.opts.stiffness);
      for (let i = 0; i < this.n; i++) ch.addSym(i, i, op.mass[i] / (dt * dt));
      this.pinW = 1e4 * this.kDiag * Math.max(1, this.opts.stiffness);
    } else {
      op.addStiffness(ch, 1);
      for (let i = 0; i < this.n; i++) ch.addSym(i, i, this.regW);
      this.pinW = 1e4 * this.kDiag;
    }
    const T = op.mesh.tris;
    for (const p of this.pins) {
      for (let i = 0; i < 3; i++)
        for (let j = i; j < 3; j++) {
          ch.addSym(T[3 * p.tri + i], T[3 * p.tri + j], this.pinW * p.b[i] * p.b[j]);
        }
    }
    ch.factor();
    this.needFactor = false;
    this.factoredFor = this.dynKey();
    this.stats.factorMs = performance.now() - t0;
  }

  /** local step: per-triangle closest rotation/similarity of the current Jacobian */
  private localStep(Y: Float64Array) {
    const J = this.J, tg = this.targets, rig = this.opts.rigidity;
    let energy = 0, flipped = 0;
    for (let t = 0; t < this.m; t++) {
      this.op.jacobian(Y, t, J);
      const a = J[0], b = J[1], c = J[2], d = J[3];
      if (a * d - b * c <= 0) flipped++;
      const p = 0.5 * (a + d), q = 0.5 * (c - b);
      const r = Math.hypot(p, q);
      let co = 1, si = 0;
      if (r > 1e-12) {
        co = p / r;
        si = q / r;
      }
      const s = rig + (1 - rig) * r; // r = best similarity scale
      tg[4 * t] = s * co;
      tg[4 * t + 1] = -s * si;
      tg[4 * t + 2] = s * si;
      tg[4 * t + 3] = s * co;
      const w = this.op.weight[t];
      energy += w * ((a - s * co) ** 2 + (b + s * si) ** 2 + (c - s * si) ** 2 + (d - s * co) ** 2);
    }
    this.stats.energy = energy / (this.op.totalArea || 1);
    this.stats.flipped = flipped;
  }

  private addPinRhs(bx: Float64Array, by: Float64Array) {
    const T = this.op.mesh.tris;
    for (const p of this.pins) {
      for (let i = 0; i < 3; i++) {
        const v = T[3 * p.tri + i];
        bx[v] += this.pinW * p.b[i] * p.x;
        by[v] += this.pinW * p.b[i] * p.y;
      }
    }
  }

  private staticIterations(iters: number): number {
    const { bx, by, sx, sy, pos } = this;
    let maxMove = 0;
    for (let it = 0; it < iters; it++) {
      this.localStep(pos);
      bx.fill(0);
      by.fill(0);
      this.op.addTargetRhs(this.targets, bx, by);
      this.addPinRhs(bx, by);
      for (let i = 0; i < this.n; i++) {
        bx[i] += this.regW * pos[2 * i];
        by[i] += this.regW * pos[2 * i + 1];
      }
      this.ch.solve(bx, sx);
      this.ch.solve(by, sy);
      maxMove = 0;
      for (let i = 0; i < this.n; i++) {
        const dx = sx[i] - pos[2 * i], dy = sy[i] - pos[2 * i + 1];
        maxMove = Math.max(maxMove, dx * dx + dy * dy);
        pos[2 * i] = sx[i];
        pos[2 * i + 1] = sy[i];
      }
    }
    this.stats.iterations = iters;
    return Math.sqrt(maxMove);
  }

  private dynamicStep(h: number) {
    const { bx, by, sx, sy, pos, vel, op } = this;
    const n = this.n;
    const g = this.opts.gravity * op.L;
    const k = this.opts.stiffness;
    const px = sx, py = sy;
    const pred = this.pred, Y = this.Y;
    // inertial prediction
    for (let i = 0; i < n; i++) {
      pred[2 * i] = pos[2 * i] + h * vel[2 * i];
      pred[2 * i + 1] = pos[2 * i + 1] + h * vel[2 * i + 1] + h * h * g;
    }
    Y.set(pred);
    const iters = Math.max(2, Math.min(6, this.opts.iterations >> 1));
    for (let it = 0; it < iters; it++) {
      this.localStep(Y);
      bx.fill(0);
      by.fill(0);
      this.op.addTargetRhs(this.targets, bx, by, k);
      this.addPinRhs(bx, by);
      for (let i = 0; i < n; i++) {
        const mh = op.mass[i] / (h * h);
        bx[i] += mh * pred[2 * i];
        by[i] += mh * pred[2 * i + 1];
      }
      this.ch.solve(bx, px);
      this.ch.solve(by, py);
      for (let i = 0; i < n; i++) {
        Y[2 * i] = px[i];
        Y[2 * i + 1] = py[i];
      }
    }
    const damp = Math.exp(-this.opts.damping * h);
    const floor = this.opts.floor;
    for (let i = 0; i < n; i++) {
      let vx = (Y[2 * i] - pos[2 * i]) / h;
      let vy = (Y[2 * i + 1] - pos[2 * i + 1]) / h;
      if (floor !== null && g > 0 && Y[2 * i + 1] > floor) {
        Y[2 * i + 1] = floor;
        if (vy > 0) vy = -0.25 * vy;
        vx *= 0.8;
      }
      vel[2 * i] = vx * damp;
      vel[2 * i + 1] = vy * damp;
      pos[2 * i] = Y[2 * i];
      pos[2 * i + 1] = Y[2 * i + 1];
    }
  }

  /**
   * Advance the solver by `dt` seconds of wall time.  Returns true if the
   * shape changed (needs redraw).
   */
  update(dt: number): boolean {
    if (this.needFactor || this.factoredFor !== this.dynKey()) this.factor();
    const t0 = performance.now();
    let changed = false;
    if (this.opts.jelly) {
      // sleep when everything has come to rest (saves battery on tablets)
      if (!this.active) return false;
      const h = 1 / 120;
      this.accum = Math.min(this.accum + dt, 4 * h);
      while (this.accum >= h) {
        this.dynamicStep(h);
        this.accum -= h;
        changed = true;
      }
      if (this.pins.some((p) => p.temp) || this.kinetic() > 1e-8) this.settle = Math.max(this.settle, 10);
      else this.settle--;
    } else {
      if (!this.active) return false;
      if (this.pins.length === 0) {
        this.settle = 0;
        return false;
      }
      const move = this.staticIterations(this.opts.iterations);
      changed = true;
      if (!this.pins.some((p) => p.temp)) {
        if (move < 1e-4 * this.op.L) this.settle = Math.min(this.settle, 1);
        this.settle--;
      }
    }
    if (changed) this.trackRotations();
    this.stats.solveMs = performance.now() - t0;
    return changed;
  }

  /** keep θ continuous in time (assumes < π rotation per frame per triangle) */
  trackRotations() {
    const J = this.J;
    for (let t = 0; t < this.m; t++) {
      this.op.jacobian(this.pos, t, J);
      const phi = polarAngle(J[0], J[1], J[2], J[3]);
      this.theta[t] += wrapPi(phi - this.theta[t]);
    }
  }
}
