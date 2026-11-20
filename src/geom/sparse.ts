/**
 * Sparse symmetric positive-definite solver for mesh Laplacian-type systems.
 *
 * Reverse Cuthill–McKee reordering + envelope (skyline) Cholesky.  For a 2D
 * triangle mesh with n vertices the envelope width is O(√n), so factoring is
 * O(n²) in the worst case but in practice a few milliseconds for n ≈ 2000,
 * and each solve is a couple of contiguous dot products per row.
 */
export class EnvelopeCholesky {
  readonly n: number;
  /** new index -> original index */
  readonly perm: Int32Array;
  /** original index -> new index */
  readonly iperm: Int32Array;
  /** first stored column of (permuted) row i */
  readonly first: Int32Array;
  /** start offset of row i inside `val`; entry (i, j) lives at off[i] + j - first[i] */
  readonly off: Int32Array;
  readonly val: Float64Array;
  private readonly work: Float64Array;
  factored = false;

  constructor(n: number, neighbors: ArrayLike<number>[]) {
    this.n = n;
    this.perm = reverseCuthillMcKee(n, neighbors);
    this.iperm = new Int32Array(n);
    for (let i = 0; i < n; i++) this.iperm[this.perm[i]] = i;
    this.first = new Int32Array(n);
    this.off = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) {
      const o = this.perm[i];
      let f = i;
      const nb = neighbors[o];
      for (let k = 0; k < nb.length; k++) {
        const j = this.iperm[nb[k]];
        if (j < f) f = j;
      }
      this.first[i] = f;
      this.off[i + 1] = this.off[i] + (i - f + 1);
    }
    this.val = new Float64Array(this.off[n]);
    this.work = new Float64Array(n);
  }

  /** Number of stored coefficients (a measure of fill-in). */
  get envelopeSize() {
    return this.off[this.n];
  }

  clear() {
    this.val.fill(0);
    this.factored = false;
  }

  /**
   * Add v to A[i][j] AND A[j][i] (original indices).  For i === j it adds v to
   * the diagonal once.  (i, j) must be neighbours in the structure given to
   * the constructor (or equal).
   */
  addSym(i: number, j: number, v: number) {
    let a = this.iperm[i];
    let b = this.iperm[j];
    if (b > a) {
      const t = a;
      a = b;
      b = t;
    }
    const f = this.first[a];
    if (b < f) throw new Error('EnvelopeCholesky: entry outside envelope');
    this.val[this.off[a] + b - f] += v;
  }

  /** In-place LLᵀ factorisation.  Returns false if the matrix is not SPD. */
  factor(): boolean {
    const { n, first, off, val } = this;
    let ok = true;
    for (let i = 0; i < n; i++) {
      const fi = first[i];
      const oi = off[i] - fi;
      for (let j = fi; j < i; j++) {
        const fj = first[j];
        const oj = off[j] - fj;
        let s = val[oi + j];
        const k0 = fi > fj ? fi : fj;
        for (let k = k0; k < j; k++) s -= val[oi + k] * val[oj + k];
        val[oi + j] = s / val[oj + j];
      }
      let d = val[oi + i];
      for (let k = fi; k < i; k++) d -= val[oi + k] * val[oi + k];
      if (!(d > 1e-300)) {
        ok = false;
        d = 1e-12;
      }
      val[oi + i] = Math.sqrt(d);
    }
    this.factored = true;
    return ok;
  }

  /** Solve A x = b (original indexing).  `x` may alias `b`. */
  solve(b: ArrayLike<number>, x: Float64Array) {
    const { n, first, off, val, perm, work: y } = this;
    for (let i = 0; i < n; i++) y[i] = b[perm[i]];
    // forward: L y = b
    for (let i = 0; i < n; i++) {
      const fi = first[i];
      const oi = off[i] - fi;
      let s = y[i];
      for (let k = fi; k < i; k++) s -= val[oi + k] * y[k];
      y[i] = s / val[oi + i];
    }
    // backward: Lᵀ x = y (column sweep)
    for (let i = n - 1; i >= 0; i--) {
      const fi = first[i];
      const oi = off[i] - fi;
      const xi = y[i] / val[oi + i];
      y[i] = xi;
      for (let k = fi; k < i; k++) y[k] -= val[oi + k] * xi;
    }
    for (let i = 0; i < n; i++) x[perm[i]] = y[i];
  }
}

/** Reverse Cuthill–McKee ordering (handles disconnected graphs). Returns new->old. */
export function reverseCuthillMcKee(n: number, neighbors: ArrayLike<number>[]): Int32Array {
  const deg = new Int32Array(n);
  for (let i = 0; i < n; i++) deg[i] = neighbors[i].length;
  const visited = new Uint8Array(n);
  const order: number[] = [];
  const byDeg = Array.from({ length: n }, (_, i) => i).sort((a, b) => deg[a] - deg[b]);

  const levelBfs = (start: number, mark: Uint8Array): { last: number[]; depth: number } => {
    // BFS over unvisited nodes, returns nodes of the last level
    const seen = mark;
    let frontier = [start];
    seen[start] = 1;
    const touched = [start];
    let depth = 0;
    let last = frontier;
    while (frontier.length) {
      last = frontier;
      const next: number[] = [];
      for (const u of frontier) {
        const nb = neighbors[u];
        for (let k = 0; k < nb.length; k++) {
          const v = nb[k];
          if (!seen[v] && !visited[v]) {
            seen[v] = 1;
            touched.push(v);
            next.push(v);
          }
        }
      }
      if (next.length) depth++;
      frontier = next;
    }
    for (const t of touched) seen[t] = 0;
    return { last, depth };
  };

  const mark = new Uint8Array(n);
  for (const s0 of byDeg) {
    if (visited[s0]) continue;
    // pseudo-peripheral node search (George–Liu)
    let start = s0;
    let { last, depth } = levelBfs(start, mark);
    for (let it = 0; it < 4; it++) {
      let cand = last[0];
      for (const c of last) if (deg[c] < deg[cand]) cand = c;
      const r = levelBfs(cand, mark);
      if (r.depth > depth) {
        start = cand;
        depth = r.depth;
        last = r.last;
      } else break;
    }
    // Cuthill–McKee BFS
    const queue = [start];
    visited[start] = 1;
    for (let q = 0; q < queue.length; q++) {
      const u = queue[q];
      order.push(u);
      const nb = Array.from(neighbors[u]).filter((v) => !visited[v]);
      nb.sort((a, b) => deg[a] - deg[b]);
      for (const v of nb) {
        if (!visited[v]) {
          visited[v] = 1;
          queue.push(v);
        }
      }
    }
  }
  order.reverse();
  return Int32Array.from(order);
}
